#!/usr/bin/env python3
"""
Continuum v5.1.0 — Aplicativo Desktop 100% Nativo para Linux (GTK 3 + Cairo Holografico + Extensao de Tela + KVM + Clipboard Auto)
Comunicacao direta e estavel entre Linux, Windows e Android via TCP 45891 + UDP 45890 + Radar TCP /24.
"""

import base64
import concurrent.futures
import datetime
import glob
import hashlib
import json
import math
import os
import queue
import re
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.parse

APP_VERSION = "5.1.0"
LAN_UDP_PORT = 45890
LAN_WS_PORT = 45891
PROTO_V5 = "continuum-lan-v5"
PROTO_V4 = "continuum-lan-v4"
PROTO_V3 = "continuum-lan-v3"
MULTICAST_ADDR = "239.255.45.90"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

DEFAULT_ROOM_CODE = "MESH01"

HOSTNAME = socket.gethostname() or "Estacao Linux"
_CLEAN_HOST = "".join(c for c in HOSTNAME.lower() if c.isalnum())[:14] or "linux"
DEVICE_ID = f"linux-app-{_CLEAN_HOST}-{os.getpid() % 9000 + 1000}"
CONFIG_DIR = os.path.expanduser("~/.config/continuum")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
LOG_DIR = os.path.expanduser("~/.local/share/continuum")
LOG_FILE = os.path.join(LOG_DIR, "app.log")
DOWNLOADS_DIR = os.path.expanduser("~/Downloads/Continuum")

_prev_cpu = None
_active_mon_geom = {"x": 0, "y": 0, "w": 1920, "h": 1080}


def log_msg(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def get_local_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.4)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127."):
                return ip
    except Exception:
        pass
    return "127.0.0.1"


def get_subnet_broadcast(ip):
    parts = (ip or "").split(".")
    if len(parts) == 4 and not ip.startswith("127."):
        return f"{parts[0]}.{parts[1]}.{parts[2]}.255"
    return None


def normalize_ws_endpoint(raw):
    """Bulletproof parser: accepts http://ip:port, ws://ip:port, ip:port, ip, or shorthand '.42'."""
    s = (raw or "").strip()
    if not s:
        return ""
    s = re.sub(r"^(https?|wss?)://", "", s, flags=re.IGNORECASE)
    if "/" in s:
        s = s.split("/", 1)[0]
    s = s.strip()
    if not s:
        return ""

    dot_clean = s.lstrip(".")
    if re.match(r"^[0-9]{1,3}(:[0-9]{2,5})?$", dot_clean):
        lan_ip = get_local_lan_ip()
        parts = lan_ip.split(".")
        if len(parts) == 4 and not lan_ip.startswith("127."):
            s = f"{parts[0]}.{parts[1]}.{parts[2]}.{dot_clean}"

    host = s
    port = LAN_WS_PORT
    if ":" in s:
        h, p = s.rsplit(":", 1)
        if p.isdigit() and 1 <= int(p) <= 65535:
            host = h.strip()
            port = int(p)
    if not host or " " in host:
        return ""
    return f"ws://{host}:{port}/ws"


def parse_host_port(raw):
    ws = normalize_ws_endpoint(raw)
    if not ws:
        return None
    p = urllib.parse.urlparse(ws)
    return (p.hostname, p.port or LAN_WS_PORT)


def probe_http_info(host, port=LAN_WS_PORT, timeout=0.32):
    s = None
    try:
        s = socket.create_connection((host, int(port)), timeout=timeout)
        s.settimeout(timeout + 0.3)
        req = f"GET /continuum-info HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
        s.sendall(req.encode("ascii"))
        data = b""
        while len(data) < 4096:
            chunk = s.recv(1024)
            if not chunk:
                break
            data += chunk
        idx = data.find(b"\r\n\r\n")
        if idx < 0:
            return None
        info = json.loads(data[idx + 4:].decode("utf-8", errors="ignore"))
        return info if info.get("ok") else None
    except Exception:
        return None
    finally:
        if s:
            try:
                s.close()
            except Exception:
                pass


def load_config():
    cfg = {
        "roomCode": DEFAULT_ROOM_CODE,
        "manualPeer": "",
        "autoLan": True,
        "wsPort": LAN_WS_PORT,
        "sensitivity": 1.6,
        "autoClipboard": True,
        "kvmEdgeEnabled": False,
        "kvmEdgeSide": "right",
    }
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding="utf-8") as fh:
                saved = json.load(fh)
            if isinstance(saved, dict):
                cfg.update(saved)
    except Exception:
        pass
    return cfg


def save_config(cfg):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_FILE, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
    except Exception:
        pass


def detect_display_server():
    session = os.environ.get("XDG_SESSION_TYPE", "").lower()
    if session == "wayland" or os.environ.get("WAYLAND_DISPLAY"):
        return "wayland"
    if session == "x11" or os.environ.get("DISPLAY"):
        return "x11"
    return "unknown"


def collect_telemetry():
    global _prev_cpu
    cpu_usage = 12
    try:
        with open("/proc/stat", "r", encoding="utf-8") as fh:
            parts = [int(x) for x in fh.readline().split()[1:8]]
        idle = parts[3] + parts[4]
        total = sum(parts)
        if _prev_cpu is not None:
            dt = total - _prev_cpu[1]
            di = idle - _prev_cpu[0]
            if dt > 0:
                cpu_usage = max(0, min(100, round((1 - di / dt) * 100)))
        _prev_cpu = (idle, total)
    except Exception:
        pass

    mem_total = 0
    mem_avail = 0
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    mem_total = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    mem_avail = int(line.split()[1])
    except Exception:
        pass
    ram_pct = round(((mem_total - mem_avail) / mem_total) * 100) if mem_total > 0 else 28

    battery = None
    charging = None
    try:
        bats = sorted(glob.glob("/sys/class/power_supply/BAT*"))
        if bats:
            with open(os.path.join(bats[0], "capacity"), "r", encoding="utf-8") as fh:
                battery = int(fh.read().strip())
            with open(os.path.join(bats[0], "status"), "r", encoding="utf-8") as fh:
                charging = fh.read().strip().lower() in ("charging", "full")
    except Exception:
        pass

    return {
        "cpuUsage": cpu_usage,
        "memoryUsagePercent": ram_pct,
        "memoryUsedMb": round((mem_total - mem_avail) / 1024) if mem_total else 0,
        "memoryTotalMb": round(mem_total / 1024) if mem_total else 0,
        "batteryLevel": battery,
        "isCharging": charging,
        "networkType": "LAN Direta",
        "lanIp": get_local_lan_ip(),
        "displayServer": detect_display_server(),
        "platformArch": os.uname().machine if hasattr(os, "uname") else "x86_64",
    }


def run_cmd(cmd):
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception:
        return False


