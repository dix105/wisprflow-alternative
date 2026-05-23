use arboard::Clipboard;
#[cfg(windows)]
use cpal::{traits::{DeviceTrait, HostTrait, StreamTrait}, SampleFormat};
#[cfg(windows)]
use oww_rs::{
    config::SpeechUnlockType::OpenWakeWordAlexa,
    mic::{converters::i16_to_f32, mic_config::find_best_config, process_audio::resample_into_chunks, resampler::{make_resampler, Resamplers}},
    oww::{OwwModel, OWW_MODEL_CHUNK_SIZE},
};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::sync::{mpsc, Arc, Mutex, OnceLock};
#[cfg(windows)]
use std::{
    collections::HashSet,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};
use std::{fs, path::PathBuf, thread, time::Duration};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
#[cfg(windows)]
use tauri::Emitter;
use tauri_plugin_autostart::MacosLauncher;
#[cfg(windows)]
use windows::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator},
    Media::Audio::Endpoints::IAudioEndpointVolume,
    System::{
        Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED},
        Threading::GetCurrentThreadId,
    },
    UI::{
        Input::KeyboardAndMouse::{
            keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, RegisterHotKey, UnregisterHotKey,
            HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_SHIFT, VK_CONTROL, VK_LCONTROL,
            VK_LMENU, VK_LSHIFT, VK_MEDIA_PLAY_PAUSE, VK_MENU, VK_RCONTROL, VK_RETURN,
            VK_RMENU, VK_RSHIFT, VK_SHIFT, VK_SPACE,
        },
        WindowsAndMessaging::{
            CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, HHOOK,
            KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_APP, WM_HOTKEY, WM_KEYDOWN,
            WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
        },
    },
};

#[cfg(windows)]
static ORIGINAL_SYSTEM_VOLUME: Mutex<Option<f32>> = Mutex::new(None);
#[cfg(windows)]
static HOOK_STARTED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static HOTKEY_THREAD_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
#[cfg(windows)]
static HOOK_STATE: OnceLock<Mutex<PushToTalkHookState>> = OnceLock::new();

#[cfg(windows)]
static NATIVE_RECORDER: OnceLock<Mutex<Option<NativeRecordingState>>> = OnceLock::new();
#[cfg(windows)]
static WAKE_WORD_LISTENER: OnceLock<Mutex<Option<WakeWordListenerState>>> = OnceLock::new();
#[cfg(windows)]
static WINDOWS_SPEECH_LISTENER: OnceLock<Mutex<Option<WindowsSpeechListenerState>>> = OnceLock::new();

#[cfg(windows)]
struct NativeRecordingState {
    stop_tx: mpsc::Sender<()>,
    done_rx: mpsc::Receiver<()>,
    samples: Arc<Mutex<Vec<i16>>>,
    sample_rate: u32,
    channels: u16,
}

#[cfg(windows)]
struct WakeWordListenerState {
    stop_tx: mpsc::Sender<()>,
    done_rx: mpsc::Receiver<()>,
}

#[cfg(windows)]
struct WindowsSpeechListenerState {
    child: Child,
}

#[cfg(windows)]
const HOTKEY_ID: i32 = 0x4644;
#[cfg(windows)]
const WM_FLOWDESK_UPDATE_HOTKEY: u32 = WM_APP + 101;

#[cfg(windows)]
struct PushToTalkHookState {
    app: tauri::AppHandle,
    shortcut_keys: Vec<u32>,
    keys_down: HashSet<u32>,
    active: bool,
    suppressing: bool,
    hold_mode: bool,
}

#[derive(Debug, Deserialize)]
struct GroqTranscription {
    text: String,
}

#[derive(Debug, Deserialize)]
struct ElevenLabsTranscription {
    text: String,
}

#[derive(Debug, Deserialize)]
struct SarvamTranscription {
    transcript: Option<String>,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeepgramResponse {
    results: DeepgramResults,
}

#[derive(Debug, Deserialize)]
struct DeepgramResults {
    channels: Vec<DeepgramChannel>,
}

#[derive(Debug, Deserialize)]
struct DeepgramChannel {
    alternatives: Vec<DeepgramAlternative>,
}

#[derive(Debug, Deserialize)]
struct DeepgramAlternative {
    transcript: String,
}

#[derive(Debug, Deserialize)]
struct GroqChatResponse {
    choices: Vec<GroqChatChoice>,
}

#[derive(Debug, Deserialize)]
struct GroqChatChoice {
    message: GroqChatMessage,
}

#[derive(Debug, Deserialize)]
struct GroqChatMessage {
    content: String,
}

#[tauri::command]
async fn transcribe_audio(
    provider: Option<String>,
    api_key: String,
    audio_bytes: Vec<u8>,
    vocabulary_prompt: Option<String>,
) -> Result<String, String> {
    let provider = provider.unwrap_or_else(|| "groq".into());
    match provider.as_str() {
        "elevenlabs" => transcribe_with_elevenlabs(api_key, audio_bytes).await,
        "sarvam" => transcribe_with_sarvam(api_key, audio_bytes).await,
        "deepgram" => transcribe_with_deepgram(api_key, audio_bytes).await,
        _ => transcribe_with_groq(api_key, audio_bytes, vocabulary_prompt).await,
    }
}

#[tauri::command]
async fn transcribe_and_paste(
    provider: Option<String>,
    api_key: String,
    audio_bytes: Vec<u8>,
    vocabulary_prompt: Option<String>,
) -> Result<String, String> {
    let text = transcribe_audio(provider, api_key, audio_bytes, vocabulary_prompt).await?;
    paste_text(&text)?;
    Ok(text)
}


fn audio_part(audio_bytes: Vec<u8>) -> Result<Part, String> {
    let filename = if is_wav(&audio_bytes) { "dictation.wav" } else { "dictation.webm" };
    Part::bytes(audio_bytes)
        .file_name(filename.to_string())
        .mime_str(if filename.ends_with(".wav") { "audio/wav" } else { "audio/webm" })
        .map_err(|e| e.to_string())
}

fn audio_mime(audio_bytes: &[u8]) -> &'static str {
    if is_wav(audio_bytes) { "audio/wav" } else { "audio/webm" }
}

