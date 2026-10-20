# Pi 1.3.0 adoption

## Scope

All five direct Pi dependencies move from `1.1.0` to `1.3.0`, and the three
Desktop patches were rebased onto the published 1.3.0 packages. The
assessment that chose what to take is `design/1.3.0.md` (local, not
committed); this record covers what was adopted.

| Workspace entry | Direct dependencies |
| --- | --- |
| `packages/agent-runtime` | `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` |
| `apps/desktop` | `@earendil-works/pi-ai`, `@earendil-works/pi-mcp` |

Taken from the release:

- **Tool argument integrity.** An invalid `\u` escape is repaired instead of
  truncating the arguments, and a completed call whose arguments are not a
  JSON object fails validation instead of running with the prefix that
  parsed. Covered on the Desktop path by
  `packages/agent-runtime/src/tool-argument-integrity.test.ts`.
- **Cross-model thinking.** A previous model's or account's thinking is
  dropped from the outgoing request instead of being replayed as answer
  text; same-model replay is unchanged. Stored and visible history are
  untouched. Two existing tests that asserted the old text replay were
  updated (`flash-transcript.test.ts`, `hosted-search-consumers.test.ts`).
- **Provider fixes.** Reasoning stays before content when a gateway sends
  both in one chunk; Anthropic and Bedrock receive an error tool result's
  images after the turn's tool results; the Anthropic strict-tool fallback;
  Gemini 4 thinking levels; Mistral's header-only timeout; Claude and MiMo
  effort levels. The first two are pinned in `provider-1-3-fixes.test.ts`.

Not taken here: compaction without historical thinking (assessment item 3),
the OpenRouter per-key catalog, GPT-6 cache-preserving effort changes, and
the Kimi Code protocol migration.

The MCP OAuth issuer check from pi-mcp 1.2.0 was ported separately into the
Desktop-owned flow (D689), since Desktop does not use pi-mcp's OAuth client.

## Retry coverage

Desktop classifies provider errors itself. `Unable to forward upstream
stream`, `The service is temporarily unavailable` and `The upstream provider
returned an error` were already transient there, so session turns retry them
without change. Compaction summaries call pi-ai's `completeSimple` directly
and are not covered by Desktop's turn retry; Pi's related fix (#10965) is in
pi-coding-agent's own session retry and does not reach them either.

## Patch rebase

Each 1.1.0 patch was three-way merged onto the pristine 1.3.0 package
(base: pristine 1.1.0). pi-agent-core and pi-coding-agent merged cleanly.
pi-ai needed three resolutions:

- `requiresNonEmptyReasoningReplay` moved into 1.3.0's
  `providers/compat-schema` (schema and declaration), where the compat
  types now live.
- The Anthropic local-request marker (`JSON.stringify(params)` before the
  request) moved inside 1.3.0's strict-tool fallback loop, and hosted web
  search is attached before the new thinking setup.
- The frame-module changes were dropped with the module, which 1.3.0 removed
  (`AssistantMessageFrame`, `AssistantMessageFrameEncoder`,
  `reduceAssistantMessageFrames`). No Desktop source used it; the tests that
  exercised only that API were retired, and the #883 stream test now reads
  decoder events.

The coding-agent patch no longer deletes upstream example
`package-lock.json` files, which `check:pi-patches` rejects; pnpm's patch
edit directory omits those files, so they were removed from the generated
patch by hand.

## Fresh-release policy

The 1.3.0 release group is inside the minimum-release-age window.
`pnpm-workspace.yaml` lists exact exclusions for its seven packages
(`chord` left the group in 1.2.0). Remove them once the group clears the
window and regenerate the lockfile; do not widen them.

## Rollback

Roll back the dependency manifests, lockfile, release-age entries, patch
files, guard scripts and version references together. Do not roll back one
patched Pi package while keeping the others at 1.3.0.
