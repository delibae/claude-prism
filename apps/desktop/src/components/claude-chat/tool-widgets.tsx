import { type FC, useState } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  CircleIcon,
  ClockIcon,
  FileEditIcon,
  FileIcon,
  FileOutputIcon,
  ListTodoIcon,
  LoaderIcon,
  MessageCircleQuestionIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useClaudeChatStore, type ContentBlock } from "@/stores/claude-chat-store";

interface ToolWidgetProps {
  toolUse: ContentBlock;
  toolResult?: ContentBlock;
}

export const ToolWidget: FC<ToolWidgetProps> = ({ toolUse, toolResult }) => {
  const name = toolUse.name?.toLowerCase() || "";

  if (name === "write") return <WriteWidget input={toolUse.input} result={toolResult} />;
  if (name === "edit" || name === "multiedit") return <EditWidget input={toolUse.input} result={toolResult} />;
  if (name === "read") return <ReadWidget input={toolUse.input} result={toolResult} />;
  if (name === "bash") return <BashWidget input={toolUse.input} result={toolResult} />;
  if (name === "glob") return <GlobWidget input={toolUse.input} result={toolResult} />;
  if (name === "grep") return <GrepWidget input={toolUse.input} result={toolResult} />;
  if (name === "askuserquestion") return <AskUserQuestionWidget input={toolUse.input} result={toolResult} />;
  if (name === "todowrite") return <TodoWriteWidget input={toolUse.input} result={toolResult} />;

  return <GenericWidget name={toolUse.name || "unknown"} input={toolUse.input} result={toolResult} />;
};

// ─── Status Icon ───

const StatusIcon: FC<{ result?: ContentBlock }> = ({ result }) => {
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  if (!result) {
    if (!isStreaming) {
      // Tool was cancelled (stop pressed) — show stopped state
      return <CircleIcon className="size-3.5 text-muted-foreground" />;
    }
    return <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />;
  }
  if (result.is_error) {
    return <span className="text-sm text-destructive">!</span>;
  }
  return <CheckIcon className="size-3.5 text-green-600" />;
};

// ─── Write Widget ───

const WriteWidget: FC<{ input: any; result?: ContentBlock }> = ({ input, result }) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileOutputIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {result ? "Wrote" : "Writing"}{" "}
        <code className="rounded bg-muted px-1 text-xs">{input?.file_path}</code>
      </span>
    </div>
  );
};

// ─── Edit Widget ───

const EditWidget: FC<{ input: any; result?: ContentBlock }> = ({ input, result }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/50 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <FileEditIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-muted-foreground">
          {result ? "Edited" : "Editing"}{" "}
          <code className="rounded bg-muted px-1 text-xs">{input?.file_path}</code>
        </span>
        {(input?.old_string || input?.edits) && (
          expanded
            ? <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground" />
            : <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />
        )}
      </button>
      {expanded && input?.old_string && (
        <div className="border-t border-border px-3 py-2 font-mono text-xs">
          <div className="mb-1 text-red-500">- {truncate(input.old_string, 200)}</div>
          <div className="text-green-500">+ {truncate(input.new_string, 200)}</div>
        </div>
      )}
    </div>
  );
};

// ─── Read Widget ───

const ReadWidget: FC<{ input: any; result?: ContentBlock }> = ({ input, result }) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {result ? "Read" : "Reading"}{" "}
        <code className="rounded bg-muted px-1 text-xs">{input?.file_path}</code>
      </span>
    </div>
  );
};

// ─── Bash Widget ───

const BashWidget: FC<{ input: any; result?: ContentBlock }> = ({ input, result }) => {
  const [expanded, setExpanded] = useState(false);
  const command = input?.command || input?.description || "";
  const resultContent = typeof result?.content === "string" ? result.content : "";

  return (
    <div className="my-1.5 rounded-lg border border-border bg-[#1e1e2e] text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <TerminalIcon className="size-3.5 shrink-0 text-green-400" />
        <code className="min-w-0 truncate text-xs text-green-300">$ {truncate(command, 80)}</code>
        {result && (
          expanded
            ? <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground" />
            : <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />
        )}
      </button>
      {expanded && resultContent && (
        <div className="max-h-40 overflow-auto border-t border-border/50 px-3 py-2">
          <pre className="whitespace-pre-wrap font-mono text-xs text-gray-300">
            {truncate(resultContent, 2000)}
          </pre>
        </div>
      )}
    </div>
  );
};

// ─── Glob Widget ───

const GlobWidget: FC<{ input: any; result?: ContentBlock }> = ({ input, result }) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {result ? "Searched" : "Searching"}{" "}
        <code className="rounded bg-muted px-1 text-xs">{input?.pattern}</code>
      </span>
    </div>
  );
};

// ─── Grep Widget ───

const GrepWidget: FC<{ input: any; result?: ContentBlock }> = ({ input, result }) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {result ? "Grepped" : "Grepping"}{" "}
        <code className="rounded bg-muted px-1 text-xs">{input?.pattern}</code>
      </span>
    </div>
  );
};

// ─── AskUserQuestion Widget ───

