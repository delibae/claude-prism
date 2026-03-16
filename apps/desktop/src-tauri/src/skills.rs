use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{Emitter, WebviewWindow};

const TARBALL_URL: &str =
    "https://github.com/K-Dense-AI/claude-scientific-skills/archive/refs/heads/main.tar.gz";
const SKILLS_SUBFOLDER: &str = "scientific-skills";

// ─── Data Types ───

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub description: String,
    pub folder: String,
}

#[derive(Debug, Serialize)]
pub struct InstallResult {
    pub success: bool,
    pub skills_installed: usize,
    pub target_dir: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct SkillsStatus {
    pub installed: bool,
    pub skill_count: usize,
    pub location: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub folder: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SkillCategory {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub skill_count: usize,
    pub skills: Vec<SkillEntry>,
}

// ─── Skill Categories Data ───

/// Returns the known scientific skill categories with metadata.
fn skill_categories() -> Vec<SkillCategory> {
    fn s(name: &str, folder: &str) -> SkillEntry {
        SkillEntry {
            name: name.into(),
            folder: folder.into(),
        }
    }

    let mut cats = vec![
        SkillCategory {
            id: "bioinformatics".into(),
            name: "Bioinformatics & Genomics".into(),
            icon: "dna".into(),
            skill_count: 0,
            skills: vec![
                s("Scanpy (scRNA-seq)", "scanpy"),
                s("BioPython", "biopython"),
                s("PyDESeq2", "pydeseq2"),
                s("PySAM", "pysam"),
                s("gget", "gget"),
                s("scikit-bio", "scikit-bio"),
                s("DeepTools", "deeptools"),
                s("CELLxGENE Census", "cellxgene-census"),
                s("AnnData", "anndata"),
                s("GTARS", "gtars"),
                s("ETE Toolkit", "etetoolkit"),
                s("TileDB-VCF", "tiledbvcf"),
                s("FlowIO", "flowio"),
                s("GenIML", "geniml"),
                s("Ensembl Database", "ensembl-database"),
                s("Gene Database", "gene-database"),
            ],
        },
        SkillCategory {
            id: "cheminformatics".into(),
            name: "Cheminformatics & Drug Discovery".into(),
            icon: "flask-conical".into(),
            skill_count: 0,
            skills: vec![
                s("RDKit", "rdkit"),
                s("Datamol", "datamol"),
                s("MolFeat", "molfeat"),
                s("MedChem Filters", "medchem"),
                s("DeepChem", "deepchem"),
                s("PubChem Database", "pubchem-database"),
                s("ChEMBL Database", "chembl-database"),
                s("ZINC Database", "zinc-database"),
                s("TorchDrug", "torchdrug"),
                s("DiffDock", "diffdock"),
                s("Rowan", "rowan"),
            ],
        },
        SkillCategory {
            id: "clinical".into(),
            name: "Clinical Research".into(),
            icon: "heart-pulse".into(),
            skill_count: 0,
            skills: vec![
                s("ClinicalTrials.gov", "clinicaltrials-database"),
                s("ClinVar Database", "clinvar-database"),
                s("ClinPGx Database", "clinpgx-database"),
                s("Treatment Plans", "treatment-plans"),
                s("Clinical Reports", "clinical-reports"),
                s("Clinical Decision Support", "clinical-decision-support"),
                s("DrugBank Database", "drugbank-database"),
                s("FDA Database", "fda-database"),
                s("BRENDA Database", "brenda-database"),
                s("PyTDC", "pytdc"),
                s("ISO 13485 Certification", "iso-13485-certification"),
                s("COSMIC Database", "cosmic-database"),
            ],
        },
        SkillCategory {
            id: "data-analysis".into(),
            name: "Data Analysis & Visualization".into(),
            icon: "bar-chart-3".into(),
            skill_count: 0,
            skills: vec![
                s("Statistical Analysis", "statistical-analysis"),
                s("Exploratory Data Analysis", "exploratory-data-analysis"),
                s("Polars", "polars"),
                s("Dask", "dask"),
                s("Vaex", "vaex"),
                s("NetworkX", "networkx"),
                s("Seaborn", "seaborn"),
                s("Plotly", "plotly"),
                s("Matplotlib", "matplotlib"),
                s("Scientific Visualization", "scientific-visualization"),
                s("Zarr", "zarr-python"),
                s("Data Commons", "datacommons-client"),
                s("Aeon (Time Series ML)", "aeon"),
                s("TimesFM Forecasting", "timesfm-forecasting"),
            ],
        },
        SkillCategory {
            id: "ml-ai".into(),
            name: "Machine Learning & AI".into(),
            icon: "brain".into(),
            skill_count: 0,
            skills: vec![
                s("scikit-learn", "scikit-learn"),
                s("Transformers", "transformers"),
                s("PyTorch Lightning", "pytorch-lightning"),
                s("PyG (Graph Neural Nets)", "torch_geometric"),
                s("Stable Baselines3", "stable-baselines3"),
                s("PufferLib", "pufferlib"),
                s("SHAP", "shap"),
                s("UMAP", "umap-learn"),
                s("HypoGeniC", "hypogenic"),
                s("Hypothesis Generation", "hypothesis-generation"),
                s("Statsmodels", "statsmodels"),
                s("PyMC", "pymc"),
                s("PennyLane", "pennylane"),
                s("Qiskit", "qiskit"),
                s("Cirq", "cirq"),
            ],
        },
        SkillCategory {
            id: "scientific-communication".into(),
            name: "Scientific Communication".into(),
            icon: "book-open".into(),
            skill_count: 0,
            skills: vec![
                s("Scientific Writing", "scientific-writing"),
                s("Literature Review", "literature-review"),
                s("Peer Review", "peer-review"),
                s("Grant Writing", "research-grants"),
                s("Citation Management", "citation-management"),
                s("Scientific Slides", "scientific-slides"),
                s("LaTeX Posters", "latex-posters"),
                s("HTML/PPTX Posters", "pptx-posters"),
                s("Infographics", "infographics"),
                s("Scientific Schematics", "scientific-schematics"),
                s("Markdown & Mermaid", "markdown-mermaid-writing"),
                s("Scientific Brainstorming", "scientific-brainstorming"),
                s("Critical Thinking", "scientific-critical-thinking"),
                s("Scholar Evaluation", "scholar-evaluation"),
                s("Paper to Web", "paper-2-web"),
                s("Venue Templates", "venue-templates"),
                s("Market Research Reports", "market-research-reports"),
                s("Image Generation", "generate-image"),
                s("Open Notebook", "open-notebook"),
                s("MarkItDown", "markitdown"),
            ],
        },
        SkillCategory {
            id: "multi-omics".into(),
            name: "Multi-omics & Systems Biology".into(),
            icon: "microscope".into(),
            skill_count: 0,
            skills: vec![
                s("scvi-tools", "scvi-tools"),
                s("COBRApy", "cobrapy"),
                s("Bioservices", "bioservices"),
                s("Arboreto (GRN)", "arboreto"),
                s("Reactome Database", "reactome-database"),
            ],
        },
        SkillCategory {
            id: "engineering".into(),
            name: "Engineering & Simulation".into(),
            icon: "settings".into(),
            skill_count: 0,
            skills: vec![
                s("SimPy", "simpy"),
                s("pymoo", "pymoo"),
                s("FluidSim", "fluidsim"),
                s("MATLAB/Octave", "matlab"),
            ],
        },
        SkillCategory {
            id: "proteomics".into(),
            name: "Proteomics & Mass Spec".into(),
            icon: "atom".into(),
            skill_count: 0,
            skills: vec![
                s("PyOpenMS", "pyopenms"),
                s("matchms", "matchms"),
                s("ESM (Protein LM)", "esm"),
                s("PDB Database", "pdb-database"),
                s("UniProt Database", "uniprot-database"),
                s("HMDB Database", "hmdb-database"),
            ],
        },
        SkillCategory {
            id: "healthcare-ai".into(),
            name: "Healthcare AI & Clinical ML".into(),
            icon: "activity".into(),
            skill_count: 0,
            skills: vec![
                s("PyHealth", "pyhealth"),
                s("NeuroKit2", "neurokit2"),
                s("scikit-survival", "scikit-survival"),
                s("GWAS Catalog", "gwas-database"),
                s("OpenAlex Database", "openalex-database"),
                s("PubMed Database", "pubmed-database"),
                s("bioRxiv Database", "biorxiv-database"),
                s("GEO Database", "geo-database"),
            ],
        },
        SkillCategory {
            id: "medical-imaging".into(),
            name: "Medical Imaging".into(),
            icon: "scan".into(),
            skill_count: 0,
            skills: vec![
                s("pydicom", "pydicom"),
                s("HistoLab", "histolab"),
                s("PathML", "pathml"),
                s("Neuropixels Analysis", "neuropixels-analysis"),
                s("Imaging Data Commons", "imaging-data-commons"),
                s("GeoMaster", "geomaster"),
                s("GeoPandas", "geopandas"),
            ],
        },
        SkillCategory {
            id: "materials-science".into(),
            name: "Materials Science".into(),
            icon: "gem".into(),
            skill_count: 0,
            skills: vec![
                s("Pymatgen", "pymatgen"),
                s("QuTiP", "qutip"),
                s("SymPy", "sympy"),
                s("Astropy", "astropy"),
                s("Open Targets", "opentargets-database"),
            ],
        },
        SkillCategory {
            id: "physics-astronomy".into(),
            name: "Physics & Astronomy".into(),
            icon: "telescope".into(),
            skill_count: 0,
            skills: vec![
                s("Astropy", "astropy"),
                s("QuTiP", "qutip"),
                s("PennyLane", "pennylane"),
                s("SymPy", "sympy"),
            ],
        },
        SkillCategory {
            id: "lab-automation".into(),
            name: "Laboratory Automation".into(),
            icon: "pipette".into(),
            skill_count: 0,
            skills: vec![
                s("Opentrons", "opentrons-integration"),
                s("PyLabRobot", "pylabrobot"),
                s("Protocols.io", "protocolsio-integration"),
                s("LabArchive", "labarchive-integration"),
                s("Ginkgo Cloud Lab", "ginkgo-cloud-lab"),
            ],
        },
        SkillCategory {
            id: "protein-engineering".into(),
            name: "Protein Engineering".into(),
            icon: "helix".into(),
            skill_count: 0,
            skills: vec![
                s("AlphaFold Database", "alphafold-database"),
                s("ESM (Protein LM)", "esm"),
                s("DiffDock", "diffdock"),
                s("Adaptyv", "adaptyv"),
                s("STRING Database", "string-database"),
                s("LaminDB", "lamindb"),
            ],
        },
        SkillCategory {
            id: "research-methodology".into(),
            name: "Research Methodology".into(),
            icon: "lightbulb".into(),
            skill_count: 0,
            skills: vec![
                s("Hypothesis Generation", "hypothesis-generation"),
                s("Scientific Brainstorming", "scientific-brainstorming"),
                s("Critical Thinking", "scientific-critical-thinking"),
                s("Experimental Design", "hypothesis-generation"),
                s("Scholar Evaluation", "scholar-evaluation"),
                s("Peer Review", "peer-review"),
                s("Research Lookup", "research-lookup"),
                s("Denario", "denario"),
                s("bGPT Paper Search", "bgpt-paper-search"),
                s("Perplexity Search", "perplexity-search"),
            ],
        },
    ];

    for cat in &mut cats {
        cat.skill_count = cat.skills.len();
    }

    cats
}

// ─── Helpers ───

/// Resolve the target skills directory.
fn skills_dir(project_path: Option<&str>) -> PathBuf {
    match project_path {
        Some(p) => PathBuf::from(p).join(".claude").join("skills"),
        None => dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".claude")
            .join("skills"),
    }
}

/// Download and extract tarball.
async fn download_tarball(tmp_dir: &Path) -> Result<(), String> {
    let response = reqwest::get(TARBALL_URL)
        .await
        .map_err(|e| format!("Failed to download tarball: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Tarball download failed with status: {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read tarball bytes: {}", e))?;

    // Decompress gzip
    let decoder = flate2::read::GzDecoder::new(&bytes[..]);
    let mut archive = tar::Archive::new(decoder);

    archive
        .unpack(tmp_dir.join("repo-raw"))
        .map_err(|e| format!("Failed to extract tarball: {}", e))?;

    // The tarball extracts to claude-scientific-skills-main/
    // We need to find it and rename to repo/
    let raw_dir = tmp_dir.join("repo-raw");
    if let Ok(mut entries) = std::fs::read_dir(&raw_dir) {
        if let Some(Ok(entry)) = entries.next() {
            std::fs::rename(entry.path(), tmp_dir.join("repo"))
                .map_err(|e| format!("Failed to rename extracted dir: {}", e))?;
        }
    }

    // Clean up the raw extraction directory
    let _ = std::fs::remove_dir_all(&raw_dir);

    Ok(())
}

/// Copy the scientific-skills directory from the cloned repo to the target.
fn copy_skills(repo_dir: &Path, target_dir: &Path) -> Result<usize, String> {
    let src = repo_dir.join(SKILLS_SUBFOLDER);
    if !src.exists() {
        return Err(format!(
            "scientific-skills directory not found in cloned repo at {}",
            src.display()
        ));
    }

    // Create target directory
    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create target dir: {}", e))?;

    let mut count = 0;

    // Iterate through skill subdirectories
    let entries =
        std::fs::read_dir(&src).map_err(|e| format!("Failed to read skills dir: {}", e))?;

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }

