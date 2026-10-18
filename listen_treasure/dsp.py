"""降噪与特征提取（numpy + scipy）

两件事是本文件的核心：

1. **背景降噪**（`NoiseReducer`）
   游戏回环录音里除了音效，还有环境音、BGM、风噪和底噪。这些都会让
   “170ms 频谱补丁”偏离模板，直接把余弦相似度拖下去。这里的做法是
   维纳滤波（spectral gating）的强化版：

   - 120Hz 高通：去掉低频轰鸣（游戏环境最脏的一段）
   - 噪声谱自适应跟踪：只在“不像事件”的帧上升级噪声估计，
     并且用一个缓慢的场景估计兜底，避免环境音变化后估计卡死
   - 过减因子 + 增益地板：默认 2.0 倍过减、-18dB 地板，
     环境音压得足够狠，同时给强信号留出抬升空间
   - **瞬态保护**：音效的上升沿只有 30~50ms，如果把它当噪声抹掉，
     后面再像也白搭。所以当某帧能量突然远超邻域时暂停该帧的降噪。
   - 时域噪声门：算录音里最安静的 10% 段的电平，低于
     “底噪 + 4dB”的补丁直接跳过——静音段不会再被硬凑成某个音效。

2. **补丁（patch）特征**
   170ms 窗口 × 64 个 mel 带 = 2048 维，做“相对地板的 log → 去均值 → L2 归一化”。
   去均值这一步很重要：它让特征只描述**频谱形状**，与整体音量、
   录音链路的频率响应无关，所以同一段音效在不同音量下仍然对得上。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy.signal import butter, lfilter, get_window

from . import config

_EPS = 1e-10


# ---------------------------------------------------------------- 重采样


def resample(x: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    """线性插值重采样（降采样时先做滑动平均抗混叠）。"""
    x = np.asarray(x, dtype=np.float32)
    if from_rate == to_rate or x.size == 0:
        return x
    if to_rate < from_rate:
        ratio = from_rate / to_rate
        win = int(round(ratio))
        if win > 1:
            kernel = np.ones(win, dtype=np.float32) / win
            x = np.convolve(x, kernel, mode="same").astype(np.float32)
    n_out = int(round(x.size * to_rate / from_rate))
    if n_out <= 0:
        return np.zeros(0, dtype=np.float32)
    src = np.arange(x.size, dtype=np.float64) * (from_rate / to_rate)
    idx = np.arange(n_out, dtype=np.float64)
    out = np.interp(idx, np.arange(x.size, dtype=np.float64), x.astype(np.float64))
    return out.astype(np.float32)


# ---------------------------------------------------------------- mel 滤波器组


def mel_filterbank(sample_rate: int = config.SAMPLE_RATE, frame_size: int = config.FRAME_SIZE,
                   n_mels: int = config.N_MELS, fmin: float = config.FMIN_HZ,
                   fmax: float = config.FMAX_HZ) -> np.ndarray:
    """标准 mel 三角滤波器组，返回 (n_mels, frame_size//2+1) 的权重矩阵。"""

    def hz_to_mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel_to_hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    n_bins = frame_size // 2 + 1
    fmax = min(fmax, sample_rate / 2.0)
    mels = np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2)
    freqs = np.linspace(0.0, sample_rate / 2.0, n_bins)
    hz = mel_to_hz(mels)
    bank = np.zeros((n_mels, n_bins), dtype=np.float32)
    for m in range(n_mels):
        lo, mid, hi = hz[m], hz[m + 1], hz[m + 2]
        left = (freqs - lo) / max(mid - lo, _EPS)
        right = (hi - freqs) / max(hi - mid, _EPS)
        bank[m] = np.maximum(0.0, np.minimum(left, right))
    # 面积归一化，避免高频带宽带来的整体抬升
    areas = bank.sum(axis=1, keepdims=True)
    bank /= np.maximum(areas, _EPS)
    return bank


