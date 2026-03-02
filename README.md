<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="ClaudePrism" />
</p>

<h1 align="center">ClaudePrism</h1>

<p align="center">
  A private, offline-first LaTeX workspace powered by Claude.<br/>
  Your documents never leave your machine.
</p>

<p align="center">
  <a href="https://github.com/delibae/claude-prism/releases">Releases</a> ·
  <a href="#installation">Install</a> ·
  <a href="#development">Development</a>
</p>

---

## Why ClaudePrism?

[OpenAI Prism](https://openai.com/prism/) is a cloud-based LaTeX workspace for scientists — free, powerful, but **your unpublished research lives on OpenAI's servers**. Experts have [raised concerns](https://decrypt.co/356259/openai-science-platform-prism-experts-warn-privacy-concerns) about intellectual property exposure and whether OpenAI could claim rights over researcher data. By default, content may be used to train future models unless you opt out.

ClaudePrism takes a different approach: **everything runs locally on your machine.**

| | OpenAI Prism | ClaudePrism |
|---|:---:|:---:|
| AI Model | GPT-5.2 (cloud) | **Claude Opus / Sonnet / Haiku (local CLI)** |
| Runtime | Browser (cloud) | **Native desktop (Tauri 2 + Rust)** |
| LaTeX | Cloud compilation | **Tectonic (embedded, offline)** |
| PDF | Cloud rendering | **MuPDF (native, SyncTeX)** |
| Getting Started | Account setup required | **Install and go — template gallery + project wizard** |
| Version Control | — | **Git-based history with labels & diff** |
| Data Privacy | Cloud storage, may train models | **Zero data collection, fully local** |
| Offline | Requires internet | **Fully offline after first compile** |
| Source Code | Proprietary | **Open source (MIT)** |

### Your Research, Your Machine

ClaudePrism invokes the **Claude CLI** as a local subprocess — your prompts and documents are handled on your machine, not routed through any intermediary server. There is **no telemetry, no analytics, no cloud logging** in the app.

- Claude Code (the CLI) [does not train on your data](https://docs.anthropic.com/en/docs/claude-cli)
- Your unpublished papers, embargoed findings, and IP stay on your local disk
- No account data, no usage tracking, no "outcome-based pricing" on your discoveries
- Open source — audit the code yourself

---

## Features

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

### Live PDF Preview
Native MuPDF rendering with SyncTeX support — click a position in the PDF to jump to the corresponding source line. Supports zoom, text selection, and annotation capture.

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

> Claude AI features require the [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed locally.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | **Tauri 2** + Rust |
| Frontend | **React 19** + TypeScript + Vite |
| Editor | **CodeMirror 6** |
| PDF | **MuPDF** (native) |
| LaTeX | **Tectonic** (embedded) |
| State | **Zustand** |
| UI | **Radix UI** + Tailwind CSS |
| Monorepo | **pnpm** + Turborepo |

## Project Structure

```
claude-prism/
├── apps/
│   ├── desktop/           # Tauri desktop app (main)
│   │   ├── src/           # React frontend
│   │   └── src-tauri/     # Rust backend
│   ├── web/               # Next.js web app (legacy)
│   └── latex-api/         # LaTeX compilation API (Hono)
├── homebrew/              # Homebrew Cask formula
├── .github/workflows/     # CI/CD (build + release)
├── biome.json             # Linter config
└── turbo.json             # Turborepo config
```

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
# Desktop app (Tauri dev mode)
pnpm dev:desktop

# Web app (legacy)
pnpm dev:web
```

### Build

```bash
pnpm build:desktop
```

### Lint

```bash
pnpm lint          # check
pnpm lint:fix      # auto-fix
```

## Contributing

Contributions are welcome! Please use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`).

## License

[MIT](./LICENSE)
