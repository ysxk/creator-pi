use super::{get, model_key, prune, values, Snapshot, Values};
use crate::db::Database;
use crate::providers::{ModelBinding, ProviderPublic};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Layers {
    pub baseline: Values,
    pub defaults: Values,
    pub overrides: Values,
}

fn binding_values(binding: &ModelBinding) -> Result<Values> {
    Ok(values::from_object(&serde_json::to_value(binding)?))
}

pub(crate) fn attach(snapshot: &Snapshot, provider: &mut ProviderPublic) -> Result<()> {
    for binding in &mut provider.models {
        let key = model_key(&binding.id);
        binding.settings = Some(Layers {
            baseline: binding_values(binding)?,
            defaults: snapshot.defaults.get(&key).cloned().unwrap_or_default(),
            overrides: snapshot
                .channels
                .get(&provider.id)
                .and_then(|models| models.get(&key))
                .cloned()
                .unwrap_or_default(),
        });
    }
    Ok(())
}

/// Provenance of the limit a layered save stores as its baseline.
///
/// A renderer holds resolved bindings, whose source describes the effective
/// limit: an override makes it `user`. Storing that beside the baseline value
/// would keep the limit from following the catalog once the override is gone.
fn baseline_limit_source(
    field: &str,
    sent: Option<String>,
    previous: Option<(&ModelBinding, &Option<String>)>,
    layers: &Layers,
) -> Result<Option<String>> {
    if let Some((previous, stored)) = previous {
        if binding_values(previous)?.get(field) == layers.baseline.get(field) {
            return Ok(stored.clone());
        }
    }
    // A model new to this channel is seeded from the catalog, so the user's
    // number is in a layer and not in the baseline.
    let layered = layers.defaults.contains_key(field) || layers.overrides.contains_key(field);
    Ok(if layered {
        Some("catalog".to_string())
    } else {
        sent
    })
}

pub(crate) fn prepare_save(
    db: &Database,
    provider_id: &str,
    models: &mut [ModelBinding],
    current: Option<&ProviderPublic>,
) -> Result<Snapshot> {
    let mut snapshot = get(db)?;
    let channel = snapshot
        .channels
        .entry(provider_id.to_string())
        .or_default();
    let mut keep = BTreeSet::new();
    for binding in models {
        let key = values::validate_model_id(&binding.id)?;
        keep.insert(key.clone());
        if let Some(prompt) = binding.system_prompt.as_ref() {
            values::validate(&Values::from([(
                "systemPrompt".into(),
                Value::String(prompt.clone()),
            )]))?;
        }
        if let Some(layers) = binding.settings.take() {
            values::validate(&layers.baseline)?;
            values::validate(&layers.defaults)?;
            values::validate(&layers.overrides)?;
            let previous = current.and_then(|provider| {
                provider
                    .models
                    .iter()
                    .find(|model| model_key(&model.id) == key)
            });
            let context_window_source = baseline_limit_source(
                "contextWindow",
                binding.context_window_source.clone(),
                previous.map(|model| (model, &model.context_window_source)),
                &layers,
            )?;
            let max_tokens_source = baseline_limit_source(
                "maxTokens",
                binding.max_tokens_source.clone(),
                previous.map(|model| (model, &model.max_tokens_source)),
                &layers,
            )?;
            let mut raw = serde_json::to_value(&binding)?;
            let object = raw
                .as_object_mut()
                .expect("model binding serializes as an object");
            for field in values::FIELDS {
                object.remove(*field);
            }
            object.extend(layers.baseline);
            *binding = serde_json::from_value(raw)?;
            binding.context_window_source = context_window_source;
            binding.max_tokens_source = max_tokens_source;
            channel.insert(key, layers.overrides);
        } else if let Some(previous) = current.and_then(|provider| {
            provider
                .models
                .iter()
                .find(|model| model_key(&model.id) == key)
        }) {
            let old = binding_values(previous)?;
            let normalized =
                crate::providers::normalize_model_bindings(std::slice::from_ref(binding));
            let new = binding_values(&normalized[0])?;
            let overrides = channel.entry(key).or_default();
            for field in values::FIELDS {
                if old.get(*field) != new.get(*field) {
                    match new.get(*field) {
                        Some(value) => {
                            overrides.insert(field.to_string(), value.clone());
                        }
                        None => {
                            overrides.remove(*field);
                        }
                    }
                }
            }
            for (field, source, previous_source) in [
                (
                    "contextWindow",
                    &normalized[0].context_window_source,
                    &previous.context_window_source,
                ),
                (
                    "maxTokens",
                    &normalized[0].max_tokens_source,
                    &previous.max_tokens_source,
                ),
            ] {
                if source.as_deref() == Some("catalog")
                    && (source != previous_source || old.get(field) != new.get(field))
                {
                    overrides.remove(field);
                }
            }
            values::validate(overrides)?;
        } else {
            channel.insert(
                key,
                values::legacy_overrides(&serde_json::to_value(&binding)?),
            );
        }
        binding.settings = None;
    }
    channel.retain(|key, _| keep.contains(key));
    prune(&mut snapshot);
    Ok(snapshot)
}

// Portable provider records carry baseline and channel intent, not a second
// copy of the exporting device's global defaults.
pub(crate) fn strip_portable_defaults(payload: &mut Value) {
    if let Some(models) = payload.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            if let Some(settings) = model.get_mut("settings").and_then(Value::as_object_mut) {
                settings.insert("defaults".into(), serde_json::json!({}));
            }
        }
    }
}
