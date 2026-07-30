use crate::anthropic_proxy::{start_openai_anthropic_proxy, OpenAiProxyCredential};
pub use crate::claude_process::{kill_process_for_window, ClaudeProcessState};
use crate::claude_process::{
    spawn_claude_process, stop_claude_process, ClaudeStopMode, SpawnProviderMetadata,
};
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, WebviewWindow};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
struct ClaudePrismAuthConfig {
    provider: Option<String>,
    anthropic_api_key: Option<String>,
    anthropic_base_url: Option<String>,
    openai_api_key: Option<String>,
    openai_base_url: Option<String>,
    openai_model: Option<String>,
    active_openai_credential_id: Option<String>,
    openai_credentials: Vec<StoredOpenAiCompatibleCredentialConfig>,
}

struct StoredClaudeCredential {
    api_key: String,
    base_url: Option<String>,
}

#[derive(Clone, Debug)]
struct StoredOpenAiCompatibleCredential {
    id: String,
    label: String,
    api_key: String,
    base_url: String,
    model: String,
    transformers: Vec<String>,
    model_transformers: HashMap<String, Vec<String>>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct StoredOpenAiCompatibleCredentialConfig {
    id: String,
    label: String,
    api_key: String,
    base_url: String,
    model: String,
    #[serde(default)]
    transformers: Vec<String>,
    #[serde(default)]
    model_transformers: HashMap<String, Vec<String>>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct OpenAiCompatibleCredentialInfo {
    id: String,
    label: String,
    base_url: String,
    model: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct OpenAiCompatibleModelInfo {
    id: String,
    metadata: Value,
}

const PROVIDER_CLAUDE_CODE: &str = "claude-code";
const PROVIDER_OPENAI_COMPATIBLE: &str = "openai-compatible";
const MOONSHOT_OFFICIAL_ORIGIN: &str = "https://api.moonshot.ai";

/// Check if an environment variable should be explicitly passed to child processes.
///
/// NOTE: This is NOT a true whitelist 鈥?we do NOT call `env_clear()`, so the
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
        | "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN"
        | "ANTHROPIC_BASE_URL"
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

fn normalize_proxy_url_with_default(raw: &str, default_scheme: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.contains("://") {
        Some(trimmed.to_string())
    } else {
        Some(format!("{}://{}", default_scheme, trimmed))
    }
}

fn normalize_proxy_url(raw: &str) -> Option<String> {
    normalize_proxy_url_with_default(raw, "http")
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProxyEnvVar {
    key: &'static str,
    value: String,
    source: String,
}

fn first_env_value(names: &[&str]) -> Option<(String, String)> {
    for name in names {
        let Ok(value) = std::env::var(name) else {
            continue;
        };
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(((*name).to_string(), trimmed.to_string()));
        }
    }

    None
}

fn explicit_proxy_env_vars() -> Vec<ProxyEnvVar> {
    let mut vars = Vec::new();
    let mut has_https_proxy = false;
    let mut has_all_proxy = false;
    let mut http_proxy = None;

    if let Some((source, raw)) = first_env_value(&["HTTPS_PROXY", "https_proxy"]) {
        if let Some(value) = normalize_proxy_url(&raw) {
            vars.push(ProxyEnvVar {
                key: "HTTPS_PROXY",
                value,
                source,
            });
            has_https_proxy = true;
        }
    }

    if let Some((source, raw)) = first_env_value(&["HTTP_PROXY", "http_proxy"]) {
        if let Some(value) = normalize_proxy_url(&raw) {
            http_proxy = Some((source.clone(), value.clone()));
            vars.push(ProxyEnvVar {
                key: "HTTP_PROXY",
                value,
                source,
            });
        }
    }

    if let Some((source, raw)) = first_env_value(&["ALL_PROXY", "all_proxy"]) {
        if let Some(value) = normalize_proxy_url(&raw) {
            vars.push(ProxyEnvVar {
                key: "ALL_PROXY",
                value,
                source,
            });
            has_all_proxy = true;
        }
    }

    if !has_https_proxy && !has_all_proxy {
        if let Some((source, value)) = http_proxy {
            vars.insert(
                0,
                ProxyEnvVar {
                    key: "HTTPS_PROXY",
                    value,
                    source: format!("{} (HTTPS fallback)", source),
                },
            );
        }
    }

    vars
}

#[cfg(target_os = "windows")]
fn windows_proxy_override_to_no_proxy_env(raw: &str) -> Option<String> {
    let entries = raw
        .split([';', ','])
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                return None;
            }

            if trimmed.eq_ignore_ascii_case("<local>") {
                return Some("localhost,127.0.0.1,::1".to_string());
            }

            if trimmed == "*" {
                return Some(trimmed.to_string());
            }

            if trimmed.contains('*') {
                return trimmed
                    .strip_prefix("*.")
                    .map(|domain| format!(".{}", domain.trim_start_matches('.')));
            }

            Some(trimmed.to_string())
        })
        .collect::<Vec<_>>();

    if entries.is_empty() {
        None
    } else {
        Some(entries.join(","))
    }
}

#[cfg(target_os = "windows")]
fn windows_system_no_proxy_env() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let raw = settings.get_value::<String, _>("ProxyOverride").ok()?;
    windows_proxy_override_to_no_proxy_env(&raw)
}

#[cfg(target_os = "windows")]
fn parse_windows_proxy_server_for_env(raw: &str) -> Vec<ProxyEnvVar> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    if !trimmed.contains('=') {
        let Some(value) = normalize_proxy_url(trimmed) else {
            return Vec::new();
        };
        return vec![
            ProxyEnvVar {
                key: "HTTPS_PROXY",
                value: value.clone(),
                source: "Windows system proxy".to_string(),
            },
            ProxyEnvVar {
                key: "HTTP_PROXY",
                value: value.clone(),
                source: "Windows system proxy".to_string(),
            },
            ProxyEnvVar {
                key: "ALL_PROXY",
                value,
                source: "Windows system proxy".to_string(),
            },
        ];
    }

    let mut vars = Vec::new();
    let mut has_https_proxy = false;
    let mut has_all_proxy = false;
    let mut http_proxy = None;

    for entry in trimmed.split(';') {
        let Some((scheme, value)) = entry.split_once('=') else {
            continue;
        };
        let scheme = scheme.trim();
        let (key, default_proxy_scheme) = match scheme.to_ascii_lowercase().as_str() {
            "http" => ("HTTP_PROXY", "http"),
            "https" => ("HTTPS_PROXY", "http"),
            "socks" | "socks5" => ("ALL_PROXY", "socks5"),
            "socks4" => ("ALL_PROXY", "socks4"),
            _ => continue,
        };
        let Some(value) = normalize_proxy_url_with_default(value, default_proxy_scheme) else {
            continue;
        };
        let source = format!("Windows system proxy ({})", scheme);

        if key == "HTTP_PROXY" {
            http_proxy = Some((source.clone(), value.clone()));
        } else if key == "HTTPS_PROXY" {
            has_https_proxy = true;
        } else if key == "ALL_PROXY" {
            has_all_proxy = true;
        }

        vars.push(ProxyEnvVar { key, value, source });
    }

    if !has_https_proxy && !has_all_proxy {
        if let Some((source, value)) = http_proxy {
            vars.insert(
                0,
                ProxyEnvVar {
                    key: "HTTPS_PROXY",
                    value,
                    source: format!("{} (HTTPS fallback)", source),
                },
            );
        }
    }

    vars
}

#[cfg(target_os = "windows")]
fn windows_system_proxy_env_vars() -> Vec<ProxyEnvVar> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Ok(settings) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    else {
        return Vec::new();
    };

    let proxy_enabled = settings.get_value::<u32, _>("ProxyEnable").unwrap_or(0) != 0;
    if !proxy_enabled {
        return Vec::new();
    }

    settings
        .get_value::<String, _>("ProxyServer")
        .map(|raw| parse_windows_proxy_server_for_env(&raw))
        .unwrap_or_default()
}

#[cfg(not(target_os = "windows"))]
fn windows_system_proxy_env_vars() -> Vec<ProxyEnvVar> {
    Vec::new()
}

#[cfg(not(target_os = "windows"))]
fn windows_system_no_proxy_env() -> Option<String> {
    None
}

fn redacted_proxy_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return "<invalid proxy URL>".to_string();
    };

    if !parsed.username().is_empty() {
        let _ = parsed.set_username("***");
        if parsed.password().is_some() {
            let _ = parsed.set_password(Some("***"));
        }
    }

    parsed.to_string()
}

pub(crate) fn apply_proxy_env_to_command(cmd: &mut Command, window: Option<&WebviewWindow>) {
    let mut vars = explicit_proxy_env_vars();
    let mut no_proxy = first_env_value(&["NO_PROXY", "no_proxy"]).map(|(_, value)| value);

    if vars.is_empty() {
        vars = windows_system_proxy_env_vars();
        if no_proxy.is_none() {
            no_proxy = windows_system_no_proxy_env();
        }
    }

    if vars.is_empty() {
        if let Some(window) = window {
            let _ = window.emit(
                "install-output",
                "Using system proxy settings when available",
            );
        }
        return;
    }

    for var in vars {
        if let Some(window) = window {
            let _ = window.emit(
                "install-output",
                format!(
                    "Using proxy from {}: {}",
                    var.source,
                    redacted_proxy_url(&var.value)
                ),
            );
        }
        cmd.env(var.key, var.value);
    }

    if let Some(no_proxy) = no_proxy {
        cmd.env("NO_PROXY", no_proxy);
    }
}

fn get_claude_prism_auth_path() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir()
        .or_else(dirs::home_dir)
        .ok_or("Could not find config directory")?;
    Ok(config_dir.join("ClaudePrism").join("anthropic-auth.json"))
}

fn read_claude_prism_auth_config() -> Result<ClaudePrismAuthConfig, String> {
    let path = get_claude_prism_auth_path()?;
    if !path.exists() {
        return Ok(ClaudePrismAuthConfig::default());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read auth settings: {}", e))?;
    let content = content.trim_start_matches('\u{feff}');
    let config = serde_json::from_str(content)
        .map_err(|e| format!("Failed to parse auth settings: {}", e))?;
    restrict_auth_file_permissions(&path)?;
    Ok(config)
}

fn restrict_auth_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to lock down auth settings permissions: {}", e))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn backup_corrupt_auth_config(path: &Path, reason: &str) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "anthropic-auth.json".to_string());
    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
    let backup = path.with_file_name(format!("{}.corrupt-{}.bak", file_name, timestamp));
    std::fs::rename(path, &backup)
        .map_err(|e| format!("Failed to back up corrupt auth settings: {}", e))?;
    let _ = restrict_auth_file_permissions(&backup);
    eprintln!(
        "[auth] backed up corrupt auth settings to {}: {}",
        backup.display(),
        reason
    );
    Ok(backup)
}

fn read_claude_prism_auth_config_for_update() -> Result<ClaudePrismAuthConfig, String> {
    match read_claude_prism_auth_config() {
        Ok(config) => Ok(config),
        Err(err) => {
            let path = get_claude_prism_auth_path()?;
            if path.exists() {
                backup_corrupt_auth_config(&path, &err)?;
                Ok(ClaudePrismAuthConfig::default())
            } else {
                Err(err)
            }
        }
    }
}

fn write_claude_prism_auth_config(config: &ClaudePrismAuthConfig) -> Result<(), String> {
    let path = get_claude_prism_auth_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create auth settings dir: {}", e))?;
    }

    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize auth settings: {}", e))?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("Failed to write auth settings: {}", e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write auth settings: {}", e))?;
    file.flush()
        .map_err(|e| format!("Failed to flush auth settings: {}", e))?;
    restrict_auth_file_permissions(&path)
}

fn normalize_api_key(value: &str) -> Result<String, String> {
    let clean = strip_nul(value).trim().to_string();
    if clean.is_empty() {
        return Err("API key is empty".to_string());
    }

    if clean.chars().any(char::is_whitespace) {
        return Err("API key cannot contain spaces or line breaks".to_string());
    }

    Ok(clean)
}

fn normalize_optional_api_key(value: &str) -> Result<String, String> {
    let clean = strip_nul(value).trim().to_string();
    if clean.chars().any(char::is_whitespace) {
        return Err("API key cannot contain spaces or line breaks".to_string());
    }

    Ok(clean)
}

fn normalize_base_url(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };

    let clean = strip_nul(value).trim().trim_end_matches('/').to_string();
    if clean.is_empty() {
        return Ok(None);
    }

    if clean.chars().any(char::is_whitespace) {
        return Err("Base URL cannot contain spaces or line breaks".to_string());
    }

    if !(clean.starts_with("https://") || clean.starts_with("http://")) {
        return Err("Base URL must start with http:// or https://".to_string());
    }

    Ok(Some(clean))
}

