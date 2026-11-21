#![recursion_limit = "512"]

mod anthropic_proxy;
mod claude;
mod claude_process;
mod history;
mod latex;
mod skills;
mod slash_commands;
mod uv;
mod zotero;

use std::path::Path;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

/// Entry point for the `--tectonic-compile` subprocess mode.
/// Runs tectonic compilation in an isolated process so that C-level global state
/// (font cache, etc.) is cleaned up on exit, preventing assertion failures on retry.
pub fn tectonic_compile_subprocess(work_dir: &Path, main_file: &str) -> Result<(), String> {
    latex::compile_with_tectonic(work_dir, main_file)
}

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
    EditorDef {
        id: "cursor",
        name: "Cursor",
        cli: "cursor",
    },
    EditorDef {
        id: "vscode",
        name: "VS Code",
        cli: "code",
    },
    EditorDef {
        id: "zed",
        name: "Zed",
        cli: "zed",
    },
    EditorDef {
        id: "sublime",
        name: "Sublime Text",
        cli: "subl",
    },
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
        .map(|e| EditorInfo {
            id: e.id.to_string(),
            name: e.name.to_string(),
        })
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

    // On macOS, GUI apps don't inherit the shell's PATH, so CLI tools like
    // "code", "cursor", etc. won't be found. Use the login shell to resolve them.
    let cli_path = resolve_editor_cli(editor.cli)?;

    let mut cmd = std::process::Command::new(&cli_path);

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

    cmd.spawn()
        .map_err(|e| format!("Failed to open {}: {}", editor.name, e))?;
    Ok(())
}

/// Resolve an editor CLI command to its full path.
/// On macOS, GUI apps lack the user's shell PATH, so we ask the login shell.
fn resolve_editor_cli(cli: &str) -> Result<String, String> {
    // First try the inherited PATH (works when launched from terminal)
    if let Ok(path) = which::which(cli) {
        return Ok(path.to_string_lossy().into_owned());
    }

    // On macOS, ask the login shell for the full PATH
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/bin/zsh")
            .args(["-l", "-c", &format!("which {}", cli)])
            .output()
            .map_err(|e| format!("Failed to resolve {}: {}", cli, e))?;
        if output.status.success() {
            let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !resolved.is_empty() && Path::new(&resolved).exists() {
                return Ok(resolved);
            }
        }
    }

    // Fallback: return bare name and hope for the best
    Ok(cli.to_string())
}

#[cfg(target_os = "macos")]
fn set_macos_app_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let icon_bytes = include_bytes!("../icons/icon.png");

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
    let label = format!(
        "window-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("ClaudePrism")
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .zoom_hotkeys_enabled(true)
        .visible(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(12.0, 12.0));
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create window: {}", e))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn apply_windows_titlebar_theme(window: &tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    use std::ffi::c_void;

    #[link(name = "dwmapi")]
    extern "system" {
        #[link_name = "DwmSetWindowAttribute"]
        fn dwm_set_window_attribute(
            hwnd: isize,
            dwattribute: u32,
            pvattribute: *const c_void,
            cbattribute: u32,
        ) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        #[link_name = "SetWindowPos"]
        fn set_window_pos(
            hwnd: isize,
            hwnd_insert_after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to resolve native window handle: {}", e))?;
    let hwnd = hwnd.0 as isize;
    let dark_value: i32 = if dark { 1 } else { 0 };
    let attr_size = std::mem::size_of_val(&dark_value) as u32;

    let mut result = unsafe {
        dwm_set_window_attribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &dark_value as *const _ as *const _,
            attr_size,
        )
    };
    if result < 0 {
        // Older Windows 10 builds used attribute 19 before Microsoft documented 20.
        result = unsafe {
            dwm_set_window_attribute(hwnd, 19, &dark_value as *const _ as *const _, attr_size)
        };
    }

    // Windows 11 honors explicit caption/text colors more reliably than the
    // immersive flag alone, especially after runtime theme switches.
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;
    let caption_color: u32 = if dark { 0x0010_1010 } else { 0x00F9_F9F9 };
    let text_color: u32 = if dark { 0x00FF_FFFF } else { 0x0000_0000 };
    unsafe {
        let _ = dwm_set_window_attribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            &caption_color as *const _ as *const _,
            std::mem::size_of_val(&caption_color) as u32,
        );
        let _ = dwm_set_window_attribute(
            hwnd,
            DWMWA_TEXT_COLOR,
            &text_color as *const _ as *const _,
            std::mem::size_of_val(&text_color) as u32,
        );
        let _ = set_window_pos(
            hwnd,
            0,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }

    if result < 0 {
        return Err(format!(
            "Failed to update Windows title bar theme: HRESULT 0x{:08X}",
            result as u32
        ));
    }

    Ok(())
}

#[tauri::command]
fn set_native_window_theme(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    let theme = theme.trim().to_ascii_lowercase();
    let dark = theme == "dark";
    let tauri_theme = if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    };

    window
        .set_theme(Some(tauri_theme))
        .map_err(|e| format!("Failed to set window theme: {}", e))?;

    #[cfg(target_os = "windows")]
    apply_windows_titlebar_theme(&window, dark)?;

    Ok(())
}