_BANK = mel_filterbank()
_WINDOW = get_window("hann", config.FRAME_SIZE).astype(np.float32)
_WINDOW_SQ = (_WINDOW.astype(np.float64) ** 2).astype(np.float32)
_WINDOW_GAIN = _WINDOW.sum() / 2.0  # 用于把功率谱近似还原成幅度


# ---------------------------------------------------------------- 降噪


class NoiseReducer:
    """流式谱减降噪 + 时域噪声门。

    用法（流式，适用于实时采集）：
        red = NoiseReducer(config.RUNTIME_NOISE, sample_rate)
        clean = red.push(pcm_chunk)          # 返回降噪后的样本（有固定延迟）
        red.level_gate_block(pcm_chunk)      # 用原始样本喂时域电平跟踪

    也可以一次性处理：
        clean = NoiseReducer(params, rate).run(pcm)
    """

    def __init__(self, params: dict | None = None, sample_rate: int = config.SAMPLE_RATE) -> None:
        p = dict(config.RUNTIME_NOISE)
        if params:
            p.update(params)
        self.p = p
        self.sample_rate = sample_rate
        self.frame = config.FRAME_SIZE
        self.hop = config.HOP_SIZE
        self.n_bins = self.frame // 2 + 1
        self.window = _WINDOW
        self.bank = _BANK
        self.latency = self.frame - self.hop  # 输出相对输入的固定延迟（样本）

        self._b, self._a = butter(2, p["high_pass_hz"] / (sample_rate / 2.0), btype="highpass")
        self._zi = np.zeros(max(len(self._a), len(self._b)) - 1, dtype=np.float64)

        self.noise = None  # (n_bins,) 噪声功率谱
        self.noise_ready_count = 0
        self.noise_scene = None
        self.gain = np.ones(self.n_bins, dtype=np.float32)

        self.in_buf = np.zeros(0, dtype=np.float32)
        # 绝对位置对齐的加权 OLA 累加器（见 push 的说明）
        self.acc = np.zeros(0, dtype=np.float64)
        self.acc_norm = np.zeros(0, dtype=np.float64)
        self.acc_pos = 0   # acc[0] 对应的全局样本位置
        self._fed = 0      # 已推入的样本总数
        self.centered = False

        # 时域电平跟踪
        self.level_blocks = []
        self.gate_db = p["gate_floor_dbfs"]

    # -------------------------------------------------- 内部：一帧的频谱

    def _power(self, raw_frame: np.ndarray) -> np.ndarray:
        centered = raw_frame - raw_frame.mean()
        spec = np.fft.rfft(centered * self.window)
        return (spec.real ** 2 + spec.imag ** 2).astype(np.float32)

    # -------------------------------------------------- 噪声估计

    def _update_noise(self, power: np.ndarray) -> None:
        p = self.p
        if self.noise is None:
            self.noise = power.copy()
            self.noise_ready_count = 1
            return
        self.noise_ready_count += 1

        band_rms = float(np.sqrt(np.mean(power)))
        noise_rms = float(np.sqrt(np.mean(self.noise)))
        ratio = band_rms / max(noise_rms, _EPS)
        hot = power > p["hot_ratio"] * self.noise
        hot_frac = float(hot.mean())

        # 场景噪声（慢）：用一个长窗口的滑动平均兜底，防止估计卡在旧环境
        if self.noise_scene is None:
            self.noise_scene = power.copy()
        else:
            self.noise_scene = (1 - p["track_slow"]) * self.noise_scene + p["track_slow"] * power

        if self.noise_ready_count <= p["noise_init_frames"]:
            # 开头几帧直接平均，快速建立初值
            a = 1.0 / self.noise_ready_count
            self.noise = (1 - a) * self.noise + a * power
            return

        if ratio < p["gate_margin_db"] and hot_frac < 0.05:
            # 安静帧：快速跟上环境变化
            self.noise = (1 - p["track_fast"]) * self.noise + p["track_fast"] * power
        elif hot_frac > 1.0 / p["broad_frac"]:
            # 宽带突发（音效/说话）：不动噪声估计
            pass
        elif ratio < p["event_ratio"]:
            # 轻微抬升：混合场景估计
            mix = 0.25
            self.noise = (1 - mix) * self.noise + mix * self.noise_scene

    # -------------------------------------------------- 降噪核心

    def _denoise_frame(self, raw_frame: np.ndarray, prev_power: np.ndarray | None,
                       next_power: np.ndarray | None) -> np.ndarray:
        p = self.p
        power = self._power(raw_frame)
        self._update_noise(power)

        # --- 瞬态保护：突然超出邻域很多 → 只轻度降噪 ---
        alpha = p["over_subtraction"]
        if prev_power is not None and next_power is not None:
            nb = 0.5 * (prev_power + next_power)
            ratio = float(np.sqrt(np.mean(power)) / max(float(np.sqrt(np.mean(nb))), _EPS))
            if ratio > p["transient_ratio"]:
                alpha = min(alpha, 1.0)

        floor = 10 ** (p["gain_floor_db"] / 10.0)
        gain = power / (power + alpha * self.noise + _EPS)
        gain = np.maximum(gain, floor).astype(np.float32)
        s = p["smoothing"]
        self.gain = s * self.gain + (1 - s) * gain

        spec = np.fft.rfft((raw_frame - raw_frame.mean()) * self.window)
        out = np.fft.irfft(spec * self.gain, n=self.frame)
        # 加窗的合成补偿（Hann + hop = N/4 时叠加和恒定）
        return out.astype(np.float32)

    # -------------------------------------------------- 对外：一次性

    def run(self, pcm: np.ndarray) -> np.ndarray:
        """整段降噪（分析阶段可以看前后帧，效果比流式好）。"""
        x = np.asarray(pcm, dtype=np.float32)
        if x.size < self.frame:
            return x.copy()
        x = lfilter(self._b, self._a, x.astype(np.float64)).astype(np.float32)
        n_frames = 1 + (x.size - self.frame) // self.hop
        powers = [self._power(x[i * self.hop: i * self.hop + self.frame]) for i in range(n_frames)]

        # 噪声谱：取最安静的 10% 帧的平均
        energies = np.array([float(pp.mean()) for pp in powers])
        quiet_n = max(1, int(n_frames * 0.1))
        quiet_idx = np.argsort(energies)[:quiet_n]
        self.noise = np.mean([powers[i] for i in quiet_idx], axis=0).astype(np.float32)
        self.noise_scene = self.noise.copy()

        floor = 10 ** (self.p["gain_floor_db"] / 10.0)
        alpha = self.p["over_subtraction"]
        out = np.zeros(x.size + self.frame, dtype=np.float32)
        norm = np.zeros(x.size + self.frame, dtype=np.float32)
        g_prev = np.ones(self.n_bins, dtype=np.float32)
        for i in range(n_frames):
            pw = powers[i]
            a = alpha
            if 0 < i < n_frames - 1:
                nb = 0.5 * (powers[i - 1] + powers[i + 1])
                if float(np.sqrt(pw.mean()) / max(float(np.sqrt(nb.mean())), _EPS)) > self.p["transient_ratio"]:
                    a = 1.0
            elif i == 0 or i == n_frames - 1:
                nb = powers[min(i + 1, n_frames - 1)]
                if float(np.sqrt(pw.mean()) / max(float(np.sqrt(nb.mean())), _EPS)) > self.p["transient_ratio"]:
                    a = 1.0
            gain = np.maximum(pw / (pw + a * self.noise + _EPS), floor).astype(np.float32)
            s = self.p["smoothing"]
            gain = s * g_prev + (1 - s) * gain
            g_prev = gain
            spec = np.fft.rfft((x[i * self.hop: i * self.hop + self.frame] -
                                x[i * self.hop: i * self.hop + self.frame].mean()) * self.window)
            seg = np.fft.irfft(spec * gain, n=self.frame).astype(np.float32) * self.window
            out[i * self.hop: i * self.hop + self.frame] += seg
            norm[i * self.hop: i * self.hop + self.frame] += _WINDOW_SQ
        out = out[: x.size] / np.maximum(norm[: x.size], _EPS)
        # 首尾各补一点原始信号，避免边缘突变
        return out.astype(np.float32)

    # -------------------------------------------------- 对外：流式

    def push(self, pcm: np.ndarray) -> np.ndarray:
        """推入一块原始样本，返回降噪后此刻“可交付”的样本。

        合成用**绝对位置对齐的加权 OLA**：每个分析帧按它在整条流里的
        绝对样本位置累加到 acc，同时累加 w² 做归一化。这样即使增益恒为 1，
        输出也与输入逐样本相等（完美重建）；如果按“本次 push 的第几个帧”
        累加，跨越 push 边界的重叠区会错位，输出会越来越长且对不上原音。
        """
        x = np.asarray(pcm, dtype=np.float32)
        if x.size == 0:
            return np.zeros(0, dtype=np.float32)
        x, self._zi = lfilter(self._b, self._a, x.astype(np.float64), zi=self._zi)
        self.gate_level_block(np.asarray(pcm, dtype=np.float32).astype(np.float64))
        self.in_buf = np.concatenate([self.in_buf, x.astype(np.float32)])
        self._fed += x.size

        start_pos = self._fed - self.in_buf.size
        n_frames = 0 if self.in_buf.size < self.frame else (self.in_buf.size - self.frame) // self.hop + 1
        if n_frames > 0:
            span = (n_frames - 1) * self.hop + self.frame
            need_end = start_pos + span
            have_end = self.acc_pos + self.acc.size
            if need_end > have_end:
                grow = need_end - have_end
                self.acc = np.concatenate([self.acc, np.zeros(grow, dtype=np.float64)])
                self.acc_norm = np.concatenate([self.acc_norm, np.zeros(grow, dtype=np.float64)])
            w = self.window.astype(np.float64)
            w2 = w * w
            for i in range(n_frames):
                fr = self._denoise_frame(self.in_buf[i * self.hop: i * self.hop + self.frame], None, None)
                off = start_pos + i * self.hop - self.acc_pos
                self.acc[off: off + self.frame] += fr.astype(np.float64) * w
                self.acc_norm[off: off + self.frame] += w2
            self.in_buf = self.in_buf[n_frames * self.hop:]
        return self._emit_ready()

    def _emit_ready(self) -> np.ndarray:
        """把“后续帧不可能再覆盖到”的部分输出。"""
        ready_end = self._fed - self.latency
        n = ready_end - self.acc_pos
        if n <= 0:
            return np.zeros(0, dtype=np.float32)
        out = (self.acc[:n] / np.maximum(self.acc_norm[:n], 1e-6)).astype(np.float32)
        self.acc = self.acc[n:]
        self.acc_norm = self.acc_norm[n:]
        self.acc_pos += n
        return out

    # -------------------------------------------------- 时域噪声门

    def gate_level_block(self, raw: np.ndarray) -> None:
        """用原始样本更新底噪估计，产出建议门限（dBFS）。"""
        p = self.p
        blk = p["level_block"]
        self.level_blocks.append(raw)
        if sum(b.size for b in self.level_blocks) < blk * 8:
            if sum(b.size for b in self.level_blocks) < blk:
                return
        buf = np.concatenate(self.level_blocks) if len(self.level_blocks) > 1 else self.level_blocks[0]
        n = buf.size // blk
        if n < 1:
            return
        blocks = buf[: n * blk].reshape(n, blk)
        rms = np.sqrt(np.mean(blocks.astype(np.float64) ** 2, axis=1))
        quiet = rms[rms > 0]
        if quiet.size == 0:
            return
        floor = float(np.percentile(quiet, 10))
        floor_db = 20 * np.log10(max(floor, 1e-9))
        dyn = 20 * np.log10(max(float(np.percentile(quiet, 95)), 1e-9)) - floor_db
        if dyn < p["gate_min_range_db"]:
            floor_db = min(floor_db, p["gate_quiet_ceiling_dbfs"])
        self.gate_db = max(p["gate_floor_dbfs"], floor_db + p["gate_margin_db"])
        self.level_blocks = [self.level_blocks[-1]]


