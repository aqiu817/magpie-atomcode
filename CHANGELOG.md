# Changelog

All notable changes to this project will be documented here.

## Unreleased

### Added

- Regression coverage for the Atom2Api signing fixture, OAuth flows, quota mapping, i18n parity, token refresh, usage caching, and model-key collisions.
- CI for Node 20/22/24, Bun, coverage thresholds, package dry-runs, and import smoke tests.
- Security, contribution, issue-reporting, and pull-request guidance.

### Changed

- Version discovery now refreshes in the background and never delays the first request.
- Plan claiming cascades across tiers only for entitlement-shaped failures; network, auth, rate-limit, and 5xx responses fail once.
- Sign-in completion no longer waits for the automatic CodingPlan claim.
- All rate-limit windows are mapped into quota output instead of only the first one.
- Model URLs now use the exact origin accepted by the signed-request loader.

### Fixed

- OAuth and CodingPlan metadata bodies are bounded while streaming and cross-origin redirects are refused.
- Broker-supplied login URLs are restricted to AtomGit.
- English check-in messages no longer contain Chinese punctuation.
