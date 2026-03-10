import {
  readTextFile,
  writeTextFile,
  readDir,
  exists,
  mkdir,
  readFile,
  copyFile,
  remove,
  rename,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";

export type ProjectFileType = "tex" | "image" | "pdf" | "bib" | "style" | "other";

export interface FsProjectFile {
  relativePath: string;
  absolutePath: string;
  type: ProjectFileType;
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".bmp",
  ".webp",
]);

const STYLE_EXTENSIONS = new Set([
  ".sty",
  ".cls",
  ".bst",
  ".def",
  ".cfg",
  ".fd",
  ".dtx",
  ".ins",
]);

const IGNORED_EXTENSIONS = new Set([
  ".aux",
  ".log",
  ".out",
  ".toc",
  ".lof",
  ".lot",
  ".fls",
  ".fdb_latexmk",
  ".synctex.gz",
  ".synctex",
  ".blg",
  ".bbl",
  ".nav",
  ".snm",
  ".vrb",
  ".run.xml",
  ".bcf",
]);

function getFileType(name: string): ProjectFileType | null {
  const lower = name.toLowerCase();
  // Skip LaTeX build artifacts
  for (const ext of IGNORED_EXTENSIONS) {
    if (lower.endsWith(ext)) return null;
  }
  if (lower.endsWith(".tex") || lower.endsWith(".ltx")) return "tex";
  if (lower.endsWith(".bib")) return "bib";
  if (lower.endsWith(".pdf")) return "pdf";
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return "image";
  }
  for (const ext of STYLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return "style";
  }
  // Show all other files (txt, md, sty downloaded packages, etc.)
  return "other";
}

export interface ScanResult {
  files: FsProjectFile[];
  folders: string[]; // relative paths of all directories
}

export async function scanProjectFolder(
  rootPath: string,
): Promise<ScanResult> {
  const files: FsProjectFile[] = [];
  const folders: string[] = [];

  async function walk(dir: string, prefix: string) {
    const entries = await readDir(dir);
    for (const entry of entries) {
      const entryPath = await join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory) {
        // Skip hidden directories and common non-project dirs
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }
        folders.push(relativePath);
        await walk(entryPath, relativePath);
      } else {
        const type = getFileType(entry.name);
        if (type) {
          files.push({
            relativePath,
            absolutePath: entryPath,
            type,
          });
        }
      }
    }
  }

  await walk(rootPath, "");
  return { files, folders };
}

export async function readTexFileContent(
  absolutePath: string,
): Promise<string> {
  return readTextFile(absolutePath);
}

export async function writeTexFileContent(
  absolutePath: string,
  content: string,
): Promise<void> {
  return writeTextFile(absolutePath, content);
}

export async function readImageAsDataUrl(
  absolutePath: string,
): Promise<string> {
  const data = await readFile(absolutePath);
  const ext = absolutePath.split(".").pop()?.toLowerCase() || "png";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    webp: "image/webp",
  };
  const mime = mimeMap[ext] || "image/png";

  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
}

export function getAssetUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath);
}

export async function createFileOnDisk(
  rootPath: string,
  name: string,
  content: string,
): Promise<string> {
  const fullPath = await join(rootPath, name);
  // Ensure parent directory exists
  const lastSep = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"));
  const parentDir = lastSep > 0 ? fullPath.substring(0, lastSep) : "";
  if (parentDir && !(await exists(parentDir))) {
    await mkdir(parentDir, { recursive: true });
  }
  await writeTextFile(fullPath, content);
  return fullPath;
}

/**
 * Generate a unique filename by appending (1), (2), etc. if the target already exists.
 * Returns the deduplicated relative path (e.g., "attachments/paper (1).pdf").
 */
export async function getUniqueTargetName(
  rootPath: string,
  targetName: string,
): Promise<string> {
  const fullPath = await join(rootPath, targetName);
  if (!(await exists(fullPath))) return targetName;

  // Split into base and extension: "attachments/paper.pdf" → ["attachments/paper", ".pdf"]
  const dotIndex = targetName.lastIndexOf(".");
  const slashIndex = targetName.lastIndexOf("/");
  const hasExt = dotIndex > slashIndex + 1;
  const baseName = hasExt ? targetName.slice(0, dotIndex) : targetName;
  const ext = hasExt ? targetName.slice(dotIndex) : "";

  for (let i = 1; i < 100; i++) {
    const candidate = `${baseName} (${i})${ext}`;
    const candidatePath = await join(rootPath, candidate);
    if (!(await exists(candidatePath))) return candidate;
  }
  // Fallback — should never reach here
  return `${baseName} (${Date.now()})${ext}`;
}

export async function copyFileToProject(
  rootPath: string,
  sourcePath: string,
  targetName: string,
): Promise<string> {
  // Auto-deduplicate filename
  const uniqueName = await getUniqueTargetName(rootPath, targetName);
  const fullPath = await join(rootPath, uniqueName);
  // Ensure parent directory exists (e.g., attachments/)
  const lastSlash = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"));
  if (lastSlash > 0) {
    const parentDir = fullPath.substring(0, lastSlash);
    if (!(await exists(parentDir))) {
      await mkdir(parentDir, { recursive: true });
    }
  }
  await copyFile(sourcePath, fullPath);
  return uniqueName;
}

export async function deleteFileFromDisk(absolutePath: string): Promise<void> {
  await remove(absolutePath);
}

export async function deleteFolderFromDisk(absolutePath: string): Promise<void> {
  await remove(absolutePath, { recursive: true });
}

export async function renameFileOnDisk(
  oldPath: string,
  newPath: string,
): Promise<void> {
  await rename(oldPath, newPath);
}

export async function createDirectory(absolutePath: string): Promise<void> {
  await mkdir(absolutePath, { recursive: true });
}

export { exists, join };