fn ensure_secure_known_provider_base_url(base_url: &str) -> Result<(), String> {
    let lower = base_url.to_ascii_lowercase();
    let insecure_known_provider = [
        "http://api.deepseek.com",
        "http://dashscope.aliyuncs.com",
        "http://dashscope-intl.aliyuncs.com",
        "http://api.moonshot.cn",
        "http://api.moonshot.ai",
    ]
    .iter()
    .any(|prefix| lower == *prefix || lower.starts_with(&format!("{}/", prefix)));

    if insecure_known_provider {
        return Err(
            "Known cloud provider endpoints must use https:// to avoid sending API keys in plaintext."
                .to_string(),
        );
    }

    Ok(())
}

fn normalize_provider(value: Option<&str>) -> Result<String, String> {
    let provider = value.unwrap_or(PROVIDER_CLAUDE_CODE).trim();
    match provider {
        "" | PROVIDER_CLAUDE_CODE => Ok(PROVIDER_CLAUDE_CODE.to_string()),
        PROVIDER_OPENAI_COMPATIBLE => Ok(PROVIDER_OPENAI_COMPATIBLE.to_string()),
        other => Err(format!("Unsupported provider: {}", other)),
    }
}

fn normalize_model(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };

    let clean = strip_nul(value).trim().to_string();
    if clean.is_empty() {
        return Ok(None);
    }

    if clean.chars().any(char::is_whitespace) {
        return Err("Model cannot contain spaces or line breaks".to_string());
    }

    Ok(Some(clean))
}

fn normalized_transformer_names(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| strip_nul(value).trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn normalized_model_transformers(
    values: &HashMap<String, Vec<String>>,
) -> HashMap<String, Vec<String>> {
    values
        .iter()
        .filter_map(|(model, transformers)| {
            let model = strip_nul(model).trim().to_string();
            if model.is_empty() {
                return None;
            }
            let transformers = normalized_transformer_names(transformers);
            if transformers.is_empty() {
                None
            } else {
                Some((model, transformers))
            }
        })
        .collect()
}

fn is_claude_model_selector(value: &str) -> bool {
    let model = value.trim().to_ascii_lowercase();
    if model.starts_with("claude") {
        return true;
    }

    matches!(model.as_str(), "sonnet" | "opus" | "haiku" | "opusplan")
}

fn normalize_provider_model_override(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(model) = normalize_model(value)? else {
        return Ok(None);
    };

    if is_claude_model_selector(&model) {
        return Ok(None);
    }

    Ok(Some(model))
}

fn known_proxy_mismatch_error(provider: &str, base_url: Option<&str>) -> Option<String> {
    let lower = base_url?.to_ascii_lowercase();
    if lower.contains("/codex-proxy") {
        return Some(
            "ModelGate codex-proxy uses the OpenAI Responses API, not chat/completions or Claude Code. Use a chat/completions-compatible endpoint for OpenAI-compatible providers, or choose the ModelGate Claude proxy preset for Claude Code."
                .to_string(),
        );
    }

    if provider == PROVIDER_OPENAI_COMPATIBLE && lower.contains("/claude-proxy") {
        return Some(
            "This is a Claude-compatible proxy endpoint. Select Claude Code / Anthropic API and the ModelGate Claude preset instead of OpenAI-compatible API."
                .to_string(),
        );
    }

    None
}

fn stored_claude_credential() -> Option<StoredClaudeCredential> {
    let config = read_claude_prism_auth_config().ok()?;
    stored_claude_credential_from_config(&config)
}

fn stored_claude_credential_from_config(
    config: &ClaudePrismAuthConfig,
) -> Option<StoredClaudeCredential> {
    let api_key = config
        .anthropic_api_key
        .as_deref()
        .and_then(|value| normalize_api_key(value).ok())?;
    let base_url = normalize_base_url(config.anthropic_base_url.as_deref()).ok()?;

    if base_url.is_none() && !api_key.starts_with("sk-ant-") {
        return None;
    }

    Some(StoredClaudeCredential { api_key, base_url })
}

fn stored_openai_compatible_credential_by_id(
    credential_id: Option<&str>,
) -> Result<Option<StoredOpenAiCompatibleCredential>, String> {
    let config = read_claude_prism_auth_config()?;
    openai_compatible_credential_by_id_from_config(&config, credential_id)
}

fn normalized_openai_compatible_credentials(
    config: &ClaudePrismAuthConfig,
) -> Vec<StoredOpenAiCompatibleCredential> {
    let mut credentials = Vec::new();
    for credential in &config.openai_credentials {
        let Ok(api_key) = normalize_optional_api_key(&credential.api_key) else {
            continue;
        };
        let Some(base_url) = normalize_base_url(Some(credential.base_url.as_str()))
            .ok()
            .flatten()
        else {
            continue;
        };
        let Some(model) = normalize_model(Some(credential.model.as_str()))
            .ok()
            .flatten()
        else {
            continue;
        };
        let id = strip_nul(&credential.id).trim().to_string();
        if id.is_empty() {
            continue;
        }
        let label = strip_nul(&credential.label).trim().to_string();
        credentials.push(StoredOpenAiCompatibleCredential {
            id,
            label: if label.is_empty() {
                model.clone()
            } else {
                label
            },
            api_key,
            base_url,
            model,
            transformers: normalized_transformer_names(&credential.transformers),
            model_transformers: normalized_model_transformers(&credential.model_transformers),
        });
    }

    if credentials.is_empty() {
        if let (Some(api_key), Some(base_url), Some(model)) = (
            config
                .openai_api_key
                .as_deref()
                .and_then(|value| normalize_optional_api_key(value).ok()),
            normalize_base_url(config.openai_base_url.as_deref())
                .ok()
                .flatten(),
            normalize_model(config.openai_model.as_deref())
                .ok()
                .flatten(),
        ) {
            credentials.push(StoredOpenAiCompatibleCredential {
                id: "legacy-openai-compatible".to_string(),
                label: model.clone(),
                api_key,
                base_url,
                model,
                transformers: Vec::new(),
                model_transformers: HashMap::new(),
            });
        }
    }

    credentials
}

fn stored_openai_compatible_credential_from_config(
    config: &ClaudePrismAuthConfig,
    credential_id: Option<&str>,
) -> Option<StoredOpenAiCompatibleCredential> {
    let credentials = normalized_openai_compatible_credentials(config);
    if let Some(credential_id) = credential_id {
        if let Some(credential) = credentials
            .iter()
            .find(|credential| credential.id == credential_id)
            .cloned()
        {
            return Some(credential);
        }
    }

    let provider = normalize_provider(config.provider.as_deref()).ok()?;
    if provider != PROVIDER_OPENAI_COMPATIBLE {
        return None;
    }

    if let Some(active_id) = config.active_openai_credential_id.as_deref() {
        if let Some(credential) = credentials
            .iter()
            .find(|credential| credential.id == active_id)
            .cloned()
        {
            return Some(credential);
        }
    }

    credentials.into_iter().next()
}

fn openai_compatible_credential_by_id_from_config(
    config: &ClaudePrismAuthConfig,
    credential_id: Option<&str>,
) -> Result<Option<StoredOpenAiCompatibleCredential>, String> {
    let credential_id = credential_id
        .map(strip_nul)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(credential_id) = credential_id else {
        return Ok(None);
    };

    normalized_openai_compatible_credentials(config)
        .into_iter()
        .find(|credential| credential.id == credential_id)
        .map(Some)
        .ok_or_else(|| "Configured provider credential not found".to_string())
}

fn claude_credential_label() -> Option<&'static str> {
    if std::env::var("ANTHROPIC_API_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        if std::env::var("ANTHROPIC_BASE_URL")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            return Some("External API key");
        }
        return Some("Anthropic API key");
    }

    if std::env::var("ANTHROPIC_AUTH_TOKEN")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return Some("Anthropic auth token");
    }

    if let Some(credential) = stored_claude_credential() {
        return Some(if credential.base_url.is_some() {
            "External API key"
        } else {
            "Anthropic API key"
        });
    }

    None
}

fn claude_credential_env_values(
    credential: &StoredClaudeCredential,
) -> Vec<(&'static str, String)> {
    let mut values = vec![("ANTHROPIC_API_KEY", credential.api_key.clone())];
    if let Some(base_url) = &credential.base_url {
        values.push(("ANTHROPIC_BASE_URL", base_url.clone()));
        values.push(("ANTHROPIC_AUTH_TOKEN", credential.api_key.clone()));
    }
    values
}

#[tauri::command]
pub async fn save_anthropic_api_key(
    api_key: String,
    base_url: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    credential_label: Option<String>,
    credential_id: Option<String>,
) -> Result<(), String> {
    let provider = normalize_provider(provider.as_deref())?;
    let api_key = if provider == PROVIDER_OPENAI_COMPATIBLE {
        normalize_optional_api_key(&api_key)?
    } else {
        normalize_api_key(&api_key)?
    };
    let base_url = normalize_base_url(base_url.as_deref())?;
    let model = normalize_model(model.as_deref())?;
    if let Some(message) = known_proxy_mismatch_error(&provider, base_url.as_deref()) {
        return Err(message);
    }

    // Saving a new key should repair an empty/corrupt legacy auth file after
    // backing it up, never silently discard parseable credentials.
    let mut config = read_claude_prism_auth_config_for_update()?;
    config.provider = Some(provider.clone());

    if provider == PROVIDER_OPENAI_COMPATIBLE {
        let base_url = base_url.ok_or("OpenAI-compatible provider requires a Base URL")?;
        ensure_secure_known_provider_base_url(&base_url)?;
        let model = model.ok_or("OpenAI-compatible provider requires a model")?;
        let label = credential_label
            .as_deref()
            .map(strip_nul)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| model.clone());
        let credential_id = credential_id
            .as_deref()
            .map(strip_nul)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                config
                    .openai_credentials
                    .iter()
                    .find(|credential| {
                        credential.label == label
                            && credential.base_url == base_url
                            && credential.model == model
                    })
                    .map(|credential| credential.id.clone())
            })
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let (transformers, model_transformers) = config
            .openai_credentials
            .iter()
            .find(|item| item.id == credential_id)
            .map(|item| {
                (
                    normalized_transformer_names(&item.transformers),
                    normalized_model_transformers(&item.model_transformers),
                )
            })
            .unwrap_or_else(|| (Vec::new(), HashMap::new()));

        let credential = StoredOpenAiCompatibleCredentialConfig {
            id: credential_id.clone(),
            label,
            api_key: api_key.clone(),
            base_url: base_url.clone(),
            model: model.clone(),
            transformers,
            model_transformers,
        };

        if let Some(existing) = config
            .openai_credentials
            .iter_mut()
            .find(|item| item.id == credential_id)
        {
            *existing = credential;
        } else {
            config.openai_credentials.push(credential);
        }

        config.active_openai_credential_id = Some(credential_id);
        config.openai_api_key = Some(api_key);
        config.openai_base_url = Some(base_url);
        config.openai_model = Some(model);
        return write_claude_prism_auth_config(&config);
    }

    if base_url.is_none() && !api_key.starts_with("sk-ant-") {
        return Err(
            "This looks like an external provider key. Set the provider Base URL, or use an Anthropic key that starts with sk-ant-."
                .to_string(),
        );
    }

    config.anthropic_api_key = Some(api_key);
    config.anthropic_base_url = base_url;
    write_claude_prism_auth_config(&config)
}

#[tauri::command]
pub async fn verify_openai_compatible_api_key(
    api_key: String,
    base_url: String,
    model: String,
) -> Result<(), String> {
    let api_key = normalize_optional_api_key(&api_key)?;
    let base_url = normalize_base_url(Some(base_url.as_str()))?
        .ok_or("OpenAI-compatible provider requires a Base URL")?;
    ensure_secure_known_provider_base_url(&base_url)?;
    if let Some(message) =
        known_proxy_mismatch_error(PROVIDER_OPENAI_COMPATIBLE, Some(base_url.as_str()))
    {
        return Err(message);
    }
    let model = normalize_model(Some(model.as_str()))?
        .ok_or("OpenAI-compatible provider requires a model")?;
    let credential = StoredOpenAiCompatibleCredential {
        id: "verification".to_string(),
        label: model.clone(),
        api_key,
        base_url,
        model,
        transformers: Vec::new(),
        model_transformers: HashMap::new(),
    };

    verify_openai_compatible_credential(&credential).await
}

#[tauri::command]
pub async fn list_openai_compatible_models(
    api_key: String,
    base_url: String,
) -> Result<Vec<OpenAiCompatibleModelInfo>, String> {
    let api_key = normalize_optional_api_key(&api_key)?;
    let base_url = normalize_base_url(Some(base_url.as_str()))?
        .ok_or("OpenAI-compatible provider requires a Base URL")?;
    ensure_secure_known_provider_base_url(&base_url)?;
    if let Some(message) =
        known_proxy_mismatch_error(PROVIDER_OPENAI_COMPATIBLE, Some(base_url.as_str()))
    {
        return Err(message);
    }

    fetch_openai_compatible_models(&api_key, &base_url).await
}

