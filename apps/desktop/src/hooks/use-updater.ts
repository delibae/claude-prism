import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "available"; version: string; notes?: string }
  | { state: "downloading"; percent: number }
  | { state: "installing" }
  | { state: "ready" }
  | { state: "error"; message: string };

export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const updateRef = useRef<Update | null>(null);

  const checkForUpdate = useCallback(async () => {
    setStatus({ state: "checking" });
    try {
      const update = await check();
      if (!update) {
        setStatus({ state: "up-to-date" });
        return;
      }
      updateRef.current = update;
      setStatus({
        state: "available",
        version: update.version,
        notes: update.body ?? undefined,
      });
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;

    try {
      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength ?? 0;
            setStatus({ state: "downloading", percent: 0 });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              setStatus({
                state: "downloading",
                percent: Math.round((downloaded / contentLength) * 100),
              });
            }
            break;
          case "Finished":
            setStatus({ state: "installing" });
            break;
        }
      });

      setStatus({ state: "ready" });
      setTimeout(() => relaunch(), 1500);
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }, []);

  // Auto-check on mount
  useEffect(() => {
    checkForUpdate();
  }, [checkForUpdate]);

  return { status, checkForUpdate, installUpdate };
}
