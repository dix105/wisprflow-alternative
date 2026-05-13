import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';

const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+Space';
const HISTORY_KEY = 'flowDeskHistory';
const VOCABULARY_KEY = 'flowDeskVocabulary';

type StatusKind = 'idle' | 'recording' | 'working' | 'error' | 'success';
type ViewName = 'dictation' | 'dictionary' | 'snippets' | 'style' | 'transforms' | 'scratchpad';
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
let pressedShortcutModifiers = new Set<string>();
let historyItems: HistoryItem[] = loadHistory();
let selectedHistoryId = historyItems[0]?.id || '';
const isTauriRuntime = '__TAURI_INTERNALS__' in window;

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <main class="app-layout">
      <aside class="side-rail" aria-label="FlowDesk navigation">
        <button class="brand-lockup" data-view="dictation" type="button">
          <span class="brand-bars"><i></i><i></i><i></i></span>
          <strong>FlowDesk</strong>
          <em>Beta</em>
        </button>

        <nav class="nav-list" aria-label="Primary">
          <button class="nav-item active" data-view="dictation" type="button"><span>⌘</span>Home</button>
          <button class="nav-item" data-view="dictionary" type="button"><span>▣</span>Dictionary</button>
          <button class="nav-item" data-view="scratchpad" type="button"><span>▤</span>Scratchpad</button>
        </nav>

      </aside>

      <section class="content-shell">
        <section class="view-panel active" data-panel="dictation">
          <header class="page-head">
            <div>
              <h1>Welcome back, Dixit</h1>
              <p>Dictate from anywhere. Press your shortcut, speak, and paste clean text back into the app you were using.</p>
            </div>
          </header>

          <article class="promo-card console-card">
            <div>
              <span class="console-kicker">Recording console</span>
              <h2>Ready for desktop dictation</h2>
              <p>Press the hotkey from any app. FlowDesk listens, transcribes, and pastes back into the field you were using.</p>
              <div class="promo-actions"><button id="toggle" class="primary-btn" type="button"><span class="button-dot"></span>Start recording</button><button id="openRewrite" class="secondary-btn" type="button">Rewrite last</button></div>
            </div>
            <div class="console-visual clean" aria-hidden="true">
              <div class="wave-card"><span></span><span></span><span></span><span></span><span></span></div>
            </div>
          </article>

          <section class="home-grid">
            <article class="setup-card hotkey-card">
              <div class="setup-heading">
                <div id="recordOrb" class="record-orb"><span class="orb-core"></span><i></i><i></i><i></i><i></i></div>
                <div><strong>Your dictation key</strong><span>Set once. Use everywhere.</span></div>
              </div>
              <div class="shortcut-inline shortcut-large"><span>Keyboard shortcut</span><button id="captureShortcut" class="shortcut-capture" type="button"><span id="shortcutValue">CommandOrControl + Alt + Space</span><span class="edit-pencil">✎</span></button><button id="save" class="soft-btn" type="button">Save</button></div>
              <div class="hotkey-footer">
                <div id="status" class="status idle">Ready. Press the shortcut to record and paste.</div>
                <label class="field compact-field"><span>Groq connection</span><input id="apiKey" type="password" autocomplete="off" placeholder="Groq key stored locally" /></label>
              </div>
            </article>
          </section>
        </section>

        <section class="view-panel" data-panel="dictionary">
          <header class="page-head"><div><h1>Dictionary</h1><p>Teach FlowDesk the names, products, and words you say often.</p></div><button class="primary-btn small" type="button">Add new</button></header>
          <article class="dictionary-hero"><h2>FlowDesk speaks the way you speak.</h2><p>Add personal terms, company jargon, client names, or industry-specific lingo. Whisper uses these hints during transcription.</p><div class="word-pills"><span>Dixit</span><span>OpenClaw</span><span>Groq</span><span>Nextbase</span><span>Wispr</span></div></article>
          <label class="dictionary-editor"><span>Common words / vocabulary</span><textarea id="vocabularyInput" class="compact-textarea" placeholder="Dixit, FlowDesk, Groq, OpenClaw, Wispr"></textarea><small>Separate words by comma or line break. Stored locally.</small></label>
        </section>

        <section class="view-panel" data-panel="snippets">
          <header class="page-head"><div><h1>Snippets</h1><p>Reusable text blocks for replies, prompts, intros, and support answers.</p></div><button class="primary-btn small" type="button">Create snippet</button></header>
          <div class="list-card"><div><strong>Quick intro</strong><p>Hey, here’s the quick context…</p></div><div><strong>Follow-up</strong><p>Checking in on this — should I proceed?</p></div><div><strong>Bug report</strong><p>Expected / Actual / Steps to reproduce…</p></div></div>
        </section>

        <section class="view-panel" data-panel="style">
          <header class="page-head"><div><h1>Style</h1><p>Choose how your dictated text should sound after cleanup.</p></div></header>
          <section class="style-grid"><article><strong>Professional</strong><p>Clear, polished, business-friendly.</p></article><article><strong>Friendly</strong><p>Warm, direct, conversational.</p></article><article><strong>Short</strong><p>Compressed and action-oriented.</p></article></section>
        </section>

        <section class="view-panel" data-panel="transforms">
          <header class="page-head"><div><h1>Transforms</h1><p>Convert rough speech into useful formats.</p></div></header>
          <section class="rewrite-layout"><article class="transform-card"><div class="section-heading"><p class="eyebrow">Rewrite input</p><h2>Clean up rough dictation</h2></div><textarea id="rewriteInput" placeholder="Record something or paste text here..."></textarea><div class="rewrite-actions"><button data-rewrite="clean" type="button">Clean up</button><button data-rewrite="professional" type="button">Professional</button><button data-rewrite="shorter" type="button">Shorter</button><button data-rewrite="friendly" type="button">Friendly</button></div></article><article class="transform-card"><div class="section-heading"><p class="eyebrow">Output</p><h2>Ready text</h2></div><div id="rewriteOutput" class="rewrite-output empty">Your rewritten text will appear here.</div><div class="promo-actions"><button id="copyRewrite" type="button">Copy</button><button id="pasteRewrite" class="primary-btn" type="button"><span class="button-dot"></span>Paste</button></div></article></section>
        </section>

        <section class="view-panel" data-panel="scratchpad">
          <header class="page-head scratchpad-head">
            <div><h1>Scratchpad</h1><p>Recovered dictations, copied text, and rewrite-ready transcripts.</p></div>
            <button id="startFromScratchpad" class="primary-btn small" type="button"><span class="button-dot"></span>Record</button>
          </header>
          <article class="scratchpad-panel">
            <div class="scratchpad-toolbar"><span>Recent transcripts</span><small>Newest first · stored locally</small></div>
            <div id="historyList" class="history-list"></div>
          </article>
        </section>

      </section>

    <aside id="settingsDrawer" class="settings-drawer" aria-hidden="true">
      <div class="drawer-backdrop" id="drawerBackdrop"></div>
      <section class="drawer-panel" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="settings-sidebar"><p>SETTINGS</p><button class="active" type="button">☷ General</button><button type="button">▭ System</button><button type="button"># Vibe coding</button><button type="button">⚗ Experimental</button><hr><p>ACCOUNT</p><button type="button">◎ Account</button><button type="button">♙ Team</button><button type="button">▰ Plans and Billing</button></div>
        <div class="settings-main"><div class="drawer-header"><div><h2>General</h2></div><button id="closeSettings" class="icon-btn" type="button">×</button></div><label class="settings-row"><div><strong>Groq API key</strong><span>Used for transcription and rewrites</span></div><input id="drawerApiKey" type="password" autocomplete="off" placeholder="gsk_..." /></label><div class="settings-row"><div><strong>Shortcuts</strong><span>Hold shortcut and speak</span></div><button id="captureShortcutMirror" class="soft-btn" type="button"><span id="shortcutValueMirror">Cmd/Ctrl + Alt + Space</span></button><button id="saveMirror" class="soft-btn" type="button">Save</button></div><label class="settings-row"><div><strong>Launch app at login</strong><span>Keep FlowDesk ready in the tray</span></div><input id="autostart" type="checkbox" /></label></div>
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
const settingsButton = document.querySelector<HTMLButtonElement>('#settingsButton');
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
const startFromScratchpadButton = document.querySelector<HTMLButtonElement>('#startFromScratchpad')!;

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
settingsButton?.addEventListener('click', openSettings);
closeSettingsButton.addEventListener('click', closeSettings);
drawerBackdrop.addEventListener('click', closeSettings);
openRewriteButton.addEventListener('click', () => setView('transforms'));
startFromScratchpadButton.addEventListener('click', () => toggleRecording());

