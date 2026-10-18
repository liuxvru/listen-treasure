/* 手机端逻辑：SSE 订阅 + 判定/藏品/电平渲染 + 设备控制。
 *
 * 和桌面版的关键差别：
 *   1. 只做纵向单列，不做图鉴浏览——手机上打游戏时只需要「当前听到什么、里面有什么」；
 *   2. SSE 每 250ms 推一次 status，绝不能整块重画 DOM，否则入场动画一直重播、还费电；
 *      所以判定卡/藏品面板都按「音效 id 变了才重画」来去重。
 */

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

const LEVEL_BARS = 40; // 手机屏幕窄，40 根柱子够看
const MAX_HITS = 30;
const SIZE_RE = /占格\s*(\d+)\s*[x×*]\s*(\d+)/;

const state = {
  items: [],
  byId: new Map(),
  devices: { loopback: [], input: [], defaultLoopback: -1 },
  deviceIndex: null,
  live: {
    running: false,
    busy: false,
    elapsed: 0,
    confirmations: 0,
    fileConfirmations: 0,
  },
  es: null,
  retryTimer: null,
  hits: [],
  stashId: null, // 当前藏品面板渲染的音效 id，用于去重
  levelEls: [],
  toastTimer: null,
  verdictId: null,
};

const $ = (sel, root) => (root || document).querySelector(sel);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text); // 一律 textContent，防注入
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function formatValue(v) {
  const n = Number(v) || 0;
  if (n >= 10000) {
    const w = n / 10000;
    if (w >= 100) return `${Math.round(w)}W`;
    if (w >= 10) return `${w.toFixed(1).replace(/\.0$/, "")}W`;
    return `${w.toFixed(2).replace(/0$/, "").replace(/\.$/, "")}W`;
  }
  return n.toLocaleString("zh-CN");
}

function formatClock(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- 提示

function toast(message, kind) {
  const box = $("#toast");
  if (!box) return;
  box.textContent = message;
  box.className = `toast${kind ? ` ${kind}` : ""}`;
  box.hidden = false;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    box.hidden = true;
    state.toastTimer = null;
  }, 2600);
}

function setConn(text, kind) {
  const box = $("#conn");
  const label = $("#conn-text");
  if (box) box.dataset.state = kind || "idle";
  if (label) label.textContent = text;
}

async function api(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const detail = data && (data.detail || data.msg || data.error);
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return data;
}

