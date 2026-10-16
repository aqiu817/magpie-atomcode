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

- **Browser OAuth sign-in**: one authorization completes sign-in + plan claim (the official `/login` semantics); multiple accounts supported, tokens kept by magpie and renewed automatically (magpie ≥ 0.1.684; older hosts fall back to inline renewal).
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

## Development

```bash
npm test        # node --test, 27 cases (also runs under bun test)
```

Sandbox verification (never touches your real magpie):

```bash
SB=$(mktemp -d)
sb() { env HOME="$SB" USERPROFILE="$SB" XDG_CONFIG_HOME="$SB/.config" XDG_CACHE_HOME="$SB/.cache" \
  MAGPIE_ADDR=127.0.0.1:3499 MAGPIE_PLUGIN_MARKET=off magpie "$@"; }
sb plugin add "C:\path\to\magpie-atomcode"
sb provider test atomcode
sb quota
```

The same code works as an OpenCode plugin (v1 shape); magpie-only hooks (`auth.usage`, `auth.refresh`, `auth.checkin`) are ignored by OpenCode.

## Disclaimer

Unofficial, not affiliated with or endorsed by AtomGit / AtomCode. Upstream protocols may change at any time; usage you choose may breach terms of service and risks account restriction or bans — Atom2Api carries the same warning. See [NOTICE.md](NOTICE.md) for attribution.
