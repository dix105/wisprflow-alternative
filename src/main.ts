import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';

const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+Space';
const DEFAULT_POLISH_SHORTCUT = 'CommandOrControl+Shift+P';
const HISTORY_KEY = 'flowDeskHistory';
const VOCABULARY_KEY = 'flowDeskVocabulary';
const PROVIDER_KEY = 'flowDeskProvider';
const ELEVENLABS_KEY = 'elevenLabsApiKey';
const SARVAM_KEY = 'sarvamApiKey';
const TOTAL_WORDS_KEY = 'flowDeskTotalWordsSpoken';
const MEDIA_PAUSE_KEY = 'flowDeskPauseBackgroundMedia';
const POLISH_SHORTCUT_KEY = 'flowDeskPolishShortcut';
const AUDIO_RESTORE_DELAY_MS = 150;
const RECORDING_TOGGLE_DEBOUNCE_MS = 900;
const PUSH_TO_TALK_RELEASE_CONFIRM_MS = 140;

type StatusKind = 'idle' | 'recording' | 'working' | 'error' | 'success';
type ViewName = 'dictation' | 'dictionary' | 'snippets' | 'style' | 'transforms' | 'scratchpad';
type RewriteMode = 'clean' | 'polish' | 'professional' | 'shorter' | 'friendly';
type TranscriptionProvider = 'groq' | 'elevenlabs' | 'sarvam';

type HistoryItem = {
  id: string;
  text: string;
  createdAt: string;
  durationMs?: number;
  wordsPerMinute?: number;
  rewrite?: string;
  rewriteMode?: RewriteMode;
};

