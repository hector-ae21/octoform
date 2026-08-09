# octoform documentation

Three documents, and the split is deliberate: what you can write, what you can
run, and how to reason about the two together.

| Document | Answers |
|---|---|
| [configuration.md](configuration.md) | Every key you can put in `octoform.yml`, what it does, what it maps to on GitHub, and what happens when it cannot be applied. |
| [commands.md](commands.md) | Every command and flag, what each one is allowed to change, its exit code, and the token it needs. |
| [concepts.md](concepts.md) | The three ideas the rest depends on: tri-state settings, layered precedence, and why a plan that cannot do something says so instead of skipping it. |

Start with [concepts.md](concepts.md) if you are new to this — the reference
reads as arbitrary until those three are in place. Start with
[configuration.md](configuration.md) if you already have a file and want to
know what a particular key does.

## The shortest possible introduction

You describe how your repositories should be configured in one YAML file.
`octoform plan` tells you where reality differs. `octoform apply` fixes it,
after showing you the same list and asking.

```yaml
owner: your-account

defaults:
  features:
    wiki: false
  security:
    vulnerability_alerts: true
```

```bash
export GITHUB_TOKEN=...
octoform plan     # read-only, always
octoform apply    # shows the same diff, asks, then acts
```

Nothing in the tool knows what npm, Moodle or WordPress are. Every fact about
your stack lives in your file — see
[the one rule about the codebase](../CONTRIBUTING.md#the-one-rule-about-the-codebase).

## Worked examples

[`examples/`](../examples/) has complete, runnable configurations for specific
situations: a minimal one, a personal account, shared presets across owners,
audit-only, four ways to target branches, and the audit configuration this
repository runs against itself.
