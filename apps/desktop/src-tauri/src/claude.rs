use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

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
/// when spawning child processes (e.g. Claude CLI, cmd.exe, node.exe).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

/// On Windows, read User + System PATH from the registry and search for claude.
/// This catches cases where claude was installed after the GUI app launched,
/// since the process PATH is stale but the registry PATH is up to date.
/// Registry values may contain unexpanded variables like `%USERPROFILE%`,
/// so we expand them via `ExpandEnvironmentStringsW` before searching.
#[cfg(target_os = "windows")]
fn find_claude_in_registry_path() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut dirs: Vec<String> = Vec::new();

    // User PATH
    if let Ok(env) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment") {
        if let Ok(user_path) = env.get_value::<String, _>("Path") {
            dirs.extend(
                user_path
                    .split(';')
                    .filter(|s| !s.is_empty())
                    .map(|s| expand_env_vars(s)),
            );
        }
    }

    // System PATH
    if let Ok(env) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
    {
        if let Ok(sys_path) = env.get_value::<String, _>("Path") {
            dirs.extend(
                sys_path
                    .split(';')
                    .filter(|s| !s.is_empty())
                    .map(|s| expand_env_vars(s)),
            );
        }
    }

    let candidates = ["claude.exe", "claude.cmd"];
    for dir in &dirs {
        for name in &candidates {
            let p = PathBuf::from(dir).join(name);
            if p.is_file() {
                return Some(p.to_string_lossy().to_string());
            }
        }
    }

    None
}

