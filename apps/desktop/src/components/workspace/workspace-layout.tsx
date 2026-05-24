import { useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { Sidebar } from "./sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { PdfPreview } from "./preview/pdf-preview";
import { useDocumentStore } from "@/stores/document-store";
import { usePreviewStore } from "@/stores/preview-store";

export function WorkspaceLayout() {
  const initialized = useDocumentStore((s) => s.initialized);
  const previewVisible = usePreviewStore((s) => s.visible);
  const togglePreview = usePreviewStore((s) => s.toggle);

  // Cmd+\ / Ctrl+\ toggles the PDF preview pane.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        togglePreview();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePreview]);

  if (!initialized) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading project...</div>
      </div>
    );
  }

  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel defaultSize={15} minSize={10} maxSize={25}>
        <Sidebar />
      </Panel>

      <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

      <Panel defaultSize={previewVisible ? 42.5 : 85} minSize={25}>
        <div className="relative h-full">
          <LatexEditor />
          <button
            type="button"
            onClick={togglePreview}
            title={
              previewVisible
                ? "Hide PDF preview (Cmd+\\)"
                : "Show PDF preview (Cmd+\\)"
            }
            className="absolute right-3 bottom-3 z-40 rounded-md border bg-background/85 p-1.5 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
          >
            {previewVisible ? (
              <PanelRightCloseIcon className="size-4" />
            ) : (
              <PanelRightOpenIcon className="size-4" />
            )}
          </button>
        </div>
      </Panel>

      {previewVisible && (
        <>
          <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

          <Panel defaultSize={42.5} minSize={25}>
            <PdfPreview />
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
