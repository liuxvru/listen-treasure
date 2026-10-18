"""启动入口：起本地服务并打开浏览器。

用法：
    python scripts/run.py                  # 127.0.0.1:8756，自动开浏览器
    python scripts/run.py --port 9000
    python scripts/run.py --no-browser     # 只起服务（给 IDE / 远程用）
    python scripts/run.py --host 0.0.0.0   # 局域网里用手机看
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from listen_treasure import config  # noqa: E402
from listen_treasure import netinfo  # noqa: E402


def _print_qr(args, mobile_urls: list[str]) -> None:
    """在终端里打印一个二维码，手机扫一下就能进手机端页面。"""
    if args.no_qr or not mobile_urls:
        return
    code = netinfo.qr_ascii(mobile_urls[0])
    if not code:
        print("  （没装 segno，跳过二维码：pip install segno）")
        return
    if args.host in ("127.0.0.1", "localhost"):
        print("  ⚠ 下面这个二维码现在扫了也连不上（只监听了 127.0.0.1）")
    print(f"  手机扫码（{mobile_urls[0]}）：")
    # 终端编码不是 UTF-8 时半格字符会崩，降级成只打印链接
    try:
        print(code)
    except UnicodeEncodeError:
        print("  （终端编码不支持方块字符，请手动输入上面的网址）")
    print()


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def _pick_port(host: str, want: int) -> int:
    """端口被占就往后找一个空的，最多试 20 个。"""
    for i in range(20):
        if _port_free(host, want + i):
            return want + i
    raise SystemExit(f"{host}:{want} 起连续 20 个端口都被占用，换个 --port 吧")


def _bootstrap_data() -> None:
    """首次运行（或 data/ 缺失）时把参考数据抓下来。

    data/ 不进仓库：里面是游戏音效和藏品图，由 crawl.py 从站点抓。
    所以新 clone 下来第一次要联网跑一次，抓完立刻建库。
    """
    from listen_treasure import crawler

    print("=" * 58)
    print("  首次运行：data/ 是空的，需要先从暗区情报站抓一次参考数据")
    print("  约 2~3 分钟（17 段音效 + 136 张藏品图，约 17 MB）")
    print("=" * 58)
    last = {"pct": -10}

    def progress(msg: str) -> None:
        print(f"  {msg}")

    stats = crawler.crawl(config.data_dir(), progress=progress)
    print(f"[抓取] 音效 {stats['sounds']} / 藏品 {stats['items']} / "
          f"图片 {stats['images']} / 缩略图 {stats['thumbs']}")
    if stats["failed"]:
        print(f"[抓取] 失败 {len(stats['failed'])} 项（站点上本来就没有，可忽略）："
              f"{', '.join(stats['failed'])}")
    if not stats["sounds"]:
        raise SystemExit(
            "一段音效都没抓到。检查网络能不能访问 https://aqtwwx.net ，"
            "或者手动跑 python scripts/crawl.py 看具体报错。"
        )


def main() -> int:
    ap = argparse.ArgumentParser(description="行商听声鉴宝 - 本地识别服务")
    ap.add_argument("--host", default=config.HOST)
    ap.add_argument("--port", type=int, default=config.PORT)
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--rebuild", action="store_true", help="启动前重建声音库")
    ap.add_argument("--lan", action="store_true",
                    help="监听 0.0.0.0，让手机连同一个 Wi-Fi 打开网页（等价 --host 0.0.0.0）")
    ap.add_argument("--no-qr", action="store_true", help="启动横幅里不打印二维码")
    args = ap.parse_args()
    if args.lan:
        args.host = "0.0.0.0"

    if args.rebuild:
        from listen_treasure.library import build_library_from_codex

        if not config.SOUNDS_DIR.exists() or not any(config.SOUNDS_DIR.glob("*.wav")):
            print("[建库] data/sounds/ 里没有音频，先抓数据")
            _bootstrap_data()
        stats = build_library_from_codex()
        print(f"[建库] {stats['entries']} 段音效 / {stats['patches']} 张模板 / "
              f"{stats['items']} 件藏品 -> {stats['path']}")

    if not config.LIBRARY_JSON.exists():
        # 没有音频的话建库只会产出空库，等于启动后什么都认不出来
        if not config.SOUNDS_DIR.exists() or not any(config.SOUNDS_DIR.glob("*.wav")):
            _bootstrap_data()
        print("建库中…")
        from listen_treasure.library import build_library_from_codex

        stats = build_library_from_codex()
        print(f"[建库] {stats['entries']} 段音效 / {stats['patches']} 张模板 / "
              f"{stats['items']} 件藏品")
        if not stats["entries"]:
            raise SystemExit("建库结果为空，data/ 数据有问题。")

    port = _pick_port(args.host, args.port)
    local_url = f"http://127.0.0.1:{port}/"
    lan_ips = netinfo.lan_ips()  # 只探测一次：每探测一轮都要扫网卡，别重复调
    mobile_urls = [f"http://{ip}:{port}/m" for ip in lan_ips]

    if not args.no_browser:
        def _open() -> None:
            time.sleep(1.2)
            try:
                webbrowser.open(local_url)
            except Exception:
                pass

        threading.Thread(target=_open, daemon=True).start()

    print("=" * 58)
    print("  行商听声鉴宝  ·  声音识别")
    print(f"  电脑： {local_url}")
    lan_open = args.host not in ("127.0.0.1", "localhost")
    for u in mobile_urls:
        # 只监听回环时这个地址是连不上的，标出来免得用户拿着去扫
        print(f"  手机： {u}" + ("" if lan_open else "  ← 需加 --lan 才能访问"))
    print(f"  接口： {local_url}api/health")
    if lan_open:
        print(f"  监听： {args.host}:{port}（局域网可访问）")
    elif mobile_urls:
        print("  提示： 现在只监听 127.0.0.1，手机打不开。"
              "要手机用请加 --lan")
    print("  按 Ctrl+C 退出")
    print("=" * 58)

    _print_qr(args, mobile_urls)

    import uvicorn

    from listen_treasure.server import app

    try:
        uvicorn.run(app, host=args.host, port=port, log_level="warning")
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
