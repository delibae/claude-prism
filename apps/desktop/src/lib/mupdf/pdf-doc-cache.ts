import { getMupdfClient } from "./mupdf-client";
import type { PageSize } from "./types";

interface CachedDoc {
  docId: number;
  pageSizes: PageSize[];
  lastAccess: number;
}

const MAX_OPEN_DOCS = 5;
const cache = new Map<string, CachedDoc>();

/** Create a fast fingerprint from PDF bytes (length + sampled bytes). */
function computeFingerprint(data: Uint8Array): string {
  const len = data.length;
  if (len < 16) return `${len}:${Array.from(data).join(",")}`;
  // Sample: length + first 8 bytes + middle 8 bytes + last 8 bytes
  const first = Array.from(data.subarray(0, 8));
  const mid = Array.from(data.subarray(Math.floor(len / 2) - 4, Math.floor(len / 2) + 4));
  const last = Array.from(data.subarray(len - 8));
  return `${len}:${first.join(",")}|${mid.join(",")}|${last.join(",")}`;
}

async function evictOldest(): Promise<void> {
  if (cache.size < MAX_OPEN_DOCS) return;

  let oldestKey: string | null = null;
  let oldestAccess = Infinity;
  for (const [key, entry] of cache) {
    if (entry.lastAccess < oldestAccess) {
      oldestAccess = entry.lastAccess;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const entry = cache.get(oldestKey)!;
    cache.delete(oldestKey);
    await getMupdfClient().closeDocument(entry.docId).catch(() => {});
  }
}

export interface DocCacheResult {
  docId: number;
  pageSizes: PageSize[];
  cacheHit: boolean;
}

/**
 * Get or open a MuPDF document, using the LRU cache.
 * Returns the docId and pageSizes. If the same PDF bytes were already open,
 * reuses the existing document (cache hit).
 */
export async function getOrOpenDocument(data: Uint8Array): Promise<DocCacheResult> {
  const fingerprint = computeFingerprint(data);

  // O(1) cache lookup by fingerprint
  const cached = cache.get(fingerprint);
  if (cached) {
    cached.lastAccess = Date.now();
    return { docId: cached.docId, pageSizes: cached.pageSizes, cacheHit: true };
  }

  // Cache miss — evict if needed, then open
  await evictOldest();

  const client = getMupdfClient();
  // Always copy — the original buffer may not be transferable (e.g., from Tauri),
  // and transfer detaches the ArrayBuffer which would corrupt the pdfCache reference.
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  const docId = await client.openDocument(buffer);
  const pageSizes = await client.getAllPageSizes(docId);

  cache.set(fingerprint, {
    docId,
    pageSizes,
    lastAccess: Date.now(),
  });

  return { docId, pageSizes, cacheHit: false };
}

/** Close and remove a specific document from cache by docId. */
export function invalidateDoc(docId: number): void {
  for (const [key, entry] of cache) {
    if (entry.docId === docId) {
      cache.delete(key);
      getMupdfClient().closeDocument(docId).catch(() => {});
      return;
    }
  }
}

/** Close all cached documents (e.g., on project close). */
export async function clearDocCache(): Promise<void> {
  const client = getMupdfClient();
  const closePromises = [...cache.values()].map(
    (entry) => client.closeDocument(entry.docId).catch(() => {}),
  );
  cache.clear();
  await Promise.all(closePromises);
}
