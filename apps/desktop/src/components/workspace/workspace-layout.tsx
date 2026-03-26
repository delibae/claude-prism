import { useCallback, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { PanelLeftOpenIcon } from "lucide-react";
import { Sidebar } from "./sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { PdfPreview } from "./preview/pdf-preview";
import { useDocumentStore } from "@/stores/document-store";
import { Button } from "@/components/ui/button";

export function WorkspaceLayout() {
  const initialized = useDocumentStore((s) => s.initialized);
  const sidebarRef = useRef<ImperativePanelHandle>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const toggleSidebar = useCallback(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, []);

  if (!initialized) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading project...</div>
      </div>
    );
  }

  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel
        ref={sidebarRef}
        defaultSize={15}
        minSize={10}
        maxSize={25}
        collapsible
        collapsedSize={0}
        onCollapse={() => setIsSidebarCollapsed(true)}
        onExpand={() => setIsSidebarCollapsed(false)}
      >
        <Sidebar onToggleSidebar={toggleSidebar} />
      </Panel>

      <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

      <Panel defaultSize={42.5} minSize={25}>
        <div className="relative h-full">
          {isSidebarCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-[calc(var(--titlebar-height)+6px)] left-1 z-10 size-6"
              onClick={toggleSidebar}
              title="Expand Sidebar"
            >
              <PanelLeftOpenIcon className="size-3.5" />
            </Button>
          )}
          <div className={isSidebarCollapsed ? "h-full pl-7" : "h-full"}>
            <LatexEditor />
          </div>
        </div>
      </Panel>

      <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

      <Panel defaultSize={42.5} minSize={25}>
        <PdfPreview />
      </Panel>
    </PanelGroup>
  );
}
