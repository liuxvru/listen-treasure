"""从暗区情报站抓图鉴数据 / 音频 / 藏品图。

用法：
    python scripts/crawl.py                    # 抓到 data/（完整）
    python scripts/crawl.py --no-images        # 只更音频，不碰图
    python scripts/crawl.py --data-dir data-test
    python scripts/crawl.py --force            # 忽略已有文件重新下

抓完之后要重建识别库：
    python scripts/build_library.py
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from listen_treasure import config, crawler  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="从暗区情报站抓取行商听声鉴宝数据")
    ap.add_argument("--data-dir", default=None,
                    help="数据目录（默认用项目里的 data/），自测时建议指到 data-test")
    ap.add_argument("--no-images", action="store_true", help="不下载藏品图")
    ap.add_argument("--no-sounds", action="store_true", help="不下载音频")
    ap.add_argument("--no-thumbs", action="store_true", help="不生成缩略图（保留原图）")
    ap.add_argument("--force", action="store_true", help="忽略已有文件，全部重新下载")
    args = ap.parse_args()

    data_dir = Path(args.data_dir) if args.data_dir else config.data_dir()
    started = time.time()

    print("=" * 56)
    print("  行商听声鉴宝  ·  图鉴数据抓取")
    print(f"  目标目录： {data_dir}")
    print("=" * 56)

    def progress(msg: str) -> None:
        print(f"  {msg}")

    try:
        stats = crawler.crawl(
            data_dir,
            with_images=not args.no_images,
            with_sounds=not args.no_sounds,
            with_thumbs=not args.no_thumbs,
            force=args.force,
            progress=progress,
        )
    except Exception as exc:  # noqa: BLE001 - 一把抓失败要给出人话提示
        print(f"\n[失败] {type(exc).__name__}: {exc}")
        return 1

    elapsed = time.time() - started
    failed = stats.get("failed") or []
    print("\n" + "-" * 56)
    print(f"  音效 {stats['codexEntries']} 段 / 藏品 {stats['items']} 件 / "
          f"音频 {stats['sounds']} 个 / 原图 {stats['images']} 张 / "
          f"缩略图 {stats['thumbs']} 张")
    if failed:
        print(f"  缺少 {len(failed)} 张图：{', '.join(failed[:6])}"
              + (" …" if len(failed) > 6 else ""))
        print("  站点上本来就没有这几张（404），识别功能不依赖图片，可以忽略")
    print(f"  耗时 {elapsed:.1f}s")
    print("-" * 56)
    print("数据已更新。下一步重建识别库：")
    print("  python scripts/build_library.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
