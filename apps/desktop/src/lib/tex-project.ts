import type { ProjectFile } from "@/stores/document-store";

const DOCUMENTCLASS_RE = /\\documentclass[\s{[]/;
const MAGIC_ROOT_RE = /^%\s*!TEX\s+root\s*=\s*(.+)/i;
/**
 * Matches file-inclusion commands. Group 1 is the command, group 2 the first
 * brace argument, group 3 the optional second brace argument (used by
 * `\import{dir}{file}` and friends).
 */
const INCLUDE_RE =
  /\\(input|include|subfile|subfileinclude|import|subimport|inputfrom|subinputfrom)\s*\{([^}]*)\}(?:\s*\{([^}]*)\})?/g;
const LABEL_RE = /\\label\s*\{([^}]*)\}/g;
const TEX_EXT_RE = /\.(tex|ltx)$/i;

/** Normalize a project-relative path: forward slashes, no `.`/`..` segments. */
export function normalizeTexPath(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function dirOf(relativePath: string): string {
  const normalized = normalizeTexPath(relativePath);
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? "" : normalized.slice(0, idx);
}

function joinTexPath(dir: string, path: string): string {
  return normalizeTexPath(dir ? `${dir}/${path}` : path);
}

/** Strip unescaped `%` comments so commented-out includes are ignored. */
function stripComments(content: string): string {
  return content.replace(/(^|[^\\])%.*$/gm, "$1");
}

export function isTexRootContent(content: string | undefined): boolean {
  return !!content && DOCUMENTCLASS_RE.test(content);
}

function candidatePaths(target: string, baseDirs: string[]): string[] {
  const trimmed = target.trim();
  if (!trimmed) return [];
  const variants = TEX_EXT_RE.test(trimmed)
    ? [trimmed]
    : [`${trimmed}.tex`, trimmed];
  const out: string[] = [];
  for (const dir of baseDirs) {
    for (const variant of variants) out.push(joinTexPath(dir, variant));
  }
  return out;
}

/**
 * Return the ids of project files that `file` includes via `\input`,
 * `\include`, `\subfile`, `\import`, etc. Targets are resolved the way TeX
 * does: relative to the project root (the compile cwd) and, as a fallback,
 * relative to the including file's directory.
 */
export function extractIncludedFileIds(
  file: ProjectFile,
  byPath: Map<string, ProjectFile>,
): string[] {
  if (!file.content) return [];
  const includerDir = dirOf(file.relativePath);
  const text = stripComments(file.content);
  const found: string[] = [];
  for (const match of text.matchAll(INCLUDE_RE)) {
    const cmd = match[1];
    let target: string;
    let baseDirs: string[];
    if (
      cmd === "import" ||
      cmd === "subimport" ||
      cmd === "inputfrom" ||
      cmd === "subinputfrom"
    ) {
      if (match[3] === undefined) continue;
      const dir = match[2].trim();
      target = match[3];
      baseDirs = cmd.startsWith("sub")
        ? [joinTexPath(includerDir, dir)]
        : [normalizeTexPath(dir), joinTexPath(includerDir, dir)];
    } else {
      target = match[2];
      baseDirs = ["", includerDir];
    }
    for (const candidate of candidatePaths(target, baseDirs)) {
      const resolved = byPath.get(candidate);
      if (resolved) {
        if (!found.includes(resolved.id)) found.push(resolved.id);
        break;
      }
    }
  }
  return found;
}

/**
 * Find root documents (files containing `\documentclass`) that include
 * `fileId`, directly or transitively.
 */
export function findIncludingRoots(
  fileId: string,
  files: ProjectFile[],
): ProjectFile[] {
  const texFiles = files.filter((f) => f.type === "tex");
  const byPath = new Map(
    texFiles.map((f) => [normalizeTexPath(f.relativePath), f] as const),
  );
  const byId = new Map(texFiles.map((f) => [f.id, f] as const));
  const includeCache = new Map<string, string[]>();
  const includesOf = (f: ProjectFile): string[] => {
    let ids = includeCache.get(f.id);
    if (!ids) {
      ids = extractIncludedFileIds(f, byPath);
      includeCache.set(f.id, ids);
    }
    return ids;
  };
  const reaches = (root: ProjectFile): boolean => {
    const seen = new Set<string>([root.id]);
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const id of includesOf(current)) {
        if (id === fileId) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        const next = byId.get(id);
        if (next) stack.push(next);
      }
    }
    return false;
  };
  return texFiles.filter(
    (f) => f.id !== fileId && isTexRootContent(f.content) && reaches(f),
  );
}

