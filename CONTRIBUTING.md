# Contributing to octoform

Thanks for taking the time to contribute.

## The one rule about the codebase

octoform must never know about a specific ecosystem, platform or convention.
If a contribution needs an `if (type === 'moodle-plugin')` or anything of the
shape `if (somethingSpecificToOneStack)`, that is a sign the configuration
model is missing a way to express what you need — fix the model, not the
code path.

A useful test: could someone using octoform for, say, a fleet of WordPress
plugin repositories adopt your change without reading its source? If the
answer depends on octoform recognising WordPress, the change is in the wrong
place.

This is not a style preference. It is the reason a personal project and an
organisation's fleet can both run the same binary with nothing but a
different YAML file, and it is the property most worth protecting here.

## Setting up

```bash
git clone https://github.com/hector-ae21/octoform.git
cd octoform
npm install
npm run build      # compiles src/ to dist/
npm test           # compiles src/ + test/ separately, then runs them
npm run typecheck  # type-checks without emitting
```

Node 20 or newer.

## Running the CLI locally

Create a local `octoform.yml` for an owner you control. Do not commit tokens,
private repository names, or account-specific policy data.

```bash
export GITHUB_TOKEN=...
npm run octoform -- audit --config octoform.yml
```

(`npm run octoform --` forwards arguments to `node bin/octoform.js`, which
runs against `dist/`, so `npm run build` first if you have not already.)

## Project layout

```
src/
  config/     the configuration model: types, loading, imports, precedence
  github/     the Octokit client — the only place that calls the GitHub API
  core/       the diff engine (plan), pure logic, no I/O
  commands/   what the CLI commands do, composed from the above
  report/     turning a list of changes into readable output
  cli.ts      argument parsing and dispatch
  index.ts    the programmatic entry point
test/         mirrors src/, one level up — see below
reference/    generated and reviewed machine-readable project artifacts
```

Tests live in `test/`, not next to the source files. `src/` is what gets
published; test files have no business shipping inside it.

## Source documentation policy

Authored comments in `src/`, `bin/`, and `scripts/` must be valid TSDoc blocks
written as `/** ... */`. Use them to document a declaration's public contract,
parameters, results, errors, or constraints. Put behavioral evidence in tests
and customer guidance or architectural rationale in the versioned
[documentation repository](https://github.com/hector-ae21/octoform-docs).

Line comments, ordinary block comments, disabled code, narration, TODO prose,
and references to private planning material are rejected automatically. The
allowlist for compiler, linter, and instrumentation comment directives is
currently empty. A shebang is executable syntax rather than a comment and is
the only non-TSDoc marker present in shipped code.

## Making a change

1. Branch as `type/short-description` — `feat/`, `fix/`, `docs/`, `refactor/`,
   `test/`, `chore/`, `ci/`.
2. Commit with [Conventional Commits](https://www.conventionalcommits.org):
   a type, an optional scope, an imperative summary, and a body that explains
   *why* when it is not obvious from the diff.
3. Add or update tests. `core/` and `config/` are pure functions with no
   network calls — most new behaviour belongs there and should be tested
   there, not by hitting the real API.
4. Changes to customer-facing documentation and validated examples belong in
   [octoform-docs](https://github.com/hector-ae21/octoform-docs). Run every
   example against an account you control, then replace owners and repository
   names with placeholders before proposing it. Changes to behavior must update
   the application and documentation in coordinated pull requests.
5. Update [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]` if the change is
   visible to a user of the CLI or the library.
6. Open a pull request against the highest `vMAJOR.x` branch — `v0.x` today,
   which is also the default branch, so the pre-filled base is already the
   right one. There is no `develop`. An older `vMAJOR.x` branch takes
   security fixes only; see [SECURITY.md](.github/SECURITY.md) for what that
   scheme means.

## Reporting a security issue

See [SECURITY.md](.github/SECURITY.md) — please do not open a public issue
for a vulnerability.

## Code of conduct

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).
