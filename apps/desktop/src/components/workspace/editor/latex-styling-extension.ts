import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// Single-arg LaTeX commands we visually style in source view.
// Match the common simple form (no nested braces) — sufficient for
// "make bold things bold, make section titles bigger".
const PATTERNS: { re: RegExp; cls: string }[] = [
  { re: /\\section\*?\{([^{}]*)\}/g, cls: "tex-section" },
  { re: /\\subsection\*?\{([^{}]*)\}/g, cls: "tex-subsection" },
  { re: /\\subsubsection\*?\{([^{}]*)\}/g, cls: "tex-subsubsection" },
  { re: /\\paragraph\*?\{([^{}]*)\}/g, cls: "tex-paragraph" },
  { re: /\\textbf\{([^{}]*)\}/g, cls: "tex-bold" },
  { re: /\\textit\{([^{}]*)\}/g, cls: "tex-italic" },
  { re: /\\emph\{([^{}]*)\}/g, cls: "tex-italic" },
];

function buildDecorations(view: EditorView): DecorationSet {
  type R = { from: number; to: number; cls: string };
  const ranges: R[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const { re, cls } of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const idx = m.index ?? 0;
        const match = m[0];
        const argStart = from + idx + match.indexOf("{") + 1;
        const argEnd = from + idx + match.length - 1;
        if (argEnd > argStart) ranges.push({ from: argStart, to: argEnd, cls });
      }
    }
  }
  // RangeSetBuilder requires ranges sorted by `from` (then `to`).
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) {
    builder.add(r.from, r.to, Decoration.mark({ class: r.cls }));
  }
  return builder.finish();
}

const theme = EditorView.theme({
  ".cm-content": {
    fontFamily: '"Times New Roman", Times, serif',
  },
  ".tex-section": { fontSize: "1.6em", fontWeight: "700" },
  ".tex-subsection": { fontSize: "1.35em", fontWeight: "700" },
  ".tex-subsubsection": { fontSize: "1.15em", fontWeight: "700" },
  ".tex-paragraph": { fontWeight: "700" },
  ".tex-bold": { fontWeight: "700" },
  ".tex-italic": { fontStyle: "italic" },
});

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const latexStyling = () => [theme, plugin];