let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let shortcut = localStorage.getItem('shortcut') || DEFAULT_SHORTCUT;
let polishShortcut = localStorage.getItem(POLISH_SHORTCUT_KEY) || DEFAULT_POLISH_SHORTCUT;
let captureTarget: 'dictation' | 'polish' | null = null;
let pressedShortcutModifiers = new Set<string>();
let transcriptionProvider = (localStorage.getItem(PROVIDER_KEY) as TranscriptionProvider) || 'groq';
let historyItems: HistoryItem[] = loadHistory();
let selectedHistoryId = historyItems[0]?.id || '';
let recordingStartedAt = 0;
let lastRecordingToggleAt = 0;
let recordingTransitionInFlight = false;
let stopAfterStartRequested = false;
let isAudioDucked = false;
let totalWordsSpoken = loadTotalWordsSpoken(historyItems);
let audioDuckingEnabled = true;
let pauseBackgroundMediaEnabled = localStorage.getItem(MEDIA_PAUSE_KEY) === 'true';
const isTauriRuntime = '__TAURI_INTERNALS__' in window;
const numberFormatter = new Intl.NumberFormat();

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
          <button class="nav-item" data-view="scratchpad" type="button"><span>▤</span>Scratchpad</button>
          <button class="nav-item" data-view="transforms" type="button"><span>✦</span>Polish text</button>
        </nav>

        <div class="rail-footer">
          <button id="settingsButton" class="nav-item" type="button" aria-expanded="false"><span>⚙</span>Settings</button>
        </div>

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
              <div class="promo-actions"><button id="toggle" class="primary-btn" type="button"><span class="button-dot"></span>Start recording</button></div>
            </div>
            <div class="console-visual clean" aria-hidden="true">
              <div class="wave-card"><span></span><span></span><span></span><span></span><span></span></div>
            </div>
          </article>

          <section class="quick-shortcuts" aria-label="Keyboard shortcuts">
            <button class="shortcut-card" data-view="transforms" type="button">
              <span>Polish text shortcut</span>
              <strong id="polishShortcutHome"><kbd>Cmd/Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd></strong>
              <small>Select text anywhere, press shortcut, get polished text pasted back.</small>
            </button>
          </section>

          <section class="stats-strip" aria-label="Dictation stats">
            <article><span>Total words spoken</span><strong id="totalWordsSpoken">0</strong><small>Across saved dictations</small></article>
            <article><span>Average speed</span><strong id="averageWordsPerMinute">—</strong><small>Words per minute</small></article>
            <article><span>Average words</span><strong id="averageWordsPerRecording">—</strong><small>Per recording</small></article>
          </section>

          <section class="home-grid">
            <article class="setup-card hotkey-card">
              <div class="setup-heading">
                <div id="recordOrb" class="record-orb"><span class="orb-core"></span><i></i><i></i><i></i><i></i></div>
                <div><strong>Your dictation key</strong><span>Set once. Use everywhere.</span></div>
              </div>
              <div class="shortcut-inline shortcut-large"><span>Keyboard shortcut</span><button id="captureShortcut" class="shortcut-capture" type="button"><span id="shortcutValue">CommandOrControl + Alt + Space</span><span class="edit-pencil">✎</span></button><button id="save" class="soft-btn" type="button">Save</button></div>
              <div class="hotkey-footer">
                <div id="status" class="status idle">Ready. Press the shortcut to record and paste.</div>
              </div>
            </article>

            <article class="provider-card">
              <div class="provider-card-head">
                <div><strong>Transcription provider</strong><span>Choose which engine turns speech into text.</span></div>
                <span id="activeProviderBadge" class="active-provider-badge">Groq active</span>
              </div>
              <div class="provider-list">
                <div class="provider-row active" data-provider-row="groq">
                  <button class="provider-option" data-provider="groq" type="button"><strong>Groq</strong><span>Whisper Large v3 Turbo</span><em>Active</em></button>
                  <label class="field compact-field"><span>Groq API key</span><input id="apiKey" type="password" autocomplete="off" placeholder="Groq key stored locally" /></label>
                </div>
                <div class="provider-row" data-provider-row="elevenlabs">
                  <button class="provider-option" data-provider="elevenlabs" type="button"><strong>ElevenLabs</strong><span>Scribe v2 speech-to-text</span><em>Make active</em></button>
                  <label class="field compact-field"><span>ElevenLabs API key</span><input id="elevenLabsApiKey" type="password" autocomplete="off" placeholder="ElevenLabs key stored locally" /></label>
                </div>
                <div class="provider-row" data-provider-row="sarvam">
                  <button class="provider-option" data-provider="sarvam" type="button"><strong>Sarvam</strong><span>Saaras v3 speech-to-text</span><em>Make active</em></button>
                  <label class="field compact-field"><span>Sarvam API key</span><input id="sarvamApiKey" type="password" autocomplete="off" placeholder="Sarvam key stored locally" /></label>
                </div>
              </div>
            </article>
          </section>
        </section>

        <section class="view-panel" data-panel="snippets">
          <header class="page-head"><div><h1>Snippets</h1><p>Reusable text blocks for replies, prompts, intros, and support answers.</p></div><button class="primary-btn small" type="button">Create snippet</button></header>
          <div class="list-card"><div><strong>Quick intro</strong><p>Hey, here’s the quick context…</p></div><div><strong>Follow-up</strong><p>Checking in on this — should I proceed?</p></div><div><strong>Bug report</strong><p>Expected / Actual / Steps to reproduce…</p></div></div>
        </section>

        <section class="view-panel" data-panel="style">
          <header class="page-head"><div><h1>Style</h1><p>Choose how your dictated text should sound after cleanup.</p></div></header>
          <section class="style-grid"><article><strong>Polished writing</strong><p>Fix grammar, punctuation, and flow without changing your voice.</p></article><article><strong>Professional</strong><p>Clear, polished, business-friendly.</p></article><article><strong>Friendly</strong><p>Warm, direct, conversational.</p></article><article><strong>Short</strong><p>Compressed and action-oriented.</p></article></section>
        </section>

        <section class="view-panel" data-panel="transforms">
          <header class="page-head"><div><h1>Transforms</h1><p>Convert rough speech into useful formats.</p></div></header>
          <section class="rewrite-layout"><article class="transform-card"><div class="section-heading"><p class="eyebrow">Rewrite input</p><h2>Clean up rough dictation</h2></div><textarea id="rewriteInput" placeholder="Record something or paste text here..."></textarea><div class="shortcut-hint">Press <kbd>Cmd/Ctrl</kbd> + <kbd>Enter</kbd> to polish writing</div><div class="rewrite-actions"><button data-rewrite="clean" type="button">Clean up</button><button data-rewrite="polish" type="button">Polish writing</button><button data-rewrite="professional" type="button">Professional</button><button data-rewrite="shorter" type="button">Shorter</button><button data-rewrite="friendly" type="button">Friendly</button></div></article><article class="transform-card"><div class="section-heading"><p class="eyebrow">Output</p><h2>Ready text</h2></div><div id="rewriteOutput" class="rewrite-output empty">Your rewritten text will appear here.</div><div class="promo-actions"><button id="copyRewrite" type="button">Copy</button><button id="pasteRewrite" class="primary-btn" type="button"><span class="button-dot"></span>Paste</button></div></article></section>
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
        <div class="settings-main"><div class="drawer-header"><div><h2>General</h2></div><button id="closeSettings" class="icon-btn" type="button">×</button></div><label class="settings-row"><div><strong>Groq API key</strong><span>Used for transcription and rewrites</span></div><input id="drawerApiKey" type="password" autocomplete="off" placeholder="gsk_..." /></label><div class="settings-row"><div><strong>Dictation shortcut</strong><span>Press once to start, press again to stop</span></div><button id="captureShortcutMirror" class="soft-btn" type="button"><span id="shortcutValueMirror">Cmd/Ctrl + Alt + Space</span></button><button id="saveMirror" class="soft-btn" type="button">Save</button></div><div class="settings-row"><div><strong>Polish text shortcut</strong><span>Select text anywhere, then polish and paste back</span></div><button id="capturePolishShortcut" class="soft-btn" type="button"><span id="polishShortcutValue">Cmd/Ctrl + Shift + P</span></button><button id="savePolishShortcut" class="soft-btn" type="button">Save</button></div><label class="settings-row"><div><strong>Pause background media</strong><span>Pause/resume the current video or music while recording.</span></div><input id="pauseBackgroundMedia" type="checkbox" /></label><div class="settings-row"><div><strong>Test audio ducking</strong><span>Lowers volume briefly, then restores it automatically.</span></div><button id="testAudioDucking" class="soft-btn" type="button">Run test</button></div><label class="settings-row"><div><strong>Launch app at login</strong><span>Keep FlowDesk ready in the tray</span></div><input id="autostart" type="checkbox" /></label></div>
      </section>
    </aside>

    <div id="miniWidget" class="mini-widget" hidden><span class="mini-wave"></span><strong>Recording</strong><button id="miniStop" type="button">Stop</button></div>
  </main>
