use super::document::{
    normalize_model, normalize_thinking, normalize_tools, parse_record, render_document,
    rewrite_front_matter,
};
use super::*;
use crate::agent_capabilities::{test_support, CapabilityTarget};
use std::fs;
use tempfile::tempdir;

#[test]
fn parser_rejects_missing_description() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("agent.md");
    fs::write(&path, "---\nname: agent\n---\n\nDo it\n").unwrap();
    let state = CapabilityState::new(dir.path(), SUBAGENT_KIND);
    assert!(parse_record(&path, &state, CapabilityLevel::Global, None).is_none());
}

#[test]
fn tools_are_normalized_and_unknown_tools_are_dropped() {
    assert_eq!(
        normalize_tools(Some(&vec!["read".into(), "Nope".into(), "Bash".into()])),
        vec!["Read", "Bash"]
    );
}

#[test]
fn inherit_token_is_kept_and_unknown_tools_still_drop() {
    assert_eq!(
        normalize_tools(Some(&vec!["inherit".into()])),
        vec!["inherit"]
    );
    assert_eq!(
        normalize_tools(Some(&vec!["inherit".into(), "Bash".into(), "Nope".into()])),
        vec!["inherit".to_string(), "Bash".to_string()]
    );
}

#[test]
fn inherit_only_documents_round_trip() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("worker.md");
    fs::write(
        &path,
        "---\nname: worker\ndescription: Uses the parent tools.\ntools: inherit\n---\n\nDo the job.\n",
    )
    .unwrap();
    let state = CapabilityState::new(dir.path(), SUBAGENT_KIND);
    let record = parse_record(&path, &state, CapabilityLevel::Global, None)
        .expect("inherit-only document must load");
    assert_eq!(record.tools, vec!["inherit"]);
    let rendered = render_document(&record, "Do the job.");
    assert!(rendered.contains("tools: inherit\n"));
    assert!(!rendered.contains("tools: [inherit]"));
}

/// The record `parse_record` reads from a document with this frontmatter.
fn scanned(front: &str) -> Option<UserSubagentRecord> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("worker.md");
    fs::write(&path, format!("{front}\n---\n\nDo the job.\n")).unwrap();
    let state = CapabilityState::new(dir.path(), SUBAGENT_KIND);
    parse_record(&path, &state, CapabilityLevel::Global, None)
}

fn scanned_tools(front: &str) -> Option<Vec<String>> {
    scanned(front).map(|record| record.tools)
}

#[test]
fn a_document_that_says_nothing_about_tools_inherits() {
    for front in [
        "---\ndescription: Says nothing.",
        "---\ndescription: Opens a list and leaves it empty.\ntools:\nmodel: openai/gpt-5",
        // A nested map's key is not the document's `tools` field.
        "---\ndescription: Nested.\nhooks:\n  tools: [Read]",
    ] {
        assert_eq!(
            scanned_tools(front),
            Some(vec!["inherit".to_string()]),
            "{front}"
        );
    }
    let record = scanned("---\ndescription: Says nothing.").unwrap();
    // Saving from Settings writes the grant down instead of changing it.
    assert!(render_document(&record, "Do the job.").contains("tools: inherit\n"));
}

#[test]
fn a_document_that_names_tools_gets_exactly_those() {
    for (front, expected) in [
        (
            "---\ndescription: Inline.\ntools: Read, Grep",
            vec!["Read", "Grep"],
        ),
        (
            "---\ndescription: Bracketed.\ntools: [Read, Bash]",
            vec!["Read", "Bash"],
        ),
        (
            "---\ndescription: Quoted.\ntools: \"Read, Edit\"",
            vec!["Read", "Edit"],
        ),
        // A block list used to be read as no declaration at all.
        (
            "---\ndescription: Block.\ntools:\n  - Read\n  - 'Glob'",
            vec!["Read", "Glob"],
        ),
        (
            "\u{feff}---\r\ndescription: CRLF.\r\ntools:\r\n  - Read",
            vec!["Read"],
        ),
        // An explicitly empty list is not an omission: it stays read-only.
        (
            "---\ndescription: Empty.\ntools: []",
            vec!["Read", "Glob", "Grep"],
        ),
    ] {
        assert_eq!(
            scanned_tools(front),
            Some(expected.into_iter().map(String::from).collect()),
            "{front}"
        );
    }
    // Naming only tools nobody knows is still a malformed grant.
    assert_eq!(
        scanned_tools("---\ndescription: Unknown.\ntools: [Nope]"),
        None
    );
}

