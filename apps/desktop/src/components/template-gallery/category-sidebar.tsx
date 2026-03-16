import {
  FileTextIcon,
  GraduationCapIcon,
  BriefcaseIcon,
  PaletteIcon,
  SparklesIcon,
  MonitorIcon,
  LayoutIcon,
  UserIcon,
  MailIcon,
  ClipboardListIcon,
  BookIcon,
  NewspaperIcon,
  FileIcon,
} from "lucide-react";
import {
  type TemplateCategory,
  type TemplateSubcategory,
  CATEGORY_LABELS,
  getCategories,
  getAllTemplates,
  getTemplatesByCategory,
} from "@/lib/template-registry";
import { useTemplateStore } from "@/stores/template-store";

const CATEGORY_ICONS: Record<TemplateCategory, React.ReactNode> = {
  academic: <GraduationCapIcon className="size-4" />,
  professional: <BriefcaseIcon className="size-4" />,
  creative: <PaletteIcon className="size-4" />,
  starter: <SparklesIcon className="size-4" />,
};

const _SUBCATEGORY_ICONS: Record<TemplateSubcategory, React.ReactNode> = {
  papers: <FileTextIcon className="size-3.5" />,
  theses: <GraduationCapIcon className="size-3.5" />,
  presentations: <MonitorIcon className="size-3.5" />,
  posters: <LayoutIcon className="size-3.5" />,
  cv: <UserIcon className="size-3.5" />,
  letters: <MailIcon className="size-3.5" />,
  reports: <ClipboardListIcon className="size-3.5" />,
  books: <BookIcon className="size-3.5" />,
  newsletters: <NewspaperIcon className="size-3.5" />,
  blank: <FileIcon className="size-3.5" />,
};

export function CategorySidebar() {
  const selectedCategory = useTemplateStore((s) => s.selectedCategory);
  const setSelectedCategory = useTemplateStore((s) => s.setSelectedCategory);
  const allCount = getAllTemplates().length;

  return (
    <nav className="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto py-2 pr-3">
      {/* All templates */}
      <button
        onClick={() => setSelectedCategory(null)}
        className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
          selectedCategory === null
            ? "bg-accent font-medium text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        }`}
      >
        <SparklesIcon className="size-4" />
        <span className="flex-1">All Templates</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {allCount}
        </span>
      </button>

      <div className="my-1.5 h-px bg-border" />

      {/* Categories */}
      {getCategories().map((cat) => {
        const count = getTemplatesByCategory(cat).length;
        const isActive = selectedCategory === cat;
        return (
          <button
            key={cat}
            onClick={() => setSelectedCategory(isActive ? null : cat)}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              isActive
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            {CATEGORY_ICONS[cat]}
            <span className="flex-1">{CATEGORY_LABELS[cat]}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {count}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
