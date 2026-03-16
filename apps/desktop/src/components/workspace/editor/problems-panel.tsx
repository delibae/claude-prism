import { useState } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  InfoIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  MousePointerClickIcon,
} from "lucide-react";

export interface DiagnosticItem {
  from: number;
  to: number;
  severity: string;
  message: string;
  line: number;
}

interface ProblemsPanelProps {
  diagnostics: DiagnosticItem[];
  fileName: string;
  onNavigate: (from: number) => void;
  onFixWithChat: (message: string, line: number) => void;
  onFixAllWithChat?: () => void;
}

function SeverityIcon({ severity }: { severity: string }) {
  switch (severity) {
    case "error":
      return <AlertCircleIcon className="size-3.5 shrink-0 text-red-400" />;
    case "warning":
      return (
        <AlertTriangleIcon className="size-3.5 shrink-0 text-yellow-400" />
      );
    default:
      return <InfoIcon className="size-3.5 shrink-0 text-blue-400" />;
  }
}

export function ProblemsPanel({
  diagnostics,
  fileName,
  onNavigate,
  onFixWithChat,
  onFixAllWithChat,
}: ProblemsPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter(
    (d) => d.severity === "warning",
  ).length;

  return (
    <div className="border-border border-t bg-background">
      {/* Header */}
      <div className="flex items-center">
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="flex flex-1 items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted/50"
        >
          {isCollapsed ? (
            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronDownIcon className="size-3.5 text-muted-foreground" />
          )}
          <span className="font-medium text-foreground">Problems</span>
          <div className="flex items-center gap-2">
            {errorCount > 0 && (
              <span className="flex items-center gap-1">
                <AlertCircleIcon className="size-3 text-red-400" />
                <span className="text-muted-foreground">{errorCount}</span>
              </span>
            )}
            {warningCount > 0 && (
              <span className="flex items-center gap-1">
                <AlertTriangleIcon className="size-3 text-yellow-400" />
                <span className="text-muted-foreground">{warningCount}</span>
              </span>
            )}
          </div>
        </button>
        {diagnostics.length > 0 && onFixAllWithChat && (
          <button
            onClick={onFixAllWithChat}
            className="mx-3 my-2 flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground text-xs shadow-sm transition-colors hover:bg-primary/90"
            title="Fix all problems with AI"
          >
            <MousePointerClickIcon className="size-3" />
            <span>Fix with Chat</span>
          </button>
        )}
      </div>

      {/* Diagnostic list */}
      {!isCollapsed && (
        <div className="max-h-36 overflow-y-auto border-border border-t">
          {diagnostics.map((d, i) => (
            <div
              key={`${d.from}-${d.message}-${i}`}
              className="group flex cursor-pointer items-center gap-2 px-3 py-1 text-xs transition-colors hover:bg-muted/50"
              onClick={() => onNavigate(d.from)}
            >
              <SeverityIcon severity={d.severity} />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {d.message}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {fileName}:{d.line}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onFixWithChat(d.message, d.line);
                }}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100"
                title="Fix with chat"
              >
                <MessageSquareIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
