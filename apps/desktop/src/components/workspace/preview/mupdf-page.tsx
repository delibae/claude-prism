import { useEffect, useRef, useState, memo } from "react";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { StructuredTextData, LinkData } from "@/lib/mupdf/types";

interface MupdfPageProps {
  docId: number;
  pageIndex: number;
  scale: number;
  pageWidth: number;
  pageHeight: number;
  isVisible: boolean;
}

export const MupdfPage = memo(function MupdfPage({
  docId,
  pageIndex,
  scale,
  pageWidth,
  pageHeight,
  isVisible,
}: MupdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [textData, setTextData] = useState<StructuredTextData | null>(null);
  const [links, setLinks] = useState<LinkData[]>([]);
  const renderGenRef = useRef(0);

  const cssW = pageWidth * scale;
  const cssH = pageHeight * scale;

  useEffect(() => {
    if (!isVisible || docId <= 0) return;

    const gen = ++renderGenRef.current;
    const client = getMupdfClient();
    const dpr = window.devicePixelRatio || 1;
    const dpi = scale * 72 * dpr;

    client.drawPage(docId, pageIndex, dpi).then(async (imageData) => {
      if (gen !== renderGenRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      // Use createImageBitmap to avoid blocking the main thread with putImageData
      const bitmap = await createImageBitmap(imageData);
      if (gen !== renderGenRef.current) { bitmap.close(); return; }
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    }).catch((err) => {
      if (gen !== renderGenRef.current) return;
      console.error(`[mupdf-page] render error page ${pageIndex}:`, err);
    });

    client.getPageText(docId, pageIndex).then((data) => {
      if (gen !== renderGenRef.current) return;
      setTextData(data);
    }).catch(() => {});

    client.getPageLinks(docId, pageIndex).then((data) => {
      if (gen !== renderGenRef.current) return;
      setLinks(data);
    }).catch(() => {});
  }, [docId, pageIndex, scale, isVisible]);

  return (
    <div
      className="mupdf-page relative mb-4 shadow-lg"
      data-page-number={pageIndex + 1}
      style={{ width: cssW, height: cssH }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: cssW, height: cssH, display: "block" }}
      />

      {/* Text layer for selection */}
      {textData && (
        <svg
          className="mupdf-text-layer"
          viewBox={`0 0 ${pageWidth} ${pageHeight}`}
          preserveAspectRatio="none"
          style={{ width: cssW, height: cssH }}
        >
          {textData.blocks.map((block, bi) =>
            block.type === "text" &&
            block.lines.map((line, li) => (
              <text
                key={`${bi}-${li}`}
                x={line.bbox.x}
                y={line.y}
                fontSize={line.font.size}
                fontFamily={line.font.family || line.font.name || "serif"}
                textLength={line.bbox.w > 0 ? line.bbox.w : undefined}
                lengthAdjust="spacingAndGlyphs"
              >
                {line.text}
              </text>
            )),
          )}
        </svg>
      )}

      {/* Link layer */}
      {links.length > 0 && (
        <div className="mupdf-link-layer">
          {links.map((link, i) => (
            <a
              key={i}
              href={link.href}
              data-external={link.isExternal ? "true" : undefined}
              style={{
                left: (link.x / pageWidth) * 100 + "%",
                top: (link.y / pageHeight) * 100 + "%",
                width: (link.w / pageWidth) * 100 + "%",
                height: (link.h / pageHeight) * 100 + "%",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
});