/// Expand Windows environment variables like `%USERPROFILE%` in a string.
#[cfg(target_os = "windows")]
fn expand_env_vars(s: &str) -> String {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let wide: Vec<u16> = OsString::from(s).encode_wide().chain(std::iter::once(0)).collect();

    // First call to get required buffer size
    let size = unsafe {
        windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    if size == 0 {
        return s.to_string();
    }

    let mut buf: Vec<u16> = vec![0u16; size as usize];
    let result = unsafe {
        windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW(
            wide.as_ptr(),
            buf.as_mut_ptr(),
            size,
        )
    };
    if result == 0 {
        return s.to_string();
    }

    // Trim trailing null
    if let Some(pos) = buf.iter().position(|&c| c == 0) {
        buf.truncate(pos);
    }
    OsString::from_wide(&buf).to_string_lossy().to_string()
}

/// Discover the claude binary on the system.
/// Search order: ~/.local/bin → NVM_BIN → which → registry PATH (Windows) →
/// login shell (Unix) → npm/nvm global → standard paths → user-specific paths.
/// Returns Err if not found.
fn find_claude_binary() -> Result<String, String> {
    // 1. Check the native installer's default location first
    //    (GUI apps often don't have ~/.local/bin in PATH)
    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "windows")]
        let native_path = home.join(".local").join("bin").join("claude.exe");
        #[cfg(not(target_os = "windows"))]
        let native_path = home.join(".local").join("bin").join("claude");
        if native_path.exists() {
            return Ok(native_path.to_string_lossy().to_string());
        }
    }

    // 2. Check NVM_BIN environment variable (active NVM version).
    //    This is checked before `which` because GUI apps lack shell-sourced PATH,
    //    but NVM_BIN may still be set when launched from a terminal-aware context.
    #[cfg(not(target_os = "windows"))]
    if let Ok(nvm_bin) = std::env::var("NVM_BIN") {
        let claude_in_nvm = PathBuf::from(&nvm_bin).join("claude");
        if claude_in_nvm.exists() {
            return Ok(claude_in_nvm.to_string_lossy().to_string());
        }
    }

    // 2b. Check PNPM_HOME before PATH probing.
    //     GUI apps on macOS often miss shell-initialized PATH entries, but
    //     package-manager homes may still be available as environment vars.
    #[cfg(not(target_os = "windows"))]
    if let Some(path) = dirs::home_dir().and_then(|home| {
        unix_claude_candidate_paths(&home, std::env::var_os("PNPM_HOME"))
            .into_iter()
            .find(|path| path.exists())
    }) {
        return Ok(path.to_string_lossy().to_string());
    }

    // 3. Try to find claude on PATH
    if let Ok(path) = which::which("claude") {
        return Ok(path.to_string_lossy().to_string());
    }

    // 4. On macOS/Linux, ask a login shell for the real PATH and package-manager
    //    homes. GUI apps inherit a minimal PATH that misses ~/.nvm, homebrew,
    //    pnpm/npm custom prefixes, etc.
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(path_str) = run_login_shell_command("command -v claude") {
            if PathBuf::from(&path_str).exists() {
                return Ok(path_str);
            }
        }

        if let Some(home) = dirs::home_dir() {
            for path in unix_shell_manager_candidate_paths(&home) {
                if path.exists() {
                    return Ok(path.to_string_lossy().to_string());
                }
            }
        }
    }

    // 5. On Windows, read the real PATH from the registry.
    //    GUI apps inherit the PATH from login time; if the user installed Claude
    //    after that, the registry PATH has it but the process PATH does not.
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = find_claude_in_registry_path() {
            return Ok(path);
        }
    }

    // 6. Check NVM directories (Unix) or npm/nvm global (Windows)
    #[allow(unused_variables)]
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

    // 7. Check standard paths (Unix only)
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

    // 8. Check user-specific paths
    if let Some(home) = dirs::home_dir() {
        #[cfg(not(target_os = "windows"))]
        let user_paths = unix_claude_candidate_paths(&home, std::env::var_os("PNPM_HOME"));
        #[cfg(target_os = "windows")]
        let user_paths = vec![
            home.join(".claude").join("local").join("claude.exe"),
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join("claude")
                .join("claude.exe"),
            // Volta
            home.join("AppData")
                .join("Local")
                .join("Volta")
                .join("bin")
                .join("claude.cmd"),
            // pnpm global
            home.join("AppData")
                .join("Local")
                .join("pnpm")
                .join("claude.cmd"),
            // Scoop
            home.join("scoop")
                .join("shims")
                .join("claude.cmd"),
            // Standard Node.js install
            PathBuf::from(r"C:\Program Files\nodejs\claude.cmd"),
        ];

        for path in &user_paths {
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    Err("Not found in any known location. Install from https://claude.ai".to_string())
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_claude_candidate_paths(home: &std::path::Path, pnpm_home: Option<std::ffi::OsString>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(pnpm_home) = pnpm_home.filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(pnpm_home).join("claude"));
    }
    paths.extend([
        home.join("Library").join("pnpm").join("claude"),
        home.join(".local").join("share").join("pnpm").join("claude"),
        home.join(".pnpm").join("claude"),
        home.join(".claude").join("local").join("claude"),
        home.join(".npm-global").join("bin").join("claude"),
        home.join(".yarn").join("bin").join("claude"),
        home.join(".bun").join("bin").join("claude"),
        home.join("bin").join("claude"),
    ]);
    paths
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_claude_path_from_bin_dir(bin_dir: impl Into<PathBuf>) -> PathBuf {
    bin_dir.into().join("claude")
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_claude_path_from_npm_prefix(prefix: impl Into<PathBuf>) -> PathBuf {
    prefix.into().join("bin").join("claude")
}

#[cfg(not(target_os = "windows"))]
fn run_login_shell_command(command: &str) -> Option<String> {
    let shell_env = std::env::var("SHELL").ok();
    let mut shells = Vec::new();
    if let Some(shell) = shell_env {
        shells.push(shell);
    }
    for fallback in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if !shells.iter().any(|shell| shell == fallback) && PathBuf::from(fallback).exists() {
            shells.push(fallback.to_string());
        }
    }

    for shell in shells {
        if let Ok(output) = std::process::Command::new(&shell)
            .args(["-l", "-c", command])
            .output()
        {
            if output.status.success() {
                let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !value.is_empty() && value != "undefined" && value != "null" {
                    return Some(value);
                }
            }
        }
    }

    None
}

#[cfg(not(target_os = "windows"))]
fn unix_shell_manager_candidate_paths(home: &std::path::Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(pnpm_bin) =
        run_login_shell_command("command -v pnpm >/dev/null 2>&1 && pnpm bin -g 2>/dev/null")
    {
        paths.push(unix_claude_path_from_bin_dir(pnpm_bin));
    }

    if let Some(npm_prefix) = run_login_shell_command(
        "command -v npm >/dev/null 2>&1 && npm config get prefix 2>/dev/null",
    ) {
        paths.push(unix_claude_path_from_npm_prefix(npm_prefix));
    }

    if let Some(yarn_bin) = run_login_shell_command(
        "command -v yarn >/dev/null 2>&1 && yarn global bin 2>/dev/null",
    ) {
        paths.push(unix_claude_path_from_bin_dir(yarn_bin));
    }

    paths.extend(unix_known_pnpm_claude_paths(home));

    paths
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_known_pnpm_claude_paths(home: &std::path::Path) -> Vec<PathBuf> {
    vec![
        home.join("Library").join("pnpm").join("claude"),
        home.join("Library").join("pnpm").join("global").join("bin").join("claude"),
        home.join(".local").join("share").join("pnpm").join("claude"),
        home.join(".local").join("share").join("pnpm").join("global").join("bin").join("claude"),
        home.join(".pnpm").join("claude"),
        home.join(".pnpm").join("global").join("bin").join("claude"),
    ]
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

/// Strip ANSI escape sequences from CLI output before sending to the frontend.
/// Handles CSI sequences (e.g. colors, cursor), OSC sequences, and private mode
/// sequences like `\x1b[?2026h` emitted by modern CLIs.
fn strip_ansi(s: &str) -> Cow<'_, str> {
    if !s.contains('\x1b') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                // CSI: ESC [ ... (letter)
                Some('[') => {
                    chars.next();
                    // consume until final byte (ASCII letter or ~)
                    while let Some(&ch) = chars.peek() {
                        chars.next();
                        if ch.is_ascii_alphabetic() || ch == '~' {
                            break;
                        }
                    }
                }
                // OSC: ESC ] ... (ST or BEL)
                Some(']') => {
                    chars.next();
                    while let Some(&ch) = chars.peek() {
                        chars.next();
                        if ch == '\x07' {
                            break;
                        }
                        if ch == '\x1b' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                // Two-character sequences: ESC ( , ESC ) , etc.
                Some(&ch) if ch.is_ascii_alphabetic() || ch == '(' || ch == ')' => {
                    chars.next();
                }
                _ => {}
            }
        } else {
            out.push(c);
        }
    }
    Cow::Owned(out)
}

/// Strip interior nul bytes that would cause Command::spawn() to fail.
/// This can happen when prompts contain clipboard artifacts or encoding issues.
/// Returns a borrowed reference when no nul bytes are present (zero-alloc fast path).
fn strip_nul(s: &str) -> Cow<'_, str> {
    if s.contains('\0') {
        eprintln!(
            "[claude-spawn] stripped {} nul byte(s) from input",
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

/// Create a std::process::Command that handles .cmd/.bat files on Windows.
fn new_sync_command(program: &str) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {

        let (resolved, prefix) = resolve_cmd_to_node(program);
        let mut c = std::process::Command::new(&resolved);
        c.creation_flags(CREATE_NO_WINDOW);
        if !prefix.is_empty() {
            c.args(&prefix);
        }
        return c;
    }
    #[cfg(not(target_os = "windows"))]
    std::process::Command::new(program)
}

/// Create a tokio Command with appropriate environment variables.
fn create_command(
    program: &str,
    args: Vec<String>,
    cwd: &str,
    effort_level: Option<&str>,
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
    // Set effort level (default: low for fast responses)
    cmd.env("CLAUDE_CODE_EFFORT_LEVEL", effort_level.unwrap_or("low"));

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
    let mut child = cmd.spawn().map_err(|e| {
        eprintln!(
            "[claude-spawn] Failed to spawn process for tab {}: {}",
            tab_id, e
        );
        format!(
            "Failed to spawn Claude process: {}. Is Claude Code CLI installed?",
            e
        )
    })?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Get a clone of the process state Arc before any moves
    let process_arc = window
        .state::<ClaudeProcessState>()
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
                let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                let msg_sub = msg.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!(
                    "[claude-stdout] [{}] +{:.1}s #{} type={} sub={} len={}",
                    tab_id_stdout,
                    elapsed,
                    line_count,
                    msg_type,
                    msg_sub,
                    line.len()
                );

                if msg.get("type").and_then(|v| v.as_str()) == Some("system")
                    && msg.get("subtype").and_then(|v| v.as_str()) == Some("init")
                {
                    if let Some(sid) = msg.get("session_id").and_then(|v| v.as_str()) {
                        if let Ok(mut guard) = session_id_stdout.lock() {
                            *guard = Some(sid.to_string());
                        }
                    }
                }
            }

            // Emit output event to this window with tab_id
            let _ = win_stdout.emit(
                "claude-output",
                ClaudeOutputEvent {
                    tab_id: tab_id_stdout.clone(),
                    data: line,
                },
            );
        }
        eprintln!(
            "[claude-stdout] [{}] stream ended after {} lines ({:.1}s)",
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
                "[claude-stderr] [{}] +{:.1}s {}",
                tab_id_stderr,
                start_time.elapsed().as_secs_f64(),
                &line[..line.len().min(200)]
            );
            let _ = win_stderr.emit(
                "claude-error",
                ClaudeErrorEvent {
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
                        "[claude-process] [{}] exited with status={} ({:.1}s)",
                        tab_id_wait,
                        status,
                        start_time.elapsed().as_secs_f64()
                    );
                    status.success()
                }
                Err(e) => {
                    eprintln!(
                        "[claude-process] [{}] wait error: {} ({:.1}s)",
                        tab_id_wait,
                        e,
                        start_time.elapsed().as_secs_f64()
                    );
                    false
                }
            }
        } else {
            eprintln!(
                "[claude-process] [{}] no child found in map ({:.1}s)",
                tab_id_wait,
                start_time.elapsed().as_secs_f64()
            );
            false
        };
        drop(processes);

        // Emit completion event to this window with tab_id
        let _ = win_wait.emit(
            "claude-complete",
            ClaudeCompleteEvent {
                tab_id: tab_id_wait,
                success,
            },
        );
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
    /// Windows only: true when Git for Windows (git-bash) is not found.
    /// Claude Code requires git-bash to function on Windows.
    pub missing_git: bool,
}

