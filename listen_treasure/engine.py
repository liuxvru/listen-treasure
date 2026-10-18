"""识别引擎：把「音频源」和「声音库」接到一起。

两种用法：

    FileRecognizer   —— 给一段录音（或 wav 文件），按时间顺序找所有出现位置
    LiveRecognizer   —— 挂在系统回环上，实时吐判定

两者共用同一条流水线：降噪 → 分帧 → 补丁 → 余弦打分 → 连续帧确认。

线程模型（实时）：PyAudio 回调只往队列里塞原始 PCM，识别放在独立线程里跑，
避免在音频回调里做 FFT（回调里做重活会直接导致爆音、丢帧）。
"""

from __future__ import annotations

import queue
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Iterable

import numpy as np

from . import capture as capture_mod
from . import config
from . import dsp
from .matcher import Hit, Matcher, confidence_of
from .library import SoundLibrary


# ---------------------------------------------------------------- 语音活动


class LevelMeter:
    """滚动显示最近电平 + 判定“有没有声音”，用于界面波形和空转跳过。"""

    # 电平的可视下限：降噪后静音帧会掉到 -160dB 这种荒谬值，
    # 如果不夹住，本底会被算成 -158dB，于是所有柱子都被映射成满格。
    MIN_DB = -90.0
    # 柱状图的映射窗口：以 max(-70dB, 本底) 为 0，往上 40dB 算满格。
    # 不用固定的 24dB —— 回环播放游戏音效时电平常在 -45~-25dB，
    # 窗口太窄会整排柱子顶到满格，看起来像坏掉了。
    BAR_BASE_DB = -70.0
    SPAN_DB = 40.0

    def __init__(self, seconds: float = 4.0) -> None:
        self.capacity = int(seconds / config.HOP_SECONDS)
        self.values: deque[float] = deque(maxlen=self.capacity)
        self.floor_db = self.MIN_DB

    def push(self, level_db: float) -> None:
        if not np.isfinite(level_db):
            level_db = self.MIN_DB
        level_db = max(self.MIN_DB, min(0.0, float(level_db)))
        self.values.append(level_db)
        if len(self.values) > 20:
            arr = np.fromiter(self.values, dtype=np.float32)
            self.floor_db = max(self.MIN_DB, float(np.percentile(arr, 20)))

    def fill(self, level_db: float, count: int) -> None:
        """批量补 count 个采样。

        WASAPI 回环在系统静音时**完全不产生数据**，所以没有声音的时候
        电平表会一直停在最后一次播放的画面上不动。识别线程在 read() 超时
        时用这个按真实时间补静音，表才会自己落下来。
        """
        for _ in range(max(0, int(count))):
            self.push(level_db)

    def summary(self) -> dict:
        if not self.values:
            return {"levelDb": -90.0, "floorDb": -90.0, "active": False, "bars": []}
        arr = np.fromiter(self.values, dtype=np.float32)
        floor = max(self.MIN_DB, self.floor_db)
        base = max(self.BAR_BASE_DB, floor)
        bars = []
        for v in arr[-160:]:
            # 映射到 0..1，方便界面直接画柱状图
            bars.append(float(min(1.0, max(0.0, (float(v) - base) / self.SPAN_DB))))
        lv = float(arr[-1])
        return {
            "levelDb": round(lv, 1),
            "floorDb": round(floor, 1),
            "active": lv > floor + 3.0,
            "bars": [round(b, 3) for b in bars],
        }


# ---------------------------------------------------------------- 结果整理


def hit_to_json(hit: Hit, lib: SoundLibrary) -> dict:
    it = lib.item(hit.id)
    return {
        "id": hit.id,
        "name": it.name if it else hit.id,
        "score": round(hit.score, 3),
        "gap": round(hit.gap, 3),
        "confidence": hit.confidence,
        "atSec": round(hit.at_sec, 3),
        "endSec": round(hit.end_sec, 3),
        "valueMin": it.value_min if it else 0,
        "valueMax": it.value_max if it else 0,
        "itemCount": it.item_count if it else 0,
        "item": it.to_json() if it else None,
    }


