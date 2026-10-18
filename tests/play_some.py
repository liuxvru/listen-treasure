"""播放 data/sounds 下的 wav 到默认输出，供回环识别端到端测试。
用法：python tests/play_some.py 1 2 3 ...   （不带参数则播 1..17）
"""
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from listen_treasure import capture  # noqa: E402

ids = sys.argv[1:] or [str(i) for i in range(1, 18)]
gap = 1.4
print(f"[play] 准备播放 {len(ids)} 段，间隔 {gap}s", flush=True)
time.sleep(1.0)
for sid in ids:
    p = ROOT / "data" / "sounds" / f"{sid}.wav"
    if not p.exists():
        print(f"[play] 跳过 {sid}（文件不存在）", flush=True)
        continue
    t0 = time.time()
    capture.play_file(str(p))
    print(f"[play] {sid} 播完 {time.time() - t0:.2f}s", flush=True)
    time.sleep(gap)
print("[play] 全部完成", flush=True)