function preferWellKnown(candidates: ProjectFile[]): ProjectFile | undefined {
  return (
    candidates.find(
      (f) => f.name === "main.tex" || f.name === "document.tex",
    ) ?? candidates[0]
  );
}

/**
 * Resolve the root .tex file for compilation.
 *
 * Priority order:
 * 1. `% !TEX root = <file>` magic comment in the first 20 lines of the file
 *    (resolved relative to the file's directory, then the project root)
 * 2. The file itself, if it contains `\documentclass`
 * 3. A `\documentclass` file that `\input`s / `\include`s this file
 * 4. `main.tex` or `document.tex` that contains `\documentclass`
 * 5. Any other .tex file in the project that contains `\documentclass`
 * 6. Fallback: the file itself
 */
export function resolveTexRoot(fileId: string, files: ProjectFile[]): string {
  // The store replaces the `files` array on every change, so a per-array memo
  // is invalidated exactly when the answer might change. This keeps the
  // include-graph walk off the hot render path of the PDF preview.
  let memo = rootMemo.get(files);
  if (!memo) {
    memo = new Map();
    rootMemo.set(files, memo);
  }
  const cached = memo.get(fileId);
  if (cached !== undefined) return cached;
  const resolved = resolveTexRootUncached(fileId, files);
  memo.set(fileId, resolved);
  return resolved;
}

const rootMemo = new WeakMap<ProjectFile[], Map<string, string>>();

function resolveTexRootUncached(fileId: string, files: ProjectFile[]): string {
  const file = files.find((f) => f.id === fileId);
  if (!file || file.type !== "tex") return fileId;
  const content = file.content ?? "";

  // 1. Check for % !TEX root magic comment
  for (const line of content.split("\n").slice(0, 20)) {
    const match = line.match(MAGIC_ROOT_RE);
    if (!match) continue;
    const rootPath = match[1].trim();
    const byPath = new Map(
      files.map((f) => [normalizeTexPath(f.relativePath), f] as const),
    );
    const candidates = [
      joinTexPath(dirOf(file.relativePath), rootPath),
      normalizeTexPath(rootPath),
    ];
    for (const candidate of candidates) {
      const target = byPath.get(candidate);
      if (target) return target.id;
    }
    const baseName = normalizeTexPath(rootPath).split("/").pop();
    const byName = files.find((f) => f.name === baseName);
    if (byName) return byName.id;
  }

  // 2. If the current file contains \documentclass, it is a root file
  if (isTexRootContent(content)) return fileId;

  // 3. A root document that includes this file
  const includers = findIncludingRoots(fileId, files);
  if (includers.length > 0) return preferWellKnown(includers)!.id;

  // 4. Look for main.tex or document.tex with \documentclass
  const wellKnown = files.find(
    (f) =>
      (f.name === "main.tex" || f.name === "document.tex") &&
      f.type === "tex" &&
      isTexRootContent(f.content),
  );
  if (wellKnown) return wellKnown.id;

  // 5. Any .tex file with \documentclass
  const anyRoot = files.find(
    (f) => f.type === "tex" && f.id !== fileId && isTexRootContent(f.content),
  );
  if (anyRoot) return anyRoot.id;

  // 6. Fallback: the file itself
  return fileId;
}

/** Collect every `\label{...}` defined in project .tex files other than `excludeId`. */
export function collectProjectLabels(
  files: ProjectFile[],
  excludeId?: string,
): Set<string> {
  const labels = new Set<string>();
  for (const f of files) {
    if (f.type !== "tex" || f.id === excludeId || !f.content) continue;
    for (const match of f.content.matchAll(LABEL_RE)) {
      labels.add(match[1].trim());
    }
  }
  return labels;
}
