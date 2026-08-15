# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/): while it is `0.x`, a
breaking change bumps the middle number rather than the first, which is what
a zero major means. Security fixes are always a patch bump. See
[SECURITY.md](.github/SECURITY.md) for which versions get them.

## [Unreleased]

Octoform now governs the account above the repositories as well as the
repositories themselves, and finishes the repository surface it had started.
Two exported shapes moved, which is why this is a minor bump rather than a
patch: see **Changed**.

### Added

#### The organization itself

- An `organization` block, planned and applied like any other change rather
  than through a command of its own. Its profile, and what members may do
  without being asked: the base permission, what they may create, forking,
  Pages, web commit sign-off, deploy keys and projects.
- The base permission and the creation switches are reported as `sensitive`,
  because they reach every repository the organization owns including ones no
  policy names, and the organization is applied before any repository so a
  lowered floor is never briefly wider than the file asks for.
- Custom property definitions under `organization.properties`. The write
  endpoint replaces rather than patches, so the current definition is read
  first and every field the configuration is silent about is carried forward;
  definitions that could not be read block rather than being written over.
- Organization rulesets under `organization.rulesets`: the same rules a
  repository can carry, aimed at repositories selected by name or by custom
  property value. Every one is `sensitive`, since it reaches whatever its
  condition matches.
- Teams under `organization.teams`, keyed by the slug GitHub addresses each one
  by, with nesting. A child team waits for a parent the same run is creating,
  and is blocked rather than attempted when that creation fails.
- Team membership under `organization.teams.<slug>.membership`: additive unless
  the block says `authoritative`, and a pending invitation counts as somebody
  already asked, so nobody is invited twice.
- Organization role assignment under `organization.roles`, granting and
  revoking a role for users and teams.
- `octoform inspect members`: owners, members, outside collaborators, waiting
  and failed invitations, and which people the configuration names are in no
  part of the organization.
- `octoform members invite`, `members remove` and `members convert`: one login
  per invocation, each saying what it will do and asking first. Membership is
  deliberately not declarative — an invitation is an act addressed to a person,
  and an authoritative list would remove somebody the first time a name was
  mistyped.

#### The repository surface, completed

- Every repository ruleset rule type, target and condition, modelled as one
  table that reading, writing and comparison are all derived from.
- Ruleset bypass actors — users, teams, apps, repository roles, deploy keys and
  organization admins — resolved by name while reading, so an unknown name is a
  blocked line in the plan rather than an exception thrown mid-apply.
- Classic branch protection under `branch_protection`. A branch governed by
  both protection and a ruleset blocks on both sides: GitHub applies both and
  the stricter wins per rule, so neither block describes what is enforced.
- `access.users` and `access.teams`, with pending invitations read so a grant
  to somebody who is not a collaborator yet is not re-sent on every run.
  Revocation is spelled `none`, so deleting a line cannot silently remove
  access.
- Labels, milestones and repository custom property values, with `rename_from`
  and `mode: absent`.
- `repo.visibility`, `repo.archived`, `repo.template` and repository rename.
  Unarchiving is sent first and everything waits for it; archiving is sent last
  and only if everything else succeeded.
- The four repository settings only GraphQL exposes: `features.sponsorships`,
  `features.pull_requests`, `repo.issue_creation` and
  `repo.pull_request_creation`. `features.discussions` is now changeable
  instead of permanently blocked.
- Merge message defaults and `security.immutable_releases`.
- A warning when `security.code_scanning_default_setup` would disable a
  workflow that uploads code scanning results, which GitHub refuses without
  either side reporting a failure.
- A resource dependency graph: apply order comes from the graph rather than
  from the order the steps happen to be written in, and a dependent whose
  prerequisite failed is blocked rather than attempted.
- `octoform inspect capabilities --repo <name>`, reporting whether rulesets can
  be managed on one repository and what said so.
- A GraphQL transport, normalized against the REST one. A GraphQL response can
  carry data and errors together under HTTP `200`, so a request reports what
  arrived alongside what failed instead of letting a partial observation read
  as a complete one. Failures are reduced to the same vocabulary a REST status
  carries, an unrecognized error type is treated as unavailable rather than as
  a confirmed absence, and one failed field narrows to the same `UNREADABLE`
  sentinel a REST read produces — so the planner blocks it for the same reason
  and cannot tell which transport observed it. Reads are retried only while
  every failure is transient and nothing arrived; a mutation is never retried.

