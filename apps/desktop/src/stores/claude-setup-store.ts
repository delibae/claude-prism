import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  isChatModelOption,
  modelInfoId,
  type OpenAiCompatibleModelInfo,
  rememberModelListCapabilityMetadata,
} from "@/lib/model-capabilities";

const MOONSHOT_OFFICIAL_ORIGIN = "https://api.moonshot.ai";

// ─── Types ───

interface ClaudeStatus {
  installed: boolean;
  authenticated: boolean;
  binary_path: string | null;
  version: string | null;
  provider_kind: "claude-code" | "openai-compatible" | null;
  account_email: string | null;
  provider_model: string | null;
  provider_base_url: string | null;
  claude_provider_configured: boolean;
  missing_git: boolean;
}

export interface OpenAiCompatibleCredentialInfo {
  id: string;
  label: string;
  base_url: string;
  model: string;
}

type SetupStatus =
  | "checking"
  | "missing-git"
  | "not-installed"
  | "not-authenticated"
  | "ready"
  | "error";

type StepStatus = "pending" | "active" | "complete" | "error";

export interface StepInfo {
  id: string;
  label: string;
  status: StepStatus;
}

interface ClaudeSetupState {
  status: SetupStatus;
  isInstalling: boolean;
  installMode: "install" | "update";
  isLoggingIn: boolean;
  isSavingApiKey: boolean;
  isClearingApiKey: boolean;
  error: string | null;
  version: string | null;
  providerKind: "claude-code" | "openai-compatible" | null;
  accountEmail: string | null;
  providerModel: string | null;
  providerBaseUrl: string | null;
  claudeProviderConfigured: boolean;
  openAiCredentials: OpenAiCompatibleCredentialInfo[];
  activeOpenAiCredentialId: string | null;

  // Install progress
  installSteps: StepInfo[];
  installLogs: string[];
  installLogsVisible: boolean;

  // Login progress
  loginSteps: StepInfo[];

  // Actions
  checkStatus: () => Promise<void>;
  install: () => Promise<void>;
  update: () => Promise<void>;
  login: () => Promise<void>;
  saveApiKey: (
    apiKey: string,
    baseUrl?: string,
    provider?: string,
    model?: string,
    credentialLabel?: string,
  ) => Promise<boolean>;
  clearApiKey: () => Promise<boolean>;
  listApiCredentials: () => Promise<void>;
  deleteApiCredential: (credentialId: string) => Promise<boolean>;
  setActiveApiCredential: (credentialId: string) => Promise<boolean>;
  fetchProviderModels: (apiKey: string, baseUrl: string) => Promise<string[]>;
  toggleInstallLogs: () => void;

  // Internal helpers
  _appendInstallLog: (line: string) => void;
  _advanceInstallStep: (stepId: string) => void;
  _failCurrentStep: (error: string) => void;
  _advanceLoginStep: (stepId: string) => void;
  _failCurrentLoginStep: (error: string) => void;
  _finishInstall: (success: boolean) => void;
  _finishLogin: (success: boolean) => void;
}

// ─── Constants ───

const INSTALL_STEPS: StepInfo[] = [
  { id: "downloading", label: "Downloading Claude Code", status: "pending" },
  { id: "installing", label: "Installing CLI", status: "pending" },
  { id: "verifying", label: "Verifying installation", status: "pending" },
  { id: "complete", label: "Ready to use", status: "pending" },
];

const LOGIN_STEPS: StepInfo[] = [
  { id: "opening-browser", label: "Opening browser", status: "pending" },
  { id: "waiting-auth", label: "Waiting for sign-in", status: "pending" },
  { id: "complete", label: "Authenticated", status: "pending" },
];

const STEP_ORDER_INSTALL = [
  "downloading",
  "installing",
  "verifying",
  "complete",
];
const STEP_ORDER_LOGIN = ["opening-browser", "waiting-auth", "complete"];

