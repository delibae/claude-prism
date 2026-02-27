mod claude;
mod history;
mod latex;
mod slash_commands;
mod zotero;

use std::path::Path;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// --- External editor detection & opening ---

#[derive(serde::Serialize, Clone)]
struct EditorInfo {
    id: String,
    name: String,
}

struct EditorDef {
    id: &'static str,
    name: &'static str,
    cli: &'static str,
}

const KNOWN_EDITORS: &[EditorDef] = &[
    EditorDef { id: "cursor", name: "Cursor", cli: "cursor" },
    EditorDef { id: "vscode", name: "VS Code", cli: "code" },
    EditorDef { id: "zed", name: "Zed", cli: "zed" },
    EditorDef { id: "sublime", name: "Sublime Text", cli: "subl" },
];

#[cfg(target_os = "macos")]
const MACOS_APP_PATHS: &[(&str, &str)] = &[
    ("cursor", "/Applications/Cursor.app"),
    ("vscode", "/Applications/Visual Studio Code.app"),
    ("zed", "/Applications/Zed.app"),
    ("sublime", "/Applications/Sublime Text.app"),
];

#[tauri::command]
fn detect_editors() -> Vec<EditorInfo> {
    KNOWN_EDITORS
        .iter()
        .filter(|e| is_editor_installed(e))
        .map(|e| EditorInfo { id: e.id.to_string(), name: e.name.to_string() })
        .collect()
}

fn is_editor_installed(editor: &EditorDef) -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Some((_, app_path)) = MACOS_APP_PATHS.iter().find(|(id, _)| *id == editor.id) {
            return Path::new(app_path).exists();
        }
    }
    // Fallback / Windows / Linux: check if CLI is on PATH
    which::which(editor.cli).is_ok()
}

#[tauri::command]
fn open_in_editor(
    editor_id: String,
    project_path: String,
    file_path: Option<String>,
    line: Option<u32>,
) -> Result<(), String> {
    let editor = KNOWN_EDITORS
        .iter()
        .find(|e| e.id == editor_id)
        .ok_or_else(|| format!("Unknown editor: {}", editor_id))?;

    let mut cmd = std::process::Command::new(editor.cli);

    // Open the project folder
    cmd.arg(&project_path);

    // If a specific file is given, open it (with optional line number via -g)
    if let Some(ref fp) = file_path {
        let full_path = Path::new(&project_path).join(fp);
        if let Some(ln) = line {
            cmd.arg("-g");
            cmd.arg(format!("{}:{}", full_path.display(), ln));
        } else {
            cmd.arg(full_path);
        }
    }

    cmd.spawn().map_err(|e| format!("Failed to open {}: {}", editor.name, e))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_macos_app_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_foundation::NSData;
    use objc2_app_kit::{NSApplication, NSImage};

    let icon_bytes = include_bytes!("../icons/icon.png");

    // We're in the setup callback which runs on the main thread
    if let Some(mtm) = MainThreadMarker::new() {
        unsafe {
            let data = NSData::with_bytes(icon_bytes);
            if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
                let app = NSApplication::sharedApplication(mtm);
                app.setApplicationIconImage(Some(&image));
            }
        }
    }
}

#[tauri::command]
fn create_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("window-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("ClaudePrism")
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .visible(false)
        .hidden_title(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(12.0, 12.0));
    }

    builder.build().map_err(|e| format!("Failed to create window: {}", e))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env file (walks up from cwd to find it)
    let _ = dotenvy::dotenv();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(claude::ClaudeProcessState::default())
        .manage(latex::LatexCompilerState::default())
        .manage(zotero::ZoteroOAuthState::default())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            set_macos_app_icon();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_new_window,
            detect_editors,
            open_in_editor,
            latex::compile_latex,
            latex::synctex_edit,
            claude::check_claude_status,
            claude::install_claude_cli,
            claude::login_claude,
            claude::execute_claude_code,
            claude::continue_claude_code,
            claude::resume_claude_code,
            claude::cancel_claude_execution,
            claude::run_shell_command,
            claude::get_claude_fast_mode,
            claude::set_claude_fast_mode,
            claude::list_claude_sessions,
            claude::load_session_history,
            zotero::zotero_start_oauth,
            zotero::zotero_complete_oauth,
            zotero::zotero_cancel_oauth,
            history::history_init,
            history::history_snapshot,
            history::history_list,
            history::history_diff,
            history::history_file_at,
            history::history_restore,
            history::history_add_label,
            history::history_remove_label,
            slash_commands::slash_commands_list,
            slash_commands::slash_command_get,
            slash_commands::slash_command_save,
            slash_commands::slash_command_delete,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
                // Kill Claude process associated with this window
                let claude_state = app_handle.state::<claude::ClaudeProcessState>();
                let label_clone = label.clone();
                let state_clone = claude_state.inner().clone();
                tauri::async_runtime::spawn(async move {
                    claude::kill_process_for_window(&state_clone, &label_clone).await;
                });

                // Quit the app when the last window is closed
                if app_handle.webview_windows().is_empty() {
                    app_handle.exit(0);
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                // Clean up LaTeX build temp directories
                let latex_state = app_handle.state::<latex::LatexCompilerState>();
                let state_clone = latex_state.inner().clone();
                tauri::async_runtime::spawn(async move {
                    latex::cleanup_all_builds(&state_clone).await;
                });
            }
            _ => {}
        }
    });
}
