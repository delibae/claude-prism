import { useEffect, useRef } from "react";
import { ImageIcon } from "lucide-react";
import type { ProjectFile } from "@/stores/document-store";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

interface ImagePreviewProps {
  file: ProjectFile;
  scale: number;
  onScaleChange?: (scale: number) => void;
}

// scale 1.0 = fit-to-width (CSS handles it, zero flicker).
// Zoom multiplies from the fitted size.

export function ImagePreview({ file, scale, onScaleChange }: ImagePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Pinch-to-zoom (Cmd/Ctrl + wheel)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onScaleChange) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY * 0.001;
        onScaleChange(Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale + delta)));
      }
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [scale, onScaleChange]);

  // Keyboard zoom (Cmd/Ctrl +/-) — scoped to container
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onScaleChange) return;

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
  }, [scale, onScaleChange]);

  if (!file.dataUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-muted/30 p-8">
        <ImageIcon className="mb-4 size-16 text-muted-foreground/50" />
        <p className="text-muted-foreground text-sm">No image data available</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} tabIndex={-1} className="h-full overflow-auto bg-muted/50 p-4 outline-none">
      {/* Wrapper width = scale * 100% of container → CSS handles fit, no JS needed */}
      <div style={{ width: `${scale * 100}%`, margin: "0 auto" }}>
        <img
          src={file.dataUrl}
          alt={file.name}
          style={{ width: "100%", height: "auto" }}
          draggable={false}
        />
      </div>
    </div>
  );
}
