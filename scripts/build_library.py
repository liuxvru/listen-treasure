"""从 data/codex.json + data/sounds/*.wav 生成 data/library.json（Python 版）。

用法：
    python scripts/build_library.py
    python scripts/build_library.py --top-refs 4
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from listen_treasure import config  # noqa: E402
from listen_treasure.library import build_library_from_codex  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sounds", default=str(config.SOUNDS_DIR))
    ap.add_argument("--codex", default=str(config.CODEX_JSON))
    ap.add_argument("--out", default=str(config.LIBRARY_JSON))
    ap.add_argument("--top-refs", type=int, default=config.MATCH_DEFAULTS["top_refs"])
    args = ap.parse_args()

    stats = build_library_from_codex(args.sounds, args.codex, args.out, top_refs=args.top_refs)
    print(f"写入 {stats['path']}")
    print(f"  音效 {stats['entries']} 段 / 模板 {stats['patches']} 张"
          f" / 藏品 {stats['items']} 件 / {stats['bytes']} 字节")

    data = json.loads(Path(args.out).read_text(encoding="utf-8"))
    for e in data["entries"]:
        print(f"  #{e['id']:>2} {e['name'][:16]:<16} 模板{len(e['patches'])} "
              f"时长{e['duration']:.3f}s 藏品{e['itemCount']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

