use git2::{
    DiffOptions, IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature, Sort,
};
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

fn default_signature() -> Signature<'static> {
    Signature::now("ClaudePrism", "history@claudeprism.local").unwrap()
}

/// Build a map of tag name → commit OID for quick label lookup
fn tag_map(repo: &Repository) -> HashMap<Oid, Vec<String>> {
    let mut map: HashMap<Oid, Vec<String>> = HashMap::new();
    if let Ok(tags) = repo.tag_names(None) {
        for tag_name in tags.iter().flatten() {
            if let Ok(reference) = repo.revparse_single(tag_name) {
                let oid = reference.peel_to_commit().map(|c| c.id()).unwrap_or(reference.id());
                map.entry(oid)
                    .or_default()
                    .push(tag_name.to_string());
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
        let _ = config.set_str(
            "core.excludesFile",
            &excludes_path.to_string_lossy(),
        );
    }
}

// ─── Tauri Commands ───

#[tauri::command]
pub fn history_init(project_root: String) -> Result<(), String> {
    let git_dir = history_path(&project_root);

    if git_dir.exists() {
        // Already initialized — verify and ensure excludes
        let repo = Repository::open(&git_dir)
            .map_err(|e| format!("Corrupt history repo: {}", e))?;
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

    let sig = default_signature();
    repo.commit(Some("HEAD"), &sig, &sig, "[init] Project opened", &tree, &[])
        .map_err(|e| format!("Failed to create initial commit: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn history_snapshot(project_root: String, message: String) -> Result<Option<SnapshotInfo>, String> {
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

    let sig = default_signature();
    let parent = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());
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
                        delta.new_file().path()
                            .or_else(|| delta.old_file().path())
                            .map(|p| p.to_string_lossy().to_string())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };

    Ok(Some(SnapshotInfo {
        id: oid.to_string(),
        message,
        timestamp: chrono::Utc::now().timestamp(),
        labels: vec![],
        changed_files,
    }))
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
    revwalk.push_head().map_err(|e| format!("Failed to push HEAD: {}", e))?;
    revwalk.set_sorting(Sort::TIME).map_err(|e| format!("Sort error: {}", e))?;

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
                            delta.new_file().path()
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
    let to_tree = to_commit
        .tree()
        .map_err(|e| format!("Tree error: {}", e))?;

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
    let tree = commit
        .tree()
        .map_err(|e| format!("Tree error: {}", e))?;
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
pub fn history_restore(
    project_root: String,
    snapshot_id: String,
) -> Result<SnapshotInfo, String> {
    let repo = open_repo(&project_root)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let tree = commit
        .tree()
        .map_err(|e| format!("Tree error: {}", e))?;

    // Checkout the tree to working directory
    repo.checkout_tree(
        tree.as_object(),
        Some(git2::build::CheckoutBuilder::new().force()),
    )
    .map_err(|e| format!("Checkout failed: {}", e))?;

    // Create a new "restore" commit on HEAD (not moving HEAD to old commit)
    let mut index = repo
        .index()
        .map_err(|e| format!("Index error: {}", e))?;
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

    let sig = default_signature();
    let head_commit = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());
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
