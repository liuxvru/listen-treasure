// 行商听声鉴宝 · 前端主逻辑（原生 ES module，无框架、无构建）
//
// 分工：
//   左栏「实时识别」——选音频源 → 开始监听 → SSE 收 hit / status → 画电平、判定、命中记录
//   右栏「声音图鉴」——17 段音效卡片 + 138 件藏品，支持搜索、试听、改名、展开
//
// 后端契约见 listen_treasure/server.py：所有接口返回 JSON，实时事件走 SSE。
// 原则：任何网络请求都 try/catch，失败用页面内错误条提示，绝不静默失败、不用 alert。

/* ================= 常量 ================= */

const API = {
  health: "/api/health",
  library: "/api/library",
  devices: "/api/devices",
  rename: "/api/rename",
  liveStart: "/api/live/start",
  liveStop: "/api/live/stop",
  liveEvents: "/api/live/events",
  recognize: "/api/recognize",
  net: "/api/net",
  qrSvg: "/api/qr.svg",
  sync: "/api/sync",
  syncStatus: "/api/sync/status",
};

const METER_BARS = 160; // 电平条格子数，对应后端 meter.bars 最多 160 个
const MAX_HITS = 50; // 命中记录最多保留条数
const FLASH_MS = 3000; // 卡片「刚刚识别」高亮持续时长

/* ================= 全局状态 ================= */

const state = {
  health: null,
  items: [], // 声音库条目（带 _dom 引用）
  byId: new Map(),
  devices: { loopback: [], input: [], defaultLoopback: -1 },
  sourceKind: "loopback", // "loopback" | "input"
  deviceIndex: null, // null = 用后端默认设备
  live: { running: false, busy: false, elapsed: 0, confirmations: 0, fileConfirmations: 0 },
  es: null, // EventSource
  reconnectBar: null, // 「连接断开，重连中…」提示条
  hits: [], // 命中记录 [{ id, name, atSec, confidence, itemCount }]
  search: "",
  expanded: new Set(), // 用户手动展开的卡片 id
  audio: null, // 正在试听的 Audio
  audioBtn: null,
  meterEls: [],
  flashTimers: new Map(),
  errorBars: [], // 当前显示的错误条（最多 4 条）
  stashId: null, // 3×3 藏品面板当前渲染的音效 id（null = 还没画过；避免 SSE 每 250ms 重画）
  sync: { busy: false }, // 正在从站点抓数据
  net: null, // 后端给的局域网信息（手机端二维码用）
};

/* ================= DOM 小工具 ================= */

const $ = (sel, root) => (root || document).querySelector(sel);

/** 创建元素：tag、class、文本（全部走 textContent，避免注入） */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ================= 格式化 ================= */

/** 价值：1.05W / 165W / 9,800 这种写法 */
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

/** 时间戳：mm:ss.mmm（命中记录用） */
function formatClock(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

/** 计时：mm:ss.d（监听时长用） */
function formatElapsed(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

function formatDuration(sec) {
  const s = Number(sec) || 0;
  return `${s.toFixed(2)}s`;
}

/** 价值区间文案 */
function formatRange(min, max) {
  const a = Number(min) || 0;
  const b = Number(max) || 0;
  if (!a && !b) return "价值未知";
  if (!b || a === b) return formatValue(a);
  return `${formatValue(a)} ~ ${formatValue(b)}`;
}

/* ================= 提示：错误条 / Toast / 状态 ================= */

/**
 * 顶部错误提示条（可关闭）。
 * 同一条文案在 8 秒内不重复堆叠，避免 SSE 每 250ms 刷一次时糊屏。
 * 返回创建的提示条元素（已存在同样文案时返回已有的那条）。
 */
function showError(message, opts) {
  const options = opts || {};
  const text = String(message || "未知错误");
  const stack = $("#error-stack");
  if (!stack) return null;

  // 已存在同样的提示：刷新它的计时器即可
  const exist = state.errorBars.find((b) => b.dataset.text === text);
  if (exist) {
    if (options.timeout) scheduleDismiss(exist, options.timeout);
    return exist;
  }

  const bar = el("div", options.warn ? "error-bar warn" : "error-bar");
  bar.dataset.text = text;
  const body = el("div", "error-text", text);
  const close = el("button", "error-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "关闭提示");
  close.addEventListener("click", () => dismissError(bar));
  bar.append(body, close);
  stack.appendChild(bar);
  state.errorBars.push(bar);

  // 最多同时显示 4 条，超出丢掉最早的
  while (state.errorBars.length > 4) dismissError(state.errorBars[0]);
  if (options.timeout) scheduleDismiss(bar, options.timeout);
  return bar;
}

function scheduleDismiss(bar, ms) {
  if (bar._timer) clearTimeout(bar._timer);
  bar._timer = setTimeout(() => dismissError(bar), ms);
}

function dismissError(bar) {
  if (!bar) return;
  if (bar._timer) clearTimeout(bar._timer);
  const i = state.errorBars.indexOf(bar);
  if (i >= 0) state.errorBars.splice(i, 1);
  if (bar.parentNode) bar.parentNode.removeChild(bar);
}

/** 右下角轻提示 */
let toastTimer = null;
function toast(message, kind) {
  const box = $("#toast");
  if (!box) return;
  box.textContent = String(message);
  box.className = kind === "err" ? "toast err" : "toast";
  box.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 2600);
}

/** 顶栏状态灯 */
function setStatus(text, kind) {
  const dot = $("#status-dot");
  const label = $("#status-text");
  if (label) label.textContent = text;
  if (dot) dot.className = `dot ${kind || ""}`.trim();
}

/* ================= 网络层 ================= */

/**
 * 统一 fetch 封装：解析 JSON、把后端 detail 转成可读错误。
 * 任何调用点都必须包 try/catch。
 */
async function api(url, options) {
  const res = await fetch(url, options);
  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      data = null;
    }
  }
  if (!res.ok) {
    const detail =
      (data && (data.detail || data.error || data.message)) ||
      (raw ? raw.slice(0, 200) : "") ||
      res.statusText ||
      "请求失败";
    throw new Error(`${res.status} ${detail}`);
  }
  if (data === null) throw new Error("服务端返回的不是 JSON");
  return data;
}

