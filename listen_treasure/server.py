"""本地 Web 服务：把识别引擎包成 HTTP + SSE 接口，配一个静态前端。

为什么用本地服务而不是纯桌面 GUI：
  1. 前端用浏览器写，样式/交互随便做，不用学 Tkinter；
  2. SSE 天然适合“实时吐判定”这种单向推送；
  3. 以后想做成 exe，把 uvicorn 塞进 PyInstaller 就行，界面代码一行不用改。

线程模型：
  uvicorn 跑在 asyncio 事件循环里，实时识别的重活在 LiveRecognizer 自己的
  后台线程里跑（PyAudio 回调 → 队列 → 识别线程），HTTP 侧只读事件列表。
  绝不能在 async 端点里直接做 FFT，那会把整个服务卡住。
"""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import capture as capture_mod
from . import config
from . import library as library_mod
from . import netinfo
from .engine import FileRecognizer, LiveRecognizer
from .library import SoundLibrary

# ---------------------------------------------------------------- 全局状态

_lib: SoundLibrary | None = None
_live: LiveRecognizer | None = None
_started_at = time.time()

# 允许上传的扩展名。真正能不能解码由 soundfile/标准库说了算，
# 这里只是提前挡掉明显不对的文件，省得把 5MB 视频喂进解码器。
_ALLOWED_SUFFIX = {".wav", ".mp3", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".aiff", ".aif", ".wma"}
_MAX_UPLOAD = 64 * 1024 * 1024


def library() -> SoundLibrary:
    """懒加载声音库（第一次请求时才读 900KB 的 json）。"""
    global _lib
    if _lib is None:
        try:
            _lib = SoundLibrary.load(config.LIBRARY_JSON)
        except FileNotFoundError as exc:
            raise HTTPException(500, str(exc)) from exc
        library_mod.apply_name_overrides(_lib)
    return _lib


def live() -> LiveRecognizer:
    global _live
    if _live is None:
        _live = LiveRecognizer(library())
    return _live


# ---------------------------------------------------------------- 数据模型


class RenameBody(BaseModel):
    id: str
    name: str


class LiveStartBody(BaseModel):
    deviceIndex: int | None = None


# ---------------------------------------------------------------- 应用

app = FastAPI(title="行商听声鉴宝", docs_url=None, redoc_url=None)


def _json(data: object, status: int = 200) -> JSONResponse:
    return JSONResponse(content=data, status_code=status)


def _library_item_json(lib: SoundLibrary, it) -> dict:
    """图鉴条目 + 缩略图 URL。前端拿到的就是这个。"""
    items = []
    for cx in it.codex_items:
        row = dict(cx)
        thumb = lib.thumb_path(cx)
        row["thumbUrl"] = f"/api/thumbs/{thumb.name}" if thumb else None
        items.append(row)
    return {
        "id": it.id,
        "name": it.name,
        "category": it.category,
        "duration": round(float(it.duration), 3),
        "valueMin": it.value_min,
        "valueMax": it.value_max,
        "itemCount": it.item_count,
        "audioUrl": f"/api/sounds/{it.id}.wav",
        "codexItems": items,
    }


# ---------------------------------------------------------------- 基础接口


@app.get("/api/health")
def api_health() -> JSONResponse:
    lib = library()
    return _json({
        "ok": True,
        "version": lib.version,
        "sounds": len(lib.items),
        "items": lib.total_items(),
        "sampleRate": lib.sample_rate,
        "uptime": round(time.time() - _started_at, 1),
    })


@app.get("/api/library")
def api_library() -> JSONResponse:
    lib = library()
    return _json({"items": [_library_item_json(lib, it) for it in lib.items]})


@app.post("/api/rename")
def api_rename(body: RenameBody) -> JSONResponse:
    lib = library()
    it = lib.item(body.id)
    if it is None:
        raise HTTPException(404, f"没有这个音效：{body.id}")
    name = lib.rename(body.id, body.name)
    # 名字写进 data/name-overrides.json，重建库也不会丢
    library_mod.save_name_override(body.id, name if name != it.base_name else "")
    return _json({"ok": True, "id": body.id, "name": name})


@app.get("/api/devices")
def api_devices() -> JSONResponse:
    try:
        return _json(capture_mod.list_devices())
    except Exception as exc:  # 没有声卡/没装 pyaudiowpatch 时不要 500
        return _json({"loopback": [], "input": [], "defaultLoopback": -1,
                      "error": f"{type(exc).__name__}: {exc}"})


# ---------------------------------------------------------------- 实时识别


@app.post("/api/live/start")
def api_live_start(body: LiveStartBody) -> JSONResponse:
    engine = live()
    try:
        return _json(engine.start(body.deviceIndex))
    except Exception as exc:
        raise HTTPException(500, f"启动采集失败：{exc}") from exc


@app.post("/api/live/stop")
def api_live_stop() -> JSONResponse:
    late = []
    if _live is not None:
        late = _live.stop()
    return _json({"ok": True, "hits": late})


