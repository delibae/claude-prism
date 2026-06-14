import { describe, it, expect } from "vitest";
import {
  offsetToLineCol,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";

describe("offsetToLineCol", () => {
  it("returns line 1, col 1 for offset 0 on empty string", () => {
    expect(offsetToLineCol("", 0)).toEqual({ line: 1, col: 1 });
  });

  it("returns line 1, col 1 for offset 0 on non-empty string", () => {
    expect(offsetToLineCol("hello", 0)).toEqual({ line: 1, col: 1 });
  });

  it("returns correct col within a single line", () => {
    expect(offsetToLineCol("hello world", 5)).toEqual({ line: 1, col: 6 });
  });

  it("handles offset at end of single line", () => {
    expect(offsetToLineCol("hello", 5)).toEqual({ line: 1, col: 6 });
  });

  it("handles multiple lines correctly", () => {
    const content = "line1\nline2\nline3";
    // offset 6 is start of "line2"
    expect(offsetToLineCol(content, 6)).toEqual({ line: 2, col: 1 });
    // offset 11 is end of "line2" (the newline before line3)
    expect(offsetToLineCol(content, 11)).toEqual({ line: 2, col: 6 });
    // offset 12 is start of "line3"
    expect(offsetToLineCol(content, 12)).toEqual({ line: 3, col: 1 });
  });

  it("returns correct position at end of multi-line content", () => {
    const content = "ab\ncd\nef";
    expect(offsetToLineCol(content, 8)).toEqual({ line: 3, col: 3 });
  });

  it("handles content with only newlines", () => {
    expect(offsetToLineCol("\n\n", 1)).toEqual({ line: 2, col: 1 });
    expect(offsetToLineCol("\n\n", 2)).toEqual({ line: 3, col: 1 });
  });
});

describe("useClaudeChatStore._appendStreamingText", () => {
  it("creates a new assistant message when the last message is not assistant", () => {
    useClaudeChatStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "Chat",
          sessionId: null,
          messages: [
            {
              type: "user",
              message: { content: [{ type: "text", text: "Hi" }] },
            },
          ],
          isStreaming: true,
          error: null,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          provider: "ollama",
          ollamaModel: "llama3",
          draft: { input: "", pinnedContexts: [] },
        },
      ],
      activeTabId: "tab-1",
    });

    useClaudeChatStore.getState()._appendStreamingText("tab-1", "Hello");
    const messages = useClaudeChatStore.getState().tabs[0].messages;
    expect(messages).toHaveLength(2);
    expect(messages[1].type).toBe("assistant");
    expect(messages[1].message?.content?.[0].text).toBe("Hello");
  });

  it("merges text into the existing assistant message", () => {
    useClaudeChatStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "Chat",
          sessionId: null,
          messages: [
            {
              type: "assistant",
              message: { content: [{ type: "text", text: "Hello" }] },
            },
          ],
          isStreaming: true,
          error: null,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          provider: "ollama",
          ollamaModel: "llama3",
          draft: { input: "", pinnedContexts: [] },
        },
      ],
      activeTabId: "tab-1",
    });

    useClaudeChatStore.getState()._appendStreamingText("tab-1", ", world!");
    const messages = useClaudeChatStore.getState().tabs[0].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].message?.content?.[0].text).toBe("Hello, world!");
  });
});
