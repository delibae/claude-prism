use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

const MAX_CONCURRENT: usize = 3;
const COMPILE_TIMEOUT_SECS: u64 = 30;

struct BuildInfo {
    work_dir: PathBuf,
    main_file_name: String, // stem without extension, e.g. "document"
    aux_hash: Option<u64>,  // hash of .aux file from last build (for single-pass optimization)
    preamble_hash: Option<u64>, // hash of preamble text (for format regeneration)
    fmt_ok: bool,               // whether .fmt was successfully generated
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

// CompileResult is no longer needed — compile_latex returns raw PDF bytes via Response.

#[derive(serde::Serialize)]
pub struct SynctexResult {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

// --- Helpers ---

struct CommandOutput {
    exit_code: i32,
    timed_out: bool,
    stdout: String,
    stderr: String,
}

/// Build an augmented PATH that includes common TeX installation directories.
/// GUI apps don't always inherit the user's shell PATH, so pdflatex etc. won't be found.
fn tex_path() -> String {
    let mut path = std::env::var("PATH").unwrap_or_default();

    #[cfg(target_os = "macos")]
    let (extras, sep) = (
        vec![
            "/Library/TeX/texbin".to_string(),
            "/usr/local/texlive/2024/bin/universal-darwin".to_string(),
            "/usr/local/texlive/2023/bin/universal-darwin".to_string(),
            "/usr/texbin".to_string(),
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
        ],
        ":",
    );

    #[cfg(target_os = "windows")]
    let (extras, sep) = ({
        let mut v = vec![
            "C:\\texlive\\2024\\bin\\windows".to_string(),
            "C:\\texlive\\2023\\bin\\windows".to_string(),
            "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64".to_string(),
        ];
        // Also check user-local MiKTeX
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            v.push(format!("{}\\Programs\\MiKTeX\\miktex\\bin\\x64", localappdata));
        }
        v
    }, ";");

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let (extras, sep): (Vec<String>, &str) = (
        vec![
            "/usr/local/texlive/2024/bin/x86_64-linux".to_string(),
            "/usr/local/texlive/2023/bin/x86_64-linux".to_string(),
            "/usr/local/bin".to_string(),
        ],
        ":",
    );

    for extra in &extras {
        if Path::new(extra).exists() && !path.contains(extra.as_str()) {
            path = format!("{}{}{}", extra, sep, path);
        }
    }
    path
}

async fn run_with_timeout(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout_secs: u64,
) -> Result<CommandOutput, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("PATH", tex_path());

    #[cfg(not(target_os = "windows"))]
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }
    #[cfg(target_os = "windows")]
    if let Ok(home) = std::env::var("USERPROFILE") {
        cmd.env("USERPROFILE", home);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", program, e))?;

    match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => Ok(CommandOutput {
            exit_code: output.status.code().unwrap_or(-1),
            timed_out: false,
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        }),
        Ok(Err(e)) => Err(format!("Process error: {}", e)),
        Err(_) => Ok(CommandOutput {
            exit_code: -1,
            timed_out: true,
            stdout: String::new(),
            stderr: "Compilation timed out".to_string(),
        }),
    }
}

fn extract_error_lines(log: &str) -> String {
    if log.is_empty() {
        return String::new();
    }

    if log.lines().any(|l| l.contains("No pages of output")) {
        return "No pages of output. Add visible content to the document body.".to_string();
    }

    let error_lines: Vec<&str> = log
        .lines()
        .filter(|l| l.starts_with('!') || l.contains("Error:") || l.contains("error:"))
        .take(10)
        .collect();

    if error_lines.is_empty() {
        let start = log.len().saturating_sub(500);
        log[start..].to_string()
    } else {
        error_lines.join("\n")
    }
}

fn has_bib_files(dir: &Path) -> bool {
    fn check(dir: &Path) -> bool {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return false,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if check(&path) {
                    return true;
                }
            } else if path.extension().map(|e| e == "bib").unwrap_or(false) {
                return true;
            }
        }
        false
    }
    check(dir)
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

