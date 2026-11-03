# ADR: Explicit channel configuration file transfer

- Status: Accepted
- Date: 2026-11-02

## Context

Channels can be configured or discovered from other tools, but users need a
small portable file to move selected API channels between installations without
restoring unrelated application state. Provider bindings now have separate
baseline, global-default and channel-override layers. Copying effective values
would silently turn inherited settings into permanent channel overrides.

## Decision

Use a versioned, bounded JSON format for user-owned API channels. Export baseline
and sparse channel intent, not global model defaults or local IDs. Imports create
new records and preserve destination default selections. Same-name channels are
explicitly shown as additions, never guessed to be equivalent or overwritten.

API keys and all custom header values are absent by default. Users may explicitly
include both after a plaintext warning. OAuth sessions and plugin-managed rows
are excluded: their lifecycles cannot be reconstructed by ordinary provider CRUD.
Credential-bearing URLs are rejected rather than silently stripped.

Electron Main owns native pickers, atomic file writes and one-use preview
snapshots bound to the issuing window. Five-minute expiry and navigation/close
cleanup bound retention. The renderer sees summaries and safe result codes, not
file contents or credentials. These channels are not MCP/plugin operations.
Rust Host remains the sole database and secret-store owner, using its existing
provider APIs; no storage migration is introduced.

## Consequences and alternatives

Plain JSON is inspectable and easy to transfer, but opt-in credential files are
not encrypted and must be handled as secrets. Requiring a new encrypted archive
format would duplicate the existing cloud-sync vault and complicate this local
workflow. Whole-application sync remains the alternative for a complete backup.

Destination model defaults may change the effective values of inherited fields;
that is intentional and explained before import. Keeping source global defaults
would affect unrelated channels, while freezing resolved values would lose
inheritance. Import is per-channel rather than all-or-nothing across the database
and secret store: later failures clean only newly-created records and report any
cleanup failure explicitly. Existing records and references are never rewritten.
