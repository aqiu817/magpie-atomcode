/**
 * `atomcode-signing-v1` — the request signature the AtomGit LLM gateway
 * requires (`X-AtomCode-*` headers).
 *
 * Port of the community-documented implementation (Atom2Api, MIT). Two facts
 * this code must not drift from:
 *
 *   - the salt is `uid bytes || 0x01 || le64(hour-bucket) || sha256(oauth_token)
 *     || sha256(client_version)`, and HKDF's info is the bare string
 *     `"atomcode-signing-v1"` (no trailing 0x01), 32 bytes out;
 *   - the canonical is `v1\nMETHOD\nPATH\nTS\nNONCE-hex\nsha256(body)-hex`,
 *     where PATH is the full request path with its `/v1` prefix.
 *
 * `test/sign.test.mjs` holds Atom2Api's independent fixture as the guard.
 *
 * The signature always covers the bytes actually sent: patch the body first,
 * sign second. Nothing here reads the network or the clock silently — both are
 * parameters for tests.
 *
 * @module magpie-atomcode/sign
 */

import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * The hard-coded master key Atom2Api ships (two independent community
 * implementations agree on it). Overridable per request in case upstream
 * rotates it without warning.
 */
export const MASTER_KEY_HEX = "e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123";

/** HKDF info label, exactly as upstream spells it. */
export const SIGNING_INFO = "atomcode-signing-v1";

/** A fresh 16-byte nonce (32 hex chars once stringified). */
export function newNonce() {
  return randomBytes(16);
}

/** Coerce a request body into what `createHash().update()` accepts. */
function toHashInput(body) {
  if (body === undefined || body === null || body === "") return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return body;
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error("unsupported request body type for signing");
}

/**
 * Build the five `X-AtomCode-*` headers for one request.
 *
 * @param {object} params
 * @param {string} params.method - HTTP method ("POST" …).
 * @param {string} params.path - full request path incl. `/v1`, no query.
 * @param {string|Buffer|ArrayBufferView|ArrayBuffer} [params.body] - what will be sent; "" hashes as the empty body.
 * @param {string} params.oauthToken - the bearer token.
 * @param {string} params.userId - the upstream `user.id` (enters the salt).
 * @param {string} params.clientVersion - `X-AtomCode-Ver` value, e.g. "5.2.3".
 * @param {number} [params.timestamp] - unix seconds; defaults to now.
 * @param {Buffer} [params.nonce] - 16 bytes; defaults to `newNonce()`.
 * @param {string} [params.masterKeyHex] - 64 hex chars; defaults to `MASTER_KEY_HEX`.
 * @returns {object} the five headers, ready to merge into a Headers object.
 */
export function signAtomGitRequest({
  method,
  path,
  body = "",
  oauthToken,
  userId,
  clientVersion,
  timestamp = Math.floor(Date.now() / 1000),
  nonce = newNonce(),
  masterKeyHex = MASTER_KEY_HEX,
}) {
  if (typeof method !== "string" || !method) throw new Error("signing requires a method");
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("signing requires an absolute request path (starting with /)");
  }
  if (!oauthToken) throw new Error("signing requires an oauth token");
  if (userId === undefined || userId === null || userId === "") {
    throw new Error("signing requires the account's user id");
  }
  if (!clientVersion) throw new Error("signing requires a client version");

  const masterKey = Buffer.from(masterKeyHex, "hex");
  const timeBucket = Buffer.alloc(8);
  timeBucket.writeBigUInt64LE(BigInt(Math.floor(timestamp / 3600)));
  const salt = Buffer.concat([
    Buffer.from(String(userId), "utf8"),
    Buffer.from([1]),
    timeBucket,
    createHash("sha256").update(oauthToken).digest(),
    createHash("sha256").update(String(clientVersion)).digest(),
  ]);
  const signingKey = Buffer.from(hkdfSync("sha256", masterKey, salt, Buffer.from(SIGNING_INFO), 32));

  const bodyHash = createHash("sha256").update(toHashInput(body)).digest("hex");
  const nonceHex = Buffer.isBuffer(nonce) ? nonce.toString("hex") : String(nonce);
  const canonical = [
    "v1",
    method.toUpperCase(),
    path,
    String(timestamp),
    nonceHex,
    bodyHash,
  ].join("\n");

  const sig = createHmac("sha256", signingKey).update(canonical).digest("hex");
  return {
    "X-AtomCode-Sig": "v1:" + sig,
    "X-AtomCode-Ts": String(timestamp),
    "X-AtomCode-Nonce": nonceHex,
    "X-AtomCode-Alg": "1",
    "X-AtomCode-Ver": String(clientVersion),
  };
}
