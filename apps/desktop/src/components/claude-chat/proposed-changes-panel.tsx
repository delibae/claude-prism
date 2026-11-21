import { type FC, useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { type ProposedChange } from "@/stores/proposed-changes-store";

const MOD_LABEL =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac")
    ? "⌘"
    : "Ctrl+";

interface ProposedChangesPanelProps {
  change: ProposedChange;
  changeIndex: number;
  totalChanges: number;
  onKeep: () => void;
  onUndo: () => void;
}

export const ProposedChangesPanel: FC<ProposedChangesPanelProps> = ({
  change,
  changeIndex,
  totalChanges,
  onKeep,
  onUndo,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const oldLines = change.oldContent.split("\n").length;
  const newLines = change.newContent.split("\n").length;
  const added = Math.max(0, newLines - oldLines);
  const removed = Math.max(0, oldLines - newLines);
  const compactTitle = containerWidth > 0 && containerWidth < 680;
  const hideToolName = containerWidth > 0 && containerWidth < 920;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateWidth = () => setContainerWidth(element.clientWidth);
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="grid h-9 min-w-0 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 overflow-hidden border-border border-t bg-muted/50 px-3"
    >
      <div className="flex shrink-0 items-center gap-2 text-sm">
        <span className="whitespace-nowrap font-medium text-foreground">
          {compactTitle ? "Changes" : "Proposed Changes"}
        </span>
        {totalChanges > 1 && (
          <span className="shrink-0 whitespace-nowrap rounded bg-violet-500/15 px-1.5 py-0.5 font-medium text-violet-600 text-xs dark:text-violet-400">
            {changeIndex + 1}/{totalChanges} files
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 overflow-hidden text-sm">
        <span className="min-w-0 truncate text-muted-foreground">
          {change.filePath}
        </span>
        {!hideToolName && (
          <span className="shrink-0 text-muted-foreground">
            {change.toolName}
          </span>
        )}
        {added > 0 && <span className="shrink-0 text-green-400">+{added}</span>}
        {removed > 0 && (
          <span className="shrink-0 text-red-400">-{removed}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onKeep}
          className="flex items-center justify-center gap-1 rounded-md bg-green-600/20 px-2.5 py-1 text-green-400 text-xs transition-colors hover:bg-green-600/30"
          title="Keep All"
          aria-label="Keep All"
        >
          <Check className="size-3.5" />
          <span className="whitespace-nowrap">Keep All</span>
          <kbd className="ml-1 rounded bg-green-600/20 px-1 py-0.5 font-mono text-[10px]">
            {MOD_LABEL}Y
          </kbd>
        </button>
        <button
          type="button"
          onClick={onUndo}
          className="flex items-center justify-center gap-1 rounded-md bg-red-600/20 px-2.5 py-1 text-red-400 text-xs transition-colors hover:bg-red-600/30"
          title="Undo All"
          aria-label="Undo All"
        >
          <X className="size-3.5" />
          <span className="whitespace-nowrap">Undo All</span>
          <kbd className="ml-1 rounded bg-red-600/20 px-1 py-0.5 font-mono text-[10px]">
            {MOD_LABEL}N
          </kbd>
        </button>
      </div>
    </div>
  );
};
