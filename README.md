# Octoform

[![npm version](https://img.shields.io/npm/v/%40hector21%2Foctoform.svg?logo=npm)](https://www.npmjs.com/package/@hector21/octoform)
[![CI](https://img.shields.io/github/actions/workflow/status/hector-ae21/octoform/ci.yml?branch=v0.x&logo=github&label=CI)](https://github.com/hector-ae21/octoform/actions/workflows/ci.yml)
[![Documentation](https://img.shields.io/badge/docs-versioned-59d5e0)](https://hector-ae21.github.io/octoform-docs/0.3/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%20%7C%2022%20%7C%2024-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/en/about/previous-releases)

Declarative governance for GitHub repositories. Describe the state you intend,
review a deterministic plan, and apply only the changes you approve.

Octoform works with organization-owned and personal repositories. It derives
availability from the authenticated owner, repository, token, and GitHub API
evidence instead of hard-coding commercial plan names.

[Read the documentation](https://hector-ae21.github.io/octoform-docs/0.3/)
· [Start safely](https://hector-ae21.github.io/octoform-docs/0.3/getting-started/)
· [Browse validated examples](https://hector-ae21.github.io/octoform-docs/0.3/examples/)

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
| Repository | Features, merge methods, metadata, topics, forking, and web commit sign-off |
| Security | Vulnerability alerts, automated fixes, private reporting, and code-scanning setup |
| Branches | Default-branch rename, ensured branches, and repository rulesets |
| Environments | Creation and required user reviewers |
| Files | Safe create-if-missing seeding without overwrite or deletion |
| Classification | Local rules for any owner and organization custom-property synchronization |

Unsupported, unavailable, and intentionally excluded operations remain visible
in the plan. See the
[capability boundary](https://hector-ae21.github.io/octoform-docs/0.3/reference/v0.3.1-baseline/)
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
[installation](https://hector-ae21.github.io/octoform-docs/0.3/getting-started/installation/),
[authentication](https://hector-ae21.github.io/octoform-docs/0.3/getting-started/authentication/),
[first-plan](https://hector-ae21.github.io/octoform-docs/0.3/getting-started/first-plan/),
and [safe-apply](https://hector-ae21.github.io/octoform-docs/0.3/getting-started/safe-apply/)
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
[configuration reference](https://hector-ae21.github.io/octoform-docs/0.3/configuration/).

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

All commands accept `--config <path>`. A run against several owners can be
narrowed with repeatable `--owner <login>`, and `--repo <name>` accepts a
qualified `owner/name` to resolve a name declared under more than one selected
owner. Planning and apply can also be narrowed with `--type <type>`. The
[command reference](https://hector-ae21.github.io/octoform-docs/0.3/commands/)
documents flags, output, authentication, and exit codes.

## Security and automation

Octoform reads credentials only from `GITHUB_TOKEN` or `GH_TOKEN`. Policy files
must never contain tokens. Plans may reveal private repository names and
settings, so their logs and artifacts require the same confidentiality as the
repositories they describe.

Pull-request workflows should remain read-only. Place write credentials behind
a protected environment, explicit authorization, pinned dependencies, and a
concurrency boundary that prevents overlapping applies.

- [Security and trust](https://hector-ae21.github.io/octoform-docs/0.3/security/)
- [CI/CD automation](https://hector-ae21.github.io/octoform-docs/0.3/automation/)
- [Private vulnerability reporting](https://github.com/hector-ae21/octoform/security/advisories/new)

## Programmatic API

The package root exports the same configuration, observation, planning, apply,
classification, and reporting building blocks used by the CLI. Octoform is ESM
only and publishes TypeScript declarations.

See the
[programmatic API overview](https://hector-ae21.github.io/octoform-docs/0.3/reference/#programmatic-api)
for the supported export surface and stability boundary.

## Versions and support

Octoform uses complete Semantic Versioning numbers without prerelease or build
suffixes. During `0.x`, a breaking contract change increments the minor
version; compatible fixes increment the patch version. Version branches use
`vMAJOR.x` and the highest supported line is the default branch.

The `0.3` documentation URL follows the newest published `0.3.x` package while
immutable patch URLs remain available. Review the
[version policy](https://hector-ae21.github.io/octoform-docs/0.3/releases/)
and [changelog](CHANGELOG.md) before updating.

## Contributing

Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, testing
contract, and the rule that product-specific behavior belongs in configuration.

Thanks to all [contributors](https://github.com/hector-ae21/octoform/graphs/contributors).

## License

[MIT](LICENSE)