#[tauri::command]
pub async fn list_openai_compatible_credential_models(
    credential_id: String,
) -> Result<Vec<OpenAiCompatibleModelInfo>, String> {
    let config = read_claude_prism_auth_config()?;
    let credential = normalized_openai_compatible_credentials(&config)
        .into_iter()
        .find(|credential| credential.id == credential_id)
        .ok_or("Configured provider credential not found")?;

    fetch_openai_compatible_models(&credential.api_key, &credential.base_url).await
}

#[tauri::command]
pub async fn list_claude_models() -> Result<Vec<OpenAiCompatibleModelInfo>, String> {
    let stored = stored_claude_credential();
    let api_key = stored
        .as_ref()
        .map(|credential| credential.api_key.clone())
        .or_else(|| {
            std::env::var("ANTHROPIC_API_KEY")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("ANTHROPIC_AUTH_TOKEN")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or(
            "The Models API requires an Anthropic API key. Browser sign-in does not expose one to ClaudePrism.",
        )?;
    let base_url = stored
        .and_then(|credential| credential.base_url)
        .or_else(|| {
            std::env::var("ANTHROPIC_BASE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let base_url = normalize_base_url(Some(base_url.as_str()))?
        .ok_or("Claude provider requires a Base URL")?;
    ensure_secure_known_provider_base_url(&base_url)?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|err| format!("Failed to create Claude models client: {}", err))?;
    let request = client
        .get(anthropic_models_url(&base_url))
        .query(&[("limit", "1000")])
        .header("anthropic-version", "2023-06-01");
    let response = with_optional_anthropic_key(request, &api_key)
        .send()
        .await
        .map_err(|err| format!("Failed to fetch Claude models: {}", err))?;
    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read Claude models response: {}", err))?;

    if !status.is_success() {
        return Err(openai_compatible_verification_error(status, &response_text));
    }

    let value: Value = serde_json::from_str(&response_text)
        .map_err(|err| format!("Claude provider returned invalid models JSON: {}", err))?;
    let mut models = value
        .get("data")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("id")
                .and_then(|value| value.as_str())
                .map(|id| OpenAiCompatibleModelInfo {
                    id: id.to_string(),
                    metadata: item.clone(),
                })
        })
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    models.retain(|model| seen.insert(model.id.clone()));
    if models.is_empty() {
        return Err("Claude provider did not return any models.".to_string());
    }

    Ok(models)
}

async fn fetch_openai_compatible_models(
    api_key: &str,
    base_url: &str,
) -> Result<Vec<OpenAiCompatibleModelInfo>, String> {
    ensure_secure_known_provider_base_url(base_url)?;
    let request = reqwest::Client::new().get(openai_models_url(base_url));
    let response = with_optional_bearer_auth(request, api_key)
        .send()
        .await
        .map_err(|err| format!("Failed to fetch provider models: {}", err))?;
    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read provider models response: {}", err))?;

    if !status.is_success() {
        return Err(openai_compatible_verification_error(status, &response_text));
    }

    let value: Value = serde_json::from_str(&response_text)
        .map_err(|err| format!("Provider returned invalid models JSON: {}", err))?;
    let mut models = value
        .get("data")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("id")
                        .and_then(|value| value.as_str())
                        .map(|id| OpenAiCompatibleModelInfo {
                            id: id.to_string(),
                            metadata: item.clone(),
                        })
                        .or_else(|| {
                            item.as_str().map(|id| OpenAiCompatibleModelInfo {
                                id: id.to_string(),
                                metadata: json!({ "id": id }),
                            })
                        })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut seen = HashSet::new();
    models.retain(|model| seen.insert(model.id.clone()));
    if models.is_empty() {
        return Err("Provider did not return any models.".to_string());
    }

    Ok(models)
}

#[tauri::command]
pub async fn clear_anthropic_api_key() -> Result<(), String> {
    // Clearing should also recover from an empty/corrupt legacy auth file after
    // preserving the bad file for manual recovery.
    let mut config = read_claude_prism_auth_config_for_update()?;
    config.provider = Some(PROVIDER_CLAUDE_CODE.to_string());
    config.anthropic_api_key = None;
    config.anthropic_base_url = None;
    config.openai_api_key = None;
    config.openai_base_url = None;
    config.openai_model = None;
    config.active_openai_credential_id = None;
    config.openai_credentials.clear();
    write_claude_prism_auth_config(&config)
}

#[tauri::command]
pub async fn list_openai_compatible_credentials(
) -> Result<Vec<OpenAiCompatibleCredentialInfo>, String> {
    let config = read_claude_prism_auth_config()?;
    Ok(normalized_openai_compatible_credentials(&config)
        .into_iter()
        .map(|credential| OpenAiCompatibleCredentialInfo {
            id: credential.id,
            label: credential.label,
            base_url: credential.base_url,
            model: credential.model,
        })
        .collect())
}

#[tauri::command]
pub async fn delete_openai_compatible_credential(credential_id: String) -> Result<(), String> {
    let credential_id = strip_nul(&credential_id).trim().to_string();
    if credential_id.is_empty() {
        return Err("Provider credential id is empty".to_string());
    }

    let mut config = read_claude_prism_auth_config_for_update()?;
    if credential_id == "legacy-openai-compatible" && config.openai_credentials.is_empty() {
        if config.openai_api_key.is_none()
            && config.openai_base_url.is_none()
            && config.openai_model.is_none()
        {
            return Err("Configured provider credential not found".to_string());
        }
        config.openai_api_key = None;
        config.openai_base_url = None;
        config.openai_model = None;
        config.active_openai_credential_id = None;
        config.provider = Some(PROVIDER_CLAUDE_CODE.to_string());
        return write_claude_prism_auth_config(&config);
    }

    let before_len = config.openai_credentials.len();
    config
        .openai_credentials
        .retain(|credential| credential.id != credential_id);
    if config.openai_credentials.len() == before_len {
        return Err("Configured provider credential not found".to_string());
    }

    let current_provider_is_openai = normalize_provider(config.provider.as_deref())
        .map(|provider| provider == PROVIDER_OPENAI_COMPATIBLE)
        .unwrap_or(false);
    let active_id = config.active_openai_credential_id.as_deref();
    let active_was_deleted = active_id == Some(&credential_id);
    let active_is_missing = current_provider_is_openai
        && active_id
            .map(|id| {
                normalized_openai_compatible_credentials(&config)
                    .iter()
                    .all(|credential| credential.id != id)
            })
            .unwrap_or(true);
    let deleted_active = active_was_deleted || active_is_missing;

    if deleted_active {
        if let Some(next) = config.openai_credentials.first() {
            config.provider = Some(PROVIDER_OPENAI_COMPATIBLE.to_string());
            config.active_openai_credential_id = Some(next.id.clone());
            config.openai_api_key = Some(next.api_key.clone());
            config.openai_base_url = Some(next.base_url.clone());
            config.openai_model = Some(next.model.clone());
        } else {
            config.provider = Some(PROVIDER_CLAUDE_CODE.to_string());
            config.active_openai_credential_id = None;
            config.openai_api_key = None;
            config.openai_base_url = None;
            config.openai_model = None;
        }
    }

    write_claude_prism_auth_config(&config)
}

#[tauri::command]
pub async fn set_active_openai_compatible_credential(credential_id: String) -> Result<(), String> {
    let mut config = read_claude_prism_auth_config_for_update()?;
    let credential = normalized_openai_compatible_credentials(&config)
        .into_iter()
        .find(|credential| credential.id == credential_id)
        .ok_or("Configured provider credential not found")?;

    config.provider = Some(PROVIDER_OPENAI_COMPATIBLE.to_string());
    config.active_openai_credential_id = Some(credential.id);
    config.openai_api_key = Some(credential.api_key);
    config.openai_base_url = Some(credential.base_url);
    config.openai_model = Some(credential.model);
    write_claude_prism_auth_config(&config)
}

/// Windows CREATE_NO_WINDOW flag to prevent console windows from flashing
/// when spawning child processes (e.g. Claude CLI, cmd.exe, node.exe).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

    let wide: Vec<u16> = OsString::from(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

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
/// Search order: ~/.local/bin 鈫?NVM_BIN 鈫?which 鈫?registry PATH (Windows) 鈫?/// login shell (Unix) 鈫?npm/nvm global 鈫?standard paths 鈫?user-specific paths.
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
            home.join("scoop").join("shims").join("claude.cmd"),
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
fn unix_claude_candidate_paths(
    home: &std::path::Path,
    pnpm_home: Option<std::ffi::OsString>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(pnpm_home) = pnpm_home.filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(pnpm_home).join("claude"));
    }
    paths.extend([
        home.join("Library").join("pnpm").join("claude"),
        home.join(".local")
            .join("share")
            .join("pnpm")
            .join("claude"),
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

    if let Some(yarn_bin) =
        run_login_shell_command("command -v yarn >/dev/null 2>&1 && yarn global bin 2>/dev/null")
    {
        paths.push(unix_claude_path_from_bin_dir(yarn_bin));
    }

    paths.extend(unix_known_pnpm_claude_paths(home));

    paths
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_known_pnpm_claude_paths(home: &std::path::Path) -> Vec<PathBuf> {
    vec![
        home.join("Library").join("pnpm").join("claude"),
        home.join("Library")
            .join("pnpm")
            .join("global")
            .join("bin")
            .join("claude"),
        home.join(".local")
            .join("share")
            .join("pnpm")
            .join("claude"),
        home.join(".local")
            .join("share")
            .join("pnpm")
            .join("global")
            .join("bin")
            .join("claude"),
        home.join(".pnpm").join("claude"),
        home.join(".pnpm").join("global").join("bin").join("claude"),
    ]
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_extra_tool_dirs(
    home: &std::path::Path,
    pnpm_home: Option<std::ffi::OsString>,
) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".local").join("bin"),
        home.join(".cargo").join("bin"),
        home.join(".bun").join("bin"),
        home.join("Library").join("pnpm"),
        home.join("Library").join("pnpm").join("global").join("bin"),
        home.join(".local").join("share").join("pnpm"),
        home.join(".local")
            .join("share")
            .join("pnpm")
            .join("global")
            .join("bin"),
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
        // Find node.exe 鈥?prefer one next to the .cmd, then fall back to PATH
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
        // Keep CLAUDE_CODE_GIT_BASH_PATH 鈥?Claude Code needs it on Windows to locate git-bash
        if key == "CLAUDE_CODE_GIT_BASH_PATH" {
            continue;
        }
        if key.starts_with("CLAUDE_CODE_") || key.starts_with("CLAUDE_AGENT_") {
            cmd.env_remove(&key);
        }
    }
    // Set effort level (default: low for fast responses)
    cmd.env("CLAUDE_CODE_EFFORT_LEVEL", effort_level.unwrap_or("low"));

    if let Some(credential) = stored_claude_credential() {
        for (key, value) in claude_credential_env_values(&credential) {
            if std::env::var(key)
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
            {
                cmd.env(key, value);
            }
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
                            current_path = format!("{}{}{}", nvm_bin_str, sep, current_path);
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
        cmd.env("UV_PROJECT_ENVIRONMENT", &venv_dir);
        cmd.env("PYTHONNOUSERSITE", "1");
        cmd.env("PIP_REQUIRE_VIRTUALENV", "true");
        #[cfg(not(target_os = "windows"))]
        let venv_bin = venv_dir.join("bin");
        #[cfg(target_os = "windows")]
        let venv_bin = venv_dir.join("Scripts");
        current_path = format!("{}{}{}", venv_bin.to_string_lossy(), sep, current_path);
    }

    cmd.env("PATH", current_path);

    cmd
}

fn clear_anthropic_provider_env(cmd: &mut Command) {
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "ANTHROPIC_BETA",
        "ANTHROPIC_VERSION",
    ] {
        cmd.env_remove(key);
    }
    for (key, _) in std::env::vars() {
        if key.to_ascii_uppercase().starts_with("ANTHROPIC_") {
            cmd.env_remove(key);
        }
    }
}

fn with_prompt_transport(mut args: Vec<String>, prompt: String) -> (Vec<String>, Option<String>) {
    args.push("-p".to_string());
    #[cfg(target_os = "windows")]
    {
        (args, Some(prompt))
    }
    #[cfg(not(target_os = "windows"))]
    {
        args.push(prompt);
        (args, None)
    }
}

// 鈹€鈹€鈹€ Setup / Status Commands 鈹€鈹€鈹€

#[derive(serde::Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub provider_kind: String,
    pub account_email: Option<String>,
    pub provider_model: Option<String>,
    pub provider_base_url: Option<String>,
    pub claude_provider_configured: bool,
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

    // 3. git on PATH 鈫?derive bash.exe location
    if let Ok(git_path) = which::which("git") {
        // git.exe is typically at Git/cmd/git.exe 鈫?bash.exe at Git/bin/bash.exe
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
    let auth_config = read_claude_prism_auth_config()?;
    let claude_provider_configured = stored_claude_credential_from_config(&auth_config).is_some()
        || std::env::var("ANTHROPIC_API_KEY")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        || std::env::var("ANTHROPIC_AUTH_TOKEN")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
    let openai_credential = stored_openai_compatible_credential_from_config(&auth_config, None);
    let provider_kind = if openai_credential.is_some() {
        PROVIDER_OPENAI_COMPATIBLE
    } else {
        PROVIDER_CLAUDE_CODE
    };
    let provider_model = openai_credential
        .as_ref()
        .map(|credential| credential.model.clone());
    let provider_base_url = openai_credential
        .as_ref()
        .map(|credential| credential.base_url.clone());

    // On Windows, check for Git for Windows first 鈥?Claude Code requires it.
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
                provider_kind: provider_kind.to_string(),
                account_email: None,
                provider_model: provider_model.clone(),
                provider_base_url: provider_base_url.clone(),
                claude_provider_configured,
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
            // Binary found but doesn't work 鈥?on Windows this is often because
            // Git for Windows is missing (Claude Code needs git-bash).
            return Ok(ClaudeStatus {
                installed: false,
                authenticated: false,
                binary_path: None,
                version: None,
                provider_kind: provider_kind.to_string(),
                account_email: None,
                provider_model: provider_model.clone(),
                provider_base_url: provider_base_url.clone(),
                claude_provider_configured,
                missing_git,
            });
        }
    };

    if openai_credential.is_some() {
        return Ok(ClaudeStatus {
            installed: true,
            authenticated: true,
            binary_path: Some(binary_path),
            version,
            provider_kind: PROVIDER_OPENAI_COMPATIBLE.to_string(),
            account_email: None,
            provider_model,
            provider_base_url,
            claude_provider_configured,
            missing_git,
        });
    }

    // Check auth status
    let auth_output = new_sync_command(&binary_path)
        .args(["auth", "status"])
        .output();

    let (authenticated, account_email) = match auth_output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            // Parse for email 鈥?claude auth status outputs account info
            let email = stdout.lines().find(|line| line.contains('@')).map(|line| {
                // Extract email-like substring
                line.split_whitespace()
                    .find(|word| word.contains('@'))
                    .unwrap_or(line.trim())
                    .to_string()
            });
            (true, email)
        }
        _ => match claude_credential_label() {
            Some(label) => (true, Some(label.to_string())),
            None => (false, None),
        },
    };

    Ok(ClaudeStatus {
        installed: true,
        authenticated,
        binary_path: Some(binary_path),
        version,
        provider_kind: PROVIDER_CLAUDE_CODE.to_string(),
        account_email,
        provider_model: None,
        provider_base_url: None,
        claude_provider_configured,
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

    // Need elevation 鈥?use osascript directly for reliability
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
pub async fn install_claude_cli(window: WebviewWindow) -> Result<bool, String> {
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
    apply_proxy_env_to_command(&mut cmd, Some(&window));

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

    let success =
        match tokio::time::timeout(std::time::Duration::from_secs(600), child.wait()).await {
            Ok(Ok(status)) => status.success(),
            Ok(Err(err)) => {
                let _ = window.emit(
                    "install-error",
                    format!("Claude Code installer failed to exit cleanly: {}", err),
                );
                false
            }
            Err(_) => {
                let _ = window.emit(
                    "install-error",
                    "Claude Code installer timed out after 10 minutes.",
                );
                let _ = child.kill().await;
                false
            }
        };

    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let _ = window.emit("install-complete", success);

    Ok(success)
}

#[tauri::command]
pub async fn update_claude_cli(window: WebviewWindow) -> Result<bool, String> {
    let binary_path = find_claude_binary().map_err(|e| format!("Claude CLI not found: {}", e))?;
    let cwd = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .to_string_lossy()
        .to_string();
    let mut cmd = create_command(&binary_path, vec!["update".to_string()], &cwd, None);
    cmd.stdin(std::process::Stdio::null());
    apply_proxy_env_to_command(&mut cmd, Some(&window));

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Claude Code update: {}", e))?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let win_stdout = window.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stdout.emit("install-output", strip_ansi(&line).as_ref());
        }
    });
    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stderr.emit("install-error", strip_ansi(&line).as_ref());
        }
    });

    let success =
        match tokio::time::timeout(std::time::Duration::from_secs(600), child.wait()).await {
            Ok(Ok(status)) => status.success(),
            Ok(Err(err)) => {
                let _ = window.emit(
                    "install-error",
                    format!("Claude Code updater failed to exit cleanly: {}", err),
                );
                false
            }
            Err(_) => {
                let _ = window.emit(
                    "install-error",
                    "Claude Code update timed out after 10 minutes.",
                );
                let _ = child.kill().await;
                false
            }
        };

    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let _ = window.emit("install-complete", success);
    Ok(success)
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
                // Timeout 鈥?kill the stuck process
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
            "2. INCREMENTAL EDITS: Use the Edit tool to make small, targeted changes 鈥?one step at a time. ",
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

