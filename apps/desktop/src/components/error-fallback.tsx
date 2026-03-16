import type { FallbackProps } from "react-error-boundary";

export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl space-y-4">
        <h1 className="font-bold text-2xl text-destructive">
          Something went wrong
        </h1>
        <p className="text-muted-foreground text-sm">
          An unexpected error occurred. You can try again or reload the app.
        </p>

        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-4 text-xs">
          {error instanceof Error
            ? `${error.message}${error.stack ? `\n\n${error.stack}` : ""}`
            : String(error)}
        </pre>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm hover:bg-primary/90"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border px-4 py-2 font-medium text-sm hover:bg-accent"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
