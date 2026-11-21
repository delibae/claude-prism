import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";

const ZOTERO_BASE = "https://api.zotero.org";

export interface ZoteroCredentials {
  apiKey: string;
  userID: string;
  username: string;
}

export interface ZoteroCollection {
  key: string;
  name: string;
  parentKey: string | false;
  itemCount: number;
}

/** Result of importing a collection */
export interface CollectionImportResult {
  bibtex: string;
  libraryVersion: number;
  keyMap: Record<string, string>;
  totalItems: number;
}

/** Result of an incremental sync */
export interface CollectionSyncResult {
  updatedEntries: { key: string; citekey: string; bibtex: string }[];
  deletedKeys: string[];
  libraryVersion: number;
}

// ─── OAuth Flow (via Tauri Rust backend) ───

export async function startOAuth(): Promise<void> {
  const result = await invoke<{ authorize_url: string }>("zotero_start_oauth");
  await open(result.authorize_url);
}

export async function completeOAuth(): Promise<ZoteroCredentials> {
  const result = await invoke<{
    api_key: string;
    user_id: string;
    username: string;
  }>("zotero_complete_oauth");
  return {
    apiKey: result.api_key,
    userID: result.user_id,
    username: result.username,
  };
}

export async function cancelOAuth(): Promise<void> {
  await invoke("zotero_cancel_oauth");
}

// ─── Zotero Web API v3 ───

const ZOTERO_MAX_RETRIES = 3;
const ZOTERO_MAX_RETRY_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryDelayMs(response: Response, attempt: number): number {
  const header =
    response.headers.get("Retry-After") ?? response.headers.get("Backoff");
  const seconds = header === null ? Number.NaN : Number(header);
  const ms =
    Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : 1000 * 2 ** attempt;
  return Math.min(ms, ZOTERO_MAX_RETRY_DELAY_MS);
}

async function zoteroFetch(
  apiKey: string,
  path: string,
  headers?: Record<string, string>,
): Promise<Response> {
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(`${ZOTERO_BASE}${path}`, {
      headers: {
        "Zotero-API-Key": apiKey,
        "Zotero-API-Version": "3",
        ...headers,
      },
    });
    // Large imports issue many requests back to back; Zotero answers 429/503
    // with Retry-After/Backoff. Wait and retry instead of failing the import.
    if (
      (response.status !== 429 && response.status !== 503) ||
      attempt >= ZOTERO_MAX_RETRIES
    ) {
      break;
    }
    await sleep(retryDelayMs(response, attempt));
  }
  if (!response.ok) {
    if (response.status === 304) return response;
    if (response.status === 403) throw new Error("Invalid or expired API key");
    throw new Error(`Zotero API error: ${response.status}`);
  }
  return response;
}

