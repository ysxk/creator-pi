use anyhow::{bail, Result};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Values = BTreeMap<String, Value>;

pub const FIELDS: &[&str] = &[
    "alias",
    "contextWindow",
    "maxTokens",
    "thinkingLevels",
    "defaultThinkingLevel",
    "thinkingProtocol",
    "supportsImages",
    "supportsVideos",
    "supportsAudio",
    "supportsDocuments",
    "availableForSubagents",
    "nativeWebSearch",
    "systemPrompt",
];

pub fn model_key(id: &str) -> String {
    id.trim().to_ascii_lowercase()
}

pub fn validate_model_id(id: &str) -> Result<String> {
    let key = model_key(id);
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_control) {
        bail!("MODEL_SETTINGS_INVALID: invalid model id");
    }
    Ok(key)
}

pub fn validate_provider_id(id: &str) -> Result<()> {
    if id.trim().is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        bail!("MODEL_SETTINGS_INVALID: invalid provider id");
    }
    Ok(())
}

pub fn validate(values: &Values) -> Result<()> {
    for (field, value) in values {
        let valid = match field.as_str() {
            "alias" => value.as_str().is_some_and(|s| s.chars().count() <= 60),
            "systemPrompt" => value.as_str().is_some_and(|s| s.len() <= 128 * 1024),
            "contextWindow" | "maxTokens" => value
                .as_u64()
                .is_some_and(|n| n > 0 && n <= u32::MAX as u64),
            "thinkingLevels" => value.as_array().is_some_and(|levels| {
                levels.len() <= 32
                    && levels.iter().all(|level| {
                        level
                            .as_str()
                            .is_some_and(|s| !s.is_empty() && s.len() <= 64)
                    })
            }),
            "defaultThinkingLevel" => {
                value.is_null()
                    || value
                        .as_str()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 64)
            }
            "thinkingProtocol" => value
                .as_str()
                .is_some_and(|s| matches!(s, "legacy" | "adaptive")),
            "supportsImages" | "supportsVideos" | "supportsAudio" | "supportsDocuments" => {
                value.is_null() || value.is_boolean()
            }
            "availableForSubagents" | "nativeWebSearch" => value.is_boolean(),
            _ => false,
        };
        if !valid {
            bail!("MODEL_SETTINGS_INVALID: invalid field {field}");
        }
    }
    Ok(())
}

pub fn from_object(value: &Value) -> Values {
    FIELDS
        .iter()
        .filter_map(|field| {
            value
                .get(*field)
                .map(|value| (field.to_string(), value.clone()))
        })
        .collect()
}

pub fn legacy_overrides(value: &Value) -> Values {
    let mut values = from_object(value);
    for (field, source, seed) in [
        ("contextWindow", "contextWindowSource", 128_000),
        ("maxTokens", "maxTokensSource", 8_192),
    ] {
        let source = value
            .get(source)
            .and_then(Value::as_str)
            .map(|source| source.trim().to_ascii_lowercase());
        if source.as_deref() == Some("catalog")
            || (source.as_deref() != Some("user")
                && value.get(field).and_then(Value::as_u64) == Some(seed))
        {
            values.remove(field);
        }
    }
    values
        .retain(|field, value| validate(&BTreeMap::from([(field.clone(), value.clone())])).is_ok());
    values
}
