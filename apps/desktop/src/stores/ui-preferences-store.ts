import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiPreferencesState {
  showZoteroPanel: boolean;
  setShowZoteroPanel: (show: boolean) => void;
}

export const useUiPreferencesStore = create<UiPreferencesState>()(
  persist(
    (set) => ({
      showZoteroPanel: true,
      setShowZoteroPanel: (show) => set({ showZoteroPanel: show }),
    }),
    {
      name: "claude-prism-ui-preferences",
    },
  ),
);
