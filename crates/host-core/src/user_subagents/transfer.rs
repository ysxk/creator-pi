//! Moving one subagent document between the global directory and a project's.

use super::document::{rewrite_front_matter, MAX_NAME_CHARS, MAX_SUBAGENT_BYTES};
use super::{UserSubagentRecord, UserSubagentRegistry, MAX_USER_SUBAGENTS, SUBAGENT_KIND};
use crate::agent_capabilities::{
    capability_dir, move_capability_file, set_moved_capability_state, sorted_files,
    suffixed_capability_id, CapabilityLevel, CapabilityTarget,
};
use anyhow::{bail, Context, Result};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

impl UserSubagentRegistry {
    /// Move one document to another level.
    ///
    /// The document moves instead of being copied, like a skill: a copy would
    /// leave the old level answering for a handle the user just reassigned. A
    /// destination that already owns the handle keeps its document, and the
    /// arrival takes a `-2` suffix so both survive.
    ///
    /// Leaving a project is the one direction that rewrites more than the name.
    /// The runtime ignores `permission` on a project document, so that key is
    /// inert while the file sits in the repository; carried to the global level
    /// unchanged it would start granting whatever the repository's author
    /// wrote. It is dropped on the way out, and the user can add their own.
    pub fn transfer(
        &mut self,
        id: &str,
        from: &CapabilityTarget,
        to: &CapabilityTarget,
    ) -> Result<UserSubagentRecord> {
        let Some(source) = self.find(id, from.level, from.project_path.as_deref())? else {
            bail!("SUBAGENT_INVALID: unknown subagent \"{id}\"");
        };
        if from.same_directory(to) {
            return Ok(source);
        }
        let source_path = PathBuf::from(&source.path);
        let raw = fs::read_to_string(&source_path)
            .with_context(|| format!("read {}", source_path.display()))?;
        if raw.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }
        let existing = self.list(to.level, to.project_path.as_deref())?;
        if existing.len() >= MAX_USER_SUBAGENTS {
            bail!("SUBAGENT_INVALID: at most {MAX_USER_SUBAGENTS} subagents");
        }

        let directory = capability_dir(to.level, to.project_path.as_deref(), SUBAGENT_KIND)?;
        // A handle is taken by a scanned record, and a filename by any document
        // in the directory, including one the scan skips as malformed.
        let mut taken: HashSet<String> = existing
            .iter()
            .map(|record| record.id.to_lowercase())
            .collect();
        for path in sorted_files(&directory, "md") {
            if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                taken.insert(stem.to_lowercase());
            }
        }
        let Some((target_id, _)) = suffixed_capability_id(&source.id, &taken, MAX_NAME_CHARS)
        else {
            bail!("SUBAGENT_INVALID: no free name at the destination");
        };
        let target_path = directory.join(format!("{target_id}.md"));
        let renamed = target_id != source.id;
        let leaving_project =
            from.level == CapabilityLevel::Project && to.level == CapabilityLevel::Global;
        let document =
            rewrite_front_matter(&raw, renamed.then_some(target_id.as_str()), leaving_project);
        if document.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }

        let rewritten = document != raw;
        if rewritten {
            if target_path.exists() {
                bail!(
                    "SUBAGENT_INVALID: destination already exists: {}",
                    target_path.display()
                );
            }
            fs::create_dir_all(&directory)?;
            // Written before the source is removed, so a failure in between
            // leaves a duplicate rather than no document at all.
            fs::write(&target_path, &document)
                .with_context(|| format!("write {}", target_path.display()))?;
            fs::remove_file(&source_path)
                .map_err(|error| anyhow::anyhow!("remove {}: {error}", source_path.display()))?;
        } else {
            move_capability_file(&source_path, &target_path)?;
        }

        let landed = self
            .list(to.level, to.project_path.as_deref())?
            .into_iter()
            .find(|record| record.id == target_id);
        let Some(moved) = landed else {
            // On disk but not listed: put the original bytes back so the move
            // strands nothing. State was never written, so nothing else changed.
            fs::remove_file(&target_path).ok();
            fs::write(&source_path, &raw)
                .with_context(|| format!("restore {}", source_path.display()))?;
            bail!("SUBAGENT_INVALID: moved subagent was not found");
        };
        set_moved_capability_state(
            &mut self.state,
            SUBAGENT_KIND,
            from.level,
            &source.id,
            source.project_path.as_deref(),
            to,
            &moved.id,
            source.enabled,
        )?;
        self.find(&moved.id, to.level, to.project_path.as_deref())?
            .ok_or_else(|| anyhow::anyhow!("SUBAGENT_INVALID: moved subagent was not found"))
    }
}
