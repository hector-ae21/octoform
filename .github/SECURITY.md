# Security Policy

## Supported versions

octoform keeps one branch per living major version, named `vMAJOR.x` —
starting from `v0.x`, which is the default branch today and where every
change lands. `v1.x`, `v2.x` and so on get their own branches as the API
evolves. The highest major is always the default branch and receives
features and fixes; the previous major receives **security fixes only**,
never features, and is published on its own when needed. Two majors back
leaves support once the current one is stable: its `vMAJOR.x` branch is
deleted, and `npm deprecate` points whoever is still on it at the current
release.

**A missing `vMAJOR.x` branch is the signal that a major is unsupported.**
There is no separate list here to fall out of date — if the branch for a
major is gone, that major is done:

| Signal | Meaning |
|---|---|
| `vMAJOR.x` branch exists, is the default branch | current major — features and fixes |
| `vMAJOR.x` branch exists, is not the default | previous major — security fixes only |
| `vMAJOR.x` branch does not exist | unsupported — `npm deprecate` points elsewhere |

Being pre-1.0 does not change the scheme, only how often the first number
moves: while octoform is `0.x`, a breaking change bumps the **middle**
number, because that is what semver says a zero major means. The branch
layout, the dist-tags and everything below already work the way they will
after 1.0.

What each position in the version number means:

| Position | Name | Bumped when |
|---|---|---|
| First — `X`.y.z | major | a breaking change ships (while pre-1.0, this stays `0`) |
| Middle — x.`Y`.z | minor | a backward-compatible feature ships — or, pre-1.0, a breaking change |
| Last — x.y.`Z` | patch | a bug or **security** fix ships |

**A security fix is always a patch bump**, never a major or minor one —
precisely so it can land on an old, otherwise-frozen major without dragging
in unrelated features.

The `latest` dist-tag always points at the highest semver published, not at
whatever was published most recently, so a security backport to an older
major never pulls `latest` backwards. Any major that is not the highest gets
its own `vNx` dist-tag instead (no dot — `v0x`, not `v0.x`, since npm's own
argument parser would otherwise read a dotted tag as a semver range and
never look at dist-tags at all), so `npm install @hector21/octoform@v0x`
keeps resolving to that major's newest patch independent of what the current
major does.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting: go to this repository's
**Security** tab and select **Report a vulnerability**. This opens a private
draft advisory that only the maintainer can see.

If you would rather not use GitHub, email <hectorlazaroarrechea@gmail.com>
with:

- The version of octoform affected.
- Steps to reproduce, or a proof of concept.
- What you think the impact is.

## What to expect

- Acknowledgement within a few days.
- This is a one-person open source project, not a company with a dedicated
  security team — please allow reasonable time for a fix before disclosing
  publicly.

## Scope

This covers the code in this repository. It does not cover the GitHub API
itself, nor a configuration file you write and run — an `octoform.yml` that
grants a token more access than it should is a token-scoping mistake, not a
vulnerability in octoform.

Worth being explicit about, since this is a tool that mutates repository
settings: octoform only ever performs the changes its own `plan` output
describes, and `apply` is the only command that writes anything. If you find
a way to make `apply` mutate something `plan` did not show, or to make any
other command write at all, that is a vulnerability under this policy —
report it.
