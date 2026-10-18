"""实时模板匹配。

核心思路（和开源项目 soundradar 一致，但打分和确认逻辑重写）：

1. **补丁是音效的“局部快照”，不是整段平均**
   模板 = 该音效若干关键位置的 170ms 补丁；查询 = 当前时刻的最近 170ms。
   音效只响几十毫秒、或与环境音叠在一起，也能单独对上。

2. **一次只出一个判定**
   每个 hop（5.33ms）算所有模板的“此刻最像”分数，全局取第一名。
   这是“此刻到底是什么声音”，而不是“每个模板各自有没有”——
   否则一个音节就能让十个模板同时“命中”。

3. **置信度用 rank-1 gap（与绝对音量无关）**
   置信度 ≈ 最佳分 - 次佳分（次佳来自**别的音效**）。
   真音效：第一名明显领先，gap 大；环境音：所有模板都低分，gap 小。
   比“绝对相似度阈值”稳得多——音量变化、叠加环境音都会压低绝对分，
   但“谁最像”这个相对关系会保留。

4. **事件级候选：先攒着，等声音过去再一次性结算**
   这是最关键的一条。逐帧打分在音效边缘会掉到 0.7 左右（170ms 窗口
   一半是音效一半是静音），而两个高度相似的音效之间 top-1 还会来回跳。
   如果“哪一帧达标就当场上报”，一段 0.7s 的音效会被拆成好几次命中，
   还会把 #2 播放期间的 #9 误报出来（实测 3 处误报）。

   所以改成：把连续达标的帧归到同一个候选事件里，持续累积
   **峰值分数 / 峰值 gap / 达标帧数**；等这个音效安静 release_frames 帧
   （约 133ms）后，再用峰值去判定一次——真音效的峰值能到 0.95 以上，
   误报的峰值顶多 0.75，两者一眼就能分开。上报时间是候选的**起点**，
   也就是声音真正开始的位置，而不是结算时刻。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import config


@dataclass
class Verdict:
    """单帧判定。"""

    id: str
    score: float
    gap: float
    level_db: float
    rise: float
    confidence: float
    confirmed: bool


@dataclass
class Hit:
    """一次已确认的命中。"""

    id: str
    score: float
    gap: float
    confidence: float
    at_sec: float
    end_sec: float


@dataclass
class _Candidate:
    """一个正在累积的声音事件。"""

    id: str
    start_frame: int
    start_sec: float
    last_frame: int
    peak_score: float
    peak_gap: float
    votes: int


def confidence_of(score: float, gap: float) -> float:
    """绝对相似度与 rank-1 gap 的加权和，再乘“相似度低就别太笃定”的系数。

    只用 gap 不够（环境音里所有模板都差，gap 仍可能到 0.05）；
    只用相似度也不够（两个相似音效会一起高分，无法区分）。
    """
    s = min(1.0, max(0.0, (score - 0.35) / 0.5))
    g = min(1.0, max(0.0, gap / 0.12))
    v = (0.55 * s + 0.45 * g) * (0.75 + 0.25 * s)
    return round(v, 3)


class Matcher:
    """把补丁流折叠成“命中事件”。"""

    def __init__(self, library, params: dict | None = None) -> None:
        self.lib = library
        self.p = dict(config.MATCH_DEFAULTS)
        if params:
            self.p.update(params)
        self.matrix = library.matrix  # (N, DIM)
        self.owners = library.matrix_owners
        self.ids = list(dict.fromkeys(self.owners))  # 去重且保持顺序
        self._id_index = {sid: i for i, sid in enumerate(self.ids)}
        self._owner_idx = (
            np.array([self._id_index[o] for o in self.owners], dtype=np.int32)
            if self.owners
            else np.zeros(0, dtype=np.int32)
        )

        self.ref_level = float("nan")
        self.frame = 0
        self.candidates: dict[str, _Candidate] = {}
        self.queue: list[Hit] = []
        self.stats = {"frames": 0, "verdicts": 0, "confirmations": 0, "rejected": 0}

    # ------------------------------------------------------------ 打分

    def evaluate(self, patch: np.ndarray) -> tuple[str | None, float, float]:
        """返回 (最佳音效 id, 最佳分, 不同音效的次佳分)。"""
        if self.matrix is None or not self.ids:
            return None, 0.0, 0.0
        scores = self.matrix @ patch  # (N,) 一次算完所有模板
        best_per_id = np.full(len(self.ids), -2.0, dtype=np.float64)
        np.maximum.at(best_per_id, self._owner_idx, scores)
        top = int(np.argmax(best_per_id))
        top_score = float(best_per_id[top])
        if best_per_id.size > 1:
            second = float(np.max(np.delete(best_per_id, top)))
        else:
            second = 0.0
        return self.ids[top], top_score, second

    # ------------------------------------------------------------ 主循环

    def push(self, patch: np.ndarray | None, level_db: float,
             at_sec: float = 0.0) -> Verdict | None:
        self.frame += 1
        self.stats["frames"] += 1
        if patch is None:
            return None

        sid, score, second = self.evaluate(patch)
        if sid is None:
            return None
        gap = score - second if second > -1.5 else score
        by_score = score >= self.p["min_score"] and gap >= self.p["min_gap"]

        # 绝对电平跟踪：上升快跟、下降慢跟，避免被音效自身拉高（只用于展示）
        if not np.isfinite(self.ref_level):
            self.ref_level = level_db
        elif np.isfinite(level_db):
            k = 0.05 if level_db > self.ref_level else 0.0015
            self.ref_level += k * (level_db - self.ref_level)
        rise = level_db - self.ref_level if np.isfinite(level_db) else -np.inf

        if by_score:
            self._accumulate(sid, score, gap, at_sec)
        self._settle(at_sec)

        if not by_score:
            return None
        self.stats["verdicts"] += 1
        cand = self.candidates.get(sid)
        return Verdict(
            id=sid,
            score=score,
            gap=gap,
            level_db=level_db,
            rise=rise,
            confidence=confidence_of(cand.peak_score if cand else score,
                                     cand.peak_gap if cand else gap),
            confirmed=False,
        )

    # ------------------------------------------------------------ 候选累积

    def _accumulate(self, sid: str, score: float, gap: float, at_sec: float) -> None:
        cand = self.candidates.get(sid)
        if cand is None:
            # at_sec 已经是这个补丁窗口的**起点**（iter_patches 按 idx*hop 给），
            # 不要再减 PATCH_SECONDS——那会整整提前 170ms。
            self.candidates[sid] = _Candidate(
                id=sid,
                start_frame=self.frame,
                start_sec=max(0.0, at_sec),
                last_frame=self.frame,
                peak_score=score,
                peak_gap=gap,
                votes=1,
            )
            return
        cand.last_frame = self.frame
        cand.peak_score = max(cand.peak_score, score)
        cand.peak_gap = max(cand.peak_gap, gap)
        cand.votes += 1

    def _settle(self, at_sec: float, force: bool = False) -> None:
        """把已经安静够久的候选结算掉：够强的报出去，不够的丢掉。

        force=True 时忽略“安静够久”条件，把还挂着的候选全部结算——
        流结束时必须这样做，否则最后一段声音永远等不到释放窗口。
        """
        quiet = self.p["release_frames"]
        for sid in [k for k, c in self.candidates.items()
                    if force or self.frame - c.last_frame > quiet]:
            cand = self.candidates.pop(sid)
            ok = (
                cand.peak_score >= self.p["confirm_score"]
                and cand.peak_gap >= self.p["min_gap"]
                and cand.votes >= self.p["min_score_frames"]
            )
            if not ok:
                self.stats["rejected"] += 1
                continue
            self.stats["confirmations"] += 1
            self.queue.append(
                Hit(
                    id=sid,
                    score=cand.peak_score,
                    gap=cand.peak_gap,
                    confidence=confidence_of(cand.peak_score, cand.peak_gap),
                    at_sec=cand.start_sec,
                    end_sec=at_sec if at_sec > cand.start_sec else cand.start_sec,
                )
            )

    def flush(self) -> list[Hit]:
        """流结束时调用：把还挂着的候选全部结算。"""
        self._settle(0.0, force=True)
        return self.take()

    def take(self) -> list[Hit]:
        out, self.queue = self.queue, []
        return out

    def reset(self) -> None:
        self.ref_level = float("nan")
        self.frame = 0
        self.candidates.clear()
        self.queue.clear()
        # 统计也要清零：否则重新开始监听时，界面上的「帧数 / 累计次数」
        # 会直接继承上一次会话的数值，看起来像是没重启。
        self.stats = {"frames": 0, "verdicts": 0, "confirmations": 0, "rejected": 0}


def match_signal(library, pcm: np.ndarray, sample_rate: int = config.SAMPLE_RATE,
                 params: dict | None = None,
                 denoise_params: dict | None = None) -> list[Hit]:
    """离线：给一整段音频找全部出现位置（文件识别用）。"""
    from .dsp import iter_patches

    m = Matcher(library, params)
    hits: list[Hit] = []
    for idx, patch, level, at_sec in iter_patches(pcm, sample_rate, denoise_params):
        m.push(patch, level, at_sec)
        hits.extend(m.take())
    hits.extend(m.flush())
    return hits
