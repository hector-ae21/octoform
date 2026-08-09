# octoform

Declarative governance for GitHub repositories. Describe how your repositories
should be configured in one YAML file; `octoform` reports the drift and, when
you tell it to, corrects it.

It is `plan` / `apply` for repository settings, branch rules, environments and
the handful of files GitHub does not inherit from your `.github` repository.

## Why

Templates only help repositories that do not exist yet. A repository created
from a template never hears from it again, and organisation-wide settings do
not reach `dependabot.yml`, workflows or `CODEOWNERS` — those are per
repository, forever. Past a handful of repositories, keeping them consistent
becomes a tour of identical Settings pages.

`octoform` reconciles what already exists.

## It knows nothing about your stack

There is no npm, Moodle, Terraform or Python anywhere in this codebase. It
understands generic primitives — read a custom property, apply a ruleset to a
set of repositories, ensure a branch exists, seed a file if missing — and every
name, type and rule comes from your configuration.

If you find yourself wanting to add `if (type === 'something')` to the source,
the configuration model is missing something. That is a bug in the model, not a
reason to special-case.

## Install

```bash
npm install --global octoform
```

Requires Node 20 or newer.

## Use

```bash
export GITHUB_TOKEN=...      # or GH_TOKEN
octoform audit               # read-only: what deviates from the config
```

`audit` never changes anything. Run it first.

The token needs `repo`. Custom properties and rulesets additionally need
`admin:org`; `octoform` checks up front and tells you which scope is missing
rather than letting the API return a bare 403 later.

## Configuration

See [example.yml](example.yml) for a commented configuration. The two ideas
worth knowing before reading it:

**Every setting is tri-state.**

| Value | Meaning |
|---|---|
| `true` | enforce it on |
| `false` | enforce it off, and correct it if someone turns it on |
| omitted | not managed, leave whatever the repository has |

The difference between `false` and omitting is the whole point. `false` is a
policy; omitting is staying out of the way. Nothing has a default in the code,
so an empty configuration file changes nothing.

**Precedence is `defaults` -> `types.<type>` -> `repos.<name>`**, resolved key
by key, so a repository can deviate in one setting without restating the rest.
To stop managing something, narrowest first:

```yaml
repos:
  some-repo:
    merge: { delete_branch_on_merge: null }   # this one setting
    manage: false                             # audit it, apply nothing
exclude:
  repos: [some-repo]                          # drop it entirely
```

## Your configuration file is not example.yml

A real configuration names your repositories, including private ones.
`octoform.yml` is gitignored here on purpose. Keep yours wherever you keep
infrastructure configuration, and point at it with `--config`.

## Plan limitations

Some of what `octoform` can express is not available on every GitHub plan —
organisation-wide rulesets need a paid plan, and rulesets are only enforced on
private repositories on paid plans. `octoform` detects this and **skips those
policies with an explicit message** rather than creating a rule that quietly
does nothing. A ruleset that exists but is not enforced is worse than no
ruleset: it looks like protection.

## Status

Early. `audit` works; `classify`, `plan` and `apply` are next.

## License

MIT
