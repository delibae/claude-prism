import { useCallback, useRef, useEffect, useState } from "react";
import { LoaderIcon } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { ask } from "@tauri-apps/plugin-dialog";
import { getOrOpenDocument } from "@/lib/mupdf/pdf-doc-cache";
import { MupdfPage } from "./mupdf-page";
import type { PageSize } from "@/lib/mupdf/types";

/** Module-level scroll position cache: rootFileId → page number */
const scrollPositionCache = new Map<string, number>();

/** Clear all cached scroll positions (e.g., on project close). */
export function clearScrollPositionCache(): void {
  scrollPositionCache.clear();
}

export interface PdfTextSelection {
  text: string;
  pageNumber: number;
  position: { top: number; left: number };
  pdfX: number;
  pdfY: number;
}

export interface CaptureResult {
  dataUrl: string;
  pageNumber: number;
  pdfX: number;
  pdfY: number;
}

interface PdfViewerProps {
  data: Uint8Array;
  scale: number;
  /** Root file ID for scroll position caching across file switches. */
  rootFileId?: string;
  onError?: (error: string) => void;
  onLoadSuccess?: (numPages: number) => void;
  onScaleChange?: (scale: number) => void;
  onTextClick?: (text: string) => void;
  onSynctexClick?: (page: number, x: number, y: number) => void;
  onTextSelect?: (selection: PdfTextSelection | null) => void;
  onFirstPageSize?: (width: number, height: number) => void;
  onContainerResize?: (width: number, height: number) => void;
  captureMode?: boolean;
  onCapture?: (result: CaptureResult) => void;
  onCancelCapture?: () => void;
}

