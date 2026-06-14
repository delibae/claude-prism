import { describe, it, expect } from "vitest";
import {
  parseOllamaProposedChanges,
  applyOllamaEdit,
} from "@/lib/ollama-edit-parser";

describe("parseOllamaProposedChanges", () => {
  it("returns an empty array when there are no edit blocks", () => {
    expect(parseOllamaProposedChanges("Hello, world!")).toEqual([]);
  });

  it("parses a single proposed-change block", () => {
    const text = `
Some explanation.

<proposed-change file="main.tex">
<old>
\\section{Introduction}
Hello.
</old>
<new>
\\section{Introduction}
Hello, world!
</new>
</proposed-change>
`;
    const edits = parseOllamaProposedChanges(text);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      filePath: "main.tex",
      oldText: "\\section{Introduction}\nHello.",
      newText: "\\section{Introduction}\nHello, world!",
    });
  });

  it("parses multiple proposed-change blocks", () => {
    const text = `
<proposed-change file="a.tex">
<old>alpha</old>
<new>ALPHA</new>
</proposed-change>
<proposed-change file="b.tex">
<old>beta</old>
<new>BETA</new>
</proposed-change>
`;
    const edits = parseOllamaProposedChanges(text);
    expect(edits).toHaveLength(2);
    expect(edits[0].filePath).toBe("a.tex");
    expect(edits[1].filePath).toBe("b.tex");
  });

  it("ignores partial blocks without a closing tag", () => {
    const text = `
<proposed-change file="main.tex">
<old>old text</old>
<new>new text</new>
`;
    expect(parseOllamaProposedChanges(text)).toEqual([]);
  });
});

describe("applyOllamaEdit", () => {
  it("replaces exact old text", () => {
    const result = applyOllamaEdit(
      "\\section{Intro}\nHello.\n\\section{Body}",
      "\\section{Intro}\nHello.\n",
      "\\section{Intro}\nHello, world!\n",
    );
    expect(result).toBe("\\section{Intro}\nHello, world!\n\\section{Body}");
  });

  it("returns null when old text is not found", () => {
    const result = applyOllamaEdit("some content", "missing text", "new text");
    expect(result).toBeNull();
  });

  it("falls back to trimmed matching", () => {
    const result = applyOllamaEdit(
      "\\section{Intro}\nHello.\n",
      "\n\\section{Intro}\nHello.\n",
      "\\section{Intro}\nHello, world!",
    );
    expect(result).toBe("\\section{Intro}\nHello, world!\n");
  });
});
