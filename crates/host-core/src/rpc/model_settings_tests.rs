use super::*;

#[tokio::test]
async fn model_settings_rpc_user_path_preserves_inheritance_and_validates_requests() {
    let data = tempfile::tempdir().unwrap();
    let mut app = AppState::open(data.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let empty = handle_request(state.clone(), "modelSettings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(empty, json!({"version":1,"defaults":{},"channels":{}}));
    let defaults = handle_request(state.clone(),"modelSettings.update",json!({"modelId":" Vendor/Model ","set":{"alias":"Global","contextWindow":300000,"systemPrompt":"Inherited"}}),tx.clone()).await.unwrap();
    assert_eq!(defaults["defaults"]["vendor/model"]["alias"], "Global");
    let created = handle_request(state.clone(),"providers.create",json!({"name":"Fixture","authKind":"none","models":[{
        "id":"Vendor/Model","contextWindow":100000,"maxTokens":4096,
        "settings":{"baseline":{"contextWindow":100000,"maxTokens":4096},"defaults":{},"overrides":{}}
    }]}),tx.clone()).await.unwrap();
    let id = created["provider"]["id"].as_str().unwrap();
    let snapshot = handle_request(state.clone(),"modelSettings.update",json!({"modelId":"vendor/model","providerId":id,"set":{"supportsImages":null,"systemPrompt":"","nativeWebSearch":false}}),tx.clone()).await.unwrap();
    assert_eq!(snapshot["channels"][id]["vendor/model"]["systemPrompt"], "");
    let fetched = handle_request(state.clone(), "providers.get", json!({"id":id}), tx.clone())
        .await
        .unwrap();
    let mut binding = fetched["provider"]["models"][0].clone();
    assert_eq!(binding["settings"]["defaults"]["contextWindow"], 300000);
    binding["contextWindow"] = json!(300000);
    binding["systemPrompt"] = json!("");
    let saved = handle_request(
        state.clone(),
        "providers.update",
        json!({"id":id,"models":[binding]}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(saved["provider"]["models"][0]["contextWindow"], 100000);
    let reset = handle_request(
        state.clone(),
        "modelSettings.update",
        json!({"providerId":id,"modelId":"vendor/model","unset":["systemPrompt","supportsImages"]}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert!(reset["channels"][id]["vendor/model"]
        .get("systemPrompt")
        .is_none());
    assert_eq!(
        reset["channels"][id]["vendor/model"]["nativeWebSearch"],
        false
    );
    let invalid = handle_request(
        state.clone(),
        "modelSettings.update",
        json!({"modelId":"model","set":{"id":"bad"}}),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid.code, 1002);
    let invalid = handle_request(
        state.clone(),
        "modelSettings.update",
        json!({"modelId":"absent","providerId":id,"set":{"alias":"bad"}}),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid.code, 1002);
    let listed = handle_request(state.clone(), "providers.list", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(
        listed["providers"][0]["models"][0]["settings"]["overrides"]["nativeWebSearch"],
        false
    );
    handle_request(
        state.clone(),
        "providers.delete",
        json!({"id":id}),
        tx.clone(),
    )
    .await
    .unwrap();
    let final_snapshot = handle_request(state, "modelSettings.get", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(final_snapshot["channels"], json!({}));
    assert_eq!(
        final_snapshot["defaults"]["vendor/model"]["systemPrompt"],
        "Inherited"
    );
}
