import { useRef, useState, useCallback, useEffect } from "react";
import {
  ChevronDownIcon,
  MessageCircleIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useClaudeEvents } from "@/hooks/use-claude-events";
import { ChatMessages } from "./chat-messages";
import { ChatComposer } from "./chat-composer";
import { SessionSelector } from "./session-selector";

const MIN_HEIGHT = 150;
const DEFAULT_HEIGHT = 360;

export function ClaudeChatDrawer() {
  // Initialize event listeners for Claude streaming
  useClaudeEvents();

  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const error = useClaudeChatStore((s) => s.error);

  const [isOpen, setIsOpen] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hasDraggedRef = useRef(false);
  const heightRef = useRef(height);
  heightRef.current = height;

  const pendingAttachments = useClaudeChatStore((s) => s.pendingAttachments);

  // Auto-open when streaming starts or a new attachment is added
  useEffect(() => {
    const shouldOpen = isStreaming || pendingAttachments.length > 0;
    if (shouldOpen && !isOpen) {
      setIsOpen(true);
      const parent = containerRef.current?.parentElement;
      const maxHeight = parent ? parent.clientHeight * 0.5 : 400;
      setHeight(maxHeight);
      heightRef.current = maxHeight;
      if (panelRef.current) {
        panelRef.current.style.height = `${maxHeight}px`;
      }
    }
  }, [isStreaming, isOpen, pendingAttachments]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    hasDraggedRef.current = false;

    const startY = e.clientY;
    const startHeight = heightRef.current;

    const handleMouseMove = (e: MouseEvent) => {
      hasDraggedRef.current = true;
      const parent = containerRef.current?.parentElement;
      const maxHeight = parent ? parent.clientHeight * 0.5 : 400;
      const delta = startY - e.clientY;
      const newHeight = Math.min(
        Math.max(startHeight + delta, MIN_HEIGHT),
        maxHeight
      );
      heightRef.current = newHeight;
      if (panelRef.current) {
        panelRef.current.style.height = `${newHeight}px`;
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setHeight(heightRef.current);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-4 pb-6"
    >
      {/* Floating toggle button */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={cn(
          "pointer-events-auto absolute right-4 bottom-6 flex size-12 items-center justify-center rounded-full border border-border bg-background shadow-lg transition-all duration-300 ease-out hover:scale-105 hover:shadow-xl",
          isOpen
            ? "pointer-events-none scale-50 opacity-0"
            : "scale-100 opacity-100"
        )}
        aria-label="Open AI Assistant"
      >
        <MessageCircleIcon className="size-5 text-foreground" />
      </button>

      {/* Chat panel */}
      <div
        ref={panelRef}
        className={cn(
          "pointer-events-auto flex w-full max-w-2xl origin-bottom flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-2xl transition-all duration-300 ease-out",
          isOpen
            ? "scale-100 opacity-100"
            : "pointer-events-none scale-95 opacity-0",
          isDragging && "!transition-none"
        )}
        style={{ height: isOpen ? height : 0 }}
      >
        {/* Header with drag handle and session selector */}
        <div className="relative">
          <div
            className="group flex cursor-row-resize items-center justify-center gap-2 py-2 transition-colors hover:bg-muted/50"
            onMouseDown={handleMouseDown}
            onClick={() => {
              if (!hasDraggedRef.current) {
                setIsOpen(false);
              }
            }}
          >
            <div className="h-1 w-10 rounded-full bg-muted-foreground/30 transition-all group-hover:w-8" />
            <ChevronDownIcon className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <div className="absolute top-1/2 right-2 -translate-y-1/2">
            <SessionSelector />
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-3 mb-1 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-destructive text-xs">
            {error}
          </div>
        )}

        {/* Messages area */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ChatMessages />
        </div>

        {/* Composer */}
        <ChatComposer />
      </div>
    </div>
  );
}