function postJSON(url, body) {
  return api(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

/* ================= 启动：health + library + devices ================= */

/**
 * 页面刷新后如果后端其实还在监听，这里把界面重新接上（避免「后端在录、界面显示未开始」）。
 * 失败不报错：没在监听是很正常的情况。
 */
async function syncLiveState() {
  let status;
  try {
    status = await api("/api/live/status");
  } catch (e) {
    return;
  }
  if (!status || !status.running) return;
  state.live.running = true;
  renderStatus(status);
  setLiveButton("running", "停止监听");
  setStatus("监听中", "ok");
  openEvents();
  toast("检测到后端已在监听，已自动接入");
}

async function loadHealth() {
  try {
    const h = await api(API.health);
    state.health = h;
    setPill("#pill-sounds", h.sounds != null ? h.sounds : "–", "段音效");
    setPill("#pill-items", h.items != null ? h.items : "–", "件藏品");
    setPill("#pill-rate", h.sampleRate != null ? h.sampleRate : "–", "Hz");
    return h;
  } catch (e) {
    setPill("#pill-sounds", "–", "段音效");
    setPill("#pill-items", "–", "件藏品");
    setPill("#pill-rate", "–", "Hz");
    showError(`连接本地服务失败：${e.message}`, { timeout: 12000 });
    setStatus("服务未连接", "bad");
    throw e;
  }
}

function setPill(sel, value, label) {
  const node = $(sel);
  if (!node) return;
  clear(node);
  const b = el("b", null, value);
  node.append(b, document.createTextNode(` ${label}`));
}

async function loadLibrary() {
  try {
    const data = await api(API.library);
    const items = Array.isArray(data.items) ? data.items : [];
    state.items = items.map(normalizeItem);
    state.byId = new Map(state.items.map((it) => [String(it.id), it]));
    renderCards();
    const skeleton = $("#skeleton-grid");
    if (skeleton) skeleton.hidden = true;
    const grid = $("#card-grid");
    if (grid) grid.hidden = false;
    updateLibrarySub();
    applyFilter();
    setStatus(`就绪 · ${state.items.length} 段声音`, "ok");
  } catch (e) {
    const skeleton = $("#skeleton-grid");
    if (skeleton) skeleton.hidden = true;
    showError(`加载声音图鉴失败：${e.message}`, { timeout: 0 });
    const empty = $("#empty-state");
    if (empty) {
      empty.hidden = false;
      $("#empty-text").textContent = "声音图鉴加载失败，请确认本地服务是否正常。";
      $("#btn-reset-search").hidden = true;
    }
  }
}

/** 归一化后端条目：兜底字段，避免渲染时到处判空 */
function normalizeItem(raw) {
  const id = String(raw.id != null ? raw.id : "");
  const codex = Array.isArray(raw.codexItems) ? raw.codexItems : [];
  return {
    id,
    name: raw.name || `音效 ${id}`,
    duration: Number(raw.duration) || 0,
    valueMin: Number(raw.valueMin) || 0,
    valueMax: Number(raw.valueMax) || 0,
    itemCount: Number(raw.itemCount) || codex.length,
    audioUrl: raw.audioUrl || `/api/sounds/${id}.wav`,
    codexItems: codex.map((c) => ({
      name: c.name || "未知藏品",
      value: Number(c.value) || 0,
      size: c.size || "",
      img: c.img || "",
      thumbUrl: c.thumbUrl || null,
    })),
  };
}

/* ================= 右栏：图鉴卡片 ================= */

function updateLibrarySub() {
  const sub = $("#library-sub");
  if (!sub) return;
  const total = state.items.reduce((n, it) => n + it.codexItems.length, 0);
  sub.textContent = `${state.items.length} 段音效 · ${total} 件藏品 · 点击卡片展开藏品清单，点名称可改名`;
}

function renderCards() {
  const grid = $("#card-grid");
  if (!grid) return;
  clear(grid);
  const frag = document.createDocumentFragment();
  for (const item of state.items) frag.appendChild(buildCard(item));
  grid.appendChild(frag);
}

function buildCard(item) {
  const root = el("article", "card");
  root.dataset.id = item.id;

  // ---- 头部：编号 + 名称 + 试听
  const head = el("div", "card-head");
  const index = el("div", "card-index", String(item.id).padStart(2, "0"));
  const titleWrap = el("div", "card-title-wrap");
  const title = el("span", "card-title", item.name);
  title.title = "点击改名";
  const meta = el("div", "card-meta");
  meta.append(
    el("span", null, formatDuration(item.duration)),
    el("span", "gold", formatRange(item.valueMin, item.valueMax)),
    el("span", null, `${item.codexItems.length} 件藏品`)
  );
  titleWrap.append(title, meta);

  const actions = el("div", "card-actions");
  const playBtn = el("button", "btn-play", "▶ 试听");
  playBtn.type = "button";
  playBtn.title = "试听这段音效";
  actions.appendChild(playBtn);

  head.append(index, titleWrap, actions);

  // ---- 缩略图网格（最多 6 格，超出用 +N 占位）
  const thumbs = el("div", "thumb-grid");
  const list = item.codexItems;
  const showN = list.length > 6 ? 5 : Math.min(6, list.length);
  for (let i = 0; i < showN; i += 1) thumbs.appendChild(buildThumb(list[i]));
  if (list.length > 6) {
    const more = el("div", "thumb more", `+${list.length - 5}`);
    more.title = `还有 ${list.length - 5} 件藏品，点击展开`;
    thumbs.appendChild(more);
  }
  if (!list.length) thumbs.appendChild(el("div", "thumb placeholder"));

  // ---- 底部：展开/收起
  const foot = el("div", "card-foot");
  const range = el("span", null, `${formatRange(item.valueMin, item.valueMax)} 哈夫币`);
  const expandBtn = el("button", "card-expand");
  expandBtn.type = "button";
  const expandText = el("span", null, `展开全部 ${item.codexItems.length} 件`);
  const caret = el("span", "caret", "▾");
  expandBtn.append(expandText, caret);
  foot.append(range, expandBtn);

  // ---- 展开后的完整清单
  const codexList = el("div", "codex-list");
  for (const c of item.codexItems) codexList.appendChild(buildCodexRow(c));

  root.append(head, thumbs, foot, codexList);

  // ---- 交互
  const dom = { root, title, expandBtn, expandText, playBtn, thumbs, codexList };
  item._dom = dom;

  expandBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleExpand(item, !root.classList.contains("expanded"));
  });

  playBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    playPreview(item, playBtn);
  });

  title.addEventListener("click", (e) => {
    e.stopPropagation();
    beginRename(item);
  });

  // 点卡片空白处展开/收起（避开按钮、标题、输入框）
  root.addEventListener("click", (e) => {
    if (e.target.closest("button, input, .card-title, .card-expand")) return;
    toggleExpand(item, !root.classList.contains("expanded"));
  });

  return root;
}

