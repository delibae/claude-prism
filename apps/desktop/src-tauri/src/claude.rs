use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct ClaudeProcessState {
    pub processes: Arc<Mutex<HashMap<String, Child>>>,
}

impl Default for ClaudeProcessState {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Discover the claude binary on the system.
/// Checks: which/where claude → NVM paths → standard paths → bare fallback.
fn find_claude_binary() -> Result<String, String> {
    // 1. Try to find claude on PATH
    if let Ok(path) = which::which("claude") {
        return Ok(path.to_string_lossy().to_string());
    }

    // 2. Check NVM directories (Unix) or npm global (Windows)
    if let Some(home) = dirs::home_dir() {
        #[cfg(not(target_os = "windows"))]
        {
            let nvm_dir = home.join(".nvm").join("versions").join("node");
            if nvm_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                    let mut candidates: Vec<PathBuf> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.path().join("bin").join("claude"))
                        .filter(|p| p.exists())
                        .collect();
                    // Sort by version (directory name) descending to prefer latest
                    candidates.sort();
                    candidates.reverse();
                    if let Some(path) = candidates.first() {
                        return Ok(path.to_string_lossy().to_string());
                    }
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            // Check common Windows Node.js locations
            if let Ok(appdata) = std::env::var("APPDATA") {
                let npm_global = PathBuf::from(&appdata).join("npm").join("claude.cmd");
                if npm_global.exists() {
                    return Ok(npm_global.to_string_lossy().to_string());
                }
            }
            // NVM for Windows
            if let Ok(nvm_home) = std::env::var("NVM_HOME") {
                // nvm symlink lives under NVM_SYMLINK (default: C:\Program Files\nodejs)
                if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
                    let p = PathBuf::from(&nvm_symlink).join("claude.cmd");
                    if p.exists() {
                        return Ok(p.to_string_lossy().to_string());
                    }
                }
                // Also scan NVM_HOME/<version>
                if let Ok(entries) = std::fs::read_dir(&nvm_home) {
                    let mut candidates: Vec<PathBuf> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.path().join("claude.cmd"))
                        .filter(|p| p.exists())
                        .collect();
                    candidates.sort();
                    candidates.reverse();
                    if let Some(path) = candidates.first() {
                        return Ok(path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    // 3. Check standard paths (Unix only)
    #[cfg(not(target_os = "windows"))]
    {
        let standard_paths = [
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
            "/usr/bin/claude",
            "/bin/claude",
        ];
        for path in &standard_paths {
            if PathBuf::from(path).exists() {
                return Ok(path.to_string());
            }
        }
    }

    // 4. Check user-specific paths
    if let Some(home) = dirs::home_dir() {
        #[cfg(not(target_os = "windows"))]
        let user_paths = vec![
            home.join(".claude").join("local").join("claude"),
            home.join(".local").join("bin").join("claude"),
            home.join(".npm-global").join("bin").join("claude"),
            home.join(".yarn").join("bin").join("claude"),
            home.join(".bun").join("bin").join("claude"),
            home.join("bin").join("claude"),
        ];
        #[cfg(target_os = "windows")]
        let user_paths = vec![
            home.join(".claude").join("local").join("claude.exe"),
            home.join("AppData").join("Local").join("Programs").join("claude").join("claude.exe"),
        ];

        for path in &user_paths {
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    // 5. Bare fallback — hope it's in PATH
    Ok("claude".to_string())
}

/// Create a tokio Command with appropriate environment variables.
fn create_command(program: &str, args: Vec<String>, cwd: &str, effort_level: Option<&str>) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(&args);
    cmd.current_dir(cwd);

    // Pipe stdout and stderr for streaming
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Remove all Claude Code internal env vars to prevent nested session detection
    // and other interference. Tauri inherits these when launched from a Claude Code session.
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_AGENT_SDK_VERSION");
    for (key, _) in std::env::vars() {
        if key.starts_with("CLAUDE_CODE_") || key.starts_with("CLAUDE_AGENT_") {
            cmd.env_remove(&key);
        }
    }
    // Set effort level (default: low for fast responses)
    cmd.env("CLAUDE_CODE_EFFORT_LEVEL", effort_level.unwrap_or("low"));

    // Build PATH: start with current PATH, prepend program dir and venv bin
    let mut current_path = std::env::var("PATH").unwrap_or_default();
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

// ─── Event payloads (include tab_id for multi-tab routing) ───

#[derive(Clone, serde::Serialize)]
struct ClaudeOutputEvent {
    tab_id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct ClaudeCompleteEvent {
    tab_id: String,
    success: bool,
}

#[derive(Clone, serde::Serialize)]
struct ClaudeErrorEvent {
    tab_id: String,
    data: String,
}

/// Spawn the Claude CLI process and stream output via Tauri events.
/// Events are emitted only to the originating window, tagged with tab_id.
async fn spawn_claude_process(
    window: WebviewWindow,
    mut cmd: Command,
    tab_id: String,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    let process_key = format!("{}:{}", window_label, tab_id);

    // Spawn the process
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude process: {}. Is Claude Code CLI installed?", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Get a clone of the process state Arc before any moves
    let process_arc = window.state::<ClaudeProcessState>().inner().processes.clone();

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
    let session_id_holder: Arc<std::sync::Mutex<Option<String>>> =
        Arc::new(std::sync::Mutex::new(None));

    let start_time = std::time::Instant::now();

    // Spawn stdout streaming task — emit only to the originating window
    let win_stdout = window.clone();
    let session_id_stdout = session_id_holder.clone();
    let tab_id_stdout = tab_id.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        let mut line_count: u64 = 0;
        while let Ok(Some(line)) = lines.next_line().await {
            line_count += 1;
            let elapsed = start_time.elapsed().as_secs_f64();

            // Parse for system:init to extract session_id
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                let msg_type = msg["type"].as_str().unwrap_or("?");
                let msg_sub = msg["subtype"].as_str().unwrap_or("");
                eprintln!("[claude-stdout] [{}] +{:.1}s #{} type={} sub={} len={}", tab_id_stdout, elapsed, line_count, msg_type, msg_sub, line.len());

                if msg["type"] == "system" && msg["subtype"] == "init" {
                    if let Some(sid) = msg["session_id"].as_str() {
                        let mut guard = session_id_stdout.lock().unwrap();
                        *guard = Some(sid.to_string());
                    }
                }
            }

            // Emit output event to this window with tab_id
            let _ = win_stdout.emit("claude-output", ClaudeOutputEvent {
                tab_id: tab_id_stdout.clone(),
                data: line,
            });
        }
        eprintln!("[claude-stdout] [{}] stream ended after {} lines ({:.1}s)", tab_id_stdout, line_count, start_time.elapsed().as_secs_f64());
    });

    // Spawn stderr streaming task — emit only to the originating window
    let win_stderr = window.clone();
    let tab_id_stderr = tab_id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[claude-stderr] [{}] +{:.1}s {}", tab_id_stderr, start_time.elapsed().as_secs_f64(), &line[..line.len().min(200)]);
            let _ = win_stderr.emit("claude-error", ClaudeErrorEvent {
                tab_id: tab_id_stderr.clone(),
                data: line,
            });
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
                    eprintln!("[claude-process] [{}] exited with status={} ({:.1}s)", tab_id_wait, status, start_time.elapsed().as_secs_f64());
                    status.success()
                }
                Err(e) => {
                    eprintln!("[claude-process] [{}] wait error: {} ({:.1}s)", tab_id_wait, e, start_time.elapsed().as_secs_f64());
                    false
                }
            }
        } else {
            eprintln!("[claude-process] [{}] no child found in map ({:.1}s)", tab_id_wait, start_time.elapsed().as_secs_f64());
            false
        };
        drop(processes);

        // Emit completion event to this window with tab_id
        let _ = win_wait.emit("claude-complete", ClaudeCompleteEvent {
            tab_id: tab_id_wait,
            success,
        });
    });

    Ok(())
}

