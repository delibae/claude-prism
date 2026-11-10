import { invoke } from "@tauri-apps/api/core";
import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";
import { createLogger } from "@/lib/debug/logger";
import type { CompileOptions } from "@/stores/settings-store";

const log = createLogger("latex");

/** Resolve which file to compile and the root ID for caching.
 *  resolveTexRoot now handles \documentclass detection and main.tex fallback,
 *  so the only remaining fallback here is for projects with no .tex files.
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
  // No .tex file exists — cannot compile
  const anyTex = files.find((f) => f.type === "tex");
  if (anyTex) {
    return { rootId: anyTex.id, targetPath: anyTex.relativePath };
  }
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

const TECTONIC_OPTIONS: CompileOptions = {
  useTexlive: false,
  texEngine: "pdflatex",
  texliveYear: null,
};

export async function compileLatex(
  projectDir: string,
  mainFile: string = "main.tex",
  options: CompileOptions = TECTONIC_OPTIONS,
): Promise<Uint8Array> {
  const { useTexlive, texEngine, texliveYear } = options;
  const backend = useTexlive
    ? `texlive/${texEngine}${texliveYear ? ` ${texliveYear}` : ""}`
    : "tectonic";
  log.info(`Compiling ${mainFile} (backend: ${backend})`);
  const start = performance.now();
  // compile_latex returns raw PDF bytes via Tauri IPC Response
  const buffer = await invoke<ArrayBuffer>("compile_latex", {
    projectDir,
    mainFile,
    useTexlive,
    texEngine,
    texliveYear,
  });

  const result = new Uint8Array(buffer);
  log.info(
    `Compiled ${mainFile} in ${(performance.now() - start).toFixed(0)}ms (${(result.byteLength / 1024).toFixed(0)} KB)`,
  );
  return result;
}

export interface TexliveInstall {
  year: number;
  binDir: string;
  engines: string[];
}

export interface TexliveStatus {
  /** Whether the system-default TeX Live has any engine. */
  available: boolean;
  engines: string[];
  /** `--version` banner of the system-default engine. */
  version: string | null;
  /** TeX Live year of the system-default engine. */
  year: number | null;
  /** Year-versioned installs found on disk, newest first. */
  installs: TexliveInstall[];
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
