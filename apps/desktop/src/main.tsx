import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles/globals.css";

// On non-macOS platforms, reset titlebar height (no overlay titlebar)
if (!navigator.userAgent.includes("Macintosh")) {
  document.documentElement.style.setProperty("--titlebar-height", "0px");
  document.documentElement.style.setProperty("--traffic-light-width", "0px");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
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
