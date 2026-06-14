import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "./document-store";
import { useHistoryStore } from "./history-store";
import { useSettingsStore } from "./settings-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("claude");

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

// ─── Tab Types ───

export interface TabDraft {
  input: string;
  pinnedContexts: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];
}

export type AiProvider = "claude" | "ollama";

export interface TabState {
  id: string;
  title: string;
  sessionId: string | null;
  messages: ClaudeStreamMessage[];
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  provider: AiProvider;
  ollamaModel: string;
  draft: TabDraft;
}

/** Fields that are projected from the active tab to top-level state */
const TAB_FIELDS = [
  "sessionId",
  "messages",
  "isStreaming",
  "error",
  "totalInputTokens",
  "totalOutputTokens",
  "provider",
  "ollamaModel",
] as const;

function makeDefaultTab(
  id: string,
  provider: AiProvider = "claude",
  ollamaModel = "",
): TabState {
  return {
    id,
    title: "New Chat",
    sessionId: null,
    messages: [],
    isStreaming: false,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    provider,
    ollamaModel,
    draft: { input: "", pinnedContexts: [] },
  };
}

let tabCounter = 0;
function nextTabId(): string {
  return `tab-${++tabCounter}`;
}

// ─── Ollama helpers ───

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Build a clean message history for Ollama from the tab's current messages. */
function buildOllamaMessages(messages: ClaudeStreamMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const msg of messages) {
    if (msg.type === "system") continue;
    if (msg.type === "result") continue;
    if (msg.type === "user" && msg.message?.content) {
      const text = msg.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) {
        out.push({ role: "user", content: text });
      }
    }
    if (msg.type === "assistant" && msg.message?.content) {
      const text = msg.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) {
        out.push({ role: "assistant", content: text });
      }
    }
  }
  return out;
}

/**
 * Update a specific tab in `tabs[]` and, if that tab is the active tab,
 * also project the changed fields to top-level state for consumer compatibility.
 */
function applyTabUpdate(
  state: ClaudeChatState,
  tabId: string,
  updates: Partial<TabState>,
): Partial<ClaudeChatState> {
  const newTabs = state.tabs.map((t) =>
    t.id === tabId ? { ...t, ...updates } : t,
  );
  const result: Partial<ClaudeChatState> = { tabs: newTabs };
  if (tabId === state.activeTabId) {
    for (const key of TAB_FIELDS) {
      if (key in updates) {
        (result as any)[key] = (updates as any)[key];
      }
    }
  }
  return result;
}

// ─── State Interface ───

const DEFAULT_TAB_ID = nextTabId();

interface ClaudeChatState {
  // ── Projected fields (from active tab — read by consumers) ──
  messages: ClaudeStreamMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;

  // ── Tab state ──
  tabs: TabState[];
  activeTabId: string;

  /** Deferred prompt to send once the workspace is ready (set by project wizard) */
  pendingInitialPrompt: string | null;
  setPendingInitialPrompt: (prompt: string | null) => void;
  consumePendingInitialPrompt: () => string | null;

