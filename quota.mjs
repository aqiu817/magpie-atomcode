/**
 * CodingPlan status → Magpie `auth.usage` mapping.
 *
 * The plan's own fields supply `plan` (套餐名) and `until` (到期时间); the first
 * `rate_limit_windows` entry supplies the one window this platform really has
 * (the rolling 5-hour call window). `auth.usage` percentages may legitimately
 * exceed 100 when the quota is exhausted — Magpie renders that natively.
 *
 * Mapping is a pure function so the shape contract can be tested offline
 * against the real response captured in the plan document (§5.4).
 *
 * @module magpie-atomcode/quota
 */

import { planOf } from "./codingplan.mjs";
import { fill } from "./i18n.mjs";

/** Number if finite (0 included), else undefined. */
export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Used-percentage fallback when the API does not hand one over. */
function pctOf(used, limit) {
  if (!num(limit)) return undefined;
  return ((num(used) ?? 0) / num(limit)) * 100;
}

/**
 * Build the `auth.usage` payload from a `status-v2` response.
 *
 * @param {object} status - parsed `status-v2`.
 * @param {object} t - the i18n table for labels.
 * @param {{user?: string}} [context] - the account's display name for the row.
 * @returns {{plan?: string, user?: string, until?: string, windows: object[]}}
 */
export function quotaFromStatus(status, t, { user } = {}) {
  const plan = planOf(status) ?? {};
  const usage = status?.current_usage ?? {};
  const windows = [];

  const raw = Array.isArray(status?.rate_limit_windows) ? status.rate_limit_windows.find((w) => w && typeof w === "object") : null;
  if (raw) {
    const limit = num(raw.call_limit);
    const span = num(raw.window_size_seconds) ?? (num(raw.window_hours) ?? 5) * 3600;
    const hours = num(raw.window_hours) ?? Math.round(span / 3600) ?? 5;
    windows.push({
      name: fill(t.windowHours, { hours }),
      used: num(usage.usage_percent) ?? pctOf(raw.calls_used, raw.call_limit) ?? 0,
      span,
      amount: num(raw.calls_used) ?? 0,
      unit: "calls",
      ...(limit ? { limit, display: fill(t.callsOf, { used: num(raw.calls_used) ?? 0, total: limit }) } : {}),
      ...(num(raw.seconds_until_reset) !== undefined
        ? { resetSecs: num(raw.seconds_until_reset) }
        : usage.reset_at
          ? { resetsAt: usage.reset_at }
          : {}),
    });
  } else if (num(usage.usage_percent) !== undefined || num(usage.window_token_limit) !== undefined) {
    // No window row (older shape?): fall back to the current_usage block.
    const hours = num(usage.window_hours) ?? 5;
    windows.push({
      name: fill(t.windowHours, { hours }),
      used: num(usage.usage_percent) ?? 0,
      span: hours * 3600,
      unit: "calls",
      ...(num(usage.seconds_until_reset) !== undefined
        ? { resetSecs: num(usage.seconds_until_reset) }
        : usage.reset_at
          ? { resetsAt: usage.reset_at }
          : {}),
    });
  }

  return {
    ...(plan.plan_name ? { plan: plan.plan_name } : { plan: t.planFallback }),
    ...(user ? { user } : {}),
    ...(plan.expires_at ? { until: plan.expires_at } : {}),
    windows,
  };
}
