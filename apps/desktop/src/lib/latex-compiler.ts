import { invoke } from "@tauri-apps/api/core";

export async function compileLatex(
  projectDir: string,
  mainFile: string = "document.tex",
  compiler?: string,
): Promise<Uint8Array> {
  // compile_latex returns raw PDF bytes via Tauri IPC Response
  const buffer = await invoke<ArrayBuffer>("compile_latex", {
    projectDir,
    mainFile,
    compiler: compiler ?? null,
  });

  return new Uint8Array(buffer);
}

export interface SynctexResult {
  file: string;
  line: number;
  column: number;
}

export async function synctexEdit(
  projectDir: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexResult | null> {
  try {
    return await invoke<SynctexResult>("synctex_edit", {
      projectDir,
      page,
      x,
      y,
    });
  } catch {
    return null;
  }
}