`;

const apiKeyInput = document.querySelector<HTMLInputElement>('#apiKey')!;
const drawerApiKeyInput = document.querySelector<HTMLInputElement>('#drawerApiKey')!;
const elevenLabsApiKeyInput = document.querySelector<HTMLInputElement>('#elevenLabsApiKey')!;
const sarvamApiKeyInput = document.querySelector<HTMLInputElement>('#sarvamApiKey')!;
const activeProviderBadge = document.querySelector<HTMLElement>('#activeProviderBadge')!;
const vocabularyInput = document.querySelector<HTMLTextAreaElement>('#vocabularyInput');
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const saveMirrorButton = document.querySelector<HTMLButtonElement>('#saveMirror')!;
const toggleButton = document.querySelector<HTMLButtonElement>('#toggle')!;
const captureShortcutButton = document.querySelector<HTMLButtonElement>('#captureShortcut')!;
const captureShortcutMirrorButton = document.querySelector<HTMLButtonElement>('#captureShortcutMirror')!;
const shortcutValue = document.querySelector<HTMLElement>('#shortcutValue')!;
const shortcutValueMirror = document.querySelector<HTMLElement>('#shortcutValueMirror')!;
const polishShortcutHome = document.querySelector<HTMLElement>('#polishShortcutHome')!;
const polishShortcutValue = document.querySelector<HTMLElement>('#polishShortcutValue')!;
const capturePolishShortcutButton = document.querySelector<HTMLButtonElement>('#capturePolishShortcut')!;
const savePolishShortcutButton = document.querySelector<HTMLButtonElement>('#savePolishShortcut')!;
const settingsButton = document.querySelector<HTMLButtonElement>('#settingsButton');
const closeSettingsButton = document.querySelector<HTMLButtonElement>('#closeSettings')!;
const drawerBackdrop = document.querySelector<HTMLDivElement>('#drawerBackdrop')!;
const settingsDrawer = document.querySelector<HTMLElement>('#settingsDrawer')!;
const autostartInput = document.querySelector<HTMLInputElement>('#autostart')!;
const pauseBackgroundMediaInput = document.querySelector<HTMLInputElement>('#pauseBackgroundMedia')!;
const testAudioDuckingButton = document.querySelector<HTMLButtonElement>('#testAudioDucking')!;
const statusBox = document.querySelector<HTMLElement>('#status')!;
const totalWordsSpokenEl = document.querySelector<HTMLElement>('#totalWordsSpoken')!;
const averageWordsPerMinuteEl = document.querySelector<HTMLElement>('#averageWordsPerMinute')!;
const averageWordsPerRecordingEl = document.querySelector<HTMLElement>('#averageWordsPerRecording')!;
const recordOrb = document.querySelector<HTMLElement>('#recordOrb')!;
const miniWidget = document.querySelector<HTMLElement>('#miniWidget')!;
const miniStopButton = document.querySelector<HTMLButtonElement>('#miniStop')!;
const rewriteInput = document.querySelector<HTMLTextAreaElement>('#rewriteInput')!;
const rewriteOutput = document.querySelector<HTMLElement>('#rewriteOutput')!;
const historyList = document.querySelector<HTMLElement>('#historyList')!;
const openRewriteButton = document.querySelector<HTMLButtonElement>('#openRewrite');
const copyRewriteButton = document.querySelector<HTMLButtonElement>('#copyRewrite')!;
const pasteRewriteButton = document.querySelector<HTMLButtonElement>('#pasteRewrite')!;
const startFromScratchpadButton = document.querySelector<HTMLButtonElement>('#startFromScratchpad')!;

apiKeyInput.value = localStorage.getItem('groqApiKey') || '';
drawerApiKeyInput.value = apiKeyInput.value;
elevenLabsApiKeyInput.value = localStorage.getItem(ELEVENLABS_KEY) || '';
sarvamApiKeyInput.value = localStorage.getItem(SARVAM_KEY) || '';
renderProvider();
if (vocabularyInput) vocabularyInput.value = localStorage.getItem(VOCABULARY_KEY) || '';
renderShortcut(shortcut);
renderPolishShortcut(polishShortcut);
renderHistory();
renderStats();
pauseBackgroundMediaInput.checked = pauseBackgroundMediaEnabled;
hydrateRewriteFromHistory();
setupPushToTalkListeners();

apiKeyInput.addEventListener('change', syncApiKey);
drawerApiKeyInput.addEventListener('change', syncApiKey);
elevenLabsApiKeyInput.addEventListener('change', syncElevenLabsKey);
sarvamApiKeyInput.addEventListener('change', syncSarvamKey);
vocabularyInput?.addEventListener('input', () => {
  localStorage.setItem(VOCABULARY_KEY, vocabularyInput.value.trim());
});

function syncApiKey() {
  const key = (document.activeElement === drawerApiKeyInput ? drawerApiKeyInput.value : apiKeyInput.value).trim();
  apiKeyInput.value = key;
  drawerApiKeyInput.value = key;
  localStorage.setItem('groqApiKey', key);
}

function syncElevenLabsKey() {
  localStorage.setItem(ELEVENLABS_KEY, elevenLabsApiKeyInput.value.trim());
}

function syncSarvamKey() {
  localStorage.setItem(SARVAM_KEY, sarvamApiKeyInput.value.trim());
}

function setProvider(provider: TranscriptionProvider) {
  transcriptionProvider = provider;
  localStorage.setItem(PROVIDER_KEY, provider);
  renderProvider();
  setStatus('success', `${providerName(provider)} is now active for transcription.`);
}

function renderProvider() {
  document.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach((button) => {
    const isActive = button.dataset.provider === transcriptionProvider;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
    button.querySelector('em')!.textContent = isActive ? 'Active' : 'Make active';
  });
  document.querySelectorAll<HTMLElement>('[data-provider-row]').forEach((row) => {
    row.classList.toggle('active', row.dataset.providerRow === transcriptionProvider);
  });
  activeProviderBadge.textContent = `${providerName(transcriptionProvider)} active`;
}

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view as ViewName));
});

document.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach((button) => {
  button.addEventListener('click', () => setProvider(button.dataset.provider as TranscriptionProvider));
});

document.querySelectorAll<HTMLButtonElement>('[data-shortcut]').forEach((button) => {
  button.addEventListener('click', () => {
    shortcut = button.dataset.shortcut || DEFAULT_SHORTCUT;
    renderShortcut(shortcut);
    setStatus('idle', `Shortcut preset selected: ${formatShortcutLabel(shortcut)}. Click Save to register it.`);
  });
});

captureShortcutButton.addEventListener('click', () => beginShortcutCapture('dictation'));
captureShortcutMirrorButton.addEventListener('click', () => beginShortcutCapture('dictation'));
capturePolishShortcutButton.addEventListener('click', () => beginShortcutCapture('polish'));
saveButton.addEventListener('click', () => installShortcut(shortcut));
saveMirrorButton.addEventListener('click', () => installShortcut(shortcut));
savePolishShortcutButton.addEventListener('click', () => installPolishShortcut(polishShortcut));
toggleButton.addEventListener('click', () => toggleRecording());
miniStopButton.addEventListener('click', () => toggleRecording());
settingsButton?.addEventListener('click', openSettings);
closeSettingsButton.addEventListener('click', closeSettings);
drawerBackdrop.addEventListener('click', closeSettings);
openRewriteButton?.addEventListener('click', () => setView('transforms'));
startFromScratchpadButton.addEventListener('click', () => toggleRecording());
testAudioDuckingButton.addEventListener('click', () => testAudioDucking());

window.addEventListener('keydown', async (event) => {
  if (!captureTarget && event.key === 'Escape') {
    closeSettings();
    return;
  }

  if (!captureTarget) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    finishShortcutCapture(currentCaptureShortcut(), false);
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
  if (!captureTarget) return;
  updateShortcutModifierState(event, false);
  renderShortcutPreview();
}, true);

pauseBackgroundMediaInput.addEventListener('change', () => {
  pauseBackgroundMediaEnabled = pauseBackgroundMediaInput.checked;
  localStorage.setItem(MEDIA_PAUSE_KEY, String(pauseBackgroundMediaEnabled));
  setStatus('success', pauseBackgroundMediaEnabled ? 'Background media pause enabled.' : 'Background media pause disabled.');
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

rewriteInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    rewriteCurrentText('polish');
  }
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

async function beginShortcutCapture(target: 'dictation' | 'polish') {
  captureTarget = target;
  pressedShortcutModifiers = new Set<string>();
  const targetButtons = target === 'dictation' ? [captureShortcutButton, captureShortcutMirrorButton] : [capturePolishShortcutButton];
  targetButtons.forEach((button) => button.classList.add('capturing'));
  setShortcutCaptureLabel('Hold Ctrl/Alt, then press a key…');

  const current = target === 'dictation' ? shortcut : polishShortcut;
  if (isTauriRuntime && current && await isRegistered(current)) {
    await unregister(current);
  }
}

function finishShortcutCapture(next: string, shouldSave: boolean) {
  const target = captureTarget;
  captureTarget = null;
  pressedShortcutModifiers = new Set<string>();
  captureShortcutButton.classList.remove('capturing');
  captureShortcutMirrorButton.classList.remove('capturing');
  capturePolishShortcutButton.classList.remove('capturing');

  if (target === 'polish') {
    polishShortcut = next;
    renderPolishShortcut(next);
    localStorage.setItem(POLISH_SHORTCUT_KEY, next);
  } else {
    shortcut = next;
    renderShortcut(next);
    localStorage.setItem('shortcut', next);
  }

  setStatus('success', shouldSave
    ? `Shortcut captured: ${formatShortcutLabel(next)}. Click Save to register it.`
    : `Shortcut restored: ${formatShortcutLabel(next)}`);
}

function currentCaptureShortcut() {
  return captureTarget === 'polish' ? polishShortcut : shortcut;
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
  const html = shortcutHtml(value);
  shortcutValue.innerHTML = html;
  shortcutValueMirror.innerHTML = html;
}

function renderPolishShortcut(value: string) {
  const html = shortcutHtml(value);
  polishShortcutHome.innerHTML = html;
  polishShortcutValue.innerHTML = html;
}

function shortcutHtml(value: string) {
  return value
    .split('+')
    .map((part) => `<kbd>${displayShortcutPart(part.trim())}</kbd>`)
    .join('<span class="shortcut-plus">+</span>');
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
  setShortcutCaptureLabel(label);
}

function setShortcutCaptureLabel(label: string) {
  if (captureTarget === 'polish') {
    polishShortcutValue.textContent = label;
    return;
  }
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

    try {
      if (shortcut && await isRegistered(shortcut)) {
        await unregister(shortcut);
      }
      await invoke('install_push_to_talk_hook', { shortcut: next });
      shortcut = next;
      localStorage.setItem('shortcut', next);
      renderShortcut(next);
      setStatus('success', `Push-to-talk shortcut registered: ${formatShortcutLabel(next)}`);
      return;
    } catch {
      // Non-Windows or hook unavailable: fall back to Tauri's toggle shortcut.
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


async function installPolishShortcut(next: string) {
  try {
    if (!isTauriRuntime) {
      polishShortcut = next;
      localStorage.setItem(POLISH_SHORTCUT_KEY, next);
      renderPolishShortcut(next);
      setStatus('idle', `Polish shortcut saved as ${formatShortcutLabel(next)}. It will register inside the desktop app.`);
      return;
    }

    if (polishShortcut && await isRegistered(polishShortcut)) {
      await unregister(polishShortcut);
    }
    await register(next, () => polishSelectedText());
    polishShortcut = next;
    localStorage.setItem(POLISH_SHORTCUT_KEY, next);
    renderPolishShortcut(next);
    setStatus('success', `Polish shortcut registered: ${formatShortcutLabel(next)}`);
  } catch (error) {
    setStatus('error', `Could not register polish shortcut: ${String(error)}`);
  }
}

async function polishSelectedText() {
  syncApiKey();
  if (!apiKeyInput.value.trim()) {
    setStatus('error', 'Add your Groq API key first.');
    return;
  }

  try {
    setStatus('working', 'Polishing selected text…');
    const text = isTauriRuntime
      ? await invoke<string>('copy_selected_text')
      : rewriteInput.value.trim();
    if (!text.trim()) {
      setStatus('error', 'Select text first, then press the polish shortcut.');
      return;
    }
    const polished = await invoke<string>('rewrite_text', {
      apiKey: apiKeyInput.value.trim(),
      text,
      mode: 'polish',
    });
    if (isTauriRuntime) await invoke('paste_transcript', { text: polished });
    else rewriteOutput.textContent = polished;
    setStatus('success', 'Selected text polished and pasted.');
  } catch (error) {
    setStatus('error', String(error));
  }
}


let pushToTalkListenersReady = false;

async function setupPushToTalkListeners() {
  if (!isTauriRuntime || pushToTalkListenersReady) return;
  pushToTalkListenersReady = true;

  await listen('push-to-talk-down', () => startRecordingFromPushToTalk());
  await listen('push-to-talk-up', () => stopRecordingFromPushToTalk());
}

function startRecordingFromPushToTalk() {
  if (recorder?.state === 'recording' || recordingTransitionInFlight) return;
  stopAfterStartRequested = false;
  toggleRecording();
}

async function stopRecordingFromPushToTalk() {
  await sleep(PUSH_TO_TALK_RELEASE_CONFIRM_MS);
  const stillPressed = await invoke<boolean>('is_push_to_talk_pressed');
  if (stillPressed) return;

  if (recorder?.state === 'recording') {
    recorder.stop();
    return;
  }
  if (recordingTransitionInFlight) stopAfterStartRequested = true;
}

async function testAudioDucking() {
  if (!isTauriRuntime) {
    setStatus('idle', 'Audio ducking test runs inside the desktop app.');
    return;
  }

  try {
    setStatus('working', 'Testing audio ducking…');
    await invoke('start_audio_ducking');
    await sleep(1800);
    await invoke('restore_audio_ducking');
    setStatus('success', 'Audio ducking test finished and volume restored.');
  } catch (error) {
    setStatus('error', `Audio ducking test failed: ${String(error)}`);
  }
}

async function toggleRecording() {
  const now = Date.now();
  if (recordingTransitionInFlight || now - lastRecordingToggleAt < RECORDING_TOGGLE_DEBOUNCE_MS) return;
  lastRecordingToggleAt = now;
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }

  recordingTransitionInFlight = true;

  try {
    syncApiKey();
    syncElevenLabsKey();
    syncSarvamKey();
    if (!activeTranscriptionKey()) {
      setStatus('error', `Add your ${providerLabel()} API key first.`);
      return;
    }

    if (pauseBackgroundMediaEnabled && isTauriRuntime) {
      await invoke('pause_background_media');
    }

    if (audioDuckingEnabled && isTauriRuntime && !isAudioDucked) {
      await invoke('start_audio_ducking');
      isAudioDucked = true;
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

    recordingStartedAt = Date.now();
    recorder.start();
    setStatus('recording', 'Recording… release shortcut or click stop when done.');
    if (stopAfterStartRequested) {
      stopAfterStartRequested = false;
      recorder.stop();
    }
  } catch (error) {
    await restoreAudioAfterDelay();
    if (pauseBackgroundMediaEnabled && isTauriRuntime) {
      await invoke('resume_background_media');
    }
    setStatus('error', `Mic error: ${String(error)}`);
  } finally {
    recordingTransitionInFlight = false;
  }
}

function pickMimeType() {
  const choices = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return choices.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

async function transcribeAndPaste() {
  try {
    setStatus('working', `Transcribing with ${providerLabel()} and pasting into the focused app…`);
    const durationMs = recordingStartedAt ? Math.max(1000, Date.now() - recordingStartedAt) : 0;
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));

    const text = await invoke<string>('transcribe_and_paste', {
      provider: transcriptionProvider,
      apiKey: activeTranscriptionKey(),
      audioBytes: bytes,
      vocabularyPrompt: buildVocabularyPrompt(),
    });

    const stats = addHistory(text, durationMs);
    rewriteInput.value = text;
    setStatus('success', `Pasted and saved to history: ${stats.words} words · ${stats.wordsPerMinute} WPM.`);
  } catch (error) {
    setStatus('error', String(error));
  } finally {
    recorder = null;
    chunks = [];
    recordingStartedAt = 0;
    await restoreAudioAfterDelay();
    if (pauseBackgroundMediaEnabled && isTauriRuntime) {
      await invoke('resume_background_media');
    }
  }
}

async function restoreAudioAfterDelay() {
  if (!audioDuckingEnabled || !isTauriRuntime || !isAudioDucked) return;
  await sleep(AUDIO_RESTORE_DELAY_MS);
  await invoke('restore_audio_ducking');
  isAudioDucked = false;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

function providerName(provider: TranscriptionProvider) {
  if (provider === 'groq') return 'Groq';
  if (provider === 'elevenlabs') return 'ElevenLabs';
  return 'Sarvam';
}

function providerLabel() {
  return providerName(transcriptionProvider);
}

function activeTranscriptionKey() {
  if (transcriptionProvider === 'groq') return apiKeyInput.value.trim();
  if (transcriptionProvider === 'elevenlabs') return elevenLabsApiKeyInput.value.trim();
  return sarvamApiKeyInput.value.trim();
}

function buildVocabularyPrompt() {
  const vocabulary = (vocabularyInput?.value || '')
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

function loadTotalWordsSpoken(items: HistoryItem[]) {
  const stored = Number(localStorage.getItem(TOTAL_WORDS_KEY));
  if (Number.isFinite(stored) && stored >= 0) return stored;
  return items.reduce((sum, item) => sum + wordCount(item.text), 0);
}

function saveTotalWordsSpoken() {
  localStorage.setItem(TOTAL_WORDS_KEY, String(totalWordsSpoken));
}

function addHistory(text: string, durationMs: number) {
  const words = wordCount(text);
  const wordsPerMinute = calculateWordsPerMinute(words, durationMs);
  const item: HistoryItem = {
    id: crypto.randomUUID(),
    text,
    createdAt: new Date().toISOString(),
    durationMs,
    wordsPerMinute,
  };
  historyItems = [item, ...historyItems].slice(0, 25);
  selectedHistoryId = item.id;
  totalWordsSpoken += words;
  saveHistory();
  saveTotalWordsSpoken();
  renderHistory();
  renderStats();
  return { words, wordsPerMinute };
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
        ${item.wordsPerMinute ? `<span>${item.wordsPerMinute} WPM</span>` : ''}
        ${item.durationMs ? `<span>${formatDuration(item.durationMs)}</span>` : ''}
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

function calculateWordsPerMinute(words: number, durationMs: number) {
  if (!words || !durationMs) return 0;
  return Math.max(1, Math.round(words / (durationMs / 60000)));
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function renderStats() {
  totalWordsSpokenEl.textContent = numberFormatter.format(totalWordsSpoken);
  averageWordsPerMinuteEl.textContent = formatOptionalNumber(averageWordsPerMinute(historyItems));
  averageWordsPerRecordingEl.textContent = formatOptionalNumber(averageWordsPerRecording(historyItems));
}

function averageWordsPerMinute(items: HistoryItem[]) {
  const totals = items.reduce((acc, item) => {
    const words = wordCount(item.text);
    const durationMs = item.durationMs || 0;
    if (!words || !durationMs) return acc;
    return { words: acc.words + words, durationMs: acc.durationMs + durationMs };
  }, { words: 0, durationMs: 0 });

  return calculateWordsPerMinute(totals.words, totals.durationMs);
}

function averageWordsPerRecording(items: HistoryItem[]) {
  if (!items.length) return 0;
  const words = items.reduce((sum, item) => sum + wordCount(item.text), 0);
  return Math.round(words / items.length);
}

function formatOptionalNumber(value: number) {
  return value ? numberFormatter.format(value) : '—';
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
installPolishShortcut(polishShortcut);
loadAutostartState();