# ---------------------------------------------------------------- 特征


class Analyzer:
    """流式分析器：推进样本，产出 170ms 补丁（2048 维）。"""

    def __init__(self, denoise_params: dict | None = None, sample_rate: int = config.SAMPLE_RATE) -> None:
        self.sample_rate = sample_rate
        self.frame = config.FRAME_SIZE
        self.hop = config.HOP_SIZE
        self.n_mels = config.N_MELS
        self.window_frames = config.WINDOW_FRAMES
        self.bank = _BANK
        self.window = _WINDOW
        self.reducer = NoiseReducer(denoise_params, sample_rate)
        self._buf = np.zeros(0, dtype=np.float32)
        self._pending = []  # 尚未合成补丁的帧
        self.frames = []  # 最近的 log-mel 帧
        self.raw_energy = []  # 最近帧的时域均方
        self.frame_count = 0
        self._emitted = 0  # 已产出的补丁数（= 下一个补丁的起始帧号）
        self._base_index = 0  # frames[0] 对应的全局帧号
        self.levels = np.zeros(0, dtype=np.float32)
        self.level_total = 0

    # -------------------------------------------------- 推进

    def push(self, pcm: np.ndarray) -> int:
        """推入原始 48k 样本，返回新增的帧数。"""
        x = np.asarray(pcm, dtype=np.float32)
        if x.size == 0:
            return 0
        self.levels = np.concatenate([self.levels, x])
        if self.levels.size > 4800:
            self.levels = self.levels[-4800:]
        self.level_total += x.size

        clean = self.reducer.push(x)
        if clean.size:
            self._buf = np.concatenate([self._buf, clean])
        n_new = 0
        while self._buf.size >= self.frame:
            frame = self._buf[: self.frame]
            self._emit_frame(frame)
            self._buf = self._buf[self.hop:]
            n_new += 1
        return n_new

    def _emit_frame(self, frame: np.ndarray) -> None:
        sq = float(np.mean(np.asarray(frame, dtype=np.float64) ** 2))
        centered = frame - frame.mean()
        spec = np.fft.rfft(centered * self.window)
        power = (spec.real ** 2 + spec.imag ** 2).astype(np.float32)
        mel = (self.bank @ power).astype(np.float32)
        logmel = 10.0 * np.log10(np.maximum(mel, _EPS))
        self.frames.append(logmel)
        self.raw_energy.append(sq)
        self.frame_count += 1
        # 只裁掉“已经被消费完”的帧：一次 push 可能推进几十帧，
        # 若按固定长度裁剪，drain_patches 拿不到中间那些窗口。
        self._trim()

    def _trim(self) -> None:
        keep_from = max(0, self._emitted - self.window_frames + 1)
        drop = keep_from - self._base_index
        if drop > 0:
            del self.frames[:drop]
            del self.raw_energy[:drop]
            self._base_index = keep_from

    # -------------------------------------------------- 产出补丁

    def drain_patches(self, stride: int = 1):
        """把“尚未产出过”的补丁按顺序取出。

        补丁 i 覆盖帧区间 [i, i+WF)。必须按**该位置**取窗，不能反复调用
        patch() —— patch() 永远返回最新的 WF 帧，一次推进多帧时会把
        同一个窗口重复产出几十次（早期版本就是这个 bug：所有模板
        都是最后 170ms，音效开头的声音永远对不上）。
        """
        if not hasattr(self, "_emitted"):
            self._emitted = 0
        out = []
        while self.frame_count - self._emitted >= self.window_frames:
            i = self._emitted
            self._emitted += 1
            if i % max(1, stride) != 0:
                self._trim()
                continue
            local = i - self._base_index
            tail = self.frames[local: local + self.window_frames]
            if len(tail) == self.window_frames:
                p = normalize_patch(np.concatenate(tail))
                out.append((p, self._patch_level_at(i)))
            self._trim()
        return out

    def _patch_level_at(self, k: int) -> float:
        i = k - self._base_index
        if i < 0 or i >= len(self.raw_energy):
            return -np.inf
        e = self.raw_energy[i]
        return 10 * np.log10(e) if e > 0 else -np.inf


    def ready(self) -> bool:
        return len(self.frames) >= self.window_frames

    def patch(self) -> np.ndarray | None:
        if not self.ready():
            return None
        tail = self.frames[-self.window_frames:]
        return normalize_patch(np.concatenate(tail))

    def patch_level_dbfs(self) -> float:
        if not self.raw_energy:
            return -np.inf
        e = self.raw_energy[-1]
        return 10 * np.log10(e) if e > 0 else -np.inf

    def level_dbfs(self) -> float:
        if self.levels.size == 0:
            return -np.inf
        rms = float(np.sqrt(np.mean(self.levels.astype(np.float64) ** 2)))
        return 20 * np.log10(rms) if rms > 0 else -np.inf

    @property
    def gate_dbfs(self) -> float:
        return self.reducer.gate_db


