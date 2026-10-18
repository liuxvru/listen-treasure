// 听声鉴宝 · 实时监视台
// 左栏实时识别，右栏命中记录 + 本次藏品。
// 逻辑与 mobile.js 保持同源，统一用 textContent 组装（防注入）。

const API = {
  health: "/api/health",
  library: "/api/library",
  devices: "/api/devices",
  liveStart: "/api/live/start",
  liveStop: "/api/live/stop",
  liveStatus: "/api/live/status",
  liveEvents: "/api/live/events",
  recognize: "/api/recognize",
};

const LEVEL_BARS = 40;
const MAX_HITS = 50;
const SIZE_RE = /占格\s*(\d+)\s*[x×*]\s*(\d+)/;

const state = {
  byId: new Map(),
  devices: { loopback: [], input: [], defaultLoopback: null, error: null },
  running: false,
  busy: false,
  source: null,
  verdictId: null,
  stashId: null,
  // 手动文件识别后，后端残留的 lastVerdict 不应该把画面覆盖回去
  verdictManual: false,
  toastTimer: 0,
  lastError: "",
};

/* ============================== 小工具 ============================== */

const el = (id) => document.getElementById(id);

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** mm:ss.mmm */
function formatClock(sec) {
  const n = Number(sec);
  const s = Number.isFinite(n) && n > 0 ? n : 0;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

function formatElapsed(sec) {
  const n = Number(sec);
  const s = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatValue(min, max) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return "";
  if (Number.isFinite(a) && Number.isFinite(b)) {
    return a === b ? `${Math.round(a)}` : `${Math.round(a)}–${Math.round(b)}`;
  }
  return `${Math.round(Number.isFinite(a) ? a : b)}`;
}

function setConn(text, kind) {
  const box = el("conn");
  const label = el("conn-text");
  if (label) label.textContent = text;
  if (box) box.dataset.state = kind || "wait";
}

function toast(message, kind) {
  const box = el("toast");
  if (!box) return;
  box.textContent = String(message == null ? "" : message);
  box.dataset.kind = kind || "info";
  box.dataset.show = "true";
  box.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    box.dataset.show = "false";
    box.hidden = true;
  }, 3200);
}

async function api(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  return res.json();
}

function postJSON(url, body) {
  return api(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body == null ? {} : body),
  });
}

/* ============================== 藏品分组 ============================== */

