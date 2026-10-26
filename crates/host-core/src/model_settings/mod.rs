mod bindings;
mod values;

pub(crate) use bindings::{attach, prepare_save, strip_portable_defaults, Layers};
pub(crate) use values::{model_key, Values};

use crate::db::Database;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

const NAMESPACE: &str = "modelSettings";
const SNAPSHOT_KEY: &str = "snapshot";
pub type ModelValues = BTreeMap<String, Values>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub version: u32,
    pub defaults: ModelValues,
    pub channels: BTreeMap<String, ModelValues>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            version: 1,
            defaults: BTreeMap::new(),
            channels: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateInput {
    pub model_id: String,
    #[serde(default, deserialize_with = "deserialize_provider_id")]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub set: Values,
    #[serde(default)]
    pub unset: Vec<String>,
}

fn deserialize_provider_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

pub fn get(db: &Database) -> Result<Snapshot> {
    if let Some(value) = db.kv_get(NAMESPACE, SNAPSHOT_KEY)? {
        let snapshot: Snapshot = serde_json::from_value(value)?;
        validate_snapshot(&snapshot)?;
        return Ok(snapshot);
    }
    let mut snapshot = Snapshot::default();
    let mut stmt = db
        .conn()
        .prepare_cached("SELECT id, config_json FROM providers WHERE owner_plugin_id IS NULL")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (provider_id, raw) = row?;
        if let Ok(config) = serde_json::from_str::<Value>(&raw) {
            if let Some(models) = config.get("models").and_then(Value::as_array) {
                for binding in models {
                    let Some(id) = binding.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let Ok(key) = values::validate_model_id(id) else {
                        continue;
                    };
                    let overrides = values::legacy_overrides(binding);
                    if !overrides.is_empty() {
                        snapshot
                            .channels
                            .entry(provider_id.clone())
                            .or_default()
                            .insert(key, overrides);
                    }
                }
            }
        }
    }
    save(db, &snapshot)?;
    Ok(snapshot)
}

pub(crate) fn save(db: &Database, snapshot: &Snapshot) -> Result<()> {
    db.kv_set(NAMESPACE, SNAPSHOT_KEY, &serde_json::to_value(snapshot)?)
}

pub fn update(db: &Database, input: UpdateInput) -> Result<Snapshot> {
    let key = values::validate_model_id(&input.model_id)?;
    values::validate(&input.set)?;
    for field in &input.unset {
        if !values::FIELDS.contains(&field.as_str()) || input.set.contains_key(field) {
            bail!("MODEL_SETTINGS_INVALID: invalid or conflicting unset field {field}");
        }
    }
    if let Some(provider_id) = input.provider_id.as_deref() {
        values::validate_provider_id(provider_id)?;
        // This includes dynamically discovered plugin models, but never creates
        // a provider or changes its enablement/ownership.
        let raw: Option<(String, Option<String>)> = db
            .conn()
            .query_row(
                "SELECT config_json, default_model_id FROM providers WHERE id = ?1",
                [provider_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((raw, legacy)) = raw else {
            bail!("MODEL_SETTINGS_INVALID: provider not found");
        };
        let configured = crate::providers::config_model_bindings(&raw, legacy, provider_id)
            .iter()
            .any(|model| model_key(&model.id) == key);
        let discovered = crate::providers::list_models(db, Some(provider_id))?
            .iter()
            .any(|model| model_key(&model.model_id) == key);
        if !configured && !discovered {
            bail!("MODEL_SETTINGS_INVALID: model not found in provider");
        }
    }
    let tx = db.conn().unchecked_transaction()?;
    let mut snapshot = get(db)?;
    let models = match input.provider_id.as_ref() {
        Some(id) => snapshot.channels.entry(id.clone()).or_default(),
        None => &mut snapshot.defaults,
    };
    let fields = models.entry(key).or_default();
    fields.extend(input.set);
    for field in input.unset {
        fields.remove(&field);
    }
    prune(&mut snapshot);
    save(db, &snapshot)?;
    tx.commit()?;
    Ok(snapshot)
}

use rusqlite::OptionalExtension;

pub(crate) fn prune(snapshot: &mut Snapshot) {
    snapshot.defaults.retain(|_, fields| !fields.is_empty());
    for models in snapshot.channels.values_mut() {
        models.retain(|_, fields| !fields.is_empty());
    }
    snapshot.channels.retain(|_, models| !models.is_empty());
}

pub(crate) fn remove_models(db: &Database, provider_id: &str, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut snapshot = get(db)?;
    if let Some(models) = snapshot.channels.get_mut(provider_id) {
        for id in ids {
            models.remove(&model_key(id));
        }
    }
    prune(&mut snapshot);
    save(db, &snapshot)?;
    Ok(())
}

pub(crate) fn remove_provider(db: &Database, provider_id: &str) -> Result<()> {
    let mut snapshot = get(db)?;
    snapshot.channels.remove(provider_id);
    save(db, &snapshot)
}

fn validate_snapshot(snapshot: &Snapshot) -> Result<()> {
    if snapshot.version != 1 {
        bail!("MODEL_SETTINGS_INVALID: unsupported snapshot version");
    }
    validate_models(&snapshot.defaults)?;
    for (provider, models) in &snapshot.channels {
        values::validate_provider_id(provider)?;
        validate_models(models)?;
    }
    Ok(())
}

fn validate_models(models: &ModelValues) -> Result<()> {
    for (key, fields) in models {
        if values::validate_model_id(key)? != *key {
            bail!("MODEL_SETTINGS_INVALID: model key must be normalized");
        }
        values::validate(fields)?;
    }
    Ok(())
}

pub(crate) fn portable(db: &Database) -> Result<Snapshot> {
    let mut snapshot = get(db)?;
    snapshot
        .channels
        .retain(|provider, _| provider.starts_with("plugin:"));
    Ok(snapshot)
}

pub(crate) fn import_portable(db: &Database, incoming: Snapshot) -> Result<()> {
    validate_snapshot(&incoming)?;
    if incoming
        .channels
        .keys()
        .any(|id| !id.starts_with("plugin:"))
    {
        bail!("MODEL_SETTINGS_INVALID: user channel settings belong to provider records");
    }
    let tx = db.conn().unchecked_transaction()?;
    let mut snapshot = get(db)?;
    snapshot.defaults = incoming.defaults;
    snapshot
        .channels
        .retain(|provider, _| !provider.starts_with("plugin:"));
    snapshot.channels.extend(incoming.channels);
    prune(&mut snapshot);
    save(db, &snapshot)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests;
