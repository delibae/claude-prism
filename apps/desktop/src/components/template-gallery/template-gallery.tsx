import { useEffect, useRef } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useTemplateStore } from "@/stores/template-store";
import {
  CATEGORY_LABELS,
  type TemplateCategory,
} from "@/lib/template-registry";
import { TemplateCard } from "./template-card";
import { CategorySidebar } from "./category-sidebar";
import { TemplatePreview } from "./template-preview";

export function TemplateGallery() {
  const searchQuery = useTemplateStore((s) => s.searchQuery);
  const setSearchQuery = useTemplateStore((s) => s.setSearchQuery);
  const selectedCategory = useTemplateStore((s) => s.selectedCategory);
  const filteredTemplates = useTemplateStore((s) => s.filteredTemplates);
  const reset = useTemplateStore((s) => s.reset);

  const searchRef = useRef<HTMLInputElement>(null);

  // Reset store when gallery mounts
  useEffect(() => {
    reset();
  }, [reset]);

  // Focus search on Cmd/Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      // Escape clears search
      if (e.key === "Escape" && document.activeElement === searchRef.current) {
        setSearchQuery("");
        searchRef.current?.blur();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSearchQuery]);

  // Group templates by category when showing all
  const showGrouped = !selectedCategory && !searchQuery;

  const heading = selectedCategory
    ? CATEGORY_LABELS[selectedCategory]
    : searchQuery
      ? `Results for "${searchQuery}"`
      : "All Templates";

  return (
    <div className="flex h-full flex-col">
      {/* Search bar */}
      <div className="shrink-0 border-border border-b px-4 py-3">
        <div className="relative mx-auto max-w-xl">
          <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            placeholder="Search templates...  ⌘K"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pr-8 pl-9"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Main content: sidebar + grid */}
      <div className="flex flex-1 overflow-hidden">
        {/* Category sidebar */}
        <div className="shrink-0 border-border border-r pt-2 pl-3">
          <CategorySidebar />
        </div>

        {/* Template grid */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {filteredTemplates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <SearchIcon className="mb-3 size-8 text-muted-foreground/40" />
              <p className="font-medium text-muted-foreground text-sm">
                No templates found
              </p>
              <p className="mt-1 text-muted-foreground/70 text-xs">
                Try a different search term or category
              </p>
            </div>
          ) : showGrouped ? (
            <GroupedGrid />
          ) : (
            <>
              <h2 className="mb-4 font-medium text-muted-foreground text-sm">
                {heading}
              </h2>
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
                {filteredTemplates.map((t) => (
                  <TemplateCard key={t.id} template={t} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Preview modal — handles template selection + project creation */}
      <TemplatePreview />
    </div>
  );
}

// ─── Grouped Grid (shows categories as sections) ───

function GroupedGrid() {
  const filteredTemplates = useTemplateStore((s) => s.filteredTemplates);

  // Group by category preserving order
  const categories: TemplateCategory[] = [
    "academic",
    "professional",
    "creative",
    "starter",
  ];
  const groups = categories
    .map((cat) => ({
      category: cat,
      templates: filteredTemplates.filter((t) => t.category === cat),
    }))
    .filter((g) => g.templates.length > 0);

  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <div key={group.category}>
          <h2 className="mb-3 font-semibold text-sm">
            {CATEGORY_LABELS[group.category]}
          </h2>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {group.templates.map((t) => (
              <TemplateCard key={t.id} template={t} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