function buildThumb(codexItem) {
  const node = el("div", "thumb");
  if (codexItem.thumbUrl) {
    node.style.backgroundImage = `url("${codexItem.thumbUrl}")`;
    node.title = codexItem.name;
  } else {
    node.classList.add("placeholder");
    node.title = `${codexItem.name}（无缩略图）`;
  }
  return node;
}

function buildCodexRow(codexItem) {
  const row = el("div", "codex-row");
  const thumb = el("div", "codex-thumb");
  if (codexItem.thumbUrl) {
    thumb.style.backgroundImage = `url("${codexItem.thumbUrl}")`;
  } else {
    thumb.classList.add("placeholder");
  }
  const body = el("div", "codex-body");
  const name = el("div", "codex-name", codexItem.name);
  const sub = el("div", "codex-sub");
  if (codexItem.value) sub.appendChild(el("span", "gold", formatValue(codexItem.value)));
  if (codexItem.size) sub.appendChild(el("span", null, codexItem.size));
  if (!codexItem.value && !codexItem.size) sub.appendChild(el("span", null, "—"));
  body.append(name, sub);
  row.append(thumb, body);
  return row;
}

function toggleExpand(item, expand) {
  const dom = item._dom;
  if (!dom) return;
  dom.root.classList.toggle("expanded", expand);
  if (expand) state.expanded.add(item.id);
  else state.expanded.delete(item.id);
  dom.expandText.textContent = expand
    ? `收起藏品`
    : `展开全部 ${item.codexItems.length} 件`;
}

/** 卡片闪烁高亮 3 秒（被识别时调用） */
function flashCard(id) {
  const item = state.byId.get(String(id));
  if (!item || !item._dom) return;
  const root = item._dom.root;
  root.classList.remove("hit-flash");
  // 强制重排，保证连续命中时动画能重播
  void root.offsetWidth;
  root.classList.add("hit-flash");
  const old = state.flashTimers.get(item.id);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    root.classList.remove("hit-flash");
    state.flashTimers.delete(item.id);
  }, FLASH_MS);
  state.flashTimers.set(item.id, timer);
}

/** 滚动到某张卡片并闪烁（点击命中记录时） */
function focusCard(id) {
  const item = state.byId.get(String(id));
  if (!item || !item._dom) {
    showError(`图鉴里找不到音效 ${id}`, { warn: true, timeout: 5000 });
    return;
  }
  if (state.search) {
    // 卡片可能被搜索过滤掉了，先清空搜索
    state.search = "";
    const input = $("#search-input");
    if (input) input.value = "";
    syncSearchBox();
    applyFilter();
  }
  const root = item._dom.root;
  root.scrollIntoView({ behavior: "smooth", block: "center" });
  flashCard(id);
}

/* ================= 试听 ================= */

function playPreview(item, btn) {
  const same = state.audioBtn === btn && state.audio;
  stopPreview();
  if (same) return; // 再点一次 = 停止

  let audio;
  try {
    audio = new Audio(item.audioUrl);
  } catch (e) {
    showError(`试听失败：${e.message}`, { timeout: 6000 });
    return;
  }
  state.audio = audio;
  state.audioBtn = btn;
  btn.classList.add("playing");
  btn.textContent = "❚❚ 播放中";

  audio.addEventListener("ended", () => {
    if (state.audio === audio) stopPreview();
  });
  audio.addEventListener("error", () => {
    // 注意：stopPreview() 里把 src 置空也会触发 error 事件，
    // 那种情况已经不是在播了，必须直接忽略，否则每次试听结束都会弹一条假的「无法加载」。
    if (state.audio !== audio) return;
    stopPreview();
    showError(`试听失败：无法加载 ${item.name} 的音频`, { timeout: 6000 });
  });
  const p = audio.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => {
      if (state.audio === audio) stopPreview();
      showError("试听失败：浏览器阻止了自动播放", { timeout: 6000 });
    });
  }
}

function stopPreview() {
  const audio = state.audio;
  const btn = state.audioBtn;
  state.audio = null;
  state.audioBtn = null;
  if (audio) {
    try {
      audio.pause();
      audio.src = "";
    } catch (e) {
      /* 忽略 */
    }
  }
  if (btn) {
    btn.classList.remove("playing");
    btn.textContent = "▶ 试听";
  }
}

/* ================= 改名（行内编辑） ================= */

