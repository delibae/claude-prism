// Modal composer for adding a new comment or suggestion.
// Opened from the SelectionToolbar after the user picks "Comment" or "Suggest".

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface CommentComposerProps {
  open: boolean;
  mode: "comment" | "suggestion";
  quotedText: string;
  initialReplacement?: string; // pre-fill for suggestion (typically the original)
  onCancel: () => void;
  onSubmit: (data: { comment: string; replacement: string | null }) => void;
}

export function CommentComposer({
  open,
  mode,
  quotedText,
  initialReplacement,
  onCancel,
  onSubmit,
}: CommentComposerProps) {
  const [comment, setComment] = useState("");
  const [replacement, setReplacement] = useState(initialReplacement ?? "");
  const commentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setComment("");
      setReplacement(initialReplacement ?? quotedText);
      // Focus the textarea after the dialog has animated in
      const t = setTimeout(() => commentRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [open, initialReplacement, quotedText]);

  const trimmedComment = comment.trim();
  const canSubmit =
    mode === "comment"
      ? trimmedComment.length > 0
      : trimmedComment.length > 0 || replacement.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({
      comment: trimmedComment,
      replacement: mode === "suggestion" ? replacement : null,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl + Enter = submit
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-lg" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>
            {mode === "comment" ? "Add comment" : "Suggest change"}
          </DialogTitle>
          <DialogDescription>
            Anchored to the selected passage. Visible to Claude Code via{" "}
            <code className="rounded bg-muted px-1 text-xs">
              .claudeprism/comments.json
            </code>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <div className="mb-1 text-muted-foreground text-xs">
              Selected text
            </div>
            <div className="max-h-32 overflow-y-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs leading-snug">
              {quotedText.length > 280
                ? `${quotedText.slice(0, 280)}…`
                : quotedText}
            </div>
          </div>

          <div>
            <label
              htmlFor="comment-composer-text"
              className="mb-1 block text-xs"
            >
              {mode === "comment" ? "Comment" : "Why change this"}
            </label>
            <Textarea
              id="comment-composer-text"
              ref={commentRef}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={
                mode === "comment"
                  ? "Type a question or note for Claude Code…"
                  : "Reason for the suggestion (optional if you provide a replacement)…"
              }
              className="min-h-[80px]"
            />
          </div>

          {mode === "suggestion" && (
            <div>
              <label
                htmlFor="comment-composer-repl"
                className="mb-1 block text-xs"
              >
                Proposed replacement
              </label>
              <Textarea
                id="comment-composer-repl"
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                placeholder="The text that should replace the selection…"
                className="min-h-[100px] font-mono text-xs"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {mode === "comment" ? "Add comment" : "Add suggestion"}
            <span className="ml-2 text-xs opacity-60">⌘↵</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
