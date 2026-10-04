# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

This is an early release. Security fixes land on the latest minor line only.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: go to the repository's **Security** tab → **Report a
vulnerability**. That opens a private advisory visible only to the maintainers.

If private advisories are unavailable to you, open a regular issue that says only
"security report available on request" with no technical detail, and wait for a response.

Please include:

- what an attacker can do, and what they need in order to do it
- the version, and whether it is a packaged build or `npm run dev`
- steps to reproduce, ideally minimal
- the relevant lines in `app.log` if the app wrote any

You can expect an acknowledgement within a few days and an assessment of whether the
report is accepted, duplicated, or out of scope.

## What is in scope

The app handles local credentials and executes commands on your machine, so these are the
areas where a vulnerability would matter most:

- **The credential store.** Provider keys are written one-way and encrypted with the OS
  keychain. Anything that would let another process, or another user account, read them.
- **The permission prompt.** This is the only gate between an agent and a command on your
  machine. Anything that lets a command run without a decision being asked for and
  recorded, or that misreports what was asked.
- **MCP servers.** A configured MCP server is a command the user chose to run. Anything
  that would start a different command than the one displayed, or execute one without the
  stored configuration.
- **Context injection.** The injected bytes are meant to be exactly what the user can
  inspect and hash. Anything that alters them in transit, or that makes the displayed
  content differ from what the agent received.
- **Update checks.** The feed is a remote-code-execution surface. Anything that would
  accept a non-HTTPS feed, or install something other than what the feed described.

## What is out of scope

- Running untrusted code on purpose. UCAD executes agent output and MCP servers by
  design; that is the product, not a vulnerability. Do not point it at a repository or an
  MCP server you do not trust.
- Weaknesses in a model provider's own API.
- Reports that require an attacker to already control the machine or your user account.
- Missing hardening with no demonstrated impact.