@dataclass
class RecognitionResult:
    """一次识别的汇总。"""

    hits: list[dict] = field(default_factory=list)
    duration: float = 0.0
    frames: int = 0
    stats: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        best = max(self.hits, key=lambda h: h["confidence"]) if self.hits else None
        return {
            "hits": self.hits,
            "best": best,
            "alternatives": self.hits[:8],
            "duration": round(self.duration, 3),
            "frames": self.frames,
            "stats": self.stats,
        }


# ---------------------------------------------------------------- 文件识别


class FileRecognizer:
    """离线识别：一段音频 → 全部命中事件。"""

    def __init__(self, lib: SoundLibrary, params: dict | None = None,
                 denoise: dict | None = None) -> None:
        self.lib = lib
        self.params = params
        self.denoise = denoise or config.RUNTIME_NOISE

    def recognize(self, pcm: np.ndarray, sample_rate: int,
                  progress: Callable[[float], None] | None = None) -> RecognitionResult:
        if sample_rate != config.SAMPLE_RATE:
            pcm = dsp.resample(pcm, sample_rate, config.SAMPLE_RATE)
        matcher = Matcher(self.lib, self.params)
        hits: list[dict] = []
        total = max(1, pcm.size)
        last_report = 0.0

        # 实时流水线要求“分析器只保留最近 3 个补丁窗口”，所以整段音频必须
        # 按块推入并边推边取，不能一次性把 5 分钟录音塞进去。
        an = dsp.Analyzer(self.denoise)
        CHUNK = 8192
        idx = 0
        for off in range(0, pcm.size, CHUNK):
            an.push(pcm[off: off + CHUNK])
            for patch, level in an.drain_patches(1):
                verdict = matcher.push(patch, level, idx * config.HOP_SECONDS)
                for h in matcher.take():
                    hits.append(hit_to_json(h, self.lib))
                if verdict is not None and verdict.confirmed:
                    pass  # 已进队列，无需另存
                idx += 1
            if progress is not None:
                done = min(1.0, off / total)
                if done - last_report > 0.02:
                    last_report = done
                    progress(done)
        if progress is not None:
            progress(1.0)
        hits.sort(key=lambda h: h["atSec"])
        return RecognitionResult(
            hits=hits,
            duration=pcm.size / config.SAMPLE_RATE,
            frames=idx,
            stats=dict(matcher.stats),
        )

    def recognize_file(self, path: str, progress: Callable[[float], None] | None = None) -> RecognitionResult:
        pcm, sr = dsp.read_audio(path)
        return self.recognize(pcm, sr, progress)


# ---------------------------------------------------------------- 实时识别


