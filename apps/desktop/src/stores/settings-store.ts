import { create } from "zustand";
import { persist } from "zustand/middleware";

type CompilerBackend = "tectonic" | "texlive";
type AiProvider = "claude" | "ollama";

interface SettingsState {
  compilerBackend: CompilerBackend;
  setCompilerBackend: (backend: CompilerBackend) => void;
  vimMode: boolean;
  setVimMode: (enabled: boolean) => void;
  aiProvider: AiProvider;
  setAiProvider: (provider: AiProvider) => void;
  ollamaBaseUrl: string;
  setOllamaBaseUrl: (url: string) => void;
  ollamaModel: string;
  setOllamaModel: (model: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      compilerBackend: "tectonic",
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
      vimMode: false,
      setVimMode: (enabled) => set({ vimMode: enabled }),
      aiProvider: "claude",
      setAiProvider: (provider) => set({ aiProvider: provider }),
      ollamaBaseUrl: "http://localhost:11434",
      setOllamaBaseUrl: (url) => set({ ollamaBaseUrl: url }),
      ollamaModel: "",
      setOllamaModel: (model) => set({ ollamaModel: model }),
    }),
    {
      name: "claude-prism-settings",
    },
  ),
);