### Changed

- `Change.repo` is now optional. An organization setting has no repository to
  name, and inventing one would make it group and count as though it did.
  Programmatic callers that read `change.repo` as a string have to handle its
  absence.
- `planOrganization`, `setPropertyValues` and `putPropertySchema` take
  different arguments. The first now receives the organization as it stands
  rather than only its settings; the other two take a list of repositories and
  a body built by the caller, because a definition has to be read before it is
  written.
- `classify --apply` and `properties sync` send thirty repositories per
  request. Neither did, and exceeding that limit is the ordinary case for an
  organization large enough to want either command.

### Fixed

- `properties sync` no longer clears the fields it says nothing about. It sent
  the allowed values alone, which on a property that already existed reset its
  description, its default value and who may edit it — every run, silently.
- Two different lists of objects of the same length no longer compare as
  identical when a ruleset is compared. They were rendered with `String`,
  which turns every object into the same text, so a rule that had changed could
  read as unchanged.
- Updating a ruleset no longer deletes the rules octoform does not model, or
  the ones the policy does not mention. The update replaces the whole rule
  list, and what was not sent back was being removed with nothing in the plan
  to say so.
- An undeclared ruleset key is no longer treated as a demand for GitHub's
  default, which made every run offer to strip approvals and protections
  nobody had asked about.
- A seeded file is read as bytes. Round-tripping through UTF-8 replaced every
  byte that was not valid text, corrupting anything that is not text.
- A seeded file's existence is checked on the branch it would be created on
  rather than on the default branch, which seeded a second copy.
- The topics, PUT/DELETE toggle, code scanning and branch rename steps record
  their failures, so anything depending on them is blocked instead of
  attempted.
- `config migrate` moves a `repos` block at an imported file's root under the
  account the root file declares, instead of refusing the whole migration.

## [0.4.1] - 2026-08-15

Found by running `0.4.0` against real multi-account configurations rather than
against fixtures. Every change is compatible: no exit class, schema, or
exported signature moved.

### Fixed

- `config migrate` no longer produces a configuration that fails to load. It
  converted the root file's `owner` to `owners` while leaving a `repos` block
  at the root of an imported file, and that block is accepted beside `owner`
  but rejected beside `owners`. The migration now stops, names the files that
  have to move first, and writes nothing. Imports that keep repositories out
  of their root migrate exactly as before.
- A setting whose current value could not be read is explained from what was
  observed instead of guessing at a commercial plan. Where repository
  visibility settles the question — GitHub hides scanning settings outside a
  public repository without Advanced Security — the report says so; where it
  does not, the report says only that the value could not be read.
- A plan summary reports how many repositories carry blocked work. The buckets
  are exclusive so they sum to what was scanned, which files a repository that
  is both changed and blocked under `changed` alone; that count is now stated
  alongside the totals instead of being left implicit.

### Added

- `PlanSummary` gains `blockedRepositories`, the number of repositories with at
  least one blocked change whether or not they also changed. Adding a field is
  a compatible change.

## [0.4.0] - 2026-08-15

### Added

- One configuration can now describe several GitHub accounts. A root `owners`
  mapping keyed by GitHub login replaces the need for one file per account, and
  the root of the file holds whatever those accounts share. Each account is
  planned and applied in the order it is declared.
- A root `version` field states which configuration contract a file is written
  against. Version `1` is the only accepted value. It is optional for a
  single-owner file and required whenever `owners` is used.
- A root `policies` mapping declares named, reusable policy fragments. Any
  layer folds them in through its own `policies` list, before that layer's own
  keys, and a policy may reference other policies.
- `--strict` fails a run when a configuration declares something that does not
  apply to the account that declared it, instead of reporting it and
  continuing.
- A generated `config-model.json` reference artifact publishes the precedence
  chain and the combining rule of every collection in the configuration model.
- `--owner <login>` narrows `audit`, `plan`, `apply`, `classify`, and
  `properties sync` to the named account(s), repeatable, and rejects a login
  the configuration does not declare.
