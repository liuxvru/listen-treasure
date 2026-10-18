"""播放 data/sounds 下的 wav 到默认输出，供回环识别端到端测试。

用法：python tests/play_some.py 1 2 3 ...   （不带参数则播 1..17）

`--gain` 用于把音效提到接近游戏里听见的音量。data/sounds 里 17 段的
中位 rms 只有 -40.9 dBFS，而机器上同时还有别的程序在响（实测本底
-27.5 dBFS）。按原样播放时音效比背景还小 13dB，测出来的是「负信噪比」
这种极端场景，不是用户实际遇到的情形。游戏里拾取音效是能清楚听见的，
所以测试默认提到 +12 dB（≈ 背景 0 dB 信噪比）。
"""
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from listen_treasure import capture, dsp  # noqa: E402

args = sys.argv[1:]
gain_db = 12.0
if "--gain" in args:
    i = args.index("--gain")
    gain_db = float(args[i + 1])
    del args[i:i + 2]

ids = args or [str(i) for i in range(1, 18)]
gap = 1.4
print(f"[play] 准备播放 {len(ids)} 段，间隔 {gap}s，增益 {gain_db:+.0f} dB", flush=True)
time.sleep(1.0)
for sid in ids:
    p = ROOT / "data" / "sounds" / f"{sid}.wav"
    if not p.exists():
        print(f"[play] 跳过 {sid}（文件不存在）", flush=True)
        continue
    t0 = time.time()
    pcm, sr = dsp.read_audio(p)
    if gain_db:
        pcm = (pcm * (10.0 ** (gain_db / 20.0))).astype("float32")
        peak = float(abs(pcm).max())
        if peak > 0.99:  # 别削顶
            pcm = (pcm * (0.99 / peak)).astype("float32")
    capture.play_file(pcm=pcm, sample_rate=sr)
    print(f"[play] {sid} 播完 {time.time() - t0:.2f}s", flush=True)
    time.sleep(gap)
print("[play] 全部完成", flush=True)
