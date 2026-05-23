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
const DEEPGRAM_KEY = 'deepgramApiKey';
const DEEPGRAM_STREAMING_KEY = 'deepgramStreaming';
const TOTAL_WORDS_KEY = 'flowDeskTotalWordsSpoken';
const MEDIA_PAUSE_KEY = 'flowDeskPauseBackgroundMedia';
const RECORDING_MODE_KEY = 'flowDeskRecordingMode';
const AUDIO_DUCKING_VOLUME_KEY = 'flowDeskAudioDuckingVolume';
const FAST_MIC_KEY = 'flowDeskFastMic';
const NATIVE_MIC_KEY = 'flowDeskNativeMic';
const POLISH_SHORTCUT_KEY = 'flowDeskPolishShortcut';
const AUTO_POLISH_KEY = 'flowDeskAutoPolish';
const VOICE_TRIGGER_KEY = 'flowDeskVoiceTrigger';
const VOICE_TRIGGER_PHRASE_KEY = 'flowDeskVoiceTriggerPhrase';
const VOICE_TRIGGER_ENGINE_KEY = 'flowDeskVoiceTriggerEngine';
const DEBUG_EXPECTED_WORDS_KEY = 'flowDeskDebugExpectedWords';
const AUDIO_RESTORE_DELAY_MS = 150;
const RECORDING_TOGGLE_DEBOUNCE_MS = 900;

type StatusKind = 'idle' | 'recording' | 'working' | 'error' | 'success';
type ViewName = 'dictation' | 'dictionary' | 'snippets' | 'style' | 'transforms' | 'scratchpad';
type RewriteMode = 'clean' | 'polish' | 'professional' | 'shorter' | 'friendly';
type TranscriptionProvider = 'groq' | 'elevenlabs' | 'sarvam' | 'deepgram';
type RecordingMode = 'hold' | 'toggle';
type VoiceTriggerEngine = 'openwakeword' | 'windows';

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
let recordingFinishing = false;
let nativeRecordingActive = false;
let stopAfterStartRequested = false;
let isAudioDucked = false;
let totalWordsSpoken = loadTotalWordsSpoken(historyItems);
let audioDuckingEnabled = true;
let pauseBackgroundMediaEnabled = localStorage.getItem(MEDIA_PAUSE_KEY) === 'true';
let fastMicEnabled = localStorage.getItem(FAST_MIC_KEY) === 'true';
let nativeMicEnabled = localStorage.getItem(NATIVE_MIC_KEY) !== 'false';
let autoPolishEnabled = localStorage.getItem(AUTO_POLISH_KEY) === 'true';
let voiceTriggerEnabled = localStorage.getItem(VOICE_TRIGGER_KEY) === 'true';
let voiceTriggerEngine = (localStorage.getItem(VOICE_TRIGGER_ENGINE_KEY) as VoiceTriggerEngine) || 'openwakeword';
let voiceTriggerPhrase = localStorage.getItem(VOICE_TRIGGER_PHRASE_KEY) || 'start typing';
let recordingMode = (localStorage.getItem(RECORDING_MODE_KEY) as RecordingMode) || 'hold';
let audioDuckingVolume = Number(localStorage.getItem(AUDIO_DUCKING_VOLUME_KEY) || '35');
if (!Number.isFinite(audioDuckingVolume)) audioDuckingVolume = 35;
audioDuckingVolume = Math.min(100, Math.max(0, audioDuckingVolume));
let deepgramStreamingEnabled = localStorage.getItem(DEEPGRAM_STREAMING_KEY) === 'true';
let streamingSocket: WebSocket | null = null;
let streamingTranscript = '';
let streamingFinalParts: string[] = [];
let streamingLastPastedLength = 0;
let pendingStreamingChunks: Blob[] = [];
let streamingSendPromises: Promise<void>[] = [];
let streamingSocketOpened = false;
let streamingSocketFailed = false;
let streamingPastedLive = false;
let debugEvents: { time: string; label: string; data?: unknown }[] = [];
let pushToTalkListenersReady = false;
let waveformContext: AudioContext | null = null;
let waveformAnalyser: AnalyserNode | null = null;
let waveformFrame = 0;
let waveformData: Uint8Array<ArrayBuffer> | null = null;
let waveformLastLogAt = 0;
let waveformPeakLevel = 0;
let polishInFlight = false;
let pasteRewriteInFlight = false;
let warmMicStream: MediaStream | null = null;
let warmMicPromise: Promise<MediaStream> | null = null;
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
                <div class="provider-row" data-provider-row="deepgram">
                  <button class="provider-option" data-provider="deepgram" type="button"><strong>Deepgram</strong><span>Nova-3 · fast &amp; accurate STT</span><em>Make active</em></button>
                  <label class="field compact-field"><span>Deepgram API key</span><input id="deepgramApiKey" type="password" autocomplete="off" placeholder="Deepgram key stored locally" /></label>
                  <label class="field compact-field streaming-toggle"><span>Live streaming</span><small>Paste words directly as you speak</small><input id="deepgramStreaming" type="checkbox" /></label>
                </div>
              </div>
            </article>
          </section>

          <article class="debug-card">
            <div class="provider-card-head">
              <div><strong>Debug bundle</strong><span>Add what you spoke, then copy all stream logs for fast diagnosis.</span></div>
              <button id="copyDebugBundle" class="soft-btn" type="button">Copy bundle</button>
            </div>
            <label class="field"><span>Words you spoke / expected text</span><textarea id="debugExpectedWords" rows="3" placeholder="Example: hello this is a streaming test..."></textarea></label>
            <pre id="debugLogOutput" class="debug-log">No stream logs yet.</pre>
          </article>
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
        <div class="settings-sidebar"><p>SETTINGS</p><button class="active" data-settings-tab="general" type="button">☷ General</button><button data-settings-tab="voice" type="button">◉ Voice trigger</button><button data-settings-tab="audio" type="button">▭ Audio</button></div>
        <div class="settings-main"><div class="drawer-header"><div><h2 id="settingsTitle">General</h2><p id="settingsSubtitle">Core keys and typing behavior.</p></div><button id="closeSettings" class="icon-btn" type="button">×</button></div><section class="settings-panel active" data-settings-panel="general"><label class="settings-row"><div><strong>Groq API key</strong><span>Used for transcription and rewrites</span></div><input id="drawerApiKey" type="password" autocomplete="off" placeholder="gsk_..." /></label><div class="settings-row"><div><strong>Dictation shortcut</strong><span>Use this from any app.</span></div><button id="captureShortcutMirror" class="soft-btn" type="button"><span id="shortcutValueMirror">Cmd/Ctrl + Alt + Space</span></button><button id="saveMirror" class="soft-btn" type="button">Save</button></div><label class="settings-row"><div><strong>Dictation mode</strong><span>Hold key, or press once to start and again to stop.</span></div><select id="recordingMode"><option value="hold">Hold to talk</option><option value="toggle">Press once / press again</option></select></label><div class="settings-row"><div><strong>Polish text shortcut</strong><span>Select text anywhere, then polish and paste back</span></div><button id="capturePolishShortcut" class="soft-btn" type="button"><span id="polishShortcutValue">Cmd/Ctrl + Shift + P</span></button><button id="savePolishShortcut" class="soft-btn" type="button">Save</button></div><label class="settings-row"><div><strong>Auto polish dictated text</strong><span>After transcription, polish the text before pasting it into the focused app.</span></div><input id="autoPolish" type="checkbox" /></label><label class="settings-row"><div><strong>Launch app at login</strong><span>Keep FlowDesk ready in the tray</span></div><input id="autostart" type="checkbox" /></label></section><section class="settings-panel" data-settings-panel="voice"><label class="settings-row"><div><strong>Voice trigger</strong><span>Background audio stays on this device. Windows supports custom phrases; Mac/Linux use Alexa.</span></div><input id="voiceTrigger" type="checkbox" /></label><label class="settings-row"><div><strong>Trigger engine</strong><span>Use Windows Speech for custom words on Windows. OpenWakeWord currently supports Alexa.</span></div><select id="voiceTriggerEngine"><option value="openwakeword">OpenWakeWord — Alexa</option><option value="windows">Windows Speech — custom phrase</option></select></label><label class="settings-row"><div><strong>Trigger phrase</strong><span>Works with Windows Speech. For OpenWakeWord, the active word is Alexa.</span></div><input id="voiceTriggerPhrase" type="text" value="start typing" autocomplete="off" /></label></section><section class="settings-panel" data-settings-panel="audio"><label class="settings-row"><div><strong>Pause background media</strong><span>Pause/resume the current video or music while recording.</span></div><input id="pauseBackgroundMedia" type="checkbox" /></label><label class="settings-row"><div><strong>Fast mic mode</strong><span>Keep the WebView mic warm so recording starts faster.</span></div><input id="fastMic" type="checkbox" /></label><label class="settings-row"><div><strong>Native mic backend</strong><span>Use Windows native audio capture for faster start. Live Deepgram streaming still uses WebView mic.</span></div><input id="nativeMic" type="checkbox" /></label><label class="settings-row"><div><strong>Audio ducking volume</strong><span>Background volume while recording. Restores as soon as recording stops.</span></div><input id="audioDuckingVolume" type="range" min="0" max="100" step="5" /><span id="audioDuckingVolumeValue">35%</span></label><div class="settings-row"><div><strong>Test audio ducking</strong><span>Lowers volume briefly, then restores it automatically.</span></div><button id="testAudioDucking" class="soft-btn" type="button">Run test</button></div></section></div>
      </section>
    </aside>

    <button id="miniWidget" class="mini-widget idle" type="button" aria-label="Start recording" aria-pressed="false">
      <span class="mini-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
      <strong id="miniWidgetLabel">Tap to speak</strong>
      <em id="miniWidgetState">Idle</em>
    </button>

  </main>
