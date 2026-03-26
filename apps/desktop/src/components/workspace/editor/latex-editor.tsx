import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  scrollPastEnd,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
  toggleComment,
} from "@codemirror/commands";
import { syntaxHighlighting, syntaxTreeAvailable } from "@codemirror/language";
import { oneDark, oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { defaultHighlightStyle } from "@codemirror/language";
import { useTheme } from "next-themes";
import {
  search,
  highlightSelectionMatches,
  SearchQuery,
  setSearchQuery as setSearchQueryEffect,
  findNext,
  findPrevious,
} from "@codemirror/search";
import {
  unifiedMergeView,
  getChunks,
  acceptChunk,
  rejectChunk,
} from "@codemirror/merge";
import { latex, latexLinter } from "codemirror-lang-latex";
import { bibtex } from "./lang-bibtex";
import {
  linter,
  lintGutter,
  forEachDiagnostic,
  type Diagnostic,
} from "@codemirror/lint";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import {
  useProposedChangesStore,
  type ProposedChange,
} from "@/stores/proposed-changes-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useHistoryStore, type FileDiff } from "@/stores/history-store";
import {
  compileLatex,
  resolveCompileTarget,
  formatCompileError,
} from "@/lib/latex-compiler";
import { useSettingsStore } from "@/stores/settings-store";
import { EditorToolbar } from "./editor-toolbar";
import { SelectionToolbar, type ToolbarAction } from "./selection-toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  SpellCheckIcon,
  RotateCcwIcon,
  TagIcon,
  CopyIcon,
  XIcon,
} from "lucide-react";
import { ClaudeChatDrawer } from "@/components/claude-chat/claude-chat-drawer";
import { ProposedChangesPanel } from "@/components/claude-chat/proposed-changes-panel";
import { ImagePreview } from "./image-preview";
import { SearchPanel } from "./search-panel";
import { ProblemsPanel, type DiagnosticItem } from "./problems-panel";
import { PdfViewer } from "@/components/workspace/preview/pdf-viewer";
import { readFile } from "@tauri-apps/plugin-fs";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("merge-view");

function getActiveFileContent(): string {
  const state = useDocumentStore.getState();
  const activeFile = state.files.find((f) => f.id === state.activeFileId);
  return activeFile?.content ?? "";
}

/** Per-file editor state cache: fileId → { cursor, scrollTop } */
const editorStateCache = new Map<
  string,
  { cursor: number; scrollTop: number }
>();

/** Clear editor state cache (e.g., on project close). */
export function clearEditorStateCache(): void {
  editorStateCache.clear();
}

