import type { InstallerContext } from './platformInstallers.ts';

function safeStr(val: string): string {
  return val.replace(/[`'"\\$<>|;&\r\n]/g, '');
}

/**
 * 100% NATIVE LINUX DESKTOP APPLICATION v4.0.0 — HOLOGRAPHIC SPATIAL UI + 3-LAYER AUTO LAN MESH
 * - Pure Python 3 Stdlib + Native GTK 3 + Cairo (ZERO WebView, ZERO Electron, ZERO Browser)
 * - 3-Layer Zero-Config Direct App-to-App LAN Mesh:
 *     1) Embedded RFC-6455 WebSocket Hub + /continuum-info HTTP probe (TCP 45891)
 *     2) Active UDP Broadcast + /24 Subnet Broadcast + Multicast 239.255.45.90 + Direct Unicast Probe Reply (UDP 45890)
 *     3) Fast Parallel /24 TCP LAN Scanner (32 workers) — discovers Windows & Android even when UDP is blocked!
 * - Holographic 60fps Cairo Spatial Map (sweeping cyan radar, flowing data packets along gradient Bezier beams,
 *   frosted glass device cards with iridescent borders & circular CPU/RAM arc gauges) + Holographic Trackpad with comet trails.
 */
export function buildLinuxNativeAppPy(ctx: InstallerContext): string {
  const room = safeStr(ctx.roomCode || 'MESH01');

  return `#!/usr/bin/env python3
"""
Continuum v4.0.0 — Aplicativo Desktop 100% Nativo para Linux (GTK 3 + Cairo Holografico + Malha Direta LAN P2P)
Comunicacao direta e automatica entre Linux, Windows e Android via TCP 45891 + UDP 45890 + Radar TCP /24.
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

APP_VERSION = "4.0.0"
LAN_UDP_PORT = 45890
LAN_WS_PORT = 45891
PROTO_V4 = "continuum-lan-v4"
PROTO_V3 = "continuum-lan-v3"
MULTICAST_ADDR = "239.255.45.90"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

DEFAULT_ROOM_CODE = ${JSON.stringify(room)}

HOSTNAME = socket.gethostname() or "Estacao Linux"
_CLEAN_HOST = "".join(c for c in HOSTNAME.lower() if c.isalnum())[:14] or "linux"
DEVICE_ID = f"linux-app-{_CLEAN_HOST}-{os.getpid() % 9000 + 1000}"
CONFIG_DIR = os.path.expanduser("~/.config/continuum")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
LOG_DIR = os.path.expanduser("~/.local/share/continuum")
LOG_FILE = os.path.join(LOG_DIR, "app.log")
DOWNLOADS_DIR = os.path.expanduser("~/Downloads/Continuum")

_prev_cpu = None


def log_msg(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(f"[{ts}] {msg}\\n")
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

    # Shorthand ".42" or "42" -> auto-complete local /24 subnet
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


def probe_http_info(host, port=LAN_WS_PORT, timeout=0.28):
    s = None
    try:
        s = socket.create_connection((host, int(port)), timeout=timeout)
        s.settimeout(timeout + 0.25)
        req = f"GET /continuum-info HTTP/1.1\\r\\nHost: {host}:{port}\\r\\nConnection: close\\r\\n\\r\\n"
        s.sendall(req.encode("ascii"))
        data = b""
        while len(data) < 4096:
            chunk = s.recv(1024)
            if not chunk:
                break
            data += chunk
        idx = data.find(b"\\r\\n\\r\\n")
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
        }
        k = key_map.get(str(event.get("key", "")), str(event.get("key", "")))
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
# RFC-6455 Pure-Python Helpers
# ---------------------------------------------------------------------------

def recv_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
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


def ws_read_frame(sock):
    b1, b2 = recv_exact(sock, 2)
    opcode = b1 & 0x0F
    is_masked = (b2 & 0x80) != 0
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack("!H", recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", recv_exact(sock, 8))[0]
    mask = recv_exact(sock, 4) if is_masked else None
    payload = recv_exact(sock, length) if length > 0 else b""
    if mask is not None and payload:
        payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    return opcode, payload


# ---------------------------------------------------------------------------
# Embedded LAN Mesh Hub (TCP 45891: RFC-6455 WebSocket + HTTP /continuum-info)
# ---------------------------------------------------------------------------

class EmbeddedLanHub:
    def __init__(self, port=LAN_WS_PORT, get_room_fn=None):
        self.port = port
        self.get_room_fn = get_room_fn or (lambda: DEFAULT_ROOM_CODE)
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
                    s.close()
                except Exception:
                    pass
            self.clients.clear()

    def peer_count(self, room_code):
        with self.lock:
            rm = self.rooms.get(room_code)
            return len(rm["devices"]) if rm else 0

    def _get_room(self, code):
        if code not in self.rooms:
            self.rooms[code] = {"devices": {}, "clipboard": [], "notifications": []}
        return self.rooms[code]

    def _accept_loop(self):
        while self.running:
            try:
                conn, addr = self.server_sock.accept()
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
            while b"\\r\\n\\r\\n" not in req and len(req) < 8192:
                chunk = conn.recv(4096)
                if not chunk:
                    conn.close()
                    return
                req += chunk
            headers = {}
            for line in req.decode("utf-8", errors="ignore").split("\\r\\n")[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            ws_key = headers.get("sec-websocket-key")
            if not ws_key:
                room = self.get_room_fn()
                body = json.dumps({
                    "ok": True,
                    "proto": PROTO_V4,
                    "hubId": self.hub_id,
                    "hubName": HOSTNAME,
                    "hub": HOSTNAME,
                    "os": "linux",
                    "roomCode": room,
                    "wsPort": self.port,
                    "ip": get_local_lan_ip(),
                    "startedAt": self.started_at,
                    "peers": self.peer_count(room),
                    "version": APP_VERSION,
                }).encode("utf-8")
                conn.sendall(
                    b"HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nAccess-Control-Allow-Origin: *\\r\\nContent-Length: "
                    + str(len(body)).encode("ascii") + b"\\r\\nConnection: close\\r\\n\\r\\n" + body
                )
                conn.close()
                return

            accept = base64.b64encode(hashlib.sha1((ws_key + WS_GUID).encode("ascii")).digest()).decode("ascii")
            handshake = (
                "HTTP/1.1 101 Switching Protocols\\r\\n"
                "Upgrade: websocket\\r\\n"
                "Connection: Upgrade\\r\\n"
                f"Sec-WebSocket-Accept: {accept}\\r\\n\\r\\n"
            )
            conn.sendall(handshake.encode("ascii"))
            conn.settimeout(None)

            with self.lock:
                self.clients[conn] = {"id": None, "room": None, "addr": addr[0], "send_lock": threading.Lock()}

            while self.running:
                opcode, payload = ws_read_frame(conn)
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
            room_code = "".join(c for c in str(msg.get("roomCode", DEFAULT_ROOM_CODE)).upper() if c.isalnum())[:12] or "MESH01"
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
        elif mtype == "input:event":
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
        elif mtype in ("file:start", "file:chunk", "file:complete"):
            target_id = msg.get("targetDeviceId")
            if target_id:
                self._send_to_device(room_code, target_id, msg, exclude=conn)
            else:
                self._broadcast_room(room_code, msg, exclude=conn)


# ---------------------------------------------------------------------------
# 3-Layer Hybrid LAN Discovery (UDP Broadcast + Subnet + Multicast + Unicast Reply + Parallel /24 TCP Scan)
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
            stale = [k for k, v in self.discovered.items() if now - v.get("lastSeen", 0) > 25.0]
            for k in stale:
                self.discovered.pop(k, None)
            return list(self.discovered.values())

    def elect_best_hub(self, room_code):
        peers = [p for p in self.list_peers() if p.get("roomCode") == room_code and p.get("hubId") != self.hub.hub_id]
        candidates = list(peers)
        if self.hub.active:
            candidates.append({
                "hubId": self.hub.hub_id,
                "hubName": HOSTNAME,
                "os": "linux",
                "ip": "127.0.0.1",
                "wsPort": self.hub.port,
                "roomCode": room_code,
                "startedAt": self.hub.started_at,
                "isLocal": True,
            })
        if not candidates:
            return None
        # Prefer desktop hubs over mobile fallback hubs unless only mobile is reachable; tie-break by startedAt
        candidates.sort(key=lambda c: (1 if c.get("os") == "android" else 0, int(c.get("startedAt", 0)), str(c.get("hubId", ""))))
        return candidates[0]

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
            "proto": PROTO_V4,
            "type": btype,
            "roomCode": room,
            "hubId": self.hub.hub_id,
            "hubName": HOSTNAME,
            "os": "linux",
            "ip": get_local_lan_ip(),
            "wsPort": self.hub.port,
            "startedAt": self.hub.started_at,
            "peers": self.hub.peer_count(room),
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
            time.sleep(2.0)
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
                if info.get("proto") not in (PROTO_V4, PROTO_V3):
                    continue
                hub_id = str(info.get("hubId") or "")
                if not hub_id or hub_id == self.hub.hub_id:
                    continue
                # Immediate direct unicast reply when Android/Windows sends an active probe!
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
# Pure Python RFC-6455 WebSocket Client
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
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if use_ssl else raw
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = f"{host}:{port}" if parsed.port else host
        req = (
            f"GET {path} HTTP/1.1\\r\\n"
            f"Host: {host_header}\\r\\n"
            f"Upgrade: websocket\\r\\n"
            f"Connection: Upgrade\\r\\n"
            f"Sec-WebSocket-Key: {key}\\r\\n"
            f"Sec-WebSocket-Version: 13\\r\\n"
            f"User-Agent: Continuum-Linux-Native/{APP_VERSION}\\r\\n\\r\\n"
        )
        self.sock.sendall(req.encode("utf-8"))
        resp = b""
        while b"\\r\\n\\r\\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("Handshake closed")
            resp += chunk
        status = resp.split(b"\\r\\n", 1)[0].decode("utf-8", errors="ignore")
        if "101" not in status:
            raise ConnectionError(f"WebSocket handshake failed: {status}")
        self.sock.settimeout(None)

    def send_json(self, obj):
        if self.closed or self.sock is None:
            return
        frame = ws_encode_frame(json.dumps(obj).encode("utf-8"), opcode=0x1, masked=True)
        with self._lock:
            self.sock.sendall(frame)

    def recv_json(self):
        while not self.closed:
            opcode, payload = ws_read_frame(self.sock)
            if opcode == 0x8:
                self.close()
                return None
            if opcode == 0x9:
                with self._lock:
                    self.sock.sendall(ws_encode_frame(payload, opcode=0xA, masked=True))
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x1:
                return json.loads(payload.decode("utf-8", errors="replace"))
        return None

    def close(self):
        self.closed = True
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Unified Mesh Client
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

        self.hub = EmbeddedLanHub(
            port=int(cfg.get("wsPort") or LAN_WS_PORT),
            get_room_fn=lambda: self.cfg.get("roomCode", DEFAULT_ROOM_CODE),
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

    def _on_lan_peers_changed(self):
        peers = self.discovery.list_peers()
        self._emit("lan_peers", peers)
        if self.cfg.get("autoLan", True) and not self.cfg.get("manualPeer"):
            best = self.discovery.elect_best_hub(self.cfg.get("roomCode", DEFAULT_ROOM_CODE))
            if best and not best.get("isLocal"):
                desired = f"ws://{best['ip']}:{best['wsPort']}/ws"
                if self.connected and self.connected_url and desired != self.connected_url:
                    self.reconnect()

    def start(self):
        threading.Thread(target=self._run_loop, daemon=True).start()
        threading.Thread(target=self._telemetry_loop, daemon=True).start()
        # Run an initial fast /24 TCP scan so Android/Windows are discovered even if UDP is blocked
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

    def set_connection_mode(self, room_code, manual_peer="", auto_lan=True):
        clean_room = "".join(c for c in (room_code or "").upper() if c.isalnum())[:12] or DEFAULT_ROOM_CODE
        self.cfg["roomCode"] = clean_room
        self.cfg["manualPeer"] = (manual_peer or "").strip()
        self.cfg["autoLan"] = bool(auto_lan)
        save_config(self.cfg)
        self.reconnect()

    def _resolve_target_ws(self):
        manual = (self.cfg.get("manualPeer") or "").strip()
        if manual:
            url = normalize_ws_endpoint(manual)
            if url:
                return url, f"Peer LAN ({manual})"
        room = self.cfg.get("roomCode", DEFAULT_ROOM_CODE)
        if self.cfg.get("autoLan", True):
            best = self.discovery.elect_best_hub(room)
            if best and not best.get("isLocal"):
                return f"ws://{best['ip']}:{best['wsPort']}/ws", f"Hub LAN · {best['hubName']} ({best['ip']})"
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
        time.sleep(0.35)
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
                        "screenWidth": 1920,
                        "screenHeight": 1080,
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
            finally:
                self.connected = False
                if self.ws:
                    self.ws.close()
                    self.ws = None
                self._emit("status", {"state": "reconnecting", "hub": hub_label, "url": ws_url})
            if self.running and not self._reconnect_flag.is_set():
                time.sleep(1.8)

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
# Holographic 60 FPS Native GTK 3 + Cairo UI (v4.0.0)
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
    from gi.repository import Gtk, Gdk, GLib

    css = b"""
    window, .root-bg { background-color: #050810; color: #F1F5F9; font-family: "Plus Jakarta Sans", "Ubuntu", "Cantarell", sans-serif; }
    .sidebar { background-color: #0A101E; border-right: 1px solid #1A2B49; }
    .topbar { background-color: #080E1B; border-bottom: 1px solid #1C3458; }
    .brand-title { font-size: 16px; font-weight: 800; color: #22D3EE; letter-spacing: 1px; }
    .brand-sub { font-size: 11px; color: #7C94B8; }
    .section-title { font-size: 15px; font-weight: 700; color: #F8FAFC; }
    .card { background-color: #0E1628; border: 1px solid #1E3354; border-radius: 12px; }
    .card-subtle { background-color: #09101E; border: 1px solid #192C4A; border-radius: 10px; }
    .muted { color: #8BA3C4; font-size: 12px; }
    .mono { font-family: "JetBrains Mono", "Ubuntu Mono", monospace; font-size: 12px; color: #22D3EE; }
    .status-ok { color: #10B981; font-weight: 700; font-size: 12px; }
    .status-cyan { color: #22D3EE; font-weight: 700; font-size: 12px; }
    .nav-btn {
        background-image: none;
        background-color: transparent;
        color: #8BA3C4;
        border: 1px solid transparent;
        border-radius: 10px;
        padding: 10px 12px;
        font-weight: 600;
        font-size: 13px;
    }
    .nav-btn:hover { background-color: #111C33; color: #F1F5F9; }
    .nav-btn-active {
        background-image: linear-gradient(90deg, #102442, #151E38);
        color: #22D3EE;
        border: 1px solid #22D3EE;
        border-radius: 10px;
        padding: 10px 12px;
        font-weight: 700;
        font-size: 13px;
    }
    button.btn-primary {
        background-image: linear-gradient(135deg, #0891B2, #3B82F6, #8B5CF6);
        color: #FFFFFF;
        border: 1px solid #22D3EE;
        border-radius: 9px;
        padding: 7px 14px;
        font-weight: 700;
        font-size: 12px;
    }
    button.btn-primary:hover { background-image: linear-gradient(135deg, #06B6D4, #2563EB, #7C3AED); }
    button.btn-secondary {
        background-image: none;
        background-color: #0E172A;
        color: #E2E8F0;
        border: 1px solid #22385C;
        border-radius: 9px;
        padding: 7px 12px;
        font-weight: 600;
        font-size: 12px;
    }
    button.btn-secondary:hover { background-color: #162440; border-color: #22D3EE; color: #FFFFFF; }
    entry {
        background-color: #060A13;
        color: #F8FAFC;
        border: 1px solid #22385C;
        border-radius: 9px;
        padding: 6px 10px;
        font-size: 12px;
    }
    entry:focus { border-color: #22D3EE; }
    progressbar trough { background-color: #101A2F; border-radius: 6px; min-height: 9px; }
    progressbar progress { background-image: linear-gradient(90deg, #22D3EE, #3B82F6, #8B5CF6); border-radius: 6px; min-height: 9px; }
    listbox { background-color: transparent; }
    listbox row { background-color: transparent; padding: 3px 0px; }
    """
    try:
        provider = Gtk.CssProvider()
        provider.load_from_data(css)
        screen = Gdk.Screen.get_default()
        if screen is not None:
            Gtk.StyleContext.add_provider_for_screen(screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    except Exception as exc:
        log_msg(f"GTK CSS warning (ignorado): {exc}")

    event_queue = queue.Queue()
    client = ContinuumMeshClient(cfg, event_queue, start_hub=start_hub)

    win = Gtk.Window(title=f"Continuum {APP_VERSION} — Malha Holográfica LAN")
    win.set_default_size(1160, 740)
    win.set_position(Gtk.WindowPosition.CENTER)
    win.get_style_context().add_class("root-bg")

    state = {
        "devices": [],
        "selected_id": None,
        "lan_peers": [],
        "active_tab": "map",
        "scanning": False,
        "scan_pct": 0,
        "phase": 0.0,
        "drag_dev_id": None,
        "drag_offset": (0.0, 0.0),
        "tp_last": None,
        "tp_moved": False,
        "tp_cursor": None,
        "tp_trail": [],
        "tp_ripples": [],
        "file_history": [],
    }

    root_hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
    win.add(root_hbox)

    # ==================== LEFT SIDEBAR ====================
    sidebar = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    sidebar.set_size_request(242, -1)
    sidebar.get_style_context().add_class("sidebar")
    sidebar.set_border_width(14)
    root_hbox.pack_start(sidebar, False, False, 0)

    brand_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
    lbl_brand = Gtk.Label(label="CONTINUUM")
    lbl_brand.set_xalign(0)
    lbl_brand.get_style_context().add_class("brand-title")
    lbl_sub = Gtk.Label(label=f"v{APP_VERSION} · Spatial LAN Mesh")
    lbl_sub.set_xalign(0)
    lbl_sub.get_style_context().add_class("brand-sub")
    brand_box.pack_start(lbl_brand, False, False, 0)
    brand_box.pack_start(lbl_sub, False, False, 0)
    sidebar.pack_start(brand_box, False, False, 6)

    nav_buttons = {}
    nav_items = [
        ("map", "Mapa Holográfico"),
        ("remote", "Trackpad & Controle"),
        ("transfer", "Arquivos & Clipboard"),
        ("network", "Radar LAN & Alertas"),
    ]

    main_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
    root_hbox.pack_start(main_vbox, True, True, 0)

    # Top Header Bar
    topbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    topbar.get_style_context().add_class("topbar")
    topbar.set_border_width(12)
    main_vbox.pack_start(topbar, False, False, 0)

    lbl_page_title = Gtk.Label(label="Mapa Espacial Holográfico")
    lbl_page_title.get_style_context().add_class("section-title")
    lbl_page_title.set_xalign(0)
    topbar.pack_start(lbl_page_title, True, True, 0)

    lbl_conn_status = Gtk.Label(label="◌ Inicializando Radar LAN...")
    lbl_conn_status.get_style_context().add_class("status-cyan")
    topbar.pack_start(lbl_conn_status, False, False, 6)

    btn_scan_top = Gtk.Button(label="Escanear Wi-Fi")
    btn_scan_top.get_style_context().add_class("btn-primary")
    btn_scan_top.connect("clicked", lambda _w: client.discovery.scan_subnet_tcp())
    topbar.pack_start(btn_scan_top, False, False, 0)

    entry_room_top = Gtk.Entry()
    entry_room_top.set_text(cfg.get("roomCode", DEFAULT_ROOM_CODE))
    entry_room_top.set_width_chars(8)
    topbar.pack_start(entry_room_top, False, False, 0)

    btn_apply_room = Gtk.Button(label="Malha")
    btn_apply_room.get_style_context().add_class("btn-secondary")
    topbar.pack_start(btn_apply_room, False, False, 0)

    stack = Gtk.Stack()
    stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
    stack.set_transition_duration(180)
    main_vbox.pack_start(stack, True, True, 0)

    page_titles = {
        "map": "Mapa Espacial Holográfico",
        "remote": "Superfície Tátil Holográfica & Mídia",
        "transfer": "Arquivos LAN & Área de Transferência",
        "network": "Radar Wi-Fi P2P & Alertas",
    }

    def switch_tab(tab_key):
        state["active_tab"] = tab_key
        stack.set_visible_child_name(tab_key)
        lbl_page_title.set_text(page_titles.get(tab_key, "Continuum"))
        for k, b in nav_buttons.items():
            ctx_b = b.get_style_context()
            if k == tab_key:
                ctx_b.remove_class("nav-btn")
                ctx_b.add_class("nav-btn-active")
            else:
                ctx_b.remove_class("nav-btn-active")
                ctx_b.add_class("nav-btn")

    for key, label in nav_items:
        btn = Gtk.Button(label=label)
        btn.get_child().set_xalign(0)
        btn.get_style_context().add_class("nav-btn")
        btn.connect("clicked", lambda _w, k=key: switch_tab(k))
        sidebar.pack_start(btn, False, False, 2)
        nav_buttons[key] = btn

    sidebar.pack_start(Gtk.Box(), True, True, 0)

    # Sidebar bottom Holographic Hub Card
    hub_card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5)
    hub_card.get_style_context().add_class("card-subtle")
    hub_card.set_border_width(11)
    lbl_hub_h = Gtk.Label(label="HUB LAN EMBUTIDO")
    lbl_hub_h.set_xalign(0)
    lbl_hub_h.get_style_context().add_class("brand-sub")
    lan_endpoint_str = f"{get_local_lan_ip()}:{client.hub.port}"
    lbl_hub_ip = Gtk.Label(label=lan_endpoint_str)
    lbl_hub_ip.set_xalign(0)
    lbl_hub_ip.set_selectable(True)
    lbl_hub_ip.get_style_context().add_class("mono")
    lbl_hub_meta = Gtk.Label(label=f"Malha {cfg.get('roomCode', DEFAULT_ROOM_CODE)} · 1 nó")
    lbl_hub_meta.set_xalign(0)
    lbl_hub_meta.get_style_context().add_class("muted")
    btn_copy_ip = Gtk.Button(label="Copiar Endereço LAN")
    btn_copy_ip.get_style_context().add_class("btn-secondary")
    btn_copy_ip.connect("clicked", lambda _w: (
        Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(f"{get_local_lan_ip()}:{client.hub.port}", -1),
        show_toast(f"Endereço {get_local_lan_ip()}:{client.hub.port} copiado!")
    ))
    hub_card.pack_start(lbl_hub_h, False, False, 0)
    hub_card.pack_start(lbl_hub_ip, False, False, 0)
    hub_card.pack_start(lbl_hub_meta, False, False, 0)
    hub_card.pack_start(btn_copy_ip, False, False, 2)
    sidebar.pack_end(hub_card, False, False, 0)

    toast_label = Gtk.Label(label="")
    toast_label.set_xalign(0)
    toast_label.get_style_context().add_class("muted")
    toast_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
    toast_box.set_border_width(7)
    toast_box.pack_start(toast_label, True, True, 8)
    main_vbox.pack_end(toast_box, False, False, 0)

    def show_toast(text):
        toast_label.set_text(text)

    def get_target_device():
        devs = state["devices"]
        if state["selected_id"]:
            for d in devs:
                if d.get("id") == state["selected_id"]:
                    return d
        for d in devs:
            if d.get("id") != DEVICE_ID:
                return d
        return devs[0] if devs else None

    # ==================== TAB 1: HOLOGRAPHIC SPATIAL MAP (CAIRO 60FPS) ====================
    tab_map = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
    tab_map.set_border_width(14)

    map_frame = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
    map_frame.get_style_context().add_class("card")
    map_canvas = Gtk.DrawingArea()
    map_canvas.set_size_request(660, 450)
    map_canvas.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK)
    map_frame.pack_start(map_canvas, True, True, 0)
    tab_map.pack_start(map_frame, True, True, 0)

    sel_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    sel_bar.get_style_context().add_class("card")
    sel_bar.set_border_width(12)
    lbl_selected = Gtk.Label(label="Radar holográfico ativo · Arraste dispositivos para posicionar no espaço.")
    lbl_selected.set_xalign(0)
    lbl_selected.get_style_context().add_class("muted")
    sel_bar.pack_start(lbl_selected, True, True, 0)

    btn_sel_ctrl = Gtk.Button(label="Controlar")
    btn_sel_ctrl.get_style_context().add_class("btn-primary")
    btn_sel_ping = Gtk.Button(label="Localizar")
    btn_sel_ping.get_style_context().add_class("btn-secondary")
    btn_sel_file = Gtk.Button(label="Enviar Arquivo")
    btn_sel_file.get_style_context().add_class("btn-secondary")
    sel_bar.pack_start(btn_sel_ctrl, False, False, 0)
    sel_bar.pack_start(btn_sel_ping, False, False, 0)
    sel_bar.pack_start(btn_sel_file, False, False, 0)
    tab_map.pack_start(sel_bar, False, False, 0)

    NODE_W = 212.0
    NODE_H = 116.0

    def node_rect(dev, idx):
        x = float(dev.get("x", 180 + (idx % 3) * 240))
        y = float(dev.get("y", 140 + (idx // 3) * 175))
        return (x - NODE_W / 2.0, y - NODE_H / 2.0, NODE_W, NODE_H, x, y)

    def draw_radial_gauge(cr, cx, cy, rad, pct, label, rgb):
        cr.set_line_width(3.4)
        cr.set_source_rgba(0.14, 0.22, 0.36, 0.8)
        cr.arc(cx, cy, rad, 0, 2 * math.pi)
        cr.stroke()
        if pct > 0:
            cr.set_source_rgb(*rgb)
            cr.arc(cx, cy, rad, -math.pi / 2.0, -math.pi / 2.0 + (min(100, pct) / 100.0) * 2 * math.pi)
            cr.stroke()
        cr.set_source_rgb(0.95, 0.97, 1.0)
        cr.select_font_face("Monospace", 0, 1)
        cr.set_font_size(9.5)
        txt = f"{pct}%"
        ext = cr.text_extents(txt)
        cr.move_to(cx - ext.width / 2.0, cy + 3.5)
        cr.show_text(txt)
        cr.set_source_rgb(0.55, 0.64, 0.77)
        cr.select_font_face("Sans", 0, 0)
        cr.set_font_size(9.5)
        cr.move_to(cx + rad + 6, cy + 3.5)
        cr.show_text(label)

    def draw_spatial_map(widget, cr):
        alloc = widget.get_allocation()
        w, h = float(alloc.width), float(alloc.height)
        cx, cy = w / 2.0, h / 2.0
        ph = state["phase"]

        # 1. Deep Space Radial Gradient
        bg = cairo.RadialGradient(cx, cy, 10, cx, cy, max(w, h) * 0.75)
        bg.add_color_stop_rgb(0.0, 0.051, 0.094, 0.176)
        bg.add_color_stop_rgb(1.0, 0.020, 0.031, 0.063)
        cr.set_source(bg)
        cr.rectangle(0, 0, w, h)
        cr.fill()

        # 2. Holographic Crosshair Matrix
        cr.set_source_rgba(0.133, 0.827, 0.933, 0.22)
        cr.set_line_width(1.0)
        for gx in range(32, int(w), 36):
            for gy in range(32, int(h), 36):
                cr.move_to(gx - 2.5, gy)
                cr.line_to(gx + 2.5, gy)
                cr.move_to(gx, gy - 2.5)
                cr.line_to(gx, gy + 2.5)
        cr.stroke()

        # 3. Concentric Holographic Radar Rings & Sweeping Beam
        max_r = min(w, h) * 0.44
        for i in range(1, 4):
            cr.set_source_rgba(0.133, 0.827, 0.933, 0.16 if state["scanning"] else 0.08)
            cr.set_line_width(1.1)
            cr.arc(cx, cy, max_r * (i / 3.0), 0, 2 * math.pi)
            cr.stroke()
        pulse_t = (ph * 0.45) % 1.0
        cr.set_source_rgba(0.133, 0.827, 0.933, (1.0 - pulse_t) * (0.45 if state["scanning"] else 0.22))
        cr.set_line_width(1.6)
        cr.arc(cx, cy, pulse_t * max_r, 0, 2 * math.pi)
        cr.stroke()

        if state["scanning"] or len(state["devices"]) <= 1:
            sweep_a = (ph * 2.1) % (2 * math.pi)
            cr.save()
            cr.move_to(cx, cy)
            cr.arc(cx, cy, max_r, sweep_a - 0.65, sweep_a)
            cr.close_path()
            cr.set_source_rgba(0.133, 0.827, 0.933, 0.14)
            cr.fill()
            cr.set_source_rgba(0.133, 0.827, 0.933, 0.65)
            cr.set_line_width(1.6)
            cr.move_to(cx, cy)
            cr.line_to(cx + math.cos(sweep_a) * max_r, cy + math.sin(sweep_a) * max_r)
            cr.stroke()
            cr.restore()

        devs = state["devices"]
        if not devs:
            cr.set_source_rgba(0.133, 0.827, 0.933, 0.85)
            cr.select_font_face("Sans", 0, 1)
            cr.set_font_size(13)
            msg = f"Radar Holográfico escaneando rede local... {state['scan_pct']}%" if state["scanning"] else "Aguardando dispositivos na rede Wi-Fi..."
            ext = cr.text_extents(msg)
            cr.move_to((w - ext.width) / 2.0, cy + max_r * 0.55)
            cr.show_text(msg)
            return False

        # 4. Glowing Bezier Links + Animated Energy Data Packets
        anchor = next((d for d in devs if d.get("id") == DEVICE_ID), devs[0])
        ax, ay = float(anchor.get("x", 180)), float(anchor.get("y", 140))
        for idx, d in enumerate(devs):
            if d.get("id") == anchor.get("id"):
                continue
            _, _, _, _, dx, dy = node_rect(d, idx)
            mx = (ax + dx) / 2.0
            is_sel = d.get("id") == state["selected_id"]

            lg = cairo.LinearGradient(ax, ay, dx, dy)
            lg.add_color_stop_rgba(0.0, 0.133, 0.827, 0.933, 0.35 if is_sel else 0.18)
            lg.add_color_stop_rgba(1.0, 0.545, 0.361, 0.965, 0.35 if is_sel else 0.18)
            cr.set_source(lg)
            cr.set_line_width(7.0 if is_sel else 4.0)
            cr.move_to(ax, ay)
            cr.curve_to(mx, ay, mx, dy, dx, dy)
            cr.stroke()

            lg2 = cairo.LinearGradient(ax, ay, dx, dy)
            lg2.add_color_stop_rgba(0.0, 0.133, 0.827, 0.933, 0.95 if is_sel else 0.65)
            lg2.add_color_stop_rgba(1.0, 0.545, 0.361, 0.965, 0.95 if is_sel else 0.65)
            cr.set_source(lg2)
            cr.set_line_width(2.0 if is_sel else 1.4)
            cr.move_to(ax, ay)
            cr.curve_to(mx, ay, mx, dy, dx, dy)
            cr.stroke()

            for k in range(2):
                t = (ph * 0.55 + k * 0.5) % 1.0
                px, py = cubic_pt(t, ax, ay, mx, ay, mx, dy, dx, dy)
                cr.set_source_rgba(0.133, 0.827, 0.933, 0.35)
                cr.arc(px, py, 6.0, 0, 2 * math.pi)
                cr.fill()
                cr.set_source_rgb(1.0, 1.0, 1.0)
                cr.arc(px, py, 2.2, 0, 2 * math.pi)
                cr.fill()

        # 5. Frosted Holographic Device Cards
        for idx, d in enumerate(devs):
            rx, ry, rw, rh, ncx, ncy = node_rect(d, idx)
            is_self = d.get("id") == DEVICE_ID
            is_sel = d.get("id") == state["selected_id"]
            os_name = str(d.get("os", "linux")).lower()
            tel = d.get("telemetry") or {}
            cpu = int(tel.get("cpuUsage") or 0)
            ram = int(tel.get("memoryUsagePercent") or 0)
            bat = tel.get("batteryLevel")

            if is_sel or is_self:
                cairo_rounded_rect(cr, rx - 1.5, ry - 1.5, rw + 3.0, rh + 3.0, 14.0)
                cr.set_source_rgba(0.133, 0.827, 0.933, 0.28) if is_sel else cr.set_source_rgba(0.063, 0.725, 0.506, 0.22)
                cr.set_line_width(6.0)
                cr.stroke()

            cairo_rounded_rect(cr, rx, ry, rw, rh, 13.0)
            fill_g = cairo.LinearGradient(rx, ry, rx + rw, ry + rh)
            if is_sel:
                fill_g.add_color_stop_rgba(0.0, 0.086, 0.141, 0.243, 0.93)
                fill_g.add_color_stop_rgba(1.0, 0.039, 0.059, 0.110, 0.95)
            else:
                fill_g.add_color_stop_rgba(0.0, 0.059, 0.090, 0.157, 0.90)
                fill_g.add_color_stop_rgba(1.0, 0.035, 0.051, 0.094, 0.92)
            cr.set_source(fill_g)
            cr.fill_preserve()

            border_g = cairo.LinearGradient(rx, ry, rx + rw, ry + rh)
            if is_sel:
                border_g.add_color_stop_rgb(0.0, 0.133, 0.827, 0.933)
                border_g.add_color_stop_rgb(0.5, 0.231, 0.510, 0.965)
                border_g.add_color_stop_rgb(1.0, 0.545, 0.361, 0.965)
                cr.set_line_width(1.9)
            elif is_self:
                border_g.add_color_stop_rgb(0.0, 0.063, 0.725, 0.506)
                border_g.add_color_stop_rgb(1.0, 0.133, 0.827, 0.933)
                cr.set_line_width(1.5)
            else:
                border_g.add_color_stop_rgb(0.0, 0.165, 0.282, 0.439)
                border_g.add_color_stop_rgb(1.0, 0.110, 0.176, 0.302)
                cr.set_line_width(1.1)
            cr.set_source(border_g)
            cr.stroke()

            # Hardware silhouette glyph
            ix, iy = rx + 14, ry + 14
            cr.set_source_rgb(0.133, 0.827, 0.933) if is_sel else (cr.set_source_rgb(0.063, 0.725, 0.506) if is_self else cr.set_source_rgb(0.376, 0.647, 0.980))
            cr.set_line_width(1.5)
            if os_name in ("android", "ios"):
                cairo_rounded_rect(cr, ix, iy, 12, 19, 2.5)
                cr.stroke()
            else:
                cairo_rounded_rect(cr, ix, iy, 18, 13, 2.0)
                cr.stroke()
                cr.move_to(ix + 5, iy + 16)
                cr.line_to(ix + 13, iy + 16)
                cr.stroke()

            cr.set_source_rgb(0.95, 0.97, 1.0)
            cr.select_font_face("Sans", 0, 1)
            cr.set_font_size(12.5)
            cr.move_to(rx + 40, ry + 24)
            cr.show_text(str(d.get("name") or "Dispositivo")[:18])

            cr.set_source_rgb(0.55, 0.64, 0.77)
            cr.select_font_face("Sans", 0, 0)
            cr.set_font_size(10)
            role_txt = "Este PC" if is_self else ("Alvo Ativo" if is_sel else "LAN Direta")
            sub = f"{os_name.upper()} · {role_txt}" + (f" · {bat}%" if bat is not None else "")
            cr.move_to(rx + 40, ry + 39)
            cr.show_text(sub)

            draw_radial_gauge(cr, rx + 42, ry + 80, 18.0, cpu, "CPU", (0.133, 0.827, 0.933))
            draw_radial_gauge(cr, rx + 132, ry + 80, 18.0, ram, "RAM", (0.545, 0.361, 0.965))

        return False

    def update_selected_bar():
        tgt = get_target_device()
        if tgt:
            tel = tgt.get("telemetry") or {}
            lbl_selected.set_text(
                f"Alvo ativo: {tgt.get('name')} ({str(tgt.get('os', '')).upper()}) · CPU {tel.get('cpuUsage', 0)}% · RAM {tel.get('memoryUsagePercent', 0)}%"
            )
            lbl_remote_target.set_text(f"Controlando: {tgt.get('name')} ({str(tgt.get('os', '')).upper()})")
        else:
            lbl_selected.set_text("Radar holográfico ativo · Abra o Continuum no Android ou Windows na mesma rede Wi-Fi.")
            lbl_remote_target.set_text("Alvo: aguardando dispositivo...")

    def on_map_press(_w, ev):
        devs = state["devices"]
        for idx in range(len(devs) - 1, -1, -1):
            d = devs[idx]
            rx, ry, rw, rh, ncx, ncy = node_rect(d, idx)
            if rx <= ev.x <= rx + rw and ry <= ev.y <= ry + rh:
                state["selected_id"] = d.get("id")
                state["drag_dev_id"] = d.get("id")
                state["drag_offset"] = (ncx - ev.x, ncy - ev.y)
                update_selected_bar()
                map_canvas.queue_draw()
                return True
        return False

    def on_map_motion(_w, ev):
        drag_id = state["drag_dev_id"]
        if not drag_id:
            return False
        alloc = map_canvas.get_allocation()
        nx = max(112.0, min(alloc.width - 112.0, ev.x + state["drag_offset"][0]))
        ny = max(66.0, min(alloc.height - 66.0, ev.y + state["drag_offset"][1]))
        for d in state["devices"]:
            if d.get("id") == drag_id:
                d["x"] = nx
                d["y"] = ny
                break
        map_canvas.queue_draw()
        return True

    def on_map_release(_w, _ev):
        drag_id = state["drag_dev_id"]
        state["drag_dev_id"] = None
        if drag_id:
            for d in state["devices"]:
                if d.get("id") == drag_id:
                    client.send({"type": "device:move", "deviceId": drag_id, "x": d.get("x", 180), "y": d.get("y", 140)})
                    break
        return True

    map_canvas.connect("draw", draw_spatial_map)
    map_canvas.connect("button-press-event", on_map_press)
    map_canvas.connect("motion-notify-event", on_map_motion)
    map_canvas.connect("button-release-event", on_map_release)
    stack.add_named(tab_map, "map")

    # ==================== TAB 2: HOLOGRAPHIC TRACKPAD & MEDIA ====================
    tab_remote = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
    tab_remote.set_border_width(14)

    remote_top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    lbl_remote_target = Gtk.Label(label="Alvo: aguardando dispositivo...")
    lbl_remote_target.set_xalign(0)
    lbl_remote_target.get_style_context().add_class("section-title")
    remote_top.pack_start(lbl_remote_target, True, True, 0)

    lbl_sens = Gtk.Label(label="Sensibilidade")
    lbl_sens.get_style_context().add_class("muted")
    scale_sens = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0.8, 3.2, 0.1)
    scale_sens.set_value(float(cfg.get("sensitivity", 1.6)))
    scale_sens.set_size_request(140, -1)
    scale_sens.set_draw_value(False)
    scale_sens.connect("value-changed", lambda s: cfg.__setitem__("sensitivity", round(s.get_value(), 2)))
    remote_top.pack_start(lbl_sens, False, False, 0)
    remote_top.pack_start(scale_sens, False, False, 0)
    tab_remote.pack_start(remote_top, False, False, 0)

    tp_card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
    tp_card.get_style_context().add_class("card")
    tp_canvas = Gtk.DrawingArea()
    tp_canvas.set_size_request(640, 330)
    tp_canvas.add_events(
        Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.SCROLL_MASK
    )
    tp_card.pack_start(tp_canvas, True, True, 0)
    tab_remote.pack_start(tp_card, True, True, 0)

    def draw_trackpad(widget, cr):
        alloc = widget.get_allocation()
        w, h = float(alloc.width), float(alloc.height)
        bg = cairo.RadialGradient(w / 2.0, h / 2.0, 10, w / 2.0, h / 2.0, max(w, h) * 0.72)
        bg.add_color_stop_rgb(0.0, 0.047, 0.086, 0.165)
        bg.add_color_stop_rgb(1.0, 0.020, 0.031, 0.063)
        cr.set_source(bg)
        cr.rectangle(0, 0, w, h)
        cr.fill()

        # Cyan precision dot matrix
        cr.set_source_rgba(0.133, 0.827, 0.933, 0.22)
        for gx in range(26, int(w), 26):
            for gy in range(26, int(h), 26):
                cr.arc(gx, gy, 1.0, 0, 2 * math.pi)
                cr.fill()

        # HUD Corner Brackets
        cr.set_source_rgba(0.133, 0.827, 0.933, 0.55)
        cr.set_line_width(2.0)
        m, b = 16.0, 20.0
        for (x0, y0, dx, dy) in [(m, m, b, b), (w - m, m, -b, b), (m, h - m, b, -b), (w - m, h - m, -b, -b)]:
            cr.move_to(x0, y0)
            cr.line_to(x0 + dx, y0)
            cr.move_to(x0, y0)
            cr.line_to(x0, y0 + dy)
        cr.stroke()

        if not state["tp_cursor"]:
            cr.set_source_rgba(0.55, 0.64, 0.77, 0.55)
            cr.select_font_face("Sans", 0, 0)
            cr.set_font_size(13)
            hint = "Superfície Tátil Holográfica · Arraste para mover · Clique Esq/Dir · Scroll"
            ext = cr.text_extents(hint)
            cr.move_to((w - ext.width) / 2.0, h / 2.0)
            cr.show_text(hint)

        now = time.time()
        # Luminous comet trail
        state["tp_trail"] = [(x, y, t0) for (x, y, t0) in state["tp_trail"] if now - t0 < 0.28]
        tr = state["tp_trail"]
        for i in range(1, len(tr)):
            p0, p1 = tr[i - 1], tr[i]
            age = (now - p1[2]) / 0.28
            cr.set_source_rgba(0.133, 0.827, 0.933, (1.0 - age) * 0.85)
            cr.set_line_width((1.0 - age) * 6.5 + 1.5)
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.move_to(p0[0], p0[1])
            cr.line_to(p1[0], p1[1])
            cr.stroke()

        # Multi-ring shockwaves
        alive = []
        for rx, ry, t0 in state["tp_ripples"]:
            age = now - t0
            if age < 0.48:
                p = age / 0.48
                cr.set_source_rgba(0.133, 0.827, 0.933, (1.0 - p) * 0.8)
                cr.set_line_width(2.0)
                cr.arc(rx, ry, 10.0 + p * 48.0, 0, 2 * math.pi)
                cr.stroke()
                cr.set_source_rgba(0.545, 0.361, 0.965, (1.0 - p) * 0.5)
                cr.arc(rx, ry, 6.0 + p * 30.0, 0, 2 * math.pi)
                cr.stroke()
                alive.append((rx, ry, t0))
        state["tp_ripples"] = alive

        if state["tp_cursor"]:
            cx, cy = state["tp_cursor"]
            g = cairo.RadialGradient(cx, cy, 2, cx, cy, 28)
            g.add_color_stop_rgba(0.0, 0.133, 0.827, 0.933, 0.65)
            g.add_color_stop_rgba(1.0, 0.133, 0.827, 0.933, 0.0)
            cr.set_source(g)
            cr.arc(cx, cy, 28.0, 0, 2 * math.pi)
            cr.fill()
            cr.set_source_rgb(1.0, 1.0, 1.0)
            cr.arc(cx, cy, 4.5, 0, 2 * math.pi)
            cr.fill()
        return False

    def send_remote(ev_payload):
        tgt = get_target_device()
        tid = tgt.get("id") if tgt else None
        if not tid:
            show_toast("Selecione um dispositivo alvo no Mapa Holográfico.")
            return
        client.send({"type": "input:event", "targetDeviceId": tid, "event": ev_payload})

    def on_tp_press(_w, ev):
        now = time.time()
        state["tp_cursor"] = (ev.x, ev.y)
        state["tp_trail"] = [(ev.x, ev.y, now)]
        state["tp_ripples"].append((ev.x, ev.y, now))
        if ev.button == 3:
            send_remote({"kind": "click", "button": "right"})
        else:
            state["tp_last"] = (ev.x, ev.y)
            state["tp_moved"] = False
        tp_canvas.queue_draw()
        return True

    def on_tp_motion(_w, ev):
        if state["tp_last"] is not None:
            sens = float(cfg.get("sensitivity", 1.6))
            dx = (ev.x - state["tp_last"][0]) * sens
            dy = (ev.y - state["tp_last"][1]) * sens
            state["tp_last"] = (ev.x, ev.y)
            state["tp_cursor"] = (ev.x, ev.y)
            state["tp_trail"].append((ev.x, ev.y, time.time()))
            if len(state["tp_trail"]) > 24:
                state["tp_trail"].pop(0)
            if abs(dx) > 0.4 or abs(dy) > 0.4:
                state["tp_moved"] = True
                send_remote({"kind": "move", "dx": round(dx, 2), "dy": round(dy, 2)})
            tp_canvas.queue_draw()
        return True

    def on_tp_release(_w, ev):
        if ev.button == 1 and state["tp_last"] is not None and not state["tp_moved"]:
            send_remote({"kind": "click", "button": "left"})
            state["tp_ripples"].append((ev.x, ev.y, time.time()))
        state["tp_last"] = None
        state["tp_cursor"] = None
        tp_canvas.queue_draw()
        return True

    def on_tp_scroll(_w, ev):
        if ev.direction == Gdk.ScrollDirection.UP:
            send_remote({"kind": "scroll", "dx": 0, "dy": -45})
        elif ev.direction == Gdk.ScrollDirection.DOWN:
            send_remote({"kind": "scroll", "dx": 0, "dy": 45})
        return True

    tp_canvas.connect("draw", draw_trackpad)
    tp_canvas.connect("button-press-event", on_tp_press)
    tp_canvas.connect("motion-notify-event", on_tp_motion)
    tp_canvas.connect("button-release-event", on_tp_release)
    tp_canvas.connect("scroll-event", on_tp_scroll)

    act_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
    actions = [
        ("Clique Esq", lambda: send_remote({"kind": "click", "button": "left"})),
        ("Clique Dir", lambda: send_remote({"kind": "click", "button": "right"})),
        ("Vol −", lambda: send_remote({"kind": "media", "action": "vol_down"})),
        ("Vol +", lambda: send_remote({"kind": "media", "action": "vol_up"})),
        ("Mudo", lambda: send_remote({"kind": "media", "action": "mute"})),
        ("Play/Pause", lambda: send_remote({"kind": "media", "action": "play_pause"})),
        ("Próxima", lambda: send_remote({"kind": "media", "action": "next"})),
        ("Bloquear", lambda: send_remote({"kind": "media", "action": "lock"})),
        ("Localizar", lambda: send_remote({"kind": "media", "action": "ping"})),
    ]
    for label, fn in actions:
        b = Gtk.Button(label=label)
        b.get_style_context().add_class("btn-secondary")
        b.connect("clicked", lambda _w, f=fn: f())
        act_row.pack_start(b, True, True, 0)
    tab_remote.pack_start(act_row, False, False, 0)

    kb_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
    entry_remote_text = Gtk.Entry()
    entry_remote_text.set_placeholder_text("Digite texto para enviar diretamente ao dispositivo alvo...")
    btn_send_text = Gtk.Button(label="Enviar Texto")
    btn_send_text.get_style_context().add_class("btn-primary")
    btn_send_enter = Gtk.Button(label="Enter")
    btn_send_enter.get_style_context().add_class("btn-secondary")

    def do_send_text(*_args):
        txt = entry_remote_text.get_text()
        if txt:
            send_remote({"kind": "text", "text": txt})
            entry_remote_text.set_text("")

    entry_remote_text.connect("activate", do_send_text)
    btn_send_text.connect("clicked", do_send_text)
    btn_send_enter.connect("clicked", lambda _w: send_remote({"kind": "key", "key": "Enter"}))
    kb_row.pack_start(entry_remote_text, True, True, 0)
    kb_row.pack_start(btn_send_text, False, False, 0)
    kb_row.pack_start(btn_send_enter, False, False, 0)
    tab_remote.pack_start(kb_row, False, False, 0)
    stack.add_named(tab_remote, "remote")

    # ==================== TAB 3: FILES & CLIPBOARD ====================
    tab_transfer = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    tab_transfer.set_border_width(14)

    file_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
    file_col.get_style_context().add_class("card")
    file_col.set_border_width(14)
    lbl_fh = Gtk.Label(label="Transferência Direta LAN")
    lbl_fh.set_xalign(0)
    lbl_fh.get_style_context().add_class("section-title")
    file_btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
    btn_pick_file = Gtk.Button(label="Escolher e Enviar Arquivo")
    btn_pick_file.get_style_context().add_class("btn-primary")
    btn_open_dl = Gtk.Button(label="Abrir Downloads")
    btn_open_dl.get_style_context().add_class("btn-secondary")
    file_btn_row.pack_start(btn_pick_file, True, True, 0)
    file_btn_row.pack_start(btn_open_dl, False, False, 0)

    file_progress = Gtk.ProgressBar()
    file_progress.set_show_text(True)
    file_progress.set_text("Pronto para transferência LAN")

    file_scroll = Gtk.ScrolledWindow()
    file_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
    file_listbox = Gtk.ListBox()
    file_listbox.set_selection_mode(Gtk.SelectionMode.NONE)
    file_scroll.add(file_listbox)
    file_col.pack_start(lbl_fh, False, False, 0)
    file_col.pack_start(file_btn_row, False, False, 0)
    file_col.pack_start(file_progress, False, False, 0)
    file_col.pack_start(file_scroll, True, True, 0)
    tab_transfer.pack_start(file_col, True, True, 0)

    def choose_and_send_file(*_args):
        dlg = Gtk.FileChooserDialog(title="Enviar Arquivo pela Rede Local", parent=win, action=Gtk.FileChooserAction.OPEN)
        dlg.add_buttons(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL, Gtk.STOCK_OPEN, Gtk.ResponseType.OK)
        if dlg.run() == Gtk.ResponseType.OK:
            fpath = dlg.get_filename()
            if fpath and os.path.isfile(fpath):
                tgt = get_target_device()
                tid = tgt.get("id") if tgt and tgt.get("id") != DEVICE_ID else None
                client.send_file(fpath, target_id=tid)
                show_toast(f"Enviando {os.path.basename(fpath)} via LAN...")
        dlg.destroy()

    btn_pick_file.connect("clicked", choose_and_send_file)
    btn_open_dl.connect("clicked", lambda _w: (os.makedirs(DOWNLOADS_DIR, exist_ok=True), run_cmd(["xdg-open", DOWNLOADS_DIR])))

    clip_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
    clip_col.get_style_context().add_class("card")
    clip_col.set_border_width(14)
    lbl_ch = Gtk.Label(label="Área de Transferência Universal")
    lbl_ch.set_xalign(0)
    lbl_ch.get_style_context().add_class("section-title")

    clip_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
    entry_clip = Gtk.Entry()
    entry_clip.set_placeholder_text("Cole ou digite texto para compartilhar...")
    btn_push_clip = Gtk.Button(label="Enviar")
    btn_push_clip.get_style_context().add_class("btn-primary")
    btn_grab_clip = Gtk.Button(label="Capturar")
    btn_grab_clip.get_style_context().add_class("btn-secondary")
    clip_row.pack_start(entry_clip, True, True, 0)
    clip_row.pack_start(btn_push_clip, False, False, 0)
    clip_row.pack_start(btn_grab_clip, False, False, 0)

    clip_scroll = Gtk.ScrolledWindow()
    clip_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
    clip_listbox = Gtk.ListBox()
    clip_listbox.set_selection_mode(Gtk.SelectionMode.NONE)
    clip_scroll.add(clip_listbox)
    clip_col.pack_start(lbl_ch, False, False, 0)
    clip_col.pack_start(clip_row, False, False, 0)
    clip_col.pack_start(clip_scroll, True, True, 0)
    tab_transfer.pack_start(clip_col, True, True, 0)

    def push_clip_text(txt):
        txt = (txt or "").strip()
        if not txt:
            return
        client.send({"type": "clipboard:push", "content": txt, "sourceDeviceId": DEVICE_ID, "sourceDeviceName": f"{HOSTNAME} (Linux)"})
        show_toast("Texto sincronizado com toda a malha LAN.")

    btn_push_clip.connect("clicked", lambda _w: (push_clip_text(entry_clip.get_text()), entry_clip.set_text("")))
    btn_grab_clip.connect("clicked", lambda _w: push_clip_text(Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text()))
    stack.add_named(tab_transfer, "transfer")

    # ==================== TAB 4: HYBRID LAN RADAR & ALERTS ====================
    tab_net = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
    tab_net.set_border_width(14)

    lan_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
    lan_col.get_style_context().add_class("card")
    lan_col.set_border_width(14)
    lbl_lh = Gtk.Label(label="Radar Híbrido Wi-Fi / LAN (UDP + TCP /24)")
    lbl_lh.set_xalign(0)
    lbl_lh.get_style_context().add_class("section-title")
    lbl_ls = Gtk.Label(
        label=f"Hub Linux ativo em {get_local_lan_ip()}:{client.hub.port}. Se o firewall do Linux (UFW) estiver ativo, copie o comando abaixo ou deixe o Radar conectar automaticamente ao Android/Windows."
    )
    lbl_ls.set_xalign(0)
    lbl_ls.set_line_wrap(True)
    lbl_ls.get_style_context().add_class("muted")

    fw_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
    btn_scan_net = Gtk.Button(label="Escanear Rede LAN Agora")
    btn_scan_net.get_style_context().add_class("btn-primary")
    btn_scan_net.connect("clicked", lambda _w: client.discovery.scan_subnet_tcp())
    btn_copy_ufw = Gtk.Button(label="Copiar Comando UFW (45890/45891)")
    btn_copy_ufw.get_style_context().add_class("btn-secondary")
    btn_copy_ufw.connect("clicked", lambda _w: (
        Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text("sudo ufw allow 45891/tcp && sudo ufw allow 45890/udp", -1),
        show_toast("Comando UFW copiado para a área de transferência!")
    ))
    fw_row.pack_start(btn_scan_net, True, True, 0)
    fw_row.pack_start(btn_copy_ufw, False, False, 0)

    manual_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
    entry_manual_ip = Gtk.Entry()
    entry_manual_ip.set_text(cfg.get("manualPeer", ""))
    entry_manual_ip.set_placeholder_text("IP do peer (aceita 192.168.1.x, .42, http:// ou ws://)")
    btn_connect_ip = Gtk.Button(label="Conectar")
    btn_connect_ip.get_style_context().add_class("btn-primary")
    btn_auto_lan = Gtk.Button(label="Auto LAN")
    btn_auto_lan.get_style_context().add_class("btn-secondary")
    manual_row.pack_start(entry_manual_ip, True, True, 0)
    manual_row.pack_start(btn_connect_ip, False, False, 0)
    manual_row.pack_start(btn_auto_lan, False, False, 0)

    peers_scroll = Gtk.ScrolledWindow()
    peers_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
    peers_listbox = Gtk.ListBox()
    peers_listbox.set_selection_mode(Gtk.SelectionMode.NONE)
    peers_scroll.add(peers_listbox)

    lan_col.pack_start(lbl_lh, False, False, 0)
    lan_col.pack_start(lbl_ls, False, False, 0)
    lan_col.pack_start(fw_row, False, False, 0)
    lan_col.pack_start(manual_row, False, False, 0)
    lan_col.pack_start(peers_scroll, True, True, 0)
    tab_net.pack_start(lan_col, True, True, 0)

    alert_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
    alert_col.get_style_context().add_class("card")
    alert_col.set_border_width(14)
    lbl_ah = Gtk.Label(label="Alertas & Ponte OS")
    lbl_ah.set_xalign(0)
    lbl_ah.get_style_context().add_class("section-title")
    ds = detect_display_server()
    xdo_ok = "Ativo" if shutil.which("xdotool") else "Instale xdotool"
    lbl_os_diag = Gtk.Label(label=f"Sessão: {ds.upper()} · Controle X11: {xdo_ok}")
    lbl_os_diag.set_xalign(0)
    lbl_os_diag.get_style_context().add_class("muted")
    btn_send_alert = Gtk.Button(label="Enviar Alerta de Teste")
    btn_send_alert.get_style_context().add_class("btn-secondary")
    btn_send_alert.connect("clicked", lambda _w: client.send({
        "type": "notification:push",
        "title": f"Alerta de {HOSTNAME}",
        "body": "Comunicação holográfica LAN ativa.",
        "sourceDeviceId": DEVICE_ID,
        "sourceDeviceName": f"{HOSTNAME} (Linux)",
    }))
    notif_scroll = Gtk.ScrolledWindow()
    notif_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
    notif_listbox = Gtk.ListBox()
    notif_listbox.set_selection_mode(Gtk.SelectionMode.NONE)
    notif_scroll.add(notif_listbox)
    alert_col.pack_start(lbl_ah, False, False, 0)
    alert_col.pack_start(lbl_os_diag, False, False, 0)
    alert_col.pack_start(btn_send_alert, False, False, 0)
    alert_col.pack_start(notif_scroll, True, True, 0)
    tab_net.pack_start(alert_col, True, True, 0)
    stack.add_named(tab_net, "network")

    btn_sel_ctrl.connect("clicked", lambda _w: switch_tab("remote"))
    btn_sel_ping.connect("clicked", lambda _w: send_remote({"kind": "media", "action": "ping"}))
    btn_sel_file.connect("clicked", choose_and_send_file)
    btn_apply_room.connect("clicked", lambda _w: client.set_connection_mode(entry_room_top.get_text(), entry_manual_ip.get_text(), auto_lan=not bool(entry_manual_ip.get_text().strip())))
    btn_connect_ip.connect("clicked", lambda _w: client.set_connection_mode(entry_room_top.get_text(), entry_manual_ip.get_text(), auto_lan=False))
    btn_auto_lan.connect("clicked", lambda _w: (entry_manual_ip.set_text(""), client.set_connection_mode(entry_room_top.get_text(), "", auto_lan=True)))

    def rebuild_clipboard(items):
        for child in clip_listbox.get_children():
            clip_listbox.remove(child)
        for item in items[:25]:
            box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            box.get_style_context().add_class("card-subtle")
            box.set_border_width(8)
            txt = str(item.get("content", ""))
            l1 = Gtk.Label(label=f"[{item.get('sourceDeviceName', 'Peer')}] {txt.replace(chr(10), ' ')[:110]}")
            l1.set_xalign(0)
            l1.set_line_wrap(True)
            btn_c = Gtk.Button(label="Copiar")
            btn_c.get_style_context().add_class("btn-secondary")
            btn_c.connect("clicked", lambda _b, c=txt: (Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(c, -1), show_toast("Copiado!")))
            box.pack_start(l1, True, True, 0)
            box.pack_start(btn_c, False, False, 0)
            clip_listbox.add(box)
        clip_listbox.show_all()

    def rebuild_lan_peers(peers):
        for child in peers_listbox.get_children():
            peers_listbox.remove(child)
        if not peers:
            lbl = Gtk.Label(label="Nenhum outro dispositivo encontrado ainda. Clique em Escanear Rede LAN Agora.")
            lbl.set_line_wrap(True)
            lbl.set_xalign(0)
            lbl.get_style_context().add_class("muted")
            peers_listbox.add(lbl)
        else:
            for p in peers:
                box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
                box.get_style_context().add_class("card-subtle")
                box.set_border_width(8)
                vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
                l1 = Gtk.Label(label=f"{p.get('hubName')} ({str(p.get('os','')).upper()})")
                l1.set_xalign(0)
                l2 = Gtk.Label(label=f"{p.get('ip')}:{p.get('wsPort')} · {p.get('via', 'LAN')} · {p.get('roomCode')}")
                l2.set_xalign(0)
                l2.get_style_context().add_class("mono")
                vbox.pack_start(l1, False, False, 0)
                vbox.pack_start(l2, False, False, 0)
                btn_conn = Gtk.Button(label="Conectar")
                btn_conn.get_style_context().add_class("btn-primary")
                ep = f"{p.get('ip')}:{p.get('wsPort')}"
                btn_conn.connect("clicked", lambda _b, e=ep, rm=p.get("roomCode"): (
                    entry_room_top.set_text(rm),
                    entry_manual_ip.set_text(e),
                    client.set_connection_mode(rm, e, auto_lan=False),
                ))
                box.pack_start(vbox, True, True, 0)
                box.pack_start(btn_conn, False, False, 0)
                peers_listbox.add(box)
        peers_listbox.show_all()

    def rebuild_notifications(items):
        for child in notif_listbox.get_children():
            notif_listbox.remove(child)
        for n in items[:25]:
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            box.get_style_context().add_class("card-subtle")
            box.set_border_width(8)
            l1 = Gtk.Label(label=f"{n.get('title', 'Alerta')} · {n.get('sourceDeviceName', '')}")
            l1.set_xalign(0)
            l2 = Gtk.Label(label=str(n.get("body", "")))
            l2.set_xalign(0)
            l2.set_line_wrap(True)
            l2.get_style_context().add_class("muted")
            box.pack_start(l1, False, False, 0)
            box.pack_start(l2, False, False, 0)
            notif_listbox.add(box)
        notif_listbox.show_all()

    def add_file_history(rec):
        state["file_history"].insert(0, rec)
        for child in file_listbox.get_children():
            file_listbox.remove(child)
        for f in state["file_history"][:20]:
            box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            box.get_style_context().add_class("card-subtle")
            box.set_border_width(8)
            tag = "Enviado" if f.get("dir") == "send" else "Recebido"
            kb = max(1, round(int(f.get("size", 0)) / 1024))
            l1 = Gtk.Label(label=f"{tag}: {f.get('name')} ({kb} KB)")
            l1.set_xalign(0)
            box.pack_start(l1, True, True, 0)
            file_listbox.add(box)
        file_listbox.show_all()

    def tick_animation():
        state["phase"] = (state["phase"] + 0.033) % 1000.0
        if state["active_tab"] == "map":
            map_canvas.queue_draw()
        elif state["active_tab"] == "remote" and (state["tp_ripples"] or state["tp_trail"]):
            tp_canvas.queue_draw()
        try:
            while True:
                etype, data = event_queue.get_nowait()
                if etype == "status":
                    st = data.get("state")
                    hub = data.get("hub", "LAN")
                    ctx_s = lbl_conn_status.get_style_context()
                    if st == "connected":
                        ctx_s.remove_class("status-cyan")
                        ctx_s.add_class("status-ok")
                        rtt_str = f" · {client.rtt_ms} ms" if client.rtt_ms else ""
                        lbl_conn_status.set_text(f"● {hub}{rtt_str}")
                    else:
                        ctx_s.remove_class("status-ok")
                        ctx_s.add_class("status-cyan")
                        lbl_conn_status.set_text(f"◌ Conectando ({hub})...")
                elif etype == "scan":
                    state["scanning"] = bool(data.get("scanning"))
                    state["scan_pct"] = int(data.get("pct", 0))
                    if state["scanning"]:
                        show_toast(f"Radar Wi-Fi escaneando rede local... {state['scan_pct']}%")
                    else:
                        show_toast(f"Varredura concluída · {len(state['lan_peers'])} peer(s) detectado(s) na rede local.")
                elif etype == "rtt":
                    if client.connected:
                        lbl_conn_status.set_text(f"● {client.connected_hub_label} · {data} ms")
                elif etype == "devices":
                    state["devices"] = data
                    if not state["selected_id"]:
                        other = next((d for d in data if d.get("id") != DEVICE_ID), None)
                        if other:
                            state["selected_id"] = other.get("id")
                    lbl_hub_meta.set_text(f"Malha {cfg.get('roomCode')} · {len(data)} nó(s)")
                    update_selected_bar()
                elif etype == "clipboard":
                    rebuild_clipboard(data)
                elif etype == "notifications":
                    rebuild_notifications(data)
                elif etype == "lan_peers":
                    state["lan_peers"] = data
                    rebuild_lan_peers(data)
                elif etype == "file_progress":
                    pct = max(0, min(100, int(data.get("pct", 0))))
                    file_progress.set_fraction(pct / 100.0)
                    verb = "Enviando" if data.get("dir") == "send" else "Recebendo"
                    file_progress.set_text(f"{verb} {data.get('name')} · {pct}%")
                elif etype == "file_done":
                    file_progress.set_fraction(1.0)
                    file_progress.set_text(f"Concluído: {data.get('name')}")
                    add_file_history(data)
                elif etype == "toast":
                    show_toast(str(data))
        except queue.Empty:
            pass
        return True

    switch_tab("map")
    rebuild_lan_peers([])
    win.connect("destroy", lambda *_a: (client.stop(), Gtk.main_quit()))
    win.show_all()
    client.start()
    GLib.timeout_add(33, tick_animation)
    Gtk.main()


def run_tk_app(cfg, start_hub=True):
    import tkinter as tk
    event_queue = queue.Queue()
    client = ContinuumMeshClient(cfg, event_queue, start_hub=start_hub)
    root = tk.Tk()
    root.title(f"Continuum {APP_VERSION} — Malha Holográfica LAN")
    root.geometry("920x620")
    root.configure(bg="#050810")
    top = tk.Frame(root, bg="#0A101E", pady=10, padx=14)
    top.pack(fill="x")
    tk.Label(top, text=f"CONTINUUM v{APP_VERSION} · LAN {get_local_lan_ip()}:{client.hub.port}", fg="#22D3EE", bg="#0A101E", font=("Sans", 12, "bold")).pack(side="left")
    lbl_st = tk.Label(top, text="Conectando...", fg="#22D3EE", bg="#0A101E")
    lbl_st.pack(side="right")
    dev_list = tk.Listbox(root, bg="#0E1628", fg="#F1F5F9", selectbackground="#3B82F6", borderwidth=0)
    dev_list.pack(fill="both", expand=True, padx=14, pady=14)

    def poll():
        try:
            while True:
                etype, data = event_queue.get_nowait()
                if etype == "status":
                    lbl_st.config(text=f"{data.get('state')} · {data.get('hub')}", fg="#10B981" if data.get("state") == "connected" else "#22D3EE")
                elif etype == "devices":
                    dev_list.delete(0, "end")
                    for d in data:
                        dev_list.insert("end", f"{d.get('name')} ({d.get('os')}) — CPU {d.get('telemetry', {}).get('cpuUsage', 0)}%")
        except queue.Empty:
            pass
        root.after(150, poll)

    root.protocol("WM_DELETE_WINDOW", lambda: (client.stop(), root.destroy()))
    client.start()
    root.after(150, poll)
    root.mainloop()


def show_fatal_dialog(message):
    log_msg(f"FATAL: {message}")
    if shutil.which("zenity"):
        run_cmd(["zenity", "--error", "--title=Continuum", "--text=" + message, "--width=420"])
    elif shutil.which("kdialog"):
        run_cmd(["kdialog", "--error", message, "--title", "Continuum"])
    print(f"[Continuum] {message}", file=sys.stderr)


def main():
    cfg = load_config()
    args = sys.argv[1:]
    headless = "--bridge-only" in args
    hub_only = "--hub-only" in args

    for i, a in enumerate(args):
        if a == "--room" and i + 1 < len(args):
            cfg["roomCode"] = args[i + 1].upper()
        elif a == "--connect" and i + 1 < len(args):
            cfg["manualPeer"] = args[i + 1]
            cfg["autoLan"] = False
        elif a == "--port" and i + 1 < len(args):
            cfg["wsPort"] = int(args[i + 1])

    if hub_only:
        hub = EmbeddedLanHub(port=int(cfg.get("wsPort") or LAN_WS_PORT), get_room_fn=lambda: cfg.get("roomCode", DEFAULT_ROOM_CODE))
        ok = hub.start()
        disc = LanDiscoveryService(hub, lambda: cfg.get("roomCode", DEFAULT_ROOM_CODE))
        disc.start()
        print(f"[Continuum] Hub LAN v{APP_VERSION} ativo={ok} em {get_local_lan_ip()}:{hub.port} (malha {cfg.get('roomCode')})", flush=True)
        try:
            while True:
                time.sleep(1.0)
        except KeyboardInterrupt:
            disc.stop()
            hub.stop()
        return

    if headless:
        eq = queue.Queue()
        start_hub = not bool(cfg.get("manualPeer"))
        client = ContinuumMeshClient(cfg, eq, start_hub=start_hub)
        client.start()
        print(f"[Continuum] Cliente headless v{APP_VERSION} iniciado (id={DEVICE_ID}, room={cfg.get('roomCode')})", flush=True)
        try:
            while True:
                try:
                    etype, data = eq.get(timeout=0.5)
                    if etype in ("status", "devices", "clipboard", "rtt"):
                        print(f"[EVENT] {etype}: {json.dumps(data, ensure_ascii=False)[:220]}", flush=True)
                except queue.Empty:
                    pass
        except KeyboardInterrupt:
            client.stop()
        return

    try:
        run_gtk_app(cfg, start_hub=True)
    except Exception as gtk_exc:
        log_msg(f"GTK 3 indisponivel ({gtk_exc}); tentando fallback Tkinter...")
        try:
            run_tk_app(cfg, start_hub=True)
        except Exception as tk_exc:
            show_fatal_dialog(f"Não foi possível abrir a interface gráfica do Continuum.\\n\\nGTK 3: {gtk_exc}\\nTkinter: {tk_exc}")
            sys.exit(1)


if __name__ == "__main__":
    main()
`;
}
