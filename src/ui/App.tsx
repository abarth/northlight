import { CanvasView } from './CanvasView';
import { ColorPicker } from './ColorPicker';
import { BrushesPanel } from './BrushesPanel';
import { BrushSettingsPanel } from './BrushSettingsPanel';
import { Dialogs } from './dialogs';
import { LayersPanel } from './LayersPanel';
import { MenuBar } from './MenuBar';
import { OptionsBar } from './OptionsBar';
import { Toolbar } from './Toolbar';
import { useStore, type SideTab } from '../store';

const TABS: { id: SideTab; label: string }[] = [
  { id: 'color', label: 'Color' },
  { id: 'brushes', label: 'Brushes' },
  { id: 'settings', label: 'Brush Settings' },
];

export function App() {
  const sideTab = useStore((s) => s.sideTab);
  const setSideTab = useStore((s) => s.setSideTab);

  return (
    <div className="app">
      <MenuBar />
      <OptionsBar />
      <div className="app-body">
        <Toolbar />
        <CanvasView />
        <div className="side-panels">
          <div className="side-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`side-tab ${sideTab === t.id ? 'active' : ''}`}
                onClick={() => setSideTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="side-tab-content">
            {sideTab === 'color' && <ColorPicker />}
            {sideTab === 'brushes' && <BrushesPanel />}
            {sideTab === 'settings' && <BrushSettingsPanel />}
          </div>
          <LayersPanel />
        </div>
      </div>
      <Dialogs />
    </div>
  );
}
