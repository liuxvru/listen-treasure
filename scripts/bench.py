"""自检 / 标定脚本（Python 版）。

用法：
    python scripts/bench.py            # 跑全部场景
    python scripts/bench.py self       # 只跑自识别
    python scripts/bench.py noisy
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from listen_treasure import config, dsp  # noqa: E402
from listen_treasure.library import SoundLibrary  # noqa: E402
from listen_treasure.matcher import Matcher  # noqa: E402


def load_wavs() -> dict[str, tuple[np.ndarray, int]]:
    out = {}
    for p in sorted(config.SOUNDS_DIR.glob("*.wav"), key=lambda q: int(q.stem)):
        out[p.stem] = dsp.read_audio(p)
    return out


def recognize(lib: SoundLibrary, pcm: np.ndarray, sr: int, params: dict | None = None) -> list[dict]:
    m = Matcher(lib, params)
    hits = []
    for idx, patch, level, at in dsp.iter_patches(pcm, sr, config.RUNTIME_NOISE):
        m.push(patch, level, at)
        for h in m.take():
            hits.append({"id": h.id, "score": h.score, "gap": h.gap,
                         "conf": h.confidence, "at": h.at_sec})
    for h in m.flush():
        hits.append({"id": h.id, "score": h.score, "gap": h.gap,
                     "conf": h.confidence, "at": h.at_sec})
    hits.sort(key=lambda h: h["at"])
    return hits


# ---------------------------------------------------------------- 场景


def scene_self(lib, wavs) -> None:
    print("\n== 自识别（干净音效原样喂入）==")
    ok = 0
    for sid, (pcm, sr) in wavs.items():
        hits = recognize(lib, pcm, sr)
        ids = [h["id"] for h in hits]
        good = bool(ids) and ids[0] == sid
        ok += good
        best = max(hits, key=lambda h: h["conf"]) if hits else None
        mark = "OK " if good else "BAD"
        print(f"  {mark} #{sid:>2}  hits={ids[:6]}  best={best['id'] if best else '-'}"
              f"  score={best['score']:.3f}" if best else f"  {mark} #{sid} hits=[]")
    print(f"  → {ok}/{len(wavs)} 首帧正确")


def scene_clean(lib, wavs) -> None:
    """把 17 段音效依次首尾相接，模拟连续拾取。"""
    print("\n== 连续拼接（干净，段间 0.4s 静音）==")
    gap = np.zeros(int(0.4 * config.SAMPLE_RATE), dtype=np.float32)
    parts, truth = [], []
    t = 0.0
    for sid, (pcm, sr) in wavs.items():
        if sr != config.SAMPLE_RATE:
            pcm = dsp.resample(pcm, sr, config.SAMPLE_RATE)
        parts.append(gap)
        t += gap.size / config.SAMPLE_RATE
        parts.append(pcm)
        truth.append((sid, t))
        t += pcm.size / config.SAMPLE_RATE
    parts.append(gap)
    signal = np.concatenate(parts)
    hits = recognize(lib, signal, config.SAMPLE_RATE)
    got = [h["id"] for h in hits]
    want = [s for s, _ in truth]
    print(f"  truth: {want}")
    print(f"  got  : {got}")
    correct = sum(1 for i, w in enumerate(want) if i < len(got) and got[i] == w)
    print(f"  → 顺序正确 {correct}/{len(want)}，总命中 {len(got)}（期望 {len(want)}）")


def scene_noisy(lib, wavs) -> None:
    print("\n== 加噪（白噪 / 粉噪 / 低频轰鸣，SNR 6dB）==")
    rng = np.random.default_rng(7)
    for kind in ("white", "pink", "rumble"):
        ok = 0
        for sid, (pcm, sr) in wavs.items():
            x = dsp.resample(pcm, sr, config.SAMPLE_RATE) if sr != config.SAMPLE_RATE else pcm
            n = x.size
            if kind == "white":
                noise = rng.normal(0, 1, n).astype(np.float32)
            elif kind == "pink":
                w = rng.normal(0, 1, n).astype(np.float32)
                noise = np.cumsum(w)
                noise -= noise.mean()
            else:
                w = rng.normal(0, 1, n).astype(np.float32)
                k = np.ones(64, dtype=np.float32) / 64
                noise = np.convolve(w, k, mode="same").astype(np.float32)
            sig_rms = float(np.sqrt(np.mean(x ** 2))) or 1e-6
            noise = noise / (float(np.sqrt(np.mean(noise ** 2))) or 1e-6) * sig_rms * 0.5
            mix = np.concatenate([np.zeros(int(0.3 * config.SAMPLE_RATE), dtype=np.float32), x + noise])
            hits = recognize(lib, mix, config.SAMPLE_RATE)
            ids = [h["id"] for h in hits]
            ok += bool(ids) and ids[0] == sid
        print(f"  {kind:>7}: {ok}/{len(wavs)}")


def scene_negative(lib, wavs) -> None:
    print("\n== 负样本（不该命中）==")
    rng = np.random.default_rng(11)
    sr = config.SAMPLE_RATE
    cases = {
        "静音": np.zeros(sr, dtype=np.float32),
        "白噪": rng.normal(0, 0.1, sr).astype(np.float32),
        "正弦 440Hz": (0.2 * np.sin(2 * np.pi * 440 * np.arange(sr) / sr)).astype(np.float32),
        "扫频": (0.2 * np.sin(2 * np.pi * np.cumsum(np.linspace(80, 8000, sr)) / sr)).astype(np.float32),
        "鼓点": np.zeros(sr, dtype=np.float32),
    }
    beat = cases["鼓点"]
    for k in range(4):
        i = int(k * 0.25 * sr)
        env = np.exp(-np.linspace(0, 8, 2400)).astype(np.float32)
        beat[i:i + 2400] += (env * np.sin(2 * np.pi * 60 * np.arange(2400) / sr)).astype(np.float32)
    for name, sig in cases.items():
        hits = recognize(lib, sig, sr)
        flag = "OK " if not hits else "误报"
        print(f"  {flag} {name}: {len(hits)} 次命中 {[h['id'] for h in hits][:5]}")


def scene_truncated(lib, wavs) -> None:
    """只保留音效开头的一段（尾部丢了），后面用静音补齐。

    必须补静音：一个补丁要 170ms 的窗口，若截断后长度不足一个窗口，
    根本产不出补丁，测出来的 0/17 是测试本身的问题而不是算法的问题。
    """
    print("\n== 截断（只给开头一段，尾部补静音）==")
    need = config.WINDOW_FRAMES * config.HOP_SIZE
    for frac in (0.5, 0.3):
        ok = 0
        for sid, (pcm, sr) in wavs.items():
            cut = max(1024, int(pcm.size * frac))
            x = pcm[:cut]
            if x.size < need + config.HOP_SIZE:
                x = np.concatenate([x, np.zeros(need + config.HOP_SIZE - x.size, dtype=np.float32)])
            hits = recognize(lib, x, sr)
            ids = [h["id"] for h in hits]
            ok += bool(ids) and ids[0] == sid
        print(f"  前 {int(frac * 100)}%: {ok}/{len(wavs)}")


def main() -> None:
    lib = SoundLibrary.load()
    wavs = load_wavs()
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    table = {
        "self": scene_self, "clean": scene_clean, "noisy": scene_noisy,
        "negative": scene_negative, "truncated": scene_truncated,
    }
    if which == "all":
        for fn in table.values():
            fn(lib, wavs)
    else:
        table[which](lib, wavs)


if __name__ == "__main__":
    main()
