# Concepts

Three ideas. The reference reads as arbitrary until these are in place, and
almost every surprising behaviour in octoform follows from one of them.

## 1. Every setting is tri-state

A setting is not on or off. It is on, off, or **none of your business**.

| Value | Meaning | What `plan` does |
|---|---|---|
| `true` | it must be on | turns it on if it is off |
| `false` | it must be off | turns it off if it is on |
| omitted | not managed | ignores it entirely, whatever it is |
| `null` | stop managing it | same as omitted, but cancels an inherited value |

The distinction that matters is `false` versus omitting. `false` is a policy:
*keep this off, and correct it if somebody turns it on*. Omitting is staying
out of the way: *decide this per repository, from the GitHub UI, and I will
never touch it*.

Without that distinction a reconciler is unusable, because it spends its life
fighting settings that somebody set by hand on purpose. With it, you can
manage four settings out of forty and genuinely leave the other thirty-six
alone.

The consequence worth stating: **no value has a default in the code**. An empty
configuration file changes nothing, and there is a test that says so. If
octoform is about to change something, it is because your file asked for it.

`null` exists for one job — cancelling something a wider layer already said.
See precedence, below.

## 2. Precedence: widest to narrowest, key by key

```
defaults  →  types.<type>  →  repos.<name>
```

Resolved **key by key**, not layer by layer. A repository can disagree with its
type about one setting without restating the other twenty.

```yaml
defaults:
  merge: { allow_squash: true, delete_branch_on_merge: true }

types:
  library:
    merge: { allow_rebase: false }        # adds to, does not replace, the above

repos:
  the-odd-one:
    merge: { delete_branch_on_merge: null }   # cancels just this one
```

`the-odd-one` ends up with `allow_squash: true`, `allow_rebase: false`, and
`delete_branch_on_merge` unmanaged.

**Lists replace, they do not accumulate.** `rulesets`, `environments`, `files`
and `ensure_branches` are whole values: a repository declaring `rulesets:`
replaces its type's rulesets rather than adding to them. This is what lets a
repository opt out of a ruleset its type declares — with merging there would be
no way to say "not that one".

### Three escape hatches, narrowest to widest

| Hatch | Effect |
|---|---|
| `repos.<name>.<key>: null` | stop managing that one setting, in that one repository |
| `repos.<name>.manage: false` | inventory and audit it, apply nothing |
| `exclude.repos: [...]` | drop it entirely, including from audits |

`manage: false` and `exclude` are not the same thing. An excluded repository
does not appear in reports at all; a `manage: false` one still shows up in
`audit`, which is usually what you want for something you have decided not to
govern but still want to see.

## 3. Blocked is not skipped

Everything octoform cannot do is reported, with the reason. Nothing is dropped
in silence — a tool that quietly does less than you asked for is worse than one
that fails, because you find out months later, from the consequences.

Three shapes of "not done":

**Blocked** — it cannot happen, and `apply` will not attempt it. A policy with
no REST endpoint, a value this GitHub plan does not expose, a ruleset the
current owner plan and token cannot manage on a private repository, a current
value that could not be read at all.

```
  my-repo
    features.discussions: false -> true   [skipped: not applicable over the REST API]
```

**Warned** — it will happen, and something else breaks as a result. Renaming a
default branch that workflow files name by hand is the case this exists for.

```
  my-repo
    default_branch.name: master -> main   [warning: .github/workflows/ci.yml names "master" and will stop triggering until updated]
```

**Unreadable** — GitHub would not tell us the current value. This is
deliberately not the same as "off": planning a change from an answer you never
got is how a tool ends up turning things on that were already on, or reporting
drift that does not exist. It is reported as blocked.

```
  my-repo
    security.secret_scanning: (unreadable) -> true   [skipped: current value could not be read, probably not available on this plan]
```

## What follows from all three

`plan` is read-only, always, and `apply` computes its diff by calling `plan` —
not by recomputing it. So `apply` can never do something `octoform plan` did
not just tell you it would do. That is the whole design in one sentence.
