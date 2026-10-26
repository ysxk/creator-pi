use super::*;
use crate::providers::{self, ProviderCreateInput, ProviderUpdateInput};
use crate::secrets::SecretStore;
use serde_json::json;

fn context() -> (tempfile::TempDir, Database, SecretStore) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let secrets = SecretStore::open(dir.path()).unwrap();
    (dir, db, secrets)
}

fn change(db: &Database, input: Value) -> Snapshot {
    update(db, serde_json::from_value(input).unwrap()).unwrap()
}

fn create(db: &Database, secrets: &SecretStore, models: Value) -> providers::ProviderPublic {
    let input: ProviderCreateInput = serde_json::from_value(json!({
        "name": "Fixture", "authKind": "none", "models": models,
    }))
    .unwrap();
    providers::create_provider(db, secrets, input).unwrap()
}

fn edit(
    db: &Database,
    secrets: &SecretStore,
    id: &str,
    models: Value,
) -> providers::ProviderPublic {
    let input: ProviderUpdateInput =
        serde_json::from_value(json!({"id": id, "models": models})).unwrap();
    providers::update_provider(db, secrets, input)
        .unwrap()
        .unwrap()
}

fn seeded(id: &str) -> Value {
    json!({
        "id": id, "contextWindow": 200000, "maxTokens": 16000,
        "contextWindowSource": "catalog", "maxTokensSource": "catalog",
        "thinkingLevels": ["off", "high"], "defaultThinkingLevel": "high",
        "settings": {
            "baseline": {"contextWindow": 200000, "maxTokens": 16000,
                "thinkingLevels": ["off", "high"], "defaultThinkingLevel": "high"},
            "defaults": {}, "overrides": {}
        }
    })
}