fn is_wav(audio_bytes: &[u8]) -> bool {
    audio_bytes.starts_with(b"RIFF") && audio_bytes.get(8..12) == Some(b"WAVE")
}

async fn transcribe_with_groq(
    api_key: String,
    audio_bytes: Vec<u8>,
    vocabulary_prompt: Option<String>,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Missing Groq API key".into());
    }

    let part = audio_part(audio_bytes)?;

    let mut form = Form::new()
        .text("model", "whisper-large-v3-turbo")
        .text("language", "en")
        .text("response_format", "json")
        .part("file", part);

    if let Some(prompt) = vocabulary_prompt {
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            form = form.text("prompt", prompt.chars().take(900).collect::<String>());
        }
    }

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .bearer_auth(api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Groq request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Groq API error {status}: {body}"));
    }

    let transcription: GroqTranscription = response
        .json()
        .await
        .map_err(|e| format!("Could not parse Groq response: {e}"))?;

    let text = transcription.text.trim().to_string();
    if text.is_empty() {
        return Err("Groq returned an empty transcript".into());
    }

    Ok(text)
}

#[tauri::command]
fn start_native_recording() -> Result<(), String> {
    #[cfg(not(windows))]
    {
        return Err("Native mic capture is only available on Windows right now".into());
    }

    #[cfg(windows)]
    {
    let recorder = NATIVE_RECORDER.get_or_init(|| Mutex::new(None));
    let mut guard = recorder.lock().map_err(|_| "Native recorder lock failed".to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let samples = Arc::new(Mutex::new(Vec::<i16>::new()));
    let thread_samples = samples.clone();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, u16), String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<()>();

    thread::spawn(move || {
        start_native_recording_thread(thread_samples, stop_rx, ready_tx);
        let _ = done_tx.send(());
    });

    let (sample_rate, channels) = ready_rx
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Native mic did not start in time".to_string())??;

    *guard = Some(NativeRecordingState { stop_tx, done_rx, samples, sample_rate, channels });
    Ok(())
    }
}

#[tauri::command]
fn stop_native_recording() -> Result<Vec<u8>, String> {
    #[cfg(not(windows))]
    {
        return Err("Native mic capture is only available on Windows right now".into());
    }

    #[cfg(windows)]
    {
    let recorder = NATIVE_RECORDER.get_or_init(|| Mutex::new(None));
    let state = recorder.lock().map_err(|_| "Native recorder lock failed".to_string())?.take();
    let Some(state) = state else { return Err("Native recording was not active".into()); };
    let _ = state.stop_tx.send(());
    let _ = state.done_rx.recv_timeout(Duration::from_secs(2));
    let samples = state.samples.lock().map_err(|_| "Native audio buffer lock failed".to_string())?.clone();
    if samples.is_empty() {
        return Err("Native recording captured no audio".into());
    }
    Ok(wav_pcm16_bytes(&samples, state.sample_rate, state.channels))
    }
}

#[tauri::command]
fn start_wake_word_listener(_app: tauri::AppHandle, _threshold: Option<f32>) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        return Err("Local wake-word detection is only available on Windows right now".into());
    }

    #[cfg(windows)]
    {
    let app = _app;
    let threshold = _threshold;
    let listener = WAKE_WORD_LISTENER.get_or_init(|| Mutex::new(None));
    let mut guard = listener.lock().map_err(|_| "Wake-word listener lock failed".to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let threshold = threshold.unwrap_or(0.3).clamp(0.05, 0.95);

    thread::spawn(move || {
        let result = run_wake_word_listener(app, threshold, stop_rx, ready_tx);
        if let Err(error) = result {
            eprintln!("wake-word listener stopped with error: {error}");
        }
        let _ = done_tx.send(());
    });

    ready_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Wake-word listener did not start in time".to_string())??;

    *guard = Some(WakeWordListenerState { stop_tx, done_rx });
    Ok(())
    }
}

