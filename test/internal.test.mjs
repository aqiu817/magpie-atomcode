import { test } from "node:test";
import assert from "node:assert/strict";

import {
  credentialsOf,
  originOf,
  readCappedResponseText,
  trustedServiceURL,
  trustedURL,
} from "../internal.mjs";

/**
 * 这两个校验函数是"地址不许乱跑"的统一收口点：模型地址、端点配置、请求目标
 * 都走同一套判定。用例钉住它的边界，改动时不会悄悄放宽。
 */

test("trustedURL：https + 白名单域名（含子域）被采纳", () => {
  const domains = ["atomgit.com", "gitcode.com"];
  assert.equal(trustedURL("https://llm-api.atomgit.com/v1", { domains }), "https://llm-api.atomgit.com/v1");
  assert.equal(trustedURL("https://api.gitcode.com/api/v5", { domains }), "https://api.gitcode.com/api/v5");
  assert.equal(trustedURL("https://atomgit.com", { domains }), "https://atomgit.com");
  assert.equal(trustedURL("  https://acs.atomgit.com  ", { domains }), "https://acs.atomgit.com");
});

test("trustedURL：明文、内嵌凭证、相近域名、非法输入一律拒绝", () => {
  const domains = ["atomgit.com", "gitcode.com"];
  assert.equal(trustedURL("http://acs.atomgit.com", { domains }), undefined);
  assert.equal(trustedURL("https://user:pass@acs.atomgit.com", { domains }), undefined);
  assert.equal(trustedURL("https://evil.example", { domains }), undefined);
  assert.equal(trustedURL("https://evil-atomgit.com", { domains }), undefined);
  assert.equal(trustedURL("https://acs.atomgit.com.evil.example", { domains }), undefined);
  assert.equal(trustedURL("", { domains }), undefined);
  assert.equal(trustedURL(undefined, { domains }), undefined);
  assert.equal(trustedURL(123, { domains }), undefined);
  assert.equal(trustedURL("https://acs.atomgit.com", {}), undefined, "没有白名单时不得放行");
});

test("trustedURL：基础端点默认拒绝 query/hash，登录跳转可显式放行", () => {
  const domains = ["atomgit.com"];
  assert.equal(trustedURL("https://atomgit.com/login?state=1", { domains }), undefined);
  assert.equal(
    trustedURL("https://atomgit.com/login?state=1", { domains, allowSearch: true }),
    "https://atomgit.com/login?state=1",
  );
});

test("trustedServiceURL：合法覆盖被采纳", () => {
  assert.equal(
    trustedServiceURL("https://api.gitcode.com/api/v6", { fallback: "https://api.gitcode.com/api/v5" }),
    "https://api.gitcode.com/api/v6",
  );
});

test("trustedServiceURL：非法值回退默认端点并上报", () => {
  const rejected = [];
  const fallback = "https://acs.atomgit.com";
  const out = trustedServiceURL("https://evil.example", { fallback, onReject: (v) => rejected.push(v) });
  assert.equal(out, fallback);
  assert.deepEqual(rejected, ["https://evil.example"]);
});

test("trustedServiceURL：未配置时不当作被拒，直接给默认值", () => {
  const rejected = [];
  const fallback = "https://acs.atomgit.com";
  assert.equal(trustedServiceURL(undefined, { fallback, onReject: (v) => rejected.push(v) }), fallback);
  assert.equal(trustedServiceURL("", { fallback, onReject: (v) => rejected.push(v) }), fallback);
  assert.deepEqual(rejected, []);
});

test("trustedServiceURL：上报回调自己抛错也不影响返回值", () => {
  const out = trustedServiceURL("https://evil.example", {
    fallback: "https://acs.atomgit.com",
    onReject: () => {
      throw new Error("logger exploded");
    },
  });
  assert.equal(out, "https://acs.atomgit.com");
});

test("originOf：协议与端口进入比较，非法输入 → undefined", () => {
  assert.equal(originOf("https://llm-api.atomgit.com/v1/chat/completions"), "https://llm-api.atomgit.com");
  assert.notEqual(
    originOf("http://llm-api.atomgit.com/v1"),
    originOf("https://llm-api.atomgit.com/v1"),
    "明文降级必须与 https 判定不同",
  );
  assert.notEqual(
    originOf("https://llm-api.atomgit.com:8443/v1"),
    originOf("https://llm-api.atomgit.com/v1"),
    "不同端口是不同来源",
  );
  assert.equal(originOf("not a url"), undefined);
  assert.equal(originOf(undefined), undefined);
});

test("credentialsOf：缺少 access 时无法签名，uid 统一转字符串", () => {
  assert.equal(credentialsOf({}), undefined);
  assert.equal(credentialsOf({ access: "" }), undefined);
  assert.equal(credentialsOf(null), undefined);
  assert.equal(credentialsOf({ access: "tok", uid: 42 }).uid, "42");
});

test("readCappedResponseText：流式读取超过上限时立即取消", async () => {
  let pulls = 0;
  const chunk = new Uint8Array(64 * 1024);
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
    },
  });
  await assert.rejects(
    () => readCappedResponseText(new Response(stream), { label: "metadata" }),
    /metadata exceeds 1 MiB/,
  );
  assert.ok(pulls <= 30, `read too far: ${pulls} chunks`);
});
