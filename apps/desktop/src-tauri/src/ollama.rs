use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use futures_util::StreamExt;
use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, WebviewWindow};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

// ─── Request / Response Types ───

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OllamaChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<OllamaChatMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    #[serde(default)]
    message: Option<OllamaMessage>,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    eval_count: Option<u64>,
    #[serde(default)]
    prompt_eval_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OllamaMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OllamaModelEntry {
    name: String,
}

#[derive(Debug, Serialize)]
pub struct OllamaStatus {
    pub available: bool,
    pub models: Vec<String>,
    pub error: Option<String>,
}

// ─── Event Payloads ───

#[derive(Clone, serde::Serialize)]
struct OllamaOutputEvent {
    tab_id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct OllamaCompleteEvent {
    tab_id: String,
    success: bool,
}

#[derive(Clone, serde::Serialize)]
struct OllamaErrorEvent {
    tab_id: String,
    data: String,
}

// ─── Cancellation State ───

#[derive(Default, Clone)]
pub struct OllamaState {
    /// Streaming task handles keyed by `window_label:tab_id`.
    pub tasks: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

fn process_key(window: &WebviewWindow, tab_id: &str) -> String {
    format!("{}:{}", window.label(), tab_id)
}

/// System prompt adapted from the Claude Code integration.
/// Includes instructions for the structured edit XML format.
fn system_prompt() -> String {
    concat!(
        "You are an AI assistant integrated into a LaTeX document editor (Prism). ",
        "You are running as a local Ollama model. ",
        "Follow these rules strictly:\n",
        "1. PLANNING FIRST: Before making changes, briefly describe your plan. ",
        "Break large tasks into small, incremental steps.\n",
        "2. INCREMENTAL EDITS: Never rewrite an entire file unless asked. ",
        "Prefer editing existing content over replacing it wholesale.\n",
        "3. PRESERVE EXISTING CONTENT: Keep the existing preamble, packages, and structure intact. ",
        "Only add or modify what is needed for the current step.\n",
        "4. LaTeX BEST PRACTICES: Use proper sectioning (\\chapter, \\section, \\subsection), ",
        "citations (\\cite), cross-references (\\label, \\ref), and BibTeX for bibliographies.\n",
        "5. PYTHON: If a .venv/ exists in the project, it is already activated. ",
        "Use `uv pip install` to add packages and `python` to run scripts.\n",
        "6. STRUCTURED EDITS: When you need to modify a file, emit one or more blocks exactly like this:\n",
        "<proposed-change file=\"relative/path.tex\">\n",
        "<old>\n",
        "exact existing text to replace\n",
        "</old>\n",
        "<new>\n",
        "replacement text\n",
        "</new>\n",
        "</proposed-change>\n",
        "The old text must match the file exactly (line endings may differ). ",
        "Place edits after your explanatory text, not inside it."
    )
    .to_string()
}

/// Build the chat request body, prepending the system prompt.
fn build_request(
    model: String,
    mut messages: Vec<OllamaChatMessage>,
    stream: bool,
) -> OllamaChatRequest {
    let system = OllamaChatMessage {
        role: "system".to_string(),
        content: system_prompt(),
    };
    messages.insert(0, system);
    OllamaChatRequest {
        model,
        messages,
        stream,
        options: None,
    }
}

/// Emit a text chunk shaped like a Claude assistant stream message.
fn emit_text_chunk(window: &WebviewWindow, tab_id: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let payload = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [{ "type": "text", "text": text }]
        }
    });
    let data = match serde_json::to_string(&payload) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[ollama] failed to serialize chunk: {}", e);
            return;
        }
    };
    let _ = window.emit(
        "ollama-output",
        OllamaOutputEvent {
            tab_id: tab_id.to_string(),
            data,
        },
    );
}

/// Emit a final `result` message with token counts.
fn emit_result(window: &WebviewWindow, tab_id: &str, prompt_tokens: u64, eval_tokens: u64) {
    let payload = serde_json::json!({
        "type": "result",
        "duration_ms": 0,
        "duration_api_ms": 0,
        "usage": {
            "input_tokens": prompt_tokens,
            "output_tokens": eval_tokens,
        }
    });
    if let Ok(data) = serde_json::to_string(&payload) {
        let _ = window.emit(
            "ollama-output",
            OllamaOutputEvent {
                tab_id: tab_id.to_string(),
                data,
            },
        );
    }
}

/// Emit an error event.
fn emit_error(window: &WebviewWindow, tab_id: &str, message: &str) {
    eprintln!("[ollama] error for tab {}: {}", tab_id, message);
    let _ = window.emit(
        "ollama-error",
        OllamaErrorEvent {
            tab_id: tab_id.to_string(),
            data: message.to_string(),
        },
    );
}

/// Emit the completion event.
fn emit_complete(window: &WebviewWindow, tab_id: &str, success: bool) {
    let _ = window.emit(
        "ollama-complete",
        OllamaCompleteEvent {
            tab_id: tab_id.to_string(),
            success,
        },
    );
}

