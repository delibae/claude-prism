use git2::{DiffOptions, IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature, Sort};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

// ─── Types ───

#[derive(Serialize, Clone)]
pub struct SnapshotInfo {
    pub id: String,
    pub message: String,
    pub timestamp: i64,
    pub labels: Vec<String>,
    pub changed_files: Vec<String>,
}

#[derive(Serialize)]
pub struct FileDiff {
    pub file_path: String,
    pub status: String, // "added" | "modified" | "deleted"
    pub old_content: Option<String>,
    pub new_content: Option<String>,
}

// ─── Helpers ───

fn history_path(project_root: &str) -> PathBuf {
    Path::new(project_root)
        .join(".claudeprism")
        .join("history.git")
}

fn open_repo(project_root: &str) -> Result<Repository, String> {
    let git_dir = history_path(project_root);
    Repository::open(&git_dir).map_err(|e| format!("Failed to open history repo: {}", e))
}

fn default_signature() -> Result<Signature<'static>, String> {
    Signature::now("ClaudePrism", "history@claudeprism.local")
        .map_err(|e| format!("Failed to create signature: {}", e))
}

/// Build a map of tag name → commit OID for quick label lookup
fn tag_map(repo: &Repository) -> HashMap<Oid, Vec<String>> {
    let mut map: HashMap<Oid, Vec<String>> = HashMap::new();
    if let Ok(tags) = repo.tag_names(None) {
        for tag_name in tags.iter().flatten() {
            if let Ok(reference) = repo.revparse_single(tag_name) {
                let oid = reference
                    .peel_to_commit()
                    .map(|c| c.id())
                    .unwrap_or(reference.id());
                map.entry(oid).or_default().push(tag_name.to_string());
            }
        }
    }
    map
}

fn ensure_excludes(project_root: &str, repo: &Repository) {
    let excludes_path = Path::new(project_root)
        .join(".claudeprism")
        .join("history-exclude");
    let content = r#"# LaTeX build artifacts
*.aux
*.log
*.out
*.toc
*.lof
*.lot
*.fls
*.fdb_latexmk
*.synctex.gz
*.bbl
*.blg
*.nav
*.snm
*.vrb
*.bcf
*.run.xml

# Output
*.pdf

# OS files
.DS_Store
Thumbs.db

# Git
.git/

# ClaudePrism internal
.claudeprism/
.prism/
"#;
    if !excludes_path.exists() {
        let _ = fs::write(&excludes_path, content);
    } else {
        // Migrate: add .prism/ if missing from existing excludes file
        if let Ok(existing) = fs::read_to_string(&excludes_path) {
            if !existing.contains(".prism/") {
                let _ = fs::write(&excludes_path, content);
            }
        }
    }
    // Configure the repo to use this excludes file
    if let Ok(mut config) = repo.config() {
        let _ = config.set_str("core.excludesFile", &excludes_path.to_string_lossy());
    }
}

// ─── Tauri Commands ───

