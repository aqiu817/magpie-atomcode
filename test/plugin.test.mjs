import { test } from "node:test";
import assert from "node:assert/strict";

import * as entry from "../index.mjs";
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

/** broker 回的登录地址，带 force_login（插件应把它摘掉）。 */
const LOGIN_URL = "https://atomgit.com/login?force_login=true";

/**
 * 安装一个按 URL 分流的全局 fetch stub，返回 { calls, restore }。
 * claimResponses 是逐次出队的 {status?, body}；statusBody 为 null 时 status-v2 回 500；
 * modelsBody 为 null 时 models-v2 回空列表。calls 里带上 headers，便于断言凭证去向。
 */
function stubFetch({
  statusBody,
  statusStatus,
  claimResponses = [],
  modelsBody = null,
  modelsStatus = 200,
  refreshResponses = [],
}) {
  const calls = [];
  const claimQueue = [...claimResponses];
  const refreshQueue = [...refreshResponses];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === "string" ? input : input.url);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push({ url, method: init.method ?? "GET", headers, redirect: init.redirect });
    if (url.includes("raw.atomgit.com")) return new Response(MANIFEST, { status: 200 });
    if (url.includes("status-v2")) {
      const status = statusStatus ?? (statusBody === null ? 500 : 200);
      return new Response(statusBody === null ? "boom" : JSON.stringify(statusBody), {
        status,
      });
    }
    if (url.includes("models-v2")) {
      return new Response(modelsBody === null ? "[]" : JSON.stringify(modelsBody), { status: modelsStatus });
    }
    if (url.includes("oauth/refresh")) {
      const next = refreshQueue.shift() ?? { status: 500, body: "{}" };
      return new Response(next.body, { status: next.status ?? 200 });
    }
    if (url.includes("auth/login")) {
      return new Response(JSON.stringify({ login_url: LOGIN_URL, state: "state-1" }), { status: 200 });
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

test("entry exports only the plugin function for OpenCode compatibility", () => {
  assert.deepEqual(Object.keys(entry), ["AtomCodePlugin"]);
});

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

test("checkin：英文 locale 的套餐名使用英文括号", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { locale: "en", autoVersion: false });
    const result = await plugin.auth.checkin(async () => AUTH);
    assert.equal(result.message, "The plan is still active; nothing to claim (CodingPlan Lite-体验版)");
    assert.doesNotMatch(result.message, /（/);
  } finally {
    stub.restore();
  }
});

test("config：seed 模型、用户覆盖和 provider 元数据正确合并", async () => {
  const plugin = await AtomCodePlugin({}, { autoVersion: false });
  const cfg = {
    provider: {
      atomcode: {
        models: { custom: { name: "Custom" } },
        maxConcurrency: 2,
      },
    },
  };
  await plugin.config(cfg);

  assert.equal(cfg.provider.atomcode.name, "ATOMCODE");
  assert.equal(cfg.provider.atomcode.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider.atomcode.api, GATEWAY);
  assert.ok(cfg.provider.atomcode.models["qwen3.8-27b"]);
  assert.deepEqual(cfg.provider.atomcode.models.custom, { name: "Custom" });
  assert.equal(cfg.provider.atomcode.maxConcurrency, 2);
});

/** 网关根地址（与 internal.mjs 的 DEFAULT_GATEWAY_BASE_URL 一致）。 */
const GATEWAY = "https://llm-api.atomgit.com/v1";

test("provider.models：上游给的自定义 base_url 不在白名单 → 退回官方网关", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    modelsBody: [
      { display_model_name: "qwen3.8-27b", context_window: 262144, base_url: "https://evil.example/v1" },
      { display_model_name: "glm5.3-flash", context_window: 512000, base_url: "https://raw.atomgit.com/v1" },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { locale: "en", autoVersion: false });
    const models = await plugin.provider.models({}, { auth: AUTH });
    assert.equal(models["qwen3.8-27b"].api.url, GATEWAY, "非法地址必须被换成官方网关");
    assert.equal(models["glm5.3-flash"].api.url, GATEWAY, "其他 atomgit 子域也必须退回网关");
  } finally {
    stub.restore();
  }
});