const AskUserQuestionWidget: FC<{ input: any; result?: ContentBlock }> = ({ input, result }) => {
  const questions: any[] = input?.questions || [];
  const [answered, setAnswered] = useState(false);

  // In -p mode, AskUserQuestion always errors because CLI can't prompt interactively.
  // The process is killed when AskUserQuestion is detected, so result may be undefined.
  // Options are clickable when there's no result or an error result.
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const needsUserAnswer = !answered && !isStreaming && (!result || result.is_error);

  const handleOptionClick = (question: string, label: string) => {
    const { sendPrompt, isStreaming } = useClaudeChatStore.getState();
    if (isStreaming) return;
    setAnswered(true);
    sendPrompt(`${label}`);
  };

  if (questions.length === 0) {
    return (
      <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
        <StatusIcon result={result} />
        <MessageCircleQuestionIcon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {result ? "Asked question" : "Asking question..."}
        </span>
      </div>
    );
  }

  // Determine header state
  const headerLabel = isStreaming
    ? "Waiting for answer..."
    : needsUserAnswer
      ? "Choose an option"
      : answered
        ? "Answer sent"
        : "Question answered";

  return (
    <div className={`my-1.5 rounded-lg border text-sm ${
      needsUserAnswer
        ? "border-blue-500/40 bg-blue-500/10"
        : "border-blue-500/20 bg-blue-500/5"
    }`}>
      <div className="flex items-center gap-2 px-3 py-2">
        {needsUserAnswer ? (
          <MessageCircleQuestionIcon className="size-3.5 text-blue-500" />
        ) : (
          <>
            <StatusIcon result={result} />
            <MessageCircleQuestionIcon className="size-3.5 text-blue-500" />
          </>
        )}
        <span className="font-medium text-blue-600 dark:text-blue-400">
          {headerLabel}
        </span>
      </div>
      <div className="space-y-3 border-t border-blue-500/20 px-3 py-2.5">
        {questions.map((q: any, qIdx: number) => (
          <div key={qIdx} className="space-y-1.5">
            {q.header && (
              <span className="inline-block rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
                {q.header}
              </span>
            )}
            <p className="text-sm font-medium text-foreground">{q.question}</p>
            <div className="space-y-1 pl-1">
              {q.options?.map((opt: any, oIdx: number) => (
                <button
                  type="button"
                  key={oIdx}
                  disabled={!needsUserAnswer}
                  onClick={() => needsUserAnswer && handleOptionClick(q.question, opt.label)}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                    needsUserAnswer
                      ? "cursor-pointer hover:bg-blue-500/15"
                      : "cursor-default"
                  }`}
                >
                  <div className="mt-0.5">
                    <CircleIcon className={`size-3.5 ${
                      needsUserAnswer ? "text-blue-500/50" : "text-muted-foreground/40"
                    }`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className={`text-sm ${
                      needsUserAnswer ? "text-foreground" : "text-muted-foreground"
                    }`}>
                      {opt.label}
                    </span>
                    {opt.description && (
                      <p className="text-xs text-muted-foreground/70 mt-0.5">
                        {opt.description}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── TodoWrite Widget ───

const TodoWriteWidget: FC<{ input: any; result?: ContentBlock }> = ({ input, result }) => {
  const [expanded, setExpanded] = useState(true);
  const todos: any[] = input?.todos || [];

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckIcon className="size-3.5 text-green-500" />;
      case "in_progress":
        return <ClockIcon className="size-3.5 animate-pulse text-blue-500" />;
      default:
        return <CircleIcon className="size-3.5 text-muted-foreground/40" />;
    }
  };

  const completedCount = todos.filter((t) => t.status === "completed").length;

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/50 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <ListTodoIcon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          Todos ({completedCount}/{todos.length})
        </span>
        {expanded
          ? <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground" />
          : <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />}
      </button>
      {expanded && todos.length > 0 && (
        <div className="space-y-0.5 border-t border-border px-3 py-2">
          {todos.map((todo, idx) => (
            <div
              key={idx}
              className={`flex items-center gap-2 rounded px-1.5 py-1 ${
                todo.status === "completed" ? "opacity-50" : ""
              }`}
            >
              {statusIcon(todo.status)}
              <span
                className={`text-xs ${
                  todo.status === "completed"
                    ? "line-through text-muted-foreground"
                    : todo.status === "in_progress"
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                }`}
              >
                {todo.status === "in_progress"
                  ? (todo.activeForm || todo.content)
                  : todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Generic Widget ───

const GenericWidget: FC<{ name: string; input: any; result?: ContentBlock }> = ({
  name,
  input,
  result,
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/50 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {result ? "Ran" : "Running"} <code className="text-xs">{name}</code>
        </span>
        {expanded
          ? <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground" />
          : <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />}
      </button>
      {expanded && input && (
        <div className="max-h-32 overflow-auto border-t border-border px-3 py-2">
          <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

// ─── Thinking Widget ───

export const ThinkingWidget: FC<{ thinking: string; signature?: string }> = ({ thinking }) => {
  const [expanded, setExpanded] = useState(false);
  const trimmed = thinking.trim();

  return (
    <div className="my-1.5 rounded-lg border border-muted-foreground/20 bg-muted-foreground/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2 hover:bg-muted-foreground/10 transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="relative">
            <BotIcon className="size-4 text-muted-foreground" />
            <SparklesIcon className="size-2.5 text-muted-foreground/70 absolute -top-1 -right-1 animate-pulse" />
          </div>
          <span className="text-sm font-medium text-muted-foreground italic">Thinking...</span>
        </div>
        <ChevronRightIcon className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && (
        <div className="border-t border-muted-foreground/20 px-3 pb-3 pt-2">
          <pre className="whitespace-pre-wrap rounded-lg bg-muted-foreground/5 p-3 font-mono text-xs text-muted-foreground italic">
            {trimmed}
          </pre>
        </div>
      )}
    </div>
  );
};

// ─── Helpers ───

function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "..." : str;
}
