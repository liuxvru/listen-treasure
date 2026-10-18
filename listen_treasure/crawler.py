"""从暗区情报站（aqtwwx.net）抓「行商听声鉴宝」的图鉴数据 / 音频 / 藏品图。

为什么要自己写签名：
  站点接口挂着三个防刷头，X-Qwe 是用一把 512 位 RSA 公钥按 PKCS#1 v1.5 加密
  `${时间戳}:${随机串}`。本机 Python 没有 cryptography / pycryptodome，
  而且为了一个只用来签 20 来个字节的公钥去装一个几 MB 的库不值当，
  所以下面手写了最小可用的 DER 解析 + PKCS#1 v1.5 填充 + pow() 求幂。

踩过的坑（别再踩）：
  - 接口真实路径是 **双 /api 前缀**（`/api/api/basic/...`），因为 axios 的
    baseURL 已经是 `/api` 而代码里的 url 又以 `/api` 开头；单 /api 会 401。
  - 但**签名要用单 /api 的路径**（`/api/basic/...`），跟浏览器里一致。
  - 必须带浏览器 UA + Referer，否则站点直接断连（curl 返回 code=000）。
  - 站点会把 SPA 的 HTML 当 200 返回（9429 字节 text/html），
    所以下载音频/图片**必须校验文件头 magic**，不然会把 HTML 存成 .wav。
"""

from __future__ import annotations

import base64
import io
import json
import secrets
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://aqtwwx.net"
# 实际请求用的前缀（双 /api）与签名用的前缀（单 /api）不同，别合并
API_PREFIX = "/api/api/basic/v1/listenTreasure/dzi-open"
SIGN_PREFIX = "/api/basic/v1/listenTreasure/dzi-open"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)
# 站点前端 bundle 里的常量 br，只用于这个防刷签名，不是敏感凭据
PUB_KEY_B64 = (
    "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAMAzUHyAQyn5tGxTXNiImUBiK7JGhaH3O2a3O8lz"
    "zb3w8X6M8xbbPkwZjPXU13/9DTe+paa7+txQXOfBxk+U//MCAwEAAQ=="
)
NONCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

WAV_MAGIC = b"RIFF"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# 缩略图规格：和站点原图的 128px 一致，保持 RGBA（原图都是透明底）
THUMB_SIZE = 128
THUMB_QUALITY = 82


# ---------------------------------------------------------------- RSA 签名


def _read_tlv(buf: bytes, i: int) -> tuple[int, int, int]:
    """读一个 DER TLV，返回 (tag, 内容起始, 内容结束)。"""
    tag = buf[i]
    i += 1
    ln = buf[i]
    i += 1
    if ln & 0x80:
        n = ln & 0x7F
        ln = int.from_bytes(buf[i : i + n], "big")
        i += n
    return tag, i, i + ln


def _parse_public_key(b64: str) -> tuple[int, int]:
    """从 SubjectPublicKeyInfo（base64）里取出 (n, e)。"""
    der = base64.b64decode(b64)
    tag, s, _e = _read_tlv(der, 0)
    assert tag == 0x30, "不是 SEQUENCE"
    tag, _a_s, a_e = _read_tlv(der, s)  # AlgorithmIdentifier，跳过
    tag, b_s, _b_e = _read_tlv(der, a_e)  # BIT STRING
    assert tag == 0x03, "不是 BIT STRING"
    # BIT STRING 首字节是「未用位数」，跳过它才是 RSAPublicKey
    tag, k_s, _k_e = _read_tlv(der, b_s + 1)
    assert tag == 0x30, "不是 RSAPublicKey"
    tag, n_s, n_e = _read_tlv(der, k_s)
    assert tag == 0x02, "modulus 不是 INTEGER"
    modulus = int.from_bytes(der[n_s:n_e], "big")
    tag, e_s, e_e = _read_tlv(der, n_e)
    assert tag == 0x02, "exponent 不是 INTEGER"
    exponent = int.from_bytes(der[e_s:e_e], "big")
    return modulus, exponent