/// Sync only source files (.tex, .bib, .sty, .cls, .bst, images) from project to build dir.
/// Skips build artifacts (.aux, .log, .toc, .pdf, .synctex.gz, etc.) to preserve them.
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
            let is_artifact = matches!(ext, "aux" | "log" | "toc" | "lof" | "lot" | "out"
                | "nav" | "snm" | "vrb" | "bbl" | "blg" | "fls" | "fdb_latexmk"
                | "synctex" | "pdf" | "idx" | "ind" | "ilg" | "glo" | "gls" | "glg");
            let is_synctex = src_path.to_string_lossy().ends_with(".synctex.gz");
            if !is_artifact && !is_synctex {
                std::fs::copy(&src_path, &dst_path)?;
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

/// Recover preamble hash from on-disk `_prism_preamble.tex` (has `\dump\n` suffix).
fn recover_preamble_hash(work_dir: &Path) -> Option<u64> {
    let preamble_tex = work_dir.join("_prism_preamble.tex");
    if !preamble_tex.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&preamble_tex).ok()?;
    let preamble = content
        .strip_suffix("\\dump\n")
        .or_else(|| content.strip_suffix("\\dump"))
        .unwrap_or(&content);
    Some(hash_string(preamble))
}

/// Hash a string (for preamble change detection).
fn hash_string(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

/// Extract preamble info from a .tex file.
/// Returns (preamble_text, byte_pos_of_begin_document, newline_count_in_preamble).
fn extract_preamble_info(content: &str) -> Option<(String, usize, usize)> {
    let marker = "\\begin{document}";
    if let Some(pos) = content.find(marker) {
        let preamble = content[..pos].to_string();
        let newlines = content[..pos].chars().filter(|&c| c == '\n').count();
        Some((preamble, pos, newlines))
    } else {
        None
    }
}

/// Try to generate a pre-compiled format (.fmt) from the preamble.
/// Returns true if the format was successfully generated.
async fn try_generate_format(
    preamble: &str,
    work_dir: &Path,
    compiler_cmd: &str,
) -> bool {
    // Write preamble + \dump to a temp .tex file
    let preamble_path = work_dir.join("_prism_preamble.tex");
    let dump_content = format!("{}\\dump\n", preamble);
    if std::fs::write(&preamble_path, &dump_content).is_err() {
        eprintln!("[latex] failed to write format preamble file");
        return false;
    }

    let ini_load = format!("&{}", compiler_cmd);
    match run_with_timeout(
        compiler_cmd,
        &["-ini", "-jobname=_prism_fmt", &ini_load, "_prism_preamble.tex"],
        work_dir,
        COMPILE_TIMEOUT_SECS,
    )
    .await
    {
        Ok(result) => {
            let fmt_path = work_dir.join("_prism_fmt.fmt");
            if fmt_path.exists() {
                let size = std::fs::metadata(&fmt_path).map(|m| m.len()).unwrap_or(0);
                eprintln!(
                    "[latex] format generated ({} bytes, exit={})",
                    size, result.exit_code
                );
                true
            } else {
                eprintln!(
                    "[latex] format generation failed (exit={}, no .fmt)",
                    result.exit_code
                );
                if !result.stderr.is_empty() {
                    let n = result.stderr.len().min(300);
                    eprintln!("[latex] fmt stderr: {}", &result.stderr[..n]);
                }
                false
            }
        }
        Err(e) => {
            eprintln!("[latex] format generation error: {}", e);
            false
        }
    }
}

/// Write a body file with padding comment lines to preserve line numbers.
/// The body file starts with `newline_count` padding lines, then \begin{document}...
/// For pdflatex, injects `\pdfcompresslevel=0` to speed up PDF generation.
/// Always injects `\AtEndDocument{\null}` to guarantee at least one page of output
/// (prevents "No pages of output" for empty document bodies).
fn write_body_file(
    content: &str,
    begin_doc_pos: usize,
    newline_count: usize,
    work_dir: &Path,
    compiler: &str,
) -> std::io::Result<()> {
    let body = &content[begin_doc_pos..];
    // Inject before \begin{document}:
    // - pdfcompresslevel=0 for faster PDF generation (pdflatex only)
    // - \AtEndDocument{\null} to ensure at least one page of output
    let inject = if compiler == "pdflatex" {
        "\\pdfcompresslevel=0 \\pdfobjcompresslevel=0 \\AtEndDocument{\\null}\n"
    } else {
        "\\AtEndDocument{\\null}\n"
    };
    let mut result = String::with_capacity(body.len() + newline_count * 2 + 80);
    if newline_count > 1 {
        for _ in 0..newline_count - 1 {
            result.push_str("%\n");
        }
        result.push_str(inject);
    } else if newline_count == 1 {
        result.push_str(inject);
    } else {
        // newline_count == 0: no padding room, inject on its own line
        result.push_str(inject);
    }
    result.push_str(body);
    std::fs::write(work_dir.join("_prism_body.tex"), &result)
}

/// Hash the contents of a file (for aux-file change detection).
fn hash_file(path: &Path) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let data = std::fs::read(path).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    Some(hasher.finish())
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn compile_latex(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
    main_file: String,
    compiler: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    // Acquire semaphore permit (non-blocking)
    let _permit = state
        .semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Server busy, too many concurrent compilations".to_string())?;

    // Acquire per-project lock to prevent concurrent compilations on the same build dir.
    // This serializes compilations for the same project while allowing different projects
    // to compile in parallel.
    let project_lock = {
        let mut locks = state.project_locks.lock().await;
        locks
            .entry(project_dir.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _project_guard = project_lock.lock().await;

    let t0 = std::time::Instant::now();

    let compiler_cmd = match compiler.as_deref() {
        Some("xelatex") => "xelatex",
        Some("lualatex") => "lualatex",
        _ => "pdflatex",
    };

    let main_file_name = Path::new(&main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();

    // Reuse existing build directory: check in-memory cache, then persistent disk cache
    let (work_dir, prev_aux_hash, prev_preamble_hash, prev_fmt_ok, is_reuse) = {
        let builds = state.last_builds.lock().await;
        if let Some(prev) = builds.get(&project_dir) {
            if prev.work_dir.exists() {
                // In-memory cache hit
                (
                    prev.work_dir.clone(),
                    prev.aux_hash,
                    prev.preamble_hash,
                    prev.fmt_ok,
                    true,
                )
            } else {
                (PathBuf::new(), None, None, false, false)
            }
        } else {
            // Check persistent disk cache (survives app restarts)
            let persistent = persistent_build_dir(&project_dir);
            if persistent.exists() {
                let aux_hash =
                    hash_file(&persistent.join(format!("{}.aux", main_file_name)));
                let preamble_hash = recover_preamble_hash(&persistent);
                let fmt_ok = persistent.join("_prism_fmt.fmt").exists();
                eprintln!(
                    "[latex] recovered persistent cache (fmt={}, aux={}, preamble={})",
                    fmt_ok,
                    aux_hash.is_some(),
                    preamble_hash.is_some()
                );
                (persistent, aux_hash, preamble_hash, fmt_ok, true)
            } else {
                (PathBuf::new(), None, None, false, false)
            }
        }
    };

    let work_dir = if is_reuse {
        // Sync only source files, preserving build artifacts (.aux, .toc, .fmt, etc.)
        sync_source_files(Path::new(&project_dir), &work_dir)
            .map_err(|e| format!("Failed to sync project: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms sync source files (reuse)",
            t0.elapsed().as_millis()
        );
        work_dir
    } else {
        // First build ever: create persistent build directory
        let work_dir = persistent_build_dir(&project_dir);
        std::fs::create_dir_all(&work_dir)
            .map_err(|e| format!("Failed to create build dir: {}", e))?;
        copy_dir_recursive(Path::new(&project_dir), &work_dir)
            .map_err(|e| format!("Failed to copy project: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms full copy (first build)",
            t0.elapsed().as_millis()
        );
        work_dir
    };

    // Pre-compiled format optimization: cache preamble loading in .fmt file
    let main_tex_path = work_dir.join(&main_file);
    let tex_content = std::fs::read_to_string(&main_tex_path).unwrap_or_default();

    let (use_fmt, new_preamble_hash) =
        if let Some((preamble, begin_doc_pos, newline_count)) =
            extract_preamble_info(&tex_content)
        {
            let p_hash = hash_string(&preamble);
            let fmt_path = work_dir.join("_prism_fmt.fmt");

            let need_regen = !(is_reuse
                && prev_preamble_hash == Some(p_hash)
                && fmt_path.exists()
                && prev_fmt_ok);

            if need_regen {
                eprintln!("[latex] preamble changed or no format — generating .fmt");
                let t_fmt = std::time::Instant::now();
                let ok = try_generate_format(&preamble, &work_dir, compiler_cmd).await;
                eprintln!(
                    "[latex] +{:.0}ms format generation (ok={})",
                    t_fmt.elapsed().as_millis(),
                    ok
                );
                if ok {
                    write_body_file(&tex_content, begin_doc_pos, newline_count, &work_dir, compiler_cmd)
                        .map_err(|e| format!("Failed to write body file: {}", e))?;
                    (true, Some(p_hash))
                } else {
                    (false, Some(p_hash))
                }
            } else {
                // Format cached and valid — just update body file (content may have changed)
                write_body_file(&tex_content, begin_doc_pos, newline_count, &work_dir, compiler_cmd)
                    .map_err(|e| format!("Failed to write body file: {}", e))?;
                eprintln!("[latex] reusing cached format");
                (true, Some(p_hash))
            }
        } else {
            (false, None)
        };

    eprintln!(
        "[latex] +{:.0}ms format setup (use_fmt={})",
        t0.elapsed().as_millis(),
        use_fmt
    );

    // Detect .bib files
    let has_bib = has_bib_files(&work_dir);

    // Build compilation arguments
    let fmt_arg = "-fmt=_prism_fmt".to_string();
    let jobname_arg = format!("-jobname={}", main_file_name);
    let latex_args: Vec<&str> = if use_fmt {
        vec![
            "-interaction=nonstopmode",
            "-synctex=1",
            &fmt_arg,
            &jobname_arg,
            "_prism_body.tex",
        ]
    } else {
        vec!["-interaction=nonstopmode", "-synctex=1", &main_file]
    };

    let mut last_result;
    let mut pass_count = 0;

    // Pass 1 — always needed
    last_result =
        run_with_timeout(compiler_cmd, &latex_args, &work_dir, COMPILE_TIMEOUT_SECS).await?;
    pass_count += 1;
    eprintln!("[latex] +{:.0}ms pass {} done (exit={})", t0.elapsed().as_millis(), pass_count, last_result.exit_code);
    if last_result.timed_out {
        return Err("Compilation timed out".to_string());
    }

    // Decide whether extra passes are needed
    let aux_path = work_dir.join(format!("{}.aux", main_file_name));
    let aux_hash_after_pass1 = hash_file(&aux_path);
    let aux_stable = prev_aux_hash.is_some() && aux_hash_after_pass1 == prev_aux_hash;

    // Check .log for rerun warnings — avoids unnecessary pass 2 even on first build
    let log_path = work_dir.join(format!("{}.log", main_file_name));
    let log_after_pass1 = std::fs::read_to_string(&log_path).unwrap_or_default();
    let needs_rerun = log_after_pass1.contains("Rerun to get")
        || log_after_pass1.contains("Rerun LaTeX")
        || log_after_pass1.contains("Label(s) may have changed");

    eprintln!(
        "[latex] aux_stable={} needs_rerun={} prev_hash={:?} new_hash={:?}",
        aux_stable, needs_rerun, prev_aux_hash, aux_hash_after_pass1
    );

    if !aux_stable && needs_rerun {
        if has_bib {
            // BibTeX + 2 more passes
            if aux_path.exists() {
                last_result = run_with_timeout(
                    "bibtex",
                    &[main_file_name.as_str()],
                    &work_dir,
                    COMPILE_TIMEOUT_SECS,
                )
                .await?;
                eprintln!("[latex] +{:.0}ms bibtex done (exit={})", t0.elapsed().as_millis(), last_result.exit_code);
                if last_result.timed_out {
                    return Err("BibTeX timed out".to_string());
                }
            }
            for _ in 0..2 {
                last_result =
                    run_with_timeout(compiler_cmd, &latex_args, &work_dir, COMPILE_TIMEOUT_SECS)
                        .await?;
                pass_count += 1;
                eprintln!("[latex] +{:.0}ms pass {} done (exit={})", t0.elapsed().as_millis(), pass_count, last_result.exit_code);
                if last_result.timed_out {
                    return Err("Compilation timed out".to_string());
                }
            }
        } else {
            // One more pass to resolve cross-references
            last_result =
                run_with_timeout(compiler_cmd, &latex_args, &work_dir, COMPILE_TIMEOUT_SECS)
                    .await?;
            pass_count += 1;
            eprintln!("[latex] +{:.0}ms pass {} done (exit={})", t0.elapsed().as_millis(), pass_count, last_result.exit_code);
            if last_result.timed_out {
                return Err("Compilation timed out".to_string());
            }
        }
    } else {
        eprintln!("[latex] skipping extra passes (aux_stable={}, needs_rerun={})", aux_stable, needs_rerun);
    }

    // Final aux hash for next compilation
    let final_aux_hash = hash_file(&aux_path);
    eprintln!("[latex] +{:.0}ms total ({} passes, reuse={}, bib={})", t0.elapsed().as_millis(), pass_count, is_reuse, has_bib);

    // Re-read log file (may have been updated by extra passes)
    let log_content = std::fs::read_to_string(&log_path).unwrap_or_default();

    // Check for PDF; if "No pages of output", retry with \null injection.
    // This handles the non-format path (empty documents compiled directly).
    // The format path already injects \AtEndDocument{\null} via write_body_file.
    let pdf_path = work_dir.join(format!("{}.pdf", main_file_name));
    if !pdf_path.exists() && log_content.contains("No pages of output") {
        eprintln!("[latex] no pages of output — retrying with \\null injection");
        let null_input = format!("\\AtEndDocument{{\\null}}\\input{{{}}}", main_file);
        let jobname_arg = format!("-jobname={}", main_file_name);
        let retry_args: Vec<&str> =
            vec!["-interaction=nonstopmode", "-synctex=1", &jobname_arg, &null_input];
        match run_with_timeout(compiler_cmd, &retry_args, &work_dir, COMPILE_TIMEOUT_SECS).await {
            Ok(r) => eprintln!("[latex] empty-body retry: exit={} pdf_exists={}", r.exit_code, pdf_path.exists()),
            Err(e) => eprintln!("[latex] empty-body retry error: {}", e),
        }
    }

    // Store build info (even on failure, for debugging / synctex)
    let store_build = |builds: &mut HashMap<String, BuildInfo>| {
        builds.insert(
            project_dir.clone(),
            BuildInfo {
                work_dir: work_dir.clone(),
                main_file_name: main_file_name.clone(),
                aux_hash: final_aux_hash,
                preamble_hash: new_preamble_hash,
                fmt_ok: use_fmt,
            },
        );
    };

    if pdf_path.exists() {
        let pdf_bytes = std::fs::read(&pdf_path)
            .map_err(|e| format!("Failed to read PDF: {}", e))?;
        let mut builds = state.last_builds.lock().await;
        store_build(&mut builds);
        Ok(tauri::ipc::Response::new(pdf_bytes))
    } else {
        let mut builds = state.last_builds.lock().await;
        store_build(&mut builds);

        let details = extract_error_lines(&log_content);
        let fallback = if last_result.stderr.is_empty() {
            let s = &last_result.stdout;
            let start = s.len().saturating_sub(500);
            s[start..].to_string()
        } else {
            last_result.stderr
        };
        let msg = if details.is_empty() { fallback } else { details };
        Err(format!("Compilation failed\n\n{}", msg))
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

    // Verify synctex data exists
    let synctex_gz = build
        .work_dir
        .join(format!("{}.synctex.gz", build.main_file_name));
    let synctex_plain = build
        .work_dir
        .join(format!("{}.synctex", build.main_file_name));
    if !synctex_gz.exists() && !synctex_plain.exists() {
        return Err("No synctex data found. Recompile with synctex enabled.".to_string());
    }

    let pdf_file = format!("{}.pdf", build.main_file_name);
    let coord_arg = format!("{}:{}:{}:{}", page, x, y, pdf_file);
    let work_dir = build.work_dir.clone();
    let main_file_name = build.main_file_name.clone();
    drop(builds); // Release lock before spawning process

    let result = run_with_timeout("synctex", &["edit", "-o", &coord_arg], &work_dir, 10).await?;

    if result.exit_code != 0 {
        return Err(format!("synctex failed: {}", result.stderr));
    }

    // Parse synctex output
    let mut file = String::new();
    let mut line = 0u32;
    let mut column = 0u32;

    for l in result.stdout.lines() {
        let trimmed = l.trim();
        if let Some(rest) = trimmed.strip_prefix("Input:") {
            file = rest.to_string();
        } else if let Some(rest) = trimmed.strip_prefix("Line:") {
            line = rest.parse().unwrap_or(0);
        } else if let Some(rest) = trimmed.strip_prefix("Column:") {
            column = rest.parse::<i32>().unwrap_or(0).max(0) as u32;
        }
    }

    if file.is_empty() || line == 0 {
        return Err("Could not resolve source location".to_string());
    }

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

    // Map format body file back to original main file
    if file == "_prism_body.tex" {
        file = format!("{}.tex", main_file_name);
    }

    Ok(SynctexResult { file, line, column })
}

/// Clear in-memory build state on app exit.
/// Persistent build directories are intentionally kept for fast restart.
pub async fn cleanup_all_builds(state: &LatexCompilerState) {
    let mut builds = state.last_builds.lock().await;
    builds.clear();
}
