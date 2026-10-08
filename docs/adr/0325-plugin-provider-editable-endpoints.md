# ADR 0325: User-Editable Endpoints on Plugin-Declared Providers

- Status: Accepted
- Date: 2026-10-09
- Supersedes: nothing (extends ADR 0259 and ADR 0322)

## Context

A plugin-declared provider (ADR 0259) is authoritative for its own fields:
every plugin load refreshes name, vendor, base URL, api style, and the model
list from the manifest, and `providers.update` / `providers.delete` refuse the
row so a generic edit cannot be silently reverted. That contract assumes the
endpoint is a fixed property of the service the plugin integrates.

The bundled CLIProxyAPI provider breaks that assumption. CLIProxyAPI is
self-hosted software: the address is a deployment detail (host, port, path)
that varies per user, and the same instance may expose more than one wire
protocol. Locking the declared default would force every non-default
deployment to stay on `http://127.0.0.1:8317/v1`.

## Decision

A provider declaration may mark its endpoint user-editable:

```json
"baseUrlEditable": true,
"apiStyleEditable": true
```

- The flags travel with the row in `config_json.pluginEndpoint`, written by
  the plugin sync, and surface on `ProviderPublic` so Settings can render the
  fields without re-reading the manifest.
- A new host RPC, `providers.setPluginEndpoint`, is the only write path. It
  validates that the row is plugin-owned, that the manifest allows each field
  it is asked to move, and that the values are well formed (absolute http(s)
  URL; a known plugin api style). A moved endpoint drops the previous
  endpoint's discovered model cache, exactly like a user-owned row's edit.
- A successful edit records the field as user-owned in
  `config_json.pluginEndpointUserOwned`. The next manifest sync keeps a
  user-owned field instead of restoring the declared default; dropping the
  flag from the manifest locks the row again.
- Manifest validation requires an editable base URL to have a declared
  default to edit from.

## Consequences

- A plugin keeps naming the default endpoint while the user's deployment
  address survives plugin updates — the same three-state philosophy as the
  binding's attachment overrides (`null` follows the declaration, an explicit
  value is pinned).
- The API key stays on the existing `providers.setSecret` path; endpoint and
  credential remain separate concerns with separate guards.
- The declaration remains authoritative for everything else: models, vendor,
  auth kind, and the flags themselves. A plugin that wants to lock the row
  back just removes the flags.
