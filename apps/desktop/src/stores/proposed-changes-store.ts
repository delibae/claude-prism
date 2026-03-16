import { create } from "zustand";
import { useDocumentStore } from "./document-store";
import { writeTexFileContent } from "@/lib/tauri/fs";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("proposed-changes");

export interface ProposedChange {
  id: string; // tool_use_id
  filePath: string; // relativePath
  absolutePath: string;
  oldContent: string; // content before Claude's edit
  newContent: string; // content after Claude's edit (from disk)
  toolName: string; // "Edit" | "Write" | "MultiEdit"
  timestamp: number;
}

interface ProposedChangesState {
  changes: ProposedChange[];

  // Actions
  addChange: (change: Omit<ProposedChange, "timestamp">) => void;
  resolveChange: (id: string) => void;
  keepChange: (id: string) => void;
  undoChange: (id: string) => Promise<void>;
  keepAll: () => void;
  undoAll: () => Promise<void>;
  getChangeForFile: (relativePath: string) => ProposedChange | undefined;
}

export const useProposedChangesStore = create<ProposedChangesState>()(
  (set, get) => ({
    changes: [],

    addChange: (change) => {
      log.debug(`Adding change: ${change.toolName} on ${change.filePath}`);
      set((state) => {
        // If there's already a pending change for the same file, merge them:
        // keep the original oldContent (true baseline), use the new newContent and id
        const existingIdx = state.changes.findIndex(
          (c) => c.filePath === change.filePath,
        );
        if (existingIdx >= 0) {
          const existing = state.changes[existingIdx];
          const merged: ProposedChange = {
            ...change,
            oldContent: existing.oldContent, // preserve original baseline
            timestamp: Date.now(),
          };
          const newChanges = [...state.changes];
          newChanges[existingIdx] = merged;
          return { changes: newChanges };
        }
        return {
          changes: [...state.changes, { ...change, timestamp: Date.now() }],
        };
      });
    },

    resolveChange: (id) => {
      set((state) => ({
        changes: state.changes.filter((c) => c.id !== id),
      }));
    },

    keepChange: (id) => {
      const change = get().changes.find((c) => c.id === id);
      if (!change) return;

      // The caller (editor) already set the correct content via setContent().
      // Write the document store content to disk to stay in sync
      // (handles partial chunk resolution where finalContent differs from disk).
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.relativePath === change.filePath);
      if (file?.content != null) {
        writeTexFileContent(change.absolutePath, file.content).catch((err) =>
          log.error("Failed to write kept change", { error: String(err) }),
        );
      }

      // Remove from pending
      set((state) => ({
        changes: state.changes.filter((c) => c.id !== id),
      }));
    },

    undoChange: async (id) => {
      const change = get().changes.find((c) => c.id === id);
      if (!change) return;

      log.info(`Undoing change on ${change.filePath}`);
      // Restore oldContent to disk
      await writeTexFileContent(change.absolutePath, change.oldContent);

      // Reload the file in document store (will pick up oldContent from disk)
      await useDocumentStore.getState().reloadFile(change.filePath);

      // Remove from pending
      set((state) => ({
        changes: state.changes.filter((c) => c.id !== id),
      }));
    },

    keepAll: () => {
      const { changes } = get();
      for (const change of changes) {
        useDocumentStore.getState().reloadFile(change.filePath);
      }
      set({ changes: [] });
    },

    undoAll: async () => {
      const { changes } = get();
      log.info(`Undoing all ${changes.length} changes`);
      for (const change of changes) {
        await writeTexFileContent(change.absolutePath, change.oldContent);
        await useDocumentStore.getState().reloadFile(change.filePath);
      }
      set({ changes: [] });
    },

    getChangeForFile: (relativePath) => {
      return get().changes.find((c) => c.filePath === relativePath);
    },
  }),
);
