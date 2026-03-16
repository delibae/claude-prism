import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { documentDir } from "@tauri-apps/api/path";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SparklesIcon,
  LoaderIcon,
  ArrowLeftIcon,
  FolderOpenIcon,
  PaperclipIcon,
  XIcon,
  UploadIcon,
  ChevronDownIcon,
  FileTextIcon,
  MapPinIcon,
  Loader2Icon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useTemplateStore } from "@/stores/template-store";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import {
  getTemplateById,
  getTemplateSkeleton,
  BIB_TEMPLATE,
} from "@/lib/template-registry";
import { getTemplatePdfUrl } from "@/lib/template-preview-cache";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { exists, join } from "@/lib/tauri/fs";
import type { PageSize } from "@/lib/mupdf/types";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("template-preview");

// ─── Helpers ───

function randomProjectName(): string {
  const adjectives = [
    "swift",
    "bright",
    "calm",
    "bold",
    "keen",
    "warm",
    "pure",
    "vast",
    "deep",
    "fair",
  ];
  const nouns = [
    "paper",
    "draft",
    "thesis",
    "note",
    "study",
    "essay",
    "report",
    "brief",
    "folio",
    "opus",
  ];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const id = Math.random().toString(36).slice(2, 6);
  return `${adj}-${noun}-${id}`;
}

// ─── Component ───

type ModalStep = "preview" | "details";

