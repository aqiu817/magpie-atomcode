import { test } from "node:test";
import assert from "node:assert/strict";

import { MASTER_KEY_HEX, signAtomGitRequest } from "../sign.mjs";

/**
 * Atom2Api's independent signing fixture. This is the compatibility contract
 * for every model request; a plugin release must never change it silently.
 */
test("signing fixture matches Atom2Api", () => {
  const headers = signAtomGitRequest({
    method: "POST",
    path: "/v1/chat/completions",
    body: '{"model":"deepseek-v4-flash"}',
    oauthToken: "token-fixture",
    userId: "user-fixture",
    clientVersion: "5.0.2",
    timestamp: 1767225600,
    nonce: Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"),
  });

  assert.equal(
    headers["X-AtomCode-Sig"],
    "v1:c5bafa716c0fdc31a6e2738412d0b21a9d9e9d1ca09cc44eb17949a1b4fa4bdd",
  );
  assert.equal(headers["X-AtomCode-Ts"], "1767225600");
  assert.equal(headers["X-AtomCode-Nonce"], "000102030405060708090a0b0c0d0e0f");
  assert.equal(headers["X-AtomCode-Alg"], "1");
  assert.equal(headers["X-AtomCode-Ver"], "5.0.2");
});

test("signature covers token, user, version and raw body bytes", () => {
  const base = {
    method: "POST",
    path: "/v1/chat/completions",
    body: new TextEncoder().encode("{}"),
    oauthToken: "token",
    userId: "user",
    clientVersion: "5.2.3",
    timestamp: 1767225600,
    nonce: Buffer.alloc(16, 7),
  };
  const signature = (overrides = {}) => signAtomGitRequest({ ...base, ...overrides })["X-AtomCode-Sig"];

  assert.notEqual(signature(), signature({ oauthToken: "other-token" }));
  assert.notEqual(signature(), signature({ userId: "other-user" }));
  assert.notEqual(signature(), signature({ clientVersion: "5.2.4" }));
  assert.notEqual(signature(), signature({ body: new TextEncoder().encode('{"x":1}') }));
});

test("signing rejects incomplete inputs instead of producing a partial signature", () => {
  assert.throws(() => signAtomGitRequest({ method: "", path: "/v1", oauthToken: "t", userId: "u", clientVersion: "v" }), /method/);
  assert.throws(() => signAtomGitRequest({ method: "GET", path: "v1", oauthToken: "t", userId: "u", clientVersion: "v" }), /path/);
  assert.throws(() => signAtomGitRequest({ method: "GET", path: "/v1", oauthToken: "", userId: "u", clientVersion: "v" }), /token/);
  assert.throws(() => signAtomGitRequest({ method: "GET", path: "/v1", oauthToken: "t", userId: "", clientVersion: "v" }), /user id/);
  assert.throws(() => signAtomGitRequest({ method: "GET", path: "/v1", oauthToken: "t", userId: "u", clientVersion: "" }), /version/);
  assert.match(MASTER_KEY_HEX, /^[0-9a-f]{64}$/);
});
