import * as brushAbr from '../brush/abr';
import * as brushBristle from '../brush/bristle';
import * as brushBristlePresets from '../brush/bristlePresets';
import * as brushDefaults from '../brush/defaults';
import * as brushDynamics from '../brush/dynamics';
import { bristleEngineParams, engineStrokeParams } from '../brush/engineParams';
import * as brushPatterns from '../brush/patterns';
import * as brushPresets from '../brush/presets';
import { tipOutline } from '../brush/tipOutline';
import * as color from '../color/convert';
import { PaintEngine } from '../gpu/engine';
import { rasterizeSelection } from '../gpu/selection';
import * as shaders from '../gpu/shaders';
import { BristleStrokeSession } from '../gpu/bristleStroke';
import { StrokeSession } from '../gpu/stroke';
import * as layersUtil from '../layers';
import * as transformInteraction from '../transform/interaction';
import * as transformQuad from '../transform/quad';
import { useStore } from '../store';
import { copySelection, cutSelection, paste } from './clipboard';
import { getEngine, setEngine } from './engineHost';
import * as layerOps from './layerOps';
import { importAbr } from './io';
import { selectAll, setSelection } from './selection';
import { fitOnScreen, nextZoomStop, zoomIn, zoomOut, zoomTo } from './view';

/**
 * Debug/test surface: exposes the store, engine, and controller operations
 * on window.__northlight for the GPU test suite and console exploration.
 */

const api = {
  store: useStore,
  engine: getEngine,
  shaders,
  color,
  PaintEngine,
  StrokeSession,
  BristleStrokeSession,
  rasterizeSelection,
  brush: {
    defaults: brushDefaults,
    dynamics: brushDynamics,
    patterns: brushPatterns,
    presets: brushPresets,
    abr: brushAbr,
    bristle: brushBristle,
    bristlePresets: brushBristlePresets,
    engineStrokeParams,
    bristleEngineParams,
    importAbr,
    tipOutline,
  },
  setEngine,
  edit: { selectAll, setSelection, copySelection, cutSelection, paste },
  layersUtil,
  layerOps,
  transformMath: { ...transformQuad, ...transformInteraction },
  view: { zoomIn, zoomOut, zoomTo, fitOnScreen, nextZoomStop },
};

declare global {
  interface Window {
    __northlight?: typeof api;
  }
}

window.__northlight = api;