// ─── Setup / Status Commands ───

#[derive(serde::Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub account_email: Option<String>,
}

#[tauri::command]
pub async fn check_claude_status() -> Result<ClaudeStatus, String> {
    // Try to find binary
    let binary_path = match find_claude_binary() {
        Ok(path) => path,
        Err(_) => {
            return Ok(ClaudeStatus {
                installed: false,
                authenticated: false,
                binary_path: None,
                version: None,
                account_email: None,
            });
        }
    };

    // Verify binary actually works by running --version
    let version_output = std::process::Command::new(&binary_path)
        .arg("--version")
        .output();

    let version = match version_output {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        _ => {
            // Binary found but doesn't work (bare "claude" fallback or broken install)
            return Ok(ClaudeStatus {
                installed: false,
                authenticated: false,
                binary_path: None,
                version: None,
                account_email: None,
            });
        }
    };

    // Check auth status
    let auth_output = std::process::Command::new(&binary_path)
        .args(["auth", "status"])
        .output();

    let (authenticated, account_email) = match auth_output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            // Parse for email — claude auth status outputs account info
            let email = stdout
                .lines()
                .find(|line| line.contains('@'))
                .map(|line| {
                    // Extract email-like substring
                    line.split_whitespace()
                        .find(|word| word.contains('@'))
                        .unwrap_or(line.trim())
                        .to_string()
                });
            (true, email)
        }
        _ => (false, None),
    };

    Ok(ClaudeStatus {
        installed: true,
        authenticated,
        binary_path: Some(binary_path),
        version,
        account_email,
    })
}

