import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  FileTextIcon,
  SpellCheckIcon,
  AlertCircleIcon,
  LoaderIcon,
  RefreshCwIcon,
  MinusIcon,
  PlusIcon,
  DownloadIcon,
  HistoryIcon,
  MousePointerClickIcon,
  CrosshairIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from "lucide-react";
import { writeFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { useDocumentStore, getPdfBytes, getCurrentPdfBytes, hasPdfData } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { HistoryPanel } from "@/components/workspace/history-panel";
import { compileLatex, synctexEdit, resolveCompileTarget, formatCompileError } from "@/lib/latex-compiler";
import { ErrorBoundary } from "react-error-boundary";
import { SelectionToolbar, type ToolbarAction } from "@/components/workspace/editor/selection-toolbar";
import { save } from "@tauri-apps/plugin-dialog";
import { PdfViewer, type PdfTextSelection, type CaptureResult } from "./pdf-viewer";
import { resolveTexRoot } from "@/stores/document-store";

type FitMode = "fit-width" | "fit-height" | null;

/** Per-root zoom state cache: rootFileId → { scale, fitMode } */
const zoomCache = new Map<string, { scale: number; fitMode: FitMode }>();

/** Max number of PdfViewer instances kept alive simultaneously. */
const MAX_ALIVE_VIEWERS = 5;

/** Clear zoom cache (e.g., on project close). */
export function clearZoomCache(): void {
  zoomCache.clear();
}

const ZOOM_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
  { value: "4", label: "400%" },
];