function parseSlots(size) {
  const m = SIZE_RE.exec(String(size || ""));
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

/**
 * 同一占格排一行；行内价值从高到低；行本身按面积（再按格数）从大到小。
 */
function groupStash(items) {
  const rows = new Map();
  const loose = [];
  for (const item of items || []) {
    if (!item) continue;
    const slot = parseSlots(item.size);
    if (!slot) {
      loose.push(item);
      continue;
    }
    const key = `${slot.w}x${slot.h}`;
    if (!rows.has(key)) rows.set(key, { key, w: slot.w, h: slot.h, items: [] });
    rows.get(key).items.push(item);
  }

  const list = [...rows.values()].sort((a, b) => {
    const area = b.w * b.h - a.w * a.h;
    if (area !== 0) return area;
    return b.h - a.h || b.w - a.w;
  });

  for (const row of list) {
    row.items.sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
  }

  if (loose.length) {
    loose.sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
    list.push({ key: "loose", w: 0, h: 0, items: loose, loose: true });
  }
  return list;
}

function buildStashTile(item, index) {
  const slot = parseSlots(item && item.size) || { w: 1, h: 1 };
  const tile = document.createElement("div");
  tile.className = "stash-tile";
  tile.dataset.name = item && item.name ? String(item.name) : "";
  tile.dataset.size = item && item.size ? String(item.size) : "";
  tile.dataset.value = String((item && item.value) || 0);
  tile.style.width = `${44 + (slot.w - 1) * 13}px`;

  const thumb = document.createElement("div");
  thumb.className = "ti";
  thumb.style.aspectRatio = `${slot.w} / ${slot.h}`;
  const src = item && (item.thumbUrl || item.img);
  if (src) {
    thumb.style.backgroundImage = `url("${String(src).replace(/"/g, "%22")}")`;
  } else {
    thumb.dataset.ph = "true";
  }

  const name = document.createElement("div");
  name.className = "tn";
  name.textContent = String((item && item.name) || `藏品 ${index + 1}`);

  const value = document.createElement("div");
  value.className = "tv";
  value.textContent = formatValue(item && item.value, item && item.value);

  tile.append(thumb, name, value);
  return tile;
}

function resolveItem(verdict) {
  if (!verdict) return null;
  if (verdict.item && typeof verdict.item === "object") return verdict.item;
  const id = verdict.id == null ? "" : String(verdict.id);
  return state.byId.get(id) || null;
}

function renderStash(verdict, force = false) {
  const box = el("stash-rows");
  const hint = el("stash-hint");
  const panel = el("stash-panel");
  if (!box) return;

  if (!verdict) {
    if (state.stashId === null) return;
    return;
  }

  const item = resolveItem(verdict);
  const codex = item && Array.isArray(item.codexItems) ? item.codexItems : [];
  if (!codex.length) return;

  const id = verdict.id == null ? "" : String(verdict.id);
  if (!force && id === state.stashId) return;
  state.stashId = id;

  const rows = groupStash(codex);
  box.textContent = "";
  for (const row of rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "stash-row";
    rowEl.dataset.slot = row.key;

    const head = document.createElement("div");
    head.className = "stash-row-head";
    const label = document.createElement("span");
    label.textContent = row.loose ? "未标注占格" : `占格 ${row.w}×${row.h}`;
    const count = document.createElement("span");
    count.textContent = `${row.items.length} 件`;
    head.append(label, count);
    rowEl.appendChild(head);

    row.items.forEach((entry, i) => rowEl.appendChild(buildStashTile(entry, i)));
    box.appendChild(rowEl);
  }

  if (hint) {
    const total = codex.length;
    const name = (item && item.name) || "";
    hint.textContent = `${total} 件 · ${rows.length} 行${name ? ` · ${name}` : ""}`;
  }
  if (panel) panel.dataset.has = "true";
}

/* ============================== 当前判定 ============================== */

function renderVerdict(verdict, force = false) {
  const panel = el("verdict-panel");
  const nameEl = el("verdict-name");
  const factsEl = el("verdict-facts");
  const barEl = el("verdict-bar-fill");
  const itemsEl = el("verdict-items");
  if (!nameEl) return;

  // 后端在没有判定时会一直推 null，不能把已经显示的判定擦回「等待声音…」
  if (!verdict) return;

  const id = verdict.id == null ? "" : String(verdict.id);
  if (!force && id === state.verdictId) return;
  state.verdictId = id;

  const item = resolveItem(verdict);
  const name = verdict.name || (item && item.name) || (id ? `音效 ${id}` : "未知音效");
  nameEl.textContent = String(name);

  const score = Number(verdict.score);
  const conf = Number(verdict.confidence);
  const gap = Number(verdict.gap);
  const facts = [];
  if (Number.isFinite(score)) facts.push(`相似度 ${(score * 100).toFixed(1)}%`);
  if (Number.isFinite(conf)) facts.push(`置信度 ${(conf * 100).toFixed(0)}%`);
  if (Number.isFinite(gap)) facts.push(`领先 ${(gap * 100).toFixed(1)}%`);
  if (factsEl) factsEl.textContent = facts.length ? facts.join("   ·   ") : "已识别";

  const basis = Number.isFinite(score) ? score : Number.isFinite(conf) ? conf : 0;
  if (barEl) barEl.style.width = `${(clamp01(basis) * 100).toFixed(1)}%`;

  if (itemsEl) {
    const count = Number(item && item.itemCount);
    itemsEl.textContent = Number.isFinite(count) && count > 0 ? `${count} 件藏品` : "—";
  }

  if (panel) panel.dataset.has = "true";
}

/* ============================== 命中记录 ============================== */

function ensureEmptyHint() {
  const list = el("hits-list");
  if (!list) return;
  if (list.querySelector(".hit-row")) return;
  if (el("hits-empty")) return;
  const li = document.createElement("li");
  li.className = "hits-empty";
  li.id = "hits-empty";
  li.textContent = "还没有命中…";
  list.appendChild(li);
}

function addHit(hit) {
  const list = el("hits-list");
  if (!list || !hit) return;

  const empty = el("hits-empty");
  if (empty && empty.parentNode) empty.parentNode.removeChild(empty);

  const li = document.createElement("li");
  li.className = "hit-row";
  li.dataset.id = hit.id == null ? "" : String(hit.id);

  const time = document.createElement("span");
  time.className = "hit-time";
  time.textContent = formatClock(hit.atSec);

  const name = document.createElement("span");
  name.className = "hit-name";
  name.textContent = String(hit.name || `音效 ${li.dataset.id}`);

  const conf = document.createElement("span");
  conf.className = "hit-conf";
  const c = Number(hit.confidence);
  conf.textContent = Number.isFinite(c) ? `${Math.round(clamp01(c) * 100)}%` : "—";

  li.append(time, name, conf);
  list.prepend(li);

  while (list.children.length > MAX_HITS) {
    list.removeChild(list.lastElementChild);
  }
}

function clearHits() {
  const list = el("hits-list");
  if (!list) return;
  list.textContent = "";
  const li = document.createElement("li");
  li.className = "hits-empty";
  li.id = "hits-empty";
  li.textContent = "还没有命中…";
  list.appendChild(li);
}

/* ============================== 电平 ============================== */

function buildLevelBars() {
  const box = el("level-bars");
  if (!box) return;
  box.textContent = "";
  for (let i = 0; i < LEVEL_BARS; i += 1) {
    const bar = document.createElement("i");
    bar.className = "level-bar";
    bar.style.height = "6%";
    box.appendChild(bar);
  }
}

function renderLevel(meter) {
  const box = el("level-bars");
  if (!box) return;
  const bars = box.children;
  if (!bars.length) return;

  const raw = meter && Array.isArray(meter.bars) ? meter.bars : [];
  // 后端给 160 根，取尾部 40 根对应最新时间
  const tail = raw.length > LEVEL_BARS ? raw.slice(raw.length - LEVEL_BARS) : raw;
  const offset = LEVEL_BARS - tail.length;

  for (let i = 0; i < LEVEL_BARS; i += 1) {
    const bar = bars[i];
    const v = i >= offset ? clamp01(tail[i - offset]) : 0;
    bar.style.height = `${(6 + v * 94).toFixed(1)}%`;
    const hot = v > 0.88;
    if (hot !== bar.classList.contains("hot")) bar.classList.toggle("hot", hot);
  }

  box.dataset.active = meter && meter.active ? "true" : "false";

  const readout = el("level-readout");
  if (readout) {
    const db = Number(meter && meter.levelDb);
    readout.textContent = Number.isFinite(db) && db > -90 ? `${db.toFixed(1)} dB` : "−∞ dB";
  }
}

/* ============================== 监听状态 ============================== */

function setLiveButton(kind, text) {
  const btn = el("btn-live");
  const label = el("live-label");
  if (!btn) return;
  btn.dataset.state = kind;
  if (label) label.textContent = text;
  const icon = btn.querySelector(".live-icon");
  if (icon) icon.textContent = kind === "running" ? "■" : "▶";
}

function syncLiveButton() {
  if (state.busy) {
    setLiveButton("busy", state.running ? "停止中…" : "启动中…");
    return;
  }
  if (state.running) setLiveButton("running", "停止监听");
  else setLiveButton("idle", "开始监听");
}

function applyStatus(status) {
  if (!status) return;

  const wasRunning = state.running;
  state.running = !!status.running;
  if (wasRunning !== state.running) syncLiveButton();

  renderLevel(status.meter);

  const counter = el("verdict-count");
  if (counter) {
    const n = Number(status.confirmations);
    counter.textContent = `累计 ${Number.isFinite(n) && n > 0 ? Math.floor(n) : 0} 次`;
  }

  const elapsed = el("live-elapsed");
  if (elapsed) elapsed.textContent = formatElapsed(status.elapsed);

  const device = el("live-device");
  if (device) {
    // 后端 status.device 是 {index,name,kind,sampleRate}，也可能直接是字符串
    const d = status.device;
    const label = d && typeof d === "object" ? (d.name || "") : d ? String(d) : "";
    device.textContent = label || "未开始";
  }

  const stateEl = el("verdict-state");
  if (stateEl) {
    if (status.error) stateEl.textContent = String(status.error);
    else if (status.running) stateEl.textContent = "监听中";
    else stateEl.textContent = "未开始";
  }

  if (status.error && status.error !== state.lastError) {
    state.lastError = String(status.error);
    toast(status.error, "err");
  } else if (!status.error) {
    state.lastError = "";
  }

  // 停止监听后后端仍保留 lastVerdict，别拿残值覆盖手动文件识别的结果
  if (!status.running && state.verdictManual) return;
  renderVerdict(status.lastVerdict);
}

/* ============================== SSE ============================== */

function handlePayload(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!data || typeof data !== "object") return;

  if (data.type === "status" && data.status) {
    applyStatus(data.status);
    return;
  }
  if (data.type === "hit" && data.hit) {
    state.verdictManual = false;
    renderVerdict(data.hit, true);
    renderStash(data.hit, true);
    addHit(data.hit);
  }
}

