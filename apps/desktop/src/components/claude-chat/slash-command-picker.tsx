import { type FC, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CommandIcon, FolderOpenIcon, GlobeIcon, TerminalIcon, FileCodeIcon, ZapIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SlashCommand {
  id: string;
  name: string;
  full_command: string;
  scope: string;
  namespace: string | null;
  file_path: string;
  content: string;
  description: string | null;
  allowed_tools: string[];
  has_bash_commands: boolean;
  has_file_references: boolean;
  accepts_arguments: boolean;
}

interface SlashCommandPickerProps {
  projectPath: string | null;
  query: string;
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

function getCommandIcon(command: SlashCommand) {
  if (command.has_bash_commands) return <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (command.has_file_references) return <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (command.accepts_arguments) return <ZapIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (command.scope === "project") return <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (command.scope === "user") return <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <CommandIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

export const SlashCommandPicker: FC<SlashCommandPickerProps> = ({
  projectPath,
  query,
  selectedIndex,
  onSelect,
  onClose,
}) => {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<SlashCommand[]>("slash_commands_list", {
      projectPath: projectPath ?? undefined,
    })
      .then(setCommands)
      .catch(() => setCommands([]));
  }, [projectPath]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return commands;

    const matched = commands.filter((cmd) => {
      if (cmd.name.toLowerCase().includes(q)) return true;
      if (cmd.full_command.toLowerCase().includes(q)) return true;
      if (cmd.namespace && cmd.namespace.toLowerCase().includes(q)) return true;
      if (cmd.description && cmd.description.toLowerCase().includes(q)) return true;
      return false;
    });

    matched.sort((a, b) => {
      const aExact = a.name.toLowerCase() === q;
      const bExact = b.name.toLowerCase() === q;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      const aStarts = a.name.toLowerCase().startsWith(q);
      const bStarts = b.name.toLowerCase().startsWith(q);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.name.localeCompare(b.name);
    });

    return matched;
  }, [query, commands]);

  // Scroll active item into view
  useEffect(() => {
    if (listRef.current) {
      const active = listRef.current.querySelector("[data-active=true]");
      active?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Expose filtered list length and items for parent keyboard handling
  // Parent controls selectedIndex, so we just need to render
  const clampedIndex = Math.min(selectedIndex, filtered.length - 1);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-3 right-3 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-background shadow-lg"
    >
      <div className="px-3 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground">Slash Commands</span>
      </div>
      {filtered.map((cmd, i) => (
        <button
          key={cmd.id}
          data-active={i === clampedIndex}
          className={cn(
            "flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors",
            i === clampedIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted",
          )}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd);
          }}
        >
          {getCommandIcon(cmd)}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm">{cmd.full_command}</span>
              {cmd.accepts_arguments && (
                <span className="text-xs text-muted-foreground">[args]</span>
              )}
              <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {cmd.scope}
              </span>
            </div>
            {cmd.description && (
              <p className="truncate text-xs text-muted-foreground">{cmd.description}</p>
            )}
          </div>
        </button>
      ))}
      <div className="border-t border-border px-3 py-1">
        <span className="text-xs text-muted-foreground">
          ↑↓ Navigate &middot; Enter Select &middot; Esc Close
        </span>
      </div>
    </div>
  );
};

// Helper to get filtered count for parent component
export function getFilteredSlashCommands(
  commands: SlashCommand[],
  query: string,
): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;

  return commands.filter((cmd) => {
    if (cmd.name.toLowerCase().includes(q)) return true;
    if (cmd.full_command.toLowerCase().includes(q)) return true;
    if (cmd.namespace && cmd.namespace.toLowerCase().includes(q)) return true;
    if (cmd.description && cmd.description.toLowerCase().includes(q)) return true;
    return false;
  });
}