@app.get("/api/live/status")
def api_live_status() -> JSONResponse:
    if _live is None:
        return _json({"running": False, "device": None, "elapsed": 0.0, "frames": 0,
                      "confirmations": 0,
                      "meter": {"levelDb": -90.0, "floorDb": -90.0, "active": False, "bars": []},
                      "lastVerdict": None, "error": None})
    return _json(_live.status())


@app.get("/api/live/events")
async def api_live_events(request: Request) -> StreamingResponse:
    """SSE：把命中事件和状态快照推给浏览器。

    用“轮询内部列表 + asyncio.sleep”而不是真队列，是因为识别线程是普通
    threading.Thread，跨线程 await 反而更麻烦；250ms 一次的轮询对这个
    数据量完全够（事件本来就只有命中时才有）。
    """

    async def gen():
        yield "retry: 2000\n\n"
        last_status = 0.0
        idle = 0.0
        while True:
            if await request.is_disconnected():
                break
            engine = _live
            if engine is not None:
                for ev in engine.read_events():
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                now = time.time()
                if now - last_status >= 0.25:
                    last_status = now
                    payload = {"type": "status", "status": engine.status()}
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            else:
                # 没启动时也要保持连接活着，否则前端 onerror 会一直重连
                idle += 0.25
                if idle >= 5.0:
                    idle = 0.0
                    yield 'data: {"type":"ping"}\n\n'
            await asyncio.sleep(0.25)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------- 文件识别


@app.post("/api/recognize")
async def api_recognize(file: UploadFile = File(...)) -> JSONResponse:
    suffix = Path(file.filename or "upload.wav").suffix.lower()
    if suffix and suffix not in _ALLOWED_SUFFIX:
        raise HTTPException(400, f"不支持的格式：{suffix}")

    tmp_path: Path | None = None
    try:
        # 先落盘：soundfile 要能随机访问文件头，而且解码失败时能重试别的后端
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix or ".wav") as fh:
            tmp_path = Path(fh.name)
            size = 0
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                if size > _MAX_UPLOAD:
                    raise HTTPException(413, "文件太大（上限 64MB）")
                fh.write(chunk)
        if size == 0:
            raise HTTPException(400, "空文件")

        lib = library()
        recognizer = FileRecognizer(lib)
        try:
            result = await asyncio.to_thread(recognizer.recognize_file, str(tmp_path))
        except Exception as exc:
            raise HTTPException(400, f"音频解码失败：{exc}") from exc
        return _json(result.to_json())
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except OSError:
                pass
        await file.close()


# ---------------------------------------------------------------- 静态资源


@app.get("/api/sounds/{sid}.wav")
def api_sound(sid: str):
    lib = library()
    it = lib.item(sid)
    if it is None:
        raise HTTPException(404, "没有这个音效")
    path = lib.audio_path(it)
    if not path.exists():
        raise HTTPException(404, "音频文件不存在")
    return FileResponse(path, media_type="audio/wav", filename=path.name)


@app.get("/api/thumbs/{img}.webp")
def api_thumb(img: str):
    # 只允许 16 进制文件名，挡掉 ../ 之类的路径穿越
    if not img or any(c not in "0123456789abcdefABCDEF" for c in img):
        raise HTTPException(400, "非法的图片名")
    path = config.data_dir() / "items" / "thumbs" / f"{img}.webp"
    if not path.exists():
        raise HTTPException(404, "缩略图不存在")
    return FileResponse(path, media_type="image/webp")


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


# ---------------------------------------------------------------- 同步图鉴（爬虫）


class _SyncState:
    """抓取任务的状态。爬虫跑在后台线程里，HTTP 侧只读这里。"""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.running = False
        self.progress = 0.0
        self.message = ""
        self.error: str | None = None
        self.stats: dict | None = None
        self.started_at = 0.0
        self.finished_at = 0.0


_sync = _SyncState()


@app.get("/api/sync/status")
def api_sync_status() -> JSONResponse:
    with _sync.lock:
        return _json({
            "running": _sync.running,
            "progress": round(_sync.progress, 3),
            "message": _sync.message,
            "error": _sync.error,
            "stats": _sync.stats,
            "startedAt": _sync.started_at,
            "finishedAt": _sync.finished_at,
            # 库这边已经重建过了；只有「需要重建但没成功」时才提醒用户
            "needRebuild": bool(_sync.stats and not _sync.running
                                and _sync.stats.get("newSounds")
                                and not _sync.stats.get("rebuilt")),
        })


def _reload_library() -> str | None:
    """重建并换掉内存里的声音库。返回错误信息，成功返回 None。

    抓完数据必须走这一步：codex.json 里的藏品价值/名称变了，但正在跑的
    LiveRecognizer 和已加载的 SoundLibrary 都还是旧对象，不换掉的话
    页面上要一直显示旧价格，直到用户重启服务。
    """
    global _lib, _live
    try:
        library_mod.build_library_from_codex()
        _lib = SoundLibrary.load(config.LIBRARY_JSON)
        library_mod.apply_name_overrides(_lib)
        # LiveRecognizer 持着 lib 引用，一并重建；正在监听的话停掉再起
        if _live is not None:
            was_running = bool(_live.status().get("running"))
            device = _live.status().get("device") or {}
            _live.stop()
            _live = LiveRecognizer(_lib)
            if was_running:
                _live.start(device.get("index"))
        return None
    except Exception as exc:  # noqa: BLE001 - 重建失败不该把同步状态搞乱
        return f"{type(exc).__name__}: {exc}"


