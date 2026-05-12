import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';

const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+Space';
const HISTORY_KEY = 'flowDeskHistory';
const VOCABULARY_KEY = 'flowDeskVocabulary';

type StatusKind = 'idle' | 'recording' | 'working' | 'error' | 'success';
type ViewName = 'dictation' | 'shortcuts' | 'rewrite' | 'history';
type RewriteMode = 'clean' | 'professional' | 'shorter' | 'friendly';

type HistoryItem = {
  id: string;
  text: string;
  createdAt: string;
  rewrite?: string;
  rewriteMode?: RewriteMode;
};

let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let shortcut = localStorage.getItem('shortcut') || DEFAULT_SHORTCUT;
let capturingShortcut = false;
let historyItems: HistoryItem[] = loadHistory();
let selectedHistoryId = historyItems[0]?.id || '';
const isTauriRuntime = '__TAURI_INTERNALS__' in window;

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <main class="utility-shell">
    <section class="app-window">
      <header class="window-bar">
        <div class="traffic" aria-hidden="true"><span></span><span></span><span></span></div>
        <button class="brand-chip" data-view="dictation" type="button" aria-label="Go to recording">
          <span class="brand-mark">W</span>
          <span><strong>FlowDesk</strong><small>Desktop dictation</small></span>
        </button>
        <nav class="nav-list" aria-label="Primary">
          <button class="nav-item active" data-view="dictation" type="button">Record</button>
          <button class="nav-item" data-view="rewrite" type="button">Rewrite</button>
          <button class="nav-item" data-view="history" type="button">History</button>
          <button class="nav-item" data-view="shortcuts" type="button">Hotkey</button>
        </nav>
        <button id="settingsButton" class="icon-button" type="button" aria-expanded="false" aria-controls="settingsDrawer">Settings</button>
      </header>

      <section class="view-panel active" data-panel="dictation">
        <div class="record-layout">
          <aside class="control-pane">
            <div class="mode-label"><span class="live-dot"></span><span>Idle</span></div>
            <div class="orb-wrap" aria-hidden="true"><div id="recordOrb" class="record-orb"><span class="orb-core"></span><i></i><i></i><i></i><i></i></div></div>
            <button id="toggle" class="start-button" type="button"><span class="button-dot"></span>Start recording</button>
            <button id="openRewrite" class="ghost-button" type="button">Rewrite last transcript</button>
            <div id="status" class="status idle">Ready. Add your API key, then start recording.</div>
          </aside>

          <section class="work-pane">
            <div class="pane-header">
              <div><p class="eyebrow">Current transcript</p><h1>Ready to record</h1></div>
              <span class="model-chip">Whisper ready</span>
            </div>
            <div class="transcript-preview">
              <div class="empty-transcript">
                <span class="transcript-cursor"></span>
                <div>
                  <strong>No transcript yet</strong>
                  <p>Press the hotkey or Start recording. Text will paste into your active app and appear here for recovery.</p>
                </div>
              </div>
              <div class="transcript-tools">
                <button type="button">Copy</button>
                <button type="button">Paste again</button>
                <button type="button">Clear</button>
              </div>
            </div>
            <div class="setup-strip">
              <label class="api-pill"><span>Groq API key</span><input id="apiKey" type="password" autocomplete="off" placeholder="gsk_..." /></label>
              <div class="shortcut-pill"><span>Hotkey</span><button id="captureShortcut" class="shortcut-capture" type="button"><span id="shortcutValue">CommandOrControl + Alt + Space</span></button><button id="save" class="save-shortcut" type="button">Save</button></div>
            </div>
          </section>
        </div>
      </section>

      <section class="view-panel" data-panel="rewrite">
        <section class="utility-grid">
          <article class="panel-card"><div class="section-heading"><p class="eyebrow">Rewrite input</p><h2>Clean up rough dictation</h2></div><textarea id="rewriteInput" placeholder="Record something or paste text here..."></textarea><div class="rewrite-actions"><button data-rewrite="clean" type="button">Clean up</button><button data-rewrite="professional" type="button">Professional</button><button data-rewrite="shorter" type="button">Shorter</button><button data-rewrite="friendly" type="button">Friendly</button></div></article>
          <article class="panel-card result-card"><div class="section-heading"><p class="eyebrow">Output</p><h2>Ready text</h2></div><div id="rewriteOutput" class="rewrite-output empty">Your rewritten text will appear here.</div><div class="hero-actions"><button id="copyRewrite" class="ghost-button" type="button">Copy</button><button id="pasteRewrite" class="start-button" type="button"><span class="button-dot"></span>Paste</button></div></article>
        </section>
      </section>

      <section class="view-panel" data-panel="history">
        <article class="panel-card wide-card"><div class="section-heading"><p class="eyebrow">History</p><h2>Recent transcripts</h2></div><div id="historyList" class="history-list"></div></article>
      </section>

      <section class="view-panel" data-panel="shortcuts">
        <article class="panel-card wide-card shortcut-panel"><div class="section-heading"><p class="eyebrow">Hotkey</p><h2>Capture keys instead of typing combinations.</h2></div><div class="shortcut-lab"><button id="captureShortcutMirror" class="shortcut-capture large" type="button"><span id="shortcutValueMirror">Cmd/Ctrl + Alt + Space</span></button><button id="saveMirror" class="start-button" type="button"><span class="button-dot"></span>Save shortcut</button></div><div class="shortcut-presets"><button data-shortcut="CommandOrControl+Alt+Space" type="button">Cmd/Ctrl + Alt + Space</button><button data-shortcut="Alt+Shift+D" type="button">Alt + Shift + D</button><button data-shortcut="CommandOrControl+Shift+Space" type="button">Cmd/Ctrl + Shift + Space</button></div></article>
      </section>

      <footer class="status-bar"><span>Paste mode: Clipboard + Ctrl+V</span><span>Transcription: whisper-large-v3-turbo</span><span>History stored locally</span></footer>
    </section>

    <aside id="settingsDrawer" class="settings-drawer" aria-hidden="true">
      <div class="drawer-backdrop" id="drawerBackdrop"></div>
      <section class="drawer-panel" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="drawer-header"><div><p class="eyebrow">Settings</p><h2>Preferences</h2></div><button id="closeSettings" class="icon-button" type="button">Close</button></div>
        <label class="settings-label"><span>Groq API key</span><input id="drawerApiKey" type="password" autocomplete="off" placeholder="gsk_..." /></label>
        <label class="settings-label"><span>Common words / vocabulary</span><textarea id="vocabularyInput" class="compact-textarea" placeholder="Dixit, FlowDesk, Groq, OpenClaw, Wispr"></textarea><small>Used as Whisper prompt guidance so common words print correctly during transcription.</small></label>
        <label class="check-row"><input id="autostart" type="checkbox" /><span>Open at Windows login and keep running from tray</span></label>
        <div class="settings-grid"><div><span class="mini-label">Provider</span><strong>Groq</strong></div><div><span class="mini-label">Transcription</span><strong>whisper-large-v3-turbo</strong></div><div><span class="mini-label">Rewrite</span><strong>llama-3.3-70b-versatile</strong></div><div><span class="mini-label">Paste</span><strong>Clipboard + Ctrl+V</strong></div></div>
      </section>
    </aside>

    <div id="miniWidget" class="mini-widget" hidden><span class="mini-wave"></span><strong>Recording</strong><button id="miniStop" type="button">Stop</button></div>
  </main>
