export interface OllamaProposedEdit {
  filePath: string;
  oldText: string;
  newText: string;
}

const CHANGE_OPEN_RE = /<proposed-change\s+file\s*=\s*["']([^"']+)["']\s*>/;

/**
 * Parse `<proposed-change file="...">...<old>...<old/><new>...<new/><proposed-change/>`
 * blocks from an Ollama response.
 *
 * This is intentionally tolerant: it searches linearly and does not require
 * well-formed XML beyond the expected tags.
 */
export function parseOllamaProposedChanges(text: string): OllamaProposedEdit[] {
  const edits: OllamaProposedEdit[] = [];
  let searchFrom = 0;

  while (true) {
    const startMatch = findNextBlockStart(text, searchFrom);
    if (!startMatch) break;
    const openEnd = startMatch.end;
    const filePath = startMatch.filePath;

    const closeIdx = text.indexOf("</proposed-change>", openEnd);
    if (closeIdx === -1) {
      // No closing tag — ignore this partial block.
      break;
    }

    const block = text.slice(openEnd, closeIdx);
    const oldText = extractTag(block, "old");
    const newText = extractTag(block, "new");

    if (oldText !== null && newText !== null) {
      edits.push({ filePath, oldText, newText });
    }

    searchFrom = closeIdx + "</proposed-change>".length;
  }

  return edits;
}

interface BlockStart {
  end: number;
  filePath: string;
}

function findNextBlockStart(text: string, from: number): BlockStart | null {
  const regex = new RegExp(CHANGE_OPEN_RE.source, "g");
  regex.lastIndex = from;
  const match = regex.exec(text);
  if (!match) return null;
  return {
    end: match.index + match[0].length,
    filePath: match[1],
  };
}

function extractTag(block: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = block.indexOf(open);
  if (start === -1) return null;
  const contentStart = start + open.length;
  const end = block.indexOf(close, contentStart);
  if (end === -1) return null;
  let content = block.slice(contentStart, end);
  // Models commonly insert a leading/trailing newline after/before XML tags.
  if (content.startsWith("\n")) content = content.slice(1);
  if (content.endsWith("\n")) content = content.slice(0, -1);
  return content;
}

/**
 * Try to apply `oldText` → `newText` to `fileContent`.
 * Falls back to a trimmed match if an exact match fails.
 *
 * Returns the updated content, or `null` if the old text could not be located.
 */
export function applyOllamaEdit(
  fileContent: string,
  oldText: string,
  newText: string,
): string | null {
  if (fileContent.includes(oldText)) {
    return fileContent.replace(oldText, newText);
  }

  // Trim-only fallback: handles models that add leading/trailing blank lines.
  const trimmed = oldText.trim();
  if (trimmed && fileContent.includes(trimmed)) {
    return fileContent.replace(trimmed, newText);
  }

  return null;
}
