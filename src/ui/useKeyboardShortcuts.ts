import { useEffect, useRef } from 'react';
import {
  addLayer,
  applyZoom,
  arrangeActiveLayer,
  copySelection,
  cutSelection,
  deleteSelectionContents,
  fillActiveLayer,
  fitOnScreen,
  groupActiveLayer,
  invertSelection,
  layerViaCopy,
  mergeDown,
  mergeVisible,
  nudgeMoveSession,
  paste,
  redo,
  reselect,
  selectAll,
  selectNeighborLayer,
  setSelection,
  startTransform,
  toggleActiveLayerLock,
  toggleActiveLayerVisibility,
  transformQuadBy,
  undo,
  ungroupActiveLayer,
  zoomIn,
  zoomOut,
} from '../controller';
import { translation } from '../transform/matrix';
import { useStore } from '../store';

export interface ModifierState {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Canvas-view collaborators the global shortcuts need to reach. */
export interface KeyboardDeps {
  /** held-modifier flags shared with the pointer logic (temporary tools) */
  spaceRef: React.MutableRefObject<boolean>;
  altRef: React.MutableRefObject<boolean>;
  ctrlRef: React.MutableRefObject<boolean>;
  /** two-digit opacity/flow typing buffer */
  digitRef: React.MutableRefObject<{ str: string; at: number; target: 'opacity' | 'flow' }>;
  setAltDown: (v: boolean) => void;
  syncOverride: () => void;
  updateHoverCursor: (mods: ModifierState) => void;
  /** Enter: apply the transform, or close the polygonal lasso */
  onEnter: () => void;
  /** Escape: cancel the transform / poly / stroke, else deselect */
  onEscape: () => void;
}

/**
 * The Photoshop-style global keyboard map: temporary-tool modifiers, tool
 * keys, brush size/hardness/opacity, clipboard, selection, zoom, layer and
 * transform shortcuts. Listens on window; fields and text inputs are left
 * alone.
 */
export function useKeyboardShortcuts(deps: KeyboardDeps): void {
  // handlers always act through the ref so they see the latest closures
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const isEditable = (t: EventTarget | null) =>
      t instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const d = depsRef.current;
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (e.code === 'Space') {
        if (!d.spaceRef.current) {
          d.spaceRef.current = true;
          d.syncOverride();
        }
        e.preventDefault();
        return;
      }
      // modifier transitions retarget the hover cursor immediately
      // (selection-op badges, Ctrl distort/perspective handles)
      if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) {
        d.updateHoverCursor(e);
      }
      if (e.key === 'Alt') {
        if (!d.altRef.current) {
          d.altRef.current = true;
          d.setAltDown(true);
          d.syncOverride();
        }
        e.preventDefault(); // keep the browser from focusing its menu bar
        return;
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        if (!d.ctrlRef.current) {
          d.ctrlRef.current = true;
          d.syncOverride();
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      // Ctrl+Shift+I inverse, Ctrl+Shift+D reselect, Ctrl+Shift+N new layer
      if (mod && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        invertSelection();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        reselect();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        addLayer();
        return;
      }
      // Alt+Ctrl+I / Alt+Ctrl+C open the Image Size / Canvas Size dialogs
      if (mod && e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        s.setDialog('imageSize');
        return;
      }
      if (mod && e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        s.setDialog('canvasSize');
        return;
      }
      // Clipboard: Ctrl+X cut, Ctrl+C copy, Shift+Ctrl+C copy merged,
      // Ctrl+V paste, Shift+Ctrl+V paste in place.
      if (mod && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        void cutSelection();
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void copySelection(e.shiftKey);
        return;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        paste(e.shiftKey);
        return;
      }
      // Ctrl+H toggles Extras (selection edges), like Photoshop
      if (mod && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        s.setShowExtras(!s.showExtras);
        return;
      }
      // Ctrl+= / Ctrl+- step through the zoom stops
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (mod && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        zoomOut();
        return;
      }
      // Ctrl+Alt+0 = 100%, like Photoshop's Actual Pixels
      if (mod && e.altKey && e.key === '0') {
        e.preventDefault();
        applyZoom(1);
        return;
      }
      if (mod && e.key.toLowerCase() === 't') {
        e.preventDefault();
        void startTransform('layer', 'free');
        return;
      }
      // Layer shortcuts: Ctrl+E merge down (or group), Shift+Ctrl+E merge
      // visible, Ctrl+G / Shift+Ctrl+G group / ungroup, Ctrl+J / Shift+Ctrl+J
      // layer via copy / cut, Ctrl+, hide layer — all like Photoshop.
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        if (e.shiftKey) void mergeVisible();
        else mergeDown();
        return;
      }
      if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) ungroupActiveLayer();
        else groupActiveLayer();
        return;
      }
      if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        void layerViaCopy(e.shiftKey);
        return;
      }
      if (mod && e.key === ',') {
        e.preventDefault();
        toggleActiveLayerVisibility();
        return;
      }
      // Ctrl+[ / Ctrl+] rearrange the layer stack (Shift jumps to the ends)
      if (mod && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        e.preventDefault();
        const up = e.code === 'BracketRight';
        arrangeActiveLayer(
          e.shiftKey ? (up ? 'front' : 'back') : up ? 'forward' : 'backward',
        );
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        setSelection(null);
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
        return;
      }
      if (mod && e.key === '0') {
        e.preventDefault();
        fitOnScreen();
        return;
      }
      if (mod && e.key === '1') {
        e.preventDefault();
        applyZoom(1);
        return;
      }
      // Photoshop fill/clear shortcuts: Alt+Backspace fills the foreground
      // color, Ctrl+Backspace the background color (both clip to a selection
      // when one exists); plain Backspace/Delete clears the selected pixels.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        if (e.altKey) fillActiveLayer('fg');
        else if (mod) fillActiveLayer('bg');
        else if (s.selectionPaths) deleteSelectionContents();
        return;
      }
      // Arrows nudge the transform box, or the layer/selection with Move (V)
      if (e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (dx === 0 && dy === 0) return;
        if (s.transform) {
          e.preventDefault();
          transformQuadBy(translation(dx, dy));
        } else if (s.tool === 'move') {
          e.preventDefault();
          nudgeMoveSession(dx, dy);
        }
        return;
      }
      if (mod) return;

      // Alt+[ / Alt+] step the active layer down/up the stack, like Photoshop
      if (e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        selectNeighborLayer(e.code === 'BracketRight' ? 'up' : 'down');
        return;
      }

      // Photoshop numeric shortcuts: digits set opacity, Shift+digits set
      // flow — swapped while the airbrush toggle is on. Two digits typed
      // quickly combine (4 then 5 -> 45%); 0 means 100%. Match on e.code so
      // Shift+7 ('&' as a key) still counts as a digit.
      const digitMatch = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
      if (digitMatch && (s.tool === 'brush' || s.tool === 'eraser')) {
        const digit = digitMatch[1];
        const toolKey = s.tool;
        const settings = s[toolKey];
        const target: 'opacity' | 'flow' =
          e.shiftKey === settings.airbrush ? 'opacity' : 'flow';
        const now = performance.now();
        const buf = d.digitRef.current;
        let str =
          now - buf.at < 700 && buf.target === target ? buf.str + digit : digit;
        if (str.length > 2) str = str.slice(-2);
        d.digitRef.current = { str, at: now, target };
        let val = parseInt(str, 10);
        if (str.length === 1) val *= 10; // single digit means N*10%
        if (val === 0) val = 100;
        s.updateBrush({ [target]: val / 100 } as never, toolKey);
        return;
      }

      // Shift+[ / ] step hardness by 25%, like Photoshop.
      if (e.shiftKey && (e.key === '{' || e.key === '}')) {
        const toolKey = s.tool === 'eraser' ? 'eraser' : 'brush';
        const tip = s[toolKey].tip;
        const dir = e.key === '}' ? 0.25 : -0.25;
        s.updateBrush(
          { tip: { ...tip, hardness: Math.min(1, Math.max(0, tip.hardness + dir)) } },
          toolKey,
        );
        return;
      }

      switch (e.key) {
        case 'v': s.setTool('move'); break;
        case 'b': s.setTool('brush'); break;
        case 'e': s.setTool('eraser'); break;
        case 'i': s.setTool('eyedropper'); break;
        case 'h': s.setTool('pan'); break;
        case 'z': s.setTool('zoom'); break;
        case 'm': s.setTool('marquee'); break;
        case 'l': s.setTool('lasso'); break;
        case 'p': s.setTool('polyLasso'); break;
        case 'x': s.swapColors(); break;
        case 'd': s.resetColors(); break;
        case '/': toggleActiveLayerLock('transparency'); break;
        case '[': {
          const t = s.tool === 'eraser' ? 'eraser' : 'brush';
          const tip = s[t].tip;
          const size = Math.max(1, tip.size - Math.max(1, Math.round(tip.size * 0.1)));
          s.updateBrush({ tip: { ...tip, size } }, t);
          break;
        }
        case ']': {
          const t = s.tool === 'eraser' ? 'eraser' : 'brush';
          const tip = s[t].tip;
          const size = Math.min(1000, tip.size + Math.max(1, Math.round(tip.size * 0.1)));
          s.updateBrush({ tip: { ...tip, size } }, t);
          break;
        }
        case 'Enter':
          d.onEnter();
          break;
        case 'Escape':
          d.onEscape();
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const d = depsRef.current;
      if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) {
        d.updateHoverCursor(e);
      }
      if (e.code === 'Space') {
        d.spaceRef.current = false;
        d.syncOverride();
      } else if (e.key === 'Alt') {
        d.altRef.current = false;
        d.setAltDown(false);
        d.syncOverride();
        e.preventDefault();
      } else if (e.key === 'Control' || e.key === 'Meta') {
        d.ctrlRef.current = false;
        d.syncOverride();
      }
    };

    // Alt+Tab and friends: key-up events never arrive, so drop all overrides
    const onBlur = () => {
      const d = depsRef.current;
      d.spaceRef.current = false;
      d.altRef.current = false;
      d.ctrlRef.current = false;
      d.setAltDown(false);
      d.syncOverride();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
