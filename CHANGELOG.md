# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/): while it is `0.x`, a
breaking change bumps the middle number rather than the first, which is what
a zero major means. Security fixes are always a patch bump. See
[SECURITY.md](.github/SECURITY.md) for which versions get them.

## [Unreleased]

### Changed

- Added pull-request dependency review, scheduled and pull-request CodeQL
  analysis for application and workflow code, and verified repository-level
  secret scanning with push protection.
- Added scheduled read-only detection of structural REST contract changes and
  GraphQL mutation drift without automatically accepting a new API baseline.
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
