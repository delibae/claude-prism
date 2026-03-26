import { invoke } from "@tauri-apps/api/core";
import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("latex");

/** Resolve which file to compile and the root ID for caching.
 *  Returns `null` when the project has no compilable .tex file. */
export function resolveCompileTarget(
  activeFileId: string,
  files: ProjectFile[],
): { rootId: string; targetPath: string } | null {
  const rootId = resolveTexRoot(activeFileId, files);
  const rootEntry = files.find((f) => f.id === rootId);
  if (rootEntry?.type === "tex") {
    return { rootId, targetPath: rootEntry.relativePath };
  }
  // Fallback: look for any well-known root tex file
  const fallback = files.find(
    (f) => f.name === "main.tex" || f.name === "document.tex",
  );
  if (fallback) {
    return { rootId: fallback.id, targetPath: fallback.relativePath };
  }
  // Final fallback: use the first available .tex file in the project
  const anyTex = files.find((f) => f.type === "tex");
  if (anyTex) {
    return { rootId: anyTex.id, targetPath: anyTex.relativePath };
  }
  // No .tex file exists — cannot compile
  return null;
}

/** Extract a human-readable error message from an unknown catch value. */
export function formatCompileError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Compilation failed";
}

export async function compileLatex(
  projectDir: string,
  mainFile: string = "main.tex",
  useTexlive: boolean = false,
): Promise<Uint8Array> {
  log.info(
    `Compiling ${mainFile} (backend: ${useTexlive ? "texlive" : "tectonic"})`,
  );
  const start = performance.now();
  // compile_latex returns raw PDF bytes via Tauri IPC Response
  const buffer = await invoke<ArrayBuffer>("compile_latex", {
    projectDir,
    mainFile,
    useTexlive,
  });

  const result = new Uint8Array(buffer);
  log.info(
    `Compiled ${mainFile} in ${(performance.now() - start).toFixed(0)}ms (${(result.byteLength / 1024).toFixed(0)} KB)`,
  );
  return result;
}

export interface TexliveStatus {
  available: boolean;
  engines: string[];
  version: string | null;
}

export async function detectTexlive(): Promise<TexliveStatus> {
  return invoke<TexliveStatus>("detect_texlive");
}

export interface SynctexResult {
  file: string;
  line: number;
  column: number;
}

export async function synctexEdit(
  projectDir: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexResult | null> {
  try {
    const result = await invoke<SynctexResult>("synctex_edit", {
      projectDir,
      page,
      x,
      y,
    });
    if (result)
      log.debug(`SyncTeX: page ${page} → ${result.file}:${result.line}`);
    return result;
  } catch (err) {
    log.debug("SyncTeX lookup failed", { page, error: String(err) });
    return null;
  }
}