#[tauri::command]
pub async fn install_claude_cli(window: WebviewWindow) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell");
        c.args(["-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex"]);
        c
    };
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Inherit essential environment variables
    for (key, value) in std::env::vars() {
        if key == "PATH"
            || key == "HOME"
            || key == "USER"
            || key == "SHELL"
            || key == "LANG"
            || key.starts_with("LC_")
            || key == "HOMEBREW_PREFIX"
            || key == "HOMEBREW_CELLAR"
            || key == "HTTP_PROXY"
            || key == "HTTPS_PROXY"
            || key == "NO_PROXY"
            || key == "ALL_PROXY"
        {
            cmd.env(&key, &value);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run installer: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    // Stream stdout
    let win_stdout = window.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stdout.emit("install-output", &line);
        }
    });

    // Stream stderr
    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stderr.emit("install-error", &line);
        }
    });

    // Wait for completion and emit result
    let win_complete = window;
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let success = match child.wait().await {
            Ok(status) => status.success(),
            Err(_) => false,
        };

        let _ = win_complete.emit("install-complete", success);
    });

    Ok(())
}

#[tauri::command]
pub async fn login_claude(window: WebviewWindow) -> Result<(), String> {
    let binary_path = find_claude_binary()
        .map_err(|e| format!("Claude CLI not found: {}", e))?;

    // Verify it actually exists
    let version_check = std::process::Command::new(&binary_path)
        .arg("--version")
        .output();

    if version_check.is_err() || !version_check.unwrap().status.success() {
        return Err("Claude CLI is not properly installed".to_string());
    }

    let mut cmd = tokio::process::Command::new(&binary_path);
    cmd.args(["auth", "login"]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Inherit essential environment variables
    for (key, value) in std::env::vars() {
        if key == "PATH"
            || key == "HOME"
            || key == "USER"
            || key == "SHELL"
            || key == "LANG"
            || key.starts_with("LC_")
            || key == "HOMEBREW_PREFIX"
            || key == "HOMEBREW_CELLAR"
            || key == "HTTP_PROXY"
            || key == "HTTPS_PROXY"
            || key == "NO_PROXY"
            || key == "ALL_PROXY"
        {
            cmd.env(&key, &value);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run auth login: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    // Stream stdout
    let win_stdout = window.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stdout.emit("login-output", &line);
        }
    });

    // Stream stderr
    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stderr.emit("login-error", &line);
        }
    });

    // Wait for completion and emit result
    let win_complete = window;
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let success = match child.wait().await {
            Ok(status) => status.success(),
            Err(_) => false,
        };

        let _ = win_complete.emit("login-complete", success);
    });

    Ok(())
}