/// Find the path to git-bash on Windows.
/// Returns `Some(path)` if found, `None` otherwise.
/// Used by both `create_command` (to set the env var) and `check_claude_status` (to report status).
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

#[tauri::command]
pub async fn check_claude_status() -> Result<ClaudeStatus, String> {
    // On Windows, check for Git for Windows first — Claude Code requires it.
    #[cfg(target_os = "windows")]
    let missing_git = find_git_bash().is_none();
    #[cfg(not(target_os = "windows"))]
    let missing_git = false;

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
                missing_git,
            });
        }
    };

    // Verify binary actually works by running --version
    let version_output = new_sync_command(&binary_path).arg("--version").output();

    let version = match version_output {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        _ => {
            // Binary found but doesn't work — on Windows this is often because
            // Git for Windows is missing (Claude Code needs git-bash).
            return Ok(ClaudeStatus {
                installed: false,
                authenticated: false,
                binary_path: None,
                version: None,
                account_email: None,
                missing_git,
            });
        }
    };

    // Check auth status
    let auth_output = new_sync_command(&binary_path)
        .args(["auth", "status"])
        .output();

    let (authenticated, account_email) = match auth_output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            // Parse for email — claude auth status outputs account info
            let email = stdout.lines().find(|line| line.contains('@')).map(|line| {
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
        missing_git,
    })
}

