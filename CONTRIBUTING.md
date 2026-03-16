# Contributing to ClaudePrism

Contributions are welcome! This guide covers the development environment, workflow, and testing.

## Development Environment

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://rustup.rs/) (stable)
- Platform-specific native dependencies (required by [Tectonic](https://tectonic-typesetting.github.io/)):
  - **macOS:** `brew install icu4c harfbuzz pkg-config`
  - **Linux:** `apt install libicu-dev libgraphite2-dev libharfbuzz-dev libfreetype-dev libfontconfig-dev libwebkit2gtk-4.1-dev libappindicator3-dev`
  - **Windows:** Visual Studio Build Tools (C++ workload) + vcpkg — see detailed steps below

#### Windows Setup (PowerShell)

```powershell
# 1. Install Visual Studio Build Tools (if not already installed)
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 2. Install vcpkg
git clone https://github.com/microsoft/vcpkg.git C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat

# 3. Set environment variables (persistent)
[Environment]::SetEnvironmentVariable("VCPKG_ROOT", "C:\vcpkg", "User")
$path = [Environment]::GetEnvironmentVariable("PATH", "User")
[Environment]::SetEnvironmentVariable("PATH", "$path;C:\vcpkg", "User")
[Environment]::SetEnvironmentVariable("TECTONIC_DEP_BACKEND", "vcpkg", "User")

# 4. Restart PowerShell, then install native libraries (~10-20 min)
vcpkg install harfbuzz[graphite2]:x64-windows freetype:x64-windows icu:x64-windows fontconfig:x64-windows
```

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

## Project Structure

```
claude-prism/
├── apps/
│   └── desktop/              # Tauri desktop app
│       ├── src/              # React frontend (TypeScript)
│       └── src-tauri/        # Rust backend
│           ├── src/
│           │   ├── lib.rs           # Tauri plugin registration
│           │   ├── history.rs       # Git-based version history
│           │   ├── latex.rs         # Tectonic compilation & SyncTeX
│           │   ├── claude.rs        # Claude CLI integration & sessions
│           │   ├── slash_commands.rs # Slash command discovery & CRUD
│           │   └── zotero.rs        # Zotero OAuth & citations
│           └── Cargo.toml
├── .github/workflows/        # CI/CD (build + release)
├── biome.json                # Linter config
└── turbo.json                # Turborepo config
```

## Testing

### Frontend (Vitest)

```bash
cd apps/desktop && pnpm test

# Watch mode
cd apps/desktop && pnpm test:watch
```

### Rust

```bash
cd apps/desktop/src-tauri && cargo test
```

Current test counts:
- **Frontend:** 89 tests (stores, components)
- **Rust:** 114 tests (65 unit + 49 integration)

### What to test

- **Unit tests:** Pure functions, parsers, data transformations
- **Integration tests:** Filesystem/git operations using `tempfile` crate for isolation
- Tests live in `#[cfg(test)] mod tests` blocks within each source file (modules are private)

### Adding Rust integration tests

Use `tempfile::TempDir` for tests that touch the filesystem or git:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_example() {
        let dir = TempDir::new().unwrap();
        // ... test with dir.path() ...
    }

    #[tokio::test]
    async fn test_async_example() {
        // For async Tauri commands that don't need the runtime
    }
}
```

## Code Style

This project uses [Biome](https://biomejs.dev/) for TypeScript/React linting and formatting.

```bash
pnpm lint          # check
pnpm lint:fix      # auto-fix
```

Rust code follows standard `rustfmt` conventions.

### Pre-commit Hook

A [Husky](https://typicode.github.io/husky/) pre-commit hook runs automatically on every commit. It checks and auto-fixes staged files via `biome check --staged --write`, so lint issues are caught before they reach the repository.

The hook is set up automatically when you run `pnpm install`.

### CI

A GitHub Actions workflow runs `biome ci` on every pull request and push to `main`. PRs that fail lint checks cannot be merged.

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run tests: `pnpm test` (frontend) and `cargo test` (Rust)
5. Commit — the pre-commit hook will auto-fix lint issues on staged files
6. Push to your fork and open a PR
7. CI will verify lint and tests pass

### Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Usage |
|--------|-------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation |
| `test:` | Adding or updating tests |
| `refactor:` | Code refactoring |
| `ci:` | CI/CD changes |
| `chore:` | Maintenance tasks |