/// Common CLI flags shared across all Claude invocations.
fn common_claude_args() -> Vec<String> {
    vec![
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
        "--append-system-prompt".to_string(),
        concat!(
            "You are an AI assistant integrated into a LaTeX document editor (Prism). ",
            "Follow these rules strictly:\n",
            "1. PLANNING FIRST: Before making changes, use TodoWrite to create a step-by-step plan. ",
            "Break large tasks into small, incremental steps (one section or one logical unit per step).\n",
            "2. INCREMENTAL EDITS: Use the Edit tool to make small, targeted changes — one step at a time. ",
            "NEVER write or rewrite an entire file at once. Always prefer editing existing content over replacing it wholesale.\n",
            "3. STEP BY STEP: After each edit, mark the todo item as completed, then proceed to the next step. ",
            "This lets the user review changes incrementally.\n",
            "4. PRESERVE EXISTING CONTENT: Always read the file first. Keep the existing preamble, packages, ",
            "and structure intact. Only add or modify what is needed for the current step.\n",
            "5. LaTeX BEST PRACTICES: Use proper sectioning (\\chapter, \\section, \\subsection), ",
            "citations (\\cite), cross-references (\\label, \\ref), and BibTeX for bibliographies.\n",
            "6. SKILLS: If scientific skills are installed in .claude/skills/, follow their guidelines ",
            "for domain-specific tasks. Use skill-provided LaTeX packages (.sty) and code patterns.\n",
            "7. PYTHON: If a .venv/ exists in the project, it is already activated. ",
            "Use `uv pip install` to add packages and `python` to run scripts."
        ).to_string(),
    ]
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn execute_claude_code(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    effort_level: Option<String>,
) -> Result<(), String> {
    let claude_path = find_claude_binary()?;

    let mut args = vec![
        "-p".to_string(),
        prompt,
    ];
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m);
    }
    args.extend(common_claude_args());

    let cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    spawn_claude_process(window, cmd, tab_id).await
}

#[tauri::command]
pub async fn continue_claude_code(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    effort_level: Option<String>,
) -> Result<(), String> {
    let claude_path = find_claude_binary()?;

    let mut args = vec![
        "-c".to_string(),
        "-p".to_string(),
        prompt,
    ];
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m);
    }
    args.extend(common_claude_args());

    let cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    spawn_claude_process(window, cmd, tab_id).await
}

#[tauri::command]
pub async fn resume_claude_code(
    window: WebviewWindow,
    project_path: String,
    session_id: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    effort_level: Option<String>,
) -> Result<(), String> {
    let claude_path = find_claude_binary()?;

    let mut args = vec![
        "--resume".to_string(),
        session_id,
        "-p".to_string(),
        prompt,
    ];
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m);
    }
    args.extend(common_claude_args());

    let cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    spawn_claude_process(window, cmd, tab_id).await
}

#[tauri::command]
pub async fn cancel_claude_execution(
    window: WebviewWindow,
    tab_id: String,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    let process_key = format!("{}:{}", window_label, tab_id);
    let claude_state = window.state::<ClaudeProcessState>();
    let mut processes = claude_state.processes.lock().await;
    if let Some(mut child) = processes.remove(&process_key) {
        let _ = child.kill().await;
        let _ = window.emit("claude-complete", ClaudeCompleteEvent {
            tab_id,
            success: false,
        });
    }
    Ok(())
}