function canonicalOpenAiCompatibleBaseUrl(url: string) {
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  const deepseekMatch = trimmed.match(
    /^(https?:\/\/api\.deepseek\.com)(?:\/|$)/i,
  );
  const deepseekOrigin = deepseekMatch?.[1];
  if (deepseekOrigin && !lower.includes("/anthropic")) {
    return `${deepseekOrigin}/anthropic`;
  }
  if (deepseekOrigin) {
    const anthropicIndex = lower.indexOf("/anthropic");
    return `${trimmed.slice(0, anthropicIndex)}/anthropic`;
  }

  const qwenMatch = trimmed.match(
    /^(https?:\/\/dashscope(?:-intl)?\.aliyuncs\.com)(?:\/|$)/i,
  );
  const qwenOrigin = qwenMatch?.[1];
  if (
    qwenOrigin &&
    (lower.includes("/apps/anthropic") ||
      lower.includes("/compatible-mode/") ||
      trimmed.replace(/\/+$/, "").toLowerCase() === qwenOrigin.toLowerCase())
  ) {
    const anthropicIndex = lower.indexOf("/apps/anthropic");
    if (anthropicIndex >= 0) {
      return `${trimmed.slice(0, anthropicIndex)}/apps/anthropic`;
    }
    return `${qwenOrigin}/apps/anthropic`;
  }

  const moonshotMatch = trimmed.match(
    /^(https?:\/\/api\.moonshot\.(?:cn|ai))(?:\/|$)/i,
  );
  const moonshotOrigin = moonshotMatch?.[1];
  if (
    moonshotOrigin &&
    (lower.includes("/anthropic") ||
      lower.includes("/v1") ||
      trimmed.replace(/\/+$/, "").toLowerCase() ===
        moonshotOrigin.toLowerCase())
  ) {
    const anthropicIndex = lower.indexOf("/anthropic");
    if (anthropicIndex >= 0) {
      return `${MOONSHOT_OFFICIAL_ORIGIN}/anthropic`;
    }
    return `${MOONSHOT_OFFICIAL_ORIGIN}/anthropic`;
  }

  return trimmed;
}

function advanceSteps(
  steps: StepInfo[],
  targetId: string,
  order: string[],
): StepInfo[] {
  const targetIdx = order.indexOf(targetId);
  return steps.map((s) => {
    const thisIdx = order.indexOf(s.id);
    if (thisIdx < targetIdx && s.status !== "error") {
      return { ...s, status: "complete" as const };
    }
    if (s.id === targetId) {
      return { ...s, status: "active" as const };
    }
    return s;
  });
}

// ─── Store ───

