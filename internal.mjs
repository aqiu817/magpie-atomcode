/**
 * Helpers shared by the plugin entry and its tests.
 *
 * Kept out of `index.mjs` because OpenCode is a compatibility host and it calls
 * every function the entry module exports. See that file's header.
 *
 * @module magpie-atomcode/internal
 */

import { readFileSync } from "node:fs";

/**
 * The provider id, which is also what agents address models by:
 * `atomcode/<model>`.
 */
export const PROVIDER = "atomcode";

/**
 * clientVersion anchor: AtomCode 5.2.3.
 *
 * Sent as `User-Agent: atomcode/<ver>` (the gateway answers 403
 * `ATOMCODE_UA_REQUIRED` without it) and as `X-AtomCode-Ver` in the signature.
 * The master key can change upstream; `clientVersion` and `masterKeyHex` are
 * plugin options so the plugin survives upstream rotation without a release.
 */
export const DEFAULT_CLIENT_VERSION = "5.2.3";

/** OAuth broker (`Atom2Api` 默认 `platform_base_url`）。 */
export const DEFAULT_PLATFORM_BASE_URL = "https://acs.atomgit.com";

/** CodingPlan REST 底座（`codingplan_api_url`）。 */
export const DEFAULT_CODING_PLAN_API_URL = "https://api.gitcode.com/api/v5";

/** LLM 网关底座（`gateway_url`）。 */
export const DEFAULT_GATEWAY_BASE_URL = "https://llm-api.atomgit.com/v1";

/** Inlined so the provider stays identifiable with no network. */
export const ICON = readIcon();

/**
 * The platform's own favicon, vendored into `assets/atomcode.ico` and inlined
 * as a data URI at load time.
 */
function readIcon() {
  try {
    const ico = readFileSync(new URL("./assets/atomcode.ico", import.meta.url));
    return `data:image/x-icon;base64,${ico.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/**
 * The `origin` of an absolute URL (scheme + host + port), or undefined when it
 * does not parse. `origin` also covers the protocol, so an `http://` downgrade
 * to the same host can never compare equal to an `https://` gateway.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function originOf(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return undefined;
  }
}

/**
 * Validate a URL that came from configuration or from upstream.
 *
 * Accepts only https, no embedded credentials, and a host that is one of
 * `domains` or a subdomain of one. Query and fragment components are rejected
 * for base endpoints unless explicitly allowed (OAuth login pages need both).
 * `undefined` means "not acceptable".
 *
 * @param {unknown} value
 * @param {{domains?: string[], allowSearch?: boolean, allowHash?: boolean}} [opts]
 * @returns {string|undefined} the trimmed URL, or undefined when unusable.
 */
export function trustedURL(value, { domains = [], allowSearch = false, allowHash = false } = {}) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  if (!allowSearch && url.search) return undefined;
  if (!allowHash && url.hash) return undefined;
  const host = url.hostname.toLowerCase();
  if (!domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return undefined;
  return value.trim();
}

/** A compact byte limit for user-facing errors. */
function byteLimitLabel(maxBytes) {
  if (maxBytes >= 1 << 20 && maxBytes % (1 << 20) === 0) return `${maxBytes / (1 << 20)} MiB`;
  if (maxBytes >= 1 << 10 && maxBytes % (1 << 10) === 0) return `${maxBytes / (1 << 10)} KiB`;
  return `${maxBytes} bytes`;
}

/**
 * Read an HTTP response body without allowing an untrusted response to consume
 * unbounded memory. The stream is cancelled as soon as the limit is crossed.
 *
 * @param {Response} res
 * @param {{maxBytes?: number, label?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function readCappedResponseText(
  res,
  { maxBytes = 1 << 20, label = "response" } = {},
) {
  if (!res?.body || typeof res.body.getReader !== "function") {
    const whole = await res.text();
    if (Buffer.byteLength(whole, "utf8") > maxBytes) {
      throw new Error(`${label} exceeds ${byteLimitLabel(maxBytes)}`);
    }
    return whole;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeds ${byteLimitLabel(maxBytes)}`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* cancel() may have released it already */
    }
  }
  return text + decoder.decode();
}

/**
 * Domains the endpoint options (`platformBaseURL`, `codingPlanAPIURL`) may point
 * at.
 *
 * An access or refresh token travels to whichever endpoint a config names, so
 * this list stays on the upstream's own two families — a value outside it is
 * treated as a misconfiguration, not as a destination.
 */
export const TRUSTED_SERVICE_DOMAINS = ["atomgit.com", "gitcode.com"];

/**
 * An endpoint option, or `fallback` when the configured value is unusable.
 *
 * A rejected value is reported through `onReject` rather than thrown: a bad
 * option must not take the whole provider down.
 *
 * @param {unknown} value
 * @param {{fallback: string, domains?: string[], onReject?: Function}} opts
 * @returns {string}
 */
export function trustedServiceURL(value, { fallback, domains = TRUSTED_SERVICE_DOMAINS, onReject } = {}) {
  const accepted = trustedURL(value, { domains });
  if (accepted) return accepted;
  if (typeof value === "string" && value.trim()) {
    try {
      onReject?.(value.trim());
    } catch {
      /* the reporter is best-effort */
    }
  }
  return fallback;
}

/** Read the stored sign-in, tolerating a host that has none. */
export async function readAuth(getAuth) {
  if (typeof getAuth !== "function") return undefined;
  try {
    return await getAuth();
  } catch {
    return undefined;
  }
}

/**
 * The fields a signed request needs, out of a stored auth record.
 *
 * `uid` (the upstream `user.id`) participates in the signing salt, so it is
 * carried on every sign-in result; a record without it cannot sign at all.
 */
export function credentialsOf(auth) {
  if (!auth || typeof auth !== "object") return undefined;
  const access = typeof auth.access === "string" && auth.access ? auth.access : undefined;
  if (!access) return undefined;
  return {
    type: auth.type,
    access,
    refresh: typeof auth.refresh === "string" && auth.refresh ? auth.refresh : undefined,
    expires: Number.isFinite(auth.expires) ? auth.expires : undefined,
    uid: auth.uid !== undefined && auth.uid !== null ? String(auth.uid) : undefined,
    accountId: typeof auth.accountId === "string" ? auth.accountId : undefined,
    email: typeof auth.email === "string" ? auth.email : undefined,
    name: typeof auth.name === "string" ? auth.name : undefined,
  };
}

/**
 * Mark a model list as the remembered one rather than a live one.
 *
 * @param {object} models - the list to mark.
 * @returns {object} a copy carrying the marker.
 */
export function fellBack(models) {
  return { ...models, [Symbol.for("magpie.fellBack")]: true };
}
