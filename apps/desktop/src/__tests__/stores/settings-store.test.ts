import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore, getCompileOptions } from "@/stores/settings-store";

describe("useSettingsStore", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      compilerBackend: "tectonic",
      texEngine: "pdflatex",
      texliveYear: null,
    });
  });

  it("defaults the TeX Live engine to pdfLaTeX (Overleaf's default)", () => {
    expect(useSettingsStore.getState().texEngine).toBe("pdflatex");
    expect(useSettingsStore.getState().texliveYear).toBeNull();
  });

  it("returns Tectonic options when the Tectonic backend is selected", () => {
    expect(getCompileOptions()).toEqual({
      useTexlive: false,
      texEngine: "pdflatex",
      texliveYear: null,
    });
  });

  it("returns the selected TeX Live engine and pinned year", () => {
    const s = useSettingsStore.getState();
    s.setCompilerBackend("texlive");
    s.setTexEngine("xelatex");
    s.setTexliveYear(2025);
    expect(getCompileOptions()).toEqual({
      useTexlive: true,
      texEngine: "xelatex",
      texliveYear: 2025,
    });
  });

  it("clears the pinned year back to the system default", () => {
    const s = useSettingsStore.getState();
    s.setTexliveYear(2025);
    s.setTexliveYear(null);
    expect(useSettingsStore.getState().texliveYear).toBeNull();
  });
});
