import {
  type CSSProperties,
  type FC,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpIcon,
  SquareIcon,
  XIcon,
  FileTextIcon,
  FileCodeIcon,
  FileIcon,
  ImageIcon,
  FileSpreadsheetIcon,
  PaperclipIcon,
  CheckIcon,
  ChevronDownIcon,
  SparklesIcon,
  PlusIcon,
  Trash2Icon,
  Loader2Icon,
  CornerDownRightIcon,
  ListEndIcon,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { writeFile, mkdir, exists, remove } from "@tauri-apps/plugin-fs";
import { join, tempDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import {
  CLAUDE_CODE_PROVIDER_ID,
  loadSelectedProviderCredentialId,
  offsetToLineCol,
  type PromptContextOverride,
  type QueuedGuidance,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";
import {
  useClaudeSetupStore,
  type OpenAiCompatibleCredentialInfo,
} from "@/stores/claude-setup-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { getUniqueTargetName } from "@/lib/tauri/fs";
import {
  getProviderDisplayName,
  getProviderIconSrc,
} from "@/lib/provider-icons";
import {
  getModelCapabilities,
  isChatModelOption,
  modelInfoId,
  type OpenAiCompatibleModelInfo,
  rememberModelListCapabilityMetadata,
} from "@/lib/model-capabilities";
import { ModelCapabilityBadges } from "@/components/model-capability-badges";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { ClaudeSetup } from "@/components/claude-setup";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SlashCommandPicker, type SlashCommand } from "./slash-command-picker";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("chat-composer");
const EMPTY_GUIDANCE: QueuedGuidance[] = [];

// Re-export for other modules
export type { SlashCommand };

interface PinnedContext {
  label: string;
  filePath: string;
  selectedText: string;
  imageDataUrl?: string; // thumbnail for captured images
  isTemporary?: boolean;
}

function pastedFileExtension(file: File) {
  const namedExt = file.name.split(".").pop()?.trim().toLowerCase();
  if (namedExt && namedExt !== file.name.toLowerCase()) return namedExt;
  return file.type.split("/")[1]?.split("+")[0] || "png";
}

function safePastedFileName(file: File, index: number) {
  const ext = pastedFileExtension(file).replace(/[^a-z0-9]/g, "") || "png";
  const base =
    file.name && file.name !== "image.png"
      ? file.name.replace(/\.[^.]+$/, "")
      : `paste-${Date.now()}-${index + 1}`;
  return `${base.replace(/[^a-zA-Z0-9._-]/g, "_")}.${ext}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

function temporaryFilePaths(contexts: PinnedContext[]) {
  return contexts
    .filter((context) => context.isTemporary)
    .map((context) => context.filePath);
}

async function cleanupTemporaryFilePaths(paths: string[] | undefined) {
  if (!paths?.length) return;
  await Promise.all(
    paths.map(async (path) => {
      try {
        await remove(path);
      } catch (err) {
        log.warn("Failed to remove temporary pasted file", {
          path,
          error: String(err),
        });
      }
    }),
  );
}

function cleanupTemporaryPinnedContext(context: PinnedContext) {
  if (!context.isTemporary) return;
  void cleanupTemporaryFilePaths([context.filePath]);
}

function pinnedContextDedupKey(context: PinnedContext) {
  return context.isTemporary
    ? `temporary:${context.filePath}`
    : `label:${context.label}`;
}

function appendUniquePinnedContexts(
  current: PinnedContext[],
  next: PinnedContext[],
) {
  const seen = new Set(current.map(pinnedContextDedupKey));
  const unique = next.filter((context) => {
    const key = pinnedContextDedupKey(context);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...current, ...unique];
}

function isPdfPath(path: string) {
  return path.toLowerCase().endsWith(".pdf");
}

function getFileIcon(file: ProjectFile) {
  if (file.type === "image")
    return <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "pdf")
    return (
      <FileSpreadsheetIcon className="size-3.5 shrink-0 text-muted-foreground" />
    );
  if (file.type === "style")
    return <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "other")
    return <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function formatGuidanceText(guidance: QueuedGuidance) {
  return guidance.contextOverride?.label
    ? `${guidance.contextOverride.label} - ${guidance.prompt}`
    : guidance.prompt;
}

type EffortLevel = "low" | "medium" | "high";
const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high"];

function effortShortLabel(level: EffortLevel) {
  return level === "low" ? "L" : level === "medium" ? "M" : "H";
}

function effortDisplayLabel(level: EffortLevel) {
  return effortShortLabel(level);
}

function EffortControls({
  effortLevel,
  setEffortLevel,
}: {
  effortLevel: EffortLevel;
  setEffortLevel: (level: EffortLevel) => void;
}) {
  return (
    <>
      <div className="my-1 border-border border-t" />
      <div className="px-2 py-1 font-medium text-muted-foreground text-xs">
        Effort
      </div>
      <div className="flex gap-1 px-2 pb-2">
        {EFFORT_LEVELS.map((level) => (
          <button
            key={level}
            className={cn(
              "flex-1 rounded-md py-1 text-center font-medium text-xs transition-colors",
              effortLevel === level
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
            onClick={() => setEffortLevel(level)}
          >
            {effortDisplayLabel(level)}
          </button>
        ))}
      </div>
    </>
  );
}

export const ChatComposer: FC<{ isOpen?: boolean }> = ({ isOpen }) => {
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);
  const setChatError = useClaudeChatStore((s) => s._setError);
  const queueGuidance = useClaudeChatStore((s) => s.queueGuidance);
  const cancelExecution = useClaudeChatStore((s) => s.cancelExecution);
  const removeQueuedGuidance = useClaudeChatStore(
    (s) => s.removeQueuedGuidance,
  );
  const forceQueuedGuidanceNow = useClaudeChatStore(
    (s) => s.forceQueuedGuidanceNow,
  );
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const selectedModel = useClaudeChatStore((s) => s.selectedModel);
  const setSelectedModel = useClaudeChatStore((s) => s.setSelectedModel);
  const selectedProviderCredentialId = useClaudeChatStore(
    (s) => s.selectedProviderCredentialId,
  );
  const setSelectedProviderCredentialId = useClaudeChatStore(
    (s) => s.setSelectedProviderCredentialId,
  );
  const selectedProviderModels = useClaudeChatStore(
    (s) => s.selectedProviderModels,
  );
  const setSelectedProviderModel = useClaudeChatStore(
    (s) => s.setSelectedProviderModel,
  );
  const effortLevel = useClaudeChatStore((s) => s.effortLevel);
  const setEffortLevel = useClaudeChatStore((s) => s.setEffortLevel);
  const activeTabId = useClaudeChatStore((s) => s.activeTabId);
  const queuedGuidance = useClaudeChatStore(
    (s) =>
      s.tabs.find((tab) => tab.id === s.activeTabId)?.queuedGuidance ??
      EMPTY_GUIDANCE,
  );
  const visibleQueuedGuidance = useMemo(
    () => queuedGuidance.filter((guidance) => !guidance.displayedInChat),
    [queuedGuidance],
  );
  const openAiCredentials = useClaudeSetupStore((s) => s.openAiCredentials);
  const activeOpenAiCredentialId = useClaudeSetupStore(
    (s) => s.activeOpenAiCredentialId,
  );
  const providerKind = useClaudeSetupStore((s) => s.providerKind);
  const setupStatus = useClaudeSetupStore((s) => s.status);
  const claudeProviderConfigured = useClaudeSetupStore(
    (s) => s.claudeProviderConfigured,
  );
  const deleteApiCredential = useClaudeSetupStore((s) => s.deleteApiCredential);
  const configuredOpenAiCredential =
    selectedProviderCredentialId &&
    selectedProviderCredentialId !== CLAUDE_CODE_PROVIDER_ID
      ? (openAiCredentials.find(
          (credential) => credential.id === selectedProviderCredentialId,
        ) ?? null)
      : null;
  const fallbackProviderCredential =
    (activeOpenAiCredentialId
      ? openAiCredentials.find(
          (credential) => credential.id === activeOpenAiCredentialId,
        )
      : null) ??
    openAiCredentials[0] ??
    null;
  const showClaudeProvider =
    claudeProviderConfigured ||
    (openAiCredentials.length === 0 && setupStatus !== "checking");
  const selectedProviderCredential =
    configuredOpenAiCredential ??
    (!showClaudeProvider ? fallbackProviderCredential : null);
  const claudeProviderActive =
    showClaudeProvider && !selectedProviderCredential;
  const providerSelectionReady =
    claudeProviderActive || !!selectedProviderCredential;
  const selectedProviderModel = selectedProviderCredential
    ? selectedProviderModels[selectedProviderCredential.id] ||
      selectedProviderCredential.model
    : null;
  const directProviderModel =
    selectedProviderModel || selectedProviderCredential?.model || "Provider";
  const selectedProviderSupportsVision = selectedProviderCredential
    ? getModelCapabilities({
        label: selectedProviderCredential.label,
        baseUrl: selectedProviderCredential.base_url,
        model: directProviderModel,
      }).vision
    : true;
  const selectedProviderDisplayName = selectedProviderCredential
    ? getProviderDisplayName({
        label: selectedProviderCredential.label,
        baseUrl: selectedProviderCredential.base_url,
        model: selectedProviderCredential.model,
      })
    : "Provider";
  const selectedProviderIconSrc = selectedProviderCredential
    ? getProviderIconSrc({
        label: selectedProviderCredential.label,
        baseUrl: selectedProviderCredential.base_url,
        model: selectedProviderCredential.model,
      })
    : null;
  const claudeCodeIconSrc = getProviderIconSrc({ label: "Anthropic" });
  const [providerModelOptions, setProviderModelOptions] = useState<
    Record<string, string[]>
  >({});
  const [providerModelLoadingId, setProviderModelLoadingId] = useState<
    string | null
  >(null);
  const [providerModelError, setProviderModelError] = useState<string | null>(
    null,
  );
  const [claudeModelOptions, setClaudeModelOptions] = useState<string[] | null>(
    null,
  );
  const [claudeModelsLoading, setClaudeModelsLoading] = useState(false);
  const [claudeModelsError, setClaudeModelsError] = useState<string | null>(
    null,
  );
  const [providerSetupOpen, setProviderSetupOpen] = useState(false);
  const [providerDeleteTarget, setProviderDeleteTarget] =
    useState<OpenAiCompatibleCredentialInfo | null>(null);
  const [providerDeleteError, setProviderDeleteError] = useState<string | null>(
    null,
  );
  const [deletingProviderId, setDeletingProviderId] = useState<string | null>(
    null,
  );
  const [input, setInput] = useState("");
  const hasInput = input.trim().length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hadStoredProviderSelectionRef = useRef(
    loadSelectedProviderCredentialId() !== null,
  );
  const initialProviderSyncDoneRef = useRef(false);

  // Model picker state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const providerModelListRef = useRef<HTMLDivElement>(null);
  const providerModelItemRefs = useRef<
    Record<string, HTMLButtonElement | null>
  >({});
  const [pickerPos, setPickerPos] = useState<{ left: number; bottom: number }>({
    left: 0,
    bottom: 0,
  });

  // Recalculate popup position when it opens
  useLayoutEffect(() => {
    if (!modelPickerOpen || !modelButtonRef.current) return;
    const rect = modelButtonRef.current.getBoundingClientRect();
    setPickerPos({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 4,
    });
  }, [modelPickerOpen]);

  useEffect(() => {
    if (
      !initialProviderSyncDoneRef.current &&
      setupStatus !== "checking" &&
      setupStatus !== "error"
    ) {
      initialProviderSyncDoneRef.current = true;
      if (
        !hadStoredProviderSelectionRef.current &&
        providerKind === "openai-compatible" &&
        fallbackProviderCredential &&
        selectedProviderCredentialId !== fallbackProviderCredential.id
      ) {
        setSelectedProviderCredentialId(fallbackProviderCredential.id);
        return;
      }
    }

    const selectedOpenAiCredentialMissing =
      selectedProviderCredentialId &&
      selectedProviderCredentialId !== CLAUDE_CODE_PROVIDER_ID &&
      !openAiCredentials.some(
        (credential) => credential.id === selectedProviderCredentialId,
      );
    const selectedClaudeUnavailable =
      selectedProviderCredentialId === CLAUDE_CODE_PROVIDER_ID &&
      !showClaudeProvider;
    const noProviderSelected =
      !selectedProviderCredentialId && !showClaudeProvider;

    if (
      selectedOpenAiCredentialMissing ||
      selectedClaudeUnavailable ||
      noProviderSelected
    ) {
      setSelectedProviderCredentialId(
        fallbackProviderCredential?.id ??
          (showClaudeProvider ? CLAUDE_CODE_PROVIDER_ID : null),
      );
    }
  }, [
    fallbackProviderCredential?.id,
    openAiCredentials,
    providerKind,
    selectedProviderCredentialId,
    setSelectedProviderCredentialId,
    setupStatus,
    showClaudeProvider,
  ]);

  const handleDeleteProviderCredential = useCallback(
    async (credentialId: string) => {
      if (deletingProviderId) return;

      const remainingCredentials = openAiCredentials.filter(
        (credential) => credential.id !== credentialId,
      );
      const deletingSelected =
        selectedProviderCredentialId === credentialId ||
        selectedProviderCredential?.id === credentialId;

      setDeletingProviderId(credentialId);
      setProviderDeleteError(null);
      try {
        const success = await deleteApiCredential(credentialId);
        if (!success) {
          setProviderDeleteError("Failed to delete this provider.");
          return;
        }

        setProviderModelOptions((prev) => {
          const next = { ...prev };
          delete next[credentialId];
          return next;
        });

        if (deletingSelected) {
          const nextCredential = remainingCredentials[0] ?? null;
          if (nextCredential) {
            setSelectedProviderCredentialId(nextCredential.id);
          } else {
            setSelectedProviderCredentialId(CLAUDE_CODE_PROVIDER_ID);
          }
        }
        setProviderDeleteTarget(null);
      } finally {
        setDeletingProviderId(null);
      }
    },
    [
      deleteApiCredential,
      deletingProviderId,
      openAiCredentials,
      selectedProviderCredential?.id,
      selectedProviderCredentialId,
      setSelectedProviderCredentialId,
    ],
  );

  useEffect(() => {
    if (!modelPickerOpen || !selectedProviderCredential) return;

    const credentialId = selectedProviderCredential.id;
    if (providerModelOptions[credentialId]) return;

    let cancelled = false;
    setProviderModelLoadingId(credentialId);
    setProviderModelError(null);

    invoke<Array<string | OpenAiCompatibleModelInfo>>(
      "list_openai_compatible_credential_models",
      {
        credentialId,
      },
    )
      .then((models) => {
        if (cancelled) return;
        rememberModelListCapabilityMetadata(
          selectedProviderCredential.base_url,
          models,
        );
        const modelIds = models
          .filter((model) =>
            isChatModelOption({
              label: selectedProviderCredential.label,
              baseUrl: selectedProviderCredential.base_url,
              model: modelInfoId(model),
              metadata: typeof model === "string" ? undefined : model.metadata,
            }),
          )
          .map(modelInfoId);
        const options = Array.from(new Set(modelIds.filter(Boolean)));
        if (
          selectedProviderCredential.model &&
          !options.includes(selectedProviderCredential.model)
        ) {
          options.push(selectedProviderCredential.model);
        }
        setProviderModelOptions((prev) => ({
          ...prev,
          [credentialId]: options,
        }));
      })
      .catch((err: any) => {
        if (cancelled) return;
        setProviderModelError(err?.message || String(err));
        setProviderModelOptions((prev) => ({
          ...prev,
          [credentialId]: [selectedProviderCredential.model].filter(Boolean),
        }));
      })
      .finally(() => {
        if (!cancelled) {
          setProviderModelLoadingId(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [modelPickerOpen, providerModelOptions, selectedProviderCredential]);

  // Pinned contexts — supports multiple files/selections
  const [pinnedContexts, setPinnedContexts] = useState<PinnedContext[]>([]);
  const hasPinnedImages = pinnedContexts.some(
    (context) => context.imageDataUrl,
  );
  const imageCompatibilityError =
    selectedProviderCredential &&
    hasPinnedImages &&
    !selectedProviderSupportsVision
      ? `${selectedProviderDisplayName} ${directProviderModel} does not support image input. Remove the pasted image or switch to a vision-capable model.`
      : null;

  useEffect(() => {
    if (imageCompatibilityError) {
      setChatError(activeTabId, imageCompatibilityError);
    }
  }, [activeTabId, imageCompatibilityError, setChatError]);

  // File drop state
  const [isDragOver, setIsDragOver] = useState(false);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<ProjectFile[]>([]);
  const mentionRef = useRef<HTMLDivElement>(null);

  // / slash command state
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const slashSelectedRef = useRef(false); // true after user picks a command — suppresses re-open

  // Keep refs to latest input/pinnedContexts so the tab-switch effect can
  // save the draft without depending on these values (which would cause loops).
  const inputRef = useRef(input);
  inputRef.current = input;
  const pinnedContextsRef = useRef(pinnedContexts);
  pinnedContextsRef.current = pinnedContexts;

  // Save draft to previous tab, restore draft from new tab
  const prevTabIdRef = useRef(activeTabId);
  useEffect(() => {
    const prevTabId = prevTabIdRef.current;
    if (prevTabId !== activeTabId) {
      // Save current input to the *previous* tab's draft (using refs for latest values)
      useClaudeChatStore.getState().saveDraft(prevTabId, {
        input: inputRef.current,
        pinnedContexts: pinnedContextsRef.current,
      });
    }
    prevTabIdRef.current = activeTabId;

    // Restore draft from the new active tab
    const tab = useClaudeChatStore
      .getState()
      .tabs.find((t) => t.id === activeTabId);
    const draft = tab?.draft;
    setInput(draft?.input ?? "");
    setPinnedContexts(draft?.pinnedContexts ?? []);
    setMentionQuery(null);
    setSlashQuery(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [activeTabId]);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const composerRef = useRef<HTMLDivElement>(null);

  // Watch selection changes to auto-pin context
  const selectionRange = useDocumentStore((s) => s.selectionRange);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const files = useDocumentStore((s) => s.files);
  const importFiles = useDocumentStore((s) => s.importFiles);
  const refreshFiles = useDocumentStore((s) => s.refreshFiles);
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  // Consume pending attachments from external sources (e.g. PDF capture)
  const pendingAttachments = useClaudeChatStore((s) => s.pendingAttachments);
  const consumePendingAttachments = useClaudeChatStore(
    (s) => s.consumePendingAttachments,
  );
  const pendingPinnedContextRemovalLabels = useClaudeChatStore(
    (s) => s.pendingPinnedContextRemovalLabels,
  );
  const consumePendingPinnedContextRemovals = useClaudeChatStore(
    (s) => s.consumePendingPinnedContextRemovals,
  );

  // Focus textarea when the drawer opens
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
    prevOpenRef.current = !!isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (pendingAttachments.length === 0) return;
    const attachments = consumePendingAttachments();
    if (attachments.length === 0) return;
    setPinnedContexts((prev) => {
      return appendUniquePinnedContexts(prev, attachments);
    });
    // Focus textarea so user can type immediately
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [pendingAttachments, consumePendingAttachments]);

  useEffect(() => {
    if (pendingPinnedContextRemovalLabels.length === 0) return;
    const labels = consumePendingPinnedContextRemovals();
    if (labels.length === 0) return;
    const labelsToRemove = new Set(labels);
    setPinnedContexts((prev) =>
      prev.filter((context) => !labelsToRemove.has(context.label)),
    );
  }, [pendingPinnedContextRemovalLabels, consumePendingPinnedContextRemovals]);

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
      const filtered = prev.filter(
        (c) => !c.label.includes(":") || c.label.startsWith("@attachments/"),
      );
      return [
        ...filtered,
        {
          label: currentContextLabel,
          filePath: file.relativePath,
          selectedText: file.content!.slice(
            selectionRange.start,
            selectionRange.end,
          ),
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
      .filter(
        (f) =>
          f.relativePath.toLowerCase().includes(q) ||
          f.name.toLowerCase().includes(q),
      )
      .slice(0, 8);
    setMentionFiles(matched);
    setMentionIndex(0);
  }, [mentionQuery, files]);

  // Load slash commands when picker is activated (keep loaded after close for send resolution)
  useEffect(() => {
    if (slashQuery === null) return;
    invoke<SlashCommand[]>("slash_commands_list", {
      projectPath: projectRoot ?? undefined,
    })
      .then(setSlashCommands)
      .catch(() => setSlashCommands([]));
  }, [slashQuery !== null, projectRoot]);

  const buildPinnedContextForFile = useCallback(
    async (file: ProjectFile): Promise<PinnedContext> => {
      const isTextFile =
        file.type === "tex" ||
        file.type === "bib" ||
        file.type === "style" ||
        file.type === "other";

      return {
        label: `@${file.relativePath}`,
        filePath: file.relativePath,
        selectedText: isTextFile
          ? (file.content ?? "")
          : `[Referenced file: ${file.relativePath} (${file.type} file)]`,
      };
    },
    [],
  );

  const selectMention = useCallback(
    async (file: ProjectFile) => {
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
      const context = await buildPinnedContextForFile(file);
      setPinnedContexts((prev) => [...prev, context]);

      // Refocus textarea
      setTimeout(() => textarea.focus(), 0);
    },
    [buildPinnedContextForFile, input],
  );

  const selectSlashCommand = useCallback((command: SlashCommand) => {
    // Insert command syntax into input (opcode-style)
    const newInput = command.accepts_arguments
      ? `${command.full_command} `
      : `${command.full_command} `;

    setInput(newInput);
    setSlashQuery(null);
    slashSelectedRef.current = true;

    // Refocus and move cursor to end
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = newInput.length;
        // Auto-resize
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
      }
    }, 0);
  }, []);

  // Handle file drops — guard against duplicate calls from stale HMR listeners
  const isProcessingDropRef = useRef(false);
  const handleFileDropRef = useRef<(paths: string[]) => Promise<void>>(
    async () => {},
  );
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
        const imported = storeFiles.find(
          (f) => f.relativePath === relativePath,
        );

        if (imported) {
          newContexts.push(await buildPinnedContextForFile(imported));
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
          return appendUniquePinnedContexts(prev, newContexts);
        });
      }
    } finally {
      isProcessingDropRef.current = false;
    }
  };

  const handleAttachFiles = useCallback(async () => {
    if (!projectRoot) return;
    const selected = await open({
      multiple: true,
      directory: false,
      title: "Attach files",
    });
    const paths =
      typeof selected === "string"
        ? [selected]
        : Array.isArray(selected)
          ? selected
          : [];
    if (paths.length === 0) return;
    await handleFileDropRef.current(paths);
  }, [projectRoot]);

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
            log.debug("skipped — sidebar handled this drop");
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
      if (!clipboardFiles || clipboardFiles.length === 0 || !projectRoot)
        return;

      // Check if there are actual file items (not just text)
      const fileItems = Array.from(clipboardFiles);
      if (fileItems.length === 0) return;

      e.preventDefault();

      const newContexts: PinnedContext[] = [];

      for (const [index, file] of fileItems.entries()) {
        if (file.type.startsWith("image/")) {
          try {
            const fileName = safePastedFileName(file, index);
            const tempRoot = await join(
              await tempDir(),
              "ClaudePrism",
              "chat-pastes",
            );
            if (!(await exists(tempRoot))) {
              await mkdir(tempRoot, { recursive: true });
            }
            const fullPath = await join(
              tempRoot,
              `${Date.now()}-${index + 1}-${fileName}`,
            );
            const buffer = await file.arrayBuffer();
            await writeFile(fullPath, new Uint8Array(buffer));

            newContexts.push({
              label:
                fileItems.length > 1
                  ? `Pasted image ${index + 1}`
                  : "Pasted image",
              filePath: fullPath,
              selectedText: [
                `[Temporary pasted image: ${fullPath}]`,
                "Use this image file as visual context for the user's message.",
              ].join("\n"),
              imageDataUrl: await readFileAsDataUrl(file),
              isTemporary: true,
            });
          } catch (err) {
            log.error("Failed to save pasted image", {
              fileName: file.name || "clipboard image",
              error: String(err),
            });
          }
          continue;
        }

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

          let content: string;

          if (isPdfPath(uniqueName) || file.type === "application/pdf") {
            content = `[Attached file: ${uniqueName} (PDF)]`;
          } else {
            // Determine if it's a text file
            const isText = file.type.startsWith("text/");
            content = isText
              ? await file.text()
              : `[Attached file: ${uniqueName} (${file.type})]`;
          }

          newContexts.push({
            label: `@${uniqueName}`,
            filePath: uniqueName,
            selectedText: content,
          });
        } catch (err) {
          log.error("Failed to save pasted file", {
            fileName,
            error: String(err),
          });
        }
      }

      if (newContexts.length > 0) {
        if (newContexts.some((context) => context.label.startsWith("@"))) {
          // Refresh only for files imported into the project tree.
          await refreshFiles();
        }

        setPinnedContexts((prev) => {
          return appendUniquePinnedContexts(prev, newContexts);
        });
      }
    },
    [projectRoot, refreshFiles],
  );

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (!providerSelectionReady) return;
    if (imageCompatibilityError) {
      setChatError(activeTabId, imageCompatibilityError);
      return;
    }

    // Resolve slash commands: if input starts with /command, find the command and substitute $ARGUMENTS
    // Skills (scope === "skill") are passed through as-is — Claude handles them via the Skill tool.
    let finalPrompt = trimmed;
    const slashMatch = trimmed.match(/^\/(\S+)\s*([\s\S]*)/);
    if (slashMatch && slashCommands.length > 0) {
      const cmdName = slashMatch[1];
      const args = slashMatch[2].trim();
      const matched = slashCommands.find(
        (cmd) => cmd.full_command === `/${cmdName}` || cmd.name === cmdName,
      );
      if (matched && matched.scope !== "skill") {
        finalPrompt = matched.content;
        if (matched.accepts_arguments && args) {
          finalPrompt = finalPrompt.replace(/\$ARGUMENTS/g, args);
        }
      }
    }

    setInput("");
    setMentionQuery(null);
    setSlashQuery(null);
    slashSelectedRef.current = false;

    let contextOverride: PromptContextOverride | undefined;
    if (pinnedContexts.length > 0) {
      const combinedLabel = pinnedContexts.map((c) => c.label).join(", ");
      const combinedText = pinnedContexts
        .map((c) => c.selectedText)
        .join("\n\n---\n\n");
      contextOverride = {
        label: combinedLabel,
        filePath: pinnedContexts[0].filePath,
        selectedText: combinedText,
        temporaryFilePaths: temporaryFilePaths(pinnedContexts),
      };
    }

    if (isStreaming) {
      queueGuidance(activeTabId, finalPrompt, contextOverride);
    } else if (contextOverride) {
      sendPrompt(finalPrompt, contextOverride);
    } else {
      sendPrompt(finalPrompt);
    }
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // Clear pinned contexts after send. Temporary files are removed by the
    // completion event once the provider has finished with them.
    setPinnedContexts([]);
  }, [
    activeTabId,
    input,
    isStreaming,
    queueGuidance,
    sendPrompt,
    pinnedContexts,
    imageCompatibilityError,
    providerSelectionReady,
    setChatError,
    slashCommands,
  ]);

  useEffect(() => {
    if (
      !modelPickerOpen ||
      !claudeProviderActive ||
      claudeModelOptions !== null
    ) {
      return;
    }

    let cancelled = false;
    let timedOut = false;
    setClaudeModelsLoading(true);
    setClaudeModelsError(null);

    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      timedOut = true;
      setClaudeModelOptions([]);
      setClaudeModelsLoading(false);
      setClaudeModelsError(
        "Model request timed out. Check the API key, Base URL, and network connection.",
      );
    }, 15_000);

    invoke<Array<string | OpenAiCompatibleModelInfo>>("list_claude_models")
      .then((models) => {
        if (cancelled || timedOut) return;
        const options = Array.from(
          new Set(models.map(modelInfoId).filter(Boolean)),
        );
        setClaudeModelOptions(options);
        if (options.length > 0 && !options.includes(selectedModel)) {
          setSelectedModel(options[0]);
        }
      })
      .catch((error) => {
        if (cancelled || timedOut) return;
        setClaudeModelOptions([]);
        setClaudeModelsError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!cancelled && !timedOut) setClaudeModelsLoading(false);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      setClaudeModelsLoading(false);
    };
  }, [
    claudeModelOptions,
    claudeProviderActive,
    modelPickerOpen,
    setSelectedModel,
  ]);

  const handleGuideQueuedGuidance = useCallback(
    (guidance: QueuedGuidance) => {
      if (isStreaming) {
        void forceQueuedGuidanceNow(activeTabId, guidance.id);
        return;
      }

      removeQueuedGuidance(activeTabId, guidance.id);
      void sendPrompt(guidance.prompt, guidance.contextOverride);
    },
    [
      activeTabId,
      forceQueuedGuidanceNow,
      isStreaming,
      removeQueuedGuidance,
      sendPrompt,
    ],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Slash command picker is open — let the picker handle keyboard events
      // (it uses window.addEventListener for ArrowUp/Down, Enter, Tab, Escape)
      if (slashQuery !== null) {
        if (
          e.key === "Enter" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Tab" ||
          e.key === "Escape"
        ) {
          e.preventDefault();
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
          void selectMention(mentionFiles[mentionIndex]);
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
    [
      handleSend,
      pinnedContexts,
      input,
      mentionQuery,
      mentionFiles,
      mentionIndex,
      selectMention,
      slashQuery,
    ],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInput(value);

      // Detect / slash command trigger — only at the very start of input
      const slashMatch = value.match(/^\/(\S*)$/);
      if (slashMatch) {
        // Typing /query with no space yet — open picker
        slashSelectedRef.current = false;
        setSlashQuery(slashMatch[1]);
        setMentionQuery(null);
      } else if (slashSelectedRef.current) {
        // User already selected a command — don't re-open picker
      } else if (!value.startsWith("/")) {
        setSlashQuery(null);
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
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
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
        modelPickerRef.current &&
        !modelPickerRef.current.contains(target) &&
        modelButtonRef.current &&
        !modelButtonRef.current.contains(target)
      ) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [modelPickerOpen]);

  const activeProviderModelOptions = selectedProviderCredential
    ? Array.from(
        new Set(
          (
            providerModelOptions[selectedProviderCredential.id] ?? [
              selectedProviderCredential.model,
            ]
          )
            .map(modelInfoId)
            .filter(Boolean),
        ),
      ).filter((model) =>
        isChatModelOption({
          label: selectedProviderCredential.label,
          baseUrl: selectedProviderCredential.base_url,
          model,
        }),
      )
    : [];
  const activeProviderModelsLoading =
    !!selectedProviderCredential &&
    providerModelLoadingId === selectedProviderCredential.id;
  const activeProviderModelOptionsKey = activeProviderModelOptions.join("\0");

  useLayoutEffect(() => {
    if (
      !modelPickerOpen ||
      claudeProviderActive ||
      activeProviderModelsLoading
    ) {
      return;
    }

    const list = providerModelListRef.current;
    const item = providerModelItemRefs.current[directProviderModel];
    if (!list || !item) return;

    const itemTop = item.offsetTop - list.offsetTop;
    const centeredTop =
      itemTop - Math.max(0, (list.clientHeight - item.offsetHeight) / 2);
    list.scrollTop = Math.max(0, centeredTop);
  }, [
    activeProviderModelOptionsKey,
    activeProviderModelsLoading,
    claudeProviderActive,
    directProviderModel,
    modelPickerOpen,
    selectedProviderCredential?.id,
  ]);

  return (
    <div
      ref={composerRef}
      className="relative mx-auto w-full max-w-[44rem] shrink-0 px-4 pb-4"
      style={
        {
          "--composer-bg":
            "color-mix(in oklab, var(--color-muted) 30%, var(--color-background))",
          "--composer-radius": "1.5rem",
          "--composer-padding": "8px",
        } as CSSProperties
      }
    >
      {/* / slash command picker — portal to body to escape all stacking contexts */}
      {slashQuery !== null && (
        <SlashCommandPicker
          projectPath={projectRoot}
          query={slashQuery}
          anchorRef={composerRef}
          onSelect={selectSlashCommand}
          onClose={() => {
            setSlashQuery(null);
          }}
        />
      )}

      {/* Model picker popup — portal to body to escape all stacking contexts */}
      {modelPickerOpen &&
        createPortal(
          <div
            ref={modelPickerRef}
            className="fixed w-[28rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-popover/95 p-1.5 text-popover-foreground shadow-lg backdrop-blur-sm"
            style={{
              left: pickerPos.left,
              bottom: pickerPos.bottom,
              zIndex: 9999,
            }}
          >
            <div className="grid grid-cols-[minmax(0,11.5rem)_minmax(0,1fr)]">
              <div className="max-h-80 overflow-y-auto border-border border-r pr-1">
                <div className="px-2 py-1 font-medium text-muted-foreground text-xs">
                  Provider
                </div>
                {showClaudeProvider && (
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      claudeProviderActive
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted",
                    )}
                    onClick={() => {
                      setSelectedProviderCredentialId(CLAUDE_CODE_PROVIDER_ID);
                    }}
                  >
                    {claudeCodeIconSrc ? (
                      <img
                        src={claudeCodeIconSrc}
                        alt=""
                        className="size-4 shrink-0 object-contain"
                      />
                    ) : (
                      <SparklesIcon className="size-3.5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-xs">
                        Claude Code
                      </div>
                      <div className="truncate text-muted-foreground text-xs">
                        {selectedModel}
                      </div>
                    </div>
                    {claudeProviderActive && (
                      <CheckIcon className="size-3 shrink-0" />
                    )}
                  </button>
                )}

                {openAiCredentials.map((credential) => {
                  const active =
                    selectedProviderCredential?.id === credential.id;
                  const displayName = getProviderDisplayName({
                    label: credential.label,
                    baseUrl: credential.base_url,
                    model: credential.model,
                  });
                  const iconSrc = getProviderIconSrc({
                    label: credential.label,
                    baseUrl: credential.base_url,
                    model: credential.model,
                  });
                  const currentModel =
                    selectedProviderModels[credential.id] || credential.model;

                  const isDeleting = deletingProviderId === credential.id;
                  const selectCredential = () => {
                    if (isDeleting) return;
                    setSelectedProviderCredentialId(credential.id);
                  };

                  return (
                    <div
                      key={credential.id}
                      role="button"
                      tabIndex={0}
                      className={cn(
                        "group/provider flex w-full cursor-pointer items-center gap-2 rounded-lg py-2 pr-1 pl-3 text-left text-sm transition-colors",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-muted",
                        isDeleting && "pointer-events-none opacity-70",
                      )}
                      onClick={selectCredential}
                      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectCredential();
                        }
                      }}
                    >
                      {iconSrc ? (
                        <img
                          src={iconSrc}
                          alt=""
                          className="size-4 shrink-0 object-contain"
                        />
                      ) : (
                        <SparklesIcon className="size-3.5 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-xs">
                          {displayName}
                        </div>
                        <div className="truncate text-muted-foreground text-xs">
                          {currentModel}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {active && <CheckIcon className="size-3 shrink-0" />}
                        <button
                          type="button"
                          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Delete ${displayName}`}
                          title="Delete provider"
                          disabled={!!deletingProviderId}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setProviderDeleteError(null);
                            setProviderDeleteTarget(credential);
                          }}
                        >
                          {isDeleting ? (
                            <Loader2Icon className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2Icon className="size-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
                <button
                  className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setModelPickerOpen(false);
                    setProviderSetupOpen(true);
                  }}
                >
                  <PlusIcon className="size-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-xs">
                      Add Provider
                    </div>
                    <div className="truncate text-xs">Save another API key</div>
                  </div>
                </button>
              </div>

              <div className="flex max-h-80 min-w-0 flex-col pl-1">
                <div
                  ref={providerModelListRef}
                  className="min-h-0 flex-1 overflow-y-auto"
                >
                  <div className="px-2 py-1 font-medium text-muted-foreground text-xs">
                    Model
                  </div>
                  {claudeProviderActive ? (
                    <>
                      {claudeModelsLoading && (
                        <div className="px-3 py-1.5 text-muted-foreground text-xs">
                          Fetching models...
                        </div>
                      )}
                      {(claudeModelOptions ?? []).map((modelId) => (
                        <button
                          key={modelId}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                            selectedModel === modelId
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-muted",
                          )}
                          onClick={() => setSelectedModel(modelId)}
                        >
                          <span className="min-w-0 flex-1 truncate font-medium text-xs">
                            {modelId}
                          </span>
                          {selectedModel === modelId && (
                            <CheckIcon className="size-3 shrink-0" />
                          )}
                        </button>
                      ))}
                      {claudeModelsError && (
                        <div className="px-3 py-1 text-amber-600 text-xs">
                          {claudeModelsError}
                        </div>
                      )}
                    </>
                  ) : selectedProviderCredential ? (
                    <>
                      {activeProviderModelsLoading && (
                        <div className="px-3 py-1.5 text-muted-foreground text-xs">
                          Fetching models...
                        </div>
                      )}
                      {activeProviderModelOptions.map((modelId) => (
                        <button
                          key={modelId}
                          ref={(node) => {
                            if (node) {
                              providerModelItemRefs.current[modelId] = node;
                            } else {
                              delete providerModelItemRefs.current[modelId];
                            }
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                            directProviderModel === modelId
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-muted",
                          )}
                          onClick={() => {
                            setSelectedProviderModel(
                              selectedProviderCredential.id,
                              modelId,
                            );
                          }}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="min-w-0 truncate font-medium text-xs">
                              {modelId}
                            </span>
                            <ModelCapabilityBadges
                              label={selectedProviderCredential.label}
                              baseUrl={selectedProviderCredential.base_url}
                              model={modelId}
                            />
                          </span>
                          {directProviderModel === modelId && (
                            <CheckIcon className="size-3 shrink-0" />
                          )}
                        </button>
                      ))}
                      {providerModelError && (
                        <div className="px-3 py-1 text-amber-600 text-xs">
                          {providerModelError}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="px-3 py-2 text-muted-foreground text-xs">
                      Select a provider
                    </div>
                  )}
                </div>
                {(claudeProviderActive || selectedProviderCredential) && (
                  <div className="shrink-0">
                    <EffortControls
                      effortLevel={effortLevel}
                      setEffortLevel={setEffortLevel}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      <Dialog open={providerSetupOpen} onOpenChange={setProviderSetupOpen}>
        <DialogContent className="max-h-[85vh] w-[min(42rem,calc(100vw-2rem))] overflow-y-auto overflow-x-hidden sm:max-w-none">
          <DialogHeader>
            <DialogTitle>Add AI Provider</DialogTitle>
            <DialogDescription>
              Configure Anthropic or another model provider for this project.
            </DialogDescription>
          </DialogHeader>
          <ClaudeSetup
            variant="provider-dialog"
            onCancel={() => setProviderSetupOpen(false)}
            onSaved={() => {
              setProviderSetupOpen(false);
              const setupState = useClaudeSetupStore.getState();
              const lastCredential =
                setupState.openAiCredentials[
                  setupState.openAiCredentials.length - 1
                ];
              setSelectedProviderCredentialId(
                setupState.activeOpenAiCredentialId ??
                  lastCredential?.id ??
                  CLAUDE_CODE_PROVIDER_ID,
              );
              setProviderModelOptions({});
              setProviderModelError(null);
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!providerDeleteTarget}
        onOpenChange={(open) => {
          if (!open && !deletingProviderId) {
            setProviderDeleteTarget(null);
            setProviderDeleteError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Provider</DialogTitle>
            <DialogDescription>
              Delete{" "}
              <span className="font-medium text-foreground">
                {providerDeleteTarget
                  ? getProviderDisplayName({
                      label: providerDeleteTarget.label,
                      baseUrl: providerDeleteTarget.base_url,
                      model: providerDeleteTarget.model,
                    })
                  : "this provider"}
              </span>{" "}
              with model{" "}
              <span className="font-mono text-foreground">
                {providerDeleteTarget?.model || "unknown"}
              </span>
              ? The API key will be removed from ClaudePrism.
            </DialogDescription>
          </DialogHeader>
          {providerDeleteError && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {providerDeleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (deletingProviderId) return;
                setProviderDeleteTarget(null);
                setProviderDeleteError(null);
              }}
              disabled={!!deletingProviderId}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (providerDeleteTarget) {
                  void handleDeleteProviderCredential(providerDeleteTarget.id);
                }
              }}
              disabled={!providerDeleteTarget || !!deletingProviderId}
            >
              {deletingProviderId ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* @ mention dropdown */}
      {slashQuery === null &&
        mentionQuery !== null &&
        mentionFiles.length > 0 && (
          <div
            ref={mentionRef}
            className="absolute right-4 bottom-full left-4 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border bg-background shadow-lg"
          >
            {mentionFiles.map((file, i) => {
              const parts = file.relativePath.split("/");
              const fileName = parts.pop()!;
              const dirPath = parts.length > 0 ? `${parts.join("/")}/` : "";
              return (
                <button
                  key={file.id}
                  data-active={i === mentionIndex}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                    i === mentionIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent textarea blur
                    void selectMention(file);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                >
                  {getFileIcon(file)}
                  <span className="truncate font-mono text-sm">{fileName}</span>
                  {dirPath && (
                    <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
                      {dirPath}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

      <div
        className={cn(
          "flex w-full flex-col gap-2 overflow-hidden rounded-(--composer-radius) border border-border/60 bg-(--composer-bg) p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:border-border focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] dark:border-muted-foreground/15 dark:shadow-none dark:focus-within:border-muted-foreground/30",
          isDragOver &&
            "border-ring border-dashed bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]",
        )}
      >
        {visibleQueuedGuidance.length > 0 && (
          <div className="max-h-20 overflow-y-auto rounded-xl border border-border/60 bg-background/60 text-xs">
            {visibleQueuedGuidance.map((guidance) => {
              const displayText = formatGuidanceText(guidance);
              return (
                <div
                  key={guidance.id}
                  className="flex min-h-8 items-center gap-1.5 border-border/50 border-b px-3 py-1 last:border-b-0"
                >
                  <ListEndIcon className="size-3 shrink-0 text-muted-foreground/60" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {displayText}
                  </span>
                  <button
                    type="button"
                    className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 font-normal text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground/90 dark:hover:bg-muted"
                    title={
                      isStreaming ? "Guide this item now" : "Send this guidance"
                    }
                    onClick={() => handleGuideQueuedGuidance(guidance)}
                  >
                    <CornerDownRightIcon className="size-3" />
                    Guide
                  </button>
                  <button
                    type="button"
                    aria-label="Remove queued guidance"
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-400"
                    onClick={() => {
                      void cleanupTemporaryFilePaths(
                        guidance.contextOverride?.temporaryFilePaths,
                      );
                      removeQueuedGuidance(activeTabId, guidance.id);
                    }}
                  >
                    <Trash2Icon className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Pinned context chips */}
        {pinnedContexts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-2.5">
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
                    aria-label="Remove attachment"
                    onClick={() => {
                      void cleanupTemporaryPinnedContext(ctx);
                      setPinnedContexts((prev) =>
                        prev.filter((_, idx) => idx !== i),
                      );
                    }}
                    className="absolute top-0.5 right-0.5 rounded-full bg-background/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ) : (
                <span
                  key={`${ctx.label}-${i}`}
                  className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-muted-foreground text-xs"
                >
                  {ctx.label}
                  <button
                    aria-label="Remove context"
                    onClick={() => {
                      void cleanupTemporaryPinnedContext(ctx);
                      setPinnedContexts((prev) =>
                        prev.filter((_, idx) => idx !== i),
                      );
                    }}
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
          <div className="flex min-h-10 items-center justify-center px-2.5 py-1 text-muted-foreground text-sm">
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
            placeholder={
              isStreaming
                ? "Add guidance for the next turn..."
                : "Ask me anything (/ for commands, @ to mention)"
            }
            className="max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none placeholder:text-muted-foreground/80"
            rows={1}
          />
        )}

        <div className="relative flex items-center justify-between">
          {/* Attachments, model & settings selector */}
          <div className="flex items-center gap-1">
            <TooltipIconButton
              tooltip="Attach files"
              side="top"
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 rounded-full"
              onClick={handleAttachFiles}
              disabled={!projectRoot}
            >
              <PlusIcon className="size-4" />
            </TooltipIconButton>
            <button
              ref={modelButtonRef}
              type="button"
              onClick={() => setModelPickerOpen((v) => !v)}
              title="Switch provider or model"
              className="flex h-7 items-center gap-1.5 rounded-full px-2 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
            >
              {selectedProviderCredential ? (
                <>
                  {selectedProviderIconSrc ? (
                    <img
                      src={selectedProviderIconSrc}
                      alt=""
                      className="size-3.5 shrink-0 object-contain"
                    />
                  ) : (
                    <SparklesIcon className="size-3" />
                  )}
                  <span className="max-w-36 truncate">
                    {selectedProviderDisplayName}
                  </span>
                  <span className="max-w-32 truncate text-muted-foreground/60">
                    {directProviderModel}
                  </span>
                  <span className="text-muted-foreground/60">
                    {effortShortLabel(effortLevel)}
                  </span>
                  <ChevronDownIcon className="size-3" />
                </>
              ) : showClaudeProvider ? (
                <>
                  {claudeCodeIconSrc ? (
                    <img
                      src={claudeCodeIconSrc}
                      alt=""
                      className="size-3.5 shrink-0 object-contain"
                    />
                  ) : (
                    <SparklesIcon className="size-3" />
                  )}
                  <span>Claude Code</span>
                  <span className="max-w-32 truncate">{selectedModel}</span>
                  <span className="text-muted-foreground/60">
                    {effortShortLabel(effortLevel)}
                  </span>
                  <ChevronDownIcon className="size-3" />
                </>
              ) : (
                <>
                  <SparklesIcon className="size-3" />
                  <span>Provider</span>
                  <span className="text-muted-foreground/60">
                    {setupStatus === "checking" ? "Loading" : "Select"}
                  </span>
                  <ChevronDownIcon className="size-3" />
                </>
              )}
            </button>
          </div>

          <div className="flex items-center gap-1">
            <TooltipIconButton
              tooltip={
                isStreaming && !hasInput
                  ? "Stop"
                  : isStreaming
                    ? "Queue guidance"
                    : "Send"
              }
              side="top"
              variant="default"
              size="icon"
              className="size-7 rounded-full"
              onClick={
                isStreaming && !hasInput
                  ? () => void cancelExecution(activeTabId)
                  : handleSend
              }
              disabled={!isStreaming && (!hasInput || !providerSelectionReady)}
            >
              {isStreaming && !hasInput ? (
                <SquareIcon className="size-3.5 fill-current" />
              ) : (
                <ArrowUpIcon className="size-4" />
              )}
            </TooltipIconButton>
          </div>
        </div>
      </div>
    </div>
  );
};