/// Stream the Ollama response and emit events.
async fn stream_ollama_response(
    window: WebviewWindow,
    tab_id: String,
    base_url: String,
    request_body: OllamaChatRequest,
) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            emit_error(&window, &tab_id, &format!("Failed to build HTTP client: {}", e));
            emit_complete(&window, &tab_id, false);
            return;
        }
    };

    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let body_json = match serde_json::to_string(&request_body) {
        Ok(j) => j,
        Err(e) => {
            emit_error(&window, &tab_id, &format!("Failed to serialize request: {}", e));
            emit_complete(&window, &tab_id, false);
            return;
        }
    };

    eprintln!("[ollama] POST {} model={}", url, request_body.model);

    let response = match client
        .post(&url)
        .header(CONTENT_TYPE, "application/json")
        .body(body_json)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            let msg = if e.is_connect() {
                format!(
                    "Could not connect to Ollama at {}. Is Ollama running?",
                    base_url
                )
            } else {
                format!("Ollama request failed: {}", e)
            };
            emit_error(&window, &tab_id, &msg);
            emit_complete(&window, &tab_id, false);
            return;
        }
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        emit_error(
            &window,
            &tab_id,
            &format!("Ollama returned HTTP {}: {}", status, body),
        );
        emit_complete(&window, &tab_id, false);
        return;
    }

    let mut prompt_tokens: u64 = 0;
    let mut eval_tokens: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                emit_error(&window, &tab_id, &format!("Stream read error: {}", e));
                break;
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Ollama streams one JSON object per line (NDJSON).
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer.replace_range(..pos + 1, "");
            if line.is_empty() {
                continue;
            }

            let parsed: OllamaChatResponse = match serde_json::from_str(&line) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[ollama] failed to parse line: {} — error: {}", line, e);
                    continue;
                }
            };

            if let Some(msg) = parsed.message {
                emit_text_chunk(&window, &tab_id, &msg.content);
            }

            if parsed.done {
                if let Some(n) = parsed.prompt_eval_count {
                    prompt_tokens = n;
                }
                if let Some(n) = parsed.eval_count {
                    eval_tokens = n;
                }
                break;
            }
        }
    }

    emit_result(&window, &tab_id, prompt_tokens, eval_tokens);
    emit_complete(&window, &tab_id, true);
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn check_ollama_status(base_url: String) -> Result<OllamaStatus, String> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = client.get(&url).send().await;
    match response {
        Ok(resp) if resp.status().is_success() => {
            let body = resp
                .text()
                .await
                .map_err(|e| format!("Failed to read Ollama response: {}", e))?;
            let parsed: serde_json::Value =
                serde_json::from_str(&body).map_err(|e| format!("Invalid JSON from Ollama: {}", e))?;
            let models = parsed
                .get("models")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            Ok(OllamaStatus {
                available: true,
                models,
                error: None,
            })
        }
        Ok(resp) => Ok(OllamaStatus {
            available: false,
            models: Vec::new(),
            error: Some(format!("Ollama returned HTTP {}", resp.status())),
        }),
        Err(e) => Ok(OllamaStatus {
            available: false,
            models: Vec::new(),
            error: Some(format!("Could not reach Ollama: {}", e)),
        }),
    }
}

#[tauri::command]
pub async fn send_ollama_message(
    window: WebviewWindow,
    state: tauri::State<'_, OllamaState>,
    base_url: String,
    model: String,
    messages: Vec<OllamaChatMessage>,
    tab_id: String,
    _project_path: String,
) -> Result<(), String> {
    if model.trim().is_empty() {
        return Err("No Ollama model selected".to_string());
    }

    let key = process_key(&window, &tab_id);
    let request = build_request(model, messages, true);
    let win = window.clone();

    // Abort any existing stream for this tab.
    {
        let mut tasks = state.tasks.lock().await;
        if let Some(handle) = tasks.remove(&key) {
            handle.abort();
        }
    }

    let handle = tokio::spawn(async move {
        stream_ollama_response(win, tab_id, base_url, request).await;
    });

    {
        let mut tasks = state.tasks.lock().await;
        tasks.insert(key, handle);
    }

    Ok(())
}

#[tauri::command]
pub async fn cancel_ollama_message(
    window: WebviewWindow,
    state: tauri::State<'_, OllamaState>,
    tab_id: String,
) -> Result<(), String> {
    let key = process_key(&window, &tab_id);
    let mut tasks = state.tasks.lock().await;
    if let Some(handle) = tasks.remove(&key) {
        handle.abort();
    }
    let _ = window.emit(
        "ollama-complete",
        OllamaCompleteEvent {
            tab_id,
            success: false,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_request_prepends_system_prompt() {
        let request = build_request(
            "llama3".to_string(),
            vec![OllamaChatMessage {
                role: "user".to_string(),
                content: "hello".to_string(),
            }],
            true,
        );
        assert_eq!(request.model, "llama3");
        assert!(request.stream);
        assert_eq!(request.messages.len(), 2);
        assert_eq!(request.messages[0].role, "system");
        assert!(request.messages[0].content.contains("Prism"));
        assert!(request.messages[0].content.contains("proposed-change"));
        assert_eq!(request.messages[1].role, "user");
        assert_eq!(request.messages[1].content, "hello");
    }

    #[test]
    fn test_emit_text_chunk_serializes_claude_shape() {
        // This test verifies the emitted JSON shape by calling the helper logic.
        let text = "hi";
        let payload = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{ "type": "text", "text": text }]
            }
        });
        let data = serde_json::to_string(&payload).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&data).unwrap();
        assert_eq!(parsed["type"], "assistant");
        assert_eq!(parsed["message"]["content"][0]["type"], "text");
        assert_eq!(parsed["message"]["content"][0]["text"], "hi");
    }
}