  /** Pending attachments from external sources (e.g. PDF capture) */
  pendingAttachments: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];
  addPendingAttachment: (attachment: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }) => void;
  consumePendingAttachments: () => {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];

  /** Currently selected model (passed per-prompt to Claude CLI) */
  selectedModel: "sonnet" | "opus" | "haiku" | "opusplan";
  setSelectedModel: (model: "sonnet" | "opus" | "haiku" | "opusplan") => void;

  /** Effort level for Opus 4.6 adaptive reasoning */
  effortLevel: "low" | "medium" | "high";
  setEffortLevel: (level: "low" | "medium" | "high") => void;

  /** Active AI provider for the current tab */
  provider: AiProvider;
  setProvider: (provider: AiProvider) => void;

  /** Selected Ollama model for the current tab */
  ollamaModel: string;
  setOllamaModel: (model: string) => void;

  // Actions
  sendPrompt: (
    userPrompt: string,
    contextOverride?: { label: string; filePath: string; selectedText: string },
  ) => Promise<void>;
  cancelExecution: () => Promise<void>;
  clearMessages: () => void;
  newSession: () => void;
  resumeSession: (sessionId: string) => Promise<void>;

  // Tab actions
  createTab: () => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  saveDraft: (tabId: string, draft: TabDraft) => void;

  /** True when any tab is streaming */
  anyStreaming: () => boolean;

  // Internal actions (called by event hook, routed by tabId)
  _appendMessage: (tabId: string, msg: ClaudeStreamMessage) => void;
  _appendStreamingText: (tabId: string, text: string) => void;
  _setSessionId: (tabId: string, id: string) => void;
  _setStreaming: (tabId: string, streaming: boolean) => void;
  _setError: (tabId: string, error: string | null) => void;
  _cancelledByUser: boolean;
}

// ─── Store ───

