import type { ProjectFile } from "@/stores/document-store";
import { collectProjectLabels, resolveTexRoot } from "@/lib/tex-project";

const MISSING_DOCUMENT_ENV_PREFIX = "Missing document environment";
const UNDEFINED_LABEL_RE = /^Reference to undefined label: (.+)$/;

/**
 * Drop linter diagnostics that only make sense for a single-file document.
 *
 * In multi-file projects (`\input{sections/...}`), section files legitimately
 * lack `\begin{document}` and reference labels defined in sibling files. The
 * bundled LaTeX linter only sees one file at a time, so filter those findings
 * using project-wide knowledge.
 */
export function filterProjectDiagnostics<T extends { message: string }>(
  diagnostics: T[],
  activeFileId: string,
  files: ProjectFile[],
): T[] {
  if (diagnostics.length === 0) return diagnostics;
  const activeFile = files.find((f) => f.id === activeFileId);
  if (!activeFile || activeFile.type !== "tex") return diagnostics;

  const isRootFile = resolveTexRoot(activeFileId, files) === activeFileId;
  let externalLabels: Set<string> | null = null;

  return diagnostics.filter((d) => {
    if (!isRootFile && d.message.startsWith(MISSING_DOCUMENT_ENV_PREFIX)) {
      return false;
    }
    const labelMatch = d.message.match(UNDEFINED_LABEL_RE);
    if (labelMatch) {
      externalLabels ??= collectProjectLabels(files, activeFileId);
      if (externalLabels.has(labelMatch[1].trim())) return false;
    }
    return true;
  });
}