        let skill_name = entry.file_name().to_string_lossy().to_string();

        let target_skill = target_dir.join(&skill_name);
        copy_dir_recursive(&entry_path, &target_skill)?;
        count += 1;
    }

    Ok(count)
}

/// Recursively copy a directory.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create dir {}: {}", dst.display(), e))?;

    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read dir {}: {}", src.display(), e))?;

    for entry in entries.flatten() {
        let entry_path = entry.path();
        let target = dst.join(entry.file_name());

        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &target)?;
        } else {
            std::fs::copy(&entry_path, &target)
                .map_err(|e| format!("Failed to copy {}: {}", entry_path.display(), e))?;
        }
    }

    Ok(())
}

/// Parse a SKILL.md file to extract skill info.
fn parse_skill_md(skill_dir: &Path) -> Option<SkillInfo> {
    let skill_md = skill_dir.join("SKILL.md");
    if !skill_md.exists() {
        return None;
    }

    let content = std::fs::read_to_string(&skill_md).ok()?;
    let folder = skill_dir.file_name()?.to_string_lossy().to_string();

    // Extract title from first # heading
    let name = content
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l.trim_start_matches("# ").trim().to_string())
        .unwrap_or_else(|| folder.clone());

    // Extract description from first paragraph after heading
    let description = content
        .lines()
        .skip_while(|l| !l.starts_with("# "))
        .skip(1)
        .skip_while(|l| l.trim().is_empty())
        .take_while(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect::<String>();

    // Infer domain from folder name prefix (e.g., "bioinformatics-rna-seq" → "bioinformatics")
    let domain = folder.split('-').next().unwrap_or("general").to_string();

    Some(SkillInfo {
        id: folder.clone(),
        name,
        domain,
        description,
        folder,
    })
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn install_scientific_skills(
    window: WebviewWindow,
    project_path: String,
) -> Result<InstallResult, String> {
    let target = skills_dir(Some(&project_path));
    install_skills_to(&window, &target, Some(&project_path)).await
}

#[tauri::command]
pub async fn install_scientific_skills_global(
    window: WebviewWindow,
) -> Result<InstallResult, String> {
    let target = skills_dir(None);
    install_skills_to(&window, &target, None).await
}

/// Ensure the target directory is creatable and writable.
/// If creation fails (e.g. ~/.claude is owned by root), prompt for admin password via osascript.
fn ensure_target_writable(target: &Path) -> Result<(), String> {
    // Try without elevation first
    if std::fs::create_dir_all(target).is_ok() {
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = dirs::home_dir().ok_or("Could not determine home directory")?;
        let user = std::env::var("USER").unwrap_or_default();
        let claude_dir = home.join(".claude");

        let script = format!(
            "mkdir -p '{}' && chown -R {} '{}'",
            target.display(),
            user,
            claude_dir.display()
        );

        let output = std::process::Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "do shell script \"{}\" with administrator privileges",
                    script
                ),
            ])
            .output()
            .map_err(|e| format!("Failed to run osascript: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Failed to fix directory permissions. Error: {}. \
                 You can fix this manually by running: sudo chown -R $(whoami) ~/.claude",
                stderr.trim()
            ));
        }

        // Verify writable
        let test_file = target.join(".prism_write_test");
        std::fs::write(&test_file, "test").map_err(|e| {
            format!(
                "Directory {} still not writable after elevation: {}",
                target.display(),
                e
            )
        })?;
        let _ = std::fs::remove_file(&test_file);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        return Err(format!(
            "Failed to create directory {}. Please check permissions.",
            target.display()
        ));
    }
}

