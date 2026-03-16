import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("history");

// ─── Types ───

export interface SnapshotInfo {
  id: string;
  message: string;
  timestamp: number;
  labels: string[];
  changed_files: string[];
}

export interface FileDiff {
  file_path: string;
  status: "added" | "modified" | "deleted";
  old_content: string | null;
  new_content: string | null;
}

interface HistoryState {
  snapshots: SnapshotInfo[];
  isLoading: boolean;
  selectedSnapshotId: string | null;
  diffResult: FileDiff[] | null;
  isDiffLoading: boolean;
  isRestoring: boolean;
  reviewingSnapshot: SnapshotInfo | null;

  init: (projectRoot: string) => Promise<void>;
  createSnapshot: (
    projectRoot: string,
    message: string,
  ) => Promise<SnapshotInfo | null>;
  loadSnapshots: (projectRoot: string) => Promise<void>;
  loadMoreSnapshots: (projectRoot: string) => Promise<void>;
  selectSnapshot: (id: string | null) => void;
  loadDiff: (
    projectRoot: string,
    fromId: string,
    toId: string,
  ) => Promise<void>;
  getFileAt: (
    projectRoot: string,
    snapshotId: string,
    filePath: string,
  ) => Promise<string>;
  restoreSnapshot: (
    projectRoot: string,
    snapshotId: string,
  ) => Promise<SnapshotInfo>;
  addLabel: (
    projectRoot: string,
    snapshotId: string,
    label: string,
  ) => Promise<void>;
  removeLabel: (projectRoot: string, label: string) => Promise<void>;
  startReview: (snapshot: SnapshotInfo) => void;
  stopReview: () => void;
  reset: () => void;
}

const PAGE_SIZE = 50;

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  snapshots: [],
  isLoading: false,
  selectedSnapshotId: null,
  diffResult: null,
  isDiffLoading: false,
  isRestoring: false,
  reviewingSnapshot: null,

  startReview: (snapshot) => {
    set({ reviewingSnapshot: snapshot });
  },

  stopReview: () => {
    set({ reviewingSnapshot: null, diffResult: null });
  },

  init: async (projectRoot) => {
    log.debug(`Initializing history for ${projectRoot}`);
    await invoke("history_init", { projectRoot });
  },

  createSnapshot: async (projectRoot, message) => {
    log.debug(`Creating snapshot: ${message}`);
    const result = await invoke<SnapshotInfo | null>("history_snapshot", {
      projectRoot,
      message,
    });
    if (result) {
      log.info(`Snapshot created: ${result.id.slice(0, 8)}`);
      set((s) => ({ snapshots: [result, ...s.snapshots] }));
    }
    return result;
  },

  loadSnapshots: async (projectRoot) => {
    set({ isLoading: true });
    try {
      const snapshots = await invoke<SnapshotInfo[]>("history_list", {
        projectRoot,
        limit: PAGE_SIZE,
        offset: 0,
      });
      set({ snapshots });
    } finally {
      set({ isLoading: false });
    }
  },

  loadMoreSnapshots: async (projectRoot) => {
    const { snapshots, isLoading } = get();
    if (isLoading) return;
    set({ isLoading: true });
    try {
      const more = await invoke<SnapshotInfo[]>("history_list", {
        projectRoot,
        limit: PAGE_SIZE,
        offset: snapshots.length,
      });
      if (more.length > 0) {
        set((s) => ({ snapshots: [...s.snapshots, ...more] }));
      }
    } finally {
      set({ isLoading: false });
    }
  },

  selectSnapshot: (id) => {
    set({ selectedSnapshotId: id, diffResult: null });
  },

  loadDiff: async (projectRoot, fromId, toId) => {
    set({ isDiffLoading: true, diffResult: null });
    try {
      const diffResult = await invoke<FileDiff[]>("history_diff", {
        projectRoot,
        fromId,
        toId,
      });
      set({ diffResult });
    } finally {
      set({ isDiffLoading: false });
    }
  },

  getFileAt: async (projectRoot, snapshotId, filePath) => {
    return invoke<string>("history_file_at", {
      projectRoot,
      snapshotId,
      filePath,
    });
  },

  restoreSnapshot: async (projectRoot, snapshotId) => {
    log.info(`Restoring snapshot: ${snapshotId.slice(0, 8)}`);
    set({ isRestoring: true });
    try {
      const result = await invoke<SnapshotInfo>("history_restore", {
        projectRoot,
        snapshotId,
      });
      log.info(`Restored snapshot, new snapshot: ${result.id.slice(0, 8)}`);
      set((s) => ({ snapshots: [result, ...s.snapshots] }));
      return result;
    } finally {
      set({ isRestoring: false });
    }
  },

  addLabel: async (projectRoot, snapshotId, label) => {
    await invoke("history_add_label", { projectRoot, snapshotId, label });
    set((s) => ({
      snapshots: s.snapshots.map((snap) =>
        snap.id === snapshotId
          ? { ...snap, labels: [...snap.labels, label] }
          : snap,
      ),
    }));
  },

  removeLabel: async (projectRoot, label) => {
    await invoke("history_remove_label", { projectRoot, label });
    set((s) => ({
      snapshots: s.snapshots.map((snap) => ({
        ...snap,
        labels: snap.labels.filter((l) => l !== label),
      })),
    }));
  },

  reset: () =>
    set({
      snapshots: [],
      isLoading: false,
      selectedSnapshotId: null,
      diffResult: null,
      isDiffLoading: false,
      isRestoring: false,
      reviewingSnapshot: null,
    }),
}));