def _sync_worker() -> None:
    from . import crawler

    def progress(msg: str) -> None:
        # 爬虫只报「阶段文案」，进度按阶段数粗估（接口 1 + 音频 1 + 图片 1 三段）
        with _sync.lock:
            _sync.message = msg
            _sync.progress = min(0.95, _sync.progress + 0.05)

    try:
        stats = crawler.crawl(config.data_dir(), progress=progress)
        need_rebuild = bool(stats.get("newSounds"))
        with _sync.lock:
            _sync.stats = stats
            _sync.progress = 0.96
            _sync.message = "重建识别库…" if need_rebuild else "完成"
        # 有新音频才需要重新提模板；只是价格变了也要重载，否则界面还是旧数据
        err = _reload_library()
        with _sync.lock:
            if err:
                _sync.error = f"数据已抓到，但重建识别库失败：{err}"
                _sync.message = "重建失败"
            else:
                _sync.progress = 1.0
                _sync.message = "完成"
                _sync.error = None
                # 库已经换过了，前端不用再提醒重启
                if _sync.stats is not None:
                    _sync.stats["rebuilt"] = True
    except Exception as exc:  # noqa: BLE001 - 抓取失败要把原因回给前端
        with _sync.lock:
            _sync.error = f"{type(exc).__name__}: {exc}"
            _sync.message = "失败"
    finally:
        with _sync.lock:
            _sync.running = False
            _sync.finished_at = time.time()


@app.post("/api/sync")
def api_sync() -> JSONResponse:
    """启动一次抓取。已经在跑就直接返回，不排第二份。"""
    with _sync.lock:
        if _sync.running:
            return _json({"ok": True, "alreadyRunning": True})
        _sync.running = True
        _sync.progress = 0.0
        _sync.message = "准备中…"
        _sync.error = None
        _sync.stats = None
        _sync.started_at = time.time()
        _sync.finished_at = 0.0
        _sync.thread = threading.Thread(target=_sync_worker, name="crawler", daemon=True)
        _sync.thread.start()
    return _json({"ok": True, "alreadyRunning": False})


# ---------------------------------------------------------------- 局域网 / 手机端


@app.get("/api/net")
def api_net(request: Request) -> JSONResponse:
    """告诉前端怎么让手机连上来：本机地址 + 候选局域网地址 + 二维码。"""
    port = request.url.port or config.PORT
    ips = netinfo.lan_ips()
    mobile_urls = [f"http://{ip}:{port}/m" for ip in ips]
    return _json({
        "port": port,
        "primaryIp": ips[0] if ips else None,
        "lanIps": ips,
        "mobileUrls": mobile_urls,
        # 只监听 127.0.0.1 时手机连不上，前端要据此提示用户加 --host 0.0.0.0
        "loopbackOnly": not ips,
        "mobileUrl": mobile_urls[0] if mobile_urls else None,
    })


@app.get("/api/qr.svg")
def api_qr_svg(url: str = "") -> Response:
    """二维码（SVG）。默认编码当前服务对局域网地址的手机端入口。"""
    target = url.strip() or _default_mobile_url()
    svg = netinfo.qr_svg(target)
    if svg is None:
        raise HTTPException(503, "没装 segno，无法生成二维码：pip install segno")
    return Response(svg, media_type="image/svg+xml")


@app.get("/api/qr.png")
def api_qr_png(url: str = "", scale: int = 8) -> Response:
    target = url.strip() or _default_mobile_url()
    png = netinfo.qr_png(target, scale=max(2, min(20, scale)))
    if png is None:
        raise HTTPException(503, "没装 segno，无法生成二维码：pip install segno")
    return Response(png, media_type="image/png",
                    headers={"Cache-Control": "no-store"})


def _default_mobile_url() -> str:
    ips = netinfo.lan_ips()
    ip = ips[0] if ips else "127.0.0.1"
    return f"http://{ip}:{config.PORT}/m"


# ---------------------------------------------------------------- 前端页面


_UI_DIR = config.UI_DIR
# check_dir=False：ui 目录可能在服务启动之后才生成（比如前端文件是后放的），
# 挂载时目录不存在不应该让整个服务起不来。
app.mount("/static/ui", StaticFiles(directory=str(_UI_DIR), check_dir=False), name="ui")


@app.get("/")
def index():
    page = _UI_DIR / "index.html"
    if not page.exists():
        raise HTTPException(500, "前端文件缺失：listen_treasure/ui/index.html")
    return FileResponse(page, media_type="text/html; charset=utf-8")


@app.get("/m")
def mobile_index():
    """手机端页面。路径短，扫码进去打字少。"""
    page = _UI_DIR / "mobile.html"
    if not page.exists():
        raise HTTPException(404, "手机端页面缺失：listen_treasure/ui/mobile.html")
    return FileResponse(page, media_type="text/html; charset=utf-8")


def create_app() -> FastAPI:
    return app