#[tauri::command]
fn stop_wake_word_listener() -> Result<(), String> {
    #[cfg(not(windows))]
    {
        return Ok(());
    }

    #[cfg(windows)]
    {
    let listener = WAKE_WORD_LISTENER.get_or_init(|| Mutex::new(None));
    let state = listener.lock().map_err(|_| "Wake-word listener lock failed".to_string())?.take();
    if let Some(state) = state {
        let _ = state.stop_tx.send(());
        let _ = state.done_rx.recv_timeout(Duration::from_secs(2));
    }
    Ok(())
    }
}

#[tauri::command]
fn start_windows_speech_listener(_app: tauri::AppHandle, _phrase: String, _stop_phrase: Option<String>) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        return Err("Windows custom voice triggers are only available on Windows".into());
    }

    #[cfg(windows)]
    {
    let app = _app;
    let phrase = _phrase.trim().to_string();
    let stop_phrase = _stop_phrase.unwrap_or_else(|| "stop typing".to_string()).trim().to_string();
    if phrase.is_empty() {
        return Err("Trigger phrase cannot be empty".into());
    }
    if stop_phrase.is_empty() {
        return Err("Stop phrase cannot be empty".into());
    }

    stop_windows_speech_listener()?;

    let listener = WINDOWS_SPEECH_LISTENER.get_or_init(|| Mutex::new(None));
    let mut guard = listener.lock().map_err(|_| "Windows speech listener lock failed".to_string())?;
    let script = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$phrase = $env:FLOWDESK_TRIGGER_PHRASE
$stopPhrase = $env:FLOWDESK_STOP_PHRASE
$recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine ([System.Globalization.CultureInfo]::CurrentCulture)
$choices = New-Object System.Speech.Recognition.Choices
[void]$choices.Add($phrase)
[void]$choices.Add($stopPhrase)
$grammarBuilder = New-Object System.Speech.Recognition.GrammarBuilder
$grammarBuilder.Culture = $recognizer.RecognizerInfo.Culture
[void]$grammarBuilder.Append($choices)
$grammar = New-Object System.Speech.Recognition.Grammar($grammarBuilder)
$recognizer.LoadGrammar($grammar)
$recognizer.SetInputToDefaultAudioDevice()
Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognized -Action {
  if ($EventArgs.Result.Confidence -ge 0.55) {
    $recognized = $EventArgs.Result.Text
    if ($recognized -ieq $env:FLOWDESK_STOP_PHRASE) {
      [Console]::Out.WriteLine(('FLOWDESK_STOP:' + $EventArgs.Result.Confidence))
    } else {
      [Console]::Out.WriteLine(('FLOWDESK_WAKE:' + $EventArgs.Result.Confidence))
    }
    [Console]::Out.Flush()
  }
} | Out-Null
$recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
while ($true) { Start-Sleep -Milliseconds 250 }
"#;

    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("FLOWDESK_TRIGGER_PHRASE", &phrase)
        .env("FLOWDESK_STOP_PHRASE", &stop_phrase)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Windows speech listener: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Some(confidence) = line.strip_prefix("FLOWDESK_WAKE:") {
                    let score = confidence.trim().parse::<f32>().unwrap_or(0.0);
                    let _ = app.emit("wake-word-detected", score);
                } else if let Some(confidence) = line.strip_prefix("FLOWDESK_STOP:") {
                    let score = confidence.trim().parse::<f32>().unwrap_or(0.0);
                    let _ = app.emit("voice-stop-detected", score);
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                eprintln!("windows speech listener: {line}");
            }
        });
    }

    *guard = Some(WindowsSpeechListenerState { child });
    Ok(())
    }
}

#[tauri::command]
fn stop_windows_speech_listener() -> Result<(), String> {
    #[cfg(not(windows))]
    {
        return Ok(());
    }

    #[cfg(windows)]
    {
    let listener = WINDOWS_SPEECH_LISTENER.get_or_init(|| Mutex::new(None));
    let mut guard = listener.lock().map_err(|_| "Windows speech listener lock failed".to_string())?;
    if let Some(mut state) = guard.take() {
        let _ = state.child.kill();
        let _ = state.child.wait();
    }
    Ok(())
    }
}

