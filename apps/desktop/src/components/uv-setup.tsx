import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2Icon,
  AlertCircleIcon,
  DownloadIcon,
  Loader2Icon,
  TerminalIcon,
  FolderIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { useDocumentStore } from "@/stores/document-store";
import { cn } from "@/lib/utils";

interface UvSetupDialogProps {
  open: boolean;
  onClose: () => void;
}

export function UvSetupDialog({ open, onClose }: UvSetupDialogProps) {
  const status = useUvSetupStore((s) => s.status);
  const isInstalling = useUvSetupStore((s) => s.isInstalling);
  const error = useUvSetupStore((s) => s.error);
  const version = useUvSetupStore((s) => s.version);
  const venvReady = useUvSetupStore((s) => s.venvReady);
  const venvPath = useUvSetupStore((s) => s.venvPath);
  const pythonPath = useUvSetupStore((s) => s.pythonPath);
  const checkStatus = useUvSetupStore((s) => s.checkStatus);
  const install = useUvSetupStore((s) => s.install);
  const setupVenv = useUvSetupStore((s) => s.setupVenv);
  const _finishInstall = useUvSetupStore((s) => s._finishInstall);

  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const hasCheckedRef = useRef(false);

  // Check status when dialog opens
  useEffect(() => {
    if (open && !hasCheckedRef.current) {
      hasCheckedRef.current = true;
      checkStatus();
    }
    if (!open) {
      hasCheckedRef.current = false;
    }
  }, [open, checkStatus]);

  // Listen for install completion events
  useEffect(() => {
    const unlistenComplete = listen<boolean>("uv-install-complete", (event) => {
      _finishInstall(event.payload);
    });

    return () => {
      unlistenComplete.then((fn) => fn());
    };
  }, [_finishInstall]);

  const handleSetupVenv = async () => {
    if (projectRoot) {
      await setupVenv(projectRoot);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TerminalIcon className="size-5" />
            Python Environment (uv)
          </DialogTitle>
          <DialogDescription>
            Manage the Python virtual environment for this project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* uv status */}
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <StatusIcon status={status} isInstalling={isInstalling} />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm">
                {status === "checking"
                  ? "Checking uv..."
                  : status === "not-installed"
                    ? "uv not installed"
                    : status === "ready"
                      ? "uv installed"
                      : "Error"}
              </div>
              {version && (
                <div className="truncate text-muted-foreground text-xs">
                  {version}
                </div>
              )}
              {error && (
                <div className="mt-1 text-destructive text-xs">{error}</div>
              )}
            </div>
            {status === "not-installed" && !isInstalling && (
              <Button size="sm" onClick={install}>
                <DownloadIcon className="mr-1.5 size-3.5" />
                Install
              </Button>
            )}
            {isInstalling && (
              <Button size="sm" disabled>
                <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                Installing...
              </Button>
            )}
          </div>

          {/* venv status — only show when uv is ready */}
          {status === "ready" && (
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <div
                className={cn(
                  "flex size-8 items-center justify-center rounded-full",
                  venvReady
                    ? "bg-accent text-accent-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <FolderIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm">
                  {venvReady
                    ? "Virtual Environment Active"
                    : "No Virtual Environment"}
                </div>
                {venvPath && (
                  <div
                    className="truncate text-muted-foreground text-xs"
                    title={venvPath}
                  >
                    {venvPath}
                  </div>
                )}
                {pythonPath && (
                  <div
                    className="truncate text-muted-foreground text-xs"
                    title={pythonPath}
                  >
                    Python:{" "}
                    {pythonPath.split("/").pop() ||
                      pythonPath.split("\\").pop()}
                  </div>
                )}
              </div>
              {!venvReady && projectRoot && (
                <Button size="sm" variant="outline" onClick={handleSetupVenv}>
                  Setup .venv
                </Button>
              )}
            </div>
          )}

          {/* Info text */}
          {status === "ready" && venvReady && (
            <p className="text-muted-foreground text-xs leading-relaxed">
              Claude Code will automatically use this environment when running
              Python code. Use{" "}
              <code className="text-foreground">uv pip install</code> to add
              packages.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StatusIcon({
  status,
  isInstalling,
}: {
  status: string;
  isInstalling: boolean;
}) {
  if (isInstalling || status === "checking") {
    return (
      <div className="flex size-8 items-center justify-center rounded-full bg-muted">
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (status === "ready") {
    return (
      <div className="flex size-8 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <CheckCircle2Icon className="size-4" />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="flex size-8 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircleIcon className="size-4" />
      </div>
    );
  }
  // not-installed
  return (
    <div className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <TerminalIcon className="size-4" />
    </div>
  );
}
