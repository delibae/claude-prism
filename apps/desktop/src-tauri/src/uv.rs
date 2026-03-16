use std::path::PathBuf;
use tauri::{Emitter, WebviewWindow};
use tokio::io::{AsyncBufReadExt, BufReader};

/// Windows CREATE_NO_WINDOW flag to prevent console windows from flashing
/// when spawning child processes (e.g. uv, powershell, python).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ─── Binary Discovery ───

/// Discover the uv binary on the system.
/// Checks: which → cargo bin → standard paths → bare fallback.
fn find_uv_binary() -> Result<String, String> {
    // 1. Try to find uv on PATH
    if let Ok(path) = which::which("uv") {
        return Ok(path.to_string_lossy().to_string());
    }

    // 2. Check user-specific paths
    if let Some(home) = dirs::home_dir() {
        #[cfg(not(target_os = "windows"))]
        let user_paths = vec![
            home.join(".cargo").join("bin").join("uv"),
            home.join(".local").join("bin").join("uv"),
        ];
        #[cfg(target_os = "windows")]
        let user_paths = vec![
            // uv's default install location (same as Claude Code)
            home.join(".local").join("bin").join("uv.exe"),
            home.join(".cargo").join("bin").join("uv.exe"),
            // %LOCALAPPDATA%\uv\bin\uv.exe
            PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
                home.join("AppData")
                    .join("Local")
                    .to_string_lossy()
                    .to_string()
            }))
            .join("uv")
            .join("bin")
            .join("uv.exe"),
        ];

        for path in &user_paths {
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    // 3. Check standard paths (Unix only)
    #[cfg(not(target_os = "windows"))]
    {
        let standard_paths = ["/usr/local/bin/uv", "/opt/homebrew/bin/uv", "/usr/bin/uv"];
        for path in &standard_paths {
            if PathBuf::from(path).exists() {
                return Ok(path.to_string());
            }
        }
    }

    // 4. Bare fallback — hope it's in PATH
    Ok("uv".to_string())
}

// ─── Status Types ───

#[derive(serde::Serialize)]
pub struct UvStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
}

#[derive(serde::Serialize)]
pub struct VenvInfo {
    pub venv_path: String,
    pub python_path: String,
    pub created: bool,
}

#[derive(serde::Serialize)]
pub struct UvCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

// ─── Helper: build PATH with venv bin prepended ───

fn venv_bin_dir(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(not(target_os = "windows"))]
    {
        venv_dir.join("bin")
    }
    #[cfg(target_os = "windows")]
    {
        venv_dir.join("Scripts")
    }
}

fn venv_python(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(not(target_os = "windows"))]
    {
        venv_bin_dir(venv_dir).join("python")
    }
    #[cfg(target_os = "windows")]
    {
        venv_bin_dir(venv_dir).join("python.exe")
    }
}

fn path_with_venv(venv_dir: &std::path::Path) -> String {
    let bin = venv_bin_dir(venv_dir);
    let current = std::env::var("PATH").unwrap_or_default();
    #[cfg(target_os = "windows")]
    let sep = ";";
    #[cfg(not(target_os = "windows"))]
    let sep = ":";
    format!("{}{}{}", bin.to_string_lossy(), sep, current)
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn check_uv_status() -> Result<UvStatus, String> {
    let binary_path = match find_uv_binary() {
        Ok(path) => path,
        Err(_) => {
            return Ok(UvStatus {
                installed: false,
                binary_path: None,
                version: None,
            });
        }
    };

    // Verify binary actually works by running --version
    let mut version_cmd = std::process::Command::new(&binary_path);
    version_cmd.arg("--version");
    #[cfg(target_os = "windows")]
    {

        version_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let version_output = version_cmd.output();

    let version = match version_output {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        _ => {
            return Ok(UvStatus {
                installed: false,
                binary_path: None,
                version: None,
            });
        }
    };

    Ok(UvStatus {
        installed: true,
        binary_path: Some(binary_path),
        version,
    })
}

#[tauri::command]
pub async fn install_uv(window: WebviewWindow) -> Result<(), String> {
    // Ensure ~/.local/bin exists — uv installs its binary there.
    // If ~/.local is owned by root (e.g. created by pip), prompt for admin password.
    #[cfg(not(target_os = "windows"))]
    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local").join("bin");
        if std::fs::create_dir_all(&local_bin).is_err() {
            let user = std::env::var("USER").unwrap_or_default();
            let local_dir = home.join(".local");
            let script = format!(
                "mkdir -p '{}' && chown -R {} '{}'",
                local_bin.display(),
                user,
                local_dir.display()
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
                .map_err(|e| format!("Failed to fix permissions for ~/.local: {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "Failed to create ~/.local/bin: {}. \
                     Please run: sudo chown -R $(whoami) ~/.local",
                    stderr.trim()
                ));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]);
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
            "irm https://astral.sh/uv/install.ps1 | iex",
        ]);
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
            // Windows-essential variables
            || key == "USERPROFILE"
            || key == "LOCALAPPDATA"
            || key == "APPDATA"
            || key == "TEMP"
            || key == "TMP"
            || key == "SystemRoot"
            || key == "WINDIR"
            || key == "PROGRAMFILES"
            || key == "PROGRAMFILES(X86)"
            || key == "COMMONPROGRAMFILES"
            || key == "SystemDrive"
            || key == "COMPUTERNAME"
            || key == "USERNAME"
        {
            cmd.env(&key, &value);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run uv installer: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    // Stream stdout
    let win_stdout = window.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stdout.emit("uv-install-output", &line);
        }
    });

    // Stream stderr
    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stderr.emit("uv-install-output", &line);
        }
    });

    // Wait for completion
    let win_complete = window;
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let success = match child.wait().await {
            Ok(status) => status.success(),
            Err(_) => false,
        };

        let _ = win_complete.emit("uv-install-complete", success);
    });

    Ok(())
}

