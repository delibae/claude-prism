import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { documentDir } from "@tauri-apps/api/path";
import {
  ArrowLeftIcon,
  FolderOpenIcon,
  PaperclipIcon,
  XIcon,
  SparklesIcon,
  UploadIcon,
  ChevronDownIcon,
  FileTextIcon,
  MapPinIcon,
  Loader2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { exists, join } from "@/lib/tauri/fs";
import { getTemplateById, getTemplateSkeleton, BIB_TEMPLATE } from "@/lib/template-registry";
import { TemplateGallery } from "@/components/template-gallery";

// ─── Helpers ───

function randomProjectName(): string {
  const adjectives = ["swift", "bright", "calm", "bold", "keen", "warm", "pure", "vast", "deep", "fair"];
  const nouns = ["paper", "draft", "thesis", "note", "study", "essay", "report", "brief", "folio", "opus"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const id = Math.random().toString(36).slice(2, 6);
  return `${adj}-${noun}-${id}`;
}

// ─── Wizard Component ───

export type CreationMode = "template" | "scratch";

interface ProjectWizardProps {
  mode: CreationMode;
  onBack: () => void;
}

export function ProjectWizard({ mode, onBack }: ProjectWizardProps) {
  // ── Template mode: just show the gallery ──
  // The TemplatePreview modal inside the gallery handles details + creation.
  if (mode === "template") {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 pt-[var(--titlebar-height)] h-[calc(48px+var(--titlebar-height))]">
          <Button variant="ghost" size="icon" className="size-7 rounded-lg" onClick={onBack}>
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="font-semibold text-sm">Choose a Template</span>
        </div>
        <div className="flex-1 overflow-hidden">
          <TemplateGallery />
        </div>
      </div>
    );
  }

  // ── Scratch mode: inline details form ──
  return <ScratchForm onBack={onBack} />;
}

// ─── Scratch mode form (no template preview) ───

function ScratchForm({ onBack }: { onBack: () => void }) {
  const [purpose, setPurpose] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [projectFolder, setProjectFolder] = useState<string | null>(null);
  const [projectName, setProjectName] = useState(randomProjectName);
  const [isCreating, setIsCreating] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [refFilesOpen, setRefFilesOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const lastProjectFolder = useProjectStore((s) => s.lastProjectFolder);
  const setLastProjectFolder = useProjectStore((s) => s.setLastProjectFolder);
  const openProject = useDocumentStore((s) => s.openProject);

  const template = getTemplateById("blank")!;

  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (projectFolder) return;
    if (lastProjectFolder) {
      setProjectFolder(lastProjectFolder);
    } else {
      documentDir().then((dir) => setProjectFolder(dir)).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChooseFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose Location for New Project" });
    if (selected) {
      setProjectFolder(selected);
      setLastProjectFolder(selected);
    }
  }, [setLastProjectFolder]);

  const handleAddAttachments = useCallback(async () => {
    const selected = await open({
      multiple: true,
      title: "Add Reference Files",
      filters: [{
        name: "Documents & Images",
        extensions: ["pdf", "tex", "bib", "txt", "md", "png", "jpg", "jpeg", "gif", "svg", "csv", "tsv", "json"],
      }],
    });
    if (selected) {
      const paths = Array.isArray(selected) ? selected : [selected];
      setAttachments((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
    }
  }, []);

  const handleRemoveAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  };

  // Drag-drop
  useEffect(() => {
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
            setAttachments((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
          }
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});

    return () => { cancelled = true; unlisten?.(); };
  }, []);

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
        const attachmentNames = attachments.map((p) => p.split("/").pop()).filter(Boolean);
        const attachmentSection = attachmentNames.length > 0
          ? `\n### Reference Files\n${attachmentNames.map((n) => `- \`${n}\``).join("\n")}\n\nPlease review them and incorporate relevant information.\n`
          : "";

        const prompt = [
          `## New ${template.name} Project`,
          "",
          `| | |`,
          `|---|---|`,
          `| **Template** | \`${template.documentClass}\` |`,
          `| **File** | \`${template.mainFileName}\` |`,
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
        await useDocumentStore.getState().importFiles(attachments, "attachments");
      }
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setIsCreating(false);
    }
  };

  const canCreate = template && projectFolder && projectName.trim();

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 pt-[var(--titlebar-height)] h-[calc(48px+var(--titlebar-height))]">
        <Button variant="ghost" size="icon" className="size-7 rounded-lg" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
        </Button>
        <span className="font-semibold text-sm">New Document</span>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[520px] space-y-4 px-6 py-10">
          {/* Purpose */}
          <div className="space-y-2.5">
            <div>
              <label className="font-semibold text-sm">What are you writing?</label>
              <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                Describe your document and Claude will generate tailored content.
              </p>
            </div>
            <Textarea
              ref={textareaRef}
              placeholder="e.g., A research paper on transformer architectures for protein structure prediction, targeting NeurIPS 2025..."
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={4}
              className="resize-none rounded-xl border-border/60 bg-card/30 text-sm leading-relaxed placeholder:text-muted-foreground/50 focus-visible:bg-card/50"
            />
          </div>

          {/* Collapsible sections */}
          <div className="rounded-xl border border-border/60 bg-card/30 divide-y divide-border/40 overflow-hidden">
            {/* Reference files */}
            <div>
              <button
                onClick={() => setRefFilesOpen(!refFilesOpen)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                  <FileTextIcon className="size-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">Reference files</span>
                  {attachments.length > 0 && (
                    <span className="ml-2 inline-flex items-center justify-center rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary">
                      {attachments.length}
                    </span>
                  )}
                </div>
                <ChevronDownIcon
                  className={`size-4 text-muted-foreground/60 transition-transform duration-200 ${refFilesOpen ? "rotate-180" : ""}`}
                />
              </button>
              {refFilesOpen && (
                <div className="px-4 pb-4 space-y-3">
                  {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {attachments.map((path) => (
                        <div
                          key={path}
                          className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 pl-2.5 pr-1.5 py-1 text-xs transition-colors hover:bg-muted/60"
                        >
                          <PaperclipIcon className="size-3 shrink-0 text-muted-foreground/70" />
                          <span className="max-w-[140px] truncate text-foreground/80">{path.split("/").pop()}</span>
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
                    className={`flex flex-col items-center gap-2 rounded-lg border border-dashed p-4 transition-all ${
                      isDragOver
                        ? "border-primary bg-primary/5 scale-[1.01]"
                        : "border-border/60 hover:border-border hover:bg-muted/20"
                    }`}
                  >
                    {isDragOver ? (
                      <>
                        <UploadIcon className="size-5 text-primary" />
                        <span className="text-xs font-medium text-primary">Drop to add</span>
                      </>
                    ) : (
                      <>
                        <UploadIcon className="size-5 text-muted-foreground/40" />
                        <div className="text-center">
                          <span className="text-xs text-muted-foreground/70">Drag & drop or </span>
                          <button
                            onClick={handleAddAttachments}
                            className="text-xs font-medium text-foreground/70 underline underline-offset-2 decoration-border hover:text-foreground hover:decoration-foreground/50 transition-colors"
                          >
                            browse files
                          </button>
                        </div>
                        <span className="text-[10px] text-muted-foreground/40">
                          PDF, TEX, BIB, images, or data files
                        </span>
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
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                  <MapPinIcon className="size-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">Project location</span>
                </div>
                {!locationOpen && projectFolder && projectName.trim() && (
                  <span className="min-w-0 max-w-[180px] truncate rounded-md bg-muted/40 px-2 py-0.5 text-[11px] font-mono text-muted-foreground/60">
                    .../{projectFolder.split("/").pop()}/{projectName.trim()}
                  </span>
                )}
                <ChevronDownIcon
                  className={`size-4 text-muted-foreground/60 transition-transform duration-200 ${locationOpen ? "rotate-180" : ""}`}
                />
              </button>
              {locationOpen && (
                <div className="px-4 pb-4 space-y-2.5">
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

          {/* Create button */}
          <div className="pt-1">
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
        </div>
      </div>
    </div>
  );
}