/// Return the list of directories the Claude Code installer needs.
#[cfg(not(target_os = "windows"))]
fn claude_required_dirs(home: &std::path::Path) -> Vec<PathBuf> {
    vec![
        home.join(".local").join("bin"),
        home.join(".local").join("share").join("claude"),
        home.join(".local").join("state").join("claude"),
        home.join(".claude"),
    ]
}

/// Try to create all required directories without elevation.
/// Returns Ok(true) if all succeeded, Ok(false) if any failed.
#[cfg(not(target_os = "windows"))]
fn try_create_dirs(dirs: &[PathBuf]) -> bool {
    dirs.iter().all(|dir| std::fs::create_dir_all(dir).is_ok())
}

/// Verify that all directories exist and are writable.
#[cfg(not(target_os = "windows"))]
fn verify_dirs_writable(dirs: &[PathBuf]) -> Result<(), String> {
    for dir in dirs {
        if !dir.exists() {
            return Err(format!(
                "Directory {} does not exist. \
                 Please run: sudo chown -R $(whoami) ~/.local",
                dir.display()
            ));
        }
        let test_file = dir.join(".prism_write_test");
        match std::fs::write(&test_file, "test") {
            Ok(_) => {
                let _ = std::fs::remove_file(&test_file);
            }
            Err(_) => {
                return Err(format!(
                    "Directory {} exists but is not writable. \
                     Please run: sudo chown -R $(whoami) ~/.local",
                    dir.display()
                ));
            }
        }
    }
    Ok(())
}