export function PdfViewer({
  data,
  scale,
  rootFileId,
  onError,
  onLoadSuccess,
  onScaleChange,
  onTextClick,
  onSynctexClick,
  onTextSelect,
  onFirstPageSize,
  onContainerResize,
  captureMode = false,
  onCapture,
  onCancelCapture,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const docIdRef = useRef(0);
  const loadGenRef = useRef(0);

  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const synctexClickRef = useRef(onSynctexClick);
  synctexClickRef.current = onSynctexClick;
  const textSelectRef = useRef(onTextSelect);
  textSelectRef.current = onTextSelect;

  // Scroll preservation across recompile
  const isFirstLoad = useRef(true);
  const savedPageRef = useRef<number>(0);

  // Capture drag state
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);
  const [dragPageNum, setDragPageNum] = useState(0);

  const numPages = pageSizes.length;

  function getVisiblePage(): number {
    const container = containerRef.current;
    if (!container) return 1;
    const pages = container.querySelectorAll(".mupdf-page");
    if (pages.length === 0) return 1;
    const containerRect = container.getBoundingClientRect();
    for (const page of pages) {
      const el = page as HTMLElement;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > containerRect.top + 50) {
        return parseInt(el.getAttribute("data-page-number") || "1", 10);
      }
    }
    return 1;
  }

  const prevRootFileIdRef = useRef<string | undefined>(undefined);

  // Save scroll position when rootFileId is about to change
  useEffect(() => {
    return () => {
      if (prevRootFileIdRef.current && containerRef.current) {
        scrollPositionCache.set(prevRootFileIdRef.current, getVisiblePage());
      }
    };
  }, [rootFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load document with MuPDF (using LRU doc cache)
  useEffect(() => {
    const gen = ++loadGenRef.current;
    prevRootFileIdRef.current = rootFileId;

    const pdfData =
      data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);

    // Validate PDF header — must start with %PDF-
    if (pdfData.length < 5 || pdfData[0] !== 0x25 || pdfData[1] !== 0x50 || pdfData[2] !== 0x44 || pdfData[3] !== 0x46) {
      console.error("[pdf-viewer] invalid PDF data: missing %PDF- header, length=", pdfData.length, "first bytes:", Array.from(pdfData.slice(0, 16)));
      setLoading(false);
      onError?.("Invalid PDF data received. Try recompiling the document.");
      return;
    }

    // Save scroll position before reloading (for recompile of same file)
    if (containerRef.current && !isFirstLoad.current) {
      savedPageRef.current = getVisiblePage();
      if (contentRef.current) {
        contentRef.current.style.minHeight = `${contentRef.current.scrollHeight}px`;
      }
    }

    setLoading(isFirstLoad.current);

    (async () => {
      try {
        const { docId, pageSizes: sizes, cacheHit } = await getOrOpenDocument(pdfData);
        if (gen !== loadGenRef.current) return;

        docIdRef.current = docId;
        setPageSizes(sizes);
        setLoading(false);

        if (isFirstLoad.current && sizes.length > 0) {
          onFirstPageSize?.(sizes[0].width, sizes[0].height);
        }
        isFirstLoad.current = false;
        onLoadSuccess?.(sizes.length);

        // Determine which page to scroll to:
        // 1. Recompile of same file → savedPageRef (scroll preservation)
        // 2. File switch with cached scroll → scrollPositionCache
        // 3. Otherwise → no scroll change
        let targetPage = savedPageRef.current;
        if (targetPage <= 0 && cacheHit && rootFileId) {
          targetPage = scrollPositionCache.get(rootFileId) ?? 0;
        }

        if (targetPage > 0) {
          savedPageRef.current = 0;
          const scrollToPage = (attempts: number) => {
            const container = containerRef.current;
            if (!container || attempts <= 0) {
              if (contentRef.current) contentRef.current.style.minHeight = "";
              return;
            }
            const pageEl = container.querySelector(
              `[data-page-number="${targetPage}"]`,
            ) as HTMLElement | null;
            if (pageEl && pageEl.clientHeight > 0) {
              const containerRect = container.getBoundingClientRect();
              const pageRect = pageEl.getBoundingClientRect();
              container.scrollTop += pageRect.top - containerRect.top - 16;
              if (contentRef.current) contentRef.current.style.minHeight = "";
            } else {
              requestAnimationFrame(() => scrollToPage(attempts - 1));
            }
          };
          requestAnimationFrame(() => scrollToPage(30));
        }
      } catch (err) {
        if (gen !== loadGenRef.current) return;
        setLoading(false);
        onError?.(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      // Cleanup handled by next load cycle; docs are managed by the cache
    };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // IntersectionObserver for lazy page rendering
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const el = entry.target as HTMLElement;
            const pageNum = parseInt(el.getAttribute("data-page-number") || "0", 10);
            if (pageNum === 0) continue;
            if (entry.isIntersecting) {
              next.add(pageNum);
            } else {
              next.delete(pageNum);
            }
          }
          return next;
        });
      },
      {
        root: container,
        rootMargin: "200% 0px",
      },
    );

    const pages = container.querySelectorAll(".mupdf-page");
    pages.forEach((p) => observer.observe(p));

    return () => observer.disconnect();
  }, [pageSizes, scale]);

  // Report container dimensions to parent for fit-to-width/height
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onContainerResize) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      onContainerResize(width, height);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [onContainerResize]);

  // Native dblclick listener for synctex
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleDblClick = (e: MouseEvent) => {
      if (captureMode) return;
      const cb = synctexClickRef.current;
      if (!cb) return;

      const target = e.target as HTMLElement;
      const pageEl = target.closest(".mupdf-page") as HTMLElement | null;
      if (!pageEl) return;

      const pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0", 10);
      if (pageNum === 0) return;

      const rect = pageEl.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      const currentScale = scaleRef.current;
      const pdfX = offsetX / currentScale;
      const pdfY = offsetY / currentScale;

      cb(pageNum, pdfX, pdfY);
    };

    container.addEventListener("dblclick", handleDblClick);
    return () => container.removeEventListener("dblclick", handleDblClick);
  }, [captureMode]);

  // Text selection detection via mouseup
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let selectionTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelPendingSelection = () => {
      if (selectionTimer !== null) {
        clearTimeout(selectionTimer);
        selectionTimer = null;
      }
    };

    const handleMouseDown = () => {
      cancelPendingSelection();
    };

    const handleMouseUp = () => {
      if (captureMode) return;
      const cb = textSelectRef.current;
      if (!cb) return;

      cancelPendingSelection();

      selectionTimer = setTimeout(() => {
        selectionTimer = null;

        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || text.length < 2) {
          cb(null);
          return;
        }

        const anchorEl = sel?.anchorNode?.parentElement;
        if (!anchorEl?.closest(".mupdf-text-layer")) {
          cb(null);
          return;
        }

        const pageEl = anchorEl.closest(".mupdf-page") as HTMLElement | null;
        const pageNum = pageEl
          ? parseInt(pageEl.getAttribute("data-page-number") || "1", 10)
          : 1;

        const range = sel!.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        let pdfX = 0;
        let pdfY = 0;
        if (pageEl) {
          const pageRect = pageEl.getBoundingClientRect();
          const currentScale = scaleRef.current;
          pdfX = (rect.left - pageRect.left) / currentScale;
          pdfY = (rect.top - pageRect.top) / currentScale;
        }

        cb({
          text,
          pageNumber: pageNum,
          position: { top: rect.bottom, left: rect.left },
          pdfX,
          pdfY,
        });
      }, 300);
    };

    container.addEventListener("mousedown", handleMouseDown);
    container.addEventListener("mouseup", handleMouseUp);
    return () => {
      cancelPendingSelection();
      container.removeEventListener("mousedown", handleMouseDown);
      container.removeEventListener("mouseup", handleMouseUp);
    };
  }, [captureMode]);

  // Dismiss selection toolbar on scroll
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const cb = textSelectRef.current;
      if (cb) cb(null);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Pinch-to-zoom
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onScaleChange) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY * 0.005;
        onScaleChange(Math.max(0.25, Math.min(4, scale + delta)));
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [scale, onScaleChange]);

  // Keyboard zoom (Cmd/Ctrl +/-) — scoped to container to avoid affecting other panels
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onScaleChange) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        onScaleChange(Math.min(4, scale + 0.25));
      } else if (e.key === "-") {
        e.preventDefault();
        onScaleChange(Math.max(0.25, scale - 0.25));
      } else if (e.key === "0") {
        e.preventDefault();
        onScaleChange(1);
      }
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [scale, onScaleChange]);

  // Intercept link clicks
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (!anchor.closest(".mupdf-link-layer")) return;

      e.preventDefault();
      e.stopPropagation();

      const href = anchor.getAttribute("href");
      if (!href) return;

      if (href.includes("#page=")) {
        const match = href.match(/#page=(\d+)/);
        if (match) {
          const pageNum = parseInt(match[1], 10);
          const pageEl = container.querySelector(
            `[data-page-number="${pageNum}"]`,
          ) as HTMLElement | null;
          if (pageEl) {
            pageEl.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }
        return;
      }

      if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
        ask(`Open in browser?\n${href}`, {
          title: "External Link",
          kind: "info",
          okLabel: "Open",
          cancelLabel: "Cancel",
        }).then((confirmed) => {
          if (confirmed) shellOpen(href);
        });
      }
    };

    container.addEventListener("click", handleClick, true);
    return () => container.removeEventListener("click", handleClick, true);
  }, []);

  // ESC during capture: cancel drag or cancel capture mode
  useEffect(() => {
    if (!captureMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dragStart) {
          setDragStart(null);
          setDragEnd(null);
        } else {
          onCancelCapture?.();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [captureMode, dragStart, onCancelCapture]);

  // Capture mode: drag to select region
  const handleCaptureMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!captureMode) return;
      const target = e.target as HTMLElement;
      const pageEl = target.closest(".mupdf-page") as HTMLElement | null;
      if (!pageEl) return;
      const pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0");
      if (!pageNum) return;
      setDragPageNum(pageNum);
      setDragStart({ x: e.clientX, y: e.clientY });
      setDragEnd(null);
    },
    [captureMode],
  );

  const handleCaptureMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!captureMode || !dragStart) return;
      setDragEnd({ x: e.clientX, y: e.clientY });
    },
    [captureMode, dragStart],
  );

  const handleCaptureMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!captureMode || !dragStart) {
        setDragStart(null);
        setDragEnd(null);
        return;
      }
      const end = { x: e.clientX, y: e.clientY };
      const w = Math.abs(end.x - dragStart.x);
      const h = Math.abs(end.y - dragStart.y);

      if (w < 10 || h < 10 || !onCapture) {
        setDragStart(null);
        setDragEnd(null);
        return;
      }

      const pageEl = containerRef.current?.querySelector(
        `.mupdf-page[data-page-number="${dragPageNum}"]`,
      ) as HTMLElement | null;
      const sourceCanvas = pageEl?.querySelector("canvas") as HTMLCanvasElement | null;
      if (!pageEl || !sourceCanvas) {
        setDragStart(null);
        setDragEnd(null);
        return;
      }

      const pageRect = pageEl.getBoundingClientRect();
      const selLeft = Math.max(0, Math.min(dragStart.x, end.x) - pageRect.left);
      const selTop = Math.max(0, Math.min(dragStart.y, end.y) - pageRect.top);
      const selW = Math.min(pageRect.width - selLeft, w);
      const selH = Math.min(pageRect.height - selTop, h);

      const scaleX = sourceCanvas.width / pageRect.width;
      const scaleY = sourceCanvas.height / pageRect.height;
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = selW * scaleX;
      cropCanvas.height = selH * scaleY;
      const ctx = cropCanvas.getContext("2d")!;
      ctx.drawImage(
        sourceCanvas,
        selLeft * scaleX,
        selTop * scaleY,
        selW * scaleX,
        selH * scaleY,
        0,
        0,
        cropCanvas.width,
        cropCanvas.height,
      );

      const currentScale = scaleRef.current;
      const pdfX = selLeft / currentScale;
      const pdfY = selTop / currentScale;

      onCapture({
        dataUrl: cropCanvas.toDataURL("image/png"),
        pageNumber: dragPageNum,
        pdfX,
        pdfY,
      });

      setDragStart(null);
      setDragEnd(null);
    },
    [captureMode, dragStart, dragPageNum, onCapture],
  );

  // Text layer click for onTextClick
  const handleTextLayerClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onTextClick) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "text" &&
        target.closest(".mupdf-text-layer")
      ) {
        const text = target.textContent?.trim();
        if (text && text.length > 2) {
          onTextClick(text);
        }
      }
    },
    [onTextClick],
  );

  const selRect =
    dragStart && dragEnd
      ? {
          left: Math.min(dragStart.x, dragEnd.x),
          top: Math.min(dragStart.y, dragEnd.y),
          width: Math.abs(dragEnd.x - dragStart.x),
          height: Math.abs(dragEnd.y - dragStart.y),
        }
      : null;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-auto outline-none"
      style={{ cursor: captureMode ? "crosshair" : undefined }}
      onMouseDown={handleCaptureMouseDown}
      onMouseMove={handleCaptureMouseMove}
      onMouseUp={handleCaptureMouseUp}
    >
      <div
        ref={contentRef}
        className="flex min-w-fit flex-col items-center gap-4 p-4"
        onClick={handleTextLayerClick}
      >
        {loading && numPages === 0 && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" />
            Loading PDF...
          </div>
        )}
        {pageSizes.map((size, i) => (
          <MupdfPage
            key={i}
            docId={docIdRef.current}
            pageIndex={i}
            scale={scale}
            pageWidth={size.width}
            pageHeight={size.height}
            isVisible={visiblePages.has(i + 1)}
          />
        ))}
      </div>
      {selRect && (
        <div
          className="pointer-events-none fixed border-2 border-primary bg-primary/10"
          style={selRect}
        />
      )}
    </div>
  );
}
