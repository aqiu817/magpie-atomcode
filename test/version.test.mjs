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

test("版本源：冷启动 ensure 立即返回兜底，后台完成后再升级", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const src = createVersionSource({
    fallback: "5.2.3",
    fetchImpl: async () => {
      await pending;
      return new Response('[workspace.package]\nversion = "6.0.1"\n');
    },
  });
  assert.equal(src.get(), "5.2.3");
  assert.equal(await src.ensure(), "5.2.3");
  finish();
  await waitFor(() => src.get() === "6.0.1");
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

test("fetchAtomCodeVersion：超过 1 MiB 的清单边读边停，不会先整块吃下", async () => {
  let pulls = 0;
  const chunk = new Uint8Array(64 * 1024);
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 200) return controller.close();
      controller.enqueue(chunk);
      return undefined;
    },
  });
  await assert.rejects(
    fetchAtomCodeVersion({ fetchImpl: async () => new Response(stream, { status: 200 }) }),
    /exceeds 1 MiB/,
  );
  // 1 MiB / 64 KiB = 16 块；读到第 17 块就该中止，远不到 200。
  assert.ok(pulls <= 30, `应在越过上限时立刻停止读取，实际读了 ${pulls} 块`);
});

test("fetchAtomCodeVersion：上限之内的较大清单仍能解析出真实版本", async () => {
  const padding = "#".repeat(200 * 1024);
  const text = `[workspace.package]\nversion = "6.1.0"\n${padding}\n`;
  const version = await fetchAtomCodeVersion({
    fetchImpl: async () => new Response(text, { status: 200 }),
  });
  assert.equal(version, "6.1.0");
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

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
