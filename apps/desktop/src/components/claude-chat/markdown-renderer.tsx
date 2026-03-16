import { type FC, useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  PlusIcon,
  PlayIcon,
  LoaderIcon,
  CheckIcon,
  XIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import "katex/dist/katex.min.css";

import { useDocumentStore } from "@/stores/document-store";

// ─── Shell Detection ───

const SHELL_LANGUAGES = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "terminal",
  "console",
]);

function looksLikeShellCommand(code: string): boolean {
  const firstLine = code
    .trim()
    .split("\n")[0]
    .replace(/^[$#]\s*/, "")
    .trim();
  const prefixes = [
    "wget",
    "curl",
    "tlmgr",
    "apt",
    "brew",
    "npm",
    "pip",
    "sudo",
    "mkdir",
    "cd ",
    "cp ",
    "mv ",
    "rm ",
    "git ",
    "make",
    "tar ",
    "unzip",
    "latexmk",
    "pdflatex",
    "xelatex",
    "bibtex",
  ];
  return prefixes.some((p) => firstLine.startsWith(p));
}

function isShellCodeBlock(language: string, code: string): boolean {
  if (SHELL_LANGUAGES.has(language.toLowerCase())) return true;
  if (!language && looksLikeShellCommand(code)) return true;
  return false;
}

// ─── Markdown Renderer ───

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export const MarkdownRenderer: FC<MarkdownRendererProps> = ({
  content,
  className,
}) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      className={className ?? "prose prose-sm dark:prose-invert max-w-none"}
      components={{
        pre({ children }) {
          return <>{children}</>;
        },
        code({ className: codeClassName, children, node, ...props }) {
          const match = /language-(\w+)/.exec(codeClassName || "");
          const language = match?.[1];
          const code = String(children).replace(/\n$/, "");
          const isBlock =
            node?.position &&
            node.position.start.line !== node.position.end.line;

          if (!match && !isBlock) {
            return (
              <code className={codeClassName} {...props}>
                {children}
              </code>
            );
          }

          return <CodeBlock language={language || ""} code={code} />;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
};

// ─── Code Block ───

type RunState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "running" }
  | { status: "done"; exitCode: number; stdout: string; stderr: string }
  | { status: "error"; message: string };

const CodeBlock: FC<{ language: string; code: string }> = ({
  language,
  code,
}) => {
  const insertAtCursor = useDocumentStore((s) => s.insertAtCursor);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const isLatex = language === "latex" || language === "tex";
  const isShell = isShellCodeBlock(language, code);

  const [runState, setRunState] = useState<RunState>({ status: "idle" });

  const handleInsert = useCallback(() => {
    insertAtCursor(code);
  }, [insertAtCursor, code]);

  // Strip leading $ or # prompts for execution
  const cleanedCommand = code
    .split("\n")
    .map((line) => line.replace(/^\$\s*/, ""))
    .join("\n")
    .trim();

  const handleRun = useCallback(() => {
    setRunState({ status: "confirming" });
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!projectRoot) {
      setRunState({ status: "error", message: "No project open" });
      return;
    }
    setRunState({ status: "running" });
    try {
      const result = await invoke<{
        exit_code: number;
        stdout: string;
        stderr: string;
      }>("run_shell_command", { command: cleanedCommand, cwd: projectRoot });
      setRunState({
        status: "done",
        exitCode: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      // Refresh file tree to pick up any new/deleted files
      useDocumentStore
        .getState()
        .refreshFiles()
        .catch((err) => {
          console.error("Failed to refresh files:", err);
        });
    } catch (err: any) {
      setRunState({ status: "error", message: err?.message || String(err) });
    }
  }, [cleanedCommand, projectRoot]);

  const handleCancel = useCallback(() => {
    setRunState({ status: "idle" });
  }, []);

  return (
    <div className="not-prose group relative my-2">
      <pre className="overflow-x-auto rounded bg-muted p-3 text-sm">
        <code>{code}</code>
      </pre>

      {/* Hover-reveal buttons */}
      <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {isLatex && (
          <button
            type="button"
            onClick={handleInsert}
            className="flex items-center gap-0.5 rounded bg-primary px-1.5 py-0.5 text-primary-foreground text-xs"
          >
            <PlusIcon className="size-3" />
            Insert
          </button>
        )}
        {isShell && runState.status === "idle" && (
          <button
            type="button"
            onClick={handleRun}
            className="flex items-center gap-0.5 rounded bg-green-600 px-1.5 py-0.5 text-white text-xs"
          >
            <PlayIcon className="size-3" />
            Run
          </button>
        )}
      </div>

      {/* Inline confirmation */}
      {runState.status === "confirming" && (
        <div className="mt-1 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
            <AlertTriangleIcon className="size-3.5 text-yellow-500" />
            <span className="text-xs">
              Run in{" "}
              <code className="rounded bg-muted px-1 text-xs">
                {projectRoot?.split("/").pop()}/
              </code>
            </span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleConfirm}
              className="flex items-center gap-1 rounded bg-green-600 px-2.5 py-1 text-white text-xs"
            >
              <PlayIcon className="size-3" />
              Run
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded bg-muted px-2.5 py-1 text-muted-foreground text-xs hover:bg-muted/80"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Running spinner */}
      {runState.status === "running" && (
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-border bg-[#1e1e2e] px-3 py-2 text-sm">
          <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
          <span className="font-mono text-muted-foreground text-xs">
            Running...
          </span>
        </div>
      )}

      {/* Command output */}
      {runState.status === "done" && (
        <CommandOutput
          exitCode={runState.exitCode}
          stdout={runState.stdout}
          stderr={runState.stderr}
        />
      )}

      {/* Error */}
      {runState.status === "error" && (
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
          <XIcon className="size-3.5" />
          {runState.message}
        </div>
      )}
    </div>
  );
};

// ─── Command Output ───

const CommandOutput: FC<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> = ({ exitCode, stdout, stderr }) => {
  const [expanded, setExpanded] = useState(true);
  const success = exitCode === 0;
  const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
  const truncated =
    output.length > 2000 ? `${output.slice(0, 2000)}\n...` : output;

  return (
    <div className="mt-1 rounded-lg border border-border bg-[#1e1e2e] text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        {success ? (
          <CheckIcon className="size-3.5 text-green-500" />
        ) : (
          <XIcon className="size-3.5 text-red-400" />
        )}
        <span
          className={`font-mono text-xs ${success ? "text-green-300" : "text-red-300"}`}
        >
          {success ? "Command completed" : `Exited with code ${exitCode}`}
        </span>
        <span className="ml-auto">
          {expanded ? (
            <ChevronDownIcon className="size-3.5 text-gray-500" />
          ) : (
            <ChevronRightIcon className="size-3.5 text-gray-500" />
          )}
        </span>
      </button>
      {expanded && truncated && (
        <div className="max-h-40 overflow-auto border-border/50 border-t px-3 py-2">
          <pre className="whitespace-pre-wrap font-mono text-gray-300 text-xs">
            {truncated}
          </pre>
        </div>
      )}
    </div>
  );
};
