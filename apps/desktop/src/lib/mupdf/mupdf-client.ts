import type { StructuredTextData, LinkData, PageSize, WorkerResponse } from "./types";

export interface MupdfClient {
  openDocument(buffer: ArrayBuffer, magic?: string): Promise<number>;
  closeDocument(docId: number): Promise<void>;
  countPages(docId: number): Promise<number>;
  getPageSize(docId: number, pageIndex: number): Promise<PageSize>;
  drawPage(docId: number, pageIndex: number, dpi: number): Promise<ImageData>;
  getPageText(docId: number, pageIndex: number): Promise<StructuredTextData>;
  getPageLinks(docId: number, pageIndex: number): Promise<LinkData[]>;
  renderThumbnail(docId: number, pageIndex: number, targetWidth: number): Promise<ArrayBuffer>;
  destroy(): void;
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

function createClient(): MupdfClient {
  const worker = new Worker(
    new URL("./mupdf-worker.ts", import.meta.url),
    { type: "module" },
  );

  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let ready: Promise<void>;
  let resolveReady: () => void;

  ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as WorkerResponse;
    const [type, id, payload] = data;

    if (type === "INIT") {
      resolveReady();
      return;
    }

    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);

    if (type === "RESULT") {
      request.resolve(payload);
    } else if (type === "ERROR") {
      const err = payload as { name: string; message: string };
      request.reject(new Error(`${err.name}: ${err.message}`));
    }
  };

  worker.onerror = (event) => {
    console.error("[mupdf-worker] error:", event);
  };

  function call(method: string, ...args: unknown[]): Promise<any> {
    return ready.then(() => {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });

        const transferables: Transferable[] = [];
        for (const arg of args) {
          if (arg instanceof ArrayBuffer) {
            transferables.push(arg);
          }
        }

        worker.postMessage([method, id, args], { transfer: transferables });
      });
    });
  }

  return {
    openDocument: (buffer, magic = "application/pdf") => call("openDocument", buffer, magic),
    closeDocument: (docId) => call("closeDocument", docId),
    countPages: (docId) => call("countPages", docId),
    getPageSize: (docId, pageIndex) => call("getPageSize", docId, pageIndex),
    drawPage: (docId, pageIndex, dpi) => call("drawPage", docId, pageIndex, dpi),
    getPageText: (docId, pageIndex) => call("getPageText", docId, pageIndex),
    getPageLinks: (docId, pageIndex) => call("getPageLinks", docId, pageIndex),
    renderThumbnail: (docId, pageIndex, targetWidth) => call("renderThumbnail", docId, pageIndex, targetWidth),
    destroy: () => worker.terminate(),
  };
}

let instance: MupdfClient | null = null;

export function getMupdfClient(): MupdfClient {
  if (!instance) {
    instance = createClient();
  }
  return instance;
}
