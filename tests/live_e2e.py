"""端到端：真实浏览器 + 真实 WASAPI 回环 + 真实播放，验证页面上的实时识别链路。

流程：
  1. 无头 Chrome 打开页面，点「开始监听」
  2. Python 侧用 pyaudiowpatch 把 17 段 wav 播到系统默认输出
  3. 页面通过 SSE 收到 hit，写进「命中记录」和「当前判定」
  4. 断言 17 段全部识别、顺序正确、无重复、无多余
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PY = sys.executable
BASE = os.environ.get("BASE", "http://127.0.0.1:8760")


def api(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    st = api("/api/live/status")
    if st.get("running"):
        print("[e2e] 后端已在监听，先停掉", flush=True)
        req = urllib.request.Request(BASE + "/api/live/stop", data=b"{}",
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=10).read()
        time.sleep(0.5)

    print("[e2e] 启动浏览器脚本（后台）", flush=True)
    node = subprocess.Popen(
        ["node", str(HERE / "live_e2e.mjs")],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace",
    )

    # 等浏览器点完「开始监听」
    deadline = time.time() + 40
    started = False
    while time.time() < deadline:
        if node.poll() is not None:
            break
        try:
            if api("/api/live/status").get("running"):
                started = True
                break
        except Exception:
            pass
        time.sleep(0.4)
    if not started:
        print("[e2e] 浏览器没能启动监听", flush=True)
        node.kill()
        print(node.stdout.read() if node.stdout else "", flush=True)
        return 1

    print("[e2e] 后端已在监听，开始播放 17 段音效", flush=True)
    time.sleep(1.0)
    play = subprocess.run([PY, str(HERE / "play_some.py")],
                          cwd=str(ROOT), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=120)
    print(play.stdout.strip(), flush=True)
    if play.returncode != 0:
        print("[e2e] 播放失败：", play.stderr[-2000:], flush=True)

    print("[e2e] 播放结束，等浏览器收尾", flush=True)
    out, _ = node.communicate(timeout=90)
    print(out, flush=True)
    return node.returncode or 0


if __name__ == "__main__":
    sys.exit(main())