window.addEventListener('keydown', async (event) => {
  if (!capturingShortcut && event.key === 'Escape') {
    closeSettings();
    return;
  }

  if (!capturingShortcut) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    finishShortcutCapture(shortcut, false);
    setStatus('idle', 'Shortcut capture cancelled.');
    return;
  }

  updateShortcutModifierState(event, true);
  const next = shortcutFromEvent(event);

  if (!next) {
    renderShortcutPreview();
    return;
  }

  finishShortcutCapture(next, true);
}, true);

window.addEventListener('keyup', (event) => {
  if (!capturingShortcut) return;
  updateShortcutModifierState(event, false);
  renderShortcutPreview();
}, true);

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
  if (view === 'scratchpad') renderHistory();
  if (view === 'transforms') hydrateRewriteFromHistory();
}

async function beginShortcutCapture() {
  capturingShortcut = true;
  pressedShortcutModifiers = new Set<string>();
  captureShortcutButton.classList.add('capturing');
  captureShortcutMirrorButton.classList.add('capturing');
  shortcutValue.textContent = 'Hold Ctrl/Alt, then press a key…';
  shortcutValueMirror.textContent = 'Hold Ctrl/Alt, then press a key…';

  // Avoid the currently registered global shortcut stealing the key event while
  // the user is trying to record a new shortcut.
  if (isTauriRuntime && shortcut && await isRegistered(shortcut)) {
    await unregister(shortcut);
  }
}

