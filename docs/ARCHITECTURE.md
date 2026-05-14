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
