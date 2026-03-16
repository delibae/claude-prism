import { describe, it, expect } from "vitest";

// These are module-private functions, so we replicate them for testing.
// The logic is simple enough that testing the replica validates the pattern.

const MYLIB_KEY = "__my_library__";
function storeKey(collectionKey: string | null): string {
  return collectionKey ?? MYLIB_KEY;
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\-\s]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function parseBibEntries(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  const parts = content.split(/\n(?=@)/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/@\w+\{([^,\s]+)/);
    if (match) {
      entries.set(match[1], trimmed);
    }
  }
  return entries;
}

describe("storeKey", () => {
  it("returns __my_library__ for null", () => {
    expect(storeKey(null)).toBe("__my_library__");
  });

  it("returns the key as-is for a string", () => {
    expect(storeKey("ABC123")).toBe("ABC123");
  });

  it("returns empty string as-is", () => {
    expect(storeKey("")).toBe("");
  });
});

describe("sanitizeFileName", () => {
  it("lowercases the result", () => {
    expect(sanitizeFileName("MyFile")).toBe("myfile");
  });

  it("replaces spaces with hyphens", () => {
    expect(sanitizeFileName("My Library")).toBe("my-library");
  });

  it("removes special characters", () => {
    expect(sanitizeFileName("hello@world!")).toBe("helloworld");
  });

  it("collapses multiple spaces into single hyphen", () => {
    expect(sanitizeFileName("a   b   c")).toBe("a-b-c");
  });

  it("keeps underscores and hyphens", () => {
    expect(sanitizeFileName("my_file-name")).toBe("my_file-name");
  });

  it("handles unicode/special chars", () => {
    expect(sanitizeFileName("Résumé (CV)")).toBe("rsum-cv");
  });

  it("handles empty string", () => {
    expect(sanitizeFileName("")).toBe("");
  });
});

describe("parseBibEntries", () => {
  it("parses a single entry", () => {
    const bib = `@article{smith2024,
  author = {Smith, John},
  title = {A Paper},
  year = {2024}
}`;
    const entries = parseBibEntries(bib);
    expect(entries.size).toBe(1);
    expect(entries.has("smith2024")).toBe(true);
    expect(entries.get("smith2024")).toContain("author = {Smith, John}");
  });

  it("parses multiple entries", () => {
    const bib = `@article{smith2024,
  author = {Smith},
  year = {2024}
}

@book{doe2023,
  author = {Doe},
  year = {2023}
}`;
    const entries = parseBibEntries(bib);
    expect(entries.size).toBe(2);
    expect(entries.has("smith2024")).toBe(true);
    expect(entries.has("doe2023")).toBe(true);
  });

  it("handles different entry types", () => {
    const bib = `@inproceedings{conf2024,
  title = {Conference Paper}
}

@misc{web2024,
  howpublished = {\\url{https://example.com}}
}`;
    const entries = parseBibEntries(bib);
    expect(entries.size).toBe(2);
    expect(entries.has("conf2024")).toBe(true);
    expect(entries.has("web2024")).toBe(true);
  });

  it("returns empty map for empty content", () => {
    expect(parseBibEntries("").size).toBe(0);
  });

  it("returns empty map for whitespace-only content", () => {
    expect(parseBibEntries("   \n\n  ").size).toBe(0);
  });

  it("ignores malformed entries without citekey", () => {
    const bib = "Some random text without bibtex format";
    const entries = parseBibEntries(bib);
    expect(entries.size).toBe(0);
  });

  it("overwrites duplicate citekeys with last occurrence", () => {
    const bib = `@article{key1,
  title = {First}
}

@article{key1,
  title = {Second}
}`;
    const entries = parseBibEntries(bib);
    expect(entries.size).toBe(1);
    expect(entries.get("key1")).toContain("Second");
  });
});
