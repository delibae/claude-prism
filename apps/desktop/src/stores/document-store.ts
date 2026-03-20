import { create } from "zustand";
import {
  scanProjectFolder,
  readTexFileContent,
  writeTexFileContent,
  readImageAsDataUrl,
  createFileOnDisk,
  copyFileToProject,
  deleteFileFromDisk,
  deleteFolderFromDisk,
  renameFileOnDisk,
  getUniqueTargetName,
  createDirectory,
  join,
  LARGE_FILE_THRESHOLD,
  type ProjectFileType,
} from "@/lib/tauri/fs";
import { useHistoryStore } from "@/stores/history-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { clearDocCache } from "@/lib/mupdf/pdf-doc-cache";
import { clearScrollPositionCache } from "@/components/workspace/preview/pdf-viewer";
import { clearZoomCache } from "@/components/workspace/preview/pdf-preview";
import { clearEditorStateCache } from "@/components/workspace/editor/latex-editor";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("document");

export interface ProjectFile {
  id: string; // relativePath is the id
  name: string;
  relativePath: string;
  absolutePath: string;
  type: ProjectFileType;
  content?: string;
  dataUrl?: string;
  isDirty: boolean;
  /** File size in bytes (from stat). Used to skip auto-loading large files. */
  fileSize?: number;
}

// ── PDF bytes cache (kept outside Zustand to avoid React diffing large buffers) ──
// Keyed by rootFileId. Consumers read via getPdfBytes() / getCurrentPdfBytes().
// Bounded LRU cache: evicts oldest entries when size or count limits are exceeded.
const _pdfBytesCache = new Map<string, Uint8Array>();
/** Insertion-order tracking for LRU eviction. Most-recently-used at end. */
const _pdfLruOrder: string[] = [];
/** Total bytes currently stored in cache. */
let _pdfCacheTotalBytes = 0;
/** Max total bytes in cache (128 MB). */
const MAX_PDF_CACHE_BYTES = 128 * 1024 * 1024;
/** Max number of cached PDFs. */
const MAX_PDF_CACHE_ENTRIES = 20;

/** Current active PDF root file id (mirrors what Zustand tracks via pdfRevision). */
let _currentPdfRootId: string | null = null;

/** Evict oldest entries until cache is within limits.
 *  Never evicts `protectKey` — used to prevent evicting a just-inserted entry. */
function _evictPdfCache(protectKey?: string) {
  while (
    _pdfLruOrder.length > MAX_PDF_CACHE_ENTRIES ||
    _pdfCacheTotalBytes > MAX_PDF_CACHE_BYTES
  ) {
    // Find the oldest entry that isn't the protected key
    const evictIdx = protectKey
      ? _pdfLruOrder.findIndex((k) => k !== protectKey)
      : 0;
    if (evictIdx === -1 || evictIdx >= _pdfLruOrder.length) break;
    const oldest = _pdfLruOrder.splice(evictIdx, 1)[0];
    const bytes = _pdfBytesCache.get(oldest);
    if (bytes) {
      _pdfCacheTotalBytes -= bytes.byteLength;
      _pdfBytesCache.delete(oldest);
    }
    if (_currentPdfRootId === oldest) _currentPdfRootId = null;
  }
}

/** Touch a key to mark it as most-recently-used. */
function _touchPdfLru(key: string) {
  const idx = _pdfLruOrder.indexOf(key);
  if (idx !== -1) _pdfLruOrder.splice(idx, 1);
  _pdfLruOrder.push(key);
}

/** Get PDF bytes for a specific root file id. */
export function getPdfBytes(rootFileId: string): Uint8Array | undefined {
  const data = _pdfBytesCache.get(rootFileId);
  if (data) _touchPdfLru(rootFileId);
  return data;
}

/** Get the current active PDF bytes (convenience for components that don't know the rootId). */
export function getCurrentPdfBytes(): Uint8Array | null {
  if (!_currentPdfRootId) return null;
  const data = _pdfBytesCache.get(_currentPdfRootId) ?? null;
  if (data) _touchPdfLru(_currentPdfRootId);
  return data;
}

/** Check if any PDF data exists for the current root. */
export function hasPdfData(): boolean {
  return _currentPdfRootId != null && _pdfBytesCache.has(_currentPdfRootId);
}

