import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { writeFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { getAssetUrl } from "@/lib/tauri/fs";
import { Button } from "@/components/ui/button";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const MIN_CROP_SIZE = 10;

interface ImagePreviewProps {
  file: ProjectFile;
  scale: number;
  onScaleChange?: (scale: number) => void;
  cropMode?: boolean;
  onCropModeChange?: (mode: boolean) => void;
}

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLES: { id: HandleId; cursor: string; x: number; y: number }[] = [
  { id: "nw", cursor: "nwse-resize", x: 0, y: 0 },
  { id: "n", cursor: "ns-resize", x: 0.5, y: 0 },
  { id: "ne", cursor: "nesw-resize", x: 1, y: 0 },
  { id: "e", cursor: "ew-resize", x: 1, y: 0.5 },
  { id: "se", cursor: "nwse-resize", x: 1, y: 1 },
  { id: "s", cursor: "ns-resize", x: 0.5, y: 1 },
  { id: "sw", cursor: "nesw-resize", x: 0, y: 1 },
  { id: "w", cursor: "ew-resize", x: 0, y: 0.5 },
];

export function ImagePreview({
  file,
  scale,
  onScaleChange,
  cropMode,
  onCropModeChange,
}: ImagePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Crop state
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [activeHandle, setActiveHandle] = useState<HandleId | "move" | null>(
    null,
  );
  const [handleDragStart, setHandleDragStart] = useState<{
    x: number;
    y: number;
    rect: CropRect;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Reset crop rect when exiting crop mode
  useEffect(() => {
    if (!cropMode) {
      setCropRect(null);
      setDragStart(null);
      setActiveHandle(null);
      setHandleDragStart(null);
    }
  }, [cropMode]);

  // ESC to cancel crop mode
  useEffect(() => {
    if (!cropMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCropModeChange?.(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cropMode, onCropModeChange]);

  // Pinch-to-zoom (Cmd/Ctrl + wheel) — disabled in crop mode
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onScaleChange || cropMode) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY * 0.001;
        onScaleChange(Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale + delta)));
      }
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [scale, onScaleChange, cropMode]);

  // Keyboard zoom (Cmd/Ctrl +/-) — disabled in crop mode
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onScaleChange || cropMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        onScaleChange(Math.min(MAX_SCALE, scale + 0.25));
      } else if (e.key === "-") {
        e.preventDefault();
        onScaleChange(Math.max(MIN_SCALE, scale - 0.25));
      } else if (e.key === "0") {
        e.preventDefault();
        onScaleChange(1);
      }
    };

    el.addEventListener("keydown", handleKeyDown);
    return () => el.removeEventListener("keydown", handleKeyDown);
  }, [scale, onScaleChange, cropMode]);

  // Get coordinates relative to the displayed image
  const getImageRelativeCoords = useCallback((e: React.MouseEvent) => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
    };
  }, []);

  // --- Crop drag: new selection ---
  const handleCropMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!cropMode || activeHandle) return;
      // Only start a new selection if clicking outside the existing crop rect
      const coords = getImageRelativeCoords(e);
      if (!coords) return;

      if (cropRect) {
        // Check if click is inside the existing crop rect → start move
        if (
          coords.x >= cropRect.x &&
          coords.x <= cropRect.x + cropRect.w &&
          coords.y >= cropRect.y &&
          coords.y <= cropRect.y + cropRect.h
        ) {
          setActiveHandle("move");
          setHandleDragStart({
            x: coords.x,
            y: coords.y,
            rect: { ...cropRect },
          });
          e.preventDefault();
          return;
        }
      }

      // Start new selection
      setCropRect(null);
      setDragStart(coords);
      e.preventDefault();
    },
    [cropMode, activeHandle, cropRect, getImageRelativeCoords],
  );

  const handleCropMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!cropMode) return;
      const coords = getImageRelativeCoords(e);
      if (!coords) return;
      const img = imgRef.current;
      if (!img) return;
      const imgRect = img.getBoundingClientRect();
      const maxW = imgRect.width;
      const maxH = imgRect.height;

      // Resizing via handle
      if (activeHandle && handleDragStart) {
        e.preventDefault();
        const { rect } = handleDragStart;
        let { x, y, w, h } = rect;
        const dx = coords.x - handleDragStart.x;
        const dy = coords.y - handleDragStart.y;

        if (activeHandle === "move") {
          x = Math.max(0, Math.min(maxW - w, rect.x + dx));
          y = Math.max(0, Math.min(maxH - h, rect.y + dy));
        } else {
          // Resize based on handle
          if (activeHandle.includes("w")) {
            const newX = Math.max(0, rect.x + dx);
            w = rect.w + (rect.x - newX);
            x = newX;
          }
          if (activeHandle.includes("e")) {
            w = Math.min(maxW - x, rect.w + dx);
          }
          if (activeHandle.includes("n")) {
            const newY = Math.max(0, rect.y + dy);
            h = rect.h + (rect.y - newY);
            y = newY;
          }
          if (activeHandle.includes("s")) {
            h = Math.min(maxH - y, rect.h + dy);
          }
          // Enforce minimum size
          if (w < MIN_CROP_SIZE) {
            w = MIN_CROP_SIZE;
            if (activeHandle.includes("w")) x = rect.x + rect.w - MIN_CROP_SIZE;
          }
          if (h < MIN_CROP_SIZE) {
            h = MIN_CROP_SIZE;
            if (activeHandle.includes("n")) y = rect.y + rect.h - MIN_CROP_SIZE;
          }
        }

        setCropRect({ x, y, w, h });
        return;
      }

      // New selection drag
      if (dragStart) {
        e.preventDefault();
        const x = Math.min(dragStart.x, coords.x);
        const y = Math.min(dragStart.y, coords.y);
        const w = Math.abs(coords.x - dragStart.x);
        const h = Math.abs(coords.y - dragStart.y);
        setCropRect({ x, y, w, h });
      }
    },
    [
      cropMode,
      dragStart,
      activeHandle,
      handleDragStart,
      getImageRelativeCoords,
    ],
  );

  const handleCropMouseUp = useCallback(() => {
    if (
      dragStart &&
      cropRect &&
      (cropRect.w < MIN_CROP_SIZE || cropRect.h < MIN_CROP_SIZE)
    ) {
      setCropRect(null);
    }
    setDragStart(null);
    setActiveHandle(null);
    setHandleDragStart(null);
  }, [dragStart, cropRect]);

  // Handle resize start
  const handleHandleMouseDown = useCallback(
    (e: React.MouseEvent, handleId: HandleId) => {
      if (!cropRect) return;
      e.preventDefault();
      e.stopPropagation();
      const coords = getImageRelativeCoords(e);
      if (!coords) return;
      setActiveHandle(handleId);
      setHandleDragStart({ x: coords.x, y: coords.y, rect: { ...cropRect } });
    },
    [cropRect, getImageRelativeCoords],
  );

  // Apply crop
  const handleApplyCrop = useCallback(async () => {
    if (!cropRect || !file.dataUrl || isSaving) return;
    setIsSaving(true);

    try {
      const img = new Image();
      img.src = file.dataUrl;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load image"));
      });

      // Convert display coords to natural image coords
      const imgEl = imgRef.current;
      if (!imgEl) return;
      const displayRect = imgEl.getBoundingClientRect();
      const scaleX = img.naturalWidth / displayRect.width;
      const scaleY = img.naturalHeight / displayRect.height;

      const sx = Math.round(cropRect.x * scaleX);
      const sy = Math.round(cropRect.y * scaleY);
      const sw = Math.round(cropRect.w * scaleX);
      const sh = Math.round(cropRect.h * scaleY);

      if (sw <= 0 || sh <= 0) return;

      // Crop via canvas
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

      // Determine output format
      const ext = file.name.split(".").pop()?.toLowerCase();
      const mimeMap: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        bmp: "image/bmp",
      };
      const mime = mimeMap[ext ?? ""] || "image/png";
      const quality = ext === "jpg" || ext === "jpeg" ? 0.92 : undefined;

      const dataUrl = canvas.toDataURL(mime, quality);

      // Convert to binary and write
      const base64 = dataUrl.split(",")[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      await writeFile(file.absolutePath, bytes);

      // Update store
      useDocumentStore.getState().updateImageDataUrl(file.id, dataUrl);

      onCropModeChange?.(false);
      toast.success("Image cropped and saved");
    } catch (err) {
      toast.error("Failed to crop image");
      console.error("Crop error:", err);
    } finally {
      setIsSaving(false);
    }
  }, [cropRect, file, isSaving, onCropModeChange]);

  // Use dataUrl if available (in-memory), otherwise fall back to asset URL (large images)
  const imageSrc = file.dataUrl || getAssetUrl(file.absolutePath);
  // Crop requires dataUrl (canvas manipulation needs same-origin data)
  const _canCrop = !!file.dataUrl;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="relative h-full overflow-auto bg-muted/50 p-4 outline-none"
      style={
        cropMode
          ? { cursor: cropRect && !dragStart ? "default" : "crosshair" }
          : undefined
      }
      onMouseMove={cropMode ? handleCropMouseMove : undefined}
      onMouseUp={cropMode ? handleCropMouseUp : undefined}
      onMouseLeave={cropMode ? handleCropMouseUp : undefined}
    >
      {/* Crop mode banner */}
      {cropMode && !cropRect && (
        <div className="absolute top-2 left-1/2 z-20 -translate-x-1/2 rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-xs shadow-lg">
          Drag to select crop area. Press ESC to cancel.
        </div>
      )}

      {/* Wrapper width = scale * 100% of container → CSS handles fit, no JS needed */}
      <div
        className="relative"
        style={{ width: `${scale * 100}%`, margin: "0 auto" }}
      >
        <img
          ref={imgRef}
          src={imageSrc}
          alt={file.name}
          style={{ width: "100%", height: "auto" }}
          draggable={false}
          onMouseDown={cropMode ? handleCropMouseDown : undefined}
        />

        {/* Crop overlay */}
        {cropMode && cropRect && (
          <>
            {/* Dark overlay: 4 divs around the crop area */}
            {/* Top */}
            <div
              className="pointer-events-none absolute z-10 bg-black/50"
              style={{ left: 0, top: 0, right: 0, height: cropRect.y }}
            />
            {/* Bottom */}
            <div
              className="pointer-events-none absolute z-10 bg-black/50"
              style={{
                left: 0,
                top: cropRect.y + cropRect.h,
                right: 0,
                bottom: 0,
              }}
            />
            {/* Left */}
            <div
              className="pointer-events-none absolute z-10 bg-black/50"
              style={{
                left: 0,
                top: cropRect.y,
                width: cropRect.x,
                height: cropRect.h,
              }}
            />
            {/* Right */}
            <div
              className="pointer-events-none absolute z-10 bg-black/50"
              style={{
                left: cropRect.x + cropRect.w,
                top: cropRect.y,
                right: 0,
                height: cropRect.h,
              }}
            />

            {/* Crop border */}
            <div
              className="absolute z-10 border-2 border-white/90"
              style={{
                left: cropRect.x,
                top: cropRect.y,
                width: cropRect.w,
                height: cropRect.h,
                cursor: "move",
              }}
              onMouseDown={(e) => {
                // Click inside → move
                e.preventDefault();
                e.stopPropagation();
                const coords = getImageRelativeCoords(e);
                if (!coords) return;
                setActiveHandle("move");
                setHandleDragStart({
                  x: coords.x,
                  y: coords.y,
                  rect: { ...cropRect },
                });
              }}
            >
              {/* Resize handles */}
              {HANDLES.map((h) => (
                <div
                  key={h.id}
                  className="absolute z-20 size-2.5 rounded-sm border border-gray-400 bg-white shadow-sm"
                  style={{
                    left:
                      h.x === 0
                        ? -5
                        : h.x === 0.5
                          ? "calc(50% - 5px)"
                          : "calc(100% - 5px)",
                    top:
                      h.y === 0
                        ? -5
                        : h.y === 0.5
                          ? "calc(50% - 5px)"
                          : "calc(100% - 5px)",
                    cursor: h.cursor,
                  }}
                  onMouseDown={(e) => handleHandleMouseDown(e, h.id)}
                />
              ))}
            </div>

            {/* Action bar */}
            {!dragStart && !activeHandle && (
              <div
                className="absolute z-20 flex items-center gap-1 rounded-md border border-border bg-background p-1 shadow-lg"
                style={{
                  left: cropRect.x + cropRect.w / 2,
                  top: cropRect.y + cropRect.h + 8,
                  transform: "translateX(-50%)",
                }}
              >
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 gap-1 px-2.5 text-xs"
                  onClick={handleApplyCrop}
                  disabled={isSaving}
                >
                  <CheckIcon className="size-3.5" />
                  {isSaving ? "Saving..." : "Apply"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2.5 text-xs"
                  onClick={() => onCropModeChange?.(false)}
                  disabled={isSaving}
                >
                  <XIcon className="size-3.5" />
                  Cancel
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