function beginRename(item) {
  const dom = item._dom;
  if (!dom || dom.renaming) return;
  dom.renaming = true;

  const input = el("input", "card-rename-input");
  input.type = "text";
  input.value = item.name;
  input.maxLength = 40;
  dom.title.hidden = true;
  dom.title.after(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    input.remove();
    dom.title.hidden = false;
    dom.renaming = false;

    if (!save || !next || next === item.name) return;
    dom.title.textContent = next; // 先乐观更新
    try {
      const res = await postJSON(API.rename, { id: item.id, name: next });
      item.name = res && res.name ? res.name : next;
      dom.title.textContent = item.name;
      refreshHitNames(item.id);
      applyFilter();
      toast(`已改名为「${item.name}」`);
    } catch (e) {
      dom.title.textContent = item.name; // 回滚
      showError(`改名失败：${e.message}`, { timeout: 8000 });
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

/** 改名后同步命中记录里的名字 */
function refreshHitNames(id) {
  const item = state.byId.get(String(id));
  if (!item) return;
  for (const row of state.hits) {
    if (String(row.id) === String(id)) {
      row.name = item.name;
      if (row.el) row.el.name.textContent = item.name;
    }
  }
}

/* ================= 搜索过滤 ================= */

function applyFilter() {
  const q = state.search.trim().toLowerCase();
  const grid = $("#card-grid");
  const empty = $("#empty-state");
  if (!grid) return;

  let visible = 0;
  for (const item of state.items) {
    const dom = item._dom;
    if (!dom) continue;
    const nameHit = !q || item.name.toLowerCase().includes(q);
    const codexHit = !!q && item.codexItems.some((c) => c.name.toLowerCase().includes(q));
    const show = !q || nameHit || codexHit;
    dom.root.hidden = !show;
    if (show) visible += 1;

    if (q) {
      // 搜索命中藏品时自动展开，方便直接看到是哪件
      const expand = codexHit && !nameHit;
      dom.root.classList.toggle("expanded", expand || state.expanded.has(item.id));
      dom.expandText.textContent = dom.root.classList.contains("expanded")
        ? "收起藏品"
        : `展开全部 ${item.codexItems.length} 件`;
    } else {
      const expand = state.expanded.has(item.id);
      dom.root.classList.toggle("expanded", expand);
      dom.expandText.textContent = expand
        ? "收起藏品"
        : `展开全部 ${item.codexItems.length} 件`;
    }
  }

  if (empty) {
    if (state.items.length && visible === 0) {
      empty.hidden = false;
      $("#empty-text").textContent = `没有找到匹配「${state.search.trim()}」的音效或藏品。`;
      $("#btn-reset-search").hidden = false;
    } else {
      empty.hidden = true;
    }
  }
}

function syncSearchBox() {
  const box = $(".search-box");
  if (!box) return;
  box.dataset.filled = state.search ? "true" : "false";
}

/* ================= 左栏：设备 ================= */

async function loadDevices() {
  try {

    const d = await api(API.devices);
    state.devices = {
      loopback: Array.isArray(d.loopback) ? d.loopback : [],
      input: Array.isArray(d.input) ? d.input : [],
      defaultLoopback: d.defaultLoopback != null ? d.defaultLoopback : -1,
    };
    if (d.error) showError(`设备列表不完整：${d.error}`, { warn: true, timeout: 10000 });
    rebuildDeviceSelect();
    updateDeviceHint();
  } catch (e) {
    state.devices = { loopback: [], input: [], defaultLoopback: -1 };
    rebuildDeviceSelect();
    updateDeviceHint();
    showError(`读取音频设备失败：${e.message}`, { timeout: 10000 });
  }
}

/** 重建设备下拉：回环组 + 麦克风组，当前音频源那一组排前面 */
function rebuildDeviceSelect() {
  const sel = $("#device-select");
  if (!sel) return;

  const groups = [
    { label: "系统声音（回环）", list: state.devices.loopback, kind: "loopback" },
    { label: "麦克风 / 输入", list: state.devices.input, kind: "input" },
  ];
  if (state.sourceKind === "input") groups.reverse();

  clear(sel);
  const auto = el("option", null, state.sourceKind === "input" ? "默认麦克风（自动）" : "默认回环设备（自动）");
  auto.value = "";
  sel.appendChild(auto);

  for (const g of groups) {
    if (!g.list.length) continue;
    const og = document.createElement("optgroup");
    og.label = g.label;
    for (const d of g.list) {
      const opt = el("option", null, d.name || `设备 ${d.index}`);
      opt.value = String(d.index);
      opt.dataset.kind = g.kind;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }

  // 恢复选择；选中的设备不属于当前分组时退回默认
  if (state.deviceIndex != null) {
    const want = String(state.deviceIndex);
    const found = Array.from(sel.options).some((o) => o.value === want);
    if (found) sel.value = want;
    else {
      state.deviceIndex = null;
      sel.value = "";
    }
  } else {
    sel.value = "";
  }
}

function updateDeviceHint() {
  const hint = $("#device-hint");
  const label = $("#source-hint");
  if (label) label.textContent = state.sourceKind === "loopback" ? "系统回环" : "麦克风";
  if (!hint) return;

  const list = state.sourceKind === "loopback" ? state.devices.loopback : state.devices.input;
  if (!list.length) {
    hint.textContent =
      state.sourceKind === "loopback"
        ? "没有检测到回环设备。请确认已安装 pyaudiowpatch，且系统有正在播放的声音输出。"
        : "没有检测到麦克风设备。请检查系统录音权限。";
    return;
  }
  if (state.deviceIndex == null) {
    // 回环时把后端认定的默认设备名字也带上，用户能一眼确认录的是哪路输出
    let defName = "";
    if (state.sourceKind === "loopback" && state.devices.defaultLoopback != null && state.devices.defaultLoopback >= 0) {
      const def = state.devices.loopback.find((d) => Number(d.index) === Number(state.devices.defaultLoopback));
      if (def) defName = `：${def.name}`;
    }
    hint.textContent =
      state.sourceKind === "loopback"
        ? `将使用默认回环设备${defName}（共 ${list.length} 个可用）。游戏声音直接从这里录，无需开麦。`
        : `将使用默认麦克风（共 ${list.length} 个可用）。`;
    return;
  }
  const dev = list.find((d) => Number(d.index) === Number(state.deviceIndex));
  hint.textContent = dev ? `当前选择：${dev.name} · ${dev.sampleRate} Hz · ${dev.channels} 声道` : "设备已失效，将使用默认设备。";
}

function updateTabs() {
  for (const btn of document.querySelectorAll("#source-tabs .seg-btn")) {
    const on = btn.dataset.kind === state.sourceKind;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
}

/* ================= 左栏：监听开关 ================= */

function setLiveButton(kind, text) {
  const btn = $("#btn-live");
  const label = $("#live-label");
  const icon = $("#live-icon");
  if (!btn || !label || !icon) return;
  btn.dataset.state = kind;
  label.textContent = text;
  icon.textContent = kind === "running" ? "■" : kind === "busy" ? "…" : "▶";
  btn.disabled = kind === "busy";
}

async function startLive() {
  if (state.live.busy) return;
  state.live.busy = true;
  setLiveButton("busy", "启动中…");
  try {
    const status = await postJSON(API.liveStart, { deviceIndex: state.deviceIndex });
    state.live.running = true;
    renderStatus(status);
    // 新一轮监听，3×3 藏品面板清空（停止时是保留，两处语义不同）
    renderStash(null, true);
    openEvents();
    setLiveButton("running", "停止监听");
    setStatus("监听中", "ok");
    const devName = status && status.device ? status.device.name : "默认设备";
    toast(`开始监听 · ${devName}`);
  } catch (e) {
    state.live.running = false;
    setLiveButton("idle", "开始监听");
    setStatus("就绪", "ok");
    showError(`启动监听失败：${e.message}`, { timeout: 12000 });
  } finally {
    state.live.busy = false;
  }
}

async function stopLive() {
  if (state.live.busy) return;
  state.live.busy = true;
  setLiveButton("busy", "停止中…");
  closeEvents();
  try {
    const res = await postJSON(API.liveStop, {});
    // 停止时后端会把还没等到释放窗口的候选强制结算，
    // 这些“迟到的命中”只在这里回来，要补进命中记录。
    for (const hit of (res && Array.isArray(res.hits) ? res.hits : [])) {
      addHit(hit);
      bumpVerdictCount(1);
    }
  } catch (e) {
    showError(`停止监听失败：${e.message}`, { timeout: 8000 });
  } finally {
    state.live.running = false;
    state.live.busy = false;
    setLiveButton("idle", "开始监听");
    setStatus("就绪", "ok");
    resetLiveUI();
  }
}

function resetLiveUI() {
  renderMeter({ bars: [], active: false, levelDb: -90 });
  renderVerdict(null);
  const elapsed = $("#live-elapsed");
  if (elapsed) elapsed.textContent = "00:00.0";
  const device = $("#live-device");
  if (device) device.textContent = "未开始";
  // 「累计 N 次」是本次会话的累计，停止监听不清零，只由后端 status 与文件识别驱动
  updateVerdictCount();
}

/* ================= SSE ================= */

function openEvents() {
  closeEvents();
  let es;
  try {
    es = new EventSource(API.liveEvents);
  } catch (e) {
    showError(`无法建立事件连接：${e.message}`, { timeout: 10000 });
    return;
  }
  state.es = es;

  es.addEventListener("open", () => {
    removeReconnectBar();
    if (state.live.running) setStatus("监听中", "ok");
  });

  es.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return; // 心跳或脏数据，忽略
    }
    handleEvent(msg);
  });

  es.addEventListener("error", () => {
    // EventSource 会自动重连（服务端 retry: 2000），这里只负责提示
    showReconnectBar();
  });
}

function closeEvents() {
  const es = state.es;
  if (!es) return;
  es.onopen = null;
  es.onmessage = null;
  es.onerror = null;
  try {
    es.close();
  } catch (e) {
    /* 忽略 */
  }
  state.es = null;
  removeReconnectBar();
}

function showReconnectBar() {
  if (state.reconnectBar) return;
  state.reconnectBar = showError("连接断开，重连中…（本地服务是否还在运行？）", { warn: true, timeout: 0 });
  setStatus("连接断开，重连中…", "warn");
}

function removeReconnectBar() {
  if (state.reconnectBar) {
    dismissError(state.reconnectBar);
    state.reconnectBar = null;
  }
  if (state.live.running) setStatus("监听中", "ok");
}

function handleEvent(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hit" && msg.hit) {
    addHit(msg.hit);
  } else if (msg.type === "status" && msg.status) {
    renderStatus(msg.status);
  }
  // ping 不需要处理
}

/* ================= 状态渲染 ================= */

function renderStatus(status) {
  if (!status) return;
  state.live.running = !!status.running;
  state.live.elapsed = Number(status.elapsed) || 0;
  state.live.confirmations = Number(status.confirmations) || 0;

  if (!state.live.busy) {
    setLiveButton(status.running ? "running" : "idle", status.running ? "停止监听" : "开始监听");
  }

  const elapsed = $("#live-elapsed");
  if (elapsed) elapsed.textContent = formatElapsed(status.running ? status.elapsed : 0);

  const device = $("#live-device");
  if (device) {
    device.textContent = status.device && status.device.name ? status.device.name : status.running ? "默认设备" : "未开始";
  }

  updateVerdictCount();

  renderMeter(status.meter);
  renderVerdict(status.lastVerdict);

  if (status.error) {
    showError(`采集异常：${status.error}`, { warn: true, timeout: 12000 });
  }
}

/** 电平柱状图：把 meter.bars 画成 160 根柱子，active 时整体高亮 */
function renderMeter(meter) {
  const box = $("#meter");
  if (!box) return;
  const bars = meter && Array.isArray(meter.bars) ? meter.bars : [];
  const active = !!(meter && meter.active);
  box.dataset.active = active ? "true" : "false";

  const pad = Math.max(0, METER_BARS - bars.length);
  for (let i = 0; i < METER_BARS; i += 1) {
    const node = state.meterEls[i];
    if (!node) continue;
    const v = i < pad ? 0 : Number(bars[i - pad]) || 0;
    const h = Math.round(4 + Math.min(1, Math.max(0, v)) * 96);
    if (node._h !== h) {
      node._h = h;
      node.style.height = `${h}%`;
    }
    const hot = v > 0.88;
    if (node._hot !== hot) {
      node._hot = hot;
      node.classList.toggle("hot", hot);
    }
  }

  const readout = $("#level-readout");
  if (readout) {
    const lv = meter && Number.isFinite(meter.levelDb) ? Number(meter.levelDb) : -90;
    readout.textContent = lv <= -89 ? "−∞ dB" : `${lv.toFixed(1)} dB`;
  }
  const activeLabel = $("#meter-active-label");
  if (activeLabel) activeLabel.textContent = active ? "● 有声音" : "等待声音";
}

/** 当前判定 */
function renderVerdict(verdict) {
  const panel = $("#verdict-panel");
  const name = $("#verdict-name");
  const facts = $("#verdict-facts");
  const fill = $("#verdict-bar-fill");
  if (!panel || !name || !facts || !fill) return;

  if (!verdict) {
    panel.dataset.has = "false";
    name.textContent = "等待声音…";
    clear(facts);
    facts.appendChild(el("span", null, "听到拾取音效后，这里会显示判定结果"));
    fill.style.width = "0%";
    renderStash(null);
    return;
  }

  panel.dataset.has = "true";
  name.textContent = verdict.name || `音效 ${verdict.id}`;

  const score = Number(verdict.score) || 0;
  const conf = Number(verdict.confidence) || 0;
  const gap = Number(verdict.gap) || 0;
  clear(facts);
  facts.append(
    el("span", null, `相似度 ${score.toFixed(2)}`),
    el("span", null, `· 置信度 ${conf.toFixed(2)}`),
    el("span", null, `· 领先 ${gap.toFixed(2)}`)
  );
  fill.style.width = `${Math.max(0, Math.min(1, conf)) * 100}%`;
  renderStash(verdict);
}

/* ================= 本次藏品：按占格分组，同占格一行，行内价值降序 ================= */

// 站点给的格式是「占格 3×2」，也见过 x / * 两种写法，全部兼容
const SIZE_RE = /占格\s*(\d+)\s*[x×*]\s*(\d+)/;

/** 「占格 2×3」→ {w:2,h:3}；解析不出来就当 1×1 */
function parseSlots(size) {
  const m = SIZE_RE.exec(String(size || ""));
  if (!m) return { w: 1, h: 1 };
  return {
    w: Math.max(1, Number(m[1]) || 1),
    h: Math.max(1, Number(m[2]) || 1),
  };
}

/**
 * 按占格分组：同一占格的一行，行内按价值从高到低。
 * 行的顺序按「面积大 → 面积小、宽 → 窄」排，大件在最上面。
 */
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
  // 占格越大，卡片越宽；缩略图框按 w:h 变形，一眼能看出 3×2 和 1×1 的差别
  tile.style.width = `${54 + (w - 1) * 17}px`;
  tile.style.animationDelay = `${Math.min(index, 10) * 22}ms`;
  tile.title = `${item.name} · ${item.size || "占格 1×1"} · 价值 ${formatValue(item.value)}`;
  // 留给自测/调试读：真实数值比格式化后的「100W」好断言
  tile.dataset.name = item.name;
  tile.dataset.size = `${w}×${h}`;
  tile.dataset.value = String(Number(item.value) || 0);

  const pic = el("div", "ti");
  pic.style.aspectRatio = `${w} / ${h}`;
  if (item.thumbUrl) pic.style.backgroundImage = `url("${item.thumbUrl}")`;
  else pic.classList.add("placeholder");

  const name = el("div", "tn", item.name);
  const val = el("div", "tv", formatValue(item.value));
  tile.append(pic, name, val);
  return tile;
}

