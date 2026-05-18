use arboard::Clipboard;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::{collections::HashSet, sync::{Mutex, OnceLock, atomic::{AtomicBool, Ordering}}};
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
    System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED},
    UI::{
        Input::KeyboardAndMouse::{
            keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_CONTROL, VK_MEDIA_PLAY_PAUSE,
            VK_MENU, VK_RETURN, VK_SHIFT, VK_SPACE,
        },
        WindowsAndMessaging::{
            CallNextHookEx, GetMessageW, SetWindowsHookExW, HHOOK, KBDLLHOOKSTRUCT, MSG,
            WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
        },
    },
};

#[cfg(windows)]
static ORIGINAL_SYSTEM_VOLUME: Mutex<Option<f32>> = Mutex::new(None);
#[cfg(windows)]
static HOOK_STARTED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static HOOK_STATE: OnceLock<Mutex<PushToTalkHookState>> = OnceLock::new();

#[cfg(windows)]
struct PushToTalkHookState {
    app: tauri::AppHandle,
    shortcut_keys: Vec<u32>,
    keys_down: HashSet<u32>,
    active: bool,
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
async fn transcribe_and_paste(
    provider: Option<String>,
    api_key: String,
    audio_bytes: Vec<u8>,
    vocabulary_prompt: Option<String>,
) -> Result<String, String> {
    let provider = provider.unwrap_or_else(|| "groq".into());
    let text = match provider.as_str() {
        "elevenlabs" => transcribe_with_elevenlabs(api_key, audio_bytes).await?,
        "sarvam" => transcribe_with_sarvam(api_key, audio_bytes).await?,
        _ => transcribe_with_groq(api_key, audio_bytes, vocabulary_prompt).await?,
    };

    paste_text(&text)?;
    Ok(text)
}

async fn transcribe_with_groq(
    api_key: String,
    audio_bytes: Vec<u8>,
    vocabulary_prompt: Option<String>,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Missing Groq API key".into());
    }

    let part = Part::bytes(audio_bytes)
        .file_name("dictation.webm")
        .mime_str("audio/webm")
        .map_err(|e| e.to_string())?;

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

async fn transcribe_with_elevenlabs(api_key: String, audio_bytes: Vec<u8>) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Missing ElevenLabs API key".into());
    }

    let part = Part::bytes(audio_bytes)
        .file_name("dictation.webm")
        .mime_str("audio/webm")
        .map_err(|e| e.to_string())?;

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

    let part = Part::bytes(audio_bytes)
        .file_name("dictation.webm")
        .mime_str("audio/webm")
        .map_err(|e| e.to_string())?;

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
fn install_push_to_talk_hook(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = app;
        let _ = shortcut;
        Err("Native push-to-talk hook is only available on Windows".into())
    }

    #[cfg(windows)]
    {
        let shortcut_keys = parse_shortcut_keys(&shortcut)?;
        let state = HOOK_STATE.get_or_init(|| Mutex::new(PushToTalkHookState {
            app: app.clone(),
            shortcut_keys: Vec::new(),
            keys_down: HashSet::new(),
            active: false,
        }));

        {
            let mut guard = state.lock().map_err(|_| "Push-to-talk hook state lock failed".to_string())?;
            guard.app = app;
            guard.shortcut_keys = shortcut_keys;
            guard.keys_down.clear();
            guard.active = false;
        }

        if !HOOK_STARTED.swap(true, Ordering::SeqCst) {
            thread::spawn(|| unsafe {
                match SetWindowsHookExW(WH_KEYBOARD_LL, Some(push_to_talk_keyboard_proc), None, 0) {
                    Ok(_hook) => {
                        let mut message = MSG::default();
                        while GetMessageW(&mut message, None, 0, 0).as_bool() {}
                    }
                    Err(error) => {
                        HOOK_STARTED.store(false, Ordering::SeqCst);
                        eprintln!("Failed to install push-to-talk hook: {error}");
                    }
                }
            });
        }

        Ok(())
    }
}

#[cfg(windows)]
unsafe extern "system" fn push_to_talk_keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = wparam.0 as u32;
        let key = (*(lparam.0 as *const KBDLLHOOKSTRUCT)).vkCode;
        let is_down = event == WM_KEYDOWN || event == WM_SYSKEYDOWN;
        let is_up = event == WM_KEYUP || event == WM_SYSKEYUP;

        if is_down || is_up {
            if let Some(state) = HOOK_STATE.get() {
                if let Ok(mut guard) = state.lock() {
                    if is_down {
                        guard.keys_down.insert(key);
                        if !guard.active && guard.shortcut_keys.iter().all(|part| guard.keys_down.contains(part)) {
                            guard.active = true;
                            let _ = guard.app.emit("push-to-talk-down", ());
                        }
                    } else {
                        guard.keys_down.remove(&key);
                        if guard.active && guard.shortcut_keys.contains(&key) {
                            guard.active = false;
                            let _ = guard.app.emit("push-to-talk-up", ());
                        }
                    }
                }
            }
        }
    }

    CallNextHookEx(None::<HHOOK>, code, wparam, lparam)
}

#[cfg(windows)]
fn parse_shortcut_keys(shortcut: &str) -> Result<Vec<u32>, String> {
    let keys = shortcut
        .split('+')
        .map(|part| shortcut_part_vk(part.trim()).ok_or_else(|| format!("Unsupported shortcut key: {part}")))
        .collect::<Result<Vec<_>, _>>()?;

    if keys.len() < 2 {
        return Err("Shortcut must include at least one modifier and one key".into());
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
fn start_audio_ducking() -> Result<(), String> {
    duck_system_volume()
}

#[tauri::command]
fn restore_audio_ducking() -> Result<(), String> {
    restore_system_volume()
}

fn duck_system_volume() -> Result<(), String> {
    #[cfg(not(windows))]
    {
        Ok(())
    }

    #[cfg(windows)]
    unsafe {
        let endpoint = default_audio_endpoint()?;
        let current = endpoint.GetMasterVolumeLevelScalar().map_err(|e| format!("Could not read system volume: {e}"))?;
        *ORIGINAL_SYSTEM_VOLUME.lock().map_err(|_| "Volume state lock failed".to_string())? = Some(current);
        // Keep ducking gentle: if volume is already low, do not push it
        // toward mute. Otherwise reduce by roughly 20 percentage points,
        // capped at 70% of current volume for a natural background dip.
        let ducked = if current <= 0.25 {
            current
        } else {
            (current - 0.20).max(current * 0.70).max(0.25)
        };
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
    CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok();
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
            start_audio_ducking,
            restore_audio_ducking,
            pause_background_media,
            resume_background_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