#[tauri::command]
pub async fn setup_project_venv(project_path: String) -> Result<VenvInfo, String> {
    let project = std::path::Path::new(&project_path);
    let venv_dir = project.join(".venv");

    // If venv already exists, just return info
    if venv_dir.exists() {
        let python = venv_python(&venv_dir);
        return Ok(VenvInfo {
            venv_path: venv_dir.to_string_lossy().to_string(),
            python_path: python.to_string_lossy().to_string(),
            created: false,
        });
    }

    let uv_bin = find_uv_binary().map_err(|e| format!("uv not found: {}", e))?;

    // Create venv: uv venv <project_path>/.venv
    let mut venv_cmd = tokio::process::Command::new(&uv_bin);
    venv_cmd.args(["venv", &venv_dir.to_string_lossy()]);
    venv_cmd.current_dir(project);
    #[cfg(target_os = "windows")]
    {

        venv_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = venv_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to create venv: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("uv venv failed: {}", stderr));
    }

    let python = venv_python(&venv_dir);

    Ok(VenvInfo {
        venv_path: venv_dir.to_string_lossy().to_string(),
        python_path: python.to_string_lossy().to_string(),
        created: true,
    })
}

#[tauri::command]
pub async fn uv_add_packages(
    packages: Vec<String>,
    project_path: String,
) -> Result<String, String> {
    let uv_bin = find_uv_binary().map_err(|e| format!("uv not found: {}", e))?;
    let venv_dir = std::path::Path::new(&project_path).join(".venv");

    if !venv_dir.exists() {
        return Err("No .venv found. Run setup_project_venv first.".to_string());
    }

    let mut args = vec!["pip".to_string(), "install".to_string()];
    args.extend(packages);

    let mut pip_cmd = tokio::process::Command::new(&uv_bin);
    pip_cmd.args(&args);
    pip_cmd.current_dir(&project_path);
    pip_cmd.env("VIRTUAL_ENV", &venv_dir);
    pip_cmd.env("PATH", path_with_venv(&venv_dir));
    #[cfg(target_os = "windows")]
    {

        pip_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = pip_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run uv pip install: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("uv pip install failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(stdout)
}

#[tauri::command]
pub async fn uv_run_command(
    command: String,
    project_path: String,
) -> Result<UvCommandResult, String> {
    let venv_dir = std::path::Path::new(&project_path).join(".venv");

    if !venv_dir.exists() {
        return Err("No .venv found. Run setup_project_venv first.".to_string());
    }

    // Split command into program + args
    let parts: Vec<&str> = command.split_whitespace().collect();
    if parts.is_empty() {
        return Err("Empty command".to_string());
    }

    let program = parts.first().ok_or("Empty command")?;
    let args = parts.get(1..).unwrap_or_default();

    let mut run_cmd = tokio::process::Command::new(program);
    run_cmd.args(args);
    run_cmd.current_dir(&project_path);
    run_cmd.env("VIRTUAL_ENV", &venv_dir);
    run_cmd.env("PATH", path_with_venv(&venv_dir));
    #[cfg(target_os = "windows")]
    {

        run_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = run_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run command: {}", e))?;

    let exit_code = output.status.code().unwrap_or(-1);

    Ok(UvCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code,
    })
}
