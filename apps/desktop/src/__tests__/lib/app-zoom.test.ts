import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  APP_ZOOM_STORAGE_KEY,
  DEFAULT_APP_ZOOM,
  LOCAL_ZOOM_SHORTCUTS_ATTR,
  MAX_APP_ZOOM,
  MIN_APP_ZOOM,
  clampAppZoom,
  getAppZoomAction,
  initializeAppZoom,
  persistAppZoom,
  readStoredAppZoom,
  resetAppZoom,
  shouldHandleAppZoomShortcut,
  zoomInApp,
  zoomOutApp,
} from "@/lib/app-zoom";

describe("app zoom", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("falls back to the default zoom when storage is empty or invalid", () => {
    expect(readStoredAppZoom()).toBe(DEFAULT_APP_ZOOM);

    localStorage.setItem(APP_ZOOM_STORAGE_KEY, "not-a-number");
    expect(readStoredAppZoom()).toBe(DEFAULT_APP_ZOOM);
  });

  it("clamps stored zoom values into the supported range", () => {
    localStorage.setItem(APP_ZOOM_STORAGE_KEY, "999");
    expect(readStoredAppZoom()).toBe(MAX_APP_ZOOM);

    localStorage.setItem(APP_ZOOM_STORAGE_KEY, "0.1");
    expect(readStoredAppZoom()).toBe(MIN_APP_ZOOM);
  });

  it("applies persisted zoom through the webview API", async () => {
    const webview = getCurrentWebview();

    await persistAppZoom(1.25);

    expect(webview.setZoom).toHaveBeenCalledWith(1.25);
    expect(localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe("1.25");
  });

  it("restores the saved zoom on startup", async () => {
    const webview = getCurrentWebview();
    localStorage.setItem(APP_ZOOM_STORAGE_KEY, "1.4");

    await initializeAppZoom();

    expect(webview.setZoom).toHaveBeenCalledWith(1.4);
  });

  it("zooms in, zooms out, and resets around the stored value", async () => {
    const webview = getCurrentWebview();
    localStorage.setItem(APP_ZOOM_STORAGE_KEY, "1.2");

    await zoomInApp();
    expect(webview.setZoom).toHaveBeenLastCalledWith(1.3);
    expect(localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe("1.3");

    await zoomOutApp();
    expect(webview.setZoom).toHaveBeenLastCalledWith(1.2);
    expect(localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe("1.2");

    await resetAppZoom();
    expect(webview.setZoom).toHaveBeenLastCalledWith(DEFAULT_APP_ZOOM);
    expect(localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe(
      DEFAULT_APP_ZOOM.toString(),
    );
  });

  it("rounds and clamps zoom values consistently", () => {
    expect(clampAppZoom(1.234)).toBe(1.23);
    expect(clampAppZoom(10)).toBe(MAX_APP_ZOOM);
    expect(clampAppZoom(0.01)).toBe(MIN_APP_ZOOM);
  });
});

describe("getAppZoomAction", () => {
  it("detects zoom-in shortcuts", () => {
    expect(
      getAppZoomAction({
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        key: "+",
        code: "Equal",
      }),
    ).toBe("in");

    expect(
      getAppZoomAction({
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        key: "=",
        code: "Equal",
      }),
    ).toBe("in");
  });

  it("detects zoom-out shortcuts", () => {
    expect(
      getAppZoomAction({
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        key: "-",
        code: "Minus",
      }),
    ).toBe("out");

    expect(
      getAppZoomAction({
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        key: "_",
        code: "Minus",
      }),
    ).toBe("out");
  });

  it("detects zoom reset shortcuts", () => {
    expect(
      getAppZoomAction({
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        key: "0",
        code: "Digit0",
      }),
    ).toBe("reset");
  });

  it("ignores unrelated shortcuts", () => {
    expect(
      getAppZoomAction({
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        key: "+",
        code: "Equal",
      }),
    ).toBeNull();

    expect(
      getAppZoomAction({
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        key: "+",
        code: "Equal",
      }),
    ).toBeNull();
  });
});

describe("shouldHandleAppZoomShortcut", () => {
  it("handles global zoom when the target is outside a local zoom surface", () => {
    const target = document.createElement("div");
    expect(shouldHandleAppZoomShortcut(target)).toBe(true);
  });

  it("skips global zoom inside local zoom surfaces", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute(LOCAL_ZOOM_SHORTCUTS_ATTR, "true");
    const target = document.createElement("button");
    wrapper.appendChild(target);

    expect(shouldHandleAppZoomShortcut(target)).toBe(false);
  });

  it("defaults to handling zoom for non-element targets", () => {
    expect(shouldHandleAppZoomShortcut(null)).toBe(true);
  });
});
