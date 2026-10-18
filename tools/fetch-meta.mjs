// 从 aqtwwx.net 抓取“行商听声鉴宝”（listen-treasure）声音图鉴元数据。
// 接口需要 X-Abc / X-Xyz / X-Qwe 三个签名头（X-Qwe = RSA(PKCS1v1.5) 加密的 `${timestamp}:${nonce}`）。
// 公钥是站点前端 data/app.js 里的常量 br（仅用于这个防刷签名，不是敏感凭据）。
// 运行：node scripts/fetch-meta.mjs
import { createPublicKey, publicEncrypt, constants } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dataDir = join(root, "data");

const BASE = "https://aqtwwx.net";
const PUBLIC_KEY_B64 =
  "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAMAzUHyAQyn5tGxTXNiImUBiK7JGhaH3O2a3O8lzzb3w8X6M8xbbPkwZjPXU13/9DTe+paa7+txQXOfBxk+U//MCAwEAAQ==";

const NONCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function makeNonce() {
  let s = "";
  for (let i = 0; i < 8; i++) s += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
  return s;
}

function sign(timestamp, nonce) {
  const pem = `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY_B64}\n-----END PUBLIC KEY-----`;
  const key = createPublicKey(pem);
  const enc = publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(`${timestamp}:${nonce}`, "utf8"));
  return enc.toString("base64");
}

function signedHeaders() {
  const ts = Date.now();
  const nonce = makeNonce();
  return {
    "X-Abc": Buffer.from(String(ts), "utf8").toString("base64"),
    "X-Xyz": nonce,
    "X-Qwe": sign(ts, nonce),
  };
}

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Referer: `${BASE}/listen-treasure`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ...signedHeaders(),
    },
  });
  const json = await res.json();
  if (json.code !== 200) throw new Error(`${path} -> ${json.code} ${json.msg || json.message}`);
  return json.data;
}

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const [sounds, codex] = await Promise.all([
  apiGet("/api/basic/v1/listenTreasure/dzi-open/sounds"),
  apiGet("/api/basic/v1/listenTreasure/dzi-open/codex"),
]);

writeFileSync(join(dataDir, "sounds-api.json"), JSON.stringify(sounds, null, 2));
writeFileSync(join(dataDir, "codex.json"), JSON.stringify(codex, null, 2));
console.log("sounds:", Array.isArray(sounds) ? sounds.length : typeof sounds);
console.log("codex keys:", codex && typeof codex === "object" ? Object.keys(codex).join(", ") : typeof codex);
console.log("sample sound:", JSON.stringify(Array.isArray(sounds) ? sounds[0] : null).slice(0, 400));
if (Array.isArray(codex)) console.log("sample codex:", JSON.stringify(codex[0]).slice(0, 600));
else console.log("sample codex:", JSON.stringify(codex).slice(0, 800));
