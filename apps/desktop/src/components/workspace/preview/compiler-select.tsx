import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettingsStore, type TexEngine } from "@/stores/settings-store";
import { detectTexlive, type TexliveStatus } from "@/lib/latex-compiler";

const TECTONIC = "tectonic";
const AUTO_YEAR = "auto";

const ENGINES: { value: TexEngine; label: string }[] = [
  { value: "pdflatex", label: "pdfLaTeX" },
  { value: "xelatex", label: "XeLaTeX" },
  { value: "lualatex", label: "LuaLaTeX" },
];

/** Years offered in the TeX Live picker: everything installed, plus a pinned
 *  year that has since been removed (so the user can see why it fails). */
export function texliveYearOptions(
  status: TexliveStatus | null,
  pinnedYear: number | null,
): number[] {
  const years = new Set(status?.installs.map((i) => i.year) ?? []);
  if (pinnedYear !== null) years.add(pinnedYear);
  return [...years].sort((a, b) => b - a);
}

/**
 * Compiler picker for the PDF toolbar, modelled on Overleaf's
 * "Compiler" + "TeX Live version" settings.
 */
export function CompilerSelect() {
  const compilerBackend = useSettingsStore((s) => s.compilerBackend);
  const texEngine = useSettingsStore((s) => s.texEngine);
  const texliveYear = useSettingsStore((s) => s.texliveYear);
  const setCompilerBackend = useSettingsStore((s) => s.setCompilerBackend);
  const setTexEngine = useSettingsStore((s) => s.setTexEngine);
  const setTexliveYear = useSettingsStore((s) => s.setTexliveYear);

  const [status, setStatus] = useState<TexliveStatus | null>(null);
  const isTexlive = compilerBackend === "texlive";

  const refreshStatus = useCallback(() => {
    detectTexlive()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  // Re-probe whenever TeX Live becomes the backend, so a fresh install
  // (e.g. MacTeX finishing in the background) shows up without a restart.
  useEffect(() => {
    if (isTexlive) refreshStatus();
  }, [isTexlive, refreshStatus]);

  const handleCompilerChange = (value: string) => {
    if (value === TECTONIC) {
      setCompilerBackend("tectonic");
    } else {
      setCompilerBackend("texlive");
      setTexEngine(value as TexEngine);
    }
  };

  const years = texliveYearOptions(status, texliveYear);
  const activeYear = texliveYear ?? status?.year ?? null;
  const notFound =
    status !== null && !status.available && status.installs.length === 0;
  // Offer a picker whenever there's a real choice — including a lone
  // year-versioned install that differs from the system default
  // (e.g. a distro TeX Live on PATH plus TeX Live 2025 in /usr/local).
  const canPickYear =
    years.length > 1 || (years.length === 1 && years[0] !== status?.year);

  return (
    <>
      <Select
        value={isTexlive ? texEngine : TECTONIC}
        onValueChange={handleCompilerChange}
      >
        <SelectTrigger
          size="sm"
          className="h-7! @[44rem]/pv:w-[8.5rem] w-[6.75rem] text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>TeX Live</SelectLabel>
            {ENGINES.map((e) => (
              <SelectItem key={e.value} value={e.value} className="text-xs">
                {e.label}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value={TECTONIC} className="text-xs">
            Tectonic
          </SelectItem>
        </SelectContent>
      </Select>

      {isTexlive && notFound && (
        <span className="px-1 text-destructive text-xs">
          TeX Live not found
        </span>
      )}

      {isTexlive && !notFound && canPickYear && (
        <Select
          value={texliveYear === null ? AUTO_YEAR : String(texliveYear)}
          onValueChange={(v) =>
            setTexliveYear(v === AUTO_YEAR ? null : Number(v))
          }
          onOpenChange={(open) => open && refreshStatus()}
        >
          <SelectTrigger
            size="sm"
            className="h-7! w-auto text-xs"
            title={status?.version ?? undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_YEAR} className="text-xs">
              {status?.year
                ? `TeX Live ${status.year} (default)`
                : "System default"}
            </SelectItem>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)} className="text-xs">
                TeX Live {y}
                {status && !status.installs.some((i) => i.year === y)
                  ? " (not installed)"
                  : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {isTexlive && !notFound && !canPickYear && activeYear && (
        <span
          className="@[38rem]/pv:inline hidden whitespace-nowrap px-1 text-muted-foreground text-xs"
          title={status?.version ?? undefined}
        >
          TeX Live {activeYear}
        </span>
      )}
    </>
  );
}
