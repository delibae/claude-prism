import { describe, expect, it } from "vitest";
import {
  AUTH_HINT,
  isClaudeAuthError,
  withAuthHint,
} from "@/lib/claude-errors";

describe("claude auth error hint (#121)", () => {
  it("recognizes expired/invalid login errors", () => {
    expect(
      isClaudeAuthError(
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
      ),
    ).toBe(true);
    expect(isClaudeAuthError("Invalid API key · Please run /login")).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isClaudeAuthError("API Error: 529 overloaded_error")).toBe(false);
    // Third-party provider key errors shouldn't point users at Claude sign-in.
    expect(isClaudeAuthError("OpenAI error: invalid api key")).toBe(false);
    expect(withAuthHint("rate limited")).toBe("rate limited");
  });

  it("appends the hint exactly once", () => {
    const once = withAuthHint("OAuth token has expired");
    expect(once.endsWith(AUTH_HINT)).toBe(true);
    expect(withAuthHint(once)).toBe(once);
  });
});
