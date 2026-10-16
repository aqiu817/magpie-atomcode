import { test } from "node:test";
import assert from "node:assert/strict";

import { claimCodingPlan, fetchModels, planNeedsClaim, planOf, planTier } from "../codingplan.mjs";

test("planTier：Max/Pro 判定与 Lite 兜底（含「体验版」写法）", () => {
  assert.equal(planTier("CodingPlan Max"), "Max");
  assert.equal(planTier("MAX 旗舰"), "Max");
  assert.equal(planTier("CodingPlan Pro"), "Pro");
  assert.equal(planTier("CodingPlan Lite-体验版"), "Lite");
  assert.equal(planTier("Lite-beta"), "Lite");
  assert.equal(planTier(undefined), "Lite");
});

test("planOf：codingplan_free 优先，plan 兜底，缺失/非对象 → null", () => {
  assert.deepEqual(planOf({ codingplan_free: { plan_name: "x" } }), { plan_name: "x" });
  assert.deepEqual(planOf({ plan: { plan_name: "y" } }), { plan_name: "y" });
  assert.equal(planOf({}), null);
  assert.equal(planOf(null), null);
});

/** 按调用次序回放响应的小工具，多余调用复用最后一个响应。 */
function sequenceFetch(responses) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    const next = responses[Math.min(seen.length - 1, responses.length - 1)];
    return new Response(next.body, { status: next.status ?? 200 });
  };
  return { fetchImpl, seen };
}

test("claim：第一档 success 即停，请求形状正确", async () => {
  const { fetchImpl, seen } = sequenceFetch([
    { body: JSON.stringify({ success: true, message: "ok", plan_name: "CodingPlan Max", plan_type: "Max" }) },
  ]);
  const r = await claimCodingPlan("https://gitcode.example", "tok", { fetchImpl, clientVersion: "5.2.3" });
  assert.equal(r.claimed, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.tier, "Max");
  assert.equal(r.planName, "CodingPlan Max");
  assert.equal(r.attempts.length, 1);
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0].url).pathname, "/coding-plan/claim-v2");
  assert.equal(JSON.parse(seen[0].init.body).plan_type, "Max");
  assert.equal(seen[0].init.headers.authorization, "Bearer tok");
  assert.equal(seen[0].init.headers["user-agent"], "atomcode/5.2.3");
});

test("claim：Max/Pro 失败 → Lite duplicate 停；错误响应体的 message 不丢", async () => {
  const { fetchImpl } = sequenceFetch([
    { status: 400, body: JSON.stringify({ success: false, message: "无可用计划" }) },
    { status: 400, body: JSON.stringify({ success: false, message: "无可用计划" }) },
    { body: JSON.stringify({ success: false, duplicate: true, plan_type: "Lite" }) },
  ]);
  const r = await claimCodingPlan("https://gitcode.example", "tok", { fetchImpl, clientVersion: "5.2.3" });
  assert.equal(r.claimed, true);
  assert.equal(r.duplicate, true);
  assert.equal(r.tier, "Lite");
  assert.equal(r.attempts.length, 3);
  assert.equal(r.attempts[0].message, "无可用计划");
});

test("claim：三档都失败 → claimed false 且不抛出", async () => {
  const { fetchImpl } = sequenceFetch([
    { status: 400, body: JSON.stringify({ success: false, message: "a" }) },
    { status: 400, body: JSON.stringify({ success: false, message: "b" }) },
    { status: 400, body: JSON.stringify({ success: false, message: "c" }) },
  ]);
  const r = await claimCodingPlan("https://gitcode.example", "tok", { fetchImpl, clientVersion: "5.2.3" });
  assert.equal(r.claimed, false);
  assert.equal(r.duplicate, false);
  assert.equal(r.message, "c");
});

test("planNeedsClaim：缺失/空名 → 需要领取", () => {
  assert.equal(planNeedsClaim({}), true);
  assert.equal(planNeedsClaim(null), true);
  assert.equal(planNeedsClaim({ codingplan_free: { plan_name: " " } }), true);
});

test("planNeedsClaim：套餐有效（无日期字段也保守放行）→ false", () => {
  assert.equal(planNeedsClaim({ codingplan_free: { plan_name: "CodingPlan Lite-体验版" } }), false);
  assert.equal(
    planNeedsClaim({ codingplan_free: { plan_name: "Lite", remaining_days: 4, expires_at: "2099-01-01" } }),
    false,
  );
});

test("planNeedsClaim：remaining_days ≤ 0 → 需要重领", () => {
  assert.equal(
    planNeedsClaim({ codingplan_free: { plan_name: "Lite", remaining_days: 0, expires_at: "2099-01-01" } }),
    true,
  );
  assert.equal(
    planNeedsClaim({ codingplan_free: { plan_name: "Lite", remaining_days: -2, expires_at: "2099-01-01" } }),
    true,
  );
});

test("planNeedsClaim：expires_at 过期超 24h → 需要重领；24h 宽限内 → false", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  assert.equal(
    planNeedsClaim({ codingplan_free: { plan_name: "Lite", expires_at: "2026-10-14T00:00:00Z" } }, now),
    true,
  );
  assert.equal(
    planNeedsClaim({ codingplan_free: { plan_name: "Lite", expires_at: "2026-10-16T00:00:00Z" } }, now),
    false,
  );
  assert.equal(
    planNeedsClaim({ codingplan_free: { plan_name: "Lite", expires_at: "2099-01-01T00:00:00Z" } }, now),
    false,
  );
});

test("claim：网络异常只记 attempt，绝不抛出", async () => {
  const r = await claimCodingPlan("https://gitcode.example", "tok", {
    fetchImpl: async () => {
      throw new Error("boom");
    },
    clientVersion: "5.2.3",
  });
  assert.equal(r.claimed, false);
  assert.equal(r.attempts.length, 3);
  assert.match(r.message, /boom/);
});

test("fetchModels：plan_type 编码进 query，过滤空名/不可用/弃用行", async () => {
  const good = { display_model_name: "ok/model", context_window: 100, plan_available: true };
  const { fetchImpl, seen } = sequenceFetch([
    {
      body: JSON.stringify([
        good,
        { display_model_name: " " },
        { display_model_name: "hidden", plan_available: false },
        { display_model_name: "old", status: "deprecated" },
      ]),
    },
  ]);
  const rows = await fetchModels("https://gitcode.example", "tok", "Lite/dark", {
    fetchImpl,
    clientVersion: "5.2.3",
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], good);
  const u = new URL(seen[0].url);
  assert.equal(u.pathname, "/coding-plan/models-v2");
  assert.equal(u.searchParams.get("plan_type"), "Lite/dark");
  assert.equal(seen[0].init.headers.authorization, "Bearer tok");
});

test("fetchModels：非数组响应抛错", async () => {
  const { fetchImpl } = sequenceFetch([{ body: JSON.stringify({ nope: 1 }) }]);
  await assert.rejects(
    () => fetchModels("https://x", "t", "Lite", { fetchImpl, clientVersion: "5.2.3" }),
    /did not return a list/,
  );
});

test("CodingPlan 401/403 标记 signIn expired", async () => {
  const { fetchImpl } = sequenceFetch([{ status: 401, body: "{}" }]);
  const error = await fetchModels("https://x", "t", "Lite", { fetchImpl, clientVersion: "5.2.3" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(error);
  assert.equal(error.signIn, "expired");
});
