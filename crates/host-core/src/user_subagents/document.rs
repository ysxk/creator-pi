//! The subagent document format as host-core reads and writes it: frontmatter
//! normalization, the scanned record, and the rewrite a level move needs.

use super::{model_fallbacks, UserSubagentRecord, SUBAGENT_KIND};
use crate::activation::ActivationScope;
use crate::agent_capabilities::{
    file_timestamp, parse_front_matter, slugify, CapabilityLevel, CapabilityState,
};
use anyhow::{bail, Result};
use std::fs;
use std::path::Path;

pub const MAX_SUBAGENT_BYTES: usize = 32 * 1024;
pub(super) const MAX_NAME_CHARS: usize = 40;
pub(super) const MAX_DESCRIPTION_CHARS: usize = 400;
/// Mirrors `MAX_SUBAGENT_MAX_TOKENS` in `packages/shared`. No published model
/// accepts an output limit above 128k, so a larger declared value is a typo.
pub(super) const MAX_TOKENS_CEILING: u32 = 200_000;
const DEFAULT_TOOLS: [&str; 3] = ["Read", "Glob", "Grep"];
const ASSIGNABLE_TOOLS: [&str; 7] = [
    "Read",
    "Glob",
    "Grep",
    "BrowserPreview",
    "Bash",
    "Edit",
    "Write",
];
const INHERIT_TOKEN: &str = "inherit";
const THINKING_LEVELS: [&str; 8] = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "omit",
];

pub(super) fn normalize_name(value: &str) -> String {
    slugify(value, MAX_NAME_CHARS)
}

pub(super) fn clip(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().take(max_chars).collect()
}

pub(super) fn normalize_tools(requested: Option<&Vec<String>>) -> Vec<String> {
    let requested = requested
        .filter(|tools| !tools.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            DEFAULT_TOOLS
                .iter()
                .map(|tool| (*tool).to_string())
                .collect()
        });
    let mut inherit = false;
    let mut result = Vec::new();
    for tool in &requested {
        let trimmed = tool.trim();
        if trimmed.eq_ignore_ascii_case(INHERIT_TOKEN) {
            inherit = true;
            continue;
        }
        if let Some(canonical) = ASSIGNABLE_TOOLS
            .iter()
            .find(|candidate| candidate.eq_ignore_ascii_case(trimmed))
        {
            if !result.iter().any(|value: &String| value == canonical) {
                result.push((*canonical).to_string());
            }
        }
    }
    if inherit {
        let mut tools = vec![INHERIT_TOKEN.to_string()];
        tools.extend(result);
        tools
    } else {
        result
    }
}

pub(super) fn normalize_thinking(value: Option<&str>) -> Option<String> {
    let candidate = value?.trim().to_lowercase();
    THINKING_LEVELS
        .iter()
        .find(|level| **level == candidate)
        .map(|level| (*level).to_string())
}

/// A definition pin, normalized, or an error when it is not a pin.
///
/// The stored shape is `provider/model`. Only the slash is structural: the
/// provider half is matched by a normalized alias in the runtime
/// (`findProvider`), and a custom endpoint's display name may contain spaces,
/// so those are valid here too. Rejecting a value the editor offers would leave
/// the user with a definition that saves but can never resolve.
pub(super) fn normalize_model(value: Option<&str>) -> Result<Option<String>> {
    let Some(trimmed) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some((provider, model)) = trimmed.split_once('/') else {
        bail!("SUBAGENT_INVALID: `model` must be written as provider/model");
    };
    if provider.is_empty() || model.is_empty() {
        bail!("SUBAGENT_INVALID: `model` must be written as provider/model");
    }
    Ok(Some(trimmed.to_string()))
}

/// Read one document into a record at `level`.
///
/// `owner` is the normalized project path of a project-level document and
/// `None` for a global one. It is both the record's `project_path` and the key
/// its enabled state is stored under, so two projects that each ship a
/// same-named document never share a switch.
pub(super) fn parse_record(
    path: &Path,
    state: &CapabilityState,
    level: CapabilityLevel,
    owner: Option<&str>,
) -> Option<UserSubagentRecord> {
    let raw = fs::read_to_string(path).ok()?;
    if raw.len() > MAX_SUBAGENT_BYTES {
        return None;
    }
    let (front, body) = parse_front_matter(&raw);
    if body.trim().is_empty() {
        return None;
    }
    let fallback = path.file_stem()?.to_str()?;
    let name = normalize_name(front.get("name").map(String::as_str).unwrap_or(fallback));
    let description = clip(front.get("description")?, MAX_DESCRIPTION_CHARS);
    if name.is_empty() || description.is_empty() {
        return None;
    }
    // A document that says nothing about tools inherits the parent session's
    // (D662), as the shared definition parser reads it. One that names tools
    // gets the known ones it names, and an empty list stays read-only.
    let tools = match front_matter_list(&raw, "tools") {
        None => vec![INHERIT_TOKEN.to_string()],
        Some(declared) => normalize_tools(Some(&declared)),
    };
    if tools.is_empty() {
        return None;
    }
    let enabled = state.enabled(SUBAGENT_KIND, level, &name, owner);
    let updated_at = file_timestamp(path);
    let max_tokens = front
        .get("maxtokens")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_TOKENS_CEILING));
    Some(UserSubagentRecord {
        id: name.clone(),
        name,
        level: Some(level.as_str().to_string()),
        project_path: owner.map(str::to_string),
        description,
        enabled,
        scope: ActivationScope::default(),
        tools,
        model: front
            .get("model")
            .cloned()
            .filter(|value| !value.is_empty()),
        fallback_models: model_fallbacks::parse(&raw).ok()?,
        thinking_level: normalize_thinking(front.get("thinkinglevel").map(String::as_str)),
        max_tokens,
        path: path.to_string_lossy().to_string(),
        size_bytes: raw.len() as u64,
        created_at: updated_at.clone(),
        updated_at,
    })
}

