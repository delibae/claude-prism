import { create } from "zustand";

interface PreviewState {
  visible: boolean;
  toggle: () => void;
  setVisible: (v: boolean) => void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  visible: true,
  toggle: () => set((s) => ({ visible: !s.visible })),
  setVisible: (v) => set({ visible: v }),
}));
