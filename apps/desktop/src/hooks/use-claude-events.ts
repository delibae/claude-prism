import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  useClaudeChatStore,
  type ClaudeStreamMessage,
} from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { readTexFileContent } from "@/lib/tauri/fs";
import { compileLatex } from "@/lib/latex-compiler";

/**
 * Hook that manages Tauri event listeners for Claude CLI streaming output.
 *
 * Listeners are kept alive at all times (no race condition with invoke).
 * Session-scoped state (pendingToolUses, hasTexChanges) is reset each time
 * isStreaming flips to true.
 */
export function useClaudeEvents() {
  // Per-session mutable state stored in refs so the long-lived listeners
  // always read the latest values without needing to be re-created.
  const pendingToolUsesRef = useRef(
    new Map<string, { name: string; input: any }>(),
  );
  const hasTexChangesRef = useRef(false);
  const cancelledForAskRef = useRef(false);
  const listenersRef = useRef<UnlistenFn[]>([]);

  // Reset per-session state whenever a new stream starts
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  useEffect(() => {
    if (isStreaming) {
      pendingToolUsesRef.current = new Map();
      hasTexChangesRef.current = false;
      cancelledForAskRef.current = false;
    }
  }, [isStreaming]);

  // ── One-time listener setup (mount only) ──
  useEffect(() => {
    async function registerProposedChange(
      filePath: string,
      toolUseId: string,
      toolName: string,
    ) {
      const docState = useDocumentStore.getState();
      const projectRoot = docState.projectRoot;
      let relativePath = filePath;
      if (projectRoot && filePath.startsWith(projectRoot)) {
        relativePath = filePath.slice(projectRoot.length).replace(/^\//, "");
      }
      const file = docState.files.find(
        (f) => f.relativePath === relativePath || f.absolutePath === filePath,
      );
      if (!file) return;

      const oldContent = file.content ?? "";
      try {
        const newContent = await readTexFileContent(file.absolutePath);
        if (oldContent !== newContent) {
          useProposedChangesStore.getState().addChange({
            id: toolUseId,
            filePath: file.relativePath,
            absolutePath: file.absolutePath,
            oldContent,
            newContent,
            toolName,
          });
        }
      } catch {
        // readTexFileContent failed — not critical
      }
    }

    let msgCount = 0;
    let streamStartTime = 0;
    let lastMsgTime = 0;

    function elapsed() {
      if (!streamStartTime) return "";
      return `+${((performance.now() - streamStartTime) / 1000).toFixed(1)}s`;
    }

    function handleStreamMessage(payload: string) {
      let msg: ClaudeStreamMessage;
      try {
        msg = JSON.parse(payload);
      } catch {
        return;
      }

      const chatStore = useClaudeChatStore.getState();

      // Only process messages while streaming
      if (!chatStore.isStreaming) return;

      msgCount++;
      const now = performance.now();
      if (msgCount === 1) streamStartTime = now;
      const gap = lastMsgTime ? ((now - lastMsgTime) / 1000).toFixed(1) : "0";
      lastMsgTime = now;

      // Log ALL message types with gap detection
      const contentTypes = msg.message?.content?.map((b: any) => b.type).join(",") ?? "";
      const gapWarning = Number(gap) > 10 ? ` ⚠️ GAP ${gap}s` : "";
      console.log(`[claude-event] ${elapsed()} #${msgCount} type=${msg.type} sub=${msg.subtype ?? ""} content=[${contentTypes}] gap=${gap}s${gapWarning}`);

      if (msg.type === "assistant") {
        const thinkingBlock = msg.message?.content?.find((b: any) => b.type === "thinking");
        if (thinkingBlock) {
          console.log(`[claude-event] ${elapsed()} 🧠 thinking: ${(thinkingBlock.thinking || "").slice(0, 100)}`);
        }
        const textBlock = msg.message?.content?.find((b: any) => b.type === "text");
        if (textBlock?.text) {
          console.log(`[claude-event] ${elapsed()} 💬 text: ${textBlock.text.slice(0, 100)}`);
        }
        const toolBlock = msg.message?.content?.find((b: any) => b.type === "tool_use");
        if (toolBlock) {
          console.log(`[claude-event] ${elapsed()} 🔧 tool_use: ${toolBlock.name} ${toolBlock.input?.file_path ?? ""}`);
        }
      }
      if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            const preview = typeof block.content === "string" ? block.content.slice(0, 80) : JSON.stringify(block.content)?.slice(0, 80);
            console.log(`[claude-event] ${elapsed()} 📋 tool_result: id=${block.tool_use_id} err=${block.is_error ?? false} len=${preview?.length ?? 0}`);
          }
        }
      }
      if (msg.type === "result") {
        console.log(`[claude-event] ${elapsed()} ✅ result cost=$${msg.cost_usd} api=${msg.duration_api_ms}ms total=${msg.duration_ms}ms`);
      }

      // Extract session_id from system:init
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        chatStore._setSessionId(msg.session_id);
      }

      // Detect rate limit events and surface to user — never append to messages
      if ((msg as any).type === "rate_limit_event") {
        const info = (msg as any).rate_limit_info;
        if (info) {
          const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "unknown";
          console.warn(`[claude-event] 🚦 rate_limit: status=${info.status} type=${info.rateLimitType} resets=${resetsAt} overage=${info.overageStatus}`);
          if (info.status !== "allowed") {
            chatStore._setError(`Rate limited (${info.rateLimitType}). Resets at ${resetsAt}`);
          }
        }
        return; // rate_limit_event is informational — do not append to messages
      }

      // Track tool_use blocks for file change detection
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use" && block.id && block.name) {
            pendingToolUsesRef.current.set(block.id, {
              name: block.name,
              input: block.input,
            });
          }
        }
      }

      // Detect file modifications from tool_results → register as proposed changes
      if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const toolUse = pendingToolUsesRef.current.get(
              block.tool_use_id,
            );
            if (
              toolUse &&
              !block.is_error &&
              /^(Write|write|Edit|edit|MultiEdit|multiedit)$/.test(toolUse.name)
            ) {
              const fp = toolUse.input?.file_path || toolUse.input?.path;
              if (fp) {
                registerProposedChange(fp, block.tool_use_id!, toolUse.name);
                if (/\.(tex|bib|sty|cls|dtx)$/i.test(fp)) {
                  hasTexChangesRef.current = true;
                }
              }
            }
          }
        }
      }

      // Skip duplicate user messages we already added locally
      if (
        msg.type === "user" &&
        msg.message?.content?.length === 1 &&
        msg.message.content[0].type === "text"
      ) {
        return;
      }

      chatStore._appendMessage(msg);

      // When AskUserQuestion is detected, cancel the process so the user
      // can interact with the widget before Claude continues.
      if (msg.type === "assistant" && msg.message?.content) {
        const hasAskUser = msg.message.content.some(
          (b: any) => b.type === "tool_use" && b.name === "AskUserQuestion",
        );
        if (hasAskUser) {
          console.log(`[claude-event] ${elapsed()} ⏸️ AskUserQuestion detected — cancelling process for user input`);
          cancelledForAskRef.current = true;
          invoke("cancel_claude_execution").catch(() => {});
        }
      }
    }

    async function handleComplete(success: boolean) {
      console.log(`[claude-event] ${elapsed()} 🏁 complete success=${success} (${msgCount} messages) cancelledForAsk=${cancelledForAskRef.current}`);
      const chatStore = useClaudeChatStore.getState();

      // Guard against duplicate complete events
      if (!chatStore.isStreaming) {
        console.warn(`[claude-event] ⚠️ ignoring duplicate complete event (not streaming)`);
        return;
      }

      if (!success && msgCount > 0 && !chatStore.error && !cancelledForAskRef.current) {
        // Process failed but we received some messages — likely rate limit or API error
        chatStore._setError("Claude process exited unexpectedly. This may be due to rate limiting or an API error.");
      }
      msgCount = 0;
      streamStartTime = 0;
      lastMsgTime = 0;
      chatStore._setStreaming(false);

      // Snapshot after Claude edit — awaited so the history store updates before UI refreshes
      const projectPath = useDocumentStore.getState().projectRoot;
      if (projectPath) {
        try {
          await useHistoryStore.getState().createSnapshot(projectPath, "[claude] After Claude edit");
        } catch {
          // snapshot failure should not break the flow
        }
      }

      const docStore = useDocumentStore.getState();
      await docStore.refreshFiles();

      // Auto-recompile after Claude finishes — always attempt if a tex file exists.
      // Skip if another compilation is already in progress (e.g. initial compile).
      const { projectRoot, files, isCompiling: alreadyCompiling } = useDocumentStore.getState();
      if (projectRoot && !alreadyCompiling) {
        const mainFile = files.find(
          (f) => f.name === "document.tex" || f.name === "main.tex",
        );
        if (mainFile) {
          const mainFileName = mainFile.relativePath;
          useDocumentStore.getState().setIsCompiling(true);
          try {
            const pdfData = await compileLatex(projectRoot, mainFileName);
            useDocumentStore.getState().setPdfData(pdfData);
          } catch (err) {
            useDocumentStore.getState().setCompileError(
              err instanceof Error ? err.message : "Compilation failed",
            );
          } finally {
            useDocumentStore.getState().setIsCompiling(false);
          }
        }
      } else if (alreadyCompiling) {
        console.log(`[claude-event] skipping post-Claude recompile — already compiling`);
      }
    }

    // Set up listeners once and keep them alive for the component lifetime
    let cancelled = false;
    (async () => {
      const unlistenOutput = await listen<string>(
        "claude-output",
        (event) => {
          if (!cancelled) handleStreamMessage(event.payload);
        },
      );
      const unlistenComplete = await listen<boolean>(
        "claude-complete",
        (event) => {
          if (!cancelled) handleComplete(event.payload);
        },
      );
      const unlistenError = await listen<string>(
        "claude-error",
        (event) => {
          if (!cancelled) {
            console.warn(`[claude-stderr] ${elapsed()}`, event.payload);
            // Surface critical errors to the user
            const payload = event.payload;
            if (payload.includes("Error") || payload.includes("error") || payload.includes("ECONNREFUSED") || payload.includes("timeout")) {
              console.error(`[claude-stderr] ⚠️ CRITICAL: ${payload}`);
            }
          }
        },
      );

      if (cancelled) {
        unlistenOutput();
        unlistenComplete();
        unlistenError();
        return;
      }

      listenersRef.current = [unlistenOutput, unlistenComplete, unlistenError];
    })();

    return () => {
      cancelled = true;
      for (const unlisten of listenersRef.current) {
        unlisten();
      }
      listenersRef.current = [];
    };
  }, []); // mount-only — no dependency on isStreaming
}
