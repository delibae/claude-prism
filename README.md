<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="ClaudePrism" />
</p>

<h1 align="center">ClaudePrism</h1>

<p align="center">
  A private, offline-first scientific writing workspace powered by Claude.<br/>
  LaTeX + Python + 100 scientific skills — all running locally on your machine.
</p>

<p align="center">
  <a href="https://github.com/delibae/claude-prism/releases">Releases</a> ·
  <a href="#installation">Install</a> ·
  <a href="#development">Development</a>
</p>

---

## Why ClaudePrism?

[OpenAI Prism](https://openai.com/prism/) is a cloud-based LaTeX workspace for scientists — free, powerful, but **your unpublished research lives on OpenAI's servers**. Experts have raised concerns about intellectual property exposure and whether OpenAI could claim rights over researcher data. By default, content may be used to train future models unless you opt out.

ClaudePrism takes a different approach: **everything runs locally on your machine.**

| | OpenAI Prism | ClaudePrism |
|---|:---:|:---:|
| AI Model | GPT-5.2 (cloud) | **Claude Opus / Sonnet / Haiku (local CLI)** |
| Runtime | Browser (cloud) | **Native desktop (Tauri 2 + Rust)** |
| LaTeX | Cloud compilation | **Tectonic (embedded, offline)** |
| Python Environment | — | **Built-in uv + venv — one-click scientific Python setup** |
| Scientific Skills | — | **100+ domain skills (bioinformatics, cheminformatics, ML, ...)** |
| Getting Started | Account setup required | **Install and go — template gallery + project wizard** |
| Version Control | — | **Git-based history with labels & diff** |
| Data Privacy | Cloud storage, [trains models by default](https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/) | **Local execution, [opt-out available](https://code.claude.com/docs/en/data-usage)** |
| Source Code | Proprietary | **Open source (MIT)** |

### Your Research, Your Machine

ClaudePrism invokes **Claude Code** as a local subprocess. Your documents stay on disk — only prompts are sent to the Claude API for inference.

**How the two compare on data:**

| | OpenAI Prism | ClaudePrism (via Claude Code) |
|---|---|---|
| Where documents live | OpenAI cloud servers | Your local disk |
| Default training policy | **ON** — ChatGPT personal accounts [train models by default](https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/) | **ON** for Consumer (Free/Pro/Max), **OFF** for [Commercial plans](https://code.claude.com/docs/en/data-usage) (Team/Enterprise/API) |
| Opt-out | Settings > Data Controls | [Privacy Settings](https://claude.ai/settings/data-privacy-controls) or use Commercial plan |
| Data retention | Not disclosed | 30 days (opt-out) / 5 years (opt-in) |
| Zero data retention | Not available | Available on Enterprise |
| Telemetry | Cannot disable | `DISABLE_TELEMETRY=1` to fully disable |
| Source code | Proprietary | Open source — [audit it yourself](https://github.com/delibae/claude-prism) |

---

## Features

### Python Environment (uv)
ClaudePrism integrates [uv](https://docs.astral.sh/uv/) — the fast Python package manager — directly into the app. One click to install uv, one click to create a project-level virtual environment. Claude Code automatically uses the `.venv` when running Python code, so you can generate plots, run analysis scripts, and process data without leaving the editor.

### 100+ Scientific Skills
Browse and install domain-specific skills from [K-Dense Scientific Skills](https://github.com/K-Dense-AI/claude-scientific-skills) — curated prompts and tool configurations that give Claude deep knowledge in specialized fields:

| Domain | Skills |
|--------|--------|
| **Bioinformatics & Genomics** | Scanpy, BioPython, PyDESeq2, PySAM, gget, AnnData, ... |
| **Cheminformatics & Drug Discovery** | RDKit, DeepChem, DiffDock, PubChem, ChEMBL, ... |
| **Data Analysis & Visualization** | Matplotlib, Seaborn, Plotly, Polars, scikit-learn, ... |
| **Machine Learning & AI** | PyTorch Lightning, Transformers, SHAP, UMAP, PyMC, ... |
| **Clinical Research** | ClinicalTrials.gov, ClinVar, DrugBank, FDA, ... |
| **Scientific Communication** | Literature Review, Grant Writing, Citation Management, ... |
| **Multi-omics & Systems Biology** | scvi-tools, COBRApy, Reactome, Bioservices, ... |
| **And more** | Materials Science, Lab Automation, Proteomics, Physics, ... |

Skills are installed globally (`~/.claude/skills/`) or per-project, and Claude automatically loads them when relevant.

### Quick Start with Templates & Project Wizard
Pick a template (paper, thesis, presentation, poster, letter, etc.), give it a name, optionally describe what you're writing — ClaudePrism sets up the project and generates initial content with AI. Drag & drop reference files (PDF, BIB, images) and start writing immediately.

### Claude AI Assistant
Chat with Claude directly in the editor. Select between Sonnet, Opus, Haiku models with adjustable reasoning effort levels. Persistent sessions, tool use (file edit, bash, search), and extensible slash commands.

### Proposed Changes Review
When Claude suggests edits, changes appear in a dedicated panel with visual diffs. Accept or reject per chunk, or apply/undo all at once (`⌘Y` / `⌘N`). Your original content is always preserved until you decide.

### Git-Based History
Every save creates a snapshot in a local Git repository (`.claudeprism/history.git/`). Label important checkpoints, browse diffs between any two snapshots, and restore previous versions — all without leaving the app.

### Offline LaTeX Compilation
Tectonic is embedded directly in the app. Packages are downloaded once on first use and cached locally. After that, compilation works fully offline with no TeX Live installation required.

### Capture & Ask
Press `⌘X` to enter capture mode, drag to select any region in the PDF — the captured image is pinned to the chat composer so you can immediately ask Claude about it. Great for asking about equations, figures, tables, or reviewer comments.

### Live PDF Preview
Native MuPDF rendering with SyncTeX support — click a position in the PDF to jump to the corresponding source line. Supports zoom, text selection, and capture.

### Editor
CodeMirror 6 with LaTeX/BibTeX syntax highlighting, real-time error linting, find & replace (regex), and multi-file project support with auto-save.

### More
- **Zotero Integration** — OAuth-based bibliography management and citation insertion.
- **Slash Commands** — Built-in (`/review`, `/init`) + custom commands from `.claude/commands/`.
- **External Editors** — Open projects in Cursor, VS Code, Zed, or Sublime Text.
- **Dark / Light Theme** — Automatic switching.

---

## Installation

### macOS (Homebrew)

```bash
brew tap delibae/claude-prism
brew install --cask claude-prism
```

### macOS / Windows / Linux

Download the latest build from [GitHub Releases](https://github.com/delibae/claude-prism/releases):

| Platform | File | Install |
|:--------:|:----:|:--------|
| **macOS** (Apple Silicon) | `.dmg` | Open → drag to Applications |
| **Windows** (x64) | `.msi` / `.exe` | Run the installer |
| **Linux** (x64) | `.AppImage` | `chmod +x` and run |
| **Linux** (x64) | `.deb` | `sudo dpkg -i claude-prism_*.deb` |

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://rustup.rs/) (stable)
- macOS: `brew install icu4c harfbuzz pkg-config`

### Setup

```bash
git clone https://github.com/delibae/claude-prism.git
cd claude-prism
pnpm install
```

### Run

```bash
pnpm dev:desktop
```

### Build

```bash
pnpm build:desktop
```

### Test

```bash
# Frontend (Vitest)
cd apps/desktop && pnpm test

# Rust
cd apps/desktop/src-tauri && cargo test
```

### Lint

```bash
pnpm lint          # check
pnpm lint:fix      # auto-fix
```

## Contributing

Contributions are welcome! Please use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`).

## Acknowledgments

This project started from [Open Prism](https://github.com/assistant-ui/open-prism) by [assistant-ui](https://github.com/assistant-ui).

## License

[MIT](./LICENSE)