def normalize_patch(patch: np.ndarray) -> np.ndarray:
    """相对地板 → 去均值 → L2 归一化。"""
    p = np.asarray(patch, dtype=np.float32).copy()
    if p.size == 0:
        return p
    max_v = float(p.max())
    if not np.isfinite(max_v):
        return np.zeros_like(p)
    floor = max_v + config.LOG_FLOOR_DB
    np.maximum(p, floor, out=p)
    p -= p.mean()
    nrm = float(np.sqrt(np.dot(p, p)))
    if nrm <= 1e-12:
        return np.zeros_like(p)
    return (p / nrm).astype(np.float32)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.clip(np.dot(a, b), -1.0, 1.0))




# ---------------------------------------------------------------- 离线接口


def read_audio(path: str | Path) -> tuple[np.ndarray, int]:
    """读任意音频文件 → (单声道 float32, 采样率)。

    优先 soundfile（支持 wav/flac/ogg/mp3 若 libsndfile 带编解码），
    失败再退回标准库 wave。游戏里录的通常是 wav，两条路都覆盖。
    """
    p = Path(path)
    try:
        import soundfile as sf  # type: ignore

        data, sr = sf.read(str(p), dtype="float32", always_2d=True)
        mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
        return np.ascontiguousarray(mono, dtype=np.float32), int(sr)
    except Exception:
        pass
    import wave

    with wave.open(str(p), "rb") as wf:
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if sw == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
        data = v.astype(np.float32) / float(1 << 23)
    elif sw == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"不支持的位深：{sw * 8}bit")
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return np.ascontiguousarray(data, dtype=np.float32), int(sr)


