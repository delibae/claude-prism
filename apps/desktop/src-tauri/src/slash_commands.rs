use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    pub id: String,
    pub name: String,
    pub full_command: String,
    pub scope: String,
    pub namespace: Option<String>,
    pub file_path: String,
    pub content: String,
    pub description: Option<String>,
    pub allowed_tools: Vec<String>,
    pub has_bash_commands: bool,
    pub has_file_references: bool,
    pub accepts_arguments: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct CommandFrontmatterRaw {
    allowed_tools: Option<serde_yaml::Value>,
    description: Option<String>,
    name: Option<String>,
}

struct CommandFrontmatter {
    allowed_tools: Option<Vec<String>>,
    description: Option<String>,
    name: Option<String>,
}

impl CommandFrontmatterRaw {
    fn into_parsed(self) -> CommandFrontmatter {
        let allowed_tools = self.allowed_tools.and_then(|v| match v {
            serde_yaml::Value::String(s) => {
                let tools: Vec<String> = s.split_whitespace().map(|t| t.to_string()).collect();
                if tools.is_empty() { None } else { Some(tools) }
            }
            serde_yaml::Value::Sequence(seq) => {
                let tools: Vec<String> = seq
                    .into_iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                if tools.is_empty() { None } else { Some(tools) }
            }
            _ => None,
        });
        CommandFrontmatter {
            allowed_tools,
            description: self.description,
            name: self.name,
        }
    }
}

fn parse_markdown_with_frontmatter(content: &str) -> (Option<CommandFrontmatter>, String) {
    let lines: Vec<&str> = content.lines().collect();

    if lines.first() != Some(&"---") {
        return (None, content.to_string());
    }

    let mut frontmatter_end = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if *line == "---" {
            frontmatter_end = Some(i);
            break;
        }
    }

    if let Some(end) = frontmatter_end {
        let frontmatter_content = lines.get(1..end).map(|s| s.join("\n")).unwrap_or_default();
        let body_content = lines.get((end + 1)..).map(|s| s.join("\n")).unwrap_or_default();

        match serde_yaml::from_str::<CommandFrontmatterRaw>(&frontmatter_content) {
            Ok(raw) => (Some(raw.into_parsed()), body_content),
            Err(_) => (None, content.to_string()),
        }
    } else {
        (None, content.to_string())
    }
}

fn extract_command_info(file_path: &Path, base_path: &Path) -> Option<(String, Option<String>)> {
    let relative_path = file_path.strip_prefix(base_path).ok()?;
    let path_without_ext = relative_path
        .with_extension("")
        .to_string_lossy()
        .to_string();

    let components: Vec<&str> = path_without_ext.split(['/', '\\']).collect();

    if components.is_empty() {
        return None;
    }

    if components.len() == 1 {
        Some((components.first()?.to_string(), None))
    } else {
        let command_name = components.last()?.to_string();
        let namespace = components.get(..components.len() - 1)
            .map(|s| s.join(":"))
            .unwrap_or_default();
        Some((command_name, Some(namespace)))
    }
}

fn load_command_from_file(
    file_path: &Path,
    base_path: &Path,
    scope: &str,
) -> Option<SlashCommand> {
    let content = fs::read_to_string(file_path).ok()?;
    let (frontmatter, body) = parse_markdown_with_frontmatter(&content);
    let (name, namespace) = extract_command_info(file_path, base_path)?;

    let full_command = match &namespace {
        Some(ns) => format!("/{ns}:{name}"),
        None => format!("/{name}"),
    };

    let id = format!(
        "{}-{}",
        scope,
        file_path.to_string_lossy().replace('/', "-")
    );

    let has_bash_commands = body.contains("!`");
    let has_file_references = body.contains('@');
    let accepts_arguments = body.contains("$ARGUMENTS");

    let (description, allowed_tools) = if let Some(fm) = frontmatter {
        (fm.description, fm.allowed_tools.unwrap_or_default())
    } else {
        (None, Vec::new())
    };

    Some(SlashCommand {
        id,
        name,
        full_command,
        scope: scope.to_string(),
        namespace,
        file_path: file_path.to_string_lossy().to_string(),
        content: body,
        description,
        allowed_tools,
        has_bash_commands,
        has_file_references,
        accepts_arguments,
    })
}

