import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  validateApiKey,
  fetchCollections,
  importCollection,
  syncCollection,
  startOAuth,
  completeOAuth,
  cancelOAuth,
  type ZoteroCollection,
} from "@/lib/zotero-api";
import { useDocumentStore } from "@/stores/document-store";
import { createFileOnDisk } from "@/lib/tauri/fs";

/** Per-collection sync metadata (persisted) */
export interface CollectionSyncInfo {
  collectionKey: string | null; // null = "My Library"
  name: string;
  bibFileName: string;
  libraryVersion: number;
  keyMap: Record<string, string>;
}

/** Synced collections scoped per project path */
type ProjectSyncedCollections = Record<string, Record<string, CollectionSyncInfo>>;

interface ZoteroState {
  // Persisted
  apiKey: string | null;
  userID: string | null;
  username: string | null;
  /** Synced collections keyed by projectPath → collectionKey */
  syncedCollections: ProjectSyncedCollections;

  // Transient
  isAuthenticated: boolean;
  isValidating: boolean;
  isSyncing: string | null; // collectionKey currently syncing, or null
  syncProgress: { loaded: number; total: number } | null;
  error: string | null;
  collections: ZoteroCollection[];
  isLoadingCollections: boolean;

  connectWithOAuth: () => Promise<boolean>;
  connectWithApiKey: (apiKey: string) => Promise<boolean>;
  cancelConnect: () => void;
  disconnect: () => void;
  revalidate: () => Promise<void>;
  loadCollections: () => Promise<void>;
  importCollectionToBib: (collectionKey: string | null, name: string) => Promise<void>;
  syncCollectionBib: (collectionKey: string | null) => Promise<void>;
  removeCollection: (collectionKey: string | null) => void;
}

const MYLIB_KEY = "__my_library__";
function storeKey(collectionKey: string | null): string {
  return collectionKey ?? MYLIB_KEY;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\s]/g, "").replace(/\s+/g, "-").toLowerCase();
}

/** Parse a .bib file into a map of citekey → full entry string */
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

