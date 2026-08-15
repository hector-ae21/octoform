# Octoform

[![npm version](https://img.shields.io/npm/v/%40hector21%2Foctoform.svg?logo=npm)](https://www.npmjs.com/package/@hector21/octoform)
[![CI](https://img.shields.io/github/actions/workflow/status/hector-ae21/octoform/ci.yml?branch=v0.x&logo=github&label=CI)](https://github.com/hector-ae21/octoform/actions/workflows/ci.yml)
[![Documentation](https://img.shields.io/badge/docs-versioned-59d5e0)](https://hector-ae21.github.io/octoform-docs/0.4/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%20%7C%2022%20%7C%2024-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/en/about/previous-releases)

Declarative governance for GitHub organizations and repositories. Describe the
state you intend, review a deterministic plan, and apply only the changes you
approve.

Octoform works with organization-owned and personal repositories, and with the
organization itself — its profile, its member policies, its teams, its custom
properties and the rulesets it aims at the repositories it owns. It derives
availability from the authenticated owner, repository, token, and GitHub API
evidence instead of hard-coding commercial plan names.

[Read the documentation](https://hector-ae21.github.io/octoform-docs/0.4/)
· [Start safely](https://hector-ae21.github.io/octoform-docs/0.4/getting-started/)
· [Browse validated examples](https://hector-ae21.github.io/octoform-docs/0.4/examples/)

## Why Octoform

Repository templates affect future repositories, while policy drift accumulates
in repositories that already exist. Octoform reconciles those existing
repositories from an explicit YAML policy.

- **Review before mutation.** `audit` and `plan` are read-only. `apply` presents
  the plan and asks for confirmation before writing.
- **Omission means unmanaged.** A setting that is absent from the policy is
  left untouched; `false` is an explicit desired value.
- **Uncertainty blocks changes.** An unreadable or unsupported setting is
  reported instead of guessed.
- **Owner-neutral configuration.** Project names, classifications, and policy
  decisions live in YAML, not in ecosystem-specific source code.
- **Capability from evidence.** Private repository rulesets and other gated
  features are decided from current GitHub behavior and token access.

## Supported scope

One configuration governs one or several GitHub accounts, personal or
organization, and supports:

| Area | Desired state |
| --- | --- |
| Repository | Features, merge methods and message defaults, metadata, topics, forking, visibility, template, archive state, and rename |
| Security | Vulnerability alerts, automated fixes, private reporting, secret scanning, code-scanning setup, and immutable releases |
| Branches | Default-branch rename, ensured branches, repository rulesets, and classic branch protection |
| Access | Direct collaborators and team grants, with revocation stated rather than inferred |
| Collections | Labels, milestones, and repository custom-property values |
| Environments | Creation and required user reviewers |
| Files | Safe create-if-missing seeding without overwrite or deletion |
| Organization | Profile, member policies, custom-property definitions, and organization rulesets targeted by repository name or property |
| Teams | Creation, nesting, visibility, and who is on each one |
| Roles | Who holds each organization role, by users and by teams |
| People | Read-only inventory, and explicit one-person invite, removal and conversion |
| Classification | Local rules for any owner and organization custom-property synchronization |

Organization membership is the one area that is deliberately not declarative.
An invitation is an act addressed to a person who is emailed about it, so it is
a command that asks first rather than a line in a file a schedule reconciles.

Unsupported, unavailable, and intentionally excluded operations remain visible
in the plan. See the
[capability boundary](https://hector-ae21.github.io/octoform-docs/0.4/reference/)
for the exact versioned contract and known limitations.

## Install

Install the scoped package globally; the executable remains `octoform`:

`npm install --global @hector21/octoform`

Node.js 20 or newer is required. Node.js 20, 22, and 24 are tested.

## Safe quick start

Create `octoform.yml` with one deliberately narrow setting:

```yaml
owner: your-account

defaults:
  merge:
    delete_branch_on_merge: true
```

Provide a token through the process environment, then produce a read-only plan:

```bash
export GITHUB_TOKEN=...
octoform plan --config octoform.yml
```

For a fine-grained personal access token, select only the repositories and
permission families needed by the declared policy. GitHub App installation
tokens are preferred for automation. Never put a token in the YAML file.

Review every proposed and blocked operation. Apply only when the plan matches
your intent:

```bash
octoform apply --config octoform.yml
```

The apply command plans again, displays the result, and requests confirmation.
Use `--yes` only inside an independently protected automation boundary.

Continue with the complete
[installation](https://hector-ae21.github.io/octoform-docs/0.4/getting-started/installation/),
[authentication](https://hector-ae21.github.io/octoform-docs/0.4/getting-started/authentication/),
[first-plan](https://hector-ae21.github.io/octoform-docs/0.4/getting-started/first-plan/),
and [safe-apply](https://hector-ae21.github.io/octoform-docs/0.4/getting-started/safe-apply/)
guides.

## Configuration model

Policy is resolved key by key from the most general layer to the most specific:

```text
imports -> policies -> root defaults -> owner defaults -> types.<type> -> repos.<name>
```

A file names one account in `owner`, or several under `owners`, keyed by GitHub
login. The root of a multi-owner file holds what the accounts share, and each
entry states only what differs. Declaring both `owner` and `owners` is
rejected, because nothing would say which account the shared layer was written
for.

`policies` are named, reusable fragments that any layer folds in through its own
`policies` list, before that layer's own keys. Imports compose whole files the
same way. An imported file may omit the owner; the configuration being executed
must name one. Unknown keys, unresolved references, conflicting owners, and
import or policy cycles are all rejected, with the file and path that caused
them.

Declarations that only apply to organizations stay valid under a personal
account so a shared preset stays shareable; they are reported as not applicable.
Pass `--strict` to fail on them instead.

For complete field shapes, precedence, selectors, capability behavior, and
examples, use the versioned
[configuration reference](https://hector-ae21.github.io/octoform-docs/0.4/configuration/).

## Commands

| Command | Contract |
| --- | --- |
| `octoform audit` | Read-only inventory and configurable findings |
| `octoform plan` | Read-only desired-state comparison with blocked-operation reasons |
| `octoform apply` | Confirmed mutation based on a freshly produced plan |
| `octoform classify` | Read-only type proposals, or explicit organization-property writes with `--apply` |
| `octoform properties sync` | Organization custom-property schema and declared value synchronization |
| `octoform config validate` | Offline load and resolution report. Never contacts GitHub |
| `octoform config migrate` | Offline conversion from a single-owner file to the multi-owner shape |
| `octoform inspect config` | Offline. The fully resolved configuration for the selected owners |
| `octoform inspect capabilities` | Each selected owner's kind, identity, and what it supports |
| `octoform inspect members` | Read-only. Who is in the organization, and which people the configuration names are not |
| `octoform members invite` | Confirmed invitation of one person, who is emailed about it |
| `octoform members remove` | Confirmed removal of one person, or withdrawal of the invitation they never answered |
| `octoform members convert` | Confirmed conversion of one member to an outside collaborator |

All commands accept `--config <path>`. A run against several owners can be
narrowed with repeatable `--owner <login>`, and `--repo <name>` accepts a
qualified `owner/name` to resolve a name declared under more than one selected
owner. Planning and apply can also be narrowed with `--type <type>`, bounded
with `--concurrency <n>`, and told to stop at the first failing owner with
`--fail-fast` instead of continuing through the rest. The `members` commands
take the one person they are about as `--user <login>`, and `members invite`
takes the organization role to offer as `--role <role>`.

The three `members` commands refuse two things whatever else is true: removing
or converting the only remaining owner, which would leave an organization
nobody can administer, and doing either to the account the run is
authenticated as, which could not put itself back.

`octoform plan --out plan.json` saves the reviewed plan, and
`octoform apply --plan plan.json` performs exactly that plan or refuses,
naming which check failed. `--format json` wraps output in a versioned
envelope. Exit status is a frozen set of classes: `0` success, `1` drift found
or apply declined, `2` usage or configuration error, `3` authentication or
permission failure, `4` an operation was blocked, `5` an operation or the run
itself failed. The
[command reference](https://hector-ae21.github.io/octoform-docs/0.4/commands/)
documents every flag and output.

## Security and automation

Octoform reads credentials from a token passed by a programmatic caller, then
`GITHUB_TOKEN`, then `GH_TOKEN`. Nothing else is searched, and secrets are
never accepted as command-line flags. A configuration value shaped like an
issued GitHub token is rejected when the file loads, naming the YAML path
without echoing the value. Plans may still reveal private repository names and
settings, so their logs and artifacts require the same confidentiality as the
repositories they describe; a saved plan is written with owner-only
permissions where the platform supports them.

Pull-request workflows should remain read-only. Place write credentials behind
a protected environment, explicit authorization, pinned dependencies, and a
concurrency boundary that prevents overlapping applies.

Governing the organization needs more than governing its repositories, and the
difference is worth stating before granting it. A base permission, an
organization ruleset and an organization role each reach every repository the
organization owns, including ones no configuration names, so each is reported
as `sensitive` in the plan. Deleting a team takes its child teams with it, and
taking somebody off a team takes them out of every repository that team
reached; both are reported as `destructive`. Nothing at this level is removed
because a file stopped mentioning it — a team, a property definition or a
member is removed only where the configuration says so, or through a command
that names the person and asks.

`reference/permissions.json` ships with the package and states, per route and
per capability, which classic scope or fine-grained profile it needs. It is
generated from the same register the behaviour is checked against, so it is
what to read before deciding what a token should be allowed to do.

There is no rollback command, and adding one would be a lie: GitHub does not
keep the previous value of most of these settings, so octoform could only
restore what it happened to read a moment earlier. The way back is the way
forward — correct the file and run again — which works because omission means
unmanaged and a plan is deterministic. What that does not recover is anything
GitHub destroyed rather than changed: a deleted team and its children, a
deleted custom property definition and every value repositories held for it, a
removed member's team memberships, a deleted label and its place on every issue
it marked. Each of those is reported as `destructive` in the plan, and none of
them happens because a line was left out of a file.

Four repository settings exist only in GitHub's GraphQL API and are read and
written there: `features.sponsorships`, `features.pull_requests`,
`repo.issue_creation` and `repo.pull_request_creation`. They are asked for only
when a policy manages one of them, they need a token GraphQL accepts, and a
change to one is blocked rather than attempted when the repository's node
identity could not be read. Everything else is REST, and a GraphQL failure
narrows to the same unreadable state a REST failure does, so the planner blocks
it for the same reason without knowing which transport observed it.

- [Security and trust](https://hector-ae21.github.io/octoform-docs/0.4/security/)
- [CI/CD automation](https://hector-ae21.github.io/octoform-docs/0.4/automation/)
- [Private vulnerability reporting](https://github.com/hector-ae21/octoform/security/advisories/new)

## Programmatic API

The package root exports the same configuration, observation, planning, apply,
classification, and reporting building blocks used by the CLI. Octoform is ESM
only and publishes TypeScript declarations.

See the
[programmatic API overview](https://hector-ae21.github.io/octoform-docs/0.4/reference/#programmatic-api)
for the supported export surface and stability boundary.

## Versions and support

Octoform uses complete Semantic Versioning numbers without prerelease or build
suffixes. During `0.x`, a breaking contract change increments the minor
version; compatible fixes increment the patch version. Version branches use
`vMAJOR.x` and the highest supported line is the default branch.

The `0.4` documentation URL follows the newest published `0.4.x` package while
immutable patch URLs remain available. Review the
[version policy](https://hector-ae21.github.io/octoform-docs/0.4/releases/)
and [changelog](CHANGELOG.md) before updating.

## Contributing

Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, testing
contract, and the rule that product-specific behavior belongs in configuration.

Thanks to all [contributors](https://github.com/hector-ae21/octoform/graphs/contributors).

## License

[MIT](LICENSE)
