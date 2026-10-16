/**
 * Client for the AtomGit CodingPlan REST API
 * (`https://api.gitcode.com/api/v5/coding-plan/*`).
 *
 * What the plugin needs from it:
 *
 *   - `status-v2`: the plan (name / type / expiry), the current window usage and
 *     the raw `rate_limit_windows` — the source for both the plan tier and the
 *     `auth.usage` windows.
 *   - `models-v2?plan_type=<Lite|Pro|Max>`: the account's model catalog, which
 *     varies by account and plan tier (Atom2Api's README lists models this
 *     account never receives), so it is always read live with a snapshot as
 *     the fallback.
 *
 * Plain bearer auth, `User-Agent: atomcode/<version>`, short timeouts — these
 * are metadata calls, not model traffic.
 *
 * @module magpie-atomcode/codingplan
 */

import { DEFAULT_CLIENT_VERSION } from "./internal.mjs";

const withBase = (base, path) => `${String(base).replace(/\/+$/, "")}/${path}`;

/**
 * The plan part of a status response. The real endpoint answers it under
 * `codingplan_free`; `plan` is a defensive fallback in case the upstream field
 * moves.
 */
export function planOf(status) {
  if (!status || typeof status !== "object") return null;
  const plan = status.codingplan_free ?? status.plan ?? null;
  return plan && typeof plan === "object" ? plan : null;
}

/**
 * Plan tier, spelled the way `models-v2?plan_type=` accepts it.
 *
 * Atom2Api's rule: the lowercase plan name containing "max" → Max, "pro" → Pro,
 * anything else → Lite ("CodingPlan Lite-体验版" and "Lite-beta" are Lite).
 */
export function planTier(planName) {
  const name = String(planName ?? "").toLowerCase();
  if (name.includes("max")) return "Max";
  if (name.includes("pro")) return "Pro";
  return "Lite";
}

/**
 * 该账号是否需要（重新）领取 CodingPlan —— 插件"签到"语义的判定。
 *
 * 协议里没有独立的每日打卡端点：官方 `/login` 的申领就是唯一写入点
 * （`claim-v2`），"限量 1000 人/日""每日 10:00 放量"是平台侧的放量节奏。
 * 因此插件里的"签到" = 套餐缺失或到期后的自动重领：
 *   - 没有 `codingplan_free`（从未领取或已彻底失效）→ 需要领取；
 *   - `remaining_days` 明确为 0 → 需要重领；
 *   - `expires_at` 已过且超出 1 天宽限（到期日当天仍算有效）→ 需要重领。
 * 判定保持保守：拿不准时一律返回 false，绝不因误判多打领取接口。
 */
export function planNeedsClaim(status, now = Date.now()) {
  const plan = planOf(status);
  if (!plan) return true;
  if (typeof plan.plan_name !== "string" || !plan.plan_name.trim()) return true;
  const remaining = Number(plan.remaining_days);
  if (Number.isFinite(remaining) && remaining <= 0) return true;
  const expires = Date.parse(plan.expires_at ?? "");
  if (Number.isFinite(expires) && now > expires + 24 * 3600_000) return true;
  return false;
}

async function request(
  base,
  path,
  token,
  {
    fetchImpl = (...args) => fetch(...args),
    clientVersion = DEFAULT_CLIENT_VERSION,
    timeoutMs = 20_000,
  } = {},
) {
  const res = await fetchImpl(withBase(base, path), {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": `atomcode/${clientVersion}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const error = new Error(`CodingPlan returned ${res.status}: ${text.slice(0, 200) || "empty response"}`);
    error.status = res.status;
    if (res.status === 401 || res.status === 403) error.signIn = "expired";
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`CodingPlan did not answer JSON: ${text.slice(0, 120) || "empty response"}`);
  }
}

/** `GET /coding-plan/status-v2` — plan + current window + rate_limit_windows. */
export async function fetchStatus(base, token, opts = {}) {
  return request(base, "coding-plan/status-v2", token, opts);
}

/**
 * `GET /coding-plan/models-v2?plan_type=…` for the account's tier.
 *
 * Rows without a display name, rows not available to the plan and deprecated
 * rows are dropped; an out-of-shape payload throws so callers fall back.
 *
 * @returns {Promise<object[]>} raw model rows, normalization happens upstream.
 */
export async function fetchModels(base, token, tier, opts = {}) {
  const r = await request(base, `coding-plan/models-v2?plan_type=${encodeURIComponent(tier)}`, token, opts);
  if (!Array.isArray(r)) throw new Error("models-v2 did not return a list");
  return r.filter((m) => {
    if (!m || typeof m !== "object") return false;
    if (typeof m.display_model_name !== "string" || !m.display_model_name.trim()) return false;
    if (m.plan_available === false) return false;
    if (m.status === "deprecated") return false;
    return true;
  });
}

/**
 * 领取 CodingPlan —— 签到（登录）闭环的最后一步。
 *
 * Atom2Api 在 OAuth 换到 token 后立刻做同一件事：按官方客户端的
 * Max → Pro → Lite 顺序 POST `/coding-plan/claim-v2`，`success` 或
 * `duplicate`（已领取过）即停；错误响应体也按 JSON 解出 `message`
 * （Atom2Api 的 `claim()` 同款）。幂等且只做领取，不改账号状态。
 *
 * 这个函数绝不抛错：领不成就把原因作为结果返回，让登录先成功。
 *
 * @returns {Promise<{claimed: boolean, tier: string, planName: string, message: string, attempts: object[]}>}
 */
export async function claimCodingPlan(
  base,
  token,
  { fetchImpl = (...args) => fetch(...args), clientVersion = DEFAULT_CLIENT_VERSION, timeoutMs = 20_000 } = {},
) {
  let lastMessage = "no Coding Plan tier is currently available";
  const attempts = [];
  for (const tier of ["Max", "Pro", "Lite"]) {
    let status = 0;
    let response = null;
    let raw = "";
    try {
      const res = await fetchImpl(withBase(base, "coding-plan/claim-v2"), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": `atomcode/${clientVersion}`,
        },
        body: JSON.stringify({ plan_type: tier }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      raw = await res.text().catch(() => "");
      try {
        response = JSON.parse(raw);
      } catch {
        /* 非 JSON 响应体 → message 退回原文 */
      }
    } catch (error) {
      attempts.push({ tier, httpStatus: 0, success: false, duplicate: false, message: error.message });
      lastMessage = error.message;
      continue;
    }
    const success = status >= 200 && status < 300 && response?.success === true;
    const duplicate = status >= 200 && status < 300 && response?.duplicate === true;
    const message =
      typeof response?.message === "string" && response.message
        ? response.message
        : response
          ? ""
          : raw.slice(0, 200) || `HTTP ${status}`;
    attempts.push({ tier, httpStatus: status, success, duplicate, message });
    if (success || duplicate) {
      return {
        claimed: true,
        // fresh（这次才领到）与 duplicate（本来就持有）在 checkin 语义里要分开：
        // 前者 = claimed，后者 = done。
        duplicate,
        tier: typeof response?.plan_type === "string" && response.plan_type ? response.plan_type : tier,
        planName: typeof response?.plan_name === "string" ? response.plan_name : "",
        message,
        attempts,
      };
    }
    if (message) lastMessage = message;
  }
  return { claimed: false, duplicate: false, tier: "", planName: "", message: lastMessage, attempts };
}