export const useClaudeSetupStore = create<ClaudeSetupState>((set, get) => ({
  status: "checking",
  isInstalling: false,
  installMode: "install",
  isLoggingIn: false,
  isSavingApiKey: false,
  isClearingApiKey: false,
  error: null,
  version: null,
  providerKind: null,
  accountEmail: null,
  providerModel: null,
  providerBaseUrl: null,
  claudeProviderConfigured: false,
  openAiCredentials: [],
  activeOpenAiCredentialId: null,

  installSteps: [],
  installLogs: [],
  installLogsVisible: false,

  loginSteps: [],

  checkStatus: async () => {
    set({ status: "checking", error: null });
    try {
      const result = await invoke<ClaudeStatus>("check_claude_status");
      let openAiCredentials: OpenAiCompatibleCredentialInfo[] = [];
      try {
        openAiCredentials = await invoke<OpenAiCompatibleCredentialInfo[]>(
          "list_openai_compatible_credentials",
        );
      } catch {
        openAiCredentials = [];
      }
      const activeOpenAiCredentialId =
        openAiCredentials.find(
          (credential) =>
            credential.model === result.provider_model &&
            credential.base_url === result.provider_base_url,
        )?.id ??
        openAiCredentials[0]?.id ??
        null;

      // On Windows, Git for Windows is required before anything else
      if (result.missing_git) {
        set({
          status: "missing-git",
          version: null,
          providerKind: result.provider_kind ?? "claude-code",
          accountEmail: null,
          providerModel: null,
          providerBaseUrl: null,
          claudeProviderConfigured: result.claude_provider_configured,
          openAiCredentials,
          activeOpenAiCredentialId,
        });
        return;
      }

      if (!result.installed) {
        set({
          status: "not-installed",
          version: null,
          providerKind: result.provider_kind ?? "claude-code",
          accountEmail: null,
          providerModel: null,
          providerBaseUrl: null,
          claudeProviderConfigured: result.claude_provider_configured,
          openAiCredentials,
          activeOpenAiCredentialId,
        });
        return;
      }

      if (!result.authenticated) {
        set({
          status: "not-authenticated",
          version: result.version,
          providerKind: result.provider_kind ?? "claude-code",
          accountEmail: null,
          providerModel: null,
          providerBaseUrl: null,
          claudeProviderConfigured: result.claude_provider_configured,
          openAiCredentials,
          activeOpenAiCredentialId,
        });
        return;
      }

      set({
        status: "ready",
        version: result.version,
        providerKind: result.provider_kind ?? "claude-code",
        accountEmail: result.account_email,
        providerModel: result.provider_model,
        providerBaseUrl: result.provider_base_url,
        claudeProviderConfigured: result.claude_provider_configured,
        openAiCredentials,
        activeOpenAiCredentialId,
      });
    } catch (err: any) {
      set({
        status: "error",
        error: err?.message || String(err),
      });
    }
  },

  install: async () => {
    const initialSteps = INSTALL_STEPS.map((s, i) => ({
      ...s,
      status: (i === 0 ? "active" : "pending") as StepStatus,
    }));

    set({
      isInstalling: true,
      installMode: "install",
      error: null,
      installSteps: initialSteps,
      installLogs: [],
      installLogsVisible: false,
    });

    try {
      // Fire-and-forget — events drive the rest
      const success = await invoke<boolean>("install_claude_cli");
      if (get().isInstalling) {
        get()._finishInstall(success);
      }
    } catch (err: any) {
      set({
        isInstalling: false,
        status: "error",
        error: err?.message || String(err),
      });
    }
  },

  update: async () => {
    const initialSteps = [
      { id: "downloading", label: "Checking for updates", status: "active" },
      { id: "installing", label: "Updating Claude Code", status: "pending" },
      { id: "verifying", label: "Verifying update", status: "pending" },
      { id: "complete", label: "Up to date", status: "pending" },
    ] satisfies StepInfo[];

    set({
      isInstalling: true,
      installMode: "update",
      error: null,
      installSteps: initialSteps,
      installLogs: [],
      installLogsVisible: false,
    });

    try {
      const success = await invoke<boolean>("update_claude_cli");
      if (get().isInstalling) {
        get()._finishInstall(success);
      }
    } catch (err: any) {
      set({
        isInstalling: false,
        status: "error",
        error: err?.message || String(err),
      });
    }
  },

  login: async () => {
    const initialSteps = LOGIN_STEPS.map((s, i) => ({
      ...s,
      status: (i === 0 ? "active" : "pending") as StepStatus,
    }));

    set({
      isLoggingIn: true,
      error: null,
      loginSteps: initialSteps,
    });

    try {
      await invoke("login_claude");
    } catch (err: any) {
      set({
        isLoggingIn: false,
        status: "error",
        error: err?.message || String(err),
      });
    }
  },

  saveApiKey: async (
    apiKey: string,
    baseUrl?: string,
    provider = "claude-code",
    model?: string,
    credentialLabel?: string,
  ) => {
    const status = get().status;
    if (status === "missing-git" || status === "not-installed") {
      set({
        error: "Install Claude Code before configuring an AI provider.",
      });
      return false;
    }

    const key = apiKey.trim();
    const rawUrl = baseUrl?.trim() ?? "";
    const url =
      provider === "openai-compatible"
        ? canonicalOpenAiCompatibleBaseUrl(rawUrl)
        : rawUrl;
    const modelName = model?.trim() ?? "";
    if (provider !== "openai-compatible" && !key) {
      set({ error: "API key is empty" });
      return false;
    }

    if (key && /\s/.test(key)) {
      set({ error: "API key cannot contain spaces or line breaks" });
      return false;
    }

    if (url && !/^https?:\/\//.test(url)) {
      set({ error: "Base URL must start with http:// or https://" });
      return false;
    }

    if (provider === "openai-compatible" && !url) {
      set({ error: "OpenAI-compatible provider requires a Base URL." });
      return false;
    }

    if (provider === "openai-compatible" && !modelName) {
      set({ error: "OpenAI-compatible provider requires a model." });
      return false;
    }

    if (
      provider !== "openai-compatible" &&
      !url &&
      !key.startsWith("sk-ant-")
    ) {
      set({
        error:
          "This looks like an external provider key. Set the provider Base URL, or use an Anthropic key that starts with sk-ant-.",
      });
      return false;
    }

    set({ isSavingApiKey: true, error: null });
    try {
      if (provider === "openai-compatible") {
        await invoke("verify_openai_compatible_api_key", {
          apiKey: key,
          baseUrl: url,
          model: modelName,
        });
      }

      await invoke("save_anthropic_api_key", {
        apiKey: key,
        baseUrl: url || null,
        provider,
        model: modelName || null,
        credentialLabel: credentialLabel || null,
      });
      set({ isSavingApiKey: false });
      await get().checkStatus();
      return true;
    } catch (err: any) {
      set({
        isSavingApiKey: false,
        error: err?.message || String(err),
      });
      return false;
    }
  },

  clearApiKey: async () => {
    set({ isClearingApiKey: true, error: null });
    try {
      await invoke("clear_anthropic_api_key");
      set({ isClearingApiKey: false });
      await get().checkStatus();
      return true;
    } catch (err: any) {
      set({
        isClearingApiKey: false,
        error: err?.message || String(err),
      });
      return false;
    }
  },

  listApiCredentials: async () => {
    const credentials = await invoke<OpenAiCompatibleCredentialInfo[]>(
      "list_openai_compatible_credentials",
    );
    set((state) => ({
      openAiCredentials: credentials,
      activeOpenAiCredentialId:
        credentials.find(
          (credential) =>
            credential.model === state.providerModel &&
            credential.base_url === state.providerBaseUrl,
        )?.id ??
        credentials[0]?.id ??
        null,
    }));
  },

  deleteApiCredential: async (credentialId: string) => {
    try {
      await invoke("delete_openai_compatible_credential", {
        credentialId,
      });
      await get().checkStatus();
      return true;
    } catch (err: any) {
      set({ error: err?.message || String(err) });
      return false;
    }
  },

  setActiveApiCredential: async (credentialId: string) => {
    try {
      await invoke("set_active_openai_compatible_credential", {
        credentialId,
      });
      await get().checkStatus();
      return true;
    } catch (err: any) {
      set({ error: err?.message || String(err) });
      return false;
    }
  },

  fetchProviderModels: async (apiKey: string, baseUrl: string) => {
    const trimmedBaseUrl = baseUrl.trim();
    const models = await invoke<Array<string | OpenAiCompatibleModelInfo>>(
      "list_openai_compatible_models",
      {
        apiKey: apiKey.trim(),
        baseUrl: trimmedBaseUrl,
      },
    );
    rememberModelListCapabilityMetadata(trimmedBaseUrl, models);
    return models
      .filter((model) =>
        isChatModelOption({
          baseUrl: trimmedBaseUrl,
          model: modelInfoId(model),
          metadata: typeof model === "string" ? undefined : model.metadata,
        }),
      )
      .map(modelInfoId);
  },

  toggleInstallLogs: () => {
    set((state) => ({ installLogsVisible: !state.installLogsVisible }));
  },

  _appendInstallLog: (line: string) => {
    set((state) => ({
      installLogs: [...state.installLogs, line].slice(-200),
    }));
  },

  _advanceInstallStep: (stepId: string) => {
    set((state) => ({
      installSteps: advanceSteps(
        state.installSteps,
        stepId,
        STEP_ORDER_INSTALL,
      ),
    }));
  },

  _failCurrentStep: (error: string) => {
    set((state) => ({
      installSteps: state.installSteps.map((s) =>
        s.status === "active" ? { ...s, status: "error" as const } : s,
      ),
      error,
    }));
  },

  _advanceLoginStep: (stepId: string) => {
    set((state) => ({
      loginSteps: advanceSteps(state.loginSteps, stepId, STEP_ORDER_LOGIN),
    }));
  },

  _failCurrentLoginStep: (error: string) => {
    set((state) => ({
      loginSteps: state.loginSteps.map((s) =>
        s.status === "active" ? { ...s, status: "error" as const } : s,
      ),
      error,
    }));
  },

  _finishInstall: (success: boolean) => {
    if (success) {
      const store = get();
      store._advanceInstallStep("verifying");

      setTimeout(() => {
        const s = get();
        // Mark verifying complete, then complete step active
        s._advanceInstallStep("complete");

        setTimeout(() => {
          // Mark all complete
          set((state) => ({
            isInstalling: false,
            installSteps: state.installSteps.map((step) => ({
              ...step,
              status: "complete" as const,
            })),
          }));
          get().checkStatus();
        }, 500);
      }, 800);
    } else {
      const store = get();
      store._failCurrentStep("Installation failed. Check logs for details.");
      set({ isInstalling: false, status: "error", installLogsVisible: true });
    }
  },

  _finishLogin: (success: boolean) => {
    if (success) {
      const store = get();
      store._advanceLoginStep("complete");

      setTimeout(() => {
        set((state) => ({
          isLoggingIn: false,
          loginSteps: state.loginSteps.map((step) => ({
            ...step,
            status: "complete" as const,
          })),
        }));
        get().checkStatus();
      }, 500);
    } else {
      const store = get();
      store._failCurrentLoginStep(
        "Authentication failed. If the browser didn't open, please run 'claude auth login' in your terminal instead.",
      );
      set({ isLoggingIn: false, status: "error" });
    }
  },
}));