function extractCitekey(bibtex: string): string {
  const match = bibtex.match(/@\w+\{([^,\s]+)/);
  return match ? match[1] : "";
}

export async function validateApiKey(
  apiKey: string,
): Promise<ZoteroCredentials> {
  const response = await zoteroFetch(apiKey, "/keys/current");
  const data = await response.json();
  return {
    apiKey,
    userID: String(data.userID),
    username: data.username ?? "",
  };
}

// ─── Collections ───

export async function fetchCollections(
  apiKey: string,
  userID: string,
): Promise<ZoteroCollection[]> {
  type RawCollection = {
    key: string;
    data: { key: string; name: string; parentCollection: string | false };
    meta: { numItems: number };
  };
  // The API returns 25 collections per page by default; page through all.
  const data: RawCollection[] = [];
  const limit = 100;
  for (let start = 0; ; ) {
    const response = await zoteroFetch(
      apiKey,
      `/users/${userID}/collections?format=json&limit=${limit}&start=${start}`,
    );
    const page = (await response.json()) as RawCollection[];
    data.push(...page);
    start += page.length;
    const total = Number(response.headers.get("Total-Results") ?? 0);
    if (page.length < limit || (total > 0 && start >= total)) break;
  }
  return data.map((c) => ({
    key: c.key,
    name: c.data.name,
    parentKey: c.data.parentCollection,
    itemCount: c.meta.numItems,
  }));
}

// ─── Collection Import (full download) ───

/**
 * Import all items from a specific collection.
 * Pass collectionKey = null to import the entire "My Library" (all top-level items).
 */
export async function importCollection(
  apiKey: string,
  userID: string,
  collectionKey: string | null,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CollectionImportResult> {
  const basePath = collectionKey
    ? `/users/${userID}/collections/${collectionKey}/items/top`
    : `/users/${userID}/items/top`;

  let allBibtex = "";
  const keyMap: Record<string, string> = {};
  let start = 0;
  const limit = 100;
  let total = 0;
  let libraryVersion = 0;

  while (true) {
    const params = new URLSearchParams({
      format: "json",
      include: "bibtex",
      limit: String(limit),
      start: String(start),
    });
    const response = await zoteroFetch(apiKey, `${basePath}?${params}`);

    if (start === 0) {
      total = Number(response.headers.get("Total-Results") ?? 0);
      libraryVersion = Number(
        response.headers.get("Last-Modified-Version") ?? 0,
      );
    }

    const items = (await response.json()) as { key: string; bibtex?: string }[];
    if (items.length === 0) break;

    for (const item of items) {
      const bibtex = item.bibtex ?? "";
      if (!bibtex.trim()) continue;
      const citekey = extractCitekey(bibtex);
      if (citekey) keyMap[item.key] = citekey;
      allBibtex += (allBibtex ? "\n\n" : "") + bibtex;
    }

    start += items.length;
    onProgress?.(total ? Math.min(start, total) : start, total);
    // Don't rely solely on Total-Results: if the header is missing (e.g. not
    // exposed to the webview), a short page is the reliable end marker.
    if (items.length < limit || (total > 0 && start >= total)) break;
  }

  return { bibtex: allBibtex, libraryVersion, keyMap, totalItems: total };
}

// ─── Incremental Sync ───

/**
 * Sync changes for a specific collection since lastVersion.
 * collectionKey = null syncs the entire library.
 *
 * Note: Zotero's `since` param works at the library level (not per-collection),
 * so for collection sync we re-fetch all collection items and diff locally.
 */
export async function syncCollection(
  apiKey: string,
  userID: string,
  collectionKey: string | null,
  lastVersion: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CollectionSyncResult> {
  // For "My Library" (all items), we can use the `since` param
  if (!collectionKey) {
    return syncFullLibrary(apiKey, userID, lastVersion, onProgress);
  }

  // For a specific collection, re-fetch all items and diff against keyMap
  // (Zotero API doesn't support `since` scoped to a collection)
  const result = await importCollection(
    apiKey,
    userID,
    collectionKey,
    onProgress,
  );

  return {
    updatedEntries: Object.entries(result.keyMap).map(([key, citekey]) => {
      // Extract the bibtex for this citekey from the full bibtex string
      const bibtexEntries = result.bibtex.split(/\n(?=@)/);
      const entry =
        bibtexEntries.find((e) => extractCitekey(e) === citekey) ?? "";
      return { key, citekey, bibtex: entry };
    }),
    deletedKeys: [],
    libraryVersion: result.libraryVersion,
  };
}

async function syncFullLibrary(
  apiKey: string,
  userID: string,
  lastVersion: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CollectionSyncResult> {
  const updatedEntries: CollectionSyncResult["updatedEntries"] = [];
  let start = 0;
  const limit = 100;
  let total = 0;
  let newVersion = lastVersion;

  while (true) {
    const params = new URLSearchParams({
      since: String(lastVersion),
      format: "json",
      include: "bibtex",
      limit: String(limit),
      start: String(start),
    });
    const response = await zoteroFetch(
      apiKey,
      `/users/${userID}/items/top?${params}`,
    );

    if (start === 0) {
      total = Number(response.headers.get("Total-Results") ?? 0);
      newVersion = Number(
        response.headers.get("Last-Modified-Version") ?? lastVersion,
      );
    }

    const items = (await response.json()) as { key: string; bibtex?: string }[];
    if (items.length === 0) break;

    for (const item of items) {
      const bibtex = item.bibtex ?? "";
      if (!bibtex.trim()) continue;
      const citekey = extractCitekey(bibtex);
      updatedEntries.push({ key: item.key, citekey, bibtex });
    }

    start += items.length;
    onProgress?.(total ? Math.min(start, total) : start, total);
    // Don't rely solely on Total-Results: if the header is missing (e.g. not
    // exposed to the webview), a short page is the reliable end marker.
    if (items.length < limit || (total > 0 && start >= total)) break;
  }

  // Fetch deleted items
  const deletedResponse = await zoteroFetch(
    apiKey,
    `/users/${userID}/deleted?since=${lastVersion}`,
  );
  const deleted = (await deletedResponse.json()) as { items?: string[] };
  const deletedKeys = deleted.items ?? [];

  if (!newVersion || newVersion === lastVersion) {
    newVersion = Number(
      deletedResponse.headers.get("Last-Modified-Version") ?? lastVersion,
    );
  }

  return { updatedEntries, deletedKeys, libraryVersion: newVersion };
}
