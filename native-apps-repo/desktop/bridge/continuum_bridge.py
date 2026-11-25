#!/usr/bin/env python3
"""
Continuum Native Linux Bridge (Pure Python 3 Stdlib - Zero pip install)
Conecta o sistema Linux a malha Continuum com Host TLS compativel com proxies reversos,
deteccao X11/Wayland, controle PipeWire/PulseAudio, cursor absoluto (Second Screen)
e log de diagnostico em ~/.local/share/continuum/bridge.log.
"""

import base64
import datetime
import glob
import json
import os
import shutil
import socket
import ssl
import struct
import subprocess
import time
import urllib.parse

ROOM_CODE = os.environ.get("CONTINUUM_ROOM_CODE") or "MESH01"
WS_URL = os.environ.get("CONTINUUM_WS_URL") or "wss://ais-pre-a6iomfzcjhr5udpk6kpqgs-702819737353.us-east1.run.app/ws"
HOSTNAME = socket.gethostname() or "Estacao Linux"
DEVICE_ID = "linux-native-" + "".join(c for c in HOSTNAME.lower() if c.isalnum())[:14]
LOG_DIR = os.path.expanduser("~/.local/share/continuum")
LOG_FILE = os.path.join(LOG_DIR, "bridge.log")

_prev_cpu = None