#[tauri::command]
fn allow_project_directory(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    let fs_scope = app.fs_scope();
    fs_scope
        .allow_directory(&root_path, true)
        .map_err(|e| format!("Failed to allow project directory: {}", e))?;

    let asset_scope = app.state::<tauri::scope::Scopes>();
    asset_scope
        .allow_directory(&root_path, true)
        .map_err(|e| format!("Failed to allow project assets: {}", e))?;

    Ok(())
}

#[derive(serde::Serialize)]
struct ProjectCandidate {
    path: String,
    name: String,
    last_modified: u64,
    has_main_tex: bool,
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn has_tex_file(dir: &Path) -> bool {
    if dir.join("main.tex").is_file() || dir.join("document.tex").is_file() {
        return true;
    }

    std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .any(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return false;
            }
            matches!(
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.to_ascii_lowercase())
                    .as_deref(),
                Some("tex" | "ltx")
            )
        })
}

fn project_modified_ms(dir: &Path) -> u64 {
    let mut latest = modified_ms(dir);
    for relative in [
        "main.tex",
        "document.tex",
        ".prism/build/main.pdf",
        ".claudeprism/history.git/.git/refs/heads/master",
    ] {
        latest = latest.max(modified_ms(&dir.join(relative)));
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                latest = latest.max(modified_ms(&path));
            }
        }
    }

    latest
}

#[tauri::command]
fn list_default_projects() -> Result<Vec<ProjectCandidate>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };

    let base = home.join("Documents").join("ClaudePrism");
    if !base.is_dir() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let entries = std::fs::read_dir(&base)
        .map_err(|e| format!("Failed to read default project directory: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !has_tex_file(&path) {
            continue;
        }

        projects.push(ProjectCandidate {
            path: path.to_string_lossy().to_string(),
            name,
            last_modified: project_modified_ms(&path),
            has_main_tex: path.join("main.tex").is_file() || path.join("document.tex").is_file(),
        });
    }

    projects.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(projects)
}

// --- Debug logging from JS (survives white-screen crashes) ---

#[tauri::command]
fn js_log(msg: String) {
    eprintln!("[js] {}", msg);
}

// --- Debug window ---

#[tauri::command]
fn open_debug_window(app: tauri::AppHandle) -> Result<(), String> {
    // If a debug window already exists, just focus it
    if let Some(win) = app.get_webview_window("debug") {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = WebviewUrl::App("index.html?debug=1".into());
    WebviewWindowBuilder::new(&app, "debug", url)
        .title("ClaudePrism — Debug")
        .inner_size(560.0, 700.0)
        .min_inner_size(400.0, 400.0)
        .zoom_hotkeys_enabled(true)
        .visible(true)
        .build()
        .map_err(|e| format!("Failed to create debug window: {}", e))?;

    Ok(())
}

// --- System info for debug panel & bug reports ---

#[derive(serde::Serialize)]
struct SystemInfo {
    os: String,
    os_version: String,
    arch: String,
    app_version: String,
}

#[tauri::command]
fn get_system_info(app: tauri::AppHandle) -> SystemInfo {
    // Get OS version from uname on unix, or fallback to "unknown"
    let os_version = {
        #[cfg(unix)]
        {
            std::process::Command::new("uname")
                .arg("-r")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| "unknown".to_string())
        }
        #[cfg(not(unix))]
        {
            "unknown".to_string()
        }
    };

    SystemInfo {
        os: std::env::consts::OS.to_string(),
        os_version,
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
    }
}

// --- Clipboard file paths (for Cmd+V paste in file tree) ---