#[tauri::command]
pub fn history_init(project_root: String) -> Result<(), String> {
    let git_dir = history_path(&project_root);

    if git_dir.exists() {
        // Already initialized — verify and ensure excludes
        let repo =
            Repository::open(&git_dir).map_err(|e| format!("Corrupt history repo: {}", e))?;
        ensure_excludes(&project_root, &repo);
        return Ok(());
    }

    // Create .claudeprism/ dir
    let claudeprism_dir = Path::new(&project_root).join(".claudeprism");
    fs::create_dir_all(&claudeprism_dir)
        .map_err(|e| format!("Failed to create .claudeprism dir: {}", e))?;

    // Init a bare repo with workdir pointing to project root
    let mut opts = RepositoryInitOptions::new();
    opts.bare(false);
    opts.workdir_path(Path::new(&project_root));
    opts.no_reinit(true);

    let repo = Repository::init_opts(&git_dir, &opts)
        .map_err(|e| format!("Failed to init history repo: {}", e))?;

    // Set up excludes file
    ensure_excludes(&project_root, &repo);

    // Create initial commit with all project files
    let mut index = repo
        .index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    // Add all files (respecting .gitignore)
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Failed to add files: {}", e))?;
    index
        .write()
        .map_err(|e| format!("Failed to write index: {}", e))?;

    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    let sig = default_signature()?;
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "[init] Project opened",
        &tree,
        &[],
    )
    .map_err(|e| format!("Failed to create initial commit: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn history_snapshot(
    project_root: String,
    message: String,
) -> Result<Option<SnapshotInfo>, String> {
    let repo = open_repo(&project_root)?;

    let mut index = repo
        .index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    // Stage all changes
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Failed to add files: {}", e))?;

    // Remove deleted files from index
    let workdir = repo.workdir().ok_or("No workdir")?;
    let entries: Vec<_> = index.iter().map(|e| e.path.clone()).collect();
    for path_bytes in &entries {
        let path_str = String::from_utf8_lossy(path_bytes);
        let full_path = workdir.join(path_str.as_ref());
        if !full_path.exists() {
            let _ = index.remove_path(Path::new(path_str.as_ref()));
        }
    }

    index
        .write()
        .map_err(|e| format!("Failed to write index: {}", e))?;

    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;

    // Check if there are actual changes vs HEAD
    if let Ok(head) = repo.head() {
        if let Ok(head_commit) = head.peel_to_commit() {
            if head_commit.tree().map(|t| t.id()).unwrap_or(Oid::zero()) == tree_oid {
                // No changes — skip snapshot
                return Ok(None);
            }
        }
    }

    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    let sig = default_signature()?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| format!("Failed to create commit: {}", e))?;

    // Collect changed file paths
    let changed_files = if let Some(parent_commit) = parent.as_ref() {
        let parent_tree = parent_commit.tree().ok();
        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
            .map(|d| {
                d.deltas()
                    .filter_map(|delta| {
                        delta
                            .new_file()
                            .path()
                            .or_else(|| delta.old_file().path())
                            .map(|p| p.to_string_lossy().to_string())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };

    let snapshot = SnapshotInfo {
        id: oid.to_string(),
        message,
        timestamp: chrono::Utc::now().timestamp(),
        labels: vec![],
        changed_files,
    };

    // Auto-prune when snapshot count exceeds MAX_SNAPSHOTS
    let should_prune = {
        let mut rw = repo.revwalk().ok();
        if let Some(ref mut rw) = rw {
            let _ = rw.push_head();
            let count = rw.take(MAX_SNAPSHOTS + 1).count();
            count > MAX_SNAPSHOTS
        } else {
            false
        }
    };
    if should_prune {
        let _ = auto_prune(&project_root);
    }

    Ok(Some(snapshot))
}

/// Maximum number of snapshots to keep before auto-pruning.
/// Labeled snapshots are always preserved regardless of this limit.
const MAX_SNAPSHOTS: usize = 500;

/// Prune old snapshots to keep the history within MAX_SNAPSHOTS.
/// Labeled snapshots and the initial commit are always preserved.
///
/// Strategy: use `git replace --graft` to turn the oldest kept commit into
/// a root (orphaning all older ancestors), then `git gc --prune=now` to
/// reclaim the unreachable objects. This actually reduces history size
/// because commits must be unreachable before gc can collect them.
fn auto_prune(project_root: &str) -> Result<(), String> {
    let repo = open_repo(project_root)?;
    let tags = tag_map(&repo);

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Revwalk error: {}", e))?;
    revwalk.push_head().map_err(|e| format!("Push HEAD: {}", e))?;
    revwalk.set_sorting(Sort::TIME).map_err(|e| format!("Sort: {}", e))?;

    let mut all_oids: Vec<Oid> = Vec::new();
    for oid_result in revwalk {
        let oid = oid_result.map_err(|e| format!("Revwalk: {}", e))?;
        all_oids.push(oid);
    }

    if all_oids.len() <= MAX_SNAPSHOTS {
        return Ok(());
    }

    // Find the cutoff: walk backwards from MAX_SNAPSHOTS to find the oldest
    // commit we want to keep, skipping labeled ones (which are always kept).
    // The cutoff commit will be grafted as a new root.
    let mut cutoff_idx = MAX_SNAPSHOTS;
    // Extend the kept range to include any labeled commits just beyond the cutoff
    while cutoff_idx < all_oids.len() {
        let oid = all_oids[cutoff_idx];
        if tags.contains_key(&oid) {
            cutoff_idx += 1;
            continue;
        }
        // Also preserve the initial commit (root)
        if let Ok(c) = repo.find_commit(oid) {
            if c.parent_count() == 0 {
                cutoff_idx += 1;
                continue;
            }
        }
        break;
    }

    // cutoff_idx-1 is the oldest commit to keep. Graft it as a root
    // to make everything older unreachable.
    let oldest_kept = all_oids[cutoff_idx - 1];
    let commit = repo.find_commit(oldest_kept)
        .map_err(|e| format!("Find cutoff commit: {}", e))?;

    // Only graft if it has parents (i.e., it's not already a root)
    if commit.parent_count() == 0 {
        return Ok(());
    }

    let git_dir = history_path(project_root);
    let git_dir_str = git_dir.to_string_lossy();

    // Graft the cutoff commit as a new root (removes parent links)
    let result = std::process::Command::new("git")
        .args(["--git-dir", &git_dir_str])
        .args(["replace", "--graft", &oldest_kept.to_string()])
        .output();

    if let Ok(output) = &result {
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // If replace ref already exists, that's fine — previous prune set it
            if !stderr.contains("already exists") {
                return Err(format!("git replace --graft failed: {}", stderr));
            }
        }
    }

    // Now gc with aggressive pruning to reclaim the orphaned objects
    let _ = std::process::Command::new("git")
        .args(["--git-dir", &git_dir_str])
        .args(["gc", "--prune=now", "--quiet"])
        .output();

    Ok(())
}

#[tauri::command]
pub fn history_prune(project_root: String) -> Result<String, String> {
    auto_prune(&project_root)?;
    Ok("Pruning complete".to_string())
}

#[tauri::command]
pub fn history_list(
    project_root: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<SnapshotInfo>, String> {
    let repo = open_repo(&project_root)?;
    let tags = tag_map(&repo);

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;
    revwalk
        .push_head()
        .map_err(|e| format!("Failed to push HEAD: {}", e))?;
    revwalk
        .set_sorting(Sort::TIME)
        .map_err(|e| format!("Sort error: {}", e))?;

    let mut snapshots = Vec::new();
    let mut count = 0u32;

    for oid_result in revwalk {
        let oid = oid_result.map_err(|e| format!("Revwalk error: {}", e))?;

        if count < offset {
            count += 1;
            continue;
        }
        if snapshots.len() >= limit as usize {
            break;
        }

        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Failed to find commit: {}", e))?;

        let message = commit.message().unwrap_or("").to_string();
        let timestamp = commit.time().seconds();
        let labels = tags.get(&oid).cloned().unwrap_or_default();

        // Collect changed file paths (vs parent)
        let changed_files = if let Some(parent) = commit.parents().next() {
            let old_tree = parent.tree().ok();
            let new_tree = commit.tree().ok();
            repo.diff_tree_to_tree(old_tree.as_ref(), new_tree.as_ref(), None)
                .map(|d| {
                    d.deltas()
                        .filter_map(|delta| {
                            delta
                                .new_file()
                                .path()
                                .or_else(|| delta.old_file().path())
                                .map(|p| p.to_string_lossy().to_string())
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        } else {
            vec![]
        };

        snapshots.push(SnapshotInfo {
            id: oid.to_string(),
            message,
            timestamp,
            labels,
            changed_files,
        });

        count += 1;
    }

    Ok(snapshots)
}

#[tauri::command]
pub fn history_diff(
    project_root: String,
    from_id: String,
    to_id: String,
) -> Result<Vec<FileDiff>, String> {
    let repo = open_repo(&project_root)?;

    let from_oid = Oid::from_str(&from_id).map_err(|e| format!("Invalid from_id: {}", e))?;
    let to_oid = Oid::from_str(&to_id).map_err(|e| format!("Invalid to_id: {}", e))?;

    let from_commit = repo
        .find_commit(from_oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let to_commit = repo
        .find_commit(to_oid)
        .map_err(|e| format!("Commit not found: {}", e))?;

    let from_tree = from_commit
        .tree()
        .map_err(|e| format!("Tree error: {}", e))?;
    let to_tree = to_commit.tree().map_err(|e| format!("Tree error: {}", e))?;

    let mut diff_opts = DiffOptions::new();
    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut diff_opts))
        .map_err(|e| format!("Diff error: {}", e))?;

    let mut results = Vec::new();

    for delta in diff.deltas() {
        let file_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            _ => "modified",
        }
        .to_string();

        let old_content = if delta.status() != git2::Delta::Added {
            let old_blob = repo.find_blob(delta.old_file().id()).ok();
            old_blob.and_then(|b| {
                if b.is_binary() {
                    None
                } else {
                    Some(String::from_utf8_lossy(b.content()).to_string())
                }
            })
        } else {
            None
        };

        let new_content = if delta.status() != git2::Delta::Deleted {
            let new_blob = repo.find_blob(delta.new_file().id()).ok();
            new_blob.and_then(|b| {
                if b.is_binary() {
                    None
                } else {
                    Some(String::from_utf8_lossy(b.content()).to_string())
                }
            })
        } else {
            None
        };

        results.push(FileDiff {
            file_path,
            status,
            old_content,
            new_content,
        });
    }

    Ok(results)
}

#[tauri::command]
pub fn history_file_at(
    project_root: String,
    snapshot_id: String,
    file_path: String,
) -> Result<String, String> {
    let repo = open_repo(&project_root)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("Tree error: {}", e))?;
    let entry = tree
        .get_path(Path::new(&file_path))
        .map_err(|e| format!("File not found in snapshot: {}", e))?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|e| format!("Blob error: {}", e))?;

    if blob.is_binary() {
        return Err("Binary file".into());
    }

    Ok(String::from_utf8_lossy(blob.content()).to_string())
}

#[tauri::command]
pub fn history_restore(project_root: String, snapshot_id: String) -> Result<SnapshotInfo, String> {
    let repo = open_repo(&project_root)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("Tree error: {}", e))?;

    // Checkout the tree to working directory
    repo.checkout_tree(
        tree.as_object(),
        Some(git2::build::CheckoutBuilder::new().force()),
    )
    .map_err(|e| format!("Checkout failed: {}", e))?;

    // Create a new "restore" commit on HEAD (not moving HEAD to old commit)
    let mut index = repo.index().map_err(|e| format!("Index error: {}", e))?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Add error: {}", e))?;
    index.write().map_err(|e| format!("Write error: {}", e))?;

    let new_tree_oid = index
        .write_tree()
        .map_err(|e| format!("Write tree error: {}", e))?;
    let new_tree = repo
        .find_tree(new_tree_oid)
        .map_err(|e| format!("Find tree error: {}", e))?;

    let sig = default_signature()?;
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = head_commit.iter().collect();

    let short_id = &snapshot_id[..8.min(snapshot_id.len())];
    let msg = format!("[restore] Restored to {}", short_id);
    let new_oid = repo
        .commit(Some("HEAD"), &sig, &sig, &msg, &new_tree, &parents)
        .map_err(|e| format!("Commit error: {}", e))?;

    Ok(SnapshotInfo {
        id: new_oid.to_string(),
        message: msg,
        timestamp: chrono::Utc::now().timestamp(),
        labels: vec![],
        changed_files: vec![],
    })
}

#[tauri::command]
pub fn history_add_label(
    project_root: String,
    snapshot_id: String,
    label: String,
) -> Result<(), String> {
    let repo = open_repo(&project_root)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;

    repo.tag_lightweight(&label, commit.as_object(), false)
        .map_err(|e| format!("Failed to create label: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn history_remove_label(project_root: String, label: String) -> Result<(), String> {
    let repo = open_repo(&project_root)?;
    let tag_ref = format!("refs/tags/{}", label);
    repo.find_reference(&tag_ref)
        .map_err(|e| format!("Label not found: {}", e))?
        .delete()
        .map_err(|e| format!("Failed to delete label: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Create a temp project dir with the given files.
    fn setup_project(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for (name, content) in files {
            let path = dir.path().join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, content).unwrap();
        }
        dir
    }

    fn root(dir: &TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    // ─── history_init ───

    #[test]
    fn test_history_init_creates_repo() {
        let dir = setup_project(&[("main.tex", "\\documentclass{article}")]);
        history_init(root(&dir)).unwrap();

        let git_dir = dir.path().join(".claudeprism").join("history.git");
        assert!(git_dir.exists(), "history.git should be created");

        // Should have an initial commit
        let repo = Repository::open(&git_dir).unwrap();
        let head = repo.head().unwrap();
        let commit = head.peel_to_commit().unwrap();
        assert!(commit.message().unwrap().contains("[init]"));
    }

    #[test]
    fn test_history_init_idempotent() {
        let dir = setup_project(&[("main.tex", "hello")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();
        // Second call should succeed without error
        history_init(r).unwrap();
    }

    #[test]
    fn test_history_init_creates_excludes() {
        let dir = setup_project(&[("main.tex", "doc")]);
        history_init(root(&dir)).unwrap();

        let excludes = dir.path().join(".claudeprism").join("history-exclude");
        assert!(excludes.exists());
        let content = fs::read_to_string(&excludes).unwrap();
        assert!(content.contains("*.aux"));
        assert!(content.contains(".claudeprism/"));
        assert!(content.contains(".prism/"));
    }

    // ─── history_snapshot ───

    #[test]
    fn test_history_snapshot_after_modification() {
        let dir = setup_project(&[("main.tex", "v1")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Modify a file
        fs::write(dir.path().join("main.tex"), "v2").unwrap();

        let result = history_snapshot(r, "edited main.tex".into()).unwrap();
        assert!(result.is_some());
        let snap = result.unwrap();
        assert_eq!(snap.message, "edited main.tex");
        assert!(snap.changed_files.contains(&"main.tex".to_string()));
    }

    #[test]
    fn test_history_snapshot_no_change_returns_none() {
        let dir = setup_project(&[("main.tex", "same")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // No modification → None
        let result = history_snapshot(r, "no-op".into()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_history_snapshot_detects_new_file() {
        let dir = setup_project(&[("main.tex", "doc")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Add a new file
        fs::write(dir.path().join("chapter1.tex"), "new chapter").unwrap();

        let snap = history_snapshot(r, "add chapter".into()).unwrap().unwrap();
        assert!(snap.changed_files.contains(&"chapter1.tex".to_string()));
    }

    // ─── history_list ───

    #[test]
    fn test_history_list_after_snapshots() {
        let dir = setup_project(&[("main.tex", "v1")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("main.tex"), "v2").unwrap();
        history_snapshot(r.clone(), "snap 1".into()).unwrap();

        fs::write(dir.path().join("main.tex"), "v3").unwrap();
        history_snapshot(r.clone(), "snap 2".into()).unwrap();

        let list = history_list(r, 10, 0).unwrap();
        assert_eq!(list.len(), 3); // init + 2 snapshots
        let msgs: Vec<&str> = list.iter().map(|s| s.message.as_str()).collect();
        assert!(msgs.contains(&"snap 1"));
        assert!(msgs.contains(&"snap 2"));
        assert!(msgs.iter().any(|m| m.contains("[init]")));
    }

    #[test]
    fn test_history_list_pagination() {
        let dir = setup_project(&[("a.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("a.tex"), "y").unwrap();
        history_snapshot(r.clone(), "s1".into()).unwrap();

        fs::write(dir.path().join("a.tex"), "z").unwrap();
        history_snapshot(r.clone(), "s2".into()).unwrap();

        // limit=1 → returns exactly 1 entry
        let page1 = history_list(r.clone(), 1, 0).unwrap();
        assert_eq!(page1.len(), 1);

        // offset=1 → returns a different entry
        let page2 = history_list(r.clone(), 1, 1).unwrap();
        assert_eq!(page2.len(), 1);
        assert_ne!(page1[0].id, page2[0].id);

        // All 3 entries accessible
        let all = history_list(r, 10, 0).unwrap();
        assert_eq!(all.len(), 3);
    }

    // ─── history_diff ───

    #[test]
    fn test_history_diff_shows_changes() {
        let dir = setup_project(&[("main.tex", "old content")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("main.tex"), "new content").unwrap();
        let snap = history_snapshot(r.clone(), "update".into())
            .unwrap()
            .unwrap();

        let list = history_list(r.clone(), 10, 0).unwrap();
        let from_id = list[1].id.clone(); // init
        let to_id = snap.id.clone();

        let diffs = history_diff(r, from_id, to_id).unwrap();
        assert!(!diffs.is_empty());
        let d = diffs.iter().find(|d| d.file_path == "main.tex").unwrap();
        assert_eq!(d.status, "modified");
        assert_eq!(d.old_content.as_deref(), Some("old content"));
        assert_eq!(d.new_content.as_deref(), Some("new content"));
    }

    #[test]
    fn test_history_diff_added_file() {
        let dir = setup_project(&[("a.tex", "a")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("b.tex"), "new file").unwrap();
        let snap = history_snapshot(r.clone(), "add b".into())
            .unwrap()
            .unwrap();

        let list = history_list(r.clone(), 10, 0).unwrap();
        let from_id = list[1].id.clone(); // init
        let to_id = snap.id;

        let diffs = history_diff(r, from_id, to_id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "b.tex").unwrap();
        assert_eq!(d.status, "added");
        assert!(d.old_content.is_none());
        assert_eq!(d.new_content.as_deref(), Some("new file"));
    }

    // ─── history_file_at ───

    #[test]
    fn test_history_file_at_returns_content() {
        let dir = setup_project(&[("main.tex", "version one")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        let content = history_file_at(r, init_id, "main.tex".into()).unwrap();
        assert_eq!(content, "version one");
    }

    #[test]
    fn test_history_file_at_nonexistent_file_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        let result = history_file_at(r, id, "nonexistent.tex".into());
        assert!(result.is_err());
    }

    // ─── history_restore ───

    #[test]
    fn test_history_restore_reverts_content() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        // Modify
        fs::write(dir.path().join("main.tex"), "modified").unwrap();
        history_snapshot(r.clone(), "modify".into()).unwrap();

        // Restore to init
        let restore_info = history_restore(r.clone(), init_id).unwrap();
        assert!(restore_info.message.contains("[restore]"));

        // Working directory should have original content
        let content = fs::read_to_string(dir.path().join("main.tex")).unwrap();
        assert_eq!(content, "original");
    }

    // ─── labels ───

    #[test]
    fn test_history_add_and_remove_label() {
        let dir = setup_project(&[("main.tex", "doc")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        // Add label
        history_add_label(r.clone(), id.clone(), "v1.0".into()).unwrap();

        // Verify label appears in list
        let list = history_list(r.clone(), 1, 0).unwrap();
        assert!(list[0].labels.contains(&"v1.0".to_string()));

        // Remove label
        history_remove_label(r.clone(), "v1.0".into()).unwrap();

        // Verify label gone
        let list = history_list(r.clone(), 1, 0).unwrap();
        assert!(!list[0].labels.contains(&"v1.0".to_string()));
    }

    #[test]
    fn test_history_remove_nonexistent_label_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let result = history_remove_label(r, "nope".into());
        assert!(result.is_err());
    }

    // ─── tag_map ───

    #[test]
    fn test_tag_map_groups_by_oid() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        history_add_label(r.clone(), id.clone(), "alpha".into()).unwrap();
        history_add_label(r.clone(), id.clone(), "beta".into()).unwrap();

        let repo = open_repo(&r).unwrap();
        let map = tag_map(&repo);
        let oid = Oid::from_str(&id).unwrap();
        let labels = map.get(&oid).unwrap();
        assert!(labels.contains(&"alpha".to_string()));
        assert!(labels.contains(&"beta".to_string()));
    }

    // ─── ensure_excludes ───

    #[test]
    fn test_ensure_excludes_migrates_missing_prism() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Write an excludes file WITHOUT .prism/
        let excludes_path = dir.path().join(".claudeprism").join("history-exclude");
        fs::write(&excludes_path, "*.aux\n*.log\n.claudeprism/\n").unwrap();

        let repo = open_repo(&r).unwrap();
        ensure_excludes(&r, &repo);

        let content = fs::read_to_string(&excludes_path).unwrap();
        assert!(
            content.contains(".prism/"),
            "should migrate to include .prism/"
        );
    }

    // ─── edge cases ───

    #[test]
    fn test_history_snapshot_deleted_file() {
        let dir = setup_project(&[("a.tex", "aaa"), ("b.tex", "bbb")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Delete a file
        fs::remove_file(dir.path().join("b.tex")).unwrap();

        let snap = history_snapshot(r.clone(), "delete b".into())
            .unwrap()
            .unwrap();
        assert!(!snap.changed_files.is_empty());
    }

    #[test]
    fn test_history_diff_deleted_file() {
        let dir = setup_project(&[("a.tex", "keep"), ("b.tex", "remove me")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        fs::remove_file(dir.path().join("b.tex")).unwrap();
        let snap = history_snapshot(r.clone(), "delete b".into())
            .unwrap()
            .unwrap();

        let diffs = history_diff(r, init_id, snap.id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "b.tex").unwrap();
        assert_eq!(d.status, "deleted");
        assert_eq!(d.old_content.as_deref(), Some("remove me"));
        assert!(d.new_content.is_none());
    }

    #[test]
    fn test_history_diff_nonadjacent_snapshots() {
        let dir = setup_project(&[("a.tex", "v1")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list0 = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list0[0].id.clone();

        fs::write(dir.path().join("a.tex"), "v2").unwrap();
        history_snapshot(r.clone(), "s1".into()).unwrap();

        fs::write(dir.path().join("a.tex"), "v3").unwrap();
        let snap3 = history_snapshot(r.clone(), "s2".into()).unwrap().unwrap();

        // Diff from init directly to s2 (skipping s1)
        let diffs = history_diff(r, init_id, snap3.id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "a.tex").unwrap();
        assert_eq!(d.old_content.as_deref(), Some("v1"));
        assert_eq!(d.new_content.as_deref(), Some("v3"));
    }

    #[test]
    fn test_history_add_duplicate_label_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        history_add_label(r.clone(), id.clone(), "dup".into()).unwrap();
        // Adding same label again should error
        let result = history_add_label(r, id, "dup".into());
        assert!(result.is_err());
    }

    #[test]
    fn test_history_restore_creates_restore_commit() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let init_list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = init_list[0].id.clone();

        fs::write(dir.path().join("main.tex"), "changed").unwrap();
        history_snapshot(r.clone(), "change".into()).unwrap();

        history_restore(r.clone(), init_id).unwrap();

        // Should now have 4 entries: init, change, restore
        let list = history_list(r, 10, 0).unwrap();
        assert_eq!(list.len(), 3);
        assert!(list.iter().any(|s| s.message.contains("[restore]")));
    }
}
