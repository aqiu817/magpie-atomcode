/**
 * Client for the AtomGit OAuth broker (`https://acs.atomgit.com`).
 *
 * Flow (mirrors Atom2Api `oauth.go`):
 *
 *   1. `startLogin`  → GET /auth/login?provider=atomgit → `{login_url, state}`;
 *      `force_login` is stripped from `login_url` (upstream's `stripForceLogin`),
 *      so an already-logged-in browser goes straight through.
 *   2. `checkLogin`  → GET /auth/check?state=… → `{valid: boolean}` — poll this.
 *   3. `tokenFor`    → GET /auth/token?state=… → `{access_token, refresh_token,
 *      token_type, expires_in, user{…}}` — requires a non-empty access token and
 *      `user.id` (the id feeds the request signature later).
 *   4. `refreshTokens` → POST /oauth/refresh `{refresh_token}` — same shape; the
 *      refresh token may or may not rotate, and a 400/401/403 means the browser
 *      sign-in is dead.
 *
 * Every call sends `User-Agent: atomcode/<version>`; the broker hands sessions
 * that die after ~10 minutes, so callers must not stall between steps.
 *
 * `fetchImpl` is injectable for tests.
 *
 * @module magpie-atomcode/oauth
 */

import { DEFAULT_CLIENT_VERSION } from "./internal.mjs";

/** Trailing slashes lie about URLs; trim once here. */
const withBase = (base, path) => `${String(base).replace(/\/+$/, "")}/${path}`;

/** `atomcode/5.2.3` — the UA every upstream endpoint asks for. */
export const userAgentOf = (clientVersion) => `atomcode/${clientVersion}`;

/**
 * Remove `force_login` from a login URL so single-sign-on works.
 *
 * Atom2Api's `stripForceLogin`: parse-delete, with a string fallback for a URL
 * that won't parse.
 */
export function stripForceLogin(raw) {
  const value = String(raw ?? "");
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete("force_login");
    return parsed.toString();
  } catch {
    return value.replace(/&force_login=true/g, "");
  }
}

async function call(
  base,
  path,
  {
    method = "GET",
    body,
    fetchImpl = (...args) => fetch(...args),
    clientVersion = DEFAULT_CLIENT_VERSION,
    timeoutMs = 15_000,
  } = {},
) {
  const res = await fetchImpl(withBase(base, path), {
    method,
    headers: {
      accept: "application/json",
      "user-agent": userAgentOf(clientVersion),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const error = new Error(`broker returned ${res.status}: ${text.slice(0, 200) || "empty response"}`);
    error.status = res.status;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`broker did not answer JSON: ${text.slice(0, 120) || "empty response"}`);
  }
}

/**
 * Start a browser sign-in.
 *
 * @returns {Promise<{loginUrl: string, state: string}>}
 */
export async function startLogin(base, opts = {}) {
  const r = await call(base, "auth/login?provider=atomgit", opts);
  if (!r?.login_url || !r?.state) {
    throw new Error("OAuth broker returned an incomplete login session");
  }
  return { loginUrl: stripForceLogin(r.login_url), state: String(r.state) };
}

/** Has the user finished signing in on the browser side? */
export async function checkLogin(base, state, opts = {}) {
  const r = await call(base, `auth/check?state=${encodeURIComponent(state)}`, opts);
  return r?.valid === true;
}

/**
 * Trade a completed state for tokens.
 *
 * @returns {Promise<{accessToken: string, refreshToken: string|undefined, expiresIn: number, tokenType: string|undefined, user: object}>}
 */
export async function tokenFor(base, state, opts = {}) {
  const r = await call(base, `auth/token?state=${encodeURIComponent(state)}`, opts);
  if (!r?.access_token || !r?.user?.id) {
    throw new Error("OAuth broker returned incomplete credentials");
  }
  return {
    accessToken: String(r.access_token),
    refreshToken: typeof r.refresh_token === "string" && r.refresh_token ? r.refresh_token : undefined,
    expiresIn: Number(r.expires_in) || 0,
    tokenType: typeof r.token_type === "string" && r.token_type ? r.token_type : "Bearer",
    user: r.user,
  };
}

/**
 * Renew with the refresh token.
 *
 * A 400/401/403 (or an empty access token) means the sign-in is dead, which is
 * signalled by `signIn: "expired"` — the token may also not rotate, in which
 * case the caller keeps the old one.
 *
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
 */
export async function refreshTokens(base, refreshToken, opts = {}) {
  if (!refreshToken) {
    const error = new Error("no refresh token available");
    error.signIn = "expired";
    throw error;
  }
  let r;
  try {
    r = await call(base, "oauth/refresh", { method: "POST", body: { refresh_token: refreshToken }, ...opts });
  } catch (e) {
    // 400/401/403 == 凭证不可用（Atom2Api 的判定同款）；其余错误原样上抛，
    // 由调用方决定是否带着旧 token 继续发请求。
    if (e.status === 400 || e.status === 401 || e.status === 403) e.signIn = "expired";
    throw e;
  }
  if (!r?.access_token) {
    const error = new Error("OAuth refresh returned an empty access token");
    error.signIn = "expired";
    throw error;
  }
  return {
    accessToken: String(r.access_token),
    refreshToken: typeof r.refresh_token === "string" && r.refresh_token ? r.refresh_token : refreshToken,
    expiresIn: Number(r.expires_in) || opts.fallbackExpiresIn || 0,
  };
}
