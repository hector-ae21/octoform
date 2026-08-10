# Commands

```
octoform audit      [--config <path>]
octoform plan       [--config <path>] [--repo <name>] [--type <type>]
octoform apply      [--config <path>] [--repo <name>] [--type <type>] [--yes]
octoform classify   [--config <path>] [--apply]
octoform properties sync [--config <path>]
```

**Three of these cannot change anything**: `audit`, `plan`, and `classify`
without `--apply`. That is worth knowing before you point this at a fleet.

| Command | Reads | Writes |
|---|---|---|
| `audit` | repositories, custom properties | nothing |
| `plan` | everything the configuration asks about | nothing |
| `apply` | same as `plan` | repository settings, rulesets, environments, branches, files |
| `classify` | repositories, named files inside them | the custom property, **only** with `--apply` |
| `properties sync` | the property schema and its values | the property schema and its values |

## Options

| Option | Applies to | Meaning |
|---|---|---|
| `--config <path>` | all | Configuration file. Default `octoform.yml` in the working directory. |
| `--repo <name>` | `plan`, `apply` | Limit to one repository. |
| `--type <type>` | `plan`, `apply` | Limit to repositories of one type. |
| `--yes` | `apply` | Skip the confirmation prompt. For a script — not for a first run. |
| `--apply` | `classify` | Record the proposals instead of only printing them. |
| `--help` | all | Usage. |

---

## `octoform audit`

An inventory and a list of findings. Every repository, its recorded type, its
visibility, and whatever deviates from the [`audit`](configuration.md#audit)
expectations.

```
Organisation: your-org (free plan)
Organisation-wide rulesets are not available on this plan. Branch rules are
applied per repository instead.

REPO                TYPE            VISIBILITY
some-library        npm-package     public
some-service        service         private

Excluded (2): scratch, some-fork

2 finding(s):
  some-library      no topics
  some-service      no description
```

Findings are information, not failure: **`audit` exits 0 even when it finds
things.** It reports, it does not gate. A scheduled run that should fail on
drift can check the output itself — see
[this repository's own audit workflow](../.github/workflows/audit.yml) for the
pattern, which deliberately never calls `apply`.

## `octoform plan`

The diff between what the configuration declares and what each repository
actually has. Read-only, always. This is the default thing to run.

```
3 change(s) across 2 repositories:

  some-library
    features.wiki: true -> false
    rulesets.version-branches: (unset) -> v*.x; 1 approval(s); checks: CI complete; no force-push; no deletion

  some-service
    security.vulnerability_alerts: false -> true

1 not applied:

  some-service
    features.discussions: false -> true  [skipped: not applicable over the REST API]

Nothing was changed. This command only reports.
```

Anything that cannot be applied appears in the second list with its reason,
never dropped in silence. See
[blocked is not skipped](concepts.md#3-blocked-is-not-skipped).

## `octoform apply`

Shows the same diff `plan` would, asks, then calls the GitHub API.

It computes that diff **by calling `plan`**, not by recomputing it, so `apply`
can never do something `octoform plan` did not just tell you it would do.

```
3 change(s) to apply:
  ...
(1 more are blocked and will not be attempted — see 'octoform plan')

Apply 3 change(s)? [y/N] y

  some-library  features.wiki: done
  some-library  rulesets.version-branches: done
  some-service  security.vulnerability_alerts: FAILED — 403: Resource not accessible

1 change(s) failed — see above.
```

Two things about how it fails:

**Changes are grouped by the endpoint they actually belong to.** Everything
that fits in the repository `PATCH` body — features, merge options, description,
homepage, and the two `security_and_analysis` toggles — goes in a single
request. Enabling five such settings costs one API call, not five.

**A group succeeds or fails together.** If that one `PATCH` fails, every change
bundled into it is reported as failed with the same reason, because none of
them happened. A failure in one endpoint never stops the others from being
attempted.

The default branch is renamed before anything that could name a branch, so a
ruleset or a seeded file lands against the name the configuration declares.

## `octoform classify`

Proposes a type for each repository that has none, using
[`classify.rules`](configuration.md#classify).

```
3 proposal(s):

  some-library      library
  some-service      application
  some-tooling      internal

1 matched no rule and are left alone: mystery-repo

Nothing was changed. Re-run with --apply to record these.
```

**A repository that already has a type is never re-examined.** This fills in
what is missing; it does not argue with a decision somebody already made,
including one made by hand against the rules.

`--apply` records the proposals in the custom property, one API call per
distinct type rather than per repository. That needs an organisation and a
`classify.property`; on a personal account there is nowhere to write it, and
the command says so and exits 1 rather than pretending. Copy them into the
configuration as `repos.<name>.type` instead.

## `octoform properties sync`

Creates or updates the custom property that stores the type, and records the
values declared under `repos.<name>.type`.

**The property's allowed values are the keys of `types`.** They are not
declared separately, and deliberately: asking for the same list twice only
creates somewhere for the two answers to differ, and the one that would
silently win is the one GitHub stores, not the one your file shows.

It writes only what differs, so running it twice is a no-op. Organisations
only — custom properties do not exist for a personal account.

Run this **before** `classify --apply` on a fresh organisation: the property
has to exist before anything can be written to it.

---

## Authentication

The token comes from `GITHUB_TOKEN` or `GH_TOKEN`.

| Scope | Needed for |
|---|---|
| `repo` | everything |
| `admin:org` | `properties sync`, and `classify --apply` |

Rulesets need admin on the repository, which owning it gives you.

A missing scope fails immediately with a message naming it and the `gh auth
refresh` line that fixes it — rather than with a bare 403 from whichever call
happened to need it first, which is the single most common way to get stuck
setting this up.

Fine-grained tokens do not report their scopes at all. octoform treats that
absence as unknown rather than as missing, so it does not refuse to run on a
token that is perfectly fine.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. For `audit`, this includes "found things" — findings are not failure. |
| `1` | Something failed: a change could not be applied, `apply` was declined at the prompt, the configuration is invalid, a scope is missing, or the API returned an error. |
| `2` | The command line itself was wrong — unknown command or option, missing value. |

## Programmatic use

The pieces the CLI is built from are exported, for planning a repository from a
script instead of shelling out and parsing text. See
[the README](../README.md#programmatic-use).