#[cfg(windows)]
fn run_wake_word_listener(
    app: tauri::AppHandle,
    threshold: f32,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| "No default input microphone found".to_string())?;
    let (config, sample_format) = find_best_config(&device).map_err(|e| format!("Could not find wake-word mic config: {e}"))?;
    let original_sample_rate = config.sample_rate.0 as f32;
    let channels = config.channels as usize;
    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(vec![]));
    let err_fn = |err| eprintln!("wake-word mic stream error: {err}");

    let stream = match sample_format {
        SampleFormat::F32 => {
            let app = app.clone();
            let buffer = buffer.clone();
            let mut model = OwwModel::new(OpenWakeWordAlexa, threshold).map_err(|e| format!("Wake-word model failed: {e}"))?;
            let mut resampler = make_resampler(original_sample_rate as _, OWW_MODEL_CHUNK_SIZE as _, channels)
                .map_err(|e| format!("Wake-word resampler failed: {e}"))?;
            device.build_input_stream(
                &config,
                move |data: &[f32], _| detect_wake_word_chunks(data, &buffer, channels, &mut resampler, &mut model, &app),
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let app = app.clone();
            let buffer = buffer.clone();
            let mut model = OwwModel::new(OpenWakeWordAlexa, threshold).map_err(|e| format!("Wake-word model failed: {e}"))?;
            let mut resampler = make_resampler(original_sample_rate as _, OWW_MODEL_CHUNK_SIZE as _, channels)
                .map_err(|e| format!("Wake-word resampler failed: {e}"))?;
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    let samples: Vec<f32> = data.iter().map(i16_to_f32).collect();
                    detect_wake_word_chunks(&samples, &buffer, channels, &mut resampler, &mut model, &app);
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let app = app.clone();
            let buffer = buffer.clone();
            let mut model = OwwModel::new(OpenWakeWordAlexa, threshold).map_err(|e| format!("Wake-word model failed: {e}"))?;
            let mut resampler = make_resampler(original_sample_rate as _, OWW_MODEL_CHUNK_SIZE as _, channels)
                .map_err(|e| format!("Wake-word resampler failed: {e}"))?;
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    let samples: Vec<f32> = data.iter().map(|sample| (*sample as f32 - 32768.0) / 32768.0).collect();
                    detect_wake_word_chunks(&samples, &buffer, channels, &mut resampler, &mut model, &app);
                },
                err_fn,
                None,
            )
        }
        other => return Err(format!("Unsupported wake-word mic sample format: {other:?}")),
    }
    .map_err(|e| format!("Could not open wake-word mic stream: {e}"))?;

    stream.play().map_err(|e| format!("Could not start wake-word mic stream: {e}"))?;
    let _ = ready_tx.send(Ok(()));
    let _ = stop_rx.recv();
    drop(stream);
    Ok(())
}

#[cfg(windows)]
fn detect_wake_word_chunks(
    samples: &[f32],
    buffer: &Arc<Mutex<Vec<f32>>>,
    channels: usize,
    resampler: &mut Resamplers,
    model: &mut OwwModel,
    app: &tauri::AppHandle,
) {
    let chunks = resample_into_chunks(samples, buffer, channels, resampler);
    for chunk in chunks {
        let detection = model.detection(chunk.data_f32.first().clone());
        if detection.detected {
            let _ = app.emit("wake-word-detected", detection.probability);
        }
    }
}

#[cfg(windows)]
fn start_native_recording_thread(
    samples: Arc<Mutex<Vec<i16>>>,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::Sender<Result<(u32, u16), String>>,
) {
    let error_tx = ready_tx.clone();
    let result = start_native_recording_stream(samples, stop_rx, ready_tx);
    if let Err(error) = result {
        let _ = error_tx.send(Err(error));
    }
}

#[cfg(windows)]
fn start_native_recording_stream(
    samples: Arc<Mutex<Vec<i16>>>,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::Sender<Result<(u32, u16), String>>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| "No default input microphone found".to_string())?;
    let supported = device.default_input_config().map_err(|e| format!("Could not read mic config: {e}"))?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels();
    let config: cpal::StreamConfig = supported.clone().into();
    if let Ok(mut guard) = samples.lock() {
        guard.reserve(sample_rate as usize * channels as usize * 30);
    }

    let writer = samples.clone();
    let error_fn = |err| eprintln!("native mic stream error: {err}");
    let stream = match supported.sample_format() {
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| push_i16_samples(&writer, data.iter().copied()),
            error_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _| push_i16_samples(&writer, data.iter().map(|sample| (*sample as i32 - 32768) as i16)),
            error_fn,
            None,
        ),
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| push_i16_samples(&writer, data.iter().map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)),
            error_fn,
            None,
        ),
        other => return Err(format!("Unsupported mic sample format: {other:?}")),
    }
    .map_err(|e| format!("Could not open native mic stream: {e}"))?;

    stream.play().map_err(|e| format!("Could not start native mic stream: {e}"))?;
    // Tell the command thread the mic is genuinely open before we block for stop.
    // `cpal::Stream` stays owned by this thread the entire time.
    let _ = ready_tx.send(Ok((sample_rate, channels)));
    let _ = stop_rx.recv();
    drop(stream);
    Ok(())
}

#[cfg(windows)]
fn push_i16_samples<I>(samples: &Arc<Mutex<Vec<i16>>>, input: I)
where
    I: IntoIterator<Item = i16>,
{
    if let Ok(mut guard) = samples.lock() {
        guard.extend(input);
    }
}

#[cfg(windows)]
fn wav_pcm16_bytes(samples: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * channels as u32 * 2;
    out.extend_from_slice(&byte_rate.to_le_bytes());
    let block_align = channels * 2;
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

async fn transcribe_with_elevenlabs(api_key: String, audio_bytes: Vec<u8>) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Missing ElevenLabs API key".into());
    }

    let part = audio_part(audio_bytes)?;

    let form = Form::new()
        .text("model_id", "scribe_v2")
        .text("language_code", "eng")
        .text("tag_audio_events", "false")
        .text("diarize", "false")
        .part("file", part);

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.elevenlabs.io/v1/speech-to-text")
        .header("xi-api-key", api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("ElevenLabs request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("ElevenLabs API error {status}: {body}"));
    }

    let transcription: ElevenLabsTranscription = response
        .json()
        .await
        .map_err(|e| format!("Could not parse ElevenLabs response: {e}"))?;

    let text = transcription.text.trim().to_string();
    if text.is_empty() {
        return Err("ElevenLabs returned an empty transcript".into());
    }

    Ok(text)
}

