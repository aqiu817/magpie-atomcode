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
