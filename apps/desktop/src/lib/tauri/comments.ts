// Tauri command wrappers + types for the per-passage comments feature.
// Mirrors the Rust schema in apps/desktop/src-tauri/src/comments.rs.

import { invoke } from "@tauri-apps/api/core";

export interface CommentAnchor {
  line_start: number;
  line_end: number;
  char_start: number;
  char_end: number;
  quoted_text: string;
}

export interface Reply {
  author: string;
  body: string;
  ts: string;
}

export type CommentStatus =
  | "open"
  | "resolved"
  | "rejected"
  | "applied"
  | "orphaned";
export type CommentType = "comment" | "suggestion";

export interface Comment {
  id: string;
  file_path: string;
  anchor: CommentAnchor;
  type: CommentType;
  author: string;
  comment: string;
  proposed_replacement: string | null;
  status: CommentStatus;
  replies: Reply[];
  created_at: string;
  updated_at: string;
}

export interface AddCommentInput {
  projectRoot: string;
  filePath: string;
  anchor: CommentAnchor;
  type: CommentType;
  author: string;
  comment: string;
  proposedReplacement: string | null;
}

export async function listComments(projectRoot: string): Promise<Comment[]> {
  return invoke<Comment[]>("comments_list", { projectRoot });
}

export async function addComment(input: AddCommentInput): Promise<Comment> {
  return invoke<Comment>("comments_add", {
    input: {
      project_root: input.projectRoot,
      file_path: input.filePath,
      anchor: input.anchor,
      type: input.type,
      author: input.author,
      comment: input.comment,
      proposed_replacement: input.proposedReplacement,
    },
  });
}

export interface UpdateCommentInput {
  projectRoot: string;
  id: string;
  patch: Partial<Pick<Comment, "comment" | "proposed_replacement" | "status">>;
}

export async function updateComment(
  input: UpdateCommentInput,
): Promise<Comment> {
  return invoke<Comment>("comments_update", {
    input: {
      project_root: input.projectRoot,
      id: input.id,
      patch: input.patch,
    },
  });
}

export async function replyToComment(args: {
  projectRoot: string;
  id: string;
  author: string;
  body: string;
}): Promise<Comment> {
  return invoke<Comment>("comments_reply", {
    input: {
      project_root: args.projectRoot,
      id: args.id,
      author: args.author,
      body: args.body,
    },
  });
}

export async function startCommentsWatcher(projectRoot: string): Promise<void> {
  return invoke<void>("comments_start_watcher", { projectRoot });
}

export async function stopCommentsWatcher(): Promise<void> {
  return invoke<void>("comments_stop_watcher");
}
