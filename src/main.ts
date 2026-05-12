import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';

const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+Space';

type StatusKind = 'idle' | 'recording' | 'working' | 'error' | 'success';

let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let shortcut = localStorage.getItem('shortcut') || DEFAULT_SHORTCUT;
let capturingShortcut = false;
const isTauriRuntime = '__TAURI_INTERNALS__' in window;

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <main class="app-shell">
    <aside class="sidebar" aria-label="Dictation dashboard navigation">
      <div class="brand-block">
        <div class="brand-mark">W</div>
        <div>
          <p class="brand-kicker">Wispr alternative</p>
          <h1>FlowDesk</h1>
        </div>
      </div>

      <nav class="nav-list" aria-label="Primary">
        <button class="nav-item active" type="button">
          <span class="nav-icon">✦</span>
          Dictation
        </button>
        <button class="nav-item" type="button">
          <span class="nav-icon">⌘</span>
          Shortcuts
        </button>
        <button class="nav-item" type="button">
          <span class="nav-icon">✎</span>
          Rewrite
        </button>
        <button class="nav-item" type="button">
          <span class="nav-icon">◷</span>
          History
        </button>
      </nav>

      <div class="sidebar-card">
        <span class="pulse-dot"></span>
        <strong>Ready for MVP</strong>
        <p>Groq transcription, global shortcut, paste into focused app.</p>
      </div>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">Desktop voice input</p>
          <h2>Fast dictation that feels like a command center.</h2>
        </div>
        <button id="settingsButton" class="icon-button" type="button" aria-expanded="false" aria-controls="settingsPanel">
          <span>⚙</span>
          Settings
        </button>
      </header>

      <section class="hero-grid">
        <article class="record-widget" aria-live="polite">
          <div class="orb-wrap" aria-hidden="true">
            <div id="recordOrb" class="record-orb">
              <span></span>
            </div>
          </div>
          <p class="widget-label">Universal dictation</p>
          <h3>Press start, speak naturally, paste anywhere.</h3>
          <p class="widget-copy">Use the global shortcut or the start button. When you stop, FlowDesk transcribes with Groq and pastes into the active field.</p>
          <div class="widget-actions">
            <button id="toggle" class="start-button" type="button">
              <span class="button-dot"></span>
              Start recording
            </button>
          </div>
          <div id="status" class="status idle">Ready. Add your API key, then start recording.</div>
        </article>

        <article class="steps-card">
          <div class="section-heading">
            <p class="eyebrow">Setup</p>
            <h3>Three steps to first dictation</h3>
          </div>

          <ol class="setup-steps">
            <li>
              <span class="step-number">1</span>
              <div>
                <strong>Enter Groq API key</strong>
                <p>Paste your key once. It stays stored locally on this device.</p>
                <input id="apiKey" type="password" autocomplete="off" placeholder="gsk_..." />
              </div>
            </li>
            <li>
              <span class="step-number">2</span>
              <div>
                <strong>Choose shortcut with animation</strong>
                <p>Click capture, press the keys, and the shortcut button updates automatically.</p>
                <div class="shortcut-row">
                  <button id="captureShortcut" class="shortcut-capture" type="button">
                    <span id="shortcutValue">CommandOrControl + Alt + Space</span>
                  </button>
                  <button id="save" class="save-shortcut" type="button">Save</button>
                </div>
              </div>
            </li>
            <li>
              <span class="step-number">3</span>
              <div>
                <strong>Start and paste</strong>
                <p>Click Start or press the shortcut. Click again to stop, transcribe, and paste.</p>
              </div>
            </li>
          </ol>
        </article>
      </section>

      <section id="settingsPanel" class="settings-panel" hidden>
        <div class="section-heading">
          <p class="eyebrow">Settings</p>
          <h3>App preferences</h3>
        </div>
        <label class="check-row">
          <input id="autostart" type="checkbox" />
          <span>Open at Windows login and keep running from tray</span>
        </label>
        <div class="settings-grid">
          <div>
            <span class="mini-label">Provider</span>
            <strong>Groq</strong>
          </div>
          <div>
            <span class="mini-label">Model</span>
            <strong>whisper-large-v3-turbo</strong>
          </div>
          <div>
            <span class="mini-label">Paste mode</span>
            <strong>Clipboard + Ctrl+V</strong>
          </div>
        </div>
      </section>
    </section>
  </main>