export function clearPdfBytesCache() {
  _pdfBytesCache.clear();
  _pdfLruOrder.length = 0;
  _pdfCacheTotalBytes = 0;
  _currentPdfRootId = null;
}

interface DocumentState {
  projectRoot: string | null;
  files: ProjectFile[];
  folders: string[];
  activeFileId: string;
  cursorPosition: number;
  selectionRange: { start: number; end: number } | null;
  jumpToPosition: number | null;
  isThreadOpen: boolean;
  /** Bumped whenever PDF bytes change — triggers re-render without storing bytes in state. */
  pdfRevision: number;
  compileError: string | null;
  isCompiling: boolean;
  /** When true, a recompile will be triggered after the current compile finishes. */
  pendingRecompile: boolean;
  isSaving: boolean;
  initialized: boolean;
  /** Incremented on every file content change; used to skip no-op recompiles. */
  contentGeneration: number;
  /** Per-root-file cache: rootFileId → compile error message. */
  compileErrorCache: Map<string, string>;
  /** Per-root-file: rootFileId → contentGeneration at last successful compile. */
  lastCompiledGenerations: Map<string, number>;

  openProject: (rootPath: string) => Promise<void>;
  closeProject: () => void;
  setActiveFile: (id: string) => void;
  addFile: (file: Omit<ProjectFile, "id" | "isDirty">) => string;
  deleteFile: (id: string) => void;
  deleteFolder: (folderPath: string) => Promise<void>;
  renameFile: (id: string, name: string) => void;
  updateFileContent: (id: string, content: string) => void;
  updateImageDataUrl: (id: string, dataUrl: string) => void;
  setCursorPosition: (position: number) => void;
  setSelectionRange: (range: { start: number; end: number } | null) => void;
  requestJumpToPosition: (position: number) => void;
  clearJumpRequest: () => void;
  setThreadOpen: (open: boolean) => void;
  setPdfData: (data: Uint8Array | null, rootFileId?: string) => void;
  setCompileError: (error: string | null, rootFileId?: string) => void;
  setIsCompiling: (isCompiling: boolean) => void;
  setPendingRecompile: (pending: boolean) => void;
  setIsSaving: (isSaving: boolean) => void;
  insertAtCursor: (text: string) => void;
  replaceSelection: (start: number, end: number, text: string) => void;
  findAndReplace: (find: string, replace: string) => boolean;
  setInitialized: () => void;
  saveFile: (id: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  saveCurrentFile: () => Promise<void>;
  createNewFile: (
    name: string,
    type: "tex" | "image",
    folder?: string,
  ) => Promise<void>;
  createFolder: (name: string, parentFolder?: string) => Promise<void>;
  importFiles: (
    sourcePaths: string[],
    targetFolder?: string,
  ) => Promise<string[]>;
  moveFile: (fileId: string, targetFolder: string | null) => Promise<void>;
  moveFolder: (
    folderPath: string,
    targetFolder: string | null,
  ) => Promise<void>;
  reloadFile: (relativePath: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  /** Load content for a file that was skipped during project open (large file). */
  loadFileContent: (id: string) => Promise<void>;

  get fileName(): string;
  get content(): string;
  setFileName: (name: string) => void;
  setContent: (content: string) => void;
}

function getActiveFile(state: { files: ProjectFile[]; activeFileId: string }) {
  return state.files.find((f) => f.id === state.activeFileId);
}

/**
 * Resolve the root .tex file for compilation.
 * Parses `% !TEX root = <file>` magic comment from the first 20 lines.
 * Returns the root file's ID (relativePath), or the input fileId if no root is specified.
 */
export function resolveTexRoot(fileId: string, files: ProjectFile[]): string {
  const file = files.find((f) => f.id === fileId);
  if (!file || file.type !== "tex" || !file.content) return fileId;

  const lines = file.content.split("\n").slice(0, 20);
  for (const line of lines) {
    const match = line.match(/^%\s*!TEX\s+root\s*=\s*(.+)/i);
    if (match) {
      const rootPath = match[1].trim();
      // Try matching by relative path first, then by filename
      const target =
        files.find((f) => f.relativePath === rootPath) ??
        files.find((f) => f.name === rootPath);
      if (target) return target.id;
    }
  }
  return fileId;
}

/** Re-key the external PDF bytes cache when a file is renamed/moved. */
function migratePdfBytesKey(oldKey: string, newKey: string) {
  if (!_pdfBytesCache.has(oldKey)) return;
  const bytes = _pdfBytesCache.get(oldKey)!;
  _pdfBytesCache.delete(oldKey);
  _pdfBytesCache.set(newKey, bytes);
  // Update LRU order
  const idx = _pdfLruOrder.indexOf(oldKey);
  if (idx !== -1) _pdfLruOrder[idx] = newKey;
  if (_currentPdfRootId === oldKey) _currentPdfRootId = newKey;
}

/** Re-key a Map entry when a file is renamed/moved. */
function migrateCacheKey<V>(
  map: Map<string, V>,
  oldKey: string,
  newKey: string,
): Map<string, V> {
  if (!map.has(oldKey)) return map;
  const copy = new Map(map);
  const val = copy.get(oldKey)!;
  copy.delete(oldKey);
  copy.set(newKey, val);
  return copy;
}

// Auto-save: debounced save 2 seconds after last content change
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
// Store reference set after creation to avoid TDZ issues
let storeRef: typeof useDocumentStore | null = null;

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    const store = storeRef;
    if (!store) return;
    const state = store.getState();
    const dirtyFiles = state.files.filter(
      (f) => f.isDirty && f.content != null,
    );
    if (dirtyFiles.length > 0) {
      await state.saveAllFiles();
    }
  }, 2000);
}

