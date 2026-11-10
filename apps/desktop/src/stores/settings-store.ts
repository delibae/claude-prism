import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CompilerBackend = "tectonic" | "texlive";
export type TexEngine = "pdflatex" | "xelatex" | "lualatex";

/** Arguments for `compileLatex`, derived from the user's compiler settings. */
export interface CompileOptions {
  useTexlive: boolean;
  /** TeX Live engine used when the document has no `% !TEX program` comment. */
  texEngine: TexEngine;
  /** Pinned TeX Live year, or `null` for the system default. */
  texliveYear: number | null;
}

interface SettingsState {
  compilerBackend: CompilerBackend;
  texEngine: TexEngine;
  texliveYear: number | null;
  setCompilerBackend: (backend: CompilerBackend) => void;
  setTexEngine: (engine: TexEngine) => void;
  setTexliveYear: (year: number | null) => void;
  vimMode: boolean;
  setVimMode: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      compilerBackend: "tectonic",
      // Overleaf compiles with pdfLaTeX by default; match it so documents
      // look the same after upload.
      texEngine: "pdflatex",
      texliveYear: null,
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
      setTexEngine: (engine) => set({ texEngine: engine }),
      setTexliveYear: (year) => set({ texliveYear: year }),
      vimMode: false,
      setVimMode: (enabled) => set({ vimMode: enabled }),
    }),
    {
      name: "claude-prism-settings",
    },
  ),
);

export function getCompileOptions(): CompileOptions {
  const { compilerBackend, texEngine, texliveYear } =
    useSettingsStore.getState();
  return {
    useTexlive: compilerBackend === "texlive",
    texEngine,
    texliveYear,
  };
}