function postJSON(url, body) {
  return api(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

// ---------------------------------------------------------------- 当前判定

function updateVerdictCount() {
  const total = state.live.confirmations + state.live.fileConfirmations;
  const node = $("#verdict-count");
  if (node) node.textContent = `累计 ${total} 次`;
}

function renderVerdict(verdict, force) {
  const panel = $("#verdict");
  const name = $("#verdict-name");
  const facts = $("#verdict-facts");
  const fill = $("#verdict-bar-fill");
  if (!panel || !name || !facts) return;

  const id = verdict && verdict.id != null ? String(verdict.id) : null;
  if (!force) {
    // 同一个音效不重画：SSE 250ms 一次，重画会让大字的发光描边一直在闪
    if (id !== null && id === state.verdictId) return;
    // 后端在「没有判定」时会一直推 lastVerdict=null。这时不要擦掉屏幕上已有
    // 的结果——打游戏时用户可能刚抬头看到，或者刚重启监听还没等到声音，
    // 一擦就变成「等待声音…」，得重新等一次。只有用户主动清空才清。
    if (id === null && state.verdictId !== null) return;
  }
  state.verdictId = id;

  if (!id) {
    panel.dataset.has = "false";
    name.textContent = "等待声音…";
    facts.textContent = state.live.running
      ? "正在监听，听到拾取音效就会显示"
      : "点下面的按钮开始监听";
    if (fill) fill.style.width = "0%";
    renderStash(null);
    return;
  }

  panel.dataset.has = "true";
  name.textContent = verdict.name || `音效 ${id}`;
  const score = Number(verdict.score) || 0;
  const conf = Number(verdict.confidence) || 0;
  const gap = Number(verdict.gap) || 0;
  facts.textContent = `相似度 ${score.toFixed(2)} · 置信度 ${conf.toFixed(2)} · 领先 ${gap.toFixed(2)}`;
  if (fill) fill.style.width = `${clamp01(conf) * 100}%`;
  renderStash(verdict);
}

// ---------------------------------------------------------------- 本次藏品

/** 「占格 2×3」→ {w:2,h:3}；解析不出来当 1×1 */
function parseSlots(size) {
  const m = SIZE_RE.exec(String(size || ""));
  if (!m) return { w: 1, h: 1 };
  return { w: Math.max(1, Number(m[1]) || 1), h: Math.max(1, Number(m[2]) || 1) };
}

/** 按占格分组：同占格一行，行内价值降序；行按面积从大到小 */
function groupStash(items) {
  const groups = new Map();
  for (const item of items) {
    const { w, h } = parseSlots(item.size);
    const key = `${w}×${h}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, w, h, area: w * h, items: [] };
      groups.set(key, g);
    }
    g.items.push(item);
  }
  const rows = [...groups.values()];
  for (const row of rows) {
    row.items.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
  }
  rows.sort((a, b) => b.area - a.area || b.w - a.w || b.h - a.h);
  return rows;
}

function buildStashTile(item, index) {
  const { w, h } = parseSlots(item.size);
  const tile = el("div", "stash-tile");
  // 占格越大卡片越宽，缩略图框按 w:h 变形，一眼看出 3×2 和 1×1 的差别
  tile.style.width = `${44 + (w - 1) * 13}px`;
  // 刻意不做逐个延迟入场：手机上这屏是「打游戏瞄一眼」用的，
  // 错开动画会让下面几行有半秒钟是空的（第一版按 index*22ms 延迟，实测就是这样）。
  void index;
  tile.title = `${item.name} · ${item.size || "占格 1×1"} · ${formatValue(item.value)}`;
  // 留给自测/调试读：真实数值比格式化后的「100W」好断言
  tile.dataset.name = item.name;
  tile.dataset.size = `${w}×${h}`;
  tile.dataset.value = String(Number(item.value) || 0);

  const pic = el("div", "ti");
  pic.style.aspectRatio = `${w} / ${h}`;
  if (item.thumbUrl) pic.style.backgroundImage = `url("${item.thumbUrl}")`;
  else pic.classList.add("placeholder");

  tile.append(pic, el("div", "tn", item.name), el("div", "tv", formatValue(item.value)));
  return tile;
}

/** force=true 强制清空（开始新一轮监听用）；传 null 且非 force 时保留上次结果 */
function renderStash(verdict, force) {
  const panel = $("#stash");
  const box = $("#stash-rows");
  const hint = $("#stash-hint");
  if (!panel || !box) return;

  const id = verdict && verdict.id != null ? String(verdict.id) : null;
  if (!force) {
    if (id === null && state.stashId !== null) return; // 停止时保留画面
    if (id !== null && id === state.stashId) return; // 同一音效不重画
  }
  // 清空是唯一「真的没有藏品」的时机，此时要连 stashId 一起清掉，
  // 否则开始新一轮监听后同一个音效会被上面的去重逻辑挡住不重画。
  if (force) state.stashId = id;
  else state.stashId = id;

  clear(box);
  const item = id ? state.byId.get(id) : null;
  const list = item && Array.isArray(item.codexItems) ? item.codexItems : [];

  if (!list.length) {
    panel.dataset.has = "false";
    if (hint) hint.textContent = id ? "这件暂无藏品数据" : "等待识别";
    box.appendChild(
      el(
        "p",
        "stash-empty",
        id
          ? "这段音效还没有对应的藏品数据。"
          : "识别到音效后，这里按占格分组列出藏品：同一占格的排一行，行内价值从高到低。"
      )
    );
    return;
  }

  const rows = groupStash(list);
  panel.dataset.has = "true";
  if (hint) hint.textContent = `共 ${list.length} 件 · ${rows.length} 种占格`;

  const frag = document.createDocumentFragment();
  let index = 0;
  for (const row of rows) {
    const wrap = el("section", "stash-row");
    const head = el("div", "stash-row-head");
    head.append(
      el("span", "stash-badge", row.key),
      el("span", "stash-row-count", `${row.items.length} 件`),
      el("span", "stash-row-top", `最高 ${formatValue(row.items[0].value)}`)
    );
    const line = el("div", "stash-row-list");
    for (const it of row.items) {
      line.appendChild(buildStashTile(it, index));
      index += 1;
    }
    wrap.append(head, line);
    frag.appendChild(wrap);
  }
  box.appendChild(frag);
}

// ---------------------------------------------------------------- 电平

function buildLevelBars() {
  const box = $("#level-bars");
  if (!box) return;
  clear(box);
  state.levelEls = [];
  for (let i = 0; i < LEVEL_BARS; i += 1) {
    const bar = el("i", "level-bar");
    box.appendChild(bar);
    state.levelEls.push(bar);
  }
}

function renderLevel(meter) {
  const box = $("#level-bars");
  const readout = $("#level-readout");
  if (!box) return;
  const bars = meter && Array.isArray(meter.bars) ? meter.bars : [];
  // 后端给 160 根，手机只取最后 40 根（最新的在右边）
  const tail = bars.slice(Math.max(0, bars.length - LEVEL_BARS));
  const pad = LEVEL_BARS - tail.length;
  const active = Boolean(meter && meter.active);
  box.dataset.active = active ? "true" : "false";

  for (let i = 0; i < state.levelEls.length; i += 1) {
    const bar = state.levelEls[i];
    const v = i - pad >= 0 ? clamp01(tail[i - pad]) : 0;
    bar.style.height = `${Math.round(6 + v * 94)}%`;
    bar.classList.toggle("hot", v > 0.88);
  }

  if (readout) {
    const lv = meter ? Number(meter.levelDb) : -90;
    readout.textContent = !Number.isFinite(lv) || lv <= -89 ? "−∞ dB" : `${lv.toFixed(1)} dB`;
  }
}

// ---------------------------------------------------------------- 状态

function setLiveButton(kind, text) {
  const btn = $("#btn-live");
  const label = $("#live-label");
  const icon = btn ? btn.querySelector(".live-icon") : null;
  if (!btn) return;
  btn.dataset.state = kind;
  if (label) label.textContent = text;
  if (icon) icon.textContent = kind === "running" ? "■" : "▶";
}

function renderStatus(status) {
  if (!status) return;
  state.live.running = Boolean(status.running);
  state.live.elapsed = Number(status.elapsed) || 0;
  state.live.confirmations = Number(status.confirmations) || 0;

  setLiveButton(state.live.running ? "running" : "idle", state.live.running ? "停止监听" : "开始监听");
  const elapsed = $("#live-elapsed");
  if (elapsed) elapsed.textContent = formatElapsed(state.live.elapsed);
  const device = $("#live-device");
  if (device) {
    device.textContent = status.device ? status.device.name : state.live.running ? "启动中…" : "未开始";
  }
  updateVerdictCount();
  renderLevel(status.meter || null);
  renderVerdict(status.lastVerdict || null);
  if (status.error) toast(status.error, "err");
}

// ---------------------------------------------------------------- 命中记录

function renderHitsEmpty() {
  const list = $("#hits");
  if (!list) return;
  if (state.hits.length) {
    const empty = $("#hits-empty");
    if (empty) empty.remove();
    return;
  }
  clear(list);
  list.appendChild(el("li", "hits-empty", "还没有命中"));
  const node = list.firstChild;
  if (node) node.id = "hits-empty";
}

function addHit(hit) {
  if (!hit || hit.id == null) return;
  const list = $("#hits");
  if (!list) return;

  const empty = $("#hits-empty");
  if (empty) empty.remove();

  const row = el("li", "hit");
  row.dataset.id = String(hit.id);
  row.append(
    el("span", "hit-time", formatClock(hit.atSec)),
    el("span", "hit-name", hit.name || `音效 ${hit.id}`),
    el("span", "hit-conf", `${Math.round(clamp01(hit.confidence) * 100)}%`)
  );
  row.addEventListener("click", () => toast(`命中 ${hit.name || hit.id}`, "ok"));

  state.hits.unshift(hit);
  list.prepend(row);
  while (state.hits.length > MAX_HITS) {
    state.hits.pop();
    if (list.lastElementChild) list.removeChild(list.lastElementChild);
  }
  renderHitsEmpty();
}

function clearHits() {
  state.hits = [];
  const list = $("#hits");
  if (!list) return;
  clear(list);
  const row = el("li", "hits-empty", "还没有命中");
  row.id = "hits-empty";
  list.appendChild(row);
}

// ---------------------------------------------------------------- SSE

function closeEvents() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
}

function openEvents() {
  closeEvents();
  setConn("连接中", "wait");
  let es;
  try {
    es = new EventSource(API.liveEvents);
  } catch (err) {
    setConn("连接失败", "err");
    toast(`连接失败：${err.message}`, "err");
    return;
  }
  state.es = es;

  es.addEventListener("open", () => setConn("已连接", "ok"));
  es.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "status") renderStatus(msg.status);
    else if (msg.type === "hit") addHit(msg.hit);
  });
  es.addEventListener("error", () => {
    // EventSource 自己会按 retry: 2000 重连，这里只更新 UI 状态
    setConn("重连中", "err");
  });
}

// ---------------------------------------------------------------- 库 / 设备

function normalizeItem(raw) {
  const codexItems = Array.isArray(raw.codexItems)
    ? raw.codexItems.map((c) => ({
        name: c.name,
        value: Number(c.value) || 0,
        size: c.size,
        img: c.img,
        thumbUrl: c.thumbUrl || null,
      }))
    : [];
  return {
    id: String(raw.id),
    name: raw.name,
    duration: Number(raw.duration) || 0,
    valueMin: Number(raw.valueMin) || 0,
    valueMax: Number(raw.valueMax) || 0,
    itemCount: Number(raw.itemCount) || codexItems.length,
    audioUrl: raw.audioUrl,
    codexItems,
  };
}

async function loadLibrary() {
  const data = await api(API.library);
  const items = data && Array.isArray(data.items) ? data.items.map(normalizeItem) : [];
  state.items = items;
  state.byId = new Map(items.map((it) => [it.id, it]));
}

function rebuildDeviceSelect() {
  const sel = $("#device-select");
  if (!sel) return;
  const previous = state.deviceIndex;
  clear(sel);

  const auto = el("option", null, "默认回环设备（自动）");
  auto.value = "";
  sel.appendChild(auto);

  const loop = state.devices.loopback || [];
  const inputs = state.devices.input || [];
  if (loop.length) {
    const group = document.createElement("optgroup");
    group.label = "系统回环（听到电脑的声音）";
    for (const d of loop) {
      const opt = el("option", null, d.name);
      opt.value = String(d.index);
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
  if (inputs.length) {
    const group = document.createElement("optgroup");
    group.label = "麦克风";
    for (const d of inputs) {
      const opt = el("option", null, d.name);
      opt.value = String(d.index);
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }

  if (previous != null && [...sel.options].some((o) => o.value === String(previous))) {
    sel.value = String(previous);
  } else {
    sel.value = "";
  }

  const hint = $("#device-hint");
  if (hint) {
    hint.textContent = state.devices.error
      ? "设备列表不可用"
      : `${loop.length} 个回环 · ${inputs.length} 个输入`;
  }
}

async function loadDevices() {
  try {
    state.devices = await api(API.devices);
  } catch (err) {
    state.devices = { loopback: [], input: [], defaultLoopback: -1, error: err.message };
  }
  rebuildDeviceSelect();
}

// ---------------------------------------------------------------- 实时控制

async function startLive() {
  if (state.live.busy) return;
  state.live.busy = true;
  setLiveButton("busy", "启动中…");
  try {
    const body = { deviceIndex: state.deviceIndex };
    const status = await postJSON(API.liveStart, body);
    renderStatus(status);
    openEvents();
    toast("开始监听", "ok");
  } catch (err) {
    setLiveButton("idle", "开始监听");
    toast(`启动失败：${err.message}`, "err");
  } finally {
    state.live.busy = false;
  }
}

async function stopLive() {
  if (state.live.busy) return;
  state.live.busy = true;
  setLiveButton("busy", "停止中…");
  try {
    const res = await postJSON(API.liveStop, {});
    // 停止时后端会把还没等到释放窗口的候选强制结算，这些命中要补上
    const late = res && Array.isArray(res.hits) ? res.hits : [];
    for (const hit of late) {
      addHit(hit);
      state.live.fileConfirmations += 1;
    }
    updateVerdictCount();
    state.live.running = false;
    setLiveButton("idle", "开始监听");
    const device = $("#live-device");
    if (device) device.textContent = "未开始";
    const elapsed = $("#live-elapsed");
    if (elapsed) elapsed.textContent = "00:00";
    // 判定和藏品保留在屏幕上：用户刚看到的结果不要一停就消失
    renderLevel(null);
    toast("已停止监听", "ok");
  } catch (err) {
    setLiveButton("running", "停止监听");
    toast(`停止失败：${err.message}`, "err");
  } finally {
    state.live.busy = false;
  }
}

// ---------------------------------------------------------------- 文件识别

async function recognizeFile(file) {
  const form = new FormData();
  form.append("file", file);
  const btn = $("#btn-file");
  if (btn) btn.disabled = true;
  try {
    const res = await api(API.recognize, { method: "POST", body: form });
    const hits = res && Array.isArray(res.hits) ? res.hits : [];
    for (const hit of hits) addHit(hit);
    state.live.fileConfirmations += hits.length;
    updateVerdictCount();
    const best = res && res.best;
    if (best && best.id != null) {
      state.verdictId = null; // 强制重画（同一段音效也可能再识别一次）
      renderVerdict(best);
      toast(`识别到 ${best.name || best.id}`, "ok");
    } else {
      toast("没听出是什么音效", "err");
    }
  } catch (err) {
    toast(`识别失败：${err.message}`, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------- 事件绑定

function bindEvents() {
  const btnLive = $("#btn-live");
  if (btnLive) {
    btnLive.addEventListener("click", () => {
      if (state.live.busy) return;
      if (state.live.running) stopLive();
      else startLive();
    });
  }

  const sel = $("#device-select");
  if (sel) {
    sel.addEventListener("change", () => {
      const raw = sel.value;
      state.deviceIndex = raw === "" ? null : Number(raw);
    });
  }

  const refresh = $("#btn-refresh");
  if (refresh) {
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      try {
        await loadDevices();
        toast("设备已刷新", "ok");
      } catch (err) {
        toast(`刷新失败：${err.message}`, "err");
      } finally {
        refresh.disabled = false;
      }
    });
  }

  const clearBtn = $("#btn-clear");
  if (clearBtn) clearBtn.addEventListener("click", clearHits);

  const input = $("#file-input");
  const btnFile = $("#btn-file");
  if (btnFile && input) {
    btnFile.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) recognizeFile(file);
      input.value = "";
    });
  }

  // 页面切到后台（打游戏切回游戏）时不要断 SSE，回来立刻可见
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !state.es) openEvents();
  });

  window.addEventListener("beforeunload", closeEvents);
}

// ---------------------------------------------------------------- 启动

async function syncLiveState() {
  try {
    const status = await api(API.liveStatus);
    renderStatus(status);
    if (status && status.running) openEvents();
  } catch {
    /* 忽略：SSE 会补上 */
  }
}

async function init() {
  buildLevelBars();
  bindEvents();
  renderVerdict(null);
  renderHitsEmpty();
  setConn("加载中", "wait");
  setLiveButton("idle", "开始监听");

  const results = await Promise.allSettled([loadLibrary(), loadDevices()]);
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    setConn("加载失败", "err");
    toast(`加载失败：${failed[0].reason && failed[0].reason.message}`, "err");
    return;
  }

  await syncLiveState();
  openEvents();
  setConn("已连接", "ok");
}

init();
