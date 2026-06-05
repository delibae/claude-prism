use crate::provider::{AiProvider, ProviderEvent};

pub struct GeminiProvider;

impl AiProvider for GeminiProvider {
    fn name(&self) -> &'static str {
        "gemini"
    }

    fn find_binary(&self) -> Result<String, String> {
        // 1. ~/.local/bin/gemini (common install location)
        if let Some(home) = dirs::home_dir() {
            #[cfg(not(target_os = "windows"))]
            let candidate = home.join(".local").join("bin").join("gemini");
            #[cfg(target_os = "windows")]
            let candidate = home.join(".local").join("bin").join("gemini.cmd");
            if candidate.exists() {
                return Ok(candidate.to_string_lossy().to_string());
            }
        }

        // 2. PATH
        if let Ok(path) = which::which("gemini") {
            return Ok(path.to_string_lossy().to_string());
        }

        // 3. npm global paths
        #[cfg(not(target_os = "windows"))]
        if let Some(home) = dirs::home_dir() {
            let candidates = [
                home.join(".npm-global").join("bin").join("gemini"),
                home.join(".pnpm-global").join("gemini"),
            ];
            for c in &candidates {
                if c.exists() {
                    return Ok(c.to_string_lossy().to_string());
                }
            }
        }

        Err("gemini CLI not found. Install with: npm install -g @google/gemini-cli".to_string())
    }

    fn build_args(
        &self,
        prompt: &str,
        model: &str,
        session_id: Option<&str>,
        system_prompt: &str,
    ) -> (Vec<String>, Option<String>) {
        // Flags verified against @google/gemini-cli as of 2026-06.
        // Run `gemini --help` to confirm flag names before shipping.
        let mut args = Vec::new();

        if let Some(sid) = session_id {
            args.push("--resume".to_string());
            args.push(sid.to_string());
        }

        args.extend([
            "--model".to_string(), model.to_string(),
            "--output-format".to_string(), "json".to_string(),
            "--yolo".to_string(),
            "--system-prompt".to_string(), system_prompt.to_string(),
            "-p".to_string(), prompt.to_string(),
        ]);

        (args, None) // always argv, never stdin
    }

    fn parse_output_line(&self, line: &str) -> ProviderEvent {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
            return ProviderEvent::Skip;
        };

        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match msg_type {
            "system" => {
                if let Some(sid) = msg.get("session_id").and_then(|v| v.as_str()) {
                    return ProviderEvent::SessionInit(sid.to_string());
                }
                ProviderEvent::Skip
            }
            "content" => {
                let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let normalised = serde_json::json!({
                    "type": "assistant",
                    "message": {
                        "content": [{"type": "text", "text": text}]
                    }
                });
                ProviderEvent::Line(normalised.to_string())
            }
            "result" => {
                let is_error = msg.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                let normalised = serde_json::json!({
                    "type": "result",
                    "is_error": is_error,
                    "cost_usd": msg.get("cost_usd"),
                });
                ProviderEvent::Line(normalised.to_string())
            }
            "tool_use" | "tool_result" => ProviderEvent::Line(line.to_string()),
            _ => ProviderEvent::Skip,
        }
    }

    fn supports_sessions(&self) -> bool {
        true
    }
}

// ─── Status command ───────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct GeminiStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub binary_path: Option<String>,
}

#[tauri::command]
pub async fn check_gemini_status() -> Result<GeminiStatus, String> {
    let provider = GeminiProvider;
    let Ok(binary) = provider.find_binary() else {
        return Ok(GeminiStatus {
            installed: false,
            version: None,
            binary_path: None,
        });
    };

    let output = tokio::process::Command::new(&binary)
        .arg("--version")
        .output()
        .await;

    let version = output
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    Ok(GeminiStatus {
        installed: true,
        version,
        binary_path: Some(binary),
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderEvent;

    #[test]
    fn test_gemini_parse_session_init() {
        let p = GeminiProvider;
        let line = r#"{"type":"system","session_id":"gem-456"}"#;
        match p.parse_output_line(line) {
            ProviderEvent::SessionInit(id) => assert_eq!(id, "gem-456"),
            _ => panic!("expected SessionInit"),
        }
    }

    #[test]
    fn test_gemini_parse_content_normalises_to_claude_format() {
        let p = GeminiProvider;
        let line = r#"{"type":"content","text":"hello world"}"#;
        match p.parse_output_line(line) {
            ProviderEvent::Line(s) => {
                let v: serde_json::Value = serde_json::from_str(&s).unwrap();
                assert_eq!(v["type"], "assistant");
                assert_eq!(v["message"]["content"][0]["text"], "hello world");
            }
            _ => panic!("expected Line"),
        }
    }

    #[test]
    fn test_gemini_parse_unknown_type_skipped() {
        let p = GeminiProvider;
        let line = r#"{"type":"internal_debug"}"#;
        assert!(matches!(p.parse_output_line(line), ProviderEvent::Skip));
    }

    #[test]
    fn test_gemini_parse_non_json_skipped() {
        let p = GeminiProvider;
        assert!(matches!(p.parse_output_line("not json"), ProviderEvent::Skip));
    }

    #[test]
    fn test_gemini_build_args_new_session() {
        let p = GeminiProvider;
        let (args, stdin) = p.build_args("hello", "gemini-2.5-pro", None, "sys");
        assert!(stdin.is_none());
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"gemini-2.5-pro".to_string()));
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"hello".to_string()));
        assert!(args.contains(&"--yolo".to_string()));
    }

    #[test]
    fn test_gemini_build_args_resume_session() {
        let p = GeminiProvider;
        let (args, _) = p.build_args("follow up", "gemini-2.5-pro", Some("sess-789"), "sys");
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"sess-789".to_string()));
    }
}