def log_msg(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def detect_display_server():
    session = (os.environ.get("XDG_SESSION_TYPE") or "").lower()
    if session == "wayland" or os.environ.get("WAYLAND_DISPLAY"):
        return "wayland"
    return "x11"


def sample_cpu_percent():
    global _prev_cpu
    try:
        with open("/proc/stat", "r", encoding="utf-8") as f:
            parts = [int(x) for x in f.readline().split()[1:8]]
        idle = parts[3] + parts[4]
        total = sum(parts)
        if _prev_cpu is None:
            _prev_cpu = (idle, total)
            return 0
        d_idle = idle - _prev_cpu[0]
        d_total = total - _prev_cpu[1]
        _prev_cpu = (idle, total)
        if d_total <= 0:
            return 0
        return max(0, min(100, round((1.0 - d_idle / d_total) * 100)))
    except Exception:
        return None


def sample_memory_gb():
    try:
        info = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if ":" in line:
                    k, v = line.split(":", 1)
                    info[k.strip()] = int(v.strip().split()[0])
        total = round(info.get("MemTotal", 0) / (1024 * 1024), 1)
        avail = round(info.get("MemAvailable", 0) / (1024 * 1024), 1)
        used = round(max(0.0, total - avail), 1)
        return total, used
    except Exception:
        return None, None


def sample_battery():
    try:
        caps = glob.glob("/sys/class/power_supply/BAT*/capacity")
        if not caps:
            return None, None
        with open(caps[0], "r", encoding="utf-8") as f:
            level = int(f.read().strip())
        status_path = os.path.join(os.path.dirname(caps[0]), "status")
        with open(status_path, "r", encoding="utf-8") as f:
            charging = f.read().strip().lower() == "charging"
        return level, charging
    except Exception:
        return None, None


def get_display_geometry():
    try:
        if shutil.which("xdotool"):
            out = subprocess.check_output(["xdotool", "getdisplaygeometry"], stderr=subprocess.DEVNULL, timeout=1.0).decode("utf-8", "ignore").strip()
            parts = out.split()
            if len(parts) == 2:
                return int(parts[0]), int(parts[1])
    except Exception:
        pass
    return 1920, 1080


def list_open_windows():
    try:
        if not shutil.which("wmctrl"):
            return []
        out = subprocess.check_output(["wmctrl", "-l"], stderr=subprocess.DEVNULL, timeout=1.5).decode("utf-8", "ignore")
        apps = []
        for idx, line in enumerate(out.splitlines()[:8]):
            parts = line.split(None, 3)
            if len(parts) == 4:
                title = parts[3].strip()
                apps.append({
                    "id": f"lin-{idx}-{parts[0]}",
                    "name": title.split(" - ")[-1][:24] or "App",
                    "title": title[:80],
                    "source": "os-agent",
                    "focused": idx == 0,
                })
        return apps
    except Exception:
        return []


def move_cursor_normalized(nx, ny):
    w, h = get_display_geometry()
    tx = max(0, min(w - 1, int(round(float(nx) * w))))
    ty = max(0, min(h - 1, int(round(float(ny) * h))))
    if shutil.which("xdotool"):
        subprocess.Popen(["xdotool", "mousemove", str(tx), str(ty)])


def adjust_volume(action):
    # Suporta PipeWire (Ubuntu 24.04 / Fedora) e PulseAudio (Ubuntu 22.04 / Mint)
    if shutil.which("wpctl"):
        if action == "vol_up":
            subprocess.Popen(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%+"])
            return
        if action == "vol_down":
            subprocess.Popen(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"])
            return
        if action == "vol_mute":
            subprocess.Popen(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"])
            return
    if shutil.which("pactl"):
        if action == "vol_up":
            subprocess.Popen(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "+5%"])
        elif action == "vol_down":
            subprocess.Popen(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "-5%"])
        elif action == "vol_mute":
            subprocess.Popen(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle"])


def handle_native_input(inp):
    kind = inp.get("kind")
    try:
        if kind == "move":
            dx, dy = inp.get("dx"), inp.get("dy")
            nx, ny = inp.get("nx"), inp.get("ny")
            if isinstance(dx, (int, float)) and isinstance(dy, (int, float)):
                if shutil.which("xdotool"):
                    subprocess.Popen(["xdotool", "mousemove_relative", "--", str(int(dx)), str(int(dy))])
                elif shutil.which("ydotool"):
                    subprocess.Popen(["ydotool", "mousemove", "--", str(int(dx)), str(int(dy))])
            elif isinstance(nx, (int, float)) and isinstance(ny, (int, float)):
                move_cursor_normalized(nx, ny)
        elif kind == "click":
            nx, ny = inp.get("nx"), inp.get("ny")
            if isinstance(nx, (int, float)) and isinstance(ny, (int, float)):
                move_cursor_normalized(nx, ny)
            btn = "3" if inp.get("button") == "right" else "2" if inp.get("button") == "middle" else "1"
            if shutil.which("xdotool"):
                subprocess.Popen(["xdotool", "click", btn])
        elif kind == "scroll":
            dy = inp.get("dy", 0)
            if shutil.which("xdotool"):
                subprocess.Popen(["xdotool", "click", "5" if dy > 0 else "4"])
        elif kind == "text" and inp.get("text"):
            if shutil.which("xdotool"):
                subprocess.Popen(["xdotool", "type", "--delay", "1", str(inp["text"])])
        elif kind == "key" and inp.get("key"):
            key_map = {"Enter": "Return", "Backspace": "BackSpace", "Escape": "Escape", "Tab": "Tab", "Meta": "Super_L"}
            k = key_map.get(inp["key"], inp["key"])
            if inp.get("ctrl"):
                k = f"ctrl+{k}"
            if inp.get("alt"):
                k = f"alt+{k}"
            if shutil.which("xdotool"):
                subprocess.Popen(["xdotool", "key", k])
        elif kind == "command":
            act = inp.get("action")
            if act in ("vol_up", "vol_down", "vol_mute"):
                adjust_volume(act)
            elif act == "media_play_pause" and shutil.which("playerctl"):
                subprocess.Popen(["playerctl", "play-pause"])
            elif act == "media_next" and shutil.which("playerctl"):
                subprocess.Popen(["playerctl", "next"])
            elif act == "media_prev" and shutil.which("playerctl"):
                subprocess.Popen(["playerctl", "previous"])
            elif act == "lock":
                subprocess.Popen(["loginctl", "lock-session"])
            elif act == "ping" and shutil.which("notify-send"):
                subprocess.Popen(["notify-send", "Continuum", "Ping de diagnostico recebido neste Linux."])
            elif act == "open_url":
                url = str(inp.get("payload", ""))
                if url.startswith(("http://", "https://")):
                    subprocess.Popen(["xdg-open", url])
    except Exception as exc:
        log_msg(f"Aviso ao executar comando nativo: {exc}")


class SimpleWS:
    def __init__(self, url):
        parsed = urllib.parse.urlparse(url)
        is_tls = parsed.scheme == "wss"
        host = parsed.hostname
        port = parsed.port or (443 if is_tls else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        # RFC-6455 / HTTP 1.1: omit default ports (:443 for wss, :80 for ws) in Host header
        default_port = 443 if is_tls else 80
        host_header = host if port == default_port else f"{host}:{port}"
        origin_proto = "https" if is_tls else "http"

        raw_sock = socket.create_connection((host, port), timeout=12)
        if is_tls:
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            self.sock = raw_sock

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            f"Origin: {origin_proto}://{host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode("ascii"))
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(2048)
            if not chunk:
                raise ConnectionError("Handshake fechado pelo servidor")
            resp += chunk
        status_line = resp.split(b"\r\n", 1)[0].decode("ascii", "ignore")
        if "101" not in status_line:
            if "302" in status_line or "401" in status_line or "403" in status_line:
                raise ConnectionError(
                    f"Servidor exigiu autenticacao ({status_line}). Use a URL compartilhada (publica) ou local na central Instalar Apps."
                )
            raise ConnectionError(f"Falha no upgrade WebSocket: {status_line}")
        self.sock.settimeout(0.25)
        self._frag_buf = bytearray()

    def _send_frame(self, opcode, payload):
        mask = os.urandom(4)
        header = bytearray([0x80 | (opcode & 0x0F)])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(payload[i] ^ mask[i % 4] for i in range(length))
        self.sock.sendall(bytes(header) + masked)

    def send_json(self, obj):
        self._send_frame(0x1, json.dumps(obj).encode("utf-8"))

    def send_ping(self):
        self._send_frame(0x9, b"ping")

    def recv_exact(self, n):
        buf = bytearray()
        self.sock.settimeout(5.0)
        try:
            while len(buf) < n:
                chunk = self.sock.recv(n - len(buf))
                if not chunk:
                    raise ConnectionError("Socket fechado durante leitura")
                buf.extend(chunk)
            return bytes(buf)
        finally:
            self.sock.settimeout(0.25)

    def poll_message(self):
        try:
            head = self.sock.recv(2)
        except socket.timeout:
            return None
        if not head:
            raise ConnectionError("Conexao encerrada pelo servidor")
        if len(head) < 2:
            head += self.recv_exact(2 - len(head))
        fin = (head[0] & 0x80) != 0
        opcode = head[0] & 0x0F
        masked = (head[1] & 0x80) != 0
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", self.recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self.recv_exact(8))[0]
        mask_key = self.recv_exact(4) if masked else None
        data = self.recv_exact(length) if length > 0 else b""
        if mask_key:
            data = bytes(data[i] ^ mask_key[i % 4] for i in range(len(data)))
        if opcode == 0x8:
            raise ConnectionError("Frame de fechamento recebido")
        if opcode == 0x9:
            self._send_frame(0xA, data[:125])
            return None
        if opcode == 0xA:
            return None
        if opcode in (0x0, 0x1):
            self._frag_buf.extend(data)
            if fin:
                full = bytes(self._frag_buf)
                self._frag_buf.clear()
                return json.loads(full.decode("utf-8", "ignore"))
        return None

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def main():
    display_srv = detect_display_server()
    log_msg(f"Iniciando ponte nativa Linux ({display_srv}) para malha {ROOM_CODE} em {WS_URL}")
    while True:
        ws = None
        try:
            ws = SimpleWS(WS_URL)
            ws.send_json({
                "type": "companion:register",
                "roomCode": ROOM_CODE,
                "deviceId": DEVICE_ID,
                "name": HOSTNAME,
                "os": "linux",
                "displayServer": display_srv,
            })
            log_msg(f"Conectado a malha {ROOM_CODE} como {HOSTNAME}.")
            last_push = 0.0
            last_ping = time.time()
            while True:
                now = time.time()
                if now - last_push >= 4.0:
                    last_push = now
                    total_gb, used_gb = sample_memory_gb()
                    bat_lvl, bat_chg = sample_battery()
                    ws.send_json({
                        "type": "companion:telemetry",
                        "telemetry": {
                            "cpuCores": os.cpu_count(),
                            "cpuUsage": sample_cpu_percent(),
                            "memoryTotalGb": total_gb,
                            "memoryUsedGb": used_gb,
                            "batteryLevel": bat_lvl,
                            "batteryCharging": bat_chg,
                            "displayServer": display_srv,
                            "openApps": list_open_windows(),
                        },
                    })
                if now - last_ping >= 20.0:
                    last_ping = now
                    ws.send_ping()
                msg = ws.poll_message()
                if msg and msg.get("type") == "input:event" and msg.get("input"):
                    handle_native_input(msg["input"])
        except Exception as exc:
            log_msg(f"Desconectado ({exc}). Reconectando em 3s...")
            time.sleep(3)
        finally:
            if ws:
                ws.close()


if __name__ == "__main__":
    main()