async fn transcribe_with_sarvam(api_key: String, audio_bytes: Vec<u8>) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Missing Sarvam API key".into());
    }

    let part = audio_part(audio_bytes)?;

    let form = Form::new()
        .text("model", "saaras:v3")
        .text("mode", "transcribe")
        .part("file", part);

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.sarvam.ai/speech-to-text")
        .header("api-subscription-key", api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Sarvam request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Sarvam API error {status}: {body}"));
    }

    let transcription: SarvamTranscription = response
        .json()
        .await
        .map_err(|e| format!("Could not parse Sarvam response: {e}"))?;

    let text = transcription
        .transcript
        .or(transcription.text)
        .unwrap_or_default()
        .trim()
        .to_string();

    if text.is_empty() {
        return Err("Sarvam returned an empty transcript".into());
    }

    Ok(text)
}

async fn transcribe_with_deepgram(api_key: String, audio_bytes: Vec<u8>) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Missing Deepgram API key".into());
    }

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en")
        .header("Authorization", format!("Token {}", api_key.trim()))
        .header("Content-Type", audio_mime(&audio_bytes))
        .body(audio_bytes)
        .send()
        .await
        .map_err(|e| format!("Deepgram request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Deepgram API error {status}: {body}"));
    }

    let dg_response: DeepgramResponse = response
        .json()
        .await
        .map_err(|e| format!("Could not parse Deepgram response: {e}"))?;

    let text = dg_response
        .results
        .channels
        .first()
        .and_then(|ch| ch.alternatives.first())
        .map(|alt| alt.transcript.trim().to_string())
        .unwrap_or_default();

    if text.is_empty() {
        return Err("Deepgram returned an empty transcript".into());
    }

    Ok(text)
}

#[tauri::command]
async fn rewrite_text(api_key: String, text: String, mode: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Missing Groq API key".into());
    }

    let input = text.trim();
    if input.is_empty() {
        return Err("Nothing to rewrite yet".into());
    }

    let instruction = match mode.as_str() {
        "polish" => "Polish this written text. Fix grammar, punctuation, spelling, clarity, and sentence flow while preserving the original voice, tone, and meaning. Do not make it more formal unless needed.",
        "professional" => "Rewrite the text to sound clear, polished, and professional. Preserve the meaning.",
        "shorter" => "Make the text shorter and punchier. Preserve the core meaning.",
        "friendly" => "Rewrite the text to sound warm, friendly, and natural. Preserve the meaning.",
        _ => "Clean up dictation artifacts, punctuation, grammar, and structure. Preserve the speaker's meaning.",
    };

    let body = serde_json::json!({
        "model": "llama-3.3-70b-versatile",
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": "You are a dictation cleanup engine. Return only the rewritten text, with no explanation."
            },
            {
                "role": "user",
                "content": format!("{instruction}\n\nText:\n{input}")
            }
        ]
    });

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Groq rewrite request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Groq rewrite error {status}: {body}"));
    }

    let rewrite: GroqChatResponse = response
        .json()
        .await
        .map_err(|e| format!("Could not parse Groq rewrite response: {e}"))?;

    let text = rewrite
        .choices
        .first()
        .map(|choice| choice.message.content.trim().to_string())
        .unwrap_or_default();

    if text.is_empty() {
        return Err("Groq returned an empty rewrite".into());
    }

    Ok(text)
}





#[tauri::command]
fn install_push_to_talk_hook(app: tauri::AppHandle, shortcut: String, hold_mode: Option<bool>) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = app;
        let _ = shortcut;
        let _ = hold_mode;
        Err("Native push-to-talk hook is only available on Windows".into())
    }

    #[cfg(windows)]
    {
        let shortcut_keys = parse_shortcut_keys(&shortcut)?;
        let hold_mode = hold_mode.unwrap_or(false);
        let state = HOOK_STATE.get_or_init(|| Mutex::new(PushToTalkHookState {
            app: app.clone(),
            shortcut_keys: Vec::new(),
            keys_down: HashSet::new(),
            active: false,
            suppressing: false,
            hold_mode,
        }));

        {
            let mut guard = state.lock().map_err(|_| "Push-to-talk hook state lock failed".to_string())?;
            guard.app = app;
            guard.shortcut_keys = shortcut_keys;
            guard.keys_down.clear();
            guard.active = false;
            guard.suppressing = false;
            guard.hold_mode = hold_mode;
        }

        if !HOOK_STARTED.swap(true, Ordering::SeqCst) {
            let app_for_thread = guard_app_clone(state)?;
            thread::spawn(move || unsafe {
                HOTKEY_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
                let _ = app_for_thread.emit("push-to-talk-debug", "hotkey-thread-started".to_string());
                install_suppressor_hook(&app_for_thread);
                update_hotkey_registration(&app_for_thread);

                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {
                    if message.message == WM_FLOWDESK_UPDATE_HOTKEY {
                        update_hotkey_registration(&app_for_thread);
                    } else if message.message == WM_HOTKEY && message.wParam.0 as i32 == HOTKEY_ID {
                        if let Some(state) = HOOK_STATE.get() {
                            if let Ok(mut guard) = state.lock() {
                                if guard.hold_mode {
                                    continue;
                                }
                                if guard.active {
                                    continue;
                                }
                                guard.active = true;
                                guard.suppressing = true;
                            }
                        }

                        let _ = app_for_thread.emit("push-to-talk-debug", "wm_hotkey_down".to_string());
                        let _ = app_for_thread.emit("push-to-talk-down", ());

                        // Toggle mode deliberately ignores physical key-up.
                        if let Some(state) = HOOK_STATE.get() {
                            if let Ok(mut guard) = state.lock() {
                                guard.active = false;
                                guard.suppressing = false;
                            }
                        }
                    }
                }
            });
        } else {
            let thread_id = HOTKEY_THREAD_ID.load(Ordering::SeqCst);
            if thread_id != 0 {
                unsafe { let _ = PostThreadMessageW(thread_id, WM_FLOWDESK_UPDATE_HOTKEY, WPARAM(0), LPARAM(0)); }
            }
        }

        Ok(())
    }
}