// 鈹€鈹€鈹€ Tauri Commands 鈹€鈹€鈹€

fn openai_chat_completions_url(base_url: &str) -> String {
    let clean = base_url.trim_end_matches('/');
    if clean.ends_with("/chat/completions") {
        clean.to_string()
    } else if openai_compatible_base_url_has_chat_root(clean) {
        format!("{}/chat/completions", clean)
    } else {
        format!("{}/v1/chat/completions", clean)
    }
}

fn with_optional_bearer_auth(
    request: reqwest::RequestBuilder,
    api_key: &str,
) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        request
    } else {
        request.bearer_auth(api_key)
    }
}

fn with_optional_anthropic_key(
    request: reqwest::RequestBuilder,
    api_key: &str,
) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        request
    } else {
        request.header("x-api-key", api_key).bearer_auth(api_key)
    }
}

fn openai_models_url(base_url: &str) -> String {
    let clean = base_url.trim_end_matches('/');
    if let Some(origin) = deepseek_origin_for_anthropic_base_url(clean) {
        return format!("{}/models", origin);
    }
    if let Some(origin) = qwen_origin_for_anthropic_base_url(clean) {
        return format!("{}/compatible-mode/v1/models", origin);
    }
    if let Some(origin) = moonshot_origin_for_anthropic_base_url(clean) {
        return format!("{}/v1/models", origin);
    }
    if let Some(root) = clean.strip_suffix("/chat/completions") {
        return format!("{}/models", root.trim_end_matches('/'));
    }

    if openai_compatible_base_url_has_chat_root(clean) {
        format!("{}/models", clean)
    } else {
        format!("{}/v1/models", clean)
    }
}

fn openai_compatible_base_url_has_chat_root(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    if lower == "https://api.deepseek.com" {
        return true;
    }

    let path = lower
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/').map(|(_, path)| path))
        .unwrap_or("")
        .trim_matches('/');
    if path.is_empty() {
        return false;
    }

    let segments = path.split('/').collect::<Vec<_>>();
    let last = segments.last().copied().unwrap_or_default();
    matches!(last, "v1" | "v2" | "v3" | "v4" | "beta")
        || path.ends_with("/openai")
        || path.ends_with("compatible-mode/v1")
}

fn openai_compatible_verification_body(model: &str) -> serde_json::Value {
    json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": "Reply with exactly: ok",
        }],
        "stream": false,
    })
}

fn anthropic_messages_url(base_url: &str) -> String {
    let clean = base_url.trim_end_matches('/');
    if clean.ends_with("/v1/messages") || clean.ends_with("/messages") {
        clean.to_string()
    } else if clean.ends_with("/v1") {
        format!("{}/messages", clean)
    } else {
        format!("{}/v1/messages", clean)
    }
}

fn anthropic_models_url(base_url: &str) -> String {
    let clean = base_url.trim_end_matches('/');
    if clean.ends_with("/v1/models") || clean.ends_with("/models") {
        clean.to_string()
    } else if clean.ends_with("/v1") {
        format!("{}/models", clean)
    } else {
        format!("{}/v1/models", clean)
    }
}

fn anthropic_verification_body(model: &str) -> serde_json::Value {
    json!({
        "model": model,
        "max_tokens": 16,
        "messages": [{
            "role": "user",
            "content": "Reply with exactly: ok",
        }],
        "stream": false,
    })
}

fn anthropic_response_has_message_content(response: &Value) -> bool {
    response
        .get("content")
        .and_then(|value| value.as_array())
        .is_some_and(|content| {
            content.iter().any(|block| {
                block.get("text").and_then(|value| value.as_str()).is_some()
                    || block
                        .get("type")
                        .and_then(|value| value.as_str())
                        .is_some_and(|block_type| matches!(block_type, "tool_use" | "thinking"))
            })
        })
}

fn provider_error_excerpt(body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 500 {
        return compact;
    }
    let truncated: String = compact.chars().take(500).collect();
    format!("{}...", truncated)
}

fn openai_compatible_verification_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = provider_error_excerpt(body);
    let hint = match status {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            "Invalid provider API key or missing model access."
        }
        reqwest::StatusCode::NOT_FOUND => {
            "Provider endpoint or model was not found. Check the Base URL and model name."
        }
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNPROCESSABLE_ENTITY => {
            "Provider rejected the request. Check the Base URL and model name."
        }
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            "Provider rate limited the verification request. Try again later."
        }
        _ => "Provider verification failed.",
    };
    if detail.is_empty() {
        format!("{} (HTTP {})", hint, status)
    } else {
        format!("{} (HTTP {}: {})", hint, status, detail)
    }
}

async fn verify_openai_compatible_credential(
    credential: &StoredOpenAiCompatibleCredential,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|err| format!("Failed to create provider client: {}", err))?;

    if let Some(anthropic_base_url) = native_anthropic_base_url(credential) {
        return verify_native_anthropic_credential(&client, credential, &anthropic_base_url).await;
    }

    let request_body = openai_compatible_verification_body(&credential.model);

    let request = client
        .post(openai_chat_completions_url(&credential.base_url))
        .header("Content-Type", "application/json")
        .body(request_body.to_string());
    let response = with_optional_bearer_auth(request, &credential.api_key)
        .send()
        .await
        .map_err(|err| format!("Provider verification request failed: {}", err))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read provider verification response: {}", err))?;

    if !status.is_success() {
        return Err(openai_compatible_verification_error(status, &response_text));
    }

    let response_json: serde_json::Value = serde_json::from_str(&response_text).map_err(|err| {
        format!(
            "Provider returned invalid JSON during verification: {}",
            err
        )
    })?;
    if response_json.pointer("/choices/0/message").is_none()
        && response_json.pointer("/choices/0/text").is_none()
    {
        return Err(
            "Provider verification succeeded but did not return an OpenAI-compatible chat response."
                .to_string(),
        );
    }

    Ok(())
}

async fn verify_native_anthropic_credential(
    client: &reqwest::Client,
    credential: &StoredOpenAiCompatibleCredential,
    anthropic_base_url: &str,
) -> Result<(), String> {
    let request_body = anthropic_verification_body(&credential.model);
    let request = client
        .post(anthropic_messages_url(anthropic_base_url))
        .header("Content-Type", "application/json")
        .header("anthropic-version", "2023-06-01")
        .body(request_body.to_string());
    let response = with_optional_anthropic_key(request, &credential.api_key)
        .send()
        .await
        .map_err(|err| format!("Provider verification request failed: {}", err))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read provider verification response: {}", err))?;

    if !status.is_success() {
        return Err(openai_compatible_verification_error(status, &response_text));
    }

    let response_json: serde_json::Value = serde_json::from_str(&response_text).map_err(|err| {
        format!(
            "Provider returned invalid JSON during verification: {}",
            err
        )
    })?;
    if !anthropic_response_has_message_content(&response_json) {
        let detail = provider_error_excerpt(&response_text);
        return Err(
            format!(
                "Provider verification succeeded but did not return an Anthropic-compatible message response. Response: {}",
                detail
            ),
        );
    }

    Ok(())
}

