import { create } from "zustand";
import { persist } from "zustand/middleware";

type CompilerBackend = "tectonic" | "texlive";

interface SettingsState {
  compilerBackend: CompilerBackend;
  setCompilerBackend: (backend: CompilerBackend) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      compilerBackend: "tectonic",
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
    }),
    {
      name: "claude-prism-settings",
    },
  ),
);
