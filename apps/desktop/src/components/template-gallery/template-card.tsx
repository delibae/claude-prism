import { useEffect, useSyncExternalStore } from "react";
import { LoaderIcon } from "lucide-react";
import type { TemplateDefinition } from "@/lib/template-registry";
import { useTemplateStore } from "@/stores/template-store";
import {
  getThumbnail,
  isThumbnailFailed,
  subscribeThumbnails,
  generateThumbnail,
} from "@/lib/template-preview-cache";

// ─── CSS Fallback Thumbnails ───
// Shown while real PDF previews are loading.

export function ThumbnailPaper({ color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center px-4 py-3">
      <div
        className="mb-1.5 h-1.5 w-12 rounded-full"
        style={{ backgroundColor: color }}
      />
      <div className="mb-3 h-1 w-8 rounded-full bg-muted-foreground/20" />
      <div className="mb-2 w-full rounded-sm bg-muted-foreground/8 p-1.5">
        <div className="mb-1 h-0.5 w-full rounded-full bg-muted-foreground/15" />
        <div className="mb-1 h-0.5 w-full rounded-full bg-muted-foreground/15" />
        <div className="h-0.5 w-3/4 rounded-full bg-muted-foreground/15" />
      </div>
      <div
        className="mb-1.5 h-1 w-10 self-start rounded-full"
        style={{ backgroundColor: color, opacity: 0.6 }}
      />
      <div className="mb-1 h-0.5 w-full rounded-full bg-muted-foreground/12" />
      <div className="mb-1 h-0.5 w-full rounded-full bg-muted-foreground/12" />
      <div className="mb-1 h-0.5 w-11/12 rounded-full bg-muted-foreground/12" />
      <div className="h-0.5 w-4/5 rounded-full bg-muted-foreground/12" />
    </div>
  );
}

export function ThumbnailSlides({ color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-3 py-2">
      <div className="flex w-full flex-1 flex-col items-center justify-center rounded-sm border border-muted-foreground/10 bg-muted-foreground/5 p-1">
        <div
          className="mb-0.5 h-1 w-10 rounded-full"
          style={{ backgroundColor: color }}
        />
        <div className="h-0.5 w-6 rounded-full bg-muted-foreground/20" />
      </div>
      <div className="flex w-full flex-1 flex-col rounded-sm border border-muted-foreground/10 bg-muted-foreground/5 p-1">
        <div
          className="mb-0.5 h-0.5 w-6 rounded-full"
          style={{ backgroundColor: color, opacity: 0.6 }}
        />
        <div className="mb-0.5 h-0.5 w-full rounded-full bg-muted-foreground/12" />
        <div className="h-0.5 w-3/4 rounded-full bg-muted-foreground/12" />
      </div>
    </div>
  );
}

export function ThumbnailPoster({ color: _color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col px-2 py-2">
      <div className="mb-2 h-1 w-10 self-center rounded-full bg-muted-foreground/20" />
      <div className="flex flex-1 gap-1.5">
        <div className="flex flex-1 flex-col gap-1 rounded-sm bg-muted-foreground/6 p-1">
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/15" />
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/15" />
          <div className="h-0.5 w-3/4 rounded-full bg-muted-foreground/15" />
        </div>
        <div className="flex flex-1 flex-col gap-1 rounded-sm bg-muted-foreground/6 p-1">
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/15" />
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/15" />
          <div className="h-0.5 w-2/3 rounded-full bg-muted-foreground/15" />
        </div>
      </div>
    </div>
  );
}

export function ThumbnailBlank(_props: { color: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="font-medium text-muted-foreground/20 text-xs">Empty</div>
    </div>
  );
}

export const THUMBNAIL_MAP: Record<string, React.FC<{ color: string }>> = {
  "paper-standard": ThumbnailPaper,
  "paper-ieee": ThumbnailPaper,
  "paper-acm": ThumbnailPaper,
  "thesis-standard": ThumbnailPaper,
  "presentation-beamer": ThumbnailSlides,
  "poster-academic": ThumbnailPoster,
  "cv-modern": ThumbnailPaper,
  "letter-formal": ThumbnailPaper,
  "report-technical": ThumbnailPaper,
  "book-standard": ThumbnailPaper,
  newsletter: ThumbnailPaper,
  blank: ThumbnailBlank,
};

export function getFallbackThumbnail(
  template: TemplateDefinition,
): React.FC<{ color: string }> {
  return THUMBNAIL_MAP[template.id] || ThumbnailPaper;
}

// ─── Template Card ───

interface TemplateCardProps {
  template: TemplateDefinition;
}

export function TemplateCard({ template }: TemplateCardProps) {
  const openPreview = useTemplateStore((s) => s.openPreview);
  const FallbackThumbnail = getFallbackThumbnail(template);

  const thumbnailUrl = useSyncExternalStore(subscribeThumbnails, () =>
    getThumbnail(template.id),
  );

  const failed = useSyncExternalStore(subscribeThumbnails, () =>
    isThumbnailFailed(template.id),
  );

  useEffect(() => {
    if (!thumbnailUrl && !failed) {
      generateThumbnail(template.id);
    }
  }, [template.id, thumbnailUrl, failed]);

  return (
    <div className="group flex flex-col">
      {/* Fixed-height thumbnail area — centers cards with different aspect ratios */}
      <div className="flex aspect-3/4 items-center justify-center">
        <button
          onClick={() => openPreview(template.id)}
          style={{ aspectRatio: template.aspectRatio }}
          className="relative max-h-full w-full overflow-hidden rounded-xl border border-border bg-card transition-all duration-200 hover:border-foreground/20 hover:shadow-md group-hover:scale-[1.02]"
        >
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={template.name}
              className="h-full w-full object-cover object-top"
            />
          ) : (
            <div className="relative h-full w-full">
              <FallbackThumbnail color={template.accentColor} />
              {!failed && (
                <div className="absolute inset-0 flex items-center justify-center bg-card/60">
                  <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          )}
        </button>
      </div>
      <div className="mt-2 px-0.5">
        <div className="font-medium text-sm leading-tight">{template.name}</div>
        <div className="mt-0.5 line-clamp-2 text-muted-foreground text-xs leading-snug">
          {template.description}
        </div>
      </div>
    </div>
  );
}
