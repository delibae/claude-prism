// CodeMirror extension for the comments feature:
//   * highlights commented ranges with a coloured underline (Decoration.mark)
//   * hover popover showing the comment + replies + action buttons
//   * click handler that focuses the matching row in the sidebar panel
//
// Action buttons inside the hover popover do not mutate state directly;
// they dispatch CustomEvents to `window` so the React layer (which holds
// the store and the modal stack) is the single source of truth.

import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  type Tooltip,
  gutter,
  GutterMarker,
} from "@codemirror/view";
import type { Comment } from "@/lib/tauri/comments";

export const setCommentsEffect = StateEffect.define<Comment[]>();

interface CommentsState {
  comments: Comment[];
  deco: DecorationSet;
}

function authorClass(c: Comment): string {
  return c.author === "claude" ? "cmp-author-claude" : "cmp-author-user";
}

function classForComment(c: Comment): string {
  const ac = authorClass(c);
  if (c.status === "resolved" || c.status === "applied")
    return `cmp-comment cmp-comment-resolved ${ac}`;
  if (c.status === "rejected") return `cmp-comment cmp-comment-rejected ${ac}`;
  if (c.status === "orphaned") return `cmp-comment cmp-comment-orphan ${ac}`;
  if (c.type === "suggestion")
    return `cmp-comment cmp-comment-suggestion ${ac}`;
  return `cmp-comment cmp-comment-open ${ac}`;
}

function buildDecorations(
  comments: Comment[],
  docLength: number,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = [...comments].sort(
    (a, b) => a.anchor.char_start - b.anchor.char_start,
  );
  for (const c of sorted) {
    if (c.status === "rejected") continue;
    const from = Math.max(0, Math.min(c.anchor.char_start, docLength));
    const to = Math.max(from, Math.min(c.anchor.char_end, docLength));
    if (from === to) continue;
    builder.add(
      from,
      to,
      Decoration.mark({
        class: classForComment(c),
        attributes: { "data-comment-id": c.id },
      }),
    );
  }
  return builder.finish();
}