async fn send_openai_compatible_no_tools_text_request(
    client: &reqwest::Client,
    credential: &StoredOpenAiCompatibleCredential,
    messages: &[serde_json::Value],
) -> Result<(String, String), String> {
    if let Some(anthropic_base_url) = native_anthropic_base_url(credential) {
        return send_native_anthropic_no_tools_text_request(
            client,
            credential,
            messages,
            &anthropic_base_url,
        )
        .await;
    }

    let request_body = json!({
        "model": credential.model.clone(),
        "messages": messages,
        "stream": false,
    });

    let request = client
        .post(openai_chat_completions_url(&credential.base_url))
        .header("Content-Type", "application/json")
        .body(request_body.to_string());
    let response = with_optional_bearer_auth(request, &credential.api_key)
        .send()
        .await
        .map_err(|err| format!("Provider request failed: {}", err))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read provider response: {}", err))?;
    if !status.is_success() {
        return Err(format!(
            "Provider returned HTTP {}: {}",
            status, response_text
        ));
    }

    let response: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|err| format!("Provider returned invalid JSON: {}", err))?;
    let message = response.pointer("/choices/0/message");
    let content = message
        .and_then(|message| message.get("content"))
        .and_then(|value| value.as_str())
        .or_else(|| {
            response
                .pointer("/choices/0/text")
                .and_then(|value| value.as_str())
        })
        .unwrap_or_default()
        .to_string();
    let reasoning = message
        .and_then(|message| {
            message
                .get("reasoning_content")
                .or_else(|| message.get("reasoning"))
        })
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();

    Ok((content, reasoning))
}

async fn send_native_anthropic_no_tools_text_request(
    client: &reqwest::Client,
    credential: &StoredOpenAiCompatibleCredential,
    messages: &[serde_json::Value],
    anthropic_base_url: &str,
) -> Result<(String, String), String> {
    let request_body = json!({
        "model": credential.model.clone(),
        "max_tokens": 128,
        "messages": messages,
        "stream": false,
    });

    let request = client
        .post(anthropic_messages_url(anthropic_base_url))
        .header("Content-Type", "application/json")
        .header("anthropic-version", "2023-06-01")
        .body(request_body.to_string());
    let response = with_optional_anthropic_key(request, &credential.api_key)
        .send()
        .await
        .map_err(|err| format!("Provider request failed: {}", err))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read provider response: {}", err))?;
    if !status.is_success() {
        return Err(format!(
            "Provider returned HTTP {}: {}",
            status, response_text
        ));
    }

    let response: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|err| format!("Provider returned invalid JSON: {}", err))?;
    let content = response
        .get("content")
        .and_then(|value| value.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let reasoning = response
        .get("content")
        .and_then(|value| value.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("thinking").and_then(|value| value.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();

    Ok((content, reasoning))
}

async fn execute_openai_compatible_via_claude_proxy(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    args_prefix: Vec<String>,
    effort_level: Option<String>,
    credential: StoredOpenAiCompatibleCredential,
) -> Result<(), String> {
    let model_transformers = credential
        .model_transformers
        .get(&credential.model)
        .cloned()
        .unwrap_or_default();
    let proxy_url = start_openai_anthropic_proxy(OpenAiProxyCredential {
        api_key: credential.api_key.clone(),
        base_url: credential.base_url.clone(),
        model: credential.model.clone(),
        transformers: credential.transformers.clone(),
        model_transformers,
    })
    .await?;
    let claude_path = find_claude_binary()?;

    let (mut args, stdin_payload) = with_prompt_transport(args_prefix, prompt);
    args.push("--model".to_string());
    args.push("sonnet".to_string());
    args.extend(common_claude_args());

    let mut cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    clear_anthropic_provider_env(&mut cmd);
    cmd.env("ANTHROPIC_API_KEY", "claude-prism-local-proxy");
    cmd.env("ANTHROPIC_BASE_URL", proxy_url);
    cmd.env_remove("CLAUDE_MODEL");

    spawn_claude_process(
        window,
        cmd,
        tab_id,
        stdin_payload,
        Some(SpawnProviderMetadata {
            provider: PROVIDER_OPENAI_COMPATIBLE,
            provider_credential_id: credential.id,
            model: credential.model,
        }),
    )
    .await
}

async fn execute_openai_compatible_provider(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    args_prefix: Vec<String>,
    effort_level: Option<String>,
    credential: StoredOpenAiCompatibleCredential,
) -> Result<(), String> {
    ensure_secure_known_provider_base_url(&credential.base_url)?;

    if uses_native_anthropic_route(&credential) {
        return execute_openai_compatible_via_native_anthropic(
            window,
            project_path,
            prompt,
            tab_id,
            args_prefix,
            effort_level,
            credential,
        )
        .await;
    }

    execute_openai_compatible_via_claude_proxy(
        window,
        project_path,
        prompt,
        tab_id,
        args_prefix,
        effort_level,
        credential,
    )
    .await
}

async fn execute_openai_compatible_via_native_anthropic(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    args_prefix: Vec<String>,
    effort_level: Option<String>,
    credential: StoredOpenAiCompatibleCredential,
) -> Result<(), String> {
    let anthropic_base_url = native_anthropic_base_url(&credential)
        .ok_or_else(|| "Provider does not expose a native Anthropic endpoint".to_string())?;
    let claude_path = find_claude_binary()?;

    let (mut args, stdin_payload) = with_prompt_transport(args_prefix, prompt);
    args.extend(common_claude_args());

    let mut cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    apply_native_anthropic_provider_env(&mut cmd, &credential, &anthropic_base_url);

    spawn_claude_process(
        window,
        cmd,
        tab_id,
        stdin_payload,
        Some(SpawnProviderMetadata {
            provider: PROVIDER_OPENAI_COMPATIBLE,
            provider_credential_id: credential.id,
            model: credential.model,
        }),
    )
    .await
}

fn apply_native_anthropic_provider_env(
    cmd: &mut Command,
    credential: &StoredOpenAiCompatibleCredential,
    anthropic_base_url: &str,
) {
    clear_anthropic_provider_env(cmd);
    cmd.env("ANTHROPIC_BASE_URL", anthropic_base_url);
    cmd.env("ANTHROPIC_AUTH_TOKEN", credential.api_key.as_str());
    cmd.env("ANTHROPIC_MODEL", credential.model.as_str());
    cmd.env("ANTHROPIC_SMALL_FAST_MODEL", credential.model.as_str());
    cmd.env("ANTHROPIC_DEFAULT_OPUS_MODEL", credential.model.as_str());
    cmd.env("ANTHROPIC_DEFAULT_SONNET_MODEL", credential.model.as_str());
    cmd.env("ANTHROPIC_DEFAULT_HAIKU_MODEL", credential.model.as_str());
    cmd.env("CLAUDE_CODE_SUBAGENT_MODEL", credential.model.as_str());
    if native_anthropic_provider_kind(anthropic_base_url) == Some("moonshot") {
        cmd.env("ENABLE_TOOL_SEARCH", "false");
        cmd.env("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "262144");
    }
    cmd.env_remove("CLAUDE_MODEL");
}

fn uses_native_anthropic_route(credential: &StoredOpenAiCompatibleCredential) -> bool {
    native_anthropic_base_url(credential).is_some()
}

fn native_anthropic_base_url(credential: &StoredOpenAiCompatibleCredential) -> Option<String> {
    let origin = http_origin(&credential.base_url)?;
    let lower_origin = origin.to_ascii_lowercase();
    if lower_origin == "https://api.deepseek.com" {
        let lower = credential.base_url.to_ascii_lowercase();
        if let Some(index) = lower.find("/anthropic") {
            return Some(format!("{}{}", &credential.base_url[..index], "/anthropic"));
        }

        return Some(format!("{}/anthropic", origin));
    }

    if is_qwen_anthropic_origin(&lower_origin) {
        let lower = credential.base_url.to_ascii_lowercase();
        if let Some(index) = lower.find("/apps/anthropic") {
            return Some(format!(
                "{}{}",
                &credential.base_url[..index],
                "/apps/anthropic"
            ));
        }

        return Some(format!("{}/apps/anthropic", origin));
    }

    if is_moonshot_anthropic_origin(&lower_origin) {
        return Some(format!("{}/anthropic", MOONSHOT_OFFICIAL_ORIGIN));
    }

    None
}

fn native_anthropic_provider_kind(base_url: &str) -> Option<&'static str> {
    let origin = http_origin(base_url)?.to_ascii_lowercase();
    if origin == "https://api.deepseek.com" {
        return Some("deepseek");
    }
    if is_qwen_anthropic_origin(&origin) {
        return Some("qwen");
    }
    if is_moonshot_anthropic_origin(&origin) {
        return Some("moonshot");
    }
    None
}

fn deepseek_origin_for_anthropic_base_url(base_url: &str) -> Option<String> {
    let lower = base_url.to_ascii_lowercase();
    let origin = http_origin(base_url)?;
    if origin.to_ascii_lowercase() != "https://api.deepseek.com" || !lower.contains("/anthropic") {
        return None;
    }
    Some(origin)
}

fn qwen_origin_for_anthropic_base_url(base_url: &str) -> Option<String> {
    let lower = base_url.to_ascii_lowercase();
    let origin = http_origin(base_url)?;
    if !is_qwen_anthropic_origin(&origin.to_ascii_lowercase()) {
        return None;
    }
    if lower.contains("/apps/anthropic") || lower.contains("/compatible-mode/") {
        return Some(origin);
    }
    None
}

fn moonshot_origin_for_anthropic_base_url(base_url: &str) -> Option<String> {
    let lower = base_url.to_ascii_lowercase();
    let origin = http_origin(base_url)?;
    if !is_moonshot_anthropic_origin(&origin.to_ascii_lowercase()) {
        return None;
    }
    if lower.contains("/anthropic") || lower.ends_with("/v1") {
        return Some(MOONSHOT_OFFICIAL_ORIGIN.to_string());
    }
    None
}

fn is_qwen_anthropic_origin(lower_origin: &str) -> bool {
    matches!(
        lower_origin,
        "https://dashscope.aliyuncs.com" | "https://dashscope-intl.aliyuncs.com"
    )
}

fn is_moonshot_anthropic_origin(lower_origin: &str) -> bool {
    matches!(
        lower_origin,
        "https://api.moonshot.cn" | "https://api.moonshot.ai"
    )
}

fn http_origin(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    let scheme_end = value.find("://")?;
    let after_scheme = &value[scheme_end + 3..];
    let host_end = after_scheme.find('/').unwrap_or(after_scheme.len());
    if host_end == 0 {
        return None;
    }
    Some(value[..scheme_end + 3 + host_end].to_string())
}

#[tauri::command]
pub async fn execute_claude_code(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    effort_level: Option<String>,
    provider_credential_id: Option<String>,
    provider_model_override: Option<String>,
) -> Result<(), String> {
    if let Some(mut credential) =
        stored_openai_compatible_credential_by_id(provider_credential_id.as_deref())?
    {
        if let Some(model) = normalize_provider_model_override(provider_model_override.as_deref())?
        {
            credential.model = model;
        }
        return execute_openai_compatible_provider(
            window,
            project_path,
            prompt,
            tab_id,
            Vec::new(),
            effort_level,
            credential,
        )
        .await;
    }

    let claude_path = find_claude_binary()?;

    let (mut args, stdin_payload) = with_prompt_transport(Vec::new(), prompt);
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m);
    }
    args.extend(common_claude_args());

    let cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    spawn_claude_process(window, cmd, tab_id, stdin_payload, None).await
}

#[tauri::command]
pub async fn continue_claude_code(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    effort_level: Option<String>,
    provider_credential_id: Option<String>,
    provider_model_override: Option<String>,
) -> Result<(), String> {
    if let Some(mut credential) =
        stored_openai_compatible_credential_by_id(provider_credential_id.as_deref())?
    {
        if let Some(model) = normalize_provider_model_override(provider_model_override.as_deref())?
        {
            credential.model = model;
        }
        return execute_openai_compatible_provider(
            window,
            project_path,
            prompt,
            tab_id,
            vec!["-c".to_string()],
            effort_level,
            credential,
        )
        .await;
    }

    let claude_path = find_claude_binary()?;

    let (mut args, stdin_payload) = with_prompt_transport(vec!["-c".to_string()], prompt);
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m);
    }
    args.extend(common_claude_args());

    let cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    spawn_claude_process(window, cmd, tab_id, stdin_payload, None).await
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
    provider_credential_id: Option<String>,
    provider_model_override: Option<String>,
) -> Result<(), String> {
    if let Some(mut credential) =
        stored_openai_compatible_credential_by_id(provider_credential_id.as_deref())?
    {
        if let Some(model) = normalize_provider_model_override(provider_model_override.as_deref())?
        {
            credential.model = model;
        }
        return execute_openai_compatible_provider(
            window,
            project_path,
            prompt,
            tab_id,
            vec!["--resume".to_string(), session_id],
            effort_level,
            credential,
        )
        .await;
    }

    let claude_path = find_claude_binary()?;

    let (mut args, stdin_payload) =
        with_prompt_transport(vec!["--resume".to_string(), session_id], prompt);
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m);
    }
    args.extend(common_claude_args());

    let cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    spawn_claude_process(window, cmd, tab_id, stdin_payload, None).await
}