#[cfg(windows)]
fn install_suppressor_hook(app: &tauri::AppHandle) {
    match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(shortcut_suppressor_proc), None, 0) } {
        Ok(_) => { let _ = app.emit("push-to-talk-debug", "suppressor-hook-installed".to_string()); }
        Err(error) => { let _ = app.emit("push-to-talk-debug", format!("suppressor-hook-error: {error}")); }
    }
}

#[cfg(windows)]
unsafe extern "system" fn shortcut_suppressor_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = wparam.0 as u32;
        let key = normalize_hook_key((*(lparam.0 as *const KBDLLHOOKSTRUCT)).vkCode);
        let is_down = event == WM_KEYDOWN || event == WM_SYSKEYDOWN;
        let is_up = event == WM_KEYUP || event == WM_SYSKEYUP;

        if is_down || is_up {
            if let Some(state) = HOOK_STATE.get() {
                let mut emit_down: Option<tauri::AppHandle> = None;
                let mut emit_up: Option<tauri::AppHandle> = None;
                let mut suppress = false;

                if let Ok(mut guard) = state.lock() {
                    let is_shortcut_key = guard.shortcut_keys.contains(&key);

                    if is_down {
                        guard.keys_down.insert(key);
                        if guard.hold_mode && !guard.active && guard.shortcut_keys.iter().all(|shortcut_key| guard.keys_down.contains(shortcut_key)) {
                            guard.active = true;
                            guard.suppressing = true;
                            emit_down = Some(guard.app.clone());
                        }
                    } else if is_up {
                        guard.keys_down.remove(&key);
                        if guard.hold_mode && guard.active && is_shortcut_key {
                            guard.active = false;
                            guard.suppressing = false;
                            emit_up = Some(guard.app.clone());
                        }
                    }

                    suppress = guard.suppressing && is_shortcut_key;
                }

                if let Some(app) = emit_down {
                    let _ = app.emit("push-to-talk-debug", "ll_hook_down".to_string());
                    let _ = app.emit("push-to-talk-down", ());
                }
                if let Some(app) = emit_up {
                    let _ = app.emit("push-to-talk-debug", "ll_hook_up".to_string());
                    let _ = app.emit("push-to-talk-up", ());
                }

                if suppress {
                    return LRESULT(1);
                }
            }
        }
    }

    CallNextHookEx(None::<HHOOK>, code, wparam, lparam)
}

#[cfg(windows)]
fn normalize_hook_key(key: u32) -> u32 {
    match key {
        k if k == VK_LMENU.0 as u32 || k == VK_RMENU.0 as u32 => VK_MENU.0 as u32,
        k if k == VK_LCONTROL.0 as u32 || k == VK_RCONTROL.0 as u32 => VK_CONTROL.0 as u32,
        k if k == VK_LSHIFT.0 as u32 || k == VK_RSHIFT.0 as u32 => VK_SHIFT.0 as u32,
        _ => key,
    }
}

#[cfg(windows)]
fn update_hotkey_registration(app: &tauri::AppHandle) {
    let hold_mode = HOOK_STATE
        .get()
        .and_then(|state| state.lock().ok())
        .map(|guard| guard.hold_mode)
        .unwrap_or(false);

    if hold_mode {
        unsafe { let _ = UnregisterHotKey(None, HOTKEY_ID); }
        let _ = app.emit("push-to-talk-debug", "hotkey-unregistered-for-hold-mode".to_string());
    } else {
        register_current_hotkey(app);
    }
}

#[cfg(windows)]
fn register_current_hotkey(app: &tauri::AppHandle) {
    unsafe { let _ = UnregisterHotKey(None, HOTKEY_ID); }

    let Some((modifiers, key)) = HOOK_STATE
        .get()
        .and_then(|state| state.lock().ok())
        .and_then(|guard| hotkey_modifiers_and_key(&guard.shortcut_keys)) else {
        let _ = app.emit("push-to-talk-debug", "hotkey-register-skipped".to_string());
        return;
    };

    match unsafe { RegisterHotKey(None, HOTKEY_ID, modifiers, key) } {
        Ok(()) => { let _ = app.emit("push-to-talk-debug", format!("hotkey-registered modifiers={modifiers:?} key={key}")); }
        Err(error) => {
            let _ = app.emit("push-to-talk-debug", format!("hotkey-register-error: {error}"));
            HOOK_STARTED.store(false, Ordering::SeqCst);
        }
    }
}

