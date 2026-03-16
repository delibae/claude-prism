import { useEffect, useRef } from "react";
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
} from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { Button } from "@/components/ui/button";
import {
  useClaudeSetupStore,
  type StepInfo,
} from "@/stores/claude-setup-store";
import { cn } from "@/lib/utils";

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

      const unlistenComplete = await listen<boolean>(
        "install-complete",
        (event) => {
          if (cancelled) return;
          clearTimeout(timer);
          useClaudeSetupStore.getState()._finishInstall(event.payload);
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

export function ClaudeSetup() {
  const status = useClaudeSetupStore((s) => s.status);
  const isInstalling = useClaudeSetupStore((s) => s.isInstalling);
  const isLoggingIn = useClaudeSetupStore((s) => s.isLoggingIn);
  const error = useClaudeSetupStore((s) => s.error);
  const version = useClaudeSetupStore((s) => s.version);
  const accountEmail = useClaudeSetupStore((s) => s.accountEmail);
  const install = useClaudeSetupStore((s) => s.install);
  const login = useClaudeSetupStore((s) => s.login);
  const checkStatus = useClaudeSetupStore((s) => s.checkStatus);
  const installSteps = useClaudeSetupStore((s) => s.installSteps);
  const loginSteps = useClaudeSetupStore((s) => s.loginSteps);

  useInstallEvents();
  useLoginEvents();

  if (status === "checking") {
    return (
      <div className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground text-sm">
          Checking Claude Code...
        </span>
      </div>
    );
  }

  if (status === "ready") {
    return (
      <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <CheckCircle2Icon className="size-5 shrink-0 text-green-600" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">Claude Code Ready</p>
          <p className="truncate text-muted-foreground text-xs">
            {[version, accountEmail].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
    );
  }

  // Installation in progress
  if (isInstalling) {
    return (
      <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-5 shrink-0 text-muted-foreground" />
          <p className="font-medium text-sm">Installing Claude Code</p>
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
      <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
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
      <div className="flex w-full flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4">
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

        <Button
          variant="outline"
          size="sm"
          className="w-fit gap-2"
          onClick={hasInstallSteps ? install : checkStatus}
        >
          <RefreshCwIcon className="size-3.5" />
          {hasInstallSteps ? "Retry Installation" : "Retry"}
        </Button>
      </div>
    );
  }

  if (status === "missing-git") {
    return (
      <div className="flex w-full flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-4">
        <div className="flex items-center gap-2">
          <GitBranchIcon className="size-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium text-sm">Git for Windows Required</p>
            <p className="text-muted-foreground text-xs">
              Claude Code needs Git for Windows (git-bash) to work. Please
              install it first, then click "I've installed Git".
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
      <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Claude Code Required</p>
            <p className="text-muted-foreground text-xs">
              ClaudePrism needs Claude Code CLI to power AI features.
            </p>
          </div>
        </div>
        <Button size="sm" className="w-full gap-2" onClick={install}>
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
      <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <div className="flex items-center gap-2">
          <LogInIcon className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Sign in to Claude</p>
            <p className="text-muted-foreground text-xs">
              Authenticate with your Anthropic account to continue.
            </p>
          </div>
        </div>
        {version && (
          <p className="text-muted-foreground text-xs">
            Claude Code {version} installed
          </p>
        )}
        <Button size="sm" className="w-full gap-2" onClick={login}>
          <LogInIcon className="size-3.5" />
          Sign in with Browser
        </Button>
      </div>
    );
  }

  return null;
}