#[tauri::command]
async fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(|| {
            let script = concat!(
                "set thePaths to \"\"\n",
                "try\n",
                "\tset theFiles to the clipboard as \u{00ab}class furl\u{00bb}\n",
                "\tset thePaths to POSIX path of theFiles\n",
                "on error\n",
                "\ttry\n",
                "\t\trepeat with f in (the clipboard as list)\n",
                "\t\t\ttry\n",
                "\t\t\t\tset thePaths to thePaths & POSIX path of (f as \u{00ab}class furl\u{00bb}) & linefeed\n",
                "\t\t\tend try\n",
                "\t\tend repeat\n",
                "\tend try\n",
                "end try\n",
                "return thePaths",
            );

            let output = std::process::Command::new("osascript")
                .arg("-e")
                .arg(script)
                .output()
                .map_err(|e| e.to_string())?;

            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                Ok(vec![])
            } else {
                Ok(stdout.lines().filter(|l| !l.is_empty()).map(|s| s.to_string()).collect())
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(vec![])
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env file (walks up from cwd to find it)
    let _ = dotenvy::dotenv();

    #[allow(clippy::expect_used)]
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(claude::ClaudeProcessState::default())
        .manage(latex::LatexCompilerState::default())
        .manage(zotero::ZoteroOAuthState::default())
        .setup(|app| {
            // Safety net: force-show the main window after a timeout if the
            // frontend JS never calls `getCurrentWindow().show()`.
            // This prevents the window from staying permanently hidden when
            // WKWebView fails to execute JS (e.g. WebKit top-level-await bug
            // on macOS 12). See https://bugs.webkit.org/show_bug.cgi?id=242740
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        eprintln!("[safety] Main window still hidden after 8s, force-showing");
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_new_window,
            set_native_window_theme,
            allow_project_directory,
            list_default_projects,
            detect_editors,
            open_in_editor,
            js_log,
            read_clipboard_file_paths,
            latex::compile_latex,
            latex::synctex_edit,
            latex::detect_texlive,
            claude::check_claude_status,
            claude::install_claude_cli,
            claude::update_claude_cli,
            claude::login_claude,
            claude::save_anthropic_api_key,
            claude::verify_openai_compatible_api_key,
            claude::list_openai_compatible_models,
            claude::list_openai_compatible_credential_models,
            claude::list_claude_models,
            claude::clear_anthropic_api_key,
            claude::list_openai_compatible_credentials,
            claude::delete_openai_compatible_credential,
            claude::set_active_openai_compatible_credential,
            claude::execute_claude_code,
            claude::continue_claude_code,
            claude::resume_claude_code,
            claude::cancel_claude_execution,
            claude::interrupt_claude_execution,
            claude::run_shell_command,
            claude::migrate_project_sessions,
            claude::get_claude_fast_mode,
            claude::set_claude_fast_mode,
            claude::list_claude_sessions,
            claude::generate_claude_session_title,
            claude::load_session_history,
            claude::delete_claude_session,
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
            skills::install_scientific_skills,
            skills::install_scientific_skills_global,
            skills::import_skill_from_folder,
            skills::check_skills_installed,
            skills::list_installed_skills,
            skills::delete_installed_skill,
            skills::uninstall_scientific_skills,
            skills::get_skill_categories,
            skills::get_skill_content,
            uv::check_uv_status,
            uv::install_uv,
            uv::setup_project_venv,
            uv::uv_add_packages,
            uv::uv_run_command,
            get_system_info,
            open_debug_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            // Set the dock icon after the app is fully initialized.
            // Doing this in setup() causes SIGBUS on first launch from signed
            // binaries due to Gatekeeper App Translocation (#38).
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Ready => {
                set_macos_app_icon();
            }
            // Workaround: WKWebView sometimes fails to repaint after the app
            // returns from background, leaving a black screen.  We apply two
            // complementary fixes on focus-restore:
            //   1. Nudge the window size by 1 px and back (forces native
            //      compositing layer to re-composite).
            //   2. Trigger a DOM reflow via JS (forces WKWebView render tree
            //      rebuild without losing app state).
            // Either one alone may not cover all cases.
            // See https://github.com/tauri-apps/tauri/issues/5226
            //     https://github.com/tauri-apps/tauri/issues/14843
            tauri::RunEvent::WindowEvent {
                ref label,
                event: tauri::WindowEvent::Focused(true),
                ..
            } => {
                if let Some(window) = app_handle.get_webview_window(label) {
                    // macOS: nudge window size to fix black screen after wake/focus
                    // See https://github.com/tauri-apps/tauri/issues/5226
                    #[cfg(target_os = "macos")]
                    {
                        if let Ok(size) = window.inner_size() {
                            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                                width: size.width + 1,
                                height: size.height,
                            }));
                            let _ = window.set_size(tauri::Size::Physical(size));
                        }
                        let _ = window.eval(
                            "document.body.style.display='none';\
                             document.body.offsetHeight;\
                             document.body.style.display='';",
                        );
                    }
                    let _ = window.emit("window-focus-restored", ());
                }
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
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
