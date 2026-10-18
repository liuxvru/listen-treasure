// 手机端 E2E：在 390×844 的移动视口里真跑 /m，逐项断言。
// 用法：node scratch\e2e\mobile_e2e.mjs
import { writeFileSync, mkdirSync } from "node:fs";
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

const browser = await launch({ headless: true, width: 390, height: 844 });
const { send, evalJs, waitFor } = makeRunner(browser.cdp);
const exceptions = [];
const consoleErrors = [];

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable").catch(() => {});
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  browser.cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description || "").join(" "));
    }
  });

  // 先导航到同源页面，然后用 fetch 复位监听状态，
  // 否则上一轮测试留下的 running=true 会让「开始/停止」按钮语义反过来。
  // （about:blank 没有源，fetch 相对路径会直接报 Failed to parse URL）
  await send("Page.navigate", { url: `${BASE}/m` });
  await waitFor(`document.readyState === "complete"`, 20000, "首次页面加载");
  const reset = await evalJs(`(async () => {
    const r = await fetch("/api/live/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const d = await r.json();
    return { ok: r.ok, hits: (d.hits || []).length };
  })()`);
  console.log(`· 已复位监听状态（迟到命中 ${reset.hits} 条）`);

  await send("Page.navigate", { url: `${BASE}/m` });
  await waitFor(`document.readyState === "complete"`, 20000, "页面加载");
  await waitFor(`document.querySelector("#verdict-name")?.textContent?.includes("等待声音")`, 15000, "判定卡初始化");
  await waitFor(`document.querySelector("#conn")?.dataset?.state === "ok"`, 15000, "SSE 连接");

  // 1. 基础渲染
  const basic = await evalJs(`(() => {
    const sel = document.querySelector("#device-select");
    const bars = document.querySelectorAll(".level-bar").length;
    const vp = document.querySelector('meta[name="viewport"]');
    return {
      title: document.title,
      viewport: vp ? vp.content : null,
      verdictName: document.querySelector("#verdict-name")?.textContent?.trim(),
      conn: document.querySelector("#conn")?.dataset?.state,
      connText: document.querySelector("#conn-text")?.textContent?.trim(),
      deviceOptions: sel ? sel.options.length : 0,
      deviceFirst: sel && sel.options[0] ? sel.options[0].textContent : null,
      deviceHint: document.querySelector("#device-hint")?.textContent?.trim(),
      bars,
      liveLabel: document.querySelector("#live-label")?.textContent?.trim(),
      hasStashEmpty: !!document.querySelector(".stash-empty"),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      bodyH: Math.round(document.body.getBoundingClientRect().height),
    };
  })()`);
  check(
    "页面标题/视口正确",
    basic.title === "听声鉴宝" && /width=device-width/.test(basic.viewport || ""),
    JSON.stringify({ title: basic.title, viewport: basic.viewport })
  );
  check(
    "设备下拉被填充",
    basic.deviceOptions >= 2 && /个回环/.test(basic.deviceHint || ""),
    `options=${basic.deviceOptions} first="${basic.deviceFirst}" hint="${basic.deviceHint}"`
  );
  check("电平条已创建", basic.bars === 40, `bars=${basic.bars}`);
  check("SSE 已连接", basic.conn === "ok" && basic.connText === "已连接", `conn=${basic.conn} "${basic.connText}"`);
  check(
    "窄屏无横向溢出",
    basic.scrollW <= basic.clientW + 1,
    `scrollW=${basic.scrollW} clientW=${basic.clientW}`
  );
  check("初始有藏品空态", basic.hasStashEmpty, `hasStashEmpty=${basic.hasStashEmpty}`);

  // 2. 开始/停止监听（放在文件识别之前：开始监听会按设计清空上一轮的判定画面）
  await evalJs(`document.querySelector("#btn-live").click()`);
  const started = await waitFor(
    `(async () => {
      const r = await fetch("/api/live/status");
      const s = await r.json();
      if (!s.running) return null;
      return {
        running: s.running,
        label: document.querySelector("#live-label")?.textContent?.trim(),
        state: document.querySelector("#btn-live")?.dataset?.state,
        device: document.querySelector("#live-device")?.textContent?.trim(),
        deviceIndex: s.device && s.device.index,
        deviceName: s.device && s.device.name,
      };
    })()`,
    20000,
    "开始监听"
  );
  check(
    "点开始后 running=true 且按钮变停止",
    started.running === true && started.label === "停止监听" && started.state === "running",
    JSON.stringify(started)
  );

  await evalJs(`document.querySelector("#btn-live").click()`);
  const stopped = await waitFor(
    `(async () => {
      const r = await fetch("/api/live/status");
      const s = await r.json();
      if (s.running) return null;
      return {
        running: s.running,
        label: document.querySelector("#live-label")?.textContent?.trim(),
        state: document.querySelector("#btn-live")?.dataset?.state,
        device: document.querySelector("#live-device")?.textContent?.trim(),
      };
    })()`,
    20000,
    "停止监听"
  );
  check(
    "点停止后 running=false 且按钮复原",
    stopped.running === false && stopped.label === "开始监听" && stopped.state === "idle",
    JSON.stringify(stopped)
  );

  // 3. 文件识别 -> 判定卡 + 藏品分组
  const recognize = await evalJs(`(async () => {
    const blob = await (await fetch("/api/sounds/5.wav")).blob();
    const file = new File([blob], "5.wav", { type: "audio/wav" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector("#file-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  void recognize;
  const verdict = await waitFor(
    `(() => {
      const name = document.querySelector("#verdict-name")?.textContent?.trim();
      if (!name || name.includes("等待")) return null;
      const panel = document.querySelector("#verdict");
      const stash = document.querySelector("#stash");
      const tiles = [...document.querySelectorAll(".stash-tile")];
      const rows = [...document.querySelectorAll(".stash-row")];
      return {
        name,
        has: panel?.dataset?.has,
        facts: document.querySelector("#verdict-facts")?.textContent?.trim(),
        count: document.querySelector("#verdict-count")?.textContent?.trim(),
        barWidth: document.querySelector("#verdict-bar-fill")?.style?.width,
        stashHas: stash?.dataset?.has,
        hint: document.querySelector("#stash-hint")?.textContent?.trim(),
        rows: rows.length,
        tiles: tiles.length,
        badges: rows.map((r) => r.querySelector(".stash-badge")?.textContent?.trim()),
        sizes: [...new Set(tiles.map((t) => t.dataset.size))],
        singleLineOk: rows.every((r) => {
          const list = r.querySelectorAll(".stash-tile");
          if (list.length < 2) return true;
          const top = list[0].offsetTop;
          return [...list].every((t) => Math.abs(t.offsetTop - top) <= 2);
        }),
        valueSortedOk: rows.every((r) => {
          const vals = [...r.querySelectorAll(".stash-tile")].map((t) => Number(t.dataset.value));
          return vals.every((v, i) => i === 0 || vals[i - 1] >= v);
        }),
        areas: rows.map((r) => {
          const m = /(\\d+)×(\\d+)/.exec(r.querySelector(".stash-badge")?.textContent || "");
          return m ? Number(m[1]) * Number(m[2]) : 0;
        }),
      };
    })()`,
    30000,
    "文件识别结果"
  );

  check(
    "文件识别后判定卡显示音效名",
    verdict.name === "拾取音效 05" && verdict.has === "true",
    `name="${verdict.name}" has=${verdict.has}`
  );
  check(
    "判定卡有相似度/置信度/领先三段",
    /相似度\s*[\d.]+\s*·\s*置信度\s*[\d.]+\s*·\s*领先\s*[\d.]+/.test(verdict.facts || ""),
    `facts="${verdict.facts}" barW=${verdict.barWidth}`
  );
  check(
    "累计次数已 +1",
    /累计 1 次/.test(verdict.count || ""),
    `count="${verdict.count}"`
  );
  check(
    "藏品面板按占格分组渲染",
    verdict.stashHas === "true" && verdict.rows >= 2 && verdict.tiles >= 4,
    `hint="${verdict.hint}" rows=${verdict.rows} tiles=${verdict.tiles} badges=${JSON.stringify(verdict.badges)}`
  );
  check(
    "同占格排同一行、行内价值降序",
    verdict.singleLineOk && verdict.valueSortedOk,
    `singleLine=${verdict.singleLineOk} valueSorted=${verdict.valueSortedOk}`
  );
  check(
    "占格大的行在上（面积降序）",
    verdict.areas.every((v, i) => i === 0 || verdict.areas[i - 1] >= v),
    `areas=${JSON.stringify(verdict.areas)} sizes=${JSON.stringify(verdict.sizes)}`
  );

  await send("Page.captureScreenshot", { format: "png" }).then((r) => {
    writeFileSync(`${SHOT_DIR}\\m1-mobile.png`, Buffer.from(r.data, "base64"));
  });

  // 4. 停止后判定保留：先识别，再开停一次，验证画面不被清掉
  await evalJs(`document.querySelector("#btn-live").click()`);
  await waitFor(
    `(async () => { const s = await (await fetch("/api/live/status")).json(); return s.running; })()`,
    20000,
    "再次开始监听"
  );
  await evalJs(`document.querySelector("#btn-live").click()`);
  const kept = await waitFor(
    `(async () => {
      const s = await (await fetch("/api/live/status")).json();
      if (s.running) return null;
      return {
        verdict: document.querySelector("#verdict-name")?.textContent?.trim(),
        stash: document.querySelector("#stash")?.dataset?.has,
      };
    })()`,
    20000,
    "停止后保留判定"
  );
  check(
    "停止后判定与藏品保留在屏幕上",
    kept.verdict === "拾取音效 05" && kept.stash === "true",
    `verdict="${kept.verdict}" stash=${kept.stash}`
  );

  // 5. 命中记录 + 清空
  const hits = await evalJs(`(() => {
    const rows = [...document.querySelectorAll(".hit")];
    return {
      count: rows.length,
      first: rows[0] ? {
        time: rows[0].querySelector(".hit-time")?.textContent?.trim(),
        name: rows[0].querySelector(".hit-name")?.textContent?.trim(),
        conf: rows[0].querySelector(".hit-conf")?.textContent?.trim(),
      } : null,
    };
  })()`);
  check(
    "命中记录有行且格式正确",
    hits.count >= 1 && hits.first && /^\d{2}:\d{2}\.\d{3}$/.test(hits.first.time || ""),
    JSON.stringify(hits)
  );
  await evalJs(`document.querySelector("#btn-clear").click()`);
  const cleared = await evalJs(`(() => ({
    rows: document.querySelectorAll(".hit").length,
    empty: document.querySelector("#hits-empty")?.textContent?.trim(),
  }))()`);
  check("清空命中生效", cleared.rows === 0 && cleared.empty === "还没有命中", JSON.stringify(cleared));

  // 5. 触发一次真实 hit（走 SSE 主链路）：直接调用 recognize 不会推 SSE，
  //    所以改为在页面里伪造不了，改用「播放 + 监听」太重；这里验证 SSE 的 status 分支已覆盖。
  //    命中链路已由 live_e2e 在真回环上验证，手机端只需确认 addHit 能正确渲染（上面文件识别已覆盖）。

  // 6. 截图收尾
  await send("Page.captureScreenshot", { format: "png" }).then((r) => {
    writeFileSync(`${SHOT_DIR}\\m2-mobile-after.png`, Buffer.from(r.data, "base64"));
  });

  check("无未捕获 JS 异常", exceptions.length === 0, exceptions.join(" | "));
  check("无 console.error", consoleErrors.length === 0, consoleErrors.join(" | "));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n==== ${passed}/${results.length} 通过 ====`);
if (passed !== results.length) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL: ${r.name} — ${r.detail}`);
  process.exitCode = 1;
}
