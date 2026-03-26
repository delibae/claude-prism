use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

const MAX_CONCURRENT: usize = 3;

struct BuildInfo {
    work_dir: PathBuf,
    main_file_name: String,
}

#[derive(Clone)]
pub struct LatexCompilerState {
    last_builds: Arc<Mutex<HashMap<String, BuildInfo>>>,
    /// Per-project locks to prevent concurrent compilations on the same build directory.
    project_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    semaphore: Arc<Semaphore>,
}

impl Default for LatexCompilerState {
    fn default() -> Self {
        Self {
            last_builds: Arc::new(Mutex::new(HashMap::new())),
            project_locks: Arc::new(Mutex::new(HashMap::new())),
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT)),
        }
    }
}

#[derive(serde::Serialize)]
pub struct SynctexResult {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

// --- Helpers ---

fn extract_error_lines(log: &str) -> String {
    if log.is_empty() {
        return String::new();
    }

    // Extract real errors first — they take priority over "No pages of output"
    let error_lines: Vec<&str> = log
        .lines()
        .filter(|l| l.starts_with('!') || l.contains("Error:") || l.contains("error:"))
        .take(10)
        .collect();

    if !error_lines.is_empty() {
        return error_lines.join("\n");
    }

    if log.lines().any(|l| l.contains("No pages of output")) {
        return "No pages of output. Add visible content to the document body.".to_string();
    }

    // Fallback: return tail of log
    let start = log.len().saturating_sub(500);
    log[start..].to_string()
}

/// Check if the log contains real TeX errors (! lines or Error: messages).
fn has_real_errors(log: &str) -> bool {
    log.lines()
        .any(|l| l.starts_with('!') || l.contains("Error:"))
}

#[derive(Debug, PartialEq)]
enum TexEngine {
    Latex,
    XeLaTeX,
    LuaLaTeX,
}

/// Detect TeX engine from `% !TEX program = <engine>` magic comment in the first 20 lines.
fn detect_tex_engine(content: &str) -> Option<TexEngine> {
    for line in content.lines().take(20) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('%') {
            let rest = rest.trim();
            if let Some(rest) = rest.strip_prefix("!TEX") {
                let rest = rest.trim();
                if let Some(rest) = rest.strip_prefix("program") {
                    let rest = rest.trim();
                    if let Some(rest) = rest.strip_prefix('=') {
                        let engine = rest.trim().to_lowercase();
                        return match engine.as_str() {
                            "xelatex" => Some(TexEngine::XeLaTeX),
                            "lualatex" => Some(TexEngine::LuaLaTeX),
                            "pdflatex" | "latex" => Some(TexEngine::Latex),
                            _ => None,
                        };
                    }
                }
            }
        }
    }
    None
}

#[derive(Debug, PartialEq)]
enum BibTool {
    Biber,
    BibTeX,
    None,
}

/// Detect which bibliography tool is needed by scanning .tex content.
fn detect_bib_tool(content: &str) -> BibTool {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('%') {
            continue;
        }
        if trimmed.contains("\\usepackage") && trimmed.contains("biblatex") {
            return BibTool::Biber;
        }
    }
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('%') {
            continue;
        }
        if trimmed.contains("\\bibliography{") || trimmed.contains("\\addbibresource{") {
            return BibTool::BibTeX;
        }
    }
    BibTool::None
}