/// Build the shell script for elevated directory creation + chown.
#[cfg(not(target_os = "windows"))]
fn build_elevation_script(dirs: &[PathBuf], user: &str, local_dir: &std::path::Path) -> String {
    let dirs_list = dirs
        .iter()
        .map(|d| format!("'{}'", d.display()))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "mkdir -p {} && chown -R {} '{}'",
        dirs_list,
        user,
        local_dir.display()
    )
}

/// Ensure ~/.local/{bin,share/claude,state/claude} and ~/.claude exist and are writable.
/// If creation fails (e.g. ~/.local is owned by root), prompt for admin password via osascript.
#[cfg(not(target_os = "windows"))]
async fn ensure_local_dirs(window: &WebviewWindow) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let required_dirs = claude_required_dirs(&home);

    // Try without elevation first
    if try_create_dirs(&required_dirs) {
        return Ok(());
    }

    // Need elevation — use osascript directly for reliability
    let user = std::env::var("USER").unwrap_or_default();
    let local_dir = home.join(".local");
    let script = build_elevation_script(&required_dirs, &user, &local_dir);

    let _ = window.emit(
        "install-output",
        "Requesting admin privileges to fix directory permissions...",
    );

    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            &format!(
                "do shell script \"{}\" with administrator privileges",
                script
            ),
        ])
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to fix directory permissions. Error: {}. \
             You can fix this manually by running: sudo chown -R $(whoami) ~/.local",
            stderr.trim()
        ));
    }

    // Verify directories are now writable
    verify_dirs_writable(&required_dirs)
}

