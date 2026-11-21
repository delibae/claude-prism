import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getAppZoomAction, shouldHandleAppZoomShortcut } from "@/lib/app-zoom";
import { useDocumentStore } from "@/stores/document-store";

/** True when focus is in an input/textarea/contenteditable (incl. CodeMirror). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    !!target.closest(
      "input, textarea, [contenteditable=''], [contenteditable='true'], .cm-editor",
    )
  );
}

/**
 * True when Cmd/Ctrl+X should keep its native "cut" meaning: focus is in an
 * editable element, or some text is selected.
 */
export function isTextEditingContext(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true;
  const selection =
    typeof window !== "undefined" ? window.getSelection() : null;
  return !!selection && selection.toString().length > 0;
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleZoomKeyDown = (e: KeyboardEvent) => {
      const zoomAction = getAppZoomAction(e);
      if (!zoomAction || !shouldHandleAppZoomShortcut(e.target)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        const state = useDocumentStore.getState();
        state.setIsSaving(true);
        state.saveCurrentFile().finally(() => {
          setTimeout(() => state.setIsSaving(false), 500);
        });
      }

      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "n"
      ) {
        e.preventDefault();
        invoke("create_new_window").catch(console.error);
      }

      // Cmd+X (macOS) / Ctrl+X (others): Capture & Ask — but only when the
      // keystroke isn't meant as a regular "cut" (focus in an editor/input or
      // text selected), otherwise cut is broken app-wide (#133).
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "x" &&
        !e.shiftKey &&
        !e.altKey &&
        !isTextEditingContext(e.target)
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-capture-mode"));
      }

      // Cmd+Enter (macOS) / Ctrl+Enter (others): compile, even when focus is
      // outside the editor (e.g. after clicking the PDF preview) (#115).
      // Inside the editor CodeMirror's own Mod-Enter binding handles it.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.altKey &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("request-compile"));
      }

      // Cmd+Shift+D (macOS) / Ctrl+Shift+D (others): Toggle debug panel
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "d"
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-debug-panel"));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keydown", handleZoomKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keydown", handleZoomKeyDown, true);
    };
  }, []);
}
