import { create } from "zustand";
import {
  scanProjectFolder,
  readTexFileContent,
  writeTexFileContent,
  readImageAsDataUrl,
  createFileOnDisk,
  copyFileToProject,
  deleteFileFromDisk,
  renameFileOnDisk,
  getUniqueTargetName,
  createDirectory,
  join,
  type ProjectFileType,
} from "@/lib/tauri/fs";
import { useHistoryStore } from "@/stores/history-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";

export interface ProjectFile {
  id: string; // relativePath is the id
  name: string;
  relativePath: string;
  absolutePath: string;
  type: ProjectFileType;
  content?: string;
  dataUrl?: string;
  isDirty: boolean;
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
  pdfData: Uint8Array | null;
  compileError: string | null;
  isCompiling: boolean;
  isSaving: boolean;
  initialized: boolean;

  openProject: (rootPath: string) => Promise<void>;
  closeProject: () => void;
  setActiveFile: (id: string) => void;
  addFile: (file: Omit<ProjectFile, "id" | "isDirty">) => string;
  deleteFile: (id: string) => void;
  renameFile: (id: string, name: string) => void;
  updateFileContent: (id: string, content: string) => void;
  setCursorPosition: (position: number) => void;
  setSelectionRange: (range: { start: number; end: number } | null) => void;
  requestJumpToPosition: (position: number) => void;
  clearJumpRequest: () => void;
  setThreadOpen: (open: boolean) => void;
  setPdfData: (data: Uint8Array | null) => void;
  setCompileError: (error: string | null) => void;
  setIsCompiling: (isCompiling: boolean) => void;
  setIsSaving: (isSaving: boolean) => void;
  insertAtCursor: (text: string) => void;
  replaceSelection: (start: number, end: number, text: string) => void;
  findAndReplace: (find: string, replace: string) => boolean;
  setInitialized: () => void;
  saveFile: (id: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  saveCurrentFile: () => Promise<void>;
  createNewFile: (name: string, type: "tex" | "image", folder?: string) => Promise<void>;
  createFolder: (name: string, parentFolder?: string) => Promise<void>;
  importFiles: (sourcePaths: string[], targetFolder?: string) => Promise<string[]>;
  moveFile: (fileId: string, targetFolder: string | null) => Promise<void>;
  moveFolder: (folderPath: string, targetFolder: string | null) => Promise<void>;
  reloadFile: (relativePath: string) => Promise<void>;
  refreshFiles: () => Promise<void>;

  get fileName(): string;
  get content(): string;
  setFileName: (name: string) => void;
  setContent: (content: string) => void;
}

function getActiveFile(state: { files: ProjectFile[]; activeFileId: string }) {
  return state.files.find((f) => f.id === state.activeFileId);
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
    const dirtyFiles = state.files.filter((f) => f.isDirty && f.content != null);
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
  pdfData: null,
  compileError: null,
  isCompiling: false,
  isSaving: false,
  initialized: false,

  openProject: async (rootPath: string) => {
    const { files: fsFiles, folders: fsFolders } = await scanProjectFolder(rootPath);
    const projectFiles: ProjectFile[] = [];

    for (const f of fsFiles) {
      const pf: ProjectFile = {
        id: f.relativePath,
        name: f.relativePath.split("/").pop() || f.relativePath,
        relativePath: f.relativePath,
        absolutePath: f.absolutePath,
        type: f.type,
        isDirty: false,
      };

      // Load content for text-based files
      if (f.type === "tex" || f.type === "bib" || f.type === "style" || f.type === "other") {
        try {
          pf.content = await readTexFileContent(f.absolutePath);
        } catch {
          pf.content = "";
        }
      }

      // Load dataUrl for image files
      if (f.type === "image") {
        try {
          pf.dataUrl = await readImageAsDataUrl(f.absolutePath);
        } catch {
          // Image loading failed, that's ok
        }
      }

      // PDF files are loaded on-demand via readFile in InlinePdfContent

      projectFiles.push(pf);
    }

    // Find the main tex file
    const mainTex =
      projectFiles.find((f) => f.name === "main.tex" || f.name === "document.tex") ||
      projectFiles.find((f) => f.type === "tex");

    set({
      projectRoot: rootPath,
      files: projectFiles,
      folders: fsFolders,
      activeFileId: mainTex?.id || projectFiles[0]?.id || "",
      pdfData: null,
      compileError: null,
      initialized: true,
      cursorPosition: 0,
      selectionRange: null,
    });

    // Initialize history system early so snapshots work before the panel is opened
    const historyStore = useHistoryStore.getState();
    historyStore.init(rootPath).then(() => historyStore.loadSnapshots(rootPath)).catch(() => {});
  },

  closeProject: () => {
    set({
      projectRoot: null,
      files: [],
      folders: [],
      activeFileId: "",
      pdfData: null,
      compileError: null,
      initialized: false,
    });
    // Reset chat session so stale messages don't leak into the next project
    useClaudeChatStore.getState().newSession();
  },

  setActiveFile: (id) =>
    set({ activeFileId: id, cursorPosition: 0, selectionRange: null }),

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
        console.error("Failed to delete file from disk:", e);
      }
    }
    const newFiles = state.files.filter((f) => f.id !== id);
    const newActiveId =
      state.activeFileId === id ? newFiles[0].id : state.activeFileId;
    set({ files: newFiles, activeFileId: newActiveId });
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
      console.error("Failed to rename file on disk:", e);
      return;
    }
    set((s) => ({
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
      activeFileId: s.activeFileId === id ? newRelativePath : s.activeFileId,
    }));
  },

  updateFileContent: (id, content) => {
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, content, isDirty: true } : f,
      ),
    }));
    scheduleAutoSave();
  },

  setThreadOpen: (open) => set({ isThreadOpen: open }),

  setPdfData: (data) => set({ pdfData: data, compileError: null }),

  setCompileError: (error) => set({ compileError: error }),

  setIsCompiling: (isCompiling) => set({ isCompiling }),

  setIsSaving: (isSaving) => set({ isSaving }),

  setCursorPosition: (position) => set({ cursorPosition: position }),

  insertAtCursor: (text) => {
    const state = get();
    const activeFile = getActiveFile(state);
    if (!activeFile || (activeFile.type === "image" || activeFile.type === "pdf"))
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
    if (!activeFile || (activeFile.type === "image" || activeFile.type === "pdf"))
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
    if (!activeFile || (activeFile.type === "image" || activeFile.type === "pdf"))
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
      files: s.files.map((f) =>
        f.id === id ? { ...f, isDirty: false } : f,
      ),
    }));
  },

  saveAllFiles: async () => {
    const state = get();
    const dirtyFiles = state.files.filter((f) => f.isDirty && f.content != null);
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
        await useHistoryStore.getState().createSnapshot(state.projectRoot, "[manual] Save");
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

    const fullPath = await createFileOnDisk(state.projectRoot, relativePath, content);

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
      const fileName = sourcePath.split("/").pop() || sourcePath;
      const targetName = targetFolder ? `${targetFolder}/${fileName}` : fileName;
      // copyFileToProject returns the actual (possibly deduplicated) relative path
      const actualName = await copyFileToProject(state.projectRoot, sourcePath, targetName);
      importedPaths.push(actualName);
    }
    await state.refreshFiles();
    return importedPaths;
  },

  moveFile: async (fileId, targetFolder) => {
    const state = get();
    const file = state.files.find((f) => f.id === fileId);
    if (!file || !state.projectRoot) return;

    const desiredPath = targetFolder ? `${targetFolder}/${file.name}` : file.name;
    if (desiredPath === file.relativePath) return;

    // Auto-deduplicate if a file with the same name exists in the target
    const newRelativePath = await getUniqueTargetName(state.projectRoot, desiredPath);
    const newAbsPath = await join(state.projectRoot, newRelativePath);
    await renameFileOnDisk(file.absolutePath, newAbsPath);

    const newName = newRelativePath.split("/").pop() || file.name;
    set((s) => ({
      files: s.files.map((f) =>
        f.id === fileId
          ? { ...f, name: newName, relativePath: newRelativePath, absolutePath: newAbsPath, id: newRelativePath }
          : f,
      ),
      activeFileId: s.activeFileId === fileId ? newRelativePath : s.activeFileId,
    }));
  },

  moveFolder: async (folderPath, targetFolder) => {
    const state = get();
    if (!state.projectRoot) return;

    const folderName = folderPath.split("/").pop()!;
    const newFolderPath = targetFolder ? `${targetFolder}/${folderName}` : folderName;
    if (newFolderPath === folderPath) return;
    // Prevent moving a folder into itself
    if (newFolderPath.startsWith(folderPath + "/")) return;

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
      }));
    }
  },

  refreshFiles: async () => {
    const { projectRoot, files, activeFileId } = get();
    if (!projectRoot) return;

    const { files: fsFiles, folders: fsFolders } = await scanProjectFolder(projectRoot);
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
          const updated = { ...existing };
          if (updated.type === "tex" || updated.type === "bib" || updated.type === "style" || updated.type === "other") {
            try {
              updated.content = await readTexFileContent(updated.absolutePath);
            } catch { /* keep previous content */ }
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
        };
        if (pf.type === "tex" || pf.type === "bib" || pf.type === "style" || pf.type === "other") {
          try {
            pf.content = await readTexFileContent(pf.absolutePath);
          } catch { /* skip unreadable */ }
        } else if (pf.type === "image") {
          try {
            pf.dataUrl = await readImageAsDataUrl(pf.absolutePath);
          } catch { /* skip unreadable */ }
        }
        // PDF files are loaded on-demand via readFile in InlinePdfContent
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
      : merged[0]?.id ?? "";

    set({ files: merged, folders: fsFolders, activeFileId: newActiveId });
  },

  get fileName() {
    const activeFile = getActiveFile(get());
    return activeFile?.name ?? "document.tex";
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
        f.id === state.activeFileId
          ? { ...f, content, isDirty: true }
          : f,
      ),
    });
    scheduleAutoSave();
  },
}));

storeRef = useDocumentStore;
