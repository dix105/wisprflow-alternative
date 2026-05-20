import { listen } from '@tauri-apps/api/event';
import './overlay.css';

type OverlayState = 'ready' | 'listening' | 'processing' | 'polishing' | 'inserted';

const overlay = document.querySelector<HTMLElement>('#overlay')!;
const dots = Array.from(document.querySelectorAll<HTMLElement>('.wave-pill i'));

const dotMultipliers = [0.45, 0.72, 1.05, 1.38, 1.02, 0.72, 0.48];
let listening = false;
let lastLevelAt = 0;
let fallbackFrame = 0;

function setOverlayState(state: OverlayState) {
  listening = state === 'listening';
  overlay.className = `overlay ${state}`;
  if (state !== 'listening') setLevel(state === 'inserted' ? 0.55 : 0.08);
}

function setLevel(rawLevel: number) {
  const level = Math.max(0, Math.min(1, rawLevel));
  dots.forEach((dot, index) => {
    const height = 4 + level * 24 * dotMultipliers[index % dotMultipliers.length];
    dot.style.setProperty('--dot-height', `${Math.max(4, Math.min(30, height))}px`);
    dot.style.opacity = String(0.45 + level * 0.55);
  });
}

function fallbackWave() {
  if (listening && Date.now() - lastLevelAt > 260) {
    const t = Date.now() / 160;
    dots.forEach((dot, index) => {
      const wave = (Math.sin(t + index * 0.8) + 1) / 2;
      dot.style.setProperty('--dot-height', `${5 + wave * 14}px`);
      dot.style.opacity = String(0.5 + wave * 0.42);
    });
  }
  fallbackFrame = window.requestAnimationFrame(fallbackWave);
}

listen<OverlayState>('dictation-overlay-state', (event) => {
  setOverlayState(event.payload || 'ready');
});

listen<number>('dictation-overlay-level', (event) => {
  if (!listening) return;
  lastLevelAt = Date.now();
  setLevel(event.payload || 0);
});

setOverlayState('ready');
fallbackWave();
window.addEventListener('beforeunload', () => cancelAnimationFrame(fallbackFrame));