/**
 * 渲染「本次藏品」面板。
 * verdict 可能来自 SSE status（没有 item 字段），所以要按 id 回查 state.byId。
 * force=true 时强制清空（开始新一次监听用）；停止监听传入 null 时保留上一次的结果，
 * 否则用户刚看到的东西会在点「停止」的瞬间消失。
 */
function renderStash(verdict, force) {
  const panel = $("#stash-panel");
  const box = $("#stash-rows");
  const hint = $("#stash-hint");
  if (!panel || !box) return;

  const id = verdict && verdict.id != null ? String(verdict.id) : null;
  // 同一段音效不重画：SSE 每 250ms 推一次 status，重画会让入场动画一直重播。
  if (!force) {
    if (id === null && state.stashId !== null) return;
    if (id !== null && id === state.stashId) return;
  }
  state.stashId = id;

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
  let tileIndex = 0;
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
      line.appendChild(buildStashTile(it, tileIndex));
      tileIndex += 1;
    }
    wrap.append(head, line);
    frag.appendChild(wrap);
  }
  box.appendChild(frag);
}

/** 文件识别没有 SSE 的 status 推送，单独记一份计数，避免被下一次 status 覆盖 */
function bumpVerdictCount(n) {
  state.live.fileConfirmations += n;
  updateVerdictCount();
}