`;

const apiKeyInput = document.querySelector<HTMLInputElement>('#apiKey')!;
const drawerApiKeyInput = document.querySelector<HTMLInputElement>('#drawerApiKey')!;
const elevenLabsApiKeyInput = document.querySelector<HTMLInputElement>('#elevenLabsApiKey')!;
const sarvamApiKeyInput = document.querySelector<HTMLInputElement>('#sarvamApiKey')!;
const deepgramApiKeyInput = document.querySelector<HTMLInputElement>('#deepgramApiKey')!;
const deepgramStreamingInput = document.querySelector<HTMLInputElement>('#deepgramStreaming')!;
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
const settingsTitle = document.querySelector<HTMLElement>('#settingsTitle')!;
const settingsSubtitle = document.querySelector<HTMLElement>('#settingsSubtitle')!;
const autostartInput = document.querySelector<HTMLInputElement>('#autostart')!;
const pauseBackgroundMediaInput = document.querySelector<HTMLInputElement>('#pauseBackgroundMedia')!;
const autoPolishInput = document.querySelector<HTMLInputElement>('#autoPolish')!;
const fastMicInput = document.querySelector<HTMLInputElement>('#fastMic')!;
const nativeMicInput = document.querySelector<HTMLInputElement>('#nativeMic')!;
const voiceTriggerInput = document.querySelector<HTMLInputElement>('#voiceTrigger')!;
const voiceTriggerEngineInput = document.querySelector<HTMLSelectElement>('#voiceTriggerEngine')!;
const voiceTriggerPhraseInput = document.querySelector<HTMLInputElement>('#voiceTriggerPhrase')!;
const recordingModeInput = document.querySelector<HTMLSelectElement>('#recordingMode')!;
const audioDuckingVolumeInput = document.querySelector<HTMLInputElement>('#audioDuckingVolume')!;
const audioDuckingVolumeValue = document.querySelector<HTMLElement>('#audioDuckingVolumeValue')!;
const testAudioDuckingButton = document.querySelector<HTMLButtonElement>('#testAudioDucking')!;
const statusBox = document.querySelector<HTMLElement>('#status')!;
const totalWordsSpokenEl = document.querySelector<HTMLElement>('#totalWordsSpoken')!;
const averageWordsPerMinuteEl = document.querySelector<HTMLElement>('#averageWordsPerMinute')!;
const averageWordsPerRecordingEl = document.querySelector<HTMLElement>('#averageWordsPerRecording')!;
const recordOrb = document.querySelector<HTMLElement>('#recordOrb')!;
const miniWidget = document.querySelector<HTMLElement>('#miniWidget')!;
const miniWidgetLabel = document.querySelector<HTMLElement>('#miniWidgetLabel')!;
const miniWidgetState = document.querySelector<HTMLElement>('#miniWidgetState')!;
const rewriteInput = document.querySelector<HTMLTextAreaElement>('#rewriteInput')!;
const rewriteOutput = document.querySelector<HTMLElement>('#rewriteOutput')!;
const historyList = document.querySelector<HTMLElement>('#historyList')!;
const openRewriteButton = document.querySelector<HTMLButtonElement>('#openRewrite');
const copyRewriteButton = document.querySelector<HTMLButtonElement>('#copyRewrite')!;
const pasteRewriteButton = document.querySelector<HTMLButtonElement>('#pasteRewrite')!;
const startFromScratchpadButton = document.querySelector<HTMLButtonElement>('#startFromScratchpad')!;
const debugExpectedWordsInput = document.querySelector<HTMLTextAreaElement>('#debugExpectedWords')!;
const debugLogOutput = document.querySelector<HTMLElement>('#debugLogOutput')!;
const copyDebugBundleButton = document.querySelector<HTMLButtonElement>('#copyDebugBundle')!;

apiKeyInput.value = localStorage.getItem('groqApiKey') || '';
drawerApiKeyInput.value = apiKeyInput.value;
elevenLabsApiKeyInput.value = localStorage.getItem(ELEVENLABS_KEY) || '';
sarvamApiKeyInput.value = localStorage.getItem(SARVAM_KEY) || '';
deepgramApiKeyInput.value = localStorage.getItem(DEEPGRAM_KEY) || '';
deepgramStreamingInput.checked = deepgramStreamingEnabled;
debugExpectedWordsInput.value = localStorage.getItem(DEBUG_EXPECTED_WORDS_KEY) || '';
renderProvider();
if (vocabularyInput) vocabularyInput.value = localStorage.getItem(VOCABULARY_KEY) || '';
renderShortcut(shortcut);
renderPolishShortcut(polishShortcut);
renderHistory();
renderStats();
pauseBackgroundMediaInput.checked = pauseBackgroundMediaEnabled;
autoPolishInput.checked = autoPolishEnabled;
fastMicInput.checked = fastMicEnabled;
nativeMicInput.checked = nativeMicEnabled;
voiceTriggerInput.checked = voiceTriggerEnabled;
voiceTriggerEngineInput.value = voiceTriggerEngine;
voiceTriggerPhraseInput.value = voiceTriggerPhrase;
recordingModeInput.value = recordingMode;
audioDuckingVolumeInput.value = String(audioDuckingVolume);
audioDuckingVolumeValue.textContent = `${audioDuckingVolume}%`;
hydrateRewriteFromHistory();
setupPushToTalkListeners();
if (fastMicEnabled) setTimeout(() => warmUpMic().catch(() => {}), 250);
if (voiceTriggerEnabled) setTimeout(() => startVoiceTrigger().catch((error) => {
  addDebugEvent('voice_trigger_autostart_failed', String(error));
  voiceTriggerEnabled = false;
  voiceTriggerInput.checked = false;
  localStorage.setItem(VOICE_TRIGGER_KEY, 'false');
  setStatus('error', `Voice trigger failed: ${String(error)}`);
}), 350);

// Load full history from disk (async, replaces localStorage snapshot)
// Wrapped in setTimeout to ensure it never blocks shortcut registration
setTimeout(async () => {
  try {
    const diskHistory = await loadHistoryFromDisk();
    if (diskHistory.length > 0) {
      historyItems = diskHistory;
      selectedHistoryId = historyItems[0]?.id || '';
      totalWordsSpoken = loadTotalWordsSpoken(historyItems);
      renderHistory();
      renderStats();
      hydrateRewriteFromHistory();
    }
  } catch (e) {
    console.warn('Disk history load failed, using localStorage', e);
  }
}, 100);

apiKeyInput.addEventListener('change', syncApiKey);
drawerApiKeyInput.addEventListener('change', syncApiKey);
elevenLabsApiKeyInput.addEventListener('change', syncElevenLabsKey);
sarvamApiKeyInput.addEventListener('change', syncSarvamKey);
deepgramApiKeyInput.addEventListener('change', syncDeepgramKey);
deepgramStreamingInput.addEventListener('change', () => {
  deepgramStreamingEnabled = deepgramStreamingInput.checked;
  localStorage.setItem(DEEPGRAM_STREAMING_KEY, String(deepgramStreamingEnabled));
});
debugExpectedWordsInput.addEventListener('input', () => localStorage.setItem(DEBUG_EXPECTED_WORDS_KEY, debugExpectedWordsInput.value.trim()));
copyDebugBundleButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(buildDebugBundle());
  setStatus('success', 'Debug bundle copied. Paste it here.');
});
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

function syncDeepgramKey() {
  if (deepgramApiKeyInput) localStorage.setItem(DEEPGRAM_KEY, deepgramApiKeyInput.value.trim());
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
miniWidget.addEventListener('click', () => toggleRecording());
settingsButton?.addEventListener('click', openSettings);
closeSettingsButton.addEventListener('click', closeSettings);
drawerBackdrop.addEventListener('click', closeSettings);
openRewriteButton?.addEventListener('click', () => setView('transforms'));
startFromScratchpadButton.addEventListener('click', () => toggleRecording());
testAudioDuckingButton.addEventListener('click', () => testAudioDucking());

document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]').forEach((button) => {
  button.addEventListener('click', () => setSettingsPanel(button.dataset.settingsTab || 'general'));
});

window.addEventListener('keydown', async (event) => {
  if (!captureTarget && shortcutMatchesEvent(shortcut, event)) {
    event.preventDefault();
    if (!isTauriRuntime) toggleRecording();
    return;
  }

  if (!captureTarget && shortcutMatchesEvent(polishShortcut, event)) {
    event.preventDefault();
    if (!isTauriRuntime) polishSelectedText();
    return;
  }

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

function shortcutMatchesEvent(value: string, event: KeyboardEvent) {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  const finalKey = parts.at(-1);
  if (!finalKey) return false;

  const wantsCtrlOrMeta = parts.includes('CommandOrControl');
  const wantsAlt = parts.includes('Alt');
  const wantsShift = parts.includes('Shift');
  const key = normalizeKey(event.key);

  return key === finalKey
    && (!wantsCtrlOrMeta || event.ctrlKey || event.metaKey)
    && (!wantsAlt || event.altKey)
    && (!wantsShift || event.shiftKey);
}

window.addEventListener('keyup', (event) => {
  if (!captureTarget) return;
  updateShortcutModifierState(event, false);
  renderShortcutPreview();
}, true);

autoPolishInput.addEventListener('change', () => {
  autoPolishEnabled = autoPolishInput.checked;
  localStorage.setItem(AUTO_POLISH_KEY, String(autoPolishEnabled));
  setStatus('success', autoPolishEnabled ? 'Auto polish enabled for dictated text.' : 'Auto polish disabled. Dictation will paste raw transcripts.');
});

pauseBackgroundMediaInput.addEventListener('change', () => {
  pauseBackgroundMediaEnabled = pauseBackgroundMediaInput.checked;
  localStorage.setItem(MEDIA_PAUSE_KEY, String(pauseBackgroundMediaEnabled));
  setStatus('success', pauseBackgroundMediaEnabled ? 'Background media pause enabled.' : 'Background media pause disabled.');
});

fastMicInput.addEventListener('change', () => {
  fastMicEnabled = fastMicInput.checked;
  localStorage.setItem(FAST_MIC_KEY, String(fastMicEnabled));
  if (fastMicEnabled) {
    warmUpMic()
      .then(() => setStatus('success', 'Fast mic mode enabled. Recording will start faster.'))
      .catch((error) => setStatus('error', `Fast mic failed: ${String(error)}`));
  } else {
    releaseWarmMic();
    setStatus('success', 'Fast mic mode disabled.');
  }
});

nativeMicInput.addEventListener('change', () => {
  nativeMicEnabled = nativeMicInput.checked;
  localStorage.setItem(NATIVE_MIC_KEY, String(nativeMicEnabled));
  setStatus('success', nativeMicEnabled ? 'Native mic backend enabled.' : 'Native mic backend disabled.');
});

voiceTriggerInput.addEventListener('change', async () => {
  voiceTriggerEnabled = voiceTriggerInput.checked;
  localStorage.setItem(VOICE_TRIGGER_KEY, String(voiceTriggerEnabled));
  try {
    if (voiceTriggerEnabled) {
      await startVoiceTrigger();
      setStatus('success', 'Voice trigger enabled. Say “Alexa” to start dictation.');
    } else {
      await stopVoiceTrigger();
      setStatus('success', 'Voice trigger disabled.');
    }
  } catch (error) {
    voiceTriggerEnabled = false;
    voiceTriggerInput.checked = false;
    localStorage.setItem(VOICE_TRIGGER_KEY, 'false');
    setStatus('error', `Voice trigger failed: ${String(error)}`);
  }
});

voiceTriggerEngineInput.addEventListener('change', async () => {
  voiceTriggerEngine = voiceTriggerEngineInput.value as VoiceTriggerEngine;
  localStorage.setItem(VOICE_TRIGGER_ENGINE_KEY, voiceTriggerEngine);
  if (voiceTriggerEnabled) {
    try {
      await stopVoiceTrigger();
      await startVoiceTrigger();
      setStatus('success', voiceTriggerEngine === 'windows'
        ? `Windows custom trigger enabled: “${voiceTriggerPhrase}”.`
        : 'OpenWakeWord trigger enabled. Say “Alexa”.');
    } catch (error) {
      setStatus('error', `Voice trigger failed: ${String(error)}`);
    }
  } else {
    setStatus('success', voiceTriggerEngine === 'windows' ? 'Windows custom trigger selected.' : 'OpenWakeWord trigger selected.');
  }
});

voiceTriggerPhraseInput.addEventListener('change', () => {
  voiceTriggerPhrase = voiceTriggerPhraseInput.value.trim() || 'start typing';
  voiceTriggerPhraseInput.value = voiceTriggerPhrase;
  localStorage.setItem(VOICE_TRIGGER_PHRASE_KEY, voiceTriggerPhrase);
  if (voiceTriggerEngine === 'windows') {
    setStatus('success', `Windows trigger phrase saved: “${voiceTriggerPhrase}”.`);
    if (voiceTriggerEnabled) {
      stopVoiceTrigger()
        .then(() => startVoiceTrigger())
        .catch((error) => setStatus('error', `Voice trigger restart failed: ${String(error)}`));
    }
  } else {
    setStatus('idle', 'Saved text, but OpenWakeWord still detects “Alexa”. Choose Windows Speech for custom words.');
  }
});

recordingModeInput.addEventListener('change', () => {
  recordingMode = recordingModeInput.value as RecordingMode;
  localStorage.setItem(RECORDING_MODE_KEY, recordingMode);
  setStatus('success', recordingMode === 'hold' ? 'Dictation mode: hold shortcut to record.' : 'Dictation mode: press once to start, press again to stop.');
});

audioDuckingVolumeInput.addEventListener('input', () => {
  audioDuckingVolume = Number(audioDuckingVolumeInput.value);
  localStorage.setItem(AUDIO_DUCKING_VOLUME_KEY, String(audioDuckingVolume));
  audioDuckingVolumeValue.textContent = `${audioDuckingVolume}%`;
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
  if (pasteRewriteInFlight) {
    addDebugEvent('paste_rewrite_ignored_already_in_flight');
    return;
  }

  const text = getRewriteText();
  if (!text) return;

  pasteRewriteInFlight = true;
  pasteRewriteButton.disabled = true;
  try {
    if (!isTauriRuntime) {
      await navigator.clipboard.writeText(text);
      setStatus('idle', 'Preview mode: copied rewritten text instead of pasting.');
      return;
    }

    await invoke('paste_transcript', { text });
    setStatus('success', 'Rewritten text pasted into the focused app.');
  } finally {
    pasteRewriteInFlight = false;
    pasteRewriteButton.disabled = false;
  }
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

function setSettingsPanel(panel: string) {
  const meta: Record<string, { title: string; subtitle: string }> = {
    general: { title: 'General', subtitle: 'Core keys and typing behavior.' },
    voice: { title: 'Voice trigger', subtitle: 'Local wake-word detection before dictation starts.' },
    audio: { title: 'Audio', subtitle: 'Mic, media pause, and volume behavior.' },
  };
  const next = meta[panel] ? panel : 'general';
  document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.settingsTab === next);
  });
  document.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach((section) => {
    section.classList.toggle('active', section.dataset.settingsPanel === next);
  });
  settingsTitle.textContent = meta[next].title;
  settingsSubtitle.textContent = meta[next].subtitle;
}

function setStatus(kind: StatusKind, message: string) {
  addDebugEvent('status', { kind, message });
  statusBox.className = `status ${kind}`;
  statusBox.textContent = message;
  recordOrb.className = `record-orb ${kind}`;
  miniWidget.classList.remove('shortcut-active');
  miniWidget.classList.toggle('recording', kind === 'recording');
  miniWidget.classList.toggle('working', kind === 'working');
  miniWidget.classList.toggle('idle', kind !== 'recording' && kind !== 'working');
  miniWidget.setAttribute('aria-pressed', String(kind === 'recording'));
  miniWidget.setAttribute('aria-label', kind === 'recording' ? 'Stop recording' : 'Start recording');
  miniWidgetLabel.textContent = kind === 'recording' ? 'Listening' : kind === 'working' ? 'Processing' : 'Tap to speak';
  miniWidgetState.textContent = kind === 'recording' ? 'Speak now' : kind === 'working' ? 'Wait' : 'Idle';
  if (kind !== 'recording') stopWaveformMonitor();
  toggleButton.innerHTML = kind === 'recording'
    ? '<span class="button-dot"></span>Stop and paste'
    : '<span class="button-dot"></span>Start recording';
}

function addDebugEvent(label: string, data?: unknown) {
  debugEvents.push({ time: new Date().toISOString(), label, data });
  debugEvents = debugEvents.slice(-300);
  renderDebugLog();
}

function safeDebugData(data: unknown) {
  if (data instanceof Blob) return { size: data.size, type: data.type };
  if (data instanceof Event) return { type: data.type };
  return data;
}

function renderDebugLog() {
  if (!debugLogOutput) return;
  debugLogOutput.textContent = debugEvents.length
    ? debugEvents.map((event) => `[${event.time}] ${event.label}${event.data === undefined ? '' : ` ${JSON.stringify(safeDebugData(event.data))}`}`).join('\n')
    : 'No stream logs yet.';
}

function buildDebugBundle() {
  const safeKey = activeTranscriptionKey() ? `${activeTranscriptionKey().slice(0, 4)}…${activeTranscriptionKey().slice(-4)}` : 'missing';
  return JSON.stringify({
    createdAt: new Date().toISOString(),
    expectedWords: debugExpectedWordsInput.value.trim(),
    provider: transcriptionProvider,
    deepgramStreamingEnabled,
    keyPreview: safeKey,
    userAgent: navigator.userAgent,
    mediaRecorderSupported: typeof MediaRecorder !== 'undefined',
    supportedMimeTypes: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].filter((type) => MediaRecorder.isTypeSupported(type)),
    selectedMimeType: pickMimeType(),
    shortcut: formatShortcutLabel(shortcut),
    currentStatus: statusBox.textContent,
    recorderState: recorder?.state || null,
    recordingFinishing,
    streamingSocketState: streamingSocket?.readyState ?? null,
    micPeakLevel: Number(waveformPeakLevel.toFixed(4)),
    chunksBuffered: chunks.map((chunk) => chunk instanceof Blob ? { size: chunk.size, type: chunk.type } : String(chunk)),
    events: debugEvents,
  }, null, 2);
}

function startWaveformMonitor(stream: MediaStream) {
  addDebugEvent('waveform_monitor_start');
  stopWaveformMonitor();

  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;

  waveformContext = new AudioContextCtor();
  waveformAnalyser = waveformContext.createAnalyser();
  waveformAnalyser.fftSize = 256;
  waveformData = new Uint8Array(new ArrayBuffer(waveformAnalyser.frequencyBinCount));
  waveformPeakLevel = 0;
  waveformLastLogAt = Date.now();
  waveformContext.createMediaStreamSource(stream).connect(waveformAnalyser);

  const bars = Array.from(miniWidget.querySelectorAll<HTMLElement>('.mini-wave i'));
  const multipliers = [0.5, 0.75, 1.12, 0.86, 1.28, 0.7, 0.52];

  const tick = () => {
    if (!waveformAnalyser || !waveformData) return;
    waveformAnalyser.getByteTimeDomainData(waveformData);

    let sum = 0;
    for (const value of waveformData) sum += Math.abs(value - 128);
    const volume = sum / waveformData.length / 128;
    const level = Math.min(1, Math.max(0, (volume - 0.015) * 12));
    waveformPeakLevel = Math.max(waveformPeakLevel, level);

    const now = Date.now();
    if (now - waveformLastLogAt > 1000) {
      waveformLastLogAt = now;
      addDebugEvent('mic_level', {
        volume: Number(volume.toFixed(4)),
        level: Number(level.toFixed(4)),
        peakLevel: Number(waveformPeakLevel.toFixed(4)),
        speaking: volume > 0.035,
      });
    }

    miniWidget.classList.toggle('speaking', volume > 0.035);
    bars.forEach((bar, index) => {
      const height = 12 + level * 34 * multipliers[index % multipliers.length];
      bar.style.setProperty('--bar-height', `${Math.max(10, Math.min(48, height))}px`);
    });

    waveformFrame = window.requestAnimationFrame(tick);
  };

  tick();
}

async function warmUpMic() {
  if (!isTauriRuntime && !fastMicEnabled) return null;
  if (warmMicStream && warmMicStream.getAudioTracks().some((track) => track.readyState === 'live')) {
    return warmMicStream;
  }
  if (warmMicPromise) return warmMicPromise;

  addDebugEvent('fast_mic_warmup_start');
  warmMicPromise = navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      warmMicStream = stream;
      addDebugEvent('fast_mic_warmup_ready', { trackCount: stream.getAudioTracks().length });
      return stream;
    })
    .catch((error) => {
      addDebugEvent('fast_mic_warmup_error', String(error));
      throw error;
    })
    .finally(() => {
      warmMicPromise = null;
    });

  return warmMicPromise;
}

async function getRecordingStream() {
  if (!fastMicEnabled) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return { stream, warm: false };
  }

  try {
    const stream = await warmUpMic();
    if (stream) return { stream, warm: true };
  } catch (error) {
    addDebugEvent('fast_mic_fallback_normal_open', String(error));
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return { stream, warm: false };
}

function releaseWarmMic() {
  if (!warmMicStream) return;
  warmMicStream.getTracks().forEach((track) => track.stop());
  warmMicStream = null;
  addDebugEvent('fast_mic_released');
}

function stopWaveformMonitor() {
  if (waveformFrame || waveformContext || waveformAnalyser) addDebugEvent('waveform_monitor_stop');
  if (waveformFrame) window.cancelAnimationFrame(waveformFrame);
  waveformFrame = 0;
  waveformAnalyser = null;
  waveformData = null;
  waveformLastLogAt = 0;
  miniWidget.classList.remove('speaking');
  miniWidget.querySelectorAll<HTMLElement>('.mini-wave i').forEach((bar) => bar.style.removeProperty('--bar-height'));
  if (waveformContext) {
    waveformContext.close().catch(() => {});
    waveformContext = null;
  }
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

  // Plain letters hijack normal typing. Single function keys like F16 are safe
  // and useful for dedicated macro keys, so allow them without modifiers.
  if (parts.length === 0 && !isStandaloneShortcutKey(key)) {
    setStatus('idle', 'Press a function key like F16, or hold Ctrl/Alt/Shift and press a key.');
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

function isStandaloneShortcutKey(key: string) {
  return /^F([1-9]|1\d|2[0-4])$/.test(key) || ['Pause', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'].includes(key);
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

    await unregisterRecordingToggleShortcuts(next);
    try {
      await invoke('install_push_to_talk_hook', { shortcut: next, holdMode: recordingMode === 'hold' });
      shortcut = next;
      localStorage.setItem('shortcut', next);
      renderShortcut(next);
      setStatus('success', `${recordingMode === 'hold' ? 'Hold-to-talk' : 'Toggle'} shortcut registered: ${formatShortcutLabel(next)}.`);
      addDebugEvent('push_to_talk_hook_registered', { shortcut: next, mode: recordingMode });
      addDebugEvent('global_shortcut_backup_skipped_native_mode_active', { shortcut: next, mode: recordingMode });
      return;
    } catch (error) {
      addDebugEvent('push_to_talk_hook_failed_falling_back', String(error));
    }

    if (isUnsafeRecordingShortcut(next)) {
      shortcut = DEFAULT_SHORTCUT;
      localStorage.setItem('shortcut', shortcut);
      renderShortcut(shortcut);
      setStatus('error', `Native shortcut failed, so ${formatShortcutLabel(next)} was rejected because fallback mode can type letters into apps. Use ${formatShortcutLabel(DEFAULT_SHORTCUT)} or fix native hook.`);
      return;
    }

    await register(next, () => toggleRecording());
    shortcut = next;
    localStorage.setItem('shortcut', next);
    renderShortcut(next);
    setStatus('success', `Toggle shortcut registered: ${formatShortcutLabel(next)}`);
  } catch (error) {
    setStatus('error', `Could not register recording shortcut: ${String(error)}`);
  }
}

async function unregisterRecordingToggleShortcuts(next: string) {
  const staleShortcuts = new Set([
    shortcut,
    next,
    DEFAULT_SHORTCUT,
    'Alt+V',
    'CommandOrControl+Alt+Space',
  ].filter(Boolean));

  for (const value of staleShortcuts) {
    try {
      if (await isRegistered(value)) {
        await unregister(value);
        addDebugEvent('stale_toggle_shortcut_unregistered', { shortcut: value });
      }
    } catch (error) {
      addDebugEvent('stale_toggle_shortcut_unregister_failed', { shortcut: value, error: String(error) });
    }
  }
}

function isUnsafeRecordingShortcut(value: string) {
  const finalKey = value.split('+').map((part) => part.trim()).filter(Boolean).at(-1) || '';
  return /^[A-Z]$/i.test(finalKey);
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
  if (polishInFlight) {
    addDebugEvent('polish_selected_text_ignored_already_in_flight');
    return;
  }

  syncApiKey();
  if (!apiKeyInput.value.trim()) {
    setStatus('error', 'Add your Groq API key first.');
    return;
  }

  polishInFlight = true;
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
  } finally {
    polishInFlight = false;
  }
}


async function setupPushToTalkListeners() {
  if (!isTauriRuntime || pushToTalkListenersReady) return;
  pushToTalkListenersReady = true;

  await listen('push-to-talk-debug', (event) => addDebugEvent('push_to_talk_native_debug', event.payload));
  await listen('wake-word-detected', (event) => {
    addDebugEvent('wake_word_detected', { probability: event.payload });
    startRecordingFromVoiceTrigger();
  });
  await listen('push-to-talk-down', () => {
    addDebugEvent('push_to_talk_down_event');
    startRecordingFromPushToTalk();
  });
  await listen('push-to-talk-up', () => {
    addDebugEvent('push_to_talk_up_event');
    if (recordingMode === 'hold') stopRecordingFromPushToTalk();
    else addDebugEvent('push_to_talk_up_ignored_toggle_mode');
  });
}

async function startVoiceTrigger() {
  if (!isTauriRuntime) {
    setStatus('idle', 'Voice trigger runs inside the desktop app.');
    return;
  }
  await setupPushToTalkListeners();
  await stopVoiceTrigger();
  if (voiceTriggerEngine === 'windows') {
    await invoke('start_windows_speech_listener', { phrase: voiceTriggerPhrase });
    addDebugEvent('voice_trigger_started', { wakeWord: voiceTriggerPhrase, engine: 'Windows Speech' });
    return;
  }
  await invoke('start_wake_word_listener', { threshold: 0.3 });
  addDebugEvent('voice_trigger_started', { wakeWord: 'Alexa', engine: 'OpenWakeWord' });
}

async function stopVoiceTrigger() {
  if (!isTauriRuntime) return;
  await Promise.allSettled([
    invoke('stop_wake_word_listener'),
    invoke('stop_windows_speech_listener'),
  ]);
  addDebugEvent('voice_trigger_stopped');
}

function startRecordingFromVoiceTrigger() {
  if (recorder?.state === 'recording' || nativeRecordingActive || recordingTransitionInFlight || recordingFinishing) {
    addDebugEvent('wake_word_ignored_recording_busy', { recorderState: recorder?.state || null, nativeRecordingActive, transition: recordingTransitionInFlight, finishing: recordingFinishing });
    return;
  }

  stopAfterStartRequested = false;
  miniWidget.classList.add('shortcut-active');
  miniWidgetLabel.textContent = 'Voice trigger active';
  miniWidgetState.textContent = 'Opening mic';
  toggleRecording();
}

function startRecordingFromPushToTalk() {
  addDebugEvent('push_to_talk_event', { mode: recordingMode, recorderState: recorder?.state || null, transition: recordingTransitionInFlight, finishing: recordingFinishing });

  if (recordingMode === 'toggle') {
    if (requestStopRecording('push_to_talk_toggle')) {
      miniWidget.classList.remove('shortcut-active');
      return;
    }

    if (recordingTransitionInFlight) {
      stopAfterStartRequested = true;
      addDebugEvent('push_to_talk_toggle_stop_after_start_requested');
      return;
    }

    if (recordingFinishing) {
      addDebugEvent('push_to_talk_toggle_ignored_finishing');
      return;
    }
  } else if (recorder?.state === 'recording' || recordingTransitionInFlight || recordingFinishing) {
    addDebugEvent('push_to_talk_down_ignored', { recorderState: recorder?.state || null, transition: recordingTransitionInFlight, finishing: recordingFinishing });
    return;
  }

  stopAfterStartRequested = false;
  miniWidget.classList.add('shortcut-active');
  miniWidgetLabel.textContent = 'Shortcut active';
  miniWidgetState.textContent = 'Opening mic';
  toggleRecording();
}

async function stopRecordingFromPushToTalk() {
  if (recordingMode !== 'hold') return;
  addDebugEvent('push_to_talk_release_check', { source: 'low_level_hook_up', recorderState: recorder?.state || null, nativeRecordingActive, transition: recordingTransitionInFlight, finishing: recordingFinishing });

  miniWidget.classList.remove('shortcut-active');

  if (requestStopRecording('push_to_talk_release')) return;
  if (recordingTransitionInFlight) stopAfterStartRequested = true;
}

async function testAudioDucking() {
  if (!isTauriRuntime) {
    setStatus('idle', 'Audio ducking test runs inside the desktop app.');
    return;
  }

  try {
    setStatus('working', 'Testing audio ducking…');
    await invoke('start_audio_ducking', { targetVolume: audioDuckingVolume / 100 });
    await sleep(1800);
    await invoke('restore_audio_ducking');
    setStatus('success', 'Audio ducking test finished and volume restored.');
  } catch (error) {
    setStatus('error', `Audio ducking test failed: ${String(error)}`);
  }
}

async function toggleRecording() {
  addDebugEvent('toggle_recording_called', { recorderState: recorder?.state || null, nativeRecordingActive, transition: recordingTransitionInFlight, finishing: recordingFinishing, provider: transcriptionProvider, streamingEnabled: deepgramStreamingEnabled });
  const now = Date.now();
  if (recordingTransitionInFlight || recordingFinishing || now - lastRecordingToggleAt < RECORDING_TOGGLE_DEBOUNCE_MS) {
    addDebugEvent('toggle_recording_ignored', { transition: recordingTransitionInFlight, finishing: recordingFinishing, msSinceLastToggle: now - lastRecordingToggleAt });
    return;
  }
  lastRecordingToggleAt = now;
  if (requestStopRecording('toggle')) return;

  recordingTransitionInFlight = true;
  miniWidget.classList.add('shortcut-active');
  miniWidgetLabel.textContent = 'Shortcut active';
  miniWidgetState.textContent = 'Opening mic';

  try {
    syncApiKey();
    syncElevenLabsKey();
    syncSarvamKey();
    syncDeepgramKey();
    if (!activeTranscriptionKey()) {
      addDebugEvent('missing_provider_key', { provider: transcriptionProvider });
      setStatus('error', `Add your ${providerLabel()} API key first.`);
      return;
    }

    if (pauseBackgroundMediaEnabled && isTauriRuntime) {
      await invoke('pause_background_media');
    }

    if (audioDuckingEnabled && isTauriRuntime && !isAudioDucked) {
      await invoke('start_audio_ducking', { targetVolume: audioDuckingVolume / 100 });
      isAudioDucked = true;
    }

    if (shouldUseNativeMic()) {
      await invoke('start_native_recording');
      nativeRecordingActive = true;
      recordingStartedAt = Date.now();
      addDebugEvent('native_recording_started');
      setStatus('recording', recordingMode === 'hold' ? 'Recording with native mic… release shortcut to stop.' : 'Recording with native mic… press shortcut again to stop.');
      if (stopAfterStartRequested) {
        stopAfterStartRequested = false;
        requestStopRecording('stop_after_start_requested');
      }
      return;
    }

    const { stream, warm } = await getRecordingStream();
    addDebugEvent('mic_stream_acquired', { trackCount: stream.getAudioTracks().length, warm });
    startWaveformMonitor(stream);
    chunks = [];
    const mimeType = pickMimeType();
    const streaming = isStreamingActive();
    addDebugEvent('media_recorder_starting', { mimeType, streaming, tracks: stream.getAudioTracks().map((track) => ({ label: track.label, enabled: track.enabled, muted: track.muted, readyState: track.readyState, settings: track.getSettings() })) });
    recorder = new MediaRecorder(stream, { mimeType });

    recorder.addEventListener('dataavailable', (event) => {
      addDebugEvent('media_recorder_dataavailable', { size: event.data.size, type: event.data.type, streaming });
      if (event.data.size > 0) {
        chunks.push(event.data);
        if (streaming) sendAudioChunkToStream(event.data);
      }
    });

    recorder.addEventListener('stop', async () => {
      addDebugEvent('media_recorder_stop_event', { chunks: chunks.map((chunk) => chunk instanceof Blob ? { size: chunk.size, type: chunk.type } : String(chunk)), streaming });
      if (!fastMicEnabled || stream !== warmMicStream) {
        stream.getTracks().forEach((track) => track.stop());
        addDebugEvent('mic_tracks_stopped');
      } else {
        addDebugEvent('fast_mic_tracks_kept_warm');
      }
      if (streaming) {
        await transcribeStreamingResult();
      } else {
        await transcribeAndPaste();
      }
    }, { once: true });

    if (streaming) openStreamingSocket();

    recordingStartedAt = Date.now();
    // Use timeslice for streaming (250ms chunks), otherwise collect all
    if (streaming) {
      recorder.start(250);
    } else {
      recorder.start();
    }
    addDebugEvent('media_recorder_started', { state: recorder.state, streaming, mimeType: recorder.mimeType });
    setStatus('recording', recordingMode === 'hold' ? 'Recording… release shortcut to stop.' : 'Recording… press shortcut again or click widget to stop.');
    if (stopAfterStartRequested) {
      stopAfterStartRequested = false;
      requestStopRecording('stop_after_start_requested');
    }
  } catch (error) {
    await restoreAudioAfterDelay();
    if (pauseBackgroundMediaEnabled && isTauriRuntime) {
      await invoke('resume_background_media');
    }
    setStatus('error', `Mic error: ${String(error)}`);
        addDebugEvent('mic_error', String(error));
  } finally {
    recordingTransitionInFlight = false;
    if (!nativeRecordingActive && recorder?.state !== 'recording') miniWidget.classList.remove('shortcut-active');
  }
}

function requestStopRecording(reason: string) {
  if (nativeRecordingActive) {
    recordingFinishing = true;
    nativeRecordingActive = false;
    addDebugEvent('native_recorder_stop_requested', { reason });
    finishNativeRecording(reason).catch((error) => {
      addDebugEvent('native_recording_finish_error', String(error));
      setStatus('error', String(error));
      recordingFinishing = false;
      recordingTransitionInFlight = false;
    });
    restoreDuckingImmediately();
    return true;
  }

  if (recorder?.state === 'recording') {
    recordingFinishing = true;
    addDebugEvent('recorder_stop_requested', { reason, state: recorder.state });
    recorder.stop();
    restoreDuckingImmediately();
    return true;
  }
  return false;
}

function shouldUseNativeMic() {
  return isTauriRuntime && nativeMicEnabled && !isStreamingActive();
}

async function finishNativeRecording(reason: string) {
  try {
    addDebugEvent('native_recording_finish_start', { reason });
    setStatus('working', `Transcribing native recording with ${providerLabel()}…`);
    const durationMs = recordingStartedAt ? Math.max(1000, Date.now() - recordingStartedAt) : 0;
    const bytes = await invoke<number[]>('stop_native_recording');
    addDebugEvent('native_recording_audio_ready', { bytes: bytes.length, durationMs });
    const text = autoPolishEnabled
      ? await invoke<string>('transcribe_audio', {
        provider: transcriptionProvider,
        apiKey: activeTranscriptionKey(),
        audioBytes: bytes,
        vocabularyPrompt: buildVocabularyPrompt(),
      })
      : await invoke<string>('transcribe_and_paste', {
        provider: transcriptionProvider,
        apiKey: activeTranscriptionKey(),
        audioBytes: bytes,
        vocabularyPrompt: buildVocabularyPrompt(),
      });
    addDebugEvent('native_transcription_result', { text, length: text.length });
    const finalText = await polishDictationIfEnabled(text);
    if (autoPolishEnabled) {
      addDebugEvent('native_auto_polish_result', { text: finalText, length: finalText.length, changed: finalText !== text });
      await pasteTextToFocusedApp(finalText);
    }
    const stats = addHistory(finalText, durationMs);
    rewriteInput.value = finalText;
          setStatus('success', `${finalText !== text ? 'Native mic polished and pasted' : 'Native mic pasted'}: ${stats.words} words · ${stats.wordsPerMinute} WPM.`);
  } finally {
    recordingStartedAt = 0;
    recordingFinishing = false;
    recordingTransitionInFlight = false;
    miniWidget.classList.remove('shortcut-active');
    await restoreAudioAfterDelay();
    if (pauseBackgroundMediaEnabled && isTauriRuntime) {
      await invoke('resume_background_media');
    }
  }
}

function isStreamingActive(): boolean {
  return transcriptionProvider === 'deepgram' && deepgramStreamingEnabled && !!deepgramApiKeyInput.value.trim();
}

function openStreamingSocket() {
  const key = deepgramApiKeyInput.value.trim();
  if (!key) return;

  streamingTranscript = '';
  streamingFinalParts = [];
  streamingLastPastedLength = 0;
  pendingStreamingChunks = [];
  streamingSendPromises = [];
  streamingSocketOpened = false;
  streamingSocketFailed = false;
  streamingPastedLive = false;

  const url = 'wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en-US&interim_results=true&punctuate=true&endpointing=300&utterance_end_ms=1000';
  addDebugEvent('deepgram_socket_opening', { url, auth: 'subprotocol token', expectedWords: debugExpectedWordsInput.value.trim() });
  const ws = new WebSocket(url, ['token', key]);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    streamingSocketOpened = true;
    console.log('[Deepgram WS] connected');
    addDebugEvent('deepgram_socket_open');
    setStatus('recording', 'Streaming — words will appear as you speak…');
    flushPendingStreamingChunks();
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      addDebugEvent('deepgram_message', {
        type: msg.type,
        duration: msg.duration,
        start: msg.start,
        is_final: msg.is_final,
        speech_final: msg.speech_final,
        transcript: msg.channel?.alternatives?.[0]?.transcript || '',
        confidence: msg.channel?.alternatives?.[0]?.confidence,
      });
      if (msg.type === 'Results' && msg.channel?.alternatives?.length) {
        const alt = msg.channel.alternatives[0];
        const text = alt.transcript || '';
        if (text) {
          const liveTranscript = msg.is_final
            ? [...streamingFinalParts, text].join(' ')
            : [...streamingFinalParts, text].join(' ');
          const delta = liveTranscript.substring(streamingLastPastedLength);
          if (delta && isTauriRuntime && !autoPolishEnabled) {
            streamingPastedLive = true;
            invoke('paste_transcript', { text: delta })
              .then(() => addDebugEvent('live_paste_delta', { delta, length: delta.length }))
              .catch((error) => addDebugEvent('live_paste_delta_failed', { delta, error: String(error) }));
          } else if (delta) {
            addDebugEvent('live_paste_delta_browser_skipped', { delta, length: delta.length });
          }
          streamingLastPastedLength = Math.max(streamingLastPastedLength, liveTranscript.length);
          streamingTranscript = liveTranscript;
        }

        if (msg.is_final && text) {
          streamingFinalParts.push(text);
          streamingTranscript = streamingFinalParts.join(' ');
        }
      }
    } catch {}
  });

  ws.addEventListener('error', (e) => {
    streamingSocketFailed = true;
    console.error('[Deepgram WS] error', e);
    addDebugEvent('deepgram_socket_error', e);
  });

  ws.addEventListener('close', (event) => {
    if (!streamingSocketOpened) streamingSocketFailed = true;
    console.log('[Deepgram WS] closed', { code: event.code, reason: event.reason, wasClean: event.wasClean });
    addDebugEvent('deepgram_socket_close', { code: event.code, reason: event.reason, wasClean: event.wasClean });
  });

  streamingSocket = ws;
}

function sendAudioChunkToStream(data: Blob) {
  addDebugEvent('audio_chunk', { size: data.size, type: data.type, socketState: streamingSocket?.readyState ?? 'none' });
  if (!streamingSocket || streamingSocket.readyState === WebSocket.CONNECTING) {
    pendingStreamingChunks.push(data);
    return;
  }

  if (streamingSocket.readyState === WebSocket.OPEN) {
    sendBlobToStreamingSocket(data);
  }
}

function flushPendingStreamingChunks() {
  const queued = pendingStreamingChunks;
  pendingStreamingChunks = [];
  queued.forEach(sendBlobToStreamingSocket);
}

function sendBlobToStreamingSocket(data: Blob) {
  if (!streamingSocket || streamingSocket.readyState !== WebSocket.OPEN) return;
  const sendPromise = data.arrayBuffer().then((buf) => {
    if (streamingSocket?.readyState === WebSocket.OPEN) {
      streamingSocket.send(buf);
      addDebugEvent('audio_chunk_sent', { bytes: buf.byteLength, type: data.type });
    }
  }).catch((error) => {
    streamingSocketFailed = true;
    console.error('[Deepgram WS] audio chunk send failed', error);
  });
  streamingSendPromises.push(sendPromise);
}

async function waitForStreamingAudioSends() {
  const sends = streamingSendPromises;
  streamingSendPromises = [];
  if (sends.length) await Promise.allSettled(sends);
}

async function closeStreamingSocket(): Promise<string> {
  return new Promise((resolve) => {
    if (!streamingSocket) {
      resolve(streamingTranscript.trim());
      return;
    }
    if (streamingSocket.readyState === WebSocket.CLOSED || streamingSocket.readyState === WebSocket.CLOSING) {
      streamingSocket = null;
      pendingStreamingChunks = [];
      streamingSendPromises = [];
      resolve(streamingTranscript.trim());
      return;
    }
    (async () => {
      flushPendingStreamingChunks();
      await waitForStreamingAudioSends();

      // Send close message only after every recorded audio blob has actually left the browser.
      if (streamingSocket?.readyState === WebSocket.OPEN) {
        addDebugEvent('close_stream_sent');
        streamingSocket.send(JSON.stringify({ type: 'CloseStream' }));
      }

      // Wait briefly for any remaining final results, then close
      const timeout = setTimeout(() => {
        streamingSocket?.close();
        streamingSocket = null;
        pendingStreamingChunks = [];
        streamingSendPromises = [];
        resolve(streamingTranscript.trim());
      }, 2200);

      streamingSocket?.addEventListener('close', () => {
        clearTimeout(timeout);
        streamingSocket = null;
        pendingStreamingChunks = [];
        streamingSendPromises = [];
        resolve(streamingTranscript.trim());
      }, { once: true });
    })().catch((error) => {
      streamingSocketFailed = true;
      console.error('[Deepgram WS] close failed', error);
      streamingSocket?.close();
      streamingSocket = null;
      pendingStreamingChunks = [];
      streamingSendPromises = [];
      resolve(streamingTranscript.trim());
    });
  });
}

async function transcribeStreamingResult() {
  try {
    const durationMs = recordingStartedAt ? Math.max(1000, Date.now() - recordingStartedAt) : 0;
    addDebugEvent('streaming_transcription_finish_start', { durationMs, bufferedChunks: chunks.map((chunk) => chunk instanceof Blob ? { size: chunk.size, type: chunk.type } : String(chunk)) });
    setStatus('working', 'Finishing stream…');
    const text = await closeStreamingSocket();
    addDebugEvent('streaming_transcription_finish_result', { text, length: text.length, socketFailed: streamingSocketFailed });

    if (text) {
      const finalText = await polishDictationIfEnabled(text);
      if (finalText !== text) addDebugEvent('streaming_auto_polish_result', { text: finalText, length: finalText.length });
      if (isTauriRuntime && !streamingPastedLive) {
        await pasteTextToFocusedApp(finalText);
        addDebugEvent('streaming_final_paste_full_text', { length: finalText.length, polished: finalText !== text });
      } else if (streamingPastedLive) {
        addDebugEvent('streaming_final_paste_skipped_already_live', { length: text.length });
      }
      const stats = addHistory(finalText, durationMs);
      rewriteInput.value = finalText;
                setStatus('success', `${finalText !== text ? 'Streamed, polished, and pasted' : 'Streamed and pasted'}: ${stats.words} words · ${stats.wordsPerMinute} WPM.`);
    } else {
      const reason = streamingSocketFailed ? 'Live stream connection failed' : 'Live stream returned no text';
      setStatus('working', `${reason} — retrying with normal transcription…`);
      await transcribeAndPaste();
      return;
    }
  } catch (error) {
    addDebugEvent('streaming_transcription_error', String(error));
        setStatus('error', String(error));
  } finally {
    recorder = null;
    chunks = [];
    recordingStartedAt = 0;
    recordingFinishing = false;
    recordingTransitionInFlight = false;
    addDebugEvent('recording_cleanup_complete', { path: 'streaming' });
    await restoreAudioAfterDelay();
    if (pauseBackgroundMediaEnabled && isTauriRuntime) {
      await invoke('resume_background_media');
    }
  }
}

function pickMimeType() {
  const choices = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return choices.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

async function transcribeAndPaste() {
  try {
    addDebugEvent('normal_transcription_start', { provider: transcriptionProvider, chunks: chunks.map((chunk) => chunk instanceof Blob ? { size: chunk.size, type: chunk.type } : String(chunk)) });
    setStatus('working', autoPolishEnabled ? `Transcribing with ${providerLabel()} before polish…` : `Transcribing with ${providerLabel()} and pasting into the focused app…`);
    const durationMs = recordingStartedAt ? Math.max(1000, Date.now() - recordingStartedAt) : 0;
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));

    const text = autoPolishEnabled
      ? await invoke<string>('transcribe_audio', {
        provider: transcriptionProvider,
        apiKey: activeTranscriptionKey(),
        audioBytes: bytes,
        vocabularyPrompt: buildVocabularyPrompt(),
      })
      : await invoke<string>('transcribe_and_paste', {
        provider: transcriptionProvider,
        apiKey: activeTranscriptionKey(),
        audioBytes: bytes,
        vocabularyPrompt: buildVocabularyPrompt(),
      });
    addDebugEvent('normal_transcription_result', { text, length: text.length });

    const finalText = await polishDictationIfEnabled(text);
    if (autoPolishEnabled) {
      addDebugEvent('normal_auto_polish_result', { text: finalText, length: finalText.length, changed: finalText !== text });
      await pasteTextToFocusedApp(finalText);
    }

    const stats = addHistory(finalText, durationMs);
    rewriteInput.value = finalText;
          setStatus('success', `${finalText !== text ? 'Polished and pasted' : 'Pasted and saved to history'}: ${stats.words} words · ${stats.wordsPerMinute} WPM.`);
  } catch (error) {
    addDebugEvent('normal_transcription_error', String(error));
        setStatus('error', String(error));
  } finally {
    recorder = null;
    chunks = [];
    recordingStartedAt = 0;
    recordingFinishing = false;
    recordingTransitionInFlight = false;
    addDebugEvent('recording_cleanup_complete', { path: 'normal' });
    await restoreAudioAfterDelay();
    if (pauseBackgroundMediaEnabled && isTauriRuntime) {
      await invoke('resume_background_media');
    }
  }
}

async function polishDictationIfEnabled(text: string) {
  if (!autoPolishEnabled) return text;
  syncApiKey();
  const key = apiKeyInput.value.trim();
  if (!key) throw new Error('Auto polish needs your Groq API key in Settings.');

  setStatus('working', 'Polishing dictated text before paste…');
  const polished = await invoke<string>('rewrite_text', {
    apiKey: key,
    text,
    mode: 'polish',
  });
  return polished.trim() || text;
}

async function pasteTextToFocusedApp(text: string) {
  if (!isTauriRuntime) {
    await navigator.clipboard.writeText(text);
    return;
  }
  await invoke('paste_transcript', { text });
}

async function restoreAudioAfterDelay() {
  if (!audioDuckingEnabled || !isTauriRuntime || !isAudioDucked) return;
  await sleep(AUDIO_RESTORE_DELAY_MS);
  await restoreDuckingImmediately();
}

function restoreDuckingImmediately() {
  if (!audioDuckingEnabled || !isTauriRuntime || !isAudioDucked) return;
  isAudioDucked = false;
  invoke('restore_audio_ducking')
    .then(() => addDebugEvent('audio_ducking_restored_after_recording_stop'))
    .catch((error) => addDebugEvent('audio_ducking_restore_failed', String(error)));
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
  if (provider === 'deepgram') return 'Deepgram';
  return 'Sarvam';
}

function providerLabel() {
  return providerName(transcriptionProvider);
}

function activeTranscriptionKey() {
  if (transcriptionProvider === 'groq') return apiKeyInput.value.trim();
  if (transcriptionProvider === 'elevenlabs') return elevenLabsApiKeyInput.value.trim();
  if (transcriptionProvider === 'deepgram') return deepgramApiKeyInput.value.trim();
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
  // Synchronous fallback from localStorage; async disk load happens in init
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

async function loadHistoryFromDisk(): Promise<HistoryItem[]> {
  if (!isTauriRuntime) return loadHistory();
  try {
    const records: HistoryItem[] = await invoke('load_transcripts');
    return records;
  } catch (e) {
    console.warn('Failed to load transcripts from disk, falling back to localStorage', e);
    return loadHistory();
  }
}

function saveHistory() {
  // Keep localStorage as quick cache
  localStorage.setItem(HISTORY_KEY, JSON.stringify(historyItems.slice(0, 50)));
}

async function saveTranscriptToDisk(item: HistoryItem) {
  if (!isTauriRuntime) return;
  try {
    await invoke('save_transcript', {
      record: {
        id: item.id,
        text: item.text,
        createdAt: item.createdAt,
        durationMs: item.durationMs ?? 0,
        wordsPerMinute: item.wordsPerMinute ?? 0,
        rewrite: item.rewrite ?? null,
        rewriteMode: item.rewriteMode ?? null,
      },
    });
  } catch (e) {
    console.warn('Failed to save transcript to disk', e);
  }
}

// exported for future use (delete from scratchpad)
// @ts-ignore: will be used when scratchpad delete UI is added
async function deleteTranscriptFromDisk(id: string) {
  if (!isTauriRuntime) return;
  try {
    await invoke('delete_transcript', { id });
  } catch (e) {
    console.warn('Failed to delete transcript from disk', e);
  }
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
  historyItems = [item, ...historyItems];
  selectedHistoryId = item.id;
  totalWordsSpoken += words;
  saveHistory();
  saveTranscriptToDisk(item);
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
  const updated = historyItems.find((item) => item.id === id);
  if (updated) saveTranscriptToDisk(updated);
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
