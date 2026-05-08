# Groq Dictation Tauri

A Windows desktop dictation app built with Tauri.

## What it does

- Captures microphone audio in the Tauri WebView.
- Sends audio to Groq's OpenAI-compatible transcription API.
- Uses `whisper-large-v3-turbo` for speech-to-text.
- Pastes the transcript into the currently focused text field using clipboard + Ctrl+V.
- Supports a configurable global shortcut, default: `CommandOrControl+Alt+Space`.

## Setup

```bash
cd /d E:\groq-dictation-tauri
npm install
npm run tauri dev
```

Enter your Groq API key in the app. It is stored in localStorage on this machine.

## Usage

1. Start the app.
2. Enter your Groq API key.
3. Click into a text input in any app.
4. Press `Ctrl+Alt+Space` to start recording.
5. Press `Ctrl+Alt+Space` again to stop, transcribe, and paste.

## Limitations

Universal text insertion is done via clipboard + simulated paste. This works in most normal desktop apps, browsers, editors, chat apps, etc. It may not work in:

- Elevated/admin apps when this app is not also elevated.
- Password fields or secure inputs.
- Apps that block paste.
- Games or custom-rendered input controls.

For those cases, the app still shows the transcript so it can be copied manually.
