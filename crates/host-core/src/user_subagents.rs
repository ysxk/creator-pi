mod document;
mod model_fallbacks;
mod transfer;

use crate::activation::ActivationScope;
use crate::agent_capabilities::{
    capability_dir, normalize_project_path, parse_front_matter, sorted_files, CapabilityLevel,
    CapabilityState,
};
use anyhow::{bail, Context, Result};
use chrono::Utc;
use document::{
    clip, default_body, normalize_model, normalize_name, normalize_thinking, normalize_tools,
    parse_record, render_document, MAX_DESCRIPTION_CHARS, MAX_TOKENS_CEILING,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub use document::MAX_SUBAGENT_BYTES;

/// Documents per directory: the global one, and each project's own.
const MAX_USER_SUBAGENTS: usize = 64;
/// Capability directory leaf and state-file kind for subagent documents.
const SUBAGENT_KIND: &str = "subagents";
/// Activation state for the subagent builtins, kept in its own file
/// (`<data-dir>/agent-capabilities/subagent-builtins.json`).
///
/// The builtins are constant documents inside agent-runtime, not files in
/// `~/.agents/subagents`, so the directory scan that `list()` performs can
/// never see their handles. That scan also `prune`s state for records it no
/// longer finds, which would delete every builtin entry as an orphan on the
/// first listing. A separate kind keeps the two catalogs apart, and because a
/// `Global` value is only ever stored for an explicit `false`, the state is
/// lazy and sticky: a handle that is off stays off even while it is absent, so
/// a builtin restored in a later release comes back still disabled.
const SUBAGENT_BUILTIN_KIND: &str = "subagent-builtins";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSubagentRecord {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// The project that owns a project-level document; absent for a global one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub description: String,
    pub enabled: bool,
    #[serde(default)]
    pub scope: ActivationScope,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallback_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    pub path: String,
    #[serde(default)]
    pub size_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSubagentInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub body: Option<String>,
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub fallback_models: Option<Vec<String>>,
    pub thinking_level: Option<String>,
    pub max_tokens: Option<u32>,
    pub enabled: Option<bool>,
    /// `global` (the default) or `project`; names the directory the document
    /// lives in, never a per-project override of a global document.
    pub level: Option<String>,
    pub project_path: Option<String>,
    /// Kept for protocol compatibility; activation is a level, not a scope.
    #[allow(dead_code)]
    pub scope: Option<ActivationScope>,
}

/// What a session on one project may delegate to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActiveSubagents {
    /// Enabled documents of both levels. A global and a project document may
    /// share a name; the runtime's capped merge picks between them.
    pub subagents: Vec<UserSubagentRecord>,
    /// Handles owned by a project document the user switched off. The handle
    /// stays claimed: neither the global document nor the shipped builtin of
    /// the same name may answer for it (ADR 0112 §3 extended to builtins).
    pub suppressed_handles: Vec<String>,
}

pub struct UserSubagentRegistry {
    state: CapabilityState,
    builtins: CapabilityState,
}

/// The level and owner a create/update payload addresses.
fn level_and_owner(input: &UserSubagentInput) -> Result<(CapabilityLevel, Option<String>)> {
    let level = CapabilityLevel::parse(input.level.as_deref())?;
    owner_for(level, input.project_path.as_deref()).map(|owner| (level, owner))
}

/// The project that owns documents at `level`: required for the project level,
/// and deliberately dropped for the global one, whose switch is not per project.
fn owner_for(level: CapabilityLevel, project_path: Option<&str>) -> Result<Option<String>> {
    match level {
        CapabilityLevel::Global => Ok(None),
        CapabilityLevel::Project => project_path
            .map(normalize_project_path)
            .filter(|value| !value.is_empty())
            .map(Some)
            .ok_or_else(|| {
                anyhow::anyhow!("CAPABILITY_INVALID: projectPath is required for project subagents")
            }),
    }
}

/// The candidates for a session: every enabled global document and every
/// enabled project document, each tagged with its level.
///
/// Which of two documents with one name loads is not decided here. The
/// runtime's merge (`mergeSubagentDefinitions`) gives a project document
/// precedence, but only while the project is within its definition cap: a
/// project document past the cap is dropped without claiming its name, and the
/// global one must still be there to answer for it. Removing the global
/// document here, before the cap is known, would leave neither available.
///
/// A switched-off project document is the one shadow resolved here, before the
/// enabled filter (ADR 0112 §3): it keeps the handle claimed, so the global
/// document goes and the handle is reported for the builtin to stay out too.
fn merge_active_records(
    global: Vec<UserSubagentRecord>,
    project: Vec<UserSubagentRecord>,
) -> ActiveSubagents {
    let mut subagents = global;
    let mut suppressed_handles = Vec::new();
    for record in project {
        if record.enabled {
            subagents.push(record);
        } else {
            subagents.retain(|existing| existing.id != record.id);
            suppressed_handles.push(record.id);
        }
    }
    subagents.retain(|record| record.enabled);
    // Stable, so a global document stays ahead of the project one of its name.
    subagents.sort_by(|a, b| a.name.cmp(&b.name));
    suppressed_handles.sort();
    ActiveSubagents {
        subagents,
        suppressed_handles,
    }
}

