import { RefObject, useCallback, useEffect, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import {
  BoldIcon,
  ItalicIcon,
  ListIcon,
  Heading1Icon,
  Heading2Icon,
  CodeIcon,
  FunctionSquareIcon,
  FileTextIcon,
  ImageIcon,
  MinusIcon,
  PlusIcon,
  BookMarkedIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDocumentStore } from "@/stores/document-store";

interface EditorInfo {
  id: string;
  name: string;
}

const ZOOM_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
  { value: "4", label: "400%" },
];

interface EditorToolbarProps {
  editorView: RefObject<EditorView | null>;
  fileType?: "tex" | "image";
  imageScale?: number;
  onImageScaleChange?: (scale: number) => void;
}

export function EditorToolbar({
  editorView,
  fileType = "tex",
  imageScale = 1,
  onImageScaleChange,
}: EditorToolbarProps) {
  const fileName = useDocumentStore((s) => {
    const activeFile = s.files.find((f) => f.id === s.activeFileId);
    return activeFile?.name ?? "document.tex";
  });
  const activeFilePath = useDocumentStore((s) => {
    const activeFile = s.files.find((f) => f.id === s.activeFileId);
    return activeFile?.relativePath;
  });
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  const [editors, setEditors] = useState<EditorInfo[]>([]);

  useEffect(() => {
    invoke<EditorInfo[]>("detect_editors").then(setEditors).catch(() => {});
  }, []);

  const openInEditor = useCallback(
    (editorId: string) => {
      if (!projectRoot) return;
      const view = editorView.current;
      const line = view
        ? view.state.doc.lineAt(view.state.selection.main.head).number
        : undefined;
      invoke("open_in_editor", {
        editorId,
        projectPath: projectRoot,
        filePath: activeFilePath,
        line,
      }).catch((err) => console.error("open_in_editor failed:", err));
    },
    [projectRoot, activeFilePath, editorView],
  );

  const insertText = (before: string, after: string = "") => {
    const view = editorView.current;
    if (!view) return;

    const { from, to } = view.state.selection.main;
    const selectedText = view.state.sliceDoc(from, to);

    view.dispatch({
      changes: {
        from,
        to,
        insert: before + selectedText + after,
      },
      selection: {
        anchor: from + before.length,
        head: from + before.length + selectedText.length,
      },
    });
    view.focus();
  };

  const wrapSelection = (wrapper: string) => {
    insertText(wrapper, wrapper);
  };

  const zoomIn = () => onImageScaleChange?.(Math.min(4, imageScale + 0.25));
  const zoomOut = () => onImageScaleChange?.(Math.max(0.25, imageScale - 0.25));

  if (fileType === "image") {
    return (
      <div className="flex items-center justify-between border-border border-b bg-muted/30 px-2 pt-[var(--titlebar-height)] h-[calc(36px+var(--titlebar-height))]">
        <div className="flex items-center gap-1">
          <ImageIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-muted-foreground text-sm">
            {fileName}
          </span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={zoomOut}
            disabled={imageScale <= 0.25}
          >
            <MinusIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={zoomIn}
            disabled={imageScale >= 4}
          >
            <PlusIcon className="size-3.5" />
          </Button>
          <Select
            value={imageScale.toString()}
            onValueChange={(v) => onImageScaleChange?.(Number(v))}
          >
            <SelectTrigger size="sm" className="h-6! w-auto text-xs">
              <SelectValue>{Math.round(imageScale * 100)}%</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ZOOM_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {editors.length === 1 && (
            <TooltipIconButton
              tooltip={`Open in ${editors[0].name}`}
              onClick={() => openInEditor(editors[0].id)}
            >
              <ExternalLinkIcon className="size-4" />
            </TooltipIconButton>
          )}
          {editors.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 p-1"
                  title="Open in Editor"
                >
                  <ExternalLinkIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {editors.map((editor) => (
                  <DropdownMenuItem
                    key={editor.id}
                    onClick={() => openInEditor(editor.id)}
                  >
                    {editor.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 border-border border-b bg-muted/30 px-2 pt-[var(--titlebar-height)] h-[calc(36px+var(--titlebar-height))]">
      <FileTextIcon className="size-4 text-muted-foreground" />
      <span className="mr-2 font-medium text-muted-foreground text-sm">
        {fileName}
      </span>
      <div className="mx-2 h-4 w-px bg-border" />
      <TooltipIconButton
        tooltip="Bold (\\textbf)"
        onClick={() => insertText("\\textbf{", "}")}
      >
        <BoldIcon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Italic (\\textit)"
        onClick={() => insertText("\\textit{", "}")}
      >
        <ItalicIcon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Code (\\texttt)"
        onClick={() => insertText("\\texttt{", "}")}
      >
        <CodeIcon className="size-4" />
      </TooltipIconButton>
      <div className="mx-2 h-4 w-px bg-border" />
      <TooltipIconButton
        tooltip="Section"
        onClick={() => insertText("\\section{", "}")}
      >
        <Heading1Icon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Subsection"
        onClick={() => insertText("\\subsection{", "}")}
      >
        <Heading2Icon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="List item"
        onClick={() => insertText("\\item ")}
      >
        <ListIcon className="size-4" />
      </TooltipIconButton>
      <div className="mx-2 h-4 w-px bg-border" />
      <TooltipIconButton
        tooltip="Inline math ($...$)"
        onClick={() => wrapSelection("$")}
      >
        <FunctionSquareIcon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Display math (\\[...\\])"
        onClick={() => insertText("\\[\n  ", "\n\\]")}
      >
        <span className="font-mono text-xs">∫</span>
      </TooltipIconButton>
      <div className="mx-2 h-4 w-px bg-border" />
      <TooltipIconButton
        tooltip="Citation (\\cite)"
        onClick={() => insertText("\\cite{", "}")}
      >
        <BookMarkedIcon className="size-4" />
      </TooltipIconButton>
      <div data-tauri-drag-region className="flex-1 self-stretch" />
      {editors.length === 1 && (
        <TooltipIconButton
          tooltip={`Open in ${editors[0].name}`}
          onClick={() => openInEditor(editors[0].id)}
        >
          <ExternalLinkIcon className="size-4" />
        </TooltipIconButton>
      )}
      {editors.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 p-1"
              title="Open in Editor"
            >
              <ExternalLinkIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {editors.map((editor) => (
              <DropdownMenuItem
                key={editor.id}
                onClick={() => openInEditor(editor.id)}
              >
                {editor.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