/// Emit a progress log event to the frontend + stderr for terminal debugging.
fn emit_log(window: &WebviewWindow, msg: &str) {
    eprintln!("[skills] {}", msg);
    let _ = window.emit("skills-install-log", msg);
}

/// Core installation logic.
async fn install_skills_to(
    window: &WebviewWindow,
    target: &Path,
    _project_path: Option<&str>,
) -> Result<InstallResult, String> {
    emit_log(window, &format!("Target directory: {}", target.display()));

    // Ensure target directory is writable before proceeding
    emit_log(window, "Checking directory permissions...");
    ensure_target_writable(target).map_err(|e| {
        emit_log(window, &format!("Permission error: {}", e));
        e
    })?;
    emit_log(window, "Directory permissions OK");

    // Create a temporary directory for the clone/download
    let tmp_dir = std::env::temp_dir().join(format!(
        "claude-scientific-skills-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| {
        let msg = format!("Failed to create temp dir: {}", e);
        emit_log(window, &msg);
        msg
    })?;

    // Download via tarball (faster, no git/git-lfs dependency)
    emit_log(window, "Downloading skills...");
    download_tarball(&tmp_dir).await.map_err(|e| {
        emit_log(window, &format!("Download failed: {}", e));
        e
    })?;
    emit_log(window, "Download complete");

    let repo_dir = tmp_dir.join("repo");

    // Copy skills to target directory
    emit_log(window, "Copying skills...");
    let count = copy_skills(&repo_dir, target).map_err(|e| {
        emit_log(window, &format!("Copy failed: {}", e));
        e
    })?;
    emit_log(window, &format!("Copied {} skills", count));

    // Clean up temp directory
    let _ = std::fs::remove_dir_all(&tmp_dir);
    emit_log(window, "Cleanup complete");

    let target_str = target.to_string_lossy().to_string();

    Ok(InstallResult {
        success: true,
        skills_installed: count,
        target_dir: target_str.clone(),
        message: format!("Successfully installed {} skills to {}", count, target_str),
    })
}