#[tauri::command]
pub async fn cancel_claude_execution(window: WebviewWindow, tab_id: String) -> Result<(), String> {
    stop_claude_process(window, tab_id, ClaudeStopMode::Terminate)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn interrupt_claude_execution(
    window: WebviewWindow,
    tab_id: String,
) -> Result<bool, String> {
    stop_claude_process(window, tab_id, ClaudeStopMode::Interrupt).await
}

// 鈹€鈹€鈹€ Session Listing 鈹€鈹€鈹€

#[derive(serde::Serialize)]
pub struct ClaudeSessionInfo {
    pub session_id: String,
    pub title: String,
    pub last_modified: i64,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct SessionTitleCache {
    title: String,
    source_modified: i64,
    generated_at: i64,
}

struct SessionCandidate {
    session_id: String,
    fallback_title: String,
    title: Option<String>,
    last_modified: i64,
}

/// Resolve the Claude Code sessions directory for a given project path.
/// Claude Code encodes paths by replacing all non-alphanumeric characters with '-'.
/// e.g. "/Users/dev/my_project" 鈫?"-Users-dev-my-project"
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

fn unique_session_migration_target(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }

    let parent = target.parent().unwrap_or_else(|| Path::new(""));
    let stem = target
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("session");
    let extension = target.extension().and_then(|value| value.to_str());

    for index in 1..1000 {
        let file_name = match extension {
            Some(ext) => format!("{}-migrated-{}.{}", stem, index, ext),
            None => format!("{}-migrated-{}", stem, index),
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    parent.join(format!(
        "{}-migrated-{}",
        stem,
        chrono::Utc::now().timestamp()
    ))
}

fn move_session_entry(source: &Path, target: &Path) -> Result<(), String> {
    let target = unique_session_migration_target(target);
    match std::fs::rename(source, &target) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            if source.is_dir() {
                return Err(format!(
                    "Failed to move session directory {:?} to {:?}: {}",
                    source, target, rename_err
                ));
            }
            std::fs::copy(source, &target).map_err(|copy_err| {
                format!(
                    "Failed to copy session file {:?} to {:?}: {}",
                    source, target, copy_err
                )
            })?;
            std::fs::remove_file(source).map_err(|remove_err| {
                format!(
                    "Copied session file to {:?}, but failed to remove old file {:?}: {}",
                    target, source, remove_err
                )
            })?;
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn migrate_project_sessions(
    old_project_path: String,
    new_project_path: String,
) -> Result<(), String> {
    let old_sessions_dir = get_sessions_dir(&old_project_path)?;
    let new_sessions_dir = get_sessions_dir(&new_project_path)?;

    if old_sessions_dir == new_sessions_dir || !old_sessions_dir.exists() {
        return Ok(());
    }

    if let Some(parent) = new_sessions_dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Claude projects directory: {}", e))?;
    }

    if !new_sessions_dir.exists() {
        match std::fs::rename(&old_sessions_dir, &new_sessions_dir) {
            Ok(()) => return Ok(()),
            Err(err) => {
                eprintln!(
                    "[session] failed to rename sessions dir {:?} -> {:?}: {}. Falling back to merge.",
                    old_sessions_dir, new_sessions_dir, err
                );
            }
        }
    }

    std::fs::create_dir_all(&new_sessions_dir)
        .map_err(|e| format!("Failed to create migrated sessions directory: {}", e))?;

    let entries = std::fs::read_dir(&old_sessions_dir)
        .map_err(|e| format!("Failed to read old sessions directory: {}", e))?;
    for entry in entries.flatten() {
        let source = entry.path();
        let target = new_sessions_dir.join(entry.file_name());
        move_session_entry(&source, &target)?;
    }

    let _ = std::fs::remove_dir(&old_sessions_dir);
    Ok(())
}

fn truncate_session_title(text: &str, max_chars: usize) -> String {
    if text.chars().count() > max_chars {
        let truncated: String = text.chars().take(max_chars.saturating_sub(3)).collect();
        format!("{}...", truncated)
    } else {
        text.to_string()
    }
}

fn truncate_long_text(text: String, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text;
    }
    let mut truncated: String = text.chars().take(max_chars).collect();
    truncated.push_str("\n...[truncated]");
    truncated
}

fn session_title_cache_path(session_path: &Path) -> PathBuf {
    session_path.with_extension("title.json")
}

fn sanitize_model_session_title(title: &str) -> Option<String> {
    let title = title
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .trim_matches(|c| matches!(c, '"' | '\'' | '`'))
        .trim();
    let title = title
        .strip_prefix("Title:")
        .or_else(|| title.strip_prefix("title:"))
        .or_else(|| title.strip_prefix("鏍囬:"))
        .unwrap_or(title)
        .trim();
    let title = normalize_title_whitespace(title);
    let lower = title.to_lowercase();
    if title.is_empty()
        || lower == "new chat"
        || lower == "untitled"
        || lower == "untitled session"
        || lower == "conversation summary"
        || lower == "chat summary"
    {
        return None;
    }

    Some(truncate_session_title(&title, 72))
}

fn read_session_title_cache(session_path: &Path) -> Option<String> {
    let cache_path = session_title_cache_path(session_path);
    let content = std::fs::read_to_string(cache_path).ok()?;
    let cache = serde_json::from_str::<SessionTitleCache>(&content).ok()?;
    sanitize_model_session_title(&cache.title)
}

fn write_session_title_cache(
    session_path: &Path,
    source_modified: i64,
    title: &str,
) -> Result<(), String> {
    let cache_path = session_title_cache_path(session_path);
    let Some(title) = sanitize_model_session_title(title) else {
        return Ok(());
    };
    let cache = SessionTitleCache {
        title,
        source_modified,
        generated_at: chrono::Utc::now().timestamp(),
    };
    let content = serde_json::to_string_pretty(&cache)
        .map_err(|e| format!("Failed to serialize session title cache: {}", e))?;
    std::fs::write(cache_path, content)
        .map_err(|e| format!("Failed to write session title cache: {}", e))
}

fn normalize_title_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_noise_title_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return true;
    }

    let lower = trimmed.to_lowercase();
    lower.starts_with("template:")
        || lower.starts_with("file:")
        || lower.starts_with("reference files")
        || lower == "what i want to create"
        || lower.starts_with("(extracted text")
        || lower.starts_with("attachments/")
        || lower.starts_with("the file currently contains")
        || (lower.starts_with("new ") && lower.contains(" project"))
}

fn extract_marked_request_body(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let marker_index = lines
        .iter()
        .position(|line| line.trim().eq_ignore_ascii_case("what i want to create"))?;

    let mut selected = Vec::new();
    for line in lines.iter().skip(marker_index + 1) {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("reference files") {
            break;
        }
        if is_noise_title_line(trimmed) {
            continue;
        }
        selected.push(trimmed);
        if selected.join(" ").chars().count() >= 120 {
            break;
        }
    }

    let body = normalize_title_whitespace(&selected.join(" "));
    if body.is_empty() {
        None
    } else {
        Some(body)
    }
}

fn first_meaningful_title_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !is_noise_title_line(line))
        .map(normalize_title_whitespace)
        .filter(|line| !line.is_empty())
}

fn summarize_session_title(text: &str) -> Option<String> {
    let source = extract_marked_request_body(text).or_else(|| first_meaningful_title_line(text))?;
    let normalized = normalize_title_whitespace(&source);
    let lower = normalized.to_lowercase();

    let research_prefix = [
        "a research paper for ",
        "research paper for ",
        "a research paper on ",
        "research paper on ",
        "a research paper about ",
        "research paper about ",
    ]
    .into_iter()
    .find(|prefix| lower.starts_with(prefix));

    let summary = if let Some(prefix) = research_prefix {
        let topic = normalized[prefix.len()..].trim();
        if topic.is_empty() {
            "Research Paper".to_string()
        } else {
            format!("Research Paper: {}", truncate_session_title(topic, 56))
        }
    } else if lower.contains("research paper") {
        truncate_session_title(&normalized, 80)
    } else {
        truncate_session_title(&normalized, 80)
    };

    Some(summary)
}

/// Clean raw user message text into a summarized display title.
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

    summarize_session_title(clean)
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

fn title_text_from_message_content(content: &serde_json::Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    let blocks = content.as_array()?;
    let mut parts = Vec::new();
    for block in blocks {
        if block.get("type").and_then(|v| v.as_str()) != Some("text") {
            continue;
        }
        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
            parts.push(text.trim());
        }
    }

    let text = normalize_title_whitespace(&parts.join("\n"));
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn session_excerpt_for_model_title(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    use std::io::BufRead;

    let mut lines = Vec::new();
    let mut total_chars = 0usize;
    for line in reader.lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(kind) = entry.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let Some(content) = entry
            .get("message")
            .and_then(|m| m.get("content"))
            .or_else(|| entry.get("content"))
        else {
            continue;
        };
        let Some(mut text) = title_text_from_message_content(content) else {
            continue;
        };
        text = text.trim().to_string();
        if text.is_empty()
            || text.starts_with("<ide_")
            || text.starts_with("<system-reminder>")
            || text.starts_with("<command-name>")
            || text.starts_with("<local-command-stdout>")
        {
            continue;
        }

        let speaker = if kind == "user" { "User" } else { "Assistant" };
        let text = truncate_long_text(text, 1400);
        let entry = format!("{}: {}", speaker, text);
        total_chars += entry.chars().count();
        lines.push(entry);
        if lines.len() >= 8 || total_chars >= 6000 {
            break;
        }
    }

    let excerpt = lines.join("\n\n");
    if excerpt.trim().is_empty() {
        None
    } else {
        Some(excerpt)
    }
}

fn session_title_credential_from_config(
    config: &ClaudePrismAuthConfig,
) -> Option<StoredOpenAiCompatibleCredential> {
    let credentials = normalized_openai_compatible_credentials(config);
    if let Some(active_id) = config.active_openai_credential_id.as_deref() {
        if let Some(credential) = credentials
            .iter()
            .find(|credential| credential.id == active_id)
            .cloned()
        {
            return Some(credential);
        }
    }

    credentials.into_iter().next()
}

async fn generate_model_session_title(
    client: &reqwest::Client,
    credential: &StoredOpenAiCompatibleCredential,
    excerpt: &str,
) -> Result<Option<String>, String> {
    let messages = vec![
        json!({
            "role": "system",
            "content": "You generate concise chat history titles. Return only the title text, with no quotes, no markdown, and no explanation.",
        }),
        json!({
            "role": "user",
            "content": format!(
                "Summarize this chat as a short history title. Use the user's language when obvious. Prefer a task/topic summary over copying the first sentence. Keep it under 8 English words or 16 Chinese characters. Avoid generic titles like New Chat or Research Paper.\n\nConversation excerpt:\n{}",
                excerpt
            ),
        }),
    ];

    let (content, reasoning) =
        send_openai_compatible_no_tools_text_request(client, credential, &messages).await?;
    let title = if content.trim().is_empty() {
        reasoning.trim()
    } else {
        content.trim()
    };

    Ok(sanitize_model_session_title(title))
}

#[tauri::command]
pub async fn list_claude_sessions(
    project_path: String,
    generate_titles: Option<bool>,
) -> Result<Vec<ClaudeSessionInfo>, String> {
    let _ = generate_titles;
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

    let mut candidates = Vec::new();
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
        let fallback_title = first_message.unwrap_or_else(|| "Untitled session".to_string());
        let title = read_session_title_cache(&path);

        candidates.push(SessionCandidate {
            session_id,
            fallback_title,
            title,
            last_modified: modified,
        });
    }

    candidates.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

    let mut sessions: Vec<ClaudeSessionInfo> = candidates
        .into_iter()
        .map(|candidate| ClaudeSessionInfo {
            session_id: candidate.session_id,
            title: candidate.title.unwrap_or(candidate.fallback_title),
            last_modified: candidate.last_modified,
        })
        .collect();

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

fn is_valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub async fn generate_claude_session_title(
    project_path: String,
    session_id: String,
) -> Result<Option<String>, String> {
    if !is_valid_session_id(&session_id) {
        return Err("Invalid session id".to_string());
    }

    let sessions_dir = get_sessions_dir(&project_path)?;
    let session_path = sessions_dir.join(format!("{}.jsonl", session_id));
    if !session_path.exists() {
        return Ok(None);
    }

    if let Some(title) = read_session_title_cache(&session_path) {
        return Ok(Some(title));
    }

    let modified = std::fs::metadata(&session_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64
        })
        .unwrap_or(0);

    let Some(excerpt) = session_excerpt_for_model_title(&session_path) else {
        return Ok(None);
    };
    let Some(credential) = read_claude_prism_auth_config()
        .ok()
        .and_then(|config| session_title_credential_from_config(&config))
    else {
        return Ok(None);
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    else {
        return Ok(None);
    };

    let Some(title) = generate_model_session_title(&client, &credential, &excerpt).await? else {
        return Ok(None);
    };

    write_session_title_cache(&session_path, modified, &title)?;
    Ok(Some(title))
}