export const commentsStateField = StateField.define<CommentsState>({
  create() {
    return { comments: [], deco: Decoration.none };
  },
  update(state, tr) {
    let next: CommentsState = {
      comments: state.comments,
      deco: state.deco.map(tr.changes),
    };
    for (const effect of tr.effects) {
      if (effect.is(setCommentsEffect)) {
        next = {
          comments: effect.value,
          deco: buildDecorations(effect.value, tr.state.doc.length),
        };
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.deco),
});

// ---------- Hover tooltip ----------

function commentsAt(state: CommentsState, pos: number): Comment[] {
  return state.comments.filter(
    (c) =>
      c.status !== "rejected" &&
      c.anchor.char_start <= pos &&
      pos <= c.anchor.char_end,
  );
}

function formatRelTime(iso: string): string {
  try {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    const delta = Math.max(0, Date.now() - then);
    const s = Math.floor(delta / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  } catch {
    return "";
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function dispatch(name: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function renderTooltipBody(comments: Comment[]): HTMLElement {
  const root = el("div", "cmp-tooltip");
  for (const c of comments) {
    const card = el("div", "cmp-tooltip-card");
    if (c.type === "suggestion") card.classList.add("cmp-tooltip-card-sug");
    if (c.author === "claude") card.classList.add("cmp-tooltip-card-claude");

    // Header: author chip + type + relative time
    const header = el("div", "cmp-tooltip-header");
    const chip = el(
      "span",
      `cmp-tooltip-chip cmp-tooltip-chip-${c.author === "claude" ? "claude" : "user"}`,
      c.author === "claude" ? "C" : c.author.charAt(0).toUpperCase() || "?",
    );
    chip.title = c.author;
    header.appendChild(chip);
    header.appendChild(el("span", "cmp-tooltip-author", c.author));
    header.appendChild(
      el(
        "span",
        "cmp-tooltip-type",
        c.type === "suggestion" ? "Suggest" : "Comment",
      ),
    );
    header.appendChild(
      el("span", "cmp-tooltip-time", formatRelTime(c.updated_at)),
    );
    if (c.status !== "open") {
      header.appendChild(
        el(
          "span",
          `cmp-tooltip-status cmp-tooltip-status-${c.status}`,
          c.status,
        ),
      );
    }
    card.appendChild(header);

    // Body
    if (c.comment) {
      card.appendChild(el("div", "cmp-tooltip-body", c.comment));
    }

    // Proposed replacement (for suggestions)
    if (c.type === "suggestion" && c.proposed_replacement) {
      const sugWrap = el("div", "cmp-tooltip-sug");
      sugWrap.appendChild(el("div", "cmp-tooltip-sug-label", "proposed"));
      sugWrap.appendChild(
        el("pre", "cmp-tooltip-sug-body", c.proposed_replacement),
      );
      card.appendChild(sugWrap);
    }

    // Replies (compact)
    if (c.replies.length) {
      const replies = el("div", "cmp-tooltip-replies");
      for (const r of c.replies) {
        const item = el("div", "cmp-tooltip-reply");
        const head = el("div", "cmp-tooltip-reply-head");
        head.appendChild(el("span", "cmp-tooltip-reply-author", r.author));
        head.appendChild(el("span", "cmp-tooltip-time", formatRelTime(r.ts)));
        item.appendChild(head);
        item.appendChild(el("div", "cmp-tooltip-reply-body", r.body));
        replies.appendChild(item);
      }
      card.appendChild(replies);
    }

    // Actions
    const actions = el("div", "cmp-tooltip-actions");
    const mkBtn = (label: string, name: string, evt: string) => {
      const b = el("button", `cmp-tooltip-btn cmp-tooltip-btn-${name}`, label);
      b.type = "button";
      b.addEventListener("mousedown", (e) => {
        // mousedown so the tooltip doesn't hide before click fires
        e.preventDefault();
        e.stopPropagation();
        dispatch(evt, { id: c.id });
      });
      return b;
    };
    if (c.status === "open") {
      actions.appendChild(mkBtn("Reply", "reply", "comments:reply-request"));
      actions.appendChild(mkBtn("Edit", "edit", "comments:edit-request"));
      if (c.type === "suggestion" && c.proposed_replacement) {
        actions.appendChild(mkBtn("Apply", "apply", "comments:apply-request"));
      }
      actions.appendChild(
        mkBtn("Resolve", "resolve", "comments:resolve-request"),
      );
      actions.appendChild(mkBtn("Reject", "reject", "comments:reject-request"));
    } else {
      actions.appendChild(mkBtn("Reopen", "reopen", "comments:reopen-request"));
      actions.appendChild(mkBtn("Edit", "edit", "comments:edit-request"));
    }
    card.appendChild(actions);

    root.appendChild(card);
  }
  return root;
}

const commentsHoverTooltip = hoverTooltip(
  (view, pos): Tooltip | null => {
    const state = view.state.field(commentsStateField, false);
    if (!state) return null;
    const matches = commentsAt(state, pos);
    if (matches.length === 0) return null;
    // Anchor the tooltip on the first match's start
    const first = matches[0];
    return {
      pos: Math.max(
        0,
        Math.min(first.anchor.char_start, view.state.doc.length),
      ),
      end: Math.max(
        first.anchor.char_start,
        Math.min(first.anchor.char_end, view.state.doc.length),
      ),
      above: true,
      arrow: true,
      create: () => {
        const dom = renderTooltipBody(matches);
        return { dom };
      },
    };
  },
  { hideOnChange: true, hoverTime: 250 },
);

// ---------- Gutter markers ----------

class CommentGutterMarker extends GutterMarker {
  constructor(private readonly comment: Comment) {
    super();
  }
  eq(other: GutterMarker): boolean {
    return (
      other instanceof CommentGutterMarker &&
      other.comment.id === this.comment.id &&
      other.comment.status === this.comment.status &&
      other.comment.type === this.comment.type
    );
  }
  toDOM(): Node {
    const dot = document.createElement("span");
    const palette =
      this.comment.status === "resolved" || this.comment.status === "applied"
        ? "cmp-gutter-resolved"
        : this.comment.status === "orphaned"
          ? "cmp-gutter-orphan"
          : this.comment.type === "suggestion"
            ? "cmp-gutter-sug"
            : "cmp-gutter-open";
    const authorClass =
      this.comment.author === "claude"
        ? "cmp-gutter-author-claude"
        : "cmp-gutter-author-user";
    dot.className = `cmp-gutter-dot ${palette} ${authorClass}`;
    dot.title = `${this.comment.author}: ${(this.comment.comment || "(no body)").slice(0, 120)}`;
    const c = this.comment;
    dot.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(
        new CustomEvent("comments:focus-in-panel", { detail: { id: c.id } }),
      );
      window.dispatchEvent(
        new CustomEvent("comments:jump", {
          detail: { from: c.anchor.char_start, to: c.anchor.char_end },
        }),
      );
    });
    return dot;
  }
}

const commentsGutter = gutter({
  class: "cmp-gutter-col",
  markers(view) {
    const state = view.state.field(commentsStateField, false);
    const builder = new RangeSetBuilder<GutterMarker>();
    if (!state) return builder.finish();
    const docLen = view.state.doc.length;
    const seenLines = new Set<number>();
    const sorted = [...state.comments]
      .filter((c) => c.status !== "rejected")
      .sort((a, b) => a.anchor.char_start - b.anchor.char_start);
    for (const c of sorted) {
      const start = Math.max(0, Math.min(c.anchor.char_start, docLen));
      const line = view.state.doc.lineAt(start);
      if (seenLines.has(line.number)) continue;
      seenLines.add(line.number);
      builder.add(line.from, line.from, new CommentGutterMarker(c));
    }
    return builder.finish();
  },
});

// ---------- Click → focus in panel ----------

const clickToFocusInPanel = EditorView.domEventHandlers({
  click: (event, _view) => {
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    const anchorEl = target.closest("[data-comment-id]");
    if (!anchorEl) return false;
    const id = anchorEl.getAttribute("data-comment-id");
    if (!id) return false;
    dispatch("comments:focus-in-panel", { id });
    return false; // do not preventDefault — let the click also place cursor
  },
});

// ---------- Theme ----------

export const commentsTheme = EditorView.theme({
  // Default (user) colors — overridden by author classes below.
  ".cmp-comment-open": {
    backgroundColor: "rgba(252, 211, 77, 0.32)",
    borderBottom: "2px solid rgba(245, 158, 11, 0.85)",
    cursor: "pointer",
  },
  ".cmp-comment-suggestion": {
    backgroundColor: "rgba(56, 189, 248, 0.28)",
    borderBottom: "2px solid rgba(14, 165, 233, 0.85)",
    cursor: "pointer",
  },
  // Claude-authored: violet/indigo palette so the user can tell at a glance
  // who wrote what.
  ".cmp-comment-open.cmp-author-claude": {
    backgroundColor: "rgba(167, 139, 250, 0.30)", // violet-400/30
    borderBottom: "2px solid rgba(124, 58, 237, 0.85)", // violet-600
  },
  ".cmp-comment-suggestion.cmp-author-claude": {
    backgroundColor: "rgba(129, 140, 248, 0.30)", // indigo-400/30
    borderBottom: "2px solid rgba(79, 70, 229, 0.85)", // indigo-600
  },
  ".cmp-comment-resolved": {
    backgroundColor: "rgba(134, 239, 172, 0.22)",
    borderBottom: "2px dashed rgba(74, 222, 128, 0.6)",
    cursor: "pointer",
  },
  ".cmp-comment-orphan": {
    backgroundColor: "rgba(244, 114, 182, 0.22)",
    borderBottom: "2px dotted rgba(236, 72, 153, 0.7)",
    cursor: "pointer",
  },
  ".cmp-comment-rejected": {
    backgroundColor: "transparent",
    borderBottom: "none",
  },

  // ---- tooltip ----
  ".cm-tooltip:has(.cmp-tooltip)": {
    backgroundColor: "transparent",
    border: "none",
    padding: "0",
  },
  ".cmp-tooltip": {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxWidth: "360px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "12px",
    color: "var(--foreground, #111)",
  },
  ".cmp-tooltip-card": {
    backgroundColor: "var(--popover, #fff)",
    color: "var(--popover-foreground, #111)",
    border: "1px solid var(--border, rgba(0,0,0,0.1))",
    borderRadius: "8px",
    padding: "8px 10px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    borderLeft: "3px solid rgba(245, 158, 11, 0.85)",
  },
  ".cmp-tooltip-card-sug": {
    borderLeft: "3px solid rgba(14, 165, 233, 0.85)",
  },
  ".cmp-tooltip-card-claude": {
    borderLeft: "3px solid rgba(124, 58, 237, 0.85)",
  },
  ".cmp-tooltip-card-claude.cmp-tooltip-card-sug": {
    borderLeft: "3px solid rgba(79, 70, 229, 0.85)",
  },
  ".cmp-tooltip-chip": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    fontSize: "9px",
    fontWeight: "700",
    color: "#fff",
    fontFamily: "system-ui, -apple-system, sans-serif",
    flexShrink: "0",
  },
  ".cmp-tooltip-chip-user": {
    backgroundColor: "rgb(217, 119, 6)",
  },
  ".cmp-tooltip-chip-claude": {
    backgroundColor: "rgb(124, 58, 237)",
  },
  ".cmp-tooltip-header": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginBottom: "4px",
    fontSize: "11px",
  },
  ".cmp-tooltip-type": {
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--muted-foreground, #555)",
    fontSize: "10px",
  },
  ".cmp-tooltip-author": {
    fontWeight: "600",
  },
  ".cmp-tooltip-time": {
    color: "var(--muted-foreground, #777)",
    fontSize: "10px",
  },
  ".cmp-tooltip-status": {
    marginLeft: "auto",
    padding: "1px 6px",
    borderRadius: "10px",
    fontSize: "10px",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  ".cmp-tooltip-status-resolved": {
    backgroundColor: "rgba(134, 239, 172, 0.3)",
    color: "rgb(22, 101, 52)",
  },
  ".cmp-tooltip-status-applied": {
    backgroundColor: "rgba(134, 239, 172, 0.3)",
    color: "rgb(22, 101, 52)",
  },
  ".cmp-tooltip-status-rejected": {
    backgroundColor: "rgba(228, 228, 231, 0.5)",
    color: "rgb(82, 82, 91)",
  },
  ".cmp-tooltip-status-orphaned": {
    backgroundColor: "rgba(244, 114, 182, 0.3)",
    color: "rgb(157, 23, 77)",
  },
  ".cmp-tooltip-body": {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: "1.4",
  },
  ".cmp-tooltip-sug": {
    marginTop: "6px",
    padding: "6px 8px",
    backgroundColor: "rgba(14, 165, 233, 0.08)",
    border: "1px solid rgba(14, 165, 233, 0.25)",
    borderRadius: "6px",
  },
  ".cmp-tooltip-sug-label": {
    fontSize: "9px",
    fontWeight: "600",
    textTransform: "uppercase",
    color: "rgb(3, 105, 161)",
    marginBottom: "2px",
  },
  ".cmp-tooltip-sug-body": {
    fontFamily: "ui-monospace, monospace",
    fontSize: "11px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    margin: "0",
    lineHeight: "1.35",
  },
  ".cmp-tooltip-replies": {
    marginTop: "6px",
    paddingLeft: "8px",
    borderLeft: "2px solid var(--border, rgba(0,0,0,0.1))",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  ".cmp-tooltip-reply-head": {
    display: "flex",
    gap: "4px",
    fontSize: "10px",
    color: "var(--muted-foreground, #777)",
  },
  ".cmp-tooltip-reply-author": {
    fontWeight: "600",
    color: "var(--foreground, #111)",
  },
  ".cmp-tooltip-reply-body": {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: "12px",
    lineHeight: "1.35",
  },
  ".cmp-tooltip-actions": {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    marginTop: "8px",
    paddingTop: "6px",
    borderTop: "1px solid var(--border, rgba(0,0,0,0.08))",
  },
  ".cmp-tooltip-btn": {
    appearance: "none",
    border: "1px solid var(--border, rgba(0,0,0,0.15))",
    background: "transparent",
    color: "var(--foreground, #111)",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "background 80ms ease",
  },
  ".cmp-tooltip-btn:hover": {
    background: "var(--accent, rgba(0,0,0,0.06))",
  },
  ".cmp-tooltip-btn-apply": {
    color: "rgb(3, 105, 161)",
    borderColor: "rgba(14, 165, 233, 0.5)",
  },
  ".cmp-tooltip-btn-resolve": {
    color: "rgb(22, 101, 52)",
    borderColor: "rgba(74, 222, 128, 0.55)",
  },
  ".cmp-tooltip-btn-reject": {
    color: "rgb(127, 29, 29)",
    borderColor: "rgba(248, 113, 113, 0.55)",
  },

  // ---- gutter ----
  ".cmp-gutter-col": {
    width: "12px",
    minWidth: "12px",
  },
  ".cmp-gutter-dot": {
    display: "block",
    width: "6px",
    height: "6px",
    margin: "5px auto 0",
    borderRadius: "50%",
    cursor: "pointer",
    boxShadow: "0 0 0 1px rgba(0,0,0,0.06)",
  },
  ".cmp-gutter-open": {
    backgroundColor: "rgb(245, 158, 11)",
  },
  ".cmp-gutter-sug": {
    backgroundColor: "rgb(14, 165, 233)",
  },
  ".cmp-gutter-resolved": {
    backgroundColor: "rgb(74, 222, 128)",
  },
  ".cmp-gutter-orphan": {
    backgroundColor: "rgb(236, 72, 153)",
  },
  // Author-specific overrides for the dot (Claude = violet/indigo)
  ".cmp-gutter-open.cmp-gutter-author-claude": {
    backgroundColor: "rgb(124, 58, 237)", // violet-600
  },
  ".cmp-gutter-sug.cmp-gutter-author-claude": {
    backgroundColor: "rgb(79, 70, 229)", // indigo-600
  },
});

export const commentsExtension = [
  commentsStateField,
  commentsHoverTooltip,
  clickToFocusInPanel,
  commentsGutter,
  commentsTheme,
];