#[test]
fn fallback_pins_survive_record_document_round_trips() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("worker.md");
    fs::write(&path, "---\nname: worker\ndescription: Fixture.\nmodel: primary/model\nfallbackModels: [backup/one, Other Gateway/vendor/two]\n---\n\nKeep the body.\n").unwrap();
    let state = CapabilityState::new(dir.path(), SUBAGENT_KIND);
    let mut record = parse_record(&path, &state, CapabilityLevel::Global, None).unwrap();
    assert_eq!(
        record.fallback_models,
        vec!["backup/one", "Other Gateway/vendor/two"]
    );
    let wire = serde_json::to_value(&record).unwrap();
    assert_eq!(
        wire["fallbackModels"],
        serde_json::json!(["backup/one", "Other Gateway/vendor/two"])
    );
    fs::write(&path, render_document(&record, "Keep the body.")).unwrap();
    assert_eq!(
        parse_record(&path, &state, CapabilityLevel::Global, None)
            .unwrap()
            .fallback_models,
        record.fallback_models
    );
    record.fallback_models.clear();
    let cleared = render_document(&record, "Keep the body.");
    assert!(!cleared.contains("fallbackModels"));
    fs::write(&path, cleared).unwrap();
    assert!(parse_record(&path, &state, CapabilityLevel::Global, None)
        .unwrap()
        .fallback_models
        .is_empty());
    let old: UserSubagentInput = serde_json::from_str("{}").unwrap();
    assert!(old.fallback_models.is_none());
    let clear: UserSubagentInput = serde_json::from_str(r#"{"fallbackModels":[]}"#).unwrap();
    assert_eq!(clear.fallback_models, Some(vec![]));
}

#[test]
fn omit_is_a_valid_thinking_override() {
    assert_eq!(normalize_thinking(Some("omit")), Some("omit".into()));
    assert_eq!(normalize_thinking(Some(" OMIT ")), Some("omit".into()));
}

#[test]
fn document_contains_no_activation_state() {
    let record = UserSubagentRecord {
        id: "review".into(),
        name: "review".into(),
        level: Some("global".into()),
        project_path: None,
        description: "Review code".into(),
        enabled: false,
        scope: ActivationScope::default(),
        tools: vec!["Read".into()],
        model: None,
        fallback_models: Vec::new(),
        thinking_level: None,
        max_tokens: None,
        path: "/tmp/review.md".into(),
        size_bytes: 0,
        created_at: String::new(),
        updated_at: String::new(),
    };
    assert!(!render_document(&record, "Review it").contains("enabled"));
}