fn find_markdown_files(dir: &Path, files: &mut Vec<PathBuf>) {
    if !dir.exists() {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();

        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }

        if path.is_dir() {
            find_markdown_files(&path, files);
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "md" {
                    files.push(path);
                }
            }
        }
    }
}

/// Load skills from a `.claude/skills/` directory.
/// Each skill is a subdirectory containing a `SKILL.md` file.
fn load_skills_from_dir(dir: &Path, scope: &str) -> Vec<SlashCommand> {
    if !dir.exists() {
        return Vec::new();
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut skills = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }

        let content = match fs::read_to_string(&skill_md) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let folder_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        let (frontmatter, body) = parse_markdown_with_frontmatter(&content);

        // Name: frontmatter name > first # heading > folder name
        let name = frontmatter
            .as_ref()
            .and_then(|fm| fm.name.clone())
            .or_else(|| {
                body.lines()
                    .find(|l| l.starts_with("# "))
                    .map(|l| l.trim_start_matches("# ").trim().to_string())
            })
            .unwrap_or_else(|| folder_name.clone());

        // Description: frontmatter description (truncated to 200 chars)
        let description = frontmatter
            .as_ref()
            .and_then(|fm| fm.description.clone())
            .map(|d| d.chars().take(200).collect());

        let id = format!("skill-{}", folder_name);

        skills.push(SlashCommand {
            id,
            name: name.clone(),
            full_command: format!("/{}", folder_name),
            scope: scope.to_string(),
            namespace: None,
            file_path: skill_md.to_string_lossy().to_string(),
            content,
            description,
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: true,
        });
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

fn create_default_commands() -> Vec<SlashCommand> {
    vec![
        SlashCommand {
            id: "default-add-dir".to_string(),
            name: "add-dir".to_string(),
            full_command: "/add-dir".to_string(),
            scope: "default".to_string(),
            namespace: None,
            file_path: String::new(),
            content: "Add additional working directories".to_string(),
            description: Some("Add additional working directories".to_string()),
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: false,
        },
        SlashCommand {
            id: "default-init".to_string(),
            name: "init".to_string(),
            full_command: "/init".to_string(),
            scope: "default".to_string(),
            namespace: None,
            file_path: String::new(),
            content: "Initialize project with CLAUDE.md guide".to_string(),
            description: Some("Initialize project with CLAUDE.md guide".to_string()),
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: false,
        },
        SlashCommand {
            id: "default-review".to_string(),
            name: "review".to_string(),
            full_command: "/review".to_string(),
            scope: "default".to_string(),
            namespace: None,
            file_path: String::new(),
            content: "Request code review".to_string(),
            description: Some("Request code review".to_string()),
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: false,
        },
    ]
}

#[tauri::command]
pub async fn slash_commands_list(
    project_path: Option<String>,
) -> Result<Vec<SlashCommand>, String> {
    let mut commands = Vec::new();

    commands.extend(create_default_commands());

    // Load project commands
    if let Some(ref proj_path) = project_path {
        let project_commands_dir = PathBuf::from(proj_path).join(".claude").join("commands");
        if project_commands_dir.exists() {
            let mut md_files = Vec::new();
            find_markdown_files(&project_commands_dir, &mut md_files);
            for file_path in md_files {
                if let Some(cmd) =
                    load_command_from_file(&file_path, &project_commands_dir, "project")
                {
                    commands.push(cmd);
                }
            }
        }
    }

    // Load user commands
    if let Some(home_dir) = dirs::home_dir() {
        let user_commands_dir = home_dir.join(".claude").join("commands");
        if user_commands_dir.exists() {
            let mut md_files = Vec::new();
            find_markdown_files(&user_commands_dir, &mut md_files);
            for file_path in md_files {
                if let Some(cmd) =
                    load_command_from_file(&file_path, &user_commands_dir, "user")
                {
                    commands.push(cmd);
                }
            }
        }
    }

    // Load installed skills (project-level first, then global)
    if let Some(proj_path) = &project_path {
        let project_skills_dir = PathBuf::from(proj_path).join(".claude").join("skills");
        commands.extend(load_skills_from_dir(&project_skills_dir, "skill"));
    }
    if let Some(home_dir) = dirs::home_dir() {
        let global_skills_dir = home_dir.join(".claude").join("skills");
        // Avoid duplicates if project and global have same skill
        let existing_ids: std::collections::HashSet<String> =
            commands.iter().map(|c| c.id.clone()).collect();
        let global_skills = load_skills_from_dir(&global_skills_dir, "skill");
        for skill in global_skills {
            if !existing_ids.contains(&skill.id) {
                commands.push(skill);
            }
        }
    }

    Ok(commands)
}

#[tauri::command]
pub async fn slash_command_get(command_id: String) -> Result<SlashCommand, String> {
    let commands = slash_commands_list(None).await?;
    commands
        .into_iter()
        .find(|cmd| cmd.id == command_id)
        .ok_or_else(|| format!("Command not found: {}", command_id))
}

#[tauri::command]
pub async fn slash_command_save(
    scope: String,
    name: String,
    namespace: Option<String>,
    content: String,
    description: Option<String>,
    allowed_tools: Vec<String>,
    project_path: Option<String>,
) -> Result<SlashCommand, String> {
    if name.is_empty() {
        return Err("Command name cannot be empty".to_string());
    }

    if !["project", "user"].contains(&scope.as_str()) {
        return Err("Invalid scope. Must be 'project' or 'user'".to_string());
    }

    let base_dir = if scope == "project" {
        if let Some(proj_path) = project_path {
            PathBuf::from(proj_path).join(".claude").join("commands")
        } else {
            return Err("Project path required for project scope".to_string());
        }
    } else {
        dirs::home_dir()
            .ok_or_else(|| "Could not find home directory".to_string())?
            .join(".claude")
            .join("commands")
    };

    let mut file_path = base_dir.clone();
    if let Some(ns) = &namespace {
        for component in ns.split(':') {
            file_path = file_path.join(component);
        }
    }

    fs::create_dir_all(&file_path).map_err(|e| format!("Failed to create directories: {}", e))?;

    file_path = file_path.join(format!("{}.md", name));

    let mut full_content = String::new();

    if description.is_some() || !allowed_tools.is_empty() {
        full_content.push_str("---\n");
        if let Some(desc) = &description {
            full_content.push_str(&format!("description: {}\n", desc));
        }
        if !allowed_tools.is_empty() {
            full_content.push_str("allowed-tools:\n");
            for tool in &allowed_tools {
                full_content.push_str(&format!("  - {}\n", tool));
            }
        }
        full_content.push_str("---\n\n");
    }

    full_content.push_str(&content);

    fs::write(&file_path, &full_content)
        .map_err(|e| format!("Failed to write command file: {}", e))?;

    load_command_from_file(&file_path, &base_dir, &scope)
        .ok_or_else(|| "Failed to load saved command".to_string())
}

#[tauri::command]
pub async fn slash_command_delete(
    command_id: String,
    project_path: Option<String>,
) -> Result<String, String> {
    let commands = slash_commands_list(project_path).await?;

    let command = commands
        .into_iter()
        .find(|cmd| cmd.id == command_id)
        .ok_or_else(|| format!("Command not found: {}", command_id))?;

    fs::remove_file(&command.file_path)
        .map_err(|e| format!("Failed to delete command file: {}", e))?;

    // Clean up empty parent directories
    if let Some(parent) = Path::new(&command.file_path).parent() {
        remove_empty_dirs(parent);
    }

    Ok(format!("Deleted command: {}", command.full_command))
}

fn remove_empty_dirs(dir: &Path) {
    if !dir.exists() {
        return;
    }
    if let Ok(mut entries) = fs::read_dir(dir) {
        if entries.next().is_none() {
            let _ = fs::remove_dir(dir);
            if let Some(parent) = dir.parent() {
                remove_empty_dirs(parent);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_markdown_no_frontmatter() {
        let (fm, body) = parse_markdown_with_frontmatter("Just some content\nwith lines");
        assert!(fm.is_none());
        assert_eq!(body, "Just some content\nwith lines");
    }

    #[test]
    fn test_parse_markdown_empty() {
        let (fm, body) = parse_markdown_with_frontmatter("");
        assert!(fm.is_none());
        assert_eq!(body, "");
    }

    #[test]
    fn test_parse_markdown_with_valid_frontmatter() {
        let content = "---\ndescription: My command\n---\nBody content here";
        let (fm, body) = parse_markdown_with_frontmatter(content);
        assert!(fm.is_some());
        let fm = fm.unwrap();
        assert_eq!(fm.description.unwrap(), "My command");
        assert_eq!(body, "Body content here");
    }

    #[test]
    fn test_parse_markdown_with_allowed_tools() {
        let content = "---\ndescription: Test\nallowed-tools:\n  - Bash\n  - Read\n---\nBody";
        let (fm, body) = parse_markdown_with_frontmatter(content);
        let fm = fm.unwrap();
        assert_eq!(fm.allowed_tools.unwrap(), vec!["Bash", "Read"]);
        assert_eq!(body, "Body");
    }

    #[test]
    fn test_parse_markdown_unclosed_frontmatter() {
        let content = "---\ndescription: Test\nno closing delimiter";
        let (fm, body) = parse_markdown_with_frontmatter(content);
        assert!(fm.is_none());
        assert_eq!(body, content);
    }

    #[test]
    fn test_extract_command_info_simple() {
        let base = Path::new("/commands");
        let file = Path::new("/commands/greet.md");
        let (name, namespace) = extract_command_info(file, base).unwrap();
        assert_eq!(name, "greet");
        assert!(namespace.is_none());
    }

    #[test]
    fn test_extract_command_info_nested() {
        let base = Path::new("/commands");
        let file = Path::new("/commands/tools/lint.md");
        let (name, namespace) = extract_command_info(file, base).unwrap();
        assert_eq!(name, "lint");
        assert_eq!(namespace.unwrap(), "tools");
    }

    #[test]
    fn test_extract_command_info_deeply_nested() {
        let base = Path::new("/commands");
        let file = Path::new("/commands/tools/rust/clippy.md");
        let (name, namespace) = extract_command_info(file, base).unwrap();
        assert_eq!(name, "clippy");
        assert_eq!(namespace.unwrap(), "tools:rust");
    }

    #[test]
    fn test_extract_command_info_strips_extension() {
        let base = Path::new("/base");
        let file = Path::new("/base/my-command.md");
        let (name, _) = extract_command_info(file, base).unwrap();
        assert_eq!(name, "my-command");
    }

    // --- SKILL.md frontmatter parsing tests ---

    #[test]
    fn test_parse_skill_frontmatter_with_extra_fields() {
        // Real SKILL.md format: has name, description, license, metadata — extra fields
        let content = "---\nname: biopython\ndescription: Comprehensive molecular biology toolkit.\nlicense: Unknown\nmetadata:\n    skill-author: K-Dense Inc.\n---\n\n# Biopython\n\nBody here.";
        let (fm, body) = parse_markdown_with_frontmatter(content);
        assert!(
            fm.is_some(),
            "Frontmatter with unknown fields (license, metadata) should parse successfully"
        );
        let fm = fm.unwrap();
        assert_eq!(fm.description.unwrap(), "Comprehensive molecular biology toolkit.");
        assert_eq!(fm.name.unwrap(), "biopython");
        assert!(body.contains("# Biopython"));
    }

    #[test]
    fn test_parse_skill_frontmatter_minimal() {
        let content = "---\nname: scanpy\ndescription: scRNA-seq analysis\n---\n\n# Scanpy";
        let (fm, _body) = parse_markdown_with_frontmatter(content);
        assert!(fm.is_some());
        let fm = fm.unwrap();
        assert_eq!(fm.name.unwrap(), "scanpy");
        assert_eq!(fm.description.unwrap(), "scRNA-seq analysis");
    }

    #[test]
    fn test_parse_skill_frontmatter_with_string_allowed_tools() {
        // Some SKILL.md files have allowed-tools as a bare string, not a list
        let content = "---\nname: bgpt\ndescription: Search papers.\nallowed-tools: Bash\nlicense: MIT\n---\n\n# BGPT";
        let (fm, _body) = parse_markdown_with_frontmatter(content);
        assert!(
            fm.is_some(),
            "Frontmatter with allowed-tools as string should still parse"
        );
        let fm = fm.unwrap();
        assert_eq!(fm.description.unwrap(), "Search papers.");
    }

    #[test]
    fn test_parse_skill_frontmatter_with_space_separated_allowed_tools() {
        // e.g. "allowed-tools: Read Write Edit Bash"
        let content = "---\nname: writer\ndescription: Write stuff.\nallowed-tools: Read Write Edit Bash\n---\n\nBody";
        let (fm, _body) = parse_markdown_with_frontmatter(content);
        assert!(
            fm.is_some(),
            "Frontmatter with space-separated allowed-tools should parse"
        );
        let fm = fm.unwrap();
        assert_eq!(fm.description.unwrap(), "Write stuff.");
    }

    #[test]
    fn test_load_skills_from_dir() {
        let dir = tempfile::tempdir().unwrap();

        // Create a skill with full SKILL.md frontmatter (including extra fields)
        let skill_dir = dir.path().join("biopython");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: biopython\ndescription: Molecular biology toolkit.\nlicense: Unknown\nmetadata:\n    skill-author: Test\n---\n\n# Biopython\n\nBody.",
        )
        .unwrap();

        // Create a skill without frontmatter
        let skill_dir2 = dir.path().join("custom-tool");
        fs::create_dir_all(&skill_dir2).unwrap();
        fs::write(
            skill_dir2.join("SKILL.md"),
            "# Custom Tool\n\nA custom tool description.",
        )
        .unwrap();

        // Non-skill directory (no SKILL.md)
        let non_skill = dir.path().join("not-a-skill");
        fs::create_dir_all(&non_skill).unwrap();
        fs::write(non_skill.join("README.md"), "nothing").unwrap();

        let skills = load_skills_from_dir(dir.path(), "skill");

        assert_eq!(skills.len(), 2, "Should find 2 skills, skip dir without SKILL.md");

        let bio = skills.iter().find(|s| s.full_command == "/biopython").unwrap();
        assert_eq!(bio.name, "biopython");
        assert_eq!(bio.description.as_deref(), Some("Molecular biology toolkit."));
        assert_eq!(bio.scope, "skill");
        assert!(bio.accepts_arguments);

        let custom = skills.iter().find(|s| s.full_command == "/custom-tool").unwrap();
        assert_eq!(custom.name, "Custom Tool");
        assert!(custom.description.is_none(), "No frontmatter = no description");
    }

    #[test]
    fn test_real_skills_dir() {
        // Test against actual installed skills if available
        let skills_dir = dirs::home_dir().unwrap().join(".claude").join("skills");
        if !skills_dir.exists() {
            eprintln!("SKIP: no skills installed at {:?}", skills_dir);
            return;
        }

        let skills = load_skills_from_dir(&skills_dir, "skill");
        eprintln!("Found {} skills", skills.len());

        let mut missing_desc = Vec::new();
        let mut missing_name = Vec::new();

        for skill in &skills {
            if skill.description.is_none() {
                missing_desc.push(skill.full_command.as_str());
            }
            if skill.name == skill.full_command.trim_start_matches('/') {
                // name fell back to folder name
                missing_name.push(skill.full_command.as_str());
            }
        }

        if !missing_desc.is_empty() {
            eprintln!("Skills WITHOUT description ({}):", missing_desc.len());
            for cmd in &missing_desc {
                eprintln!("  {}", cmd);
            }
        }
        if !missing_name.is_empty() {
            eprintln!("Skills where name == folder ({}):", missing_name.len());
            for cmd in &missing_name {
                eprintln!("  {}", cmd);
            }
        }

        // Print a few samples with descriptions
        for skill in skills.iter().take(5) {
            eprintln!(
                "  {} | name={:?} | desc={:?}",
                skill.full_command,
                skill.name,
                skill.description.as_deref().map(|d| &d[..d.len().min(60)])
            );
        }

        assert!(
            missing_desc.is_empty(),
            "{} skills missing description: {:?}",
            missing_desc.len(),
            missing_desc
        );
    }

    // --- load_command_from_file integration tests ---

    #[test]
    fn test_load_command_from_file_simple() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("greet.md");
        fs::write(&file, "Hello $ARGUMENTS, run !`echo hi` and check @main.tex").unwrap();

        let cmd = load_command_from_file(&file, dir.path(), "project").unwrap();
        assert_eq!(cmd.name, "greet");
        assert!(cmd.namespace.is_none());
        assert_eq!(cmd.full_command, "/greet");
        assert_eq!(cmd.scope, "project");
        assert!(cmd.accepts_arguments);
        assert!(cmd.has_bash_commands);
        assert!(cmd.has_file_references);
        assert!(cmd.description.is_none());
        assert!(cmd.allowed_tools.is_empty());
    }

    #[test]
    fn test_load_command_from_file_with_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("lint.md");
        let content = "---\ndescription: Run linter\nallowed-tools:\n  - Bash\n  - Read\n---\nLint the project";
        fs::write(&file, content).unwrap();

        let cmd = load_command_from_file(&file, dir.path(), "user").unwrap();
        assert_eq!(cmd.name, "lint");
        assert_eq!(cmd.description.unwrap(), "Run linter");
        assert_eq!(cmd.allowed_tools, vec!["Bash", "Read"]);
        assert_eq!(cmd.content, "Lint the project");
    }

    #[test]
    fn test_load_command_from_file_nested_namespace() {
        let dir = tempfile::tempdir().unwrap();
        let ns_dir = dir.path().join("tools").join("rust");
        fs::create_dir_all(&ns_dir).unwrap();
        let file = ns_dir.join("clippy.md");
        fs::write(&file, "Run clippy").unwrap();

        let cmd = load_command_from_file(&file, dir.path(), "project").unwrap();
        assert_eq!(cmd.name, "clippy");
        assert_eq!(cmd.namespace.unwrap(), "tools:rust");
        assert_eq!(cmd.full_command, "/tools:rust:clippy");
    }

    // --- find_markdown_files integration tests ---

    #[test]
    fn test_find_markdown_files_collects_md_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("cmd1.md"), "a").unwrap();
        fs::write(dir.path().join("cmd2.md"), "b").unwrap();
        fs::write(dir.path().join("notes.txt"), "c").unwrap();
        fs::write(dir.path().join("data.json"), "d").unwrap();

        let mut files = Vec::new();
        find_markdown_files(dir.path(), &mut files);

        assert_eq!(files.len(), 2);
        let names: Vec<String> = files.iter().map(|f| f.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert!(names.contains(&"cmd1.md".to_string()));
        assert!(names.contains(&"cmd2.md".to_string()));
    }

    #[test]
    fn test_find_markdown_files_skips_hidden_dirs() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("visible.md"), "ok").unwrap();
        let hidden = dir.path().join(".hidden");
        fs::create_dir_all(&hidden).unwrap();
        fs::write(hidden.join("secret.md"), "hidden").unwrap();

        let mut files = Vec::new();
        find_markdown_files(dir.path(), &mut files);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].file_name().unwrap().to_str().unwrap(), "visible.md");
    }

    #[test]
    fn test_find_markdown_files_recursive() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("top.md"), "top").unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("nested.md"), "nested").unwrap();

        let mut files = Vec::new();
        find_markdown_files(dir.path(), &mut files);

        assert_eq!(files.len(), 2);
        let names: Vec<String> = files.iter().map(|f| f.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert!(names.contains(&"top.md".to_string()));
        assert!(names.contains(&"nested.md".to_string()));
    }

    // --- remove_empty_dirs integration tests ---

    #[test]
    fn test_remove_empty_dirs_removes_nested_empty() {
        let dir = tempfile::tempdir().unwrap();
        let deep = dir.path().join("a").join("b").join("c");
        fs::create_dir_all(&deep).unwrap();

        remove_empty_dirs(&deep);

        assert!(!dir.path().join("a").exists(), "entire empty chain should be removed");
    }

    #[test]
    fn test_remove_empty_dirs_stops_at_nonempty() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("a");
        let child = parent.join("b");
        fs::create_dir_all(&child).unwrap();
        fs::write(parent.join("keep.txt"), "x").unwrap();

        remove_empty_dirs(&child);

        assert!(!child.exists(), "empty child should be removed");
        assert!(parent.exists(), "parent with file should be kept");
    }

    #[test]
    fn test_remove_empty_dirs_nonexistent_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("nonexistent");
        // Should not panic
        remove_empty_dirs(&fake);
    }

    // --- create_default_commands ---

    #[test]
    fn test_create_default_commands_structure() {
        let cmds = create_default_commands();
        assert_eq!(cmds.len(), 3);
        let names: Vec<&str> = cmds.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"add-dir"));
        assert!(names.contains(&"init"));
        assert!(names.contains(&"review"));
        for cmd in &cmds {
            assert_eq!(cmd.scope, "default");
            assert!(cmd.full_command.starts_with('/'));
        }
    }

    // --- slash_command_save integration tests ---

    #[tokio::test]
    async fn test_slash_command_save_project_scope() {
        let dir = tempfile::tempdir().unwrap();
        let project_path = dir.path().to_string_lossy().to_string();

        let result = slash_command_save(
            "project".into(),
            "test-cmd".into(),
            None,
            "Do something".into(),
            None,
            vec![],
            Some(project_path.clone()),
        )
        .await;

        assert!(result.is_ok());
        let cmd = result.unwrap();
        assert_eq!(cmd.name, "test-cmd");
        assert_eq!(cmd.full_command, "/test-cmd");
        assert_eq!(cmd.content, "Do something");

        // Verify file was created
        let file = dir.path().join(".claude").join("commands").join("test-cmd.md");
        assert!(file.exists());
        assert_eq!(fs::read_to_string(&file).unwrap(), "Do something");
    }

    #[tokio::test]
    async fn test_slash_command_save_with_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        let project_path = dir.path().to_string_lossy().to_string();

        let cmd = slash_command_save(
            "project".into(),
            "lint".into(),
            None,
            "Run the linter".into(),
            Some("Lint all files".into()),
            vec!["Bash".into(), "Read".into()],
            Some(project_path),
        )
        .await
        .unwrap();

        assert_eq!(cmd.description.unwrap(), "Lint all files");
        assert_eq!(cmd.allowed_tools, vec!["Bash", "Read"]);

        // Verify frontmatter in file
        let file = dir.path().join(".claude").join("commands").join("lint.md");
        let content = fs::read_to_string(&file).unwrap();
        assert!(content.starts_with("---\n"));
        assert!(content.contains("description: Lint all files"));
        assert!(content.contains("- Bash"));
    }

    #[tokio::test]
    async fn test_slash_command_save_with_namespace() {
        let dir = tempfile::tempdir().unwrap();
        let project_path = dir.path().to_string_lossy().to_string();

        let cmd = slash_command_save(
            "project".into(),
            "clippy".into(),
            Some("tools:rust".into()),
            "Run clippy".into(),
            None,
            vec![],
            Some(project_path),
        )
        .await
        .unwrap();

        assert_eq!(cmd.name, "clippy");
        assert_eq!(cmd.namespace.unwrap(), "tools:rust");
        assert_eq!(cmd.full_command, "/tools:rust:clippy");

        // Verify nested directory structure
        let file = dir.path().join(".claude").join("commands").join("tools").join("rust").join("clippy.md");
        assert!(file.exists());
    }

    #[tokio::test]
    async fn test_slash_command_save_empty_name_errors() {
        let result = slash_command_save(
            "project".into(),
            "".into(),
            None,
            "content".into(),
            None,
            vec![],
            Some("/tmp".into()),
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[tokio::test]
    async fn test_slash_command_save_invalid_scope_errors() {
        let result = slash_command_save(
            "global".into(),
            "test".into(),
            None,
            "content".into(),
            None,
            vec![],
            None,
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid scope"));
    }
}