- `--repo` accepts a qualified `owner/name` to resolve a repository name
  declared under more than one selected owner; an unqualified name that
  matches more than one selected owner is rejected with the qualified forms.
- A run touching more than one declared owner, or narrowed by a selector,
  prints a scope summary of which owners are selected and which were excluded.
- `octoform config validate` loads and reports a configuration without
  contacting GitHub.
- `octoform config migrate` converts a single-owner file to the multi-owner
  shape, previewing by default; `--write` updates the file in place and
  refuses to run against a file with uncommitted git changes.
- `discoverOwner` resolves an owner's kind and GitHub's numeric identity for
  it in one call, replacing the need to trust a login alone; `detectOwnerKind`
  is now a thin projection over the same discovery, sharing its cache.
- Capability decisions carry status, reason, source, and an observation
  timestamp instead of a bare boolean. `detectRulesetCapability` replaces
  `detectPrivateRulesetCapability` and reports `supported`, `forbidden`, or
  `unknown` — an opaque `404` no longer reads the same as a confirmed denial.
- Requests now send the pinned `X-GitHub-Api-Version` header, published as
  `REST_API_VERSION`.
- `requireScopes` now also returns the core rate-limit budget, read from the
  same response rather than a dedicated request. `audit`, `plan`, `apply`,
  `classify`, and `properties sync` print a one-line warning when it is low
  enough to threaten the rest of the run.
- `detectLimits` is now cached per owner for the life of the client, the same
  way owner discovery already was.
- Every planned change now carries a stable `id`, `owner`, `operation`
  (`create`/`update`/`attach`/`detach`/`delete`), and `risk`
  (`normal`/`sensitive`/`destructive`/`cost`), so a result can be correlated
  with the operation that produced it across a run and across output formats.
- `--concurrency <n>` bounds how many repositories `plan` and `apply` work on
  at once per owner (default 4). Two runs against unchanged state now produce
  operations in the same order regardless of API response timing.
- A failure in one owner no longer aborts the rest of the selection: by
  default the run continues to every other owner and reports each outcome
  isolated from the others; `--fail-fast` stops at the first failure instead.
  A run against more than one owner prints a total across every owner reached.
- A repository whose plan cannot even be computed is now reported as a
  distinct failure rather than silently treated as "no changes."
- `octoform plan --out <path>` saves a versioned plan artifact:
  actor, target owners' numeric identity, a digest of the resolved
  configuration and of every source file that contributed to it, an
  observation time, and an expiry (`--expires-in <minutes>`, default 60).
- `octoform apply --plan <path>` applies exactly that saved plan instead of
  planning again. It refuses a plan whose schema version, actor, owner
  identity, configuration digest, source digests, or expiry no longer match,
  each with its own distinct reason — a stale or altered plan is never
  silently repaired or re-planned.
- `createClient` accepts an explicit token or token-provider function, checked
  before `GITHUB_TOKEN` and `GH_TOKEN`.
- A configuration value shaped like a GitHub token (`ghp_…`, `github_pat_…`,
  and other issued-token prefixes) is now rejected at load time, naming the
  YAML path without echoing the value. Mapping keys are checked too: a token
  pasted where a login or a repository name belongs is reported against its
  parent, so the error never repeats it.
- Exit codes are now a documented, frozen set of classes for the `v0` line:
  `0` success, `1` drift found or apply declined, `2` usage/configuration
  error, `3` authentication or permission failure, `4` an operation was
  blocked, `5` an operation or the run itself failed.
- `octoform inspect config` prints the fully resolved configuration for the
  selected owners. Offline, like `config validate`.
- `octoform inspect capabilities` prints, per selected owner, its kind,
  numeric identity, organisation-ruleset availability, and any declaration
  that does not apply to that owner.
- `--format json` wraps output in a versioned envelope
  (`{ schemaVersion, command, data }`). Supported by `plan`, `inspect config`,
  and `inspect capabilities` in this release; other commands remain text-only.
- `printable` renders a value that came from GitHub or from a configuration
  file safely for a terminal, and every report now goes through it.

### Changed

- Unknown configuration keys are now rejected instead of ignored. The error
  names the file, the YAML path, and the closest declared key.