#[test]
fn an_output_cap_is_written_and_an_absent_one_is_omitted() {
    let mut record = UserSubagentRecord {
        id: "review".into(),
        name: "review".into(),
        level: Some("global".into()),
        project_path: None,
        description: "Review code".into(),
        enabled: true,
        scope: ActivationScope::default(),
        tools: vec!["Read".into()],
        model: None,
        fallback_models: Vec::new(),
        thinking_level: None,
        max_tokens: Some(16_000),
        path: "/tmp/review.md".into(),
        size_bytes: 0,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let document = render_document(&record, "Review it");
    assert!(document.contains("maxTokens: 16000\n"));

    // Absent means "follow the model", so the key must not appear at all —
    // a written `maxTokens: 0` would read back as an explicit empty cap.
    record.max_tokens = None;
    assert!(!render_document(&record, "Review it").contains("maxTokens"));
}

#[test]
fn legacy_max_turns_frontmatter_is_ignored() {
    // The turn limit is gone (ADR 0253). A document that still declares the
    // key must load like any other unknown frontmatter key: keys are only
    // lowercased, so `maxTurns` used to normalize to `maxturns`, while
    // `max-turns` was never read in the first place.
    let dir = tempdir().unwrap();
    let path = dir.path().join("worker.md");
    fs::write(
        &path,
        "---\nname: worker\ndescription: Uses the parent tools.\ntools: [Read]\nmaxTurns: 20\nmax-turns: 20\n---\n\nDo the job.\n",
    )
    .unwrap();
    let state = CapabilityState::new(dir.path(), SUBAGENT_KIND);
    let record = parse_record(&path, &state, CapabilityLevel::Global, None)
        .expect("a legacy maxTurns key must not fail the load");
    assert_eq!(record.description, "Uses the parent tools.");
    assert!(!render_document(&record, "Do the job.").contains("maxTurns"));
}

#[test]
fn a_model_pin_requires_a_slash_and_keeps_the_users_spelling() {
    // The shape is `provider/model`; the provider half may be a vendor key
    // or a display name, and a custom endpoint's name contains spaces.
    assert_eq!(
        normalize_model(Some("anthropic/claude-haiku-4-5")).unwrap(),
        Some("anthropic/claude-haiku-4-5".into())
    );
    assert_eq!(
        normalize_model(Some("  My Gateway/local-model  ")).unwrap(),
        Some("My Gateway/local-model".into())
    );
    // An openrouter-style model id keeps its own slashes.
    assert_eq!(
        normalize_model(Some("openrouter/deepseek/deepseek-chat")).unwrap(),
        Some("openrouter/deepseek/deepseek-chat".into())
    );
}

#[test]
fn a_cleared_model_is_none_and_a_malformed_one_is_rejected() {
    assert_eq!(normalize_model(None).unwrap(), None);
    assert_eq!(normalize_model(Some("   ")).unwrap(), None);

    // A bare id has no provider to look up, so the runtime could never
    // resolve it; the editor rejects the same shape before saving.
    assert!(normalize_model(Some("claude-haiku-4-5")).is_err());
    assert!(normalize_model(Some("/claude-haiku-4-5")).is_err());
    assert!(normalize_model(Some("anthropic/")).is_err());
}

#[test]
fn builtins_are_enabled_until_one_is_turned_off() {
    let dir = tempdir().unwrap();
    let mut registry = UserSubagentRegistry::new(dir.path());
    assert!(registry.disabled_builtins().is_empty());

    let handle = registry.set_builtin_enabled("Fixer", false).unwrap();
    assert_eq!(handle, "fixer");
    assert_eq!(registry.disabled_builtins(), vec!["fixer".to_string()]);

    registry.set_builtin_enabled("fixer", true).unwrap();
    assert!(registry.disabled_builtins().is_empty());
}

#[test]
fn builtin_state_survives_a_registry_rebuild() {
    let dir = tempdir().unwrap();
    let mut registry = UserSubagentRegistry::new(dir.path());
    registry.set_builtin_enabled("fixer", false).unwrap();
    registry
        .set_builtin_enabled("code-reviewer", false)
        .unwrap();

    let reopened = UserSubagentRegistry::new(dir.path());
    // Sorted, so the answer never depends on insertion order.
    assert_eq!(
        reopened.disabled_builtins(),
        vec!["code-reviewer".to_string(), "fixer".to_string()]
    );
}

#[test]
fn a_blank_builtin_handle_is_rejected() {
    let dir = tempdir().unwrap();
    let mut registry = UserSubagentRegistry::new(dir.path());
    let error = registry.set_builtin_enabled("   ", false).unwrap_err();
    assert!(error.to_string().contains("SUBAGENT_INVALID"));
    assert!(registry.disabled_builtins().is_empty());
}

#[test]
fn listing_documents_does_not_prune_builtin_state() {
    // The scan prunes state for ids it did not find. A builtin has no
    // document at all, so the two kinds must never share one state file or
    // the first `list()` would delete every builtin the user turned off.
    let dir = tempdir().unwrap();
    let agents = tempdir().unwrap();
    let mut registry = UserSubagentRegistry::new(dir.path());
    registry.set_builtin_enabled("fixer", false).unwrap();

    test_support::with_global_agents(agents.path(), || {
        registry.list(CapabilityLevel::Global, None).unwrap();
    });
    assert_eq!(registry.disabled_builtins(), vec!["fixer".to_string()]);

    // And a rebuilt registry still agrees after the listing.
    let mut reopened = UserSubagentRegistry::new(dir.path());
    test_support::with_global_agents(agents.path(), || {
        reopened.list(CapabilityLevel::Global, None).unwrap();
    });
    assert_eq!(reopened.disabled_builtins(), vec!["fixer".to_string()]);

    // The document kind keeps its own file, so the builtin entry is not
    // mistaken for a user subagent either.
    assert!(dir
        .path()
        .join("agent-capabilities/subagent-builtins.json")
        .exists());
}

fn write_agent(dir: &std::path::Path, stem: &str, front: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join(format!("{stem}.md")),
        format!("---\n{front}\n---\n\nDo the job.\n"),
    )
    .unwrap();
}