/// Load the full JSONL history for a specific session.
#[tauri::command]
pub async fn load_session_history(
    project_path: String,
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    if !is_valid_session_id(&session_id) {
        return Err("Invalid session id".to_string());
    }

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

// 鈹€鈹€鈹€ Shell Command Execution 鈹€鈹€鈹€

#[tauri::command]
pub async fn delete_claude_session(project_path: String, session_id: String) -> Result<(), String> {
    if !is_valid_session_id(&session_id) {
        return Err("Invalid session id".to_string());
    }

    let sessions_dir = get_sessions_dir(&project_path)?;
    let session_path = sessions_dir.join(format!("{}.jsonl", session_id));

    if !session_path.exists() {
        return Ok(());
    }

    let canonical_sessions_dir = sessions_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve sessions directory: {}", e))?;
    let canonical_session_path = session_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve session file: {}", e))?;

    if !canonical_session_path.starts_with(&canonical_sessions_dir) {
        return Err("Refusing to delete session outside project history".to_string());
    }

    if canonical_session_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("Refusing to delete non-session file".to_string());
    }

    std::fs::remove_file(&canonical_session_path)
        .map_err(|e| format!("Failed to delete session: {}", e))?;
    let _ = std::fs::remove_file(session_title_cache_path(&canonical_session_path));

    Ok(())
}

#[derive(serde::Serialize)]
pub struct ShellCommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

fn truncate_shell_output(value: &[u8]) -> String {
    const MAX_OUTPUT_BYTES: usize = 64 * 1024;
    let truncated = value.len() > MAX_OUTPUT_BYTES;
    let mut text = String::from_utf8_lossy(&value[..value.len().min(MAX_OUTPUT_BYTES)]).to_string();
    if truncated {
        text.push_str("\n[output truncated]");
    }
    text
}

#[tauri::command]
pub async fn run_shell_command(command: String, cwd: String) -> Result<ShellCommandResult, String> {
    let command = strip_nul(&command).trim().to_string();
    if command.is_empty() {
        return Err("Command is empty".to_string());
    }

    let cwd = strip_nul(&cwd).trim().to_string();
    if cwd.is_empty() {
        return Err("Command working directory is empty".to_string());
    }
    let cwd = PathBuf::from(cwd);
    let cwd = cwd
        .canonicalize()
        .map_err(|e| format!("Failed to resolve command working directory: {}", e))?;
    if !cwd.is_dir() {
        return Err("Command working directory is not a directory".to_string());
    }
    let cwd = cwd.to_string_lossy().to_string();

    #[cfg(not(target_os = "windows"))]
    let (shell, args) = ("sh", vec!["-c".to_string(), command]);
    #[cfg(target_os = "windows")]
    let (shell, args) = ("cmd", vec!["/C".to_string(), command]);
    let mut cmd = create_command(shell, args, &cwd, None);
    cmd.kill_on_drop(true);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "Command timed out after 120 seconds".to_string())?
    .map_err(|e| format!("Failed to wait for command: {}", e))?;

    Ok(ShellCommandResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: truncate_shell_output(&output.stdout),
        stderr: truncate_shell_output(&output.stderr),
    })
}

