// Zustand store for the per-passage comments feature.
//
// Subscribes to the backend `comments-changed` event so external writes
// (e.g. a Claude Code terminal session) appear live. On every refresh
// triggered by an event, detects new comments or replies authored by a
// remote actor and fires a sonner toast so the user notices.

import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  type Comment,
  type AddCommentInput,
  type UpdateCommentInput,
  listComments,
  addComment as backendAdd,
  updateComment as backendUpdate,
  replyToComment as backendReply,
  startCommentsWatcher,
  stopCommentsWatcher,
} from "@/lib/tauri/comments";

export const LOCAL_AUTHOR = "user";

interface CommentsState {
  projectRoot: string | null;
  comments: Comment[];
  loading: boolean;
  error: string | null;

  _unlisten: UnlistenFn | null;
  // Snapshot of (commentId -> reply count) used to diff after an external
  // refresh and decide whether to fire a toast.
  _replyCountById: Map<string, number>;
  _seenCommentIds: Set<string>;

  attachToProject: (projectRoot: string) => Promise<void>;
  detach: () => Promise<void>;
  refresh: (options?: { silent?: boolean }) => Promise<void>;

  addComment: (input: Omit<AddCommentInput, "projectRoot">) => Promise<Comment>;
  updateComment: (
    id: string,
    patch: UpdateCommentInput["patch"],
  ) => Promise<Comment>;
  reply: (id: string, body: string, author?: string) => Promise<Comment>;

  byFile: (filePath: string) => Comment[];
  openCount: () => number;
}

function snapshotReplyCounts(comments: Comment[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of comments) m.set(c.id, c.replies.length);
  return m;
}

function snapshotIds(comments: Comment[]): Set<string> {
  return new Set(comments.map((c) => c.id));
}

function fileShortName(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return i >= 0 ? filePath.slice(i + 1) : filePath;
}

function summarizeBody(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;
}

export const useCommentsStore = create<CommentsState>()((set, get) => ({
  projectRoot: null,
  comments: [],
  loading: false,
  error: null,
  _unlisten: null,
  _replyCountById: new Map(),
  _seenCommentIds: new Set(),

  attachToProject: async (projectRoot: string) => {
    await get().detach();
    set({ projectRoot, loading: true, error: null });

    try {
      const comments = await listComments(projectRoot);
      set({
        comments,
        loading: false,
        _replyCountById: snapshotReplyCounts(comments),
        _seenCommentIds: snapshotIds(comments),
      });
    } catch (e) {
      set({ error: String(e), loading: false });
    }

    try {
      await startCommentsWatcher(projectRoot);
    } catch (e) {
      console.warn("[comments] failed to start watcher:", e);
    }

    try {
      const unlisten = await listen<{ path: string }>(
        "comments-changed",
        async () => {
          await get().refresh();
        },
      );
      set({ _unlisten: unlisten });
    } catch (e) {
      console.warn("[comments] failed to listen:", e);
    }
  },

  detach: async () => {
    const { _unlisten } = get();
    if (_unlisten) {
      try {
        _unlisten();
      } catch {
        /* noop */
      }
    }
    try {
      await stopCommentsWatcher();
    } catch {
      /* noop */
    }
    set({
      projectRoot: null,
      comments: [],
      loading: false,
      error: null,
      _unlisten: null,
      _replyCountById: new Map(),
      _seenCommentIds: new Set(),
    });
  },

  refresh: async (options) => {
    const silent = options?.silent ?? false;
    const root = get().projectRoot;
    if (!root) return;
    try {
      const next = await listComments(root);

      if (!silent) {
        const prevIds = get()._seenCommentIds;
        const prevReplyCounts = get()._replyCountById;

        // New comments from remote
        for (const c of next) {
          if (!prevIds.has(c.id) && c.author !== LOCAL_AUTHOR) {
            const label =
              c.type === "suggestion"
                ? `${c.author} suggested an edit on ${fileShortName(c.file_path)}:${c.anchor.line_start}`
                : `${c.author} commented on ${fileShortName(c.file_path)}:${c.anchor.line_start}`;
            toast.info(label, {
              description: summarizeBody(c.comment || ""),
              action: {
                label: "Show",
                onClick: () => {
                  window.dispatchEvent(
                    new CustomEvent("comments:focus-in-panel", {
                      detail: { id: c.id },
                    }),
                  );
                  window.dispatchEvent(
                    new CustomEvent("comments:jump", {
                      detail: {
                        from: c.anchor.char_start,
                        to: c.anchor.char_end,
                      },
                    }),
                  );
                },
              },
            });
          }
        }

        // New replies on existing comments
        for (const c of next) {
          const before = prevReplyCounts.get(c.id) ?? 0;
          if (c.replies.length > before) {
            const newOnes = c.replies.slice(before);
            for (const r of newOnes) {
              if (r.author === LOCAL_AUTHOR) continue;
              toast.info(
                `${r.author} replied on ${fileShortName(c.file_path)}:${c.anchor.line_start}`,
                {
                  description: summarizeBody(r.body),
                  action: {
                    label: "Show",
                    onClick: () => {
                      window.dispatchEvent(
                        new CustomEvent("comments:focus-in-panel", {
                          detail: { id: c.id },
                        }),
                      );
                    },
                  },
                },
              );
            }
          }
        }
      }

      set({
        comments: next,
        _replyCountById: snapshotReplyCounts(next),
        _seenCommentIds: snapshotIds(next),
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  addComment: async (input) => {
    const root = get().projectRoot;
    if (!root) throw new Error("No project open");
    const added = await backendAdd({ ...input, projectRoot: root });
    set((s) => {
      const next = [...s.comments, added];
      return {
        comments: next,
        _replyCountById: snapshotReplyCounts(next),
        _seenCommentIds: snapshotIds(next),
      };
    });
    return added;
  },

  updateComment: async (id, patch) => {
    const root = get().projectRoot;
    if (!root) throw new Error("No project open");
    const updated = await backendUpdate({ projectRoot: root, id, patch });
    set((s) => {
      const next = s.comments.map((c) => (c.id === id ? updated : c));
      return {
        comments: next,
        _replyCountById: snapshotReplyCounts(next),
      };
    });
    return updated;
  },

  reply: async (id, body, author = LOCAL_AUTHOR) => {
    const root = get().projectRoot;
    if (!root) throw new Error("No project open");
    const updated = await backendReply({ projectRoot: root, id, author, body });
    set((s) => {
      const next = s.comments.map((c) => (c.id === id ? updated : c));
      return {
        comments: next,
        _replyCountById: snapshotReplyCounts(next),
      };
    });
    return updated;
  },

  byFile: (filePath: string) => {
    return get().comments.filter((c) => c.file_path === filePath);
  },

  openCount: () => {
    return get().comments.filter((c) => c.status === "open").length;
  },
}));
