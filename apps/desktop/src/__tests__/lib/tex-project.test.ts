import { describe, it, expect } from "vitest";
import type { ProjectFile } from "@/stores/document-store";
import {
  collectProjectLabels,
  findIncludingRoots,
  normalizeTexPath,
  resolveTexRoot,
} from "@/lib/tex-project";

function tex(relativePath: string, content: string): ProjectFile {
  return {
    id: relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    absolutePath: `/project/${relativePath}`,
    type: "tex",
    content,
    isDirty: false,
  };
}

const ROOT = "\\documentclass{article}\n\\begin{document}\n";

describe("normalizeTexPath", () => {
  it("collapses dot segments and backslashes", () => {
    expect(normalizeTexPath("sections/../sections/./intro.tex")).toBe(
      "sections/intro.tex",
    );
    expect(normalizeTexPath("sections\\intro.tex")).toBe("sections/intro.tex");
    expect(normalizeTexPath("./main.tex")).toBe("main.tex");
  });
});

describe("resolveTexRoot", () => {
  it("resolves a section file to the root that \\input's it", () => {
    const files = [
      tex("paper.tex", `${ROOT}\\input{sections/intro}\n\\end{document}`),
      tex("sections/intro.tex", "\\section{Intro}\nText.\n"),
    ];
    expect(resolveTexRoot("sections/intro.tex", files)).toBe("paper.tex");
  });

  it("prefers the root that actually includes the file over other roots", () => {
    const files = [
      tex("main.tex", `${ROOT}Standalone\n\\end{document}`),
      tex(
        "thesis.tex",
        `${ROOT}\\include{chapters/ch1}\n\\input{sections/intro.tex}\n\\end{document}`,
      ),
      tex("chapters/ch1.tex", "\\chapter{One}"),
      tex("sections/intro.tex", "\\section{Intro}"),
    ];
    expect(resolveTexRoot("chapters/ch1.tex", files)).toBe("thesis.tex");
    expect(resolveTexRoot("sections/intro.tex", files)).toBe("thesis.tex");
  });

  it("follows transitive includes", () => {
    const files = [
      tex("main.tex", `${ROOT}\\input{sections/all}\n\\end{document}`),
      tex("sections/all.tex", "\\input{sections/a}\n\\input{sections/b}\n"),
      tex("sections/a.tex", "A"),
      tex("sections/b.tex", "B"),
    ];
    expect(resolveTexRoot("sections/b.tex", files)).toBe("main.tex");
  });

  it("ignores commented-out includes", () => {
    const files = [
      tex("main.tex", `${ROOT}% \\input{sections/old}\n\\end{document}`),
      tex("other.tex", `${ROOT}\\input{sections/old}\n\\end{document}`),
      tex("sections/old.tex", "Old"),
    ];
    expect(resolveTexRoot("sections/old.tex", files)).toBe("other.tex");
  });

  it("resolves includes relative to the including file's directory", () => {
    const files = [
      tex("main.tex", `${ROOT}\\input{chapters/ch1}\n\\end{document}`),
      tex("chapters/ch1.tex", "\\input{ch1-details}"),
      tex("chapters/ch1-details.tex", "Details"),
    ];
    expect(resolveTexRoot("chapters/ch1-details.tex", files)).toBe("main.tex");
  });

  it("resolves \\import and \\subimport", () => {
    const files = [
      tex("main.tex", `${ROOT}\\import{sections/}{intro}\n\\end{document}`),
      tex("sections/intro.tex", "\\subimport{sub/}{deep}"),
      tex("sections/sub/deep.tex", "Deep"),
    ];
    expect(resolveTexRoot("sections/sub/deep.tex", files)).toBe("main.tex");
  });

  it("resolves a relative % !TEX root magic comment", () => {
    const files = [
      tex("main.tex", `${ROOT}\\end{document}`),
      tex("sections/intro.tex", "% !TEX root = ../main.tex\nText"),
    ];
    expect(resolveTexRoot("sections/intro.tex", files)).toBe("main.tex");
  });

  it("returns the file itself when it has \\documentclass", () => {
    const files = [
      tex("main.tex", `${ROOT}\\input{fig}\n\\end{document}`),
      tex("fig.tex", "\\documentclass{standalone}\n\\begin{document}x"),
    ];
    expect(resolveTexRoot("fig.tex", files)).toBe("fig.tex");
  });

  it("falls back to main.tex for a not-yet-included file", () => {
    const files = [
      tex("main.tex", `${ROOT}\\end{document}`),
      tex("sections/new.tex", "New section"),
    ];
    expect(resolveTexRoot("sections/new.tex", files)).toBe("main.tex");
  });

  it("falls back to main.tex when the file's content is not loaded yet", () => {
    const files = [
      tex("main.tex", `${ROOT}\\end{document}`),
      { ...tex("sections/lazy.tex", ""), content: undefined },
    ];
    expect(resolveTexRoot("sections/lazy.tex", files)).toBe("main.tex");
  });

  it("returns the file itself when there is no root at all", () => {
    const files = [tex("notes.tex", "Just notes")];
    expect(resolveTexRoot("notes.tex", files)).toBe("notes.tex");
  });
});

describe("findIncludingRoots", () => {
  it("does not treat \\includegraphics as a file include", () => {
    const files = [
      tex("main.tex", `${ROOT}\\includegraphics{fig}\n\\end{document}`),
      tex("fig.tex", "not a figure"),
    ];
    expect(findIncludingRoots("fig.tex", files)).toEqual([]);
  });
});

describe("collectProjectLabels", () => {
  it("collects labels from other tex files only", () => {
    const files = [
      tex("main.tex", "\\label{sec:main}"),
      tex("sections/a.tex", "\\label{ fig:a }\n\\label{eq:1}"),
    ];
    const labels = collectProjectLabels(files, "main.tex");
    expect([...labels].sort()).toEqual(["eq:1", "fig:a"]);
  });
});