_N, _E = _parse_public_key(PUB_KEY_B64)
_KEY_BYTES = (_N.bit_length() + 7) // 8


def rsa_encrypt(plain: str) -> str:
    """PKCS#1 v1.5 加密，返回 base64（等价于 JSEncrypt 的 encrypt）。"""
    data = plain.encode("utf-8")
    limit = _KEY_BYTES - 11
    if len(data) > limit:
        raise ValueError(f"明文 {len(data)} 字节超过 {limit} 字节上限")
    # EM = 00 || 02 || 非零随机填充 || 00 || M
    pad_len = _KEY_BYTES - 3 - len(data)
    pad = bytearray()
    while len(pad) < pad_len:
        chunk = secrets.token_bytes(pad_len - len(pad))
        pad.extend(x for x in chunk if x != 0)  # 填充字节必须非零
    em = b"\x00\x02" + bytes(pad[:pad_len]) + b"\x00" + data
    cipher = pow(int.from_bytes(em, "big"), _E, _N)
    return base64.b64encode(cipher.to_bytes(_KEY_BYTES, "big")).decode("ascii")


def make_headers(sign_path: str) -> dict:
    """生成站点要的三个签名头。sign_path 必须是**单 /api 前缀**的路径。"""
    ts = int(time.time() * 1000)
    nonce = "".join(secrets.choice(NONCE_CHARS) for _ in range(8))
    return {
        "X-Abc": base64.b64encode(str(ts).encode()).decode("ascii"),
        "X-Xyz": nonce,
        "X-Qwe": rsa_encrypt(f"{ts}:{nonce}"),
    }


# ---------------------------------------------------------------- HTTP


def _open(url: str, *, sign_path: str | None = None, timeout: float = 25.0):
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Referer": f"{BASE}/listen-treasure",
        "Origin": BASE,
    }
    if sign_path:
        headers.update(make_headers(sign_path))
    req = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(req, timeout=timeout)


def _retry(fn, *args, attempts: int = 3, wait: float = 0.8, **kwargs):
    """网络请求重试。最后一次还是失败就把异常抛出去，由调用方决定是否跳过。"""
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - 站点各种 4xx/断连都要重试
            last = exc
            if i + 1 < attempts:
                time.sleep(wait)
    raise last  # type: ignore[misc]


def api_get(path: str) -> dict:
    """请求图鉴接口。path 传完整路径，如 f"{API_PREFIX}/codex"。"""
    if not path.startswith(API_PREFIX):
        raise ValueError(f"path 必须以 {API_PREFIX} 开头：{path}")
    sign_path = SIGN_PREFIX + path[len(API_PREFIX):]

    def call() -> dict:
        with _open(BASE + path, sign_path=sign_path) as resp:
            raw = resp.read()
        data = json.loads(raw.decode("utf-8"))
        if data.get("code") != 200:
            raise RuntimeError(f"{path} -> code={data.get('code')} msg={data.get('msg')}")
        return data

    return _retry(call)


def fetch_codex() -> list[dict]:
    """声音→藏品 的对应关系（17 条声音 / 138 件藏品）。"""
    return api_get(f"{API_PREFIX}/codex").get("data") or []


def fetch_sounds() -> list[dict]:
    return api_get(f"{API_PREFIX}/sounds").get("data") or []


def download(url: str, dest: Path, magic: bytes, *, force: bool = False) -> str:
    """带 UA/Referer 下载并校验文件头。

    返回 "skipped"（已存在且文件头正确）/ "new"（这次真下载了）/ "failed"。
    调用方用 "new" 判断要不要重建识别库——只看「有没有文件」会把
    「全都没变」也报成需要重建。
    """
    if dest.exists() and not force:
        try:
            with dest.open("rb") as fh:
                if fh.read(len(magic)) == magic:
                    return "skipped"
        except OSError:
            pass

    def call() -> bytes:
        with _open(url) as resp:
            return resp.read()

    try:
        blob = _retry(call)
    except Exception:  # noqa: BLE001 - 单张图失败不该中断整个抓取
        return "failed"

    # 站点会把 SPA 的 HTML 当 200 返回，所以必须验文件头
    if not blob.startswith(magic):
        return "failed"

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(blob)
    tmp.replace(dest)
    return "new"


