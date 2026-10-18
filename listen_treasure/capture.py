"""音频采集：WASAPI 回环（系统声音）与麦克风。

为什么不用麦克风默认值：
  游戏在耳机/音箱里播放，麦克风录到的是“经过房间和扬声器”的声音，
  音量小、混响重、还有键盘声。WASAPI 回环直接拿声卡的输出缓冲，
  等于把“游戏听到什么”原样录下来，是这类识别最干净的输入。

依赖 pyaudiowpatch（PyAudio 的 WASAPI 回环分支）。没装时自动退化成
麦克风模式，界面会提示原因。
"""

from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass

import numpy as np

from . import config


@dataclass
class DeviceInfo:
    index: int
    name: str
    kind: str  # "loopback" | "input"
    channels: int
    sample_rate: int

    def to_json(self) -> dict:
        return {
            "index": self.index,
            "name": self.name,
            "kind": self.kind,
            "channels": self.channels,
            "sampleRate": self.sample_rate,
        }


def _pyaudio_module():
    try:
        import pyaudiowpatch as pyaudio  # type: ignore

        return pyaudio
    except Exception:
        return None


def _safe_name(raw: object) -> str:
    """PyAudio 的端口名是按系统 ANSI 代码页解出来的 bytes，中文会变乱码。

    这里尽量把 bytes 按 UTF-8 / GBK 重解，失败就沿用原串。
    纯粹为了界面好看，识别逻辑不依赖设备名。
    """
    if isinstance(raw, bytes):
        for enc in ("utf-8", "gbk", "cp936"):
            try:
                return raw.decode(enc)
            except Exception:
                continue
        return raw.decode("latin-1", "replace")
    # Windows 上端口名本来就是 str（UTF-16），乱码是控制台代码页显示问题，
    # 不要在这里二次解码，否则会把正常的“耳机”改成问号。
    return str(raw or "")


def list_devices() -> dict:
    """列出可用的回环设备与麦克风。"""
    pyaudio = _pyaudio_module()
    loopback: list[DeviceInfo] = []
    inputs: list[DeviceInfo] = []
    if pyaudio is None:
        return {
            "loopback": [],
            "input": [],
            "defaultLoopback": -1,
            "error": "未安装 pyaudiowpatch，只能手动选文件识别",
        }
    p = pyaudio.PyAudio()
    default_index = -1
    try:
        try:
            default_index = int(p.get_default_wasapi_loopback()["index"])
        except Exception:
            default_index = -1
        for i in range(p.get_device_count()):
            try:
                d = p.get_device_info_by_index(i)
            except Exception:
                continue
            ch = int(d.get("maxInputChannels") or 0)
            if ch <= 0:
                continue
            name = _safe_name(d.get("name") or f"设备 {i}")
            rate = int(d.get("defaultSampleRate") or config.SAMPLE_RATE)
            if d.get("isLoopbackDevice"):
                loopback.append(DeviceInfo(i, name, "loopback", ch, rate))
            else:
                inputs.append(DeviceInfo(i, name, "input", ch, rate))
        # 把系统默认回环排到第一
        loopback.sort(key=lambda x: (x.index != default_index, x.name))
    finally:
        p.terminate()
    return {
        "loopback": [d.to_json() for d in loopback],
        "input": [d.to_json() for d in inputs],
        "defaultLoopback": default_index,
    }


