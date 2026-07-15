import { CanvasView } from './CanvasView';
import { ColorPicker } from './ColorPicker';
import { LayersPanel } from './LayersPanel';
import { OptionsBar } from './OptionsBar';
import { Toolbar } from './Toolbar';

export function App() {
  return (
    <div className="app">
      <OptionsBar />
      <div className="app-body">
        <Toolbar />
        <CanvasView />
        <div className="side-panels">
          <ColorPicker />
          <LayersPanel />
        </div>
      </div>
    </div>
  );
}
