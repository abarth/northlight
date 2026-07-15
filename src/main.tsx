import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';

// Note: no <StrictMode> — its double-mounted effects would configure the
// WebGPU canvas context twice concurrently and race the two devices.
createRoot(document.getElementById('root')!).render(<App />);