`;

const apiKeyInput = document.querySelector<HTMLInputElement>('#apiKey')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const toggleButton = document.querySelector<HTMLButtonElement>('#toggle')!;
const captureShortcutButton = document.querySelector<HTMLButtonElement>('#captureShortcut')!;
const shortcutValue = document.querySelector<HTMLElement>('#shortcutValue')!;
const settingsButton = document.querySelector<HTMLButtonElement>('#settingsButton')!;
const settingsPanel = document.querySelector<HTMLElement>('#settingsPanel')!;
const autostartInput = document.querySelector<HTMLInputElement>('#autostart')!;
const statusBox = document.querySelector<HTMLElement>('#status')!;
const recordOrb = document.querySelector<HTMLElement>('#recordOrb')!;

apiKeyInput.value = localStorage.getItem('groqApiKey') || '';
renderShortcut(shortcut);

apiKeyInput.addEventListener('change', () => {
  localStorage.setItem('groqApiKey', apiKeyInput.value.trim());
});

captureShortcutButton.addEventListener('click', () => {
  capturingShortcut = true;
  captureShortcutButton.classList.add('capturing');
  shortcutValue.textContent = 'Press your shortcut…';
});

window.addEventListener('keydown', async (event) => {
  if (!capturingShortcut) return;
  event.preventDefault();

  const next = shortcutFromEvent(event);
  if (!next) return;

  capturingShortcut = false;
  captureShortcutButton.classList.remove('capturing');
  shortcut = next;
  renderShortcut(next);
  setStatus('success', `Shortcut captured: ${next}. Click Save to register it.`);
});

saveButton.addEventListener('click', async () => {
  await installShortcut(shortcut);
});

toggleButton.addEventListener('click', () => toggleRecording());
settingsButton.addEventListener('click', toggleSettings);

autostartInput.addEventListener('change', async () => {
  try {
    if (autostartInput.checked) {
      await enable();
      setStatus('success', 'App will open at Windows login.');
    } else {
      await disable();
      setStatus('success', 'App will not open at Windows login.');
    }
  } catch (error) {
    autostartInput.checked = !autostartInput.checked;
    setStatus('error', `Could not change login startup: ${String(error)}`);
  }
});

function toggleSettings() {
  const nextHidden = !settingsPanel.hidden;
  settingsPanel.hidden = nextHidden;
  settingsButton.setAttribute('aria-expanded', String(!nextHidden));
  if (!nextHidden) settingsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setStatus(kind: StatusKind, message: string) {
  statusBox.className = `status ${kind}`;
  statusBox.textContent = message;
  recordOrb.className = `record-orb ${kind}`;
  toggleButton.innerHTML = kind === 'recording'
    ? '<span class="button-dot"></span>Stop and paste'
    : '<span class="button-dot"></span>Start recording';
}

function renderShortcut(value: string) {
  shortcutValue.innerHTML = value
    .split('+')
    .map((part) => `<kbd>${displayShortcutPart(part.trim())}</kbd>`)
    .join('<span class="shortcut-plus">+</span>');
}

function displayShortcutPart(part: string) {
  return part === 'CommandOrControl' ? 'Cmd/Ctrl' : part;
}

function shortcutFromEvent(event: KeyboardEvent) {
  const key = normalizeKey(event.key);
  if (!key) return '';

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(key)) parts.push(key);
  return parts.length > 1 ? parts.join('+') : '';
}

function normalizeKey(key: string) {
  if (key === ' ') return 'Space';
  if (key === 'Control') return 'Control';
  if (key === 'Meta') return 'Meta';
  if (key === 'Alt') return 'Alt';
  if (key === 'Shift') return 'Shift';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

async function installShortcut(next: string) {
  try {
    if (!isTauriRuntime) {
      shortcut = next;
      localStorage.setItem('shortcut', next);
      renderShortcut(next);
      setStatus('idle', `Preview mode: shortcut saved as ${next}. It registers inside the desktop app.`);
      return;
    }

    if (shortcut && await isRegistered(shortcut)) {
      await unregister(shortcut);
    }
    await register(next, () => toggleRecording());
    shortcut = next;
    localStorage.setItem('shortcut', next);
    renderShortcut(next);
    setStatus('success', `Shortcut registered: ${next}`);
  } catch (error) {
    setStatus('error', `Could not register shortcut: ${String(error)}`);
  }
}

async function toggleRecording() {
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }

  try {
    localStorage.setItem('groqApiKey', apiKeyInput.value.trim());
    if (!apiKeyInput.value.trim()) {
      setStatus('error', 'Add your Groq API key first.');
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    recorder.addEventListener('stop', async () => {
      stream.getTracks().forEach((track) => track.stop());
      await transcribeAndPaste();
    }, { once: true });

    recorder.start();
    setStatus('recording', 'Recording… press shortcut or click stop when done.');
  } catch (error) {
    setStatus('error', `Mic error: ${String(error)}`);
  }
}

function pickMimeType() {
  const choices = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return choices.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

async function transcribeAndPaste() {
  try {
    setStatus('working', 'Transcribing with Groq and pasting into the focused app…');
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));

    const text = await invoke<string>('transcribe_and_paste', {
      apiKey: apiKeyInput.value.trim(),
      audioBytes: bytes,
    });

    setStatus('success', `Pasted: ${text}`);
  } catch (error) {
    setStatus('error', String(error));
  } finally {
    recorder = null;
    chunks = [];
  }
}

async function loadAutostartState() {
  try {
    if (!isTauriRuntime) return;
    autostartInput.checked = await isEnabled();
  } catch (error) {
    setStatus('error', `Could not read login startup state: ${String(error)}`);
  }
}

installShortcut(shortcut);
loadAutostartState();