export function PdfPreview() {
  const pdfRevision = useDocumentStore((s) => s.pdfRevision);
  const compileError = useDocumentStore((s) => s.compileError);
  const isCompiling = useDocumentStore((s) => s.isCompiling);
  const isSaving = useDocumentStore((s) => s.isSaving);
  const setPdfData = useDocumentStore((s) => s.setPdfData);
  const setCompileError = useDocumentStore((s) => s.setCompileError);
  const setIsCompiling = useDocumentStore((s) => s.setIsCompiling);
  const content = useDocumentStore((s) => s.content);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const files = useDocumentStore((s) => s.files);
  const saveAllFiles = useDocumentStore((s) => s.saveAllFiles);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const activeFile = useDocumentStore((s) => {
    return s.files.find((f) => f.id === s.activeFileId) ?? null;
  });
  const activeFileType = activeFile?.type ?? "tex";
  const isTexActive = activeFileType === "tex";
  const requestJumpToPosition = useDocumentStore(
    (s) => s.requestJumpToPosition,
  );

  const [pdfError, setPdfError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageInputValue, setPageInputValue] = useState<string>("1");
  const [isEditingPage, setIsEditingPage] = useState(false);
  const scrollToPageRef = useRef<((page: number) => void) | null>(null);
  const [scale, setScale] = useState<number>(1.0);
  const [captureMode, setCaptureMode] = useState(false);
  const [fitMode, setFitMode] = useState<FitMode>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);
  const [firstPageSize, setFirstPageSize] = useState<{ width: number; height: number } | null>(null);
  const hasInitialCompile = useRef(false);
  const initialized = useDocumentStore((s) => s.initialized);

  // Derive pdfData from external cache, re-read whenever pdfRevision bumps
  const pdfData = useMemo(() => getCurrentPdfBytes(), [pdfRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep-alive: track which root files have PdfViewer instances alive (LRU order)
  const currentRootFileId = resolveTexRoot(activeFile?.id ?? "", files);
  const [aliveOrder, setAliveOrder] = useState<string[]>([]);
  const prevRootRef = useRef(currentRootFileId);

  // Save/restore zoom state per root file on switch
  useEffect(() => {
    const prev = prevRootRef.current;
    if (prev && prev !== currentRootFileId) {
      // Save previous root's zoom
      zoomCache.set(prev, { scale, fitMode });
    }
    // Restore new root's zoom
    const cached = zoomCache.get(currentRootFileId);
    if (cached) {
      setScale(cached.scale);
      setFitMode(cached.fitMode);
    }
    prevRootRef.current = currentRootFileId;
  }, [currentRootFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update alive set when active root changes and has PDF data
  useEffect(() => {
    if (!currentRootFileId || !pdfData) return;
    setAliveOrder((prev) => {
      if (prev[0] === currentRootFileId) return prev; // already at front
      const without = prev.filter((id) => id !== currentRootFileId);
      return [currentRootFileId, ...without].slice(0, MAX_ALIVE_VIEWERS);
    });
  }, [currentRootFileId, pdfData]);

  // PDF text selection toolbar
  const [pdfSelection, setPdfSelection] = useState<PdfTextSelection | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  const handleTextClick = useCallback(
    (text: string) => {
      let index = content.indexOf(text);
      if (index === -1) {
        const cleanText = text.replace(/[{}\\$]/g, "");
        if (cleanText.length > 2) index = content.indexOf(cleanText);
      }
      if (index === -1 && text.length > 5) {
        const words = text.split(/\s+/).filter((w) => w.length > 3);
        for (const word of words) {
          index = content.indexOf(word);
          if (index !== -1) break;
        }
      }
      if (index !== -1) requestJumpToPosition(index);
    },
    [content, requestJumpToPosition],
  );

  const handleSynctexClick = useCallback(
    async (page: number, x: number, y: number) => {
      if (!projectRoot) return;
      const result = await synctexEdit(projectRoot, page, x, y);
      if (!result) return;

      const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
      const normalizedTarget = normalize(result.file);
      const targetFile = files.find(
        (f) => normalize(f.relativePath) === normalizedTarget,
      );
      if (!targetFile) return;

      const state = useDocumentStore.getState();
      const needsSwitch = state.activeFileId !== targetFile.id;
      if (needsSwitch) {
        setActiveFile(targetFile.id);
      }

      const fileContent = targetFile.content ?? "";
      const fileLines = fileContent.split("\n");
      const targetLine = Math.max(1, Math.min(result.line, fileLines.length));
      let offset = 0;
      for (let i = 0; i < targetLine - 1; i++) {
        offset += fileLines[i].length + 1;
      }
      if (result.column > 0) {
        offset += Math.min(result.column, fileLines[targetLine - 1]?.length ?? 0);
      }

      if (needsSwitch) {
        setTimeout(() => requestJumpToPosition(offset), 100);
      } else {
        requestJumpToPosition(offset);
      }
    },
    [projectRoot, files, setActiveFile, requestJumpToPosition],
  );

  // Resolved source location from synctex
  const [resolvedSource, setResolvedSource] = useState<{
    file: string;
    line: number;
    column: number;
  } | null>(null);

  const handleTextSelect = useCallback((selection: PdfTextSelection | null) => {
    setPdfSelection(selection);
    setResolvedSource(null);
  }, []);

  // When PDF selection changes, resolve source via synctex
  useEffect(() => {
    if (!pdfSelection || !projectRoot) return;
    let cancelled = false;
    synctexEdit(projectRoot, pdfSelection.pageNumber, pdfSelection.pdfX, pdfSelection.pdfY)
      .then((result) => {
        if (cancelled || !result) return;
        setResolvedSource(result);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pdfSelection, projectRoot]);

  const pdfContextLabel = resolvedSource
    ? `~@${resolvedSource.file}:${resolvedSource.line}`
    : pdfSelection
      ? `~@PDF page ${pdfSelection.pageNumber}`
      : "";

  const navigateToSource = useCallback(() => {
    if (!resolvedSource) return;
    const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
    const normalizedTarget = normalize(resolvedSource.file);
    const targetFile = files.find(
      (f) => normalize(f.relativePath) === normalizedTarget,
    );
    if (!targetFile) return;

    const state = useDocumentStore.getState();
    const needsSwitch = state.activeFileId !== targetFile.id;
    if (needsSwitch) setActiveFile(targetFile.id);

    const fileContent = targetFile.content ?? "";
    const fileLines = fileContent.split("\n");
    const targetLine = Math.max(1, Math.min(resolvedSource.line, fileLines.length));
    let offset = 0;
    for (let i = 0; i < targetLine - 1; i++) {
      offset += fileLines[i].length + 1;
    }
    if (resolvedSource.column > 0) {
      offset += Math.min(resolvedSource.column, fileLines[targetLine - 1]?.length ?? 0);
    }

    if (needsSwitch) {
      setTimeout(() => requestJumpToPosition(offset), 100);
    } else {
      requestJumpToPosition(offset);
    }
  }, [resolvedSource, files, setActiveFile, requestJumpToPosition]);

  const buildPdfContext = useCallback((text: string) => {
    const locationNote = resolvedSource
      ? `near ${resolvedSource.file}:${resolvedSource.line}`
      : pdfSelection
        ? `PDF page ${pdfSelection.pageNumber}`
        : "PDF";
    return `[Selected from PDF output, approximate source location: ${locationNote}]\n${text}`;
  }, [resolvedSource, pdfSelection]);

  const handlePdfToolbarSendPrompt = useCallback(
    (prompt: string) => {
      if (!pdfSelection) return;
      const label = pdfContextLabel;
      const sel = pdfSelection;
      setPdfSelection(null);
      window.getSelection()?.removeAllRanges();
      useClaudeChatStore.getState().sendPrompt(prompt, {
        label,
        filePath: resolvedSource?.file ?? "document.pdf",
        selectedText: buildPdfContext(sel.text),
      });
    },
    [pdfSelection, pdfContextLabel, resolvedSource, buildPdfContext],
  );

  const pdfToolbarActions: ToolbarAction[] = useMemo(() => [
    { id: "proofread", label: "Proofread", icon: <SpellCheckIcon className="size-4" /> },
    { id: "navigate", label: "Navigate to source", icon: <FileTextIcon className="size-4" />, hint: "dbl-click" },
  ], []);

  const handlePdfToolbarAction = useCallback(
    (actionId: string) => {
      if (!pdfSelection) return;
      const label = pdfContextLabel;
      const sel = pdfSelection;
      setPdfSelection(null);
      window.getSelection()?.removeAllRanges();
      if (actionId === "proofread") {
        useClaudeChatStore.getState().sendPrompt("Proofread and fix any errors in this text", {
          label,
          filePath: resolvedSource?.file ?? "document.pdf",
          selectedText: buildPdfContext(sel.text),
        });
      } else if (actionId === "navigate") {
        navigateToSource();
      }
    },
    [pdfSelection, pdfContextLabel, resolvedSource, navigateToSource, buildPdfContext],
  );

  const handlePdfToolbarDismiss = useCallback(() => {
    setPdfSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const pdfToolbarPosition = (() => {
    if (!pdfSelection || !previewContainerRef.current) return null;
    const containerRect = previewContainerRef.current.getBoundingClientRect();
    const relTop = pdfSelection.position.top - containerRect.top + 4;
    const relLeft = Math.max(8, Math.min(
      pdfSelection.position.left - containerRect.left,
      containerRect.width - 272,
    ));
    return { top: relTop, left: relLeft };
  })();

  useEffect(() => {
    if (hasInitialCompile.current) return;
    if (!initialized || !projectRoot) return;
    if (pdfData || isCompiling || compileError) return;

    hasInitialCompile.current = true;

    const compile = async () => {
      setIsCompiling(true);
      try {
        await saveAllFiles();
        const { files: allFiles, activeFileId } = useDocumentStore.getState();
        const resolved = resolveCompileTarget(activeFileId, allFiles);
        if (!resolved) {
          setCompileError("No .tex file found in this project. Create a main.tex file to compile.");
          return;
        }
        const { rootId, targetPath } = resolved;
        const data = await compileLatex(projectRoot, targetPath);
        setPdfData(data, rootId);
      } catch (error) {
        setCompileError(formatCompileError(error));
      } finally {
        setIsCompiling(false);
      }
    };
    compile();
  }, [initialized, projectRoot, pdfData, isCompiling, compileError, setIsCompiling, setPdfData, setCompileError, saveAllFiles, files, activeFile]);

  // Recompute scale when fit mode is active and container/page size changes
  useEffect(() => {
    if (!fitMode || !containerSize || !firstPageSize) return;
    const PADDING = 32; // p-4 on each side
    if (fitMode === "fit-width") {
      const newScale = (containerSize.width - PADDING) / firstPageSize.width;
      setScale(Math.max(0.25, Math.min(4, newScale)));
    } else if (fitMode === "fit-height") {
      const newScale = (containerSize.height - PADDING) / firstPageSize.height;
      setScale(Math.max(0.25, Math.min(4, newScale)));
    }
  }, [fitMode, containerSize, firstPageSize]);

  const zoomIn = () => { setFitMode(null); setScale((s) => Math.min(4, s + 0.1)); };
  const zoomOut = () => { setFitMode(null); setScale((s) => Math.max(0.25, s - 0.1)); };

  const handleExport = async () => {
    const currentPdf = getCurrentPdfBytes();
    if (!currentPdf) return;
    const mainFile = files.find((f) => f.name === "main.tex" || f.name === "document.tex");
    const defaultName = mainFile
      ? mainFile.name.replace(/\.tex$/, ".pdf")
      : "document.pdf";
    const filePath = await save({
      title: "Export PDF",
      defaultPath: defaultName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!filePath) return;
    await writeFile(filePath, new Uint8Array(currentPdf));
  };

  const handleCurrentPageChange = useCallback((page: number) => {
    setCurrentPage((prev) => {
      if (prev === page) return prev;
      if (!isEditingPage) setPageInputValue(String(page));
      return page;
    });
  }, [isEditingPage]);

  const goToPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(numPages, page));
    scrollToPageRef.current?.(clamped);
  }, [numPages]);

  const handlePageInputCommit = useCallback(() => {
    setIsEditingPage(false);
    const parsed = parseInt(pageInputValue, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= numPages) {
      goToPage(parsed);
    } else {
      setPageInputValue(String(currentPage));
    }
  }, [pageInputValue, numPages, currentPage, goToPage]);

  const handleLoadSuccess = (pages: number) => setNumPages(pages);
  const handleScaleChange = (newScale: number) => { setFitMode(null); setScale(newScale); };

  const handleCompile = async () => {
    // Read all guard values from the store to avoid stale closures
    const state = useDocumentStore.getState();
    if (!state.projectRoot) return;
    if (state.isCompiling) {
      // Queue a recompile after the current one finishes
      state.setPendingRecompile(true);
      return;
    }
    const allFiles = state.files;
    const activeFileId = state.activeFileId;
    const activeEntry = allFiles.find((f) => f.id === activeFileId);
    if (!activeEntry || activeEntry.type !== "tex") return;
    const resolved = resolveCompileTarget(activeFileId, allFiles);
    if (!resolved) {
      setCompileError("No .tex file found in this project. Create a main.tex file to compile.");
      return;
    }
    const { rootId, targetPath: targetFile } = resolved;
    // Skip recompile if no edits since last successful compile of this root
    const lastGen = state.lastCompiledGenerations.get(rootId);
    if (hasPdfData() && lastGen !== undefined && state.contentGeneration === lastGen) return;
    useHistoryStore.getState().stopReview();
    setIsCompiling(true);
    state.setPendingRecompile(false);
    setPdfError(null);
    try {
      await saveAllFiles();
      const data = await compileLatex(state.projectRoot, targetFile);
      setPdfData(data, rootId);
    } catch (error) {
      setCompileError(formatCompileError(error), rootId);
    } finally {
      setIsCompiling(false);
      // If a recompile was requested while we were compiling, trigger it now
      // Use setTimeout to avoid unbounded recursion on the call stack
      if (useDocumentStore.getState().pendingRecompile) {
        setTimeout(() => handleCompile(), 0);
      }
    }
  };

  const handleCapture = async (result: CaptureResult) => {
    setCaptureMode(false);
    if (!projectRoot) return;

    const fileName = `capture-p${result.pageNumber}-${Date.now()}.png`;
    const relativePath = `attachments/${fileName}`;

    try {
      const attachmentsDir = await join(projectRoot, "attachments");
      if (!(await exists(attachmentsDir))) {
        await mkdir(attachmentsDir, { recursive: true });
      }
      const fullPath = await join(projectRoot, relativePath);

      const base64 = result.dataUrl.split(",")[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      await writeFile(fullPath, bytes);

      await useDocumentStore.getState().refreshFiles();

      useClaudeChatStore.getState().addPendingAttachment({
        label: `@${relativePath}`,
        filePath: relativePath,
        selectedText: `[Captured region from PDF page ${result.pageNumber}]`,
        imageDataUrl: result.dataUrl,
      });
    } catch (err) {
      console.error("[capture] failed to save:", err);
    }
  };

  // Listen for global Capture & Ask shortcut (Cmd+X / Ctrl+X)
  useEffect(() => {
    const handleToggleCapture = () => {
      if (pdfData) setCaptureMode((prev) => !prev);
    };
    window.addEventListener("toggle-capture-mode", handleToggleCapture);
    return () => window.removeEventListener("toggle-capture-mode", handleToggleCapture);
  }, [pdfData]);

  const renderContent = () => {
    if (compileError) {
      const errors = [...new Set(
        compileError
          .split(/\s*!\s*/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s !== "Compilation failed"),
      )];

      const handleFixWithChat = () => {
        const errorList = errors.map((e) => `- ${e}`).join("\n");
        useClaudeChatStore.getState().sendPrompt(
          `[Compilation errors]\n${errorList}\n\nFix these LaTeX compilation errors.`,
        );
      };

      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-6">
          <div className="w-full max-w-lg">
            <div className="mb-4 flex items-center gap-2 text-destructive">
              <AlertCircleIcon className="size-5" />
              <h2 className="font-semibold text-base">Compilation Failed</h2>
              <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium">
                {errors.length} {errors.length === 1 ? "error" : "errors"}
              </span>
            </div>
            <div className="rounded-lg border border-destructive/20 bg-background">
              <div className="max-h-60 overflow-y-auto divide-y divide-border">
                {errors.map((error, i) => (
                  <div key={i} className="flex items-start gap-2.5 px-3 py-2.5">
                    <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive/70" />
                    <span className="text-sm text-foreground">{error}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={handleFixWithChat}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                <MousePointerClickIcon className="size-3.5" />
                Fix with Chat
              </button>
              <button
                onClick={handleCompile}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <RefreshCwIcon className="size-3.5" />
                Retry
              </button>
            </div>
          </div>
        </div>
      );
    }
    if (!pdfData) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <FileTextIcon className="mb-4 size-16 text-muted-foreground/50" />
          <h2 className="mb-2 font-medium text-lg text-muted-foreground">PDF Preview</h2>
          <p className="mb-4 text-center text-muted-foreground text-sm">Press ⌘+Enter to compile your document</p>
          {isTexActive && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleCompile}>
              <RefreshCwIcon className="size-3.5" />
              Compile
            </Button>
          )}
        </div>
      );
    }
    if (pdfError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <AlertCircleIcon className="mb-4 size-12 text-destructive" />
          <h2 className="mb-2 font-medium text-destructive text-lg">PDF Load Error</h2>
          <p className="max-w-md text-center text-muted-foreground text-sm">{pdfError}</p>
        </div>
      );
    }

    // Keep-alive rendering: one PdfViewer per root file, toggle via CSS.
    // Use visibility:hidden + absolute positioning instead of display:none
    // so that the browser preserves scrollTop on the overflow container.
    return (
      <div className="relative flex min-h-0 flex-1">
        {aliveOrder.map((rootId) => {
          const data = getPdfBytes(rootId);
          if (!data) return null;
          const isActive = rootId === currentRootFileId;
          return (
            <ErrorBoundary
              key={rootId}
              fallback={
                <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/30 p-8">
                  <AlertCircleIcon className="size-10 text-destructive" />
                  <p className="text-sm text-muted-foreground">PDF viewer crashed. Try recompiling.</p>
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={handleCompile}>
                    <RefreshCwIcon className="size-3.5" />
                    Recompile
                  </Button>
                </div>
              }
            >
              <div
                className={
                  isActive
                    ? "absolute inset-0 flex flex-col"
                    : "invisible pointer-events-none absolute inset-0 flex flex-col"
                }
              >
                <PdfViewer
                  data={data}
                  scale={scale}
                  rootFileId={rootId}
                  isActive={isActive}
                  onError={isActive ? setPdfError : undefined}
                  onLoadSuccess={isActive ? handleLoadSuccess : undefined}
                  onScaleChange={isActive ? handleScaleChange : undefined}
                  onTextClick={isActive ? handleTextClick : undefined}
                  onSynctexClick={isActive ? handleSynctexClick : undefined}
                  onTextSelect={isActive ? handleTextSelect : undefined}
                  onFirstPageSize={isActive ? (w, h) => setFirstPageSize({ width: w, height: h }) : undefined}
                  onContainerResize={isActive ? (w, h) => setContainerSize({ width: w, height: h }) : undefined}
                  onCurrentPageChange={isActive ? handleCurrentPageChange : undefined}
                  scrollToPageRef={isActive ? scrollToPageRef : undefined}
                  captureMode={isActive ? captureMode : false}
                  onCapture={isActive ? handleCapture : undefined}
                  onCancelCapture={isActive ? () => setCaptureMode(false) : undefined}
                />
              </div>
            </ErrorBoundary>
          );
        })}
      </div>
    );
  };

  return (
    <div ref={previewContainerRef} className="@container/pv relative flex h-full flex-col bg-muted/50">
      <div className="flex shrink-0 items-center border-border border-b bg-background px-2 pt-[var(--titlebar-height)] h-[calc(40px+var(--titlebar-height))]">
        <div className="flex items-center gap-1">
          {isSaving && (
            <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1">
              <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground text-xs font-medium">Saving...</span>
            </div>
          )}
          {!isSaving && isCompiling && (
            <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1">
              <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground text-xs font-medium">Compiling...</span>
            </div>
          )}
          {!isSaving && !isCompiling && !compileError && isTexActive && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={handleCompile}>
              <RefreshCwIcon className="size-3.5" />
              {pdfData ? "Recompile" : "Compile"}
            </Button>
          )}
          {!isSaving && !isCompiling && compileError && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2.5 text-xs text-destructive hover:text-destructive" onClick={handleCompile} disabled={!isTexActive}>
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
          )}
        </div>
        <div data-tauri-drag-region className="flex-1 self-stretch" />
        <div className="flex shrink-0 items-center gap-1">
          {pdfData && (
            <>
              <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} title="Page Up">
                <ChevronUpIcon className="size-3.5" />
              </Button>
              {isEditingPage ? (
                <input
                  autoFocus
                  type="text"
                  inputMode="numeric"
                  className="h-6 w-8 shrink-0 rounded border border-border bg-background text-center text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                  value={pageInputValue}
                  onChange={(e) => setPageInputValue(e.target.value)}
                  onBlur={handlePageInputCommit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handlePageInputCommit();
                    if (e.key === "Escape") {
                      setIsEditingPage(false);
                      setPageInputValue(String(currentPage));
                    }
                  }}
                />
              ) : (
                <button
                  className="flex h-6 min-w-[2rem] shrink-0 items-center justify-center rounded px-1 text-xs text-muted-foreground tabular-nums hover:bg-muted"
                  onClick={() => { setIsEditingPage(true); setPageInputValue(String(currentPage)); }}
                  title="Click to jump to page"
                >
                  {currentPage}
                </button>
              )}
              <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs">/ {numPages}</span>
              <Button variant="ghost" size="icon" className="size-7" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= numPages} title="Page Down">
                <ChevronDownIcon className="size-3.5" />
              </Button>
              <div className="mx-1 h-4 w-px bg-border" />
              <Button variant="ghost" size="icon" className="size-7" onClick={zoomOut} disabled={scale <= 0.25}><MinusIcon className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" className="size-7" onClick={zoomIn} disabled={scale >= 4}><PlusIcon className="size-3.5" /></Button>
              <Select
                value={fitMode ?? scale.toString()}
                onValueChange={(v) => {
                  if (v === "fit-width" || v === "fit-height") {
                    setFitMode(v);
                  } else {
                    setFitMode(null);
                    setScale(Number(v));
                  }
                }}
              >
                <SelectTrigger size="sm" className="h-7! w-auto text-xs">
                  <SelectValue>
                    {fitMode === "fit-width" ? "Fit width" : fitMode === "fit-height" ? "Fit height" : `${Math.round(scale * 100)}%`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectItem value="fit-width">Fit to width</SelectItem>
                  <SelectItem value="fit-height">Fit to height</SelectItem>
                  <SelectSeparator />
                  {ZOOM_OPTIONS.map((opt) => (<SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>))}
                </SelectContent>
              </Select>
              <div className="mx-1 h-4 w-px bg-border" />
              {/* Capture mode */}
              <Button
                variant={captureMode ? "default" : "secondary"}
                size="sm"
                className={`h-7 gap-1.5 px-2 text-xs ${
                  captureMode
                    ? "ring-2 ring-primary/30"
                    : "bg-foreground text-background hover:bg-foreground/90"
                }`}
                onClick={() => setCaptureMode(!captureMode)}
                title={`Capture & Ask (${navigator.userAgent.includes("Mac") ? "⌘X" : "Ctrl+X"})`}
              >
                <CrosshairIcon className="size-3.5 shrink-0" />
                <span className="hidden @[36rem]/pv:inline">Capture & Ask</span>
                <kbd className="pointer-events-none ml-0.5 hidden rounded border border-background/30 bg-background/20 px-1 py-0.5 text-[10px] font-medium leading-none text-background @[36rem]/pv:inline">
                  {navigator.userAgent.includes("Mac") ? "⌘X" : "Ctrl+X"}
                </kbd>
              </Button>
              <div className="mx-1 h-4 w-px bg-border" />
              <Button variant="ghost" size="icon" className="size-7" onClick={handleExport} title="Export PDF">
                <DownloadIcon className="size-3.5" />
              </Button>
            </>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" title="History">
                <HistoryIcon className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96">
              <HistoryPanel maxHeight="max-h-[32rem]" />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {renderContent()}
      {/* PDF selection toolbar */}
      {pdfToolbarPosition && pdfSelection && (
        <SelectionToolbar
          position={pdfToolbarPosition}
          contextLabel={pdfContextLabel}
          actions={pdfToolbarActions}
          onSendPrompt={handlePdfToolbarSendPrompt}
          onAction={handlePdfToolbarAction}
          onDismiss={handlePdfToolbarDismiss}
        />
      )}
      {/* Capture mode floating banner */}
      {captureMode && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur-sm">
            <CrosshairIcon className="size-3.5 text-primary" />
            <span className="text-xs text-foreground">
              Drag to select a region
            </span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              ESC
            </kbd>
            <span className="text-[10px] text-muted-foreground">or</span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+"}X
            </kbd>
            <span className="text-[10px] text-muted-foreground">to cancel</span>
          </div>
        </div>
      )}
    </div>
  );
}