/// A registry, an isolated global root, and a project root with its own
/// `.agents/subagents` directory.
struct Levels {
    data: tempfile::TempDir,
    agents: tempfile::TempDir,
    project: tempfile::TempDir,
}

impl Levels {
    fn new() -> Self {
        Self {
            data: tempdir().unwrap(),
            agents: tempdir().unwrap(),
            project: tempdir().unwrap(),
        }
    }

    fn global_dir(&self) -> std::path::PathBuf {
        self.agents.path().join("subagents")
    }

    fn project_dir(&self) -> std::path::PathBuf {
        self.project.path().join(".agents").join("subagents")
    }

    fn project_path(&self) -> String {
        self.project.path().to_string_lossy().to_string()
    }

    fn run<T>(&self, f: impl FnOnce(&mut UserSubagentRegistry) -> T) -> T {
        let mut registry = UserSubagentRegistry::new(self.data.path());
        test_support::with_global_agents(self.agents.path(), || f(&mut registry))
    }
}

#[test]
fn a_project_document_is_listed_at_its_own_level_only() {
    let levels = Levels::new();
    write_agent(
        &levels.global_dir(),
        "mine",
        "name: mine\ndescription: Global.",
    );
    write_agent(
        &levels.project_dir(),
        "repo",
        "name: repo\ndescription: Project.",
    );
    let project = levels.project_path();
    levels.run(|registry| {
        let global = registry.list(CapabilityLevel::Global, None).unwrap();
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].id, "mine");
        assert_eq!(global[0].level.as_deref(), Some("global"));
        assert_eq!(global[0].project_path, None);

        let scoped = registry
            .list(CapabilityLevel::Project, Some(&project))
            .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].id, "repo");
        assert_eq!(scoped[0].level.as_deref(), Some("project"));
        assert!(scoped[0].project_path.is_some());
    });
}

#[test]
fn a_project_level_query_requires_its_project() {
    let levels = Levels::new();
    levels.run(|registry| {
        let error = registry
            .list(CapabilityLevel::Project, None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("CAPABILITY_INVALID"), "{error}");
    });
}

#[test]
fn a_session_without_a_project_sees_global_documents_only() {
    let levels = Levels::new();
    write_agent(
        &levels.global_dir(),
        "mine",
        "name: mine\ndescription: Global.",
    );
    write_agent(
        &levels.project_dir(),
        "repo",
        "name: repo\ndescription: Project.",
    );
    levels.run(|registry| {
        let active = registry.active_for(None).unwrap();
        let ids: Vec<_> = active.subagents.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["mine"]);
        assert!(active.suppressed_handles.is_empty());
    });
}

#[test]
fn a_project_document_shadows_the_global_one_of_the_same_handle() {
    let levels = Levels::new();
    write_agent(
        &levels.global_dir(),
        "reviewer",
        "name: reviewer\ndescription: Global reviewer.",
    );
    write_agent(
        &levels.global_dir(),
        "mine",
        "name: mine\ndescription: Global.",
    );
    write_agent(
        &levels.project_dir(),
        "reviewer",
        "name: reviewer\ndescription: Project reviewer.",
    );
    let project = levels.project_path();
    levels.run(|registry| {
        let active = registry.active_for(Some(&project)).unwrap();
        let seen: Vec<_> = active
            .subagents
            .iter()
            .map(|r| (r.id.as_str(), r.level.as_deref().unwrap_or("")))
            .collect();
        assert_eq!(seen, vec![("mine", "global"), ("reviewer", "project")]);
        assert_eq!(
            active
                .subagents
                .iter()
                .find(|r| r.id == "reviewer")
                .unwrap()
                .description,
            "Project reviewer."
        );
        assert!(active.suppressed_handles.is_empty());
    });
}

#[test]
fn a_disabled_project_document_keeps_the_handle_claimed() {
    // Shadowing is resolved before the enabled filter (ADR 0112 §3): switching
    // the project document off must not bring the global one back, and the
    // handle is reported so the runtime keeps the builtin out as well.
    let levels = Levels::new();
    write_agent(
        &levels.global_dir(),
        "explorer",
        "name: explorer\ndescription: Global explorer.",
    );
    write_agent(
        &levels.project_dir(),
        "explorer",
        "name: explorer\ndescription: Project explorer.",
    );
    let project = levels.project_path();
    levels.run(|registry| {
        registry
            .set_enabled("explorer", false, CapabilityLevel::Project, Some(&project))
            .unwrap()
            .expect("the project document exists");
        let active = registry.active_for(Some(&project)).unwrap();
        assert!(active.subagents.is_empty());
        assert_eq!(active.suppressed_handles, vec!["explorer".to_string()]);

        // The global document is untouched for every other project.
        let elsewhere = registry.active_for(None).unwrap();
        assert_eq!(elsewhere.subagents.len(), 1);
        assert_eq!(elsewhere.subagents[0].level.as_deref(), Some("global"));
        assert!(elsewhere.suppressed_handles.is_empty());
    });
}

