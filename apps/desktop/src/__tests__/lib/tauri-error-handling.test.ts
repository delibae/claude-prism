import { describe, it, expect } from "vitest";

/**
 * Regression tests: Tauri IPC error handling.
 *
 * When a Rust #[tauri::command] returns Err(String), the frontend's
 * `invoke()` rejects with a **plain string**, NOT an Error object.
 * Catch blocks that only check `error instanceof Error` will miss these
 * and fall through to a generic message, losing the actual error details.
 *
 * The correct pattern is:
 *   error instanceof Error ? error.message
 *     : typeof error === "string" ? error
 *     : "Compilation failed"
 */

/** Helper that mirrors the pattern used in catch blocks */
function extractErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Compilation failed";
}

describe("Tauri IPC error message extraction", () => {
  it("extracts message from a standard Error object", () => {
    const error = new Error("Something went wrong");
    expect(extractErrorMessage(error)).toBe("Something went wrong");
  });

  it("extracts message from a plain string (Tauri Err(String) pattern)", () => {
    // This is what Tauri invoke() rejects with for Rust Err(String)
    const error = "Compilation failed\n\n! Undefined control sequence.";
    expect(extractErrorMessage(error)).toBe(
      "Compilation failed\n\n! Undefined control sequence.",
    );
  });

  it("extracts message from an empty string", () => {
    expect(extractErrorMessage("")).toBe("");
  });

  it("falls back to generic message for non-string, non-Error values", () => {
    expect(extractErrorMessage(42)).toBe("Compilation failed");
    expect(extractErrorMessage(null)).toBe("Compilation failed");
    expect(extractErrorMessage(undefined)).toBe("Compilation failed");
    expect(extractErrorMessage({ code: 1 })).toBe("Compilation failed");
  });

  it("a plain string is NOT instanceof Error (the root cause of the bug)", () => {
    const tauriError: unknown = "Compilation failed\n\n! Missing $ inserted.";
    expect(tauriError instanceof Error).toBe(false);
    expect(typeof tauriError === "string").toBe(true);
  });
});