/// Resolve a TeXLive engine binary to its full path.
/// GUI apps on macOS lack the user's shell PATH, so we check standard
/// TeXLive installation locations and fall back to a login-shell query.
fn find_texlive_binary(name: &str) -> Result<PathBuf, String> {
    // 1. Try PATH (works when launched from terminal)
    if let Ok(path) = which::which(name) {
        return Ok(path);
    }

    // 2. Check standard TeXLive locations
    #[cfg(not(target_os = "windows"))]
    {
        let standard_paths = [
            format!("/Library/TeX/texbin/{}", name),
            format!("/usr/local/texlive/2025/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2024/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2025/bin/x86_64-linux/{}", name),
            format!("/usr/local/texlive/2024/bin/x86_64-linux/{}", name),
            format!("/opt/homebrew/bin/{}", name),
            format!("/usr/bin/{}", name),
        ];
        for path_str in &standard_paths {
            let p = PathBuf::from(path_str);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let standard_paths = [
            format!("C:\\texlive\\2025\\bin\\windows\\{}.exe", name),
            format!("C:\\texlive\\2024\\bin\\windows\\{}.exe", name),
        ];
        for path_str in &standard_paths {
            let p = PathBuf::from(path_str);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // 3. macOS: ask login shell for PATH
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/bin/zsh")
            .args(["-l", "-c", &format!("which {}", name)])
            .output()
        {
            if output.status.success() {
                let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let p = PathBuf::from(&resolved);
                if p.exists() {
                    return Ok(p);
                }
            }
        }
    }

    Err(format!(
        "{} not found. Install TeXLive or add it to your PATH.",
        name
    ))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            // Skip hidden directories (.git, .claudeprism, etc.)
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Sync only source files (.tex, .bib, .sty, .cls, .bst, images, .pdf figures) from project to build dir.
/// Skips build artifacts (.aux, .log, .toc, .synctex.gz, etc.) to preserve them.
/// Note: .pdf is NOT skipped — figure PDFs must be synced. The output PDF is managed by compile_latex.
fn sync_source_files(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            sync_source_files(&src_path, &dst_path)?;
        } else {
            let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let is_artifact = matches!(
                ext,
                "aux"
                    | "log"
                    | "toc"
                    | "lof"
                    | "lot"
                    | "out"
                    | "nav"
                    | "snm"
                    | "vrb"
                    | "bbl"
                    | "blg"
                    | "fls"
                    | "fdb_latexmk"
                    | "synctex"
                    | "idx"
                    | "ind"
                    | "ilg"
                    | "glo"
                    | "gls"
                    | "glg"
                    | "fmt"
                    | "xdv"
            );
            let is_synctex = src_path.to_string_lossy().ends_with(".synctex.gz");
            if !is_artifact && !is_synctex {
                // Cloud storage (Dropbox/iCloud) may keep files as online-only
                // placeholders with 0 bytes. Reading the file forces a download.
                let metadata = std::fs::metadata(&src_path)?;
                if metadata.len() == 0 {
                    // Attempt to materialize the file by reading it
                    let data = std::fs::read(&src_path)?;
                    if !data.is_empty() {
                        std::fs::write(&dst_path, &data)?;
                    } else {
                        std::fs::copy(&src_path, &dst_path)?;
                    }
                } else {
                    std::fs::copy(&src_path, &dst_path)?;
                }
            }
        }
    }
    Ok(())
}

/// Persistent build directory inside the project.
/// Stored in `<project>/.prism/build/` — hidden from file tree (dot-prefix is filtered).
fn persistent_build_dir(project_dir: &str) -> PathBuf {
    PathBuf::from(project_dir).join(".prism").join("build")
}

// --- Thread priority ---

/// Lower the current thread's scheduling priority so CPU-heavy compilation
/// does not starve the WebView's main thread (and thus the UI / typing).
fn lower_thread_priority() {
    #[cfg(target_os = "macos")]
    {
        // QOS_CLASS_UTILITY (0x11) — lower than default, appropriate for long-running work.
        extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        unsafe { pthread_set_qos_class_self_np(0x11, 0) };
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        extern "C" {
            fn nice(inc: i32) -> i32;
        }
        unsafe { nice(10) };
    }
}

// --- Tectonic Compilation ---

pub(crate) fn compile_with_tectonic(work_dir: &Path, main_file: &str) -> Result<(), String> {
    use tectonic::config::PersistentConfig;
    use tectonic::driver::{OutputFormat, PassSetting, ProcessingSessionBuilder};
    use tectonic::status::NoopStatusBackend;

    let mut status = NoopStatusBackend {};

    let config = PersistentConfig::open(false)
        .map_err(|e| format!("Failed to open tectonic config: {}", e))?;

    let bundle = config.default_bundle(false, &mut status).map_err(|e| {
        format!(
            "Failed to load tectonic bundle (check network connection): {}",
            e
        )
    })?;

    let format_cache = config
        .format_cache_path()
        .map_err(|e| format!("Failed to get format cache path: {}", e))?;

    let mut builder = ProcessingSessionBuilder::default();
    builder
        .bundle(bundle)
        .primary_input_path(work_dir.join(main_file))
        .tex_input_name(main_file)
        .filesystem_root(work_dir)
        .output_dir(work_dir)
        .format_name("latex")
        .format_cache_path(format_cache)
        .output_format(OutputFormat::Pdf)
        .pass(PassSetting::Default)
        .synctex(true)
        .keep_intermediates(true)
        .keep_logs(true);

    let mut session = builder
        .create(&mut status)
        .map_err(|e| format!("Failed to create tectonic session: {}", e))?;

    session.run(&mut status).map_err(|e| format!("{}", e))?;

    Ok(())
}

/// Run tectonic compilation in an isolated subprocess.
///
/// This avoids the font cache assertion failure (`font_cache.fonts == NULL`)
/// that occurs when tectonic is called multiple times in the same process.
/// The C-level static `font_cache` in `dpx-pdffont.c` is not cleaned up
/// on compilation failure, causing subsequent calls to abort.
///
/// By spawning a subprocess, each compilation gets a fresh process with
/// clean global state, and cleanup happens automatically on process exit.
fn compile_with_tectonic_subprocess(work_dir: &Path, main_file: &str) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {}", e))?;

    let output = std::process::Command::new(&exe)
        .args(["--tectonic-compile", &work_dir.to_string_lossy(), main_file])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to spawn tectonic subprocess: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.trim().to_string())
    }
}

// --- TeXLive Compilation ---

/// Build a PATH that includes the TeXLive bin directory so that xelatex
/// can find xdvipdfmx, kpsewhich, and other tools it invokes internally.
/// GUI apps on macOS have a minimal PATH that doesn't include TeXLive.
fn texlive_env_path(engine: &Path) -> String {
    let texbin = engine
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let current_path = std::env::var("PATH").unwrap_or_default();
    if current_path.contains(&texbin) {
        current_path
    } else {
        format!("{}:{}", texbin, current_path)
    }
}

/// Run a single TeX engine pass.  Never returns `Err` for a non-zero exit
/// code — TeXLive returns non-zero for warnings, font substitutions, etc.
/// The only `Err` is when the process cannot be *spawned* at all.
/// The caller decides success by checking whether the PDF was produced.
fn run_texlive_pass(
    engine: &Path,
    args: &[&str],
    main_file: &Path,
    work_dir: &Path,
) -> Result<(), String> {
    let output = std::process::Command::new(engine)
        .args(args)
        .arg(main_file)
        .current_dir(work_dir)
        .env("PATH", texlive_env_path(engine))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to launch {}: {}", engine.display(), e))?;

    // TeXLive returns non-zero on warnings too — don't fail here.
    // The caller decides success by checking whether the PDF was produced.
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            eprintln!("[texlive] engine stderr: {}", stderr.trim());
        }
    }
    Ok(())
}

