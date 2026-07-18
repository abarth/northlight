/**
 * Controller facade: bridges UI actions that need both the zustand store
 * (metadata) and the PaintEngine (GPU textures). The implementation lives in
 * src/controller/, one module per concern; everything is re-exported here so
 * callers can import from a single place.
 */
export * from './controller/engineHost';
export * from './controller/selection';
export * from './controller/transform';
export * from './controller/layerOps';
export * from './controller/clipboard';
export * from './controller/sampling';
export * from './controller/view';
export * from './controller/document';
export * from './controller/io';
export * from './controller/history';
import './controller/debug';
