import {
  COMMIT_SHADER,
  COMPOSITE_SHADER,
  PRESENT_SHADER,
  STAMP_SHADER,
} from './shaders';
import { BLEND_MODE_INDEX, type BlendMode, type LayerMeta, type Viewport } from '../types';
import {
  TEXTURE_BLEND_INDEX,
  type DualBrush,
  type PatternId,
  type TextureBlend,
  type TipShape,
} from '../brush/types';
import { getPattern, getTip } from '../brush/patterns';
import { STAMP_FLOATS } from '../brush/dynamics';

export interface EngineTextureParams {
  pattern: PatternId;
  /** pattern tile size in document pixels */
  scalePx: number;
  brightness: number;
  contrast: number;
  invert: boolean;
  depth: number;
  mode: TextureBlend;
  /** apply per stamp (true) or once over the whole stroke (false) */
  eachTip: boolean;
}

export interface EngineStrokeParams {
  mode: 'paint' | 'erase';
  /** stroke-level opacity cap, 0..1 */
  opacity: number;
  /** paint blending mode against the layer */
  blendMode: BlendMode;
  /** 0..1, for the analytic round tip */
  hardness: number;
  tipShape: TipShape;
  wetEdges: boolean;
  noise: boolean;
  texture: EngineTextureParams | null;
  dual: DualBrush | null;
}

export interface RenderState {
  layers: LayerMeta[]; // bottom -> top
  activeLayerId: string;
  view: Viewport;
}

interface HistoryEntry {
  layerId: string;
  data: Promise<Uint8Array<ArrayBuffer>>;
}

const MAX_HISTORY = 24;
const UNIFORM_SLICE = 256;
export const MAX_LAYERS = 64;
const LAYER_U_SIZE = 80;
const STAMP_STRIDE = STAMP_FLOATS * 4; // bytes

export class PaintEngine {
  readonly device: GPUDevice;
  readonly docWidth: number;
  readonly docHeight: number;

  /**
   * Kept alive on purpose: if the GPUAdapter is garbage-collected, some
   * Chromium builds drop the underlying Dawn instance and every
   * queue.writeBuffer/writeTexture/mapAsync starts failing with "A valid
   * external Instance reference no longer exists".
   */
  private adapter: GPUAdapter | null = null;

  private context: GPUCanvasContext;
  private canvas: HTMLCanvasElement;
  private format: GPUTextureFormat;

  private layers = new Map<string, GPUTexture>();
  private accum: [GPUTexture, GPUTexture];
  private scratch: GPUTexture;
  private strokeTex: GPUTexture;
  private dualStrokeTex: GPUTexture;
  private selectionTex: GPUTexture | null = null;
  private whiteTex: GPUTexture;

  private patternTextures = new Map<string, GPUTexture>();

  private compositePipeline: GPURenderPipeline;
  private stampPipeline: GPURenderPipeline;
  private stampPipelineDual: GPURenderPipeline;
  private commitPipeline: GPURenderPipeline;
  private presentPipeline: GPURenderPipeline;

  private layerUniforms: GPUBuffer;
  private stampUniforms: GPUBuffer;
  private dualStampUniforms: GPUBuffer;
  private commitUniforms: GPUBuffer;
  private viewUniforms: GPUBuffer;

  private sampLinear: GPUSampler;
  private sampNearest: GPUSampler;
  private sampRepeat: GPUSampler;

  private instanceBuf: GPUBuffer;
  private instanceCapacity = 4096; // stamps

  private stroke: EngineStrokeParams | null = null;
  private strokeTipTex: GPUTexture | null = null;
  private strokePatternTex: GPUTexture | null = null;
  private strokeDualTipTex: GPUTexture | null = null;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void = () => {};

