const AUTH_ERROR_PATTERNS = [
  "oauth token has expired",
  "authentication_error",
  "failed to authenticate",
  "invalid api key",
  "invalid x-api-key",
  "please run /login",
];

export const AUTH_HINT =
  "Your Claude sign-in has expired or is invalid. Sign in again from the Claude setup screen, or run `claude auth login` in a terminal.";

/** Whether a Claude CLI error message indicates an expired/invalid login. */
export function isClaudeAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Append an actionable next step to auth failures (e.g. 401 "OAuth token has
 * expired"), which otherwise only show the raw API error (#121).
 */
export function withAuthHint(message: string): string {
  if (!isClaudeAuthError(message) || message.includes(AUTH_HINT)) {
    return message;
  }
  return `${message}\n\n${AUTH_HINT}`;
}
