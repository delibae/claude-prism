import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "./document-store";
import { useHistoryStore } from "./history-store";

/** Convert a character offset to 1-based line:col */
export function offsetToLineCol(
  content: string,
  offset: number,
): { line: number; col: number } {
  const before = content.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

// ─── Types ───

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: any;
  // tool_result block
  tool_use_id?: string;
  content?: any;
  is_error?: boolean;
  // thinking block
  thinking?: string;
  signature?: string;
}

export interface ClaudeStreamMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  message?: {
    content?: ContentBlock[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  usage?: { input_tokens: number; output_tokens: number };
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
}

interface ClaudeChatState {
  messages: ClaudeStreamMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;

  /** Deferred prompt to send once the workspace is ready (set by project wizard) */
  pendingInitialPrompt: string | null;
  setPendingInitialPrompt: (prompt: string | null) => void;
  consumePendingInitialPrompt: () => string | null;

  /** Pending attachments from external sources (e.g. PDF capture) */
  pendingAttachments: { label: string; filePath: string; selectedText: string; imageDataUrl?: string }[];
  addPendingAttachment: (attachment: { label: string; filePath: string; selectedText: string; imageDataUrl?: string }) => void;
  consumePendingAttachments: () => { label: string; filePath: string; selectedText: string; imageDataUrl?: string }[];

  /** Currently selected model (passed per-prompt to Claude CLI) */
  selectedModel: "sonnet" | "opus" | "haiku" | "opusplan";
  setSelectedModel: (model: "sonnet" | "opus" | "haiku" | "opusplan") => void;

  /** Effort level for Opus 4.6 adaptive reasoning */
  effortLevel: "low" | "medium" | "high";
  setEffortLevel: (level: "low" | "medium" | "high") => void;

  // Actions
  sendPrompt: (userPrompt: string, contextOverride?: { label: string; filePath: string; selectedText: string }) => Promise<void>;
  cancelExecution: () => Promise<void>;
  clearMessages: () => void;
  newSession: () => void;
  resumeSession: (sessionId: string) => Promise<void>;