#[tauri::command]
pub async fn install_claude_cli(window: WebviewWindow) -> Result<(), String> {
    // Ensure directories that the Claude Code installer expects exist.
    // The installer fails with EACCES if ~/.local is owned by root
    // (e.g. created by pip or another tool).
    #[cfg(not(target_os = "windows"))]
    {
        ensure_local_dirs(&window).await?;
    }

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {

        let mut c = tokio::process::Command::new("powershell");
        c.creation_flags(CREATE_NO_WINDOW);
        c.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://claude.ai/install.ps1 | iex",
        ]);
        c
    };
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    // On Linux AppImage, restore original environment so curl/bash work correctly
    #[cfg(target_os = "linux")]
    sanitize_appimage_env(&mut cmd);

    // Inherit essential environment variables, ensuring ~/.local/bin is in PATH
    #[cfg(target_os = "windows")]
    let path_sep = ";";
    #[cfg(not(target_os = "windows"))]
    let path_sep = ":";
    for (key, value) in std::env::vars() {
        if key.eq_ignore_ascii_case("PATH") {
            // Prepend ~/.local/bin so the installer sees it in PATH
            if let Some(home) = dirs::home_dir() {
                let local_bin = home.join(".local").join("bin");
                let local_bin_str = local_bin.to_string_lossy();
                if !value.contains(local_bin_str.as_ref()) {
                    cmd.env("PATH", format!("{}{}{}", local_bin_str, path_sep, value));
                } else {
                    cmd.env("PATH", &value);
                }
            } else {
                cmd.env("PATH", &value);
            }
        } else if is_essential_env_var(&key) {
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
            let clean = strip_ansi(&line);
            let _ = win_stdout.emit("install-output", clean.as_ref());
        }
    });

    // Stream stderr
    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let clean = strip_ansi(&line);
            let _ = win_stderr.emit("install-error", clean.as_ref());
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
    let binary_path = find_claude_binary().map_err(|e| format!("Claude CLI not found: {}", e))?;

    // Verify it actually exists
    let version_check = new_sync_command(&binary_path).arg("--version").output();

    if !version_check.as_ref().is_ok_and(|o| o.status.success()) {
        return Err("Claude CLI is not properly installed".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {

        let (resolved, prefix) = resolve_cmd_to_node(&binary_path);
        let mut c = tokio::process::Command::new(&resolved);
        c.creation_flags(CREATE_NO_WINDOW);
        if !prefix.is_empty() {
            c.args(&prefix);
        }
        c.args(["auth", "login"]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new(&binary_path);
        c.args(["auth", "login"]);
        c
    };
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    // On Linux AppImage, restore original environment so xdg-open works
    #[cfg(target_os = "linux")]
    sanitize_appimage_env(&mut cmd);

    // Inherit essential environment variables
    for (key, value) in std::env::vars() {
        if key.eq_ignore_ascii_case("PATH") || is_essential_env_var(&key) {
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
            let clean = strip_ansi(&line);
            let _ = win_stdout.emit("login-output", clean.as_ref());
        }
    });

    // Stream stderr
    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let clean = strip_ansi(&line);
            let _ = win_stderr.emit("login-error", clean.as_ref());
        }
    });

    // Wait for completion with a timeout.
    // If the browser fails to open (e.g. no default browser, AppImage env issues),
    // the CLI can hang indefinitely waiting for auth callback.
    let win_complete = window;
    let child = Arc::new(Mutex::new(child));
    let child_for_timeout = child.clone();
    tokio::spawn(async move {
        let timeout_duration = tokio::time::Duration::from_secs(120);
        let wait_result = tokio::time::timeout(timeout_duration, async {
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            child.lock().await.wait().await
        })
        .await;

        let success = match wait_result {
            Ok(Ok(status)) => status.success(),
            Ok(Err(_)) => false,
            Err(_) => {
                // Timeout — kill the stuck process
                let _ = child_for_timeout.lock().await.kill().await;
                false
            }
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

    let mut args = vec!["-p".to_string(), prompt];
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

    let mut args = vec!["-c".to_string(), "-p".to_string(), prompt];
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

    let mut args = vec!["--resume".to_string(), session_id, "-p".to_string(), prompt];
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m);
    }
    args.extend(common_claude_args());

    let cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    spawn_claude_process(window, cmd, tab_id).await
}