/** 「累计 N 次」= 实时确认数 + 文件识别命中数 */
function updateVerdictCount() {
  const count = $("#verdict-count");
  if (!count) return;
  const total = (Number(state.live.confirmations) || 0) + (Number(state.live.fileConfirmations) || 0);
  count.textContent = `累计 ${total} 次`;
}

/* ================= 命中记录 ================= */

function addHit(hit) {
  const entry = {
    id: String(hit.id),
    name: hit.name || `音效 ${hit.id}`,
    atSec: Number(hit.atSec) || 0,
    confidence: Number(hit.confidence) || 0,
    score: Number(hit.score) || 0,
    itemCount: Number(hit.itemCount) || 0,
    el: null,
  };

  const list = $("#hits-list");
  if (!list) return;
  const empty = $("#hits-empty");
  if (empty) empty.hidden = true;

  const row = buildHitRow(entry);
  entry.el = row.dom;
  list.appendChild(row.node);
  state.hits.push(entry);

  // 最多保留 50 条
  while (state.hits.length > MAX_HITS) {
    const old = state.hits.shift();
    if (old && old.node && old.node.parentNode) old.node.parentNode.removeChild(old.node);
  }

  // 用户已经在底部附近时自动滚到最新
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 80) {
    list.scrollTop = list.scrollHeight;
  }

  flashCard(entry.id);
}