class LiveRecognizer:
    """实时识别：后台线程吃 PCM，产出判定与统计。

    识别线程与采集线程用 queue.Queue 解耦；
    `read_events(since)` 由 HTTP / WebSocket 侧按游标取增量事件。

    事件是**广播**而不是队列：每个订阅者拿自己的游标来读，
    读事件不改变引擎状态，谁读都不会把别人的事件吃掉。
    早期版本用「读走即清空」的共享列表，只要同时开着两个页面
    （电脑 + 手机是这套软件的正常用法），两个页面就会互相抢事件，
    表现为「累计次数 17 但只列出 2 条」。
    """

    # 事件缓冲区最多留多少条。命中事件只在确认时产生（一场游戏几十条），
    # 留 400 条既够落后几秒的订阅者追上，也不会无限涨。
    MAX_EVENTS = 400

    def __init__(self, lib: SoundLibrary, params: dict | None = None,
                 denoise: dict | None = None) -> None:
        self.lib = lib
        self.params = params
        self.denoise = denoise or config.RUNTIME_NOISE
        self.capture = capture_mod.AudioCapture()
        self.matcher = Matcher(lib, self.params)
        self.params = self.matcher.p  # 补齐默认值，后面直接下标取 confirm_score
        self.analyzer = dsp.Analyzer(self.denoise)
        self.meter = LevelMeter()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        # 事件缓冲：只保留最近 MAX_EVENTS 条，配合单调递增的「总条数」当游标。
        # _events_dropped 记录被丢弃的条数，好让游标跨丢弃保持单调。
        self._events: list[dict] = []
        self._events_dropped = 0
        self._lock = threading.Lock()
        self.running = False
        self.started_at = 0.0
        self.last_verdict: dict | None = None
        self.hop_index = 0
        self.frame_seconds = 0.0

    # ------------------------------------------------------------ 生命周期

    def start(self, device_index: int | None = None) -> dict:
        if self.running:
            return self.status()
        self.matcher.reset()
        self.analyzer = dsp.Analyzer(self.denoise)
        self.meter = LevelMeter()  # 新一轮监听要清空电平历史，否则本底还带着上一轮
        self.last_verdict = None
        self.capture.start(device_index)
        self._stop.clear()
        with self._lock:
            # 清掉上一轮的事件，但**不能把游标归零**：游标必须单调递增，
            # 否则重新开始监听后，一直挂着的 SSE 连接（游标停在旧的高位）
            # 会永远读不到新事件。把清掉的条数记进 _events_dropped 即可。
            self._events_dropped += len(self._events)
            self._events.clear()
        self.hop_index = 0
        self.frame_seconds = 0.0
        self.started_at = time.time()
        self.running = True
        self._thread = threading.Thread(target=self._loop, name="recognizer", daemon=True)
        self._thread.start()
        return self.status()

    def stop(self) -> list[dict]:
        """停止采集，并结算还挂着的候选（返回这批“迟到的命中”）。

        回环在静音时不产生数据，所以最后一段声音往往还没来得及等到
        释放窗口用户就点了停止。这里强制结算，把结果交给 /api/live/stop
        一起返回，前端补进命中记录，避免“刚响完就停”丢一条。
        """
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.5)
            self._thread = None
        self.capture.stop()
        self.running = False
        late: list[dict] = []
        try:
            for h in self.matcher.flush():
                late.append(hit_to_json(h, self.lib))
                item = self.lib.item(h.id)
                self.last_verdict = {
                    "id": h.id,
                    "name": (item.name if item else h.id),
                    "score": round(h.score, 3),
                    "gap": round(h.gap, 3),
                    "confidence": h.confidence,
                    "rise": None,
                    "levelDb": (self.last_verdict or {}).get("levelDb", -90.0),
                    "confirmed": True,
                }
        except Exception:  # pragma: no cover - 结算失败不该影响停止
            late = []
        return late

    # ------------------------------------------------------------ 识别线程

    def _loop(self) -> None:
        sr = self.capture.sample_rate
        # 分析器的 mel 滤波器组、帧长、跳长全是按 48k 定的。设备原生采样率可能
        # 是 44100（本机麦克风全是 44.1k），不重采样会让每一帧的时长和频带位置
        # 都偏掉，识别率会毫无征兆地塌方。用带相位状态的流式重采样，块之间
        # 不累积误差（对每块单独调 resample() 会因逐块四舍五入慢慢漂）。
        resampler = dsp.StreamResampler(sr, config.SAMPLE_RATE)
        pending = np.zeros(0, dtype=np.float32)
        while not self._stop.is_set():
            block = self.capture.read(timeout=0.1)
            if block is None:
                # WASAPI 回环在静音时不出数据。这里按真实时间补静音，
                # 否则电平表会永远停在最后一次声音的画面上。
                self.meter.fill(self.meter.MIN_DB, int(0.1 / config.HOP_SECONDS))
                continue
            block = resampler.push(block)
            pending = np.concatenate([pending, block]) if pending.size else block
            self.analyzer.push(pending)
            pending = np.zeros(0, dtype=np.float32)
            for patch, level in self.analyzer.drain_patches(1):
                at = self.hop_index * config.HOP_SECONDS
                self.frame_seconds = at
                verdict = self.matcher.push(patch, level, at)
                self.meter.push(level)
                # 「当前判定」和最终确认用同一套两条路：要么够像（干净音效），
                # 要么一直明显领先（被背景掩蔽时）。只走后者会让干净音效
                # 在第一帧就因持续量不足而迟迟不显示；只走前者又会漏掉掩蔽场景。
                # 判据直接问 matcher，避免两处条件各改各的慢慢走岔。
                if (verdict is not None
                        and self.matcher.accepts(verdict.peak_score, verdict.peak_gap,
                                                 verdict.mass, verdict.votes)):
                    item = self.lib.item(verdict.id)
                    self.last_verdict = {
                        "id": verdict.id,
                        "name": (item.name if item else verdict.id),
                        "score": round(verdict.score, 3),
                        "gap": round(verdict.gap, 3),
                        "confidence": verdict.confidence,
                        "rise": round(float(verdict.rise), 1) if np.isfinite(verdict.rise) else None,
                        "levelDb": round(float(level), 1) if np.isfinite(level) else -90.0,
                        "confirmed": False,
                    }
                for h in self.matcher.take():
                    # 确认出来的命中才是“最终判定”，覆盖掉候选态
                    item = self.lib.item(h.id)
                    self.last_verdict = {
                        "id": h.id,
                        "name": (item.name if item else h.id),
                        "score": round(h.score, 3),
                        "gap": round(h.gap, 3),
                        "confidence": h.confidence,
                        "rise": None,
                        "levelDb": round(float(level), 1) if np.isfinite(level) else -90.0,
                        "confirmed": True,
                    }
                    self._push_event({"type": "hit", "hit": hit_to_json(h, self.lib),
                                      "at": round(time.time() - self.started_at, 3)})
                self.hop_index += 1
            # 让出 GIL，避免长时间独占（模型数据 config.DIM 维，运算很轻）
            time.sleep(0)

    def _push_event(self, ev: dict) -> None:
        with self._lock:
            self._events.append(ev)
            # 只保留最近 MAX_EVENTS 条：游标是单调递增的序号，落后太多的
            # 订阅者（比如手机锁屏两小时）会被直接跳到最早保留的位置，
            # 而不是越积越多把内存吃光。
            if len(self._events) > self.MAX_EVENTS:
                drop = len(self._events) - self.MAX_EVENTS
                del self._events[:drop]
                self._events_dropped += drop

    # ------------------------------------------------------------ 读取

    def event_cursor(self) -> int:
        """订阅者刚开始读时该用的游标：从「当前最新」开始，不重放历史。

        页面刚打开就收到这一轮之前的全部命中会让人莫名其妙，
        而且那些命中在打开页面时本来就看不到。
        """
        with self._lock:
            return self._events_dropped + len(self._events)

    def read_events(self, since: int = 0) -> tuple[list[dict], int]:
        """取游标 `since` 之后的事件，返回 (事件列表, 新游标)。

        纯读取，不清空、不推进别人的游标 —— 多个订阅者各读各的。
        """
        with self._lock:
            newest = self._events_dropped + len(self._events)
            oldest = self._events_dropped
            start = max(since, oldest)
            begin = start - oldest
            out = self._events[begin:]
            return out, newest

    def status(self) -> dict:
        dev = self.capture.device
        return {
            "running": self.running,
            "device": ({"index": dev.index, "name": dev.name, "kind": dev.kind,
                        "sampleRate": dev.sample_rate} if dev else None),
            "elapsed": round(time.time() - self.started_at, 2) if self.running else 0.0,
            "frames": self.matcher.stats["frames"],
            "confirmations": self.matcher.stats["confirmations"],
            "meter": self.meter.summary(),
            "lastVerdict": self.last_verdict,
            "error": self.capture.error,
        }
