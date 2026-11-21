import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCollections,
  importCollection,
  retryDelayMs,
} from "@/lib/zotero-api";

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function collection(i: number) {
  return {
    key: `C${i}`,
    data: { key: `C${i}`, name: `Collection ${i}`, parentCollection: false },
    meta: { numItems: 1 },
  };
}

function item(i: number) {
  return { key: `I${i}`, bibtex: `@article{key${i},\n title={T${i}}\n}` };
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchCollections", () => {
  it("pages through more than one page of collections", async () => {
    const all = Array.from({ length: 130 }, (_, i) => collection(i));
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const start = Number(url.searchParams.get("start"));
      const limit = Number(url.searchParams.get("limit"));
      return jsonResponse(all.slice(start, start + limit), {
        "Total-Results": "130",
      });
    });

    const result = await fetchCollections("key", "42");
    expect(result).toHaveLength(130);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("importCollection", () => {
  it("keeps paging when Total-Results is not exposed", async () => {
    const all = Array.from({ length: 250 }, (_, i) => item(i));
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const start = Number(url.searchParams.get("start"));
      return jsonResponse(all.slice(start, start + 100)); // no headers
    });

    const result = await importCollection("key", "42", null);
    expect(Object.keys(result.keyMap)).toHaveLength(250);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries rate-limited requests instead of failing the import", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([item(1)], { "Total-Results": "1" }));

    const promise = importCollection("key", "42", null);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result.keyMap).toEqual({ I1: "key1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("retryDelayMs", () => {
  it("honors Retry-After, falls back to exponential backoff, and caps", () => {
    const withHeader = new Response(null, {
      status: 429,
      headers: { "Retry-After": "5" },
    });
    expect(retryDelayMs(withHeader, 0)).toBe(5000);
    expect(retryDelayMs(new Response(null, { status: 503 }), 2)).toBe(4000);
    const huge = new Response(null, {
      status: 429,
      headers: { "Retry-After": "3600" },
    });
    expect(retryDelayMs(huge, 0)).toBe(30_000);
  });
});
