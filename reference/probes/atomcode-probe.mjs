// Verification probe: atomcode-signing-v1 in pure Node, then one live chat call.
// Secrets are only read from ~/.atomcode/auth.toml and never printed.
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MASTER_KEY_HEX = "e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123";

function signAtomGitRequest({ method, path, body, oauthToken, userId, clientVersion, timestamp, nonce }) {
  const masterKey = Buffer.from(MASTER_KEY_HEX, "hex");
  const tokenHash = createHash("sha256").update(oauthToken).digest();
  const versionHash = createHash("sha256").update(clientVersion).digest();
  const timeBucket = Buffer.alloc(8);
  timeBucket.writeBigUInt64LE(BigInt(Math.floor(timestamp / 3600)));
  const salt = Buffer.concat([
    Buffer.from(userId, "utf8"),
    Buffer.from([1]),
    timeBucket,
    tokenHash,
    versionHash,
  ]);
  const signingKey = Buffer.from(hkdfSync("sha256", masterKey, salt, Buffer.from("atomcode-signing-v1"), 32));
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const nonceHex = nonce.toString("hex");
  const canonical = ["v1", method.toUpperCase(), path, String(timestamp), nonceHex, bodyHash].join("\n");
  const sig = createHmac("sha256", signingKey).update(canonical).digest("hex");
  return {
    "X-AtomCode-Sig": "v1:" + sig,
    "X-AtomCode-Ts": String(timestamp),
    "X-AtomCode-Nonce": nonceHex,
    "X-AtomCode-Alg": "1",
    "X-AtomCode-Ver": clientVersion,
  };
}

// --- 1. Self-check against Atom2Api's independent fixture -------------------
const fixtureHeaders = signAtomGitRequest({
  method: "POST",
  path: "/v1/chat/completions",
  body: Buffer.from('{"model":"deepseek-v4-flash"}', "utf8"),
  oauthToken: "token-fixture",
  userId: "user-fixture",
  clientVersion: "5.0.2",
  timestamp: 1767225600,
  nonce: Buffer.from(Array.from({ length: 16 }, (_, i) => i)),
});
const expected = "v1:c5bafa716c0fdc31a6e2738412d0b21a9d9e9d1ca09cc44eb17949a1b4fa4bdd";
console.log("fixture sig match:", fixtureHeaders["X-AtomCode-Sig"] === expected ? "YES" : "NO -> " + fixtureHeaders["X-AtomCode-Sig"]);

// --- 2. Parse auth.toml (line-based; values are never printed) -------------
const raw = readFileSync(join(homedir(), ".atomcode", "auth.toml"), "utf8");
const kv = {};
let section = "";
for (const line of raw.split(/\r?\n/)) {
  const sec = line.match(/^\[(.+)\]\s*$/);
  if (sec) { section = sec[1].trim(); continue; }
  const m = line.match(/^([A-Za-z_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  const key = section ? section + "." + m[1] : m[1];
  kv[key] = m[2].trim().replace(/^"|"$/g, "");
}
const accessToken = kv["access_token"];
const userId = kv["user.id"];
const created = Number(kv["created_at"]);
const expiresIn = Number(kv["expires_in"]);
console.log("token present:", Boolean(accessToken), "| user id present:", Boolean(userId),
  "| valid until:", Number.isFinite(created) ? new Date((created + expiresIn) * 1000).toISOString() : "(unknown)");

// --- 3. Live minimal chat call --------------------------------------------
const CLIENT_VERSION = "5.2.3";
const url = "https://llm-api.atomgit.com/v1/chat/completions";
const body = JSON.stringify({
  model: "qwen3.8-27b",
  messages: [{ role: "user", content: "reply with the single word: pong" }],
  max_tokens: 64,
  stream: false,
});

const ts = Math.floor(Date.now() / 1000);
const nonce = randomBytes(16);
const sigHeaders = signAtomGitRequest({
  method: "POST",
  path: new URL(url).pathname,
  body: Buffer.from(body, "utf8"),
  oauthToken: accessToken,
  userId,
  clientVersion: CLIENT_VERSION,
  timestamp: ts,
  nonce,
});

const res = await fetch(url, {
  method: "POST",
  headers: {
    "authorization": "Bearer " + accessToken,
    "user-agent": "atomcode/" + CLIENT_VERSION,
    "content-type": "application/json",
    "accept": "*/*",
    ...sigHeaders,
  },
  body,
  signal: AbortSignal.timeout(90000),
});
console.log("chat status:", res.status, "|", res.headers.get("content-type"));
const text = await res.text();
try {
  const j = JSON.parse(text);
  console.log("chat summary:", JSON.stringify({
    model: j.model,
    finish: j.choices?.[0]?.finish_reason,
    content: j.choices?.[0]?.message?.content?.slice(0, 80),
    usage: j.usage,
  }, null, 1));
} catch {
  console.log("raw body head:", text.slice(0, 500));
}
