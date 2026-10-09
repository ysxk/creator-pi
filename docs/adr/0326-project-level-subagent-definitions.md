# ADR 0326: Project-Level Subagent Definitions

- Status: Accepted for implementation (D658)
- Date: 2026-10-09
- Deciders: PI-Desktop core
- Supersedes: the "no project-level subagent directory" clauses of ADR 0062,
  ADR 0063, and ADR 0112 §1 / §4 / §5
- Amends: ADR 0126, ADR 0269, ADR 0270
- Related: D201, D202, D257, ADR 0089, ADR 0300, `subagent-model-opt-in`

## Context

ADR 0063 and ADR 0112 made subagent definitions global-only: one directory,
`~/.agents/subagents`, and no project source. The reason given was that "a
repository cannot silently add a delegate to a user's agent catalog", and that a
second precedence model was not worth its cost.

Skills and MCP servers took the other path in the same ADR and have had a
project level since: `<project>/.agents/skills` and `<project>/.agents/servers`
shadow the global directories for sessions on that project. A team can
therefore ship the skills a repository needs but not the delegates that use
them, and a user who wants a reviewer tuned for one codebase has to keep it in
their global catalog, where it is offered in every other project too.

The original objection is about what a repository-authored document may do,
not about where a document may live. It is answered by limiting a project
document, not by refusing to read it.

## Decision

### 1. A project carries its own subagent documents

```text
~/.agents/subagents/<id>.md              global, user-owned
<project>/.agents/subagents/<id>.md      project
```

The format is the same Markdown document at both levels. `.pi/agents` remains
unread. host-core owns both directories; the runtime still never reads a
project directory itself and receives the documents from the launch path with
their source (`user` or `project`).

### 2. Precedence is project, then global, then builtin

For a session on a project, a project document shadows the global document and
the shipped builtin of the same handle. Shadowing is resolved before the
enabled filter, as ADR 0112 §3 already requires for skills and MCP: a project
document the user switched off keeps its handle claimed, so neither the global
document nor the builtin answers for it. host-core reports those handles as
`suppressedHandles` beside the active documents, because the builtins are
merged in the runtime and have to be kept out there.

A session with no project sees global documents and builtins only.

### 3. A project document is held to three limits

A project document is repository content. The user may never have read it, so
it must not be able to do what the user's own document can:

1. **No permission scope.** Its `permission` frontmatter key is ignored with a
   diagnostic and its delegates resolve under the session's effective mode
   (ADR 0089). Cloning a repository never grants it a permission upgrade.
2. **No model the user did not offer.** Its `model` and `fallbackModels` pins
   resolve only against a provider model the user enabled for subagents
   (`availableForSubagents`), or one that a user-owned definition pins itself.
   A refused pin is left unresolved and reported; the delegate then fails with
   the pin named, exactly like any other unresolvable pin, instead of quietly
   running on the session model. No credential is read for a refused pin.
3. **A bounded share of the catalog.** At most
   `MAX_PROJECT_SUBAGENT_DEFINITIONS` (8) of the 16 catalog entries come from
   the project. Project documents win their handles first; without a cap of
   their own a repository shipping sixteen definitions would remove every one
   of the user's delegates from the session. A project document past the cap
   is dropped without claiming its handle.

The `tools` grant is honored as written. It is not a privilege on its own:
every tool call still resolves under the session's permission mode.

### 4. Project documents are enabled by default

A project document is active as soon as it is in the directory, like a project
skill or MCP server. Its switch is app-local state in
`<data>/agent-capabilities/subagents.json`, keyed by the owning project, so
two projects that each ship a `reviewer` never share a switch and nothing is
written into the repository. Global documents keep one global switch; there is
no per-project override of a global subagent.

### 5. Management and moves

Settings > Agent > Subagents becomes the same workbench as Skills and MCP: the
All / Global / Project filter, the project picker, and a Project group headed
by the resolved `<project>/.agents/subagents` path. The Built-in group stays
with the global level. Rows carry their level badge; a project row's badge and
the editor's scope label state the limits of §3.

A document moves between levels through `agents.transfer`, with the semantics
ADR 0269 gave skills and MCP (moved, not copied; `-2` suffix on a taken handle;
the switch travels). One direction rewrites more than the name: a document
leaving a project loses its `permission` key, because a grant that was inert in
the repository would otherwise become live in the user's own directory without
the user having written it.

`agents.create` refuses to write over a file the scan skipped as malformed, so
authoring into a repository can never destroy a tracked file.

### 6. Protocol

`agents.list`, `agents.read`, `agents.remove` and `agents.setEnabled` accept
`level` and `projectPath`; `agents.create` and `agents.update` accept them in
the payload. A request that names no level addresses the global directory, so
existing callers are unaffected, and a project-level request without
`projectPath` is `CAPABILITY_INVALID`. `agents.active` returns
`{ subagents, suppressedHandles }`. `agents.transfer` is new.

### 7. Sync stays global

Configuration sync (ADR 0300) continues to carry global subagent documents
only. A project document belongs to its repository and travels with it. An
applied sync entity is pinned to the global level regardless of its payload, so
a bundle cannot write into a project directory on the receiving machine.

## Consequences

- A repository can ship delegates alongside the skills and MCP servers it
  already ships, and they stop at the project boundary.
- Opening an unfamiliar repository can add delegates to that project's `Task`
  catalog without a prompt. What those delegates can do is bounded by §3 and by
  the session's permission mode; the Settings page lists them and switches them
  off per project.
- A user who wants a project document's permission scope or an unoffered model
  moves the document to the global level and edits it there.
- Generated avatars stay keyed by handle, as the deterministic avatar is, so a
  handle shows the same mark at either level.
- The catalog has a third source, and the Settings page a second level.

## Alternatives rejected

- **Off until the user enables each project document.** Safer by default, but
  inconsistent with project skills and MCP servers, which are active on
  discovery and reach further (an MCP server runs a process). §3 removes what
  made an unreviewed subagent document dangerous in the first place.
- **Keep the global-only boundary.** Leaves teams without repository-scoped
  delegates and pushes project-specific prompts into every other project.
- **Honor `permission` on project documents after a trust prompt.** Adds a
  project-trust state the host does not otherwise have; moving the document to
  the global level is an explicit, already-available way to adopt it.
- **Read `.pi/agents`.** ADR 0112 made `.agents` the only capability root.