function buildHitRow(entry) {
  const node = el("li", "hit-row");
  node.dataset.id = entry.id;
  node.title = "点击定位到图鉴卡片";

  const time = el("span", "hit-time", formatClock(entry.atSec));
  const main = el("div", "hit-main");
  const name = el("div", "hit-name", entry.name);
  const sub = el("div", "hit-sub");
  const bar = el("div", "hit-bar");
  const barFill = el("i");
  barFill.style.width = `${Math.max(0, Math.min(1, entry.confidence)) * 100}%`;
  bar.appendChild(barFill);
  const conf = el("span", "hit-conf", `${Math.round(entry.confidence * 100)}%`);
  sub.append(bar, conf);
  main.append(name, sub);

  const badge = el("span", "hit-badge", entry.itemCount ? `${entry.itemCount} 件` : "命中");

  node.append(time, main, badge);
  node.addEventListener("click", () => focusCard(entry.id));

  // entry.node 用于超量时移除；entry.dom 给改名同步用
  entry.node = node;
  return { node, dom: { node, name, badge } };
}

function clearHits() {
  state.hits = [];
  const list = $("#hits-list");
  if (!list) return;
  clear(list);
  const empty = el("li", "hits-empty", "还没有命中，开始监听后这里会记录每一次识别。");
  empty.id = "hits-empty";
  list.appendChild(empty);
}

/* ================= 文件识别（POST /api/recognize） ================= */

async function recognizeFile(file) {
  if (!file) return;
  const progress = $("#file-progress");
  const fill = $("#fp-fill");
  const text = $("#fp-text");
  if (progress) progress.hidden = false;
  if (fill) fill.style.width = "0%";
  if (text) text.textContent = `识别中…（${file.name}）`;

  const form = new FormData();
  form.append("file", file, file.name);

  try {
    const res = await api(API.recognize, { method: "POST", body: form });
    const hits = Array.isArray(res.hits) ? res.hits : [];
    if (text) text.textContent = `识别完成：${hits.length} 次命中 / ${(Number(res.duration) || 0).toFixed(2)}s`;
    if (fill) fill.style.width = "100%";

    if (!hits.length) {
      toast("这段音频里没有识别到拾取音效", "err");
    } else {
      for (const h of hits) addHit(h);
      toast(`识别完成：命中 ${hits.length} 次`);
    }
    // 文件识别的结果同样回填到「当前判定」，否则用户拖完文件后大字区域还是「等待声音…」
    renderVerdict(res.best && res.best.id ? res.best : null);
    if (hits.length) bumpVerdictCount(hits.length);
    if (res.best && res.best.id) focusCard(res.best.id);
    setTimeout(() => {
      if (progress) progress.hidden = true;
    }, 2200);
  } catch (e) {
    if (text) text.textContent = "识别失败";
    if (progress) progress.hidden = true;
    showError(`文件识别失败：${e.message}`, { timeout: 12000 });
  }
}

/* ================= 初始化 ================= */

function bindEvents() {
  // ---- 音频源切换
  for (const btn of document.querySelectorAll("#source-tabs .seg-btn")) {
    btn.addEventListener("click", () => {
      if (state.live.running) {
        showError("请先停止监听再切换音频源", { warn: true, timeout: 5000 });
        return;
      }
      const kind = btn.dataset.kind;
      if (!kind || kind === state.sourceKind) return;
      state.sourceKind = kind;
      state.deviceIndex = null;
      updateTabs();
      rebuildDeviceSelect();
      updateDeviceHint();
    });
  }

  // ---- 设备下拉
  const sel = $("#device-select");
  if (sel) {
    sel.addEventListener("change", () => {
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      if (!sel.value) {
        state.deviceIndex = null;
      } else {
        state.deviceIndex = Number(sel.value);
        const kind = opt && opt.dataset ? opt.dataset.kind : null;
        if (kind && kind !== state.sourceKind) {
          state.sourceKind = kind;
          updateTabs();
          rebuildDeviceSelect();
        }
      }
      updateDeviceHint();
    });
  }

  const refresh = $("#btn-refresh-devices");
  if (refresh) {
    refresh.addEventListener("click", () => {
      refresh.disabled = true;
      loadDevices().finally(() => {
        refresh.disabled = false;
      });
    });
  }

  // ---- 开始 / 停止
  const live = $("#btn-live");
  if (live) {
    live.addEventListener("click", () => {
      if (state.live.busy) return;
      if (state.live.running) stopLive();
      else startLive();
    });
  }

  // ---- 清空命中
  const clearBtn = $("#btn-clear-hits");
  if (clearBtn) clearBtn.addEventListener("click", clearHits);

  // ---- 搜索
  const search = $("#search-input");
  if (search) {
    search.addEventListener("input", () => {
      state.search = search.value;
      syncSearchBox();
      applyFilter();
    });
  }
  const searchClear = $("#search-clear");
  if (searchClear) {
    searchClear.addEventListener("click", () => {
      state.search = "";
      if (search) search.value = "";
      syncSearchBox();
      applyFilter();
      if (search) search.focus();
    });
  }
  const resetSearch = $("#btn-reset-search");
  if (resetSearch) {
    resetSearch.addEventListener("click", () => {
      state.search = "";
      if (search) search.value = "";
      syncSearchBox();
      applyFilter();
    });
  }

  // ---- 文件识别
  const drop = $("#dropzone");
  const fileInput = $("#file-input");
  if (drop && fileInput) {
    drop.addEventListener("click", () => fileInput.click());
    // 键盘可达：回车 / 空格等同点击
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) recognizeFile(f);
      fileInput.value = "";
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("dragging");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("dragging");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) recognizeFile(f);
    });
  }

  // ---- 离开页面时断开 SSE
  window.addEventListener("beforeunload", closeEvents);

  // ---- 同步图鉴（从暗区情报站抓数据）
  const syncBtn = $("#btn-sync");
  if (syncBtn) syncBtn.addEventListener("click", runSync);
}

