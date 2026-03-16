import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FlaskConicalIcon,
  DownloadIcon,
  CheckCircle2Icon,
  AlertCircleIcon,
  RefreshCwIcon,
  ExternalLinkIcon,
  Trash2Icon,
  Loader2Icon,
  ChevronLeftIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  type SkillCategoryData,
  type SkillEntryData,
  ICON_MAP,
} from "./skill-category-card";
import { InstallProgress } from "./install-progress";

const STORAGE_KEY = "scientific-skills-installed";

interface InstallResult {
  success: boolean;
  skills_installed: number;
  target_dir: string;
  message: string;
}

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
  location: string;
}

interface ScientificSkillsOnboardingProps {
  onClose: () => void;
}

export function ScientificSkillsOnboarding({
  onClose,
}: ScientificSkillsOnboardingProps) {
  const [categories, setCategories] = useState<SkillCategoryData[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [installResult, setInstallResult] = useState<InstallResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SkillsStatus | null>(null);
  const [isUninstalling, setIsUninstalling] = useState(false);

  // Check global install status
  const checkStatus = useCallback(async () => {
    try {
      const gs = await invoke<SkillsStatus>("check_skills_installed", {
        projectPath: null,
      });
      setStatus(gs);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    invoke<SkillCategoryData[]>("get_skill_categories")
      .then((cats) => {
        setCategories(cats);
        if (cats.length > 0) setSelectedId(cats[0].id);
      })
      .catch(console.error);
  }, []);

  const totalSkills = categories.reduce((sum, c) => sum + c.skill_count, 0);
  const selected = categories.find((c) => c.id === selectedId) ?? null;
  const isInstalled = status?.installed ?? false;

  const handleInstall = useCallback(async () => {
    setIsInstalling(true);
    setError(null);

    try {
      const result = await invoke<InstallResult>(
        "install_scientific_skills_global",
      );
      setInstallResult(result);
      setIsComplete(true);
      localStorage.setItem(STORAGE_KEY, "true");
      await checkStatus();
    } catch (e) {
      setError(String(e));
      setIsInstalling(false);
    }
  }, [checkStatus]);

  const handleUninstall = useCallback(async () => {
    setIsUninstalling(true);
    try {
      await invoke("uninstall_scientific_skills", { projectPath: null });
      await checkStatus();
      const gsAfter = await invoke<SkillsStatus>("check_skills_installed", {
        projectPath: null,
      });
      if (!gsAfter.installed) {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      console.error("Failed to uninstall:", e);
    } finally {
      setIsUninstalling(false);
    }
  }, [checkStatus]);

  // ─── Installing / Complete state ───
  if (isInstalling || isComplete) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && (isComplete || error)) onClose();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              {isComplete ? (
                <CheckCircle2Icon className="size-5 text-foreground" />
              ) : (
                <FlaskConicalIcon className="size-5 text-muted-foreground" />
              )}
              {isComplete ? "Installation Complete" : "Installing Skills"}
            </DialogTitle>
            {isComplete && (
              <DialogDescription>
                {installResult?.skills_installed ?? 0} scientific skills are now
                available.
              </DialogDescription>
            )}
          </DialogHeader>

          <InstallProgress
            isInstalling={isInstalling}
            isComplete={isComplete}
            error={error}
          />

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="text-muted-foreground text-xs leading-relaxed">
                {error}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            {error && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError(null);
                  setIsInstalling(false);
                }}
                className="gap-1.5"
              >
                <RefreshCwIcon className="size-3.5" />
                Retry
              </Button>
            )}
            {(isComplete || error) && (
              <Button size="sm" onClick={onClose}>
                {isComplete ? "Done" : "Close"}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ─── Browse state — two-column layout ───
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(36rem,calc(100vh-6rem))] w-[min(56rem,calc(100vw-4rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        {/* Header */}
        <DialogHeader className="shrink-0 border-border border-b px-6 py-3">
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-sm">Scientific Skills</DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">
                {totalSkills} AI skills across {categories.length} domains —
                powered by{" "}
                <a
                  href="https://github.com/K-Dense-AI/claude-scientific-skills"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 underline decoration-border underline-offset-2 hover:text-foreground"
                >
                  K-Dense
                  <ExternalLinkIcon className="size-2.5" />
                </a>
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {isInstalled ? (
                <>
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <CheckCircle2Icon className="size-3" />
                    {status?.skill_count} installed
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleInstall}
                    className="gap-1.5"
                  >
                    <RefreshCwIcon className="size-3.5" />
                    Update
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleUninstall}
                    disabled={isUninstalling}
                    className="gap-1.5 text-destructive hover:text-destructive"
                  >
                    {isUninstalling ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                    Uninstall
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={handleInstall} className="gap-1.5">
                  <DownloadIcon className="size-3.5" />
                  Install All
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Body — sidebar + detail */}
        <div className="flex flex-1 overflow-hidden">
          {/* Category sidebar */}
          <nav className="w-64 shrink-0 overflow-hidden border-border border-r">
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-0.5 p-2">
                {categories.map((cat) => {
                  const Icon = ICON_MAP[cat.icon] || FlaskConicalIcon;
                  const isActive = selectedId === cat.id;
                  return (
                    <button
                      key={cat.id}
                      onClick={() => setSelectedId(cat.id)}
                      className={cn(
                        "flex items-center gap-2.5 overflow-hidden rounded-lg px-3 py-2 text-left text-sm transition-colors",
                        isActive
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {cat.name}
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {cat.skill_count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </nav>

          {/* Detail panel */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {selected ? (
              <ScrollArea className="flex-1">
                <div className="p-6">
                  <CategoryDetail
                    category={selected}
                    isInstalled={isInstalled}
                  />
                </div>
              </ScrollArea>
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                Select a category
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-border border-t bg-muted/20 px-6 py-2.5">
          <p className="font-mono text-[11px] text-muted-foreground/60">
            {isInstalled ? status?.location : "~/.claude/skills/"}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="text-muted-foreground"
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Category Detail Panel ───

function CategoryDetail({
  category,
  isInstalled,
}: {
  category: SkillCategoryData;
  isInstalled: boolean;
}) {
  const Icon = ICON_MAP[category.icon] || FlaskConicalIcon;
  const [selectedSkill, setSelectedSkill] = useState<SkillEntryData | null>(
    null,
  );
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Reset when category changes
  useEffect(() => {
    setSelectedSkill(null);
    setSkillContent(null);
    setFetchError(null);
  }, [category.id]);

  const handleSkillClick = useCallback(
    async (skill: SkillEntryData) => {
      if (selectedSkill?.folder === skill.folder) {
        setSelectedSkill(null);
        setSkillContent(null);
        setFetchError(null);
        return;
      }
      setSelectedSkill(skill);
      setSkillContent(null);
      setFetchError(null);
      setLoadingContent(true);
      try {
        const content = await invoke<string>("get_skill_content", {
          skillFolder: skill.folder,
          projectPath: null,
        });
        setSkillContent(content);
      } catch (e) {
        setFetchError(String(e));
      } finally {
        setLoadingContent(false);
      }
    },
    [selectedSkill],
  );

  // Viewing a specific skill
  if (selectedSkill) {
    return (
      <div>
        <button
          onClick={() => {
            setSelectedSkill(null);
            setSkillContent(null);
            setFetchError(null);
          }}
          className="mb-3 flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
        >
          <ChevronLeftIcon className="size-3.5" />
          {category.name}
        </button>

        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
            <Icon className="size-5 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-sm">{selectedSkill.name}</h3>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/60">
              {selectedSkill.folder}
            </p>
          </div>
        </div>

        <Separator className="my-4" />

        {loadingContent ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading skill content…
          </div>
        ) : fetchError ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-muted-foreground text-xs leading-relaxed">
              {fetchError}
            </p>
          </div>
        ) : skillContent ? (
          <div className="whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/30 p-4 font-mono text-foreground/80 text-xs leading-relaxed">
            {skillContent}
          </div>
        ) : null}
      </div>
    );
  }

  // Skill list view
  return (
    <div>
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className="size-5 text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-sm">{category.name}</h3>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {category.skill_count} skills
            </Badge>
            {isInstalled && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <CheckCircle2Icon className="size-3" />
                Installed
              </Badge>
            )}
          </div>
        </div>
      </div>

      <Separator className="my-4" />

      <div>
        <h4 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Skills
        </h4>
        <div className="grid grid-cols-2 gap-1.5">
          {category.skills.map((skill) => (
            <button
              key={skill.folder}
              onClick={() => handleSkillClick(skill)}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/30 px-3 py-2 text-left text-sm transition-colors hover:border-border hover:bg-accent/30"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-foreground/40" />
              {skill.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Helper ───

export function shouldShowOnboarding(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== "true";
}

export function resetOnboardingFlag(): void {
  localStorage.removeItem(STORAGE_KEY);
}