#[cfg(windows)]
fn hotkey_modifiers_and_key(keys: &[u32]) -> Option<(HOT_KEY_MODIFIERS, u32)> {
    let mut modifiers = HOT_KEY_MODIFIERS(0);
    let mut final_key = None;

    for key in keys {
        match *key {
            k if k == VK_CONTROL.0 as u32 => modifiers |= MOD_CONTROL,
            k if k == VK_MENU.0 as u32 => modifiers |= MOD_ALT,
            k if k == VK_SHIFT.0 as u32 => modifiers |= MOD_SHIFT,
            _ => final_key = Some(*key),
        }
    }

    final_key.map(|key| (modifiers, key))
}

#[cfg(windows)]
fn guard_app_clone(state: &Mutex<PushToTalkHookState>) -> Result<tauri::AppHandle, String> {
    state
        .lock()
        .map(|guard| guard.app.clone())
        .map_err(|_| "Push-to-talk hook state lock failed".to_string())
}

#[cfg(windows)]
fn parse_shortcut_keys(shortcut: &str) -> Result<Vec<u32>, String> {
    let keys = shortcut
        .split('+')
        .map(|part| shortcut_part_vk(part.trim()).ok_or_else(|| format!("Unsupported shortcut key: {part}")))
        .collect::<Result<Vec<_>, _>>()?;

    if keys.is_empty() {
        return Err("Shortcut must include a key".into());
    }

    Ok(keys)
}

#[cfg(windows)]
fn shortcut_part_vk(part: &str) -> Option<u32> {
    match part {
        "CommandOrControl" | "Control" | "Ctrl" => Some(VK_CONTROL.0 as u32),
        "Alt" => Some(VK_MENU.0 as u32),
        "Shift" => Some(VK_SHIFT.0 as u32),
        "Space" => Some(VK_SPACE.0 as u32),
        "Enter" | "Return" => Some(VK_RETURN.0 as u32),
        key if key.len() >= 2 && key.starts_with('F') => key[1..]
            .parse::<u32>()
            .ok()
            .filter(|number| (1..=24).contains(number))
            .map(|number| 0x70 + number - 1),
        key if key.len() == 1 => key.chars().next().map(|char| char.to_ascii_uppercase() as u32),
        _ => None,
    }
}


#[tauri::command]
fn is_push_to_talk_pressed() -> bool {
    #[cfg(not(windows))]
    {
        false
    }

    #[cfg(windows)]
    {
        HOOK_STATE
            .get()
            .and_then(|state| state.lock().ok())
            .map(|guard| guard.shortcut_keys.iter().all(|key| is_key_physically_down(*key as i32)))
            .unwrap_or(false)
    }
}

#[cfg(windows)]
fn is_key_physically_down(vk: i32) -> bool {
    unsafe { (windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk) & 0x8000u16 as i16) != 0 }
}

#[tauri::command]
fn pause_background_media() {
    send_media_play_pause();
}

#[tauri::command]
fn resume_background_media() {
    send_media_play_pause();
}

fn send_media_play_pause() {
    #[cfg(windows)]
    unsafe {
        keybd_event(VK_MEDIA_PLAY_PAUSE.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(VK_MEDIA_PLAY_PAUSE.0 as u8, 0, KEYEVENTF_KEYUP, 0);
    }
}

#[tauri::command]
fn start_audio_ducking(target_volume: Option<f32>) -> Result<(), String> {
    duck_system_volume(target_volume)
}

#[tauri::command]
fn restore_audio_ducking() -> Result<(), String> {
    restore_system_volume()
}

fn duck_system_volume(target_volume: Option<f32>) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = target_volume;
        Ok(())
    }

    #[cfg(windows)]
    unsafe {
        let endpoint = default_audio_endpoint()?;
        let current = endpoint.GetMasterVolumeLevelScalar().map_err(|e| format!("Could not read system volume: {e}"))?;
        *ORIGINAL_SYSTEM_VOLUME.lock().map_err(|_| "Volume state lock failed".to_string())? = Some(current);
        let requested = target_volume.unwrap_or(0.35).clamp(0.0, 1.0);
        let ducked = requested.min(current);
        if (current - ducked).abs() > 0.01 {
            fade_system_volume(current, ducked)?;
        }
        Ok(())
    }
}

fn restore_system_volume() -> Result<(), String> {
    #[cfg(not(windows))]
    {
        Ok(())
    }

    #[cfg(windows)]
    unsafe {
        let original = ORIGINAL_SYSTEM_VOLUME
            .lock()
            .map_err(|_| "Volume state lock failed".to_string())?
            .take();
        let Some(original) = original else { return Ok(()); };
        let endpoint = default_audio_endpoint()?;
        let current = endpoint.GetMasterVolumeLevelScalar().map_err(|e| format!("Could not read system volume: {e}"))?;
        fade_system_volume(current, original)?;
        Ok(())
    }
}