#[test]
fn project_state_belongs_to_the_owning_project() {
    let levels = Levels::new();
    let other = tempdir().unwrap();
    let other_dir = other.path().join(".agents").join("subagents");
    write_agent(
        &levels.project_dir(),
        "repo",
        "name: repo\ndescription: One.",
    );
    write_agent(&other_dir, "repo", "name: repo\ndescription: Two.");
    let project = levels.project_path();
    let other_path = other.path().to_string_lossy().to_string();
    levels.run(|registry| {
        registry
            .set_enabled("repo", false, CapabilityLevel::Project, Some(&project))
            .unwrap();
        let mine = registry
            .list(CapabilityLevel::Project, Some(&project))
            .unwrap();
        let theirs = registry
            .list(CapabilityLevel::Project, Some(&other_path))
            .unwrap();
        assert!(!mine[0].enabled);
        assert!(
            theirs[0].enabled,
            "another project's document keeps its own state"
        );

        // Scanning one project prunes nothing that belongs to the other.
        fs::remove_file(other_dir.join("repo.md")).unwrap();
        registry
            .list(CapabilityLevel::Project, Some(&other_path))
            .unwrap();
        let mine = registry
            .list(CapabilityLevel::Project, Some(&project))
            .unwrap();
        assert!(!mine[0].enabled);
    });
}

