# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/): while it is `0.x`, a
breaking change bumps the middle number rather than the first, which is what
a zero major means. Security fixes are always a patch bump. See
[SECURITY.md](.github/SECURITY.md) for which versions get them.

## [Unreleased]

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
- A scheduled, audit-only workflow, with `examples/self-audit/` as the
  configuration it runs. It never calls `apply`: a scheduled job that mutates
  repositories turns one bad commit into a fleet-wide change nobody watched.
- The version branch scheme (`vMAJOR.x`) this project prescribes now applies
  to this project. `v0.x` is the default branch, and `SECURITY.md` states the
  whole policy explicitly rather than deferring it to 1.0.

### Fixed

- `release.yml` decided the npm dist-tag after publishing, which cannot work:
  the credential npm exchanges for the OIDC token is scoped to that one
  publish call, so the follow-up `npm dist-tag add` gets a 401. The tag is now
  computed before publishing and passed to `npm publish --tag`.
- `ci.yml` skipped its entire test matrix on a manual tag push. A reusable
  workflow inherits the caller's event, so `github.event_name` was still
  `push` and the gate `release.yml` depends on ran nothing at all.

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