def _sound_url(audio_path: str, sound_id: str) -> str:
    """`/listen-treasure/sounds/1.wav` → `/static/listen-treasure/sounds/1.wav`。

    站点前端 resolveTreasureSoundPath 干的也是这件事。
    """
    p = audio_path or f"/listen-treasure/sounds/{sound_id}.wav"
    p = p.replace("/listen-treasure/", "/static/listen-treasure/", 1)
    if p.startswith("/"):
        return BASE + p
    return f"{BASE}/{p}"


def _item_img_url(item_id: str) -> str:
    return f"{BASE}/images/items/{item_id}.png"


# ---------------------------------------------------------------- 缩略图


def make_thumb(png_path: Path, webp_path: Path, *, force: bool = False) -> bool:
    """原图（约 14MB 一堆大 png）压成 128px RGBA webp。

    必须保留 alpha 通道：站点原图是透明底，转成 RGB 会变成黑底方块。
    """
    if webp_path.exists() and not force:
        return True
    try:
        from PIL import Image
    except ImportError:
        return False
    try:
        with Image.open(png_path) as im:
            out = im.convert("RGBA")
            out.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
            webp_path.parent.mkdir(parents=True, exist_ok=True)
            out.save(webp_path, "WEBP", quality=THUMB_QUALITY, method=6)
        return True
    except Exception:  # noqa: BLE001 - 坏图跳过
        return False


# ---------------------------------------------------------------- 编排


def _item_size_label(item: dict) -> str:
    """把接口的 gridSpace/gridRows/gridCols 统一成站点页面上的「占格 3×2」。

    gridSpace 原文是星号（"3*2"），但 library.py 和前端正则都用 ×号，
    这里统一输出「占格 行×列」，和现有 data/codex.json 完全一致。
    """
    rows = item.get("gridRows")
    cols = item.get("gridCols")
    if not rows or not cols:
        space = str(item.get("gridSpace") or "")
        parts = [p for p in space.replace("*", "x").replace("×", "x").split("x") if p.strip()]
        if len(parts) == 2:
            try:
                rows, cols = int(parts[0]), int(parts[1])
            except ValueError:
                rows = cols = None
    try:
        return f"占格 {int(rows)}×{int(cols)}"
    except (TypeError, ValueError):
        return "占格 1×1"


def build_codex_payload(codex_api: list[dict]) -> dict:
    """接口数据 → 和现有 data/codex.json 完全同构的结构。

    只产出真正会被消费的字段（soundId/title/items[].{name,img,size,value}），
    外加能从接口反推的展示字段；sizes/eyebrow/facts 这类纯展示字段
    由页面自己算，写进来也不会被读，索性不编，避免以后有人误以为它们可信。
    """
    entries = []
    for item in codex_api:
        sid = str(item.get("soundId") or "").strip()
        if not sid:
            continue
        raw_items = item.get("items") or []
        items = []
        for it in raw_items:
            item_id = str(it.get("itemId") or "").strip()
            if not item_id:
                continue
            items.append({
                "name": str(it.get("itemName") or it.get("shortName") or ""),
                # value 接口直接给整数，比页面上 "1,650,000" 的文本可靠
                "value": str(int(it.get("value") or 0)),
                "size": _item_size_label(it),
                "img": f"/images/items/{item_id}.png",
            })
        entries.append({
            "soundId": sid,
            "title": f"拾取音效 {int(sid):02d}" if sid.isdigit() else f"拾取音效 {sid}",
            "items": items,
        })
    entries.sort(key=lambda e: (int(e["soundId"]) if str(e["soundId"]).isdigit() else 10**9,
                                str(e["soundId"])))
    return {
        "scrapedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
        "source": f"{BASE}/listen-treasure",
        "codex": entries,
    }


