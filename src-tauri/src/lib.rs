use arboard::Clipboard;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use std::{thread, time::Duration};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_CONTROL,
};

#[derive(Debug, Deserialize)]
struct GroqTranscription {
    text: String,
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
async fn transcribe_and_paste(api_key: String, audio_bytes: Vec<u8>) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Missing Groq API key".into());
    }

    let part = Part::bytes(audio_bytes)
        .file_name("dictation.webm")
        .mime_str("audio/webm")
        .map_err(|e| e.to_string())?;

    let form = Form::new()
        .text("model", "whisper-large-v3-turbo")
        .text("language", "en")
        .text("response_format", "json")
        .part("file", part);

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

    paste_text(&text)?;
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
            paste_transcript
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
