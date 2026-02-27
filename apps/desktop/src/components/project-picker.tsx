import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpenIcon,
  FolderPlusIcon,
  ClockIcon,
  XIcon,
  FileTextIcon,
  SparklesIcon,
} from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ProjectWizard, type CreationMode } from "./project-wizard";
import { ClaudeSetup } from "./claude-setup";

export function ProjectPicker() {
  const [showModeDialog, setShowModeDialog] = useState(false);
  const [wizardMode, setWizardMode] = useState<CreationMode | null>(null);

  const recentProjects = useProjectStore((s) => s.recentProjects);
  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const removeRecentProject = useProjectStore((s) => s.removeRecentProject);
  const openProject = useDocumentStore((s) => s.openProject);

  const claudeStatus = useClaudeSetupStore((s) => s.status);
  const checkClaudeStatus = useClaudeSetupStore((s) => s.checkStatus);
  const isClaudeReady = claudeStatus === "ready";

  useEffect(() => {
    checkClaudeStatus();
  }, [checkClaudeStatus]);

  const handleOpenFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Project Folder",
    });
    if (selected) {
      addRecentProject(selected);
      await openProject(selected);
    }
  };

  const handleOpenRecent = async (path: string) => {
    addRecentProject(path);
    await openProject(path);
  };

  const handleSelectMode = (mode: CreationMode) => {
    setShowModeDialog(false);
    setWizardMode(mode);
  };

  if (wizardMode) {
    return (
      <ProjectWizard
        mode={wizardMode}
        onBack={() => setWizardMode(null)}
      />
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex w-full max-w-md flex-col items-center gap-8 px-8">
        <div className="flex flex-col items-center gap-2">
          <img src="/icon-192.png" alt="ClaudePrism" className="size-16" />
          <h1 className="font-bold text-2xl">ClaudePrism</h1>
          <p className="text-center text-muted-foreground text-sm">
            AI-powered academic writing workspace
          </p>
        </div>

        {!isClaudeReady && <ClaudeSetup />}

        <div className={`flex w-full gap-3 ${!isClaudeReady ? "pointer-events-none opacity-50" : ""}`}>
          <Button
            onClick={() => setShowModeDialog(true)}
            size="lg"
            variant="outline"
            className="flex-1 gap-2"
            disabled={!isClaudeReady}
          >
            <FolderPlusIcon className="size-5" />
            New Project
          </Button>
          <Button
            onClick={handleOpenFolder}
            size="lg"
            className="flex-1 gap-2"
            disabled={!isClaudeReady}
          >
            <FolderOpenIcon className="size-5" />
            Open Folder
          </Button>
        </div>

        {recentProjects.length > 0 && (
          <div className="w-full">
            <div className="mb-3 flex items-center gap-2 text-muted-foreground text-sm">
              <ClockIcon className="size-4" />
              <span>Recent Projects</span>
            </div>
            <div className="space-y-1">
              {recentProjects.map((project) => (
                <div
                  key={project.path}
                  className="group flex items-center gap-2 rounded-md px-3 py-2 transition-colors hover:bg-muted"
                >
                  <button
                    className="flex flex-1 flex-col items-start overflow-hidden text-left"
                    onClick={() => handleOpenRecent(project.path)}
                  >
                    <span className="truncate font-medium text-sm">
                      {project.name}
                    </span>
                    <span className="truncate text-muted-foreground text-xs">
                      {project.path}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecentProject(project.path);
                    }}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* New Project mode selection dialog */}
      <Dialog open={showModeDialog} onOpenChange={setShowModeDialog}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
            <DialogDescription>
              How would you like to start?
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => handleSelectMode("template")}
              className="group flex flex-1 flex-col items-center gap-3 rounded-xl border border-foreground/10 p-5 text-center transition-all hover:border-foreground/20 hover:bg-muted/50"
            >
              <div className="flex size-12 items-center justify-center rounded-lg bg-muted/50 transition-colors group-hover:bg-muted">
                <SparklesIcon className="size-6 text-muted-foreground transition-colors group-hover:text-foreground" />
              </div>
              <div>
                <div className="font-semibold text-sm">Guided Setup</div>
                <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                  Pick a template and let AI help you get started
                </p>
              </div>
              <span className="rounded-full bg-foreground/8 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Recommended
              </span>
            </button>

            <button
              onClick={() => handleSelectMode("scratch")}
              className="group flex flex-1 flex-col items-center gap-3 rounded-xl border border-border p-5 text-center transition-all hover:border-foreground/20 hover:bg-muted/50"
            >
              <div className="flex size-12 items-center justify-center rounded-lg bg-muted/50 transition-colors group-hover:bg-muted">
                <FileTextIcon className="size-6 text-muted-foreground transition-colors group-hover:text-foreground" />
              </div>
              <div>
                <div className="font-semibold text-sm">Blank Document</div>
                <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                  Start with an empty LaTeX file
                </p>
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