export const useZoteroStore = create<ZoteroState>()(
  persist(
    (set, get) => ({
      apiKey: null,
      userID: null,
      username: null,
      syncedCollections: {},

      isAuthenticated: false,
      isValidating: false,
      isSyncing: null,
      syncProgress: null,
      error: null,
      collections: [],
      isLoadingCollections: false,

      connectWithOAuth: async () => {
        set({ isValidating: true, error: null });
        try {
          await startOAuth();
          const creds = await completeOAuth();
          set({
            apiKey: creds.apiKey,
            userID: creds.userID,
            username: creds.username,
            isAuthenticated: true,
            isValidating: false,
          });
          // Auto-load collections after connecting
          get().loadCollections();
          return true;
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : "Connection failed",
            isValidating: false,
          });
          return false;
        }
      },

      connectWithApiKey: async (apiKey: string) => {
        set({ isValidating: true, error: null });
        try {
          const creds = await validateApiKey(apiKey);
          set({
            apiKey: creds.apiKey,
            userID: creds.userID,
            username: creds.username,
            isAuthenticated: true,
            isValidating: false,
          });
          get().loadCollections();
          return true;
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : "Connection failed",
            isValidating: false,
          });
          return false;
        }
      },

      cancelConnect: () => {
        cancelOAuth().catch(() => {});
        set({ isValidating: false, error: null });
      },

      disconnect: () => {
        set({
          apiKey: null,
          userID: null,
          username: null,
          syncedCollections: {},
          isAuthenticated: false,
          error: null,
          collections: [],
        });
      },

      revalidate: async () => {
        const { apiKey } = get();
        if (!apiKey) return;
        try {
          const creds = await validateApiKey(apiKey);
          set({
            userID: creds.userID,
            username: creds.username,
            isAuthenticated: true,
          });
          get().loadCollections();
        } catch {
          set({ isAuthenticated: false });
        }
      },

      loadCollections: async () => {
        const { apiKey, userID } = get();
        if (!apiKey || !userID) return;
        set({ isLoadingCollections: true });
        try {
          const collections = await fetchCollections(apiKey, userID);
          set({ collections, isLoadingCollections: false });
        } catch {
          set({ isLoadingCollections: false });
        }
      },

      importCollectionToBib: async (collectionKey, name) => {
        const { apiKey, userID } = get();
        if (!apiKey || !userID) return;

        const docStore = useDocumentStore.getState();
        if (!docStore.projectRoot) return;
        const projectRoot = docStore.projectRoot;

        const sk = storeKey(collectionKey);
        set({ isSyncing: sk, syncProgress: null, error: null });

        try {
          const result = await importCollection(apiKey, userID, collectionKey, (loaded, total) => {
            set({ syncProgress: { loaded, total } });
          });

          // Determine .bib file name
          const bibFileName = `${sanitizeFileName(name)}.bib`;

          // Check if this .bib file already exists in the project
          const existingFile = docStore.files.find((f) => f.name === bibFileName);
          if (existingFile) {
            docStore.updateFileContent(existingFile.id, result.bibtex);
          } else {
            const fullPath = await createFileOnDisk(
              projectRoot,
              bibFileName,
              result.bibtex,
            );
            docStore.addFile({
              name: bibFileName,
              relativePath: bibFileName,
              absolutePath: fullPath,
              type: "tex",
              content: result.bibtex,
            });
          }

          // Store sync info scoped to current project
          const syncInfo: CollectionSyncInfo = {
            collectionKey,
            name,
            bibFileName,
            libraryVersion: result.libraryVersion,
            keyMap: result.keyMap,
          };
          set((s) => {
            const projectColls = s.syncedCollections[projectRoot] ?? {};
            return {
              syncedCollections: {
                ...s.syncedCollections,
                [projectRoot]: { ...projectColls, [sk]: syncInfo },
              },
              isSyncing: null,
              syncProgress: null,
            };
          });
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : "Import failed",
            isSyncing: null,
            syncProgress: null,
          });
        }
      },

      syncCollectionBib: async (collectionKey) => {
        const { apiKey, userID, syncedCollections } = get();
        if (!apiKey || !userID) return;

        const docStore = useDocumentStore.getState();
        if (!docStore.projectRoot) return;
        const projectRoot = docStore.projectRoot;

        const sk = storeKey(collectionKey);
        const projectColls = syncedCollections[projectRoot] ?? {};
        const syncInfo = projectColls[sk];
        if (!syncInfo) return;

        const bibFile = docStore.files.find((f) => f.name === syncInfo.bibFileName);
        if (!bibFile) return;

        set({ isSyncing: sk, syncProgress: null, error: null });

        try {
          const result = await syncCollection(
            apiKey, userID, collectionKey, syncInfo.libraryVersion,
            (loaded, total) => { set({ syncProgress: { loaded, total } }); },
          );

          if (collectionKey) {
            // For specific collections, syncCollection returns a full re-import
            // Rebuild the .bib content from all entries
            const newKeyMap: Record<string, string> = {};
            const entries: string[] = [];
            for (const entry of result.updatedEntries) {
              if (entry.bibtex.trim()) {
                entries.push(entry.bibtex);
                newKeyMap[entry.key] = entry.citekey;
              }
            }
            const updatedContent = entries.join("\n\n") + "\n";
            docStore.updateFileContent(bibFile.id, updatedContent);

            set((s) => {
              const pColls = s.syncedCollections[projectRoot] ?? {};
              return {
                syncedCollections: {
                  ...s.syncedCollections,
                  [projectRoot]: {
                    ...pColls,
                    [sk]: {
                      ...syncInfo,
                      libraryVersion: result.libraryVersion,
                      keyMap: newKeyMap,
                    },
                  },
                },
                isSyncing: null,
                syncProgress: null,
              };
            });
          } else {
            // For "My Library", apply incremental diff
            const currentContent = bibFile.content ?? "";
            const entries = parseBibEntries(currentContent);
            const newKeyMap = { ...syncInfo.keyMap };

            for (const entry of result.updatedEntries) {
              const oldCitekey = newKeyMap[entry.key];
              if (oldCitekey && oldCitekey !== entry.citekey) {
                entries.delete(oldCitekey);
              }
              entries.set(entry.citekey, entry.bibtex);
              newKeyMap[entry.key] = entry.citekey;
            }

            for (const deletedKey of result.deletedKeys) {
              const citekey = newKeyMap[deletedKey];
              if (citekey) {
                entries.delete(citekey);
                delete newKeyMap[deletedKey];
              }
            }

            const updatedContent = Array.from(entries.values()).join("\n\n") + "\n";
            docStore.updateFileContent(bibFile.id, updatedContent);

            set((s) => {
              const pColls = s.syncedCollections[projectRoot] ?? {};
              return {
                syncedCollections: {
                  ...s.syncedCollections,
                  [projectRoot]: {
                    ...pColls,
                    [sk]: {
                      ...syncInfo,
                      libraryVersion: result.libraryVersion,
                      keyMap: newKeyMap,
                    },
                  },
                },
                isSyncing: null,
                syncProgress: null,
              };
            });
          }
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : "Sync failed",
            isSyncing: null,
            syncProgress: null,
          });
        }
      },

      removeCollection: (collectionKey) => {
        const projectRoot = useDocumentStore.getState().projectRoot;
        if (!projectRoot) return;

        const sk = storeKey(collectionKey);
        set((s) => {
          const projectColls = s.syncedCollections[projectRoot] ?? {};
          const { [sk]: _, ...rest } = projectColls;
          return {
            syncedCollections: {
              ...s.syncedCollections,
              [projectRoot]: rest,
            },
          };
        });
      },
    }),
    {
      name: "claude-prism-zotero",
      partialize: (state) => ({
        apiKey: state.apiKey,
        userID: state.userID,
        username: state.username,
        syncedCollections: state.syncedCollections,
      }),
    },
  ),
);
