# Configuration reference

Every key `octoform.yml` accepts. Read [concepts.md](concepts.md) first if you
have not — tri-state values and layered precedence are assumed throughout.

The file has no schema version and no required key other than `owner`.
Anything you do not write is not managed.

- [Top level](#top-level)
  - [`owner`](#owner) · [`imports`](#imports) · [`exclude`](#exclude)
  - [`defaults`, `types`, `repos`](#defaults-types-and-repos)
  - [`classify`](#classify) · [`audit`](#audit)
- [Policy blocks](#policy-blocks)
  - [`manage`](#manage) · [`features`](#features) · [`merge`](#merge)
  - [`security`](#security) · [`repo`](#repo)
  - [`default_branch`](#default_branch) · [`ensure_branches`](#ensure_branches)
  - [`rulesets`](#rulesets) · [`environments`](#environments) · [`files`](#files)
- [What is never applied, and why](#what-is-never-applied-and-why)

---

## Top level

### `owner`

**Required. String.** A GitHub organisation or a personal account.

```yaml
owner: your-org
```

Which of the two it is, octoform asks the API — it is never declared here. An
organisation and a user can share a login, and a configuration file is the
wrong place to be wrong about that.

What changes between the two:

| | Organisation | Personal account |
|---|---|---|
| Custom properties | available | **do not exist** — types come from `repos.<name>.type` |
| Which repositories are listed | all the org's | yours only, and private ones only when the token is your own |
| Rulesets on private repositories | needs a paid plan | reported as not enforced (see [`rulesets`](#rulesets)) |

### `imports`

**String array.** Other configuration files to fold in before this one.

```yaml
imports:
  - presets/security-baseline.yml
  - presets/npm-library.yml
```

- Paths are resolved **relative to the file that lists them**, and an imported
  file can import further files.
- **Most general first**: a later import beats an earlier one, and this file's
  own content beats every import.
- Circular imports are detected and reported with the full chain.
- An imported file does not need an `owner` — that is the point. A file with
  `types` and `defaults` and no `owner` is a shared preset, usable by owners
  that know nothing about each other. Two files declaring *different* owners is
  an error.

### `exclude`

```yaml
exclude:
  repos: [scratch, some-fork]
```

Dropped entirely: not audited, not planned, not applied, not counted. For a
repository you want to see but not govern, use
[`manage: false`](#manage) instead.

### `defaults`, `types` and `repos`

The three precedence layers. All three take the same [policy blocks](#policy-blocks).

```yaml
defaults:              # every repository that is not excluded
  features: { wiki: false }

types:                 # by recorded type — the name is yours, it means nothing here
  library:
    environments: [{ name: npm }]

repos:                 # one repository, by name
  the-odd-one:
    features: { wiki: null }
```

`repos.<name>` additionally accepts **`type`**, which declares the repository's
type in the file rather than reading it from the custom property. A type
declared here wins over the property — which is what makes octoform work on a
plan without custom properties, and is the only source available on a personal
account.

A `type` naming something not declared under `types` is an error, caught when
the file loads rather than halfway through a run.

### `classify`

Where a repository's type comes from, and how to infer one for repositories
that have none.

```yaml
classify:
  property: project-type
  rules:
    - when: { file_exists: package.json, json: { private: true } }
      type: application
    - when: { file_exists: package.json }
      type: library
    - when: { visibility: private }
      type: internal
```

| Key | Type | Meaning |
|---|---|---|
| `property` | string | Name of the GitHub **organisation custom property** holding the type. Ignored for a personal account, which has no such API. |
| `rules` | list | Conditions used by [`octoform classify`](commands.md#octoform-classify) to propose a type. Never used to *apply* one during `plan`/`apply`. |

Each rule is `{ when: {...}, type: <name> }`. Inside `when`:

| Condition | Meaning |
|---|---|
| `file_exists: <path>` | The repository has a file at that path. |
| `json: { key: value }` | Shallow match against the JSON file named by `file_exists`. Every listed key must equal the given value. |
| `visibility: public\|private` | The repository's visibility. |

**First match wins**, so order is significant and narrower rules go above
broader ones — `package.json` with `private: true` must be tested before plain
`package.json`, or the second would swallow everything. octoform has no idea
which of your rules is the narrower one; that is why the order is yours.

A rule with an empty `when: {}` matches everything, which is a legitimate way
to write a final catch-all. A file that exists but is not the JSON the rule
expected is simply not a match, not an error.

### `audit`

Read-only expectations. These never change anything; they exist so that "every
public repository needs a description" is a line of configuration instead of a
branch in somebody's code.

```yaml
audit:
  require_type: true
  require_description: { visibility: public }
  require_topics: { visibility: public }
  max_topics: 8
```

| Key | Type | Meaning |
|---|---|---|
| `require_type` | boolean | Report repositories with no recorded type. **Defaults to on** — set it to `false` to disable. The only key here that is on unless you say otherwise. |
| `require_description` | `{ visibility }` | Report repositories of that visibility with no description. |
| `require_topics` | `{ visibility }` | Report repositories of that visibility with no topics. |
| `max_topics` | number | Report repositories with more topics than this. |

`require_description` and `require_topics` need their `visibility` — an empty
`{}` matches nothing at all, because an absent visibility is the tri-state
"not managed" rather than "any". Archived repositories are never reported.

---

## Policy blocks

Everything below can appear in `defaults`, in `types.<type>`, or in
`repos.<name>`.

### `manage`

**Boolean.** `manage: false` means: inventory it, audit it, apply nothing.

Unlike [`exclude`](#exclude), the repository still appears in `audit` output.
Use it for something you have deliberately decided not to govern but still want
to see in the report.

### `features`

| Key | GitHub field | Notes |
|---|---|---|
| `issues` | `has_issues` | |
| `wiki` | `has_wiki` | |
| `projects` | `has_projects` | |
| `discussions` | — | **Never applied.** See [below](#what-is-never-applied-and-why). |

Applied in the repository `PATCH`, bundled with `merge` and `repo`.

### `merge`

| Key | GitHub field |
|---|---|
| `allow_squash` | `allow_squash_merge` |
| `allow_merge_commit` | `allow_merge_commit` |
| `allow_rebase` | `allow_rebase_merge` |
| `allow_auto_merge` | `allow_auto_merge` |
| `allow_update_branch` | `allow_update_branch` |
| `delete_branch_on_merge` | `delete_branch_on_merge` |

`delete_branch_on_merge` is the half of branch hygiene people forget: a
protected branch surrounded by fifty stale merged branches is still a mess.

### `security`

| Key | Endpoint | Notes |
|---|---|---|
| `secret_scanning` | repository `PATCH`, under `security_and_analysis` | |
| `secret_scanning_push_protection` | idem | |
| `vulnerability_alerts` | `PUT`/`DELETE .../vulnerability-alerts` | Dependabot alerts. |
| `automated_security_fixes` | `PUT`/`DELETE .../automated-security-fixes` | Dependabot security updates (the PRs). |
| `private_vulnerability_reporting` | `PUT`/`DELETE .../private-vulnerability-reporting` | |
| `code_scanning_default_setup` | `PATCH .../code-scanning/default-setup` | CodeQL **without** a workflow file in the repository. |

Two caveats worth knowing before you declare these fleet-wide:

**`secret_scanning` and `code_scanning_default_setup` on private repositories
need a paid plan.** Where they are unavailable, GitHub does not report them as
"off" — it omits them, which octoform reports as unreadable and blocks rather
than guessing.

**`code_scanning_default_setup` is incompatible with a `codeql.yml` of your
own.** Enabling the default setup on a repository using advanced setup turns
the advanced one off. If you have per-repository CodeQL workflows, leave this
key out for those repositories rather than setting it `false`.

### `repo`

| Key | Endpoint | Notes |
|---|---|---|
| `description` | repository `PATCH` | |
| `homepage` | repository `PATCH` | |
| `topics` | `PUT .../topics` | Compared as a **set**: order never counts as drift. |
| `allow_forking` | repository `PATCH` | |
| `web_commit_signoff_required` | repository `PATCH` | |

`description`, `homepage` and `topics` are inherently per-repository — they
belong in `repos.<name>`, not in a type. GitHub returns an unset description as
an empty string in some responses and `null` in others; neither counts as drift
against the other.

### `default_branch`

```yaml
default_branch:
  name: main
  rename_from: [master]
```

| Key | Type | Meaning |
|---|---|---|
| `name` | string | What the default branch should be called. |
| `rename_from` | string array | Only rename when the current name is one of these. |

Applied with `POST .../branches/{branch}/rename`.

This is the only change that reaches outside a repository's settings, so it is
gated twice.

**`rename_from` is a safety catch, not a filter.** A repository whose default
branch is not on the list is *reported as blocked*, not renamed — a branch
nobody anticipated is a branch nobody thought about, and renaming it anyway
would be the tool deciding something the configuration declined to decide. Omit
`rename_from` entirely to rename unconditionally.

**Workflows are named as a warning.** GitHub retargets open pull requests and
redirects the old branch name by itself. It does not rewrite a workflow that
names the branch — `on: push: branches: [master]` keeps parsing perfectly and
simply stops matching anything, with no error anywhere. So `plan` reads the
repository's workflow files first and names the ones that will break. It never
edits them; that is yours to do.

A repository with no default branch at all (an empty one) is reported as
blocked rather than failing.

### `ensure_branches`

```yaml
ensure_branches: [main]
```

**String array.** Guarantees the branch exists, created from the current
default branch's tip.

It never deletes a branch, never moves one that already exists, and never
touches contents. Creating it is the entire contract.

### `rulesets`

```yaml
rulesets:
  - name: version-branches
    target_branches: ['v*.x']
    required_approvals: 1
    required_checks: ['CI complete']
    block_force_push: true
    block_deletion: true
```

| Key | Type | Meaning |
|---|---|---|
| `name` | string | Identifies the ruleset. Renaming it creates a second one. |
| `target_branches` | string array | What it applies to. See below. |
| `required_approvals` | number | Approving reviews needed to merge. |
| `required_checks` | string array | Status checks that must pass. |
| `block_force_push` | boolean | Refuses force-pushes (`non_fast_forward`). |
| `block_deletion` | boolean | Refuses branch deletion. |

**`target_branches`** accepts a literal name (`main`), a glob (`v*.x`), or
GitHub's own placeholders — `~DEFAULT_BRANCH`, which follows a rename, and
`~ALL`. Plain names are turned into refs (`refs/heads/main`) at the API
boundary; you write branch names, not refs.

**`required_approvals: 0` is meaningful and different from omitting it.** Zero
still creates the pull-request rule, so the branch stops accepting direct
pushes and every change has to arrive as a pull request — it just does not
require anyone to approve it. That is the right setting for a
single-maintainer repository, where GitHub will not let you approve your own
pull request and `1` would lock the only person who can merge out of merging.

**Only what you declare is compared.** A ruleset carrying rules octoform does
not model is not "different" — treating it as such would make every run offer
to strip whatever somebody configured by hand. A ruleset that exists and is
*not* declared here is left completely alone; octoform never deletes one.

`enforcement` is always `active` and `target` is always `branch`. Neither is
configurable, on purpose: a ruleset in evaluate mode reads like protection that
is not there.

**Private repositories.** Rulesets are only enforced on private repositories on
paid plans. Where they would not be enforced, octoform reports them as blocked
instead of creating one, because a ruleset that exists but does nothing is
worse than no ruleset at all. For a **personal account** this is currently
assumed rather than probed, so a personal Pro account may see its private
repositories reported as unenforceable when they are not — verifying it
properly would mean creating a real ruleset to see whether it holds, which is
too invasive for a read-only command.

### `environments`

```yaml
environments:
  - name: npm
    reviewers: [some-user, another-user]
```

| Key | Type | Meaning |
|---|---|---|
| `name` | string | The environment name. |
| `reviewers` | string array | GitHub **logins** that must approve a deployment. |

Applied with `PUT .../environments/{name}`. Logins are resolved to numeric ids,
which is what the endpoint wants; a login that does not resolve fails the whole
change rather than quietly creating an environment with fewer reviewers than
you asked for.

**Known limitation:** only *missing* environments are created. An environment
that already exists is left alone, so a change to its `reviewers` is not
currently detected or applied.

### `files`

```yaml
files:
  - path: .github/dependabot.yml
    from: files/dependabot/npm.yml
    mode: create-if-missing
```

| Key | Type | Meaning |
|---|---|---|
| `path` | string | Where it goes in the repository. |
| `from` | string | Local file to copy. Resolved **relative to the configuration file that declares it**. |
| `mode` | `create-if-missing` | The only mode. |

`from` resolving against its own file is what lets a shared preset be imported
from anywhere without its file references breaking — the same rule
[`imports`](#imports) follows.

**`create-if-missing` is the only mode, deliberately.** Seeding what is absent
is safe; overwriting whatever a repository already has at that path is the
fastest way to destroy work nobody asked this tool to touch. The write is sent
without a blob `sha`, which means GitHub *refuses* it if the file appeared
between `plan` and `apply` — failing there is the correct answer, not
overwriting.

This exists mostly for the files GitHub does **not** inherit from a `.github`
repository: `dependabot.yml`, workflows and `CODEOWNERS`. `SECURITY.md`,
`CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` do inherit, and seeding a local copy
of one would silently stop that inheritance.

---

## What is never applied, and why

| Policy | Reason |
|---|---|
| `features.discussions` | GitHub has no REST field for it anywhere — `repos/update` does not accept `has_discussions` and there is no dedicated endpoint. It is GraphQL-only. Reported as blocked rather than attempted. |
| Anything on an **archived** repository | Archived repositories are read-only on GitHub's side. Reporting changes that can never be applied would be noise on every run. |
| Environment `reviewers`, when the environment already exists | Not implemented yet. See [`environments`](#environments). |
| Rulesets on private repositories without an enforcing plan | They would exist without being enforced. See [`rulesets`](#rulesets). |
| Any setting whose current value could not be read | Planning a change from an answer you never got is how a tool reports drift that does not exist. See [concepts.md](concepts.md#3-blocked-is-not-skipped). |
