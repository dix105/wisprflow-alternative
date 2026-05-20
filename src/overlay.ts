import { listen } from '@tauri-apps/api/event';
import './overlay.css';

type OverlayState = 'ready' | 'listening' | 'processing' | 'polishing' | 'inserted';

const overlay = document.querySelector<HTMLElement>('#overlay')!;
const label = document.querySelector<HTMLElement>('#label')!;

const labels: Record<OverlayState, string> = {
  ready: 'Dictate',
  listening: 'Listening',
  processing: 'Processing',
  polishing: 'Polishing',
  inserted: 'Inserted',
};

function setOverlayState(state: OverlayState) {
  overlay.className = `overlay ${state}`;
  label.textContent = labels[state] || labels.ready;
}

listen<OverlayState>('dictation-overlay-state', (event) => {
  setOverlayState(event.payload || 'ready');
});

setOverlayState('ready');
