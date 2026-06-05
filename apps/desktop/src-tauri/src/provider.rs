use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

// ─── ProviderEvent ────────────────────────────────────────────────────────────

/// Normalised output from any AI CLI process.
pub enum ProviderEvent {
    /// Carries the session_id extracted from provider output.
    SessionInit(String),
    /// A line to emit to the frontend verbatim.
    Line(String),
    /// Drop this line silently.
    Skip,
}

// ─── AiProvider trait ─────────────────────────────────────────────────────────

/// Contract that every AI CLI provider must implement.
pub trait AiProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn find_binary(&self) -> Result<String, String>;
    fn build_args(
        &self,
        prompt: &str,
        model: &str,
        session_id: Option<&str>,
        system_prompt: &str,
    ) -> (Vec<String>, Option<String>); // (args, stdin_payload)
    fn parse_output_line(&self, line: &str) -> ProviderEvent;
    fn setup_env(&self, _cmd: &mut tokio::process::Command, _effort_level: Option<&str>) {}
    fn supports_sessions(&self) -> bool {
        true
    }
}

// ─── AiProcessState ───────────────────────────────────────────────────────────

/// Provider-agnostic process registry (replaces `ClaudeProcessState`).
#[derive(Clone)]
pub struct AiProcessState {
    pub processes: Arc<Mutex<HashMap<String, Child>>>,
}

impl Default for AiProcessState {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ─── Event payloads ───────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct AiOutputEvent {
    pub tab_id: String,
    pub data: String,
}

#[derive(Clone, serde::Serialize)]
pub struct AiCompleteEvent {
    pub tab_id: String,
    pub success: bool,
}

#[derive(Clone, serde::Serialize)]
pub struct AiErrorEvent {
    pub tab_id: String,
    pub data: String,
}

// ─── Environment helpers ──────────────────────────────────────────────────────

/// Check if an environment variable should be explicitly passed to child processes.
///
/// NOTE: This is NOT a true whitelist — we do NOT call `env_clear()`, so the
/// child inherits the full parent environment.  This helper only identifies vars
/// that we *explicitly* re-set via `cmd.env()` to guarantee they are present
/// even when other per-key overrides are applied (e.g. prepending to PATH).
/// Uses case-insensitive comparison for Windows compatibility.
pub(crate) fn is_essential_env_var(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    // Cross-platform
    matches!(
        k.as_str(),
        "HOME" | "USER" | "SHELL" | "LANG"
        | "HOMEBREW_PREFIX" | "HOMEBREW_CELLAR"
        | "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY" | "ALL_PROXY"
    ) || k.starts_with("LC_")
    // Windows-specific
    || matches!(
        k.as_str(),
        "USERPROFILE" | "APPDATA" | "LOCALAPPDATA"
        | "TEMP" | "TMP"
        | "SYSTEMROOT" | "SYSTEMDRIVE"
        | "COMPUTERNAME" | "USERNAME"
        | "PROGRAMFILES" | "PROGRAMFILES(X86)" | "COMMONPROGRAMFILES"
        | "PATHEXT" | "PSMODULEPATH" | "WINDIR"
    )
}

/// Windows CREATE_NO_WINDOW flag to prevent console windows from flashing
/// when spawning child processes (e.g. AI CLI, cmd.exe, node.exe).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Strip interior nul bytes that would cause Command::spawn() to fail.
/// This can happen when prompts contain clipboard artifacts or encoding issues.
/// Returns a borrowed reference when no nul bytes are present (zero-alloc fast path).
fn strip_nul(s: &str) -> Cow<'_, str> {
    if s.contains('\0') {
        eprintln!(
            "[ai-spawn] stripped {} nul byte(s) from input",
            s.matches('\0').count()
        );
        Cow::Owned(s.replace('\0', ""))
    } else {
        Cow::Borrowed(s)
    }
}

/// Environment variables needed by child processes on Linux desktops.
/// These are required for xdg-open, D-Bus, and display server communication.
#[cfg(target_os = "linux")]
const LINUX_DESKTOP_ENV_VARS: &[&str] = &[
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
    "DESKTOP_SESSION",
];