def execute_os_input(event, ui_notify=None):
    kind = event.get("kind")
    has_xdo = shutil.which("xdotool") is not None
    if kind == "move" and has_xdo:
        dx = int(round(float(event.get("dx", 0)) * 1.8))
        dy = int(round(float(event.get("dy", 0)) * 1.8))
        if dx != 0 or dy != 0:
            run_cmd(["xdotool", "mousemove_relative", "--", str(dx), str(dy)])
    elif kind == "abs_move" and has_xdo:
        nx = max(0.0, min(1.0, float(event.get("nx", 0.5))))
        ny = max(0.0, min(1.0, float(event.get("ny", 0.5))))
        ax = int(_active_mon_geom["x"] + nx * _active_mon_geom["w"])
        ay = int(_active_mon_geom["y"] + ny * _active_mon_geom["h"])
        run_cmd(["xdotool", "mousemove", str(ax), str(ay)])
    elif kind == "abs_click" and has_xdo:
        nx = max(0.0, min(1.0, float(event.get("nx", 0.5))))
        ny = max(0.0, min(1.0, float(event.get("ny", 0.5))))
        ax = int(_active_mon_geom["x"] + nx * _active_mon_geom["w"])
        ay = int(_active_mon_geom["y"] + ny * _active_mon_geom["h"])
        btn_map = {"left": "1", "middle": "2", "right": "3"}
        btn = btn_map.get(event.get("button", "left"), "1")
        run_cmd(["xdotool", "mousemove", str(ax), str(ay), "click", btn])
    elif kind == "click" and has_xdo:
        btn_map = {"left": "1", "middle": "2", "right": "3"}
        btn = btn_map.get(event.get("button", "left"), "1")
        if event.get("double"):
            run_cmd(["xdotool", "click", "--repeat", "2", "--delay", "70", btn])
        else:
            run_cmd(["xdotool", "click", btn])
    elif kind == "scroll" and has_xdo:
        dy = float(event.get("dy", 0))
        btn = "5" if dy > 0 else "4"
        steps = max(1, min(8, int(abs(dy) / 22) or 1))
        run_cmd(["xdotool", "click", "--repeat", str(steps), btn])
    elif kind == "text" and has_xdo:
        text = str(event.get("text", ""))[:400]
        if text:
            run_cmd(["xdotool", "type", "--clearmodifiers", "--delay", "8", "--", text])
    elif kind == "key" and has_xdo:
        raw_key = str(event.get("key", ""))
        key_map = {
            "Enter": "Return",
            "Backspace": "BackSpace",
            "Escape": "Escape",
            "Tab": "Tab",
            "Space": "space",
            "ArrowUp": "Up",
            "ArrowDown": "Down",
            "ArrowLeft": "Left",
            "ArrowRight": "Right",
            "Alt+Tab": "alt+Tab",
            "Ctrl+C": "ctrl+c",
            "Ctrl+V": "ctrl+v",
            "Ctrl+Z": "ctrl+z",
            "Super": "Super_L",
        }
        k = key_map.get(raw_key, raw_key)
        if k:
            run_cmd(["xdotool", "key", k])
    elif kind == "media":
        action = event.get("action")
        if action == "vol_up":
            if shutil.which("wpctl"):
                run_cmd(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%+"])
            elif shutil.which("pactl"):
                run_cmd(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "+5%"])
        elif action == "vol_down":
            if shutil.which("wpctl"):
                run_cmd(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"])
            elif shutil.which("pactl"):
                run_cmd(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "-5%"])
        elif action == "mute":
            if shutil.which("wpctl"):
                run_cmd(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"])
            elif shutil.which("pactl"):
                run_cmd(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle"])
        elif action == "play_pause":
            if shutil.which("playerctl"):
                run_cmd(["playerctl", "play-pause"])
            elif has_xdo:
                run_cmd(["xdotool", "key", "XF86AudioPlay"])
        elif action == "next":
            if shutil.which("playerctl"):
                run_cmd(["playerctl", "next"])
            elif has_xdo:
                run_cmd(["xdotool", "key", "XF86AudioNext"])
        elif action == "prev":
            if shutil.which("playerctl"):
                run_cmd(["playerctl", "previous"])
            elif has_xdo:
                run_cmd(["xdotool", "key", "XF86AudioPrev"])
        elif action == "lock":
            if shutil.which("loginctl"):
                run_cmd(["loginctl", "lock-session"])
            elif shutil.which("xdg-screensaver"):
                run_cmd(["xdg-screensaver", "lock"])
        elif action == "ping":
            if shutil.which("notify-send"):
                run_cmd(["notify-send", "Continuum", "Sinal de localizacao recebido na rede local!"])
            if ui_notify:
                ui_notify("Localizacao", "Sinal de localizacao recebido de outro dispositivo!")


# ---------------------------------------------------------------------------
# RFC-6455 Pure-Python Helpers (Full Fragmented Frame Support)
# ---------------------------------------------------------------------------

def recv_exact(sock, n, stop_check=None):
    buf = bytearray()
    while len(buf) < n:
        if stop_check and stop_check():
            raise ConnectionError("Closed")
        try:
            chunk = sock.recv(n - len(buf))
        except socket.timeout:
            if stop_check and stop_check():
                raise ConnectionError("Closed")
            continue
        if not chunk:
            raise ConnectionError("EOF")
        buf.extend(chunk)
    return bytes(buf)


def ws_encode_frame(payload_bytes, opcode=0x1, masked=False):
    header = bytearray([0x80 | (opcode & 0x0F)])
    length = len(payload_bytes)
    mask_bit = 0x80 if masked else 0x00
    if length < 126:
        header.append(mask_bit | length)
    elif length < 65536:
        header.append(mask_bit | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(mask_bit | 127)
        header.extend(struct.pack("!Q", length))
    if masked:
        mask = os.urandom(4)
        header.extend(mask)
        masked_data = bytes(b ^ mask[i & 3] for i, b in enumerate(payload_bytes))
        return bytes(header) + masked_data
    return bytes(header) + payload_bytes


def ws_read_message(sock, stop_check=None):
    """Reads a complete RFC-6455 message, automatically reassembling fragmented frames (FIN=0 + opcode=0)."""
    frag_chunks = []
    frag_opcode = None
    while True:
        b1, b2 = recv_exact(sock, 2, stop_check=stop_check)
        fin = (b1 & 0x80) != 0
        opcode = b1 & 0x0F
        is_masked = (b2 & 0x80) != 0
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack("!H", recv_exact(sock, 2, stop_check=stop_check))[0]
        elif length == 127:
            length = struct.unpack("!Q", recv_exact(sock, 8, stop_check=stop_check))[0]
        if length > 32 * 1024 * 1024:
            raise ConnectionError("Frame too large")
        mask = recv_exact(sock, 4, stop_check=stop_check) if is_masked else None
        payload = recv_exact(sock, length, stop_check=stop_check) if length > 0 else b""
        if mask is not None and payload:
            payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        if opcode in (0x8, 0x9, 0xA):
            return opcode, payload
        if opcode != 0x0:
            if fin:
                return opcode, payload
            frag_opcode = opcode
            frag_chunks = [payload]
        else:
            frag_chunks.append(payload)
            if fin:
                return (frag_opcode or 0x1), b"".join(frag_chunks)


# ---------------------------------------------------------------------------
# Embedded LAN Mesh Hub (TCP 45891: RFC-6455 WebSocket + HTTP /continuum-info)
# ---------------------------------------------------------------------------

class EmbeddedLanHub:
    def __init__(self, port=LAN_WS_PORT, get_room_fn=None, on_remote_peer_joined=None):
        self.port = port
        self.get_room_fn = get_room_fn or (lambda: DEFAULT_ROOM_CODE)
        self.on_remote_peer_joined = on_remote_peer_joined
        self.running = False
        self.active = False
        self.started_at = int(time.time() * 1000)
        self.hub_id = DEVICE_ID
        self.server_sock = None
        self.lock = threading.Lock()
        self.clients = {}
        self.rooms = {}

    def start(self):
        if self.running:
            return self.active
        self.running = True
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("0.0.0.0", self.port))
            s.listen(32)
            s.settimeout(1.0)
            self.server_sock = s
            self.active = True
            threading.Thread(target=self._accept_loop, daemon=True).start()
            log_msg(f"Embedded LAN Hub ativo em 0.0.0.0:{self.port}")
            return True
        except OSError as exc:
            log_msg(f"Porta {self.port} ja em uso: {exc}")
            self.active = False
            return False

    def stop(self):
        self.running = False
        self.active = False
        try:
            if self.server_sock:
                self.server_sock.close()
        except Exception:
            pass
        with self.lock:
            for s in list(self.clients.keys()):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except Exception:
                    pass
                try:
                    s.close()
                except Exception:
                    pass
            self.clients.clear()

    def peer_count(self, room_code):
        with self.lock:
            rm = self.rooms.get(room_code)
            return len(rm["devices"]) if rm else 0

    def remote_peer_count(self):
        with self.lock:
            return sum(1 for m in self.clients.values() if m.get("id") and m.get("id") != self.hub_id)

    def _get_room(self, code):
        if code not in self.rooms:
            self.rooms[code] = {"devices": {}, "clipboard": [], "notifications": []}
        return self.rooms[code]

    def _accept_loop(self):
        while self.running:
            try:
                conn, addr = self.server_sock.accept()
                try:
                    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                    conn.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
                except Exception:
                    pass
                conn.settimeout(15.0)
                threading.Thread(target=self._handle_client, args=(conn, addr), daemon=True).start()
            except socket.timeout:
                continue
            except Exception:
                if self.running:
                    time.sleep(0.2)

    def _send_json(self, conn, payload):
        with self.lock:
            meta = self.clients.get(conn)
        if not meta:
            return
        try:
            frame = ws_encode_frame(json.dumps(payload).encode("utf-8"), opcode=0x1, masked=False)
            with meta["send_lock"]:
                conn.sendall(frame)
        except Exception:
            pass

    def _broadcast_room(self, room_code, payload, exclude=None):
        with self.lock:
            targets = [s for s, m in self.clients.items() if m.get("room") == room_code and s is not exclude]
        frame = ws_encode_frame(json.dumps(payload).encode("utf-8"), opcode=0x1, masked=False)
        for s in targets:
            with self.lock:
                meta = self.clients.get(s)
            if not meta:
                continue
            try:
                with meta["send_lock"]:
                    s.sendall(frame)
            except Exception:
                pass

    def _send_to_device(self, room_code, target_id, payload, exclude=None):
        with self.lock:
            targets = [
                s for s, m in self.clients.items()
                if m.get("room") == room_code and m.get("id") == target_id and s is not exclude
            ]
        if not targets:
            self._broadcast_room(room_code, payload, exclude=exclude)
            return
        frame = ws_encode_frame(json.dumps(payload).encode("utf-8"), opcode=0x1, masked=False)
        for s in targets:
            with self.lock:
                meta = self.clients.get(s)
            if not meta:
                continue
            try:
                with meta["send_lock"]:
                    s.sendall(frame)
            except Exception:
                pass

    def _handle_client(self, conn, addr):
        try:
            req = b""
            while b"\r\n\r\n" not in req and len(req) < 8192:
                chunk = conn.recv(4096)
                if not chunk:
                    conn.close()
                    return
                req += chunk
            headers = {}
            for line in req.decode("utf-8", errors="ignore").split("\r\n")[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            ws_key = headers.get("sec-websocket-key")
            if not ws_key:
                room = self.get_room_fn()
                body = json.dumps({
                    "ok": True,
                    "proto": PROTO_V5,
                    "hubId": self.hub_id,
                    "hubName": HOSTNAME,
                    "hub": HOSTNAME,
                    "os": "linux",
                    "roomCode": room,
                    "wsPort": self.port,
                    "ip": get_local_lan_ip(),
                    "startedAt": self.started_at,
                    "peers": self.peer_count(room),
                    "remotePeers": self.remote_peer_count(),
                    "version": APP_VERSION,
                }).encode("utf-8")
                conn.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: "
                    + str(len(body)).encode("ascii") + b"\r\nConnection: close\r\n\r\n" + body
                )
                conn.close()
                return

            accept = base64.b64encode(hashlib.sha1((ws_key + WS_GUID).encode("ascii")).digest()).decode("ascii")
            handshake = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            )
            conn.sendall(handshake.encode("ascii"))
            conn.settimeout(1.0)

            with self.lock:
                self.clients[conn] = {"id": None, "room": None, "addr": addr[0], "send_lock": threading.Lock()}

            while self.running:
                opcode, payload = ws_read_message(conn, stop_check=lambda: not self.running)
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    with self.lock:
                        meta = self.clients.get(conn)
                    if meta:
                        with meta["send_lock"]:
                            conn.sendall(ws_encode_frame(payload, opcode=0xA, masked=False))
                    continue
                if opcode != 0x1:
                    continue
                try:
                    msg = json.loads(payload.decode("utf-8", errors="replace"))
                except Exception:
                    continue
                self._process_message(conn, msg)
        except Exception:
            pass
        finally:
            self._disconnect_client(conn)

    def _disconnect_client(self, conn):
        room_code = None
        dev_id = None
        with self.lock:
            meta = self.clients.pop(conn, None)
            if meta:
                room_code = meta.get("room")
                dev_id = meta.get("id")
                if room_code and dev_id and room_code in self.rooms:
                    self.rooms[room_code]["devices"].pop(dev_id, None)
                    devs = list(self.rooms[room_code]["devices"].values())
                else:
                    devs = None
            else:
                devs = None
        try:
            conn.close()
        except Exception:
            pass
        if room_code and dev_id:
            self._broadcast_room(room_code, {"type": "device:left", "deviceId": dev_id})
            if devs is not None:
                self._broadcast_room(room_code, {"type": "mesh:devices_sync", "devices": devs})

    def _process_message(self, conn, msg):
        mtype = msg.get("type")
        with self.lock:
            meta = self.clients.get(conn)
        if not meta:
            return

        if mtype == "mesh:join":
            # Canonical Hub Room Unification: every peer joining this LAN Hub enters the Hub's active room
            # so two devices on the same LAN Hub can NEVER be stranded in separate rooms.
            room_code = "".join(c for c in str(self.get_room_fn() or DEFAULT_ROOM_CODE).upper() if c.isalnum())[:12] or "MESH01"
            dev = msg.get("device") or {}
            dev_id = str(dev.get("id") or f"peer-{int(time.time()*1000)}")
            with self.lock:
                rm = self._get_room(room_code)
                idx = len(rm["devices"])
                default_x = 180 + (idx % 3) * 230
                default_y = 140 + (idx // 3) * 165
                existing = rm["devices"].get(dev_id, {})
                dev_record = {
                    "id": dev_id,
                    "name": str(dev.get("name") or "Dispositivo"),
                    "os": str(dev.get("os") or "linux"),
                    "kind": str(dev.get("kind") or "desktop"),
                    "status": "online",
                    "x": float(dev.get("x", existing.get("x", default_x))),
                    "y": float(dev.get("y", existing.get("y", default_y))),
                    "screenWidth": int(dev.get("screenWidth") or 1920),
                    "screenHeight": int(dev.get("screenHeight") or 1080),
                    "companionConnected": bool(dev.get("companionConnected", True)),
                    "telemetry": dev.get("telemetry") or {},
                    "lanIp": meta.get("addr", ""),
                    "lastSeenAt": int(time.time() * 1000),
                }
                rm["devices"][dev_id] = dev_record
                meta["id"] = dev_id
                meta["room"] = room_code
                snapshot_devs = list(rm["devices"].values())
                snapshot_clip = list(rm["clipboard"][:40])
                snapshot_notifs = list(rm["notifications"][:40])

            self._send_json(conn, {
                "type": "mesh:init",
                "roomCode": room_code,
                "hubName": HOSTNAME,
                "hubIp": get_local_lan_ip(),
                "devices": snapshot_devs,
                "clipboard": snapshot_clip,
                "notifications": snapshot_notifs,
            })
            self._broadcast_room(room_code, {"type": "device:joined", "device": dev_record}, exclude=conn)
            self._broadcast_room(room_code, {"type": "mesh:devices_sync", "devices": snapshot_devs})
            if dev_id != self.hub_id and self.on_remote_peer_joined:
                threading.Thread(
                    target=self.on_remote_peer_joined,
                    args=(room_code, dict(dev_record)),
                    daemon=True,
                ).start()
            return

        room_code = meta.get("room")
        dev_id = meta.get("id")
        if not room_code:
            return

        if mtype == "telemetry:ping":
            self._send_json(conn, {"type": "telemetry:pong", "sentAt": msg.get("sentAt"), "serverTime": int(time.time() * 1000)})
        elif mtype == "device:telemetry":
            with self.lock:
                rm = self._get_room(room_code)
                if dev_id in rm["devices"]:
                    rm["devices"][dev_id]["telemetry"] = msg.get("telemetry") or {}
                    rm["devices"][dev_id]["lastSeenAt"] = int(time.time() * 1000)
                    updated = dict(rm["devices"][dev_id])
                else:
                    updated = None
            if updated:
                self._broadcast_room(room_code, {"type": "device:updated", "device": updated})
        elif mtype == "device:move":
            target_id = str(msg.get("deviceId") or dev_id)
            nx = float(msg.get("x", 180))
            ny = float(msg.get("y", 140))
            with self.lock:
                rm = self._get_room(room_code)
                if target_id in rm["devices"]:
                    rm["devices"][target_id]["x"] = nx
                    rm["devices"][target_id]["y"] = ny
                    updated = dict(rm["devices"][target_id])
                else:
                    updated = None
            if updated:
                self._broadcast_room(room_code, {"type": "device:updated", "device": updated})
        elif mtype in ("input:event", "file:start", "file:chunk", "file:complete", "screen:start", "screen:frame", "screen:stop", "screen:request"):
            target_id = msg.get("targetDeviceId")
            if target_id:
                self._send_to_device(room_code, target_id, msg, exclude=conn)
            else:
                self._broadcast_room(room_code, msg, exclude=conn)
        elif mtype == "clipboard:push":
            content = str(msg.get("content") or "")[:32000]
            if not content:
                return
            item = {
                "id": f"clip-{int(time.time() * 1000)}",
                "content": content,
                "sourceDeviceId": msg.get("sourceDeviceId") or dev_id,
                "sourceDeviceName": msg.get("sourceDeviceName") or "Dispositivo",
                "createdAt": int(time.time() * 1000),
            }
            with self.lock:
                rm = self._get_room(room_code)
                rm["clipboard"].insert(0, item)
                rm["clipboard"] = rm["clipboard"][:40]
            self._broadcast_room(room_code, {"type": "clipboard:added", "item": item})
        elif mtype == "notification:push":
            notif = {
                "id": f"notif-{int(time.time() * 1000)}",
                "title": str(msg.get("title") or "Alerta"),
                "body": str(msg.get("body") or ""),
                "appName": str(msg.get("appName") or "Continuum"),
                "severity": str(msg.get("severity") or "info"),
                "sourceDeviceId": msg.get("sourceDeviceId") or dev_id,
                "sourceDeviceName": msg.get("sourceDeviceName") or "Dispositivo",
                "createdAt": int(time.time() * 1000),
            }
            with self.lock:
                rm = self._get_room(room_code)
                rm["notifications"].insert(0, notif)
                rm["notifications"] = rm["notifications"][:40]
            self._broadcast_room(room_code, {"type": "notification:added", "notification": notif})


# ---------------------------------------------------------------------------
# 3-Layer Hybrid LAN Discovery (UDP + Multicast + Unicast Reply + Parallel /24 TCP Scan)
# ---------------------------------------------------------------------------

class LanDiscoveryService:
    def __init__(self, hub, get_room_fn, on_peers_changed=None, on_scan_state=None):
        self.hub = hub
        self.get_room_fn = get_room_fn
        self.on_peers_changed = on_peers_changed
        self.on_scan_state = on_scan_state
        self.running = False
        self.scanning = False
        self.lock = threading.Lock()
        self.discovered = {}

    def start(self):
        if self.running:
            return
        self.running = True
        threading.Thread(target=self._listen_loop, daemon=True).start()
        threading.Thread(target=self._broadcast_loop, daemon=True).start()

    def stop(self):
        self.running = False

    def list_peers(self):
        now = time.time()
        with self.lock:
            stale = [k for k, v in self.discovered.items() if now - v.get("lastSeen", 0) > 28.0]
            for k in stale:
                self.discovered.pop(k, None)
            return sorted(list(self.discovered.values()), key=lambda p: p.get("hubName", ""))

    def scan_subnet_tcp(self):
        if self.scanning:
            return
        my_ip = get_local_lan_ip()
        parts = my_ip.split(".")
        if len(parts) != 4 or my_ip.startswith("127."):
            return
        prefix = f"{parts[0]}.{parts[1]}.{parts[2]}"
        self.scanning = True
        if self.on_scan_state:
            self.on_scan_state(True, 0)

        def _worker():
            try:
                ips = [f"{prefix}.{i}" for i in range(1, 255) if f"{prefix}.{i}" != my_ip]
                done = 0
                with concurrent.futures.ThreadPoolExecutor(max_workers=32) as ex:
                    fut_map = {ex.submit(probe_http_info, ip, LAN_WS_PORT, 0.25): ip for ip in ips}
                    for fut in concurrent.futures.as_completed(fut_map):
                        ip = fut_map[fut]
                        done += 1
                        try:
                            info = fut.result()
                            if info and info.get("hubId") != self.hub.hub_id:
                                entry = {
                                    "hubId": str(info.get("hubId") or f"lan-{ip}"),
                                    "hubName": str(info.get("hubName") or info.get("hub") or ip),
                                    "os": str(info.get("os") or "desktop"),
                                    "ip": ip,
                                    "wsPort": int(info.get("wsPort") or LAN_WS_PORT),
                                    "roomCode": str(info.get("roomCode") or self.get_room_fn()),
                                    "startedAt": int(info.get("startedAt") or 0),
                                    "peers": int(info.get("peers") or 1),
                                    "remotePeers": int(info.get("remotePeers") or 0),
                                    "needsReverseConnect": bool(info.get("needsReverseConnect", False)),
                                    "via": "TCP Radar",
                                    "lastSeen": time.time(),
                                }
                                with self.lock:
                                    self.discovered[entry["hubId"]] = entry
                                if self.on_peers_changed:
                                    self.on_peers_changed()
                        except Exception:
                            pass
                        if done % 24 == 0 or done == len(ips):
                            if self.on_scan_state:
                                self.on_scan_state(True, int((done / len(ips)) * 100))
            finally:
                self.scanning = False
                if self.on_scan_state:
                    self.on_scan_state(False, 100)

        threading.Thread(target=_worker, daemon=True).start()

    def _make_beacon(self, btype="beacon"):
        room = self.get_room_fn()
        return json.dumps({
            "proto": PROTO_V5,
            "type": btype,
            "roomCode": room,
            "hubId": self.hub.hub_id,
            "hubName": HOSTNAME,
            "os": "linux",
            "ip": get_local_lan_ip(),
            "wsPort": self.hub.port,
            "startedAt": self.hub.started_at,
            "peers": self.hub.peer_count(room),
            "remotePeers": self.hub.remote_peer_count(),
        }).encode("utf-8")

    def _broadcast_loop(self):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        except Exception:
            return
        while self.running:
            try:
                if self.hub.active:
                    payload = self._make_beacon("beacon")
                    sock.sendto(payload, ("255.255.255.255", LAN_UDP_PORT))
                    sb = get_subnet_broadcast(get_local_lan_ip())
                    if sb:
                        sock.sendto(payload, (sb, LAN_UDP_PORT))
                    sock.sendto(payload, (MULTICAST_ADDR, LAN_UDP_PORT))
            except Exception:
                pass
            time.sleep(2.2)
        try:
            sock.close()
        except Exception:
            pass

    def _listen_loop(self):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if hasattr(socket, "SO_REUSEPORT"):
                try:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
                except Exception:
                    pass
            sock.bind(("", LAN_UDP_PORT))
            try:
                mreq = struct.pack("4s4s", socket.inet_aton(MULTICAST_ADDR), socket.inet_aton("0.0.0.0"))
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            except Exception:
                pass
            sock.settimeout(1.0)
        except Exception as exc:
            log_msg(f"UDP listen error: {exc}")
            return

        while self.running:
            try:
                data, addr = sock.recvfrom(4096)
                info = json.loads(data.decode("utf-8", errors="ignore"))
                if info.get("proto") not in (PROTO_V5, PROTO_V4, PROTO_V3):
                    continue
                hub_id = str(info.get("hubId") or "")
                if not hub_id or hub_id == self.hub.hub_id:
                    continue
                if info.get("type") == "probe" and self.hub.active:
                    try:
                        sock.sendto(self._make_beacon("beacon"), addr)
                    except Exception:
                        pass
                peer_ip = addr[0] if addr[0] and not addr[0].startswith("127.") else str(info.get("ip") or addr[0])
                entry = {
                    "hubId": hub_id,
                    "hubName": str(info.get("hubName") or "Peer"),
                    "os": str(info.get("os") or "desktop"),
                    "ip": peer_ip,
                    "wsPort": int(info.get("wsPort") or LAN_WS_PORT),
                    "roomCode": str(info.get("roomCode") or DEFAULT_ROOM_CODE),
                    "startedAt": int(info.get("startedAt") or 0),
                    "peers": int(info.get("peers") or 1),
                    "remotePeers": int(info.get("remotePeers") or 0),
                    "needsReverseConnect": bool(info.get("needsReverseConnect", False)),
                    "via": "UDP Auto",
                    "lastSeen": time.time(),
                }
                with self.lock:
                    self.discovered[hub_id] = entry
                if self.on_peers_changed:
                    self.on_peers_changed()
            except socket.timeout:
                continue
            except Exception:
                continue
        try:
            sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Pure Python RFC-6455 WebSocket Client (Fragmented Frames + TCP_NODELAY)
# ---------------------------------------------------------------------------

class SimpleWebSocket:
    def __init__(self, url):
        self.url = url
        self.sock = None
        self._lock = threading.Lock()
        self.closed = False

    def connect(self, timeout=5.0):
        parsed = urllib.parse.urlparse(self.url)
        use_ssl = parsed.scheme == "wss"
        host = parsed.hostname
        port = parsed.port or (443 if use_ssl else 80)
        path = parsed.path or "/ws"
        if parsed.query:
            path += "?" + parsed.query
        raw = socket.create_connection((host, port), timeout=timeout)
        try:
            raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            raw.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        except Exception:
            pass
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if use_ssl else raw
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = f"{host}:{port}" if parsed.port else host
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"User-Agent: Continuum-Linux-Native/{APP_VERSION}\r\n\r\n"
        )
        self.sock.sendall(req.encode("utf-8"))
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("Handshake closed")
            resp += chunk
        status = resp.split(b"\r\n", 1)[0].decode("utf-8", errors="ignore")
        if "101" not in status:
            raise ConnectionError(f"WebSocket handshake failed: {status}")
        self.sock.settimeout(1.0)

    def send_json(self, obj):
        sock = self.sock
        if self.closed or sock is None:
            return
        frame = ws_encode_frame(json.dumps(obj).encode("utf-8"), opcode=0x1, masked=True)
        with self._lock:
            sock.sendall(frame)

    def recv_json(self):
        while not self.closed:
            sock = self.sock
            if sock is None:
                return None
            opcode, payload = ws_read_message(sock, stop_check=lambda: self.closed)
            if opcode == 0x8:
                self.close()
                return None
            if opcode == 0x9:
                with self._lock:
                    sock.sendall(ws_encode_frame(payload, opcode=0xA, masked=True))
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x1:
                return json.loads(payload.decode("utf-8", errors="replace"))
        return None

    def close(self):
        self.closed = True
        sock = self.sock
        self.sock = None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Stable Zero-Loop Mesh Client
# ---------------------------------------------------------------------------

class ContinuumMeshClient:
    def __init__(self, cfg, event_queue, start_hub=True):
        self.cfg = cfg
        self.events = event_queue
        self.running = True
        self.ws = None
        self.connected = False
        self.connected_url = ""
        self.connected_hub_label = "Hub Local LAN"
        self.rtt_ms = None
        self.devices = []
        self.clipboard = []
        self.notifications = []
        self.incoming_files = {}
        self._reconnect_flag = threading.Event()
        self._consecutive_fails = 0
        self._auto_switch_lock = threading.Lock()
        self._probing_auto = False

        self.hub = EmbeddedLanHub(
            port=int(cfg.get("wsPort") or LAN_WS_PORT),
            get_room_fn=lambda: self.cfg.get("roomCode", DEFAULT_ROOM_CODE),
            on_remote_peer_joined=self._on_remote_peer_joined,
        )
        if start_hub:
            self.hub.start()

        self.discovery = LanDiscoveryService(
            hub=self.hub,
            get_room_fn=lambda: self.cfg.get("roomCode", DEFAULT_ROOM_CODE),
            on_peers_changed=self._on_lan_peers_changed,
            on_scan_state=lambda scanning, pct: self._emit("scan", {"scanning": scanning, "pct": pct}),
        )
        self.discovery.start()

    def _emit(self, etype, data=None):
        self.events.put((etype, data))

    def _on_remote_peer_joined(self, room_code, dev_rec):
        peer_name = dev_rec.get("name", "Dispositivo")
        local_url = f"ws://127.0.0.1:{self.hub.port}/ws"
        if self.connected_url != local_url:
            log_msg(f"Peer remoto '{peer_name}' entrou no Hub Local! Retornando cliente para {local_url}.")
            self.cfg["manualPeer"] = ""
            self._forced_auto_target = None
            save_config(self.cfg)
            self._emit("toast", f"{peer_name} conectou ao seu Hub Local! Sincronizando mapa...")
            self.reconnect()
        else:
            self._emit("toast", f"{peer_name} entrou na malha!")

    def _on_lan_peers_changed(self):
        peers = self.discovery.list_peers()
        self._emit("lan_peers", peers)
        # ZERO-LOOP & NO-CROSSOVER RULE:
        # 1) Never auto-switch if we already have a connected peer in our mesh or on our local Hub.
        if not self.cfg.get("autoLan", True) or self.cfg.get("manualPeer"):
            return
        if self.hub.remote_peer_count() > 0 or len(self.devices) > 1:
            return
        if self._probing_auto:
            return

        # 2) Deterministic Hub Election (Desktop always hosts for Android unless Android reports firewall block!)
        candidates = []
        for p in peers:
            pid = p.get("hubId", "")
            if not pid or pid == self.hub.hub_id:
                continue
            pos = str(p.get("os", "desktop")).lower()
            if pos == "android":
                # Only connect outbound to Android if Android couldn't reach our port (needsReverseConnect) or already hosts peers!
                if p.get("needsReverseConnect") or int(p.get("remotePeers", 0)) > 0:
                    candidates.append(p)
            else:
                # Between two desktops: join only if peer already hosts remote peers OR has strictly lower hubId
                if int(p.get("remotePeers", 0)) > 0 or pid < self.hub.hub_id:
                    candidates.append(p)
        if not candidates:
            return

        room = self.cfg.get("roomCode", DEFAULT_ROOM_CODE)
        candidates.sort(key=lambda c: (
            0 if int(c.get("remotePeers", 0)) > 0 else 1,
            0 if c.get("os") != "android" else 1,
            0 if c.get("roomCode") == room else 1,
            str(c.get("hubId", "")),
        ))
        best = candidates[0]
        desired = f"ws://{best['ip']}:{best['wsPort']}/ws"
        if desired == self.connected_url:
            return

        def _probe_and_join():
            with self._auto_switch_lock:
                if self._probing_auto:
                    return
                self._probing_auto = True
            try:
                info = probe_http_info(best["ip"], best["wsPort"], timeout=0.7)
                if not info:
                    return
                if self.hub.remote_peer_count() > 0 or len(self.devices) > 1:
                    return
                r_room = str(info.get("roomCode") or "")
                if r_room and r_room != self.cfg.get("roomCode"):
                    self.cfg["roomCode"] = r_room
                    self._emit("room_synced", r_room)
                self._forced_auto_target = (desired, f"{best['hubName']} ({best['ip']})")
                self._emit("toast", f"Conectando automaticamente a {best['hubName']} ({best['ip']})...")
                self.reconnect()
            finally:
                self._probing_auto = False

        threading.Thread(target=_probe_and_join, daemon=True).start()

    def start(self):
        self._forced_auto_target = None
        threading.Thread(target=self._run_loop, daemon=True).start()
        threading.Thread(target=self._telemetry_loop, daemon=True).start()
        self.discovery.scan_subnet_tcp()

    def stop(self):
        self.running = False
        self._reconnect_flag.set()
        if self.ws:
            self.ws.close()
        self.discovery.stop()
        self.hub.stop()

    def reconnect(self):
        self._reconnect_flag.set()
        if self.ws:
            self.ws.close()

    def connect_to_peer(self, host_port_str, room_code=None):
        """User explicitly clicked Connect on a peer: show immediate feedback, probe, sync room, and switch immediately."""
        hp = parse_host_port(host_port_str)
        if not hp:
            self._emit("toast", "Endereco IP invalido. Use ex: 192.168.1.42 ou .42")
            return
        host, port = hp
        self._emit("toast", f"Conectando a {host}:{port}...")

        def _probe():
            info = probe_http_info(host, port, timeout=1.8)
            if info:
                r_name = str(info.get("hubName") or info.get("hub") or host)
                r_room = str(info.get("roomCode") or room_code or self.cfg.get("roomCode", DEFAULT_ROOM_CODE))
                self.cfg["roomCode"] = r_room
                self.cfg["manualPeer"] = f"{host}:{port}"
                self.cfg["autoLan"] = False
                self._forced_auto_target = None
                save_config(self.cfg)
                self._emit("room_synced", r_room)
                self._emit("toast", f"Conectado ao Hub de {r_name} ({host}:{port})!")
                self.reconnect()
            else:
                self._emit("toast", f"Sem resposta em {host}:{port}. Verifique se o app esta aberto na mesma rede Wi-Fi.")

        threading.Thread(target=_probe, daemon=True).start()

    def set_connection_mode(self, room_code, manual_peer="", auto_lan=True):
        clean_room = "".join(c for c in (room_code or "").upper() if c.isalnum())[:12] or DEFAULT_ROOM_CODE
        self.cfg["roomCode"] = clean_room
        self.cfg["manualPeer"] = (manual_peer or "").strip()
        self.cfg["autoLan"] = bool(auto_lan)
        self._forced_auto_target = None
        save_config(self.cfg)
        self._emit("toast", "Modo de conexao atualizado — reconectando...")
        self.reconnect()

    def _resolve_target_ws(self):
        manual = (self.cfg.get("manualPeer") or "").strip()
        if manual:
            url = normalize_ws_endpoint(manual)
            if url:
                return url, f"Peer LAN ({manual})"
        if getattr(self, "_forced_auto_target", None):
            return self._forced_auto_target
        port = int(self.cfg.get("wsPort") or LAN_WS_PORT)
        return f"ws://127.0.0.1:{port}/ws", f"Hub Local ({get_local_lan_ip()}:{port})"

    def send(self, payload):
        try:
            if self.ws and self.connected:
                self.ws.send_json(payload)
                return True
        except Exception:
            pass
        return False

    def send_file(self, file_path, target_id=None):
        def _worker():
            try:
                size = os.path.getsize(file_path)
                name = os.path.basename(file_path)
                transfer_id = f"ft-{int(time.time() * 1000)}"
                chunk_size = 48 * 1024
                total_chunks = max(1, (size + chunk_size - 1) // chunk_size)
                self.send({
                    "type": "file:start",
                    "transferId": transfer_id,
                    "fileName": name,
                    "fileSize": size,
                    "totalChunks": total_chunks,
                    "sourceDeviceId": DEVICE_ID,
                    "sourceDeviceName": f"{HOSTNAME} (Linux)",
                    "targetDeviceId": target_id,
                })
                with open(file_path, "rb") as fh:
                    for idx in range(total_chunks):
                        chunk = fh.read(chunk_size)
                        self.send({
                            "type": "file:chunk",
                            "transferId": transfer_id,
                            "chunkIndex": idx,
                            "data": base64.b64encode(chunk).decode("ascii"),
                            "targetDeviceId": target_id,
                        })
                        pct = int(((idx + 1) / total_chunks) * 100)
                        self._emit("file_progress", {"name": name, "pct": pct, "dir": "send"})
                        time.sleep(0.004)
                self.send({"type": "file:complete", "transferId": transfer_id, "targetDeviceId": target_id})
                self._emit("file_done", {"name": name, "size": size, "dir": "send", "path": file_path})
            except Exception as exc:
                self._emit("toast", f"Falha ao enviar arquivo: {exc}")
        threading.Thread(target=_worker, daemon=True).start()

    def _run_loop(self):
        time.sleep(0.3)
        while self.running:
            self._reconnect_flag.clear()
            ws_url, hub_label = self._resolve_target_ws()
            self.connected_url = ws_url
            self.connected_hub_label = hub_label
            self._emit("status", {"state": "connecting", "hub": hub_label, "url": ws_url})
            try:
                ws = SimpleWebSocket(ws_url)
                ws.connect(timeout=5.0)
                self.ws = ws
                self.connected = True
                self._consecutive_fails = 0
                self._emit("status", {"state": "connected", "hub": hub_label, "url": ws_url})

                room = self.cfg.get("roomCode", DEFAULT_ROOM_CODE)
                ws.send_json({
                    "type": "mesh:join",
                    "roomCode": room,
                    "device": {
                        "id": DEVICE_ID,
                        "name": f"{HOSTNAME} (Linux)",
                        "os": "linux",
                        "kind": "desktop",
                        "status": "online",
                        "screenWidth": _active_mon_geom["w"],
                        "screenHeight": _active_mon_geom["h"],
                        "companionConnected": True,
                        "telemetry": collect_telemetry(),
                    },
                })
                ws.send_json({"type": "telemetry:ping", "sentAt": int(time.time() * 1000)})

                while self.running and not self._reconnect_flag.is_set():
                    msg = ws.recv_json()
                    if msg is None:
                        break
                    self._handle_message(msg)
            except Exception as exc:
                log_msg(f"Conexao LAN encerrada ({ws_url}): {exc}")
                self._consecutive_fails += 1
                if not ws_url.startswith("ws://127.0.0.1") and self._consecutive_fails >= 2:
                    self.cfg["manualPeer"] = ""
                    self._forced_auto_target = None
                    self._consecutive_fails = 0
                    self._emit("toast", "Peer desconectou — retornando ao Hub Local.")
            finally:
                self.connected = False
                if self.ws:
                    self.ws.close()
                    self.ws = None
                self._emit("status", {"state": "reconnecting", "hub": hub_label, "url": ws_url})
            if self.running and not self._reconnect_flag.is_set():
                time.sleep(2.2)

    def _telemetry_loop(self):
        while self.running:
            time.sleep(2.5)
            if self.connected:
                self.send({"type": "device:telemetry", "telemetry": collect_telemetry()})
                self.send({"type": "telemetry:ping", "sentAt": int(time.time() * 1000)})
            self._emit("lan_peers", self.discovery.list_peers())

    def _handle_message(self, msg):
        mtype = msg.get("type")
        if mtype == "mesh:init":
            init_room = str(msg.get("roomCode") or "").strip()
            if init_room and init_room != self.cfg.get("roomCode"):
                self.cfg["roomCode"] = init_room
                self._emit("room_synced", init_room)
            self.devices = msg.get("devices", [])
            self.clipboard = msg.get("clipboard", [])
            self.notifications = msg.get("notifications", [])
            self._emit("devices", list(self.devices))
            self._emit("clipboard", list(self.clipboard))
            self._emit("notifications", list(self.notifications))
        elif mtype == "mesh:devices_sync":
            self.devices = msg.get("devices", [])
            self._emit("devices", list(self.devices))
        elif mtype in ("device:joined", "device:updated"):
            dev = msg.get("device")
            if dev and dev.get("id"):
                found = False
                for i, d in enumerate(self.devices):
                    if d.get("id") == dev["id"]:
                        self.devices[i] = dev
                        found = True
                        break
                if not found:
                    self.devices.append(dev)
                self._emit("devices", list(self.devices))
        elif mtype == "device:left":
            did = msg.get("deviceId")
            self.devices = [d for d in self.devices if d.get("id") != did]
            self._emit("devices", list(self.devices))
        elif mtype == "telemetry:pong":
            sent = msg.get("sentAt")
            if sent:
                self.rtt_ms = max(1, int(time.time() * 1000) - int(sent))
                self._emit("rtt", self.rtt_ms)
        elif mtype == "clipboard:added":
            item = msg.get("item")
            if item:
                self.clipboard.insert(0, item)
                self.clipboard = self.clipboard[:40]
                self._emit("clipboard", list(self.clipboard))
                if item.get("sourceDeviceId") != DEVICE_ID:
                    self._emit("clipboard_remote_sync", item.get("content", ""))
        elif mtype == "notification:added":
            notif = msg.get("notification")
            if notif:
                self.notifications.insert(0, notif)
                self.notifications = self.notifications[:40]
                self._emit("notifications", list(self.notifications))
                if notif.get("sourceDeviceId") != DEVICE_ID and shutil.which("notify-send"):
                    run_cmd(["notify-send", notif.get("title", "Continuum"), notif.get("body", "")])
        elif mtype == "input:event":
            target = msg.get("targetDeviceId")
            if not target or target == DEVICE_ID:
                execute_os_input(msg.get("event") or {}, ui_notify=lambda t, b: self._emit("toast", f"{t}: {b}"))
        elif mtype in ("screen:start", "screen:frame", "screen:stop", "screen:request"):
            self._emit(mtype, msg)
        elif mtype == "file:start":
            tid = msg.get("transferId")
            if tid and msg.get("sourceDeviceId") != DEVICE_ID:
                self.incoming_files[tid] = {
                    "name": os.path.basename(str(msg.get("fileName") or "arquivo.bin")),
                    "size": int(msg.get("fileSize") or 0),
                    "total": max(1, int(msg.get("totalChunks") or 1)),
                    "chunks": {},
                }
                self._emit("file_progress", {"name": self.incoming_files[tid]["name"], "pct": 0, "dir": "recv"})
        elif mtype == "file:chunk":
            tid = msg.get("transferId")
            rec = self.incoming_files.get(tid)
            if rec:
                rec["chunks"][int(msg.get("chunkIndex", 0))] = msg.get("data", "")
                pct = int((len(rec["chunks"]) / rec["total"]) * 100)
                self._emit("file_progress", {"name": rec["name"], "pct": min(99, pct), "dir": "recv"})
        elif mtype == "file:complete":
            tid = msg.get("transferId")
            rec = self.incoming_files.pop(tid, None)
            if rec:
                try:
                    os.makedirs(DOWNLOADS_DIR, exist_ok=True)
                    out_path = os.path.join(DOWNLOADS_DIR, rec["name"])
                    with open(out_path, "wb") as fh:
                        for idx in range(rec["total"]):
                            b64 = rec["chunks"].get(idx)
                            if b64:
                                fh.write(base64.b64decode(b64))
                    self._emit("file_progress", {"name": rec["name"], "pct": 100, "dir": "recv"})
                    self._emit("file_done", {"name": rec["name"], "size": rec["size"], "dir": "recv", "path": out_path})
                    if shutil.which("notify-send"):
                        run_cmd(["notify-send", "Continuum — Arquivo Recebido", f"{rec['name']} salvo em Downloads/Continuum"])
                except Exception as exc:
                    self._emit("toast", f"Erro ao salvar arquivo: {exc}")


# ---------------------------------------------------------------------------
# Holographic 60 FPS Native GTK 3 + Cairo UI (v5.0.0 — Web-App Parity, Zero Cramping)
# ---------------------------------------------------------------------------

def cairo_rounded_rect(cr, x, y, w, h, r):
    r = min(r, w / 2.0, h / 2.0)
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


def cubic_pt(t, x0, y0, x1, y1, x2, y2, x3, y3):
    u = 1.0 - t
    x = (u ** 3) * x0 + 3 * (u ** 2) * t * x1 + 3 * u * (t ** 2) * x2 + (t ** 3) * x3
    y = (u ** 3) * y0 + 3 * (u ** 2) * t * y1 + 3 * u * (t ** 2) * y2 + (t ** 3) * y3
    return x, y


def run_gtk_app(cfg, start_hub=True):
    import gi
    gi.require_version("Gtk", "3.0")
    import cairo
    from gi.repository import Gtk, Gdk, GdkPixbuf, GLib

    css = b"""
    window, .root-bg { background-color: #060A13; color: #F1F5F9; font-family: "Plus Jakarta Sans", "Ubuntu", "Cantarell", sans-serif; }
    .sidebar { background-color: #0A101E; border-right: 1px solid #1C2F4E; }
    .topbar { background-color: #080E1B; border-bottom: 1px solid #1C2F4E; }
    .brand-title { font-size: 17px; font-weight: 800; color: #F8FAFC; }
    .brand-sub { font-size: 11px; color: #22D3EE; font-weight: 600; }
    .page-title { font-size: 15px; font-weight: 700; color: #F8FAFC; }
    .section-title { font-size: 15px; font-weight: 700; color: #F8FAFC; }
    .card { background-color: #10192B; border: 1px solid #1E314F; border-radius: 12px; }
    .card-subtle { background-color: #0B1324; border: 1px solid #192B47; border-radius: 10px; }
    .muted { color: #94A3B8; font-size: 12.5px; }
    .mono { font-family: "JetBrains Mono", "Ubuntu Mono", monospace; font-size: 12px; color: #22D3EE; }
    .status-ok { color: #10B981; font-weight: 700; font-size: 12.5px; }
    .status-warn { color: #F59E0B; font-weight: 700; font-size: 12.5px; }
    .nav-btn { background: transparent; color: #94A3B8; border: 1px solid transparent; border-radius: 10px; padding: 11px 14px; font-weight: 600; font-size: 13.5px; min-height: 22px; }
    .nav-btn:hover { background-color: #111C32; color: #F1F5F9; }
    .nav-btn-active { background-color: #13223D; color: #F8FAFC; border: 1px solid #22D3EE; border-radius: 10px; padding: 11px 14px; font-weight: 700; font-size: 13.5px; min-height: 22px; }
    button.btn-primary { background-image: linear-gradient(135deg, #0891B2, #3B82F6, #6366F1); background-color: #2563EB; color: #FFFFFF; border: 1px solid #38BDF8; border-radius: 9px; padding: 9px 18px; font-weight: 700; font-size: 13px; min-height: 20px; }
    button.btn-primary:hover { background-image: linear-gradient(135deg, #06B6D4, #2563EB, #4F46E5); }
    button.btn-danger { background-color: #991B1B; color: #FFFFFF; border: 1px solid #EF4444; border-radius: 9px; padding: 9px 18px; font-weight: 700; font-size: 13px; min-height: 20px; }
    button.btn-ghost { background-color: #0E172A; color: #E2E8F0; border: 1px solid #2A4369; border-radius: 9px; padding: 9px 16px; font-weight: 600; font-size: 13px; min-height: 20px; }
    button.btn-ghost:hover { background-color: #172542; border-color: #22D3EE; color: #FFFFFF; }
    entry, combobox button.combo { background-color: #070C17; color: #F1F5F9; border: 1px solid #263D61; border-radius: 9px; padding: 9px 12px; min-height: 20px; }
    entry:focus { border-color: #22D3EE; }
    progressbar trough { background-color: #0B1220; border-radius: 6px; min-height: 10px; border: 1px solid #1E314F; }
    progressbar progress { background-image: linear-gradient(90deg, #22D3EE, #3B82F6, #8B5CF6); border-radius: 6px; min-height: 10px; }
    .feedback-banner { background-color: #0D2036; border-bottom: 1px solid #22D3EE; padding: 8px 18px; }
    .feedback-text { color: #E0F2FE; font-weight: 600; font-size: 12.5px; }
    """
    try:
        provider = Gtk.CssProvider()
        provider.load_from_data(css)
        Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    except Exception as exc:
        log_msg(f"CSS load aviso: {exc}")

    events = queue.Queue()
    client = ContinuumMeshClient(cfg, events, start_hub=start_hub)

    win = Gtk.Window(title="Continuum")
    win.set_default_size(1220, 780)
    win.set_size_request(940, 620)
    win.set_position(Gtk.WindowPosition.CENTER)
    win.get_style_context().add_class("root-bg")

    state = {
        "devices": [],
        "selected_id": None,
        "drag_id": None,
        "drag_off": (0, 0),
        "scanning": False,
        "scan_pct": 0,
        "phase": 0.0,
        "last_frame": time.monotonic(),
        "track_last": None,
        "track_cursor": None,
        "track_moved": False,
        "track_trail": [],
        "track_ripples": [],
        "lan_peers": [],
        "streaming_out": False,
        "stream_target_id": None,
        "stream_mon_idx": 0,
        "stream_fps": 15,
        "stream_quality": 65,
        "stream_seq": 0,
        "rx_pixbuf": None,
        "auto_clip": bool(cfg.get("autoClipboard", True)),
        "last_clip_text": "",
        "kvm_capture_active": False,
        "kvm_edge_enabled": bool(cfg.get("kvmEdgeEnabled", False)),
        "kvm_edge_side": str(cfg.get("kvmEdgeSide", "right")),
        "kvm_edge_locked": False,
    }

    def get_target_device():
        devs = state["devices"]
        if state["selected_id"]:
            for d in devs:
                if d.get("id") == state["selected_id"] and d.get("id") != DEVICE_ID:
                    return d
        for d in devs:
            if d.get("id") != DEVICE_ID:
                return d
        return devs[0] if devs else None

    def send_remote(ev):
        tgt = get_target_device()
        if not tgt or tgt.get("id") == DEVICE_ID:
            return
        client.send({"type": "input:event", "targetDeviceId": tgt["id"], "event": ev})

    def get_monitors():
        mons = []
        try:
            disp = Gdk.Display.get_default()
            n = disp.get_n_monitors()
            for i in range(n):
                m = disp.get_monitor(i)
                g = m.get_geometry()
                name = m.get_model() or f"Monitor {i + 1}"
                mons.append({"idx": i, "label": f"Monitor {i + 1} — {name} ({g.width}×{g.height})", "x": g.x, "y": g.y, "w": g.width, "h": g.height})
        except Exception:
            pass
        if not mons:
            mons.append({"idx": 0, "label": "Tela Principal (1920×1080)", "x": 0, "y": 0, "w": 1920, "h": 1080})
        return mons

    monitors = get_monitors()
    if monitors:
        _active_mon_geom.update({"x": monitors[0]["x"], "y": monitors[0]["y"], "w": monitors[0]["w"], "h": monitors[0]["h"]})

    # ==================== ROOT SHELL (252px SIDEBAR + MAIN) ====================
    root = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
    win.add(root)

    sidebar = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    sidebar.set_size_request(252, -1)
    sidebar.get_style_context().add_class("sidebar")
    sidebar.set_margin_start(0)
    root.pack_start(sidebar, False, False, 0)

    brand_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
    brand_box.set_margin_top(18)
    brand_box.set_margin_bottom(14)
    brand_box.set_margin_start(20)
    brand_box.set_margin_end(20)
    lbl_brand = Gtk.Label(label="Continuum")
    lbl_brand.set_xalign(0)
    lbl_brand.get_style_context().add_class("brand-title")
    lbl_bsub = Gtk.Label(label=f"Malha Nativa v{APP_VERSION}")
    lbl_bsub.set_xalign(0)
    lbl_bsub.get_style_context().add_class("brand-sub")
    brand_box.pack_start(lbl_brand, False, False, 0)
    brand_box.pack_start(lbl_bsub, False, False, 0)
    sidebar.pack_start(brand_box, False, False, 0)
    sidebar.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)

    nav_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    nav_box.set_margin_top(12)
    nav_box.set_margin_start(14)
    nav_box.set_margin_end(14)
    sidebar.pack_start(nav_box, True, True, 0)

    nav_defs = [
        ("map", "Mapa Espacial"),
        ("screen", "Extensão de Tela"),
        ("remote", "Mouse & Teclado"),
        ("transfer", "Clipboard & Arquivos"),
        ("network", "Rede & Sistema"),
    ]
    nav_buttons = {}
    stack = Gtk.Stack()
    stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
    stack.set_transition_duration(150)

    lbl_top_title = Gtk.Label(label="Continuum  /  Mapa Espacial")
    lbl_top_title.set_xalign(0)
    lbl_top_title.get_style_context().add_class("page-title")

    def switch_page(key):
        stack.set_visible_child_name(key)
        for k, b in nav_buttons.items():
            sc = b.get_style_context()
            sc.remove_class("nav-btn-active")
            sc.remove_class("nav-btn")
            sc.add_class("nav-btn-active" if k == key else "nav-btn")
        for k, title in nav_defs:
            if k == key:
                lbl_top_title.set_text(f"Continuum  /  {title}")

    for key, title in nav_defs:
        b = Gtk.Button(label=title)
        b.set_alignment(0.0, 0.5)
        b.get_style_context().add_class("nav-btn")
        b.connect("clicked", lambda _w, k=key: switch_page(k))
        nav_box.pack_start(b, False, False, 0)
        nav_buttons[key] = b

    # Sidebar Connection Footer (Clean unboxed typography matching Web App)
    sidebar.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)
    foot = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    foot.set_margin_top(14)
    foot.set_margin_bottom(16)
    foot.set_margin_start(18)
    foot.set_margin_end(18)

    lbl_side_status = Gtk.Label(label="Iniciando Hub LAN...")
    lbl_side_status.set_xalign(0)
    lbl_side_status.set_line_wrap(True)
    lbl_side_status.get_style_context().add_class("status-warn")

    lbl_side_room = Gtk.Label(label=f"Malha: {cfg.get('roomCode', DEFAULT_ROOM_CODE)}")
    lbl_side_room.set_xalign(0)
    lbl_side_room.get_style_context().add_class("mono")

    lbl_side_ip = Gtk.Label(label=f"IP: {get_local_lan_ip()}:{LAN_WS_PORT}")
    lbl_side_ip.set_xalign(0)
    lbl_side_ip.get_style_context().add_class("muted")

    lbl_side_count = Gtk.Label(label="1 dispositivo online")
    lbl_side_count.set_xalign(0)
    lbl_side_count.get_style_context().add_class("muted")

    foot.pack_start(lbl_side_status, False, False, 0)
    foot.pack_start(lbl_side_room, False, False, 0)
    foot.pack_start(lbl_side_ip, False, False, 0)
    foot.pack_start(lbl_side_count, False, False, 0)
    sidebar.pack_end(foot, False, False, 0)

    # ==================== MAIN RIGHT COLUMN ====================
    main_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
    root.pack_start(main_col, True, True, 0)

    topbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=14)
    topbar.set_size_request(-1, 58)
    topbar.get_style_context().add_class("topbar")
    topbar.set_border_width(10)
    lbl_top_title.set_margin_start(10)
    topbar.pack_start(lbl_top_title, True, True, 0)

    lbl_top_rtt = Gtk.Label(label="LAN Direta")
    lbl_top_rtt.get_style_context().add_class("mono")
    topbar.pack_start(lbl_top_rtt, False, False, 0)

    btn_top_scan = Gtk.Button(label="Escanear Wi-Fi")
    btn_top_scan.get_style_context().add_class("btn-primary")
    btn_top_scan.connect("clicked", lambda _w: client.discovery.scan_subnet_tcp())
    topbar.pack_start(btn_top_scan, False, False, 4)

    main_col.pack_start(topbar, False, False, 0)

    banner_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    banner_box.get_style_context().add_class("feedback-banner")
    banner_box.set_no_show_all(True)
    lbl_banner = Gtk.Label(label="")
    lbl_banner.set_xalign(0)
    lbl_banner.set_line_wrap(True)
    lbl_banner.get_style_context().add_class("feedback-text")
    btn_banner_close = Gtk.Button(label="×")
    btn_banner_close.get_style_context().add_class("btn-ghost")
    btn_banner_close.connect("clicked", lambda _w: banner_box.hide())
    banner_box.pack_start(lbl_banner, True, True, 0)
    banner_box.pack_end(btn_banner_close, False, False, 0)
    main_col.pack_start(banner_box, False, False, 0)
    toast_gen = [0]

    def show_banner_toast(message):
        toast_gen[0] += 1
        my_gen = toast_gen[0]
        lbl_banner.set_text(str(message))
        lbl_banner.show()
        btn_banner_close.show()
        banner_box.show()
        def _auto_hide():
            if toast_gen[0] == my_gen:
                banner_box.hide()
            return False
        GLib.timeout_add(6500, _auto_hide)

    main_col.pack_start(stack, True, True, 0)

    def make_card(pad=18, spacing=12):
        b = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=spacing)
        b.get_style_context().add_class("card")
        b.set_border_width(pad)
        return b

    def make_scrolled_page():
        sc = Gtk.ScrolledWindow()
        sc.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        inner.set_margin_top(20)
        inner.set_margin_bottom(24)
        inner.set_margin_start(22)
        inner.set_margin_end(22)
        sc.add(inner)
        return sc, inner

    # ==================== VIEW 1: MAPA ESPACIAL HOLOGRÁFICO ====================
    map_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
    map_page.set_margin_top(18)
    map_page.set_margin_bottom(18)
    map_page.set_margin_start(20)
    map_page.set_margin_end(20)

    map_canvas = Gtk.DrawingArea()
    map_canvas.set_hexpand(True)
    map_canvas.set_vexpand(True)
    map_canvas.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK)
    map_frame = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    map_frame.get_style_context().add_class("card")
    map_frame.pack_start(map_canvas, True, True, 0)
    map_page.pack_start(map_frame, True, True, 0)

    NODE_W, NODE_H = 224, 118

    def draw_radial_gauge(cr, cx, cy, rad, pct, label, rgb):
        cr.set_line_width(3.4)
        cr.set_source_rgba(0.12, 0.20, 0.33, 0.72)
        cr.arc(cx, cy, rad, 0, 2 * math.pi)
        cr.stroke()
        sweep = (max(0, min(100, pct)) / 100.0) * 2 * math.pi
        if sweep > 0:
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.set_source_rgba(rgb[0], rgb[1], rgb[2], 0.96)
            cr.arc(cx, cy, rad, -math.pi / 2, -math.pi / 2 + sweep)
            cr.stroke()
        cr.select_font_face("Monospace", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(9.5)
        txt = f"{pct}%"
        ext = cr.text_extents(txt)
        cr.set_source_rgb(0.95, 0.97, 0.99)
        cr.move_to(cx - ext.width / 2, cy + ext.height / 2)
        cr.show_text(txt)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        cr.set_font_size(9.5)
        cr.set_source_rgb(0.58, 0.65, 0.76)
        cr.move_to(cx + rad + 8, cy + 3.5)
        cr.show_text(label)

    def on_map_draw(widget, cr):
        alloc = widget.get_allocation()
        w, h = max(1, alloc.width), max(1, alloc.height)
        cx, cy = w / 2.0, h / 2.0
        max_r = min(w, h) * 0.44

        bg_pat = cairo.RadialGradient(cx, cy, 10, cx, cy, max(w, h) * 0.75)
        bg_pat.add_color_stop_rgb(0, 0.055, 0.098, 0.18)
        bg_pat.add_color_stop_rgb(1, 0.024, 0.039, 0.075)
        cr.set_source(bg_pat)
        cr.rectangle(0, 0, w, h)
        cr.fill()

        cr.set_source_rgba(0.13, 0.83, 0.93, 0.16)
        cr.set_line_width(1.0)
        for gx in range(36, w, 40):
            for gy in range(36, h, 40):
                cr.move_to(gx - 2.5, gy); cr.line_to(gx + 2.5, gy)
                cr.move_to(gx, gy - 2.5); cr.line_to(gx, gy + 2.5)
        cr.stroke()

        phase = state["phase"]
        for i in range(1, 4):
            cr.set_source_rgba(0.13, 0.83, 0.93, 0.18 if state["scanning"] else 0.08)
            cr.set_line_width(1.1)
            cr.arc(cx, cy, max_r * (i / 3.0), 0, 2 * math.pi)
            cr.stroke()
        pulse_t = (phase * 0.45) % 1.0
        cr.set_source_rgba(0.13, 0.83, 0.93, (1.0 - pulse_t) * (0.45 if state["scanning"] else 0.22))
        cr.set_line_width(1.5)
        cr.arc(cx, cy, pulse_t * max_r, 0, 2 * math.pi)
        cr.stroke()

        if state["scanning"] or len(state["devices"]) <= 1:
            ang = (phase * 1.8) % (2 * math.pi)
            cr.new_path()
            cr.move_to(cx, cy)
            cr.arc(cx, cy, max_r, ang - 0.55, ang)
            cr.close_path()
            cr.set_source_rgba(0.13, 0.83, 0.93, 0.12)
            cr.fill()
            cr.set_source_rgba(0.13, 0.83, 0.93, 0.65)
            cr.set_line_width(1.5)
            cr.move_to(cx, cy)
            cr.line_to(cx + math.cos(ang) * max_r, cy + math.sin(ang) * max_r)
            cr.stroke()

        devs = state["devices"]
        if not devs:
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(13)
            cr.set_source_rgba(0.13, 0.83, 0.93, 0.9)
            msg = f"Radar escaneando Wi-Fi... {state['scan_pct']}%" if state["scanning"] else "Aguardando dispositivos na rede Wi-Fi..."
            ext = cr.text_extents(msg)
            cr.move_to(cx - ext.width / 2, cy + max_r * 0.52)
            cr.show_text(msg)
            return

        anchor = next((d for d in devs if d.get("id") == DEVICE_ID), devs[0])
        ax, ay = float(anchor.get("x", 220)), float(anchor.get("y", 180))
        for d in devs:
            if d.get("id") == anchor.get("id"):
                continue
            dx, dy = float(d.get("x", 480)), float(d.get("y", 180))
            is_sel = d.get("id") == state["selected_id"]
            mx = (ax + dx) / 2.0
            lp = cairo.LinearGradient(ax, ay, dx, dy)
            lp.add_color_stop_rgba(0, 0.13, 0.83, 0.93, 0.36 if is_sel else 0.18)
            lp.add_color_stop_rgba(1, 0.55, 0.36, 0.96, 0.36 if is_sel else 0.18)
            cr.set_source(lp)
            cr.set_line_width(6.5 if is_sel else 3.5)
            cr.move_to(ax, ay); cr.curve_to(mx, ay, mx, dy, dx, dy); cr.stroke()

            lp2 = cairo.LinearGradient(ax, ay, dx, dy)
            lp2.add_color_stop_rgba(0, 0.13, 0.83, 0.93, 0.92 if is_sel else 0.58)
            lp2.add_color_stop_rgba(1, 0.55, 0.36, 0.96, 0.92 if is_sel else 0.58)
            cr.set_source(lp2)
            cr.set_line_width(2.0 if is_sel else 1.3)
            cr.move_to(ax, ay); cr.curve_to(mx, ay, mx, dy, dx, dy); cr.stroke()

            for k in range(2):
                t = (phase * 0.55 + k * 0.5) % 1.0
                px, py = cubic_pt(t, ax, ay, mx, ay, mx, dy, dx, dy)
                cr.set_source_rgba(0.13, 0.83, 0.93, 0.35)
                cr.arc(px, py, 6.0, 0, 2 * math.pi); cr.fill()
                cr.set_source_rgba(1.0, 1.0, 1.0, 0.95)
                cr.arc(px, py, 2.2, 0, 2 * math.pi); cr.fill()

        for d in devs:
            nx, ny = float(d.get("x", 220)), float(d.get("y", 180))
            rx, ry = nx - NODE_W / 2, ny - NODE_H / 2
            is_self = d.get("id") == DEVICE_ID
            is_sel = d.get("id") == state["selected_id"]
            tel = d.get("telemetry") or {}
            cpu = int(tel.get("cpuUsage") or 0)
            ram = int(tel.get("memoryUsagePercent") or 0)
            bat = tel.get("batteryLevel")

            if is_sel or is_self:
                cairo_rounded_rect(cr, rx - 2, ry - 2, NODE_W + 4, NODE_H + 4, 14)
                cr.set_source_rgba(0.13, 0.83, 0.93, 0.24) if is_sel else cr.set_source_rgba(0.06, 0.72, 0.50, 0.20)
                cr.set_line_width(5.0); cr.stroke()

            cairo_rounded_rect(cr, rx, ry, NODE_W, NODE_H, 12)
            cp = cairo.LinearGradient(rx, ry, rx + NODE_W, ry + NODE_H)
            if is_sel:
                cp.add_color_stop_rgba(0, 0.085, 0.145, 0.255, 0.94)
                cp.add_color_stop_rgba(1, 0.045, 0.075, 0.145, 0.96)
            else:
                cp.add_color_stop_rgba(0, 0.060, 0.095, 0.175, 0.92)
                cp.add_color_stop_rgba(1, 0.038, 0.060, 0.115, 0.95)
            cr.set_source(cp); cr.fill_preserve()

            bp = cairo.LinearGradient(rx, ry, rx + NODE_W, ry + NODE_H)
            if is_sel:
                bp.add_color_stop_rgb(0, 0.13, 0.83, 0.93)
                bp.add_color_stop_rgb(1, 0.55, 0.36, 0.96)
            elif is_self:
                bp.add_color_stop_rgb(0, 0.06, 0.72, 0.50)
                bp.add_color_stop_rgb(1, 0.13, 0.83, 0.93)
            else:
                bp.add_color_stop_rgb(0, 0.18, 0.30, 0.46)
                bp.add_color_stop_rgb(1, 0.11, 0.18, 0.30)
            cr.set_source(bp)
            cr.set_line_width(2.0 if is_sel else 1.2)
            cr.stroke()

            os_name = str(d.get("os") or "peer").lower()
            cr.set_source_rgb(0.13, 0.83, 0.93) if is_sel else (cr.set_source_rgb(0.06, 0.72, 0.50) if is_self else cr.set_source_rgb(0.38, 0.65, 0.98))
            cr.set_line_width(1.6)
            if os_name in ("android", "ios"):
                cairo_rounded_rect(cr, rx + 14, ry + 14, 12, 19, 2.5); cr.stroke()
            else:
                cairo_rounded_rect(cr, rx + 12, ry + 14, 18, 13, 2.0); cr.stroke()
                cr.move_to(rx + 16, ry + 30); cr.line_to(rx + 26, ry + 30); cr.stroke()

            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(12.5)
            cr.set_source_rgb(0.95, 0.97, 0.99)
            cr.move_to(rx + 38, ry + 26)
            cr.show_text(str(d.get("name") or "Peer")[:20])

            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            cr.set_font_size(10.5)
            cr.set_source_rgb(0.58, 0.66, 0.77)
            role = "Este PC" if is_self else ("Alvo Ativo" if is_sel else "LAN Direta")
            bat_str = f" · {bat}%" if bat is not None else ""
            cr.move_to(rx + 38, ry + 42)
            cr.show_text(f"{os_name.upper()} · {role}{bat_str}")

            draw_radial_gauge(cr, rx + 44, ry + 82, 17, cpu, "CPU", (0.13, 0.83, 0.93))
            draw_radial_gauge(cr, rx + 136, ry + 82, 17, ram, "RAM", (0.55, 0.36, 0.96))

    def on_map_press(_w, ev):
        for d in reversed(state["devices"]):
            nx, ny = float(d.get("x", 220)), float(d.get("y", 180))
            if abs(ev.x - nx) <= NODE_W / 2 and abs(ev.y - ny) <= NODE_H / 2:
                state["selected_id"] = d.get("id")
                state["drag_id"] = d.get("id")
                state["drag_off"] = (nx - ev.x, ny - ev.y)
                refresh_selected_bar()
                map_canvas.queue_draw()
                return True
        return False

    def on_map_motion(widget, ev):
        if not state["drag_id"]:
            return False
        alloc = widget.get_allocation()
        for d in state["devices"]:
            if d.get("id") == state["drag_id"]:
                d["x"] = max(NODE_W / 2 + 12, min(alloc.width - NODE_W / 2 - 12, ev.x + state["drag_off"][0]))
                d["y"] = max(NODE_H / 2 + 12, min(alloc.height - NODE_H / 2 - 12, ev.y + state["drag_off"][1]))
                map_canvas.queue_draw()
                return True
        return False

    def on_map_release(_w, _ev):
        if state["drag_id"]:
            did = state["drag_id"]
            state["drag_id"] = None
            for d in state["devices"]:
                if d.get("id") == did:
                    client.send({"type": "device:move", "deviceId": did, "x": d["x"], "y": d["y"]})
        return True

    map_canvas.connect("draw", on_map_draw)
    map_canvas.connect("button-press-event", on_map_press)
    map_canvas.connect("motion-notify-event", on_map_motion)
    map_canvas.connect("button-release-event", on_map_release)

    sel_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    sel_bar.get_style_context().add_class("card")
    sel_bar.set_border_width(14)
    lbl_map_sel = Gtk.Label(label="Arraste os nós no mapa para organizar seus monitores. Selecione o alvo para estender tela ou controlar.")
    lbl_map_sel.set_xalign(0)
    lbl_map_sel.set_line_wrap(True)
    lbl_map_sel.get_style_context().add_class("muted")
    sel_bar.pack_start(lbl_map_sel, True, True, 0)

    btn_sel_screen = Gtk.Button(label="Estender Tela")
    btn_sel_screen.get_style_context().add_class("btn-primary")
    btn_sel_screen.connect("clicked", lambda _w: switch_page("screen"))

    btn_sel_remote = Gtk.Button(label="Mouse & Teclado")
    btn_sel_remote.get_style_context().add_class("btn-ghost")
    btn_sel_remote.connect("clicked", lambda _w: switch_page("remote"))

    btn_sel_ping = Gtk.Button(label="Localizar")
    btn_sel_ping.get_style_context().add_class("btn-ghost")
    btn_sel_ping.connect("clicked", lambda _w: send_remote({"kind": "media", "action": "ping"}))

    sel_bar.pack_start(btn_sel_screen, False, False, 0)
    sel_bar.pack_start(btn_sel_remote, False, False, 0)
    sel_bar.pack_start(btn_sel_ping, False, False, 0)
    map_page.pack_start(sel_bar, False, False, 0)
    stack.add_named(map_page, "map")

    # ==================== VIEW 2: EXTENSÃO DE TELA / SECOND SCREEN ====================
    screen_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
    screen_page.set_margin_top(18)
    screen_page.set_margin_bottom(18)
    screen_page.set_margin_start(20)
    screen_page.set_margin_end(20)

    scr_card = make_card(pad=18, spacing=14)
    lbl_scr_h = Gtk.Label(label="Extensão de Monitor / Segunda Tela via LAN")
    lbl_scr_h.set_xalign(0)
    lbl_scr_h.get_style_context().add_class("section-title")
    lbl_scr_sub = Gtk.Label(label="Transmita sua tela ou monitor secundário diretamente para o Tablet Android ou Windows em tempo real, com toque e cursor sincronizados.")
    lbl_scr_sub.set_xalign(0)
    lbl_scr_sub.set_line_wrap(True)
    lbl_scr_sub.get_style_context().add_class("muted")
    scr_card.pack_start(lbl_scr_h, False, False, 0)
    scr_card.pack_start(lbl_scr_sub, False, False, 0)

    scr_ctrl_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    combo_mon = Gtk.ComboBoxText()
    for m in monitors:
        combo_mon.append_text(m["label"])
    combo_mon.set_active(0)

    combo_fps = Gtk.ComboBoxText()
    combo_fps.append_text("15 FPS · Equilibrado (1280px)")
    combo_fps.append_text("20 FPS · Fluido (1100px)")
    combo_fps.append_text("10 FPS · Alta Nitidez (1440px)")
    combo_fps.set_active(0)

    btn_toggle_stream = Gtk.Button(label="Iniciar Extensão para Tablet/PC")
    btn_toggle_stream.get_style_context().add_class("btn-primary")

    scr_ctrl_row.pack_start(combo_mon, True, True, 0)
    scr_ctrl_row.pack_start(combo_fps, False, False, 0)
    scr_ctrl_row.pack_start(btn_toggle_stream, False, False, 0)
    scr_card.pack_start(scr_ctrl_row, False, False, 0)

    lbl_stream_status = Gtk.Label(label="Status: pronto · Clique em Iniciar Extensão ou toque em 'Pedir Tela' no seu Tablet.")
    lbl_stream_status.set_xalign(0)
    lbl_stream_status.get_style_context().add_class("mono")
    scr_card.pack_start(lbl_stream_status, False, False, 0)
    screen_page.pack_start(scr_card, False, False, 0)

    # Live Screen Preview / Receiver Canvas
    rx_canvas = Gtk.DrawingArea()
    rx_canvas.set_hexpand(True)
    rx_canvas.set_vexpand(True)
    rx_canvas.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.POINTER_MOTION_MASK)
    rx_frame = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    rx_frame.get_style_context().add_class("card")
    rx_frame.pack_start(rx_canvas, True, True, 0)
    screen_page.pack_start(rx_frame, True, True, 0)

    def on_rx_draw(widget, cr):
        alloc = widget.get_allocation()
        w, h = max(1, alloc.width), max(1, alloc.height)
        cr.set_source_rgb(0.025, 0.04, 0.075)
        cr.rectangle(0, 0, w, h)
        cr.fill()
        pb = state["rx_pixbuf"]
        if pb is None:
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(14)
            cr.set_source_rgb(0.82, 0.88, 0.96)
            txt = "Prévia / Receptor de Segunda Tela"
            ext = cr.text_extents(txt)
            cr.move_to((w - ext.width) / 2, h / 2 - 10)
            cr.show_text(txt)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            cr.set_font_size(12)
            cr.set_source_rgb(0.55, 0.64, 0.76)
            sub = "Inicie a transmissão acima para enviar este monitor ao Tablet Android, ou receba a tela de outro PC aqui."
            ext2 = cr.text_extents(sub)
            cr.move_to((w - ext2.width) / 2, h / 2 + 16)
            cr.show_text(sub)
            return
        bw, bh = pb.get_width(), pb.get_height()
        scale = min(w / float(bw), h / float(bh))
        dw, dh = int(bw * scale), int(bh * scale)
        ox, oy = (w - dw) / 2.0, (h - dh) / 2.0
        scaled = pb.scale_simple(max(1, dw), max(1, dh), GdkPixbuf.InterpType.BILINEAR)
        Gdk.cairo_set_source_pixbuf(cr, scaled, ox, oy)
        cr.paint()

    rx_canvas.connect("draw", on_rx_draw)

    def capture_monitor_jpeg(mon, target_w=1280, quality=65):
        # Method 1: Fast native GTK/GdkPixbuf capture (X11)
        try:
            root_w = Gdk.get_default_root_window()
            if root_w is not None:
                pb = Gdk.pixbuf_get_from_window(root_w, mon["x"], mon["y"], mon["w"], mon["h"])
                if pb is not None:
                    bw, bh = pb.get_width(), pb.get_height()
                    if bw > target_w:
                        th = max(1, int(bh * (target_w / float(bw))))
                        pb = pb.scale_simple(target_w, th, GdkPixbuf.InterpType.BILINEAR)
                    ok, buf = pb.save_to_bufferv("jpeg", ["quality"], [str(quality)])
                    if ok and buf:
                        return bytes(buf), pb.get_width(), pb.get_height(), pb
        except Exception:
            pass
        # Method 2: Wayland fallback via grim
        if shutil.which("grim"):
            try:
                out = subprocess.check_output(["grim", "-t", "jpeg", "-q", str(quality), "-"], timeout=1.5)
                if out:
                    return out, target_w, int(target_w * 9 / 16), None
            except Exception:
                pass
        return None, 0, 0, None

    def stop_screen_stream():
        if not state["streaming_out"]:
            return
        state["streaming_out"] = False
        client.send({"type": "screen:stop", "sourceDeviceId": DEVICE_ID, "targetDeviceId": state["stream_target_id"]})
        btn_toggle_stream.set_label("Iniciar Extensão para Tablet/PC")
        sc = btn_toggle_stream.get_style_context()
        sc.remove_class("btn-danger")
        sc.add_class("btn-primary")
        lbl_stream_status.set_text("Status: transmissão pausada.")
        state["rx_pixbuf"] = None
        rx_canvas.queue_draw()

    def start_screen_stream(explicit_target_id=None):
        tgt = get_target_device()
        target_id = explicit_target_id or (tgt["id"] if tgt and tgt.get("id") != DEVICE_ID else None)
        idx = max(0, combo_mon.get_active())
        mon = monitors[idx] if idx < len(monitors) else monitors[0]
        _active_mon_geom.update({"x": mon["x"], "y": mon["y"], "w": mon["w"], "h": mon["h"]})

        preset = combo_fps.get_active()
        if preset == 1:
            fps, tw, q = 20, 1100, 58
        elif preset == 2:
            fps, tw, q = 10, 1440, 76
        else:
            fps, tw, q = 15, 1280, 65

        state["streaming_out"] = True
        state["stream_target_id"] = target_id
        state["stream_fps"] = fps
        state["stream_seq"] = 0
        btn_toggle_stream.set_label("Parar Extensão de Tela")
        sc = btn_toggle_stream.get_style_context()
        sc.remove_class("btn-primary")
        sc.add_class("btn-danger")
        lbl_stream_status.set_text(f"Transmitindo {mon['label']} · {fps} FPS · LAN Direta")

        client.send({
            "type": "screen:start",
            "sourceDeviceId": DEVICE_ID,
            "sourceDeviceName": f"{HOSTNAME} (Linux)",
            "targetDeviceId": target_id,
            "mode": "extend",
            "width": mon["w"],
            "height": mon["h"],
            "fps": fps,
        })

        def _tick_capture():
            if not state["streaming_out"] or not client.running:
                return False
            if client.connected:
                jpg, cw, ch, pb = capture_monitor_jpeg(mon, target_w=tw, quality=q)
                if jpg:
                    state["stream_seq"] += 1
                    b64 = base64.b64encode(jpg).decode("ascii")
                    client.send({
                        "type": "screen:frame",
                        "sourceDeviceId": DEVICE_ID,
                        "targetDeviceId": state["stream_target_id"],
                        "width": cw,
                        "height": ch,
                        "seq": state["stream_seq"],
                        "data": b64,
                    })
                    if pb is not None:
                        state["rx_pixbuf"] = pb
                        rx_canvas.queue_draw()
            return state["streaming_out"]

        GLib.timeout_add(int(1000 / max(1, fps)), _tick_capture)

    def on_toggle_stream(_w):
        if state["streaming_out"]:
            stop_screen_stream()
        else:
            start_screen_stream()

    btn_toggle_stream.connect("clicked", on_toggle_stream)
    stack.add_named(screen_page, "screen")

    # ==================== VIEW 3: MOUSE & TECLADO CONTÍNUO (KVM + TRACKPAD) ====================
    remote_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
    remote_page.set_margin_top(18)
    remote_page.set_margin_bottom(18)
    remote_page.set_margin_start(20)
    remote_page.set_margin_end(20)

    kvm_bar = make_card(pad=16, spacing=10)
    kvm_top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    lbl_rem_target = Gtk.Label(label="Alvo: conecte um Tablet ou PC na mesma rede Wi-Fi")
    lbl_rem_target.set_xalign(0)
    lbl_rem_target.get_style_context().add_class("section-title")
    kvm_top.pack_start(lbl_rem_target, True, True, 0)

    sw_edge_lbl = Gtk.Label(label="Estender Mouse pela Borda:")
    sw_edge_lbl.get_style_context().add_class("muted")
    sw_edge = Gtk.Switch()
    sw_edge.set_active(state["kvm_edge_enabled"])

    combo_edge = Gtk.ComboBoxText()
    for val, lbl in [("right", "Borda Direita"), ("left", "Borda Esquerda"), ("top", "Borda Superior"), ("bottom", "Borda Inferior")]:
        combo_edge.append(val, lbl)
    combo_edge.set_active_id(state["kvm_edge_side"])

    def on_edge_changed(_w, _p=None):
        state["kvm_edge_enabled"] = sw_edge.get_active()
        state["kvm_edge_side"] = combo_edge.get_active_id() or "right"
        cfg["kvmEdgeEnabled"] = state["kvm_edge_enabled"]
        cfg["kvmEdgeSide"] = state["kvm_edge_side"]
        save_config(cfg)

    sw_edge.connect("notify::active", on_edge_changed)
    combo_edge.connect("changed", on_edge_changed)

    kvm_top.pack_start(sw_edge_lbl, False, False, 0)
    kvm_top.pack_start(sw_edge, False, False, 0)
    kvm_top.pack_start(combo_edge, False, False, 0)
    kvm_bar.pack_start(kvm_top, False, False, 0)
    remote_page.pack_start(kvm_bar, False, False, 0)

    # Holographic Trackpad & Live Keyboard Capture Pad
    pad_area = Gtk.DrawingArea()
    pad_area.set_hexpand(True)
    pad_area.set_vexpand(True)
    pad_area.set_can_focus(True)
    pad_area.add_events(
        Gdk.EventMask.BUTTON_PRESS_MASK
        | Gdk.EventMask.BUTTON_RELEASE_MASK
        | Gdk.EventMask.POINTER_MOTION_MASK
        | Gdk.EventMask.SCROLL_MASK
        | Gdk.EventMask.KEY_PRESS_MASK
    )
    pad_wrap = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    pad_wrap.get_style_context().add_class("card")
    pad_wrap.pack_start(pad_area, True, True, 0)
    remote_page.pack_start(pad_wrap, True, True, 0)

    def on_pad_draw(widget, cr):
        alloc = widget.get_allocation()
        w, h = max(1, alloc.width), max(1, alloc.height)
        bg = cairo.RadialGradient(w / 2, h / 2, 10, w / 2, h / 2, max(w, h) * 0.72)
        bg.add_color_stop_rgb(0, 0.05, 0.09, 0.165)
        bg.add_color_stop_rgb(1, 0.024, 0.039, 0.075)
        cr.set_source(bg); cr.rectangle(0, 0, w, h); cr.fill()

        cr.set_source_rgba(0.13, 0.83, 0.93, 0.20)
        for gx in range(28, w, 28):
            for gy in range(28, h, 28):
                cr.arc(gx, gy, 1.0, 0, 2 * math.pi); cr.fill()

        m, b = 18, 22
        cr.set_source_rgba(0.13, 0.83, 0.93, 0.55)
        cr.set_line_width(2.0)
        cr.move_to(m, m + b); cr.line_to(m, m); cr.line_to(m + b, m); cr.stroke()
        cr.move_to(w - m - b, m); cr.line_to(w - m, m); cr.line_to(w - m, m + b); cr.stroke()
        cr.move_to(m, h - m - b); cr.line_to(m, h - m); cr.line_to(m + b, h - m); cr.stroke()
        cr.move_to(w - m - b, h - m); cr.line_to(w - m, h - m); cr.line_to(w - m, h - m - b); cr.stroke()

        if not state["track_cursor"]:
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            cr.set_font_size(13)
            cr.set_source_rgba(0.58, 0.66, 0.77, 0.82)
            hint = "Superfície KVM Holográfica · Arraste para mover cursor · Clique Esq/Dir · Scroll · Digite direto com o teclado"
            ext = cr.text_extents(hint)
            cr.move_to((w - ext.width) / 2, h / 2)
            cr.show_text(hint)

        now = time.monotonic()
        state["track_trail"] = [pt for pt in state["track_trail"] if now - pt[2] < 0.25]
        tr = state["track_trail"]
        for i in range(1, len(tr)):
            age = (now - tr[i][2]) / 0.25
            cr.set_source_rgba(0.13, 0.83, 0.93, max(0.0, (1.0 - age) * 0.85))
            cr.set_line_width((1.0 - age) * 6.0 + 1.5)
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.move_to(tr[i - 1][0], tr[i - 1][1]); cr.line_to(tr[i][0], tr[i][1]); cr.stroke()

        state["track_ripples"] = [r for r in state["track_ripples"] if now - r[2] < 0.45]
        for rx, ry, t0 in state["track_ripples"]:
            p = (now - t0) / 0.45
            cr.set_source_rgba(0.13, 0.83, 0.93, max(0.0, (1.0 - p) * 0.82))
            cr.set_line_width(2.0)
            cr.arc(rx, ry, 10 + p * 46, 0, 2 * math.pi); cr.stroke()

        if state["track_cursor"]:
            cx, cy = state["track_cursor"]
            gp = cairo.RadialGradient(cx, cy, 2, cx, cy, 28)
            gp.add_color_stop_rgba(0, 0.13, 0.83, 0.93, 0.55)
            gp.add_color_stop_rgba(1, 0.13, 0.83, 0.93, 0.0)
            cr.set_source(gp); cr.arc(cx, cy, 28, 0, 2 * math.pi); cr.fill()
            cr.set_source_rgb(1.0, 1.0, 1.0); cr.arc(cx, cy, 4.5, 0, 2 * math.pi); cr.fill()

    def on_pad_press(widget, ev):
        widget.grab_focus()
        now = time.monotonic()
        state["track_cursor"] = (ev.x, ev.y)
        state["track_trail"] = [(ev.x, ev.y, now)]
        state["track_ripples"].append((ev.x, ev.y, now))
        if ev.button == 3:
            send_remote({"kind": "click", "button": "right"})
        elif ev.button == 2:
            send_remote({"kind": "click", "button": "middle"})
        else:
            state["track_last"] = (ev.x, ev.y)
            state["track_moved"] = False
        pad_area.queue_draw()
        return True

    def on_pad_motion(_w, ev):
        if state["track_last"] is not None:
            sens = float(cfg.get("sensitivity", 1.6))
            dx = (ev.x - state["track_last"][0]) * sens
            dy = (ev.y - state["track_last"][1]) * sens
            state["track_last"] = (ev.x, ev.y)
            state["track_cursor"] = (ev.x, ev.y)
            state["track_trail"].append((ev.x, ev.y, time.monotonic()))
            if len(state["track_trail"]) > 24:
                state["track_trail"].pop(0)
            if abs(dx) > 0.4 or abs(dy) > 0.4:
                state["track_moved"] = True
                send_remote({"kind": "move", "dx": round(dx, 2), "dy": round(dy, 2)})
            pad_area.queue_draw()
        return True

    def on_pad_release(_w, ev):
        if ev.button == 1 and state["track_last"] is not None and not state["track_moved"]:
            send_remote({"kind": "click", "button": "left"})
            state["track_ripples"].append((ev.x, ev.y, time.monotonic()))
        state["track_last"] = None
        state["track_cursor"] = None
        pad_area.queue_draw()
        return True

    def on_pad_scroll(_w, ev):
        dy = 42 if ev.direction == Gdk.ScrollDirection.DOWN else -42
        send_remote({"kind": "scroll", "dx": 0, "dy": dy})
        return True

    def on_pad_key(_w, ev):
        kname = Gdk.keyval_name(ev.keyval) or ""
        special = {
            "Return": "Enter", "BackSpace": "Backspace", "Escape": "Escape",
            "Tab": "Tab", "space": "Space", "Up": "ArrowUp", "Down": "ArrowDown",
            "Left": "ArrowLeft", "Right": "ArrowRight",
        }
        if kname in special:
            send_remote({"kind": "key", "key": special[kname]})
            return True
        ch = chr(Gdk.keyval_to_unicode(ev.keyval)) if Gdk.keyval_to_unicode(ev.keyval) else ""
        if ch and ch.isprintable():
            send_remote({"kind": "text", "text": ch})
            return True
        return False

    pad_area.connect("draw", on_pad_draw)
    pad_area.connect("button-press-event", on_pad_press)
    pad_area.connect("motion-notify-event", on_pad_motion)
    pad_area.connect("button-release-event", on_pad_release)
    pad_area.connect("scroll-event", on_pad_scroll)
    pad_area.connect("key-press-event", on_pad_key)

    # Bottom Keyboard & Media Controls (2 Clean Spacious Rows — NEVER crowded!)
    rem_controls = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
    kb_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    ent_type = Gtk.Entry()
    ent_type.set_placeholder_text("Digite texto para enviar diretamente ao teclado do dispositivo alvo...")
    btn_send_txt = Gtk.Button(label="Enviar Texto")
    btn_send_txt.get_style_context().add_class("btn-primary")
    btn_send_ent = Gtk.Button(label="Enter")
    btn_send_ent.get_style_context().add_class("btn-ghost")
    btn_send_bs = Gtk.Button(label="Backspace")
    btn_send_bs.get_style_context().add_class("btn-ghost")

    def do_send_text(_w=None):
        t = ent_type.get_text()
        if t:
            send_remote({"kind": "text", "text": t})
            ent_type.set_text("")

    ent_type.connect("activate", do_send_text)
    btn_send_txt.connect("clicked", do_send_text)
    btn_send_ent.connect("clicked", lambda _w: send_remote({"kind": "key", "key": "Enter"}))
    btn_send_bs.connect("clicked", lambda _w: send_remote({"kind": "key", "key": "Backspace"}))
    kb_row.pack_start(ent_type, True, True, 0)
    kb_row.pack_start(btn_send_txt, False, False, 0)
    kb_row.pack_start(btn_send_ent, False, False, 0)
    kb_row.pack_start(btn_send_bs, False, False, 0)
    rem_controls.pack_start(kb_row, False, False, 0)

    media_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    for lbl, ev in [
        ("Clique Esq.", {"kind": "click", "button": "left"}),
        ("Clique Dir.", {"kind": "click", "button": "right"}),
        ("Vol −", {"kind": "media", "action": "vol_down"}),
        ("Vol +", {"kind": "media", "action": "vol_up"}),
        ("Play / Pause", {"kind": "media", "action": "play_pause"}),
        ("Alt + Tab", {"kind": "key", "key": "Alt+Tab"}),
    ]:
        b = Gtk.Button(label=lbl)
        b.get_style_context().add_class("btn-ghost")
        b.connect("clicked", lambda _w, payload=ev: send_remote(payload))
        media_row.pack_start(b, True, True, 0)
    rem_controls.pack_start(media_row, False, False, 0)
    remote_page.pack_start(rem_controls, False, False, 0)
    stack.add_named(remote_page, "remote")

    # ==================== VIEW 4: CLIPBOARD AUTOMÁTICO & ARQUIVOS ====================
    transfer_scroll, transfer_inner = make_scrolled_page()

    # Card 1: Universal Auto-Sync Clipboard
    clip_card = make_card(pad=18, spacing=12)
    clip_hdr = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    clip_tbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
    lbl_ch = Gtk.Label(label="Área de Transferência Universal (Sincronização Automática)")
    lbl_ch.set_xalign(0); lbl_ch.get_style_context().add_class("section-title")
    lbl_cs = Gtk.Label(label="Quando ativo, qualquer Ctrl+C no Linux é enviado na hora para Tablet/Windows e vice-versa.")
    lbl_cs.set_xalign(0); lbl_cs.set_line_wrap(True); lbl_cs.get_style_context().add_class("muted")
    clip_tbox.pack_start(lbl_ch, False, False, 0)
    clip_tbox.pack_start(lbl_cs, False, False, 0)
    clip_hdr.pack_start(clip_tbox, True, True, 0)

    sw_clip = Gtk.Switch()
    sw_clip.set_active(state["auto_clip"])
    sw_clip.set_valign(Gtk.Align.CENTER)
    def on_sw_clip(_w, _p):
        state["auto_clip"] = sw_clip.get_active()
        cfg["autoClipboard"] = state["auto_clip"]
        save_config(cfg)
    sw_clip.connect("notify::active", on_sw_clip)
    clip_hdr.pack_start(sw_clip, False, False, 0)
    clip_card.pack_start(clip_hdr, False, False, 0)

    clip_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    ent_clip = Gtk.Entry()
    ent_clip.set_placeholder_text("Cole ou digite um texto para enviar imediatamente para a malha...")
    btn_clip_push = Gtk.Button(label="Enviar Texto")
    btn_clip_push.get_style_context().add_class("btn-primary")
    btn_clip_sys = Gtk.Button(label="Enviar Ctrl+C Atual")
    btn_clip_sys.get_style_context().add_class("btn-ghost")

    def push_clip_text(txt):
        if not txt:
            return
        state["last_clip_text"] = txt
        client.send({"type": "clipboard:push", "content": txt, "sourceDeviceId": DEVICE_ID, "sourceDeviceName": f"{HOSTNAME} (Linux)"})

    btn_clip_push.connect("clicked", lambda _w: (push_clip_text(ent_clip.get_text().strip()), ent_clip.set_text("")))
    btn_clip_sys.connect("clicked", lambda _w: push_clip_text((Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text() or "").strip()))
    clip_row.pack_start(ent_clip, True, True, 0)
    clip_row.pack_start(btn_clip_push, False, False, 0)
    clip_row.pack_start(btn_clip_sys, False, False, 0)
    clip_card.pack_start(clip_row, False, False, 0)

    clip_list_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    clip_card.pack_start(clip_list_box, False, False, 0)
    transfer_inner.pack_start(clip_card, False, False, 0)

    # Card 2: Direct LAN File Transfer
    file_card = make_card(pad=18, spacing=12)
    lbl_fh = Gtk.Label(label="Transferência Direta de Arquivos (Velocidade Wi-Fi LAN)")
    lbl_fh.set_xalign(0); lbl_fh.get_style_context().add_class("section-title")
    file_card.pack_start(lbl_fh, False, False, 0)

    file_btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    btn_pick_file = Gtk.Button(label="Escolher e Enviar Arquivo")
    btn_pick_file.get_style_context().add_class("btn-primary")
    btn_open_dl = Gtk.Button(label="Abrir Pasta Recebidos")
    btn_open_dl.get_style_context().add_class("btn-ghost")

    def on_pick_file(_w):
        dlg = Gtk.FileChooserDialog(title="Enviar arquivo via LAN", parent=win, action=Gtk.FileChooserAction.OPEN)
        dlg.add_buttons(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL, "Enviar", Gtk.ResponseType.OK)
        if dlg.run() == Gtk.ResponseType.OK:
            fp = dlg.get_filename()
            tgt = get_target_device()
            tid = tgt["id"] if tgt and tgt.get("id") != DEVICE_ID else None
            client.send_file(fp, target_id=tid)
        dlg.destroy()

    def on_open_dl(_w):
        os.makedirs(DOWNLOADS_DIR, exist_ok=True)
        run_cmd(["xdg-open", DOWNLOADS_DIR])

    btn_pick_file.connect("clicked", on_pick_file)
    btn_open_dl.connect("clicked", on_open_dl)
    file_btn_row.pack_start(btn_pick_file, False, False, 0)
    file_btn_row.pack_start(btn_open_dl, False, False, 0)
    file_card.pack_start(file_btn_row, False, False, 0)

    lbl_file_status = Gtk.Label(label="Pronto para transferir arquivos sem usar nuvem.")
    lbl_file_status.set_xalign(0); lbl_file_status.get_style_context().add_class("muted")
    prog_file = Gtk.ProgressBar()
    file_hist_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    file_card.pack_start(lbl_file_status, False, False, 0)
    file_card.pack_start(prog_file, False, False, 0)
    file_card.pack_start(file_hist_box, False, False, 0)
    transfer_inner.pack_start(file_card, False, False, 0)
    stack.add_named(transfer_scroll, "transfer")

    # ==================== VIEW 5: REDE LAN & SISTEMA ====================
    net_scroll, net_inner = make_scrolled_page()

    lan_card = make_card(pad=18, spacing=12)
    lbl_nh = Gtk.Label(label="Radar Wi-Fi LAN & Conexão Direta")
    lbl_nh.set_xalign(0); lbl_nh.get_style_context().add_class("section-title")
    lbl_ns = Gtk.Label(label=f"Hub Linux ativo em {get_local_lan_ip()}:{LAN_WS_PORT} · Descoberta híbrida (UDP + Radar TCP /24).")
    lbl_ns.set_xalign(0); lbl_ns.get_style_context().add_class("mono")
    lan_card.pack_start(lbl_nh, False, False, 0)
    lan_card.pack_start(lbl_ns, False, False, 0)

    lan_actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    btn_scan_now = Gtk.Button(label="Escanear Sub-Rede Wi-Fi Agora")
    btn_scan_now.get_style_context().add_class("btn-primary")
    btn_scan_now.connect("clicked", lambda _w: client.discovery.scan_subnet_tcp())

    btn_copy_ip = Gtk.Button(label=f"Copiar {get_local_lan_ip()}:{LAN_WS_PORT}")
    btn_copy_ip.get_style_context().add_class("btn-ghost")
    btn_copy_ip.connect("clicked", lambda _w: Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(f"{get_local_lan_ip()}:{LAN_WS_PORT}", -1))

    btn_copy_ufw = Gtk.Button(label="Copiar Regra Firewall UFW")
    btn_copy_ufw.get_style_context().add_class("btn-ghost")
    btn_copy_ufw.connect("clicked", lambda _w: Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text("sudo ufw allow 45891/tcp && sudo ufw allow 45890/udp", -1))

    lan_actions.pack_start(btn_scan_now, False, False, 0)
    lan_actions.pack_start(btn_copy_ip, False, False, 0)
    lan_actions.pack_start(btn_copy_ufw, False, False, 0)
    lan_card.pack_start(lan_actions, False, False, 0)

    lan_peers_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    lan_card.pack_start(lan_peers_box, False, False, 0)

    # Manual IP + Room Code
    manual_grid = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    ent_room = Gtk.Entry()
    ent_room.set_text(cfg.get("roomCode", DEFAULT_ROOM_CODE))
    ent_room.set_placeholder_text("Código da Malha")
    ent_room.set_width_chars(12)

    ent_manual = Gtk.Entry()
    ent_manual.set_text(cfg.get("manualPeer", ""))
    ent_manual.set_placeholder_text("IP do dispositivo (ex: 192.168.1.42 ou .42)")

    btn_manual_conn = Gtk.Button(label="Conectar")
    btn_manual_conn.get_style_context().add_class("btn-primary")
    btn_manual_conn.connect("clicked", lambda _w: (
        client.connect_to_peer(ent_manual.get_text().strip(), ent_room.get_text().strip())
        if ent_manual.get_text().strip()
        else client.set_connection_mode(ent_room.get_text().strip(), "", True)
    ))

    btn_auto_mode = Gtk.Button(label="Modo Automático")
    btn_auto_mode.get_style_context().add_class("btn-ghost")
    btn_auto_mode.connect("clicked", lambda _w: (ent_manual.set_text(""), client.set_connection_mode(ent_room.get_text().strip(), "", True)))

    manual_grid.pack_start(ent_room, False, False, 0)
    manual_grid.pack_start(ent_manual, True, True, 0)
    manual_grid.pack_start(btn_manual_conn, False, False, 0)
    manual_grid.pack_start(btn_auto_mode, False, False, 0)
    lan_card.pack_start(manual_grid, False, False, 0)
    net_inner.pack_start(lan_card, False, False, 0)

    # Telemetry & Alerts Card
    sys_card = make_card(pad=18, spacing=12)
    lbl_sysh = Gtk.Label(label="Telemetria em Tempo Real & Alertas")
    lbl_sysh.set_xalign(0); lbl_sysh.get_style_context().add_class("section-title")
    sys_card.pack_start(lbl_sysh, False, False, 0)
    tel_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    sys_card.pack_start(tel_box, False, False, 0)

    btn_alert_test = Gtk.Button(label="Enviar Alerta de Teste para Malha")
    btn_alert_test.get_style_context().add_class("btn-ghost")
    btn_alert_test.connect("clicked", lambda _w: client.send({
        "type": "notification:push",
        "title": f"Alerta de {HOSTNAME}",
        "body": "Conexao direta LAN ativa.",
        "sourceDeviceId": DEVICE_ID,
        "sourceDeviceName": f"{HOSTNAME} (Linux)",
    }))
    sys_card.pack_start(btn_alert_test, False, False, 0)
    notif_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    sys_card.pack_start(notif_box, False, False, 0)
    net_inner.pack_start(sys_card, False, False, 0)
    stack.add_named(net_scroll, "network")

    # ==================== UI REFRESH HELPERS ====================
    def clear_box(box):
        for ch in box.get_children():
            box.remove(ch)

    def refresh_selected_bar():
        tgt = get_target_device()
        if tgt and tgt.get("id") != DEVICE_ID:
            tel = tgt.get("telemetry") or {}
            lbl_map_sel.set_text(f"Alvo ativo: {tgt.get('name')} ({str(tgt.get('os','')).upper()}) · CPU {tel.get('cpuUsage',0)}% · RAM {tel.get('memoryUsagePercent',0)}%")
            lbl_rem_target.set_text(f"Controlando: {tgt.get('name')} ({str(tgt.get('os','')).upper()})")
        else:
            lbl_map_sel.set_text("Nenhum outro dispositivo conectado ainda · Abra o Continuum no Tablet/Windows no mesmo Wi-Fi.")
            lbl_rem_target.set_text("Alvo: aguardando outro dispositivo na rede Wi-Fi...")

    def refresh_lan_peers_ui():
        clear_box(lan_peers_box)
        peers = state["lan_peers"]
        if not peers:
            lbl = Gtk.Label(label="Nenhum dispositivo detectado ainda. Clique em Escanear Sub-Rede Wi-Fi.")
            lbl.set_xalign(0); lbl.get_style_context().add_class("muted")
            lan_peers_box.pack_start(lbl, False, False, 0)
        else:
            joined_ips = {d.get("lanIp") for d in state["devices"]}
            joined_ids = {d.get("id") for d in state["devices"]}
            for p in peers:
                is_joined = p["ip"] in joined_ips or p["hubId"] in joined_ids or client.connected_url == f"ws://{p['ip']}:{p['wsPort']}/ws"
                row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
                row.get_style_context().add_class("card-subtle")
                row.set_border_width(12)
                info = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
                t1 = Gtk.Label(label=f"{p['hubName']} ({p['os'].upper()})")
                t1.set_xalign(0)
                t2 = Gtk.Label(label=f"{p['ip']}:{p['wsPort']} · {p.get('via','LAN')} · Malha {p['roomCode']}")
                t2.set_xalign(0); t2.get_style_context().add_class("mono")
                info.pack_start(t1, False, False, 0)
                info.pack_start(t2, False, False, 0)
                row.pack_start(info, True, True, 0)
                if is_joined and client.connected:
                    st = Gtk.Label(label="Conectado")
                    st.get_style_context().add_class("status-ok")
                    row.pack_start(st, False, False, 6)
                else:
                    bc = Gtk.Button(label="Conectar")
                    bc.get_style_context().add_class("btn-primary")
                    bc.connect("clicked", lambda _w, ip=p["ip"], pt=p["wsPort"], rm=p["roomCode"]: (
                        ent_manual.set_text(f"{ip}:{pt}"),
                        client.connect_to_peer(f"{ip}:{pt}", rm),
                    ))
                    row.pack_start(bc, False, False, 0)
                lan_peers_box.pack_start(row, False, False, 0)
        lan_peers_box.show_all()

    def refresh_telemetry_ui():
        clear_box(tel_box)
        for d in state["devices"]:
            tel = d.get("telemetry") or {}
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
            row.get_style_context().add_class("card-subtle")
            row.set_border_width(10)
            bat = f" · Bateria {tel.get('batteryLevel')}%" if tel.get("batteryLevel") is not None else ""
            l1 = Gtk.Label(label=f"{d.get('name')} ({str(d.get('os','')).upper()})")
            l1.set_xalign(0)
            l2 = Gtk.Label(label=f"CPU {tel.get('cpuUsage',0)}% · RAM {tel.get('memoryUsagePercent',0)}%{bat}")
            l2.get_style_context().add_class("mono")
            row.pack_start(l1, True, True, 0)
            row.pack_start(l2, False, False, 0)
            tel_box.pack_start(row, False, False, 0)
        tel_box.show_all()

    def refresh_clipboard_ui(items):
        clear_box(clip_list_box)
        for it in items[:15]:
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            row.get_style_context().add_class("card-subtle")
            row.set_border_width(10)
            txt = str(it.get("content") or "")
            lbl = Gtk.Label(label=f"[{it.get('sourceDeviceName','Peer')}] {txt[:110]}")
            lbl.set_xalign(0); lbl.set_line_wrap(True)
            bc = Gtk.Button(label="Copiar")
            bc.get_style_context().add_class("btn-ghost")
            bc.connect("clicked", lambda _w, c=txt: (state.__setitem__("last_clip_text", c), Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(c, -1)))
            row.pack_start(lbl, True, True, 0)
            row.pack_start(bc, False, False, 0)
            clip_list_box.pack_start(row, False, False, 0)
        clip_list_box.show_all()

    def refresh_notifs_ui(items):
        clear_box(notif_box)
        for n in items[:10]:
            lbl = Gtk.Label(label=f"[{n.get('sourceDeviceName','Peer')}] {n.get('title','')}: {n.get('body','')}")
            lbl.set_xalign(0); lbl.set_line_wrap(True)
            lbl.get_style_context().add_class("muted")
            notif_box.pack_start(lbl, False, False, 0)
        notif_box.show_all()

    # ==================== TIMERS: 60FPS ANIMATION + AUTO CLIPBOARD + EDGE KVM ====================
    def tick_animation():
        now = time.monotonic()
        dt = min(0.05, max(0.005, now - state["last_frame"]))
        state["last_frame"] = now
        state["phase"] = (state["phase"] + dt) % 1000.0
        cur = stack.get_visible_child_name()
        if cur == "map":
            map_canvas.queue_draw()
        elif cur == "remote" and (state["track_ripples"] or state["track_trail"] or state["track_cursor"]):
            pad_area.queue_draw()
        return True

    def tick_auto_clipboard():
        if state["auto_clip"] and client.connected:
            try:
                txt = (Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text() or "").strip()
                if txt and txt != state["last_clip_text"]:
                    state["last_clip_text"] = txt
                    client.send({
                        "type": "clipboard:push",
                        "content": txt,
                        "sourceDeviceId": DEVICE_ID,
                        "sourceDeviceName": f"{HOSTNAME} (Linux)",
                        "auto": True,
                    })
            except Exception:
                pass
        return True

    def tick_edge_kvm():
        if not state["kvm_edge_enabled"] or not client.connected:
            return True
        tgt = get_target_device()
        if not tgt or tgt.get("id") == DEVICE_ID:
            return True
        try:
            disp = Gdk.Display.get_default()
            seat = disp.get_default_seat()
            ptr = seat.get_pointer()
            _scr, px, py = ptr.get_position()
            mw, mh = _active_mon_geom["w"], _active_mon_geom["h"]
            side = state["kvm_edge_side"]
            hit = (
                (side == "right" and px >= mw - 2)
                or (side == "left" and px <= 1)
                or (side == "top" and py <= 1)
                or (side == "bottom" and py >= mh - 2)
            )
            if hit:
                # Forward subtle relative nudge when pushing against monitor border
                dx = 12 if side == "right" else (-12 if side == "left" else 0)
                dy = 12 if side == "bottom" else (-12 if side == "top" else 0)
                send_remote({"kind": "move", "dx": dx, "dy": dy})
        except Exception:
            pass
        return True

    def poll_events():
        while True:
            try:
                etype, data = events.get_nowait()
            except queue.Empty:
                break
            if etype == "status":
                st = data.get("state")
                hub = data.get("hub", "LAN")
                sc = lbl_side_status.get_style_context()
                sc.remove_class("status-ok"); sc.remove_class("status-warn")
                if st == "connected":
                    lbl_side_status.set_text(f"Conectado · {hub}")
                    sc.add_class("status-ok")
                else:
                    lbl_side_status.set_text(f"Conectando · {hub}...")
                    sc.add_class("status-warn")
                refresh_lan_peers_ui()
            elif etype == "rtt":
                lbl_top_rtt.set_text(f"{data} ms · LAN Direta")
            elif etype == "room_synced":
                ent_room.set_text(str(data))
                lbl_side_room.set_text(f"Malha: {data}")
            elif etype == "scan":
                state["scanning"] = bool(data.get("scanning"))
                state["scan_pct"] = int(data.get("pct") or 0)
                btn_top_scan.set_label(f"Escaneando {state['scan_pct']}%" if state["scanning"] else "Escanear Wi-Fi")
            elif etype == "lan_peers":
                state["lan_peers"] = data or []
                refresh_lan_peers_ui()
            elif etype == "devices":
                state["devices"] = data or []
                if not state["selected_id"]:
                    other = next((d for d in state["devices"] if d.get("id") != DEVICE_ID), None)
                    if other:
                        state["selected_id"] = other["id"]
                cnt = len(state["devices"])
                lbl_side_count.set_text(f"{cnt} {'dispositivo' if cnt == 1 else 'dispositivos'} online")
                refresh_selected_bar()
                refresh_telemetry_ui()
                refresh_lan_peers_ui()
                map_canvas.queue_draw()
            elif etype == "clipboard":
                refresh_clipboard_ui(data or [])
            elif etype == "clipboard_remote_sync":
                if state["auto_clip"] and data and data != state["last_clip_text"]:
                    state["last_clip_text"] = data
                    try:
                        Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(data, -1)
                    except Exception:
                        pass
            elif etype == "notifications":
                refresh_notifs_ui(data or [])
            elif etype == "screen:request":
                req_from = data.get("sourceDeviceId")
                if not state["streaming_out"]:
                    switch_page("screen")
                    start_screen_stream(explicit_target_id=req_from)
            elif etype == "screen:frame":
                if not state["streaming_out"] and data.get("data"):
                    try:
                        raw = base64.b64decode(data["data"])
                        loader = GdkPixbuf.PixbufLoader.new_with_type("jpeg")
                        loader.write(raw)
                        loader.close()
                        state["rx_pixbuf"] = loader.get_pixbuf()
                        rx_canvas.queue_draw()
                    except Exception:
                        pass
            elif etype == "screen:stop":
                if not state["streaming_out"]:
                    state["rx_pixbuf"] = None
                    rx_canvas.queue_draw()
            elif etype == "file_progress":
                lbl_file_status.set_text(f"{'Enviando' if data['dir']=='send' else 'Recebendo'} {data['name']} · {data['pct']}%")
                prog_file.set_fraction(max(0.0, min(1.0, data["pct"] / 100.0)))
            elif etype == "file_done":
                lbl_file_status.set_text(f"Concluído: {data['name']}")
                row = Gtk.Label(label=f"{'Enviado' if data['dir']=='send' else 'Recebido'}: {data['name']} ({max(1, int(data['size']//1024))} KB)")
                row.set_xalign(0); row.get_style_context().add_class("muted")
                file_hist_box.pack_start(row, False, False, 0)
                file_hist_box.show_all()
            elif etype == "toast":
                show_banner_toast(str(data))
        return True

    def on_destroy(_w):
        stop_screen_stream()
        client.stop()
        Gtk.main_quit()

    win.connect("destroy", on_destroy)
    switch_page("map")
    client.start()
    GLib.timeout_add(33, tick_animation)
    GLib.timeout_add(60, poll_events)
    GLib.timeout_add(850, tick_auto_clipboard)
    GLib.timeout_add(90, tick_edge_kvm)
    win.show_all()
    Gtk.main()


