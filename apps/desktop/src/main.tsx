import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { initializeAppZoom } from "./lib/app-zoom";
import { createLogger } from "./lib/debug/logger";
import { APP_VISIBILITY_RESTORED } from "./lib/debug/log-store";
import "./styles/globals.css";

const isDebugWindow = new URLSearchParams(window.location.search).has("debug");

const log = createLogger("app");

// Catch unhandled promise rejections to prevent silent failures
window.addEventListener("unhandledrejection", (event) => {
  log.error("Unhandled promise rejection", { reason: String(event.reason) });
});

// Debounce visibility-restored dispatches — both visibilitychange and the Tauri
// Focused event can fire for the same app-switch, so coalesce within 200ms.
let _visibilityTimer: ReturnType<typeof setTimeout> | null = null;
function dispatchVisibilityRestored(source: string) {
  if (_visibilityTimer) return; // already scheduled
  log.info(`Visibility restored (${source})`);
  _visibilityTimer = setTimeout(() => {
    _visibilityTimer = null;
    window.dispatchEvent(new CustomEvent(APP_VISIBILITY_RESTORED));
  }, 200);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    dispatchVisibilityRestored("visibilitychange");
  }
});

// Tauri-native focus event — more reliable than visibilitychange on macOS.
listen("window-focus-restored", () => {
  dispatchVisibilityRestored("window-focus-restored");
});

// Platform-specific titlebar height adjustments
if (navigator.userAgent.includes("Windows")) {
  // Windows overlay titlebar is ~12px (title + window controls)
  document.documentElement.style.setProperty("--titlebar-height", "12px");
  document.documentElement.style.setProperty("--traffic-light-width", "0px");
} else if (!navigator.userAgent.includes("Macintosh")) {
  // Linux and others: no overlay titlebar
  document.documentElement.style.setProperty("--titlebar-height", "0px");
  document.documentElement.style.setProperty("--traffic-light-width", "0px");
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");
const rootContainer: HTMLElement = rootEl;

function hideLoadingScreen() {
  const loading = document.getElementById("loading-screen");
  if (loading) {
    loading.style.opacity = "0";
    setTimeout(() => loading.remove(), 300);
  }
  getCurrentWindow().show();
}

async function bootstrap() {
  try {
    await initializeAppZoom();
  } catch (error) {
    log.error("Failed to initialize app zoom", { error: String(error) });
  }

  if (isDebugWindow) {
    // Debug window — render standalone debug page
    const { DebugPage } = await import("./components/debug/debug-page");
    ReactDOM.createRoot(rootContainer).render(
      <React.StrictMode>
        <DebugPage />
      </React.StrictMode>,
    );
    hideLoadingScreen();
    return;
  }

  // Main app window
  const { App } = await import("./App");
  ReactDOM.createRoot(rootContainer).render(
    <React.StrictMode>
      <App onReady={hideLoadingScreen} />
    </React.StrictMode>,
  );
}

void bootstrap();