export const useClaudeChatStore = create<ClaudeChatState>()((set, get) => ({
  // Projected fields (initialized from default tab)
  messages: [],
  sessionId: null,
  isStreaming: false,
  error: null,
  _cancelledByUser: false,
  totalInputTokens: 0,
  totalOutputTokens: 0,

  // Tab state
  tabs: [makeDefaultTab(DEFAULT_TAB_ID)],
  activeTabId: DEFAULT_TAB_ID,

  selectedModel: "opus",
  setSelectedModel: (model) => set({ selectedModel: model }),

  effortLevel: "medium",
  setEffortLevel: (level) => set({ effortLevel: level }),

  provider: "claude",
  setProvider: (provider) =>
    set((state) => {
      const updates: Partial<ClaudeChatState> = { provider };
      return {
        ...updates,
        ...applyTabUpdate(state, state.activeTabId, {
          provider,
        }),
      };
    }),

  ollamaModel: "",
  setOllamaModel: (model) =>
    set((state) => {
      const updates: Partial<ClaudeChatState> = { ollamaModel: model };
      return {
        ...updates,
        ...applyTabUpdate(state, state.activeTabId, {
          ollamaModel: model,
        }),
      };
    }),

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

  anyStreaming: () => get().tabs.some((t) => t.isStreaming),

  sendPrompt: async (
    userPrompt: string,
    contextOverride?: { label: string; filePath: string; selectedText: string },
  ) => {
    const state = get();
    const { activeTabId } = state;
    const activeTab = state.tabs.find((t) => t.id === activeTabId);
    // Guard: prevent sending from a tab that's already streaming
    if (activeTab?.isStreaming) return;

    const { sessionId, selectedModel, effortLevel, provider, ollamaModel } =
      state;

    const sendStart = performance.now();
    log.info("sendPrompt start", {
      provider,
      sessionId: !!sessionId,
      hasContext: !!contextOverride,
      tab: activeTabId,
    });

    const docState = useDocumentStore.getState();
    const projectPath = docState.projectRoot;
    if (!projectPath) {
      set((s) => applyTabUpdate(s, activeTabId, { error: "No project open" }));
      return;
    }

    // Compute context label for display in chat history
    const activeFile = docState.files.find(
      (f) => f.id === docState.activeFileId,
    );
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

    // Auto-set tab title from first prompt
    const isFirstMessage = activeTab && activeTab.messages.length === 0;
    const tabTitle = isFirstMessage
      ? userPrompt.slice(0, 40) + (userPrompt.length > 40 ? "..." : "")
      : undefined;

    set((s) => {
      const tabUpdates: Partial<TabState> = {
        messages: [
          ...(s.tabs.find((t) => t.id === activeTabId)?.messages ?? []),
          userMessage,
        ],
        isStreaming: true,
        error: null,
      };
      if (tabTitle) tabUpdates.title = tabTitle;
      return {
        ...applyTabUpdate(s, activeTabId, tabUpdates),
        _cancelledByUser: false,
      };
    });

    // Flush unsaved edits to disk so the AI reads the latest content
    if (docState.files.some((f) => f.isDirty)) {
      log.debug("saving dirty files...");
      await docState.saveAllFiles();
      log.debug("saveAllFiles done");
    }

    // Snapshot before AI edit
    if (projectPath) {
      try {
        log.debug("creating snapshot...");
        const snapshotLabel =
          provider === "ollama"
            ? "[ollama] Before Ollama response"
            : "[claude] Before Claude edit";
        await useHistoryStore
          .getState()
          .createSnapshot(projectPath, snapshotLabel);
        log.debug("snapshot done");
      } catch {
        /* snapshot failure should not block the AI flow */
      }
    }

    try {
      if (provider === "ollama") {
        // Build full message history for Ollama
        const currentMessages =
          get().tabs.find((t) => t.id === activeTabId)?.messages ?? [];
        const ollamaMessages = buildOllamaMessages(currentMessages);
        const settings = useSettingsStore.getState();

        await invoke("send_ollama_message", {
          baseUrl: settings.ollamaBaseUrl,
          model: ollamaModel,
          messages: ollamaMessages,
          tabId: activeTabId,
          projectPath,
        });
      } else {
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
        log.info("invoking Claude CLI", {
          promptLength: prompt.length,
          mode: sessionId ? "resume" : "new",
        });

        if (sessionId) {
          await invoke("resume_claude_code", {
            projectPath,
            sessionId,
            prompt,
            tabId: activeTabId,
            model: selectedModel,
            effortLevel,
          });
        } else {
          await invoke("execute_claude_code", {
            projectPath,
            prompt,
            tabId: activeTabId,
            model: selectedModel,
            effortLevel,
          });
        }
      }
      log.info(
        `sendPrompt complete in ${(performance.now() - sendStart).toFixed(0)}ms`,
      );
    } catch (err: any) {
      log.error(
        `sendPrompt failed after ${(performance.now() - sendStart).toFixed(0)}ms`,
        { error: String(err) },
      );
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          isStreaming: false,
          error: err?.message || String(err),
        }),
      );
    }
  },

  cancelExecution: async () => {
    const { activeTabId, provider } = get();
    set({ _cancelledByUser: true });
    try {
      if (provider === "ollama") {
        await invoke("cancel_ollama_message", { tabId: activeTabId });
      } else {
        await invoke("cancel_claude_execution", { tabId: activeTabId });
      }
    } catch {
      // ignore
    }
    set((s) => applyTabUpdate(s, activeTabId, { isStreaming: false }));
  },

  clearMessages: () => {
    const { activeTabId } = get();
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        error: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
    );
  },

  newSession: () => {
    log.info("Starting new session");
    const { activeTabId } = get();
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        sessionId: null,
        error: null,
        isStreaming: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: "New Chat",
        // Keep provider + ollama model on new session
      }),
    );
  },

  resumeSession: async (sessionId: string) => {
    log.info(`Resuming session: ${sessionId.slice(0, 8)}`);
    const { activeTabId } = get();
    const projectPath = useDocumentStore.getState().projectRoot;

    // Reset state with new session ID
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        sessionId,
        error: null,
        isStreaming: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
    );

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

        set((s) => applyTabUpdate(s, activeTabId, { messages }));
      } catch (err) {
        log.error("Failed to load session history", { error: String(err) });
      }
    }
  },

  // ─── Tab Actions ───

  createTab: () => {
    log.debug("Creating new tab");
    const state = get();
    const id = nextTabId();
    const newTab = makeDefaultTab(id, state.provider, state.ollamaModel);
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: id,
      // Project new tab fields to top-level
      messages: newTab.messages,
      sessionId: newTab.sessionId,
      isStreaming: newTab.isStreaming,
      error: newTab.error,
      totalInputTokens: newTab.totalInputTokens,
      totalOutputTokens: newTab.totalOutputTokens,
      provider: newTab.provider,
      ollamaModel: newTab.ollamaModel,
    }));
    return id;
  },

  closeTab: (tabId: string) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    // Prevent closing a streaming tab
    if (tab?.isStreaming) return;
    // Prevent closing the last tab
    if (state.tabs.length <= 1) return;

    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const newTabs = state.tabs.filter((t) => t.id !== tabId);

    if (tabId === state.activeTabId) {
      // Switch to adjacent tab
      const newIdx = Math.min(idx, newTabs.length - 1);
      const newActive = newTabs[newIdx];
      set({
        tabs: newTabs,
        activeTabId: newActive.id,
        // Project new active tab
        messages: newActive.messages,
        sessionId: newActive.sessionId,
        isStreaming: newActive.isStreaming,
        error: newActive.error,
        totalInputTokens: newActive.totalInputTokens,
        totalOutputTokens: newActive.totalOutputTokens,
        provider: newActive.provider,
        ollamaModel: newActive.ollamaModel,
      });
    } else {
      set({ tabs: newTabs });
    }
  },

  setActiveTab: (tabId: string) => {
    const state = get();
    if (tabId === state.activeTabId) return;
    const targetTab = state.tabs.find((t) => t.id === tabId);
    if (!targetTab) return;

    // Project the target tab's fields to top-level
    set({
      activeTabId: tabId,
      messages: targetTab.messages,
      sessionId: targetTab.sessionId,
      isStreaming: targetTab.isStreaming,
      error: targetTab.error,
      totalInputTokens: targetTab.totalInputTokens,
      totalOutputTokens: targetTab.totalOutputTokens,
      provider: targetTab.provider,
      ollamaModel: targetTab.ollamaModel,
    });
  },

  saveDraft: (tabId: string, draft: TabDraft) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, draft } : t)),
    }));
  },

  // ─── Internal Actions (routed by explicit tabId) ───

  _appendMessage: (tabId: string, msg: ClaudeStreamMessage) => {
    set((state) => {
      let inputDelta = 0;
      let outputDelta = 0;
      const usage = msg.usage || msg.message?.usage;
      if (usage) {
        inputDelta = usage.input_tokens || 0;
        outputDelta = usage.output_tokens || 0;
      }

      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};

      return applyTabUpdate(state, tabId, {
        messages: [...tab.messages, msg],
        totalInputTokens: tab.totalInputTokens + inputDelta,
        totalOutputTokens: tab.totalOutputTokens + outputDelta,
      });
    });
  },

  _appendStreamingText: (tabId: string, text: string) => {
    if (!text) return;
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};

      const lastMsg = tab.messages[tab.messages.length - 1];
      if (
        lastMsg?.type === "assistant" &&
        Array.isArray(lastMsg.message?.content)
      ) {
        const content = lastMsg.message.content;
        const lastBlock = content[content.length - 1];
        if (lastBlock?.type === "text") {
          const updatedContent = [...content];
          updatedContent[updatedContent.length - 1] = {
            ...lastBlock,
            text: (lastBlock.text ?? "") + text,
          };
          return applyTabUpdate(state, tabId, {
            messages: [
              ...tab.messages.slice(0, -1),
              {
                ...lastMsg,
                message: { ...lastMsg.message, content: updatedContent },
              },
            ],
          });
        }
      }

      return applyTabUpdate(state, tabId, {
        messages: [
          ...tab.messages,
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text }],
            },
          } as ClaudeStreamMessage,
        ],
      });
    });
  },

  _setSessionId: (tabId: string, id: string) => {
    set((state) => applyTabUpdate(state, tabId, { sessionId: id }));
  },

  _setStreaming: (tabId: string, streaming: boolean) => {
    set((state) => applyTabUpdate(state, tabId, { isStreaming: streaming }));
  },

  _setError: (tabId: string, error: string | null) => {
    set((state) => applyTabUpdate(state, tabId, { error }));
  },
}));
