import { create } from "zustand";
import { persist } from "zustand/middleware";

interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

interface ProjectState {
  recentProjects: RecentProject[];
  lastProjectFolder: string | null;
  addRecentProject: (path: string) => void;
  removeRecentProject: (path: string) => void;
  setLastProjectFolder: (path: string) => void;
}

const MAX_RECENT = 10;

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      recentProjects: [],
      lastProjectFolder: null,

      setLastProjectFolder: (path) => set({ lastProjectFolder: path }),

      addRecentProject: (path) => {
        const name = path.split("/").pop() || path;
        set((state) => {
          const filtered = state.recentProjects.filter((p) => p.path !== path);
          return {
            recentProjects: [
              { path, name, lastOpened: Date.now() },
              ...filtered,
            ].slice(0, MAX_RECENT),
          };
        });
      },

      removeRecentProject: (path) => {
        set((state) => ({
          recentProjects: state.recentProjects.filter((p) => p.path !== path),
        }));
      },
    }),
    {
      name: "claude-prism-projects",
    },
  ),
);
