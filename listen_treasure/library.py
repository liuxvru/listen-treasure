"""声音库：载入 library.json（模板补丁 + 图鉴藏品），提供检索与 URL 拼接。

library.json 由 `scripts/build_library.py` 生成，结构：

    {
      "version": 3,
      "sample_rate": 48000,
      "dim": 2048,
      "entries": [
        {
          "id": "1",
          "name": "拾取音效 01",
          "audio": "sounds/1.wav",
          "duration": 0.62,
          "valueMin": 10000, "valueMax": 1650000, "itemCount": 31,
          "codexItems": [{"name": "...", "value": "1650000", "size": "占格 3×2", "img": "abcd"}],
          "patches": [{"level": 0, "data": "<base64 int8>"}, ...]
        }
      ]
    }

补丁是 2048 维 float32 量化成 int8（除以 254），base64 编码 —— 体积从
17×4×2048×4B ≈ 560KB 压到约 130KB。
"""

from __future__ import annotations

import base64
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import config


def _dequantize(b64: str, dim: int) -> np.ndarray:
    """base64 → int8 → float32 / 254（与建库脚本的量化严格对应）。"""
    raw = np.frombuffer(base64.b64decode(b64), dtype=np.int8).astype(np.float32)
    out = np.zeros(dim, dtype=np.float32)
    n = min(raw.size, dim)
    out[:n] = raw[:n] / 254.0
    return out


def _parse_value(text: object) -> int:
    """把 "1,650,000" / "1650000" / "1.65W" 这类写法转成整数。"""
    if isinstance(text, (int, float)):
        return int(text)
    s = str(text or "").strip().replace(",", "")
    mult = 1
    if s.endswith("W") or s.endswith("w"):
        mult, s = 10_000, s[:-1]
    elif s.endswith("万"):
        mult, s = 10_000, s[:-1]
    try:
        return int(round(float(s) * mult))
    except Exception:
        return 0


@dataclass
class SoundItem:
    id: str
    name: str
    base_name: str
    category: str
    audio: str
    duration: float
    value_min: int
    value_max: int
    item_count: int
    codex_items: list[dict] = field(default_factory=list)
    patches: np.ndarray | None = None  # (n_patches, DIM)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "audio": self.audio,
            "duration": self.duration,
            "valueMin": self.value_min,
            "valueMax": self.value_max,
            "itemCount": self.item_count,
            "codexItems": self.codex_items,
        }


class SoundLibrary:
    """线程安全的只读声音库（后台识别线程与 HTTP 请求都会读）。"""

    def __init__(self) -> None:
        self.items: list[SoundItem] = []
        self.by_id: dict[str, SoundItem] = {}
        self.version = 0
        self.dim = config.DIM
        self.sample_rate = config.SAMPLE_RATE
        self.built_at: str | None = None
        self._lock = threading.Lock()
        # 模板矩阵：把所有条目的补丁拼成一个 (N, DIM) 矩阵，
        # 匹配时一次矩阵乘法算完所有模板，比逐条循环快一个数量级。
        self._matrix: np.ndarray | None = None
        self._matrix_owner: list[str] = []

    # ------------------------------------------------------------ 载入

    @classmethod
    def load(cls, path: Path | str | None = None) -> "SoundLibrary":
        p = Path(path) if path else config.data_dir() / "library.json"
        if not p.exists():
            raise FileNotFoundError(f"找不到声音库：{p}（先跑 scripts/build_library.py）")
        with p.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)

        lib = cls()
        lib.version = int(raw.get("version", 1))
        lib.dim = int(raw.get("dim", config.DIM))
        lib.sample_rate = int(raw.get("sample_rate") or raw.get("sampleRate") or config.SAMPLE_RATE)
        lib.built_at = raw.get("builtAt") or raw.get("built_at")

        for it in raw.get("entries", []):
            sid = str(it["id"])
            patches = [_dequantize(p["data"], lib.dim) for p in it.get("patches", [])]
            mat = np.stack(patches) if patches else None
            item = SoundItem(
                id=sid,
                name=it.get("name") or f"声音 #{sid}",
                base_name=it.get("name") or f"声音 #{sid}",
                category=it.get("category") or "拾取音效",
                audio=it.get("audio") or f"sounds/{sid}.wav",
                duration=float(it.get("duration") or 0.0),
                value_min=int(it.get("valueMin") or 0),
                value_max=int(it.get("valueMax") or 0),
                item_count=int(it.get("itemCount") or len(it.get("codexItems", []))),
                codex_items=list(it.get("codexItems") or []),
                patches=mat,
            )
            lib.items.append(item)
            lib.by_id[sid] = item

        lib._build_matrix()
        return lib

    def _build_matrix(self) -> None:
        # top_refs 只作为**上限**保护：模板少时全部用上。
        # 曾经这里硬截到 4 张，导致“密集采样”的模板被砍掉后半段，
        # 丢头/丢尾场景直接崩掉（tail50 从 10/17 掉到 1/17）。
        cap = int(config.MATCH_DEFAULTS.get("top_refs") or 0)
        rows, owners = [], []
        for it in self.items:
            if it.patches is None or not len(it.patches):
                continue
            take = it.patches if cap <= 0 else it.patches[:cap]
            for k in range(take.shape[0]):
                rows.append(take[k])
                owners.append(it.id)
        self._matrix = np.stack(rows) if rows else None
        self._matrix_owner = owners

    # ------------------------------------------------------------ 查询

    @property
    def matrix(self) -> np.ndarray | None:
        return self._matrix

    @property
    def matrix_owners(self) -> list[str]:
        return self._matrix_owner

    def item(self, sid: str | int) -> SoundItem | None:
        return self.by_id.get(str(sid))

    def total_items(self) -> int:
        return sum(it.item_count for it in self.items)

    def rename(self, sid: str, name: str) -> str:
        with self._lock:
            it = self.by_id.get(str(sid))
            if not it:
                raise KeyError(sid)
            it.name = name.strip() or it.base_name
            return it.name

    def audio_path(self, it: SoundItem) -> Path:
        return config.data_dir() / it.audio

    def thumb_path(self, codex_item: dict) -> Path | None:
        img = codex_item.get("img")
        if not img:
            return None
        p = config.data_dir() / "items" / "thumbs" / f"{img}.webp"
        return p if p.exists() else None

    def to_json(self) -> dict:
        return {
            "version": self.version,
            "dim": self.dim,
            "sampleRate": self.sample_rate,
            "builtAt": self.built_at,
            "totalItems": self.total_items(),
            "items": [it.to_json() for it in self.items],
        }