export function LatexEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const files = useDocumentStore((s) => s.files);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const setContent = useDocumentStore((s) => s.setContent);
  const setCursorPosition = useDocumentStore((s) => s.setCursorPosition);
  const setSelectionRange = useDocumentStore((s) => s.setSelectionRange);
  const jumpToPosition = useDocumentStore((s) => s.jumpToPosition);
  const clearJumpRequest = useDocumentStore((s) => s.clearJumpRequest);

  const setIsCompiling = useDocumentStore((s) => s.setIsCompiling);
  const setPdfData = useDocumentStore((s) => s.setPdfData);
  const setCompileError = useDocumentStore((s) => s.setCompileError);
  const saveAllFiles = useDocumentStore((s) => s.saveAllFiles);

  const activeFile = files.find((f) => f.id === activeFileId);
  const isTextFile =
    activeFile?.type === "tex" ||
    activeFile?.type === "bib" ||
    activeFile?.type === "style" ||
    activeFile?.type === "other";
  const activeFileContent = activeFile?.content;
  const isLargeFileNotLoaded =
    isTextFile && activeFileContent === undefined && !!activeFile;
  const loadFileContent = useDocumentStore((s) => s.loadFileContent);

  // History review state
  const reviewingSnapshot = useHistoryStore((s) => s.reviewingSnapshot);
  const historyDiffResult = useHistoryStore((s) => s.diffResult);

  const [imageScale, setImageScale] = useState(1.0);
  const [cropMode, setCropMode] = useState(false);

  // Reset scale and crop mode when switching files
  useEffect(() => {
    setImageScale(1.0);
    setCropMode(false);
  }, [activeFileId]);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [mergeChunkInfo, setMergeChunkInfo] = useState({
    total: 0,
    current: 0,
  });
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [selectionCoords, setSelectionCoords] = useState<{
    top: number;
    left: number;
  } | null>(null);
  // When the selection toolbar is visible, prevent CM selection changes from clearing it.
  // Only explicit dismiss/send/action should clear the toolbar.
  const toolbarStickyRef = useRef(false);
  const parentRef = useRef<HTMLDivElement>(null);

  const { resolvedTheme } = useTheme();

  const compileRef = useRef<() => void>(() => {});
  const isSearchOpenRef = useRef(false);
  const themeCompartmentRef = useRef(new Compartment());
  const mergeCompartmentRef = useRef(new Compartment());
  const isMergeActiveRef = useRef(false);
  const pendingChangeRef = useRef<ProposedChange | null>(null);
  const handleKeepAllRef = useRef<() => void>(() => {});
  const handleUndoAllRef = useRef<() => void>(() => {});
  const diagnosticsRef = useRef<DiagnosticItem[]>([]);

  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
  }, [isSearchOpen]);

  // Proposed changes for active file
  const proposedChanges = useProposedChangesStore((s) => s.changes);
  const activeFileChange = useMemo(() => {
    if (!activeFile) return null;
    return (
      proposedChanges.find((c) => c.filePath === activeFile.relativePath) ??
      null
    );
  }, [proposedChanges, activeFile]);

  // Keep all changes (⌘Y)
  handleKeepAllRef.current = () => {
    const view = viewRef.current;
    const change = pendingChangeRef.current;
    if (!view || !change) return;
    isMergeActiveRef.current = false;
    setMergeChunkInfo({ total: 0, current: 0 });
    view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
    setContent(change.newContent);
    useProposedChangesStore.getState().keepChange(change.id);
    pendingChangeRef.current = null;
    // Auto-navigate to next file with pending changes (only if file exists)
    const remaining = useProposedChangesStore.getState().changes;
    if (remaining.length > 0) {
      const docStore = useDocumentStore.getState();
      const nextFile = remaining.find((c) =>
        docStore.files.some((f) => f.relativePath === c.filePath),
      );
      if (nextFile) {
        docStore.setActiveFile(nextFile.filePath);
      }
    }
  };

  // Undo all changes (⌘N)
  handleUndoAllRef.current = () => {
    const view = viewRef.current;
    const change = pendingChangeRef.current;
    if (!view || !change) return;
    isMergeActiveRef.current = false;
    setMergeChunkInfo({ total: 0, current: 0 });
    view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: change.oldContent,
      },
      annotations: Transaction.addToHistory.of(false),
    });
    setContent(change.oldContent);
    useProposedChangesStore.getState().undoChange(change.id);
    pendingChangeRef.current = null;
    // Auto-navigate to next file with pending changes (only if file exists)
    const remaining = useProposedChangesStore.getState().changes;
    if (remaining.length > 0) {
      const docStore = useDocumentStore.getState();
      const nextFile = remaining.find((c) =>
        docStore.files.some((f) => f.relativePath === c.filePath),
      );
      if (nextFile) {
        docStore.setActiveFile(nextFile.filePath);
      }
    }
  };

  // Navigate to a specific chunk by index
  const goToChunk = (index: number) => {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getChunks(view.state);
    if (!chunks || index < 0 || index >= chunks.chunks.length) return;
    const chunk = chunks.chunks[index];
    view.dispatch({
      selection: { anchor: chunk.fromB },
      effects: EditorView.scrollIntoView(chunk.fromB, { y: "center" }),
    });
    view.focus();
  };

  // After individual accept/reject, navigate to next chunk or auto-resolve
  const afterChunkAction = (view: EditorView, prevIdx: number) => {
    const remaining = getChunks(view.state);
    if (!remaining || remaining.chunks.length === 0) {
      // All chunks resolved — clean up merge view
      const change = pendingChangeRef.current;
      if (change) {
        isMergeActiveRef.current = false;
        setMergeChunkInfo({ total: 0, current: 0 });
        const finalContent = view.state.doc.toString();
        view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
        setContent(finalContent);
        if (finalContent === change.oldContent) {
          useProposedChangesStore.getState().undoChange(change.id);
        } else {
          useProposedChangesStore.getState().keepChange(change.id);
        }
        pendingChangeRef.current = null;
        // Auto-navigate to next file with pending changes
        const pendingChanges = useProposedChangesStore.getState().changes;
        if (pendingChanges.length > 0) {
          useDocumentStore.getState().setActiveFile(pendingChanges[0].filePath);
        }
      }
    } else {
      // Focus the next remaining chunk
      const nextIdx = Math.min(prevIdx, remaining.chunks.length - 1);
      const next = remaining.chunks[nextIdx];
      view.dispatch({
        selection: { anchor: next.fromB },
        effects: EditorView.scrollIntoView(next.fromB, { y: "center" }),
      });
    }
    view.focus();
  };

  const acceptCurrentChunk = () => {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getChunks(view.state);
    const idx = mergeChunkInfo.current - 1;
    if (!chunks || idx < 0 || idx >= chunks.chunks.length) return;
    acceptChunk(view, chunks.chunks[idx].fromB);
    afterChunkAction(view, idx);
  };

  const rejectCurrentChunk = () => {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getChunks(view.state);
    const idx = mergeChunkInfo.current - 1;
    if (!chunks || idx < 0 || idx >= chunks.chunks.length) return;
    rejectChunk(view, chunks.chunks[idx].fromB);
    afterChunkAction(view, idx);
  };

  useEffect(() => {
    if (!searchQuery || !activeFileContent) {
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    const regex = new RegExp(
      searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    const matches = activeFileContent.match(regex);
    setMatchCount(matches?.length ?? 0);
    setCurrentMatch(matches && matches.length > 0 ? 1 : 0);
  }, [searchQuery, activeFileContent]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const query = new SearchQuery({
      search: searchQuery,
      caseSensitive: false,
      literal: true,
    });
    view.dispatch({ effects: setSearchQueryEffect.of(query) });
    if (searchQuery) findNext(view);
  }, [searchQuery]);

  const handleFindNext = () => {
    const view = viewRef.current;
    if (view) {
      findNext(view);
      view.focus();
    }
  };
  const handleFindPrevious = () => {
    const view = viewRef.current;
    if (view) {
      findPrevious(view);
      view.focus();
    }
  };

  // Compile: save all files first, then compile via Tauri command
  compileRef.current = async () => {
    const state = useDocumentStore.getState();
    if (!projectRoot || activeFile?.type !== "tex") return;
    if (state.isCompiling) {
      // Queue a recompile after the current one finishes
      state.setPendingRecompile(true);
      return;
    }
    const { files: allFiles } = state;
    const resolved = resolveCompileTarget(activeFile.id, allFiles);
    if (!resolved) {
      setCompileError(
        "No .tex file found in this project. Create a main.tex file to compile.",
        activeFile.id,
      );
      return;
    }
    const { rootId, targetPath } = resolved;
    useHistoryStore.getState().stopReview();
    setIsCompiling(true);
    state.setPendingRecompile(false);
    const compileStart = Date.now();
    try {
      await saveAllFiles();
      // Pre-compile snapshot (fire-and-forget to avoid blocking compilation start)
      useHistoryStore
        .getState()
        .createSnapshot(projectRoot, "[compile] Pre-compile")
        .catch(() => {});
      const useTexlive =
        useSettingsStore.getState().compilerBackend === "texlive";
      const data = await compileLatex(projectRoot, targetPath, useTexlive);
      setPdfData(data, rootId);
    } catch (error) {
      setCompileError(formatCompileError(error), rootId);
    } finally {
      // Ensure the spinner is visible for at least 500ms for visual feedback
      const elapsed = Date.now() - compileStart;
      if (elapsed < 500) {
        await new Promise((r) => setTimeout(r, 500 - elapsed));
      }
      setIsCompiling(false);
      // If a recompile was requested while we were compiling, trigger it now
      // Use setTimeout to avoid unbounded recursion on the call stack
      if (useDocumentStore.getState().pendingRecompile) {
        setTimeout(() => compileRef.current?.(), 0);
      }
    }
  };

  useEffect(() => {
    if (!containerRef.current || !isTextFile) return;
    const currentContent = getActiveFileContent();

    const updateListener = EditorView.updateListener.of((update) => {
      if (isMergeActiveRef.current) {
        const chunks = getChunks(update.state);
        if (chunks) {
          const total = chunks.chunks.length;
          // Track current chunk based on cursor position
          const cursorPos = update.state.selection.main.head;
          let current = 0;
          for (let i = 0; i < chunks.chunks.length; i++) {
            if (cursorPos >= chunks.chunks[i].fromB) current = i + 1;
          }
          setMergeChunkInfo({
            total,
            current: Math.min(Math.max(1, current), total),
          });

          // Auto-resolve when all chunks have been individually accepted/rejected
          // Note: acceptChunk doesn't change the main doc (only the original),
          // so we check total === 0 regardless of docChanged
          if (total === 0) {
            const change = pendingChangeRef.current;
            if (change) {
              setTimeout(() => {
                const v = viewRef.current;
                if (!v || !isMergeActiveRef.current) return;
                // Guard: bail if already resolved by afterChunkAction or a new stacked edit arrived
                if (pendingChangeRef.current !== change) return;
                isMergeActiveRef.current = false;
                setMergeChunkInfo({ total: 0, current: 0 });
                const finalContent = v.state.doc.toString();
                v.dispatch({
                  effects: mergeCompartmentRef.current.reconfigure([]),
                });
                setContent(finalContent);
                if (finalContent === change.oldContent) {
                  useProposedChangesStore.getState().undoChange(change.id);
                } else {
                  useProposedChangesStore.getState().keepChange(change.id);
                }
                pendingChangeRef.current = null;
                // Auto-navigate to next file with pending changes
                const remaining = useProposedChangesStore.getState().changes;
                if (remaining.length > 0) {
                  useDocumentStore
                    .getState()
                    .setActiveFile(remaining[0].filePath);
                }
              }, 0);
            }
          }
        }
        return;
      }
      if (update.docChanged) setContent(update.state.doc.toString());
      if (update.selectionSet) {
        const { from, to, head } = update.state.selection.main;
        setCursorPosition(head);

        // Compute toolbar position below the selection end
        // Skip toolbar for "select all" (Cmd+A) to avoid overlay issues
        const isSelectAll = from === 0 && to === update.state.doc.length;
        if (from !== to && !isSelectAll) {
          setSelectionRange({ start: from, end: to });
          const startCoords = update.view.coordsAtPos(from);
          const endCoords = update.view.coordsAtPos(to);
          if (endCoords && startCoords) {
            setSelectionCoords({
              top: endCoords.bottom, // below last line of selection
              left: startCoords.left, // aligned to selection start
            });
          }
          toolbarStickyRef.current = true;
        } else if (!toolbarStickyRef.current) {
          // Only clear selection/coords if the toolbar is not being interacted with.
          // Clicking the toolbar input causes CM to lose focus and collapse the selection,
          // but we want to keep the toolbar visible until explicitly dismissed.
          setSelectionRange(null);
          setSelectionCoords(null);
        }
      }

      // Sync diagnostics for Problems panel
      const diags: DiagnosticItem[] = [];
      forEachDiagnostic(update.state, (d, from) => {
        diags.push({
          from,
          to: d.to,
          severity: d.severity,
          message: d.message,
          line: update.state.doc.lineAt(from).number,
        });
      });
      if (
        diags.length !== diagnosticsRef.current.length ||
        diags.some(
          (d, i) =>
            d.from !== diagnosticsRef.current[i]?.from ||
            d.message !== diagnosticsRef.current[i]?.message,
        )
      ) {
        diagnosticsRef.current = diags;
        setDiagnostics(diags);
      }
    });

    // Wrap selected text with a LaTeX command, or insert empty command at cursor
    const wrapSelection = (view: EditorView, cmd: string): boolean => {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      const wrapped = `\\${cmd}{${selected}}`;
      const cursorPos = selected
        ? from + wrapped.length
        : from + cmd.length + 2;
      view.dispatch({
        changes: { from, to, insert: wrapped },
        selection: { anchor: cursorPos },
      });
      return true;
    };

    const compileKeymap = Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            compileRef.current();
            return true;
          },
        },
        {
          key: "Mod-s",
          run: () => {
            const state = useDocumentStore.getState();
            state.setIsSaving(true);
            state
              .saveCurrentFile()
              .finally(() => setTimeout(() => state.setIsSaving(false), 500));
            return true;
          },
        },
        {
          key: "Mod-f",
          run: () => {
            setIsSearchOpen(true);
            return true;
          },
        },
        {
          key: "Escape",
          run: () => {
            if (isSearchOpenRef.current) {
              setIsSearchOpen(false);
              return true;
            }
            return false;
          },
        },
        {
          key: "Mod-y",
          run: () => {
            if (isMergeActiveRef.current) {
              handleKeepAllRef.current();
              return true;
            }
            return false;
          },
        },
        {
          key: "Mod-n",
          run: () => {
            if (isMergeActiveRef.current) {
              handleUndoAllRef.current();
              return true;
            }
            return false;
          },
        },
        {
          key: "Mod-b",
          run: (view) => wrapSelection(view, "textbf"),
        },
        {
          key: "Mod-i",
          run: (view) => wrapSelection(view, "textit"),
        },
        {
          key: "Mod-/",
          run: toggleComment,
        },
      ]),
    );

    const state = EditorState.create({
      doc: currentContent,
      extensions: [
        compileKeymap,
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([
          { key: "Tab", run: indentMore, shift: indentLess },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        activeFile?.type === "bib" ? bibtex() : latex({ enableLinting: false }),
        ...(activeFile?.type === "tex"
          ? [
              linter((view) => {
                // Wait until the Lezer parser has fully parsed the document
                // to avoid false positives from incomplete syntax trees
                if (!syntaxTreeAvailable(view.state, view.state.doc.length)) {
                  return [];
                }
                const baseLinter = latexLinter();
                const diagnostics = baseLinter(view);
                return diagnostics.map((d: Diagnostic) => ({
                  ...d,
                  actions: [
                    ...(d.actions ?? []),
                    {
                      name: "Fix with chat",
                      apply: (v: EditorView, from: number, _to: number) => {
                        const line = v.state.doc.lineAt(from);
                        const docState = useDocumentStore.getState();
                        const file = docState.files.find(
                          (f) => f.id === docState.activeFileId,
                        );
                        const fileName = file?.relativePath ?? "main.tex";
                        const ctx = `[Lint error in ${fileName}:${line.number}]\n[Error: ${d.message}]`;
                        useClaudeChatStore
                          .getState()
                          .sendPrompt(`${ctx}\n\nFix this lint error.`);
                      },
                    },
                  ],
                }));
              }),
              lintGutter(),
            ]
          : []),
        themeCompartmentRef.current.of(
          resolvedTheme === "dark"
            ? [oneDark, syntaxHighlighting(oneDarkHighlightStyle)]
            : [syntaxHighlighting(defaultHighlightStyle)],
        ),
        search(),
        highlightSelectionMatches(),
        mergeCompartmentRef.current.of([]),
        updateListener,
        EditorView.lineWrapping,
        scrollPastEnd(),
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "14px",
            color: "var(--foreground)",
            backgroundColor: "var(--background)",
            WebkitBackfaceVisibility: "hidden",
            backfaceVisibility: "hidden",
          },
          ".cm-scroller": {
            overflow: "auto",
            WebkitTransform: "translateZ(0)",
            transform: "translateZ(0)",
          },
          ".cm-gutters": { paddingRight: "4px" },
          ".cm-lineNumbers .cm-gutterElement": {
            paddingLeft: "8px",
            paddingRight: "4px",
          },
          ".cm-content": {
            paddingLeft: "8px",
            paddingRight: "12px",
          },
          ".cm-searchMatch": {
            backgroundColor: "#facc15 !important",
            color: "#000 !important",
            borderRadius: "2px",
            boxShadow: "0 0 0 1px #eab308",
          },
          ".cm-searchMatch-selected": {
            backgroundColor: "#f97316 !important",
            color: "#fff !important",
            borderRadius: "2px",
            boxShadow: "0 0 0 2px #ea580c",
          },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "rgba(100, 150, 255, 0.3)",
          },
          ".cm-changedLine": {
            backgroundColor: "rgba(34, 197, 94, 0.08) !important",
          },
          ".cm-deletedChunk": {
            backgroundColor: "rgba(239, 68, 68, 0.12) !important",
            paddingLeft: "6px",
            position: "relative",
          },
          ".cm-insertedLine": {
            backgroundColor: "rgba(34, 197, 94, 0.15) !important",
          },
          ".cm-deletedLine": {
            backgroundColor: "rgba(239, 68, 68, 0.15) !important",
          },
          ".cm-changedText": {
            backgroundColor: "rgba(34, 197, 94, 0.25) !important",
          },
          ".cm-chunkButtons": {
            position: "absolute",
            insetInlineEnd: "5px",
            top: "2px",
            zIndex: "10",
          },
          ".cm-chunkButtons button": {
            border: "none",
            cursor: "pointer",
            color: "white",
            margin: "0 2px",
            borderRadius: "3px",
            padding: "2px 8px",
            fontSize: "12px",
            lineHeight: "1.4",
          },
          ".cm-chunkButtons button[name=accept]": {
            backgroundColor: "#22c55e",
          },
          ".cm-chunkButtons button[name=reject]": {
            backgroundColor: "#ef4444",
          },
          ".cm-changeGutter": { width: "3px", minWidth: "3px" },
          ".cm-changedLineGutter": { backgroundColor: "#22c55e" },
          ".cm-deletedLineGutter": { backgroundColor: "#ef4444" },
          ".cm-diagnostic": {
            padding: "8px 10px",
          },
          ".cm-diagnosticAction": {
            display: "inline-block",
            padding: "4px 12px",
            borderRadius: "6px",
            fontSize: "12px",
            fontWeight: "500",
            cursor: "pointer",
            backgroundColor: "var(--muted, rgba(255,255,255,0.08))",
            color: "var(--foreground, #e5e5e5)",
            border: "1px solid var(--border, rgba(255,255,255,0.1))",
            marginTop: "8px",
            transition: "background-color 0.15s, border-color 0.15s",
          },
          ".cm-diagnosticAction:hover": {
            backgroundColor: "var(--accent, rgba(255,255,255,0.15))",
            borderColor: "var(--foreground, rgba(255,255,255,0.3))",
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    // Restore per-file cursor + scroll from cache
    const cached = editorStateCache.get(activeFileId);
    if (cached) {
      const pos = Math.min(cached.cursor, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos, head: pos } });
      // Scroll restoration needs layout to settle
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = cached.scrollTop;
      });
    }

    return () => {
      // Save per-file cursor + scroll before destroying
      editorStateCache.set(activeFileId, {
        cursor: view.state.selection.main.head,
        scrollTop: view.scrollDOM.scrollTop,
      });
      view.destroy();
      viewRef.current = null;
    };
  }, [
    activeFileId,
    isTextFile,
    setContent,
    setCursorPosition,
    setSelectionRange,
  ]);

  // Dynamically switch editor theme when resolvedTheme changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const extensions =
      resolvedTheme === "dark"
        ? [oneDark, syntaxHighlighting(oneDarkHighlightStyle)]
        : [syntaxHighlighting(defaultHighlightStyle)];
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(extensions),
    });
  }, [resolvedTheme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isTextFile || isMergeActiveRef.current) return;
    const content = activeFileContent ?? "";
    const currentContent = view.state.doc.toString();
    if (currentContent !== content) {
      view.dispatch({
        changes: { from: 0, to: currentContent.length, insert: content },
      });
    }
  }, [activeFileContent, isTextFile]);

  // Watch for proposed changes → activate/deactivate/update merge view
  useEffect(() => {
    const view = viewRef.current;
    log.debug("effect fired", {
      hasView: !!view,
      isTextFile,
      activeFileChange: activeFileChange
        ? { id: activeFileChange.id, filePath: activeFileChange.filePath }
        : null,
      isMergeActive: isMergeActiveRef.current,
      pendingId: pendingChangeRef.current?.id,
    });
    if (!view || !isTextFile) return;

    if (activeFileChange && !isMergeActiveRef.current) {
      // Activate merge view: load newContent + enable merge extension in ONE atomic dispatch
      log.debug(`ACTIVATING merge view for: ${activeFileChange.filePath}`);
      pendingChangeRef.current = activeFileChange;
      isMergeActiveRef.current = true;
      try {
        const scrollTop = view.scrollDOM.scrollTop;
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: activeFileChange.newContent,
          },
          effects: mergeCompartmentRef.current.reconfigure(
            unifiedMergeView({
              original: activeFileChange.oldContent,
              highlightChanges: true,
              gutter: true,
              mergeControls: true,
            }),
          ),
          annotations: Transaction.addToHistory.of(false),
        });
        view.scrollDOM.scrollTop = scrollTop;
        log.debug("merge view activated successfully");
        // Auto-scroll to first chunk
        setTimeout(() => goToChunk(0), 50);
      } catch (err) {
        log.error("failed to activate merge view", { error: String(err) });
        isMergeActiveRef.current = false;
        pendingChangeRef.current = null;
      }
    } else if (
      activeFileChange &&
      isMergeActiveRef.current &&
      pendingChangeRef.current?.id !== activeFileChange.id
    ) {
      // Stacked edit: the change was updated while merge was already active.
      // Re-dispatch the merge view with the accumulated diff (original → latest).
      log.debug(
        `UPDATING merge view (stacked edit) for: ${activeFileChange.filePath}`,
      );
      pendingChangeRef.current = activeFileChange;
      try {
        const scrollTop = view.scrollDOM.scrollTop;
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: activeFileChange.newContent,
          },
          effects: mergeCompartmentRef.current.reconfigure(
            unifiedMergeView({
              original: activeFileChange.oldContent,
              highlightChanges: true,
              gutter: true,
              mergeControls: true,
            }),
          ),
          annotations: Transaction.addToHistory.of(false),
        });
        view.scrollDOM.scrollTop = scrollTop;
        log.debug("merge view updated successfully (stacked edit)");
      } catch (err) {
        log.error("failed to update merge view", { error: String(err) });
      }
    } else if (!activeFileChange && isMergeActiveRef.current) {
      // Deactivate merge view (externally resolved)
      log.debug("DEACTIVATING merge view");
      view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
      isMergeActiveRef.current = false;
      pendingChangeRef.current = null;
    }
  }, [activeFileChange, isTextFile]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || jumpToPosition === null) return;
    view.dispatch({
      selection: { anchor: jumpToPosition },
      effects: EditorView.scrollIntoView(jumpToPosition, { y: "center" }),
    });
    view.focus();
    clearJumpRequest();
  }, [jumpToPosition, clearJumpRequest]);

  // Selection toolbar: compute context label and container-relative position
  const selectionRange = useDocumentStore((s) => s.selectionRange);
  const selectionLabel = useMemo(() => {
    const view = viewRef.current;
    if (!selectionRange || !view || !activeFile) return null;
    try {
      const startLine = view.state.doc.lineAt(selectionRange.start);
      const endLine = view.state.doc.lineAt(selectionRange.end);
      const startCol = selectionRange.start - startLine.from + 1;
      const endCol = selectionRange.end - endLine.from + 1;
      const fileName = activeFile.relativePath;
      return `@${fileName}:${startLine.number}:${startCol}-${endLine.number}:${endCol}`;
    } catch {
      return null;
    }
  }, [selectionRange, activeFile]);

  const toolbarPosition = useMemo(() => {
    if (!selectionCoords || !parentRef.current) return null;
    const parentRect = parentRef.current.getBoundingClientRect();
    const relTop = selectionCoords.top - parentRect.top + 4; // 4px gap below selection
    const relLeft = Math.max(
      8,
      Math.min(
        selectionCoords.left - parentRect.left,
        parentRect.width - 272, // 264px toolbar + 8px margin
      ),
    );
    return { top: relTop, left: relLeft };
  }, [selectionCoords]);

  const handleToolbarSendPrompt = useCallback(
    (prompt: string) => {
      toolbarStickyRef.current = false;
      setSelectionCoords(null);
      setSelectionRange(null);
      useClaudeChatStore.getState().sendPrompt(prompt);
    },
    [setSelectionRange],
  );

  const editorToolbarActions: ToolbarAction[] = useMemo(
    () => [
      {
        id: "proofread",
        label: "Proofread",
        icon: <SpellCheckIcon className="size-4" />,
      },
    ],
    [],
  );

  const handleToolbarAction = useCallback(
    (actionId: string) => {
      toolbarStickyRef.current = false;
      setSelectionCoords(null);
      setSelectionRange(null);
      if (actionId === "proofread") {
        useClaudeChatStore
          .getState()
          .sendPrompt("Proofread and fix any errors in this text");
      }
    },
    [setSelectionRange],
  );

  const handleToolbarDismiss = useCallback(() => {
    toolbarStickyRef.current = false;
    setSelectionCoords(null);
    setSelectionRange(null);
  }, [setSelectionRange]);

  // History review action handlers
  const handleHistoryRestore = useCallback(async () => {
    if (!reviewingSnapshot || !projectRoot) return;
    useHistoryStore.getState().stopReview();
    await useHistoryStore
      .getState()
      .restoreSnapshot(projectRoot, reviewingSnapshot.id);
    await useDocumentStore.getState().openProject(projectRoot);
    await useHistoryStore.getState().loadSnapshots(projectRoot);
  }, [reviewingSnapshot, projectRoot]);

  const [historyLabelDialogOpen, setHistoryLabelDialogOpen] = useState(false);
  const [historyLabelValue, setHistoryLabelValue] = useState("");

  const handleHistoryAddLabel = useCallback(async () => {
    const label = historyLabelValue.trim();
    if (!label || !reviewingSnapshot || !projectRoot) return;
    await useHistoryStore
      .getState()
      .addLabel(projectRoot, reviewingSnapshot.id, label);
    setHistoryLabelDialogOpen(false);
    setHistoryLabelValue("");
  }, [reviewingSnapshot, projectRoot, historyLabelValue]);

  const handleHistoryCopySha = useCallback(() => {
    if (!reviewingSnapshot) return;
    navigator.clipboard.writeText(reviewingSnapshot.id);
  }, [reviewingSnapshot]);

  const handleHistoryClose = useCallback(() => {
    useHistoryStore.getState().stopReview();
  }, []);

  const isPdf = activeFile?.type === "pdf";
  const isImage = !isTextFile && !isPdf && !!activeFile;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Toolbar — adapts to file type */}
      <EditorToolbar
        editorView={viewRef}
        fileType={isPdf || isImage ? "image" : undefined}
        imageScale={isPdf || isImage ? imageScale : undefined}
        onImageScaleChange={isPdf || isImage ? setImageScale : undefined}
        cropMode={isImage ? cropMode : undefined}
        onCropToggle={isImage ? () => setCropMode((v) => !v) : undefined}
      />
      {/* Text-editor-only panels */}
      {!isPdf && !isImage && !isLargeFileNotLoaded && isSearchOpen && (
        <SearchPanel
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onClose={() => {
            setIsSearchOpen(false);
            setSearchQuery("");
            viewRef.current?.focus();
          }}
          onFindNext={handleFindNext}
          onFindPrevious={handleFindPrevious}
          matchCount={matchCount}
          currentMatch={currentMatch}
        />
      )}
      {!isPdf && !isImage && !isLargeFileNotLoaded && reviewingSnapshot && (
        <div className="flex h-9 shrink-0 items-center justify-between border-border border-b bg-amber-500/10 px-3">
          <div className="flex items-center gap-2 text-xs">
            <RotateCcwIcon className="size-3.5 text-amber-600 dark:text-amber-400" />
            <span className="font-medium text-amber-700 dark:text-amber-300">
              Reviewing history
            </span>
            <span className="text-muted-foreground">
              {reviewingSnapshot.message.replace(/^\[.*?\]\s*/, "")} &middot;{" "}
              {reviewingSnapshot.id.slice(0, 7)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={handleHistoryRestore}
            >
              <RotateCcwIcon className="size-3" />
              Restore
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={() => {
                setHistoryLabelDialogOpen(true);
                setHistoryLabelValue("");
              }}
            >
              <TagIcon className="size-3" />
              Label
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={handleHistoryCopySha}
            >
              <CopyIcon className="size-3" />
              SHA
            </Button>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={handleHistoryClose}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
      {/* Main content area — single wrapper keeps ClaudeChatDrawer stable */}
      <div
        ref={isPdf || isImage ? undefined : parentRef}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {/* PDF content */}
        {isPdf && activeFile && (
          <InlinePdfContent
            file={activeFile}
            imageScale={imageScale}
            onImageScaleChange={setImageScale}
          />
        )}
        {/* Image content */}
        {isImage && activeFile && (
          <ImagePreview
            file={activeFile}
            scale={imageScale}
            onScaleChange={setImageScale}
            cropMode={cropMode}
            onCropModeChange={setCropMode}
          />
        )}
        {/* Large file warning */}
        {isLargeFileNotLoaded && activeFile && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="max-w-md rounded-lg border border-border bg-card/50 p-6 shadow-sm">
              <p className="mb-1 font-medium text-foreground text-sm">
                {activeFile.name}
              </p>
              <p className="mb-4 text-muted-foreground text-xs">
                This file is large (
                {activeFile.fileSize != null
                  ? `${(activeFile.fileSize / (1024 * 1024)).toFixed(1)} MB`
                  : "unknown size"}
                ). Opening it may slow down the editor.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadFileContent(activeFile.id)}
              >
                Open Anyway
              </Button>
            </div>
          </div>
        )}
        {/* Text editor content */}
        {!isPdf && !isImage && !isLargeFileNotLoaded && (
          <>
            <div
              ref={containerRef}
              className={reviewingSnapshot ? "hidden" : "absolute inset-0"}
            />
            {reviewingSnapshot && historyDiffResult && (
              <HistoryDiffView diffs={historyDiffResult} />
            )}
            {toolbarPosition &&
              selectionLabel &&
              !isMergeActiveRef.current &&
              !isSearchOpen && (
                <SelectionToolbar
                  position={toolbarPosition}
                  contextLabel={selectionLabel}
                  actions={editorToolbarActions}
                  onSendPrompt={handleToolbarSendPrompt}
                  onAction={handleToolbarAction}
                  onDismiss={handleToolbarDismiss}
                />
              )}
            {activeFileChange && mergeChunkInfo.total > 0 && (
              <div className="absolute top-3 right-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-background/95 px-2 py-1 shadow-lg backdrop-blur-sm">
                <span className="px-1 font-mono text-muted-foreground text-xs">
                  ±&nbsp;{mergeChunkInfo.current}/{mergeChunkInfo.total}
                </span>
                <div className="mx-0.5 h-4 w-px bg-border" />
                <button
                  onClick={() =>
                    goToChunk(
                      mergeChunkInfo.current <= 1
                        ? mergeChunkInfo.total - 1
                        : mergeChunkInfo.current - 2,
                    )
                  }
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
                  title="Previous change"
                  aria-label="Previous change"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                </button>
                <button
                  onClick={() =>
                    goToChunk(
                      mergeChunkInfo.current >= mergeChunkInfo.total
                        ? 0
                        : mergeChunkInfo.current,
                    )
                  }
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
                  title="Next change"
                  aria-label="Next change"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                <div className="mx-0.5 h-4 w-px bg-border" />
                <button
                  onClick={acceptCurrentChunk}
                  className="rounded p-0.5 text-green-400 transition-colors hover:bg-green-600/20"
                  title="Accept this change"
                  aria-label="Accept this change"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </button>
                <button
                  onClick={rejectCurrentChunk}
                  className="rounded p-0.5 text-red-400 transition-colors hover:bg-red-600/20"
                  title="Reject this change"
                  aria-label="Reject this change"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}
          </>
        )}
        {/* Chat drawer — single stable instance across all file types */}
        <ClaudeChatDrawer />
      </div>
      {/* Text-editor-only bottom panels */}
      {!isPdf &&
        !isImage &&
        !isLargeFileNotLoaded &&
        diagnostics.length > 0 && (
          <ProblemsPanel
            diagnostics={diagnostics}
            fileName={activeFile?.relativePath ?? "main.tex"}
            onNavigate={(from) => {
              const view = viewRef.current;
              if (!view) return;
              view.dispatch({
                selection: { anchor: from },
                effects: EditorView.scrollIntoView(from, { y: "center" }),
              });
              view.focus();
            }}
            onFixWithChat={(message, line) => {
              const fileName = activeFile?.relativePath ?? "main.tex";
              const ctx = `[Lint error in ${fileName}:${line}]\n[Error: ${message}]`;
              useClaudeChatStore
                .getState()
                .sendPrompt(`${ctx}\n\nFix this lint error.`);
            }}
            onFixAllWithChat={() => {
              const fileName = activeFile?.relativePath ?? "main.tex";
              const errorList = diagnostics
                .map((d) => `- ${fileName}:${d.line} — ${d.message}`)
                .join("\n");
              useClaudeChatStore
                .getState()
                .sendPrompt(
                  `[Lint errors in ${fileName}]\n${errorList}\n\nFix all these lint errors.`,
                );
            }}
          />
        )}
      {!isPdf && !isImage && !isLargeFileNotLoaded && activeFileChange && (
        <ProposedChangesPanel
          change={activeFileChange}
          changeIndex={proposedChanges.findIndex(
            (c) => c.filePath === activeFile?.relativePath,
          )}
          totalChanges={proposedChanges.length}
          onKeep={() => handleKeepAllRef.current()}
          onUndo={() => handleUndoAllRef.current()}
        />
      )}
      {/* History label dialog */}
      <Dialog
        open={historyLabelDialogOpen}
        onOpenChange={setHistoryLabelDialogOpen}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Label</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="e.g. Draft v1"
              value={historyLabelValue}
              onChange={(e) => setHistoryLabelValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleHistoryAddLabel();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setHistoryLabelDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleHistoryAddLabel}
              disabled={!historyLabelValue.trim()}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Inline PDF Content (data loading + MuPDF PdfViewer) ───

function InlinePdfContent({
  file,
  imageScale,
  onImageScaleChange,
}: {
  file: ProjectFile;
  imageScale: number;
  onImageScaleChange: (scale: number) => void;
}) {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fitted, setFitted] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setPdfData(null);
    setError(null);
    setFitted(false);

    readFile(file.absolutePath)
      .then((data) => {
        if (!cancelled) setPdfData(new Uint8Array(data));
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [file.absolutePath]);

  const handleFirstPageSize = useCallback(
    (pageWidth: number) => {
      const containerWidth = wrapperRef.current?.clientWidth;
      if (!containerWidth || !onImageScaleChange) return;
      const fitScale = (containerWidth - 32) / pageWidth; // 32px padding
      onImageScaleChange(Math.max(0.25, Math.min(2, fitScale)));
      setFitted(true);
    },
    [onImageScaleChange],
  );

  if (pdfData) {
    return (
      <div
        ref={wrapperRef}
        className="flex min-h-0 flex-1 flex-col"
        style={{ opacity: fitted ? 1 : 0 }}
      >
        <PdfViewer
          data={pdfData}
          scale={imageScale}
          onScaleChange={onImageScaleChange}
          onFirstPageSize={handleFirstPageSize}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Failed to load PDF: {error}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
      Loading PDF...
    </div>
  );
}

// ─── History Diff View (git-diff style combined view) ───

function HistoryDiffView({ diffs }: { diffs: FileDiff[] }) {
  return (
    <div className="absolute inset-0 overflow-y-auto bg-background font-mono text-xs leading-relaxed">
      {diffs.map((diff) => (
        <div key={diff.file_path} className="border-border border-b">
          {/* File header */}
          <div className="sticky top-0 z-10 flex items-center gap-2 border-border border-b bg-muted/80 px-4 py-1.5 backdrop-blur-sm">
            <span
              className={
                diff.status === "added"
                  ? "font-bold text-green-600 dark:text-green-400"
                  : diff.status === "deleted"
                    ? "font-bold text-red-600 dark:text-red-400"
                    : "font-bold text-blue-600 dark:text-blue-400"
              }
            >
              {diff.status === "added"
                ? "+"
                : diff.status === "deleted"
                  ? "−"
                  : "~"}
            </span>
            <span className="font-medium text-foreground">
              {diff.file_path}
            </span>
            <span className="text-muted-foreground">({diff.status})</span>
          </div>
          {/* Diff lines */}
          <DiffLines diff={diff} />
        </div>
      ))}
      {diffs.length === 0 && (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          No changes in this snapshot
        </div>
      )}
    </div>
  );
}

function DiffLines({ diff }: { diff: FileDiff }) {
  const oldLines = diff.old_content?.split("\n") ?? [];
  const newLines = diff.new_content?.split("\n") ?? [];

  if (diff.status === "added") {
    return (
      <div className="px-1">
        {newLines.map((line, i) => (
          <div key={i} className="flex bg-green-500/10">
            <span className="w-12 shrink-0 select-none pr-2 text-right text-green-500/50">
              {i + 1}
            </span>
            <span className="mr-1 select-none text-green-500/50">+</span>
            <span className="text-green-700 dark:text-green-400">
              {line || " "}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (diff.status === "deleted") {
    return (
      <div className="px-1">
        {oldLines.map((line, i) => (
          <div key={i} className="flex bg-red-500/10">
            <span className="w-12 shrink-0 select-none pr-2 text-right text-red-500/50">
              {i + 1}
            </span>
            <span className="mr-1 select-none text-red-500/50">−</span>
            <span className="text-red-700 dark:text-red-400">
              {line || " "}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Modified: compute unified diff with context
  const hunks = computeUnifiedHunks(oldLines, newLines, 3);

  return (
    <div className="px-1">
      {hunks.map((hunk, hi) => (
        <div key={hi}>
          {/* Hunk header */}
          <div className="bg-blue-500/10 px-1 text-blue-600 dark:text-blue-400">
            @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount}{" "}
            @@
          </div>
          {hunk.lines.map((line, li) => (
            <div
              key={li}
              className={
                line.type === "del"
                  ? "flex bg-red-500/10"
                  : line.type === "add"
                    ? "flex bg-green-500/10"
                    : "flex"
              }
            >
              <span
                className={`w-12 shrink-0 select-none pr-2 text-right ${
                  line.type === "del"
                    ? "text-red-500/50"
                    : line.type === "add"
                      ? "text-green-500/50"
                      : "text-muted-foreground/50"
                }`}
              >
                {line.type !== "add" ? line.oldNum : ""}
              </span>
              <span
                className={`w-12 shrink-0 select-none pr-2 text-right ${
                  line.type === "del"
                    ? "text-red-500/50"
                    : line.type === "add"
                      ? "text-green-500/50"
                      : "text-muted-foreground/50"
                }`}
              >
                {line.type !== "del" ? line.newNum : ""}
              </span>
              <span
                className={`mr-1 select-none ${
                  line.type === "del"
                    ? "text-red-500/50"
                    : line.type === "add"
                      ? "text-green-500/50"
                      : "text-muted-foreground/30"
                }`}
              >
                {line.type === "del" ? "−" : line.type === "add" ? "+" : " "}
              </span>
              <span
                className={
                  line.type === "del"
                    ? "text-red-700 dark:text-red-400"
                    : line.type === "add"
                      ? "text-green-700 dark:text-green-400"
                      : "text-muted-foreground"
                }
              >
                {line.text || " "}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface DiffLine {
  type: "ctx" | "del" | "add";
  text: string;
  oldNum?: number;
  newNum?: number;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

function computeUnifiedHunks(
  oldLines: string[],
  newLines: string[],
  context: number,
): Hunk[] {
  // Simple line-by-line diff to find changed regions
  const ops: {
    type: "eq" | "del" | "add";
    oldIdx?: number;
    newIdx?: number;
    text: string;
  }[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      ops.push({ type: "eq", oldIdx: i, newIdx: j, text: oldLines[i] });
      i++;
      j++;
    } else {
      // Find the next matching line
      let foundOld = -1;
      let foundNew = -1;
      const searchLimit = Math.min(
        50,
        Math.max(oldLines.length - i, newLines.length - j),
      );
      for (let look = 1; look <= searchLimit; look++) {
        if (
          i + look < oldLines.length &&
          j < newLines.length &&
          oldLines[i + look] === newLines[j]
        ) {
          foundOld = i + look;
          break;
        }
        if (
          j + look < newLines.length &&
          i < oldLines.length &&
          newLines[j + look] === oldLines[i]
        ) {
          foundNew = j + look;
          break;
        }
      }

      if (foundOld >= 0) {
        // Delete lines from old until match
        while (i < foundOld) {
          ops.push({ type: "del", oldIdx: i, text: oldLines[i] });
          i++;
        }
      } else if (foundNew >= 0) {
        // Add lines from new until match
        while (j < foundNew) {
          ops.push({ type: "add", newIdx: j, text: newLines[j] });
          j++;
        }
      } else {
        // No match found nearby, emit del+add
        if (i < oldLines.length) {
          ops.push({ type: "del", oldIdx: i, text: oldLines[i] });
          i++;
        }
        if (j < newLines.length) {
          ops.push({ type: "add", newIdx: j, text: newLines[j] });
          j++;
        }
      }
    }
  }

  // Group into hunks with context lines
  const changedIndices = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.type !== "eq") {
      for (
        let c = Math.max(0, idx - context);
        c <= Math.min(ops.length - 1, idx + context);
        c++
      ) {
        changedIndices.add(c);
      }
    }
  });

  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (let idx = 0; idx < ops.length; idx++) {
    if (!changedIndices.has(idx)) {
      if (currentHunk) {
        hunks.push(currentHunk);
        currentHunk = null;
      }
      continue;
    }

    const op = ops[idx];
    if (!currentHunk) {
      const oldStart =
        op.type !== "add"
          ? (op.oldIdx ?? 0) + 1
          : (ops[idx + 1]?.oldIdx ?? 0) + 1;
      const newStart =
        op.type !== "del"
          ? (op.newIdx ?? 0) + 1
          : (ops[idx + 1]?.newIdx ?? 0) + 1;
      currentHunk = { oldStart, oldCount: 0, newStart, newCount: 0, lines: [] };
    }

    if (op.type === "eq") {
      currentHunk.lines.push({
        type: "ctx",
        text: op.text,
        oldNum: (op.oldIdx ?? 0) + 1,
        newNum: (op.newIdx ?? 0) + 1,
      });
      currentHunk.oldCount++;
      currentHunk.newCount++;
    } else if (op.type === "del") {
      currentHunk.lines.push({
        type: "del",
        text: op.text,
        oldNum: (op.oldIdx ?? 0) + 1,
      });
      currentHunk.oldCount++;
    } else {
      currentHunk.lines.push({
        type: "add",
        text: op.text,
        newNum: (op.newIdx ?? 0) + 1,
      });
      currentHunk.newCount++;
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  return hunks;
}
