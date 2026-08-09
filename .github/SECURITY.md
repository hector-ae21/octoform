# Security Policy

## Supported versions

octoform is pre-1.0. Only the latest published version is supported; there
are no maintained older lines yet. That changes once 1.0 ships and the
project adopts version branches per major release, the same scheme
`types.npm-package` in the example configuration describes.

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
itself, nor a configuration file you write and run — a `octoform.yml` that
grants a token more access than it should is a token-scoping mistake, not a
vulnerability in octoform.
