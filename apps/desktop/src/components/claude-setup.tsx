import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  DownloadIcon,
  LogInIcon,
  LoaderIcon,
  CheckCircle2Icon,
  CheckIcon,
  AlertCircleIcon,
  RefreshCwIcon,
  TerminalIcon,
  CircleIcon,
  ChevronRightIcon,
  GitBranchIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Trash2Icon,
} from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useClaudeSetupStore,
  type StepInfo,
} from "@/stores/claude-setup-store";
import {
  getProviderDisplayName,
  getProviderIconSrc,
} from "@/lib/provider-icons";
import { ModelCapabilityBadges } from "@/components/model-capability-badges";
import { cn } from "@/lib/utils";

type OpenAICompatiblePreset = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  note: string;
  apiKeyOptional?: boolean;
};

type ClaudeCompatiblePreset = {
  id: string;
  label: string;
  baseUrl: string;
  note: string;
};

type ModelProviderCard = {
  id: string;
  label: string;
  provider: "claude-code" | "openai-compatible";
  baseUrl: string;
  model: string;
  badge: string;
  note: string;
  apiKeyOptional?: boolean;
};

const CLAUDE_COMPATIBLE_PRESETS: ClaudeCompatiblePreset[] = [
  {
    id: "modelgate-web",
    label: "ModelGate Claude (Web)",
    baseUrl: "https://mg.aid.pub/claude-proxy",
    note: "Use a ModelGate web API key with the Claude proxy endpoint.",
  },
];

const OPENAI_COMPATIBLE_PRESETS: OpenAICompatiblePreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    model: "",
    note: "OpenAI chat completions endpoint.",
  },
  {
    id: "qwen",
    label: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    model: "",
    note: "Qwen Anthropic-compatible endpoint for Claude Code.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "",
    note: "DeepSeek Anthropic-compatible endpoint for Claude Code.",
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    baseUrl: "https://api.moonshot.ai/anthropic",
    model: "",
    note: "Kimi Anthropic-compatible endpoint for Claude Code.",
  },
  {
    id: "glm",
    label: "GLM (BigModel)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "",
    note: "Zhipu BigModel chat completions endpoint.",
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "",
    note: "Local Ollama OpenAI-compatible endpoint.",
    apiKeyOptional: true,
  },
  {
    id: "gemini",
    label: "Gemini OpenAI",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "",
    note: "Google Gemini OpenAI-compatible endpoint.",
  },
];

const OPENAI_PROVIDER_CARDS: ModelProviderCard[] = [
  ...OPENAI_COMPATIBLE_PRESETS.map((preset) => ({
    ...preset,
    provider: "openai-compatible" as const,
    badge: preset.label
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase(),
  })),
];

const CLAUDE_PROVIDER_CARDS: ModelProviderCard[] = [
  {
    id: "anthropic-direct",
    label: "Anthropic",
    provider: "claude-code",
    baseUrl: "",
    model: "",
    badge: "A",
    note: "Use a direct Anthropic API key.",
  },
  ...CLAUDE_COMPATIBLE_PRESETS.map((preset) => ({
    ...preset,
    provider: "claude-code" as const,
    model: "",
    badge: "MG",
  })),
];

const OPENAI_DEFAULT_PRESET_ID = OPENAI_PROVIDER_CARDS[0]?.id ?? "openai";
const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const QWEN_ANTHROPIC_BASE_URL = "https://dashscope.aliyuncs.com/apps/anthropic";
const MOONSHOT_ANTHROPIC_BASE_URL = "https://api.moonshot.ai/anthropic";
const MOONSHOT_OFFICIAL_ORIGIN = "https://api.moonshot.ai";

function deepseekOrigin(url: string) {
  const trimmed = url.trim();
  const match = trimmed.match(/^(https?:\/\/api\.deepseek\.com)(?:\/|$)/i);
  return match?.[1] ?? null;
}

function qwenOrigin(url: string) {
  const trimmed = url.trim();
  const match = trimmed.match(
    /^(https?:\/\/dashscope(?:-intl)?\.aliyuncs\.com)(?:\/|$)/i,
  );
  return match?.[1] ?? null;
}

function moonshotOrigin(url: string) {
  const trimmed = url.trim();
  const match = trimmed.match(
    /^(https?:\/\/api\.moonshot\.(?:cn|ai))(?:\/|$)/i,
  );
  return match?.[1] ?? null;
}

