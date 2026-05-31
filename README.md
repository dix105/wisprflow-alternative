# Deskflow

Deskflow is a lightweight desktop dictation app inspired by Wispr Flow. It lets you press a global shortcut, speak naturally, transcribe the audio with your chosen speech-to-text provider, and paste the cleaned transcript back into the app or text field you were using.

Built with **Tauri v2 + Vite + TypeScript** for a fast native desktop experience.

## What we created

Deskflow was created as a desktop-first dictation tool with a clean Flow-style interface:

- Global hotkey recording flow
- Desktop microphone capture
- Automatic transcription and paste into the active app
- Local transcript history / scratchpad
- Dictation stats: words per minute, average words, and total words spoken
- Native Windows push-to-talk hook: hold shortcut to record, duck system volume, release to stop and restore
- Optional background media pause/resume while recording
- Auto polish mode that rewrites dictated speech before it is pasted
- Wispr-style floating overlay pill for recording, waveform, processing, polishing, and inserted states
- Global polish shortcut that copies selected text, polishes it, and pastes it back
- Dictionary vocabulary hints for better spelling
- Rewrite modes for cleaning or reshaping text
- Provider selection between Groq and ElevenLabs
- Compact white desktop UI with sidebar navigation
- Local-only key storage for development/testing

The goal is simple: open Deskflow, set your shortcut, choose a provider, and dictate anywhere.

## Core features

### Global shortcut dictation

Default shortcut:

```txt
CommandOrControl + Alt + Space
```

Flow:

1. Click into any text field in another app.
2. Press the Deskflow shortcut to start recording.
3. Speak naturally.
4. Press the shortcut again to stop.
5. Deskflow transcribes the audio and pastes the text into the focused app.

Shortcut capture requires a modifier key such as Ctrl, Alt, or Shift so normal typing is not hijacked.

### Transcription providers

Deskflow currently supports two transcription providers.

#### 1. Groq

Provider label in app: **Groq**

- Model: `whisper-large-v3-turbo`
- Endpoint: `https://api.groq.com/openai/v1/audio/transcriptions`
- Auth: Bearer token
- Supports vocabulary prompt hints

Groq is fast and works well for direct dictation.

#### 2. ElevenLabs

Provider label in app: **ElevenLabs**

- Model: `scribe_v2`
- Endpoint: `https://api.elevenlabs.io/v1/speech-to-text`
- Auth header: `xi-api-key`
- Uses ElevenLabs Speech to Text API

ElevenLabs is available as an alternative STT provider. In the app, choose ElevenLabs and click **Make active**.

### Provider selection

The Home screen has a **Transcription provider** box below the dictation key section.

It includes:

- Groq provider button
- ElevenLabs provider button
- Active provider badge
- Separate local key fields for each provider
- “Make active” / “Active” state

The selected provider is saved locally under:

```txt
flowDeskProvider
```

### Dictionary / vocabulary

The Dictionary page stores common terms locally and sends them as a prompt hint to Groq Whisper.

Useful for names and product words like:

- Dixit
- Deskflow
- OpenClaw
- Nextbase
- Groq
- Wispr

LocalStorage key:

```txt
flowDeskVocabulary
```

Note: Whisper prompt hints are limited, so Deskflow truncates the prompt before sending.

### Scratchpad / transcript history

The Scratchpad stores recent transcripts locally so you can recover text if pasting fails or you want to reuse a dictation.

Stored locally under:

```txt
flowDeskHistory
```

Each transcript card shows:

- timestamp
- word count
- words per minute
- recording duration
- transcript text
- Copy action
- Rewrite action

### Auto polish dictated text

Settings includes **Auto polish dictated text**. When enabled, Deskflow transcribes the recording, sends the transcript through the Polish writing rewrite mode, then pastes the polished result into the focused app. This also applies to native mic dictation and live Deepgram sessions; live streaming waits for the final transcript when auto polish is enabled so rough interim text is not pasted first.

Auto polish uses the Groq API key because rewrites are powered by Groq chat completions.

### Floating dictation overlay

Deskflow includes a tiny transparent always-on-top overlay window. When dictation starts it shows a black pill similar to Wispr Flow, switches to an animated dotted waveform while listening, then shows processing, polishing, and inserted states before hiding.

Current positioning is the reliable MVP: bottom-center of the active monitor. Exact above-caret positioning can be added later with Windows UI Automation, but some apps block caret coordinates.

### Global polish shortcut

Settings includes a separate **Polish text shortcut**. Default:

```txt
CommandOrControl + Shift + P
```

Flow:

1. Select text in any app.
2. Press the polish shortcut.
3. Deskflow copies the selection, rewrites it with Polish writing mode, and pastes it back.

The shortcut is stored locally under:

```txt
flowDeskPolishShortcut
flowDeskAutoPolish
```

### Background media controls

Settings includes two separate controls:

