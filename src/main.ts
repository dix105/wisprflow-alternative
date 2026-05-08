import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';

const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+Space';

type StatusKind = 'idle' | 'recording' | 'working' | 'error' | 'success';

let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let shortcut = localStorage.getItem('shortcut') || DEFAULT_SHORTCUT;

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">Groq + Tauri</p>
      <h1>Universal Dictation</h1>
      <p class="subtitle">Press your shortcut, speak, press it again. The transcript is pasted into the active text field.</p>
    </section>

    <section class="card">
      <label>
        <span>Groq API key</span>
        <input id="apiKey" type="password" autocomplete="off" placeholder="gsk_..." />
      </label>
      <p class="hint">Stored locally in this app only. Create a key at Groq Console.</p>

      <label>
        <span>Global shortcut</span>
        <input id="shortcut" placeholder="CommandOrControl+Alt+Space" />
      </label>
      <p class="hint">Examples: <code>CommandOrControl+Alt+Space</code>, <code>Alt+Shift+D</code></p>

      <label class="check-row">
        <input id="autostart" type="checkbox" />
        <span>Open at Windows login and keep running from tray</span>
      </label>

      <div class="actions">
        <button id="save">Save shortcut</button>
        <button id="toggle" class="primary">Start recording</button>
      </div>
    </section>

    <section id="status" class="status idle">Ready</section>

    <section class="tips">
      <strong>How to use</strong>
      <ol>
        <li>Enter your Groq API key.</li>
        <li>Click into any text box in any app.</li>
        <li>Press the shortcut to start recording.</li>
        <li>Press it again to stop, transcribe, and paste.</li>
      </ol>
      <p>Close hides the app to the system tray. Double-click the tray icon to reopen, or right-click it for Show / Hide / Quit.</p>
      <p>Note: apps that block paste, elevated/admin windows, or secure password fields may not accept inserted text.</p>
    </section>
  </main>
`;

const apiKeyInput = document.querySelector<HTMLInputElement>('#apiKey')!;
const shortcutInput = document.querySelector<HTMLInputElement>('#shortcut')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const toggleButton = document.querySelector<HTMLButtonElement>('#toggle')!;
const autostartInput = document.querySelector<HTMLInputElement>('#autostart')!;
const statusBox = document.querySelector<HTMLElement>('#status')!;

apiKeyInput.value = localStorage.getItem('groqApiKey') || '';
shortcutInput.value = shortcut;

apiKeyInput.addEventListener('change', () => {
  localStorage.setItem('groqApiKey', apiKeyInput.value.trim());
});

saveButton.addEventListener('click', async () => {
  const next = shortcutInput.value.trim() || DEFAULT_SHORTCUT;
  await installShortcut(next);
});

toggleButton.addEventListener('click', () => toggleRecording());

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

function setStatus(kind: StatusKind, message: string) {
  statusBox.className = `status ${kind}`;
  statusBox.textContent = message;
  toggleButton.textContent = kind === 'recording' ? 'Stop and paste' : 'Start recording';
}

async function installShortcut(next: string) {
  try {
    if (shortcut && await isRegistered(shortcut)) {
      await unregister(shortcut);
    }
    await register(next, () => toggleRecording());
    shortcut = next;
    localStorage.setItem('shortcut', next);
    shortcutInput.value = next;
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
    setStatus('recording', 'Recording… press shortcut again to stop.');
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
    setStatus('working', 'Transcribing with Groq and pasting…');
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
    autostartInput.checked = await isEnabled();
  } catch (error) {
    setStatus('error', `Could not read login startup state: ${String(error)}`);
  }
}

installShortcut(shortcut);
loadAutostartState();