  // Internal actions (called by event hook)
  _appendMessage: (msg: ClaudeStreamMessage) => void;
  _setSessionId: (id: string) => void;
  _setStreaming: (streaming: boolean) => void;
  _setError: (error: string | null) => void;
}

// ─── Store ───

export const useClaudeChatStore = create<ClaudeChatState>()((set, get) => ({
  messages: [],
  sessionId: null,
  isStreaming: false,
  error: null,
  totalInputTokens: 0,
  totalOutputTokens: 0,

  selectedModel: "opus",
  setSelectedModel: (model) => set({ selectedModel: model }),

  effortLevel: "medium",
  setEffortLevel: (level) => set({ effortLevel: level }),

  pendingInitialPrompt: null,
  setPendingInitialPrompt: (prompt) => set({ pendingInitialPrompt: prompt }),
  consumePendingInitialPrompt: () => {
    const { pendingInitialPrompt } = get();
    if (pendingInitialPrompt) {
      set({ pendingInitialPrompt: null });
    }
    return pendingInitialPrompt;
  },

  pendingAttachments: [],
  addPendingAttachment: (attachment) => {
    set((state) => ({
      pendingAttachments: [...state.pendingAttachments, attachment],
    }));
  },
  consumePendingAttachments: () => {
    const { pendingAttachments } = get();
    if (pendingAttachments.length > 0) {
      set({ pendingAttachments: [] });
    }
    return pendingAttachments;
  },

  sendPrompt: async (userPrompt: string, contextOverride?: { label: string; filePath: string; selectedText: string }) => {
    const { sessionId, isStreaming, selectedModel, effortLevel } = get();
    if (isStreaming) return;

    console.time("[claude] total-send");
    console.log("[claude] sendPrompt start", { sessionId: !!sessionId, hasContext: !!contextOverride });

    const docState = useDocumentStore.getState();
    const projectPath = docState.projectRoot;
    if (!projectPath) {
      set({ error: "No project open" });
      return;
    }

    // Compute context label for display in chat history
    const activeFile = docState.files.find((f) => f.id === docState.activeFileId);
    let contextLabel: string | null = null;

    if (contextOverride) {
      contextLabel = contextOverride.label;
    } else if (activeFile) {
      const selRange = docState.selectionRange;
      if (selRange && activeFile.content) {
        const content = activeFile.content;
        const startLC = offsetToLineCol(content, selRange.start);
        const endLC = offsetToLineCol(content, selRange.end);
        contextLabel = `@${activeFile.relativePath}:${startLC.line}:${startLC.col}-${endLC.line}:${endLC.col}`;
      }
    }

    // Add user message to the list for display (with context label visible)
    const displayText = contextLabel
      ? `${contextLabel}\n${userPrompt}`
      : userPrompt;
    const userMessage: ClaudeStreamMessage = {
      type: "user",
      message: {
        content: [{ type: "text", text: displayText }],
      },
    };

    set((state) => ({
      messages: [...state.messages, userMessage],
      isStreaming: true,
      error: null,
    }));

    // Flush unsaved edits to disk so Claude reads the latest content
    if (docState.files.some((f) => f.isDirty)) {
      console.timeLog("[claude] total-send", "saving dirty files...");
      await docState.saveAllFiles();
      console.timeLog("[claude] total-send", "saveAllFiles done");
    }

    // Snapshot before Claude edit
    if (projectPath) {
      try {
        console.timeLog("[claude] total-send", "creating snapshot...");
        await useHistoryStore.getState().createSnapshot(projectPath, "[claude] Before Claude edit");
        console.timeLog("[claude] total-send", "snapshot done");
      } catch { /* snapshot failure should not block Claude */ }
    }

    // Build prompt with full context for Claude
    let prompt = userPrompt;
    if (activeFile) {
      const selRange = docState.selectionRange;
      const selectedText =
        selRange && activeFile.content
          ? activeFile.content.slice(selRange.start, selRange.end)
          : null;
      let ctx = `[Currently open file: ${activeFile.relativePath}]`;
      if (contextOverride) {
        ctx += `\n[Selection: ${contextOverride.label}]`;
        ctx += `\n[Selected text:\n${contextOverride.selectedText}\n]`;
      } else if (selectedText && selRange) {
        const content = activeFile.content ?? "";
        const startLC = offsetToLineCol(content, selRange.start);
        const endLC = offsetToLineCol(content, selRange.end);
        ctx += `\n[Selection: @${activeFile.relativePath}:${startLC.line}:${startLC.col}-${endLC.line}:${endLC.col}]`;
        ctx += `\n[Selected text:\n${selectedText}\n]`;
      }
      prompt = `${ctx}\n\n${userPrompt}`;
    }
    console.timeLog("[claude] total-send", "invoking CLI...");
    console.log("[claude] prompt length:", prompt.length, "chars | mode:", sessionId ? "resume" : "new");

    try {
      if (sessionId) {
        // Resume existing session
        await invoke("resume_claude_code", {
          projectPath,
          sessionId,
          prompt,
          model: selectedModel,
          effortLevel,
        });
      } else {
        // New session
        await invoke("execute_claude_code", {
          projectPath,
          prompt,
          model: selectedModel,
          effortLevel,
        });
      }
      console.timeEnd("[claude] total-send");
    } catch (err: any) {
      console.timeEnd("[claude] total-send");
      console.error("[claude] invoke failed:", err);
      set({
        isStreaming: false,
        error: err?.message || String(err),
      });
    }
  },

  cancelExecution: async () => {
    try {
      await invoke("cancel_claude_execution");
    } catch {
      // ignore
    }
    set({ isStreaming: false });
  },

  clearMessages: () => {
    set({
      messages: [],
      error: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
  },

  newSession: () => {
    set({
      messages: [],
      sessionId: null,
      error: null,
      isStreaming: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
  },

  resumeSession: async (sessionId: string) => {
    const projectPath = useDocumentStore.getState().projectRoot;
    // Reset state with new session ID
    set({
      messages: [],
      sessionId,
      error: null,
      isStreaming: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });

    // Load session history from JSONL file
    if (projectPath) {
      try {
        const history = await invoke<any[]>("load_session_history", {
          projectPath,
          sessionId,
        });

        // Filter to displayable message types and map to ClaudeStreamMessage
        const messages: ClaudeStreamMessage[] = [];
        for (const entry of history) {
          const type = entry.type;
          if (type === "user" || type === "assistant" || type === "result") {
            messages.push(entry as ClaudeStreamMessage);
          }
        }

        set({ messages });
      } catch {
        // Failed to load session history
      }
    }
  },

  _appendMessage: (msg: ClaudeStreamMessage) => {
    set((state) => {
      let inputDelta = 0;
      let outputDelta = 0;
      const usage = msg.usage || msg.message?.usage;
      if (usage) {
        inputDelta = usage.input_tokens || 0;
        outputDelta = usage.output_tokens || 0;
      }

      return {
        messages: [...state.messages, msg],
        totalInputTokens: state.totalInputTokens + inputDelta,
        totalOutputTokens: state.totalOutputTokens + outputDelta,
      };
    });
  },

  _setSessionId: (id: string) => {
    set({ sessionId: id });
  },

  _setStreaming: (streaming: boolean) => {
    set({ isStreaming: streaming });
  },

  _setError: (error: string | null) => {
    set({ error });
  },
}));
