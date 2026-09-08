import { describe, it, expect } from "vitest";
import type { ProjectFile } from "@/stores/document-store";
import { filterProjectDiagnostics } from "@/lib/latex-diagnostics";

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

const MISSING_DOC_ENV = {
  message:
    "Missing document environment. LaTeX documents should be enclosed in \\begin{document}...\\end{document}",
};
const files = [
  tex(
    "main.tex",
    "\\documentclass{article}\n\\begin{document}\n\\label{sec:intro}\n\\input{sections/results}\n\\end{document}",
  ),
  tex(
    "sections/results.tex",
    "\\section{Results}\\label{sec:results} See \\ref{sec:intro} and \\ref{sec:nowhere}.",
  ),
];

describe("filterProjectDiagnostics", () => {
  it("drops the missing-document warning for included section files", () => {
    expect(
      filterProjectDiagnostics(
        [MISSING_DOC_ENV],
        "sections/results.tex",
        files,
      ),
    ).toEqual([]);
  });

  it("keeps the missing-document warning for the root file", () => {
    expect(
      filterProjectDiagnostics([MISSING_DOC_ENV], "main.tex", files),
    ).toEqual([MISSING_DOC_ENV]);
  });

  it("drops undefined-label warnings when the label lives in another file", () => {
    const defined = { message: "Reference to undefined label: sec:intro" };
    const missing = { message: "Reference to undefined label: sec:nowhere" };
    expect(
      filterProjectDiagnostics(
        [defined, missing],
        "sections/results.tex",
        files,
      ),
    ).toEqual([missing]);
  });

  it("leaves unrelated diagnostics untouched", () => {
    const other = { message: "Missing \\end{figure}" };
    expect(
      filterProjectDiagnostics([other], "sections/results.tex", files),
    ).toEqual([other]);
  });
});
