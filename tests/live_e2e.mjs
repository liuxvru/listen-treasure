// 浏览器侧：打开页面 → 点「开始监听」→ 等 SSE hit → 汇总命中记录 → 输出 JSON 结果
// 由 live_e2e.py 启动，播放由 Python 侧负责（pyaudiowpatch 回环）。
import { launch, makeRunner } from "./cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = process.env.BASE || "http://127.0.0.1:8760";

const browser = await launch({ headless: true, width: 1440, height: 1000 });
const { send, evalJs, waitFor } = makeRunner(browser.cdp);
const hardStop = setTimeout(() => {
  console.error("!! 浏览器脚本超时");
  process.exit(2);
}, 150000);

try {
  await send("Page.enable");
  await send("Runtime.enable");
  const errors = [];
  browser.cdp.on((m) => {
    if (m.method === "Runtime.exceptionThrown") {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });

  await send("Page.navigate", { url: BASE + "/" });
  await waitFor(`document.querySelectorAll("#card-grid .card").length >= 17`, 20000, "cards");
  await evalJs(`(() => { document.querySelector("#btn-clear-hits")?.click(); return true; })()`);
  await sleep(300);

  // 点「开始监听」
  await evalJs(`(() => { document.querySelector("#btn-live").click(); return true; })()`);
  console.log("[browser] 已点击开始监听");

  // 轮询命中记录，直到 17 条或超时 70s
  const t0 = Date.now();
  let rows = [];
  while (Date.now() - t0 < 70000) {
    rows = await evalJs(`[...document.querySelectorAll("#hits-list .hit-row")].map(n => ({
      id: n.dataset.id,
      text: n.textContent.replace(/\\s+/g, " ").trim(),
      name: n.querySelector(".hit-name")?.textContent?.trim() || "",
      time: n.querySelector(".hit-time")?.textContent?.trim() || "",
    }))`);
    if (rows.length >= 17) break;
    await sleep(400);
  }

  await sleep(1500); // 留点时间看有没有多余的误报
  rows = await evalJs(`[...document.querySelectorAll("#hits-list .hit-row")].map(n => ({
    id: n.dataset.id,
    name: n.querySelector(".hit-name")?.textContent?.trim() || "",
    time: n.querySelector(".hit-time")?.textContent?.trim() || "",
  }))`);
  const verdict = await evalJs(`({
    name: document.querySelector("#verdict-name")?.textContent?.trim() || "",
    facts: document.querySelector("#verdict-facts")?.textContent?.trim() || "",
    count: document.querySelector("#verdict-count")?.textContent?.trim() || "",
    has: document.querySelector("#verdict-panel")?.dataset.has || "",
  })`);
  const status = await evalJs(`({
    text: document.querySelector("#status-text")?.textContent?.trim() || "",
    level: document.querySelector("#level-readout")?.textContent?.trim() || "",
    label: document.querySelector("#live-label")?.textContent?.trim() || "",
    device: document.querySelector("#live-device")?.textContent?.trim() || "",
    elapsed: document.querySelector("#live-elapsed")?.textContent?.trim() || "",
  })`);

  // 截图存档
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("./shots/p5-live-hits.png", import.meta.url), Buffer.from(shot.data, "base64"));

  // 停止监听
  await evalJs(`(() => { document.querySelector("#btn-live")?.click(); return true; })()`);
  await sleep(1200);
  const stopped = await evalJs(`(async () => (await (await fetch("/api/live/status")).json()).running)()`);

  const ids = rows.map((r) => String(r.id));
  const expected = Array.from({ length: 17 }, (_, i) => String(i + 1));
  const result = {
    count: rows.length,
    ids,
    orderOk: JSON.stringify(ids) === JSON.stringify(expected),
    missing: expected.filter((e) => !ids.includes(e)),
    extra: ids.filter((i) => !expected.includes(i)),
    dupes: ids.filter((v, i) => ids.indexOf(v) !== i),
    rows,
    verdict,
    status,
    stopped,
    errors,
  };
  console.log("RESULT_JSON " + JSON.stringify(result));
  console.log(
    `\n===== 命中 ${result.count}/17 · 顺序${result.orderOk ? "正确" : "错误"} · ` +
      `漏检[${result.missing.join(",")}] · 多余[${result.extra.join(",")}] · 重复[${result.dupes.join(",")}] =====`
  );
  console.log(`当前判定: ${verdict.name} | ${verdict.facts} | ${verdict.count}`);
  console.log(`顶栏: ${status.text} | 电平 ${status.level} | 按钮 ${status.label} | 设备 ${status.device}`);
  if (errors.length) console.log("JS 异常:\n" + errors.join("\n").slice(0, 2000));
  process.exitCode = result.count === 17 && result.orderOk && !result.missing.length && !result.dupes.length && !errors.length ? 0 : 1;
} catch (e) {
  console.error("失败:", e?.stack || e?.message || String(e));
  process.exitCode = 1;
} finally {
  clearTimeout(hardStop);
  try { await browser.close(); } catch {}
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref?.();
}