fn compile_with_texlive(
    work_dir: &Path,
    main_file: &str,
    engine: Option<TexEngine>,
    tex_content: &str,
) -> Result<(), String> {
    let engine_name = match engine {
        Some(TexEngine::XeLaTeX) | None => "xelatex",
        Some(TexEngine::Latex) => "pdflatex",
        Some(TexEngine::LuaLaTeX) => "lualatex",
    };

    let engine_path = find_texlive_binary(engine_name)?;
    let env_path = texlive_env_path(&engine_path);
    eprintln!("[texlive] backend: {} ({})", engine_name, engine_path.display());
    let bib_tool = detect_bib_tool(tex_content);

    // Use "." as output-directory since current_dir is already work_dir.
    // Absolute paths break when they contain ~ (e.g. iCloud's com~apple~CloudDocs)
    // because TeX interprets ~ as a home directory shortcut.
    let output_dir_arg = "-output-directory=.".to_string();
    // Do NOT use -halt-on-error: xelatex is a pipeline (xetex → .xdv → xdvipdfmx → .pdf).
    // With -halt-on-error, recoverable warnings (e.g. missing font shapes) cause xetex to
    // exit non-zero, and the xelatex wrapper skips the xdvipdfmx step — producing .xdv but
    // no .pdf.  -interaction=nonstopmode alone is sufficient to avoid interactive prompts.
    let common_args: Vec<&str> = vec![
        "-synctex=1",
        "-interaction=nonstopmode",
        &output_dir_arg,
    ];

    let main_file_path = Path::new(main_file);

    // Pass 1
    run_texlive_pass(&engine_path, &common_args, main_file_path, work_dir)?;

    // Bib pass (if needed)
    let main_stem = Path::new(main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");

    match bib_tool {
        BibTool::Biber => {
            let biber_path = find_texlive_binary("biber")?;
            let output = std::process::Command::new(&biber_path)
                .arg(main_stem)
                .current_dir(work_dir)
                .env("PATH", &env_path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .map_err(|e| format!("Failed to run biber: {}", e))?;
            if !output.status.success() {
                eprintln!(
                    "[texlive] biber warning: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        BibTool::BibTeX => {
            let bibtex_path = find_texlive_binary("bibtex")?;
            let aux_file = work_dir.join(format!("{}.aux", main_stem));
            let output = std::process::Command::new(&bibtex_path)
                .arg(&aux_file)
                .current_dir(work_dir)
                .env("PATH", &env_path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .map_err(|e| format!("Failed to run bibtex: {}", e))?;
            if !output.status.success() {
                eprintln!(
                    "[texlive] bibtex warning: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        BibTool::None => {}
    }

    // Pass 2: resolve references / TOC
    run_texlive_pass(&engine_path, &common_args, &main_file_path, work_dir)?;

    // Pass 3: stabilize citations (only if bib was used)
    if !matches!(bib_tool, BibTool::None) {
        run_texlive_pass(&engine_path, &common_args, &main_file_path, work_dir)?;
    }

    let pdf_path = work_dir.join(format!("{}.pdf", main_stem));
    let xdv_path = work_dir.join(format!("{}.xdv", main_stem));

    // Fallback: if xelatex produced .xdv but no .pdf (e.g. xdvipdfmx was skipped due to
    // warnings), manually run xdvipdfmx to convert .xdv → .pdf.
    if !pdf_path.exists() && xdv_path.exists() {
        eprintln!("[texlive] .xdv exists but no .pdf — running xdvipdfmx manually");
        if let Ok(xdvipdfmx) = find_texlive_binary("xdvipdfmx") {
            let output = std::process::Command::new(&xdvipdfmx)
                .args(["-o", &pdf_path.to_string_lossy()])
                .arg(&xdv_path)
                .current_dir(work_dir)
                .env("PATH", &env_path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .map_err(|e| format!("Failed to launch xdvipdfmx: {}", e))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stderr.trim().is_empty() {
                    eprintln!("[texlive] xdvipdfmx stderr: {}", stderr.trim());
                }
            }
        }
    }

    // Success is determined by whether the PDF exists, not by exit codes.
    // The caller (compile_latex) checks pdf_path.exists() and reads the log for errors.
    Ok(())
}

// --- SyncTeX Native Parser ---

struct SynctexNode {
    tag: u32,
    line: u32,
    h: f64, // PDF points
    v: f64, // PDF points
}

/// Parse synctex data and find the source location closest to (target_x, target_y) on target_page.
fn parse_synctex_data(
    data: &str,
    target_page: u32,
    target_x: f64,
    target_y: f64,
) -> Option<(String, u32, u32)> {
    let mut inputs: HashMap<u32, String> = HashMap::new();
    let mut magnification: f64 = 1000.0;
    let mut unit: f64 = 1.0;
    let mut x_offset: f64 = 0.0;
    let mut y_offset: f64 = 0.0;

    let mut in_content = false;
    let mut on_target_page = false;
    let mut nodes: Vec<SynctexNode> = Vec::new();

    for raw_line in data.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if !in_content {
            if let Some(rest) = line.strip_prefix("Input:") {
                if let Some(colon_pos) = rest.find(':') {
                    if let Ok(tag) = rest[..colon_pos].parse::<u32>() {
                        inputs.insert(tag, rest[colon_pos + 1..].to_string());
                    }
                }
            } else if let Some(rest) = line.strip_prefix("Magnification:") {
                magnification = rest.trim().parse().unwrap_or(1000.0);
            } else if let Some(rest) = line.strip_prefix("Unit:") {
                unit = rest.trim().parse().unwrap_or(1.0);
            } else if let Some(rest) = line.strip_prefix("X Offset:") {
                x_offset = rest.trim().parse().unwrap_or(0.0);
            } else if let Some(rest) = line.strip_prefix("Y Offset:") {
                y_offset = rest.trim().parse().unwrap_or(0.0);
            } else if line == "Content:" {
                in_content = true;
            }
            continue;
        }

        // Content section
        if line.starts_with("Postamble:") {
            break;
        }

        let first_byte = match line.as_bytes().first() {
            Some(b) => *b,
            None => continue,
        };
        match first_byte {
            b'{' => {
                let page: u32 = line.get(1..).and_then(|s| s.parse().ok()).unwrap_or(0);
                on_target_page = page == target_page;
            }
            b'}' => {
                on_target_page = false;
            }
            // Box/node records: [, (, h, v, k, x, g, $
            b'[' | b'(' | b'h' | b'v' | b'k' | b'x' | b'g' | b'$' if on_target_page => {
                // Convert synctex internal units to PDF points (bp)
                // 1 TeX pt = 65536 sp; 1 inch = 72.27 TeX pt = 72 PDF bp
                let factor = unit * magnification / (1000.0 * 65536.0) * 72.0 / 72.27;
                if let Some(node) = line
                    .get(1..)
                    .and_then(|s| parse_synctex_node(s, factor, x_offset, y_offset))
                {
                    nodes.push(node);
                }
            }
            _ => {}
        }
    }

    if nodes.is_empty() {
        return None;
    }

    // Find closest node to (target_x, target_y)
    let mut best_idx = 0;
    let mut best_dist = f64::MAX;
    for (i, node) in nodes.iter().enumerate() {
        let dx = node.h - target_x;
        let dy = node.v - target_y;
        let dist = dx * dx + dy * dy;
        if dist < best_dist {
            best_dist = dist;
            best_idx = i;
        }
    }

    let best = nodes.get(best_idx)?;
    let filename = inputs.get(&best.tag)?.clone();
    Some((filename, best.line, 0))
}

/// Parse a synctex node record (after stripping the type character).
/// Format: `<tag>,<line>,<column>:<h>,<v>[:<W>,<H>,<D>]`
fn parse_synctex_node(s: &str, factor: f64, x_offset: f64, y_offset: f64) -> Option<SynctexNode> {
    let colon_parts: Vec<&str> = s.splitn(4, ':').collect();
    if colon_parts.len() < 2 {
        return None;
    }

    // Parse tag and line (ignore column)
    let first_part = colon_parts.first()?;
    let tlc: Vec<&str> = first_part.splitn(3, ',').collect();
    if tlc.len() < 2 {
        return None;
    }
    let tag: u32 = tlc.first()?.parse().ok()?;
    let line: u32 = tlc.get(1)?.parse().ok()?;

    // Parse h, v coordinates
    let second_part = colon_parts.get(1)?;
    let hv: Vec<&str> = second_part.splitn(2, ',').collect();
    if hv.len() < 2 {
        return None;
    }
    let h_raw: i64 = hv.first()?.parse().ok()?;
    let v_raw: i64 = hv.get(1)?.parse().ok()?;

    let h = h_raw as f64 * factor + x_offset;
    let v = v_raw as f64 * factor + y_offset;

    Some(SynctexNode { tag, line, h, v })
}

// --- Tauri Commands ---

#[derive(serde::Serialize)]
pub struct TexliveStatus {
    pub available: bool,
    pub engines: Vec<String>,
    pub version: Option<String>,
}

#[tauri::command]
pub fn detect_texlive() -> TexliveStatus {
    let engines_to_check = ["pdflatex", "xelatex", "lualatex"];
    let mut found_engines = Vec::new();

    for name in &engines_to_check {
        if find_texlive_binary(name).is_ok() {
            found_engines.push(name.to_string());
        }
    }

    let version = find_texlive_binary("pdflatex").ok().and_then(|path| {
        std::process::Command::new(&path)
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .ok()
            .and_then(|o| {
                let stdout = String::from_utf8_lossy(&o.stdout);
                stdout.lines().next().map(|l| l.to_string())
            })
    });

    TexliveStatus {
        available: !found_engines.is_empty(),
        engines: found_engines,
        version,
    }
}

#[tauri::command]
pub async fn compile_latex(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
    main_file: String,
    use_texlive: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    // Acquire semaphore permit (non-blocking)
    let _permit = state
        .semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Server busy, too many concurrent compilations".to_string())?;

    // Acquire per-project lock to prevent concurrent compilations on the same build dir.
    let project_lock = {
        let mut locks = state.project_locks.lock().await;
        locks
            .entry(project_dir.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _project_guard = project_lock.lock().await;

    let t0 = std::time::Instant::now();
    let use_texlive = use_texlive.unwrap_or(false);

    let main_file_name = Path::new(&main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();

    // Set up build directory (offload blocking I/O to avoid starving the async runtime)
    let work_dir = persistent_build_dir(&project_dir);
    let is_reuse = work_dir.exists();

    {
        let work_dir = work_dir.clone();
        let project_dir = project_dir.clone();
        tokio::task::spawn_blocking(move || {
            if is_reuse {
                sync_source_files(Path::new(&project_dir), &work_dir)
                    .map_err(|e| format!("Failed to sync project: {}", e))
            } else {
                std::fs::create_dir_all(&work_dir)
                    .map_err(|e| format!("Failed to create build dir: {}", e))?;
                copy_dir_recursive(Path::new(&project_dir), &work_dir)
                    .map_err(|e| format!("Failed to copy project: {}", e))
            }
        })
        .await
        .map_err(|e| format!("File sync task panicked: {}", e))??;
    }

    eprintln!(
        "[latex] +{:.0}ms {} ({}, backend={})",
        t0.elapsed().as_millis(),
        if is_reuse {
            "sync source files"
        } else {
            "full copy"
        },
        if is_reuse { "reuse" } else { "first build" },
        if use_texlive { "texlive" } else { "tectonic" }
    );

    // Remove stale PDF so a failed compile doesn't return the previous result.
    let pdf_path = work_dir.join(format!("{}.pdf", main_file_name));
    let _ = std::fs::remove_file(&pdf_path);

    // Verify the main TeX file exists before attempting compilation
    let main_tex_path = work_dir.join(&main_file);
    if !main_tex_path.exists() {
        return Err(format!(
            "Compilation failed\n\nNo .tex file found: \"{}\". Create a document.tex or main.tex file to compile.",
            main_file
        ));
    }

    // Detect TeX engine from magic comment
    let main_tex_content = std::fs::read_to_string(&main_tex_path).unwrap_or_default();
    let engine = detect_tex_engine(&main_tex_content);

    // Save engine name before `engine` is moved into the spawn_blocking closure
    let engine_name_for_label = match &engine {
        Some(TexEngine::XeLaTeX) | None => "xelatex",
        Some(TexEngine::Latex) => "pdflatex",
        Some(TexEngine::LuaLaTeX) => "lualatex",
    };
    let backend_label = if use_texlive {
        format!("TeXLive/{}", engine_name_for_label)
    } else {
        "Tectonic".to_string()
    };

    if !use_texlive {
        if let Some(TexEngine::LuaLaTeX) = engine {
            return Err(
                "Compilation failed\n\nThis document requires LuaLaTeX (% !TEX program = lualatex), \
                 which is not supported. Prism uses a XeTeX-based engine (Tectonic). \
                 Please switch to XeLaTeX or remove the magic comment."
                    .to_string(),
            );
        }
    }

    let compile_result = if use_texlive {
        let work_dir_clone = work_dir.clone();
        let main_file_clone = main_file.clone();
        let result = tokio::task::spawn_blocking(move || {
            lower_thread_priority();
            compile_with_texlive(&work_dir_clone, &main_file_clone, engine, &main_tex_content)
        })
        .await
        .map_err(|e| format!("Compilation task panicked: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms texlive done (ok={})",
            t0.elapsed().as_millis(),
            result.is_ok()
        );
        result
    } else {
        // Run Tectonic in a subprocess to isolate C-level global state (font cache, etc.).
        let work_dir_clone = work_dir.clone();
        let main_file_clone = main_file.clone();
        let result = tokio::task::spawn_blocking(move || {
            lower_thread_priority();
            compile_with_tectonic_subprocess(&work_dir_clone, &main_file_clone)
        })
        .await
        .map_err(|e| format!("Compilation task panicked: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms tectonic done (ok={})",
            t0.elapsed().as_millis(),
            result.is_ok()
        );
        result
    };

    let log_path = work_dir.join(format!("{}.log", main_file_name));

    // Handle "No pages of output" — retry with \AtEndDocument{\null} injection (Tectonic only).
    // TeXLive multi-pass handles this differently; the injection is Tectonic-specific.
    if !use_texlive && !pdf_path.exists() {
        let log_path_clone = log_path.clone();
        let main_tex = work_dir.join(&main_file);
        let pdf_path_clone = pdf_path.clone();
        let main_file_clone = main_file.clone();
        let work_dir_clone = work_dir.clone();

        let needs_retry = tokio::task::spawn_blocking(move || {
            let log_content = std::fs::read_to_string(&log_path_clone).unwrap_or_default();
            if !log_content.contains("No pages of output") || has_real_errors(&log_content) {
                return Ok(false);
            }
            eprintln!("[latex] no pages of output — retrying with \\null injection");
            if let Ok(content) = std::fs::read_to_string(&main_tex) {
                if let Some(pos) = content.find("\\begin{document}") {
                    let modified = format!(
                        "{}\\AtEndDocument{{\\null}}{}",
                        &content[..pos],
                        &content[pos..]
                    );
                    let _ = std::fs::write(&main_tex, &modified);
                    return Ok(true);
                }
            }
            Ok::<bool, String>(false)
        })
        .await
        .map_err(|e| format!("Retry prep panicked: {}", e))??;

        if needs_retry {
            let retry_result = tokio::task::spawn_blocking(move || {
                compile_with_tectonic_subprocess(&work_dir_clone, &main_file_clone)
            })
            .await
            .map_err(|e| format!("Retry task panicked: {}", e))?;
            eprintln!(
                "[latex] empty-body retry: ok={} pdf_exists={}",
                retry_result.is_ok(),
                pdf_path_clone.exists()
            );
        }
    }

    // Store build info
    {
        let mut builds = state.last_builds.lock().await;
        builds.insert(
            project_dir.clone(),
            BuildInfo {
                work_dir: work_dir.clone(),
                main_file_name: main_file_name.clone(),
            },
        );
    }

    if pdf_path.exists() {
        let pdf_path_clone = pdf_path.clone();
        let pdf_bytes = tokio::task::spawn_blocking(move || std::fs::read(&pdf_path_clone))
            .await
            .map_err(|e| format!("PDF read task panicked: {}", e))?
            .map_err(|e| format!("Failed to read PDF: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms total (reuse={}, backend={}) pdf_size={}KB",
            t0.elapsed().as_millis(),
            is_reuse,
            backend_label,
            pdf_bytes.len() / 1024
        );
        Ok(tauri::ipc::Response::new(pdf_bytes))
    } else {
        let log_content = std::fs::read_to_string(&log_path).unwrap_or_default();
        let details = extract_error_lines(&log_content);
        let msg = if details.is_empty() {
            match compile_result {
                Err(e) => e,
                Ok(_) => "Compilation failed: no PDF generated".to_string(),
            }
        } else {
            details
        };
        Err(format!("Compilation failed ({})\n\n{}", backend_label, msg))
    }
}

#[tauri::command]
pub async fn synctex_edit(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SynctexResult, String> {
    let builds = state.last_builds.lock().await;
    let build = builds
        .get(&project_dir)
        .ok_or("No build found for this project")?;

    let synctex_gz = build
        .work_dir
        .join(format!("{}.synctex.gz", build.main_file_name));
    let synctex_plain = build
        .work_dir
        .join(format!("{}.synctex", build.main_file_name));

    let work_dir = build.work_dir.clone();
    drop(builds); // Release lock before I/O

    // Read, decompress, and parse synctex data (blocking I/O + CPU work → offload)
    let (mut file, line, column) = tokio::task::spawn_blocking(move || {
        let synctex_data = if synctex_gz.exists() {
            let compressed = std::fs::read(&synctex_gz)
                .map_err(|e| format!("Failed to read synctex.gz: {}", e))?;
            let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
            let mut data = String::new();
            decoder
                .read_to_string(&mut data)
                .map_err(|e| format!("Failed to decompress synctex: {}", e))?;
            Ok::<_, String>(data)
        } else if synctex_plain.exists() {
            std::fs::read_to_string(&synctex_plain)
                .map_err(|e| format!("Failed to read synctex: {}", e))
        } else {
            Err("No synctex data found. Recompile with synctex enabled.".to_string())
        }?;

        parse_synctex_data(&synctex_data, page, x, y)
            .ok_or_else(|| "Could not resolve source location".to_string())
    })
    .await
    .map_err(|e| format!("Synctex task panicked: {}", e))??;

    // Normalize: strip work_dir prefix and "./" or ".\\" prefix
    let work_dir_str = work_dir.to_string_lossy().to_string();
    if let Some(rest) = file.strip_prefix(&format!("{}/", work_dir_str)) {
        file = rest.to_string();
    } else if let Some(rest) = file.strip_prefix(&format!("{}\\", work_dir_str)) {
        file = rest.to_string();
    }
    if let Some(rest) = file.strip_prefix("./") {
        file = rest.to_string();
    } else if let Some(rest) = file.strip_prefix(".\\") {
        file = rest.to_string();
    }

    Ok(SynctexResult { file, line, column })
}

/// Clear in-memory build state on app exit.
/// Persistent build directories are intentionally kept for fast restart.
pub async fn cleanup_all_builds(state: &LatexCompilerState) {
    let mut builds = state.last_builds.lock().await;
    builds.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- detect_bib_tool ---

    #[test]
    fn test_detect_bib_tool_biber() {
        let content = "\\documentclass{article}\n\\usepackage{biblatex}\n\\begin{document}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::Biber);
    }

    #[test]
    fn test_detect_bib_tool_biblatex_with_options() {
        let content = "\\documentclass{article}\n\\usepackage[style=apa,backend=biber]{biblatex}\n\\begin{document}";
        assert_eq!(detect_bib_tool(content), BibTool::Biber);
    }

    #[test]
    fn test_detect_bib_tool_bibtex() {
        let content = "\\documentclass{article}\n\\bibliography{refs}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::BibTeX);
    }

    #[test]
    fn test_detect_bib_tool_addbibresource() {
        let content = "\\documentclass{article}\n\\addbibresource{refs.bib}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::BibTeX);
    }

    #[test]
    fn test_detect_bib_tool_none() {
        let content = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::None);
    }

    #[test]
    fn test_detect_bib_tool_commented_out() {
        let content = "\\documentclass{article}\n% \\bibliography{refs}\n% \\usepackage{biblatex}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::None);
    }

    // --- extract_error_lines ---

    #[test]
    fn test_extract_error_lines_empty_log() {
        assert_eq!(extract_error_lines(""), "");
    }

    #[test]
    fn test_extract_error_lines_no_pages() {
        let log = "Some preamble\nNo pages of output.\nSome trailing";
        let result = extract_error_lines(log);
        assert_eq!(
            result,
            "No pages of output. Add visible content to the document body."
        );
    }

    #[test]
    fn test_extract_error_lines_with_errors() {
        let log = "line 1\n! Undefined control sequence.\nline 3\n! Missing $ inserted.\nline 5";
        let result = extract_error_lines(log);
        assert!(result.contains("Undefined control sequence"));
        assert!(result.contains("Missing $ inserted"));
    }

    #[test]
    fn test_extract_error_lines_error_colon() {
        let log = "stuff\nLatex Error: Bad math environment\nmore stuff";
        let result = extract_error_lines(log);
        assert!(result.contains("Error:"));
    }

    #[test]
    fn test_extract_error_lines_no_errors_returns_tail() {
        let log = "a".repeat(1000);
        let result = extract_error_lines(&log);
        // Should return last 500 chars
        assert_eq!(result.len(), 500);
    }

    #[test]
    fn test_extract_error_lines_limits_to_10() {
        let mut log = String::new();
        for i in 0..20 {
            log.push_str(&format!("! Error number {}\n", i));
        }
        let result = extract_error_lines(&log);
        let count = result.lines().count();
        assert!(count <= 10);
    }

    // --- persistent_build_dir ---

    #[test]
    fn test_persistent_build_dir() {
        let dir = persistent_build_dir("/Users/dev/my-project");
        assert_eq!(dir, PathBuf::from("/Users/dev/my-project/.prism/build"));
    }

    // --- parse_synctex_node ---

    #[test]
    fn test_parse_synctex_node_basic() {
        // Format: tag,line,column:h,v
        let node = parse_synctex_node("1,42,0:1000,2000", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let node = node.unwrap();
        assert_eq!(node.tag, 1);
        assert_eq!(node.line, 42);
        assert_eq!(node.h, 1000.0);
        assert_eq!(node.v, 2000.0);
    }

    #[test]
    fn test_parse_synctex_node_with_dimensions() {
        // Format: tag,line,column:h,v:W,H,D
        let node = parse_synctex_node("3,10,0:500,600:100,20,5", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let node = node.unwrap();
        assert_eq!(node.tag, 3);
        assert_eq!(node.line, 10);
    }

    #[test]
    fn test_parse_synctex_node_with_offset() {
        let node = parse_synctex_node("1,1,0:0,0", 1.0, 10.0, 20.0);
        let node = node.unwrap();
        assert_eq!(node.h, 10.0); // 0 * 1.0 + 10.0
        assert_eq!(node.v, 20.0); // 0 * 1.0 + 20.0
    }

    #[test]
    fn test_parse_synctex_node_invalid_missing_colon() {
        assert!(parse_synctex_node("1,1,0", 1.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn test_parse_synctex_node_invalid_missing_comma() {
        assert!(parse_synctex_node("1:100,200", 1.0, 0.0, 0.0).is_none());
    }

    // --- parse_synctex_data ---

    #[test]
    fn test_parse_synctex_data_basic() {
        let data = "\
SyncTeX Version:1
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000:500,100,0
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 50.0, 50.0);
        assert!(result.is_some());
        let (file, line, _col) = result.unwrap();
        assert_eq!(file, "./main.tex");
        assert_eq!(line, 5);
    }

    #[test]
    fn test_parse_synctex_data_wrong_page() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000
}1
Postamble:
";
        // Looking for page 2 but data only has page 1
        let result = parse_synctex_data(data, 2, 50.0, 50.0);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_synctex_data_closest_node() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,10,0:0,0
h1,20,0:100000000,100000000
}1
Postamble:
";
        // (0, 0) is closer to the first node
        let result = parse_synctex_data(data, 1, 0.0, 0.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 10);
    }

    #[test]
    fn test_parse_synctex_data_empty() {
        let result = parse_synctex_data("", 1, 0.0, 0.0);
        assert!(result.is_none());
    }

    // --- extract_error_lines additional edge cases ---

    #[test]
    fn test_extract_error_lines_mixed_error_formats() {
        let log = "preamble\n! LaTeX Error: File not found.\nl.42 \\input{missing}\nerror: compilation stopped";
        let result = extract_error_lines(log);
        assert!(result.contains("LaTeX Error"));
        assert!(result.contains("error: compilation stopped"));
    }

    #[test]
    fn test_extract_error_lines_short_log_no_errors() {
        let log = "This is a short log without errors";
        let result = extract_error_lines(log);
        // Short log (< 500 chars) returned as tail
        assert_eq!(result, log);
    }

    // --- parse_synctex_node additional edge cases ---

    #[test]
    fn test_parse_synctex_node_negative_coordinates() {
        let node = parse_synctex_node("1,1,0:-500,300", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let n = node.unwrap();
        assert_eq!(n.h, -500.0);
        assert_eq!(n.v, 300.0);
    }

    #[test]
    fn test_parse_synctex_node_factor_scaling() {
        // factor=2.0 should double the coordinates
        let node = parse_synctex_node("1,1,0:100,200", 2.0, 0.0, 0.0);
        let n = node.unwrap();
        assert_eq!(n.h, 200.0);
        assert_eq!(n.v, 400.0);
    }

    #[test]
    fn test_parse_synctex_node_zero_tag_and_line() {
        let node = parse_synctex_node("0,0,0:0,0", 1.0, 0.0, 0.0);
        let n = node.unwrap();
        assert_eq!(n.tag, 0);
        assert_eq!(n.line, 0);
    }

    // --- parse_synctex_data additional edge cases ---

    #[test]
    fn test_parse_synctex_data_multiple_inputs() {
        let data = "\
Input:1:./main.tex
Input:2:./chapter1.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h2,15,0:500,500
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 0.0, 0.0);
        assert!(result.is_some());
        let (file, line, _) = result.unwrap();
        assert_eq!(file, "./chapter1.tex");
        assert_eq!(line, 15);
    }

    #[test]
    fn test_parse_synctex_data_multiple_pages() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:100,100
}1
{2
h1,25,0:200,200
}2
Postamble:
";
        let result = parse_synctex_data(data, 2, 200.0, 200.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 25);
    }

    // --- extract_error_lines: real errors take priority over "No pages of output" ---

    #[test]
    fn test_extract_error_lines_real_errors_over_no_pages() {
        let log = "Some preamble\n! LaTeX Error: File `missing.sty' not found.\nNo pages of output.\nMore stuff";
        let result = extract_error_lines(log);
        assert!(
            result.contains("LaTeX Error"),
            "real error should be shown, got: {}",
            result
        );
        assert!(
            !result.contains("Add visible content"),
            "No pages fallback should NOT appear"
        );
    }

    // --- has_real_errors ---

    #[test]
    fn test_has_real_errors_with_bang() {
        assert!(has_real_errors("ok\n! Undefined control sequence.\nmore"));
    }

    #[test]
    fn test_has_real_errors_with_error_colon() {
        assert!(has_real_errors("LaTeX Error: Bad math\nstuff"));
    }

    #[test]
    fn test_has_real_errors_none() {
        assert!(!has_real_errors("This is pdfTeX\nNo pages of output.\n"));
    }

    // --- detect_tex_engine ---

    #[test]
    fn test_detect_tex_engine_xelatex() {
        let content = "% !TEX program = xelatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_pdflatex() {
        let content = "% !TEX program = pdflatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::Latex));
    }

    #[test]
    fn test_detect_tex_engine_lualatex() {
        let content = "% !TEX program = lualatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::LuaLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_none() {
        let content = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n";
        assert_eq!(detect_tex_engine(content), None);
    }

    #[test]
    fn test_detect_tex_engine_case_insensitive() {
        let content = "% !TEX program = XeLaTeX\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_no_spaces() {
        let content = "%!TEX program=xelatex\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    // --- persistent_build_dir edge case ---

    #[test]
    fn test_persistent_build_dir_trailing_slash() {
        let dir = persistent_build_dir("/project/");
        assert_eq!(dir, PathBuf::from("/project/.prism/build"));
    }

    // --- copy_dir_recursive integration tests ---

    #[test]
    fn test_copy_dir_recursive_nested() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Create nested structure
        std::fs::create_dir_all(src.path().join("sub").join("deep")).unwrap();
        std::fs::write(src.path().join("top.tex"), "top").unwrap();
        std::fs::write(src.path().join("sub").join("mid.tex"), "mid").unwrap();
        std::fs::write(
            src.path().join("sub").join("deep").join("bottom.tex"),
            "bottom",
        )
        .unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("top.tex")).unwrap(),
            "top"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("mid.tex")).unwrap(),
            "mid"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("deep").join("bottom.tex"))
                .unwrap(),
            "bottom"
        );
    }

    #[test]
    fn test_copy_dir_recursive_skips_hidden_dirs() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join(".git")).unwrap();
        std::fs::write(src.path().join(".git").join("config"), "secret").unwrap();
        std::fs::write(src.path().join("main.tex"), "doc").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert!(!dst.path().join(".git").exists(), ".git should be skipped");
    }

    #[test]
    fn test_copy_dir_recursive_empty_subdir() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("empty_sub")).unwrap();
        std::fs::write(src.path().join("a.tex"), "a").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("empty_sub").exists());
        assert!(dst.path().join("empty_sub").is_dir());
    }

    // --- sync_source_files integration tests ---

    #[test]
    fn test_sync_source_files_copies_sources() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("refs.bib"), "bib").unwrap();
        std::fs::write(src.path().join("style.sty"), "sty").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("main.tex")).unwrap(),
            "doc"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("refs.bib")).unwrap(),
            "bib"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("style.sty")).unwrap(),
            "sty"
        );
    }

    #[test]
    fn test_sync_source_files_skips_artifacts() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("main.aux"), "aux").unwrap();
        std::fs::write(src.path().join("main.log"), "log").unwrap();
        std::fs::write(src.path().join("main.synctex.gz"), "sync").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert!(!dst.path().join("main.aux").exists());
        assert!(!dst.path().join("main.log").exists());
        assert!(!dst.path().join("main.synctex.gz").exists());
    }

    #[test]
    fn test_sync_source_files_recursive_and_skips_hidden() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("chapters")).unwrap();
        std::fs::create_dir_all(src.path().join(".claudeprism")).unwrap();
        std::fs::write(src.path().join("chapters").join("ch1.tex"), "ch1").unwrap();
        std::fs::write(src.path().join("chapters").join("ch1.aux"), "aux").unwrap();
        std::fs::write(src.path().join(".claudeprism").join("data"), "data").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("chapters").join("ch1.tex")).unwrap(),
            "ch1"
        );
        assert!(!dst.path().join("chapters").join("ch1.aux").exists());
        assert!(!dst.path().join(".claudeprism").exists());
    }

    // --- sync_source_files copies figure PDFs ---

    #[test]
    fn test_sync_source_files_copies_figure_pdfs() {
        // .pdf files (e.g. figures) must be synced — they are NOT artifacts.
        // The output PDF is managed by compile_latex (explicit remove_file).
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("figures")).unwrap();
        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("figures").join("chart.pdf"), "pdf figure").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert_eq!(
            std::fs::read_to_string(dst.path().join("figures").join("chart.pdf")).unwrap(),
            "pdf figure"
        );
    }

    #[test]
    fn test_sync_source_files_overwrites_changed_tex_content() {
        // Regression: when a user empties a file, sync must overwrite
        // the old content in the build dir with the empty content.
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Old content in build dir
        std::fs::write(dst.path().join("main.tex"), "old content").unwrap();
        // User emptied the file
        std::fs::write(src.path().join("main.tex"), "").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("main.tex")).unwrap(),
            ""
        );
    }

    // --- persistent_build_dir ---

    #[test]
    fn test_stale_pdf_removal_pattern() {
        // Simulates the pattern used in compile_latex: remove stale PDF
        // before compilation so a failed compile doesn't return old results.
        let build_dir = tempfile::tempdir().unwrap();
        let pdf_path = build_dir.path().join("document.pdf");

        // Simulate previous successful build left a PDF
        std::fs::write(&pdf_path, "old pdf data").unwrap();
        assert!(pdf_path.exists());

        // This is what compile_latex does before running tectonic
        let _ = std::fs::remove_file(&pdf_path);
        assert!(!pdf_path.exists());

        // If compilation fails, pdf_path.exists() is false → error returned
    }

    #[test]
    fn test_stale_pdf_removal_no_existing_file() {
        // remove_file on a non-existent path should not panic (we use let _ =)
        let build_dir = tempfile::tempdir().unwrap();
        let pdf_path = build_dir.path().join("document.pdf");

        assert!(!pdf_path.exists());
        let result = std::fs::remove_file(&pdf_path);
        // It's an error but we ignore it with let _ =
        assert!(result.is_err());
    }
}