test("provider.models：sanitize 后 key 冲突时保留两个模型", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    modelsBody: [
      { display_model_name: "model/a", context_window: 1000 },
      { display_model_name: "model_a", context_window: 2000 },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const models = await plugin.provider.models({}, { auth: AUTH });
    assert.equal(models["model_a"].api.id, "model/a");
    assert.equal(models["model_a_2"].api.id, "model_a");
    assert.equal(models["model_a_2"].limit.context, 2000);
  } finally {
    stub.restore();
  }
});

test("provider.models：目录读取失败时返回带 fallback 标记的内置列表", async () => {
  const stub = stubFetch({ statusBody: null });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const models = await plugin.provider.models({}, { auth: AUTH });
    assert.equal(models[Symbol.for("magpie.fellBack")], true);
    assert.ok(models["qwen3.8-27b"]);
  } finally {
    stub.restore();
  }
});

test("provider.models：401 让账号进入重新登录状态", async () => {
  const stub = stubFetch({ statusBody: { error: "expired" }, statusStatus: 401 });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    await assert.rejects(
      () => plugin.provider.models({}, { auth: AUTH }),
      (error) => error.signIn === "expired",
    );
  } finally {
    stub.restore();
  }
});

test("loader：发往网关的请求照常带凭证与签名", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => AUTH);
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m" }) });
    const call = stub.calls.find((c) => c.url.includes("chat/completions"));
    assert.ok(call, "官方网关的请求应当发出");
    assert.equal(call.headers.get("authorization"), "Bearer tok");
    assert.match(call.headers.get("x-atomcode-sig") ?? "", /^v1:[0-9a-f]{64}$/);
    assert.equal(call.headers.get("user-agent"), "atomcode/5.2.3");
    assert.equal(call.redirect, "error");
  } finally {
    stub.restore();
  }
});

test("loader：非网关目标的请求被拦下，一个请求都不发出", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => AUTH);
    await assert.rejects(
      () => patched("https://evil.example/v1/chat/completions", { method: "POST", body: "{}" }),
      (error) => error instanceof Error && /evil\.example/.test(error.message),
    );
    assert.equal(stub.calls.filter((c) => c.url.includes("evil.example")).length, 0, "凭证不得离开网关");
  } finally {
    stub.restore();
  }
});

test("loader：同域名的 http 明文地址同样被拦下", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => AUTH);
    await assert.rejects(
      () => patched("http://llm-api.atomgit.com/v1/chat/completions", { method: "POST", body: "{}" }),
      (error) => error instanceof Error && /llm-api\.atomgit\.com/.test(error.message),
    );
    assert.equal(stub.calls.filter((c) => c.url.startsWith("http://")).length, 0, "明文请求不得发出");
  } finally {
    stub.restore();
  }
});

test("loader：没有登录时移除传入的 authorization 再请求网关", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => undefined);
    await patched(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer caller-token" },
      body: "{}",
    });
    const call = stub.calls.find((c) => c.url.includes("chat/completions"));
    assert.equal(call.headers.get("authorization"), null);
  } finally {
    stub.restore();
  }
});

test("loader：过期 token 单次刷新后持久化并签名新 token", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }),
      },
    ],
  });
  const saved = [];
  try {
    const plugin = await AtomCodePlugin(
      { client: { auth: { set: async (payload) => saved.push(payload) } } },
      { autoVersion: false },
    );
    const expired = { ...AUTH, refresh: "old-refresh", expires: Date.now() - 1 };
    const { fetch: patched } = await plugin.auth.loader(async () => expired);
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: "{}" });

    const call = stub.calls.find((c) => c.url.includes("chat/completions"));
    assert.equal(call.headers.get("authorization"), "Bearer fresh-access");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].body.access, "fresh-access");
    assert.equal(saved[0].body.refresh, "fresh-refresh");
  } finally {
    stub.restore();
  }
});