function openEvents() {
  if (state.source) return;
  const src = new EventSource(API.liveEvents);
  state.source = src;

  src.onopen = () => setConn("已连接", "ok");
  src.onerror = () => setConn("重连中", "err");
  src.onmessage = (event) => handlePayload(event.data);
  // 兼容后端把 type 写成 SSE 事件名的情况
  src.addEventListener("status", (event) => handlePayload(event.data));
  src.addEventListener("hit", (event) => handlePayload(event.data));
}

function closeEvents() {
  if (!state.source) return;
  state.source.close();
  state.source = null;
  setConn("已断开", "wait");
}

/* ============================== 数据加载 ============================== */

function normalizeItem(raw) {
  if (!raw || raw.id == null) return null;
  return {
    id: String(raw.id),
    name: raw.name || `音效 ${raw.id}`,
    category: raw.category || "",
    duration: Number(raw.duration) || 0,
    valueMin: Number(raw.valueMin) || 0,
    valueMax: Number(raw.valueMax) || 0,
    itemCount: Number(raw.itemCount) || 0,
    audioUrl: raw.audioUrl || "",
    codexItems: Array.isArray(raw.codexItems) ? raw.codexItems : [],
  };
}

async function loadLibrary() {
  try {
    const data = await api(API.library);
    const items = Array.isArray(data && data.items) ? data.items : [];
    state.byId = new Map();
    for (const raw of items) {
      const item = normalizeItem(raw);
      if (item) state.byId.set(item.id, item);
    }
  } catch (error) {
    toast(`藏品库加载失败：${error.message}`, "err");
  }
}