#[tauri::command]
pub async fn cancel_claude_execution(window: WebviewWindow, tab_id: String) -> Result<(), String> {
    let window_label = window.label().to_string();
    let process_key = format!("{}:{}", window_label, tab_id);
    let claude_state = window.state::<ClaudeProcessState>();
    let mut processes = claude_state.processes.lock().await;
    if let Some(mut child) = processes.remove(&process_key) {
        let _ = child.kill().await;
        let _ = window.emit(
            "claude-complete",
            ClaudeCompleteEvent {
                tab_id,
                success: false,
            },
        );
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
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;

    let encoded: String = project_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();

    eprintln!(
        "[session] project_path={} encoded={}",
        project_path, encoded
    );

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

        if msg.get("type").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }

        let content_val = msg.get("message").and_then(|m| m.get("content"));
        let content_val = match content_val {
            Some(v) => v,
            None => continue,
        };
        let timestamp = msg
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

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
pub async fn list_claude_sessions(project_path: String) -> Result<Vec<ClaudeSessionInfo>, String> {
    eprintln!(
        "[session] list_claude_sessions called with project_path={}",
        project_path
    );
    let sessions_dir = get_sessions_dir(&project_path)?;
    eprintln!(
        "[session] sessions_dir={:?} exists={}",
        sessions_dir,
        sessions_dir.exists()
    );

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
            .map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64
            })
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
        eprintln!(
            "[session]   id={} title={} modified={}",
            s.session_id, s.title, s.last_modified
        );
    }

    Ok(sessions)
}