def patches_of_signal(pcm: np.ndarray, sample_rate: int = config.SAMPLE_RATE,
                      stride: int = 1, denoise_params: dict | None = None) -> tuple[list[np.ndarray], list[float], "Analyzer"]:
    """整段音频 → 每 hop 一个补丁（stride>1 时抽稀）。

    返回 (patches, levels_dbfs, analyzer)。补丁按时间顺序排列，
    patches[i] 覆盖的区间是 [i*hop, i*hop + WF*hop)。
    """
    x = np.asarray(pcm, dtype=np.float32)
    if sample_rate != config.SAMPLE_RATE:
        x = resample(x, sample_rate, config.SAMPLE_RATE)
    an = Analyzer(denoise_params)
    patches: list[np.ndarray] = []
    levels: list[float] = []
    CHUNK = 8192
    for off in range(0, x.size, CHUNK):
        an.push(x[off: off + CHUNK])
        for p, lv in an.drain_patches(stride):
            patches.append(p)
            levels.append(lv)
    # 尾部不足一窗的部分不再补
    return patches, levels, an


def _active_picks(energy: np.ndarray, count: int, span: int,
                  step: int, frac: float) -> list[int]:
    """从逐帧能量里挑出要当模板的位置（两种策略合并）。"""
    n = int(energy.size)
    peak = int(np.argmax(energy))

    # 策略一：以峰值为中心的一簇（覆盖音效最响的那一段）
    if count > 1:
        offs = [int(round(-span * (1 - 2 * k / (count - 1)))) for k in range(count)]
        cluster = [min(n - 1, max(0, peak + d)) for d in offs]
    else:
        cluster = [peak]

    # 策略二：在“有声区间”里均匀铺开（覆盖音效的头/中/尾）
    # 只用策略一会漏掉音效的开头——游戏里经常是声音已经响了我们才开始捕获，
    # 实测丢头 15% 就掉到 13/17。补上铺开后丢尾 50% 从 1/17 涨到 10/17。
    thr = energy[peak] * frac
    active = [i for i in range(n) if energy[i] >= thr]
    if not active:
        active = [peak]
    spread = active[::max(1, step)]
    if spread and spread[-1] != active[-1]:
        spread.append(active[-1])

    return sorted(set(cluster) | set(spread))


