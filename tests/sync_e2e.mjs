// 验证桌面版新加的两块 UI：同步图鉴按钮 + 手机二维码面板。
// 因为真爬一次要 2~3 分钟且会改动 data/，这里只验证：
//   1. 两块 DOM 都在、二维码图片真的加载出来了（naturalWidth > 0）
//   2. 点按钮会真的发出 POST /api/sync，按钮进入 busy 态并显示进度文案
//   3. 点完立刻再点一次不会重复开任务（后端返回 alreadyRunning）
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { launch, makeRunner } from "./cdp.mjs";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE || "http://127.0.0.1:8760";
const SHOT_DIR = process.env.SHOTS || fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail == null ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
}

const browser = await launch({ headless: true, width: 1440, height: 950 });
const { send, evalJs, waitFor } = makeRunner(browser.cdp);
const exceptions = [];
try {
  await send("Page.enable");
  await send("Runtime.enable");
  browser.cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    }
  });

  await send("Page.navigate", { url: `${BASE}/` });
  await waitFor(`document.readyState === "complete"`, 20000, "页面加载");
  await waitFor(`document.querySelector("#btn-sync") !== null`, 10000, "同步按钮存在");
  // 等二维码图片 decode 完
  await waitFor(
    `(() => { const img = document.querySelector("#phone-qr img"); return img && img.complete && img.naturalWidth > 0; })()`,
    15000,
    "二维码图片加载"
  );

  const panel = await evalJs(`(() => {
    const img = document.querySelector("#phone-qr img");
    const panelEl = document.querySelector("#phone-panel");
    return {
      qrSrc: img ? img.getAttribute("src") : null,
      naturalW: img ? img.naturalWidth : 0,
      naturalH: img ? img.naturalHeight : 0,
      url: document.querySelector("#phone-url")?.textContent?.trim(),
      tip: document.querySelector("#phone-tip")?.textContent?.trim(),
      reachable: panelEl?.dataset?.reachable,
      syncLabel: document.querySelector("#sync-label")?.textContent?.trim(),
    };
  })()`);
  check(
    "二维码图片真的加载出来了",
    panel.naturalW > 0 && panel.naturalH > 0,
    `src=${panel.qrSrc} ${panel.naturalW}×${panel.naturalH}`
  );
  check(
    "手机端地址正确且标记为可达",
    /^http:\/\/(?!127\.|localhost)[\w.-]+:\d+\/m$/.test(panel.url || "") && panel.reachable === "true",
    `url=${panel.url} reachable=${panel.reachable}`
  );
  check("按钮初始文案", panel.syncLabel === "同步图鉴", `"${panel.syncLabel}"`);

  // 点同步：会真的发起 POST /api/sync
  const posted = await evalJs(`(() => {
    window.__syncCalls = [];
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const u = typeof input === "string" ? input : (input && input.url) || "";
      if (String(u).includes("/api/sync")) window.__syncCalls.push({ u: String(u), m: (init && init.method) || "GET" });
      return orig.apply(this, arguments);
    };
    document.querySelector("#btn-sync").click();
    return true;
  })()`);
  void posted;

  const busy = await waitFor(
    `(() => {
      const btn = document.querySelector("#btn-sync");
      const label = document.querySelector("#sync-label")?.textContent?.trim() || "";
      if (btn?.dataset?.busy !== "true") return null;
      return {
        busy: btn.dataset.busy,
        disabled: btn.disabled,
        label,
        calls: window.__syncCalls,
        serverRunning: null,
      };
    })()`,
    15000,
    "按钮进入 busy 态"
  );
  check(
    "点按钮后进入抓取态且发出 POST /api/sync",
    busy.busy === "true" &&
      busy.disabled === true &&
      /抓取中/.test(busy.label) &&
      (busy.calls || []).some((c) => c.m === "POST"),
    `busy=${busy.busy} disabled=${busy.disabled} label="${busy.label}" calls=${JSON.stringify(busy.calls)}`
  );

  // 后端确实在跑
  const serverSide = await evalJs(`(async () => (await (await fetch("/api/sync/status")).json()))()`);
  check(
    "后端 /api/sync/status 显示 running",
    serverSide.running === true || serverSide.progress > 0,
    JSON.stringify({ running: serverSide.running, progress: serverSide.progress, message: serverSide.message })
  );

  await send("Page.captureScreenshot", { format: "png" }).then((r) => {
    writeFileSync(`${SHOT_DIR}\\d1-sync-phone.png`, Buffer.from(r.data, "base64"));
  });

  // 重复点击保护：再点一次不应再发 POST（按钮 disabled），后端也不会开第二个任务
  const before = (await evalJs(`(async () => (await (await fetch("/api/sync/status")).json()))()`)).startedAt;
  await evalJs(`document.querySelector("#btn-sync").click()`);
  await new Promise((r) => setTimeout(r, 1200));
  const after = await evalJs(`(async () => {
    const s = await (await fetch("/api/sync/status")).json();
    return { startedAt: s.startedAt, calls: window.__syncCalls.length };
  })()`);
  check(
    "抓取中重复点击不会重开任务",
    after.startedAt === before,
    `startedAt ${before} -> ${after.startedAt}, fetch calls=${after.calls}`
  );

  check("无未捕获 JS 异常", exceptions.length === 0, exceptions.join(" | "));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n==== ${passed}/${results.length} 通过 ====`);
if (passed !== results.length) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL: ${r.name} — ${r.detail}`);
  process.exitCode = 1;
}