/// Sanitize environment for a child process spawned from an AppImage.
///
/// AppImages modify LD_LIBRARY_PATH, PATH, and other variables to point to
/// bundled libraries. Child processes that need to use host system binaries
/// (e.g. xdg-open for browser launch, curl for downloads) will break if they
/// inherit these modified variables. AppImage stores the originals with an
/// `_ORIG` suffix (e.g. `LD_LIBRARY_PATH_ORIG`).
///
/// This function:
/// 1. Closes stdin to prevent interactive prompts from blocking
/// 2. Restores original environment variables when running inside an AppImage
/// 3. Passes through Linux desktop environment variables (DISPLAY, XDG_*, etc.)
#[cfg(target_os = "linux")]
fn sanitize_appimage_env(cmd: &mut tokio::process::Command) {
    cmd.stdin(std::process::Stdio::null());

    if std::env::var("APPIMAGE").is_ok() {
        // Restore original environment variables that AppImage overrides
        for key in &[
            "LD_LIBRARY_PATH",
            "PATH",
            "GDK_PIXBUF_MODULE_FILE",
            "PYTHONPATH",
            "PERLLIB",
            "GSETTINGS_SCHEMA_DIR",
        ] {
            let orig_key = format!("{}_ORIG", key);
            match std::env::var(&orig_key) {
                Ok(orig) => {
                    cmd.env(key, orig);
                }
                Err(_) => {
                    cmd.env_remove(key);
                }
            }
        }
        // Remove AppImage-specific variables that poison child processes
        cmd.env_remove("GDK_BACKEND");
        cmd.env_remove("GIO_MODULE_DIR");
        cmd.env_remove("GIO_EXTRA_MODULES");
    }

    // Pass through Linux desktop environment variables
    for key in LINUX_DESKTOP_ENV_VARS {
        if let Ok(value) = std::env::var(key) {
            cmd.env(key, value);
        }
    }
}

/// On Windows, resolve a `.cmd` wrapper to its underlying Node.js script
/// so we can run `node <script.js>` directly, avoiding cmd.exe escaping issues.
/// Returns (program, extra_prefix_args).
#[cfg(target_os = "windows")]
fn resolve_cmd_to_node(program: &str) -> (String, Vec<String>) {
    let lower = program.to_lowercase();
    if !lower.ends_with(".cmd") && !lower.ends_with(".bat") {
        return (program.to_string(), vec![]);
    }

    // Try to find the JS entry point next to the .cmd file
    // npm .cmd wrappers invoke: node "<dir>\node_modules\<pkg>\cli.js" %*
    let cmd_dir = std::path::Path::new(program)
        .parent()
        .unwrap_or(std::path::Path::new("."));
    let cli_js = cmd_dir
        .join("node_modules")
        .join("@anthropic-ai")
        .join("claude-code")
        .join("cli.js");
    if cli_js.exists() {
        // Find node.exe — prefer one next to the .cmd, then fall back to PATH
        let node = {
            let local_node = cmd_dir.join("node.exe");
            if local_node.exists() {
                local_node.to_string_lossy().to_string()
            } else {
                "node".to_string()
            }
        };
        return (node, vec![cli_js.to_string_lossy().to_string()]);
    }
    // Fallback: use cmd.exe /C (may have issues with special chars in args)
    (
        "cmd.exe".to_string(),
        vec!["/C".to_string(), program.to_string()],
    )
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_extra_tool_dirs(home: &std::path::Path, pnpm_home: Option<std::ffi::OsString>) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".local").join("bin"),
        home.join(".cargo").join("bin"),
        home.join(".bun").join("bin"),
        home.join("Library").join("pnpm"),
        home.join("Library").join("pnpm").join("global").join("bin"),
        home.join(".local").join("share").join("pnpm"),
        home.join(".local").join("share").join("pnpm").join("global").join("bin"),
        home.join(".pnpm"),
        home.join(".pnpm").join("global").join("bin"),
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(),
    ];
    if let Some(pnpm_home) = pnpm_home.filter(|value| !value.is_empty()) {
        dirs.insert(0, PathBuf::from(pnpm_home));
    }
    dirs
}

/// On Windows, locate git-bash.exe which is required by the Claude Code CLI.
/// Checks user override → common install paths → git on PATH → bash on PATH.
#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<String> {
    // 1. User-specified override (only if the path actually exists)
    if let Ok(p) = std::env::var("CLAUDE_CODE_GIT_BASH_PATH") {
        if PathBuf::from(&p).is_file() {
            return Some(p);
        }
    }

    // 2. Common install locations
    let candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    for path in &candidates {
        if PathBuf::from(path).is_file() {
            return Some(path.to_string());
        }
    }

    // 3. git on PATH → derive bash.exe location
    if let Ok(git_path) = which::which("git") {
        // git.exe is typically at Git/cmd/git.exe → bash.exe at Git/bin/bash.exe
        if let Some(cmd_dir) = git_path.parent() {
            if let Some(git_root) = cmd_dir.parent() {
                let bash = git_root.join("bin").join("bash.exe");
                if bash.is_file() {
                    return Some(bash.to_string_lossy().to_string());
                }
            }
        }
    }

    // 4. bash directly on PATH
    if let Ok(bash_path) = which::which("bash") {
        return Some(bash_path.to_string_lossy().to_string());
    }

    None
}

