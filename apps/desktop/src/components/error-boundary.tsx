import { Component, type ErrorInfo, type ReactNode, useState } from "react";
import { AlertCircleIcon, RefreshCwIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, CheckIcon } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback UI. If not provided, a default recovery UI is shown. */
  fallback?: ReactNode;
  /** Called when an error is caught. */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

function ErrorDetails({ error, errorInfo }: { error: Error; errorInfo: ErrorInfo | null }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const stackTrace = error.stack || "No stack trace available";
  const componentStack = errorInfo?.componentStack || "";

  const fullDetails = [
    `Error: ${error.message}`,
    "",
    "Stack trace:",
    stackTrace,
    ...(componentStack ? ["", "Component stack:", componentStack] : []),
  ].join("\n");

  const handleCopy = () => {
    navigator.clipboard.writeText(fullDetails).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="w-full max-w-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
        Details
      </button>
      {expanded && (
        <div className="mt-2 rounded-lg border border-border bg-muted/50">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Error details</span>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] text-muted-foreground">
            {fullDetails}
          </pre>
        </div>
      )}
    </div>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, errorInfo);
    this.setState({ errorInfo });
    this.props.onError?.(error, errorInfo);
  }

  handleReset = () => {
    this.setState({ error: null, errorInfo: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-background p-8">
          <AlertCircleIcon className="size-12 text-destructive" />
          <h2 className="font-semibold text-lg text-foreground">
            Something went wrong
          </h2>
          <p className="max-w-md text-center text-sm text-muted-foreground">
            {this.state.error.message || "An unexpected error occurred."}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={this.handleReset}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <RefreshCwIcon className="size-3.5" />
              Try again
            </button>
            <button
              onClick={this.handleReload}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Reload app
            </button>
          </div>
          <ErrorDetails error={this.state.error} errorInfo={this.state.errorInfo} />
        </div>
      );
    }

    return this.props.children;
  }
}
