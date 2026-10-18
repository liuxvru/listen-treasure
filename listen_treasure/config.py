"""路径与可调参数。

所有“魔法数字”都集中在这里，方便对着真实录音调。
默认值是按“游戏回环录音 + 环境音”场景标定的。
"""

from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------- 路径

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SOUNDS_DIR = DATA_DIR / "sounds"
ITEMS_DIR = DATA_DIR / "items"
THUMBS_DIR = ITEMS_DIR / "thumbs"
LIBRARY_JSON = DATA_DIR / "library.json"
CODEX_JSON = DATA_DIR / "codex.json"
UI_DIR = Path(__file__).resolve().parent / "ui"


def data_dir() -> Path:
    """允许用环境变量覆盖数据目录（打包后放在 exe 旁边时用）。"""
    override = os.environ.get("LISTEN_DATA_DIR")
    return Path(override).resolve() if override else DATA_DIR


# ---------------------------------------------------------------- 识别流水线

SAMPLE_RATE = 48_000
FRAME_SIZE = 1024  # 21.33 ms
HOP_SIZE = 256  # 5.33 ms
N_MELS = 64
WINDOW_FRAMES = 32  # 一个补丁 = 32 帧 = 170.7 ms
DIM = N_MELS * WINDOW_FRAMES  # 2048 维
FMIN_HZ = 40.0
FMAX_HZ = 16_000.0

# 对数能量的相对地板：低于“本补丁最响的带”多少 dB 就夹住。
# 必须是相对值——回环录音整体可能只有 -30dBFS，用绝对地板会把所有带夹成常数。
LOG_FLOOR_DB = -20.0

HOP_SECONDS = HOP_SIZE / SAMPLE_RATE
PATCH_SECONDS = WINDOW_FRAMES * HOP_SECONDS  # ≈0.17s

# 建库时模板取样的两套策略（合并后去重）：
#   1. 以能量峰值中心的一簇（count 张，span 帧内铺开）
#   2. 在“有声区间”（能量 ≥ 峰值 × ACTIVE_FRAC）里每隔 SPREAD_STEP 帧取一张
# 只用策略一，游戏里“声音已经开始才捕获到”会认不出来；
# 只用策略二，开头那一段又覆盖不到。两者合并才稳。
TEMPLATE_SPREAD_STEP = 3
TEMPLATE_ACTIVE_FRAC = 0.12
TEMPLATE_COUNT = 4  # 峰值中心那一簇取几张

# ---------------------------------------------------------------- 背景降噪

# 分两阶段，这是整个项目里最容易调错的地方：
#   1. 建库（模板）用的降噪要“保守”——音效本身的特征不能被削掉，
#      因为模板就是识别基准，削坏了永远对不上。
#   2. 实时/文件识别用的降噪可以“激进”——环境音是干扰项，能压多低压多低。
TEMPLATE_NOISE = {
    "mode": "conservative",
    "high_pass_hz": 60.0,
    "over_subtraction": 0.8,
    "gain_floor_db": -6.0,
    "smoothing": 0.6,
}

RUNTIME_NOISE = {
    "mode": "aggressive",
    "high_pass_hz": 120.0,
    "over_subtraction": 2.0,
    "gain_floor_db": -18.0,
    "smoothing": 0.5,
    # 噪声谱估计
    "noise_init_frames": 5,
    "track_fast": 0.55,
    "track_slow": 0.02,
    "scene_seconds": 0.2,
    "hot_ratio": 4.0,
    "event_ratio": 3.5,
    "broad_frac": 3,
    # 瞬态保护：音效的上升沿不能被当成噪声抹掉
    "transient_window_sec": 0.01,
    "transient_ratio": 2.0,
    "transient_max_hops": 6,
    # 时域底噪门限
    "level_block": 960,
    "gate_min_range_db": 12.0,
    "gate_quiet_ceiling_dbfs": -42.0,
    "gate_margin_db": 4.0,
    "gate_floor_dbfs": -70.0,
}

# ---------------------------------------------------------------- 匹配

MATCH_DEFAULTS = {
    "min_score": 0.5,  # 补丁与模板的余弦相似度下限（先粗筛）
    "min_gap": 0.06,  # 与“别的音效”第一名的差距下限
    "top_refs": 12,  # 每条音效最多贡献多少张参考补丁（上限保护，不是固定值）
    "min_score_frames": 3,  # 确认前至少要有几帧“按相似度达标”
    "confirm_score": 0.85,  # 确认时要求的**峰值**相似度（标定见下）
    # 迟滞释放：某音效最后一次达标后，要安静这么多帧（25 × 5.33ms ≈ 133ms）
    # 才允许再次上报。取太短会把一段音效报成十几次，太长会吞掉连点。
    "release_frames": 25,
    # 说明：早期版本还有 anchor_frames / anchor_cooldown_frames /
    # use_level_gate / level_rise_db / min_level_db 五个键，那套“电平突增 + 固定
    # 帧数确认”的逻辑已经被 matcher.py 里的候选累积 + 迟滞释放取代，这些键
    # 早已没有任何代码读取，删掉以免误导调参。
}

# confirm_score 标定（scripts/bench.py all，17 段音效）：
#   0.70 → 干净 17/17 但 3 处误报；白噪 17、粉噪 17、轰鸣 17
#   0.80 → 干净 17/17 且 0 误报；白噪 17、粉噪 17、轰鸣 14
#   0.85 → 干净 17/17 且 0 误报（模板铺开后） ← 采用
#   0.90 → 轰鸣掉到 9
# 误报的峰值集中在 0.72~0.77（都是 #11 被 #4/#15 的尾音勾出来），
# 真音效的峰值在 0.95 以上，中间这条沟很干净。

# ---------------------------------------------------------------- 服务器

HOST = "127.0.0.1"
PORT = int(os.environ.get("LISTEN_PORT", "8756"))