/// Create a tokio Command with appropriate environment variables.
/// The caller is responsible for setting provider-specific env vars via
/// `provider.setup_env()` after this function returns.
pub fn create_command(
    program: &str,
    args: Vec<String>,
    cwd: &str,
) -> Command {
    let clean_program = strip_nul(program);
    let clean_args: Vec<Cow<str>> = args.iter().map(|a| strip_nul(a)).collect();
    let clean_cwd = strip_nul(cwd);

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let (resolved, prefix) = resolve_cmd_to_node(clean_program.as_ref());
        let mut c = Command::new(&resolved);
        c.creation_flags(CREATE_NO_WINDOW);
        if !prefix.is_empty() {
            c.args(&prefix);
        }
        c.args(clean_args.iter().map(|a| a.as_ref()));
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(clean_program.as_ref());
        c.args(clean_args.iter().map(|a| a.as_ref()));
        c
    };
    cmd.current_dir(clean_cwd.as_ref());

    // Pipe stdout and stderr for streaming
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // On Linux AppImage, restore original environment so child processes work correctly
    #[cfg(target_os = "linux")]
    sanitize_appimage_env(&mut cmd);

    // Remove all Claude Code internal env vars to prevent nested session detection
    // and other interference. Tauri inherits these when launched from a Claude Code session.
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_AGENT_SDK_VERSION");
    for (key, _) in std::env::vars() {
        // Keep CLAUDE_CODE_GIT_BASH_PATH — Claude Code needs it on Windows to locate git-bash
        if key == "CLAUDE_CODE_GIT_BASH_PATH" {
            continue;
        }
        if key.starts_with("CLAUDE_CODE_") || key.starts_with("CLAUDE_AGENT_") {
            cmd.env_remove(&key);
        }
    }

    // On Windows, ensure CLAUDE_CODE_GIT_BASH_PATH is set.
    // Claude Code requires git-bash to run on Windows.
    // Uses find_git_bash() which also validates user-specified paths.
    #[cfg(target_os = "windows")]
    {
        if let Some(bash_path) = find_git_bash() {
            cmd.env("CLAUDE_CODE_GIT_BASH_PATH", bash_path);
        }
    }

    // Build PATH: start with current PATH, prepend program dir and venv bin
    // Strip nul bytes from inherited PATH to prevent spawn failures
    let mut current_path = strip_nul(&std::env::var("PATH").unwrap_or_default()).into_owned();
    #[cfg(target_os = "windows")]
    let sep = ";";
    #[cfg(not(target_os = "windows"))]
    let sep = ":";

    // Add the program's parent directory to PATH if not already present
    if let Some(program_dir) = std::path::Path::new(program).parent() {
        let program_dir_str = program_dir.to_string_lossy();
        if !current_path.contains(program_dir_str.as_ref()) {
            current_path = format!("{}{}{}", program_dir_str, sep, current_path);
        }
    }

    // GUI apps (launched from Dock/Spotlight/Finder) inherit a minimal PATH
    // that lacks directories like /opt/homebrew/bin or ~/.local/bin.
    // MCP servers and other child processes that rely on tools installed there
    // (e.g. `uv`, `node`, `python`) would fail to start.
    // Prepend common tool directories so child processes can find them.
    // This mirrors the approach used by find_claude_binary() and extends it
    // to all child processes.  Fixes #87 and #90.
    #[cfg(not(target_os = "windows"))]
    if let Some(home) = dirs::home_dir() {
        let extra_dirs = unix_extra_tool_dirs(&home, std::env::var_os("PNPM_HOME"));
        // Also check NVM: if NVM_BIN is set, use it; otherwise scan ~/.nvm
        if let Ok(nvm_bin) = std::env::var("NVM_BIN") {
            let nvm_bin_path = std::path::PathBuf::from(&nvm_bin);
            if nvm_bin_path.exists() && !current_path.contains(&nvm_bin) {
                current_path = format!("{}{}{}", nvm_bin, sep, current_path);
            }
        } else {
            let nvm_dir = home.join(".nvm").join("versions").join("node");
            if nvm_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                    let mut candidates: Vec<std::path::PathBuf> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.path().join("bin"))
                        .filter(|p| p.exists())
                        .collect();
                    candidates.sort();
                    candidates.reverse(); // prefer latest version
                    if let Some(nvm_bin_path) = candidates.first() {
                        let nvm_bin_str = nvm_bin_path.to_string_lossy();
                        if !current_path.contains(nvm_bin_str.as_ref()) {
                            current_path =
                                format!("{}{}{}", nvm_bin_str, sep, current_path);
                        }
                    }
                }
            }
        }
        for dir in extra_dirs {
            let dir_str = dir.to_string_lossy().to_string();
            if dir.exists() && !current_path.contains(&dir_str) {
                current_path = format!("{}{}{}", dir_str, sep, current_path);
            }
        }
    }

    // Auto-detect project venv and inject VIRTUAL_ENV + PATH
    let venv_dir = std::path::Path::new(cwd).join(".venv");
    if venv_dir.exists() {
        cmd.env("VIRTUAL_ENV", &venv_dir);
        #[cfg(not(target_os = "windows"))]
        let venv_bin = venv_dir.join("bin");
        #[cfg(target_os = "windows")]
        let venv_bin = venv_dir.join("Scripts");
        current_path = format!("{}{}{}", venv_bin.to_string_lossy(), sep, current_path);
    }

    cmd.env("PATH", current_path);

    cmd
}