def show_visible_error(msg):
    log_msg(f"ERRO FATAL: {msg}")
    sys.stderr.write(msg + "\n")
    for cmd in (["zenity", "--error", "--title=Continuum", f"--text={msg}"], ["kdialog", "--error", msg]):
        if shutil.which(cmd[0]):
            try:
                subprocess.Popen(cmd)
                return
            except Exception:
                pass


def main():
    args = sys.argv[1:]
    cfg = load_config()
    hub_only = False
    i = 0
    while i < len(args):
        if args[i] == "--hub-only":
            hub_only = True
        elif args[i] == "--room" and i + 1 < len(args):
            cfg["roomCode"] = args[i + 1].upper()[:12]
            i += 1
        elif args[i] == "--port" and i + 1 < len(args):
            cfg["wsPort"] = int(args[i + 1])
            i += 1
        i += 1

    if hub_only:
        hub = EmbeddedLanHub(port=int(cfg.get("wsPort") or LAN_WS_PORT), get_room_fn=lambda: cfg.get("roomCode", DEFAULT_ROOM_CODE))
        hub.start()
        disc = LanDiscoveryService(hub, lambda: cfg.get("roomCode", DEFAULT_ROOM_CODE))
        disc.start()
        print(f"Continuum LAN Hub v{APP_VERSION} ativo em {get_local_lan_ip()}:{hub.port} (malha {cfg['roomCode']})", flush=True)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            disc.stop()
            hub.stop()
        return

    try:
        run_gtk_app(cfg, start_hub=True)
    except Exception as exc:
        show_visible_error(f"Nao foi possivel iniciar a interface GTK 3 do Continuum:\n{exc}\n\nInstale: sudo apt install python3-gi gir1.2-gtk-3.0")


if __name__ == "__main__":
    main()
