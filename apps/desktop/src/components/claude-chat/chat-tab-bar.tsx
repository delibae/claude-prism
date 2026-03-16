import { useCallback, useRef, useEffect } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useClaudeChatStore, type TabState } from "@/stores/claude-chat-store";
import { SessionSelector } from "./session-selector";

export function ChatTabBar() {
  const tabs = useClaudeChatStore((s) => s.tabs);
  const activeTabId = useClaudeChatStore((s) => s.activeTabId);
  const setActiveTab = useClaudeChatStore((s) => s.setActiveTab);
  const createTab = useClaudeChatStore((s) => s.createTab);
  const closeTab = useClaudeChatStore((s) => s.closeTab);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll active tab into view when it changes
  useEffect(() => {
    const el = scrollRef.current?.querySelector(
      `[data-tab-id="${activeTabId}"]`,
    );
    el?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId]);

  // Keyboard shortcuts: Ctrl+Tab / Ctrl+Shift+Tab to switch tabs, Ctrl+T new, Ctrl+W close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.startsWith("Mac");
      const state = useClaudeChatStore.getState();
      const { tabs: currentTabs, activeTabId: currentActive } = state;
      if (currentTabs.length === 0) return;

      // Ctrl+Tab / Ctrl+Shift+Tab — tab switching (all platforms)
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const idx = currentTabs.findIndex((t) => t.id === currentActive);
        if (e.shiftKey) {
          const prev = (idx - 1 + currentTabs.length) % currentTabs.length;
          state.setActiveTab(currentTabs[prev].id);
        } else {
          const next = (idx + 1) % currentTabs.length;
          state.setActiveTab(currentTabs[next].id);
        }
        return;
      }

      // Cmd+T / Ctrl+T — new tab
      const modKey = isMac ? e.metaKey : e.ctrlKey;
      if (modKey && e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        state.createTab();
        return;
      }

      // Cmd+W / Ctrl+W — close tab
      if (modKey && e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        state.closeTab(currentActive);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleCreate = useCallback(() => {
    createTab();
  }, [createTab]);

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      closeTab(tabId);
    },
    [closeTab],
  );

  return (
    <div className="flex items-center border-border border-b">
      <div
        ref={scrollRef}
        className="scrollbar-none flex min-w-0 flex-1 items-center overflow-x-auto"
      >
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            isStreaming={tab.isStreaming}
            isLastTab={tabs.length <= 1}
            onClick={() => setActiveTab(tab.id)}
            onClose={(e) => handleClose(e, tab.id)}
          />
        ))}
      </div>
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={handleCreate}
          className="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="New tab"
        >
          <PlusIcon className="size-3.5" />
        </button>
        <SessionSelector />
      </div>
    </div>
  );
}

function TabButton({
  tab,
  isActive,
  isStreaming,
  isLastTab,
  onClick,
  onClose,
}: {
  tab: TabState;
  isActive: boolean;
  isStreaming: boolean;
  isLastTab: boolean;
  onClick: () => void;
  onClose: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      data-tab-id={tab.id}
      onClick={onClick}
      className={cn(
        "group relative flex min-w-0 max-w-[160px] items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs transition-colors",
        isActive
          ? "border-primary bg-muted/50 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/30 hover:text-foreground",
      )}
    >
      {/* Streaming indicator */}
      {isStreaming && (
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
      )}
      <span className="truncate">{tab.title}</span>
      {/* Close button — hidden for the last remaining tab or when streaming on this tab */}
      {!isLastTab && !isStreaming && (
        <span
          role="button"
          tabIndex={-1}
          aria-label="Close tab"
          onClick={onClose}
          className="ml-auto shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-muted-foreground/20 group-hover:opacity-100"
        >
          <XIcon className="size-3" />
        </span>
      )}
    </button>
  );
}
