/**
 * CLIProxyAPI — bundled provider plugin.
 *
 * The whole contribution is declarative: `contributes.providers` in the
 * manifest registers the provider row (ADR 0259), the host-owned setup form
 * collects the API key, and the endpoint's own /v1/models populates the model
 * list. This module exists only because a bundled plugin ships a main entry;
 * it has no runtime behavior.
 */

module.exports = {};