  private constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    docWidth: number,
    docHeight: number,
  ) {
    this.device = device;
    this.canvas = canvas;
    this.context = context;
    this.format = format;
    this.docWidth = docWidth;
    this.docHeight = docHeight;

    const docTex = (format2: GPUTextureFormat, label: string) =>
      device.createTexture({
        label,
        size: [docWidth, docHeight],
        format: format2,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });

    this.accum = [docTex('rgba8unorm', 'accumA'), docTex('rgba8unorm', 'accumB')];
    this.scratch = docTex('rgba8unorm', 'scratch');
    this.strokeTex = docTex('rgba8unorm', 'stroke');
    this.dualStrokeTex = docTex('r8unorm', 'dualStroke');

    this.whiteTex = device.createTexture({
      size: [1, 1],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.uploadTexture(this.whiteTex, new Uint8Array([255]), 1, 1, 1);

    this.sampLinear = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.sampNearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    this.sampRepeat = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    this.layerUniforms = device.createBuffer({
      size: UNIFORM_SLICE * MAX_LAYERS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.stampUniforms = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.dualStampUniforms = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.commitUniforms = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.viewUniforms = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.instanceBuf = device.createBuffer({
      size: this.instanceCapacity * STAMP_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // --- pipelines ---

    const compositeModule = device.createShaderModule({ code: COMPOSITE_SHADER });
    this.compositePipeline = device.createRenderPipeline({
      label: 'composite',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [
          device.createBindGroupLayout({
            entries: [
              { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
              { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
              { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
              { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
              {
                binding: 4,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform', hasDynamicOffset: true },
              },
              { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
              { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
              { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            ],
          }),
        ],
      }),
      vertex: { module: compositeModule, entryPoint: 'vs' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const stampModule = device.createShaderModule({ code: STAMP_SHADER });
    const stampVertex: GPUVertexState = {
      module: stampModule,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: STAMP_STRIDE,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // center
            { shaderLocation: 1, offset: 8, format: 'float32' }, // radius
            { shaderLocation: 2, offset: 12, format: 'float32' }, // alpha
            { shaderLocation: 3, offset: 16, format: 'float32' }, // angle
            { shaderLocation: 4, offset: 20, format: 'float32' }, // roundness
            { shaderLocation: 5, offset: 24, format: 'float32x3' }, // color
            { shaderLocation: 6, offset: 36, format: 'float32' }, // flags
            { shaderLocation: 7, offset: 40, format: 'float32' }, // depthScale
          ],
        },
      ],
    };
    const overBlend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const makeStampPipeline = (label: string, target: GPUTextureFormat) =>
      device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: stampVertex,
        fragment: {
          module: stampModule,
          entryPoint: 'fs',
          targets: [{ format: target, blend: overBlend }],
        },
        primitive: { topology: 'triangle-strip' },
      });
    // primary stamps accumulate premultiplied color; dual-brush stamps
    // accumulate a single-channel coverage mask
    this.stampPipeline = makeStampPipeline('stamp', 'rgba8unorm');
    this.stampPipelineDual = makeStampPipeline('stamp-dual', 'r8unorm');

    const commitModule = device.createShaderModule({ code: COMMIT_SHADER });
    this.commitPipeline = device.createRenderPipeline({
      label: 'commit',
      layout: 'auto',
      vertex: { module: commitModule, entryPoint: 'vs' },
      fragment: {
        module: commitModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const presentModule = device.createShaderModule({ code: PRESENT_SHADER });
    this.presentPipeline = device.createRenderPipeline({
      label: 'present',
      layout: 'auto',
      vertex: { module: presentModule, entryPoint: 'vs' },
      fragment: {
        module: presentModule,
        entryPoint: 'fs',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.clearTexture(this.strokeTex);
  }

  static async create(
    canvas: HTMLCanvasElement,
    docWidth: number,
    docHeight: number,
  ): Promise<PaintEngine> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not available in this browser.');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No WebGPU adapter found.');
    }
    const device = await adapter.requestDevice();
    void device.lost.then((info) => {
      console.error(`[northlight] WebGPU device lost (${info.reason}): ${info.message}`);
    });
    device.addEventListener('uncapturederror', (e) => {
      console.error('[northlight] WebGPU error:', (e as GPUUncapturedErrorEvent).error.message);
    });
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Could not create a WebGPU canvas context.');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const engine = new PaintEngine(device, canvas, context, format, docWidth, docHeight);
    engine.adapter = adapter;
    void engine.adapter; // referenced only to pin the adapter's lifetime
    return engine;
  }

  // -------------------------------------------------------------------------
  // Uploads
  //
  // All CPU->GPU uploads go through mappedAtCreation staging buffers and
  // GPU-side copies instead of queue.writeBuffer/writeTexture. Some Chromium
  // builds (e.g. SwiftShader-backed headless) silently drop queue.write*
  // ("A valid external Instance reference no longer exists") while encoder
  // copies keep working; this path is correct everywhere.
  // -------------------------------------------------------------------------

  private uploadBuffer(target: GPUBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const size = Math.ceil(bytes.byteLength / 4) * 4;
    const staging = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    new Uint8Array(staging.getMappedRange()).set(bytes);
    staging.unmap();
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(staging, 0, target, offset, size);
    this.device.queue.submit([enc.finish()]);
    staging.destroy();
  }

  /** `data` is tightly packed rows of `bytesPerPixel * width` bytes. */
  private uploadTexture(
    tex: GPUTexture,
    data: Uint8Array,
    width: number,
    height: number,
    bytesPerPixel: number,
  ): void {
    const unpadded = width * bytesPerPixel;
    const padded = Math.ceil(unpadded / 256) * 256;
    const staging = this.device.createBuffer({
      size: padded * height,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    const dst = new Uint8Array(staging.getMappedRange());
    if (padded === unpadded) {
      dst.set(data);
    } else {
      for (let y = 0; y < height; y++) {
        dst.set(data.subarray(y * unpadded, (y + 1) * unpadded), y * padded);
      }
    }
    staging.unmap();
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: staging, bytesPerRow: padded },
      { texture: tex },
      [width, height],
    );
    this.device.queue.submit([enc.finish()]);
    staging.destroy();
  }

  /** Cached single-channel texture for patterns / tip shapes / dual tiles. */
  private grayTexture(key: string, make: () => { size: number; data: Uint8Array }): GPUTexture {
    let tex = this.patternTextures.get(key);
    if (!tex) {
      const map = make();
      tex = this.device.createTexture({
        label: `gray:${key}`,
        size: [map.size, map.size],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.uploadTexture(tex, map.data, map.size, map.size, 1);
      this.patternTextures.set(key, tex);
    }
    return tex;
  }

  // -------------------------------------------------------------------------
  // Layer management
  // -------------------------------------------------------------------------

  ensureLayer(id: string): void {
    if (this.layers.has(id)) return;
    const tex = this.device.createTexture({
      label: `layer:${id}`,
      size: [this.docWidth, this.docHeight],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    this.layers.set(id, tex);
    this.clearTexture(tex);
  }

  fillLayer(id: string, rgba: [number, number, number, number]): void {
    const tex = this.layers.get(id);
    if (!tex) return;
    this.clearTexture(tex, rgba);
  }

  deleteLayer(id: string): void {
    const tex = this.layers.get(id);
    if (tex) {
      tex.destroy();
      this.layers.delete(id);
    }
    this.undoStack = this.undoStack.filter((e) => e.layerId !== id);
    this.redoStack = this.redoStack.filter((e) => e.layerId !== id);
    this.notifyHistory();
  }

  copyLayer(srcId: string, dstId: string): void {
    this.ensureLayer(dstId);
    const src = this.layers.get(srcId);
    const dst = this.layers.get(dstId);
    if (!src || !dst) return;
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: src }, { texture: dst }, [
      this.docWidth,
      this.docHeight,
    ]);
    this.device.queue.submit([enc.finish()]);
  }

  private clearTexture(
    tex: GPUTexture,
    rgba: [number, number, number, number] = [0, 0, 0, 0],
  ): void {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: tex.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] },
        },
      ],
    });
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /** `mask` is a doc-sized, single-channel coverage bitmap, or null to clear. */
  setSelectionMask(mask: Uint8Array<ArrayBuffer> | null): void {
    if (!mask) {
      this.selectionTex?.destroy();
      this.selectionTex = null;
      return;
    }
    if (!this.selectionTex) {
      this.selectionTex = this.device.createTexture({
        label: 'selection',
        size: [this.docWidth, this.docHeight],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    }
    this.uploadTexture(this.selectionTex, mask, this.docWidth, this.docHeight, 1);
  }

  // -------------------------------------------------------------------------
  // Strokes
  // -------------------------------------------------------------------------

  /** StampU layout shared by the primary and dual stamp passes. */
  private fillStampUniforms(
    target: GPUBuffer,
    hardness: number,
    tipTextured: boolean,
    tex: EngineTextureParams | null,
    noise: boolean,
  ): void {
    const u = new ArrayBuffer(48);
    const f = new Float32Array(u);
    const i = new Uint32Array(u);
    f[0] = this.docWidth;
    f[1] = this.docHeight;
    f[2] = hardness;
    f[3] = tipTextured ? 1 : 0;
    f[4] = tex && tex.eachTip ? 1 : 0;
    f[5] = tex ? tex.scalePx : 256;
    f[6] = noise ? 1 : 0;
    i[7] = tex ? TEXTURE_BLEND_INDEX[tex.mode] : 0;
    f[8] = tex ? tex.brightness : 0;
    f[9] = tex ? tex.contrast : 0;
    f[10] = tex && tex.invert ? 1 : 0;
    f[11] = tex ? tex.depth : 1;
    this.uploadBuffer(target, 0, u);
  }

  beginStroke(params: EngineStrokeParams): void {
    this.stroke = params;
    this.clearTexture(this.strokeTex);
    this.clearTexture(this.dualStrokeTex);

    this.strokeTipTex =
      params.tipShape === 'round'
        ? null
        : this.grayTexture(`tip:${params.tipShape}`, () => getTip(params.tipShape));
    this.strokePatternTex = params.texture
      ? this.grayTexture(`pat:${params.texture.pattern}`, () => getPattern(params.texture!.pattern))
      : null;
    this.strokeDualTipTex =
      params.dual && params.dual.shape !== 'round'
        ? this.grayTexture(`tip:${params.dual.shape}`, () => getTip(params.dual!.shape))
        : null;

    this.fillStampUniforms(
      this.stampUniforms,
      params.hardness,
      params.tipShape !== 'round',
      params.texture,
      params.noise,
    );
    if (params.dual) {
      this.fillStampUniforms(
        this.dualStampUniforms,
        params.dual.hardness,
        params.dual.shape !== 'round',
        null,
        false,
      );
    }
  }

  get strokeActive(): boolean {
    return this.stroke !== null;
  }

  get currentStroke(): EngineStrokeParams | null {
    return this.stroke;
  }

  /**
   * instances: packed STAMP_FLOATS records per stamp. `target` selects the
   * primary color stroke or the dual-brush coverage mask.
   */
  drawStamps(
    instances: Float32Array<ArrayBuffer>,
    count: number,
    target: 'primary' | 'dual' = 'primary',
  ): void {
    if (!this.stroke || count === 0) return;
    if (count > this.instanceCapacity) {
      while (this.instanceCapacity < count) this.instanceCapacity *= 2;
      this.instanceBuf.destroy();
      this.instanceBuf = this.device.createBuffer({
        size: this.instanceCapacity * STAMP_STRIDE,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.uploadBuffer(this.instanceBuf, 0, instances.subarray(0, count * STAMP_FLOATS));

    const dual = target === 'dual';
    const pipeline = dual ? this.stampPipelineDual : this.stampPipeline;
    const white = this.whiteTex.createView();
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: dual ? this.dualStampUniforms : this.stampUniforms } },
        { binding: 1, resource: (this.selectionTex ?? this.whiteTex).createView() },
        { binding: 2, resource: this.sampLinear },
        {
          binding: 3,
          resource: (dual ? this.strokeDualTipTex : this.strokeTipTex)?.createView() ?? white,
        },
        { binding: 4, resource: this.strokePatternTex?.createView() ?? white },
        { binding: 5, resource: this.sampRepeat },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: (dual ? this.dualStrokeTex : this.strokeTex).createView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, this.instanceBuf);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4, count);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Bakes the stroke into the layer and records an undo snapshot. */
  endStroke(layerId: string): void {
    const stroke = this.stroke;
    this.stroke = null;
    const layer = this.layers.get(layerId);
    if (!stroke || !layer) return;

    // Snapshot the pre-stroke pixels for undo (read is enqueued before the
    // commit pass below, so it captures the old contents).
    this.pushUndo(layerId);

    const u = new ArrayBuffer(80);
    const f = new Float32Array(u);
    const i = new Uint32Array(u);
    const tex = stroke.texture;
    const texOn = tex && !tex.eachTip;
    i[0] = stroke.mode === 'erase' ? 2 : 1;
    f[1] = stroke.opacity;
    i[2] = BLEND_MODE_INDEX[stroke.blendMode] ?? 0;
    f[3] = stroke.wetEdges ? 1 : 0;
    f[4] = texOn ? 1 : 0;
    f[5] = tex ? tex.scalePx : 256;
    i[6] = tex ? TEXTURE_BLEND_INDEX[tex.mode] : 0;
    f[7] = stroke.dual ? 1 : 0;
    f[8] = tex ? tex.brightness : 0;
    f[9] = tex ? tex.contrast : 0;
    f[10] = tex && tex.invert ? 1 : 0;
    f[11] = tex ? tex.depth : 1;
    i[12] = stroke.dual ? TEXTURE_BLEND_INDEX[stroke.dual.mode] : 0;
    f[16] = this.docWidth;
    f[17] = this.docHeight;
    this.uploadBuffer(this.commitUniforms, 0, u);

    const bindGroup = this.device.createBindGroup({
      layout: this.commitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampNearest },
        { binding: 1, resource: layer.createView() },
        { binding: 2, resource: this.strokeTex.createView() },
        { binding: 3, resource: { buffer: this.commitUniforms } },
        { binding: 4, resource: (this.strokePatternTex ?? this.whiteTex).createView() },
        { binding: 5, resource: this.sampRepeat },
        { binding: 6, resource: this.dualStrokeTex.createView() },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: this.scratch.createView(), loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(this.commitPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    enc.copyTextureToTexture(
      { texture: this.scratch },
      { texture: layer },
      [this.docWidth, this.docHeight],
    );
    this.device.queue.submit([enc.finish()]);

    this.clearTexture(this.strokeTex);
    this.clearTexture(this.dualStrokeTex);
  }

  cancelStroke(): void {
    this.stroke = null;
    this.clearTexture(this.strokeTex);
    this.clearTexture(this.dualStrokeTex);
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  private pushUndo(layerId: string): void {
    this.undoStack.push({ layerId, data: this.readLayer(layerId) });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.notifyHistory();
  }

  async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) return;
    if (!this.layers.has(entry.layerId)) {
      this.notifyHistory();
      return;
    }
    this.redoStack.push({ layerId: entry.layerId, data: this.readLayer(entry.layerId) });
    const data = await entry.data;
    this.writeLayer(entry.layerId, data);
    this.notifyHistory();
  }

  async redo(): Promise<void> {
    const entry = this.redoStack.pop();
    if (!entry) return;
    if (!this.layers.has(entry.layerId)) {
      this.notifyHistory();
      return;
    }
    this.undoStack.push({ layerId: entry.layerId, data: this.readLayer(entry.layerId) });
    const data = await entry.data;
    this.writeLayer(entry.layerId, data);
    this.notifyHistory();
  }

  private notifyHistory(): void {
    this.onHistoryChange(this.undoStack.length > 0, this.redoStack.length > 0);
  }

  private readLayer(layerId: string): Promise<Uint8Array<ArrayBuffer>> {
    const layer = this.layers.get(layerId);
    if (!layer) return Promise.resolve(new Uint8Array(0));
    return this.readTexture(layer, this.docWidth, this.docHeight);
  }

  private async readTexture(
    tex: GPUTexture,
    w: number,
    h: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const rowBytes = Math.ceil((w * 4) / 256) * 256;
    const buf = this.device.createBuffer({
      size: rowBytes * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: tex },
        { buffer: buf, bytesPerRow: rowBytes },
        [w, h],
      );
      this.device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buf.getMappedRange());
      const out = new Uint8Array(w * 4 * h);
      for (let y = 0; y < h; y++) {
        out.set(mapped.subarray(y * rowBytes, y * rowBytes + w * 4), y * w * 4);
      }
      buf.unmap();
      return out;
    } catch (err) {
      // GPU readback can fail on broken WebGPU stacks; degrade gracefully
      // (the corresponding undo step is skipped) instead of crashing.
      console.warn('[northlight] texture readback failed:', err);
      return new Uint8Array(0);
    } finally {
      buf.destroy();
    }
  }

  private writeLayer(layerId: string, data: Uint8Array<ArrayBuffer>): void {
    const layer = this.layers.get(layerId);
    if (!layer || data.length === 0) return;
    this.uploadTexture(layer, data, this.docWidth, this.docHeight, 4);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  resize(): boolean {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * devicePixelRatio));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * devicePixelRatio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      return true;
    }
    return false;
  }

  /** Runs the layer compositor into an accum texture and returns it. */
  private composite(enc: GPUCommandEncoder, state: RenderState): GPUTexture {
    const visible = state.layers.filter((l) => this.layers.has(l.id));

    // Write all per-layer uniform slices in one go.
    const buf = new ArrayBuffer(UNIFORM_SLICE * Math.max(1, visible.length));
    visible.forEach((meta, idx) => {
      const f = new Float32Array(buf, idx * UNIFORM_SLICE, LAYER_U_SIZE / 4);
      const u = new Uint32Array(buf, idx * UNIFORM_SLICE, LAYER_U_SIZE / 4);
      u[0] = BLEND_MODE_INDEX[meta.blendMode] ?? 0;
      f[1] = meta.opacity;
      const stroke = this.stroke;
      const strokeHere =
        stroke !== null && meta.id === state.activeLayerId && meta.visible;
      u[2] = strokeHere ? (stroke!.mode === 'erase' ? 2 : 1) : 0;
      if (strokeHere) {
        const tex = stroke.texture;
        const texOn = tex && !tex.eachTip;
        f[3] = stroke.opacity;
        u[4] = BLEND_MODE_INDEX[stroke.blendMode] ?? 0;
        f[5] = stroke.wetEdges ? 1 : 0;
        f[6] = texOn ? 1 : 0;
        f[7] = tex ? tex.scalePx : 256;
        f[8] = tex ? tex.brightness : 0;
        f[9] = tex ? tex.contrast : 0;
        f[10] = tex && tex.invert ? 1 : 0;
        f[11] = tex ? tex.depth : 1;
        u[12] = tex ? TEXTURE_BLEND_INDEX[tex.mode] : 0;
        f[13] = stroke.dual ? 1 : 0;
        u[14] = stroke.dual ? TEXTURE_BLEND_INDEX[stroke.dual.mode] : 0;
      }
      f[16] = this.docWidth;
      f[17] = this.docHeight;
    });
    this.uploadBuffer(this.layerUniforms, 0, buf);

    // Clear the first accumulation target.
    let read = 0;
    const clearPass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.accum[read].createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    clearPass.end();

    const patternView = (this.strokePatternTex ?? this.whiteTex).createView();
    visible.forEach((meta, idx) => {
      if (!meta.visible) return;
      const layerTex = this.layers.get(meta.id)!;
      const bindGroup = this.device.createBindGroup({
        layout: this.compositePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampNearest },
          { binding: 1, resource: this.accum[read].createView() },
          { binding: 2, resource: layerTex.createView() },
          { binding: 3, resource: this.strokeTex.createView() },
          { binding: 4, resource: { buffer: this.layerUniforms, size: LAYER_U_SIZE } },
          { binding: 5, resource: patternView },
          { binding: 6, resource: this.sampRepeat },
          { binding: 7, resource: this.dualStrokeTex.createView() },
        ],
      });
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.accum[1 - read].createView(),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(this.compositePipeline);
      pass.setBindGroup(0, bindGroup, [idx * UNIFORM_SLICE]);
      pass.draw(3);
      pass.end();
      read = 1 - read;
    });

    return this.accum[read];
  }

  private encodePresent(
    enc: GPUCommandEncoder,
    accum: GPUTexture,
    view: Viewport,
    target: GPUTextureView,
    viewW: number,
    viewH: number,
  ): void {
    const u = new ArrayBuffer(64);
    const f = new Float32Array(u);
    f[0] = viewW;
    f[1] = viewH;
    f[2] = this.docWidth;
    f[3] = this.docHeight;
    f[4] = view.panX;
    f[5] = view.panY;
    f[6] = view.zoom;
    f[7] = view.zoom >= 2 ? 1 : 0; // nearest sampling when zoomed in
    f[8] = 8 * devicePixelRatio; // checker cell size
    this.uploadBuffer(this.viewUniforms, 0, u);

    const bindGroup = this.device.createBindGroup({
      layout: this.presentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampLinear },
        { binding: 1, resource: this.sampNearest },
        { binding: 2, resource: accum.createView() },
        { binding: 3, resource: { buffer: this.viewUniforms } },
      ],
    });

    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0.118, g: 0.118, b: 0.125, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.presentPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  render(state: RenderState): void {
    this.resize();
    const enc = this.device.createCommandEncoder();
    const accum = this.composite(enc, state);
    this.encodePresent(
      enc,
      accum,
      state.view,
      this.context.getCurrentTexture().createView(),
      this.canvas.width,
      this.canvas.height,
    );
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * Runs the full pipeline (compositor + present pass) into an offscreen
   * texture and reads it back. Pixels are in the canvas's preferred format
   * (typically BGRA). Used by tests and available for thumbnails.
   */
  async renderOffscreen(
    state: RenderState,
    width: number,
    height: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const tex = this.device.createTexture({
      size: [width, height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const enc = this.device.createCommandEncoder();
    const accum = this.composite(enc, state);
    this.encodePresent(enc, accum, state.view, tex.createView(), width, height);
    this.device.queue.submit([enc.finish()]);
    const out = await this.readTexture(tex, width, height);
    tex.destroy();
    return out;
  }

  get canvasFormat(): GPUTextureFormat {
    return this.format;
  }

  /** Flattened document pixels (premultiplied RGBA), for export. */
  async readComposite(state: RenderState): Promise<Uint8Array<ArrayBuffer>> {
    const enc = this.device.createCommandEncoder();
    const accum = this.composite(enc, state);
    this.device.queue.submit([enc.finish()]);
    return this.readTexture(accum, this.docWidth, this.docHeight);
  }
}
