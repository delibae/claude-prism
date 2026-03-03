import { useEffect, useState } from "react";
import { Progress } from "@/components/ui/progress";

interface StepDef {
  label: string;
  pct: number;
}

const STEPS: StepDef[] = [
  { label: "Downloading repository…", pct: 20 },
  { label: "Extracting skills…", pct: 50 },
  { label: "Copying to .claude/skills…", pct: 80 },
  { label: "Finalizing…", pct: 95 },
];

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
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!isInstalling || isComplete || error) return;
    const interval = setInterval(() => {
      setPhase((p) => Math.min(p + 1, STEPS.length - 1));
    }, 1500);
    return () => clearInterval(interval);
  }, [isInstalling, isComplete, error]);

  useEffect(() => {
    if (isComplete) setPhase(STEPS.length);
  }, [isComplete]);

  const pct = isComplete ? 100 : error ? STEPS[phase]?.pct ?? 0 : STEPS[phase]?.pct ?? 0;
  const label = isComplete
    ? "Done"
    : error
      ? STEPS[phase]?.label ?? ""
      : STEPS[phase]?.label ?? "";

  return (
    <div className="space-y-2 py-1">
      <Progress value={pct} />
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="font-mono text-muted-foreground text-xs tabular-nums">
          {pct}%
        </p>
      </div>
    </div>
  );
}