def anchor_patches(pcm: np.ndarray, sample_rate: int = config.SAMPLE_RATE,
                   count: int = 4, span: int = 6,
                   denoise_params: dict | None = None,
                   step: int | None = None,
                   active_frac: float | None = None) -> list[np.ndarray]:
    """挑出“音效有声区间”的若干补丁作为模板。

    音效只有 60~800ms，若整段平均成一个向量，静音段会把特征稀释。
    这里先按**时间区间**算逐帧能量，再合并两种取样策略（见 _active_picks）。

    注意：补丁能量必须**直接按时间区间**从原始 PCM 算，不能用分析器内部的
    逐帧能量数组——那个数组只保留最近若干帧，跨块累积会错位（曾经导致
    4 张模板全取到音效之外，自识别只有 0.4 分）。
    """
    x = np.asarray(pcm, dtype=np.float32)
    if sample_rate != config.SAMPLE_RATE:
        x = resample(x, sample_rate, config.SAMPLE_RATE)
    params = denoise_params or config.TEMPLATE_NOISE
    step = int(config.TEMPLATE_SPREAD_STEP if step is None else step)
    frac = float(config.TEMPLATE_ACTIVE_FRAC if active_frac is None else active_frac)

    patches, _, _ = patches_of_signal(x, config.SAMPLE_RATE, stride=1, denoise_params=params)
    n = len(patches)
    if n == 0:
        return []

    hop = config.HOP_SIZE
    win = config.WINDOW_FRAMES * hop
    energy = np.zeros(n, dtype=np.float64)
    for i in range(n):
        seg = x[i * hop: i * hop + win]
        if seg.size:
            energy[i] = float(np.mean(seg.astype(np.float64) ** 2))
    smooth = np.convolve(energy, np.ones(5) / 5.0, mode="same") if n >= 5 else energy

    out: list[np.ndarray] = []
    for i in _active_picks(smooth, count, span, step, frac):
        p = patches[i]
        # 完全相同的补丁去重（短音效几个偏移会落到同一位置）
        if any(float(np.dot(p, q)) > 0.9999 for q in out):
            continue
        out.append(p)
    return out


def iter_patches(pcm: np.ndarray, sample_rate: int = config.SAMPLE_RATE,
                 denoise_params: dict | None = None):
    """整段音频 → 依次产出 (index, patch, level_db, at_sec)。"""
    x = np.asarray(pcm, dtype=np.float32)
    if sample_rate != config.SAMPLE_RATE:
        x = resample(x, sample_rate, config.SAMPLE_RATE)
    an = Analyzer(denoise_params)
    idx = 0
    CHUNK = 8192
    for off in range(0, x.size, CHUNK):
        an.push(x[off: off + CHUNK])
        for p, lv in an.drain_patches(1):
            yield idx, p, lv, idx * config.HOP_SECONDS
            idx += 1
