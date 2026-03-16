import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";

const PHASE_MAP: Record<string, number> = {
  "Checking directory permissions...": 5,
  "Directory permissions OK": 10,
  "Git available": 15,
  "cloning repository": 20,
  "downloading tarball": 20,
  "Download complete": 60,
  "Copying skills": 70,
  Copied: 90,
  "Cleanup complete": 95,
};

function pctFromLog(log: string): number | null {
  for (const [key, pct] of Object.entries(PHASE_MAP)) {
    if (log.toLowerCase().includes(key.toLowerCase())) return pct;
  }
  return null;
}

interface InstallProgressProps {
  isInstalling: boolean;
  isComplete: boolean;
  error: string | null;
}

export function InstallProgress({
  isInstalling,
  isComplete,
  error,
}: InstallProgressProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [pct, setPct] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isInstalling) return;
    const unlisten = listen<string>("skills-install-log", (event) => {
      setLogs((prev) => [...prev, event.payload]);
      const p = pctFromLog(event.payload);
      if (p !== null) setPct(p);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [isInstalling]);

  useEffect(() => {
    if (isComplete) setPct(100);
  }, [isComplete]);

  // Auto-scroll to bottom
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [logs]);

  const label = isComplete
    ? "Done"
    : error
      ? "Error"
      : logs.length > 0
        ? logs[logs.length - 1]
        : "Starting...";

  return (
    <div className="space-y-2 py-1">
      <Progress value={pct} />
      <div className="flex items-center justify-between">
        <p className="max-w-[80%] truncate text-muted-foreground text-xs">
          {label}
        </p>
        <p className="font-mono text-muted-foreground text-xs tabular-nums">
          {pct}%
        </p>
      </div>
      {logs.length > 0 && (
        <ScrollArea className="h-28 rounded-md border border-border/60 bg-muted/30">
          <div
            ref={scrollRef}
            className="p-2 font-mono text-[11px] text-muted-foreground leading-relaxed"
          >
            {logs.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
