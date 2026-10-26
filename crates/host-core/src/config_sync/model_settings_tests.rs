use super::*;
use crate::model_settings;

fn change(st: &AppState, input: Value) {
    model_settings::update(&st.db, serde_json::from_value(input).unwrap()).unwrap();
}

fn provider_selection() -> CategorySelection {
    CategorySelection(
        domains::ALL_DOMAINS
            .into_iter()
            .map(|domain| (domain.to_string(), domain == domains::DOMAIN_PROVIDERS))
            .collect(),
    )
}

#[test]
fn model_settings_capture_apply_restores_layers_without_enabling_plugin_or_creating_rows() {
    let source_dir = tempfile::tempdir().unwrap();
    let target_dir = tempfile::tempdir().unwrap();
    let mut source = AppState::open(source_dir.path()).unwrap();
    let mut target = AppState::open(target_dir.path()).unwrap();
    let input = serde_json::from_value(json!({
        "name":"Portable", "authKind":"none", "models":[{
            "id":"Model","contextWindow":200000,"maxTokens":16000,
            "settings":{"baseline":{"contextWindow":200000,"maxTokens":16000},"defaults":{},"overrides":{}}
        }]
    })).unwrap();
    let provider = providers::create_provider(&source.db, &source.secrets, input).unwrap();
    let plugin_id = "plugin:fixture:service";
    let config =
        json!({"models":[{"id":"Model","contextWindow":100000,"maxTokens":4096}]}).to_string();
    for st in [&source, &target] {
        st.db.conn().execute("INSERT INTO providers (id,name,vendor_key,type,protocol,enabled,auth_kind,config_json,created_at,updated_at,owner_plugin_id) VALUES (?1,'Plugin','custom','custom','openai',0,'none',?2,0,0,'fixture')",rusqlite::params![plugin_id,config]).unwrap();
    }
    change(
        &source,
        json!({"modelId":"Model","set":{"contextWindow":900000,"systemPrompt":"Global","availableForSubagents":false,"nativeWebSearch":false}}),
    );
    change(
        &source,
        json!({"modelId":"Model","providerId":provider.id,"set":{"systemPrompt":"","supportsImages":null,"alias":"User"}}),
    );
    change(
        &source,
        json!({"modelId":"Model","providerId":plugin_id,"set":{"supportsAudio":false,"systemPrompt":""}}),
    );
    let expected = model_settings::get(&source.db).unwrap();
    let (header, key) = create_vault("fixture passphrase", "fixture-vault").unwrap();
    let mut config = config_from_input(
        None,
        &json!({"endpoint":"https://sync.invalid","deviceLabel":"Fixture"}),
        header,
    )
    .unwrap();
    let snapshot = domains::capture(
        &mut source,
        &key,
        &provider_selection(),
        false,
        &BTreeMap::new(),
        &domains::ProjectIdentityOverrides::default(),
    )
    .unwrap();
    let portable_provider = snapshot
        .manifest
        .entities
        .iter()
        .find(|entity| entity.entity_id == format!("provider:{}", provider.id))
        .unwrap();
    assert_eq!(
        portable_provider.payload["models"][0]["settings"]["defaults"],
        json!({})
    );
    let settings_entity = snapshot
        .manifest
        .entities
        .iter()
        .find(|entity| entity.entity_id == "model-settings")
        .unwrap();
    assert!(!settings_entity.payload["channels"]
        .as_object()
        .unwrap()
        .contains_key(&provider.id));
    assert!(settings_entity.payload["channels"]
        .as_object()
        .unwrap()
        .contains_key(plugin_id));
    let bundle = PendingBundle {
        manifest: snapshot.manifest.clone(),
        local_before: None,
        resources: snapshot.resources,
        approvals: Vec::new(),
        conflicts: Vec::new(),
        journal_state: "staged".into(),
        remote_revision_id: "fixture".into(),
    };
    for entity in &bundle.manifest.entities {
        apply_entity(&mut target, &mut config, &bundle, entity).unwrap();
    }
    assert_eq!(model_settings::get(&target.db).unwrap(), expected);
    assert!(
        !providers::get_provider(&target.db, &target.secrets, plugin_id)
            .unwrap()
            .unwrap()
            .enabled
    );
    let restored = providers::get_provider(&target.db, &target.secrets, &provider.id)
        .unwrap()
        .unwrap();
    assert_eq!(restored.models[0].context_window, 200000);
    assert_eq!(
        restored.models[0].settings.as_ref().unwrap().defaults["contextWindow"],
        900000
    );
    assert_eq!(
        restored.models[0].settings.as_ref().unwrap().overrides["systemPrompt"],
        ""
    );
    for entity in &bundle.manifest.entities {
        apply_entity(&mut target, &mut config, &bundle, entity).unwrap();
    }
    assert_eq!(model_settings::get(&target.db).unwrap(), expected);
    target
        .db
        .conn()
        .execute("DELETE FROM providers WHERE id = ?1", [plugin_id])
        .unwrap();
    apply_entity(&mut target, &mut config, &bundle, settings_entity).unwrap();
    assert!(
        providers::get_provider(&target.db, &target.secrets, plugin_id)
            .unwrap()
            .is_none()
    );
    assert!(model_settings::get(&target.db)
        .unwrap()
        .channels
        .contains_key(plugin_id));
    let mut selection = provider_selection();
    selection
        .0
        .insert(domains::DOMAIN_PROVIDERS.to_string(), false);
    let excluded = domains::capture(
        &mut source,
        &key,
        &selection,
        false,
        &BTreeMap::new(),
        &domains::ProjectIdentityOverrides::default(),
    )
    .unwrap();
    assert!(excluded.manifest.entities.is_empty());
}

#[test]
fn model_settings_import_rejects_invalid_versions_and_user_channel_injection_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::open(dir.path()).unwrap();
    change(&state, json!({"modelId":"model","set":{"alias":"Keep"}}));
    let before = model_settings::get(&state.db).unwrap();
    for input in [
        json!({"version":2,"defaults":{},"channels":{}}),
        json!({"version":1,"defaults":{"model":{"id":"bad"}},"channels":{}}),
        json!({"version":1,"defaults":{},"channels":{"user":{"model":{"alias":"bad"}}}}),
    ] {
        let incoming = serde_json::from_value(input).unwrap();
        assert!(model_settings::import_portable(&state.db, incoming).is_err());
        assert_eq!(model_settings::get(&state.db).unwrap(), before);
    }
}