impl UserSubagentRegistry {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            state: CapabilityState::new(data_dir, SUBAGENT_KIND),
            builtins: CapabilityState::new(data_dir, SUBAGENT_BUILTIN_KIND),
        }
    }

    fn scan_level(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<Vec<UserSubagentRecord>> {
        let owner = owner_for(level, project_path)?;
        let directory = capability_dir(level, owner.as_deref(), SUBAGENT_KIND)?;
        let mut records = Vec::new();
        let mut seen = HashSet::new();
        for path in sorted_files(&directory, "md") {
            let Some(record) = parse_record(&path, &self.state, level, owner.as_deref()) else {
                continue;
            };
            if seen.insert(record.id.clone()) {
                records.push(record);
            }
        }
        let ids = records.iter().map(|record| record.id.clone()).collect();
        self.state
            .prune(SUBAGENT_KIND, level, owner.as_deref(), &ids)?;
        records.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(records)
    }

    /// The documents in one directory: the global one, or one project's.
    pub fn list(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<Vec<UserSubagentRecord>> {
        self.scan_level(level, project_path)
    }

    /// The effective catalog for a session on `project_path`.
    pub fn active_for(&mut self, project_path: Option<&str>) -> Result<ActiveSubagents> {
        let global = self.scan_level(CapabilityLevel::Global, None)?;
        let selected = project_path
            .map(normalize_project_path)
            .filter(|value| !value.is_empty());
        let project = match selected.as_deref() {
            Some(path) => self.scan_level(CapabilityLevel::Project, Some(path))?,
            None => Vec::new(),
        };
        Ok(merge_active_records(global, project))
    }

    fn find(
        &mut self,
        id: &str,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<Option<UserSubagentRecord>> {
        Ok(self
            .scan_level(level, project_path)?
            .into_iter()
            .find(|record| record.id == id))
    }

    pub fn create(&mut self, input: UserSubagentInput) -> Result<UserSubagentRecord> {
        let (level, owner) = level_and_owner(&input)?;
        let name = normalize_name(
            input
                .id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .or(input.name.as_deref())
                .unwrap_or_default(),
        );
        if name.is_empty() {
            bail!("SUBAGENT_INVALID: name is required");
        }
        let description = clip(
            input.description.as_deref().unwrap_or_default(),
            MAX_DESCRIPTION_CHARS,
        );
        if description.is_empty() {
            bail!("SUBAGENT_INVALID: description is required");
        }
        let existing = self.scan_level(level, owner.as_deref())?;
        if existing.iter().any(|record| record.id == name) {
            bail!("SUBAGENT_INVALID: a subagent named \"{name}\" already exists");
        }
        if existing.len() >= MAX_USER_SUBAGENTS {
            bail!("SUBAGENT_INVALID: at most {MAX_USER_SUBAGENTS} subagents");
        }
        let tools = normalize_tools(input.tools.as_ref());
        if tools.is_empty() {
            bail!("SUBAGENT_INVALID: grant at least one known tool");
        }
        let record = UserSubagentRecord {
            id: name.clone(),
            name,
            level: Some(level.as_str().to_string()),
            project_path: owner.clone(),
            description,
            enabled: input.enabled.unwrap_or(true),
            scope: ActivationScope::default(),
            tools,
            model: normalize_model(input.model.as_deref())?,
            fallback_models: model_fallbacks::normalize(
                input.fallback_models.as_deref().unwrap_or(&[]),
            )?,
            thinking_level: normalize_thinking(input.thinking_level.as_deref()),
            max_tokens: input
                .max_tokens
                .filter(|value| *value > 0)
                .map(|value| value.min(MAX_TOKENS_CEILING)),
            path: String::new(),
            size_bytes: 0,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let directory = capability_dir(level, owner.as_deref(), SUBAGENT_KIND)?;
        let path = directory.join(format!("{}.md", record.id));
        if path.exists() {
            // A file the scan skipped (unreadable, no description, an empty
            // body) still owns its filename; never overwrite it.
            bail!(
                "SUBAGENT_INVALID: a document already exists at {}",
                path.display()
            );
        }
        fs::create_dir_all(&directory)?;
        let default_body = default_body(&record.name);
        let body = input.body.as_deref().unwrap_or(default_body.as_str());
        let document = render_document(&record, body);
        if document.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }
        fs::write(&path, &document).with_context(|| format!("write {}", path.display()))?;
        if !record.enabled {
            self.state
                .set_enabled(SUBAGENT_KIND, level, &record.id, owner.as_deref(), false)?;
        }
        self.find(&record.id, level, owner.as_deref())?
            .ok_or_else(|| anyhow::anyhow!("SUBAGENT_INVALID: created subagent was not found"))
    }

    pub fn update(
        &mut self,
        id: &str,
        input: UserSubagentInput,
    ) -> Result<Option<UserSubagentRecord>> {
        let (level, owner) = level_and_owner(&input)?;
        let Some(current) = self.find(id, level, owner.as_deref())? else {
            return Ok(None);
        };
        let name = input
            .name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(normalize_name)
            .unwrap_or_else(|| current.name.clone());
        if name != current.name
            && self
                .scan_level(level, owner.as_deref())?
                .iter()
                .any(|record| record.id == name)
        {
            bail!("SUBAGENT_INVALID: a subagent named \"{name}\" already exists");
        }
        let description = input
            .description
            .as_deref()
            .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
            .unwrap_or_else(|| current.description.clone());
        if description.is_empty() {
            bail!("SUBAGENT_INVALID: description is required");
        }
        let tools = normalize_tools(input.tools.as_ref().or(Some(&current.tools)));
        if tools.is_empty() {
            bail!("SUBAGENT_INVALID: grant at least one known tool");
        }
        let raw = fs::read_to_string(&current.path)?;
        let (_, old_body) = parse_front_matter(&raw);
        let body = input.body.unwrap_or(old_body);
        let mut next = current.clone();
        next.id = name.clone();
        next.name = name.clone();
        next.description = description;
        next.tools = tools;
        next.model = match input.model {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => normalize_model(Some(value.as_str()))?,
            None => current.model,
        };
        if let Some(values) = input.fallback_models {
            next.fallback_models = model_fallbacks::normalize(&values)?;
        }
        next.thinking_level = match input.thinking_level {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => normalize_thinking(Some(value.as_str())),
            None => current.thinking_level,
        };
        next.max_tokens = match input.max_tokens {
            Some(0) => None,
            Some(value) => Some(value.min(MAX_TOKENS_CEILING)),
            None => current.max_tokens,
        };
        next.enabled = input.enabled.unwrap_or(current.enabled);
        next.path = current.path.clone();
        if next.id != current.id {
            next.path = capability_dir(level, owner.as_deref(), SUBAGENT_KIND)?
                .join(format!("{}.md", next.id))
                .to_string_lossy()
                .to_string();
        }
        let document = render_document(&next, &body);
        if document.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }
        fs::write(&next.path, &document)?;
        if next.path != current.path {
            fs::remove_file(&current.path).ok();
        }
        if next.enabled != current.enabled {
            self.state.set_enabled(
                SUBAGENT_KIND,
                level,
                &next.id,
                owner.as_deref(),
                next.enabled,
            )?;
        }
        self.find(&next.id, level, owner.as_deref())
    }

    pub fn read(
        &mut self,
        id: &str,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<Option<(UserSubagentRecord, String)>> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&record.path)?;
        if raw.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }
        let (_, body) = parse_front_matter(&raw);
        Ok(Some((record, body)))
    }

    pub fn remove(
        &mut self,
        id: &str,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<bool> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(false);
        };
        fs::remove_file(&record.path).ok();
        // The rescan prunes the state the removed document owned.
        let _ = self.scan_level(level, project_path)?;
        Ok(true)
    }

    pub fn set_enabled(
        &mut self,
        id: &str,
        enabled: bool,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<Option<UserSubagentRecord>> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(None);
        };
        self.state.set_enabled(
            SUBAGENT_KIND,
            level,
            &record.id,
            record.project_path.as_deref(),
            enabled,
        )?;
        self.find(id, level, project_path)
    }

    pub fn set_scope(
        &mut self,
        id: &str,
        scope: ActivationScope,
    ) -> Result<Option<UserSubagentRecord>> {
        // Scope is not persisted; a document's level is its directory. Kept so
        // an older caller gets the scanned record instead of an error.
        let _ = scope;
        self.find(id, CapabilityLevel::Global, None)
    }

    /// Handles the user turned off among the shipped subagent builtins.
    ///
    /// Read straight from the state file: the builtins have no document to
    /// scan, and the answer must not depend on which of them the running
    /// build happens to define.
    pub fn disabled_builtins(&self) -> Vec<String> {
        self.builtins
            .disabled_ids(SUBAGENT_BUILTIN_KIND, CapabilityLevel::Global)
    }

    /// Turn one builtin handle on or off, returning the normalized handle.
    ///
    /// The handle is normalized exactly like a document id, so the same
    /// spelling reaches the runtime catalog. Nothing is validated against a
    /// current builtin list on purpose: the state is sticky for handles a
    /// later build may reintroduce.
    pub fn set_builtin_enabled(&mut self, handle: &str, enabled: bool) -> Result<String> {
        let name = normalize_name(handle);
        if name.is_empty() {
            bail!("SUBAGENT_INVALID: a builtin handle is required");
        }
        self.builtins.set_enabled(
            SUBAGENT_BUILTIN_KIND,
            CapabilityLevel::Global,
            &name,
            None,
            enabled,
        )?;
        Ok(name)
    }
}

#[cfg(test)]
mod tests;