#[cfg(windows)]
unsafe fn default_audio_endpoint() -> Result<IAudioEndpointVolume, String> {
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok();
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        .map_err(|e| format!("Could not create audio device enumerator: {e}"))?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| format!("Could not get default audio endpoint: {e}"))?;
    device
        .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
        .map_err(|e| format!("Could not open system volume control: {e}"))
}

#[cfg(windows)]
unsafe fn fade_system_volume(from: f32, to: f32) -> Result<(), String> {
    let endpoint = default_audio_endpoint()?;
    let steps = 10;
    for step in 1..=steps {
        let progress = step as f32 / steps as f32;
        let value = from + ((to - from) * progress);
        endpoint
            .SetMasterVolumeLevelScalar(value.clamp(0.0, 1.0), core::ptr::null())
            .map_err(|e| format!("Could not set system volume: {e}"))?;
        thread::sleep(Duration::from_millis(35));
    }
    CoUninitialize();
    Ok(())
}


#[tauri::command]
fn copy_selected_text() -> Result<String, String> {
    send_ctrl_c();
    thread::sleep(Duration::from_millis(180));
    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
    clipboard
        .get_text()
        .map_err(|e| format!("Could not read selected text from clipboard: {e}"))
}

fn send_ctrl_c() {
    #[cfg(not(windows))]
    {
        return;
    }

    #[cfg(windows)]
    {
    const C_KEY: u8 = 0x43;

    unsafe {
        keybd_event(VK_CONTROL.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(C_KEY, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(C_KEY, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL.0 as u8, 0, KEYEVENTF_KEYUP, 0);
    }
    }
}

#[tauri::command]
fn paste_transcript(text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Nothing to paste".into());
    }

    paste_text(text.trim())
}

fn paste_text(text: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("Could not set clipboard text: {e}"))?;

    // Give Windows a tiny moment to publish the clipboard update, then paste into
    // whichever control currently owns focus. This is the most reliable generic
    // cross-app insertion method without per-application accessibility APIs.
    thread::sleep(Duration::from_millis(250));

    send_ctrl_v();
    Ok(())
}

fn send_ctrl_v() {
    #[cfg(not(windows))]
    {
        return;
    }

    #[cfg(windows)]
    {
    const V_KEY: u8 = 0x56;

    unsafe {
        // Live dictation may paste while the user is still holding the
        // recording chord (for example Alt+V). Clear modifiers first so the
        // paste is Ctrl+V, not Ctrl+Alt+V / menu navigation.
        keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_SHIFT.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        thread::sleep(Duration::from_millis(20));

        keybd_event(VK_CONTROL.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(V_KEY, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(V_KEY, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL.0 as u8, 0, KEYEVENTF_KEYUP, 0);
    }
    }
}

// --------------- File-system transcript persistence ---------------

#[derive(Debug, Serialize, Deserialize)]
struct TranscriptRecord {
    id: String,
    text: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "durationMs")]
    duration_ms: f64,
    #[serde(rename = "wordsPerMinute")]
    words_per_minute: f64,
    rewrite: Option<String>,
    #[serde(rename = "rewriteMode")]
    rewrite_mode: Option<String>,
}

fn transcripts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let dir = base.join("transcripts");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create transcripts dir: {e}"))?;
    Ok(dir)
}

#[tauri::command]
fn save_transcript(app: tauri::AppHandle, record: TranscriptRecord) -> Result<(), String> {
    let dir = transcripts_dir(&app)?;
    let path = dir.join(format!("{}.json", record.id));
    let json = serde_json::to_string_pretty(&record)
        .map_err(|e| format!("JSON serialization error: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write transcript: {e}"))?;
    Ok(())
}

#[tauri::command]
fn load_transcripts(app: tauri::AppHandle) -> Result<Vec<TranscriptRecord>, String> {
    let dir = transcripts_dir(&app)?;
    let mut records: Vec<TranscriptRecord> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read transcripts dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(contents) = fs::read_to_string(&path) {
                if let Ok(rec) = serde_json::from_str::<TranscriptRecord>(&contents) {
                    records.push(rec);
                }
            }
        }
    }
    // newest first
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(records)
}

#[tauri::command]
fn delete_transcript(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = transcripts_dir(&app)?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete transcript: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn get_transcripts_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = transcripts_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

// ------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Show Groq Dictation", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide to Tray", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Groq Dictation");

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "hide" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            })
            .build(app)?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            transcribe_audio,
            transcribe_and_paste,
            rewrite_text,
            paste_transcript,
            copy_selected_text,
            save_transcript,
            load_transcripts,
            delete_transcript,
            get_transcripts_path,
            install_push_to_talk_hook,
            is_push_to_talk_pressed,
            start_wake_word_listener,
            stop_wake_word_listener,
            start_windows_speech_listener,
            stop_windows_speech_listener,
            start_native_recording,
            stop_native_recording,
            start_audio_ducking,
            restore_audio_ducking,
            pause_background_media,
            resume_background_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