- **Smooth volume ducking** is always on for shortcut dictation: native Windows hook lowers volume on shortcut down and restores on shortcut up.
- **Pause background media** sends the system media play/pause key when recording starts and stops, so videos/music can pause and resume.

### Smooth volume ducking

On Windows, Deskflow uses a native low-level keyboard hook for real push-to-talk semantics. It saves the current system volume, gently lowers it when the dictation shortcut is pressed, records while held, then stops recording and restores the exact saved volume when the shortcut is released. Settings includes a **Test audio ducking** button so restore can be verified without doing a real dictation.

### Dictation stats

The Home screen summarizes speaking activity locally:

- Total words spoken across saved dictations
- Average speed in words per minute
- Average words per recording

New recordings save their duration and WPM alongside the transcript. The all-time total is stored locally under:

```txt
flowDeskTotalWordsSpoken
```

### Rewrite modes

Deskflow includes rewrite helpers powered by Groq chat completions.

Model:

```txt
llama-3.3-70b-versatile
```

Modes:

- Clean up
- Polish writing (`Cmd/Ctrl + Enter` inside the rewrite input, or the global configurable Polish text shortcut)
- Professional
- Shorter
- Friendly

These are used to clean dictation artifacts, polish written text, improve grammar, or reshape tone.

## Tech stack

- **Desktop shell:** Tauri v2
- **Frontend:** Vite + TypeScript
- **Styling:** Vanilla CSS with DM Sans
- **Backend/native commands:** Rust
- **Clipboard/paste:** `arboard` + simulated `Ctrl+V` on Windows
- **Global shortcut:** `@tauri-apps/plugin-global-shortcut`
- **Autostart:** `@tauri-apps/plugin-autostart`

## Project structure

```txt
.
├── src/
│   ├── main.ts       # UI, recording flow, provider selection, history, shortcuts
│   └── style.css     # Deskflow interface styling
├── src-tauri/
│   ├── src/lib.rs    # Tauri commands, transcription providers, paste behavior
│   ├── Cargo.toml
│   └── tauri.conf.json
├── public/
├── package.json
└── README.md
```

## Local setup

Install dependencies:

```bash
npm install
```

Run the desktop app in development:

```bash
npm run tauri dev
```

Build frontend:

```bash
npm run build
```

Check Rust/Tauri backend:

```bash
cd src-tauri
cargo check
```

### macOS test build

Build the Mac app on a Mac machine:

```bash
npm install
npm run tauri:build -- --bundles app,dmg
```

The `.app` and `.dmg` outputs will be under:

```txt
src-tauri/target/release/bundle/
```

For dictation + paste on macOS, grant FlowDesk:

- Microphone access when macOS prompts
- Accessibility access in System Settings → Privacy & Security → Accessibility
- Automation access if macOS asks to control System Events

Mac support currently uses the Tauri global shortcut plugin in toggle mode plus WebView microphone capture. Cross-app paste and selected-text polish use macOS System Events, so Accessibility permission is required.

## App setup

1. Open Deskflow.
2. Choose a transcription provider: Groq or ElevenLabs.
3. Paste the API key for that provider.
4. Click **Make active** on the provider you want to use.
5. Set or keep the keyboard shortcut.
6. Click into another app and use the shortcut to dictate.

## LocalStorage keys

Deskflow currently stores development settings locally in the WebView:

```txt
groqApiKey              # Groq API key
elevenLabsApiKey        # ElevenLabs API key
flowDeskProvider        # active provider: groq, elevenlabs, sarvam, or deepgram
shortcut                # global shortcut
flowDeskPolishShortcut  # selected-text polish shortcut
flowDeskAutoPolish      # auto-polish dictated text before paste
flowDeskHistory         # recent transcripts
flowDeskVocabulary      # dictionary terms
```

## Security note

API keys are currently stored in `localStorage` for development speed. This is okay for local testing, but production should move keys into secure native storage such as a Tauri keychain/stronghold plugin.

Do not commit API keys into the repository.

## Current limitations

- Clipboard insertion uses copy + simulated paste, so it may not work in every app.
- Elevated/admin apps may reject paste if Deskflow is not also elevated.
- Password fields and secure inputs may block paste.
- ElevenLabs support is batch transcription, not realtime streaming.
- Secure key storage is not implemented yet.
- Windows runtime testing is still required for tray, paste, shortcut, and permission edge cases.

## Repository

GitHub repo:

```txt
https://github.com/dix105/deskflow
```

Previous working name:

```txt
wisprflow-alternative
```

Current product name:

```txt
FlowDesk
```

## Recommended next improvements

- Replace localStorage API keys with secure keychain storage
- Add installer/release workflow for Windows
- Add visible provider health check
- Add “Copied” feedback in Scratchpad
- Add transcript search/filter
- Add more rewrite presets
- Improve tray menu naming from old Groq Dictation labels to Deskflow everywhere
