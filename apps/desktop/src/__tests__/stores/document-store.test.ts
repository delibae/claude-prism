import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  readDir,
  readTextFile,
  rename,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import {
  useDocumentStore,
  getCurrentPdfBytes,
  getCurrentPdfRootId,
  clearPdfBytesCache,
  type ProjectFile,
} from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";

// Mock history store
vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      init: vi.fn(() => Promise.resolve()),
      loadSnapshots: vi.fn(() => Promise.resolve()),
      createSnapshot: vi.fn(() => Promise.resolve()),
      reset: vi.fn(),
    })),
  },
}));

// Mock claude-chat-store
vi.mock("@/stores/claude-chat-store", () => ({
  useClaudeChatStore: {
    getState: vi.fn(() => ({
      newSession: vi.fn(),
    })),
  },
}));

function makeFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    id: "main.tex",
    name: "main.tex",
    relativePath: "main.tex",
    absolutePath: "/project/main.tex",
    type: "tex",
    content: "Hello World",
    isDirty: false,
    ...overrides,
  };
}

describe("useDocumentStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPdfBytesCache();
    useDocumentStore.setState({
      projectRoot: "/project",
      files: [makeFile()],
      folders: [],
      activeFileId: "main.tex",
      cursorPosition: 5, // after "Hello"
      selectionRange: null,
      jumpToPosition: null,
      isThreadOpen: false,
      pdfRevision: 0,
      compileError: null,
      isCompiling: false,
      pendingRecompile: false,
      isSaving: false,
      initialized: true,
    });
    useProjectStore.setState({
      recentProjects: [],
      lastProjectFolder: null,
    });
  });

  describe("getActiveFile logic", () => {
    it("insertAtCursor finds the correct active file", () => {
      // Validates that getActiveFile() correctly resolves the active file
      // by confirming insertAtCursor modifies the right file's content
      useDocumentStore.getState().insertAtCursor("!");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello! World");
    });

    it("returns null for nonexistent activeFileId (no-op on insert)", () => {
      useDocumentStore.setState({ activeFileId: "nonexistent" });
      useDocumentStore.getState().insertAtCursor("text");
      // Files should not be modified
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello World");
    });
  });

  describe("openProject", () => {
    it("re-authorizes the project directory before scanning", async () => {
      const projectPath = "E:\\overleaf-cache\\论文项目";
      let resolveAuthorization!: () => void;
      const authorizationPromise = new Promise<void>((resolve) => {
        resolveAuthorization = resolve;
      });

      vi.mocked(invoke).mockReturnValue(
        authorizationPromise as ReturnType<typeof invoke>,
      );
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("\\documentclass{article}");

      const openProjectPromise = useDocumentStore
        .getState()
        .openProject(projectPath);

      expect(invoke).toHaveBeenCalledWith("allow_project_directory", {
        rootPath: projectPath,
      });
      expect(readDir).not.toHaveBeenCalled();

      resolveAuthorization();
      await openProjectPromise;

      expect(readDir).toHaveBeenCalled();
    });

    it("skips Python cache directories and bytecode files during open", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockImplementation(async (dir: string | URL) => {
        const dirPath = String(dir);
        if (dirPath === "/project") {
          return [
            { name: "__pycache__", isDirectory: true },
            { name: "main.tex", isDirectory: false },
            { name: "tool.py", isDirectory: false },
            { name: "compiled.pyc", isDirectory: false },
          ] as any;
        }

        throw new Error(`Unexpected readDir path: ${dirPath}`);
      });
      vi.mocked(stat).mockResolvedValue({ size: 32 } as any);
      vi.mocked(readTextFile).mockImplementation(async (path: string | URL) => {
        const filePath = String(path);
        if (filePath === "/project/main.tex") {
          return "\\documentclass{article}";
        }
        if (filePath === "/project/tool.py") {
          return "print('hello')";
        }
        throw new Error(`Unexpected readTextFile path: ${filePath}`);
      });

      await useDocumentStore.getState().openProject("/project");

      expect(readDir).toHaveBeenCalledWith("/project");
      expect(readDir).not.toHaveBeenCalledWith("/project/__pycache__");
      expect(stat).toHaveBeenCalledTimes(1);
      expect(stat).toHaveBeenCalledWith("/project/tool.py");
      expect(readTextFile).toHaveBeenCalledTimes(2);
      expect(readTextFile).not.toHaveBeenCalledWith("/project/compiled.pyc");
      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toEqual(["main.tex", "tool.py"]);
    });
  });

  describe("renameProject", () => {
    it("renames the project folder and reopens the new path", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("\\documentclass{article}");
      useProjectStore.setState({
        recentProjects: [{ path: "/work/old", name: "old", lastOpened: 1 }],
        lastProjectFolder: "/work",
      });
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [makeFile({ absolutePath: "/work/old/main.tex" })],
      });

      await useDocumentStore.getState().renameProject("renamed");

      expect(rename).toHaveBeenCalledWith("/work/old", "/work/renamed");
      expect(invoke).toHaveBeenCalledWith("migrate_project_sessions", {
        oldProjectPath: "/work/old",
        newProjectPath: "/work/renamed",
      });
      expect(invoke).toHaveBeenCalledWith("allow_project_directory", {
        rootPath: "/work/renamed",
      });
      expect(useDocumentStore.getState().projectRoot).toBe("/work/renamed");
      expect(useProjectStore.getState().recentProjects[0]).toMatchObject({
        path: "/work/renamed",
        name: "renamed",
      });
      expect(
        useProjectStore
          .getState()
          .recentProjects.some((project) => project.path === "/work/old"),
      ).toBe(false);
      expect(useProjectStore.getState().lastProjectFolder).toBe("/work");
    });

    it("saves dirty files before renaming the project folder", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(writeTextFile).mockResolvedValue(undefined);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("\\documentclass{article}");
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [
          makeFile({
            absolutePath: "/work/old/main.tex",
            content: "dirty",
            isDirty: true,
          }),
        ],
      });

      await useDocumentStore.getState().renameProject("renamed");

      expect(writeTextFile).toHaveBeenCalledWith("/work/old/main.tex", "dirty");
      expect(rename).toHaveBeenCalledWith("/work/old", "/work/renamed");
    });
  });

  describe("insertAtCursor", () => {
    it("inserts text at cursor position", () => {
      useDocumentStore.getState().insertAtCursor(", Beautiful");
      const state = useDocumentStore.getState();
      const file = state.files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello, Beautiful World");
      expect(file.isDirty).toBe(true);
    });

    it("updates cursor position after insert", () => {
      useDocumentStore.getState().insertAtCursor("!");
      expect(useDocumentStore.getState().cursorPosition).toBe(6);
    });

    it("inserts at beginning when cursor is at 0", () => {
      useDocumentStore.setState({ cursorPosition: 0 });
      useDocumentStore.getState().insertAtCursor(">> ");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe(">> Hello World");
    });

    it("inserts at end when cursor is at content length", () => {
      useDocumentStore.setState({ cursorPosition: 11 }); // "Hello World".length
      useDocumentStore.getState().insertAtCursor("!");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello World!");
    });

    it("does nothing for image files", () => {
      useDocumentStore.setState({
        files: [makeFile({ type: "image", content: undefined })],
      });
      useDocumentStore.getState().insertAtCursor("text");
      const file = useDocumentStore.getState().files[0];
      expect(file.content).toBeUndefined();
    });

    it("handles empty content", () => {
      useDocumentStore.setState({
        files: [makeFile({ content: "" })],
        cursorPosition: 0,
      });
      useDocumentStore.getState().insertAtCursor("New text");
      const file = useDocumentStore.getState().files[0];
      expect(file.content).toBe("New text");
    });
  });

  describe("replaceSelection", () => {
    it("replaces a range of text", () => {
      // Replace "World" (indices 6-11) with "Universe"
      useDocumentStore.getState().replaceSelection(6, 11, "Universe");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello Universe");
      expect(file.isDirty).toBe(true);
    });

    it("updates cursor position to end of replacement", () => {
      useDocumentStore.getState().replaceSelection(6, 11, "Universe");
      expect(useDocumentStore.getState().cursorPosition).toBe(14); // 6 + "Universe".length
    });

    it("can delete text (empty replacement)", () => {
      useDocumentStore.getState().replaceSelection(5, 11, "");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello");
    });

    it("can insert at a point (start === end)", () => {
      useDocumentStore.getState().replaceSelection(5, 5, " Beautiful");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello Beautiful World");
    });

    it("does nothing for pdf files", () => {
      useDocumentStore.setState({
        files: [makeFile({ type: "pdf", content: "pdf-data" })],
      });
      useDocumentStore.getState().replaceSelection(0, 3, "new");
      expect(useDocumentStore.getState().files[0].content).toBe("pdf-data");
    });
  });

  describe("findAndReplace", () => {
    it("replaces first occurrence", () => {
      const result = useDocumentStore
        .getState()
        .findAndReplace("World", "Universe");
      expect(result).toBe(true);
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello Universe");
      expect(file.isDirty).toBe(true);
    });

    it("returns false when find string is not found", () => {
      const result = useDocumentStore.getState().findAndReplace("xyz", "abc");
      expect(result).toBe(false);
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.isDirty).toBe(false); // not modified
    });

    it("replaces only first occurrence (String.replace behavior)", () => {
      useDocumentStore.setState({
        files: [makeFile({ content: "aaa bbb aaa" })],
      });
      useDocumentStore.getState().findAndReplace("aaa", "ccc");
      const file = useDocumentStore.getState().files[0];
      expect(file.content).toBe("ccc bbb aaa");
    });

    it("handles special regex characters in find string", () => {
      useDocumentStore.setState({
        files: [makeFile({ content: "price is $10.00" })],
      });
      const result = useDocumentStore
        .getState()
        .findAndReplace("$10.00", "€12.00");
      expect(result).toBe(true);
      expect(useDocumentStore.getState().files[0].content).toBe(
        "price is €12.00",
      );
    });

    it("does nothing for image files", () => {
      useDocumentStore.setState({
        files: [makeFile({ type: "image" })],
      });
      const result = useDocumentStore.getState().findAndReplace("Hello", "Bye");
      expect(result).toBe(false);
    });
  });

  describe("updateFileContent", () => {
    it("updates content and marks dirty", () => {
      useDocumentStore.getState().updateFileContent("main.tex", "New content");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("New content");
      expect(file.isDirty).toBe(true);
    });

    it("does not affect other files", () => {
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: "other.tex",
            name: "other.tex",
            relativePath: "other.tex",
            content: "Other",
          }),
        ],
      });
      useDocumentStore.getState().updateFileContent("main.tex", "Changed");
      const other = useDocumentStore
        .getState()
        .files.find((f) => f.id === "other.tex")!;
      expect(other.content).toBe("Other");
      expect(other.isDirty).toBe(false);
    });
  });

  describe("addFile", () => {
    it("adds a new file and sets it active", () => {
      const id = useDocumentStore.getState().addFile({
        name: "refs.bib",
        relativePath: "refs.bib",
        absolutePath: "/project/refs.bib",
        type: "bib",
        content: "@article{...}",
      });
      expect(id).toBe("refs.bib");
      const state = useDocumentStore.getState();
      expect(state.files).toHaveLength(2);
      expect(state.activeFileId).toBe("refs.bib");
    });
  });

  describe("setActiveFile", () => {
    it("changes active file and resets selection", () => {
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({ id: "ch1.tex", name: "ch1.tex", relativePath: "ch1.tex" }),
        ],
        cursorPosition: 100,
        selectionRange: { start: 10, end: 20 },
      });
      useDocumentStore.getState().setActiveFile("ch1.tex");
      const state = useDocumentStore.getState();
      expect(state.activeFileId).toBe("ch1.tex");
      // cursorPosition is preserved — the editor restores it from per-file cache
      expect(state.cursorPosition).toBe(100);
      expect(state.selectionRange).toBeNull();
    });

    it("keeps the current PDF when switching to a non-tex file", () => {
      const pdfBytes = new Uint8Array([1, 2, 3]);
      useDocumentStore.setState({
        files: [
          makeFile({
            content:
              "\\documentclass{article}\\begin{document}Hi\\end{document}",
          }),
          makeFile({
            id: "analysis.py",
            name: "analysis.py",
            relativePath: "analysis.py",
            absolutePath: "/project/analysis.py",
            type: "other",
            content: "print('hello')",
          }),
        ],
        activeFileId: "main.tex",
        selectionRange: { start: 0, end: 3 },
      });
      useDocumentStore.getState().setPdfData(pdfBytes, "main.tex");
      const revisionBefore = useDocumentStore.getState().pdfRevision;

      useDocumentStore.getState().setActiveFile("analysis.py");

      const state = useDocumentStore.getState();
      expect(state.activeFileId).toBe("analysis.py");
      expect(state.selectionRange).toBeNull();
      expect(state.pdfRevision).toBe(revisionBefore);
      expect(getCurrentPdfRootId()).toBe("main.tex");
      expect(getCurrentPdfBytes()).toEqual(pdfBytes);
    });
  });

  describe("refreshFiles", () => {
    function mockDisk(contents: Record<string, string>) {
      vi.mocked(readDir).mockImplementation(async (dir: string | URL) => {
        const dirPath = String(dir);
        if (dirPath === "/project") {
          return [
            { name: "main.tex", isDirectory: false },
            { name: "sections", isDirectory: true },
          ] as any;
        }
        if (dirPath === "/project/sections") {
          return [{ name: "intro.tex", isDirectory: false }] as any;
        }
        throw new Error(`Unexpected readDir path: ${dirPath}`);
      });
      vi.mocked(readTextFile).mockImplementation(async (path: string | URL) => {
        const filePath = String(path);
        if (filePath in contents) return contents[filePath];
        throw new Error(`Unexpected readTextFile path: ${filePath}`);
      });
    }

    const mainContent = "\\documentclass{article}\\input{sections/intro}";
    const introContent = "\\section{Intro}";

    beforeEach(() => {
      useDocumentStore.setState({
        files: [
          makeFile({ content: mainContent }),
          makeFile({
            id: "sections/intro.tex",
            name: "intro.tex",
            relativePath: "sections/intro.tex",
            absolutePath: "/project/sections/intro.tex",
            content: introContent,
          }),
        ],
        activeFileId: "main.tex",
      });
    });

    it("keeps a file that became active while the refresh was in flight", async () => {
      mockDisk({
        "/project/main.tex": mainContent,
        "/project/sections/intro.tex": introContent,
      });
      const store = useDocumentStore.getState();
      const refresh = store.refreshFiles();
      // User opens a section file while disk reads are still pending
      store.setActiveFile("sections/intro.tex");
      await refresh;

      expect(useDocumentStore.getState().activeFileId).toBe(
        "sections/intro.tex",
      );
    });

    it("does not clobber edits made while the refresh was in flight", async () => {
      mockDisk({
        "/project/main.tex": mainContent,
        "/project/sections/intro.tex": introContent,
      });
      const store = useDocumentStore.getState();
      const refresh = store.refreshFiles();
      store.updateFileContent("sections/intro.tex", "edited during refresh");
      await refresh;

      const intro = useDocumentStore
        .getState()
        .files.find((f) => f.id === "sections/intro.tex");
      expect(intro?.content).toBe("edited during refresh");
      expect(intro?.isDirty).toBe(true);
    });

    it("reloads clean files from disk and picks up new files", async () => {
      vi.mocked(readDir).mockImplementation(async (dir: string | URL) => {
        const dirPath = String(dir);
        if (dirPath === "/project") {
          return [
            { name: "main.tex", isDirectory: false },
            { name: "sections", isDirectory: true },
          ] as any;
        }
        if (dirPath === "/project/sections") {
          return [
            { name: "intro.tex", isDirectory: false },
            { name: "results.tex", isDirectory: false },
          ] as any;
        }
        throw new Error(`Unexpected readDir path: ${dirPath}`);
      });
      vi.mocked(readTextFile).mockImplementation(async (path: string | URL) => {
        const filePath = String(path);
        if (filePath === "/project/main.tex") return mainContent;
        if (filePath === "/project/sections/intro.tex") return "updated intro";
        if (filePath === "/project/sections/results.tex") return "results";
        throw new Error(`Unexpected readTextFile path: ${filePath}`);
      });

      await useDocumentStore.getState().refreshFiles();

      const state = useDocumentStore.getState();
      expect(state.files.map((f) => f.id)).toEqual([
        "main.tex",
        "sections/intro.tex",
        "sections/results.tex",
      ]);
      expect(
        state.files.find((f) => f.id === "sections/intro.tex")?.content,
      ).toBe("updated intro");
      expect(
        state.files.find((f) => f.id === "sections/results.tex")?.content,
      ).toBe("results");
      expect(state.folders).toEqual(["sections"]);
      expect(state.activeFileId).toBe("main.tex");
    });
  });

  describe("saveFile", () => {
    beforeEach(() => {
      vi.mocked(writeTextFile).mockClear();
      vi.mocked(writeTextFile).mockResolvedValue(undefined);
    });

    it("saves a dirty file with content to disk", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "saved content" })],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).toHaveBeenCalledWith(
        "/project/main.tex",
        "saved content",
      );
      expect(useDocumentStore.getState().files[0].isDirty).toBe(false);
    });

    it("saves a dirty file with empty string content (regression: empty content is not falsy-skipped)", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "" })],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).toHaveBeenCalledWith("/project/main.tex", "");
      expect(useDocumentStore.getState().files[0].isDirty).toBe(false);
    });

    it("skips saving when content is null", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: null as unknown as string }),
        ],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it("skips saving when file is not dirty", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: false, content: "clean" })],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).not.toHaveBeenCalled();
    });
  });

  describe("saveAllFiles", () => {
    beforeEach(() => {
      vi.mocked(writeTextFile).mockClear();
      vi.mocked(writeTextFile).mockResolvedValue(undefined);
    });

    it("saves all dirty files", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: "dirty content" }),
          makeFile({
            id: "clean.tex",
            name: "clean.tex",
            absolutePath: "/project/clean.tex",
            relativePath: "clean.tex",
            isDirty: false,
            content: "clean",
          }),
        ],
      });
      await useDocumentStore.getState().saveAllFiles();
      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(writeTextFile).toHaveBeenCalledWith(
        "/project/main.tex",
        "dirty content",
      );
    });

    it("saves dirty files with empty string content (regression: empty string is not falsy-skipped)", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: "" }),
          makeFile({
            id: "slide.tex",
            name: "slide.tex",
            absolutePath: "/project/slide.tex",
            relativePath: "slide.tex",
            isDirty: true,
            content: "",
          }),
        ],
      });
      await useDocumentStore.getState().saveAllFiles();
      expect(writeTextFile).toHaveBeenCalledTimes(2);
      expect(writeTextFile).toHaveBeenCalledWith("/project/main.tex", "");
      expect(writeTextFile).toHaveBeenCalledWith("/project/slide.tex", "");
      // Both should be marked clean
      const files = useDocumentStore.getState().files;
      expect(files.every((f) => !f.isDirty)).toBe(true);
    });

    it("skips files with null content even if dirty", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: null as unknown as string }),
        ],
      });
      await useDocumentStore.getState().saveAllFiles();
      expect(writeTextFile).not.toHaveBeenCalled();
    });
  });

  describe("setPdfData / setCompileError", () => {
    it("setPdfData clears compile error", () => {
      useDocumentStore.setState({ compileError: "some error" });
      useDocumentStore.getState().setPdfData(new Uint8Array([1, 2, 3]));
      const state = useDocumentStore.getState();
      expect(getCurrentPdfBytes()).toEqual(new Uint8Array([1, 2, 3]));
      expect(state.compileError).toBeNull();
    });

    it("setCompileError stores the error string (regression: Tauri string errors must be preserved)", () => {
      useDocumentStore
        .getState()
        .setCompileError("Compilation failed\n\n! Undefined control sequence.");
      expect(useDocumentStore.getState().compileError).toBe(
        "Compilation failed\n\n! Undefined control sequence.",
      );
    });
  });
});