export const useDocumentStore = create<DocumentState>()((set, get) => ({
  projectRoot: null,
  files: [],
  folders: [],
  activeFileId: "",
  cursorPosition: 0,
  selectionRange: null,
  jumpToPosition: null,
  isThreadOpen: false,
  pdfRevision: 0,
  compileError: null,
  isCompiling: false,
  pendingRecompile: false,
  isSaving: false,
  initialized: false,
  contentGeneration: 0,
  compileErrorCache: new Map(),
  lastCompiledGenerations: new Map(),

  openProject: async (rootPath: string) => {
    log.info(`Opening project: ${rootPath}`);
    const { files: fsFiles, folders: fsFolders } =
      await scanProjectFolder(rootPath);
    const projectFiles: ProjectFile[] = [];

    for (const f of fsFiles) {
      const pf: ProjectFile = {
        id: f.relativePath,
        name: f.relativePath.split("/").pop() || f.relativePath,
        relativePath: f.relativePath,
        absolutePath: f.absolutePath,
        type: f.type,
        isDirty: false,
        fileSize: f.fileSize,
      };

      // Load content for text-based files (skip large non-essential files)
      if (
        f.type === "tex" ||
        f.type === "bib" ||
        f.type === "style" ||
        f.type === "other"
      ) {
        const isLargeNonEssential =
          f.type === "other" && f.fileSize > LARGE_FILE_THRESHOLD;
        if (!isLargeNonEssential) {
          try {
            pf.content = await readTexFileContent(f.absolutePath);
          } catch {
            pf.content = "";
          }
        }
        // Large "other" files: content stays undefined, loaded on-demand via loadFileContent
      }

      // Load dataUrl for image files (skip very large images)
      if (f.type === "image") {
        if (f.fileSize <= LARGE_FILE_THRESHOLD) {
          try {
            pf.dataUrl = await readImageAsDataUrl(f.absolutePath);
          } catch {
            // Image loading failed, that's ok
          }
        }
      }

      // PDF files are loaded on-demand via readFile in InlinePdfContent

      projectFiles.push(pf);
    }

    // Find the main tex file
    const mainTex =
      projectFiles.find(
        (f) => f.name === "main.tex" || f.name === "document.tex",
      ) || projectFiles.find((f) => f.type === "tex");

    clearPdfBytesCache();
    set({
      projectRoot: rootPath,
      files: projectFiles,
      folders: fsFolders,
      activeFileId: mainTex?.id || projectFiles[0]?.id || "",
      pdfRevision: 0,
      compileError: null,
      compileErrorCache: new Map(),
      lastCompiledGenerations: new Map(),
      initialized: true,
      cursorPosition: 0,
      selectionRange: null,
    });

    // Initialize history system early so snapshots work before the panel is opened
    const historyStore = useHistoryStore.getState();
    historyStore
      .init(rootPath)
      .then(() => historyStore.loadSnapshots(rootPath))
      .catch((err) => {
        log.error("Failed to initialize history", { error: String(err) });
      });
  },

  closeProject: () => {
    log.info("Closing project");
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    clearDocCache();
    clearScrollPositionCache();
    clearZoomCache();
    clearEditorStateCache();
    clearPdfBytesCache();
    set({
      projectRoot: null,
      files: [],
      folders: [],
      activeFileId: "",
      pdfRevision: 0,
      compileError: null,
      compileErrorCache: new Map(),
      lastCompiledGenerations: new Map(),
      initialized: false,
    });
    // Reset chat session so stale messages don't leak into the next project
    useClaudeChatStore.getState().newSession();
  },

  setActiveFile: (id) => {
    const state = get();
    const rootId = resolveTexRoot(id, state.files);
    const newPdfRootId = _pdfBytesCache.has(rootId) ? rootId : null;
    const pdfRootChanged = newPdfRootId !== _currentPdfRootId;
    _currentPdfRootId = newPdfRootId;
    const cachedError = state.compileErrorCache.get(rootId) ?? null;
    set((s) => ({
      activeFileId: id,
      selectionRange: null,
      ...(pdfRootChanged ? { pdfRevision: s.pdfRevision + 1 } : {}),
      compileError: cachedError,
    }));
  },

  setSelectionRange: (range) => set({ selectionRange: range }),

  requestJumpToPosition: (position) => set({ jumpToPosition: position }),

  clearJumpRequest: () => set({ jumpToPosition: null }),

  addFile: (file) => {
    const id = file.relativePath;
    set((state) => ({
      files: [...state.files, { ...file, id, isDirty: false }],
      activeFileId: id,
    }));
    return id;
  },

  deleteFile: async (id) => {
    const state = get();
    if (state.files.length <= 1) return;
    const file = state.files.find((f) => f.id === id);
    if (file) {
      try {
        await deleteFileFromDisk(file.absolutePath);
      } catch (e) {
        log.error("Failed to delete file from disk", { error: String(e) });
      }
    }
    const newFiles = state.files.filter((f) => f.id !== id);
    const newActiveId =
      state.activeFileId === id ? newFiles[0].id : state.activeFileId;
    const compileErrorCache = new Map(state.compileErrorCache);
    const lastCompiledGenerations = new Map(state.lastCompiledGenerations);
    const deletedPdf = _pdfBytesCache.get(id);
    if (deletedPdf) _pdfCacheTotalBytes -= deletedPdf.byteLength;
    _pdfBytesCache.delete(id);
    const lruIdx = _pdfLruOrder.indexOf(id);
    if (lruIdx !== -1) _pdfLruOrder.splice(lruIdx, 1);
    compileErrorCache.delete(id);
    lastCompiledGenerations.delete(id);
    // If the deleted file was active, show the new active file's cached PDF
    const switchingActive = state.activeFileId === id;
    const newRootId = switchingActive
      ? resolveTexRoot(newActiveId, newFiles)
      : undefined;
    if (switchingActive && newRootId) {
      _currentPdfRootId = _pdfBytesCache.has(newRootId) ? newRootId : null;
    }
    set((s) => ({
      files: newFiles,
      activeFileId: newActiveId,
      compileErrorCache,
      lastCompiledGenerations,
      ...(switchingActive ? { pdfRevision: s.pdfRevision + 1 } : {}),
      ...(switchingActive && newRootId
        ? {
            compileError: compileErrorCache.get(newRootId) ?? null,
          }
        : {}),
    }));
  },

  deleteFolder: async (folderPath) => {
    const state = get();
    if (!state.projectRoot) return;
    const prefix = `${folderPath}/`;
    const filesToRemove = state.files.filter((f) =>
      f.relativePath.startsWith(prefix),
    );
    const remainingFiles = state.files.filter(
      (f) => !f.relativePath.startsWith(prefix),
    );
    // Must keep at least one file
    if (remainingFiles.length === 0) return;

    // Delete folder from disk (recursive)
    try {
      const absPath = await join(state.projectRoot, folderPath);
      await deleteFolderFromDisk(absPath);
    } catch (e) {
      log.error("Failed to delete folder from disk", { error: String(e) });
    }

    // Clean caches
    const compileErrorCache = new Map(state.compileErrorCache);
    const lastCompiledGenerations = new Map(state.lastCompiledGenerations);
    for (const f of filesToRemove) {
      const deletedPdf = _pdfBytesCache.get(f.id);
      if (deletedPdf) _pdfCacheTotalBytes -= deletedPdf.byteLength;
      _pdfBytesCache.delete(f.id);
      const lruIdx = _pdfLruOrder.indexOf(f.id);
      if (lruIdx !== -1) _pdfLruOrder.splice(lruIdx, 1);
      compileErrorCache.delete(f.id);
      lastCompiledGenerations.delete(f.id);
    }

    const removedIds = new Set(filesToRemove.map((f) => f.id));
    const newActiveId = removedIds.has(state.activeFileId)
      ? remainingFiles[0].id
      : state.activeFileId;
    const switchingActive = newActiveId !== state.activeFileId;
    const newRootId = switchingActive
      ? resolveTexRoot(newActiveId, remainingFiles)
      : undefined;
    if (switchingActive && newRootId) {
      _currentPdfRootId = _pdfBytesCache.has(newRootId) ? newRootId : null;
    }

    // Remove folder from folders list
    const newFolders = state.folders.filter(
      (f) => f !== folderPath && !f.startsWith(prefix),
    ); // include exact match since folders list contains folder paths directly

    set((s) => ({
      files: remainingFiles,
      folders: newFolders,
      activeFileId: newActiveId,
      compileErrorCache,
      lastCompiledGenerations,
      ...(switchingActive ? { pdfRevision: s.pdfRevision + 1 } : {}),
      ...(switchingActive && newRootId
        ? {
            compileError: compileErrorCache.get(newRootId) ?? null,
          }
        : {}),
    }));
  },

  renameFile: async (id, name) => {
    const state = get();
    const file = state.files.find((f) => f.id === id);
    if (!file || !state.projectRoot) return;

    const dir = file.relativePath.includes("/")
      ? file.relativePath.substring(0, file.relativePath.lastIndexOf("/"))
      : "";
    const newRelativePath = dir ? `${dir}/${name}` : name;

    const newAbsPath = await join(state.projectRoot, newRelativePath);
    try {
      await renameFileOnDisk(file.absolutePath, newAbsPath);
    } catch (e) {
      log.error("Failed to rename file on disk", { error: String(e) });
      return;
    }
    migratePdfBytesKey(id, newRelativePath);
    set((s) => {
      const compileErrorCache = migrateCacheKey(
        s.compileErrorCache,
        id,
        newRelativePath,
      );
      const lastCompiledGenerations = migrateCacheKey(
        s.lastCompiledGenerations,
        id,
        newRelativePath,
      );
      const isActive = s.activeFileId === id;
      return {
        files: s.files.map((f) =>
          f.id === id
            ? {
                ...f,
                name,
                relativePath: newRelativePath,
                absolutePath: newAbsPath,
                id: newRelativePath,
              }
            : f,
        ),
        activeFileId: isActive ? newRelativePath : s.activeFileId,
        compileErrorCache,
        lastCompiledGenerations,
      };
    });
  },

  updateFileContent: (id, content) => {
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, content, isDirty: true } : f,
      ),
      contentGeneration: state.contentGeneration + 1,
    }));
    scheduleAutoSave();
  },

  updateImageDataUrl: (id, dataUrl) => {
    set((state) => ({
      files: state.files.map((f) => (f.id === id ? { ...f, dataUrl } : f)),
    }));
  },

  setThreadOpen: (open) => set({ isThreadOpen: open }),

  setPdfData: (data, rootFileId?) => {
    if (data) {
      const key = rootFileId ?? "__default__";
      // Update cache size tracking
      const existing = _pdfBytesCache.get(key);
      if (existing) _pdfCacheTotalBytes -= existing.byteLength;
      _pdfBytesCache.set(key, data);
      _pdfCacheTotalBytes += data.byteLength;
      _touchPdfLru(key);
      _evictPdfCache(key);
      _currentPdfRootId = key;
    } else if (rootFileId) {
      const existing = _pdfBytesCache.get(rootFileId);
      if (existing) _pdfCacheTotalBytes -= existing.byteLength;
      _pdfBytesCache.delete(rootFileId);
      const idx = _pdfLruOrder.indexOf(rootFileId);
      if (idx !== -1) _pdfLruOrder.splice(idx, 1);
      if (_currentPdfRootId === rootFileId) _currentPdfRootId = null;
    } else {
      _currentPdfRootId = null;
    }
    if (rootFileId) {
      if (data) {
        const s = get();
        const compileErrorCache = new Map(s.compileErrorCache);
        const lastCompiledGenerations = new Map(s.lastCompiledGenerations);
        compileErrorCache.delete(rootFileId);
        lastCompiledGenerations.set(rootFileId, s.contentGeneration);
        set((prev) => ({
          pdfRevision: prev.pdfRevision + 1,
          compileError: null,
          compileErrorCache,
          lastCompiledGenerations,
        }));
      } else {
        set((prev) => ({
          pdfRevision: prev.pdfRevision + 1,
          compileError: null,
        }));
      }
    } else {
      set((prev) => ({
        pdfRevision: prev.pdfRevision + 1,
        compileError: null,
      }));
    }
  },

  setCompileError: (error, rootFileId?) => {
    if (rootFileId) {
      const compileErrorCache = new Map(get().compileErrorCache);
      if (error) {
        compileErrorCache.set(rootFileId, error);
      } else {
        compileErrorCache.delete(rootFileId);
      }
      set({ compileError: error, compileErrorCache });
    } else {
      set({ compileError: error });
    }
  },

  setIsCompiling: (isCompiling) => set({ isCompiling }),
  setPendingRecompile: (pending) => set({ pendingRecompile: pending }),

  setIsSaving: (isSaving) => set({ isSaving }),

  setCursorPosition: (position) => set({ cursorPosition: position }),

  insertAtCursor: (text) => {
    const state = get();
    const activeFile = getActiveFile(state);
    if (!activeFile || activeFile.type === "image" || activeFile.type === "pdf")
      return;

    const content = activeFile.content ?? "";
    const { cursorPosition } = state;
    const newContent =
      content.slice(0, cursorPosition) + text + content.slice(cursorPosition);

    set({
      files: state.files.map((f) =>
        f.id === activeFile.id
          ? { ...f, content: newContent, isDirty: true }
          : f,
      ),
      cursorPosition: cursorPosition + text.length,
    });
  },

  replaceSelection: (start, end, text) => {
    const state = get();
    const activeFile = getActiveFile(state);
    if (!activeFile || activeFile.type === "image" || activeFile.type === "pdf")
      return;

    const content = activeFile.content ?? "";
    const newContent = content.slice(0, start) + text + content.slice(end);

    set({
      files: state.files.map((f) =>
        f.id === activeFile.id
          ? { ...f, content: newContent, isDirty: true }
          : f,
      ),
      cursorPosition: start + text.length,
    });
  },

  findAndReplace: (find, replace) => {
    const state = get();
    const activeFile = getActiveFile(state);
    if (!activeFile || activeFile.type === "image" || activeFile.type === "pdf")
      return false;

    const content = activeFile.content ?? "";
    if (!content.includes(find)) return false;

    const newContent = content.replace(find, replace);
    set({
      files: state.files.map((f) =>
        f.id === activeFile.id
          ? { ...f, content: newContent, isDirty: true }
          : f,
      ),
    });
    return true;
  },

  setInitialized: () => set({ initialized: true }),

  saveFile: async (id) => {
    const state = get();
    const file = state.files.find((f) => f.id === id);
    if (!file || !file.isDirty || file.content == null) return;

    await writeTexFileContent(file.absolutePath, file.content);
    set((s) => ({
      files: s.files.map((f) => (f.id === id ? { ...f, isDirty: false } : f)),
    }));
  },

  saveAllFiles: async () => {
    const state = get();
    const dirtyFiles = state.files.filter(
      (f) => f.isDirty && f.content != null,
    );
    const results = await Promise.allSettled(
      dirtyFiles.map((f) => writeTexFileContent(f.absolutePath, f.content!)),
    );
    // Only mark successfully saved files as clean
    const savedIds = new Set<string>();
    results.forEach((r, i) => {
      if (r.status === "fulfilled") savedIds.add(dirtyFiles[i].id);
    });
    if (savedIds.size > 0) {
      set((s) => ({
        files: s.files.map((f) =>
          savedIds.has(f.id) ? { ...f, isDirty: false } : f,
        ),
      }));
    }
  },

  saveCurrentFile: async () => {
    const state = get();
    await state.saveFile(state.activeFileId);
    // Manual save → immediate snapshot
    if (state.projectRoot) {
      try {
        await useHistoryStore
          .getState()
          .createSnapshot(state.projectRoot, "[manual] Save");
      } catch {
        // Snapshot failure should not break save
      }
    }
  },

  createNewFile: async (name, type, folder) => {
    const state = get();
    if (!state.projectRoot) return;

    const relativePath = folder ? `${folder}/${name}` : name;
    const isTexFile = name.endsWith(".tex") || name.endsWith(".ltx");
    const content = isTexFile
      ? `\\documentclass{article}\n\n\\begin{document}\n\n% Your content here\n\n\\end{document}\n`
      : "";

    const fullPath = await createFileOnDisk(
      state.projectRoot,
      relativePath,
      content,
    );

    set((s) => ({
      files: [
        ...s.files,
        {
          id: relativePath,
          name,
          relativePath,
          absolutePath: fullPath,
          type,
          content: type !== "image" ? content : undefined,
          isDirty: false,
        },
      ],
      activeFileId: relativePath,
    }));
  },

  createFolder: async (name, parentFolder) => {
    const state = get();
    if (!state.projectRoot) return;

    const relativePath = parentFolder ? `${parentFolder}/${name}` : name;
    const absolutePath = await join(state.projectRoot, relativePath);
    await createDirectory(absolutePath);
    set((s) => ({
      folders: [...s.folders, relativePath],
    }));
  },

  importFiles: async (sourcePaths, targetFolder) => {
    const state = get();
    if (!state.projectRoot) return [];

    const importedPaths: string[] = [];
    for (const sourcePath of sourcePaths) {
      // Handle both Unix (/) and Windows (\) path separators
      const fileName = sourcePath.split(/[/\\]/).pop() || sourcePath;
      const targetName = targetFolder
        ? `${targetFolder}/${fileName}`
        : fileName;
      // copyFileToProject returns the actual (possibly deduplicated) relative path
      const actualName = await copyFileToProject(
        state.projectRoot,
        sourcePath,
        targetName,
      );
      importedPaths.push(actualName);
    }
    await state.refreshFiles();
    return importedPaths;
  },

  moveFile: async (fileId, targetFolder) => {
    const state = get();
    const file = state.files.find((f) => f.id === fileId);
    if (!file || !state.projectRoot) return;

    const desiredPath = targetFolder
      ? `${targetFolder}/${file.name}`
      : file.name;
    if (desiredPath === file.relativePath) return;

    // Auto-deduplicate if a file with the same name exists in the target
    const newRelativePath = await getUniqueTargetName(
      state.projectRoot,
      desiredPath,
    );
    const newAbsPath = await join(state.projectRoot, newRelativePath);
    await renameFileOnDisk(file.absolutePath, newAbsPath);

    const newName = newRelativePath.split("/").pop() || file.name;
    migratePdfBytesKey(fileId, newRelativePath);
    set((s) => {
      const compileErrorCache = migrateCacheKey(
        s.compileErrorCache,
        fileId,
        newRelativePath,
      );
      const lastCompiledGenerations = migrateCacheKey(
        s.lastCompiledGenerations,
        fileId,
        newRelativePath,
      );
      return {
        files: s.files.map((f) =>
          f.id === fileId
            ? {
                ...f,
                name: newName,
                relativePath: newRelativePath,
                absolutePath: newAbsPath,
                id: newRelativePath,
              }
            : f,
        ),
        activeFileId:
          s.activeFileId === fileId ? newRelativePath : s.activeFileId,
        compileErrorCache,
        lastCompiledGenerations,
      };
    });
  },

  moveFolder: async (folderPath, targetFolder) => {
    const state = get();
    if (!state.projectRoot) return;

    const folderName = folderPath.split("/").pop()!;
    const newFolderPath = targetFolder
      ? `${targetFolder}/${folderName}`
      : folderName;
    if (newFolderPath === folderPath) return;
    // Prevent moving a folder into itself
    if (newFolderPath.startsWith(`${folderPath}/`)) return;

    const oldAbsPath = await join(state.projectRoot, folderPath);
    const newAbsPath = await join(state.projectRoot, newFolderPath);
    await renameFileOnDisk(oldAbsPath, newAbsPath);

    // Reload project to pick up all new paths
    await state.openProject(state.projectRoot);
  },

  reloadFile: async (relativePath) => {
    const state = get();
    const file = state.files.find((f) => f.relativePath === relativePath);
    if (!file) return;

    if (file.type === "tex" || file.type === "bib") {
      const content = await readTexFileContent(file.absolutePath);
      set((s) => ({
        files: s.files.map((f) =>
          f.id === file.id ? { ...f, content, isDirty: false } : f,
        ),
        contentGeneration: s.contentGeneration + 1,
      }));
    }
  },

  refreshFiles: async () => {
    const { projectRoot, files, activeFileId } = get();
    if (!projectRoot) return;

    const { files: fsFiles, folders: fsFolders } =
      await scanProjectFolder(projectRoot);
    const existingMap = new Map(files.map((f) => [f.relativePath, f]));
    const diskPaths = new Set(fsFiles.map((f) => f.relativePath));

    const merged: ProjectFile[] = [];

    for (const fsFile of fsFiles) {
      const existing = existingMap.get(fsFile.relativePath);

      if (existing) {
        // Existing file — reload content from disk unless the user has unsaved edits
        if (existing.isDirty) {
          merged.push(existing);
        } else {
          const updated = { ...existing, fileSize: fsFile.fileSize };
          if (
            updated.type === "tex" ||
            updated.type === "bib" ||
            updated.type === "style" ||
            updated.type === "other"
          ) {
            const isLargeNonEssential =
              updated.type === "other" &&
              fsFile.fileSize > LARGE_FILE_THRESHOLD;
            // Only reload if it was previously loaded (not a skipped large file)
            if (!isLargeNonEssential || updated.content !== undefined) {
              try {
                updated.content = await readTexFileContent(
                  updated.absolutePath,
                );
              } catch {
                /* keep previous content */
              }
            }
          }
          merged.push(updated);
        }
      } else {
        // New file on disk
        const pf: ProjectFile = {
          id: fsFile.relativePath,
          name: fsFile.relativePath.split("/").pop() || fsFile.relativePath,
          relativePath: fsFile.relativePath,
          absolutePath: fsFile.absolutePath,
          type: fsFile.type,
          isDirty: false,
          fileSize: fsFile.fileSize,
        };
        const isLargeNonEssential =
          pf.type === "other" && fsFile.fileSize > LARGE_FILE_THRESHOLD;
        if (
          pf.type === "tex" ||
          pf.type === "bib" ||
          pf.type === "style" ||
          (pf.type === "other" && !isLargeNonEssential)
        ) {
          try {
            pf.content = await readTexFileContent(pf.absolutePath);
          } catch {
            /* skip unreadable */
          }
        } else if (
          pf.type === "image" &&
          fsFile.fileSize <= LARGE_FILE_THRESHOLD
        ) {
          try {
            pf.dataUrl = await readImageAsDataUrl(pf.absolutePath);
          } catch {
            /* skip unreadable */
          }
        }
        // PDF files and large files are loaded on-demand
        merged.push(pf);
      }
    }

    // Keep dirty files that were deleted from disk (user hasn't saved yet)
    for (const f of files) {
      if (!diskPaths.has(f.relativePath) && f.isDirty) {
        merged.push(f);
      }
    }

    const newActiveId = merged.some((f) => f.id === activeFileId)
      ? activeFileId
      : (merged[0]?.id ?? "");

    set((s) => ({
      files: merged,
      folders: fsFolders,
      activeFileId: newActiveId,
      contentGeneration: s.contentGeneration + 1,
    }));
  },

  loadFileContent: async (id) => {
    const state = get();
    const file = state.files.find((f) => f.id === id);
    if (!file || file.content !== undefined) return; // already loaded
    try {
      const content = await readTexFileContent(file.absolutePath);
      set((s) => ({
        files: s.files.map((f) => (f.id === id ? { ...f, content } : f)),
      }));
    } catch {
      set((s) => ({
        files: s.files.map((f) => (f.id === id ? { ...f, content: "" } : f)),
      }));
    }
  },

  get fileName() {
    const activeFile = getActiveFile(get());
    return activeFile?.name ?? "main.tex";
  },

  get content() {
    const activeFile = getActiveFile(get());
    return activeFile?.content ?? "";
  },

  setFileName: (name) => {
    const state = get();
    set({
      files: state.files.map((f) =>
        f.id === state.activeFileId ? { ...f, name } : f,
      ),
    });
  },

  setContent: (content) => {
    const state = get();
    set({
      files: state.files.map((f) =>
        f.id === state.activeFileId ? { ...f, content, isDirty: true } : f,
      ),
      contentGeneration: state.contentGeneration + 1,
    });
    scheduleAutoSave();
  },
}));

storeRef = useDocumentStore;
