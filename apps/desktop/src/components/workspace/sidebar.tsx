import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  FileTextIcon,
  FolderIcon,
  HomeIcon,
  FolderPlusIcon,
  ImageIcon,
  PlusIcon,
  Trash2Icon,
  PencilIcon,
  UploadIcon,
  RefreshCwIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ListIcon,
  HashIcon,
  GithubIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  GripVerticalIcon,
  AppWindowIcon,
  FlaskConicalIcon,
  TerminalIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useTheme } from "next-themes";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { cn } from "@/lib/utils";
import { ZoteroPanel, ZoteroHeader } from "@/components/workspace/zotero-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { UvSetupDialog } from "@/components/uv-setup";

// ─── Table of Contents ───

interface TocItem {
  level: number;
  title: string;
  line: number;
}

function parseTableOfContents(content: string): TocItem[] {
  const lines = content.split("\n");
  const toc: TocItem[] = [];
  const sectionRegex =
    /\\(section|subsection|subsubsection|chapter|part)\*?\s*\{([^}]*)\}/;
  const levelMap: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
  };
  lines.forEach((line, index) => {
    const match = line.match(sectionRegex);
    if (match) {
      const [, type, title] = match;
      toc.push({ level: levelMap[type] ?? 2, title: title.trim(), line: index + 1 });
    }
  });
  return toc;
}

// ─── File Tree Builder ───

interface TreeNode {
  name: string;
  relativePath: string;
  type: "folder" | "file";
  file?: ProjectFile;
  children: TreeNode[];
}

function buildFileTree(files: ProjectFile[], folders: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();

  function getOrCreateFolder(path: string): TreeNode[] {
    if (!path) return root;
    if (folderMap.has(path)) return folderMap.get(path)!.children;

    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");
    const parentChildren = getOrCreateFolder(parentPath);

    const folder: TreeNode = {
      name,
      relativePath: path,
      type: "folder",
      children: [],
    };
    folderMap.set(path, folder);
    parentChildren.push(folder);
    return folder.children;
  }

  // Ensure all known folders exist as nodes (including empty ones)
  for (const folderPath of folders) {
    getOrCreateFolder(folderPath);
  }

  for (const file of files) {
    const parts = file.relativePath.split("/");
    const fileName = parts[parts.length - 1];
    const folderPath = parts.slice(0, -1).join("/");
    const parentChildren = getOrCreateFolder(folderPath);

    parentChildren.push({
      name: fileName,
      relativePath: file.relativePath,
      type: "file",
      file,
      children: [],
    });
  }

  // Sort: folders first, then alphabetical
  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.type === "folder") sortNodes(node.children);
    }
  }
  sortNodes(root);

  return root;
}

// ─── File Icon ───

function getFileIcon(file: ProjectFile) {
  if (file.type === "image") return <ImageIcon className="size-4 shrink-0" />;
  if (file.type === "pdf") return <FileSpreadsheetIcon className="size-4 shrink-0" />;
  if (file.type === "style") return <FileCodeIcon className="size-4 shrink-0" />;
  if (file.type === "other") return <FileIcon className="size-4 shrink-0" />;
  return <FileTextIcon className="size-4 shrink-0" />;
}

// ─── Constants ───

const APP_VERSION = "0.0.1";

// ─── Sidebar ───

