import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BASE_URL,
  normalizeCodingPlanModel,
  toProviderModel,
  trustedModelBaseURL,
} from "../models.mjs";

/**
 * `base_url` 来自上游 `models-v2`（服务端可控数据）。这些用例钉住白名单：
 * 只有 https、无内嵌凭证、且落在 atomgit 域上的地址才被采纳，其余一律回退
 * 官方网关——否则上游响应就能决定这个账号的 bearer token 发往哪里。
 */

test("trustedModelBaseURL：只采纳 loader 实际允许的网关 origin", () => {
  assert.equal(trustedModelBaseURL("https://llm-api.atomgit.com/v1"), "https://llm-api.atomgit.com/v1");
  assert.equal(trustedModelBaseURL("https://raw.atomgit.com/x"), undefined);
  assert.equal(trustedModelBaseURL("https://atomgit.com"), undefined);
  assert.equal(trustedModelBaseURL("https://llm-api.atomgit.com:8443/v1"), undefined);
  assert.equal(trustedModelBaseURL("  https://llm-api.atomgit.com/v1  "), "https://llm-api.atomgit.com/v1");
});

test("trustedModelBaseURL：域名不在白名单 → 拒绝", () => {
  assert.equal(trustedModelBaseURL("https://evil.example/v1"), undefined);
  assert.equal(trustedModelBaseURL("https://evil-atomgit.com/v1"), undefined, "相近域名不得蒙混过关");
  assert.equal(
    trustedModelBaseURL("https://llm-api.atomgit.com.evil.example/v1"),
    undefined,
    "把白名单域名当前缀同样不行",
  );
});

test("trustedModelBaseURL：明文降级与内嵌凭证 → 拒绝", () => {
  assert.equal(trustedModelBaseURL("http://llm-api.atomgit.com/v1"), undefined);
  assert.equal(trustedModelBaseURL("https://user:pass@llm-api.atomgit.com/v1"), undefined);
});

test("trustedModelBaseURL：非 URL 与非法类型 → 拒绝", () => {
  assert.equal(trustedModelBaseURL("not a url"), undefined);
  assert.equal(trustedModelBaseURL(""), undefined);
  assert.equal(trustedModelBaseURL("   "), undefined);
  assert.equal(trustedModelBaseURL(undefined), undefined);
  assert.equal(trustedModelBaseURL(null), undefined);
  assert.equal(trustedModelBaseURL(42), undefined);
  assert.equal(trustedModelBaseURL({}), undefined);
});

test("normalizeCodingPlanModel：非法 base_url 被丢弃并上报原始值", () => {
  const rejected = [];
  const model = normalizeCodingPlanModel(
    { display_model_name: "m1", base_url: "https://evil.example/v1" },
    { onReject: (value) => rejected.push(value) },
  );
  assert.equal(model.baseURL, undefined, "非法地址不得进入模型描述");
  assert.deepEqual(rejected, ["https://evil.example/v1"]);
});

test("normalizeCodingPlanModel：合法 base_url 原样保留，且不触发上报", () => {
  let rejected = 0;
  const model = normalizeCodingPlanModel(
    { display_model_name: "m1", base_url: "https://llm-api.atomgit.com/v1" },
    {
      onReject: () => {
        rejected += 1;
      },
    },
  );
  assert.equal(model.baseURL, "https://llm-api.atomgit.com/v1");
  assert.equal(rejected, 0);
});

test("normalizeCodingPlanModel：没有 base_url 时静默，不当作被拒", () => {
  let rejected = 0;
  const model = normalizeCodingPlanModel(
    { display_model_name: "m1" },
    {
      onReject: () => {
        rejected += 1;
      },
    },
  );
  assert.equal(model.baseURL, undefined);
  assert.equal(rejected, 0);
});

test("normalizeCodingPlanModel：上报回调自己抛错也不影响模型", () => {
  const model = normalizeCodingPlanModel(
    { display_model_name: "m1", base_url: "https://evil.example/v1" },
    {
      onReject: () => {
        throw new Error("logger exploded");
      },
    },
  );
  assert.equal(model.id, "m1");
  assert.equal(model.baseURL, undefined);
});

test("toProviderModel：模型没有可用 base_url 时落到调用方给的官方网关", () => {
  const model = normalizeCodingPlanModel({ display_model_name: "m1", base_url: "https://evil.example" });
  const providerModel = toProviderModel(model, "atomcode", { baseURL: DEFAULT_BASE_URL });
  assert.equal(providerModel.api.url, DEFAULT_BASE_URL);
  assert.equal(providerModel.api.id, "m1");
});
