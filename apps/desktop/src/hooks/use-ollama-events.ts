import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import {
  parseOllamaProposedChanges,
  applyOllamaEdit,
} from "@/lib/ollama-edit-parser";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("ollama-event");

interface OllamaOutputPayload {
  tab_id: string;
  data: string;
}

interface OllamaCompletePayload {
  tab_id: string;
  success: boolean;
}

interface OllamaErrorPayload {
  tab_id: string;
  data: string;
}

/**
 * Hook that manages Tauri event listeners for Ollama streaming output.
 *
 * Ollama responses are plain text, so we accumulate them per tab and convert
 * each chunk into a Claude-shaped assistant message so the existing chat UI
 * can render it. After the stream completes, we parse the full response for
 * `<proposed-change>` blocks and register them as proposed changes.
 */
export function useOllamaEvents() {
  // Per-tab mutable state stored in refs so long-lived listeners read latest.
  const accumulatedTextRef = useRef(new Map<string, string>());
  const listenersRef = useRef<UnlistenFn[]>([]);

  // Reset accumulator whenever a tab starts streaming
  const tabs = useClaudeChatStore((s) => s.tabs);
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.isStreaming) {
        accumulatedTextRef.current.set(tab.id, "");
      } else {
        // Keep the accumulated text for a moment so the complete handler
        // can still read it; it will clean up after itself.
      }
    }
  }, [tabs]);

  useEffect(() => {
    function appendTextChunk(tabId: string, text: string) {
      if (!text) return;
      const current = accumulatedTextRef.current.get(tabId) ?? "";
      accumulatedTextRef.current.set(tabId, current + text);
      useClaudeChatStore.getState()._appendStreamingText(tabId, text);
    }

    async function registerProposedChanges(
      tabId: string,
      responseText: string,
    ) {
      const docState = useDocumentStore.getState();
      const projectRoot = docState.projectRoot;
      if (!projectRoot) return;

      const edits = parseOllamaProposedChanges(responseText);
      if (edits.length === 0) return;

      const warnings: string[] = [];
      for (const edit of edits) {
        const file = docState.files.find(
          (f) => f.relativePath === edit.filePath,
        );
        if (!file) {
          warnings.push(`Could not find file: ${edit.filePath}`);
          continue;
        }
        const currentContent = file.content ?? "";
        const newContent = applyOllamaEdit(
          currentContent,
          edit.oldText,
          edit.newText,
        );
        if (newContent === null) {
          warnings.push(
            `Could not locate the specified text in ${edit.filePath}`,
          );
          continue;
        }
        useProposedChangesStore.getState().addChange({
          id: `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filePath: file.relativePath,
          absolutePath: file.absolutePath,
          oldContent: currentContent,
          newContent,
          toolName: "OllamaEdit",
        });
      }

      if (warnings.length > 0) {
        const chatStore = useClaudeChatStore.getState();
        chatStore._appendMessage(tabId, {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text:
                  "_Some edits could not be applied:_\n\n" +
                  warnings.map((w) => `- ${w}`).join("\n"),
              },
            ],
          },
        });
      }
    }

    async function handleComplete(payload: OllamaCompletePayload) {
      const { tab_id: tabId, success } = payload;
      const chatStore = useClaudeChatStore.getState();
      const tab = chatStore.tabs.find((t) => t.id === tabId);
      if (!tab?.isStreaming) {
        log.warn(`[${tabId}] ignoring duplicate ollama-complete event`);
        return;
      }

      log.info(`[${tabId}] ollama complete success=${success}`);

      if (!success && !tab.error && !chatStore._cancelledByUser) {
        chatStore._setError(
          tabId,
          "Ollama response failed. Check that Ollama is running and the model is available.",
        );
      }

      // Parse any structured edits from the full response.
      const responseText = accumulatedTextRef.current.get(tabId) ?? "";
      if (success && responseText) {
        await registerProposedChanges(tabId, responseText);
      }

      accumulatedTextRef.current.delete(tabId);
      chatStore._setStreaming(tabId, false);

      // Snapshot after Ollama response.
      const projectPath = useDocumentStore.getState().projectRoot;
      if (projectPath) {
        try {
          await useHistoryStore
            .getState()
            .createSnapshot(projectPath, "[ollama] After Ollama response");
        } catch {
          /* snapshot failure should not break the flow */
        }
      }

      await useDocumentStore.getState().refreshFiles();
    }

    let cancelled = false;
    (async () => {
      const unlistenOutput = await listen<OllamaOutputPayload>(
        "ollama-output",
        (event) => {
          if (cancelled) return;
          const { tab_id: tabId, data } = event.payload;
          let msg;
          try {
            msg = JSON.parse(data);
          } catch {
            return;
          }

          const type = msg?.type;
          if (type === "assistant" && Array.isArray(msg?.message?.content)) {
            for (const block of msg.message.content) {
              if (block?.type === "text" && typeof block.text === "string") {
                appendTextChunk(tabId, block.text);
              }
            }
          } else if (type === "result") {
            // Result metadata — append to the chat store for token accounting.
            useClaudeChatStore.getState()._appendMessage(tabId, msg);
          }
        },
      );
      if (cancelled) {
        unlistenOutput();
        return;
      }
      listenersRef.current.push(unlistenOutput);

      const unlistenComplete = await listen<OllamaCompletePayload>(
        "ollama-complete",
        (event) => {
          if (!cancelled) handleComplete(event.payload);
        },
      );
      if (cancelled) {
        unlistenComplete();
        return;
      }
      listenersRef.current.push(unlistenComplete);

      const unlistenError = await listen<OllamaErrorPayload>(
        "ollama-error",
        (event) => {
          if (cancelled) return;
          const { tab_id: tabId, data } = event.payload;
          log.error(`[${tabId}] ollama-error: ${data}`);
          useClaudeChatStore.getState()._setError(tabId, data);
        },
      );
      if (cancelled) {
        unlistenError();
        return;
      }
      listenersRef.current.push(unlistenError);
    })();

    return () => {
      cancelled = true;
      for (const unlisten of listenersRef.current) {
        unlisten();
      }
      listenersRef.current = [];
    };
  }, []);
}
