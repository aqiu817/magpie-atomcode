// Probe 2: streaming SSE + reasoning_effort acceptance.
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MASTER_KEY_HEX = "e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123";
const CLIENT_VERSION = "5.2.3";

function sign({ method, path, body, oauthToken, userId, timestamp, nonce }) {
  const masterKey = Buffer.from(MASTER_KEY_HEX, "hex");
  const timeBucket = Buffer.alloc(8);
  timeBucket.writeBigUInt64LE(BigInt(Math.floor(timestamp / 3600)));
  const salt = Buffer.concat([
    Buffer.from(userId, "utf8"), Buffer.from([1]), timeBucket,
    createHash("sha256").update(oauthToken).digest(),
    createHash("sha256").update(CLIENT_VERSION).digest(),
  ]);
  const signingKey = Buffer.from(hkdfSync("sha256", masterKey, salt, Buffer.from("atomcode-signing-v1"), 32));
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const nonceHex = nonce.toString("hex");
  const canonical = ["v1", method.toUpperCase(), path, String(timestamp), nonceHex, bodyHash].join("\n");
  return {
    "X-AtomCode-Sig": "v1:" + createHmac("sha256", signingKey).update(canonical).digest("hex"),
    "X-AtomCode-Ts": String(timestamp),
    "X-AtomCode-Nonce": nonceHex,
    "X-AtomCode-Alg": "1",
    "X-AtomCode-Ver": CLIENT_VERSION,
  };
}

const raw = readFileSync(join(homedir(), ".atomcode", "auth.toml"), "utf8");
const kv = {}; let section = "";
for (const line of raw.split(/\r?\n/)) {
  const sec = line.match(/^\[(.+)\]\s*$/);
  if (sec) { section = sec[1].trim(); continue; }
  const m = line.match(/^([A-Za-z_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  kv[section ? section + "." + m[1] : m[1]] = m[2].trim().replace(/^"|"$/g, "");
}
const accessToken = kv["access_token"], userId = kv["user.id"];

async function call(name, payload) {
  const url = "https://llm-api.atomgit.com/v1/chat/completions";
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + accessToken,
      "user-agent": "atomcode/" + CLIENT_VERSION,
      "content-type": "application/json",
      accept: "*/*",
      ...sign({ method: "POST", path: new URL(url).pathname, body: Buffer.from(body, "utf8"), oauthToken: accessToken, userId, timestamp: ts, nonce: randomBytes(16) }),
    },
    body,
    signal: AbortSignal.timeout(120000),
  });
  console.log(`[${name}] status:`, res.status, "| ctype:", res.headers.get("content-type"));

  if (payload.stream) {
    let events = 0, firstChunk = null, lastChunk = null, usageChunk = null, doneSeen = false, reasoningSeen = false;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { doneSeen = true; continue; }
        try {
          const ev = JSON.parse(data);
          events++;
          if (!firstChunk) firstChunk = ev;
          lastChunk = ev;
          if (ev.usage) usageChunk = ev.usage;
          if (ev.choices?.[0]?.delta?.reasoning_content) reasoningSeen = true;
        } catch { /* keep going */ }
      }
    }
    console.log(`[${name}] SSE events:`, events, "| [DONE]:", doneSeen, "| reasoning deltas:", reasoningSeen);
    console.log(`[${name}] first delta keys:`, JSON.stringify(firstChunk?.choices?.[0]?.delta ?? firstChunk).slice(0, 200));
    console.log(`[${name}] finish_reason:`, lastChunk?.choices?.[0]?.finish_reason, "| usage in stream:", JSON.stringify(usageChunk ?? null).slice(0, 160));
  } else {
    const j = await res.json().catch(() => null);
    console.log(`[${name}] message keys:`, j ? Object.keys(j.choices?.[0]?.message ?? {}).join(",") : "(unparsable)");
    console.log(`[${name}] reasoning head:`, JSON.stringify((j?.choices?.[0]?.message?.reasoning_content ?? "").slice(0, 60)));
    console.log(`[${name}] content head:`, JSON.stringify((j?.choices?.[0]?.message?.content ?? "").slice(0, 80)));
    console.log(`[${name}] usage:`, JSON.stringify(j?.usage ?? null).slice(0, 200));
  }
}

await call("stream+include_usage", {
  model: "qwen3.8-27b",
  messages: [{ role: "user", content: "count from 1 to 5" }],
  max_tokens: 128,
  stream: true,
  stream_options: { include_usage: true },
});

await call("reasoning=xhigh", {
  model: "qwen3.8-27b",
  messages: [{ role: "user", content: "what is 17*23? answer briefly" }],
  max_tokens: 512,
  reasoning_effort: "xhigh",
  stream: false,
});
