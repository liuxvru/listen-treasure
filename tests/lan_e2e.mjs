// 用局域网 IP（不是 127.0.0.1）打开手机版，确认真的能通过内网访问。
// 这是用户最关心的场景：「手机直接访问电脑 IP」。
//
// 局域网 IP 不写死：先问本机回环接口 /api/net 要，换台电脑也能直接跑。
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launch, makeRunner } from "./cdp.mjs";

const LOOPBACK = process.env.BASE || "http://127.0.0.1:8760";
const net = await fetch(`${LOOPBACK}/api/net`)
  .then((r) => r.json())
  .catch((e) => ({ error: String(e) }));
const LAN = process.env.LAN || net.primaryIp || "127.0.0.1";
const PORT = new URL(LOOPBACK).port;
const BASE = `http://${LAN}:${PORT}`;
const SHOT_DIR = process.env.SHOTS || fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(SHOT_DIR, { recursive: true });

if (!net.primaryIp) {
  console.log(`跳过：本机没有局域网 IP（/api/net 返回 ${JSON.stringify(net).slice(0, 120)}）`);
  console.log("      手机端只在同一个 Wi-Fi 下有意义，单机跑这个测试没有意义。");
  process.exit(0);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail == null ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
}

// 先探一下 TCP 通不通，不通就别浪费浏览器
const probe = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
check("局域网 IP 可达", probe && probe.ok === true, JSON.stringify(probe).slice(0, 140));

const browser = await launch({ headless: true, width: 390, height: 844 });
const { send, evalJs, waitFor } = makeRunner(browser.cdp);
const exceptions = [];
const consoleErrors = [];
try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  browser.cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description).join(" "));
    }
  });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

  // 走局域网地址，不是 localhost
  await send("Page.navigate", { url: `${BASE}/m` });
  await waitFor(`document.readyState === "complete"`, 20000, "页面加载");
  await waitFor(`document.querySelector("#conn")?.dataset?.state === "ok"`, 20000, "SSE 连接建立");

  // 确认页面里的 API 请求确实打到了局域网地址
  const origin = await evalJs(`location.origin`);
  check("页面 origin 是局域网地址", origin === BASE, origin);

  const ui = await evalJs(`(() => ({
    conn: document.querySelector("#conn")?.dataset?.state,
    connText: document.querySelector("#conn-text")?.textContent?.trim(),
    verdictName: document.querySelector("#verdict-name")?.textContent?.trim(),
    deviceCount: document.querySelectorAll("#device-select option").length,
    bars: document.querySelectorAll(".level-bar").length,
    liveLabel: document.querySelector("#live-label")?.textContent?.trim(),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }))()`);
  check("连接状态正常", ui.conn === "ok", `conn=${ui.conn} text="${ui.connText}"`);
  check("设备列表加载了", ui.deviceCount > 1, `options=${ui.deviceCount}`);
  check("电平条建好了", ui.bars === 40, `bars=${ui.bars}`);
  check("窄屏无横向溢出", ui.scrollW <= ui.clientW, `scrollW=${ui.scrollW} clientW=${ui.clientW}`);

  // 读库里第 5 段音频，通过 LAN 上传识别（验证 multipart 走内网也没问题）
  const fileRes = await evalJs(`(async () => {
    const wav = await (await fetch("/api/sounds/5.wav")).blob();
    const fd = new FormData();
    fd.append("file", new File([wav], "5.wav", { type: "audio/wav" }));
    const r = await fetch("/api/recognize", { method: "POST", body: fd });
    const j = await r.json();
    return {
      status: r.status,
      best: j.best ? { id: j.best.id, name: j.best.name, score: j.best.score } : null,
      hits: (j.hits || []).length,
    };
  })()`);
  check(
    "通过局域网做文件识别成功",
    fileRes.status === 200 && fileRes.best && String(fileRes.best.id) === "5",
    JSON.stringify(fileRes)
  );

  await send("Page.captureScreenshot", { format: "png" }).then((r) => {
    writeFileSync(`${SHOT_DIR}\\m2-lan.png`, Buffer.from(r.data, "base64"));
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
