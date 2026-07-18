import { getEngine } from './engineHost';
import { commitTransform } from './transform';

export function undo(): void {
  commitTransform(); // undoing right after reverts the just-baked float
  void getEngine()?.undo();
}

export function redo(): void {
  commitTransform();
  void getEngine()?.redo();
}
