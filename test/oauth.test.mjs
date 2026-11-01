import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkLogin,
  refreshTokens,
  startLogin,
  stripForceLogin,
  tokenFor,
} from "../oauth.mjs";

function sequenceFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next.error) throw next.error;
    return new Response(next.body ?? "", { status: next.status ?? 200 });
  };
  return { fetchImpl, calls };
}

test("startLogin strips force_login and validates the returned URL", async () => {
  const { fetchImpl, calls } = sequenceFetch([
    {
      body: JSON.stringify({
        login_url: "https://atomgit.com/login?force_login=true&next=%2Fhome",
        state: "state-1",
      }),
    },
  ]);
  const result = await startLogin("https://acs.atomgit.com", { fetchImpl });

  assert.equal(result.loginUrl, "https://atomgit.com/login?next=%2Fhome");
  assert.equal(result.state, "state-1");
  assert.equal(calls[0].init.redirect, "error");
});

test("startLogin refuses a broker-supplied login URL outside AtomGit", async () => {
  const { fetchImpl } = sequenceFetch([
    { body: JSON.stringify({ login_url: "https://evil.example/login", state: "state-1" }) },
  ]);

  await assert.rejects(() => startLogin("https://acs.atomgit.com", { fetchImpl }), /untrusted login URL/);
});

test("checkLogin encodes state and only accepts a strict true", async () => {
  const { fetchImpl, calls } = sequenceFetch([{ body: JSON.stringify({ valid: true }) }]);
  assert.equal(await checkLogin("https://acs.atomgit.com", "a/b c", { fetchImpl }), true);
  assert.equal(new URL(calls[0].url).searchParams.get("state"), "a/b c");
});

test("tokenFor validates and maps the credential response", async () => {
  const { fetchImpl } = sequenceFetch([
    {
      body: JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        token_type: "Bearer",
        user: { id: 42, email: "u@example.com" },
      }),
    },
  ]);
  const token = await tokenFor("https://acs.atomgit.com", "state", { fetchImpl });
  assert.equal(token.accessToken, "access");
  assert.equal(token.refreshToken, "refresh");
  assert.equal(token.expiresIn, 3600);
  assert.equal(token.user.id, 42);
});

test("refreshTokens keeps the old refresh token when upstream does not rotate", async () => {
  const { fetchImpl, calls } = sequenceFetch([
    { body: JSON.stringify({ access_token: "new-access", expires_in: 7200 }) },
  ]);
  const token = await refreshTokens("https://acs.atomgit.com", "old-refresh", { fetchImpl });

  assert.equal(token.accessToken, "new-access");
  assert.equal(token.refreshToken, "old-refresh");
  assert.equal(token.expiresIn, 7200);
  assert.equal(JSON.parse(calls[0].init.body).refresh_token, "old-refresh");
  assert.equal(calls[0].init.redirect, "error");
});

test("refreshTokens marks only credential failures as expired", async () => {
  for (const status of [400, 401, 403]) {
    const { fetchImpl } = sequenceFetch([{ status, body: "{}" }]);
    await assert.rejects(
      () => refreshTokens("https://acs.atomgit.com", "refresh", { fetchImpl }),
      (error) => error.signIn === "expired",
    );
  }

  const { fetchImpl } = sequenceFetch([{ status: 503, body: "unavailable" }]);
  await assert.rejects(
    () => refreshTokens("https://acs.atomgit.com", "refresh", { fetchImpl }),
    (error) => error.status === 503 && error.signIn === undefined,
  );
});

test("OAuth responses are bounded before JSON parsing", async () => {
  const chunk = new Uint8Array(64 * 1024);
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
  });
  const { fetchImpl } = sequenceFetch([{ body: stream }]);
  await assert.rejects(() => checkLogin("https://acs.atomgit.com", "state", { fetchImpl }), /exceeds 1 MiB/);
});

test("stripForceLogin tolerates malformed URLs with the legacy fallback", () => {
  assert.equal(stripForceLogin("not a url&force_login=true"), "not a url");
});