function canonicalOpenAiCompatibleBaseUrl(
  url: string,
  presetId?: string | null,
) {
  const trimmed = url.trim();
  const origin = deepseekOrigin(trimmed);
  if (
    origin &&
    (presetId === "deepseek" || !trimmed.toLowerCase().includes("/anthropic"))
  ) {
    const lower = trimmed.toLowerCase();
    const anthropicIndex = lower.indexOf("/anthropic");
    if (anthropicIndex >= 0) {
      return `${trimmed.slice(0, anthropicIndex)}/anthropic`;
    }
    return `${origin}/anthropic`;
  }

  const qwenBaseOrigin = qwenOrigin(trimmed);
  if (
    qwenBaseOrigin &&
    (presetId === "qwen" ||
      trimmed.toLowerCase().includes("/apps/anthropic") ||
      trimmed.toLowerCase().includes("/compatible-mode/") ||
      normalizeOriginOnlyUrl(trimmed) ===
        normalizeOriginOnlyUrl(qwenBaseOrigin))
  ) {
    const lower = trimmed.toLowerCase();
    const anthropicIndex = lower.indexOf("/apps/anthropic");
    if (anthropicIndex >= 0) {
      return `${trimmed.slice(0, anthropicIndex)}/apps/anthropic`;
    }
    return `${qwenBaseOrigin}/apps/anthropic`;
  }

  const moonshotBaseOrigin = moonshotOrigin(trimmed);
  if (
    moonshotBaseOrigin &&
    (presetId === "moonshot" ||
      trimmed.toLowerCase().includes("/anthropic") ||
      trimmed.toLowerCase().includes("/v1") ||
      normalizeOriginOnlyUrl(trimmed) ===
        normalizeOriginOnlyUrl(moonshotBaseOrigin))
  ) {
    const lower = trimmed.toLowerCase();
    const anthropicIndex = lower.indexOf("/anthropic");
    if (anthropicIndex >= 0) {
      return `${MOONSHOT_OFFICIAL_ORIGIN}/anthropic`;
    }
    return `${MOONSHOT_OFFICIAL_ORIGIN}/anthropic`;
  }

  return trimmed;
}