export function Sidebar() {
  const files = useDocumentStore((s) => s.files);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const deleteFile = useDocumentStore((s) => s.deleteFile);
  const deleteFolder = useDocumentStore((s) => s.deleteFolder);
  const renameFile = useDocumentStore((s) => s.renameFile);
  const createNewFile = useDocumentStore((s) => s.createNewFile);
  const createFolder = useDocumentStore((s) => s.createFolder);
  const importFiles = useDocumentStore((s) => s.importFiles);
  const activeFileContent = useDocumentStore((s) => {
    const active = s.files.find((f) => f.id === s.activeFileId);
    return active?.content ?? "";
  });
  const requestJumpToPosition = useDocumentStore((s) => s.requestJumpToPosition);
  const insertAtCursor = useDocumentStore((s) => s.insertAtCursor);
  const moveFile = useDocumentStore((s) => s.moveFile);
  const moveFolder = useDocumentStore((s) => s.moveFolder);
  const closeProject = useDocumentStore((s) => s.closeProject);
  const refreshFiles = useDocumentStore((s) => s.refreshFiles);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const folders = useDocumentStore((s) => s.folders);
  const { theme, setTheme } = useTheme();

  // ─── Native OS file drop (Tauri onDragDropEvent) ───
  const sidebarFilesRef = useRef<HTMLDivElement>(null);
  const nativeDropTargetRef = useRef<string | null>(null);
  const [nativeDragOver, setNativeDragOver] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (cancelled) return;
        const { type } = event.payload;

        if (type === "over" || type === "enter") {
          const payload = event.payload as { position: { x: number; y: number } };
          const { x, y } = payload.position;
          // Tauri reports physical pixels; elementFromPoint expects logical (CSS) pixels
          const logicalX = x / window.devicePixelRatio;
          const logicalY = y / window.devicePixelRatio;

          const el = document.elementFromPoint(logicalX, logicalY);
          const filesArea = sidebarFilesRef.current;

          if (!filesArea || !el || !filesArea.contains(el)) {
            // Not over the sidebar file tree
            if (nativeDropTargetRef.current !== null) {
              nativeDropTargetRef.current = null;
              setNativeDragOver(null);
            }
            return;
          }

          // Walk up from the hovered element to find the closest drop-folder target
          const folderEl = el.closest("[data-drop-folder]") as HTMLElement | null;
          const folder = folderEl?.dataset.dropFolder ?? "__root__";
          nativeDropTargetRef.current = folder;
          setNativeDragOver(folder);
        } else if (type === "drop") {
          const payload = event.payload as { paths: string[]; position: { x: number; y: number } };
          const { paths, position } = payload;
          const logicalX = position.x / window.devicePixelRatio;
          const logicalY = position.y / window.devicePixelRatio;

          const el = document.elementFromPoint(logicalX, logicalY);
          const filesArea = sidebarFilesRef.current;

          if (!filesArea || !el || !filesArea.contains(el)) {
            setNativeDragOver(null);
            nativeDropTargetRef.current = null;
            return;
          }

          const targetFolder = nativeDropTargetRef.current === "__root__"
            ? undefined
            : (nativeDropTargetRef.current ?? undefined);

          // Mark as handled so chat-composer doesn't also process it
          (window as any).__sidebarHandledDrop = true;
          setTimeout(() => { (window as any).__sidebarHandledDrop = false; }, 200);

          try {
            await importFiles(paths, targetFolder);
          } catch (err) {
            console.error("[native-drop] import failed:", err);
          }

          setNativeDragOver(null);
          nativeDropTargetRef.current = null;
        } else if (type === "leave") {
          setNativeDragOver(null);
          nativeDropTargetRef.current = null;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not in Tauri environment (dev mode)
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [importFiles]);

  // Track selected folder for paste target
  const [pasteTargetFolder, setPasteTargetFolder] = useState<string | undefined>();

  // ─── Cmd+V paste files from OS clipboard ───
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "v") return;

      // Don't intercept paste in text inputs / editor (contentEditable)
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      )
        return;

      try {
        const paths = await invoke<string[]>("read_clipboard_file_paths");
        if (paths.length > 0) {
          e.preventDefault();
          await importFiles(paths, pasteTargetFolder);
        }
      } catch (err) {
        console.error("[paste] read clipboard failed:", err);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [importFiles, pasteTargetFolder]);

  // dnd-kit drag-and-drop (uses PointerSensor — works in Tauri WKWebView)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const [activeDrag, setActiveDrag] = useState<{ id: string; type: "file" | "folder"; name: string } | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { type, name } = event.active.data.current as { type: "file" | "folder"; name: string };
    setActiveDrag({ id: event.active.id as string, type, name });
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) return;

    const draggedPath = active.id as string;
    const draggedType = (active.data.current as { type: string }).type;
    const targetId = over.id as string;
    const targetFolder = targetId === "__root__" ? null : targetId;

    // Don't move if same parent
    const draggedParent = draggedPath.includes("/")
      ? draggedPath.substring(0, draggedPath.lastIndexOf("/"))
      : null;
    if (targetFolder === draggedParent) return;

    // Don't move folder into itself or descendant
    if (draggedType === "folder" && targetFolder) {
      if (targetFolder === draggedPath || targetFolder.startsWith(draggedPath + "/")) return;
    }

    try {
      if (draggedType === "file") await moveFile(draggedPath, targetFolder);
      else await moveFolder(draggedPath, targetFolder);
    } catch (err) {
      console.error("[dnd] move failed:", err);
    }
  }, [moveFile, moveFolder]);

  // Dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogFolder, setAddDialogFolder] = useState<string | undefined>();
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDialogParent, setFolderDialogParent] = useState<string | undefined>();
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newFileName, setNewFileName] = useState("");
  const [newFolderName, setNewFolderName] = useState("");

  // Folder expand/collapse
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildFileTree(files, folders), [files, folders]);

  // Auto-expand parent folders of the active file so it stays visible
  useEffect(() => {
    if (!activeFileId) return;
    const parts = activeFileId.split("/");
    if (parts.length <= 1) return;
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        if (!next.has(folder)) { next.add(folder); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [activeFileId]);

  const toggleFolder = useCallback((path: string) => {
    setPasteTargetFolder(path);
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Outline
  const toc = useMemo(() => parseTableOfContents(activeFileContent), [activeFileContent]);
  const handleTocClick = useCallback(
    (line: number) => {
      const lines = activeFileContent.split("\n");
      let position = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) {
        position += lines[i].length + 1;
      }
      requestJumpToPosition(position);
    },
    [activeFileContent, requestJumpToPosition],
  );

  // Check if a name already exists in the given folder
  // Case-insensitive on macOS/Windows (default case-insensitive filesystems)
  const isCaseInsensitiveFs = navigator.platform.startsWith("Mac") || navigator.platform.startsWith("Win");
  const nameExistsIn = useCallback(
    (name: string, folder?: string) => {
      const targetPath = folder ? `${folder}/${name}` : name;
      const cmp = (a: string, b: string) =>
        isCaseInsensitiveFs ? a.toLowerCase() === b.toLowerCase() : a === b;
      const existsAsFile = files.some((f) => cmp(f.relativePath, targetPath));
      const existsAsFolder = folders.some((f) => cmp(f, targetPath));
      return existsAsFile || existsAsFolder;
    },
    [files, folders, isCaseInsensitiveFs],
  );

  // Handlers
  const [nameError, setNameError] = useState("");

  const handleAddFile = () => {
    const name = newFileName.trim();
    if (!name) return;
    if (nameExistsIn(name, addDialogFolder)) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    const type = name.endsWith(".tex") || name.endsWith(".ltx") || name.endsWith(".bib") || name.endsWith(".sty") || name.endsWith(".cls") ? "tex" : "image";
    createNewFile(name, type, addDialogFolder);
    setNewFileName("");
    setNameError("");
    setAddDialogOpen(false);
    setAddDialogFolder(undefined);
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (nameExistsIn(name, folderDialogParent)) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    createFolder(name, folderDialogParent);
    setNewFolderName("");
    setNameError("");
    setFolderDialogOpen(false);
    setFolderDialogParent(undefined);
  };

  const handleImport = async (targetFolder?: string) => {
    const selected = await openDialog({
      multiple: true,
      filters: [
        {
          name: "All Files",
          extensions: ["tex", "bib", "sty", "cls", "bst", "png", "jpg", "jpeg", "gif", "svg", "bmp", "webp", "pdf", "txt", "md"],
        },
      ],
    });
    if (selected && projectRoot) {
      const paths = Array.isArray(selected) ? selected : [selected];
      await importFiles(paths, targetFolder);
    }
  };

  const openRenameDialog = (id: string, name: string) => {
    setRenameFileId(id);
    setRenameValue(name);
    setNameError("");
    setRenameDialogOpen(true);
  };

  const handleRename = () => {
    const name = renameValue.trim();
    if (!renameFileId || !name) return;
    // Check duplicate: find the parent folder of the file being renamed
    const file = files.find((f) => f.id === renameFileId);
    const parentFolder = file?.relativePath.includes("/")
      ? file.relativePath.substring(0, file.relativePath.lastIndexOf("/"))
      : undefined;
    const isSameName = isCaseInsensitiveFs
      ? name.toLowerCase() === file?.name.toLowerCase()
      : name === file?.name;
    if (nameExistsIn(name, parentFolder) && !isSameName) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    renameFile(renameFileId, name);
    setRenameDialogOpen(false);
    setRenameFileId(null);
    setRenameValue("");
    setNameError("");
  };

  const openNewFileDialog = (folder?: string) => {
    setAddDialogFolder(folder);
    setNewFileName("");
    setNameError("");
    setAddDialogOpen(true);
  };

  const openNewFolderDialog = (parent?: string) => {
    setFolderDialogParent(parent);
    setNewFolderName("");
    setNameError("");
    setFolderDialogOpen(true);
  };

  // ─── Render ───

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Header — padded top for macOS overlay titlebar */}
      <div className="relative flex items-center justify-center border-sidebar-border border-b px-3 pt-[var(--titlebar-height)] h-[calc(48px+var(--titlebar-height))]">
        <div className="flex flex-col items-center">
          <span className="font-semibold text-sm">ClaudePrism</span>
          <span className="text-muted-foreground text-xs">
            {projectRoot?.split("/").pop() || "Desktop"}
          </span>
        </div>
        <div className="absolute right-3 flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={closeProject}
            title="Close Project"
          >
            <HomeIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Resizable sections */}
      <PanelGroup direction="vertical" className="min-h-0 flex-1">
        {/* Files */}
        <Panel defaultSize={50} minSize={15}>
          <div ref={sidebarFilesRef} className="flex h-full flex-col" data-sidebar-files>
            <div className="relative flex h-8 shrink-0 items-center justify-center border-sidebar-border border-b px-3">
              <div className="flex items-center gap-2">
                <FolderIcon className="size-3.5 text-muted-foreground" />
                <span className="font-medium text-xs">Files</span>
              </div>
              <div className="absolute right-3 flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5"
                  title="Refresh"
                  onClick={() => refreshFiles()}
                >
                  <RefreshCwIcon className="size-3" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-5" title="Add">
                      <PlusIcon className="size-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openNewFileDialog()}>
                      <FileTextIcon className="mr-2 size-4" />
                      New LaTeX File
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => openNewFolderDialog()}>
                      <FolderPlusIcon className="mr-2 size-4" />
                      New Folder
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => handleImport()}>
                      <UploadIcon className="mr-2 size-4" />
                      Import File
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <DroppableRoot nativeDragOver={nativeDragOver === "__root__"}>
                    {tree.map((node) => (
                      <FileTreeNode
                        key={node.relativePath}
                        node={node}
                        depth={0}
                        activeFileId={activeFileId}
                        expandedFolders={expandedFolders}
                        onToggleFolder={toggleFolder}
                        onSelectFile={(id: string) => {
                          const parent = id.includes("/") ? id.substring(0, id.lastIndexOf("/")) : undefined;
                          setPasteTargetFolder(parent);
                          setActiveFile(id);
                        }}
                        onNewFile={openNewFileDialog}
                        onNewFolder={openNewFolderDialog}
                        onImport={handleImport}
                        onRename={openRenameDialog}
                        onDelete={deleteFile}
                        onDeleteFolder={deleteFolder}
                        fileCount={files.length}
                        nativeDragOver={nativeDragOver}
                      />
                    ))}
                  </DroppableRoot>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => openNewFileDialog()}>
                    <FileTextIcon className="mr-2 size-4" />
                    New File
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => openNewFolderDialog()}>
                    <FolderPlusIcon className="mr-2 size-4" />
                    New Folder
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => handleImport()}>
                    <UploadIcon className="mr-2 size-4" />
                    Import File
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <DragOverlay dropAnimation={null}>
                {activeDrag && (
                  <div className="flex items-center gap-2 rounded-md bg-sidebar px-2 py-1 text-sm shadow-lg ring-1 ring-ring">
                    {activeDrag.type === "folder"
                      ? <FolderIcon className="size-4 shrink-0" />
                      : <FileTextIcon className="size-4 shrink-0" />
                    }
                    <span className="truncate">{activeDrag.name}</span>
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          </div>
        </Panel>

        <PanelResizeHandle className="h-px bg-sidebar-border transition-colors hover:bg-ring data-resize-handle-active:bg-ring" />

        {/* Outline */}
        <Panel defaultSize={20} minSize={10}>
          <div className="flex h-full flex-col">
            <div className="flex h-8 shrink-0 items-center justify-center gap-2 px-3">
              <ListIcon className="size-3.5 text-muted-foreground" />
              <span className="font-medium text-xs">Outline</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {toc.length > 0 ? (
                toc.map((item, index) => (
                  <button
                    key={index}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
                    style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
                    onClick={() => handleTocClick(item.line)}
                  >
                    <HashIcon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{item.title}</span>
                  </button>
                ))
              ) : (
                <div className="px-2 py-1 text-muted-foreground text-xs">
                  No sections found
                </div>
              )}
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="h-px bg-sidebar-border transition-colors hover:bg-ring data-resize-handle-active:bg-ring" />

        {/* Zotero */}
        <Panel defaultSize={15} minSize={10}>
          <div className="flex h-full flex-col">
            <div className="flex h-8 shrink-0 items-center">
              <ZoteroHeader />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ZoteroPanel />
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Environment section — Python + Skills */}
      <EnvironmentSection projectPath={projectRoot} />

      {/* Footer */}
      <div className="flex items-center justify-between border-sidebar-border border-t px-3 py-2 text-muted-foreground text-xs">
        <span className="truncate">ClaudePrism v{APP_VERSION}</span>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" className="size-6" asChild>
            <a
              href="https://github.com/delibae/claude-prism"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub"
            >
              <GithubIcon className="size-3.5" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => {
              if (theme === "system") setTheme("light");
              else if (theme === "light") setTheme("dark");
              else setTheme("system");
            }}
            title={
              theme === "system"
                ? "System theme"
                : theme === "light"
                  ? "Light mode"
                  : "Dark mode"
            }
          >
            {theme === "system" ? (
              <MonitorIcon className="size-3.5" />
            ) : theme === "light" ? (
              <SunIcon className="size-3.5" />
            ) : (
              <MoonIcon className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* New File Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              New File{addDialogFolder ? ` in ${addDialogFolder}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Input
              placeholder="filename.tex"
              value={newFileName}
              onChange={(e) => { setNewFileName(e.target.value); setNameError(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddFile();
              }}
              autoFocus
            />
            {nameError && <p className="text-destructive text-xs">{nameError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddFile} disabled={!newFileName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Folder Dialog */}
      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              New Folder{folderDialogParent ? ` in ${folderDialogParent}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Input
              placeholder="folder name"
              value={newFolderName}
              onChange={(e) => { setNewFolderName(e.target.value); setNameError(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
              }}
              autoFocus
            />
            {nameError && <p className="text-destructive text-xs">{nameError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Input
              value={renameValue}
              onChange={(e) => { setRenameValue(e.target.value); setNameError(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
              autoFocus
            />
            {nameError && <p className="text-destructive text-xs">{nameError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRename}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── File Tree Node ───

// ─── dnd-kit helpers ───

function DroppableRoot({ children, nativeDragOver }: { children: React.ReactNode; nativeDragOver?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "__root__" });
  return (
    <div
      ref={setNodeRef}
      data-drop-folder="__root__"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto p-1",
        (isOver || nativeDragOver) && "bg-accent/30",
      )}
    >
      {children}
    </div>
  );
}

function DroppableFolder({ id, children, nativeDragOver }: { id: string; children: React.ReactNode; nativeDragOver?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} data-drop-folder={id} className={cn((isOver || nativeDragOver) && "bg-accent/30 rounded-md")}>
      {children}
    </div>
  );
}

// ─── File Tree Node ───

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  activeFileId: string;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (id: string) => void;
  onNewFile: (folder?: string) => void;
  onNewFolder: (parent?: string) => void;
  onImport: (folder?: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  fileCount: number;
  nativeDragOver?: string | null;
}

function FileTreeNode({
  node,
  depth,
  activeFileId,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  onNewFile,
  onNewFolder,
  onImport,
  onRename,
  onDelete,
  onDeleteFolder,
  fileCount,
  nativeDragOver,
}: FileTreeNodeProps) {
  const isExpanded = expandedFolders.has(node.relativePath);

  if (node.type === "folder") {
    return (
      <DroppableFolder id={node.relativePath} nativeDragOver={nativeDragOver === node.relativePath}>
        <DraggableItem id={node.relativePath} type="folder" name={node.name}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50"
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
                onClick={() => onToggleFolder(node.relativePath)}
              >
                {isExpanded ? (
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <FolderIcon className="size-4 shrink-0" />
                <span className="truncate">{node.name}</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onNewFile(node.relativePath)}>
                <FileTextIcon className="mr-2 size-4" />
                New File Here
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onNewFolder(node.relativePath)}>
                <FolderPlusIcon className="mr-2 size-4" />
                New Folder
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onImport(node.relativePath)}>
                <UploadIcon className="mr-2 size-4" />
                Import File Here
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => onRename(node.relativePath, node.name)}>
                <PencilIcon className="mr-2 size-4" />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onClick={() => onDeleteFolder(node.relativePath)}
              >
                <Trash2Icon className="mr-2 size-4" />
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </DraggableItem>
        {isExpanded &&
          node.children.map((child) => (
            <FileTreeNode
              key={child.relativePath}
              node={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onImport={onImport}
              onRename={onRename}
              onDelete={onDelete}
              onDeleteFolder={onDeleteFolder}
              fileCount={fileCount}
              nativeDragOver={nativeDragOver}
            />
          ))}
      </DroppableFolder>
    );
  }

  // File node
  const file = node.file!;
  return (
    <DraggableItem id={file.relativePath} type="file" name={node.name}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              file.id === activeFileId
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/50",
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => {
              useHistoryStore.getState().stopReview();
              onSelectFile(file.id);
            }}
          >
            {getFileIcon(file)}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {file.isDirty && (
              <span className="ml-auto shrink-0 size-2 rounded-full bg-blue-500" title="Modified" />
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onRename(file.id, file.name)}>
            <PencilIcon className="mr-2 size-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => onDelete(file.id)}
            disabled={fileCount <= 1}
          >
            <Trash2Icon className="mr-2 size-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </DraggableItem>
  );
}

// ─── Environment Section (Python + Skills) ───

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
  location: string;
}

function EnvironmentSection({ projectPath }: { projectPath: string | null }) {
  // ── Python / uv ──
  const venvReady = useUvSetupStore((s) => s.venvReady);
  const uvStatus = useUvSetupStore((s) => s.status);
  const [showUvDialog, setShowUvDialog] = useState(false);

  // ── Scientific Skills ──
  const [skillsStatus, setSkillsStatus] = useState<SkillsStatus | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const checkSkillsStatus = useCallback(async () => {
    try {
      const globalStatus = await invoke<SkillsStatus>("check_skills_installed", {
        projectPath: null,
      });
      if (globalStatus.installed) {
        setSkillsStatus(globalStatus);
        return;
      }
      if (projectPath) {
        const projectStatus = await invoke<SkillsStatus>("check_skills_installed", {
          projectPath,
        });
        setSkillsStatus(projectStatus);
      } else {
        setSkillsStatus(globalStatus);
      }
    } catch {
      // Ignore errors silently
    }
  }, [projectPath]);

  useEffect(() => {
    checkSkillsStatus();
  }, [checkSkillsStatus]);

  // Lazy import onboarding
  const [OnboardingComponent, setOnboardingComponent] = useState<React.ComponentType<{
    onClose: () => void;
  }> | null>(null);

  useEffect(() => {
    if (showOnboarding && !OnboardingComponent) {
      import("@/components/scientific-skills/scientific-skills-onboarding").then(
        (mod) => setOnboardingComponent(() => mod.ScientificSkillsOnboarding)
      );
    }
  }, [showOnboarding, OnboardingComponent]);

  const pythonLabel =
    venvReady ? "Active" : uvStatus === "not-installed" ? "Not installed" : uvStatus === "ready" ? "No venv" : "";
  const skillsLabel =
    skillsStatus?.installed ? `${skillsStatus.skill_count} skills` : "Not installed";

  return (
    <>
      <div className="border-sidebar-border border-t">
        <div className="flex h-8 shrink-0 items-center justify-center gap-2 px-3">
          <AppWindowIcon className="size-3.5 text-muted-foreground" />
          <span className="font-medium text-xs">Environment</span>
        </div>
        <div className="px-1 pb-1.5 space-y-0.5">
          {/* Python / uv row */}
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50 min-w-0"
            onClick={() => setShowUvDialog(true)}
          >
            <TerminalIcon className={cn("size-3.5 shrink-0", venvReady ? "text-foreground" : "text-muted-foreground")} />
            <span className="min-w-0 truncate text-xs flex-1">Python</span>
            <span className={cn("shrink-0 text-xs", venvReady ? "text-foreground" : "text-muted-foreground")}>
              {pythonLabel}
            </span>
          </button>
          {/* Scientific Skills row */}
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50 min-w-0"
            onClick={() => setShowOnboarding(true)}
          >
            <FlaskConicalIcon className={cn("size-3.5 shrink-0", skillsStatus?.installed ? "text-foreground" : "text-muted-foreground")} />
            <span className="min-w-0 truncate text-xs flex-1">Skills</span>
            <span className={cn("shrink-0 text-xs", skillsStatus?.installed ? "text-foreground" : "text-muted-foreground")}>
              {skillsLabel}
            </span>
          </button>
        </div>
      </div>

      <UvSetupDialog open={showUvDialog} onClose={() => setShowUvDialog(false)} />

      {showOnboarding && OnboardingComponent && (
        <OnboardingComponent
          onClose={() => {
            setShowOnboarding(false);
            checkSkillsStatus();
          }}
        />
      )}
    </>
  );
}

// ─── Draggable wrapper ───

function DraggableItem({ id, type, name, children }: { id: string; type: "file" | "folder"; name: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: { type, name },
  });

  // Wrap listeners to log pointer events
  const wrappedListeners = listeners ? Object.fromEntries(
    Object.entries(listeners).map(([key, handler]) => [
      key,
      (e: React.PointerEvent) => {
        (handler as (e: React.PointerEvent) => void)(e);
      },
    ]),
  ) : {};

  return (
    <div
      ref={setNodeRef}
      {...wrappedListeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      {children}
    </div>
  );
}
