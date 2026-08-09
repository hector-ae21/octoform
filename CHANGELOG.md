# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/) once it reaches 1.0 —
until then, breaking changes can land in a minor release.

## [Unreleased]

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
  Rulesets, environments and seeded files are part of the configuration
  model but not yet diffed against a repository's actual state.
- Support for personal GitHub accounts, not just organisations: `owner` in
  the configuration is resolved against the API rather than assumed, so the
  same file format and commands work identically for an organisation's fleet
  or for one person's own repositories.
- `imports`: split a configuration across several files and fold them back
  together, most general first, so a set of type presets can be shared
  across unrelated owners.
- `octoform apply`: shows the same diff `plan` would, asks for confirmation
  (`--yes` to skip it), and calls the GitHub API. Applies everything `plan`
  diffs today — grouped so that, for instance, five repository-settings
  changes cost one API call, not five — and reports each change as applied
  or failed with the reason; a failure in one group never stops the others
  from being attempted. Rulesets, environments, default-branch renaming and
  file seeding remain plan-only for now.
- Tri-state configuration model (`true` / `false` / omitted) with precedence
  `defaults` -> `types.<type>` -> `repos.<name>`, resolved key by key.
- Programmatic entry point (`import ... from 'octoform'`) alongside the CLI.

## [0.1.0] - 2026-08-09

Initial scaffolding. Not published.