`;

const apiKeyInput = document.querySelector<HTMLInputElement>('#apiKey')!;
const drawerApiKeyInput = document.querySelector<HTMLInputElement>('#drawerApiKey')!;
const vocabularyInput = document.querySelector<HTMLTextAreaElement>('#vocabularyInput')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const saveMirrorButton = document.querySelector<HTMLButtonElement>('#saveMirror')!;
const toggleButton = document.querySelector<HTMLButtonElement>('#toggle')!;
const captureShortcutButton = document.querySelector<HTMLButtonElement>('#captureShortcut')!;
const captureShortcutMirrorButton = document.querySelector<HTMLButtonElement>('#captureShortcutMirror')!;
const shortcutValue = document.querySelector<HTMLElement>('#shortcutValue')!;
const shortcutValueMirror = document.querySelector<HTMLElement>('#shortcutValueMirror')!;
const settingsButton = document.querySelector<HTMLButtonElement>('#settingsButton')!;
const closeSettingsButton = document.querySelector<HTMLButtonElement>('#closeSettings')!;
const drawerBackdrop = document.querySelector<HTMLDivElement>('#drawerBackdrop')!;
const settingsDrawer = document.querySelector<HTMLElement>('#settingsDrawer')!;
const autostartInput = document.querySelector<HTMLInputElement>('#autostart')!;
const statusBox = document.querySelector<HTMLElement>('#status')!;
const recordOrb = document.querySelector<HTMLElement>('#recordOrb')!;
const miniWidget = document.querySelector<HTMLElement>('#miniWidget')!;
const miniStopButton = document.querySelector<HTMLButtonElement>('#miniStop')!;
const rewriteInput = document.querySelector<HTMLTextAreaElement>('#rewriteInput')!;
const rewriteOutput = document.querySelector<HTMLElement>('#rewriteOutput')!;
const historyList = document.querySelector<HTMLElement>('#historyList')!;
const openRewriteButton = document.querySelector<HTMLButtonElement>('#openRewrite')!;
const copyRewriteButton = document.querySelector<HTMLButtonElement>('#copyRewrite')!;
const pasteRewriteButton = document.querySelector<HTMLButtonElement>('#pasteRewrite')!;

apiKeyInput.value = localStorage.getItem('groqApiKey') || '';
drawerApiKeyInput.value = apiKeyInput.value;
vocabularyInput.value = localStorage.getItem(VOCABULARY_KEY) || '';
renderShortcut(shortcut);
renderHistory();
hydrateRewriteFromHistory();

apiKeyInput.addEventListener('change', syncApiKey);
drawerApiKeyInput.addEventListener('change', syncApiKey);
vocabularyInput.addEventListener('input', () => {
  localStorage.setItem(VOCABULARY_KEY, vocabularyInput.value.trim());
});

function syncApiKey() {
  const key = (document.activeElement === drawerApiKeyInput ? drawerApiKeyInput.value : apiKeyInput.value).trim();
  apiKeyInput.value = key;
  drawerApiKeyInput.value = key;
  localStorage.setItem('groqApiKey', key);
}

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view as ViewName));
});

document.querySelectorAll<HTMLButtonElement>('[data-shortcut]').forEach((button) => {
  button.addEventListener('click', () => {
    shortcut = button.dataset.shortcut || DEFAULT_SHORTCUT;
    renderShortcut(shortcut);
    setStatus('idle', `Shortcut preset selected: ${formatShortcutLabel(shortcut)}. Click Save to register it.`);
  });
});

captureShortcutButton.addEventListener('click', beginShortcutCapture);
captureShortcutMirrorButton.addEventListener('click', beginShortcutCapture);
saveButton.addEventListener('click', () => installShortcut(shortcut));
saveMirrorButton.addEventListener('click', () => installShortcut(shortcut));
toggleButton.addEventListener('click', () => toggleRecording());
miniStopButton.addEventListener('click', () => toggleRecording());
settingsButton.addEventListener('click', openSettings);
closeSettingsButton.addEventListener('click', closeSettings);
drawerBackdrop.addEventListener('click', closeSettings);
openRewriteButton.addEventListener('click', () => setView('rewrite'));

window.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') closeSettings();
  if (!capturingShortcut) return;
  event.preventDefault();

  const next = shortcutFromEvent(event);
  if (!next) return;

  capturingShortcut = false;
  captureShortcutButton.classList.remove('capturing');
  captureShortcutMirrorButton.classList.remove('capturing');
  shortcut = next;
  renderShortcut(next);
  setStatus('success', `Shortcut captured: ${formatShortcutLabel(next)}. Click Save to register it.`);
});

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

document.querySelectorAll<HTMLButtonElement>('[data-rewrite]').forEach((button) => {
  button.addEventListener('click', () => rewriteCurrentText(button.dataset.rewrite as RewriteMode));
});

copyRewriteButton.addEventListener('click', async () => {
  const text = getRewriteText();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus('success', 'Rewritten text copied.');
});

pasteRewriteButton.addEventListener('click', async () => {
  const text = getRewriteText();
  if (!text) return;

  if (!isTauriRuntime) {
    await navigator.clipboard.writeText(text);
    setStatus('idle', 'Preview mode: copied rewritten text instead of pasting.');
    return;
  }

  await invoke('paste_transcript', { text });
  setStatus('success', 'Rewritten text pasted into the focused app.');
});

function setView(view: ViewName) {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', (button as HTMLElement).dataset.view === view);
  });
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    panel.classList.toggle('active', (panel as HTMLElement).dataset.panel === view);
  });
  if (view === 'history') renderHistory();
  if (view === 'rewrite') hydrateRewriteFromHistory();
}

function beginShortcutCapture() {
  capturingShortcut = true;
  captureShortcutButton.classList.add('capturing');
  captureShortcutMirrorButton.classList.add('capturing');
  shortcutValue.textContent = 'Press your shortcut…';
  shortcutValueMirror.textContent = 'Press your shortcut…';
}

function openSettings() {
  settingsDrawer.classList.add('open');
  settingsDrawer.setAttribute('aria-hidden', 'false');
  settingsButton.setAttribute('aria-expanded', 'true');
}

function closeSettings() {
  settingsDrawer.classList.remove('open');
  settingsDrawer.setAttribute('aria-hidden', 'true');
  settingsButton.setAttribute('aria-expanded', 'false');
}

function setStatus(kind: StatusKind, message: string) {
  statusBox.className = `status ${kind}`;
  statusBox.textContent = message;
  recordOrb.className = `record-orb ${kind}`;
  miniWidget.hidden = kind !== 'recording';
  toggleButton.innerHTML = kind === 'recording'
    ? '<span class="button-dot"></span>Stop and paste'
    : '<span class="button-dot"></span>Start recording';
}

function renderShortcut(value: string) {
  const html = value
    .split('+')
    .map((part) => `<kbd>${displayShortcutPart(part.trim())}</kbd>`)
    .join('<span class="shortcut-plus">+</span>');

  shortcutValue.innerHTML = html;
  shortcutValueMirror.innerHTML = html;
}

function displayShortcutPart(part: string) {
  return part === 'CommandOrControl' ? 'Cmd/Ctrl' : part;
}

function formatShortcutLabel(value: string) {
  return value.split('+').map((part) => displayShortcutPart(part.trim())).join(' + ');
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
      setStatus('idle', `Preview mode: shortcut saved as ${formatShortcutLabel(next)}. It registers inside the desktop app.`);
      return;
    }

    if (shortcut && await isRegistered(shortcut)) {
      await unregister(shortcut);
    }
    await register(next, () => toggleRecording());
    shortcut = next;
    localStorage.setItem('shortcut', next);
    renderShortcut(next);
    setStatus('success', `Shortcut registered: ${formatShortcutLabel(next)}`);
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
    syncApiKey();
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
      vocabularyPrompt: buildVocabularyPrompt(),
    });

    addHistory(text);
    rewriteInput.value = text;
    setStatus('success', `Pasted and saved to history: ${text}`);
  } catch (error) {
    setStatus('error', String(error));
  } finally {
    recorder = null;
    chunks = [];
  }
}

async function rewriteCurrentText(mode: RewriteMode) {
  const text = rewriteInput.value.trim() || historyItems[0]?.text || '';
  if (!text) {
    setStatus('error', 'Record or paste text before rewriting.');
    return;
  }
  if (!apiKeyInput.value.trim()) {
    setStatus('error', 'Add your Groq API key first.');
    return;
  }

  try {
    rewriteOutput.classList.remove('empty');
    rewriteOutput.textContent = 'Rewriting…';
    const rewritten = await invoke<string>('rewrite_text', {
      apiKey: apiKeyInput.value.trim(),
      text,
      mode,
    });
    rewriteOutput.textContent = rewritten;
    attachRewriteToSelected(rewritten, mode);
    setStatus('success', `Rewrite ready: ${mode}`);
  } catch (error) {
    rewriteOutput.textContent = String(error);
    setStatus('error', String(error));
  }
}

function getRewriteText() {
  const text = rewriteOutput.textContent?.trim() || '';
  if (!text || text === 'Your rewritten text will appear here.' || text === 'Rewriting…') {
    setStatus('error', 'No rewritten text yet.');
    return '';
  }
  return text;
}

function buildVocabularyPrompt() {
  const vocabulary = vocabularyInput.value
    .split(/[\n,]/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 80)
    .join(', ');

  if (!vocabulary) return '';
  return `This is desktop dictation. Use these preferred spellings and common terms when heard: ${vocabulary}.`;
}

function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(historyItems.slice(0, 25)));
}

function addHistory(text: string) {
  const item: HistoryItem = {
    id: crypto.randomUUID(),
    text,
    createdAt: new Date().toISOString(),
  };
  historyItems = [item, ...historyItems].slice(0, 25);
  selectedHistoryId = item.id;
  saveHistory();
  renderHistory();
}

function attachRewriteToSelected(rewrite: string, mode: RewriteMode) {
  const id = selectedHistoryId || historyItems[0]?.id;
  if (!id) return;
  historyItems = historyItems.map((item) => item.id === id ? { ...item, rewrite, rewriteMode: mode } : item);
  saveHistory();
  renderHistory();
}

function hydrateRewriteFromHistory() {
  const item = historyItems.find((entry) => entry.id === selectedHistoryId) || historyItems[0];
  if (!item) return;
  selectedHistoryId = item.id;
  rewriteInput.value = item.text;
  rewriteOutput.textContent = item.rewrite || 'Your rewritten text will appear here.';
  rewriteOutput.classList.toggle('empty', !item.rewrite);
}

function renderHistory() {
  if (!historyItems.length) {
    historyList.innerHTML = '<div class="empty-state">No transcripts yet. Start a recording and your recent dictations will appear here.</div>';
    return;
  }

  historyList.innerHTML = historyItems.map((item) => `
    <article class="history-item ${item.id === selectedHistoryId ? 'selected' : ''}" data-history-id="${item.id}">
      <div>
        <time>${formatDate(item.createdAt)}</time>
        <p>${escapeHtml(item.text)}</p>
        ${item.rewrite ? `<small>${item.rewriteMode}: ${escapeHtml(item.rewrite)}</small>` : ''}
      </div>
      <div class="history-actions">
        <button data-history-action="rewrite" type="button">Rewrite</button>
        <button data-history-action="copy" type="button">Copy</button>
      </div>
    </article>
  `).join('');

  historyList.querySelectorAll<HTMLElement>('.history-item').forEach((itemEl) => {
    itemEl.addEventListener('click', () => {
      selectedHistoryId = itemEl.dataset.historyId || '';
      hydrateRewriteFromHistory();
      renderHistory();
    });
  });

  historyList.querySelectorAll<HTMLButtonElement>('[data-history-action]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const container = button.closest<HTMLElement>('[data-history-id]');
      const item = historyItems.find((entry) => entry.id === container?.dataset.historyId);
      if (!item) return;
      selectedHistoryId = item.id;
      hydrateRewriteFromHistory();
      if (button.dataset.historyAction === 'rewrite') setView('rewrite');
      if (button.dataset.historyAction === 'copy') {
        await navigator.clipboard.writeText(item.text);
        setStatus('success', 'Transcript copied.');
      }
    });
  });
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char] || char));
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
