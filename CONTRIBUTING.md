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

```bash
export GITHUB_TOKEN=...
npm run octoform -- audit --config example.yml
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
examples/     valid configurations for specific scenarios, owner names redacted
```

Tests live in `test/`, not next to the source files. `src/` is what gets
published; test files have no business shipping inside it.

## Making a change

1. Branch as `type/short-description` — `feat/`, `fix/`, `docs/`, `refactor/`,
   `test/`, `chore/`, `ci/`.
2. Commit with [Conventional Commits](https://www.conventionalcommits.org):
   a type, an optional scope, an imperative summary, and a body that explains
   *why* when it is not obvious from the diff.
3. Add or update tests. `core/` and `config/` are pure functions with no
   network calls — most new behaviour belongs there and should be tested
   there, not by hitting the real API.
4. If your example claims a configuration works, run it — against your own
   account or organisation while you write it — before committing it; a
   plausible-looking YAML snippet that was never actually executed does not
   belong under `examples/`. Once it works, replace `owner` and any
   repository names with a placeholder (`org-name`, `your-username`,
   `library-a`, ...) before committing: this project does not publish
   worked examples against real, specific third-party GitHub accounts.
5. Update [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]` if the change is
   visible to a user of the CLI or the library.
6. Open a pull request against `main`.

## Reporting a security issue

See [SECURITY.md](.github/SECURITY.md) — please do not open a public issue
for a vulnerability.

## Code of conduct

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).
