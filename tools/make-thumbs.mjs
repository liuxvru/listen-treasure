// 把 data/items/*.png 压成 128px 的 webp 缩略图（原图 14MB，缩略图约 1MB）。
// 用 canvas 在无头 Chrome 里转码，项目本身不引入任何图片依赖。
// 用法：node tools/make-thumbs.mjs
// 产物：data/items/thumbs/<同名>.webp
import { launch, makeRunner } from "../tests/cdp.mjs";
import { readdirSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";

const SRC = "data/items";
const OUT = "data/items/thumbs";

async function main() {
  mkdirSync(OUT, { recursive: true });
  const files = readdirSync(SRC).filter((f) => f.endsWith(".png"));
  console.error(`转码 ${files.length} 张`);

  const browser = await launch({ headless: true });
  const { send, evalJs } = makeRunner(browser.cdp);
  await send("Page.enable");
  await send("Runtime.enable");
  try {
    await send("Page.navigate", { url: "data:text/html,<h1>thumb</h1>" });
    await new Promise((r) => setTimeout(r, 400));

    let done = 0;
    for (const f of files) {
      const b64 = readFileSync(`${SRC}/${f}`).toString("base64");
      // 用页面里的 Image + canvas 缩到 128 宽，导出 webp(q=0.82)
      const out = await evalJs(`
        (async () => {
          const img = new Image();
          img.src = "data:image/png;base64,${b64}";
          await img.decode();
          const W = 128;
          const H = Math.round((img.naturalHeight * W) / img.naturalWidth) || W;
          const c = document.createElement("canvas");
          c.width = W; c.height = H;
          const ctx = c.getContext("2d");
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, W, H);
          const url = c.toDataURL("image/webp", 0.82);
          return url.split(",")[1];
        })()
      `);
      if (!out) {
        console.error(`  ✗ ${f}`);
        continue;
      }
      writeFileSync(`${OUT}/${f.replace(/\.png$/, ".webp")}`, Buffer.from(out, "base64"));
      if (++done % 25 === 0) console.error(`  ...${done}`);
    }
    console.error(`完成 ${done}/${files.length} -> ${OUT}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
