import { getMupdfClient } from "./mupdf-client";
import { createLogger } from "@/lib/debug/logger";
import type { PageSize } from "./types";

const log = createLogger("pdf-doc-cache");

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
  const mid = Array.from(
    data.subarray(Math.floor(len / 2) - 4, Math.floor(len / 2) + 4),
  );
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
    log.debug(`Evicted doc ${entry.docId} (cache size was ${cache.size + 1})`);
    await getMupdfClient()
      .closeDocument(entry.docId)
      .catch(() => {});
  }
}

export interface DocCacheResult {
  docId: number;
  pageSizes: PageSize[];
  cacheHit: boolean;
}

/**
 * Synchronous cache lookup — returns the cached result if the PDF is already open,
 * or null on cache miss. Use this to skip the async path on file switch.
 */
export function getCachedDocument(data: Uint8Array): DocCacheResult | null {
  const fingerprint = computeFingerprint(data);
  const cached = cache.get(fingerprint);
  if (cached) {
    cached.lastAccess = Date.now();
    return { docId: cached.docId, pageSizes: cached.pageSizes, cacheHit: true };
  }
  return null;
}

/**
 * Get or open a MuPDF document, using the LRU cache.
 * Returns the docId and pageSizes. If the same PDF bytes were already open,
 * reuses the existing document (cache hit).
 */
export async function getOrOpenDocument(
  data: Uint8Array,
): Promise<DocCacheResult> {
  // Reuse synchronous lookup to avoid duplicating fingerprint + cache logic
  const hit = getCachedDocument(data);
  if (hit) return hit;

  // Cache miss — evict if needed, then open
  await evictOldest();
  const fingerprint = computeFingerprint(data);

  log.debug(
    `Cache miss, opening document (${(data.byteLength / 1024).toFixed(0)} KB)`,
  );
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

  log.info(
    `Opened doc ${docId}: ${pageSizes.length} pages, cache size=${cache.size}`,
  );
  return { docId, pageSizes, cacheHit: false };
}

/** Close and remove a specific document from cache by docId. */
export function invalidateDoc(docId: number): void {
  for (const [key, entry] of cache) {
    if (entry.docId === docId) {
      cache.delete(key);
      getMupdfClient()
        .closeDocument(docId)
        .catch(() => {});
      return;
    }
  }
}

/** Close all cached documents (e.g., on project close). */
export async function clearDocCache(): Promise<void> {
  const count = cache.size;
  const client = getMupdfClient();
  const closePromises = [...cache.values()].map((entry) =>
    client.closeDocument(entry.docId).catch(() => {}),
  );
  cache.clear();
  await Promise.all(closePromises);
  log.info(`Cleared doc cache (${count} documents closed)`);
}