// 鈹€鈹€鈹€ Claude Settings (fast mode, etc.) 鈹€鈹€鈹€

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

    fn test_openai_compatible_auth_config() -> ClaudePrismAuthConfig {
        ClaudePrismAuthConfig {
            provider: Some(PROVIDER_OPENAI_COMPATIBLE.to_string()),
            active_openai_credential_id: Some("qwen".to_string()),
            openai_credentials: vec![
                StoredOpenAiCompatibleCredentialConfig {
                    id: "qwen".to_string(),
                    label: "Qwen".to_string(),
                    api_key: "sk-qwen".to_string(),
                    base_url: "https://dashscope.aliyuncs.com/apps/anthropic".to_string(),
                    model: "qwen3-coder-plus".to_string(),
                    transformers: vec!["enhancetool".to_string()],
                    model_transformers: HashMap::new(),
                },
                StoredOpenAiCompatibleCredentialConfig {
                    id: "deepseek".to_string(),
                    label: "DeepSeek".to_string(),
                    api_key: "sk-deepseek".to_string(),
                    base_url: "https://api.deepseek.com/anthropic".to_string(),
                    model: "deepseek-chat".to_string(),
                    transformers: vec!["deepseek".to_string()],
                    model_transformers: HashMap::from([(
                        "deepseek-chat".to_string(),
                        vec!["tooluse".to_string()],
                    )]),
                },
                StoredOpenAiCompatibleCredentialConfig {
                    id: "moonshot".to_string(),
                    label: "Moonshot / Kimi".to_string(),
                    api_key: "sk-moonshot".to_string(),
                    base_url: "https://api.moonshot.ai/anthropic".to_string(),
                    model: "kimi-k2.5".to_string(),
                    transformers: Vec::new(),
                    model_transformers: HashMap::new(),
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn test_normalize_proxy_url_defaults_to_http() {
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalize_proxy_url("socks5://127.0.0.1:7891"),
            Some("socks5://127.0.0.1:7891".to_string())
        );
        assert_eq!(normalize_proxy_url("   "), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_windows_proxy_server_single_proxy_for_installer_env() {
        let vars = parse_windows_proxy_server_for_env("127.0.0.1:7890");

        assert_eq!(
            vars,
            vec![
                ProxyEnvVar {
                    key: "HTTPS_PROXY",
                    value: "http://127.0.0.1:7890".to_string(),
                    source: "Windows system proxy".to_string(),
                },
                ProxyEnvVar {
                    key: "HTTP_PROXY",
                    value: "http://127.0.0.1:7890".to_string(),
                    source: "Windows system proxy".to_string(),
                },
                ProxyEnvVar {
                    key: "ALL_PROXY",
                    value: "http://127.0.0.1:7890".to_string(),
                    source: "Windows system proxy".to_string(),
                },
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_windows_proxy_server_per_scheme_for_installer_env() {
        let vars = parse_windows_proxy_server_for_env(
            "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892",
        );

        assert_eq!(
            vars,
            vec![
                ProxyEnvVar {
                    key: "HTTP_PROXY",
                    value: "http://127.0.0.1:7890".to_string(),
                    source: "Windows system proxy (http)".to_string(),
                },
                ProxyEnvVar {
                    key: "HTTPS_PROXY",
                    value: "http://127.0.0.1:7891".to_string(),
                    source: "Windows system proxy (https)".to_string(),
                },
                ProxyEnvVar {
                    key: "ALL_PROXY",
                    value: "socks5://127.0.0.1:7892".to_string(),
                    source: "Windows system proxy (socks)".to_string(),
                },
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_proxy_override_to_no_proxy_env() {
        assert_eq!(
            windows_proxy_override_to_no_proxy_env("<local>;*.example.com;api.test"),
            Some("localhost,127.0.0.1,::1,.example.com,api.test".to_string())
        );
    }

    #[test]
    fn test_provider_model_override_ignores_claude_model_selectors() {
        assert_eq!(
            normalize_provider_model_override(Some("claude-opus-4-7")).unwrap(),
            None
        );
        assert_eq!(
            normalize_provider_model_override(Some("opusplan")).unwrap(),
            None
        );
        assert_eq!(
            normalize_provider_model_override(Some("sonnet")).unwrap(),
            None
        );
    }

    #[test]
    fn test_provider_model_override_accepts_openai_compatible_models() {
        assert_eq!(
            normalize_provider_model_override(Some("qwen3-coder-plus")).unwrap(),
            Some("qwen3-coder-plus".to_string())
        );
        assert_eq!(
            normalize_provider_model_override(Some("deepseek-chat")).unwrap(),
            Some("deepseek-chat".to_string())
        );
    }

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

    #[test]
    fn test_session_id_validation_rejects_path_components() {
        assert!(is_valid_session_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(is_valid_session_id("session_123"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("../other-project/session"));
        assert!(!is_valid_session_id("..\\other-project\\session"));
        assert!(!is_valid_session_id("session.jsonl"));
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
    fn test_clean_user_message_title_summarizes_project_wizard_prompt() {
        let text = "New IEEE Conference Paper Project\nTemplate: IEEEtran\nFile: main.tex\nThe file currently contains only the LaTeX preamble.\nWhat I want to create\nA research paper for vllm acceleration on FastGraphVID and GraphSTM\nReference Files\nattachments/Very_Long_File_Name.pdf\n(extracted text:";
        let result = clean_user_message_title(text);
        assert_eq!(
            result,
            Some("Research Paper: vllm acceleration on FastGraphVID and GraphSTM".to_string())
        );
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

    #[test]
    fn test_with_prompt_transport_always_includes_print_flag() {
        let (args, stdin_payload) = with_prompt_transport(
            vec!["--resume".to_string(), "abc".to_string()],
            "hello 鏂囦欢".into(),
        );
        assert!(args.contains(&"-p".to_string()));
        #[cfg(target_os = "windows")]
        {
            assert_eq!(stdin_payload.as_deref(), Some("hello 鏂囦欢"));
            assert!(!args.contains(&"hello 鏂囦欢".to_string()));
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(stdin_payload, None);
            assert_eq!(args.last().map(String::as_str), Some("hello 鏂囦欢"));
        }
    }

    #[test]
    fn test_claude_external_proxy_sets_api_key_and_auth_token_envs() {
        let credential = StoredClaudeCredential {
            api_key: "sk-modelgate".to_string(),
            base_url: Some("https://mg.aid.pub/claude-proxy".to_string()),
        };
        let values = claude_credential_env_values(&credential);

        assert!(values.contains(&("ANTHROPIC_API_KEY", "sk-modelgate".to_string())));
        assert!(values.contains(&(
            "ANTHROPIC_BASE_URL",
            "https://mg.aid.pub/claude-proxy".to_string()
        )));
        assert!(values.contains(&("ANTHROPIC_AUTH_TOKEN", "sk-modelgate".to_string())));
    }

    #[test]
    fn test_claude_direct_anthropic_key_does_not_set_auth_token() {
        let credential = StoredClaudeCredential {
            api_key: "sk-ant-test".to_string(),
            base_url: None,
        };
        let values = claude_credential_env_values(&credential);

        assert!(values.contains(&("ANTHROPIC_API_KEY", "sk-ant-test".to_string())));
        assert!(!values.iter().any(|(key, _)| *key == "ANTHROPIC_AUTH_TOKEN"));
        assert!(!values.iter().any(|(key, _)| *key == "ANTHROPIC_BASE_URL"));
    }

    #[test]
    fn test_claude_credential_is_available_when_openai_provider_is_active() {
        let mut config = test_openai_compatible_auth_config();
        config.anthropic_api_key = Some("sk-modelgate".to_string());
        config.anthropic_base_url = Some("https://mg.aid.pub/claude-proxy".to_string());

        let credential = stored_claude_credential_from_config(&config).unwrap();

        assert_eq!(credential.api_key, "sk-modelgate");
        assert_eq!(
            credential.base_url.as_deref(),
            Some("https://mg.aid.pub/claude-proxy")
        );
    }

    #[test]
    fn test_known_proxy_mismatch_rejects_modelgate_codex_proxy() {
        let error = known_proxy_mismatch_error(
            PROVIDER_OPENAI_COMPATIBLE,
            Some("https://mg.aid.pub/codex-proxy"),
        )
        .unwrap();

        assert!(error.contains("codex-proxy"));
        assert!(error.contains("Responses API"));
        assert!(error.contains("chat/completions"));
    }

    #[test]
    fn test_known_proxy_mismatch_rejects_claude_proxy_as_openai_compatible() {
        let error = known_proxy_mismatch_error(
            PROVIDER_OPENAI_COMPATIBLE,
            Some("https://mg.aid.pub/claude-proxy"),
        )
        .unwrap();

        assert!(error.contains("Claude-compatible proxy"));
        assert!(error.contains("Claude Code / Anthropic API"));
    }

    #[test]
    fn test_known_proxy_mismatch_allows_claude_proxy_for_claude_provider() {
        assert!(known_proxy_mismatch_error(
            PROVIDER_CLAUDE_CODE,
            Some("https://mg.aid.pub/claude-proxy"),
        )
        .is_none());
    }

    #[test]
    fn test_provider_id_lookup_none_does_not_fallback_to_active_provider() {
        let config = test_openai_compatible_auth_config();
        let credential = openai_compatible_credential_by_id_from_config(&config, None).unwrap();

        assert!(credential.is_none());
    }

    #[test]
    fn test_provider_id_lookup_uses_explicit_provider() {
        let config = test_openai_compatible_auth_config();
        let credential = openai_compatible_credential_by_id_from_config(&config, Some("deepseek"))
            .unwrap()
            .unwrap();

        assert_eq!(credential.id, "deepseek");
        assert_eq!(credential.model, "deepseek-chat");
    }

    #[test]
    fn test_deepseek_official_root_uses_native_anthropic_route() {
        let config = test_openai_compatible_auth_config();
        let credential = openai_compatible_credential_by_id_from_config(&config, Some("deepseek"))
            .unwrap()
            .unwrap();

        assert!(uses_native_anthropic_route(&credential));
        assert_eq!(
            native_anthropic_base_url(&credential).as_deref(),
            Some("https://api.deepseek.com/anthropic")
        );
    }

    #[test]
    fn test_qwen_official_anthropic_endpoint_uses_native_route() {
        let config = test_openai_compatible_auth_config();
        let credential = openai_compatible_credential_by_id_from_config(&config, Some("qwen"))
            .unwrap()
            .unwrap();

        assert!(uses_native_anthropic_route(&credential));
        assert_eq!(
            native_anthropic_base_url(&credential).as_deref(),
            Some("https://dashscope.aliyuncs.com/apps/anthropic")
        );
    }

    #[test]
    fn test_moonshot_official_anthropic_endpoint_uses_native_route() {
        let config = test_openai_compatible_auth_config();
        let credential = openai_compatible_credential_by_id_from_config(&config, Some("moonshot"))
            .unwrap()
            .unwrap();

        assert!(uses_native_anthropic_route(&credential));
        assert_eq!(
            native_anthropic_base_url(&credential).as_deref(),
            Some("https://api.moonshot.ai/anthropic")
        );
    }

    #[test]
    fn test_native_anthropic_route_preserves_explicit_anthropic_path() {
        let credential = StoredOpenAiCompatibleCredential {
            id: "deepseek-anthropic".to_string(),
            label: "DeepSeek".to_string(),
            api_key: "sk-test".to_string(),
            base_url: "https://api.deepseek.com/anthropic/v1".to_string(),
            model: "deepseek-v4-pro".to_string(),
            transformers: Vec::new(),
            model_transformers: HashMap::new(),
        };

        assert_eq!(
            native_anthropic_base_url(&credential).as_deref(),
            Some("https://api.deepseek.com/anthropic")
        );
    }

    #[test]
    fn test_non_deepseek_anthropic_path_stays_on_proxy_route() {
        let credential = StoredOpenAiCompatibleCredential {
            id: "other-anthropic".to_string(),
            label: "Other".to_string(),
            api_key: "sk-test".to_string(),
            base_url: "https://router.example.com/anthropic".to_string(),
            model: "qwen3".to_string(),
            transformers: Vec::new(),
            model_transformers: HashMap::new(),
        };

        assert!(!uses_native_anthropic_route(&credential));
        assert_eq!(native_anthropic_base_url(&credential), None);
    }

    #[test]
    fn test_qwen_legacy_compatible_mode_uses_native_anthropic_route() {
        let credential = StoredOpenAiCompatibleCredential {
            id: "qwen-compatible".to_string(),
            label: "Qwen".to_string(),
            api_key: "sk-test".to_string(),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            model: "qwen3-max-2026-01-23".to_string(),
            transformers: Vec::new(),
            model_transformers: HashMap::new(),
        };

        assert!(uses_native_anthropic_route(&credential));
        assert_eq!(
            native_anthropic_base_url(&credential).as_deref(),
            Some("https://dashscope.aliyuncs.com/apps/anthropic")
        );
    }

    #[test]
    fn test_moonshot_legacy_openai_mode_uses_native_anthropic_route() {
        let credential = StoredOpenAiCompatibleCredential {
            id: "moonshot-compatible".to_string(),
            label: "Moonshot / Kimi".to_string(),
            api_key: "sk-test".to_string(),
            base_url: "https://api.moonshot.ai/v1".to_string(),
            model: "kimi-k2.5".to_string(),
            transformers: Vec::new(),
            model_transformers: HashMap::new(),
        };

        assert!(uses_native_anthropic_route(&credential));
        assert_eq!(
            native_anthropic_base_url(&credential).as_deref(),
            Some("https://api.moonshot.ai/anthropic")
        );
    }

    #[test]
    fn test_moonshot_cn_urls_normalize_to_official_ai_route() {
        let credential = StoredOpenAiCompatibleCredential {
            id: "moonshot-compatible".to_string(),
            label: "Moonshot / Kimi".to_string(),
            api_key: "sk-test".to_string(),
            base_url: "https://api.moonshot.cn/v1".to_string(),
            model: "kimi-k2.5".to_string(),
            transformers: Vec::new(),
            model_transformers: HashMap::new(),
        };

        assert!(uses_native_anthropic_route(&credential));
        assert_eq!(
            native_anthropic_base_url(&credential).as_deref(),
            Some("https://api.moonshot.ai/anthropic")
        );
    }

    #[test]
    fn test_known_native_provider_routes_require_https() {
        for (base_url, model) in [
            ("http://api.deepseek.com/anthropic", "deepseek-chat"),
            ("http://dashscope.aliyuncs.com/apps/anthropic", "qwen3-max"),
            ("http://api.moonshot.ai/anthropic", "kimi-k2.5"),
        ] {
            let credential = StoredOpenAiCompatibleCredential {
                id: "insecure".to_string(),
                label: "Insecure".to_string(),
                api_key: "sk-test".to_string(),
                base_url: base_url.to_string(),
                model: model.to_string(),
                transformers: Vec::new(),
                model_transformers: HashMap::new(),
            };

            assert!(!uses_native_anthropic_route(&credential));
            assert!(ensure_secure_known_provider_base_url(base_url).is_err());
        }

        assert!(ensure_secure_known_provider_base_url("http://localhost:11434/v1").is_ok());
    }

    #[test]
    fn test_provider_id_lookup_rejects_missing_provider() {
        let config = test_openai_compatible_auth_config();
        let error =
            openai_compatible_credential_by_id_from_config(&config, Some("missing")).unwrap_err();

        assert!(error.contains("Configured provider credential not found"));
    }

    #[test]
    fn test_openai_chat_completions_url_preserves_full_endpoint() {
        assert_eq!(
            openai_chat_completions_url("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
    }

    #[test]
    fn test_openai_chat_completions_url_supports_common_provider_roots() {
        assert_eq!(
            openai_chat_completions_url("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://generativelanguage.googleapis.com/v1beta/openai/"),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://open.bigmodel.cn/api/paas/v4"),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://api.deepseek.com"),
            "https://api.deepseek.com/chat/completions"
        );
    }

    #[test]
    fn test_anthropic_messages_url_matches_deepseek_native_base() {
        assert_eq!(
            anthropic_messages_url("https://api.deepseek.com/anthropic"),
            "https://api.deepseek.com/anthropic/v1/messages"
        );
        assert_eq!(
            anthropic_messages_url("https://api.deepseek.com/anthropic/v1"),
            "https://api.deepseek.com/anthropic/v1/messages"
        );
    }

    #[test]
    fn test_anthropic_response_has_message_content_with_thinking_block() {
        let response = serde_json::json!({
            "content": [{
                "type": "thinking",
                "thinking": "We need to output ok."
            }]
        });

        assert!(anthropic_response_has_message_content(&response));
    }

    #[test]
    fn test_anthropic_response_has_message_content_with_empty_content() {
        let response = serde_json::json!({});

        assert!(!anthropic_response_has_message_content(&response));
    }

    #[test]
    fn test_openai_chat_completions_url_keeps_generic_openai_default() {
        assert_eq!(
            openai_chat_completions_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
    }

    #[test]
    fn test_openai_chat_completions_url_supports_ollama_roots() {
        assert_eq!(
            openai_chat_completions_url("http://localhost:11434"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn test_openai_models_url_matches_provider_roots() {
        assert_eq!(
            openai_models_url("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
        );
        assert_eq!(
            openai_models_url("https://dashscope.aliyuncs.com/apps/anthropic"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
        );
        assert_eq!(
            openai_models_url("https://api.moonshot.cn/anthropic"),
            "https://api.moonshot.ai/v1/models"
        );
        assert_eq!(
            openai_models_url("https://api.moonshot.ai/anthropic"),
            "https://api.moonshot.ai/v1/models"
        );
        assert_eq!(
            openai_models_url("https://generativelanguage.googleapis.com/v1beta/openai/"),
            "https://generativelanguage.googleapis.com/v1beta/openai/models"
        );
        assert_eq!(
            openai_models_url("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
            "https://open.bigmodel.cn/api/paas/v4/models"
        );
        assert_eq!(
            openai_models_url("https://api.openai.com"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            openai_models_url("https://api.deepseek.com/anthropic"),
            "https://api.deepseek.com/models"
        );
        assert_eq!(
            openai_models_url("http://localhost:11434"),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            openai_models_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1/models"
        );
    }

    #[test]
    fn test_anthropic_models_url_matches_provider_roots() {
        assert_eq!(
            anthropic_models_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(
            anthropic_models_url("https://gateway.example.com/anthropic/v1"),
            "https://gateway.example.com/anthropic/v1/models"
        );
        assert_eq!(
            anthropic_models_url("https://gateway.example.com/anthropic/v1/models"),
            "https://gateway.example.com/anthropic/v1/models"
        );
    }

    #[test]
    fn test_openai_compatible_api_key_can_be_empty_for_local_providers() {
        assert!(normalize_api_key("").is_err());
        assert_eq!(normalize_optional_api_key("").unwrap(), "");
        assert_eq!(normalize_optional_api_key(" ollama ").unwrap(), "ollama");
        assert!(normalize_optional_api_key("bad key").is_err());
    }

    #[test]
    fn test_openai_compatible_verification_body_uses_chat_messages_without_tools() {
        let body = openai_compatible_verification_body("qwen3-coder-plus");

        assert_eq!(body["model"], "qwen3-coder-plus");
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"][0]["role"], "user");
        assert!(body.get("tools").is_none());
        assert!(body.get("functions").is_none());
    }

    #[test]
    fn test_openai_compatible_verification_error_is_actionable() {
        let unauthorized = openai_compatible_verification_error(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{ "error": { "message": "bad key" } }"#,
        );
        assert!(unauthorized.contains("Invalid provider API key"));
        assert!(unauthorized.contains("bad key"));

        let not_found =
            openai_compatible_verification_error(reqwest::StatusCode::NOT_FOUND, "no model");
        assert!(not_found.contains("Base URL and model name"));

        let rate_limited =
            openai_compatible_verification_error(reqwest::StatusCode::TOO_MANY_REQUESTS, "");
        assert!(rate_limited.contains("rate limited"));
    }

    // --- create_command ---

    #[test]
    fn test_create_command_sets_args_and_cwd() {
        let args = vec!["--version".to_string()];
        let cmd = create_command("/usr/bin/claude", args, "/tmp/project", None);
        // Command is created 鈥?we can verify via its Debug representation
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
        let text = "a".repeat(100);
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
        // dots and underscores are non-alphanumeric 鈫?replaced with '-'
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

    #[test]
    fn test_sanitize_model_session_title_strips_wrappers() {
        let title = sanitize_model_session_title("`Title: FastVID Paper Revision`\nignored")
            .expect("title should be accepted");
        assert_eq!(title, "FastVID Paper Revision");
    }

    #[test]
    fn test_session_title_cache_survives_session_modification() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, "").unwrap();

        write_session_title_cache(&path, 10, "Aftershock Modeling").unwrap();
        assert_eq!(
            read_session_title_cache(&path).unwrap(),
            "Aftershock Modeling"
        );
        assert_eq!(
            read_session_title_cache(&path).unwrap(),
            "Aftershock Modeling"
        );
    }

    #[test]
    fn test_session_excerpt_for_model_title_collects_displayable_turns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let lines = r#"{"type":"user","message":{"content":"<ide_context>skip"}}
{"type":"user","message":{"content":[{"type":"text","text":"Please rewrite the FlashVID related work"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"I will compare FlashVID with FastVID."}]}}"#;
        std::fs::write(&path, lines).unwrap();

        let excerpt = session_excerpt_for_model_title(&path).expect("excerpt should exist");
        assert!(!excerpt.contains("<ide_context>"));
        assert!(excerpt.contains("User: Please rewrite"));
        assert!(excerpt.contains("Assistant: I will compare"));
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
        let paths =
            unix_claude_candidate_paths(&home, Some(std::ffi::OsString::from("/custom/pnpm")));
        assert!(paths.contains(&PathBuf::from("/custom/pnpm").join("claude")));
        assert!(paths.contains(&home.join("Library").join("pnpm").join("claude")));
        assert!(paths.contains(
            &home
                .join(".local")
                .join("share")
                .join("pnpm")
                .join("claude")
        ));
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
        assert!(paths.contains(
            &home
                .join(".local")
                .join("share")
                .join("pnpm")
                .join("claude")
        ));
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
        assert!(paths.contains(&home.join(".pnpm").join("global").join("bin").join("claude")));
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
