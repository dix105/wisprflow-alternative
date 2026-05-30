# Meeting Transcription Research

Goal: extend FlowDesk from short dictation into a meeting transcription mode for Indian users, with full meeting transcript after the call.

## Current app baseline

FlowDesk is a Tauri desktop app. It already has:

- Short push-to-talk dictation
- Providers: Groq Whisper, ElevenLabs, Sarvam Saaras v3, Deepgram
- Local history/scratchpad
- Native Windows mic capture path
- No real meeting mode yet: no long-running recorder, no speaker diarization, no meeting notes/export flow, no system-audio capture for calls

## Best public GitHub references

### 1. Meetily — best architecture reference

Repo: https://github.com/Zackriya-Solutions/meetily

Why it matters:

- Open-source AI meeting assistant
- Local processing focus
- Live transcription
- Speaker diarization
- Meeting summarization
- macOS + Windows support
- Rust-based parts, closer to Tauri/Rust than Python-only projects

Use it as reference for:

- Meeting-mode product flow
- Transcript + summary UI
- Local-first meeting assistant architecture
- Speaker labels and meeting note format

Do not copy blindly; extract patterns.

### 2. ownscribe — best local pipeline reference

Repo: https://github.com/paberr/ownscribe

Why it matters:

- Local-first meeting transcription and summarization CLI
- Captures system audio + mic on macOS
- Uses WhisperX for word timestamps
- Optional pyannote speaker diarization
- Local LLM summaries via Ollama/LM Studio/OpenAI-compatible server
- Search/ask across meetings

Use it as reference for:

- Long meeting pipeline
- Output format for transcript + summary
- Silence auto-stop
- Local LLM summary templates
- System-audio + mic capture model

Caveat: macOS system-audio capture is easier here than Windows/Linux; FlowDesk will need platform-specific capture.

### 3. TranscriptionSuite — best diarization/backend reference

Repo: https://github.com/homelab-00/TranscriptionSuite

Why it matters:

- Fully local/private STT app
- Cross-platform support
- Speaker diarization engine
- Longform and live transcription
- LM Studio integration

Use it as reference for:

- Diarization service shape
- Longform transcript handling
- Local backend process separation

### 4. Handless — useful because it is Tauri-like dictation

Repo: https://github.com/ElwinLiu/handless

Why it matters:

- Open-source macOS speech-to-text app
- Local transcription models
- Shortcut-driven dictation
- LLM post-processing

Use it as reference for:

- Local model management UX
- Dictation app polish
- Provider abstraction

Less useful for full meeting transcription than Meetily/ownscribe.

## Sarvam vs offline

Sarvam is not offline; it is a cloud API. It is still important for Indian users because Indian English + Hindi/regional code-mix can be better than generic English-only transcription.

Recommended product positioning:

- `Indian accuracy mode` — Sarvam Saaras v3 cloud transcription
- `Private/offline mode` — local Whisper/WhisperX/Parakeet pipeline
- `Hybrid mode` — record locally, transcribe with Sarvam when online, fallback to local if API fails

## Recommended implementation plan

### Phase 1 — Meeting mode MVP

Add a separate `Meeting` view:

- Start meeting / stop meeting
- Long-running recording timer
- Save full audio locally
- Transcribe after stop using existing provider system, especially Sarvam
- Save transcript as a meeting item, not normal scratchpad dictation
- Export transcript as `.txt` / `.md`

This can reuse most existing provider code.

### Phase 2 — Indian meeting polish

- Sarvam provider options: language selection / auto-detect if supported
- Meeting vocabulary: people names, company names, product names
- Cleanup prompt tuned for Indian English and mixed Hindi-English
- Summary output:
  - Decisions
  - Action items
  - Follow-ups
  - Open questions

### Phase 3 — Speaker diarization

Options:

- Cloud/simple: if provider supports diarization, enable it
- Offline: add a sidecar Python service using WhisperX + pyannote
- Product compromise: start with timestamped transcript first, speaker labels later

### Phase 4 — System audio capture

Required for Google Meet/Zoom/Teams without bots.

Platform path:

- macOS: Core Audio process taps / ScreenCaptureKit style capture
- Windows: WASAPI loopback capture
- Linux: PipeWire/PulseAudio monitor source

This is the hard part. For the first MVP, mic-only meeting recording is much faster; system audio can follow.

## My recommendation

Build Phase 1 first using Sarvam because the app already has Sarvam integration. Then add offline mode using Meetily/ownscribe ideas.

Best immediate next feature set:

1. New `Meeting` tab
2. Record long audio to local file
3. Transcribe with Sarvam/Groq/Deepgram after stop
4. Save transcript in `flowDeskMeetings`
5. Generate simple meeting summary/action items with Groq rewrite endpoint
6. Export Markdown

This gives a useful meeting transcript quickly without waiting for diarization/system-audio complexity.
