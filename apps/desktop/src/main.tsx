import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles/globals.css";

// Catch unhandled promise rejections to prevent silent failures
window.addEventListener("unhandledrejection", (event) => {
  console.error("[unhandledrejection]", event.reason);
});

// Platform-specific titlebar height adjustments
if (navigator.userAgent.includes("Windows")) {
  // Windows overlay titlebar is ~32px (title + window controls)
  document.documentElement.style.setProperty("--titlebar-height", "32px");
  document.documentElement.style.setProperty("--traffic-light-width", "0px");
} else if (!navigator.userAgent.includes("Macintosh")) {
  // Linux and others: no overlay titlebar
  document.documentElement.style.setProperty("--titlebar-height", "0px");
  document.documentElement.style.setProperty("--traffic-light-width", "0px");
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App
      onReady={() => {
        // Hide loading screen
        const loading = document.getElementById("loading-screen");
        if (loading) {
          loading.style.opacity = "0";
          setTimeout(() => loading.remove(), 300);
        }
        // Show the Tauri window
        getCurrentWindow().show();
      }}
    />
  </React.StrictMode>,
);
