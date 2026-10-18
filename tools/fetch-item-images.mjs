// 下载图鉴里全部藏品图片（站点的 /images/items/*.png 对 curl 会挂，但在页面里 fetch 正常）。
// 用法：node tools/fetch-item-images.mjs
// 产物：data/items/<hash>.png + data/items/index.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { launch, makeRunner } from "../tests/cdp.mjs";

const CODEX = "data/codex.json";
const OUT_DIR = "data/items";

async function main() {
  const codex = JSON.parse(readFileSync(CODEX, "utf8"));
  const srcs = new Set();
  for (const s of codex.codex) for (const it of s.items) if (it.img && !it.img.includes("placeholder")) srcs.add(it.img);
  const list = [...srcs];
  console.error(`需要下载 ${list.length} 张图片`);

  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launch({ headless: true });
  const { send, evalJs, waitFor } = makeRunner(browser.cdp);
  await send("Page.enable");
  await send("Runtime.enable");

  const index = {};
  try {
    // 先打开站点，让 fetch 走同源上下文
    await send("Page.navigate", { url: "https://aqtwwx.net/listen-treasure" });
    await waitFor("!!document.querySelector('main')", 30000, "页面加载");

    // 分批在页面里 fetch -> base64
    const CHUNK = 12;
    for (let i = 0; i < list.length; i += CHUNK) {
      const batch = list.slice(i, i + CHUNK);
      const res = await evalJs(`
        (async () => {
          const out = {};
          await Promise.all(${JSON.stringify(batch)}.map(async (u) => {
            try {
              const r = await fetch(u);
              if (!r.ok) { out[u] = null; return; }
              const blob = await r.blob();
              const b64 = await new Promise((resolve) => {
                const fr = new FileReader();
                fr.onload = () => resolve(String(fr.result).split(",")[1]);
                fr.readAsDataURL(blob);
              });
              out[u] = b64;
            } catch (e) { out[u] = null; }
          }));
          return out;
        })()
      `);
      for (const [u, b64] of Object.entries(res)) {
        if (!b64) {
          console.error(`  ✗ ${u}`);
          continue;
        }
        const name = u.split("/").pop();
        writeFileSync(`${OUT_DIR}/${name}`, Buffer.from(b64, "base64"));
        index[u] = `items/${name}`;
        console.error(`  ✓ ${name} (${Math.round((b64.length * 3) / 4 / 1024)} KB)`);
      }
    }
    writeFileSync(`${OUT_DIR}/index.json`, JSON.stringify(index, null, 2));
    console.error(`完成：${Object.keys(index).length}/${list.length} 张，索引写入 ${OUT_DIR}/index.json`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