test("auth.refresh：刷新成功返回新凭证，失败透出 expired", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      },
      { status: 401, body: "{}" },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const next = await plugin.auth.refresh({ ...AUTH, refresh: "old-refresh", expires: Date.now() - 1 });
    assert.equal(next.access, "new-access");
    assert.equal(next.refresh, "new-refresh");
    assert.ok(next.expires > Date.now());

    await assert.rejects(
      () => plugin.auth.refresh({ ...AUTH, refresh: "dead-refresh" }),
      (error) => error.signIn === "expired",
    );
  } finally {
    stub.restore();
  }
});

test("usage：成功结果按账号缓存，未登录不请求上游", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { locale: "en", autoVersion: false });
    const first = await plugin.auth.usage(async () => AUTH);
    const second = await plugin.auth.usage(async () => AUTH);
    assert.equal(first.plan, "CodingPlan Lite-体验版");
    assert.equal(first.windows.length, 1);
    assert.deepEqual(second, first);
    assert.equal(stub.calls.filter((c) => c.url.includes("status-v2")).length, 1);

    const noAccount = await plugin.auth.usage(async () => undefined);
    assert.equal(noAccount.error, "No signed-in AtomCode account");
  } finally {
    stub.restore();
  }
});

test("options：非白名单的 platformBaseURL 被拒，回退官方 broker", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false, platformBaseURL: "https://evil.example" });
    const started = await plugin.auth.methods[0].authorize();
    assert.equal(stub.calls.filter((c) => c.url.includes("evil.example")).length, 0, "授权请求不得打到非白名单地址");
    assert.ok(
      stub.calls.some((c) => c.url.startsWith("https://acs.atomgit.com/")),
      "应改用官方 broker",
    );
    assert.equal(started.url, "https://atomgit.com/login");
  } finally {
    stub.restore();
  }
});

test("options：http 或非白名单的 codingPlanAPIURL 被拒，回退官方端点", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false, codingPlanAPIURL: "http://evil.example" });
    await plugin.auth.checkin(async () => AUTH);
    assert.equal(stub.calls.filter((c) => c.url.includes("evil.example")).length, 0, "额度请求不得打到非白名单地址");
    assert.ok(
      stub.calls.some((c) => c.url.startsWith("https://api.gitcode.com/")),
      "应改用官方端点",
    );
  } finally {
    stub.restore();
  }
});

test("options：白名单内的合法覆盖被采纳（上游迁移时的逃生口）", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false, codingPlanAPIURL: "https://api.gitcode.com/api/v6" });
    await plugin.auth.checkin(async () => AUTH);
    assert.ok(
      stub.calls.some((c) => c.url.startsWith("https://api.gitcode.com/api/v6/")),
      "合法覆盖应当生效",
    );
  } finally {
    stub.restore();
  }
});

test("options：非法数值、版本号和布尔值回退默认并告警", async () => {
  const logs = [];
  const plugin = await AtomCodePlugin(
    {
      client: {
        app: {
          log: ({ body }) => logs.push(body.message),
        },
      },
    },
    {
      autoVersion: false,
      autoClaim: "false",
      clientVersion: "5.2.3\r\nInjected",
      masterKeyHex: "not-a-key",
      quotaTtlMs: Infinity,
      maxOutputTokens: -1,
    },
  );

  assert.equal(plugin.auth.refreshLead, 5 * 60 * 1000);
  for (const name of [
    "autoClaim",
    "clientVersion",
    "masterKeyHex",
    "quotaTtlMs",
    "maxOutputTokens",
  ]) {
    assert.ok(logs.some((line) => line.includes(name)), `missing warning for ${name}`);
  }
});