- Values of the wrong kind, such as a single value where a list is required,
  are rejected with their YAML path.
- Notes about declarations that do not apply to an account are now reported for
  every command rather than only during `audit`.
- `loadConfig` returns a resolved configuration holding one scope per owner
  rather than a single-owner object, and `resolvePolicy`, `repoType`, and
  `isExcluded` take one of those scopes. Configuration files are unaffected;
  programmatic callers that read `config.owner` read `config.owners[n].owner`.
- A blocked ruleset change on a private repository now states the specific
  reason the capability was unavailable, instead of a single generic message.
- `PlanOptions.rulesetsEnforcedOnPrivate: boolean` is now
  `PlanOptions.rulesetCapability: CapabilityResult`. Only programmatic callers
  of `planRepo` are affected.
- `audit`'s and `apply`'s previous ad hoc `0`/`1` exit codes now follow the
  frozen classes above. A script that only checked "zero or not" is
  unaffected; one that branched on the exact previous number should not have.
- `mapWithConcurrency`, `DEFAULT_CONCURRENCY`, `errorMessage`, and
  `errorStatus` are no longer exported from the package entry point. They
  were internal execution and error-classification helpers, never part of the
  documented programmatic API.
- `buildPlanArtifact` and `verifyPlanArtifact` take the authenticated actor
  and the owners' numeric identities as data rather than a client, and
  `verifyPlanArtifact` is now synchronous. Deciding whether a saved plan is
  still valid no longer performs requests of its own. Only programmatic
  callers are affected.

### Security

- A declared owner is now checked against GitHub's own login format when the
  configuration loads, and rejected with the reason when it cannot be one: a
  path separator, a control character, a leading or trailing hyphen, a length
  over 39, or a character GitHub does not issue. Every declared owner is asked
  of the API by login, so this turns an unusable value into one error naming
  the file and the path instead of an opaque `404` several requests later. No
  configuration that previously worked is affected — a login this rejects
  could not have resolved to an account.
- Repository names, descriptions, topics, custom-property values and API error
  text are writable by anyone with access to the account being audited, which
  is not always the person running octoform. Control characters in any of them
  are now escaped before they are printed, so a crafted value can no longer
  emit terminal escape sequences that overwrite lines already on screen, hide
  a blocked change from the report, or imitate the confirmation prompt
  `apply` shows before it changes anything.

### Compatibility

- Existing single-owner configurations keep their exact meaning and produce the
  same plans. `owner`, `defaults`, `types`, `repos`, `classify`, `audit`, and
  `exclude` at the root are unchanged.
- Root-level `repos` is rejected only when combined with `owners`, where a bare
  repository name no longer identifies one repository.

### Internal

- Every type and interface now lives under `src/types/`, grouped by domain
  instead of scattered across the module that happened to use it first. Public
  exports are unaffected; this is a source-organization change only.
- Determinism, layering, selector narrowing, no-op stability and owner
  isolation are now checked as properties over generated configurations and
  generated observed state, alongside an adversarial suite covering confusable
  logins, hostile repository names, import and policy cycles, and unreadable
  state. Generated cases are seeded, so a failure reports the seed that
  reproduces it.

## [0.3.2] - 2026-08-14

### Compatibility

- This is a maintenance-only patch for `0.3.1`. It does not add or remove
  configuration fields, CLI commands, public exports, managed GitHub
  capabilities, or plan/apply behavior. Existing `0.3.1` configurations and
  integrations remain compatible without migration.

### Changed

- Standardized formatting and the local verification entry points so the same
  deterministic checks cover source, generated artifacts, tests, builds, and
  the packed package.
- Hardened pull-request and release workflows with pinned actions, explicit
  permissions, bounded execution, concurrency controls, and a supported Node
  `20`, `22`, and `24` verification matrix.
- Added pull-request dependency review, scheduled and pull-request CodeQL
  analysis for application and workflow code, and verified repository-level
  secret scanning with push protection.
- Added scheduled read-only detection of structural REST contract changes and
  GraphQL mutation drift without automatically accepting a new API baseline.
  A failed audit opens or refreshes one maintainer-review issue, preserves the
  failed workflow signal, and closes the notice after the contract is clean.
