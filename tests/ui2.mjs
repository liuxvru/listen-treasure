// 真实浏览器验收：无头 Chrome 打开 http://127.0.0.1:8760/ ，走一遍前端主流程并截图。
// 只用 Node 内置能力（见 cdp.mjs）。
import { launch, makeRunner } from "./cdp.mjs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const URL_BASE = process.env.BASE || "http://127.0.0.1:8760";
const SHOT_DIR = process.env.SHOTS || fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 整体硬超时，避免像上次那样挂住
const hardStop = setTimeout(() => {
  console.error("!! 整体超时 180s，强制退出");
  process.exit(2);
}, 180000);
hardStop.unref?.();

// 先把后端从上一轮残留的「监听中」状态里拉回来。
// 否则页面一打开就是监听中，第 9 步点按钮变成「停止」，后面全都反了。
async function resetLive() {
  try {
    const r = await fetch(URL_BASE + "/api/live/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const j = await r.json();
    console.log(`· 已复位监听状态（running=false, 迟到命中 ${(j.hits || []).length} 条）`);
  } catch (e) {
    console.log(`· 复位监听状态失败（忽略）：${e.message}`);
  }
}
await resetLive();

let browser;
try {
  browser = await launch({ headless: true, width: 1440, height: 1000 });
  const { send, evalJs, waitFor } = makeRunner(browser.cdp);

  const errors = [];
  const consoleErrors = [];
  browser.cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
    }
  });

  await send("Runtime.enable");
  await send("Log.enable").catch(() => {});
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  });

  await send("Page.navigate", { url: URL_BASE + "/" });
  await waitFor(`document.readyState === "complete"`, 20000, "页面加载");

  // 1. 声音库渲染出 17 张卡
  const cards = await waitFor(
    `(() => { const g = document.querySelector("#card-grid"); if (!g) return 0; const n = g.querySelectorAll(".card, [data-id]").length; return n >= 17 ? n : 0; })()`,
    20000,
    "17 张声音卡"
  );
  check("声音图鉴渲染 17 张卡", cards >= 17, `实际 ${cards}`);

  // 2. 顶部统计 + 连接状态
  const health = await evalJs(`(async () => {
    const r = await fetch("/api/health"); return await r.json();
  })()`);
  check("health 接口可用", health.ok === true && health.sounds === 17, JSON.stringify(health));

  const statusText = await evalJs(`document.querySelector("#status-text")?.textContent?.trim() || ""`);
  check("顶栏状态不是「正在连接…」", statusText && !statusText.includes("正在连接"), `"${statusText}"`);

  const pillSounds = await evalJs(`document.querySelector("#pill-sounds")?.textContent?.trim() || ""`);
  check("统计药丸显示段音效数", /17/.test(pillSounds), `"${pillSounds}"`);

  // 3. 设备下拉已填充
  const devOpts = await evalJs(`(() => {
    const s = document.querySelector("#device-select");
    return { n: s ? s.querySelectorAll("option").length : 0, first: s?.options?.[0]?.textContent?.trim() || "" };
  })()`);
  check("设备下拉已填充", devOpts.n >= 2, JSON.stringify(devOpts));

  await send("Page.captureScreenshot", { format: "png" }).then(async (r) => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${SHOT_DIR}\\p1-initial.png`, Buffer.from(r.data, "base64"));
  });

  // 4. 搜索过滤
  await evalJs(`(() => {
    const i = document.querySelector("#search-input");
    i.value = "鎏金";
    i.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(600);
  const searched = await evalJs(`(() => {
    const g = document.querySelector("#card-grid");
    return { visible: g.querySelectorAll(".card:not([hidden]), [data-id]:not([hidden])").length, empty: !document.querySelector("#empty-state")?.hidden };
  })()`);
  check("搜索「鎏金」有结果", searched.visible >= 1, JSON.stringify(searched));

  await evalJs(`(() => {
    const b = document.querySelector("#search-clear") || document.querySelector("#btn-reset-search");
    b?.click(); return true;
  })()`);
  await sleep(500);

  // 5. 文件识别：把 /api/sounds/5.wav 造成 File 塞进 input
  await evalJs(`(() => {
    window.__hitLog = [];
    const ul = document.querySelector("#hits-list");
    if (ul) new MutationObserver(() => {
      const txt = ul.textContent || "";
      if (txt) window.__hitLog.push(txt);
    }).observe(ul, { childList: true, subtree: true, characterData: true });
    return true;
  })()`);

  await evalJs(`(async () => {
    const blob = await (await fetch("/api/sounds/5.wav")).blob();
    const f = new File([blob], "probe-5.wav", { type: "audio/wav" });
    const dt = new DataTransfer();
    dt.items.add(f);
    const input = document.querySelector("#file-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);

  const recognized = await waitFor(
    `(() => {
      const hits = document.querySelector("#hits-list")?.textContent || "";
      return /拾取音效\\s*0?5|音效\\s*0?5/.test(hits) ? hits.replace(/\\s+/g, " ").slice(0, 160) : "";
    })()`,
    30000,
    "文件识别结果出现在命中记录"
  );
  check("文件识别 wav#5 → 命中记录出现 #05", true, recognized);

  const verdictName = await evalJs(`document.querySelector("#verdict-name")?.textContent?.trim() || ""`);
  check("当前判定已更新", !!verdictName && !verdictName.includes("等待"), `"${verdictName}"`);

  const verdictCount = await evalJs(`document.querySelector("#verdict-count")?.textContent?.trim() || ""`);
  // 开跑前已经复位成 running=false，累计应从 0 开始，文件识别一次就是 1。
  const countNum = Number((verdictCount.match(/(\d+)/) || [])[1]);
  check("累计次数已 +1", countNum === 1, `"${verdictCount}"`);

  // 5.5 本次藏品面板：识别到 #5 后应按占格分组、同占格一行、行内价值降序
  const stash = await evalJs(`(async () => {
    const panel = document.querySelector("#stash-panel");
    const box = document.querySelector("#stash-rows");
    if (!panel || !box) return { ok: false, why: "找不到 #stash-panel/#stash-rows" };
    const rows = [...box.querySelectorAll(".stash-row")].map((row) => {
      const tiles = [...row.querySelectorAll(".stash-tile")];
      return {
        badge: row.querySelector(".stash-badge")?.textContent?.trim() || "",
        count: row.querySelector(".stash-row-count")?.textContent?.trim() || "",
        top: row.querySelector(".stash-row-top")?.textContent?.trim() || "",
        sizes: tiles.map((t) => t.dataset.size || ""),
        values: tiles.map((t) => Number(t.dataset.value) || 0),
        names: tiles.map((t) => t.dataset.name || ""),
        // 用 offsetTop 判断是否同一行：入场动画的 transform 会污染 getBoundingClientRect
        tops: [...new Set(tiles.map((t) => t.offsetTop))],
        // 这一行是否横向排列（没有折行）：左侧位置严格递增
        lefts: tiles.map((t) => t.offsetLeft),
      };
    });
    const rowsSorted = rows.every((r) => r.values.every((v, i) => i === 0 || v <= r.values[i - 1]));
    const singleLine = rows.every((r) => r.tops.length <= 1);
    const noWrap = rows.every((r) => r.lefts.every((x, i) => i === 0 || x > r.lefts[i - 1]));
    const sizesConsistent = rows.every((r) => r.sizes.every((s) => s === r.sizes[0]));
    const areas = rows.map((r) => {
      const [w, h] = (r.badge || "1×1").split("×").map(Number);
      return (w || 1) * (h || 1);
    });
    const rowsByArea = areas.every((a, i) => i === 0 || a <= areas[i - 1]);
    return {
      has: panel.dataset.has,
      hint: document.querySelector("#stash-hint")?.textContent?.trim() || "",
      rows: rows.length,
      rowBadges: rows.map((r) => r.badge + "/" + r.count),
      tiles: rows.reduce((n, r) => n + r.sizes.length, 0),
      rowsSorted, singleLine, noWrap, sizesConsistent, rowsByArea, areas,
      firstRow: rows[0] ? { badge: rows[0].badge, names: rows[0].names, values: rows[0].values } : null,
      empty: !!box.querySelector(".stash-empty"),
    };
  })()`);
  check(
    "本次藏品面板已按占格分组渲染",
    stash.ok !== false && stash.has === "true" && stash.rows >= 2 && stash.tiles >= 4,
    JSON.stringify(stash)
  );
  check(
    "同一占格的藏品排在同一行、行内价值从高到低",
    stash.ok !== false &&
      stash.sizesConsistent === true &&
      stash.rowsSorted === true &&
      stash.singleLine === true &&
      stash.noWrap === true,
    `sizesConsistent=${stash.sizesConsistent} rowsSorted=${stash.rowsSorted} singleLine=${stash.singleLine} noWrap=${stash.noWrap}`
  );
  check(
    "占格大的行排在上面（3×2 → 2×2 → 2×1 → 1×1）",
    stash.ok !== false && stash.rowsByArea === true && stash.rows >= 3,
    `rowsByArea=${stash.rowsByArea} areas=${JSON.stringify(stash.areas)} badges=${JSON.stringify(stash.rowBadges)}`
  );

  await send("Page.captureScreenshot", { format: "png" }).then(async (r) => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${SHOT_DIR}\\p2b-stash.png`, Buffer.from(r.data, "base64"));
  });

  // 6. 卡片「刚刚识别」高亮
  const flashed = await evalJs(`(() => {
    const g = document.querySelector("#card-grid");
    const hit = g.querySelector('[class*="flash"], [class*="recognized"], [data-hit="true"], .is-hit');
    return hit ? (hit.className + " | " + (hit.textContent || "").replace(/\\s+/g, " ").slice(0, 60)) : "";
  })()`);
  check("被识别的卡片有高亮标记", !!flashed, flashed);

  await send("Page.captureScreenshot", { format: "png" }).then(async (r) => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${SHOT_DIR}\\p2-recognized.png`, Buffer.from(r.data, "base64"));
  });

  // 7. 展开藏品（用计算样式判断，textContent 长度不会变——隐藏的 codex-list 也在 DOM 里）
  const expanded = await evalJs(`(async () => {
    const g = document.querySelector("#card-grid");
    const card = g.querySelector(".card, [data-id]");
    const btn = card.querySelector(".card-expand") || [...card.querySelectorAll("button")].find(b => /展开|全部|藏品/.test(b.textContent || ""));
    if (!btn) return { ok: false, why: "找不到展开按钮", btns: [...card.querySelectorAll("button")].map(b => b.textContent.trim()).slice(0, 8) };
    const list = card.querySelector(".codex-list");
    const before = list ? getComputedStyle(list).display : "n/a";
    const rows = list ? list.querySelectorAll(".codex-row").length : 0;
    btn.click();
    await new Promise(r => setTimeout(r, 500));
    const after = list ? getComputedStyle(list).display : "n/a";
    const h = list ? Math.round(list.getBoundingClientRect().height) : 0;
    return { ok: before === "none" && after !== "none" && h > 50,
             before, after, h, rows, cls: card.className, btnText: btn.textContent.trim() };
  })()`);
  check("卡片可展开藏品清单", expanded.ok === true, JSON.stringify(expanded));

  // 8. 试听按钮：音效只有 0.5~0.9s，必须在播完之前采样，否则按钮已经复位
  const listen = await evalJs(`(async () => {
    const g = document.querySelector("#card-grid");
    const btn = [...g.querySelectorAll("button")].find(b => /试听/.test(b.textContent || ""));
    if (!btn) return { ok: false, why: "no btn" };
    const errsBefore = document.querySelectorAll("#error-stack > *").length;
    btn.click();
    // 每 50ms 采样 600ms，抓「播放中」状态
    let sawPlaying = false, sawText = "";
    for (let i = 0; i < 12; i += 1) {
      await new Promise(r => setTimeout(r, 50));
      if (btn.classList.contains("playing") || /播放中/.test(btn.textContent || "")) {
        sawPlaying = true; sawText = btn.textContent.trim(); break;
      }
    }
    const errs = [...document.querySelectorAll("#error-stack > *")].map(n => n.textContent.trim());
    return { ok: true, sawPlaying, sawText, newErrs: errs.slice(errsBefore) };
  })()`);
  check(
    "试听按钮进入播放态且不报错",
    listen.ok === true && listen.sawPlaying === true && (listen.newErrs || []).length === 0,
    JSON.stringify(listen)
  );

  // 9. 开始监听（真实 WASAPI 回环）→ 状态变化 → 停止
  const liveStart = await evalJs(`(async () => {
    const b = document.querySelector("#btn-live");
    if (!b) return { ok: false, why: "no btn-live" };
    b.click();
    return { ok: true };
  })()`);
  await sleep(2500);
  const liveStatus = await evalJs(`(async () => {
    const r = await fetch("/api/live/status"); const j = await r.json();
    return { running: j.running, device: j.device, frames: j.frames, levelDb: j.meter?.levelDb,
             btn: document.querySelector("#btn-live")?.textContent?.trim() || "",
             label: document.querySelector("#live-label")?.textContent?.trim() || "" };
  })()`);
  check("点击开始监听后后端进入 running", liveStatus.running === true, JSON.stringify(liveStatus));

  await send("Page.captureScreenshot", { format: "png" }).then(async (r) => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${SHOT_DIR}\\p3-live.png`, Buffer.from(r.data, "base64"));
  });

  // 停止监听
  await evalJs(`(() => { document.querySelector("#btn-live")?.click(); return true; })()`);
  await sleep(1500);
  const liveStop = await evalJs(`(async () => (await (await fetch("/api/live/status")).json()).running)()`);
  check("点击停止监听后后端 running=false", liveStop === false, String(liveStop));

  // 10. 清空命中
  await evalJs(`(() => { document.querySelector("#btn-clear-hits")?.click(); return true; })()`);
  await sleep(500);
  const cleared = await evalJs(`document.querySelector("#hits-list")?.textContent?.trim() || ""`);
  check("清空命中记录生效", !/拾取音效|音效\\s*\\d/.test(cleared), `"${cleared.slice(0, 60)}"`);

  // 11. 无 JS 异常
  check("无未捕获 JS 异常", errors.length === 0, errors.slice(0, 3).join(" | "));
  check("无 console.error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  // 12. 响应式：窄屏不溢出
  await send("Emulation.setDeviceMetricsOverride", {
    width: 760, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(700);
  const overflow = await evalJs(`({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  })`);
  check("窄屏(760px)无横向溢出", overflow.scrollW <= overflow.clientW + 2, JSON.stringify(overflow));
  await send("Page.captureScreenshot", { format: "png" }).then(async (r) => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${SHOT_DIR}\\p4-narrow.png`, Buffer.from(r.data, "base64"));
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  if (errors.length) console.log("JS 异常:\n" + errors.join("\n").slice(0, 3000));
  if (consoleErrors.length) console.log("console.error:\n" + consoleErrors.join("\n").slice(0, 2000));
} catch (e) {
  console.error("E2E 失败:", e?.stack || e?.message || String(e));
  process.exitCode = 1;
} finally {
  clearTimeout(hardStop);
  try { await browser?.close(); } catch {}
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref?.();
}