// ─── Generic process runner ───────────────────────────────────────────────────

/// Spawn an AI CLI process and stream its output via Tauri events.
/// Events are emitted only to the originating window, tagged with tab_id.
pub async fn spawn_ai_process(
    window: WebviewWindow,
    provider: Arc<dyn AiProvider>,
    project_path: &str,
    prompt: &str,
    model: &str,
    tab_id: String,
    session_id: Option<&str>,
    system_prompt: &str,
    effort_level: Option<&str>,
) -> Result<(), String> {
    let binary = provider.find_binary()?;
    let (args, stdin_payload) = provider.build_args(prompt, model, session_id, system_prompt);
    let mut cmd = create_command(&binary, args, project_path);
    provider.setup_env(&mut cmd, effort_level);

    let window_label = window.label().to_string();
    let process_key = format!("{}:{}", window_label, tab_id);

    if stdin_payload.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }

    // Spawn the process
    let mut child = cmd.spawn().map_err(|e| {
        eprintln!(
            "[ai-spawn] Failed to spawn {} process for tab {}: {}",
            provider.name(),
            tab_id,
            e
        );
        format!(
            "Failed to spawn {} process: {}. Is the CLI installed?",
            provider.name(),
            e
        )
    })?;

    if let Some(payload) = stdin_payload {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("Failed to acquire stdin for {} process", provider.name()))?;
        stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("Failed to write prompt to {} process stdin: {}", provider.name(), e))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("Failed to close {} process stdin: {}", provider.name(), e))?;
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Get a clone of the process state Arc before any moves
    let process_arc = window
        .state::<AiProcessState>()
        .inner()
        .processes
        .clone();

    // Store the child process in state (kill any existing process for this tab)
    {
        let mut processes = process_arc.lock().await;
        if let Some(mut existing) = processes.remove(&process_key) {
            let _ = existing.kill().await;
        }
        processes.insert(process_key.clone(), child);
    }

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    let start_time = std::time::Instant::now();

    // Spawn stdout streaming task — emit only to the originating window
    let win_stdout = window.clone();
    let tab_id_stdout = tab_id.clone();
    let provider_stdout = provider.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        let mut line_count: u64 = 0;
        while let Ok(Some(line)) = lines.next_line().await {
            line_count += 1;
            let elapsed = start_time.elapsed().as_secs_f64();
            eprintln!(
                "[ai-stdout] [{}] +{:.1}s #{} len={}",
                tab_id_stdout,
                elapsed,
                line_count,
                line.len()
            );

            match provider_stdout.parse_output_line(&line) {
                ProviderEvent::SessionInit(_) => {
                    // Emit the raw line verbatim — the frontend captures session_id
                    // from the raw JSON (Claude's format is already correct).
                    let _ = win_stdout.emit(
                        "claude-output",
                        AiOutputEvent {
                            tab_id: tab_id_stdout.clone(),
                            data: line,
                        },
                    );
                }
                ProviderEvent::Line(s) => {
                    let _ = win_stdout.emit(
                        "claude-output",
                        AiOutputEvent {
                            tab_id: tab_id_stdout.clone(),
                            data: s,
                        },
                    );
                }
                ProviderEvent::Skip => {
                    // drop silently
                }
            }
        }
        eprintln!(
            "[ai-stdout] [{}] stream ended after {} lines ({:.1}s)",
            tab_id_stdout,
            line_count,
            start_time.elapsed().as_secs_f64()
        );
    });

    // Spawn stderr streaming task — emit only to the originating window
    let win_stderr = window.clone();
    let tab_id_stderr = tab_id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!(
                "[ai-stderr] [{}] +{:.1}s {}",
                tab_id_stderr,
                start_time.elapsed().as_secs_f64(),
                &line[..line.len().min(200)]
            );
            let _ = win_stderr.emit(
                "claude-error",
                AiErrorEvent {
                    tab_id: tab_id_stderr.clone(),
                    data: line,
                },
            );
        }
    });

    // Spawn wait task — wait for process completion
    let process_arc_wait = process_arc.clone();
    let win_wait = window;
    let process_key_wait = process_key;
    let tab_id_wait = tab_id;
    tokio::spawn(async move {
        // Wait for stdout/stderr to finish
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        // Wait for process exit and remove from map
        let mut processes = process_arc_wait.lock().await;
        let success = if let Some(mut child) = processes.remove(&process_key_wait) {
            match child.wait().await {
                Ok(status) => {
                    eprintln!(
                        "[ai-process] [{}] exited with status={} ({:.1}s)",
                        tab_id_wait,
                        status,
                        start_time.elapsed().as_secs_f64()
                    );
                    status.success()
                }
                Err(e) => {
                    eprintln!(
                        "[ai-process] [{}] wait error: {} ({:.1}s)",
                        tab_id_wait,
                        e,
                        start_time.elapsed().as_secs_f64()
                    );
                    false
                }
            }
        } else {
            eprintln!(
                "[ai-process] [{}] no child found in map ({:.1}s)",
                tab_id_wait,
                start_time.elapsed().as_secs_f64()
            );
            false
        };
        drop(processes);

        // Emit completion event to this window with tab_id
        let _ = win_wait.emit(
            "claude-complete",
            AiCompleteEvent {
                tab_id: tab_id_wait,
                success,
            },
        );
    });

    Ok(())
}

