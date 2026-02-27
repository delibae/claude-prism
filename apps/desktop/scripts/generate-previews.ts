/**
 * Generate example projects for all LaTeX templates.
 *
 * Usage:  pnpm --filter @claude-prism/desktop generate-previews
 *
 * Requires pdflatex to be installed (part of TeX Live / MacTeX).
 * Output: public/examples/{template-id}/main.tex, main.pdf, references.bib (if applicable)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import template registry (pure data, no DOM dependencies)
const registryPath = path.resolve(__dirname, "../src/lib/template-registry.ts");

// Since this is a .ts file with exports, we rely on tsx to handle it
async function loadTemplates() {
  const mod = await import(registryPath);
  return mod.getAllTemplates() as Array<{
    id: string;
    name: string;
    mainFileName: string;
    content: string;
    hasBibliography: boolean;
  }>;
}

const EXAMPLES_DIR = path.resolve(__dirname, "../public/examples");
const COMPILE_TIMEOUT = 30_000;

async function main() {
  console.log("Generating example projects...\n");

  const templates = await loadTemplates();
  let successCount = 0;
  let failCount = 0;

  for (const template of templates) {
    process.stdout.write(`  ${template.id}... `);

    const exampleDir = path.join(EXAMPLES_DIR, template.id);
    fs.mkdirSync(exampleDir, { recursive: true });

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `prism-preview-${template.id}-`),
    );

    try {
      // Write .tex file (inject \null for blank templates to force a page)
      let content = template.content;
      if (template.id === "blank") {
        content = content.replace(
          "\\begin{document}",
          "\\begin{document}\n\\null",
        );
      }
      const texPath = path.join(tmpDir, template.mainFileName);
      fs.writeFileSync(texPath, content, "utf-8");

      // Write stub .bib if template uses bibliography
      if (template.hasBibliography) {
        fs.writeFileSync(
          path.join(tmpDir, "references.bib"),
          "% empty bibliography\n",
          "utf-8",
        );
      }

      const cmd = [
        "pdflatex",
        "-interaction=nonstopmode",
        `-output-directory=${tmpDir}`,
        texPath,
      ].join(" ");

      // First pass
      execSync(cmd, { cwd: tmpDir, timeout: COMPILE_TIMEOUT, stdio: "pipe" });

      // Second pass (for TOC, references, etc.)
      try {
        execSync(cmd, { cwd: tmpDir, timeout: COMPILE_TIMEOUT, stdio: "pipe" });
      } catch {
        // Second pass failure is non-fatal
      }

      // Copy source files to example folder
      fs.copyFileSync(texPath, path.join(exampleDir, template.mainFileName));
      if (template.hasBibliography) {
        fs.copyFileSync(
          path.join(tmpDir, "references.bib"),
          path.join(exampleDir, "references.bib"),
        );
      }

      // Copy compiled PDF to example folder
      const pdfName = template.mainFileName.replace(/\.tex$/, ".pdf");
      const pdfPath = path.join(tmpDir, pdfName);

      if (fs.existsSync(pdfPath)) {
        fs.copyFileSync(pdfPath, path.join(exampleDir, pdfName));
        const sizeKb = Math.round(fs.statSync(path.join(exampleDir, pdfName)).size / 1024);
        console.log(`OK (${sizeKb} KB)`);
        successCount++;
      } else {
        console.log("WARN: no PDF output");
        failCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 120) : String(err);
      console.log(`FAIL: ${msg}`);
      failCount++;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log(`\nDone: ${successCount} succeeded, ${failCount} failed`);
  if (failCount > 0) {
    console.log(
      "Note: Failed templates may require document classes not installed in your TeX distribution.",
    );
    console.log("The gallery will show CSS fallback thumbnails for those templates.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
