/**
 * UI strings, zh and en.
 *
 * These labels land in Magpie's own account card, in `magpie quota`, and in the
 * sign-in flow, so they are user-visible, not decoration. The language is the
 * plugin's `locale` option, defaulting to following the machine.
 *
 * @module magpie-atomcode/i18n
 */

/** The languages with a string table here. */
export const LOCALES = ["zh", "en"];

const ZH = {
  locale: "zh",

  methodLabel: "AtomGit 登录（浏览器）",
  instructions: "浏览器将打开 AtomGit 登录页完成授权；授权完成后回到这里等待，登录会自动完成。",
  loginTimeout: "登录超时（浏览器授权没有在 9 分钟内完成），请重试",
  loginFailed: "登录失败：{detail}",
  loginIncomplete: "授权流程没有返回完整账号信息，请重试",


  reloginRequired: "AtomCode 登录已失效，请重新登录",
  refreshFailed: "AtomCode 令牌续期失败：{detail}",
  cannotSign: "账号信息缺少 user id，无法生成请求签名，请重新登录",
  noAccount: "没有已登录的 AtomCode 账号",
  planFallback: "AtomCode CodingPlan",
  reclaimed: "套餐已重新领取：{plan}",
  reclaimFailed: "自动重领未成功：{detail}",
  checkinDone: "套餐仍有效，无需重领",


  usageHttp: "读取额度失败 HTTP {status}",
  readFailed: "读取额度失败：{detail}",

  windowHours: "{hours} 小时额度",
  callsOf: "{used} / {total} 次",


  modelsUnavailable: "模型目录暂时不可用，沿用内置列表",
  modelListEmpty: "模型目录为空（计划可能未领取），沿用内置列表",
};

const EN = {
  locale: "en",

  methodLabel: "AtomGit Sign-in (browser)",
  instructions: "Your browser will open the AtomGit sign-in page; after authorizing, come back here and the sign-in completes by itself.",
  loginTimeout: "Timed out (browser authorization not finished within 9 minutes); please retry",
  loginFailed: "Sign-in failed: {detail}",
  loginIncomplete: "The authorization flow returned incomplete account info; please retry",


  reloginRequired: "The AtomCode sign-in has expired; please sign in again",
  refreshFailed: "Renewing the AtomCode token failed: {detail}",
  cannotSign: "The stored account lacks its user id, so requests cannot be signed; please sign in again",
  noAccount: "No signed-in AtomCode account",
  planFallback: "AtomCode CodingPlan",
  reclaimed: "Plan reclaimed: {plan}",
  reclaimFailed: "Automatic re-claim failed: {detail}",
  checkinDone: "The plan is still active; nothing new to claim",


  usageHttp: "Reading the quota failed with HTTP {status}",
  readFailed: "Reading the quota failed: {detail}",

  windowHours: "{hours}h window",
  callsOf: "{used} / {total} calls",


  modelsUnavailable: "The model catalog is unavailable; keeping the built-in list",
  modelListEmpty: "The model catalog is empty (the plan may need claiming); keeping the built-in list",
};

const TABLES = { zh: ZH, en: EN };

/**
 * Fill `{name}` placeholders. Unknown names are left as they are, so a missing
 * string shows up in the UI instead of turning into "undefined".
 */
export function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    key in values ? String(values[key]) : whole
  );
}

/** The table for a resolved locale. */
export function strings(locale = "zh") {
  return TABLES[locale] ?? ZH;
}

/** The OS locale as Node reports it, or "" when there is nothing to report. */
function osLocale() {
  try {
    return typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function"
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : "";
  } catch {
    return "";
  }
}

/**
 * Decide the locale.
 *
 * `Intl` first (reflects OS settings on every platform including Windows, where
 * `LANG` is usually unset), then the environment as a fallback for a Node built
 * without ICU; a POSIX `C`/`POSIX` value is skipped rather than misread.
 *
 * @param {string|undefined} value - the `locale` option: `"auto"`, `"zh"`, or `"en"`.
 * @param {object} [env] - environment to read, injected for testing.
 * @param {string} [intl] - the OS locale, injected for testing.
 * @returns {"zh"|"en"}
 */
export function resolveLocale(value, env = process.env, intl = osLocale()) {
  if (value === "zh" || value === "en") return value;
  if (value && value !== "auto") {
    const explicit = String(value).toLowerCase();
    if (explicit.startsWith("zh")) return "zh";
    if (explicit.startsWith("en")) return "en";
  }

  if (/^zh/i.test(intl)) return "zh";
  if (/^en/i.test(intl)) return "en";

  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const raw = env?.[key];
    if (typeof raw !== "string") continue;
    const tag = raw.trim().split(".")[0].split("_")[0].toLowerCase();
    if (!tag || tag === "c" || tag === "posix") continue;
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}