#[tauri::command]
pub async fn check_skills_installed(project_path: Option<String>) -> Result<SkillsStatus, String> {
    let target = skills_dir(project_path.as_deref());

    if !target.exists() {
        return Ok(SkillsStatus {
            installed: false,
            skill_count: 0,
            location: target.to_string_lossy().to_string(),
        });
    }

    // Count subdirectories that contain SKILL.md
    let count = std::fs::read_dir(&target)
        .map_err(|e| format!("Failed to read skills dir: {}", e))?
        .flatten()
        .filter(|e| e.path().is_dir() && e.path().join("SKILL.md").exists())
        .count();

    Ok(SkillsStatus {
        installed: count > 0,
        skill_count: count,
        location: target.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn list_installed_skills(project_path: Option<String>) -> Result<Vec<SkillInfo>, String> {
    let target = skills_dir(project_path.as_deref());

    if !target.exists() {
        return Ok(Vec::new());
    }

    let mut skills = Vec::new();
    let entries =
        std::fs::read_dir(&target).map_err(|e| format!("Failed to read skills dir: {}", e))?;

    for entry in entries.flatten() {
        if entry.path().is_dir() {
            if let Some(info) = parse_skill_md(&entry.path()) {
                skills.push(info);
            }
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

#[tauri::command]
pub async fn uninstall_scientific_skills(project_path: Option<String>) -> Result<(), String> {
    let target = skills_dir(project_path.as_deref());

    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("Failed to remove skills: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_skill_categories() -> Vec<SkillCategory> {
    skill_categories()
}

/// Read the raw SKILL.md content for a specific skill folder.
/// Tries local install first, then fetches from GitHub.
#[tauri::command]
pub async fn get_skill_content(
    skill_folder: String,
    project_path: Option<String>,
) -> Result<String, String> {
    // Try local (project-level first, then global)
    let locations: Vec<PathBuf> = match project_path.as_deref() {
        Some(pp) => vec![skills_dir(Some(pp)), skills_dir(None)],
        None => vec![skills_dir(None)],
    };

    for base in &locations {
        let skill_md = base.join(&skill_folder).join("SKILL.md");
        if skill_md.exists() {
            return std::fs::read_to_string(&skill_md)
                .map_err(|e| format!("Failed to read SKILL.md: {}", e));
        }
    }

    // Fallback: fetch from GitHub
    let url = format!(
        "https://raw.githubusercontent.com/K-Dense-AI/claude-scientific-skills/main/scientific-skills/{}/SKILL.md",
        skill_folder
    );

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch from GitHub: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Skill '{}' not found (HTTP {})",
            skill_folder,
            response.status()
        ));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_skills_dir_global() {
        let dir = skills_dir(None);
        assert!(dir.to_string_lossy().contains(".claude"));
        assert!(dir.to_string_lossy().ends_with("skills"));
    }

    #[test]
    fn test_skills_dir_project() {
        let dir = skills_dir(Some("/tmp/my-project"));
        assert_eq!(dir, PathBuf::from("/tmp/my-project/.claude/skills"));
    }

    #[test]
    fn test_skill_categories_count() {
        let cats = skill_categories();
        assert_eq!(cats.len(), 16);
        // Verify skill_count matches actual skills vec length
        for cat in &cats {
            assert_eq!(cat.skill_count, cat.skills.len(), "Mismatch in {}", cat.id);
        }
        let total: usize = cats.iter().map(|c| c.skill_count).sum();
        assert!(total >= 100);
    }

    #[test]
    fn test_parse_skill_md() {
        let tmp = std::env::temp_dir().join("test-skill-parse");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let skill_content = "# RNA-seq Analysis\n\nComprehensive RNA-seq data analysis pipeline.\n\n## Usage\nUse this skill for RNA sequencing workflows.\n";
        std::fs::write(tmp.join("SKILL.md"), skill_content).unwrap();

        let info = parse_skill_md(&tmp).unwrap();
        assert_eq!(info.name, "RNA-seq Analysis");
        assert!(info.description.contains("RNA-seq"));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