/// Kill all Claude processes associated with a specific window label.
/// Called when a window is destroyed.
pub async fn kill_process_for_window(state: &ClaudeProcessState, window_label: &str) {
    let mut processes = state.processes.lock().await;
    let prefix = format!("{}:", window_label);
    let keys_to_remove: Vec<String> = processes
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    for key in keys_to_remove {
        if let Some(mut child) = processes.remove(&key) {
            let _ = child.kill().await;
        }
    }
}

// ─── Session Listing ───

#[derive(serde::Serialize)]
pub struct ClaudeSessionInfo {
    pub session_id: String,
    pub title: String,
    pub last_modified: i64,
}

/// Resolve the Claude Code sessions directory for a given project path.
/// Claude Code encodes paths by replacing all non-alphanumeric characters with '-'.
/// e.g. "/Users/dev/my_project" → "-Users-dev-my-project"
fn get_sessions_dir(project_path: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or("Could not determine home directory")?;

    let encoded: String = project_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();

    eprintln!("[session] project_path={} encoded={}", project_path, encoded);

    Ok(home.join(".claude").join("projects").join(&encoded))
}

/// Clean raw user message text into a display title.
fn clean_user_message_title(text: &str) -> Option<String> {
    // Skip IDE context tags
    if text.starts_with("<ide_") || text.starts_with("<system-reminder>") {
        return None;
    }
    // Skip command tags
    if text.starts_with("<command-name>") || text.starts_with("<local-command-stdout>") {
        return None;
    }

    // Strip context prefix like "[Currently open file: ...]\n\n"
    let clean = if let Some(idx) = text.rfind("]\n\n") {
        &text[idx + 3..]
    } else {
        text
    };

    // Skip if still an IDE tag after stripping context
    if clean.starts_with("<ide_") {
        return None;
    }

    let clean = clean.trim();
    if clean.is_empty() {
        return None;
    }

    let title = if clean.chars().count() > 80 {
        let truncated: String = clean.chars().take(77).collect();
        format!("{}...", truncated)
    } else {
        clean.to_string()
    };

    Some(title)
}

/// Extract the first valid user message from a JSONL session file.
/// Handles both string content (stored JSONL) and array content (streaming format).
fn extract_first_user_message(path: &PathBuf) -> (Option<String>, Option<String>) {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let reader = std::io::BufReader::new(file);
    use std::io::BufRead;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let msg = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if msg["type"] != "user" {
            continue;
        }

        let content_val = &msg["message"]["content"];
        let timestamp = msg["timestamp"].as_str().map(|s| s.to_string());

        // Case 1: content is a plain string (Claude Code stored JSONL format)
        if let Some(text) = content_val.as_str() {
            if let Some(title) = clean_user_message_title(text) {
                return (Some(title), timestamp);
            }
            continue;
        }

        // Case 2: content is an array of blocks (streaming format)
        if let Some(blocks) = content_val.as_array() {
            for block in blocks {
                if block["type"] == "text" {
                    if let Some(text) = block["text"].as_str() {
                        if let Some(title) = clean_user_message_title(text) {
                            return (Some(title), timestamp);
                        }
                    }
                }
            }
        }
    }
    (None, None)
}

