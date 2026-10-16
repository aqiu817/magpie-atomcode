import { test } from "node:test";
import assert from "node:assert/strict";

import { createVersionSource, extractVersionFromManifest, fetchAtomCodeVersion } from "../version.mjs";

const MANIFEST = '[package]\nname = "atomcode"\nversion = "9.9.9"\n\n[workspace.package]\nversion = "5.2.3"\nedition = "2021"\n';

test("只认 [workspace.package] 的 version，忽略 [package] 的", () => {
  assert.equal(extractVersionFromManifest(MANIFEST), "5.2.3");
});

test("缺段 / 缺字段 / 非语义版本 → null", () => {
  assert.equal(extractVersionFromManifest('[package]\nversion = "1.2.3"\n'), null);
  assert.equal(extractVersionFromManifest('[workspace.package]\nedition = "2021"\n'), null);
  assert.equal(extractVersionFromManifest('[workspace.package]\nversion = "nightly"\n'), null);
  assert.equal(extractVersionFromManifest(""), null);
  assert.equal(extractVersionFromManifest(undefined), null);
});

test("CRLF / 缩进 / 前导空白容忍", () => {
  assert.equal(extractVersionFromManifest('[workspace.package]\r\n  version   =  "6.0.1"  \r\n'), "6.0.1");
});

test("fetchAtomCodeVersion：正常返回版本，非 2xx 抛错", async () => {
  const version = await fetchAtomCodeVersion({
    fetchImpl: async () => new Response(MANIFEST, { status: 200 }),
  });
  assert.equal(version, "5.2.3");
  await assert.rejects(
    fetchAtomCodeVersion({ fetchImpl: async () => new Response("nope", { status: 404 }) }),
    /manifest returned 404/,
  );
});

test("版本源：冷启动 ensure 等到真实结果；此前 get() 返回兜底", async () => {
  const src = createVersionSource({
    fallback: "5.2.3",
    fetchImpl: async () => new Response('[workspace.package]\nversion = "6.0.1"\n'),
  });
  assert.equal(src.get(), "5.2.3");
  assert.equal(await src.ensure(), "6.0.1");
  assert.equal(src.get(), "6.0.1");
});

test("TTL 内不重复拉取", async () => {
  let calls = 0;
  const src = createVersionSource({
    fallback: "5.2.3",
    fetchImpl: async () => {
      calls++;
      return new Response('[workspace.package]\nversion = "6.0.1"\n');
    },
  });
  await src.ensure();
  await src.ensure();
  assert.equal(calls, 1);
});

test("拉取失败：退回兜底、标记 quiet，失败窗口内不再碰网、只回调一次 onError", async () => {
  let calls = 0;
  const logs = [];
  const src = createVersionSource({
    fallback: "5.2.3",
    failTtlMs: 60_000,
    fetchImpl: async () => {
      calls++;
      throw new Error("offline");
    },
    onError: (e) => logs.push(e.message),
  });
  assert.equal(await src.ensure(), "5.2.3");
  assert.equal(await src.ensure(), "5.2.3");
  assert.equal(calls, 1);
  assert.deepEqual(logs, ["offline"]);
});

test("poke：后台拉取完成后 get() 升级（宿主常驻场景）", async () => {
  const src = createVersionSource({
    fallback: "5.2.3",
    fetchImpl: async () => new Response('[workspace.package]\nversion = "6.0.0"\n'),
  });
  assert.equal(src.get(), "5.2.3");
  src.poke();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(src.get(), "6.0.0");
});