function finishShortcutCapture(next: string, shouldSave: boolean) {
  capturingShortcut = false;
  pressedShortcutModifiers = new Set<string>();
  captureShortcutButton.classList.remove('capturing');
  captureShortcutMirrorButton.classList.remove('capturing');
  shortcut = next;
  renderShortcut(next);
  localStorage.setItem('shortcut', next);
  setStatus('success', shouldSave
    ? `Shortcut captured: ${formatShortcutLabel(next)}. Click Save to register it.`
    : `Shortcut restored: ${formatShortcutLabel(next)}`);
}

function openSettings() {
  settingsDrawer.classList.add('open');
  settingsDrawer.setAttribute('aria-hidden', 'false');
  settingsButton?.setAttribute('aria-expanded', 'true');
}

function closeSettings() {
  settingsDrawer.classList.remove('open');
  settingsDrawer.setAttribute('aria-hidden', 'true');
  settingsButton?.setAttribute('aria-expanded', 'false');
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
  if (!key || ['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return '';

  const parts = shortcutModifierParts(event);

  // Global dictation hotkeys should not be plain letters like "Z" because that
  // hijacks normal typing. Require at least one modifier before accepting.
  if (parts.length === 0) {
    setStatus('idle', 'Hold Ctrl, Alt, or Shift, then press the final key.');
    return '';
  }

  parts.push(key);
  return parts.join('+');
}

function updateShortcutModifierState(event: KeyboardEvent, isDown: boolean) {
  const modifier = modifierFromKey(event.key);
  if (!modifier) return;
  if (isDown) pressedShortcutModifiers.add(modifier);
  else pressedShortcutModifiers.delete(modifier);
}

function modifierFromKey(key: string) {
  if (key === 'Control') return 'CommandOrControl';
  if (key === 'Meta') return 'CommandOrControl';
  if (key === 'Alt') return 'Alt';
  if (key === 'Shift') return 'Shift';
  return '';
}

function shortcutModifierParts(event?: KeyboardEvent) {
  const parts = new Set<string>(pressedShortcutModifiers);
  if (event?.ctrlKey || event?.metaKey) parts.add('CommandOrControl');
  if (event?.altKey) parts.add('Alt');
  if (event?.shiftKey) parts.add('Shift');

  return ['CommandOrControl', 'Alt', 'Shift'].filter((part) => parts.has(part));
}

function renderShortcutPreview() {
  const parts = shortcutModifierParts();
  const label = parts.length ? `${formatShortcutLabel(parts.join('+'))} + …` : 'Hold Ctrl/Alt, then press a key…';
  shortcutValue.textContent = label;
  shortcutValueMirror.textContent = label;
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
      setStatus('idle', `Shortcut saved as ${formatShortcutLabel(next)}. It will register inside the desktop app.`);
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
      <div class="history-meta">
        <time>${formatDate(item.createdAt)}</time>
        <span>${wordCount(item.text)} words</span>
      </div>
      <div class="history-body">
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
      if (button.dataset.historyAction === 'rewrite') setView('transforms');
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

function wordCount(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
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
