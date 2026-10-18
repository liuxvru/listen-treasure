// 从站点“声音图鉴”里把 17 组「音效 → 藏品」对照表抓下来（只读 DOM，不碰签名接口）。
// 用法：node tools/scrape-codex.mjs
// 产物：data/codex.json（原始）+ 各藏品图片可选下载到 data/items/
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { launch, makeRunner } from "../tests/cdp.mjs";

const PAGE = "https://aqtwwx.net/listen-treasure";
const OUT = "data/codex.json";

const CLICK_CODEX = () => {
  // 切到“声音图鉴”模式：点 .mode-card（H4 本身不可点，父级才是）
  const card = [...document.querySelectorAll(".mode-card")].find((c) => /声音图鉴/.test(c.textContent));
  if (card) card.click();
  return !!card;
};

const READ_CODEX = () => {
  const cards = [...document.querySelectorAll(".codex-body .track")];
  if (!cards.length) return null;
  const out = [];
  for (const card of cards) {
    const no = (card.querySelector(".track-no")?.textContent || "").trim();
    const name = (card.querySelector(".track-main")?.textContent || "").trim();
    const countText = (card.querySelector(".track-count")?.textContent || "").trim();
    const thumbs = [...card.querySelectorAll(".track-thumbs img")].map((i) => i.getAttribute("src"));
    out.push({ no, name, countText, thumbs });
  }
  return out;
};

const READ_DETAIL = () => {
  const stage = document.querySelector(".stage");
  if (!stage) return null;
  const title = (stage.querySelector(".stage-title")?.textContent || "").trim();
  const eyebrow = (stage.querySelector(".stage-eyebrow")?.textContent || "").trim();
  const facts = [...stage.querySelectorAll(".stage-facts > *")].map((n) =>
    (n.textContent || "").replace(/\s+/g, " ").trim()
  );
  const sizes = [...stage.querySelectorAll(".grid-filter > button")].map((b) =>
    (b.textContent || "").replace(/\s+/g, " ").trim()
  );
  const items = [...stage.querySelectorAll(".item-card, .item-cell, [class*='item-']")]
    .filter((n) => n.querySelector(".item-name"))
    .map((n) => {
      const name = (n.querySelector(".item-name")?.textContent || "").trim();
      const img = n.querySelector(".item-img")?.getAttribute("src") || "";
      const size = (
        n.querySelector(".item-size")?.getAttribute("title") ||
        n.querySelector(".item-size")?.textContent ||
        ""
      ).trim();
      const value = (n.querySelector(".item-value")?.textContent || "").trim();
      const rarity = n.getAttribute("data-rarity") || n.className.match(/rarity-(\w+)/)?.[1] || "";
      return { name, img, size, value, rarity };
    });
  // 去重（选择器可能命中多层）
  const seen = new Set();
  const uniq = items.filter((it) => {
    const k = it.name + "|" + it.img;
    if (seen.has(k)) return false;
    seen.add(k);
    return it.name;
  });
  return { title, eyebrow, facts, sizes, items: uniq };
};

async function main() {
  const browser = await launch({ headless: true, width: 1440, height: 1200 });
  const { send, evalJs, waitFor } = makeRunner(browser.cdp);
  await send("Page.enable");
  await send("Runtime.enable");

  try {
    await send("Page.navigate", { url: PAGE });
    await waitFor("!!document.querySelector('#app') && document.querySelector('main')", 30000, "页面加载");
    await evalJs("(" + CLICK_CODEX.toString() + ")()");
    await waitFor("!!document.querySelector('.codex .track')", 30000, "图鉴卡片");
    // 让图鉴进入可视区（波形按需渲染），再滚动一遍触发所有懒加载
    for (let k = 0; k < 6; k++) {
      await evalJs("window.scrollBy(0,1400)");
      await new Promise((r) => setTimeout(r, 350));
    }
    await new Promise((r) => setTimeout(r, 2500));

    const tracks = await evalJs("(" + READ_CODEX.toString() + ")()");
    console.error(`读到 ${tracks.length} 张音效卡`);

    const soundIds = await evalJs(
      "[...document.querySelectorAll('.codex-body .track')].map(n=>n.getAttribute('data-sound'))"
    );
    console.error("soundIds:", soundIds.join(","));

    const codex = [];
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const soundId = soundIds[i];
      // 点击该音效卡，读取右侧舞台详情
      await evalJs(`[...document.querySelectorAll('.codex-body .track')][${i}].click()`);
      await waitFor(
        `document.querySelector('.stage-title') && document.querySelector('.stage-title').textContent.includes(${JSON.stringify(
          track.no.replace(/^0+/, "")
        )}) || !!document.querySelector('.stage .item-name')`,
        15000,
        "详情渲染"
      );
      await new Promise((r) => setTimeout(r, 250));
      const detail = await evalJs("(" + READ_DETAIL.toString() + ")()");
      codex.push({
        soundId: String(soundId),
        no: track.no,
        label: track.name,
        countText: track.countText,
        previewThumbs: track.thumbs,
        ...detail,
      });
      console.error(`  ${track.no} soundId=${soundId} -> ${detail.title} ${detail.items.length} 件`);
    }

    const payload = { scrapedAt: new Date().toISOString(), source: PAGE, codex };
    mkdirSync("data", { recursive: true });
    writeFileSync(OUT, JSON.stringify(payload, null, 2));
    console.error(`已写入 ${OUT}`);
    console.log(JSON.stringify(payload));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
