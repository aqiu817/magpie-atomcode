# magpie-atomcode

[中文](README.zh-CN.md) | English

An (unofficial) provider plugin for [magpie](https://usemagpie.ai) that brings **ATOMCODE (AtomGit CodingPlan)** in.

After a browser sign-in with your AtomGit account, the CodingPlan models appear in magpie as the **ATOMCODE** provider. Any agent — Claude Code, Codex, OpenCode — can use `atomcode/<model>`. The plan, the daily check-in and the rolling 5-hour window show up on the account row, in `magpie quota`, and in settings.

```
Agent (Claude Code / Codex / OpenCode / …)
   │ any API
   ▼
magpie gateway ──► magpie-atomcode (adds atomcode-signing-v1 headers + UA)
   ▼
https://llm-api.atomgit.com/v1 (OpenAI-compatible, SSE streams back untouched)
```

## Features

- **Browser OAuth sign-in**: one authorization completes sign-in and starts the official `/login` plan claim in the background; multiple accounts are supported, and tokens are kept by magpie and renewed automatically (magpie ≥ 0.1.684; older hosts fall back to inline renewal).
- **Direct to AtomGit**: no Atom2Api instance needed; streaming, tool calls and reasoning efforts all work (verified live in M3).
- **Daily check-in (`checkin`)**: scheduled by magpie's native check-in toggle. Plan valid → done; expired/missing → the official Max→Pro→Lite cascade re-claims it; quota exhausted → failed with the upstream reason.
- **Quota window**: plan name, expiry and the 5-hour call-count window on the account row and in `magpie quota`, updating live.
- **Auto version tracking**: follows the AtomCode repo's current version by default (the official client force-updates); falls back to the built-in anchor, never blocking a request.
- **Live model catalog**: each account pulls its own (varies by plan/tier), with a built-in snapshot as the offline fallback.

## Current models (snapshot 2026-10-16)

| Model | Context | Reasoning efforts | Vision |
|---|---|---|---|
| `qwen3.8-27b` | 256K | low / medium / xhigh | ✓ |
| `glm5.3-flash` | 500K | low / high | ✓ |

The catalog varies per account and plan — the live list wins after sign-in.

## Install

```bash
magpie plugin add C:\path\to\magpie-atomcode     # folder, loaded in place
magpie plugin add magpie-atomcode                # npm, once published
```

In the app: Plugins → Add plugin → point at this folder.

## Sign in & check-in

```bash
magpie plugin login atomcode   # the browser handles AtomGit authorization
```

- Check-in: the toggle in magpie's plugin settings ("has the ATOMCODE plugin sign in every signed-in account, daily"). Even when off, an expired plan is re-claimed automatically while reading quota/catalog (30-min cooldown).
- Plan quotas: Lite 1000/day; Pro trial 100/day released at 10:00. When the daily pool is out, the check-in fails with the upstream message — try again tomorrow.

## Options (`options` in `plugins.json`; all have defaults)

| Option | Default | Meaning |
|---|---|---|
| `locale` | auto | `zh` / `en` |
| `autoVersion` | `true` | follow the AtomCode repo's current version automatically |
| `clientVersion` | `5.2.3` | fallback version anchor (used when `autoVersion` is off or the fetch fails) |
| `autoClaim` | `true` | idempotent claim after sign-in + automatic re-claim on expiry |
| `masterKeyHex` | built-in | escape hatch when upstream rotates its signing key |
| `platformBaseURL` | `https://acs.atomgit.com` | OAuth broker |
| `codingPlanAPIURL` | `https://api.gitcode.com/api/v5` | CodingPlan REST |
| `quotaTtlMs` | `60000` | quota cache |
| `maxOutputTokens` | `32768` | default model output ceiling |

## Security boundaries

All of these are enforced in code, and `npm test` covers each one:

- **The gateway is the only destination.** `loader.fetch` compares the request's origin against `https://llm-api.atomgit.com`; anything else is refused with an error *before* a credential or signature header is attached. `origin` includes the scheme, so an `http://` downgrade is refused too.
- **Upstream cannot move the destination.** A model row's `base_url` is honoured only when its origin exactly matches the signed gateway; otherwise that model falls back to the official gateway and the plugin logs that it did.
- **Endpoint options are allowlisted.** `platformBaseURL` and `codingPlanAPIURL` must be https on `atomgit.com` or `gitcode.com`; anything else falls back to the official endpoint with a warning. A tampered `plugins.json` therefore cannot reroute your bearer or refresh token.
- **Bounded reads and redirects.** Version, OAuth and CodingPlan response bodies are capped at 1 MiB *while* streaming; every metadata call has a timeout and refuses redirects. A broker-supplied login URL must also stay on AtomGit.

Credentials live in magpie's own store (`plugin-auth.json`): this plugin never writes, never logs and never prints them, and only ever sends them to the two official endpoint families above.

### What runs by default

Both defaults are on out of the box, and both act without being asked:

| Default | What it actually does | Turn off with |
|---|---|---|
| `autoClaim: true` | Starts the CodingPlan `claim-v2` after sign-in and retries the idempotent claim when the plan has expired. After sign-in it runs in the background. | `magpie plugin options atomcode '{"autoClaim":false}'` |
| `autoVersion: true` | Refreshes the version manifest from `raw.atomgit.com` in the background (12 h cache). Requests immediately use the current cached version, including the built-in fallback. | `magpie plugin options atomcode '{"autoVersion":false}'` |

## Troubleshooting

For a 401 during sign-in or provider testing:

1. Run `magpie version` and note the failure stage: OAuth callback, model catalog, quota, or chat request.
2. Try `atomcode login` with the official AtomCode client using the same account. If that also returns 401, the account is likely refused upstream rather than by this plugin.
3. Open a bug report with redacted logs. Never include access tokens, refresh tokens, OAuth state, `plugin-auth.json`, email addresses, account IDs, or unredacted home-directory paths.

Security issues should follow [SECURITY.md](SECURITY.md). Development and review expectations are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
npm test                    # node --test, 85 cases
npm run test:coverage       # built-in Node coverage report
npm run pack:check          # verify the published tarball contents
```

CI runs the suite on Node 20, 22 and 24 plus Bun, enforces coverage thresholds, and smoke-tests the npm package.

Sandbox verification (never touches your real magpie):

```bash
SB=$(mktemp -d)
PLUGIN_ROOT="$(pwd)"
sb() { env HOME="$SB" USERPROFILE="$SB" XDG_CONFIG_HOME="$SB/.config" XDG_CACHE_HOME="$SB/.cache" \
  MAGPIE_ADDR=127.0.0.1:3499 MAGPIE_PLUGIN_MARKET=off magpie "$@"; }
sb plugin add "$PLUGIN_ROOT"
sb provider test atomcode
sb quota
```

The same code works as an OpenCode plugin (v1 shape); magpie-only hooks (`auth.usage`, `auth.refresh`, `auth.checkin`) are ignored by OpenCode.

## Disclaimer

Unofficial, not affiliated with or endorsed by AtomGit / AtomCode. Upstream protocols may change at any time; usage you choose may breach terms of service and risks account restriction or bans — Atom2Api carries the same warning. See [NOTICE.md](NOTICE.md) for attribution.
