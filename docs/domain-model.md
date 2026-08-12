# Domain model

Not a diagram drawn for the occasion — this is the actual shape of the types
underneath `plan()`, in [`src/config/types.ts`](../src/config/types.ts) and
[`src/core/plan.ts`](../src/core/plan.ts).

![octoform domain model](https://www.plantuml.com/plantuml/proxy?cache=no&fmt=svg&src=https://raw.githubusercontent.com/hector-ae21/octoform/v0.x/docs/diagrams/domain-model.puml)

Four groups, and the grouping is the argument:

- **Config** — the file you write. Resolves into one `PolicySet` per
  repository (`defaults` → `types.<type>` → `repos.<name>`, see
  [concepts.md](concepts.md#2-precedence-widest-to-narrowest-key-by-key)).
- **PolicySet** and what it owns — `RulesetPolicy`, `EnvironmentPolicy`,
  `FilePolicy`. This is entirely **declared**: what you say should be true.
- **RepoState** / **RepoDetail** / **RepoStructure** — entirely **observed**:
  what GitHub actually reports back, gathered by
  [`getRepoDetail`](../src/github/client.ts).
- **Change** and **AppliedChange** — neither of the two above is the answer on
  its own. `planRepo(detail, policy)` compares them and produces `Change`,
  one entry per setting that differs. `apply()` only ever turns an
  already-reviewed `Change` into an `AppliedChange`.

A `Change` that cannot be carried out is not dropped — it comes back with
`blocked` set to why, per [concepts.md](concepts.md#3-blocked-is-not-skipped).
That field exists on `Change` itself for exactly this reason: a blocked
change is still a change, just one `apply` will refuse to make.

## Source

[`domain-model.puml`](diagrams/domain-model.puml) — plain PlantUML, rendered above
through the public PlantUML server against the raw file on `v0.x`. Edit the
`.puml`, not the image: there is no image to edit, the link above always
renders whatever is currently on the default branch.

To preview a change locally before pushing it, either paste the file into the
[PlantUML online editor](https://www.plantuml.com/plantuml/uml/) or use a
local renderer — the [PlantUML VS Code extension](https://marketplace.visualstudio.com/items?itemName=jebbs.plantuml)
works without a network round-trip if you have Java and Graphviz installed.