/// Spawn a pre-built command and stream its output via Tauri events.
/// Use this when the caller has already constructed the Command (e.g. for
/// Claude's `-c` continue flag which doesn't fit the build_args contract).
/// All JSON lines are forwarded verbatim as "claude-output" events.
pub async fn spawn_prebuilt_process(
    window: WebviewWindow,
    mut cmd: Command,
    tab_id: String,
    stdin_payload: Option<String>,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    let process_key = format!("{}:{}", window_label, tab_id);

    if stdin_payload.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    if let Some(payload) = stdin_payload {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to acquire stdin".to_string())?;
        stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("Failed to close stdin: {}", e))?;
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let process_arc = window
        .state::<AiProcessState>()
        .inner()
        .processes
        .clone();

    {
        let mut processes = process_arc.lock().await;
        if let Some(mut existing) = processes.remove(&process_key) {
            let _ = existing.kill().await;
        }
        processes.insert(process_key.clone(), child);
    }

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);
    let start_time = std::time::Instant::now();

    let win_stdout = window.clone();
    let tab_id_stdout = tab_id.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stdout.emit(
                "claude-output",
                AiOutputEvent {
                    tab_id: tab_id_stdout.clone(),
                    data: line,
                },
            );
        }
    });

    let win_stderr = window.clone();
    let tab_id_stderr = tab_id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stderr.emit(
                "claude-error",
                AiErrorEvent {
                    tab_id: tab_id_stderr.clone(),
                    data: line,
                },
            );
        }
    });

    let process_arc_wait = process_arc.clone();
    let win_wait = window;
    let process_key_wait = process_key;
    let tab_id_wait = tab_id;
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        let mut processes = process_arc_wait.lock().await;
        let success = if let Some(mut child) = processes.remove(&process_key_wait) {
            matches!(child.wait().await, Ok(s) if s.success())
        } else {
            false
        };
        drop(processes);
        let _ = win_wait.emit(
            "claude-complete",
            AiCompleteEvent {
                tab_id: tab_id_wait,
                success,
            },
        );
    });

    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_event_session_init_carries_id() {
        let e = ProviderEvent::SessionInit("abc".to_string());
        match e {
            ProviderEvent::SessionInit(id) => assert_eq!(id, "abc"),
            _ => panic!(),
        }
    }

    #[test]
    fn provider_event_line_carries_content() {
        let e = ProviderEvent::Line("hello".to_string());
        match e {
            ProviderEvent::Line(s) => assert_eq!(s, "hello"),
            _ => panic!(),
        }
    }
}