pub(super) fn render_document(record: &UserSubagentRecord, body: &str) -> String {
    let mut output = String::from("---\n");
    output.push_str(&format!("name: {}\n", record.name));
    output.push_str(&format!(
        "description: {}\n",
        record.description.replace('\n', " ")
    ));
    if record.tools.len() == 1 && record.tools[0].eq_ignore_ascii_case("inherit") {
        output.push_str("tools: inherit\n");
    } else {
        output.push_str(&format!("tools: [{}]\n", record.tools.join(", ")));
    }
    if let Some(model) = &record.model {
        output.push_str(&format!("model: {model}\n"));
    }
    if !record.fallback_models.is_empty() {
        output.push_str(&format!(
            "fallbackModels: [{}]\n",
            record.fallback_models.join(", ")
        ));
    }
    if let Some(level) = &record.thinking_level {
        output.push_str(&format!("thinkingLevel: {level}\n"));
    }
    if let Some(max_tokens) = record.max_tokens {
        output.push_str(&format!("maxTokens: {max_tokens}\n"));
    }
    output.push_str("---\n\n");
    output.push_str(body.trim());
    output.push('\n');
    output
}

pub(super) fn default_body(name: &str) -> String {
    format!("Do the work the task names and report only what the parent needs. Start with the first concrete step for `{name}`.\n")
}

/// The shared definition parser matches keys loosely (`max-tokens`,
/// `maxTokens`), so a key is compared the same way here.
fn loose_key(key: &str) -> String {
    key.trim()
        .to_lowercase()
        .chars()
        .filter(|ch| !matches!(ch, '-' | '_' | ' '))
        .collect()
}

/// Read a list field the way the shared definition parser does: inline
/// (`[a, b]` / `a, b`) or as `- item` lines under the key.
///
/// `None` means the document says nothing for the key: it is absent, or it
/// opens a block list that has no items. An inline empty list is `Some(vec![])`.
pub(super) fn front_matter_list(raw: &str, key: &str) -> Option<Vec<String>> {
    let mut lines = raw.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    let mut values: Option<Vec<String>> = None;
    let mut collecting = false;
    for raw_line in lines {
        let line = raw_line.trim();
        if line == "---" {
            break;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if collecting {
            if let Some(item) = line.strip_prefix("- ") {
                let item = unquote(item);
                if !item.is_empty() {
                    values.get_or_insert_with(Vec::new).push(item);
                }
                continue;
            }
        }
        collecting = false;
        // An indented `key:` belongs to a nested map, which is not a field.
        if raw_line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((candidate, value)) = line.split_once(':') else {
            continue;
        };
        if loose_key(candidate) != key {
            continue;
        }
        let value = value.trim();
        collecting = value.is_empty();
        values = (!collecting).then(|| {
            unquote(value)
                .trim_matches(['[', ']'])
                .split(',')
                .map(unquote)
                .filter(|entry| !entry.is_empty())
                .collect()
        });
    }
    values
}

fn unquote(value: &str) -> String {
    value.trim().trim_matches(['\'', '"']).trim().to_string()
}

/// Rewrite the frontmatter of a document that is changing level.
///
/// Everything the move does not touch stays byte-identical: the body, the
/// other keys, the line endings and a leading BOM. `name` replaces the declared
/// name (or adds one) when the destination already owns the handle.
/// `strip_permission` drops the `permission` key, which the runtime ignores on a
/// project document: promoting that document to the global level must not
/// switch on a grant the repository's author wrote and the user never chose.
/// A document without a closed frontmatter block is returned unchanged; the
/// definition parser reads no keys from it either.
pub(super) fn rewrite_front_matter(
    raw: &str,
    name: Option<&str>,
    strip_permission: bool,
) -> String {
    let (bom, text) = match raw.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", raw),
    };
    let mut lines = text.split_inclusive('\n');
    let Some(opening) = lines.next() else {
        return raw.to_string();
    };
    if opening.trim() != "---" {
        return raw.to_string();
    }
    let newline = if opening.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut output = String::with_capacity(raw.len() + 48);
    output.push_str(bom);
    output.push_str(opening);
    let mut name_written = false;
    let mut closed = false;
    // A dropped or replaced key may own continuation lines (`- item`, or an
    // indented block scalar); they go with it.
    let mut dropping = false;
    for line in lines.by_ref() {
        let content = line.trim_end_matches(['\n', '\r']);
        if content.trim() == "---" {
            if let Some(name) = name.filter(|_| !name_written) {
                output.push_str(&format!("name: {name}{newline}"));
            }
            output.push_str(line);
            closed = true;
            break;
        }
        let indented = content.starts_with(' ') || content.starts_with('\t');
        if dropping && (indented || content.starts_with('-')) {
            continue;
        }
        dropping = false;
        if !indented {
            if let Some((key, _)) = content.split_once(':') {
                let key = loose_key(key);
                if strip_permission && key == "permission" {
                    dropping = true;
                    continue;
                }
                if key == "name" {
                    if let Some(name) = name {
                        if !name_written {
                            output.push_str(&format!("name: {name}{newline}"));
                            name_written = true;
                        }
                        dropping = true;
                        continue;
                    }
                }
            }
        }
        output.push_str(line);
    }
    if !closed {
        return raw.to_string();
    }
    for line in lines {
        output.push_str(line);
    }
    output
}