# ---------------------------------------------------------------- 名称覆盖

_OVERRIDE_PATH = lambda: config.data_dir() / "name-overrides.json"  # noqa: E731


def load_name_overrides() -> dict[str, str]:
    p = _OVERRIDE_PATH()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_name_override(sid: str, name: str) -> None:
    data = load_name_overrides()
    name = (name or "").strip()
    if name:
        data[str(sid)] = name
    else:
        data.pop(str(sid), None)
    _OVERRIDE_PATH().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def apply_name_overrides(lib: SoundLibrary) -> None:
    for sid, name in load_name_overrides().items():
        it = lib.item(sid)
        if it:
            it.name = name


# ---------------------------------------------------------------- 从 codex 建库


def build_library_from_codex(sounds_dir: Path | None = None,
                             codex_path: Path | None = None,
                             out_path: Path | None = None,
                             top_refs: int | None = None) -> dict:
    """扫描 data/sounds/*.wav，生成 library.json（v3）。

    模板补丁用 **保守降噪**（TEMPLATE_NOISE）提取：模板是识别基准，
    削太狠会让同一段音效自己都认不出来。

    top_refs 默认取 MATCH_DEFAULTS["top_refs"]（12），**不是** TEMPLATE_COUNT（4）。
    两者含义不同：TEMPLATE_COUNT 是"峰值附近取几张"，top_refs 是"整段最多留几张"。
    这里默认值以前错写成 TEMPLATE_COUNT，导致 run.py --rebuild 和"库丢了自动建库"
    这两条路径建出来的库只有 258 张模板（正常 334 张），识别率会悄悄变差。
    """
    from . import dsp

    if top_refs is None:
        top_refs = int(config.MATCH_DEFAULTS["top_refs"])
    sounds_dir = Path(sounds_dir) if sounds_dir else config.data_dir() / "sounds"
    codex_path = Path(codex_path) if codex_path else config.data_dir() / "codex.json"
    out_path = Path(out_path) if out_path else config.data_dir() / "library.json"

    codex_by_sound: dict[str, dict] = {}
    if codex_path.exists():
        raw = json.loads(codex_path.read_text(encoding="utf-8"))
        for c in raw.get("codex", []):
            codex_by_sound[str(c.get("soundId"))] = c

    wavs = sorted(
        (p for p in sounds_dir.glob("*.wav")),
        key=lambda p: (int(p.stem) if p.stem.isdigit() else 10**9, p.stem),
    )
    entries: list[dict] = []
    for wav in wavs:
        sid = wav.stem
        pcm, sr = dsp.read_audio(wav)
        patches = dsp.anchor_patches(pcm, sr, count=top_refs, span=6,
                                     denoise_params=config.TEMPLATE_NOISE)
        if not patches:
            continue
        packed = []
        for k, p in enumerate(patches):
            q = np.clip(np.round(p * 254.0), -127, 127).astype(np.int8)
            packed.append({
                "level": k,
                "data": base64.b64encode(q.tobytes()).decode("ascii"),
            })
        cx = codex_by_sound.get(sid) or {}
        items = []
        for it in cx.get("items") or []:
            img = str(it.get("img") or "")
            if "/" in img:
                img = img.rsplit("/", 1)[-1].split(".")[0]
            items.append({
                "name": it.get("name") or "",
                "value": _parse_value(it.get("value")),
                "size": it.get("size") or "",
                "img": img,
            })
        values = [i["value"] for i in items if i["value"]]
        entries.append({
            "id": sid,
            "name": cx.get("title") or f"拾取音效 {int(sid):02d}" if sid.isdigit() else f"拾取音效 {sid}",
            "category": "拾取音效",
            "audio": f"sounds/{wav.name}",
            "duration": round(pcm.size / max(1, sr), 3),
            "valueMin": min(values) if values else 0,
            "valueMax": max(values) if values else 0,
            "itemCount": len(items),
            "codexItems": items,
            "patches": packed,
        })

    payload = {
        "version": 3,
        "builtAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "sampleRate": config.SAMPLE_RATE,
        "dim": config.DIM,
        "entries": entries,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {
        "entries": len(entries),
        "patches": sum(len(e["patches"]) for e in entries),
        "items": sum(e["itemCount"] for e in entries),
        "bytes": out_path.stat().st_size,
        "path": str(out_path),
    }
