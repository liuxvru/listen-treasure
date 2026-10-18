// 实时监视台（桌面）E2E：真跑 listen_treasure/ui/live.html，逐项断言布局与交互。
// 用法：node tests/live_page_e2e.mjs
//   BASE  = 服务地址（默认 http://127.0.0.1:8760）
//   SHOTS = 截图目录（默认 tests/shots/）
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launch, makeRunner } from "./cdp.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:8760";
const PAGE = `${BASE}/static/ui/live.html`;
const SHOT_DIR = process.env.SHOTS || fileURLToPath(new URL("./shots/", import.meta.url));
const WAV_URL = new URL("../data/sounds/5.wav", import.meta.url);
const WAV_PATH = fileURLToPath(WAV_URL);

const VIEW_W = 1440;
const VIEW_H = 900;

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail == null ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
}

async function shot(send, file) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const path = `${SHOT_DIR}\\${file}`;
  writeFileSync(path, Buffer.from(r.data, "base64"));
  return path;
}

const browser = await launch({ headless: true, width: VIEW_W, height: VIEW_H });
const { send, evalJs, waitFor } = makeRunner(browser.cdp);
const exceptions = [];
const consoleErrors = [];
const failedRequests = [];
let shotHits = "";

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable").catch(() => {});
  await send("Network.enable").catch(() => {});
  await send("Emulation.setDeviceMetricsOverride", {
    width: VIEW_W,
    height: VIEW_H,
    deviceScaleFactor: 1,
    mobile: false,
  });

  browser.cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type ?? "").join(" "));
    }
    if (msg.method === "Network.loadingFailed") {
      failedRequests.push(`${msg.params.type}:${msg.params.errorText}`);
    }
  });

  /* ---------- 0. 复位监听状态 ---------- */
  // 必须先到同源页面再 fetch（about:blank 没有 origin，相对路径会 parse 失败）
  await send("Page.navigate", { url: PAGE });
  await waitFor(`document.readyState === "complete"`, 20000, "首次页面加载");
  const reset = await evalJs(`(async () => {
    const r = await fetch("/api/live/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const d = await r.json().catch(() => ({}));
    const s = await (await fetch("/api/live/status")).json();
    return { ok: r.ok, hits: (d.hits || []).length, running: !!s.running };
  })()`);
  console.log(`· 已复位监听状态（迟到命中 ${reset.hits} 条，running=${reset.running}）`);

  /* ---------- 1. 打开页面 ---------- */
  await send("Page.navigate", { url: PAGE });
  await waitFor(`document.readyState === "complete"`, 20000, "页面加载");
  await waitFor(`document.querySelector("#verdict-name")?.textContent`, 15000, "判定卡初始化");
  await waitFor(`document.querySelectorAll(".level-bar").length === 40`, 15000, "电平条初始化");
  // 注意别只等 option >= 1：HTML 里的占位项「加载设备中…」会立刻满足它，要等真正分好组
  await waitFor(`document.querySelectorAll("#device-select optgroup").length >= 2`, 30000, "设备下拉初始化");
  const connOk = await waitFor(
    `(() => { const t = document.querySelector("#conn-text")?.textContent?.trim(); return t === "已连接" ? t : null; })()`,
    15000,
    "SSE 连接"
  ).catch(() => null);

  /* ---------- 2. 布局断言 ---------- */
  const layout = await evalJs(`(() => {
    const box = (sel) => { const n = document.querySelector(sel); return n ? n.getBoundingClientRect() : null; };
    const r = (rect) => rect ? { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
    const leftCol = document.querySelector("#left-col");
    const rightCol = document.querySelector("#right-col");
    const hitsPanel = document.querySelector("#hits-panel");
    const stashPanel = document.querySelector("#stash-panel");
    const filePanel = document.querySelector("#left-col .file-panel");
    const list = document.querySelector("#hits-list");
    const cs = (n) => n ? getComputedStyle(n) : null;
    return {
      winW: window.innerWidth,
      winH: window.innerHeight,
      list: r(box("#hits-list")),
      leftCol: r(box("#left-col")),
      rightCol: r(box("#right-col")),
      hitsPanel: r(box("#hits-panel")),
      stashPanel: r(box("#stash-panel")),
      filePanel: r(box("#left-col .file-panel")),
      cols: getComputedStyle(document.body).gridTemplateColumns,
      leftOverflow: cs(leftCol)?.overflowY,
      rightOverflow: cs(rightCol)?.overflowY,
      leftMinH: cs(leftCol)?.minHeight,
      rightMinH: cs(rightCol)?.minHeight,
      bodyH: Math.round(document.body.getBoundingClientRect().height),
      listOverflow: cs(list)?.overflowY,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      hitsIsInLeftCol: leftCol ? leftCol.contains(document.querySelector("#hits-list")) : null,
      stashInLeftCol: leftCol && stashPanel ? leftCol.contains(stashPanel) : null,
      hitsIsInRightCol: rightCol ? rightCol.contains(document.querySelector("#hits-panel")) : null,
      // --stash-unit 就是「一个占格小方格的边长」，卡片宽度按它乘占格算
      stashUnit: parseFloat(
        getComputedStyle(document.querySelector("#stash-rows")).getPropertyValue("--stash-unit")
      ) || 0,
      title: document.title,
      levelBars: document.querySelectorAll("#level-bars > *").length,
      deviceOptions: document.querySelectorAll("#device-select option").length,
      deviceGroups: [...document.querySelectorAll("#device-select optgroup")].map((g) => g.label),
      deviceValue: document.querySelector("#device-select")?.value,
      deviceText: document.querySelector("#device-select")?.selectedOptions[0]?.textContent?.trim(),
      liveLabel: document.querySelector("#live-label")?.textContent?.trim(),
      liveState: document.querySelector("#btn-live")?.dataset?.state,
    };
  })()`);

  // getComputedStyle 返回的是已解析的像素值（"998px 400px"），声明的 minmax(0,1fr) 要从样式表里读
  const declaredCols = await evalJs(`(() => {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule.selectorText === "body" && rule.style?.gridTemplateColumns) return rule.style.gridTemplateColumns;
      }
    }
    return "";
  })()`);
  check(
    "整页 grid 为 minmax(0,1fr) 400px 两栏",
    /minmax\(\s*0(px)?\s*,\s*1fr\s*\)/.test(declaredCols || "") && /400px/.test(declaredCols || "") &&
      layout.rightCol?.width === 400,
    `declared="${declaredCols}" computed="${layout.cols}" rightCol.width=${layout.rightCol?.width}`
  );
  check(
    "body 撑满一屏高度",
    Math.abs(layout.bodyH - layout.winH) <= 2,
    `bodyH=${layout.bodyH} winH=${layout.winH}`
  );
  check(
    "左右两栏各自独立滚动（min-height:0 + overflow-y:auto）",
    layout.leftOverflow === "auto" && layout.rightOverflow === "auto" &&
      layout.leftMinH === "0px" && layout.rightMinH === "0px",
    `left=${layout.leftOverflow}/${layout.leftMinH} right=${layout.rightOverflow}/${layout.rightMinH}`
  );
  check(
    "命中记录在右半屏（#hits-list.left > 窗口宽度一半）",
    layout.list && layout.list.left > layout.winW / 2,
    `hits-list.left=${layout.list?.left} winW/2=${layout.winW / 2}`
  );
  check(
    "#hits-list 不在左栏里（left > 左栏右边界）",
    layout.list && layout.leftCol && layout.list.left > layout.leftCol.right &&
      layout.hitsIsInLeftCol === false,
    `hits-list.left=${layout.list?.left} leftCol.right=${layout.leftCol?.right} contains=${layout.hitsIsInLeftCol}`
  );
  check(
    "右栏只剩命中记录（#hits-panel 占满右栏，藏品面板已挪到左栏）",
    layout.hitsPanel && layout.rightCol && layout.stashPanel &&
      layout.stashInLeftCol === true &&
      layout.hitsIsInRightCol === true &&
      layout.hitsPanel.height >= layout.rightCol.height * 0.9 &&
      layout.listOverflow === "auto",
    `stashInLeftCol=${layout.stashInLeftCol} hitsInRight=${layout.hitsIsInRightCol} ` +
      `hitsPanel.h=${layout.hitsPanel?.height} rightCol.h=${layout.rightCol?.height} listOverflowY=${layout.listOverflow}`
  );
  check(
    "本次藏品面板在左栏文件识别下方，且 --stash-unit 已放大到 >= 40px",
    layout.stashPanel && layout.filePanel && layout.stashPanel.top >= layout.filePanel.bottom - 1 &&
      layout.stashUnit >= 40,
    `file.bottom=${layout.filePanel?.bottom} stash.top=${layout.stashPanel?.top} --stash-unit=${layout.stashUnit}px`
  );
  check(
    "设备下拉选项数 >= 1",
    layout.deviceOptions >= 1,
    `options=${layout.deviceOptions} groups=${JSON.stringify(layout.deviceGroups)} value="${layout.deviceValue}" text="${layout.deviceText}"`
  );
  check(
    "设备下拉含系统回环/麦克风分组",
    layout.deviceGroups.some((g) => /回环/.test(g || "")) && layout.deviceGroups.some((g) => /麦克风/.test(g || "")),
    `groups=${JSON.stringify(layout.deviceGroups)}`
  );
  check("#level-bars 子元素数 == 40", layout.levelBars === 40, `bars=${layout.levelBars}`);
  check(
    "宽屏无横向溢出",
    layout.docScrollW <= layout.docClientW + 1,
    `scrollW=${layout.docScrollW} clientW=${layout.docClientW}`
  );
  check("SSE 连上后 #conn-text 显示「已连接」", connOk === "已连接", `connText="${connOk}"`);
  check(
    "初始按钮为「开始监听」且命中记录为空态",
    layout.liveLabel === "开始监听" && layout.liveState === "idle",
    `label="${layout.liveLabel}" state=${layout.liveState}`
  );

  /* ---------- 3. 命中记录面板结构 ---------- */
  const structure = await evalJs(`(() => {
    const panel = document.querySelector("#hits-panel");
    const head = panel?.querySelector("h2");
    const btn = document.querySelector("#btn-clear-hits");
    const list = document.querySelector("#hits-list");
    const empty = document.querySelector("#hits-empty");
    return {
      h2: head?.textContent?.trim(),
      btnText: btn?.textContent?.trim(),
      btnInPanel: panel ? panel.contains(btn) : false,
      listTag: list?.tagName,
      listInPanel: panel ? panel.contains(list) : false,
      emptyClass: empty?.className,
      emptyTag: empty?.tagName,
      emptyText: empty?.textContent?.trim(),
      emptyInList: list && empty ? list.contains(empty) : false,
      hasVerdictName: !!document.querySelector("#verdict-name"),
      hasVerdictFacts: !!document.querySelector("#verdict-facts"),
      hasVerdictCount: !!document.querySelector("#verdict-count"),
      hasDeviceSelect: !!document.querySelector("#device-select"),
      hasBtnLive: !!document.querySelector("#btn-live"),
      hasBtnRefresh: !!document.querySelector("#btn-refresh"),
      hasLevelBars: !!document.querySelector("#level-bars"),
      hasFileInput: !!document.querySelector("#file-input"),
      hasStashRows: !!document.querySelector("#stash-rows"),
      hasConnText: !!document.querySelector("#conn-text"),
    };
  })()`);
  const idsOk =
    structure.hasVerdictName && structure.hasVerdictFacts && structure.hasVerdictCount &&
    structure.hasDeviceSelect && structure.hasBtnLive && structure.hasBtnRefresh &&
    structure.hasLevelBars && structure.hasFileInput && structure.hasStashRows &&
    structure.hasConnText;
  check(
    "必须的 id 全部存在",
    idsOk,
    JSON.stringify(structure)
  );
  check(
    "命中记录面板结构（h2 + 清空按钮 + ul#hits-list + 空态 li）",
    structure.h2 === "命中记录" && structure.btnText === "清空" && structure.btnInPanel &&
      structure.listTag === "UL" && structure.listInPanel && structure.emptyTag === "LI" &&
      structure.emptyClass === "hits-empty" && /还没有命中/.test(structure.emptyText || "") &&
      structure.emptyInList,
    JSON.stringify(structure)
  );

  /* ---------- 4. 文件识别（DataTransfer 造 File，字节取 data/sounds/5.wav） ---------- */
  if (!existsSync(WAV_PATH)) throw new Error(`找不到测试音频：${WAV_PATH}`);
  const wavB64 = readFileSync(WAV_PATH).toString("base64");
  console.log(`· 测试音频 ${WAV_PATH}（${readFileSync(WAV_PATH).length} 字节，base64 ${wavB64.length} 字符）`);
  await evalJs(`window.__E2E_WAV_B64 = ${JSON.stringify(wavB64)}; true`);

  const t0 = Date.now();
  await evalJs(`(() => {
    const bin = atob(window.__E2E_WAV_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "5.wav", { type: "audio/wav" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector("#file-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { files: input.files.length, size: file.size };
  })()`);

  // 等识别结果落到判定卡 + 命中记录；要求 3 秒内完成
  const recognized = await waitFor(
    `(() => {
      const name = document.querySelector("#verdict-name")?.textContent?.trim() || "";
      const rows = document.querySelectorAll("#hits-list .hit-row").length;
      if (!name.includes("拾取音效 05")) return null;
      if (rows < 1) return null;
      const first = document.querySelector("#hits-list .hit-row");
      return {
        name,
        rows,
        time: first?.querySelector(".hit-time")?.textContent?.trim(),
        hitName: first?.querySelector(".hit-name")?.textContent?.trim(),
        conf: first?.querySelector(".hit-conf")?.textContent?.trim(),
        dataId: first?.dataset?.id,
        facts: document.querySelector("#verdict-facts")?.textContent?.trim(),
        barW: document.querySelector("#verdict-bar-fill")?.style?.width,
        verdictHas: document.querySelector("#verdict-panel")?.dataset?.has,
        stashRows: document.querySelectorAll("#stash-rows .stash-row").length,
        stashHint: document.querySelector("#stash-hint")?.textContent?.trim(),
        countText: document.querySelector("#verdict-count")?.textContent?.trim(),
      };
    })()`,
    12000,
    "文件识别结果"
  );
  const elapsed = Date.now() - t0;

  check(
    "上传后 #verdict-name 在 3 秒内变为「拾取音效 05」",
    recognized.name.includes("拾取音效 05") && elapsed <= 3000,
    `name="${recognized.name}" elapsed=${elapsed}ms`
  );
  check(
    "命中记录 >= 1 行且首行 .hit-name 含「拾取音效 05」",
    recognized.rows >= 1 && /拾取音效 05/.test(recognized.hitName || ""),
    JSON.stringify({ rows: recognized.rows, hitName: recognized.hitName, dataId: recognized.dataId, conf: recognized.conf })
  );
  check(
    "首行 .hit-time 为 mm:ss.mmm",
    /^\d{2}:\d{2}\.\d{3}$/.test(recognized.time || ""),
    `time="${recognized.time}"`
  );
  check(
    "首行 .hit-row 的 data-id 为音效 id",
    recognized.dataId === "5",
    `data-id="${recognized.dataId}"`
  );
  check(
    "判定卡同步显示相似度/置信度/领先与进度条",
    /相似度/.test(recognized.facts || "") && /置信度/.test(recognized.facts || "") &&
      /领先/.test(recognized.facts || "") && recognized.verdictHas === "true" &&
      parseFloat(recognized.barW || "0") > 0,
    `facts="${recognized.facts}" barW=${recognized.barW} has=${recognized.verdictHas}`
  );
  check(
    "本次藏品按占格分组渲染",
    recognized.stashRows >= 2,
    `rows=${recognized.stashRows} hint="${recognized.stashHint}"`
  );

  shotHits = await shot(send, "live1-right-hits.png");
  console.log(`· 截图：${shotHits}`);

  // 命中列表首行在最上面（最新一条）
  const order = await evalJs(`(() => {
    const rows = [...document.querySelectorAll("#hits-list .hit-row")];
    if (!rows.length) return null;
    const list = document.querySelector("#hits-list").getBoundingClientRect();
    const first = rows[0].getBoundingClientRect();
    const last = rows[rows.length - 1].getBoundingClientRect();
    return {
      count: rows.length,
      firstTop: Math.round(first.top),
      lastTop: Math.round(last.top),
      listTop: Math.round(list.top),
      nearestToTop: Math.abs(first.top - list.top) <= Math.abs(last.top - list.top),
      max: rows.length <= 50,
    };
  })()`);
  check(
    "命中记录最新一条在最上面，且不超过 50 条",
    order && order.nearestToTop && order.max && order.count >= 1,
    JSON.stringify(order)
  );

  /* ---------- 5. 停止后判定不被 lastVerdict=null 擦掉 ---------- */
  await evalJs(`document.querySelector("#btn-live").click()`);
  const started = await waitFor(
    `(async () => {
      const s = await (await fetch("/api/live/status")).json();
      if (!s.running) return null;
      return { running: s.running, label: document.querySelector("#live-label")?.textContent?.trim(), state: document.querySelector("#btn-live")?.dataset?.state };
    })()`,
    25000,
    "开始监听"
  );
  check(
    "点开始后按钮变「停止监听」",
    started.label === "停止监听" && started.state === "running",
    JSON.stringify(started)
  );

  await evalJs(`document.querySelector("#btn-live").click()`);
  const stopped = await waitFor(
    `(async () => {
      const s = await (await fetch("/api/live/status")).json();
      if (s.running) return null;
      return {
        running: s.running,
        lastVerdict: s.lastVerdict,
        label: document.querySelector("#live-label")?.textContent?.trim(),
        state: document.querySelector("#btn-live")?.dataset?.state,
      };
    })()`,
    25000,
    "停止监听"
  );
  check(
    "点停止后按钮复原为「开始监听」",
    stopped.label === "开始监听" && stopped.state === "idle",
    JSON.stringify({ label: stopped.label, state: stopped.state })
  );

  // 观察 800ms：SSE 会持续推 type=status（lastVerdict 可能是 null），判定文本不应被改写
  const steadiness = await evalJs(`(async () => {
    const node = document.querySelector("#verdict-name");
    const before = node.textContent.trim();
    let mutations = 0;
    const obs = new MutationObserver((list) => { mutations += list.length; });
    obs.observe(node, { childList: true, characterData: true, subtree: true });
    await new Promise((r) => setTimeout(r, 800));
    obs.disconnect();
    return {
      before,
      after: document.querySelector("#verdict-name").textContent.trim(),
      mutations,
      liveDevice: document.querySelector("#live-device")?.textContent?.trim(),
      liveElapsed: document.querySelector("#live-elapsed")?.textContent?.trim(),
      elapsed: document.querySelector("#verdict-count")?.textContent?.trim(),
      verdictState: document.querySelector("#verdict-state")?.textContent?.trim(),
    };
  })()`);
  check(
    "停止后判定保留，lastVerdict=null 不擦回「等待声音…」",
    steadiness.before.includes("拾取音效 05") &&
      steadiness.after.includes("拾取音效 05") &&
      steadiness.mutations === 0,
    JSON.stringify({ before: steadiness.before, after: steadiness.after, mutations: steadiness.mutations })
  );
  check(
    "顶栏设备/时长文案正常（不出现 [object Object]）",
    !/\[object /.test(steadiness.liveDevice || "") &&
      /^(\d{2}:\d{2}|\d+:\d{2}:\d{2})$/.test(steadiness.liveElapsed || "") &&
      /累计\s*\d+\s*次/.test(steadiness.elapsed || ""),
    JSON.stringify({ device: steadiness.liveDevice, elapsed: steadiness.liveElapsed, count: steadiness.elapsed, state: steadiness.verdictState })
  );

  /* ---------- 6. 清空命中 ---------- */
  const beforeClear = await evalJs(`document.querySelectorAll("#hits-list .hit-row").length`);
  await evalJs(`document.querySelector("#btn-clear-hits").click()`);
  const cleared = await evalJs(`(() => ({
    rows: document.querySelectorAll("#hits-list .hit-row").length,
    empty: document.querySelector("#hits-empty")?.textContent?.trim(),
    emptyInList: !!document.querySelector("#hits-list #hits-empty"),
  }))()`);
  check(
    "点清空后命中记录归零并显示空态",
    beforeClear >= 1 && cleared.rows === 0 && /还没有命中/.test(cleared.empty || "") && cleared.emptyInList,
    `before=${beforeClear} after=${cleared.rows} empty="${cleared.empty}"`
  );

  /* ---------- 7. 窄屏单列：无横向滚动条 ---------- */
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await new Promise((r) => setTimeout(r, 350));
  const narrow = await evalJs(`(() => {
    const doc = document.documentElement;
    const box = (sel) => { const n = document.querySelector(sel); return n ? n.getBoundingClientRect() : null; };
    const hitsPanel = box("#hits-panel");
    const stashPanel = box("#stash-panel");
    const topbar = box(".topbar");
    const widest = Math.max(0, ...[...document.querySelectorAll("body *")].map((n) => Math.round(n.getBoundingClientRect().right)));
    return {
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      bodyScrollW: document.body.scrollWidth,
      hitsLeft: Math.round(hitsPanel?.left ?? -1),
      hitsTop: Math.round(hitsPanel?.top ?? -1),
      stashTop: Math.round(stashPanel?.top ?? -1),
      topbarTop: Math.round(topbar?.top ?? -1),
      hitsWidth: Math.round(hitsPanel?.width ?? -1),
      widest,
      cols: getComputedStyle(document.body).gridTemplateColumns,
    };
  })()`);
  check(
    "窄屏（390×844）无横向滚动条",
    narrow.scrollW <= narrow.clientW,
    `scrollW=${narrow.scrollW} clientW=${narrow.clientW} bodyScrollW=${narrow.bodyScrollW} widestRight=${narrow.widest}`
  );
  check(
    "窄屏单列堆叠，命中记录挪到最后",
    narrow.hitsTop > narrow.stashTop && narrow.stashTop > narrow.topbarTop &&
      narrow.hitsWidth > 300,
    `topbar.top=${narrow.topbarTop} stash.top=${narrow.stashTop} hits.top=${narrow.hitsTop} hits.w=${narrow.hitsWidth} cols="${narrow.cols}"`
  );

  /* ---------- 8. 运行期错误 ---------- */
  const bad = failedRequests.filter((f) => !/favicon|ERR_ABORTED/.test(f));
  check("无未捕获 JS 异常", exceptions.length === 0, exceptions.join(" | "));
  check("无 console.error", consoleErrors.length === 0, consoleErrors.join(" | "));
  check("无失败的关键网络请求", bad.length === 0, bad.join(" | "));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n==== ${passed}/${results.length} 通过 ====`);
if (shotHits) console.log(`截图：${shotHits}`);
if (passed !== results.length) {
  console.log("");
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL: ${r.name} — ${r.detail}`);
  process.exitCode = 1;
}
