<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="ClaudePrism" />
</p>

<h1 align="center">ClaudePrism</h1>

<p align="center">
  An offline-first scientific writing workspace powered by Claude.<br/>
  LaTeX + Python + 100+ scientific skills — runs on your desktop.
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/demo/main.webp" alt="ClaudePrism Demo" width="800" />
</p>

<p align="center">
  <a href="https://claudeprism.delibae.dev?utm_source=github&utm_medium=readme&utm_campaign=launch_v054">
    <img src="https://img.shields.io/badge/Website-claudeprism.dev-blue?style=flat-square&logo=googlechrome&logoColor=white" alt="Website" />
  </a>&nbsp;
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_aarch64.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Apple_Silicon)-black?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" />
  </a>&nbsp;
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_x64-setup.exe">
    <img src="https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" />
  </a>&nbsp;
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_amd64.deb">
    <img src="https://img.shields.io/badge/Download-Linux_(deb)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download for Linux" />
  </a>
</p>
<p align="center">
  <a href="https://github.com/delibae/claude-prism/releases">
    <img src="https://img.shields.io/github/v/release/delibae/claude-prism?style=flat-square&label=Latest%20Release&color=green" alt="Latest Release" />
  </a>
</p>

---

## Why ClaudePrism?

[OpenAI Prism](https://openai.com/prism/) is a cloud-based LaTeX workspace — all your files and data must be uploaded to OpenAI's servers to use it.

ClaudePrism is a **local-first** alternative — your files are stored on your disk, compiled offline, and edited locally. AI features require sending content to Anthropic's API for inference (see [data usage](https://code.claude.com/docs/en/data-usage)).

| | OpenAI Prism | ClaudePrism |
|---|:---:|:---:|
| AI Model | GPT-5.2 | **Claude Opus / Sonnet / Haiku** |
| Runtime | Browser (cloud) | **Native desktop (Tauri 2 + Rust)** |
| LaTeX | Cloud compilation | **Tectonic (embedded, offline)** |
| Python Environment | — | **Built-in uv + venv — one-click scientific Python setup** |
| Scientific Skills | — | **100+ domain skills (bioinformatics, cheminformatics, ML, ...)** |
| Getting Started | Account setup required | **Install and go — template gallery + project wizard** |
| Version Control | — | **Git-based history with labels & diff** |
| Source Code | Proprietary | **Open source (MIT)** |

### Data & Privacy

ClaudePrism stores and compiles your documents locally — nothing is uploaded to a remote server for storage. However, when you use AI features, **prompts and file contents that Claude reads are sent to Anthropic's API for inference**, just like any cloud-based LLM tool. See [Claude Code data usage](https://code.claude.com/docs/en/data-usage) for retention policies and opt-out options.

---

## Features

### Python Environment (uv)
ClaudePrism integrates [uv](https://docs.astral.sh/uv/) — the fast Python package manager — directly into the app. One click to install uv, one click to create a project-level virtual environment. Claude Code automatically uses the `.venv` when running Python code, so you can generate plots, run analysis scripts, and process data without leaving the editor.

<p align="center">
  <img src="./assets/demo/python.webp" alt="Python Environment" width="600" />
</p>

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

<p align="center">
  <img src="./assets/demo/scientific.webp" alt="Scientific Skills" width="700" />
</p>

### Quick Start with Templates & Project Wizard
Pick a template (paper, thesis, presentation, poster, letter, etc.), give it a name, optionally describe what you're writing — ClaudePrism sets up the project and generates initial content with AI. Drag & drop reference files (PDF, BIB, images) and start writing immediately.

<p align="center">
  <img src="./assets/demo/starter.webp" alt="Template Gallery & Project Wizard" width="700" />
</p>

### Claude AI Assistant
Chat with Claude directly in the editor. Select between Sonnet, Opus, Haiku models with adjustable reasoning effort levels. Persistent sessions, tool use (file edit, bash, search), and extensible slash commands.

<p align="center">
  <img src="./assets/demo/claudecommand.webp" alt="Claude AI Assistant & Slash Commands" width="600" />
</p>

### History & Proposed Changes
Every save creates a snapshot in a local Git repository (`.claudeprism/history.git/`). Label important checkpoints, browse diffs between any two snapshots, and restore previous versions. When Claude suggests edits, changes appear in a dedicated panel with visual diffs — accept or reject per chunk, or apply/undo all at once (`⌘Y` / `⌘N`).

<p align="center">
  <img src="./assets/demo/history.webp" alt="History & Proposed Changes" width="700" />
</p>

### Offline LaTeX Compilation
Tectonic is embedded directly in the app. Packages are downloaded once on first use and cached locally. After that, compilation works fully offline with no TeX Live installation required.

### Capture & Ask
Press `⌘X` to enter capture mode, drag to select any region in the PDF — the captured image is pinned to the chat composer so you can immediately ask Claude about it. Great for asking about equations, figures, tables, or reviewer comments.

<p align="center">
  <img src="./assets/demo/capture_ask.webp" alt="Capture & Ask" width="700" />
</p>

### Live PDF Preview
Native MuPDF rendering with SyncTeX support — click a position in the PDF to jump to the corresponding source line. Supports zoom, text selection, and capture.

### Editor
CodeMirror 6 with LaTeX/BibTeX syntax highlighting, real-time error linting, find & replace (regex), and multi-file project support with auto-save.

### More
- **Zotero Integration** — OAuth-based bibliography management and citation insertion.

<p align="center">
  <img src="./assets/demo/zotero.webp" alt="Zotero Integration" width="300" />
</p>

- **Slash Commands** — Built-in (`/review`, `/init`) + custom commands from `.claude/commands/`.
- **External Editors** — Open projects in Cursor, VS Code, Zed, or Sublime Text.
- **Dark / Light Theme** — Automatic switching.

---

## Installation

Download the latest build from [GitHub Releases](https://github.com/delibae/claude-prism/releases).

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing, and guidelines.

## Acknowledgments

This project started from [Open Prism](https://github.com/assistant-ui/open-prism) by [assistant-ui](https://github.com/assistant-ui).

## License

[MIT](./LICENSE)
