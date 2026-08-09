# octoform

Declarative governance for GitHub repositories — an organisation's or your
own. Describe how your repositories should be configured in one YAML file;
octoform reports the drift and, when you tell it to, corrects it.

It is `plan` / `apply` for repository settings, branch rules, environments and
the handful of files GitHub does not inherit from a `.github` repository.

## Table of contents

- [Why](#why)
- [It knows nothing about your stack](#it-knows-nothing-about-your-stack)
- [Install](#install)
- [Quick start](#quick-start)
- [Organisations and personal accounts](#organisations-and-personal-accounts)
- [Configuration](#configuration)
  - [Every setting is tri-state](#every-setting-is-tri-state)
  - [Precedence](#precedence)
  - [Splitting configuration with imports](#splitting-configuration-with-imports)
- [Commands](#commands)
- [Programmatic use](#programmatic-use)
- [Examples](#examples)
- [Plan limitations](#plan-limitations)
- [Status](#status)
- [Contributing](#contributing)
- [License](#license)

## Why

Templates only help repositories that do not exist yet. A repository created
from a template never hears from it again, and organisation-wide settings do
not reach `dependabot.yml`, workflows or `CODEOWNERS` — those are per
repository, forever. Past a handful of repositories, keeping them consistent
becomes a tour of identical Settings pages, whether they belong to a company
or to one person with too many side projects.

octoform reconciles what already exists, for either.

## It knows nothing about your stack

There is no npm, Moodle, Terraform or Python anywhere in this codebase. It
understands generic primitives — read a custom property, apply a ruleset to a
set of repositories, ensure a branch exists, seed a file if missing — and
every name, type and rule comes from your configuration.

If you find yourself wanting to add `if (type === 'something')` to the
source, the configuration model is missing something. That is a bug in the
model, not a reason to special-case.

## Install

```bash
npm install --global octoform
```

Requires Node 20 or newer.

## Quick start

```bash
export GITHUB_TOKEN=...      # or GH_TOKEN
octoform audit               # read-only: what deviates from the config
octoform plan                # read-only: what apply would change, and why some of it can't
```

Both commands look for `octoform.yml` in the current directory by default;
point elsewhere with `--config path/to/file.yml`. Neither one changes
anything — `apply` is the only command that does, and it does not exist yet
(see [Status](#status)).

The token needs `repo`. Custom properties and rulesets on an organisation
additionally need `admin:org`; octoform checks up front and tells you which
scope is missing rather than letting the API return a bare 403 later.

## Organisations and personal accounts

`owner` in the configuration names a GitHub login, and octoform asks the API
whether it is an organisation or a personal account — it is not declared,
because getting that wrong quietly would be worse than a redundant lookup.
The practical differences:

| | Organisation | Personal account |
|---|---|---|
| Repository listing | every repo in the org | your own (all of them, via your token) or someone else's (public only, regardless of whose token) |
| Custom properties | available, plan permitting | does not exist — use `classify.rules` or `repos.<name>.type` |
| Organisation-wide rulesets | available on paid plans | not a concept; per-repository rulesets still apply |

Everything else — `plan`, `audit`, the whole configuration model — behaves
identically. See [`examples/personal-account/`](examples/personal-account/)
for a configuration that only ever manages one person's own repositories.

## Configuration

See [`example.yml`](example.yml) for a fully annotated reference, and
[Examples](#examples) below for configurations you can actually run.

### Every setting is tri-state

| Value | Meaning |
|---|---|
| `true` | enforce it on |
| `false` | enforce it off, and correct it if someone turns it on |
| omitted | not managed, leave whatever the repository has |

The difference between `false` and omitting is the whole point. `false` is a
policy; omitting is staying out of the way. Nothing has a default in the
code, so an empty configuration file changes nothing.

### Precedence

Resolved key by key, most general first:

```
defaults  ->  types.<type>  ->  repos.<name>
```

A repository can deviate in one setting without restating the rest. To stop
managing something, narrowest first:

```yaml
repos:
  some-repo:
    merge: { delete_branch_on_merge: null }   # this one setting
    manage: false                             # audit it, apply nothing
exclude:
  repos: [some-repo]                          # drop it entirely
```

### Splitting configuration with imports

A configuration file can pull in others:

```yaml
owner: my-org
imports:
  - presets/npm-library.yml
  - presets/security-baseline.yml
```

- Paths resolve relative to the file that lists them, and an imported file
  can itself import further files — there is no limit to the nesting, other
  than a clear error if two imports form a cycle.
- Imports are listed **most general first**: a later import overrides an
  earlier one, and the importing file's own content overrides every import
  it lists. Same precedence idea as `defaults -> types -> repos`, one level
  up.
- A file meant to be shared — a preset of `types` and `defaults` used by
  several unrelated owners — usually declares no `owner` of its own. Only
  the file you actually run has to. If two files in the same chain declare
  a *different* owner, that is almost certainly a mistake (importing
  somebody else's whole configuration by accident), and octoform refuses to
  guess which one you meant.

See [`examples/shared-presets/`](examples/shared-presets/) for two unrelated
GitHub accounts — one an organisation, one personal — importing the exact
same two preset files.

## Commands

| Command | Effect |
|---|---|
| `octoform audit` | Read-only inventory: every repository, its recorded type, and configurable findings (missing type, missing description or topics on public repositories, too many topics). |
| `octoform plan` | Read-only diff between the configuration and each repository's actual settings — features, merge options, security settings, description and topics today. Anything that cannot be applied — an unimplemented policy, a value this GitHub plan does not expose, a ruleset on a private repository the plan would not enforce — is reported as blocked, with the reason, never dropped in silence. Rulesets, environments and seeded files are part of the configuration model but not yet diffed against the repository's actual state; that lands with `apply`. |

Both accept `--config <path>`; `plan` additionally accepts `--repo <name>` and
`--type <type>` to narrow the scope.

`apply`, which actually changes things, is not implemented yet.

## Programmatic use

The pieces the CLI is built from are exported, for planning a repository from
a script instead of shelling out and parsing text:

```ts
import { loadConfig, createClient, detectOwnerKind, listRepos, getRepoDetail, resolvePolicy, planRepo } from 'octoform';

const config = loadConfig('octoform.yml');
const octokit = createClient();
const kind = await detectOwnerKind(octokit, config.owner);
const [repo] = await listRepos(octokit, config.owner, kind);
const detail = await getRepoDetail(octokit, config.owner, repo);
const changes = planRepo(detail, resolvePolicy(config, repo), { rulesetsEnforcedOnPrivate: true });
```

## Examples

Every example under [`examples/`](examples/) is a complete, valid
configuration for a specific scenario, verified against a real GitHub
account while it was written. `owner` in each one is a placeholder
(`org-name`, `your-username`) rather than a real organisation or person —
deliberately: this project does not publish worked examples against
specific third-party accounts. Swap the placeholder for your own and run it.

| Example | Demonstrates |
|---|---|
| [`minimal/`](examples/minimal/) | The smallest configuration that does anything: one policy, applied org-wide. |
| [`personal-account/`](examples/personal-account/) | Managing one person's own repositories rather than an organisation's. |
| [`shared-presets/`](examples/shared-presets/) | `imports`: the same two preset files reused by an organisation and a personal account that know nothing of each other. |
| [`audit-only/`](examples/audit-only/) | Using octoform purely as a compliance report, with no `types` or `defaults` at all. |
| [`branch-patterns/`](examples/branch-patterns/) | Four unrelated, equally valid ways to target branches with a ruleset — octoform has no opinion on branch naming, and does not prescribe one. |

Run any of them with `octoform plan --config examples/<name>/octoform.yml` (or
the appropriately named file inside `shared-presets/`).

## Plan limitations

Some of what octoform can express is not available on every GitHub plan —
organisation-wide rulesets need a paid plan, and rulesets are only enforced
on private repositories on paid plans, on both organisation and personal
accounts. octoform detects this and **skips those policies with an explicit
message** rather than creating a rule that quietly does nothing. A ruleset
that exists but is not enforced is worse than no ruleset: it looks like
protection.

## Status

Early. `audit` and `plan` work; `apply` is next.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