#[test]
fn create_update_and_remove_address_the_project_directory() {
    let levels = Levels::new();
    let project = levels.project_path();
    levels.run(|registry| {
        let created = registry
            .create(UserSubagentInput {
                name: Some("repo-helper".into()),
                description: Some("Helps in this repository.".into()),
                level: Some("project".into()),
                project_path: Some(project.clone()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(created.level.as_deref(), Some("project"));
        assert!(levels.project_dir().join("repo-helper.md").is_file());
        assert!(!levels.global_dir().join("repo-helper.md").exists());

        // The same handle is free at the other level.
        registry
            .create(UserSubagentInput {
                name: Some("repo-helper".into()),
                description: Some("Mine.".into()),
                ..Default::default()
            })
            .unwrap();

        let updated = registry
            .update(
                "repo-helper",
                UserSubagentInput {
                    description: Some("Updated in the project.".into()),
                    level: Some("project".into()),
                    project_path: Some(project.clone()),
                    ..Default::default()
                },
            )
            .unwrap()
            .expect("the project document exists");
        assert_eq!(updated.description, "Updated in the project.");
        let (global, _) = registry
            .read("repo-helper", CapabilityLevel::Global, None)
            .unwrap()
            .unwrap();
        assert_eq!(global.description, "Mine.");

        assert!(registry
            .remove("repo-helper", CapabilityLevel::Project, Some(&project))
            .unwrap());
        assert!(!levels.project_dir().join("repo-helper.md").exists());
        assert!(levels.global_dir().join("repo-helper.md").is_file());
    });
}

#[test]
fn create_never_overwrites_a_document_the_scan_skipped() {
    let levels = Levels::new();
    fs::create_dir_all(levels.project_dir()).unwrap();
    // No description, so the scan does not list it, but the file is the
    // repository's and must survive.
    fs::write(levels.project_dir().join("draft.md"), "work in progress\n").unwrap();
    let project = levels.project_path();
    levels.run(|registry| {
        let error = registry
            .create(UserSubagentInput {
                name: Some("draft".into()),
                description: Some("New.".into()),
                level: Some("project".into()),
                project_path: Some(project.clone()),
                ..Default::default()
            })
            .unwrap_err()
            .to_string();
        assert!(error.contains("SUBAGENT_INVALID"), "{error}");
    });
    assert_eq!(
        fs::read_to_string(levels.project_dir().join("draft.md")).unwrap(),
        "work in progress\n"
    );
}

#[test]
fn moving_out_of_a_project_drops_the_permission_grant() {
    let levels = Levels::new();
    write_agent(
        &levels.project_dir(),
        "deployer",
        "name: deployer\ndescription: Ships it.\ntools: [Read, Bash]\npermission: auto",
    );
    let project = levels.project_path();
    levels.run(|registry| {
        let from = CapabilityTarget::new(CapabilityLevel::Project, Some(&project)).unwrap();
        let to = CapabilityTarget::new(CapabilityLevel::Global, None).unwrap();
        let moved = registry.transfer("deployer", &from, &to).unwrap();
        assert_eq!(moved.level.as_deref(), Some("global"));
        assert_eq!(moved.tools, vec!["Read", "Bash"]);
    });
    assert!(!levels.project_dir().join("deployer.md").exists());
    let landed = fs::read_to_string(levels.global_dir().join("deployer.md")).unwrap();
    assert!(!landed.to_lowercase().contains("permission"), "{landed}");
    assert!(landed.contains("tools: [Read, Bash]\n"));
    assert!(landed.ends_with("Do the job.\n"));
}

#[test]
fn moving_into_a_project_is_byte_identical() {
    let levels = Levels::new();
    let front = "name: deployer\ndescription: Ships it.\npermission: auto";
    write_agent(&levels.global_dir(), "deployer", front);
    let before = fs::read_to_string(levels.global_dir().join("deployer.md")).unwrap();
    let project = levels.project_path();
    levels.run(|registry| {
        let from = CapabilityTarget::new(CapabilityLevel::Global, None).unwrap();
        let to = CapabilityTarget::new(CapabilityLevel::Project, Some(&project)).unwrap();
        let moved = registry.transfer("deployer", &from, &to).unwrap();
        assert_eq!(moved.level.as_deref(), Some("project"));
    });
    assert_eq!(
        fs::read_to_string(levels.project_dir().join("deployer.md")).unwrap(),
        before
    );
}

#[test]
fn a_move_onto_a_taken_handle_renames_the_arrival_and_keeps_its_state() {
    let levels = Levels::new();
    write_agent(
        &levels.global_dir(),
        "reviewer",
        "name: reviewer\ndescription: Mine.",
    );
    write_agent(
        &levels.project_dir(),
        "reviewer",
        "name: reviewer\ndescription: Theirs.",
    );
    let project = levels.project_path();
    levels.run(|registry| {
        registry
            .set_enabled("reviewer", false, CapabilityLevel::Project, Some(&project))
            .unwrap();
        let from = CapabilityTarget::new(CapabilityLevel::Project, Some(&project)).unwrap();
        let to = CapabilityTarget::new(CapabilityLevel::Global, None).unwrap();
        let moved = registry.transfer("reviewer", &from, &to).unwrap();
        assert_eq!(moved.id, "reviewer-2");
        assert_eq!(moved.description, "Theirs.");
        assert!(!moved.enabled, "the switch the user set travels with it");

        let global = registry.list(CapabilityLevel::Global, None).unwrap();
        let ids: Vec<_> = global.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["reviewer", "reviewer-2"]);
        assert!(global[0].enabled, "the document already there is untouched");
        assert!(registry
            .list(CapabilityLevel::Project, Some(&project))
            .unwrap()
            .is_empty());
    });
}

#[test]
fn front_matter_rewrite_touches_only_the_named_keys() {
    let raw = "\u{feff}---\r\ndescription: Keeps CRLF.\r\nPermission: auto\r\ntools:\r\n  - Read\r\n---\r\n\r\nBody permission: stays.\r\n";
    let rewritten = rewrite_front_matter(raw, Some("fresh"), true);
    assert_eq!(
        rewritten,
        "\u{feff}---\r\ndescription: Keeps CRLF.\r\ntools:\r\n  - Read\r\nname: fresh\r\n---\r\n\r\nBody permission: stays.\r\n"
    );

    // A replaced name keeps its position; an untouched document is unchanged.
    let named = "---\nname: old\ndescription: D.\n---\n\nBody.\n";
    assert_eq!(
        rewrite_front_matter(named, Some("new"), false),
        "---\nname: new\ndescription: D.\n---\n\nBody.\n"
    );
    assert_eq!(rewrite_front_matter(named, None, true), named);

    // No closed frontmatter block: nothing to rewrite.
    let open = "---\nname: old\npermission: auto\n";
    assert_eq!(rewrite_front_matter(open, Some("new"), true), open);
    assert_eq!(
        rewrite_front_matter("plain body\n", Some("new"), true),
        "plain body\n"
    );
}