class AudioCapture:
    """持续采集指定设备，按块回调解出 48k 单声道 PCM。"""

    def __init__(self) -> None:
        self._pyaudio = _pyaudio_module()
        self._audio = None
        self._stream = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=64)
        self.device: DeviceInfo | None = None
        self.sample_rate = config.SAMPLE_RATE
        self.channels = 1
        self.error: str | None = None
        self.running = False
        self.level_db = -np.inf

    # ------------------------------------------------------------ 启动

    def start(self, device_index: int | None = None) -> None:
        if self.running:
            return
        if self._pyaudio is None:
            raise RuntimeError("未安装 pyaudiowpatch，无法采集系统声音（可改用文件识别）")
        self._audio = self._pyaudio.PyAudio()
        info = self._pick_device(device_index)
        self.device = info
        self.sample_rate = info.sample_rate
        self.channels = min(2, info.channels)
        self._stop.clear()
        self._stream = self._audio.open(
            format=self._pyaudio.paFloat32,
            channels=self.channels,
            rate=self.sample_rate,
            frames_per_buffer=1024,
            input=True,
            input_device_index=info.index,
            stream_callback=self._callback,
        )
        self._stream.start_stream()
        self.running = True
        self.error = None

    def _pick_device(self, device_index: int | None) -> DeviceInfo:
        p = self._audio
        if device_index is not None:
            d = p.get_device_info_by_index(device_index)
            return DeviceInfo(
                int(d["index"]),
                str(d["name"]),
                "loopback" if d.get("isLoopbackDevice") else "input",
                int(d["maxInputChannels"]),
                int(d["defaultSampleRate"]),
            )
        # 默认：系统默认输出设备的回环
        try:
            d = p.get_default_wasapi_loopback()
            return DeviceInfo(
                int(d["index"]),
                str(d["name"]),
                "loopback",
                int(d["maxInputChannels"]),
                int(d["defaultSampleRate"]),
            )
        except Exception:
            # 退化成默认麦克风
            d = p.get_default_input_device_info()
            return DeviceInfo(
                int(d["index"]),
                str(d["name"]),
                "input",
                int(d["maxInputChannels"]),
                int(d["defaultSampleRate"]),
            )

    # ------------------------------------------------------------ 回调

    def _callback(self, in_data, frame_count, time_info, status):  # noqa: ANN001
        pyaudio = self._pyaudio
        try:
            data = np.frombuffer(in_data, dtype=np.float32).reshape(-1, self.channels)
            mono = data.mean(axis=1)
            rms = float(np.sqrt(np.mean(mono.astype(np.float64) ** 2))) if mono.size else 0.0
            self.level_db = 20 * np.log10(rms) if rms > 0 else -np.inf
            try:
                self._q.put_nowait(mono)
            except queue.Full:
                pass
        except Exception as exc:  # pragma: no cover
            self.error = str(exc)
        return (None, pyaudio.paContinue)

    # ------------------------------------------------------------ 读取

    def read(self, timeout: float = 0.2) -> np.ndarray | None:
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain(self) -> list[np.ndarray]:
        out = []
        while True:
            try:
                out.append(self._q.get_nowait())
            except queue.Empty:
                return out

    def stop(self) -> None:
        self.running = False
        self._stop.set()
        try:
            if self._stream is not None:
                self._stream.stop_stream()
                self._stream.close()
        except Exception:
            pass
        try:
            if self._audio is not None:
                self._audio.terminate()
        except Exception:
            pass
        self._stream = None
        self._audio = None

    # ------------------------------------------------------------ 录制一段

    def record(self, seconds: float, preroll: float = 0.2) -> tuple[np.ndarray, int]:
        """从当前流录制固定时长，返回 (48k 单声道 PCM, 原始采样率)。"""
        if not self.running:
            raise RuntimeError("采集器未启动")
        chunks = []
        while True:  # 丢掉积压的旧块
            try:
                self._q.get_nowait()
            except queue.Empty:
                break
        # 预录：先拿一点已经在路上的数据
        t_end = time.time() + seconds
        while time.time() < t_end:
            block = self.read(timeout=0.2)
            if block is not None:
                chunks.append(block)
        pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        return pcm, self.sample_rate


def play_file(path: str | None = None, pcm: np.ndarray | None = None,
              sample_rate: int = config.SAMPLE_RATE) -> None:
    """把一段音频播到默认输出（用于“用样本音效测试回环”）。"""
    pyaudio = _pyaudio_module()
    if pyaudio is None:
        raise RuntimeError("未安装 pyaudiowpatch，无法播放")
    if pcm is None:
        import wave

        with wave.open(str(path), "rb") as wf:
            n = wf.getnframes()
            raw = wf.readframes(n)
            ch = wf.getnchannels()
            sw = wf.getsampwidth()
            sr = wf.getframerate()
        if sw == 2:
            data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        elif sw == 4:
            data = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
        elif sw == 1:
            data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
        else:
            raise RuntimeError(f"不支持的位深：{sw * 8}bit")
        pcm = data.reshape(-1, ch).mean(axis=1)
        sample_rate = sr
    p = pyaudio.PyAudio()
    try:
        stream = p.open(format=pyaudio.paFloat32, channels=1, rate=int(sample_rate), output=True,
                        frames_per_buffer=1024)
        stream.write(np.asarray(pcm, dtype=np.float32).tobytes())
        stream.stop_stream()
        stream.close()
    finally:
        p.terminate()
