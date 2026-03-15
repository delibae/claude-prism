import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// ─── Types ───

interface ClaudeStatus {
  installed: boolean;
  authenticated: boolean;
  binary_path: string | null;
  version: string | null;
  account_email: string | null;
  missing_git: boolean;
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
  isLoggingIn: boolean;
  error: string | null;
  version: string | null;
  accountEmail: string | null;

  // Install progress
  installSteps: StepInfo[];
  installLogs: string[];
  installLogsVisible: boolean;

  // Login progress
  loginSteps: StepInfo[];

  // Actions
  checkStatus: () => Promise<void>;
  install: () => Promise<void>;
  login: () => Promise<void>;
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

const STEP_ORDER_INSTALL = ["downloading", "installing", "verifying", "complete"];
const STEP_ORDER_LOGIN = ["opening-browser", "waiting-auth", "complete"];

function advanceSteps(steps: StepInfo[], targetId: string, order: string[]): StepInfo[] {
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
  isLoggingIn: false,
  error: null,
  version: null,
  accountEmail: null,

  installSteps: [],
  installLogs: [],
  installLogsVisible: false,

  loginSteps: [],

  checkStatus: async () => {
    set({ status: "checking", error: null });
    try {
      const result = await invoke<ClaudeStatus>("check_claude_status");

      // On Windows, Git for Windows is required before anything else
      if (result.missing_git) {
        set({ status: "missing-git", version: null, accountEmail: null });
        return;
      }

      if (!result.installed) {
        set({ status: "not-installed", version: null, accountEmail: null });
        return;
      }

      if (!result.authenticated) {
        set({
          status: "not-authenticated",
          version: result.version,
          accountEmail: null,
        });
        return;
      }

      set({
        status: "ready",
        version: result.version,
        accountEmail: result.account_email,
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
      error: null,
      installSteps: initialSteps,
      installLogs: [],
      installLogsVisible: false,
    });

    try {
      // Fire-and-forget — events drive the rest
      await invoke("install_claude_cli");
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
      installSteps: advanceSteps(state.installSteps, stepId, STEP_ORDER_INSTALL),
    }));
  },

  _failCurrentStep: (error: string) => {
    set((state) => ({
      installSteps: state.installSteps.map((s) =>
        s.status === "active" ? { ...s, status: "error" as const } : s
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
        s.status === "active" ? { ...s, status: "error" as const } : s
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
      store._failCurrentLoginStep("Authentication failed.");
      set({ isLoggingIn: false, status: "error" });
    }
  },
}));