function fillDeviceSelect() {
  const sel = el("device-select");
  if (!sel) return;
  const devices = state.devices;

  sel.textContent = "";

  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "默认回环设备（自动）";
  sel.appendChild(auto);

  const addGroup = (label, list) => {
    if (!Array.isArray(list) || !list.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const dev of list) {
      if (!dev) continue;
      const option = document.createElement("option");
      option.value = String(dev.index);
      const rate = Number(dev.sampleRate);
      option.textContent =
        Number.isFinite(rate) && rate > 0
          ? `${dev.name || `设备 ${dev.index}`}（${Math.round(rate / 1000)} kHz）`
          : dev.name || `设备 ${dev.index}`;
      if (dev.index === devices.defaultLoopback) option.dataset.default = "1";
      group.appendChild(option);
    }
    sel.appendChild(group);
  };

  addGroup("系统回环（听到电脑的声音）", devices.loopback);
  addGroup("麦克风", devices.input);

  const preferred = devices.defaultLoopback;
  sel.value = preferred == null ? "" : String(preferred);
  if (sel.value !== String(preferred == null ? "" : preferred)) sel.value = "";

  const hint = el("device-hint");
  if (hint) {
    if (devices.error) hint.textContent = String(devices.error);
    else {
      const total = (devices.loopback || []).length + (devices.input || []).length;
      hint.textContent = total ? `${total} 个音频设备` : "没有可用设备";
    }
  }
}

async function loadDevices() {
  try {
    const data = await api(API.devices);
    state.devices = {
      loopback: Array.isArray(data && data.loopback) ? data.loopback : [],
      input: Array.isArray(data && data.input) ? data.input : [],
      defaultLoopback: data && data.defaultLoopback != null ? data.defaultLoopback : null,
      error: (data && data.error) || null,
    };
  } catch (error) {
    state.devices = { loopback: [], input: [], defaultLoopback: null, error: error.message };
  }
  fillDeviceSelect();
}

/* ============================== 监听控制 ============================== */

async function startLive() {
  if (state.busy || state.running) return;
  state.busy = true;
  syncLiveButton();
  try {
    const raw = el("device-select") ? el("device-select").value : "";
    const deviceIndex = raw === "" ? null : Number(raw);
    const status = await postJSON(API.liveStart, {
      deviceIndex: Number.isFinite(deviceIndex) ? deviceIndex : null,
    });
    state.running = true;
    state.verdictManual = false;
    if (status) applyStatus(status);
    toast("开始监听", "ok");
  } catch (error) {
    toast(`启动失败：${error.message}`, "err");
  } finally {
    state.busy = false;
    syncLiveButton();
  }
}

