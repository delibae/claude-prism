import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

const { mockDocumentState, getDocumentState, createSnapshotMock } = vi.hoisted(
  () => ({
    mockDocumentState: {} as any,
    getDocumentState: vi.fn(),
    createSnapshotMock: vi.fn(() => Promise.resolve(null)),
  }),
);

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: {
    getState: getDocumentState,
  },
}));

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      createSnapshot: createSnapshotMock,
    })),
  },
}));

vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({
      ollamaBaseUrl: "http://localhost:11434",
    })),
  },
}));

import { useClaudeChatStore } from "@/stores/claude-chat-store";

function resetClaudeChatStore() {
  useClaudeChatStore.setState({
    messages: [],
    sessionId: null,
    isStreaming: false,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    tabs: [
      {
        id: "tab-default",
        title: "New Chat",
        sessionId: null,
        messages: [],
        isStreaming: false,
        error: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        provider: "claude",
        ollamaModel: "",
        draft: { input: "", pinnedContexts: [] },
      },
    ],
    activeTabId: "tab-default",
    pendingInitialPrompt: null,
    pendingAttachments: [],
    selectedModel: "opus",
    effortLevel: "medium",
    provider: "claude",
    ollamaModel: "",
    _cancelledByUser: false,
  });
}

function setMockDocumentState(overrides: Partial<any> = {}) {
  const content = ["Line 1", "Line 2", "Line 3", "Line 4"].join("\n");

  const state = {
    projectRoot: "/project",
    files: [
      {
        id: "main.tex",
        name: "main.tex",
        relativePath: "main.tex",
        absolutePath: "/project/main.tex",
        type: "tex",
        content,
        isDirty: false,
      },
    ],
    activeFileId: "main.tex",
    selectionRange: null,
    saveAllFiles: vi.fn(() => Promise.resolve()),
    refreshFiles: vi.fn(() => Promise.resolve()),
    reloadFile: vi.fn(() => Promise.resolve()),
    ...overrides,
  };

  Object.keys(mockDocumentState).forEach(
    (key) => delete mockDocumentState[key],
  );
  Object.assign(mockDocumentState, state);
  getDocumentState.mockImplementation(() => mockDocumentState);
  return state;
}

describe("useClaudeChatStore.sendPrompt context assembly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClaudeChatStore();
    setMockDocumentState();
  });

  it("uses a plain file label and full file content for whole-file mentions", async () => {
    const wholeFileText =
      "\\section{Intro}\nThis is the full file.\n\\textbf{Important note}";

    await useClaudeChatStore.getState().sendPrompt("Please revise this", {
      label: "@main.tex",
      filePath: "main.tex",
      selectedText: wholeFileText,
    });

    expect(invoke).toHaveBeenCalledWith(
      "execute_claude_code",
      expect.objectContaining({
        projectPath: "/project",
        tabId: "tab-default",
        prompt: expect.stringContaining("[Selection: @main.tex]"),
      }),
    );

    const prompt = (vi.mocked(invoke).mock.calls[0]?.[1] as any)
      ?.prompt as string;
    expect(prompt).toContain("[Currently open file: main.tex]");
    expect(prompt).toContain("[Selection: @main.tex]");
    expect(prompt).toContain(wholeFileText);

    const userText =
      useClaudeChatStore.getState().messages[0].message?.content?.[0].text;
    expect(userText).toBe("@main.tex\nPlease revise this");
  });

  it("uses a line-range label and only the selected slice for selection context", async () => {
    const state = setMockDocumentState({
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/project/main.tex",
          type: "tex",
          content: "alpha\nbeta\ngamma\ndelta",
          isDirty: false,
        },
      ],
      selectionRange: { start: 6, end: 16 },
    });

    await useClaudeChatStore.getState().sendPrompt("Please revise this");

    expect(invoke).toHaveBeenCalledWith(
      "execute_claude_code",
      expect.objectContaining({
        projectPath: "/project",
        tabId: "tab-default",
        prompt: expect.stringContaining("[Selection: @main.tex:2:1-3:6]"),
      }),
    );

    const prompt = (vi.mocked(invoke).mock.calls[0]?.[1] as any)
      ?.prompt as string;
    expect(prompt).toContain("[Currently open file: main.tex]");
    expect(prompt).toContain("[Selection: @main.tex:2:1-3:6]");
    expect(prompt).toContain("[Selected text:\nbeta\ngamma\n]");
    expect(prompt).not.toContain("alpha\na");
    expect(prompt).not.toContain("\ndelta");

    const userText =
      useClaudeChatStore.getState().messages[0].message?.content?.[0].text;
    expect(userText).toBe("@main.tex:2:1-3:6\nPlease revise this");
    expect(state.saveAllFiles).not.toHaveBeenCalled();
    expect(createSnapshotMock).toHaveBeenCalledWith(
      "/project",
      "[claude] Before Claude edit",
    );
  });

  it("invokes send_ollama_message when provider is Ollama", async () => {
    useClaudeChatStore.setState({
      provider: "ollama",
      ollamaModel: "llama3",
      tabs: [
        {
          ...useClaudeChatStore.getState().tabs[0],
          provider: "ollama",
          ollamaModel: "llama3",
        },
      ],
    });

    await useClaudeChatStore.getState().sendPrompt("Explain this section");

    expect(invoke).toHaveBeenCalledWith(
      "send_ollama_message",
      expect.objectContaining({
        baseUrl: "http://localhost:11434",
        model: "llama3",
        tabId: "tab-default",
        projectPath: "/project",
      }),
    );

    const messagesArg = (vi.mocked(invoke).mock.calls[0]?.[1] as any)
      ?.messages as { role: string; content: string }[];
    expect(messagesArg).toHaveLength(1);
    expect(messagesArg[0].role).toBe("user");
    expect(messagesArg[0].content).toContain("Explain this section");

    expect(createSnapshotMock).toHaveBeenCalledWith(
      "/project",
      "[ollama] Before Ollama response",
    );
  });
});
