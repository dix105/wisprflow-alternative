# Deskflow Architecture

## Entry point
- `index.html` mounts the app into `#app`.
- `src/main.ts` owns the single-page UI, recording flow, provider selection, transcript history, rewrites, shortcuts, and stats.
- `src/style.css` owns all app styling.

## Native/API contract
- Frontend calls Tauri commands with `invoke`:
  - `transcribe_and_paste` receives provider, API key, audio bytes, and vocabulary prompt; returns transcript text.
  - `rewrite_text` receives Groq key, text, and rewrite mode; returns rewritten text.
  - `paste_transcript` receives text for focused-app paste.
- Global shortcut registration uses `@tauri-apps/plugin-global-shortcut`.
- Autostart uses `@tauri-apps/plugin-autostart`.

## Local storage keys
- `flowDeskHistory`: latest transcript cards.
- `flowDeskTotalWordsSpoken`: cumulative spoken-word count.
- `flowDeskProvider`: active STT provider.
- `flowDeskVocabulary`: vocabulary prompt hints.
- `groqApiKey`, `elevenLabsApiKey`, `sarvamApiKey`: local provider keys.
- `shortcut`: global shortcut string.

## Dictation stats
- Recording duration is measured in `src/main.ts` from recorder start until transcription begins.
- Per-recording WPM is calculated from transcript word count and recording duration.
- The Home stats strip renders total words spoken, average WPM, and average words per recording.
- Scratchpad history shows word count, WPM, and recording duration per new transcript.


## Meeting transcription

- `src/main.ts` includes a Meeting view for long-form recording.
- Meeting mode uses the existing `transcribe_audio` Tauri command, so the active provider can be Groq, ElevenLabs, Sarvam, or Deepgram.
- Meeting records are stored locally under `flowDeskMeetings` with `id`, `title`, `createdAt`, `durationMs`, `provider`, and `transcript`.
- Meeting transcripts can be copied or exported as Markdown from the Meeting view.
- Sarvam Hindi/manual sample testing helper: `SARVAM_API_KEY=... node scripts/test-sarvam-hindi-sample.mjs <audio-file> [expected.txt]`.

## Always-on app voice commands

- Optional setting: `flowDeskVoiceCommands`.
- Windows desktop mode starts a native `System.Speech` grammar listener through `start_windows_command_listener`.
- It listens for exact fast commands like `open notion`, `open telegram`, `open discord`, `open x`, `open whatsapp`, `open gmail`, `open github`, and `open chrome`.
- Recognized commands emit `voice-command-detected`; the frontend calls `open_voice_target`.
- `open_voice_target` maps known targets to app schemes or web URLs and opens them via OS shell.
- This path intentionally does not use an LLM for the core open-app commands; exact grammar is faster and safer. Cerebras/GPT-OSS can be layered later for fuzzy commands like “open my notes app” or “message Harshil on Telegram”.

### GPT-OSS command brain

- Optional setting: `flowDeskAiVoiceCommands` with `cerebrasApiKey`.
- Exact grammar commands still execute first for speed.
- If exact parsing returns `none`, the frontend calls `classify_voice_command`.
- `classify_voice_command` uses Cerebras OpenAI-compatible chat completions at `https://api.cerebras.ai/v1/chat/completions` with model `gpt-oss-120b`.
- The model must return JSON: `{ "action": "open|close|none", "target": "...", "confidence": 0-1, "reason": "..." }`.
- The app only acts when confidence is at least `0.65`.
- Close commands are deliberately limited to known mapped desktop apps on Windows.

### Sarvam TTS confirmation and web fallbacks

- Voice commands now use a confirmation step before execution.
- After a valid command decision, the frontend calls `sarvam_text_to_speech` and plays: “I will <action> <target>. Say okay to confirm, or cancel.”
- Saying `okay`, `confirm`, or `yes` executes the pending command; saying `cancel` or `no` clears it.
- `sarvam_text_to_speech` uses Sarvam Bulbul v3 via `https://api.sarvam.ai/text-to-speech` and returns base64 WAV audio.
- Web-capable targets have fallbacks. Examples: WhatsApp falls back to `https://web.whatsapp.com`, Discord to `https://discord.com/app`, Telegram to `https://web.telegram.org`, VS Code to `https://vscode.dev`, and Office apps to Office web launch URLs.
