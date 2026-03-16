import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BugIcon, CopyIcon, TrashIcon, CheckIcon } from "lucide-react";
import {
  useLogStore,
  getGpuRenderer,
  getVisibilityLogs,
  APP_VISIBILITY_RESTORED,
  type LogLevel,
  type SystemInfo,
} from "@/lib/debug/log-store";
import { generateBugReport } from "@/lib/debug/bug-report";

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "text-neutral-400",
  info: "text-blue-500",
  warn: "text-yellow-500",
  error: "text-red-500",
};

type Tab = "logs" | "system" | "visibility";

export function DebugPage() {
  const [tab, setTab] = useState<Tab>("logs");
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const [sourceFilter, setSourceFilter] = useState("");
  const [search, setSearch] = useState("");
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [visibilityCount, setVisibilityCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const version = useLogStore((s) => s.version);
  const store = useLogStore.getState();
  const entries = store.getEntries();

  // Track visibility restore events
  useEffect(() => {
    const handler = () => setVisibilityCount((c) => c + 1);
    window.addEventListener(APP_VISIBILITY_RESTORED, handler);
    return () => window.removeEventListener(APP_VISIBILITY_RESTORED, handler);
  }, []);

  // Fetch system info once
  useEffect(() => {
    invoke<SystemInfo>("get_system_info")
      .then(setSystemInfo)
      .catch(() => {});
  }, []);

  // Auto-scroll logs only if already scrolled to bottom.
  // Use rAF to wait for the DOM to update after React re-render.
  const wasAtBottomRef = useRef(true);
  useEffect(() => {
    if (tab !== "logs") return;
    const container = logContainerRef.current;
    if (!container) return;
    // Check before new content is painted
    const gap =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    wasAtBottomRef.current = gap < 40;
  }); // runs every render, before paint

  useEffect(() => {
    if (tab !== "logs" || !wasAtBottomRef.current) return;
    requestAnimationFrame(() => {
      logEndRef.current?.scrollIntoView({ behavior: "instant" });
    });
  }, [version, tab]);

  const filteredEntries = store.getFilteredLogs(
    levelFilter === "all" && !sourceFilter && !search
      ? undefined
      : {
          level: levelFilter === "all" ? undefined : levelFilter,
          source: sourceFilter || undefined,
          search: search || undefined,
        },
  );

  const sources = [...new Set(entries.map((e) => e.source))].sort();

  const handleCopyReport = useCallback(async () => {
    const report = await generateBugReport();
    await navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return (
      d.toLocaleTimeString("en-US", { hour12: false }) +
      "." +
      String(d.getMilliseconds()).padStart(3, "0")
    );
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <BugIcon className="size-4" />
          <h1 className="font-semibold text-sm">Debug</h1>
        </div>
        <button
          type="button"
          onClick={handleCopyReport}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground text-xs hover:bg-primary/90"
        >
          {copied ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
          {copied ? "Copied!" : "Copy Bug Report"}
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b px-4">
        {(["logs", "system", "visibility"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-1.5 font-medium text-xs capitalize transition-colors ${
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden px-4 py-2">
        {tab === "logs" && (
          <div className="flex h-full flex-col gap-2">
            <div className="flex gap-2">
              <select
                value={levelFilter}
                onChange={(e) =>
                  setLevelFilter(e.target.value as LogLevel | "all")
                }
                className="rounded border bg-background px-2 py-1 text-xs"
              >
                <option value="all">All levels</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="rounded border bg-background px-2 py-1 text-xs"
              >
                <option value="">All sources</option>
                {sources.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 rounded border bg-background px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={store.clear}
                title="Clear logs"
                className="rounded border p-1 text-muted-foreground hover:text-foreground"
              >
                <TrashIcon className="size-3.5" />
              </button>
            </div>

            <div
              ref={logContainerRef}
              className="flex-1 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px]"
            >
              {filteredEntries.length === 0 && (
                <p className="py-4 text-center text-muted-foreground">
                  No log entries
                </p>
              )}
              {filteredEntries.map((entry, i) => (
                <div key={i} className="flex gap-2 py-0.5 hover:bg-muted/50">
                  <span className="shrink-0 text-muted-foreground">
                    {formatTime(entry.timestamp)}
                  </span>
                  <span
                    className={`w-10 shrink-0 font-semibold uppercase ${LEVEL_COLORS[entry.level]}`}
                  >
                    {entry.level}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    [{entry.source}]
                  </span>
                  <span className="break-all text-foreground">
                    {entry.message}
                  </span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            <p className="text-[10px] text-muted-foreground">
              {entries.length} entries ({filteredEntries.length} shown)
            </p>
          </div>
        )}

        {tab === "system" && (
          <div className="space-y-3">
            <h3 className="font-semibold text-muted-foreground text-xs uppercase">
              System Information
            </h3>
            {systemInfo ? (
              <div className="space-y-1 text-sm">
                <Row label="OS" value={systemInfo.os} />
                <Row label="OS Version" value={systemInfo.os_version} />
                <Row label="Architecture" value={systemInfo.arch} />
                <Row label="App Version" value={systemInfo.app_version} />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Loading...</p>
            )}

            <h3 className="pt-4 font-semibold text-muted-foreground text-xs uppercase">
              Browser / WebView
            </h3>
            <div className="space-y-1 text-sm">
              <Row label="User Agent" value={navigator.userAgent} />
              <Row
                label="Device Pixel Ratio"
                value={String(window.devicePixelRatio)}
              />
              <Row label="GPU Renderer" value={getGpuRenderer()} />
            </div>
          </div>
        )}

        {tab === "visibility" && (
          <div className="space-y-3">
            <h3 className="font-semibold text-muted-foreground text-xs uppercase">
              Visibility State
            </h3>
            <div className="space-y-1 text-sm">
              <Row
                label="Current State"
                value={document.visibilityState}
                valueClass={
                  document.visibilityState === "visible"
                    ? "text-green-500"
                    : "text-yellow-500"
                }
              />
              <Row
                label="Window Focused"
                value={document.hasFocus() ? "Yes" : "No"}
              />
              <Row label="Restore Events" value={String(visibilityCount)} />
            </div>

            <h3 className="pt-4 font-semibold text-muted-foreground text-xs uppercase">
              Recent Visibility Logs
            </h3>
            <div className="max-h-48 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px]">
              {getVisibilityLogs().map((entry, i) => (
                <div key={i} className="py-0.5">
                  <span className="text-muted-foreground">
                    {formatTime(entry.timestamp)}
                  </span>{" "}
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex gap-2">
      <span className="w-32 shrink-0 text-muted-foreground">{label}:</span>
      <span className={`break-all ${valueClass ?? ""}`}>{value}</span>
    </div>
  );
}