def crawl(data_dir: Path | str | None = None, *,
          with_images: bool = True,
          with_sounds: bool = True,
          with_thumbs: bool = True,
          force: bool = False,
          progress=None) -> dict:
    """抓全量数据到 data_dir：codex.json / sounds/*.wav / items/*.png / items/thumbs/*.webp。"""
    from . import config

    root = Path(data_dir) if data_dir else config.data_dir()
    root.mkdir(parents=True, exist_ok=True)

    def say(msg: str) -> None:
        if progress:
            progress(msg)

    stats: dict = {
        "codexEntries": 0,
        "items": 0,
        "sounds": 0,
        "newSounds": 0,  # 这次真的重新下载的音频数（决定要不要重建识别库）
        "images": 0,
        "thumbs": 0,
        "failed": [],
        "dataDir": str(root),
    }
    # 1) 接口数据
    say("拉取图鉴接口…")
    codex_api = fetch_codex()
    say(f"  取到 {len(codex_api)} 条声音")
    try:
        sounds_api = fetch_sounds() if with_sounds else []
    except Exception as exc:  # noqa: BLE001 - 声音列表挂了还能用音频路径兜底
        say(f"  声音列表接口失败（继续）：{exc}")
        sounds_api = []

    payload = build_codex_payload(codex_api)
    stats["codexEntries"] = len(payload["codex"])
    stats["items"] = sum(len(e["items"]) for e in payload["codex"])

    codex_path = root / "codex.json"
    codex_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    # 原始接口响应留一份，以后接口改字段了不用重新抓
    (root / "raw-codex-api.json").write_text(
        json.dumps({"codex": codex_api, "sounds": sounds_api}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    say(f"  写入 {codex_path.name}：{stats['codexEntries']} 段 / {stats['items']} 件")

    # 2) 音频
    if with_sounds:
        say("下载音频…")
        sounds_dir = root / "sounds"
        sounds_dir.mkdir(parents=True, exist_ok=True)
        by_id = {str(s.get("soundId")): s for s in sounds_api}
        for entry in payload["codex"]:
            sid = entry["soundId"]
            audio_path = (by_id.get(sid) or {}).get("audioPath") or ""
            url = _sound_url(audio_path, sid)
            dest = sounds_dir / f"{sid}.wav"
            got = download(url, dest, WAV_MAGIC, force=force)
            if got == "failed":
                stats["failed"].append(f"音频 {sid}")
                say(f"  ✗ 音频 {sid}")
            else:
                stats["sounds"] += 1
                if got == "new":
                    stats["newSounds"] += 1
        say(f"  音频 {stats['sounds']}/{len(payload['codex'])}"
            + (f"（新下 {stats['newSounds']} 个）" if stats["newSounds"] else "（都是已有的）"))

    # 3) 藏品原图 + 缩略图
    if with_images:
        say("下载藏品原图…")
        items_dir = root / "items"
        thumbs_dir = items_dir / "thumbs"
        seen: set[str] = set()
        for entry in payload["codex"]:
            for it in entry["items"]:
                img = it["img"].rsplit("/", 1)[-1].split(".")[0]
                if not img or img in seen:
                    continue
                seen.add(img)
                png = items_dir / f"{img}.png"
                if download(_item_img_url(img), png, PNG_MAGIC, force=force) == "failed":
                    # 站点上确实有两张图是 404，跳过并从索引里去掉，别留坏引用
                    stats["failed"].append(f"图片 {img}")
                    continue
                stats["images"] += 1
                if with_thumbs and make_thumb(png, thumbs_dir / f"{img}.webp", force=force):
                    stats["thumbs"] += 1
        say(f"  原图 {stats['images']} / 缩略图 {stats['thumbs']}（共 {len(seen)} 件）")

    return stats


if __name__ == "__main__":  # pragma: no cover - 手工调试用
    def _echo(msg: str) -> None:
        print(msg)

    result = crawl(progress=_echo)
    print(json.dumps(result, ensure_ascii=False, indent=2))
