"""局域网地址探测 + 二维码生成。

手机端要走「电脑起服务、手机连同一个 Wi-Fi 打开网页」这条路，所以必须
知道本机在局域网里的地址；地址有时候不止一个（有线 + 无线 + 虚拟网卡），
所以全部列出来让用户自己挑，别自作聪明只给一个。
"""

from __future__ import annotations

import socket

# 虚拟网卡/容器网卡的地址对「手机连电脑」毫无意义，直接过滤掉。
_SKIP_PREFIXES = (
    "127.",
    "169.254.",  # APIPA：没拿到 DHCP 时的自分配地址
    "0.",
)


def _is_usable(ip: str) -> bool:
    if not ip or ip.count(".") != 3:
        return False
    return not ip.startswith(_SKIP_PREFIXES)


def primary_ip() -> str | None:
    """拿默认出口网卡的地址。

    UDP socket 的 connect 不会真的发包，只是让内核选路由，所以很快也不用网络。
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.4)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        return ip if _is_usable(ip) else None
    except OSError:
        return None


def lan_ips() -> list[str]:
    """所有可用的局域网 IPv4，默认出口地址排最前。"""
    found: list[str] = []
    first = primary_ip()
    if first:
        found.append(first)

    # getaddrinfo 能捞到多网卡的地址（有些机器只有这个方法能拿全）
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if _is_usable(ip) and ip not in found:
                found.append(ip)
    except OSError:
        pass

    # 兜底：直连不同网段，逼内核给出该网段使用的本机地址
    for probe in ("10.255.255.255", "192.168.255.255", "172.16.255.255"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.settimeout(0.25)
                s.connect((probe, 1))
                ip = s.getsockname()[0]
            if _is_usable(ip) and ip not in found:
                found.append(ip)
        except OSError:
            continue

    return found


def is_loopback_host(host: str) -> bool:
    return host in ("127.0.0.1", "localhost", "::1", "0.0.0.0")


# ---------------------------------------------------------------- 二维码


def qr_svg(text: str, scale: int = 5) -> str | None:
    """生成 SVG 二维码（矢量，任意分辨率都清晰，体积只有 1~2KB）。"""
    try:
        import io

        import segno
    except ImportError:
        return None
    # segno 的 SVG writer 按 out 的类型决定写 str 还是 bytes：
    # 给 StringIO 它反而写 bytes（TypeError），所以统一用 BytesIO 再解码。
    buf = io.BytesIO()
    segno.make(text, error="m").save(buf, kind="svg", scale=scale, border=2,
                                     xmldecl=False, svgns=True, nl=True,
                                     dark="#0b0f0d", light="#ffffff")
    return buf.getvalue().decode("utf-8")


def qr_png(text: str, scale: int = 8) -> bytes | None:
    try:
        import io

        import segno
    except ImportError:
        return None
    buf = io.BytesIO()
    segno.make(text, error="m").save(buf, kind="png", scale=scale, border=2,
                                     dark="#0b0f0d", light="#ffffff")
    return buf.getvalue()


def qr_ascii(text: str) -> str | None:
    """终端里直接打印的二维码：用两个半格字符把 1 个模块压成半行高。"""
    try:
        import segno
    except ImportError:
        return None
    qr = segno.make(text, error="m")
    rows = list(qr.matrix)
    lines = []
    for y in range(0, len(rows), 2):
        top = rows[y]
        bottom = rows[y + 1] if y + 1 < len(rows) else [0] * len(top)
        line = []
        for x in range(len(top)):
            t = 1 if top[x] else 0
            b = 1 if x < len(bottom) and bottom[x] else 0
            # ▀ 上半黑 / ▄ 下半黑 / █ 全黑 / 空格 全白
            line.append("█" if t and b else "▀" if t else "▄" if b else " ")
        lines.append("".join(line))
    return "\n".join(lines)


if __name__ == "__main__":
    print("primary:", primary_ip())
    print("all:", lan_ips())
    print(qr_ascii(f"http://{primary_ip()}:8760/m"))