fn raw(db: &Database, id: &str) -> Value {
    let raw: String = db
        .conn()
        .query_row(
            "SELECT config_json FROM providers WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn sparse_updates_keep_siblings_and_distinguish_false_null_empty_and_unset() {
    let (_dir, db, secrets) = context();
    let provider = create(
        &db,
        &secrets,
        json!([seeded("Vendor/Model"), seeded("Other/Model")]),
    );
    change(
        &db,
        json!({"modelId":" Vendor/Model ", "set": {
            "alias": "Global", "supportsImages": true, "contextWindow": 300000,
            "thinkingLevels": ["high"], "defaultThinkingLevel": "omit", "systemPrompt": "Global prompt"
        }}),
    );
    let snapshot = change(
        &db,
        json!({"providerId":provider.id,"modelId":"VENDOR/MODEL", "set": {
            "alias": "", "supportsImages": false, "supportsAudio": null,
            "defaultThinkingLevel": null, "thinkingLevels": [], "systemPrompt": "",
            "availableForSubagents": false, "nativeWebSearch": false
        }}),
    );
    let fields = &snapshot.channels[&provider.id]["vendor/model"];
    assert_eq!(fields["supportsImages"], false);
    assert_eq!(fields["supportsAudio"], Value::Null);
    assert_eq!(fields["defaultThinkingLevel"], Value::Null);
    assert_eq!(fields["systemPrompt"], "");
    assert_eq!(fields["thinkingLevels"], json!([]));
    change(
        &db,
        json!({"providerId":provider.id,"modelId":"vendor/model","set":{"maxTokens":42}}),
    );
    change(
        &db,
        json!({"providerId":provider.id,"modelId":"other/model","set":{"alias":"Sibling"}}),
    );
    let snapshot = change(
        &db,
        json!({"providerId":provider.id,"modelId":"vendor/model","unset":["supportsImages","defaultThinkingLevel"]}),
    );
    let fields = &snapshot.channels[&provider.id]["vendor/model"];
    assert!(!fields.contains_key("supportsImages"));
    assert!(!fields.contains_key("defaultThinkingLevel"));
    assert_eq!(fields["supportsAudio"], Value::Null);
    assert_eq!(fields["maxTokens"], 42);
    assert_eq!(fields["alias"], "");
    assert_eq!(snapshot.defaults["vendor/model"]["supportsImages"], true);
    assert_eq!(
        snapshot.channels[&provider.id]["other/model"]["alias"],
        "Sibling"
    );
    let projected = providers::get_provider(&db, &secrets, &provider.id)
        .unwrap()
        .unwrap();
    let layers = projected.models[0].settings.as_ref().unwrap();
    assert_eq!(layers.defaults["contextWindow"], 300000);
    assert_eq!(layers.overrides, *fields);
    assert_eq!(projected.models[0].context_window, 200000);
    assert_eq!(layers.baseline["contextWindow"], 200000);
}

#[test]
fn migration_is_idempotent_excludes_catalog_seeds_and_plugin_declarations() {
    let (_dir, db, secrets) = context();
    let provider = create(&db, &secrets, json!([]));
    db.kv_delete(NAMESPACE, SNAPSHOT_KEY).unwrap();
    let config = json!({"models":[
        {"id":" Vendor/Full-Wire-ID ","contextWindow":900000,"contextWindowSource":"catalog",
            "maxTokens":42000,"maxTokensSource":"user","supportsImages":false,
            "supportsAudio":null,"alias":"", "thinkingLevels":[],"defaultThinkingLevel":null,"systemPrompt":""},
        {"id":"seeds","contextWindow":128000,"maxTokens":8192},
        {"id":"old-explicit","contextWindow":250000,"maxTokens":4096}
    ]});
    db.conn()
        .execute(
            "UPDATE providers SET config_json = ?1 WHERE id = ?2",
            rusqlite::params![config.to_string(), provider.id],
        )
        .unwrap();
    db.conn().execute("INSERT INTO providers (id,name,vendor_key,type,protocol,enabled,auth_kind,config_json,created_at,updated_at,owner_plugin_id) VALUES ('plugin:test:service','Plugin','custom','custom','openai',1,'none',?1,0,0,'test')", [config.to_string()]).unwrap();
    let first = get(&db).unwrap();
    let fields = &first.channels[&provider.id]["vendor/full-wire-id"];
    assert!(!fields.contains_key("contextWindow"));
    assert!(!fields.contains_key("id"));
    assert!(!fields.contains_key("maxTokensSource"));
    assert_eq!(fields["maxTokens"], 42000);
    assert_eq!(fields["supportsImages"], false);
    assert_eq!(fields["supportsAudio"], Value::Null);
    assert_eq!(fields["alias"], "");
    assert_eq!(fields["systemPrompt"], "");
    assert!(!first.channels[&provider.id].contains_key("seeds"));
    assert_eq!(
        first.channels[&provider.id]["old-explicit"]["contextWindow"],
        250000
    );
    assert!(!first.channels.contains_key("plugin:test:service"));
    assert_eq!(first, get(&db).unwrap());
    change(
        &db,
        json!({"providerId":provider.id,"modelId":"vendor/full-wire-id","unset":["maxTokens","supportsImages"]}),
    );
    assert!(
        !get(&db).unwrap().channels[&provider.id]["vendor/full-wire-id"].contains_key("maxTokens")
    );
    assert!(
        !get(&db).unwrap().channels[&provider.id]["vendor/full-wire-id"]
            .contains_key("supportsImages")
    );
}

#[test]
fn projection_save_and_copy_preserve_baseline_and_do_not_pin_inherited_defaults() {
    let (_dir, db, secrets) = context();
    change(
        &db,
        json!({"modelId":"vendor/model","set":{"contextWindow":900000,"maxTokens":9000,"systemPrompt":"Inherited"}}),
    );
    let provider = create(&db, &secrets, json!([seeded("Vendor/Model")]));
    assert!(!get(&db).unwrap().channels.contains_key(&provider.id));
    change(
        &db,
        json!({"providerId":provider.id,"modelId":"vendor/model","set":{"supportsDocuments":null,"alias":"Private"}}),
    );
    let projected = providers::get_provider(&db, &secrets, &provider.id)
        .unwrap()
        .unwrap();
    let mut binding = serde_json::to_value(&projected.models[0]).unwrap();
    binding["contextWindow"] = json!(900000);
    binding["maxTokens"] = json!(9000);
    binding["systemPrompt"] = json!("Inherited");
    binding["alias"] = json!("Private");
    let saved = edit(&db, &secrets, &provider.id, json!([binding.clone()]));
    assert_eq!(saved.models[0].context_window, 200000);
    assert_eq!(saved.models[0].max_tokens, 16000);
    assert_eq!(saved.models[0].system_prompt, None);
    let stored = raw(&db, &provider.id);
    assert!(stored["models"][0].get("settings").is_none());
    assert!(stored["models"][0].get("systemPrompt").is_none());
    let fields = &get(&db).unwrap().channels[&provider.id]["vendor/model"];
    assert_eq!(fields.len(), 2);
    assert_eq!(fields["supportsDocuments"], Value::Null);
    let copied = create(&db, &secrets, json!([binding]));
    assert_ne!(provider.id, copied.id);
    assert_eq!(
        get(&db).unwrap().channels[&provider.id],
        get(&db).unwrap().channels[&copied.id]
    );
    change(
        &db,
        json!({"modelId":"vendor/model","set":{"contextWindow":800000}}),
    );
    let reread = providers::get_provider(&db, &secrets, &copied.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        reread.models[0].settings.as_ref().unwrap().defaults["contextWindow"],
        800000
    );
    assert!(!reread.models[0]
        .settings
        .as_ref()
        .unwrap()
        .overrides
        .contains_key("contextWindow"));
}

#[test]
fn legacy_callers_reconcile_only_changes_and_resets_remove_empty_maps() {
    let (_dir, db, secrets) = context();
    let provider = create(&db, &secrets, json!([seeded("Model")]));
    change(
        &db,
        json!({"modelId":"model","providerId":provider.id,"set":{"systemPrompt":"Separate","supportsImages":false,"contextWindow":765432,"maxTokens":4321}}),
    );
    let mut binding = raw(&db, &provider.id)["models"][0].clone();
    binding["alias"] = json!("Legacy edit");
    let updated = edit(&db, &secrets, &provider.id, json!([binding]));
    let fields = &updated.models[0].settings.as_ref().unwrap().overrides;
    assert_eq!(fields["alias"], "Legacy edit");
    assert_eq!(fields["systemPrompt"], "Separate");
    assert_eq!(fields["supportsImages"], false);
    assert_eq!(fields["contextWindow"], 765432);
    assert_eq!(fields["maxTokens"], 4321);
    let fields = fields.keys().cloned().collect::<Vec<_>>();
    let snapshot = change(
        &db,
        json!({"modelId":"model","providerId":provider.id,"unset":fields}),
    );
    assert!(!snapshot.channels.contains_key(&provider.id));
    let unchanged = edit(
        &db,
        &secrets,
        &provider.id,
        raw(&db, &provider.id)["models"].clone(),
    );
    assert!(unchanged.models[0]
        .settings
        .as_ref()
        .unwrap()
        .overrides
        .is_empty());
}

#[test]
fn removed_bindings_and_deleted_providers_clear_channels_not_global_defaults() {
    let (_dir, db, secrets) = context();
    let provider = create(&db, &secrets, json!([seeded("First"), seeded("Second")]));
    change(&db, json!({"modelId":"first","set":{"alias":"Global"}}));
    for id in ["first", "second"] {
        change(
            &db,
            json!({"modelId":id,"providerId":provider.id,"set":{"systemPrompt":""}}),
        );
    }
    let second = serde_json::to_value(
        &providers::get_provider(&db, &secrets, &provider.id)
            .unwrap()
            .unwrap()
            .models[1],
    )
    .unwrap();
    edit(&db, &secrets, &provider.id, json!([second]));
    let snapshot = get(&db).unwrap();
    assert!(!snapshot.channels[&provider.id].contains_key("first"));
    assert!(snapshot.channels[&provider.id].contains_key("second"));
    assert_eq!(snapshot.defaults["first"]["alias"], "Global");
    providers::delete_provider(&db, &secrets, &provider.id).unwrap();
    assert!(!get(&db).unwrap().channels.contains_key(&provider.id));
    assert_eq!(get(&db).unwrap().defaults["first"]["alias"], "Global");
}

#[test]
fn validation_is_atomic_and_rejects_unknown_fields_types_lengths_and_missing_models() {
    let (_dir, db, secrets) = context();
    let provider = create(&db, &secrets, json!([seeded("Model")]));
    change(&db, json!({"modelId":"model","set":{"alias":"Keep"}}));
    let initial = get(&db).unwrap();
    for set in [
        json!({"contextWindow":0}),
        json!({"maxTokens":-1}),
        json!({"maxTokens":1.5}),
        json!({"maxTokens":4294967296_u64}),
        json!({"id":"no"}),
        json!({"contextWindowSource":"user"}),
        json!({"supportsImages":"false"}),
        json!({"availableForSubagents":null}),
        json!({"nativeWebSearch":null}),
        json!({"alias":"x".repeat(61)}),
        json!({"systemPrompt":"x".repeat(128*1024+1)}),
        json!({"thinkingLevels":[true]}),
        json!({"thinkingLevels":["x".repeat(65)]}),
        json!({"thinkingLevels":vec!["high";33]}),
        json!({"thinkingProtocol":"other"}),
        json!({"defaultThinkingLevel":false}),
    ] {
        let input = serde_json::from_value(json!({"modelId":"model","set":set})).unwrap();
        assert!(update(&db, input).is_err());
        assert_eq!(get(&db).unwrap(), initial);
    }
    for input in [
        json!({"modelId":"  ","set":{"alias":"bad"}}),
        json!({"modelId":"x".repeat(513)}),
        json!({"modelId":"model","providerId":"missing","set":{"alias":"bad"}}),
        json!({"modelId":"missing","providerId":provider.id,"set":{"alias":"bad"}}),
        json!({"modelId":"model","unset":["id"]}),
        json!({"modelId":"model","set":{"alias":"bad"},"unset":["alias"]}),
    ] {
        assert!(update(&db, serde_json::from_value(input).unwrap()).is_err());
    }
    for input in [
        json!({"modelId":"model","set":null}),
        json!({"modelId":"model","providerId":null}),
        json!({"modelId":"model","unset":[false]}),
        json!({"modelId":"model","extra":1}),
    ] {
        assert!(serde_json::from_value::<UpdateInput>(input).is_err());
    }
    assert_eq!(get(&db).unwrap(), initial);
}

#[test]
fn persistence_survives_reopen_including_explicit_empty_and_catalog_fallback() {
    let (dir, db, secrets) = context();
    let provider = create(&db, &secrets, json!([seeded("Model")]));
    change(
        &db,
        json!({"modelId":"model","set":{"thinkingProtocol":"adaptive","defaultThinkingLevel":"omit"}}),
    );
    let expected = change(
        &db,
        json!({"modelId":"model","providerId":provider.id,"set":{"systemPrompt":"","supportsImages":null,"availableForSubagents":false}}),
    );
    drop(secrets);
    drop(db);
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let secrets = SecretStore::open(dir.path()).unwrap();
    assert_eq!(get(&db).unwrap(), expected);
    let list = providers::list_providers(&db, &secrets, true).unwrap();
    let layers = list[0].models[0].settings.as_ref().unwrap();
    assert_eq!(layers.overrides["systemPrompt"], "");
    assert_eq!(layers.overrides["supportsImages"], Value::Null);
    assert_eq!(layers.defaults["defaultThinkingLevel"], "omit");
}

#[test]
fn identity_is_full_wire_ascii_case_insensitive_without_unicode_case_folding() {
    assert_eq!(model_key(" Vendor/Model:Latest "), "vendor/model:latest");
    assert_ne!(model_key("Ä/Model"), model_key("ä/Model"));
    let (_dir, db, _secrets) = context();
    change(
        &db,
        json!({"modelId":"Vendor/Model","set":{"alias":"Vendor"}}),
    );
    let snapshot = change(&db, json!({"modelId":"Model","set":{"alias":"Bare"}}));
    assert_eq!(snapshot.defaults.len(), 2);
}

#[test]
fn plugin_refresh_keeps_user_layers_but_removal_clears_them_and_guards_remain() {
    let (_dir, db, secrets) = context();
    let mut manifest: crate::plugins::PluginManifest = serde_json::from_value(json!({
        "schemaVersion":1,"id":"fixture","name":"Fixture","version":"1.0.0",
        "main":"main.js","permissions":["provider.register"],
        "contributes":{"providers":[{"id":"service","name":"Service","authKind":"none",
            "apiStyle":"chat_completions","models":[{"id":"Model","contextWindow":100000,"supportsImages":true}]}]}
    })).unwrap();
    let id = "plugin:fixture:service";
    let declared = crate::plugins::declared_providers(&manifest);
    crate::plugins::sync_plugin_providers(&db, &secrets, "fixture", &declared, false).unwrap();
    assert!(!get(&db).unwrap().channels.contains_key(id));
    change(&db, json!({"modelId":"model","set":{"alias":"Global"}}));
    let expected = change(
        &db,
        json!({"providerId":id,"modelId":"model","set":{"supportsImages":null,"systemPrompt":"","nativeWebSearch":false}}),
    );
    manifest.contributes.as_mut().unwrap()["providers"][0]["models"][0]["contextWindow"] =
        json!(250000);
    let declared = crate::plugins::declared_providers(&manifest);
    crate::plugins::sync_plugin_providers(&db, &secrets, "fixture", &declared, false).unwrap();
    let provider = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert!(!provider.enabled);
    assert_eq!(provider.models[0].context_window, 250000);
    assert_eq!(
        provider.models[0].settings.as_ref().unwrap().overrides,
        expected.channels[id]["model"]
    );
    assert_eq!(
        provider.models[0].settings.as_ref().unwrap().defaults["alias"],
        "Global"
    );
    let input = serde_json::from_value(json!({"id":id,"name":"Forbidden"})).unwrap();
    assert!(providers::update_provider(&db, &secrets, input)
        .unwrap_err()
        .to_string()
        .starts_with("PROVIDER_OWNED_BY_PLUGIN:"));
    assert!(providers::delete_provider(&db, &secrets, id).is_err());
    manifest.contributes.as_mut().unwrap()["providers"][0]["models"] = json!([]);
    let declared = crate::plugins::declared_providers(&manifest);
    crate::plugins::sync_plugin_providers(&db, &secrets, "fixture", &declared, false).unwrap();
    assert!(!get(&db).unwrap().channels.contains_key(id));
    assert_eq!(get(&db).unwrap().defaults["model"]["alias"], "Global");
}

#[test]
fn malformed_metadata_cannot_change_rows_or_persist_effective_values() {
    let (_dir, db, secrets) = context();
    let provider = create(&db, &secrets, json!([seeded("Model")]));
    let before = raw(&db, &provider.id);
    let snapshot = get(&db).unwrap();
    for (layer, field, value) in [
        ("baseline", "id", json!("Other")),
        ("baseline", "contextWindow", json!(0)),
        ("overrides", "nativeWebSearch", Value::Null),
        ("overrides", "maxTokensSource", json!("user")),
    ] {
        let mut binding = seeded("Model");
        binding["settings"][layer][field] = value;
        let input = serde_json::from_value(json!({"id":provider.id,"models":[binding]})).unwrap();
        assert!(providers::update_provider(&db, &secrets, input).is_err());
        assert_eq!(raw(&db, &provider.id), before);
        assert_eq!(get(&db).unwrap(), snapshot);
    }
}

#[test]
fn dynamic_plugin_discovery_removal_clears_only_the_removed_models_channel() {
    let (_dir, db, secrets) = context();
    let provider = create(&db, &secrets, json!([]));
    db.conn()
        .execute(
            "UPDATE providers SET owner_plugin_id = 'fixture' WHERE id = ?1",
            [&provider.id],
        )
        .unwrap();
    let models = serde_json::from_value::<Vec<providers::DiscoveredModelInput>>(json!([
        {"modelId":"Vendor/First","displayName":"First"},
        {"modelId":"Vendor/Second","displayName":"Second"}
    ]))
    .unwrap();
    providers::cache_discovered_models(&db, &provider.id, &models).unwrap();
    for model in &models {
        change(
            &db,
            json!({"providerId":provider.id,"modelId":model.model_id,"set":{"supportsImages":null,"systemPrompt":""}}),
        );
    }
    change(
        &db,
        json!({"modelId":"vendor/first","set":{"alias":"Global"}}),
    );
    providers::cache_discovered_models(&db, &provider.id, &models[1..]).unwrap();
    let snapshot = get(&db).unwrap();
    assert!(!snapshot.channels[&provider.id].contains_key("vendor/first"));
    assert_eq!(
        snapshot.channels[&provider.id]["vendor/second"]["supportsImages"],
        Value::Null
    );
    assert_eq!(snapshot.defaults["vendor/first"]["alias"], "Global");
    let provider = providers::get_provider(&db, &secrets, &provider.id)
        .unwrap()
        .unwrap();
    assert_eq!(provider.models.len(), 1);
    assert_eq!(provider.models[0].id, "Vendor/Second");
}

#[test]
fn legacy_system_prompt_is_bounded_and_global_reset_does_not_touch_channels() {
    let (_dir, db, secrets) = context();
    let input = serde_json::from_value(
        json!({"name":"Invalid","models":[{"id":"Model","systemPrompt":"x".repeat(128*1024+1)}]}),
    )
    .unwrap();
    assert!(providers::create_provider(&db, &secrets, input).is_err());
    assert!(providers::list_providers(&db, &secrets, true)
        .unwrap()
        .is_empty());
    let provider = create(&db, &secrets, json!([seeded("Model")]));
    change(
        &db,
        json!({"modelId":"model","set":{"alias":"Global","systemPrompt":""}}),
    );
    change(
        &db,
        json!({"modelId":"model","providerId":provider.id,"set":{"alias":"Local"}}),
    );
    let snapshot = change(
        &db,
        json!({"modelId":"model","unset":["alias","systemPrompt"]}),
    );
    assert!(snapshot.defaults.is_empty());
    assert_eq!(snapshot.channels[&provider.id]["model"]["alias"], "Local");
}

#[test]
fn failed_settings_write_rolls_back_provider_and_cache_mutations() {
    let (_dir, db, secrets) = context();
    let provider = create(&db, &secrets, json!([seeded("Model")]));
    let config_before = raw(&db, &provider.id);
    let settings_before = get(&db).unwrap();
    db.conn().execute_batch("CREATE TRIGGER reject_model_settings BEFORE UPDATE ON kv WHEN NEW.ns = 'modelSettings' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;").unwrap();
    let mut binding = serde_json::to_value(&provider.models[0]).unwrap();
    binding["settings"]["overrides"]["alias"] = json!("Rejected");
    let input =
        serde_json::from_value(json!({"id":provider.id,"name":"Rejected","models":[binding]}))
            .unwrap();
    assert!(providers::update_provider(&db, &secrets, input).is_err());
    assert_eq!(raw(&db, &provider.id), config_before);
    assert_eq!(get(&db).unwrap(), settings_before);
    assert_eq!(
        providers::get_provider(&db, &secrets, &provider.id)
            .unwrap()
            .unwrap()
            .name,
        "Fixture"
    );
    let models = serde_json::from_value::<Vec<providers::DiscoveredModelInput>>(
        json!([{"modelId":"Model","displayName":"Model"}]),
    )
    .unwrap();
    providers::cache_discovered_models(&db, &provider.id, &models).unwrap();
    assert!(providers::forget_cached_models(&db, &provider.id, &["Model".into()]).is_err());
    assert_eq!(
        providers::list_models(&db, Some(&provider.id))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(get(&db).unwrap(), settings_before);
}

#[test]
fn migration_uses_the_same_limit_source_normalization_as_binding_reads() {
    let fields = values::legacy_overrides(&json!({
        "contextWindow":900000,"contextWindowSource":" CATALOG ",
        "maxTokens":8192,"maxTokensSource":" USER "
    }));
    assert!(!fields.contains_key("contextWindow"));
    assert_eq!(fields["maxTokens"], 8192);
}