export function TemplatePreview() {
  const previewTemplateId = useTemplateStore((s) => s.previewTemplateId);
  const closePreview = useTemplateStore((s) => s.closePreview);
  const template = previewTemplateId
    ? getTemplateById(previewTemplateId)
    : null;

  const [modalStep, setModalStep] = useState<ModalStep>("preview");

  // ── PDF preview state ──
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLandscape, setIsLandscape] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const docIdRef = useRef(0);
  const pageSizesRef = useRef<PageSize[]>([]);
  const loadGenRef = useRef(0);

  // ── Creation form state ──
  const [purpose, setPurpose] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [projectFolder, setProjectFolder] = useState<string | null>(null);
  const [projectName, setProjectName] = useState(randomProjectName);
  const [isCreating, setIsCreating] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [refFilesOpen, setRefFilesOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Store access ──
  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const lastProjectFolder = useProjectStore((s) => s.lastProjectFolder);
  const setLastProjectFolder = useProjectStore((s) => s.setLastProjectFolder);
  const openProject = useDocumentStore((s) => s.openProject);

  // ── Dialog open/close ──
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closePreview();
        setModalStep("preview");
        setCurrentPage(1);
        setNumPages(0);
        setIsLandscape(false);
        setError(false);
        if (docIdRef.current > 0) {
          getMupdfClient()
            .closeDocument(docIdRef.current)
            .catch(() => {});
          docIdRef.current = 0;
        }
      }
    },
    [closePreview],
  );

  // Reset form when a new template is previewed
  useEffect(() => {
    if (previewTemplateId) {
      setModalStep("preview");
      setPurpose("");
      setAttachments([]);
      setProjectName(randomProjectName());
      setRefFilesOpen(false);
      setLocationOpen(false);
    }
  }, [previewTemplateId]);

  // Default project folder
  useEffect(() => {
    if (projectFolder) return;
    if (lastProjectFolder) {
      setProjectFolder(lastProjectFolder);
    } else {
      documentDir()
        .then((dir) => setProjectFolder(dir))
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus textarea in details step
  useEffect(() => {
    if (modalStep === "details") {
      const timer = setTimeout(() => textareaRef.current?.focus(), 150);
      return () => clearTimeout(timer);
    }
  }, [modalStep]);

  // ── PDF loading ──
  useEffect(() => {
    if (!previewTemplateId) return;

    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(false);
    setNumPages(0);
    setCurrentPage(1);

    (async () => {
      try {
        const url = getTemplatePdfUrl(previewTemplateId);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (gen !== loadGenRef.current) return;

        const client = getMupdfClient();
        if (docIdRef.current > 0) {
          await client.closeDocument(docIdRef.current).catch(() => {});
        }

        const docId = await client.openDocument(buffer);
        if (gen !== loadGenRef.current) {
          client.closeDocument(docId).catch(() => {});
          return;
        }
        docIdRef.current = docId;

        const count = await client.countPages(docId);
        if (gen !== loadGenRef.current) return;

        const sizes: PageSize[] = [];
        for (let i = 0; i < count; i++) {
          const size = await client.getPageSize(docId, i);
          if (gen !== loadGenRef.current) return;
          sizes.push(size);
        }

        pageSizesRef.current = sizes;
        setNumPages(count);
        setCurrentPage(1);
        if (sizes.length > 0) {
          setIsLandscape(sizes[0].width > sizes[0].height);
        }
        setLoading(false);
      } catch (err) {
        if (gen !== loadGenRef.current) return;
        log.warn("load error", { error: String(err) });
        setLoading(false);
        setError(true);
      }
    })();
  }, [previewTemplateId]);

  // ── Render current page ──
  useEffect(() => {
    if (
      docIdRef.current <= 0 ||
      numPages === 0 ||
      !canvasRef.current ||
      !containerRef.current
    )
      return;

    const pageIndex = currentPage - 1;
    const size = pageSizesRef.current[pageIndex];
    if (!size) return;

    setIsLandscape(size.width > size.height);

    const container = containerRef.current;
    const maxW = container.clientWidth - 48;
    const maxH = container.clientHeight - 48;
    const pageAspect = size.width / size.height;

    let displayW = maxW;
    let displayH = displayW / pageAspect;
    if (displayH > maxH) {
      displayH = maxH;
      displayW = displayH * pageAspect;
    }

    const dpr = window.devicePixelRatio || 1;
    const dpi = (displayW / size.width) * 72 * dpr;

    const client = getMupdfClient();
    client
      .drawPage(docIdRef.current, pageIndex, dpi)
      .then((imageData) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        canvas.style.width = `${displayW}px`;
        canvas.style.height = `${displayH}px`;
        const ctx = canvas.getContext("2d")!;
        ctx.putImageData(imageData, 0, 0);
      })
      .catch((err) => {
        log.warn("render error", { error: String(err) });
      });
  }, [currentPage, numPages, isLandscape]);

  // ── Page navigation ──
  const goToPrevPage = useCallback(
    () => setCurrentPage((p) => Math.max(1, p - 1)),
    [],
  );
  const goToNextPage = useCallback(
    () => setCurrentPage((p) => Math.min(numPages, p + 1)),
    [numPages],
  );

  useEffect(() => {
    if (!previewTemplateId || modalStep !== "preview") return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPrevPage();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToNextPage();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewTemplateId, modalStep, goToPrevPage, goToNextPage]);

  // ── Drag-drop for reference files ──
  useEffect(() => {
    if (modalStep !== "details") return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const { type } = event.payload;
        if (type === "enter") {
          setIsDragOver(true);
          setRefFilesOpen(true);
        } else if (type === "drop") {
          setIsDragOver(false);
          const paths = (event.payload as { paths: string[] }).paths;
          if (paths?.length > 0) {
            setAttachments((prev) => [
              ...prev,
              ...paths.filter((p) => !prev.includes(p)),
            ]);
          }
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [modalStep]);

  // ── File handlers ──
  const handleAddAttachments = useCallback(async () => {
    const selected = await open({
      multiple: true,
      title: "Add Reference Files",
      filters: [
        {
          name: "Documents & Images",
          extensions: [
            "pdf",
            "tex",
            "bib",
            "txt",
            "md",
            "png",
            "jpg",
            "jpeg",
            "gif",
            "svg",
            "csv",
            "tsv",
            "json",
          ],
        },
      ],
    });
    if (selected) {
      const paths = Array.isArray(selected) ? selected : [selected];
      setAttachments((prev) => [
        ...prev,
        ...paths.filter((p) => !prev.includes(p)),
      ]);
    }
  }, []);

  const handleRemoveAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  };

  const handleChooseFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose Location for New Project",
    });
    if (selected) {
      setProjectFolder(selected);
      setLastProjectFolder(selected);
    }
  }, [setLastProjectFolder]);

  // ── Create project ──
  const handleCreate = async () => {
    if (!template || !projectFolder || !projectName.trim()) return;
    setIsCreating(true);

    try {
      const projectPath = await join(projectFolder, projectName.trim());
      await mkdir(projectPath, { recursive: true }).catch(() => {});

      const mainTexPath = await join(projectPath, template.mainFileName);
      const mainExists = await exists(mainTexPath);
      if (!mainExists) {
        await writeTextFile(mainTexPath, getTemplateSkeleton(template));
      }

      if (template.hasBibliography) {
        const bibPath = await join(projectPath, "references.bib");
        const bibExists = await exists(bibPath);
        if (!bibExists) {
          await writeTextFile(bibPath, BIB_TEMPLATE);
        }
      }

      if (attachments.length > 0) {
        const attachmentsDir = await join(projectPath, "attachments");
        await mkdir(attachmentsDir, { recursive: true }).catch(() => {});
      }

      if (purpose.trim()) {
        const attachmentNames = attachments
          .map((p) => p.split("/").pop())
          .filter(Boolean);
        const attachmentSection =
          attachmentNames.length > 0
            ? `\n### Reference Files\n${attachmentNames.map((n) => `- \`${n}\``).join("\n")}\n\nPlease review them and incorporate relevant information.\n`
            : "";

        const prompt = [
          `## New ${template.name} Project`,
          "",
          `**Template:** \`${template.documentClass}\`  `,
          `**File:** \`${template.mainFileName}\``,
          "",
          `> The file currently contains only the LaTeX preamble (packages, styling, custom commands) with an empty document body.`,
          "",
          `### What I want to create`,
          "",
          purpose.trim(),
          attachmentSection,
          `### Instructions`,
          "",
          `Please generate the full document content based on my description. Keep the existing preamble and fill in the document body (between \`\\begin{document}\` and \`\\end{document}\`) with appropriate title, author, sections, and content. Make it a complete, well-structured **${template.name.toLowerCase()}** ready for me to refine.`,
        ].join("\n");

        useClaudeChatStore.getState().newSession();
        useClaudeChatStore.getState().setPendingInitialPrompt(prompt);
      }

      setLastProjectFolder(projectFolder);
      addRecentProject(projectPath);
      await openProject(projectPath);

      if (attachments.length > 0) {
        await useDocumentStore
          .getState()
          .importFiles(attachments, "attachments");
      }

      // Close modal on success
      closePreview();
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setIsCreating(false);
    }
  };

  const canCreate = template && projectFolder && projectName.trim();

  if (!template) return null;

  // ── Modal width depends on step ──
  const modalWidth =
    modalStep === "preview"
      ? isLandscape
        ? "w-[min(72rem,calc(100vw-4rem))]"
        : "w-[min(48rem,calc(100vw-6rem))]"
      : "w-[min(32rem,calc(100vw-4rem))]";

  return (
    <Dialog open={!!previewTemplateId} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={`flex max-w-none flex-col gap-0 overflow-hidden p-0 transition-[width] duration-300 sm:max-w-none ${modalWidth} ${modalStep === "preview" ? "h-[70vh]" : "max-h-[80vh]"}`}
      >
        {modalStep === "preview" ? (
          /* ═══════════════════ PREVIEW STEP ═══════════════════ */
          <>
            <DialogHeader className="shrink-0 border-border border-b px-6 py-3">
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <DialogTitle className="text-sm">{template.name}</DialogTitle>
                  <DialogDescription className="mt-0.5 truncate text-xs">
                    {template.description} — {template.documentClass}
                    {template.packages.length > 0 &&
                      ` — ${template.packages.length} packages`}
                  </DialogDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => setModalStep("details")}
                    className="gap-1.5"
                  >
                    <SparklesIcon className="size-3.5" />
                    Use Template
                  </Button>
                </div>
              </div>
            </DialogHeader>

            <div className="flex flex-1 overflow-hidden">
              <div className="relative flex flex-1 flex-col">
                <div
                  ref={containerRef}
                  className="flex flex-1 items-center justify-center overflow-hidden bg-muted/30 p-6"
                >
                  {loading && (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <LoaderIcon className="size-5 animate-spin" />
                      <span className="text-sm">Loading preview...</span>
                    </div>
                  )}
                  {error && (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <span className="text-sm">Preview not available</span>
                      <span className="text-xs opacity-60">
                        Run `pnpm generate-previews` to generate
                      </span>
                    </div>
                  )}
                  {!loading && !error && numPages > 0 && (
                    <canvas ref={canvasRef} className="shadow-xl" />
                  )}
                </div>

                {numPages > 0 && (
                  <div className="flex shrink-0 items-center justify-center gap-3 border-border border-t bg-background py-2.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={goToPrevPage}
                      disabled={currentPage <= 1}
                    >
                      <ChevronLeftIcon className="size-4" />
                    </Button>
                    <span className="min-w-16 text-center text-muted-foreground text-xs tabular-nums">
                      {numPages > 1 ? `${currentPage} / ${numPages}` : "1 page"}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={goToNextPage}
                      disabled={currentPage >= numPages}
                    >
                      <ChevronRightIcon className="size-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          /* ═══════════════════ DETAILS STEP ═══════════════════ */
          <>
            {/* Header */}
            <DialogHeader className="shrink-0 border-border/60 border-b px-5 py-3">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 rounded-lg"
                  onClick={() => setModalStep("preview")}
                >
                  <ArrowLeftIcon className="size-4" />
                </Button>
                <div className="min-w-0 flex-1">
                  <DialogTitle className="text-sm">{template.name}</DialogTitle>
                  <DialogDescription className="mt-0.5 truncate text-xs">
                    {template.description}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {/* Form content */}
            <div className="flex-1 overflow-y-auto">
              <div className="space-y-4 p-5">
                {/* Purpose — hero element */}
                <div className="space-y-2">
                  <div>
                    <span className="font-semibold text-sm">
                      What are you writing?
                    </span>
                    <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                      Describe your document and Claude will generate tailored
                      content.
                    </p>
                  </div>
                  <Textarea
                    ref={textareaRef}
                    placeholder="e.g., A research paper on transformer architectures for protein structure prediction, targeting NeurIPS 2025..."
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    rows={3}
                    className="resize-none rounded-xl border-border/60 bg-card/30 text-sm leading-relaxed placeholder:text-muted-foreground/50 focus-visible:bg-card/50"
                  />
                </div>

                {/* Collapsible sections */}
                <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/60 bg-card/30">
                  {/* Reference files */}
                  <div>
                    <button
                      onClick={() => setRefFilesOpen(!refFilesOpen)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
                    >
                      <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/50">
                        <FileTextIcon className="size-3 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-sm">
                          Reference files
                        </span>
                        {attachments.length > 0 && (
                          <span className="ml-2 inline-flex items-center justify-center rounded-full bg-primary/15 px-1.5 py-0.5 font-semibold text-[10px] text-primary leading-none">
                            {attachments.length}
                          </span>
                        )}
                      </div>
                      <ChevronDownIcon
                        className={`size-4 text-muted-foreground/60 transition-transform duration-200 ${refFilesOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    {refFilesOpen && (
                      <div className="space-y-2.5 px-4 pb-3">
                        {attachments.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {attachments.map((path) => (
                              <div
                                key={path}
                                className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 py-1 pr-1.5 pl-2.5 text-xs transition-colors hover:bg-muted/60"
                              >
                                <PaperclipIcon className="size-3 shrink-0 text-muted-foreground/70" />
                                <span className="max-w-30 truncate text-foreground/80">
                                  {path.split("/").pop()}
                                </span>
                                <button
                                  onClick={() => handleRemoveAttachment(path)}
                                  className="flex size-4 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                                >
                                  <XIcon className="size-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div
                          className={`flex flex-col items-center gap-1.5 rounded-lg border border-dashed p-3 transition-all ${
                            isDragOver
                              ? "border-primary bg-primary/5"
                              : "border-border/60 hover:border-border hover:bg-muted/20"
                          }`}
                        >
                          {isDragOver ? (
                            <>
                              <UploadIcon className="size-4 text-primary" />
                              <span className="font-medium text-primary text-xs">
                                Drop to add
                              </span>
                            </>
                          ) : (
                            <>
                              <UploadIcon className="size-4 text-muted-foreground/40" />
                              <div className="text-center">
                                <span className="text-muted-foreground/70 text-xs">
                                  Drag & drop or{" "}
                                </span>
                                <button
                                  onClick={handleAddAttachments}
                                  className="font-medium text-foreground/70 text-xs underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                                >
                                  browse files
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Project location */}
                  <div>
                    <button
                      onClick={() => setLocationOpen(!locationOpen)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
                    >
                      <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/50">
                        <MapPinIcon className="size-3 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-sm">
                          Project location
                        </span>
                      </div>
                      {!locationOpen && projectFolder && projectName.trim() && (
                        <span className="min-w-0 max-w-35 truncate rounded-md bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground/60">
                          .../{projectFolder.split("/").pop()}/
                          {projectName.trim()}
                        </span>
                      )}
                      <ChevronDownIcon
                        className={`size-4 text-muted-foreground/60 transition-transform duration-200 ${locationOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    {locationOpen && (
                      <div className="space-y-2 px-4 pb-3">
                        <div className="flex gap-2">
                          <Input
                            placeholder="Project name"
                            value={projectName}
                            onChange={(e) => setProjectName(e.target.value)}
                            className="flex-1 rounded-lg border-border/60 bg-background/50"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0 gap-1.5 rounded-lg border-border/60"
                            onClick={handleChooseFolder}
                          >
                            <FolderOpenIcon className="size-3.5" />
                            {projectFolder ? "Change" : "Choose"}
                          </Button>
                        </div>
                        {projectFolder && (
                          <p className="truncate rounded-md bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground/60">
                            {projectFolder}/{projectName.trim() || "..."}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Create button — sticky footer */}
            <div className="shrink-0 border-border/60 border-t px-5 py-4">
              <Button
                className="w-full gap-2 rounded-xl font-semibold shadow-sm transition-all hover:shadow-md active:scale-[0.99]"
                size="lg"
                disabled={!canCreate || isCreating}
                onClick={handleCreate}
              >
                {isCreating ? (
                  <>
                    <Loader2Icon className="size-4 animate-spin" />
                    Creating project...
                  </>
                ) : purpose.trim() ? (
                  <>
                    <SparklesIcon className="size-4" />
                    Create & Generate with AI
                  </>
                ) : (
                  "Create Project"
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
