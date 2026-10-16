import { test } from "node:test";
import assert from "node:assert/strict";

import { AtomCodePlugin } from "../index.mjs";

/**
 * checkin 钩子的四条路径。
 *
 * 插件的 CodingPlan 调用走全局 fetch（与 sensenova 模板同款测试法），
 * 所以这里 stub globalThis.fetch 按 URL 分流：status-v2 / claim-v2 /
 * raw.atomgit.com（版本探测）各自给脚本。
 */

/** status-v2 的有效套餐响应（登录态健康、无需重领）。 */
const VALID_STATUS = {
  codingplan_free: {
    plan_name: "CodingPlan Lite-体验版",
    plan_type: "Lite-beta",
    status: 1,
    remaining_days: 4,
    expires_at: "2099-10-20",
  },
  current_usage: { usage_percent: 0, window_hours: 5, seconds_until_reset: 1000 },
  rate_limit_windows: [{ window_size_seconds: 18000, call_limit: 200, calls_used: 0, seconds_until_reset: 1000 }],
};

const MANIFEST = '[workspace.package]\nversion = "5.2.3"\nedition = "2021"\n';

/**
 * 安装一个按 URL 分流的全局 fetch stub，返回 { calls, restore }。
 * claimResponses 是逐次出队的 {status?, body}；statusBody 为 null 时 status-v2 回 500。
 */
function stubFetch({ statusBody, claimResponses = [] }) {
  const calls = [];
  const claimQueue = [...claimResponses];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === "string" ? input : input.url);
    calls.push({ url, method: init.method ?? "GET" });
    if (url.includes("raw.atomgit.com")) return new Response(MANIFEST, { status: 200 });
    if (url.includes("status-v2")) {
      return new Response(statusBody === null ? "boom" : JSON.stringify(statusBody), {
        status: statusBody === null ? 500 : 200,
      });
    }
    if (url.includes("claim-v2")) {
      const next = claimQueue.shift() ?? { status: 400, body: JSON.stringify({ success: false, message: "no" }) };
      return new Response(next.body, { status: next.status ?? 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

const AUTH = { type: "oauth", access: "tok", uid: "u1" };

async function checkinWith(setup, getAuth = async () => AUTH) {
  const stub = stubFetch(setup);
  try {
    const plugin = await AtomCodePlugin({}, {});
    return { result: await plugin.auth.checkin(getAuth), calls: stub.calls };
  } finally {
    stub.restore();
  }
}

test("checkin：套餐仍有效 → done，不打领取接口", async () => {
  const { result, calls } = await checkinWith({ statusBody: VALID_STATUS });
  assert.equal(result.outcome, "done");
  assert.match(result.message, /Lite/);
  assert.equal(calls.filter((c) => c.url.includes("claim-v2")).length, 0, "有效期内不应打领取接口");
});

test("checkin：套餐过期 → 重领成功 → claimed，带套餐名", async () => {
  const expired = {
    ...VALID_STATUS,
    codingplan_free: { ...VALID_STATUS.codingplan_free, remaining_days: 0, expires_at: "2020-01-01" },
  };
  const { result } = await checkinWith({
    statusBody: expired,
    claimResponses: [
      { body: JSON.stringify({ success: true, duplicate: false, plan_name: "CodingPlan Lite-体验版", plan_type: "Lite" }) },
    ],
  });
  assert.equal(result.outcome, "claimed");
  assert.match(result.message, /CodingPlan Lite-体验版/);
});

test("checkin：duplicate（本来就持有）→ done 而不是 claimed", async () => {
  const expired = {
    ...VALID_STATUS,
    codingplan_free: { ...VALID_STATUS.codingplan_free, remaining_days: 0, expires_at: "2020-01-01" },
  };
  const { result } = await checkinWith({
    statusBody: expired,
    claimResponses: [{ body: JSON.stringify({ success: false, duplicate: true, plan_type: "Lite" }) }],
  });
  assert.equal(result.outcome, "done");
});

test("checkin：上游拒绝（日限额已满）→ failed，透出上游 message", async () => {
  const expired = {
    ...VALID_STATUS,
    codingplan_free: { ...VALID_STATUS.codingplan_free, remaining_days: 0, expires_at: "2020-01-01" },
  };
  const full = { status: 400, body: JSON.stringify({ success: false, message: "全平台日限额已满" }) };
  const { result } = await checkinWith({
    statusBody: expired,
    claimResponses: [full, full, full],
  });
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /日限额|no tier/);
});

test("checkin：未登录 → failed 提示登录，CodingPlan 请求一个都不发", async () => {
  // 插件构造时的版本探测会先打一次 raw.atomgit.com（正常），这里只看 CodingPlan。
  const { result, calls } = await checkinWith({ statusBody: VALID_STATUS }, async () => undefined);
  assert.equal(result.outcome, "failed");
  assert.equal(calls.filter((c) => c.url.includes("gitcode") || c.url.includes("coding-plan")).length, 0);
});

test("checkin：status 500（网络/服务异常）→ 仍尝试领取，由领取结果说话", async () => {
  const { result } = await checkinWith({
    statusBody: null,
    claimResponses: [{ body: JSON.stringify({ success: true, duplicate: false, plan_name: "CodingPlan Lite" }) }],
  });
  assert.equal(result.outcome, "claimed");
});
