import { type FC, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpIcon, SquareIcon, XIcon, FileTextIcon, FileCodeIcon, FileIcon, ImageIcon, FileSpreadsheetIcon, PaperclipIcon, ZapIcon, CheckIcon, ChevronDownIcon, SparklesIcon, RabbitIcon, LayersIcon } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { writeFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { useClaudeChatStore, offsetToLineCol } from "@/stores/claude-chat-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { getUniqueTargetName } from "@/lib/tauri/fs";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { SlashCommandPicker, type SlashCommand } from "./slash-command-picker";

interface PinnedContext {
  label: string;       // @file:line:col-line:col
  filePath: string;
  selectedText: string;
  imageDataUrl?: string; // thumbnail for captured images
}

function getFileIcon(file: ProjectFile) {
  if (file.type === "image") return <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "pdf") return <FileSpreadsheetIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "style") return <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "other") return <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

export const ChatComposer: FC = () => {
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);
  const cancelExecution = useClaudeChatStore((s) => s.cancelExecution);
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const selectedModel = useClaudeChatStore((s) => s.selectedModel);
  const setSelectedModel = useClaudeChatStore((s) => s.setSelectedModel);
  const effortLevel = useClaudeChatStore((s) => s.effortLevel);
  const setEffortLevel = useClaudeChatStore((s) => s.setEffortLevel);
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Model picker state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const [pickerPos, setPickerPos] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 });

  // Recalculate popup position when it opens
  useLayoutEffect(() => {
    if (!modelPickerOpen || !modelButtonRef.current) return;
    const rect = modelButtonRef.current.getBoundingClientRect();
    setPickerPos({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 4,
    });
  }, [modelPickerOpen]);

  // Pinned contexts — supports multiple files/selections
  const [pinnedContexts, setPinnedContexts] = useState<PinnedContext[]>([]);

  // File drop state
  const [isDragOver, setIsDragOver] = useState(false);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<ProjectFile[]>([]);
  const mentionRef = useRef<HTMLDivElement>(null);

  // / slash command state
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const slashFilteredCountRef = useRef(0);

  // Watch selection changes to auto-pin context
  const selectionRange = useDocumentStore((s) => s.selectionRange);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const files = useDocumentStore((s) => s.files);
  const importFiles = useDocumentStore((s) => s.importFiles);
  const refreshFiles = useDocumentStore((s) => s.refreshFiles);
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  // Consume pending attachments from external sources (e.g. PDF capture)
  const pendingAttachments = useClaudeChatStore((s) => s.pendingAttachments);
  const consumePendingAttachments = useClaudeChatStore((s) => s.consumePendingAttachments);

  useEffect(() => {
    if (pendingAttachments.length === 0) return;
    const attachments = consumePendingAttachments();
    if (attachments.length === 0) return;
    setPinnedContexts((prev) => {
      const existingLabels = new Set(prev.map((c) => c.label));
      const unique = attachments.filter((a) => !existingLabels.has(a.label));
      return [...prev, ...unique];
    });
    // Focus textarea so user can type immediately
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [pendingAttachments, consumePendingAttachments]);

  const currentContextLabel = useMemo(() => {
    if (!selectionRange) return null;
    const file = files.find((f) => f.id === activeFileId);
    if (!file?.content) return null;
    const start = offsetToLineCol(file.content, selectionRange.start);
    const end = offsetToLineCol(file.content, selectionRange.end);
    return `@${file.relativePath}:${start.line}:${start.col}-${end.line}:${end.col}`;
  }, [selectionRange, activeFileId, files]);

  // Auto-pin when a new selection is made
  useEffect(() => {
    if (!selectionRange || !currentContextLabel) return;
    const file = files.find((f) => f.id === activeFileId);
    if (!file?.content) return;
    // Replace any existing selection-based context (keep file contexts)
    setPinnedContexts((prev) => {
      const filtered = prev.filter((c) => !c.label.includes(":") || c.label.startsWith("@attachments/"));
      return [
        ...filtered,
        {
          label: currentContextLabel,
          filePath: file.relativePath,
          selectedText: file.content!.slice(selectionRange.start, selectionRange.end),
        },
      ];
    });
  }, [selectionRange, currentContextLabel, activeFileId, files]);

  // Compute @ mention matches
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionFiles([]);
      return;
    }
    const q = mentionQuery.toLowerCase();
    const matched = files
      .filter((f) => f.relativePath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
      .slice(0, 8);
    setMentionFiles(matched);
    setMentionIndex(0);
  }, [mentionQuery, files]);

  // Load slash commands when picker is activated
  useEffect(() => {
    if (slashQuery === null) {
      setSlashCommands([]);
      return;
    }
    invoke<SlashCommand[]>("slash_commands_list", {
      projectPath: projectRoot ?? undefined,
    })
      .then(setSlashCommands)
      .catch(() => setSlashCommands([]));
  }, [slashQuery !== null, projectRoot]);

  // Compute filtered slash command count for keyboard navigation bounds
  useEffect(() => {
    if (slashQuery === null || slashCommands.length === 0) {
      slashFilteredCountRef.current = 0;
      return;
    }
    const q = slashQuery.toLowerCase();
    if (!q) {
      slashFilteredCountRef.current = slashCommands.length;
    } else {
      slashFilteredCountRef.current = slashCommands.filter((cmd) => {
        if (cmd.name.toLowerCase().includes(q)) return true;
        if (cmd.full_command.toLowerCase().includes(q)) return true;
        if (cmd.namespace && cmd.namespace.toLowerCase().includes(q)) return true;
        if (cmd.description && cmd.description.toLowerCase().includes(q)) return true;
        return false;
      }).length;
    }
  }, [slashQuery, slashCommands]);

  const selectMention = useCallback((file: ProjectFile) => {
    // Replace @query with empty and pin the file as context
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart;
    // Find the @ position before cursor
    const textBefore = input.slice(0, cursorPos);
    const atIndex = textBefore.lastIndexOf("@");
    if (atIndex === -1) return;
    const newInput = input.slice(0, atIndex) + input.slice(cursorPos);
    setInput(newInput);
    setMentionQuery(null);

    // Pin the whole file as context
    const isTextFile = file.type === "tex" || file.type === "bib" || file.type === "style" || file.type === "other";
    setPinnedContexts((prev) => [
      ...prev,
      {
        label: `@${file.relativePath}`,
        filePath: file.relativePath,
        selectedText: isTextFile
          ? (file.content ?? "")
          : `[Referenced file: ${file.relativePath} (${file.type} file)]`,
      },
    ]);

    // Refocus textarea
    setTimeout(() => textarea.focus(), 0);
  }, [input]);

  const selectSlashCommand = useCallback((command: SlashCommand) => {
    // Insert command text into input (opcode-style: insert as template, don't send immediately)
    const newInput = command.accepts_arguments
      ? `${command.full_command} `
      : command.content;

    setInput(newInput);
    setSlashQuery(null);
    setSlashIndex(0);

    // Refocus and move cursor to end
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = newInput.length;
        // Auto-resize
        textarea.style.height = "auto";
        textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
      }
    }, 0);
  }, []);

  // Handle file drops — guard against duplicate calls from stale HMR listeners
  const isProcessingDropRef = useRef(false);
  const handleFileDropRef = useRef<(paths: string[]) => Promise<void>>(async () => {});
  handleFileDropRef.current = async (paths: string[]) => {
    if (!projectRoot || paths.length === 0) return;
    if (isProcessingDropRef.current) return;
    isProcessingDropRef.current = true;

    try {
      // Import files to attachments/ folder — returns actual (deduplicated) relative paths
      const importedPaths = await importFiles(paths, "attachments");

      // Pin each file as context
      const storeFiles = useDocumentStore.getState().files;
      const newContexts: PinnedContext[] = [];

      for (const relativePath of importedPaths) {
        const imported = storeFiles.find((f) => f.relativePath === relativePath);

        if (imported) {
          const isText = imported.type === "tex" || imported.type === "bib" || imported.type === "style" || imported.type === "other";
          newContexts.push({
            label: `@${relativePath}`,
            filePath: relativePath,
            selectedText: isText
              ? (imported.content ?? "")
              : `[Attached file: ${relativePath} (${imported.type} file)]`,
          });
        } else {
          // File imported but type might be filtered out — still pin as reference
          newContexts.push({
            label: `@${relativePath}`,
            filePath: relativePath,
            selectedText: `[Attached file: ${relativePath}]`,
          });
        }
      }

      if (newContexts.length > 0) {
        setPinnedContexts((prev) => {
          // Deduplicate by label
          const existingLabels = new Set(prev.map((c) => c.label));
          const unique = newContexts.filter((c) => !existingLabels.has(c.label));
          return [...prev, ...unique];
        });
      }
    } finally {
      isProcessingDropRef.current = false;
    }
  };

  // Listen for Tauri drag-drop events (OS file drops)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (cancelled) return;
        const { type } = event.payload;
        if (type === "enter") {
          setIsDragOver(true);
        } else if (type === "drop") {
          setIsDragOver(false);
          // Skip if the sidebar already handled this drop (OS file dropped on sidebar file tree)
          if ((window as any).__sidebarHandledDrop) {
            console.log("[chat-drop] skipped — sidebar handled this drop");
            return;
          }
          const paths = (event.payload as { paths: string[] }).paths;
          if (paths?.length > 0) {
            await handleFileDropRef.current?.(paths);
          }
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // Not in Tauri environment (dev mode), ignore
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Handle clipboard paste — detect files (screenshots, images) and save to attachments/
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const clipboardFiles = e.clipboardData?.files;
      if (!clipboardFiles || clipboardFiles.length === 0 || !projectRoot) return;

      // Check if there are actual file items (not just text)
      const fileItems = Array.from(clipboardFiles);
      if (fileItems.length === 0) return;

      e.preventDefault();

      const newContexts: PinnedContext[] = [];

      for (const file of fileItems) {
        // Generate a filename — use the original name or a timestamp-based name for screenshots
        let fileName = file.name;
        if (!fileName || fileName === "image.png") {
          const ext = file.type.split("/")[1] || "png";
          fileName = `paste-${Date.now()}.${ext}`;
        }

        const targetName = `attachments/${fileName}`;

        try {
          // Ensure attachments/ directory exists
          const attachmentsDir = await join(projectRoot, "attachments");
          if (!(await exists(attachmentsDir))) {
            await mkdir(attachmentsDir, { recursive: true });
          }

          // Deduplicate filename
          const uniqueName = await getUniqueTargetName(projectRoot, targetName);
          const fullPath = await join(projectRoot, uniqueName);

          // Read file data and write to disk
          const buffer = await file.arrayBuffer();
          await writeFile(fullPath, new Uint8Array(buffer));

          // Determine if it's a text file
          const isText = file.type.startsWith("text/");
          const content = isText ? await file.text() : `[Attached file: ${uniqueName} (${file.type})]`;

          newContexts.push({
            label: `@${uniqueName}`,
            filePath: uniqueName,
            selectedText: content,
          });
        } catch (err) {
          console.error("[chat-paste] failed to save file:", fileName, err);
        }
      }

      if (newContexts.length > 0) {
        // Refresh file list so the store knows about new files
        await refreshFiles();

        setPinnedContexts((prev) => {
          const existingLabels = new Set(prev.map((c) => c.label));
          const unique = newContexts.filter((c) => !existingLabels.has(c.label));
          return [...prev, ...unique];
        });
      }
    },
    [projectRoot, refreshFiles],
  );

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    // Resolve slash commands: if input starts with /command, find the command and substitute $ARGUMENTS
    let finalPrompt = trimmed;
    const slashMatch = trimmed.match(/^\/(\S+)\s*([\s\S]*)/);
    if (slashMatch && slashCommands.length > 0) {
      const cmdName = slashMatch[1];
      const args = slashMatch[2].trim();
      const matched = slashCommands.find(
        (cmd) => cmd.full_command === `/${cmdName}` || cmd.name === cmdName,
      );
      if (matched) {
        finalPrompt = matched.content;
        if (matched.accepts_arguments && args) {
          finalPrompt = finalPrompt.replace(/\$ARGUMENTS/g, args);
        }
      }
    }

    setInput("");
    setMentionQuery(null);
    setSlashQuery(null);
    // Send with pinned context override
    if (pinnedContexts.length > 0) {
      const combinedLabel = pinnedContexts.map((c) => c.label).join(", ");
      const combinedText = pinnedContexts.map((c) => c.selectedText).join("\n\n---\n\n");
      sendPrompt(finalPrompt, {
        label: combinedLabel,
        filePath: pinnedContexts[0].filePath,
        selectedText: combinedText,
      });
    } else {
      sendPrompt(finalPrompt);
    }
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // Clear pinned contexts after send
    setPinnedContexts([]);
  }, [input, isStreaming, sendPrompt, pinnedContexts, slashCommands]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // / slash command navigation
      if (slashQuery !== null && slashFilteredCountRef.current > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => Math.min(i + 1, slashFilteredCountRef.current - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          // Tab selects the command — trigger via a DOM query for the active item
          // We'll let the picker handle it via onSelect
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashQuery(null);
          setSlashIndex(0);
          return;
        }
      }

      // @ mention navigation
      if (mentionQuery !== null && mentionFiles.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => Math.min(i + 1, mentionFiles.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          selectMention(mentionFiles[mentionIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      // Backspace at start of empty input removes last pinned context
      if (e.key === "Backspace" && pinnedContexts.length > 0 && input === "") {
        e.preventDefault();
        setPinnedContexts((prev) => prev.slice(0, -1));
      }
    },
    [handleSend, pinnedContexts, input, mentionQuery, mentionFiles, mentionIndex, selectMention, slashQuery],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInput(value);

      // Detect / slash command trigger — only at the very start of input
      const slashMatch = value.match(/^\/(\S*)$/);
      const slashMatchWithArgs = value.match(/^\/(\S+)\s/);
      if (slashMatch) {
        setSlashQuery(slashMatch[1]);
        setSlashIndex(0);
        setMentionQuery(null);
      } else if (slashMatchWithArgs) {
        // Keep slash picker open while typing args after command name
        setSlashQuery(slashMatchWithArgs[1]);
      } else if (!value.startsWith("/")) {
        setSlashQuery(null);
        setSlashIndex(0);
      }

      // Detect @ mention trigger (only when not in slash command mode)
      if (!value.startsWith("/")) {
        const cursorPos = e.target.selectionStart;
        const textBefore = value.slice(0, cursorPos);
        // Match @ at start of input or after a space
        const atMatch = textBefore.match(/(?:^|[\s])@([^\s]*)$/);
        if (atMatch) {
          setMentionQuery(atMatch[1]);
        } else {
          setMentionQuery(null);
        }
      }

      // Auto-resize
      const el = e.target;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    },
    [],
  );

  // Scroll active mention into view
  useEffect(() => {
    if (mentionRef.current) {
      const active = mentionRef.current.querySelector("[data-active=true]");
      active?.scrollIntoView({ block: "nearest" });
    }
  }, [mentionIndex]);

  // Close model picker on click outside
  useEffect(() => {
    if (!modelPickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        modelPickerRef.current && !modelPickerRef.current.contains(target) &&
        modelButtonRef.current && !modelButtonRef.current.contains(target)
      ) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [modelPickerOpen]);

  return (
    <div className="relative shrink-0 p-3">
      {/* / slash command picker */}
      {slashQuery !== null && (
        <SlashCommandPicker
          projectPath={projectRoot}
          query={slashQuery}
          selectedIndex={slashIndex}
          onSelect={selectSlashCommand}
          onClose={() => {
            setSlashQuery(null);
            setSlashIndex(0);
          }}
        />
      )}

      {/* Model picker popup — portal to body to escape all stacking contexts */}
      {modelPickerOpen && createPortal(
        <div
          ref={modelPickerRef}
          className="fixed w-64 rounded-lg border border-border bg-background shadow-lg"
          style={{ left: pickerPos.left, bottom: pickerPos.bottom, zIndex: 9999 }}
        >
          {/* Models */}
          <div className="p-1">
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Model</div>
            {([
              { id: "sonnet" as const, name: "Sonnet", desc: "Fast, efficient for most tasks", icon: <ZapIcon className="size-3.5" /> },
              { id: "opus" as const, name: "Opus", desc: "Most capable, complex reasoning", icon: <SparklesIcon className="size-3.5" /> },
              { id: "haiku" as const, name: "Haiku", desc: "Fastest, simple tasks", icon: <RabbitIcon className="size-3.5" /> },
              { id: "opusplan" as const, name: "OpusPlan", desc: "Opus for planning, Sonnet for execution", icon: <LayersIcon className="size-3.5" /> },
            ]).map((m) => (
              <button
                key={m.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors",
                  selectedModel === m.id ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                )}
                onClick={() => setSelectedModel(m.id)}
              >
                {m.icon}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-xs">{m.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{m.desc}</div>
                </div>
                {selectedModel === m.id && <CheckIcon className="size-3 shrink-0" />}
              </button>
            ))}
          </div>

          <div className="border-t border-border" />

          {/* Effort level */}
          <div className="p-2">
            <div className="flex items-center justify-between px-1 mb-1.5">
              <span className="text-xs font-medium text-muted-foreground">Effort</span>
              <span className="text-xs text-muted-foreground">
                {effortLevel === "low" ? "Low" : effortLevel === "medium" ? "Medium" : "High"}
              </span>
            </div>
            <div className="flex gap-1">
              {(["low", "medium", "high"] as const).map((level) => (
                <button
                  key={level}
                  className={cn(
                    "flex-1 rounded-md py-1 text-center text-xs font-medium transition-colors",
                    effortLevel === level
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80",
                  )}
                  onClick={() => setEffortLevel(level)}
                >
                  {level === "low" ? "L" : level === "medium" ? "M" : "H"}
                </button>
              ))}
            </div>
          </div>

        </div>,
        document.body,
      )}

      {/* @ mention dropdown */}
      {slashQuery === null && mentionQuery !== null && mentionFiles.length > 0 && (
        <div
          ref={mentionRef}
          className="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-background shadow-lg"
        >
          {mentionFiles.map((file, i) => {
            const parts = file.relativePath.split("/");
            const fileName = parts.pop()!;
            const dirPath = parts.length > 0 ? parts.join("/") + "/" : "";
            return (
              <button
                key={file.id}
                data-active={i === mentionIndex}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                  i === mentionIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                )}
                onMouseDown={(e) => {
                  e.preventDefault(); // prevent textarea blur
                  selectMention(file);
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                {getFileIcon(file)}
                <span className="truncate font-mono text-sm">{fileName}</span>
                {dirPath && (
                  <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{dirPath}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div
        className={cn(
          "flex w-full flex-col rounded-2xl border border-input bg-muted/30 transition-colors focus-within:border-ring focus-within:bg-background",
          isDragOver && "border-ring bg-accent/20",
        )}
      >
        {/* Pinned context chips */}
        {pinnedContexts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3 pb-0">
            {pinnedContexts.map((ctx, i) =>
              ctx.imageDataUrl ? (
                <div
                  key={`${ctx.label}-${i}`}
                  className="group relative overflow-hidden rounded-lg border border-border bg-muted"
                >
                  <img
                    src={ctx.imageDataUrl}
                    alt={ctx.label}
                    className="block h-16 w-auto object-contain"
                  />
                  <button
                    onClick={() => setPinnedContexts((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute top-0.5 right-0.5 rounded-full bg-background/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ) : (
                <span
                  key={`${ctx.label}-${i}`}
                  className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
                >
                  {ctx.label}
                  <button
                    onClick={() => setPinnedContexts((prev) => prev.filter((_, idx) => idx !== i))}
                    className="ml-0.5 rounded-sm p-0.5 transition-colors hover:bg-muted-foreground/20"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ),
            )}
          </div>
        )}

        {isDragOver ? (
          <div className="flex min-h-10 items-center justify-center px-4 py-3 text-sm text-muted-foreground">
            <PaperclipIcon className="mr-2 size-4" />
            Drop files to attach
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Ask me anything (/ for commands, @ to mention)"
            className="max-h-40 min-h-10 w-full resize-none bg-transparent px-4 py-2 text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
            rows={1}
          />
        )}

        <div className="flex items-center justify-between px-2 pb-2">
          {/* Model & settings selector */}
          <div>
            <button
              ref={modelButtonRef}
              type="button"
              onClick={() => setModelPickerOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <span>
                {selectedModel === "sonnet" ? "Sonnet" : selectedModel === "opus" ? "Opus" : selectedModel === "haiku" ? "Haiku" : "OpusPlan"}
              </span>
              <span className="text-muted-foreground/60">
                {effortLevel === "low" ? "L" : effortLevel === "medium" ? "M" : "H"}
              </span>
              <ChevronDownIcon className="size-3" />
            </button>
          </div>

          {isStreaming ? (
            <TooltipIconButton
              tooltip="Stop"
              side="top"
              variant="secondary"
              size="icon"
              className="size-8 rounded-full"
              onClick={cancelExecution}
            >
              <SquareIcon className="size-3 fill-current" />
            </TooltipIconButton>
          ) : (
            <TooltipIconButton
              tooltip="Send"
              side="top"
              variant="default"
              size="icon"
              className="size-8 rounded-full"
              onClick={handleSend}
              disabled={!input.trim()}
            >
              <ArrowUpIcon className="size-4" />
            </TooltipIconButton>
          )}
        </div>
      </div>
    </div>
  );
};
