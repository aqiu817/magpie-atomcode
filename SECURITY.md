# Security Policy

## Reporting a vulnerability

Do not open a public issue for a credential leak, request-routing bypass, signature flaw, or other exploitable behavior.

Use GitHub's private **Security advisories** flow for this repository:

https://github.com/aqiu817/magpie-atomcode/security/advisories/new

Include the affected version, a minimal reproduction, impact, and any suggested mitigation. Remove access tokens, refresh tokens, OAuth state values, account identifiers, and personal paths from logs and screenshots.

## Supported versions

Security fixes target the latest published `0.1.x` release and the current `main` branch. Older commits and local forks are not supported.

## Security boundaries

- Upstream tokens are stored by magpie and are never written or logged by this plugin.
- Signed model traffic is restricted to the official gateway origin; redirects are refused.
- Configurable OAuth and CodingPlan endpoints must use HTTPS on the official AtomGit/GitCode domain families.
- Upstream model URLs are accepted only when their origin matches the signed gateway.
- OAuth login redirects are restricted to AtomGit and metadata responses are size-bounded.
