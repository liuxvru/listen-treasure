// 极简 CDP 客户端：只用 Node 内置能力（WebSocket 用 node 22+ 全局实现）
// 用途：在无头 Chrome 里真正跑一遍页面，验证前端能初始化、能识别。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

export async function launch({ headless = true, fakeAudioFile = null, width = 1280, height = 900 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "listen-cdp-"));
  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--mute-audio",
    `--window-size=${width},${height}`,
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  if (fakeAudioFile) {
    args.unshift(
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${fakeAudioFile}`
    );
  }
  const exe = CHROME_CANDIDATES.find((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
  if (!exe) throw new Error("找不到 Chrome/Edge");

  const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));

  // 从 stderr 里读 DevTools 端口
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 DevTools 端口超时\n" + stderr.slice(0, 800))), 20000);
    const onData = (d) => {
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(d.toString());
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`chrome 退出 ${code}\n${stderr.slice(0, 800)}`)));
  });

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  const cdp = await connect(page.webSocketDebuggerUrl);

  return {
    cdp,
    port,
    async close() {
      try {
        await cdp.send("Browser.close");
      } catch {}
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    },
  };
}


async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  return {
    send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
    },
    on(fn) {
      listeners.push(fn);
    },
    close() {
      ws.close();
    },
  };
}

/** 常用组合：打开页面、注入脚本、取结果 */
export function makeRunner(cdp) {
  const send = cdp.send.bind(cdp);
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  const waitFor = async (expression, timeout = 15000, label = expression) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = await evalJs(expression);
      if (v) return v;
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`等待超时：${label}`);
  };
  return { send, evalJs, waitFor };
}


