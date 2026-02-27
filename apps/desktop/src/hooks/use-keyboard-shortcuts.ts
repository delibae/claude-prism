import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "@/stores/document-store";

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        const state = useDocumentStore.getState();
        state.setIsSaving(true);
        state.saveCurrentFile().finally(() => {
          setTimeout(() => state.setIsSaving(false), 500);
        });
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        invoke("create_new_window").catch(console.error);
      }

      // Cmd+X (macOS) / Ctrl+X (others): Capture & Ask
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "x" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-capture-mode"));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
