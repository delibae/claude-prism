import { describe, it, expect, beforeEach, vi } from "vitest";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";

// ─── Mocks ───

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: {
    getState: vi.fn(() => ({
      projectRoot: "/project",
      files: [],
      activeFileId: null,
      selectionRange: null,
      reloadFile: vi.fn(),
      refreshFiles: vi.fn(() => Promise.resolve()),
      saveAllFiles: vi.fn(() => Promise.resolve()),
    })),
  },
}));

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      createSnapshot: vi.fn(() => Promise.resolve()),
    })),
  },
}));

vi.mock("@/lib/tauri/fs", () => ({
  writeTexFileContent: vi.fn(() => Promise.resolve()),
  readTexFileContent: vi.fn(() => Promise.resolve("")),
}));

function resetStores() {
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
        draft: { input: "", pinnedContexts: [] },
      },
    ],
    activeTabId: "tab-default",
    _cancelledByUser: false,
  });
  useProposedChangesStore.setState({ changes: [] });
}

// ─── Tests ───

describe("Multi-tab merge triggers", () => {
  beforeEach(resetStores);

  describe("proposed-changes-store is tab-independent (file-scoped)", () => {
    it("changes from tab A are visible when viewing tab B", () => {
      const chat = useClaudeChatStore.getState();

      // Create two tabs
      const tabB = chat.createTab();

      // Simulate: tab A's stream triggers a file change
      useProposedChangesStore.getState().addChange({
        id: "tool-from-tab-a",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "original content",
        newContent: "edited by tab A",
        toolName: "Edit",
      });

      // Switch to tab B
      chat.setActiveTab(tabB);

      // Proposed change should still be visible — it's file-scoped, not tab-scoped
      const change = useProposedChangesStore
        .getState()
        .getChangeForFile("main.tex");
      expect(change).toBeDefined();
      expect(change!.id).toBe("tool-from-tab-a");
      expect(change!.newContent).toBe("edited by tab A");
    });

    it("resolving a change from tab B works even though tab A triggered it", () => {
      const chat = useClaudeChatStore.getState();
      const tabB = chat.createTab();

      // Tab A triggered a change
      useProposedChangesStore.getState().addChange({
        id: "tool-from-tab-a",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "original",
        newContent: "edited",
        toolName: "Edit",
      });

      // User views tab B and resolves the change
      chat.setActiveTab(tabB);
      useProposedChangesStore.getState().resolveChange("tool-from-tab-a");

      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
    });
  });

  describe("concurrent file edits from different tabs merge correctly", () => {
    it("second edit to same file preserves original baseline from first tab", () => {
      // Tab A edits main.tex: original -> v1
      useProposedChangesStore.getState().addChange({
        id: "tool-tab-a-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "original",
        newContent: "v1-from-tab-a",
        toolName: "Edit",
      });

      // Tab B later also edits main.tex: v1 -> v2
      useProposedChangesStore.getState().addChange({
        id: "tool-tab-b-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "v1-from-tab-a",
        newContent: "v2-from-tab-b",
        toolName: "Edit",
      });

      const { changes } = useProposedChangesStore.getState();
      // Should be merged into a single entry
      expect(changes).toHaveLength(1);
      // Baseline must be "original" (the true pre-edit state)
      expect(changes[0].oldContent).toBe("original");
      expect(changes[0].newContent).toBe("v2-from-tab-b");
      expect(changes[0].id).toBe("tool-tab-b-1");
    });

    it("edits to different files from different tabs stay independent", () => {
      useProposedChangesStore.getState().addChange({
        id: "tool-tab-a",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "main-original",
        newContent: "main-edited",
        toolName: "Edit",
      });

      useProposedChangesStore.getState().addChange({
        id: "tool-tab-b",
        filePath: "refs.bib",
        absolutePath: "/project/refs.bib",
        oldContent: "bib-original",
        newContent: "bib-edited",
        toolName: "Write",
      });

      const { changes } = useProposedChangesStore.getState();
      expect(changes).toHaveLength(2);

      const mainChange = changes.find((c) => c.filePath === "main.tex");
      const bibChange = changes.find((c) => c.filePath === "refs.bib");
      expect(mainChange!.oldContent).toBe("main-original");
      expect(bibChange!.oldContent).toBe("bib-original");
    });

    it("three sequential edits to the same file all preserve the original baseline", () => {
      const store = useProposedChangesStore.getState();

      store.addChange({
        id: "edit-1",
        filePath: "doc.tex",
        absolutePath: "/project/doc.tex",
        oldContent: "baseline",
        newContent: "v1",
        toolName: "Edit",
      });
      store.addChange({
        id: "edit-2",
        filePath: "doc.tex",
        absolutePath: "/project/doc.tex",
        oldContent: "v1",
        newContent: "v2",
        toolName: "Edit",
      });
      store.addChange({
        id: "edit-3",
        filePath: "doc.tex",
        absolutePath: "/project/doc.tex",
        oldContent: "v2",
        newContent: "v3",
        toolName: "MultiEdit",
      });

      const { changes } = useProposedChangesStore.getState();
      expect(changes).toHaveLength(1);
      expect(changes[0].oldContent).toBe("baseline");
      expect(changes[0].newContent).toBe("v3");
      expect(changes[0].id).toBe("edit-3");
      expect(changes[0].toolName).toBe("MultiEdit");
    });
  });

  describe("per-tab independent streaming", () => {
    it("tab A streaming does not block tab B from streaming", () => {
      const chat = useClaudeChatStore.getState();
      const tabB = chat.createTab();

      // Tab A starts streaming
      useClaudeChatStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === "tab-default" ? { ...t, isStreaming: true } : t,
        ),
        isStreaming: s.activeTabId === "tab-default",
      }));

      // Tab B can also be streaming independently
      useClaudeChatStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabB ? { ...t, isStreaming: true } : t,
        ),
        isStreaming: s.activeTabId === tabB,
      }));

      const state = useClaudeChatStore.getState();
      const tabAState = state.tabs.find((t) => t.id === "tab-default")!;
      const tabBState = state.tabs.find((t) => t.id === tabB)!;
      expect(tabAState.isStreaming).toBe(true);
      expect(tabBState.isStreaming).toBe(true);
    });

    it("_appendMessage routes to the specified tab, not the active tab", () => {
      const chat = useClaudeChatStore.getState();
      const tabB = chat.createTab();

      // Mark tab A as streaming
      useClaudeChatStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === "tab-default" ? { ...t, isStreaming: true } : t,
        ),
      }));

      // User is viewing tab B (active), but message is for tab A
      chat.setActiveTab(tabB);

      useClaudeChatStore.getState()._appendMessage("tab-default", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello from stream" }] },
      });

      const state = useClaudeChatStore.getState();
      const tabAState = state.tabs.find((t) => t.id === "tab-default")!;
      const tabBState = state.tabs.find((t) => t.id === tabB)!;

      expect(tabAState.messages).toHaveLength(1);
      expect(tabAState.messages[0].message?.content?.[0].text).toBe(
        "Hello from stream",
      );
      expect(tabBState.messages).toHaveLength(0);

      // Top-level projected messages should reflect the active tab (tab B) — empty
      expect(state.messages).toHaveLength(0);
    });

    it("_setSessionId routes to the specified tab", () => {
      const chat = useClaudeChatStore.getState();
      const tabB = chat.createTab();

      // Viewing tab B, set session on tab A
      chat.setActiveTab(tabB);
      chat._setSessionId("tab-default", "session-123");

      const state = useClaudeChatStore.getState();
      const tabA = state.tabs.find((t) => t.id === "tab-default")!;
      expect(tabA.sessionId).toBe("session-123");
      // Active tab (tab B) projected sessionId should not change
      expect(state.sessionId).toBeNull();
    });

    it("_setStreaming(tabId, false) only affects that specific tab", () => {
      const chat = useClaudeChatStore.getState();
      const tabB = chat.createTab();

      // Both tabs streaming
      useClaudeChatStore.setState((s) => ({
        tabs: s.tabs.map((t) => ({ ...t, isStreaming: true })),
        isStreaming: true,
      }));

      // Tab A finishes
      chat._setStreaming("tab-default", false);

      const state = useClaudeChatStore.getState();
      expect(state.tabs.find((t) => t.id === "tab-default")!.isStreaming).toBe(
        false,
      );
      expect(state.tabs.find((t) => t.id === tabB)!.isStreaming).toBe(true);
    });

    it("_setError routes to the specified tab, not active tab", () => {
      const chat = useClaudeChatStore.getState();
      const tabB = chat.createTab();

      // Viewing tab B, error on tab A
      chat.setActiveTab(tabB);
      chat._setError("tab-default", "Rate limited");

      const state = useClaudeChatStore.getState();
      const tabA = state.tabs.find((t) => t.id === "tab-default")!;
      expect(tabA.error).toBe("Rate limited");
      // Active tab (tab B) projected error should be null
      expect(state.error).toBeNull();
    });

    it("concurrent messages to different tabs are independent", () => {
      const chat = useClaudeChatStore.getState();
      const tabB = chat.createTab();

      // Simulate concurrent streaming on both tabs
      chat._appendMessage("tab-default", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Tab A message 1" }] },
      });
      chat._appendMessage(tabB, {
        type: "assistant",
        message: { content: [{ type: "text", text: "Tab B message 1" }] },
      });
      chat._appendMessage("tab-default", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Tab A message 2" }] },
      });

      const state = useClaudeChatStore.getState();
      const tabAMsgs = state.tabs.find((t) => t.id === "tab-default")!.messages;
      const tabBMsgs = state.tabs.find((t) => t.id === tabB)!.messages;

      expect(tabAMsgs).toHaveLength(2);
      expect(tabBMsgs).toHaveLength(1);
      expect(tabAMsgs[0].message?.content?.[0].text).toBe("Tab A message 1");
      expect(tabAMsgs[1].message?.content?.[0].text).toBe("Tab A message 2");
      expect(tabBMsgs[0].message?.content?.[0].text).toBe("Tab B message 1");
    });
  });

  describe("tab switching preserves merge state across views", () => {
    it("switching tabs does not lose proposed changes", () => {
      const chat = useClaudeChatStore.getState();
      const tabB = chat.createTab();

      useProposedChangesStore.getState().addChange({
        id: "edit-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "before",
        newContent: "after",
        toolName: "Edit",
      });

      // Rapidly switch tabs
      chat.setActiveTab("tab-default");
      chat.setActiveTab(tabB);
      chat.setActiveTab("tab-default");
      chat.setActiveTab(tabB);

      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
      expect(useProposedChangesStore.getState().changes[0].newContent).toBe(
        "after",
      );
    });

    it("keepAll clears all changes regardless of which tab is active", () => {
      const chat = useClaudeChatStore.getState();
      const tabB = chat.createTab();

      useProposedChangesStore.getState().addChange({
        id: "edit-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "old-main",
        newContent: "new-main",
        toolName: "Edit",
      });
      useProposedChangesStore.getState().addChange({
        id: "edit-2",
        filePath: "refs.bib",
        absolutePath: "/project/refs.bib",
        oldContent: "old-bib",
        newContent: "new-bib",
        toolName: "Write",
      });

      chat.setActiveTab(tabB);
      useProposedChangesStore.getState().keepAll();

      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
    });
  });

  describe("tab lifecycle does not affect proposed changes", () => {
    it("closing a tab does not remove its triggered proposed changes", () => {
      const chat = useClaudeChatStore.getState();
      const tabB = chat.createTab();

      chat.setActiveTab(tabB);
      useProposedChangesStore.getState().addChange({
        id: "from-tab-b",
        filePath: "chapter.tex",
        absolutePath: "/project/chapter.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Write",
      });

      chat.closeTab(tabB);

      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
      expect(useProposedChangesStore.getState().changes[0].id).toBe(
        "from-tab-b",
      );
    });

    it("creating a new tab does not clear existing proposed changes", () => {
      useProposedChangesStore.getState().addChange({
        id: "existing-edit",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });

      useClaudeChatStore.getState().createTab();

      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
    });
  });
});