- Enforced valid TSDoc as the only authored comment format in production and
  tooling source, with automated rejection of narrative comments, directives,
  disabled code, and references to private planning material.

### Documentation

- Added deterministic configuration-schema, CLI, capability, and permission
  manifests with complete implemented-route coverage and SHA-256 checksums for
  immutable release assets.
- Added a deterministic, machine-readable TypeDoc reference for every
  supported programmatic export, with validation that rejects undocumented
  declarations and stale generated output.
- Replaced the application README with a complete product overview and safe
  packed-package quick start linked to the versioned documentation site.
- Moved the maintained configuration, command, architecture, security, and
  example documentation to the dedicated `octoform-docs` repository so public
  guidance is published and versioned through one canonical source.
- Added an audited `v0.3.1` behavior baseline covering the published artifact,
  CLI and exit behavior, configuration surface, desired-state coverage, REST
  operations, authentication boundaries, and confirmed documentation gaps.
- Added a reproducible disposition register for 1,063 relevant REST operations
  and 274 GraphQL mutations, with pinned source evidence and verification that
  blocks unreviewed API surface changes.

## [0.3.1] - 2026-08-12

### Fixed

- Private repositories owned by personal accounts no longer have their
  rulesets blocked merely because organisation-wide rulesets do not exist for
  that kind of owner. `plan` now probes the capability for each private
  repository and current token through GitHub's read-only branch-protection
  endpoint, which has the same plan availability as repository rulesets. This
  supports GitHub Pro benefits such as Education without hard-coding plan
  names, while still blocking a ruleset when the owner plan or token does not
  permit it.

## [0.3.0] - 2026-08-10

### Added

- `plan`/`apply` now correct an **existing** environment's `reviewers`, not
  just create the environment when it's missing. GitHub's list endpoint
  already returns each environment's required-reviewers rule, so this costs
  no extra request. Reviewers are compared as a set — order is never drift,
  same as `topics`.
- An environment whose required reviewer is a **team** is reported as
  blocked rather than corrected: octoform only resolves a declared reviewer
  to a *user* id, so it has no way to compare against — or safely write over
  — a team's protection. Reading that case as "no reviewers" would have made
  a normal-looking change quietly replace the team the moment `apply` ran.
