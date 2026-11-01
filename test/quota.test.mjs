import { test } from "node:test";
import assert from "node:assert/strict";

import { strings } from "../i18n.mjs";
import { quotaFromStatus } from "../quota.mjs";

const t = strings("en");

test("quotaFromStatus maps every rate-limit window", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: {
        plan_name: "CodingPlan Pro",
        expires_at: "2026-12-01",
      },
      current_usage: {
        usage_percent: 99,
        reset_at: "2026-11-01T10:00:00Z",
      },
      rate_limit_windows: [
        {
          window_hours: 5,
          call_limit: 200,
          calls_used: 50,
          usage_percent: 25,
          seconds_until_reset: 1200,
        },
        {
          window_size_seconds: 86400,
          call_limit: 1000,
          calls_used: 250,
          usage_percent: 25,
        },
      ],
    },
    t,
    { user: "alice" },
  );

  assert.equal(usage.plan, "CodingPlan Pro");
  assert.equal(usage.user, "alice");
  assert.equal(usage.until, "2026-12-01");
  assert.equal(usage.windows.length, 2);
  assert.deepEqual(usage.windows[0], {
    name: "5h window",
    used: 25,
    span: 18000,
    amount: 50,
    unit: "calls",
    limit: 200,
    display: "50 / 200 calls",
    resetSecs: 1200,
  });
  assert.equal(usage.windows[1].name, "24h window");
  assert.equal(usage.windows[1].display, "250 / 1000 calls");
});

test("quotaFromStatus falls back to current_usage when no window rows exist", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: { plan_name: "CodingPlan Lite" },
      current_usage: {
        usage_percent: 120,
        window_hours: 3,
        seconds_until_reset: 60,
      },
    },
    t,
  );
  assert.deepEqual(usage.windows, [
    {
      name: "3h window",
      used: 120,
      span: 10800,
      unit: "calls",
      resetSecs: 60,
    },
  ]);
});

test("quotaFromStatus returns a stable empty shape for malformed status", () => {
  assert.deepEqual(quotaFromStatus(null, t), {
    plan: "AtomCode CodingPlan",
    windows: [],
  });
});
