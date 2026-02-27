import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useDocumentStore } from "@/stores/document-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { ProjectPicker } from "@/components/project-picker";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TooltipProvider } from "@/components/ui/tooltip";

function WorkspaceWithClaude() {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const initialized = useDocumentStore((s) => s.initialized);

  // Update window title
  useEffect(() => {
    if (projectRoot) {
      const name = projectRoot.split(/[/\\]/).pop() || "ClaudePrism";
      getCurrentWindow().setTitle(`${name} - ClaudePrism`);
    }
  }, [projectRoot]);

  // Consume pending initial prompt from project wizard
  useEffect(() => {
    if (!initialized) return;
    // Delay to let ClaudeChatDrawer mount and register event listeners
    const timer = setTimeout(() => {
      const prompt = useClaudeChatStore.getState().consumePendingInitialPrompt();
      if (prompt) {
        useClaudeChatStore.getState().sendPrompt(prompt);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [initialized]);

  return (
    <>
      <WorkspaceLayout />
      <Toaster />
    </>
  );
}

export function App({ onReady }: { onReady?: () => void }) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  // Register global keyboard shortcuts (Cmd+S, Cmd+N) at the app level
  useKeyboardShortcuts();

  useEffect(() => {
    onReady?.();
  }, [onReady]);

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <TooltipProvider>
        {/* Global macOS titlebar drag region — sits above all content */}
        <div
          data-tauri-drag-region
          className="fixed inset-x-0 top-0 z-[9999] h-[var(--titlebar-height)]"
        />
        {projectRoot ? <WorkspaceWithClaude /> : <ProjectPicker />}
      </TooltipProvider>
    </ThemeProvider>
  );
}
