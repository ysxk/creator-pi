# ADR 0327: Separation of Channel and Model Settings with Inherited Overrides

- Status: Accepted
- Date: 2026-10-26
- Deciders: PI-Desktop core

## Context

Previously, the "Models" settings page was predominantly a provider/channel connection manager. Individual model bindings could only be accessed through an advanced drawer inside provider configuration modals, making it tedious to inspect or adjust settings for a specific model across different providers. Furthermore, users could not set model-specific system prompts.

## Decision

1. **Information Architecture**:
   - Separate Settings navigation into **Channels** (`providers`) and **Models** (`agent`).
   - Channels manages endpoints, API credentials, OAuth subscriptions, and discovered model lists.
   - Models aggregates all configured models across all channels into a master/detail view, providing centralized model parameter adjustment and model-specific instructions.
   - Image generation defaults remain in the Models destination.

2. **Hierarchical Configuration & Sparse Overrides**:
   - Model parameters follow the resolution hierarchy: `Channel explicit override > Model public default > Catalog / baseline seed`.
   - Persistence preserves sparse intent in a versioned key-value snapshot (`modelSettings`), mapping model IDs and channel IDs to explicit overrides.
   - Users can reset any field to "Inherit", restoring inheritance from the public default or catalog baseline.

3. **Model System Prompt Sequencing**:
   - Models support a dedicated system prompt.
   - In session and subagent turn execution, the active model's prompt is inserted strictly after global user instructions and before workspace/directory project instructions.
   - Channels can inherit the prompt, provide a channel-specific prompt, or explicitly disable it.

## Consequences

- Direct, convenient model parameter and prompt adjustments without navigating into channel modals.
- Clean separation between provider connection credentials and model behavior.
- Full backward compatibility with existing stored providers and plugin declarations.

## Amendment (D705)

Every reader of provider bindings applies the layers: `resolveProviderModels`
is the shared read, including the worker-spawn gate and plugin model list.
Migration keeps only values someone chose as channel overrides, so model
defaults reach migrated channels. A layered save never stores an effective
limit source beside a baseline value. An unreadable snapshot degrades provider
reads to baselines without being overwritten; settings writers still refuse.