#[tauri::command]
pub async fn list_claude_sessions(
    project_path: String,
) -> Result<Vec<ClaudeSessionInfo>, String> {
    eprintln!("[session] list_claude_sessions called with project_path={}", project_path);
    let sessions_dir = get_sessions_dir(&project_path)?;
    eprintln!("[session] sessions_dir={:?} exists={}", sessions_dir, sessions_dir.exists());

    if !sessions_dir.exists() {
        eprintln!("[session] sessions_dir does not exist, returning empty");
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    let entries = std::fs::read_dir(&sessions_dir)
        .map_err(|e| format!("Failed to read sessions directory: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        if session_id.is_empty() {
            continue;
        }

        let metadata = std::fs::metadata(&path).ok();
        let modified = metadata
            .and_then(|m| m.modified().ok())
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
            .unwrap_or(0);

        let (first_message, _timestamp) = extract_first_user_message(&path);
        let title = first_message.unwrap_or_else(|| "Untitled session".to_string());

        sessions.push(ClaudeSessionInfo {
            session_id,
            title,
            last_modified: modified,
        });
    }

    sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

    eprintln!("[session] found {} sessions", sessions.len());
    for s in &sessions {
        eprintln!("[session]   id={} title={} modified={}", s.session_id, s.title, s.last_modified);
    }

    Ok(sessions)
}

/// Load the full JSONL history for a specific session.
#[tauri::command]
pub async fn load_session_history(
    project_path: String,
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    eprintln!("[session] load_session_history called: session_id={} project_path={}", session_id, project_path);
    let sessions_dir = get_sessions_dir(&project_path)?;
    let session_path = sessions_dir.join(format!("{}.jsonl", session_id));
    eprintln!("[session] session_path={:?} exists={}", session_path, session_path.exists());

    if !session_path.exists() {
        return Err(format!("Session file not found: {}", session_id));
    }

    let file = std::fs::File::open(&session_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;

    let reader = std::io::BufReader::new(file);
    use std::io::BufRead;
    let mut messages = Vec::new();

    for line in reader.lines() {
        if let Ok(line) = line {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                messages.push(json);
            }
        }
    }

    eprintln!("[session] loaded {} messages from session {}", messages.len(), session_id);

    Ok(messages)
}

// ─── Shell Command Execution ───

#[derive(serde::Serialize)]
pub struct ShellCommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub async fn run_shell_command(
    command: String,
    cwd: String,
) -> Result<ShellCommandResult, String> {
    #[cfg(not(target_os = "windows"))]
    let (shell, args) = ("sh", vec!["-c".to_string(), command]);
    #[cfg(target_os = "windows")]
    let (shell, args) = ("cmd", vec!["/C".to_string(), command]);
    let mut cmd = create_command(shell, args, &cwd, None);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to wait for command: {}", e))?;

    Ok(ShellCommandResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

// ─── Claude Settings (fast mode, etc.) ───

fn get_claude_settings_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join(".claude").join("settings.json"))
}

#[tauri::command]
pub async fn get_claude_fast_mode() -> Result<bool, String> {
    let path = get_claude_settings_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;
    let settings: serde_json::Value = serde_json::from_str(&content)
        .unwrap_or(serde_json::json!({}));
    Ok(settings["fastMode"].as_bool().unwrap_or(false))
}

#[tauri::command]
pub async fn set_claude_fast_mode(enabled: bool) -> Result<(), String> {
    let path = get_claude_settings_path()?;

    // Ensure directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings dir: {}", e))?;
    }

    // Read existing settings or create new
    let mut settings: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Update fastMode
    if let Some(obj) = settings.as_object_mut() {
        if enabled {
            obj.insert("fastMode".to_string(), serde_json::json!(true));
        } else {
            obj.remove("fastMode");
        }
    }

    // Write back
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- get_sessions_dir ---

    #[test]
    fn test_get_sessions_dir_encodes_path() {
        let result = get_sessions_dir("/Users/dev/my_project");
        assert!(result.is_ok());
        let path = result.unwrap();
        let dir_name = path.file_name().unwrap().to_str().unwrap();
        // All non-alphanumeric chars should be replaced with '-'
        assert_eq!(dir_name, "-Users-dev-my-project");
    }

    #[test]
    fn test_get_sessions_dir_alphanumeric_only() {
        let result = get_sessions_dir("abc123");
        assert!(result.is_ok());
        let path = result.unwrap();
        let dir_name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(dir_name, "abc123");
    }

    #[test]
    fn test_get_sessions_dir_special_chars() {
        let result = get_sessions_dir("/a/b c/d@e");
        assert!(result.is_ok());
        let path = result.unwrap();
        let dir_name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(dir_name, "-a-b-c-d-e");
    }

    // --- clean_user_message_title ---

    #[test]
    fn test_clean_user_message_title_simple() {
        let result = clean_user_message_title("Hello Claude");
        assert_eq!(result, Some("Hello Claude".to_string()));
    }

    #[test]
    fn test_clean_user_message_title_skips_ide_tags() {
        assert_eq!(clean_user_message_title("<ide_something>data"), None);
        assert_eq!(clean_user_message_title("<system-reminder>stuff"), None);
    }

    #[test]
    fn test_clean_user_message_title_skips_command_tags() {
        assert_eq!(clean_user_message_title("<command-name>test"), None);
        assert_eq!(clean_user_message_title("<local-command-stdout>output"), None);
    }

    #[test]
    fn test_clean_user_message_title_strips_context_prefix() {
        let text = "[Currently open file: main.tex]\n\nFix the bibliography";
        let result = clean_user_message_title(text);
        assert_eq!(result, Some("Fix the bibliography".to_string()));
    }

    #[test]
    fn test_clean_user_message_title_truncates_at_80() {
        let long_text = "a".repeat(100);
        let result = clean_user_message_title(&long_text).unwrap();
        assert_eq!(result.len(), 80); // 77 chars + "..."
        assert!(result.ends_with("..."));
    }

    #[test]
    fn test_clean_user_message_title_empty() {
        assert_eq!(clean_user_message_title(""), None);
        assert_eq!(clean_user_message_title("   "), None);
    }

    #[test]
    fn test_clean_user_message_title_exactly_80_chars() {
        let text = "a".repeat(80);
        let result = clean_user_message_title(&text).unwrap();
        assert_eq!(result, text); // No truncation needed
    }

    // --- common_claude_args ---

    #[test]
    fn test_common_claude_args_has_required_flags() {
        let args = common_claude_args();
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--verbose".to_string()));
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn test_common_claude_args_system_prompt_mentions_latex() {
        let args = common_claude_args();
        let prompt_idx = args.iter().position(|a| a == "--append-system-prompt").unwrap();
        let prompt = &args[prompt_idx + 1];
        assert!(prompt.contains("LaTeX"));
    }

    // --- create_command ---

    #[test]
    fn test_create_command_sets_args_and_cwd() {
        let args = vec!["--version".to_string()];
        let cmd = create_command("/usr/bin/claude", args, "/tmp/project", None);
        // Command is created — we can verify via its Debug representation
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("--version"));
    }

    #[test]
    fn test_create_command_default_effort_level() {
        let cmd = create_command("/usr/bin/claude", vec![], "/tmp", None);
        let debug_str = format!("{:?}", cmd);
        // The env setup is internal; just verify the command is created
        assert!(debug_str.contains("claude"));
    }

    #[test]
    fn test_create_command_custom_effort_level() {
        let cmd = create_command("/usr/bin/claude", vec![], "/tmp", Some("high"));
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("claude"));
    }

    // --- clean_user_message_title edge cases ---

    #[test]
    fn test_clean_user_message_title_context_with_nested_brackets() {
        let text = "[File: main.tex]\n[Selection: @main.tex:1:1-5:10]\n\nWrite an abstract";
        let result = clean_user_message_title(text);
        assert_eq!(result, Some("Write an abstract".to_string()));
    }

    #[test]
    fn test_clean_user_message_title_only_context_no_body() {
        // After stripping context prefix, if it becomes an IDE tag, returns None
        let text = "[context info]\n\n<ide_something>hidden";
        let result = clean_user_message_title(text);
        assert_eq!(result, None);
    }

    #[test]
    fn test_clean_user_message_title_only_whitespace_after_strip() {
        let text = "[context]\n\n   ";
        let result = clean_user_message_title(text);
        assert_eq!(result, None);
    }

    #[test]
    fn test_clean_user_message_title_multibyte_truncation() {
        // Truncation counts chars, not bytes
        let text = "あ".repeat(100); // 100 Japanese chars
        let result = clean_user_message_title(&text).unwrap();
        assert!(result.ends_with("..."));
        // 77 chars + "..." = 80 display chars
        assert_eq!(result.chars().count(), 80);
    }

    // --- get_sessions_dir edge cases ---

    #[test]
    fn test_get_sessions_dir_windows_path_style() {
        let result = get_sessions_dir("C:\\Users\\dev\\project").unwrap();
        let dir_name = result.file_name().unwrap().to_str().unwrap();
        assert_eq!(dir_name, "C--Users-dev-project");
    }

    #[test]
    fn test_get_sessions_dir_dots_and_underscores() {
        let result = get_sessions_dir("/home/user/.my_project.v2").unwrap();
        let dir_name = result.file_name().unwrap().to_str().unwrap();
        // dots and underscores are non-alphanumeric → replaced with '-'
        assert_eq!(dir_name, "-home-user--my-project-v2");
    }

    // --- extract_first_user_message integration tests ---

    #[test]
    fn test_extract_first_user_message_string_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let line = r#"{"type":"user","timestamp":"2024-01-01T00:00:00Z","message":{"content":"Fix the bibliography"}}"#;
        std::fs::write(&path, line).unwrap();

        let pb = PathBuf::from(&path);
        let (title, ts) = extract_first_user_message(&pb);
        assert_eq!(title.unwrap(), "Fix the bibliography");
        assert_eq!(ts.unwrap(), "2024-01-01T00:00:00Z");
    }

    #[test]
    fn test_extract_first_user_message_block_array_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let line = r#"{"type":"user","timestamp":"2024-02-01T00:00:00Z","message":{"content":[{"type":"text","text":"Rewrite the abstract"}]}}"#;
        std::fs::write(&path, line).unwrap();

        let pb = PathBuf::from(&path);
        let (title, ts) = extract_first_user_message(&pb);
        assert_eq!(title.unwrap(), "Rewrite the abstract");
        assert_eq!(ts.unwrap(), "2024-02-01T00:00:00Z");
    }

    #[test]
    fn test_extract_first_user_message_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.jsonl");
        std::fs::write(&path, "").unwrap();

        let pb = PathBuf::from(&path);
        let (title, ts) = extract_first_user_message(&pb);
        assert!(title.is_none());
        assert!(ts.is_none());
    }

    #[test]
    fn test_extract_first_user_message_no_user_messages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let lines = r#"{"type":"system","subtype":"init","session_id":"abc"}
{"type":"assistant","message":{"content":"Hello"}}"#;
        std::fs::write(&path, lines).unwrap();

        let pb = PathBuf::from(&path);
        let (title, ts) = extract_first_user_message(&pb);
        assert!(title.is_none());
        assert!(ts.is_none());
    }

    #[test]
    fn test_extract_first_user_message_nonexistent_path() {
        let pb = PathBuf::from("/tmp/nonexistent_session_file_12345.jsonl");
        let (title, ts) = extract_first_user_message(&pb);
        assert!(title.is_none());
        assert!(ts.is_none());
    }

    #[test]
    fn test_extract_first_user_message_skips_ide_tags() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        // First user message is an IDE tag (should skip), second is real
        let lines = r#"{"type":"user","timestamp":"2024-01-01T00:00:00Z","message":{"content":"<ide_context>data"}}
{"type":"user","timestamp":"2024-01-02T00:00:00Z","message":{"content":"Add a new section"}}"#;
        std::fs::write(&path, lines).unwrap();

        let pb = PathBuf::from(&path);
        let (title, ts) = extract_first_user_message(&pb);
        assert_eq!(title.unwrap(), "Add a new section");
        assert_eq!(ts.unwrap(), "2024-01-02T00:00:00Z");
    }
}