- A [domain-model diagram](https://hector-ae21.github.io/octoform-docs/0.3.1/architecture/software/domain-model/)
  of the actual types behind `plan()` — what's declared, what's observed, and
  the `Change` produced by comparing them.

### Changed

- **Breaking (type-level):** `RepoStructure.environments` is now
  `ExistingEnvironment[]` (`{ name, reviewers }`) instead of `string[]`. Only
  affects programmatic use of `getRepoDetail`'s return value directly — the
  CLI and `octoform.yml` are unaffected.

## [0.2.1] - 2026-08-10

The configuration model was complete in 0.1.0; `apply` was not. This closes
that gap — everything the YAML can declare, `apply` now carries out — and
turns the branching scheme this tool prescribes on the tool itself.

0.2.0 was tagged but never published: the release pipeline caught the
`--help` exit code below and stopped before publishing, which is what it is
there for. Nothing was released under that number, so this is the first
version carrying any of the changes here.

### Added

- `plan`/`apply` now cover the rest of the configuration model: rulesets
  (created and updated in place, comparing only the rules octoform models, so
  a rule somebody added by hand is never silently stripped), environments,
  `ensure_branches`, file seeding, default-branch renaming, and the
  `automated_security_fixes` / `private_vulnerability_reporting` toggles.
- Renaming a default branch names the workflow files that will break. GitHub
  redirects the branch and retargets open pull requests, but a workflow that
  says `branches: [master]` keeps parsing and quietly stops matching anything;
  `plan` reads the workflows first and reports which ones do that.
- `default_branch.rename_from` gates the rename to names the configuration
  anticipated. A repository whose default branch is not on that list is
  reported, not renamed.
- `octoform classify`: proposes a type for each unclassified repository from
  `classify.rules`, prints them, and only records them with `--apply`.
- `octoform properties sync`: creates or updates the custom property that
  stores the type and records the declared values. Its allowed values are the
  keys of `types`, so there is no second list to fall out of step. It writes
  only what differs, which is what makes a second run a no-op.
- A scheduled, audit-only workflow, with `.github/octoform-audit.yml` as the
  configuration it runs. It never calls `apply`: a scheduled job that mutates
  repositories turns one bad commit into a fleet-wide change nobody watched.
- The version branch scheme (`vMAJOR.x`) this project prescribes now applies
  to this project. `v0.x` is the default branch, and `SECURITY.md` states the
  whole policy explicitly rather than deferring it to 1.0.
- A full reference for every configuration key and command, alongside the
  concepts the rest depends on. This historical documentation is preserved in
  the immutable [Octoform 0.3.1 documentation](https://hector-ae21.github.io/octoform-docs/0.3.1/).

### Fixed

- `release.yml` decided the npm dist-tag after publishing, which cannot work:
  the credential npm exchanges for the OIDC token is scoped to that one
  publish call, so the follow-up `npm dist-tag add` gets a 401. The tag is now
  computed before publishing and passed to `npm publish --tag`.
- `ci.yml` skipped its entire test matrix on a manual tag push. A reusable
  workflow inherits the caller's event, so `github.event_name` was still
  `push` and the gate `release.yml` depends on ran nothing at all.
- `octoform --help` exited 2. Asking for help is not a usage error, and a
  release job running it as a smoke test — or any script checking the exit
  code — is right to treat a non-zero as failure. Running with no command at
  all still exits 2, because there the usage text really is an error message.
  Never caught before because 0.1.0 was published by hand, so the step that
  runs it had never actually executed.
- The CLI ran a stale build without saying so. `bin/octoform.js` executes
  `dist/`, so a failed or forgotten `npm run build` meant the previous build
  kept running — and its failure mode is quietly doing less than you asked
  for, which reads as the tool ignoring a policy rather than as a stale
  build. It now refuses to start when `src/` is newer than `dist/`, and only
  checks that when `src/` is present, since an installed package has none.

### Changed

- `files[].from` resolves against the file that declares it rather than the
  working directory, so an imported preset finds the files sitting next to it.

## [0.1.0] - 2026-08-09

First published version.

### Added

- `octoform audit`: read-only inventory of an owner's repositories, their
  recorded type, and configurable findings (missing type, missing
  description or topics on public repositories, topics over a limit).
- `octoform plan`: read-only diff between the declared configuration and each
  repository's actual settings (features, merge options, security settings,
  description and topics), with `--repo` and `--type` filters. Anything that
  cannot be applied is reported as blocked with the reason, never dropped in
  silence — an unimplemented policy, a value this GitHub plan does not
  expose, or a ruleset on a private repository the plan would not enforce.
- `octoform apply`: shows the same diff `plan` would, asks for confirmation
  (`--yes` to skip it), and calls the GitHub API. Applies everything `plan`
  diffs today — grouped so that, for instance, five repository-settings
  changes cost one API call, not five — and reports each change as applied
  or failed with the reason; a failure in one group never stops the others
  from being attempted.
- Support for personal GitHub accounts, not just organisations: `owner` in
  the configuration is resolved against the API rather than assumed, so the
  same file format and commands work identically for an organisation's fleet
  or for one person's own repositories.
- `imports`: split a configuration across several files and fold them back
  together, most general first, so a set of type presets can be shared
  across unrelated owners.
- Tri-state configuration model (`true` / `false` / omitted) with precedence
  `defaults` -> `types.<type>` -> `repos.<name>`, resolved key by key.
- Programmatic entry point (`import ... from '@hector21/octoform'`) alongside
  the CLI.

### Known limitations

- Rulesets, environments, default-branch renaming and file seeding are part
  of the configuration model and show up in `audit`/`plan`, but `apply`
  cannot act on any of them yet.
- `security.automated_security_fixes` and
  `security.private_vulnerability_reporting` are declared in the model but
  not implemented.
- `features.discussions` cannot be applied over the REST API: GitHub has no
  `has_discussions` field on `repos/update`, and no dedicated endpoint
  either.
- Organisation-wide rulesets need a paid GitHub plan, and rulesets are only
  enforced on private repositories on paid plans, on both organisation and
  personal accounts. octoform detects this and skips those policies with an
  explicit message instead of creating a rule that quietly does nothing.
