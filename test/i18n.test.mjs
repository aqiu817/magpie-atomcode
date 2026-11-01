import { test } from "node:test";
import assert from "node:assert/strict";

import { LOCALES, fill, resolveLocale, strings } from "../i18n.mjs";

test("zh and en expose the same keys and placeholders", () => {
  const zh = strings("zh");
  const en = strings("en");
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());

  for (const key of Object.keys(zh)) {
    if (key === "locale") continue;
    const placeholders = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `placeholder mismatch for ${key}`);
  }
});

test("plan-aware check-in copy uses locale-appropriate punctuation", () => {
  assert.equal(fill(strings("en").checkinDoneWithPlan, { plan: "Lite" }), "The plan is still active; nothing to claim (Lite)");
  assert.equal(fill(strings("zh").checkinDoneWithPlan, { plan: "Lite" }), "套餐仍有效，无需重领（Lite）");
});

test("fill leaves unknown placeholders visible", () => {
  assert.equal(fill("{known}-{missing}", { known: "ok" }), "ok-{missing}");
});

test("resolveLocale follows explicit option, Intl and environment", () => {
  assert.deepEqual(LOCALES, ["zh", "en"]);
  assert.equal(resolveLocale("zh-CN", {}, "en-US"), "zh");
  assert.equal(resolveLocale("auto", {}, "en-GB"), "en");
  assert.equal(resolveLocale("auto", { LANG: "zh_CN.UTF-8" }, "fr-FR"), "zh");
  assert.equal(resolveLocale("auto", { LANG: "C" }, "fr-FR"), "en");
});
