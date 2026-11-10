import { describe, it, expect } from "vitest";
import { texliveYearOptions } from "@/components/workspace/preview/compiler-select";
import type { TexliveStatus } from "@/lib/latex-compiler";

function status(years: number[]): TexliveStatus {
  return {
    available: true,
    engines: ["pdflatex"],
    version: null,
    year: years[0] ?? null,
    installs: years.map((year) => ({
      year,
      binDir: `/usr/local/texlive/${year}/bin/universal-darwin`,
      engines: ["pdflatex"],
    })),
  };
}

describe("texliveYearOptions", () => {
  it("lists installed years newest first", () => {
    expect(texliveYearOptions(status([2024, 2026, 2025]), null)).toEqual([
      2026, 2025, 2024,
    ]);
  });

  it("keeps a pinned year that is no longer installed", () => {
    expect(texliveYearOptions(status([2026]), 2025)).toEqual([2026, 2025]);
  });

  it("does not duplicate a pinned year that is installed", () => {
    expect(texliveYearOptions(status([2025, 2024]), 2025)).toEqual([
      2025, 2024,
    ]);
  });

  it("handles an unknown status", () => {
    expect(texliveYearOptions(null, null)).toEqual([]);
  });
});