/* ================= 同步图鉴（从暗区情报站抓数据） ================= */

/**
 * 点按钮 → 后端跑爬虫 → 轮询进度 → 完成后重载图鉴。
 * 爬虫要下几百个文件，可能跑一两分钟，所以必须有可见进度，不能让用户以为卡死了。
 */
async function runSync() {
  const btn = $("#btn-sync");
  const label = $("#sync-label");
  if (!btn || state.sync.busy) return;

  state.sync.busy = true;
  btn.dataset.busy = "true";
  btn.dataset.state = "";
  btn.disabled = true;
  if (label) label.textContent = "抓取中 0%";

  try {
    const started = await postJSON(API.sync, {});
    if (started && started.alreadyRunning) {
      toast("已经在抓取了，等它跑完", "warn");
    }
    // 轮询到 finished 为止。爬虫在后台线程里跑，接口只读状态。
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      const st = await api(API.syncStatus);
      const pct = Math.round(clampPercent(st.progress));
      if (label) label.textContent = `抓取中 ${pct}%`;
      if (st.message) setStatus(st.message, "warn");
      if (!st.running) {
        if (st.error) throw new Error(st.error);
        if (label) label.textContent = "同步完成";
        btn.dataset.state = "done";
        // 数据变了：重拉库和健康状态，让图鉴/统计立刻反映新数据
        await Promise.allSettled([loadLibrary(), loadHealth()]);
        renderCards();
        updateLibrarySub();
        const s = st.stats || {};
        toast(
          `已同步 ${s.codexEntries || 0} 段音效 / ${s.items || 0} 件藏品` +
            (s.sounds ? ` / 音频 ${s.sounds}` : "") +
            (s.thumbs ? ` / 缩略图 ${s.thumbs}` : ""),
          "ok"
        );
        setStatus(`就绪 · ${state.items.length} 段声音`, "ok");
        if (st.needRebuild) {
          showError("数据已更新，但识别库还没重建。重启服务（或加 --rebuild）后新音频才会生效。");
        }
        break;
      }
    }
  } catch (err) {
    if (label) label.textContent = "同步失败";
    btn.dataset.state = "error";
    showError(`同步失败：${err.message}`);
  } finally {
    state.sync.busy = false;
    btn.dataset.busy = "false";
    btn.disabled = false;
    // 3 秒后把按钮文字复原，别一直挂着「同步完成」
    setTimeout(() => {
      if (label && !state.sync.busy) label.textContent = "同步图鉴";
    }, 3000);
  }
}

function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/* ================= 手机端入口（二维码） ================= */

async function loadPhonePanel() {
  const panel = $("#phone-panel");
  const box = $("#phone-qr");
  const urlNode = $("#phone-url");
  const tip = $("#phone-tip");
  if (!panel || !box || !urlNode) return;

  let net;
  try {
    net = await api(API.net);
  } catch (err) {
    panel.dataset.reachable = "false";
    box.innerHTML = "";
    box.appendChild(el("span", "qr-fail", "读不到网络信息"));
    if (tip) tip.textContent = `获取局域网地址失败：${err.message}`;
    return;
  }

  const url = net && net.mobileUrl;
  state.net = net || null;
  if (!url) {
    panel.dataset.reachable = "false";
    box.innerHTML = "";
    box.appendChild(el("span", "qr-fail", "没有局域网地址"));
    if (tip) tip.textContent = "没检测到局域网地址，手机可能连不上。";
    return;
  }

  urlNode.textContent = url;
  // 二维码直接拉后端生成的 SVG，前端不引第三方库
  const img = document.createElement("img");
  img.alt = `手机端二维码：${url}`;
  img.src = `${API.qrSvg}?url=${encodeURIComponent(url)}`;
  img.style.width = "100%";
  img.style.height = "100%";
  img.style.display = "block";
  img.addEventListener("error", () => {
    box.innerHTML = "";
    box.appendChild(el("span", "qr-fail", "二维码生成失败"));
  });
  box.innerHTML = "";
  box.appendChild(img);

  const reachable = net && net.loopbackOnly === false;
  panel.dataset.reachable = reachable ? "true" : "false";
  if (!reachable) {
    if (tip) {
      tip.textContent =
        "现在服务只监听了 127.0.0.1，手机连不上。用 python scripts/run.py --lan 重启服务后再扫码。";
    }
  } else if (tip) {
    const count = (net.lanIps || []).length;
    tip.textContent =
      count > 1
        ? `手机连同一个 Wi-Fi，扫左边的码；打不开就换下面别的地址试。`
        : "手机连同一个 Wi-Fi，扫左边的码就能打开手机版界面。";
  }
}

function buildMeter() {
  const box = $("#meter-bars");
  if (!box) return;
  clear(box);
  state.meterEls = [];
  for (let i = 0; i < METER_BARS; i += 1) {
    const node = el("div", "meter-bar");
    node.style.height = "4%";
    box.appendChild(node);
    state.meterEls.push(node);
  }
}

async function init() {
  buildMeter();
  bindEvents();
  updateTabs();
  setStatus("正在加载…", "warn");
  setLiveButton("idle", "开始监听");
  renderVerdict(null);
  syncSearchBox();

  // health / library / devices 并行拉取，谁失败谁自己报错，互不阻塞
  await Promise.allSettled([loadHealth(), loadLibrary(), loadDevices()]);

  // 手机端二维码面板：拿不到局域网信息也不该挡主流程
  loadPhonePanel();

  // 后端可能已经在监听（比如用户只是刷新了页面），自动接上 SSE
  await syncLiveState();

  if (state.health && state.items.length) {
    setStatus(`就绪 · ${state.health.sounds || state.items.length} 段声音`, "ok");
  }
}

init();