function normalizeOriginOnlyUrl(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function isNativeAnthropicPreset(cardId?: string | null) {
  return cardId === "deepseek" || cardId === "qwen" || cardId === "moonshot";
}

function normalizePresetBaseUrl(url: string) {
  return canonicalOpenAiCompatibleBaseUrl(url)
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function findOpenAiPresetIdForBaseUrl(baseUrl?: string | null) {
  const normalized = normalizePresetBaseUrl(baseUrl ?? "");
  if (!normalized) return null;

  return (
    OPENAI_COMPATIBLE_PRESETS.find(
      (preset) => normalizePresetBaseUrl(preset.baseUrl) === normalized,
    )?.id ?? null
  );
}

function openAiPresetIdForBaseUrl(baseUrl?: string | null) {
  return findOpenAiPresetIdForBaseUrl(baseUrl) ?? OPENAI_DEFAULT_PRESET_ID;
}

function findClaudePresetIdForBaseUrl(baseUrl?: string | null) {
  const normalized = normalizePresetBaseUrl(baseUrl ?? "");
  if (!normalized) return null;

  return (
    CLAUDE_COMPATIBLE_PRESETS.find(
      (preset) => normalizePresetBaseUrl(preset.baseUrl) === normalized,
    )?.id ?? null
  );
}

// ─── Event Hooks ───

function useInstallEvents() {
  const isInstalling = useClaudeSetupStore((s) => s.isInstalling);

  useEffect(() => {
    if (!isInstalling) return;

    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    // Synthetic timer: advance to "installing" after 3s if still on downloading
    const timer = setTimeout(() => {
      if (cancelled) return;
      const store = useClaudeSetupStore.getState();
      const downloadStep = store.installSteps.find(
        (s) => s.id === "downloading",
      );
      if (downloadStep?.status === "active") {
        store._advanceInstallStep("installing");
      }
    }, 3000);

    (async () => {
      const unlistenOutput = await listen<string>("install-output", (event) => {
        if (cancelled) return;
        const store = useClaudeSetupStore.getState();
        const line = event.payload;
        store._appendInstallLog(line);

        // Parse output for step advancement
        const lower = line.toLowerCase();
        if (lower.includes("setting up") || lower.includes("installing")) {
          store._advanceInstallStep("installing");
        }
        if (
          lower.includes("complete") ||
          lower.includes("successfully") ||
          line.includes("✅")
        ) {
          store._advanceInstallStep("verifying");
        }
      });

      const unlistenError = await listen<string>("install-error", (event) => {
        if (cancelled) return;
        useClaudeSetupStore.getState()._appendInstallLog(event.payload);
      });

      if (cancelled) {
        unlistenOutput();
        unlistenError();
        return;
      }

      unlisteners.push(unlistenOutput, unlistenError);
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const u of unlisteners) u();
    };
  }, [isInstalling]);
}

function useLoginEvents() {
  const isLoggingIn = useClaudeSetupStore((s) => s.isLoggingIn);

  useEffect(() => {
    if (!isLoggingIn) return;

    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    // Advance to "waiting-auth" after 1.5s
    const timer = setTimeout(() => {
      if (cancelled) return;
      useClaudeSetupStore.getState()._advanceLoginStep("waiting-auth");
    }, 1500);

    (async () => {
      const unlistenOutput = await listen<string>("login-output", (_event) => {
        if (cancelled) return;
        // Any output means browser is open, advance to waiting
        useClaudeSetupStore.getState()._advanceLoginStep("waiting-auth");
      });

      const unlistenError = await listen<string>("login-error", () => {
        // ignore stderr for login
      });

      const unlistenComplete = await listen<boolean>(
        "login-complete",
        (event) => {
          if (cancelled) return;
          clearTimeout(timer);
          useClaudeSetupStore.getState()._finishLogin(event.payload);
        },
      );

      if (cancelled) {
        unlistenOutput();
        unlistenError();
        unlistenComplete();
        return;
      }

      unlisteners.push(unlistenOutput, unlistenError, unlistenComplete);
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const u of unlisteners) u();
    };
  }, [isLoggingIn]);
}

// ─── Sub-components ───

function StepRow({ step }: { step: StepInfo }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      {step.status === "complete" && (
        <CheckIcon className="size-3.5 text-green-600" />
      )}
      {step.status === "active" && (
        <LoaderIcon className="size-3.5 animate-spin text-foreground" />
      )}
      {step.status === "pending" && (
        <CircleIcon className="size-3.5 text-muted-foreground/30" />
      )}
      {step.status === "error" && (
        <AlertCircleIcon className="size-3.5 text-destructive" />
      )}
      <span
        className={cn(
          "text-sm",
          step.status === "complete" && "text-green-600",
          step.status === "active" && "font-medium text-foreground",
          step.status === "pending" && "text-muted-foreground/60",
          step.status === "error" && "text-destructive",
        )}
      >
        {step.label}
      </span>
    </div>
  );
}

function InstallLogOutput() {
  const logs = useClaudeSetupStore((s) => s.installLogs);
  const visible = useClaudeSetupStore((s) => s.installLogsVisible);
  const toggle = useClaudeSetupStore((s) => s.toggleInstallLogs);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current && visible) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, visible]);

  return (
    <div className="mt-1">
      <button
        onClick={toggle}
        className="flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 transition-transform duration-200",
            visible && "rotate-90",
          )}
        />
        {visible ? "Hide logs" : "Show logs"}
        {logs.length > 0 && (
          <span className="text-muted-foreground/50">({logs.length})</span>
        )}
      </button>
      <div
        className={cn(
          "overflow-hidden transition-[max-height] duration-300 ease-in-out",
          visible ? "max-h-40" : "max-h-0",
        )}
      >
        <div
          ref={scrollRef}
          className="mt-2 max-h-36 overflow-y-auto rounded-md border border-border bg-foreground/3 p-3 font-mono text-[11px] text-muted-foreground leading-relaxed"
        >
          {logs.length === 0 ? (
            <span className="italic">Waiting for output...</span>
          ) : (
            logs.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───

interface ClaudeSetupProps {
  variant?: "default" | "provider-dialog" | "embedded";
  onSaved?: () => void;
  onCancel?: () => void;
}

export function ClaudeSetup({
  variant = "default",
  onSaved,
  onCancel,
}: ClaudeSetupProps = {}) {
  const [provider, setProvider] = useState<"claude-code" | "openai-compatible">(
    "claude-code",
  );
  const [providerPreset, setProviderPreset] = useState("anthropic-direct");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  const [isEditingProvider, setIsEditingProvider] = useState(false);
  const status = useClaudeSetupStore((s) => s.status);
  const isInstalling = useClaudeSetupStore((s) => s.isInstalling);
  const installMode = useClaudeSetupStore((s) => s.installMode);
  const isLoggingIn = useClaudeSetupStore((s) => s.isLoggingIn);
  const isSavingApiKey = useClaudeSetupStore((s) => s.isSavingApiKey);
  const isClearingApiKey = useClaudeSetupStore((s) => s.isClearingApiKey);
  const error = useClaudeSetupStore((s) => s.error);
  const version = useClaudeSetupStore((s) => s.version);
  const providerKind = useClaudeSetupStore((s) => s.providerKind);
  const accountEmail = useClaudeSetupStore((s) => s.accountEmail);
  const providerModel = useClaudeSetupStore((s) => s.providerModel);
  const providerBaseUrl = useClaudeSetupStore((s) => s.providerBaseUrl);
  const claudeProviderConfigured = useClaudeSetupStore(
    (s) => s.claudeProviderConfigured,
  );
  const openAiCredentials = useClaudeSetupStore((s) => s.openAiCredentials);
  const install = useClaudeSetupStore((s) => s.install);
  const update = useClaudeSetupStore((s) => s.update);
  const login = useClaudeSetupStore((s) => s.login);
  const saveApiKey = useClaudeSetupStore((s) => s.saveApiKey);
  const clearApiKey = useClaudeSetupStore((s) => s.clearApiKey);
  const fetchProviderModels = useClaudeSetupStore((s) => s.fetchProviderModels);
  const checkStatus = useClaudeSetupStore((s) => s.checkStatus);
  const installSteps = useClaudeSetupStore((s) => s.installSteps);
  const loginSteps = useClaudeSetupStore((s) => s.loginSteps);

  useInstallEvents();
  useLoginEvents();

  const isEmbedded = variant === "embedded";
  const setupSurfaceClass = (
    tone: "default" | "error" | "warning" = "default",
  ) =>
    cn(
      "flex w-full flex-col gap-3",
      isEmbedded
        ? "px-4 py-3"
        : tone === "error"
          ? "rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4"
          : tone === "warning"
            ? "rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-4"
            : "rounded-xl border border-border bg-muted/30 px-5 py-4",
    );

  const handleSaveApiKey = async (
    selectedProvider: "claude-code" | "openai-compatible" = provider,
    credentialLabel?: string,
  ) => {
    const savedBaseUrl =
      selectedProvider === "openai-compatible"
        ? canonicalOpenAiCompatibleBaseUrl(baseUrl, providerPreset)
        : baseUrl.trim();
    const savedPreset =
      selectedProvider === "openai-compatible"
        ? openAiPresetIdForBaseUrl(savedBaseUrl)
        : "anthropic-direct";
    const success = await saveApiKey(
      apiKey,
      savedBaseUrl,
      selectedProvider,
      model,
      credentialLabel,
    );
    if (success) {
      setApiKey("");
      setBaseUrl("");
      setModel("");
      setModelOptions([]);
      setModelFetchError(null);
      setProviderPreset(savedPreset);
      setIsEditingProvider(false);
      onSaved?.();
    }
  };

  const resetProviderForm = () => {
    setIsEditingProvider(false);
    setApiKey("");
    setBaseUrl("");
    setModel("");
    setModelOptions([]);
    setModelFetchError(null);
    setProviderPreset("anthropic-direct");
  };

  const beginProviderEdit = (isDirectProvider: boolean) => {
    const nextBaseUrl = isDirectProvider
      ? canonicalOpenAiCompatibleBaseUrl(providerBaseUrl || "")
      : "";
    setProvider(isDirectProvider ? "openai-compatible" : "claude-code");
    setProviderPreset(
      isDirectProvider
        ? openAiPresetIdForBaseUrl(nextBaseUrl)
        : "anthropic-direct",
    );
    setApiKey("");
    setBaseUrl(nextBaseUrl);
    setModel(isDirectProvider ? providerModel || "" : "");
    setModelOptions([]);
    setModelFetchError(null);
    setIsEditingProvider(true);
  };

  const handleClearApiKey = async () => {
    const success = await clearApiKey();
    if (success) {
      setApiKey("");
      setBaseUrl("");
      setModel("");
      setModelOptions([]);
      setModelFetchError(null);
      setProviderPreset("anthropic-direct");
      setIsEditingProvider(false);
    }
  };

  const selectProviderCard = (card: ModelProviderCard) => {
    setProvider(card.provider);
    setProviderPreset(card.id);
    setBaseUrl(card.baseUrl);
    setModel(card.model);
    setModelOptions(card.model ? [card.model] : []);
    setModelFetchError(null);
  };

  const handleFetchModels = async () => {
    setIsFetchingModels(true);
    setModelFetchError(null);
    try {
      const models = await fetchProviderModels(apiKey, baseUrl);
      setModelOptions(models);
      if (!models.includes(model)) {
        setModel(models[0] ?? "");
      }
    } catch (err: any) {
      setModelOptions([]);
      setModelFetchError(err?.message || String(err));
    } finally {
      setIsFetchingModels(false);
    }
  };

  const renderApiKeyForm = ({
    forceOpenAiCompatible = false,
    allowBrowserSignIn = false,
  }: {
    forceOpenAiCompatible?: boolean;
    allowBrowserSignIn?: boolean;
  } = {}) => {
    const selectedProvider = forceOpenAiCompatible
      ? "openai-compatible"
      : provider;
    const providerCards = forceOpenAiCompatible
      ? OPENAI_PROVIDER_CARDS
      : [...CLAUDE_PROVIDER_CARDS, ...OPENAI_PROVIDER_CARDS];
    const providerCardIds = new Set(providerCards.map((card) => card.id));
    const fallbackCardId =
      selectedProvider === "openai-compatible"
        ? OPENAI_DEFAULT_PRESET_ID
        : "anthropic-direct";
    const activeCardId = providerCardIds.has(providerPreset)
      ? providerPreset
      : fallbackCardId;
    const activeCard = providerCards.find((card) => card.id === activeCardId);
    const apiKeyOptional =
      selectedProvider === "openai-compatible" && !!activeCard?.apiKeyOptional;
    const apiKeyRequired = !apiKeyOptional;
    const showBrowserSignIn =
      allowBrowserSignIn &&
      selectedProvider === "claude-code" &&
      activeCardId === "anthropic-direct";

    return (
      <>
        <form
          className="min-w-0 max-w-full space-y-2 overflow-hidden"
          onSubmit={(event) => {
            event.preventDefault();
            handleSaveApiKey(selectedProvider, activeCard?.label);
          }}
        >
          <div className="min-w-0 space-y-2">
            <Label className="text-xs">
              {selectedProvider === "openai-compatible"
                ? "Model Provider"
                : "Provider"}
            </Label>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              {providerCards.map((card) => {
                const iconSrc = getProviderIconSrc(card);
                const active = activeCardId === card.id;

                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => selectProviderCard(card)}
                    disabled={isSavingApiKey}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-md border font-semibold text-[10px]",
                        active
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border bg-muted text-muted-foreground",
                      )}
                    >
                      {iconSrc ? (
                        <img
                          src={iconSrc}
                          alt=""
                          className="size-4 object-contain"
                        />
                      ) : (
                        card.badge
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-xs">
                        {card.label}
                      </span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {card.note}
                      </span>
                    </span>
                    {active && <CheckIcon className="size-3 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="anthropic-api-key" className="text-xs">
              {selectedProvider === "openai-compatible"
                ? "Provider API Key"
                : "Anthropic / Proxy Key"}
            </Label>
            <Input
              id="anthropic-api-key"
              type="password"
              placeholder={
                selectedProvider === "openai-compatible"
                  ? apiKeyOptional
                    ? "Optional for local Ollama"
                    : "sk-..."
                  : "sk-ant-... or provider key"
              }
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setModelOptions([]);
                setModelFetchError(null);
              }}
              disabled={isSavingApiKey}
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              {selectedProvider === "openai-compatible"
                ? apiKeyOptional
                  ? "Ollama runs locally and normally does not require an API key."
                  : "Use the API key from your model provider."
                : "Anthropic keys start with sk-ant-. Claude-compatible proxies can use their own key format."}
            </p>
          </div>

          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="anthropic-base-url" className="text-xs">
              {isNativeAnthropicPreset(activeCardId)
                ? "Base URL (Anthropic)"
                : "Base URL"}
            </Label>
            <Input
              id="anthropic-base-url"
              type="url"
              placeholder={
                selectedProvider === "openai-compatible"
                  ? activeCardId === "deepseek"
                    ? DEEPSEEK_ANTHROPIC_BASE_URL
                    : activeCardId === "qwen"
                      ? QWEN_ANTHROPIC_BASE_URL
                      : activeCardId === "moonshot"
                        ? MOONSHOT_ANTHROPIC_BASE_URL
                        : "https://dashscope.aliyuncs.com/compatible-mode/v1"
                  : "https://mg.aid.pub/claude-proxy"
              }
              value={baseUrl}
              onChange={(event) => {
                const nextUrl = event.target.value;
                const matchingPreset = findOpenAiPresetIdForBaseUrl(nextUrl);
                const matchingClaudePreset =
                  findClaudePresetIdForBaseUrl(nextUrl);
                setBaseUrl(nextUrl);
                setModelOptions([]);
                setModelFetchError(null);
                if (selectedProvider === "openai-compatible") {
                  if (matchingPreset) {
                    setProviderPreset(matchingPreset);
                    if (isNativeAnthropicPreset(matchingPreset)) {
                      const canonicalUrl = canonicalOpenAiCompatibleBaseUrl(
                        nextUrl,
                        matchingPreset,
                      );
                      if (canonicalUrl !== nextUrl.trim()) {
                        setBaseUrl(canonicalUrl);
                      }
                    }
                  }
                } else {
                  if (matchingClaudePreset) {
                    setProviderPreset(matchingClaudePreset);
                  } else if (!nextUrl.trim()) {
                    setProviderPreset("anthropic-direct");
                  }
                }
              }}
              disabled={isSavingApiKey}
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              {selectedProvider === "openai-compatible"
                ? activeCardId === "deepseek"
                  ? "DeepSeek runs through its native Anthropic-compatible Claude Code route."
                  : activeCardId === "qwen"
                    ? "Qwen runs through its native Anthropic-compatible Claude Code route."
                    : activeCardId === "moonshot"
                      ? "Kimi runs through its native Anthropic-compatible Claude Code route."
                      : "Use either the API root or a full /chat/completions URL."
                : "Leave blank for Anthropic direct API."}
            </p>
          </div>

          {selectedProvider === "openai-compatible" && (
            <div className="min-w-0 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="provider-model" className="text-xs">
                  Model
                </Label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={handleFetchModels}
                  disabled={
                    isSavingApiKey ||
                    isFetchingModels ||
                    (apiKeyRequired && !apiKey.trim()) ||
                    !baseUrl.trim()
                  }
                >
                  {isFetchingModels ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                  Fetch Models
                </Button>
              </div>
              {modelOptions.length > 0 ? (
                <Select
                  value={model}
                  onValueChange={(value) => {
                    setModel(value);
                  }}
                  disabled={isSavingApiKey}
                >
                  <SelectTrigger id="provider-model" className="h-9 w-full">
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((item) => (
                      <SelectItem key={item} value={item}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate">{item}</span>
                          <ModelCapabilityBadges
                            label={activeCard?.label}
                            baseUrl={baseUrl}
                            model={item}
                          />
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="provider-model"
                  type="text"
                  placeholder="Fetch models, or enter qwen3-coder-plus, deepseek-v4-pro, glm-5.1, ..."
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                  }}
                  disabled={isSavingApiKey}
                  autoComplete="off"
                />
              )}
              {modelFetchError && (
                <p className="max-w-full whitespace-pre-wrap break-all text-[11px] text-amber-600">
                  {modelFetchError}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                {activeCardId === "deepseek"
                  ? "Fetches DeepSeek models from the matching provider model endpoint."
                  : activeCardId === "qwen"
                    ? "Fetches Qwen models from the matching DashScope model endpoint."
                    : activeCardId === "moonshot"
                      ? "Fetches Kimi models from the matching Moonshot model endpoint."
                      : "Fetches the provider's real /models list when available."}
              </p>
            </div>
          )}

          {error && (
            <p className="max-w-full whitespace-pre-wrap break-all text-destructive text-xs">
              {error}
            </p>
          )}
          <Button
            type="submit"
            size="sm"
            className="w-full gap-2"
            disabled={
              (apiKeyRequired && !apiKey.trim()) ||
              isSavingApiKey ||
              (selectedProvider === "openai-compatible" &&
                (!baseUrl.trim() || !model.trim()))
            }
          >
            {isSavingApiKey ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <KeyRoundIcon className="size-3.5" />
            )}
            {isSavingApiKey
              ? selectedProvider === "openai-compatible"
                ? "Verifying..."
                : "Saving..."
              : selectedProvider === "openai-compatible"
                ? apiKeyOptional
                  ? "Verify & Use Local Provider"
                  : "Verify & Use API Key"
                : "Use API Key"}
          </Button>
        </form>

        {showBrowserSignIn && (
          <>
            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[11px] text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <Button
              size="sm"
              variant="outline"
              className="w-full gap-2"
              onClick={login}
              disabled={isSavingApiKey}
            >
              <LogInIcon className="size-3.5" />
              Sign in with Browser
            </Button>
          </>
        )}
      </>
    );
  };

  if (status === "checking") {
    return (
      <div
        className={cn(
          "flex w-full items-center justify-center gap-2",
          isEmbedded
            ? "px-4 py-3"
            : "rounded-xl border border-border bg-muted/30 px-5 py-4",
        )}
      >
        <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground text-sm">
          Checking Claude Code...
        </span>
      </div>
    );
  }

  if (variant === "provider-dialog" && status === "missing-git") {
    return (
      <div className={setupSurfaceClass("warning")}>
        <div className="flex items-center gap-2">
          <GitBranchIcon className="size-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium text-sm">Install Git first</p>
            <p className="text-muted-foreground text-xs">
              Claude Code needs Git for Windows before providers can be added.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full gap-2"
          onClick={() => {
            shellOpen("https://git-scm.com/downloads/win");
          }}
        >
          <ExternalLinkIcon className="size-3.5" />
          Download Git for Windows
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="w-full gap-2 text-muted-foreground"
          onClick={checkStatus}
        >
          <RefreshCwIcon className="size-3.5" />
          I've installed Git
        </Button>
      </div>
    );
  }

  if (variant === "provider-dialog" && status === "not-installed") {
    return (
      <div className={setupSurfaceClass()}>
        <div className="flex items-center gap-2">
          <DownloadIcon className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Install Claude Code first</p>
            <p className="text-muted-foreground text-xs">
              AI providers can be configured after the Claude Code CLI is
              installed.
            </p>
          </div>
        </div>
        <Button size="sm" className="w-full gap-2" onClick={install}>
          <DownloadIcon className="size-3.5" />
          Install Claude Code
        </Button>
      </div>
    );
  }

  if (variant === "provider-dialog") {
    return (
      <div className="min-w-0 max-w-full space-y-3 overflow-hidden">
        {renderApiKeyForm({ allowBrowserSignIn: true })}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => {
            resetProviderForm();
            onCancel?.();
          }}
          disabled={isSavingApiKey}
        >
          Cancel
        </Button>
      </div>
    );
  }

  if (status === "ready") {
    const isDirectProvider = providerKind === "openai-compatible";
    const openAiProviderCount = Math.max(
      openAiCredentials.length,
      isDirectProvider && (providerModel || providerBaseUrl) ? 1 : 0,
    );
    const includesClaudeProvider =
      claudeProviderConfigured || !isDirectProvider;
    const configuredProviderCount =
      openAiProviderCount + (includesClaudeProvider ? 1 : 0);
    const readyDetail = [
      `${configuredProviderCount} provider${configuredProviderCount === 1 ? "" : "s"} configured`,
      version ? `Claude Code ${version}` : null,
      !isDirectProvider && accountEmail ? accountEmail : null,
    ]
      .filter(Boolean)
      .join(" / ");
    const claudeProviderIconSrc = getProviderIconSrc({ label: "Anthropic" });

    if (isEditingProvider) {
      return (
        <div className={setupSurfaceClass()}>
          <div className="flex items-center gap-3">
            <CheckCircle2Icon className="size-5 shrink-0 text-green-600" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm">
                {isDirectProvider ? "Update AI Provider" : "Update Claude Code"}
              </p>
              <p className="truncate text-muted-foreground text-xs">
                {readyDetail}
              </p>
            </div>
          </div>

          {renderApiKeyForm({ allowBrowserSignIn: !isDirectProvider })}

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                resetProviderForm();
              }}
              disabled={isSavingApiKey || isClearingApiKey}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-2 text-destructive hover:text-destructive"
              onClick={handleClearApiKey}
              disabled={isSavingApiKey || isClearingApiKey}
            >
              {isClearingApiKey ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              Forget Provider
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div
        className={cn(
          "w-full",
          isEmbedded ? "" : "rounded-xl border border-border bg-muted/30",
        )}
      >
        <div className="flex min-w-0 items-center gap-3 px-4 py-3.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-green-500/20 bg-green-500/10 text-green-600">
            <CheckCircle2Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-semibold text-sm">
                AI Providers
              </span>
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {configuredProviderCount}
              </span>
            </div>
            <p className="mt-0.5 truncate text-muted-foreground text-xs">
              {readyDetail}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 gap-1.5 rounded-md px-2.5 text-xs"
            onClick={update}
            disabled={isInstalling}
          >
            <RefreshCwIcon className="size-3" />
            Update CC
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 gap-1.5 rounded-md px-2.5 text-xs"
            onClick={() => beginProviderEdit(isDirectProvider)}
          >
            <RefreshCwIcon className="size-3" />
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 gap-1.5 rounded-md px-2.5 text-destructive text-xs hover:text-destructive"
            onClick={handleClearApiKey}
            disabled={isClearingApiKey}
          >
            {isClearingApiKey ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <Trash2Icon className="size-3" />
            )}
            Clear
          </Button>
        </div>

        {(includesClaudeProvider || openAiCredentials.length > 0) && (
          <div className="space-y-1.5 border-border/60 border-t px-4 py-3">
            {includesClaudeProvider && (
              <div className="flex min-h-9 min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/50">
                {claudeProviderIconSrc ? (
                  <img
                    src={claudeProviderIconSrc}
                    alt=""
                    className="size-4 shrink-0 object-contain"
                  />
                ) : (
                  <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-medium">
                      Anthropic / Claude Code
                    </span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {accountEmail || "Claude Code"}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {openAiCredentials.map((credential) => {
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

              return (
                <div
                  key={credential.id}
                  className="flex min-h-9 min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/50"
                >
                  {iconSrc ? (
                    <img
                      src={iconSrc}
                      alt=""
                      className="size-4 shrink-0 object-contain"
                    />
                  ) : (
                    <CircleIcon className="size-3 shrink-0 text-muted-foreground/50" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-medium">
                        {displayName}
                      </span>
                      <span className="min-w-0 truncate text-muted-foreground">
                        {credential.model}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0">
                    <ModelCapabilityBadges
                      label={credential.label}
                      baseUrl={credential.base_url}
                      model={credential.model}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Installation in progress
  if (isInstalling) {
    return (
      <div className={setupSurfaceClass()}>
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-5 shrink-0 text-muted-foreground" />
          <p className="font-medium text-sm">
            {installMode === "update"
              ? "Updating Claude Code"
              : "Installing Claude Code"}
          </p>
        </div>

        <div className="space-y-0 pl-1">
          {installSteps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </div>

        <InstallLogOutput />
      </div>
    );
  }

  // Login in progress
  if (isLoggingIn) {
    return (
      <div className={setupSurfaceClass()}>
        <div className="flex items-center gap-2">
          <LogInIcon className="size-5 shrink-0 text-muted-foreground" />
          <p className="font-medium text-sm">Signing in to Claude</p>
        </div>

        <div className="space-y-0 pl-1">
          {loginSteps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </div>

        <p className="text-center text-[11px] text-muted-foreground">
          Complete the sign-in in your browser to continue.
        </p>
      </div>
    );
  }

  if (status === "error") {
    const hasInstallSteps = installSteps.length > 0;

    return (
      <div className={setupSurfaceClass("error")}>
        <div className="flex items-center gap-2">
          <AlertCircleIcon className="size-5 shrink-0 text-destructive" />
          <p className="font-medium text-sm">
            {hasInstallSteps ? "Installation Failed" : "Setup Error"}
          </p>
        </div>

        {hasInstallSteps && (
          <div className="space-y-0 pl-1">
            {installSteps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </div>
        )}

        {error && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {error}
          </p>
        )}

        {hasInstallSteps && <InstallLogOutput />}

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={hasInstallSteps ? install : checkStatus}
          >
            <RefreshCwIcon className="size-3.5" />
            {hasInstallSteps ? "Retry Installation" : "Retry"}
          </Button>
          {!hasInstallSteps && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground"
              onClick={() => {
                shellOpen("https://code.claude.com/docs/en/quickstart");
              }}
            >
              <ExternalLinkIcon className="size-3.5" />
              Setup Guide
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (status === "missing-git") {
    return (
      <div className={setupSurfaceClass("warning")}>
        <div className="flex items-center gap-2">
          <GitBranchIcon className="size-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium text-sm">Install Git first</p>
            <p className="text-muted-foreground text-xs">
              Git for Windows is required before Claude Code can be installed
              and providers can be configured.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full gap-2"
          onClick={() => {
            shellOpen("https://git-scm.com/downloads/win");
          }}
        >
          <ExternalLinkIcon className="size-3.5" />
          Download Git for Windows
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="w-full gap-2 text-muted-foreground"
          onClick={checkStatus}
        >
          <RefreshCwIcon className="size-3.5" />
          I've installed Git
        </Button>
      </div>
    );
  }

  if (status === "not-installed") {
    return (
      <div className={setupSurfaceClass()}>
        <div className="flex items-center gap-2">
          <DownloadIcon className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Install Claude Code first</p>
            <p className="text-muted-foreground text-xs">
              Provider keys can be added after the Claude Code CLI is installed.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="default"
          className="w-full gap-2"
          onClick={install}
        >
          <DownloadIcon className="size-3.5" />
          Install Claude Code
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">
          Installs to ~/.local/bin/claude
        </p>
      </div>
    );
  }

  if (status === "not-authenticated") {
    return (
      <div className={setupSurfaceClass()}>
        <div className="flex items-center gap-2">
          <KeyRoundIcon className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Connect Claude</p>
            <p className="text-muted-foreground text-xs">
              Use an Anthropic key, an external API proxy, or browser sign-in.
            </p>
          </div>
        </div>
        {version && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              Claude Code {version} installed
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={update}
              disabled={isInstalling}
            >
              <RefreshCwIcon className="size-3" />
              Update
            </Button>
          </div>
        )}

        {renderApiKeyForm({ allowBrowserSignIn: true })}
      </div>
    );
  }

  return null;
}