async function stopLive() {
  if (state.busy) return;
  state.busy = true;
  syncLiveButton();
  try {
    const data = await postJSON(API.liveStop, {});
    state.running = false;
    state.verdictManual = false;
    const hits = Array.isArray(data && data.hits) ? data.hits : [];
    for (const hit of hits) addHit(hit);
    if (hits.length) toast(`本轮共 ${hits.length} 次命中`, "ok");
  } catch (error) {
    toast(`停止失败：${error.message}`, "err");
  } finally {
    state.busy = false;
    syncLiveButton();
  }
}

function toggleLive() {
  if (state.running) stopLive();
  else startLive();
}

async function syncLiveState() {
  try {
    const status = await api(API.liveStatus);
    if (status) applyStatus(status);
  } catch {
    // 后端没起来时保持默认画面
  }
}

/* ============================== 文件识别 ============================== */

async function recognizeFile(file) {
  if (!file) return;
  const status = el("file-status");
  if (status) status.textContent = `识别中：${file.name}`;
  try {
    const body = new FormData();
    body.append("file", file, file.name || "audio.wav");
    const res = await fetch(API.recognize, { method: "POST", body });
    if (!res.ok) throw new Error(`识别失败 HTTP ${res.status}`);
    const data = await res.json();
    const hits = Array.isArray(data && data.hits) ? data.hits : [];

    // hits 按得分从高到低，倒序添加让最匹配的一条落在列表最上面
    for (let i = hits.length - 1; i >= 0; i -= 1) addHit(hits[i]);

    const best = (data && data.best) || hits[0] || null;
    if (best) {
      state.verdictManual = true;
      renderVerdict(best, true);
      renderStash(best, true);
      const itemsEl = el("verdict-items");
      if (itemsEl) {
        const item = resolveItem(best);
        const count = Number(item && item.itemCount);
        if (Number.isFinite(count) && count > 0) itemsEl.textContent = `${count} 件藏品`;
      }
    }

    if (status) {
      const dur = Number(data && data.duration);
      const frames = Number(data && data.frames);
      status.textContent = Number.isFinite(dur)
        ? `${file.name} · ${dur.toFixed(2)}s · ${Number.isFinite(frames) ? frames : "?"} 帧`
        : `${file.name} 识别完成`;
    }
    if (!best) toast("这段音频没听出东西来", "err");
  } catch (error) {
    if (status) status.textContent = "识别失败";
    toast(error.message || "识别失败", "err");
  }
}

/* ============================== 事件绑定 ============================== */

function bindEvents() {
  const btnLive = el("btn-live");
  if (btnLive) btnLive.addEventListener("click", toggleLive);

  const btnRefresh = el("btn-refresh");
  if (btnRefresh) {
    btnRefresh.addEventListener("click", async () => {
      btnRefresh.dataset.busy = "true";
      await loadDevices();
      delete btnRefresh.dataset.busy;
      toast("设备列表已刷新", "ok");
    });
  }

  const clearBtn = el("btn-clear-hits");
  if (clearBtn) clearBtn.addEventListener("click", clearHits);

  const fileInput = el("file-input");
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) recognizeFile(file);
      fileInput.value = "";
    });
  }

  const dropzone = el("dropzone");
  if (dropzone) {
    dropzone.addEventListener("click", () => {
      if (fileInput) fileInput.click();
    });
    dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (fileInput) fileInput.click();
      }
    });
    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.dataset.drag = "true";
    });
    dropzone.addEventListener("dragleave", () => {
      delete dropzone.dataset.drag;
    });
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      delete dropzone.dataset.drag;
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) recognizeFile(file);
    });
  }

  const deviceSelect = el("device-select");
  if (deviceSelect) {
    deviceSelect.addEventListener("change", () => {
      if (state.running) toast("切换设备需要先停止监听", "err");
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.source) openEvents();
  });

  window.addEventListener("beforeunload", closeEvents);
}

/* ============================== 启动 ============================== */

async function init() {
  buildLevelBars();
  renderLevel({ bars: [], active: false });
  bindEvents();
  setLiveButton("idle", "开始监听");
  setConn("连接中", "wait");
  ensureEmptyHint();

  openEvents();
  await Promise.all([loadLibrary(), loadDevices()]);
  await syncLiveState();
  syncLiveButton();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