/// Load the full JSONL history for a specific session.
#[tauri::command]
pub async fn load_session_history(
    project_path: String,
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    eprintln!(
        "[session] load_session_history called: session_id={} project_path={}",
        session_id, project_path
    );
    let sessions_dir = get_sessions_dir(&project_path)?;
    let session_path = sessions_dir.join(format!("{}.jsonl", session_id));
    eprintln!(
        "[session] session_path={:?} exists={}",
        session_path,
        session_path.exists()
    );

    if !session_path.exists() {
        return Err(format!("Session file not found: {}", session_id));
    }

    let file = std::fs::File::open(&session_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;

    let reader = std::io::BufReader::new(file);
    use std::io::BufRead;
    let mut messages = Vec::new();

    for line in reader.lines().map_while(Result::ok) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
            messages.push(json);
        }
    }

    eprintln!(
        "[session] loaded {} messages from session {}",
        messages.len(),
        session_id
    );

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
pub async fn run_shell_command(command: String, cwd: String) -> Result<ShellCommandResult, String> {
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
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;
    let settings: serde_json::Value =
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
    Ok(settings
        .get("fastMode")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
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
    std::fs::write(&path, content).map_err(|e| format!("Failed to write settings: {}", e))?;

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
        assert_eq!(
            clean_user_message_title("<local-command-stdout>output"),
            None
        );
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
        let prompt_idx = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
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

    // --- claude_required_dirs ---

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_claude_required_dirs_has_all_paths() {
        let home = PathBuf::from("/Users/test");
        let dirs = claude_required_dirs(&home);
        assert_eq!(dirs.len(), 4);
        assert!(dirs.contains(&home.join(".local").join("bin")));
        assert!(dirs.contains(&home.join(".local").join("share").join("claude")));
        assert!(dirs.contains(&home.join(".local").join("state").join("claude")));
        assert!(dirs.contains(&home.join(".claude")));
    }

    #[test]
    fn test_unix_claude_candidate_paths_include_pnpm_locations() {
        let home = PathBuf::from("/Users/test");
        let paths = unix_claude_candidate_paths(
            &home,
            Some(std::ffi::OsString::from("/custom/pnpm")),
        );
        assert!(paths.contains(&PathBuf::from("/custom/pnpm").join("claude")));
        assert!(paths.contains(&home.join("Library").join("pnpm").join("claude")));
        assert!(paths.contains(&home.join(".local").join("share").join("pnpm").join("claude")));
        assert!(paths.contains(&home.join(".pnpm").join("claude")));
        assert!(paths.contains(&home.join(".claude").join("local").join("claude")));
    }

    #[test]
    fn test_unix_claude_path_from_bin_dir_appends_claude() {
        assert_eq!(
            unix_claude_path_from_bin_dir("/custom/bin"),
            PathBuf::from("/custom/bin").join("claude")
        );
    }

    #[test]
    fn test_unix_claude_path_from_npm_prefix_appends_bin_claude() {
        assert_eq!(
            unix_claude_path_from_npm_prefix("/custom/prefix"),
            PathBuf::from("/custom/prefix").join("bin").join("claude")
        );
    }

    #[test]
    fn test_unix_known_pnpm_claude_paths_include_known_layouts() {
        let home = PathBuf::from("/Users/test");
        let paths = unix_known_pnpm_claude_paths(&home);
        assert!(paths.contains(&home.join("Library").join("pnpm").join("claude")));
        assert!(paths.contains(
            &home
                .join("Library")
                .join("pnpm")
                .join("global")
                .join("bin")
                .join("claude")
        ));
        assert!(paths.contains(&home.join(".local").join("share").join("pnpm").join("claude")));
        assert!(paths.contains(
            &home
                .join(".local")
                .join("share")
                .join("pnpm")
                .join("global")
                .join("bin")
                .join("claude")
        ));
        assert!(paths.contains(&home.join(".pnpm").join("claude")));
        assert!(paths.contains(
            &home.join(".pnpm").join("global").join("bin").join("claude")
        ));
    }

    #[test]
    fn test_unix_extra_tool_dirs_include_pnpm_dirs() {
        let home = PathBuf::from("/Users/test");
        let dirs = unix_extra_tool_dirs(&home, Some(std::ffi::OsString::from("/custom/pnpm")));
        assert_eq!(dirs.first(), Some(&PathBuf::from("/custom/pnpm")));
        assert!(dirs.contains(&home.join("Library").join("pnpm")));
        assert!(dirs.contains(&home.join("Library").join("pnpm").join("global").join("bin")));
        assert!(dirs.contains(&home.join(".local").join("share").join("pnpm")));
        assert!(dirs.contains(
            &home
                .join(".local")
                .join("share")
                .join("pnpm")
                .join("global")
                .join("bin")
        ));
        assert!(dirs.contains(&home.join(".pnpm")));
        assert!(dirs.contains(&home.join(".pnpm").join("global").join("bin")));
    }

    // --- try_create_dirs ---

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_try_create_dirs_succeeds_in_temp() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = vec![tmp.path().join("a").join("b"), tmp.path().join("c")];
        assert!(try_create_dirs(&dirs));
        assert!(dirs[0].exists());
        assert!(dirs[1].exists());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_try_create_dirs_fails_for_invalid_path() {
        let dirs = vec![PathBuf::from("/nonexistent_root_path/test/dir")];
        assert!(!try_create_dirs(&dirs));
    }

    // --- verify_dirs_writable ---

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_verify_dirs_writable_success() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = vec![tmp.path().to_path_buf()];
        assert!(verify_dirs_writable(&dirs).is_ok());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_verify_dirs_writable_nonexistent() {
        let dirs = vec![PathBuf::from("/tmp/nonexistent_dir_prism_test_12345")];
        let result = verify_dirs_writable(&dirs);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_verify_dirs_writable_cleans_up_test_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = vec![tmp.path().to_path_buf()];
        verify_dirs_writable(&dirs).unwrap();
        // The .prism_write_test file should be cleaned up
        assert!(!tmp.path().join(".prism_write_test").exists());
    }

    // --- build_elevation_script ---

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_build_elevation_script_format() {
        let dirs = vec![
            PathBuf::from("/Users/test/.local/bin"),
            PathBuf::from("/Users/test/.claude"),
        ];
        let script = build_elevation_script(
            &dirs,
            "testuser",
            std::path::Path::new("/Users/test/.local"),
        );
        assert!(script.contains("mkdir -p"));
        assert!(script.contains("'/Users/test/.local/bin'"));
        assert!(script.contains("'/Users/test/.claude'"));
        assert!(script.contains("chown -R testuser"));
        assert!(script.contains("'/Users/test/.local'"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_build_elevation_script_handles_spaces_in_path() {
        let dirs = vec![PathBuf::from("/Users/my user/.local/bin")];
        let script = build_elevation_script(
            &dirs,
            "myuser",
            std::path::Path::new("/Users/my user/.local"),
        );
        // Paths are single-quoted to handle spaces
        assert!(script.contains("'/Users/my user/.local/bin'"));
        assert!(script.contains("'/Users/my user/.local'"));
    }
}
