import type { InstallerContext } from './platformInstallers.ts';
import type { ZipEntryInput } from './zipBuilder.ts';

function safeStr(val: string): string {
  return val.replace(/[`'"\\$<>|;&\r\n]/g, '');
}

/**
 * 100% NATIVE LINUX DESKTOP APPLICATION (Python 3 + Native GTK 3 — ZERO WebView / ZERO Browser)
 * Speaks the real Continuum Mesh WebSocket protocol (/ws), renders a native dark GTK 3 UI
 * (Devices, Remote Trackpad/Keyboard, Universal Clipboard & File Transfer, Telemetry & Alerts),
 * and executes native Linux OS control (X11 xdotool, PipeWire/PulseAudio, playerctl, notify-send)
 * inside the same single process. Also supports `--bridge-only` for headless/automated testing.
 */
export function buildLinuxNativeAppPy(ctx: InstallerContext): string {
  const room = safeStr(ctx.roomCode);
  const wsUrl = safeStr(ctx.wsUrl);
  const appUrl = safeStr(ctx.appUrl).replace(/\/+$/, '');

  return `#!/usr/bin/env python3
"""
Continuum Native Linux Desktop Application (GTK 3 + Pure Python 3 Stdlib)
Aplicativo nativo real para Linux (Zorin OS, Ubuntu, Mint, Debian, Fedora, Arch) — SEM navegador e SEM WebView.
"""

import base64
import datetime
import glob
import json
import os
import queue
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.parse

DEFAULT_SERVER_URL = ${JSON.stringify(appUrl)}
DEFAULT_WS_URL = ${JSON.stringify(wsUrl)}
DEFAULT_ROOM_CODE = ${JSON.stringify(room)}

HOSTNAME = socket.gethostname() or "Estacao Linux"
DEVICE_ID = "linux-app-" + "".join(c for c in HOSTNAME.lower() if c.isalnum())[:16]
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
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\\n")
    except Exception:
        pass


def load_config():
    cfg = {
        "serverUrl": os.environ.get("CONTINUUM_SERVER_URL") or DEFAULT_SERVER_URL,
        "roomCode": os.environ.get("CONTINUUM_ROOM_CODE") or DEFAULT_ROOM_CODE,
        "deviceName": f"{HOSTNAME} (Linux)",
    }
    try:
        if os.path.exists(CONFIG_FILE):
            saved = json.load(open(CONFIG_FILE, "r", encoding="utf-8"))
            if isinstance(saved, dict):
                cfg.update({k: v for k, v in saved.items() if v})
    except Exception:
        pass
    cfg["serverUrl"] = str(cfg["serverUrl"]).strip().rstrip("/")
    cfg["roomCode"] = "".join(c for c in str(cfg["roomCode"]).upper() if c.isalnum())[:8] or "MESH01"
    return cfg


def save_config(cfg):
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception as exc:
        log_msg(f"Erro ao salvar config: {exc}")


def server_to_ws(server_url):
    env_ws = os.environ.get("CONTINUUM_WS_URL")
    if env_ws:
        return env_ws
    try:
        p = urllib.parse.urlparse(server_url)
        proto = "wss" if p.scheme == "https" else "ws"
        if p.netloc:
            return f"{proto}://{p.netloc}/ws"
    except Exception:
        pass
    return DEFAULT_WS_URL


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
            out = subprocess.check_output(
                ["xdotool", "getdisplaygeometry"], stderr=subprocess.DEVNULL, timeout=1.0
            ).decode("utf-8", "ignore").strip()
            parts = out.split()
            if len(parts) == 2:
                return int(parts[0]), int(parts[1])
    except Exception:
        pass
    return 1920, 1080


def list_open_windows():
    apps = []
    try:
        if shutil.which("wmctrl"):
            out = subprocess.check_output(["wmctrl", "-l"], stderr=subprocess.DEVNULL, timeout=1.5).decode("utf-8", "ignore")
            for idx, line in enumerate(out.splitlines()[:8]):
                parts = line.split(None, 3)
                if len(parts) >= 4:
                    title = parts[3].strip()
                    apps.append({
                        "id": f"lin-{parts[0]}",
                        "name": title.split(" - ")[-1][:24],
                        "title": title[:64],
                        "focused": idx == 0,
                        "source": "os-agent",
                    })
    except Exception:
        pass
    return apps


def collect_telemetry(rtt_ms=None):
    mem_total, mem_used = sample_memory_gb()
    bat_level, bat_charging = sample_battery()
    return {
        "batteryLevel": bat_level,
        "batteryCharging": bat_charging,
        "cpuCores": os.cpu_count() or 1,
        "cpuUsage": sample_cpu_percent(),
        "memoryTotalGb": mem_total,
        "memoryUsedGb": mem_used,
        "rttMs": rtt_ms,
        "volume": 72,
        "brightness": 85,
        "displayServer": detect_display_server(),
        "companionLastSeenAt": int(time.time() * 1000),
        "openApps": list_open_windows(),
    }


def run_cmd(args):
    try:
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def adjust_linux_volume(direction):
    if shutil.which("wpctl"):
        if direction == "up":
            run_cmd(["wpctl", "set-volume", "-l", "1.5", "@DEFAULT_AUDIO_SINK@", "5%+"])
        elif direction == "down":
            run_cmd(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"])
        elif direction == "mute":
            run_cmd(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"])
        return
    if shutil.which("pactl"):
        if direction == "up":
            run_cmd(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "+5%"])
        elif direction == "down":
            run_cmd(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "-5%"])
        elif direction == "mute":
            run_cmd(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle"])


def handle_native_os_input(evt):
    if not isinstance(evt, dict):
        return
    kind = evt.get("kind")
    has_xdotool = shutil.which("xdotool") is not None

    if kind == "move" and has_xdotool:
        if evt.get("dx") is not None and evt.get("dy") is not None:
            run_cmd(["xdotool", "mousemove_relative", "--", str(int(evt["dx"])), str(int(evt["dy"]))])
        elif evt.get("nx") is not None and evt.get("ny") is not None:
            sw, sh = get_display_geometry()
            tx = max(0, min(sw - 1, int(float(evt["nx"]) * sw)))
            ty = max(0, min(sh - 1, int(float(evt["ny"]) * sh)))
            run_cmd(["xdotool", "mousemove", "--sync", str(tx), str(ty)])
    elif kind == "click" and has_xdotool:
        if evt.get("nx") is not None and evt.get("ny") is not None:
            sw, sh = get_display_geometry()
            tx = max(0, min(sw - 1, int(float(evt["nx"]) * sw)))
            ty = max(0, min(sh - 1, int(float(evt["ny"]) * sh)))
            run_cmd(["xdotool", "mousemove", "--sync", str(tx), str(ty)])
        btn = "3" if evt.get("button") == "right" else "1"
        run_cmd(["xdotool", "click", btn])
    elif kind == "scroll" and has_xdotool:
        dy = float(evt.get("dy", 0))
        btn = "5" if dy > 0 else "4"
        steps = max(1, min(6, int(abs(dy) / 30) or 1))
        run_cmd(["xdotool", "click", "--repeat", str(steps), btn])
    elif kind == "text" and evt.get("text") and has_xdotool:
        run_cmd(["xdotool", "type", "--clearmodifiers", "--delay", "2", str(evt["text"])])
    elif kind == "key" and evt.get("key") and has_xdotool:
        kmap = {
            "Enter": "Return",
            "Backspace": "BackSpace",
            "Tab": "Tab",
            "Escape": "Escape",
            "ArrowUp": "Up",
            "ArrowDown": "Down",
            "ArrowLeft": "Left",
            "ArrowRight": "Right",
        }
        key = kmap.get(evt["key"], str(evt["key"]))
        parts = []
        if evt.get("ctrl"):
            parts.append("ctrl")
        if evt.get("alt"):
            parts.append("alt")
        parts.append(key)
        run_cmd(["xdotool", "key", "+".join(parts)])
    elif kind == "command":
        act = evt.get("action")
        if act == "vol_up":
            adjust_linux_volume("up")
        elif act == "vol_down":
            adjust_linux_volume("down")
        elif act == "vol_mute":
            adjust_linux_volume("mute")
        elif act == "media_play_pause" and shutil.which("playerctl"):
            run_cmd(["playerctl", "play-pause"])
        elif act == "media_next" and shutil.which("playerctl"):
            run_cmd(["playerctl", "next"])
        elif act == "media_prev" and shutil.which("playerctl"):
            run_cmd(["playerctl", "previous"])
        elif act == "lock":
            if shutil.which("loginctl"):
                run_cmd(["loginctl", "lock-session"])
        elif act == "ping":
            if shutil.which("notify-send"):
                run_cmd(["notify-send", "Continuum", "Alerta de localizacao disparado neste computador."])
        elif act == "open_url":
            url = str(evt.get("payload") or "")
            if url.startswith("http://") or url.startswith("https://"):
                run_cmd(["xdg-open", url])


class RawWebSocket:
    """RFC-6455 compliant pure-stdlib WebSocket client with TLS SNI & multi-frame reassembly."""

    def __init__(self, url):
        parsed = urllib.parse.urlparse(url)
        self.ssl_enabled = parsed.scheme == "wss"
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or (443 if self.ssl_enabled else 80)
        self.path = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
        default_port = (self.ssl_enabled and self.port == 443) or (not self.ssl_enabled and self.port == 80)
        self.host_header = self.host if default_port else f"{self.host}:{self.port}"
        self.origin = f"{'https' if self.ssl_enabled else 'http'}://{self.host_header}"
        self._lock = threading.Lock()
        self.sock = None

    def connect(self):
        raw = socket.create_connection((self.host, self.port), timeout=10)
        if self.ssl_enabled:
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(raw, server_hostname=self.host)
        else:
            self.sock = raw
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {self.path} HTTP/1.1\\r\\n"
            f"Host: {self.host_header}\\r\\n"
            f"Origin: {self.origin}\\r\\n"
            f"Upgrade: websocket\\r\\n"
            f"Connection: Upgrade\\r\\n"
            f"Sec-WebSocket-Key: {key}\\r\\n"
            f"Sec-WebSocket-Version: 13\\r\\n\\r\\n"
        )
        self.sock.sendall(req.encode("ascii"))
        resp = b""
        while b"\\r\\n\\r\\n" not in resp:
            chunk = self.sock.recv(1024)
            if not chunk:
                raise ConnectionError("Handshake fechado pelo servidor")
            resp += chunk
        status_line = resp.split(b"\\r\\n", 1)[0].decode("ascii", "ignore")
        if " 101 " not in status_line:
            raise ConnectionError(f"Handshake rejeitado: {status_line}")
        self.sock.settimeout(0.25)

    def _send_frame(self, opcode, payload):
        with self._lock:
            if not self.sock:
                return
            mask = os.urandom(4)
            header = bytearray([0x80 | opcode])
            n = len(payload)
            if n < 126:
                header.append(0x80 | n)
            elif n < 65536:
                header.append(0x80 | 126)
                header.extend(struct.pack("!H", n))
            else:
                header.append(0x80 | 127)
                header.extend(struct.pack("!Q", n))
            header.extend(mask)
            masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            self.sock.sendall(bytes(header) + masked)

    def send_json(self, obj):
        self._send_frame(0x1, json.dumps(obj).encode("utf-8"))

    def send_ping(self):
        self._send_frame(0x9, b"ping")

    def _recv_exact(self, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("Conexao encerrada")
            buf.extend(chunk)
        return bytes(buf)

    def recv_text(self):
        fragments = []
        while True:
            try:
                b1, b2 = self._recv_exact(2)
            except socket.timeout:
                if fragments:
                    continue
                return None
            fin = (b1 & 0x80) != 0
            opcode = b1 & 0x0F
            masked = (b2 & 0x80) != 0
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            mask_key = self._recv_exact(4) if masked else None
            data = self._recv_exact(length) if length > 0 else b""
            if mask_key:
                data = bytes(b ^ mask_key[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:
                raise ConnectionError("Servidor fechou WebSocket")
            if opcode == 0x9:
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x0):
                fragments.append(data)
                if fin:
                    return b"".join(fragments).decode("utf-8", "ignore")

    def close(self):
        with self._lock:
            if self.sock:
                try:
                    self.sock.close()
                except Exception:
                    pass
                self.sock = None


class MeshClientThread(threading.Thread):
    def __init__(self, cfg, on_event):
        super().__init__(daemon=True)
        self.cfg = dict(cfg)
        self.on_event = on_event
        self.stop_evt = threading.Event()
        self.reconnect_evt = threading.Event()
        self.outbox = queue.Queue()
        self.rtt_ms = None
        self.pending_files = {}

    def reconfigure(self, new_cfg):
        self.cfg = dict(new_cfg)
        self.reconnect_evt.set()

    def send(self, obj):
        self.outbox.put(obj)

    def stop(self):
        self.stop_evt.set()

    def send_file(self, file_path, to_device_id="all", to_device_name="Todos os dispositivos"):
        def _worker():
            try:
                size = os.path.getsize(file_path)
                name = os.path.basename(file_path)
                tr_id = f"file-{int(time.time() * 1000)}"
                record = {
                    "id": tr_id,
                    "fileName": name,
                    "fileSize": size,
                    "mimeType": "application/octet-stream",
                    "fromDeviceId": DEVICE_ID,
                    "fromDeviceName": self.cfg.get("deviceName") or HOSTNAME,
                    "toDeviceId": to_device_id,
                    "toDeviceName": to_device_name,
                    "status": "transferring",
                    "progress": 0,
                    "speedMbps": 0,
                    "createdAt": int(time.time() * 1000),
                }
                self.send({"type": "file:start", "record": record})
                chunk_size = 48 * 1024
                total_chunks = max(1, (size + chunk_size - 1) // chunk_size)
                started = time.time()
                with open(file_path, "rb") as f:
                    for idx in range(total_chunks):
                        raw = f.read(chunk_size)
                        b64 = base64.b64encode(raw).decode("ascii")
                        sent_bytes = min(size, (idx + 1) * chunk_size)
                        elapsed = max(0.05, time.time() - started)
                        speed = round((sent_bytes / (1024 * 1024)) / elapsed, 2)
                        prog = min(99, round(((idx + 1) / total_chunks) * 100))
                        self.send({
                            "type": "file:chunk",
                            "transferId": tr_id,
                            "toDeviceId": to_device_id,
                            "chunkIndex": idx,
                            "totalChunks": total_chunks,
                            "data": b64,
                            "progress": prog,
                            "speedMbps": speed,
                        })
                        time.sleep(0.005)
                self.send({"type": "file:complete", "transferId": tr_id, "toDeviceId": to_device_id})
                self.on_event({"type": "local:toast", "message": f"Arquivo enviado: {name}"})
            except Exception as exc:
                self.on_event({"type": "local:toast", "message": f"Erro ao enviar arquivo: {exc}"})

        threading.Thread(target=_worker, daemon=True).start()

    def _handle_incoming(self, msg):
        t = msg.get("type")
        if t == "telemetry:pong":
            sent = msg.get("sentAt")
            if isinstance(sent, (int, float)):
                self.rtt_ms = max(1, int((time.time() * 1000) - sent))
                self.on_event({"type": "local:rtt", "rttMs": self.rtt_ms})
            return

        if t == "input:event" or t == "companion:input":
            handle_native_os_input(msg.get("input"))
            return

        if t == "file:start":
            rec = msg.get("record") or {}
            if rec.get("fromDeviceId") != DEVICE_ID and rec.get("id"):
                self.pending_files[rec["id"]] = {"record": rec, "chunks": {}, "total": 0}
        elif t == "file:chunk":
            tr_id = msg.get("transferId")
            asm = self.pending_files.get(tr_id)
            if asm is not None:
                asm["total"] = int(msg.get("totalChunks") or 0)
                asm["chunks"][int(msg.get("chunkIndex") or 0)] = str(msg.get("data") or "")
        elif t == "file:complete":
            tr_id = msg.get("transferId")
            asm = self.pending_files.pop(tr_id, None)
            if asm is not None:
                try:
                    os.makedirs(DOWNLOADS_DIR, exist_ok=True)
                    safe_name = os.path.basename(asm["record"].get("fileName") or f"continuum-{tr_id}.bin")
                    dest = os.path.join(DOWNLOADS_DIR, safe_name)
                    with open(dest, "wb") as out_f:
                        for i in range(asm["total"]):
                            part = asm["chunks"].get(i)
                            if part:
                                out_f.write(base64.b64decode(part))
                    self.on_event({"type": "local:file_saved", "path": dest, "fileName": safe_name})
                    if shutil.which("notify-send"):
                        run_cmd(["notify-send", "Continuum — Arquivo Recebido", f"Salvo em {dest}"])
                except Exception as exc:
                    log_msg(f"Erro ao salvar arquivo recebido: {exc}")

        if t == "notification:added":
            notif = msg.get("notification") or {}
            if notif.get("sourceDeviceId") != DEVICE_ID and shutil.which("notify-send"):
                run_cmd(["notify-send", f"Continuum ({notif.get('app', 'App')})", f"{notif.get('title', '')}: {notif.get('body', '')}"])

        self.on_event(msg)

    def run(self):
        while not self.stop_evt.is_set():
            self.reconnect_evt.clear()
            ws_url = server_to_ws(self.cfg["serverUrl"])
            room = self.cfg["roomCode"]
            ws = RawWebSocket(ws_url)
            try:
                self.on_event({"type": "local:status", "state": "connecting", "wsUrl": ws_url})
                ws.connect()
                log_msg(f"Conectado em {ws_url} (Malha {room})")
                sw, sh = get_display_geometry()
                ws.send_json({
                    "type": "mesh:join",
                    "roomCode": room,
                    "device": {
                        "id": DEVICE_ID,
                        "name": self.cfg.get("deviceName") or f"{HOSTNAME} (Linux)",
                        "os": "linux",
                        "formFactor": "desktop",
                        "screenWidth": sw,
                        "screenHeight": sh,
                        "pixelRatio": 1,
                        "orientation": "landscape",
                        "companionConnected": True,
                        "telemetry": collect_telemetry(self.rtt_ms),
                    },
                })
                ws.send_json({"type": "telemetry:ping", "sentAt": time.time() * 1000})
                self.on_event({"type": "local:status", "state": "connected", "wsUrl": ws_url})

                last_tel = time.time()
                last_ping = time.time()

                while not self.stop_evt.is_set() and not self.reconnect_evt.is_set():
                    while True:
                        try:
                            item = self.outbox.get_nowait()
                            ws.send_json(item)
                        except queue.Empty:
                            break

                    txt = ws.recv_text()
                    if txt:
                        try:
                            self._handle_incoming(json.loads(txt))
                        except Exception:
                            pass

                    now = time.time()
                    if now - last_tel >= 4.0:
                        last_tel = now
                        ws.send_json({"type": "telemetry:ping", "sentAt": now * 1000})
                        ws.send_json({
                            "type": "device:update",
                            "deviceId": DEVICE_ID,
                            "patch": {"telemetry": collect_telemetry(self.rtt_ms)},
                        })
                    if now - last_ping >= 20.0:
                        last_ping = now
                        ws.send_ping()
            except Exception as exc:
                log_msg(f"Desconectado ({ws_url}): {exc}")
                self.on_event({"type": "local:status", "state": "reconnecting", "error": str(exc)})
            finally:
                ws.close()

            for _ in range(30):
                if self.stop_evt.is_set() or self.reconnect_evt.is_set():
                    break
                time.sleep(0.1)


def run_gtk_app():
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gdk, GLib, Gtk

    css = b"""
    window, .background { background-color: #090B0E; color: #F1F5F9; }
    headerbar { background-color: #0D1015; color: #F1F5F9; border-bottom: 1px solid #222936; }
    .card { background-color: #11151B; border: 1px solid #222936; border-radius: 6px; padding: 12px; }
    entry, textview, textview text { background-color: #0D1015; color: #F1F5F9; border: 1px solid #222936; border-radius: 5px; }
    button { background-color: #171C24; color: #F1F5F9; border: 1px solid #222936; border-radius: 5px; padding: 6px 12px; }
    button:hover { border-color: #3B82F6; }
    button.primary { background-color: #3B82F6; color: #FFFFFF; border-color: #3B82F6; }
    button.primary:hover { background-color: #2563EB; }
    .muted { color: #94A3B8; font-size: 12px; }
    .ok { color: #16A34A; font-weight: bold; }
    .warn { color: #D97706; font-weight: bold; }
    """
    provider = Gtk.CssProvider()
    provider.load_from_data(css)
    Gtk.StyleContext.add_provider_for_screen(
        Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )

    class ContinuumWindow(Gtk.Window):
        def __init__(self):
            super().__init__(title="Continuum — Aplicativo Nativo Linux")
            self.set_default_size(980, 680)
            self.set_border_width(0)

            self.cfg = load_config()
            self.devices = []
            self.clipboard_items = []
            self.notifications = []
            self.target_device_id = None
            self._drag_last = None

            header = Gtk.HeaderBar()
            header.set_show_close_button(True)
            header.props.title = "Continuum"
            header.props.subtitle = f"App Nativo Linux · {detect_display_server().upper()}"
            self.set_titlebar(header)

            self.status_lbl = Gtk.Label(label="Conectando...")
            header.pack_end(self.status_lbl)

            root_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
            root_box.set_margin_top(12)
            root_box.set_margin_bottom(12)
            root_box.set_margin_start(14)
            root_box.set_margin_end(14)
            self.add(root_box)

            # Top Connection Bar
            conn_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            conn_bar.get_style_context().add_class("card")
            self.server_entry = Gtk.Entry()
            self.server_entry.set_text(self.cfg["serverUrl"])
            self.server_entry.set_hexpand(True)
            self.server_entry.set_placeholder_text("https://servidor-continuum")

            self.room_entry = Gtk.Entry()
            self.room_entry.set_text(self.cfg["roomCode"])
            self.room_entry.set_width_chars(10)
            self.room_entry.set_max_length(8)

            apply_btn = Gtk.Button(label="Conectar")
            apply_btn.get_style_context().add_class("primary")
            apply_btn.connect("clicked", self.on_apply_connection)

            conn_bar.pack_start(Gtk.Label(label="Servidor:"), False, False, 0)
            conn_bar.pack_start(self.server_entry, True, True, 0)
            conn_bar.pack_start(Gtk.Label(label="Malha:"), False, False, 0)
            conn_bar.pack_start(self.room_entry, False, False, 0)
            conn_bar.pack_start(apply_btn, False, False, 0)
            root_box.pack_start(conn_bar, False, False, 0)

            # Tabs Stack
            stack = Gtk.Stack()
            stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
            switcher = Gtk.StackSwitcher()
            switcher.set_stack(stack)
            root_box.pack_start(switcher, False, False, 0)
            root_box.pack_start(stack, True, True, 0)

            # Tab 1: Devices Mesh
            self.devices_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
            dev_scroll = Gtk.ScrolledWindow()
            dev_scroll.add(self.devices_box)
            stack.add_titled(dev_scroll, "devices", "Dispositivos")

            # Tab 2: Remote Control (Trackpad + Keyboard + Media)
            remote_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
            target_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            target_row.pack_start(Gtk.Label(label="Alvo:"), False, False, 0)
            self.target_combo = Gtk.ComboBoxText()
            self.target_combo.connect("changed", self.on_target_changed)
            target_row.pack_start(self.target_combo, True, True, 0)
            remote_box.pack_start(target_row, False, False, 0)

            self.trackpad = Gtk.DrawingArea()
            self.trackpad.set_size_request(-1, 240)
            self.trackpad.add_events(
                Gdk.EventMask.BUTTON_PRESS_MASK
                | Gdk.EventMask.BUTTON_RELEASE_MASK
                | Gdk.EventMask.POINTER_MOTION_MASK
                | Gdk.EventMask.SCROLL_MASK
            )
            self.trackpad.connect("draw", self.on_draw_trackpad)
            self.trackpad.connect("button-press-event", self.on_trackpad_press)
            self.trackpad.connect("button-release-event", self.on_trackpad_release)
            self.trackpad.connect("motion-notify-event", self.on_trackpad_motion)
            self.trackpad.connect("scroll-event", self.on_trackpad_scroll)
            remote_box.pack_start(self.trackpad, True, True, 0)

            click_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            b_left = Gtk.Button(label="Clique Esquerdo")
            b_left.connect("clicked", lambda *_: self.send_input({"kind": "click", "button": "left"}))
            b_right = Gtk.Button(label="Clique Direito")
            b_right.connect("clicked", lambda *_: self.send_input({"kind": "click", "button": "right"}))
            b_vol_d = Gtk.Button(label="Vol -")
            b_vol_d.connect("clicked", lambda *_: self.send_input({"kind": "command", "action": "vol_down"}))
            b_vol_u = Gtk.Button(label="Vol +")
            b_vol_u.connect("clicked", lambda *_: self.send_input({"kind": "command", "action": "vol_up"}))
            b_play = Gtk.Button(label="Play/Pause")
            b_play.connect("clicked", lambda *_: self.send_input({"kind": "command", "action": "media_play_pause"}))
            b_lock = Gtk.Button(label="Bloquear")
            b_lock.connect("clicked", lambda *_: self.send_input({"kind": "command", "action": "lock"}))
            for btn in (b_left, b_right, b_vol_d, b_vol_u, b_play, b_lock):
                click_row.pack_start(btn, True, True, 0)
            remote_box.pack_start(click_row, False, False, 0)

            kb_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            self.kb_entry = Gtk.Entry()
            self.kb_entry.set_placeholder_text("Digite texto para enviar ao dispositivo selecionado...")
            self.kb_entry.connect("activate", self.on_send_text)
            send_txt_btn = Gtk.Button(label="Enviar Texto")
            send_txt_btn.get_style_context().add_class("primary")
            send_txt_btn.connect("clicked", self.on_send_text)
            ent_btn = Gtk.Button(label="Enter")
            ent_btn.connect("clicked", lambda *_: self.send_input({"kind": "key", "key": "Enter"}))
            bs_btn = Gtk.Button(label="Backspace")
            bs_btn.connect("clicked", lambda *_: self.send_input({"kind": "key", "key": "Backspace"}))
            kb_row.pack_start(self.kb_entry, True, True, 0)
            kb_row.pack_start(send_txt_btn, False, False, 0)
            kb_row.pack_start(ent_btn, False, False, 0)
            kb_row.pack_start(bs_btn, False, False, 0)
            remote_box.pack_start(kb_row, False, False, 0)
            stack.add_titled(remote_box, "remote", "Controle Remoto")

            # Tab 3: Clipboard & Files
            cf_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
            file_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            send_file_btn = Gtk.Button(label="Enviar Arquivo para a Malha...")
            send_file_btn.get_style_context().add_class("primary")
            send_file_btn.connect("clicked", self.on_pick_file)
            open_dl_btn = Gtk.Button(label="Abrir Pasta de Recebidos")
            open_dl_btn.connect("clicked", lambda *_: (os.makedirs(DOWNLOADS_DIR, exist_ok=True), run_cmd(["xdg-open", DOWNLOADS_DIR])))
            grab_clip_btn = Gtk.Button(label="Capturar Clipboard do Linux")
            grab_clip_btn.connect("clicked", self.on_capture_clipboard)
            file_bar.pack_start(send_file_btn, False, False, 0)
            file_bar.pack_start(open_dl_btn, False, False, 0)
            file_bar.pack_end(grab_clip_btn, False, False, 0)
            cf_box.pack_start(file_bar, False, False, 0)

            clip_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            self.clip_entry = Gtk.Entry()
            self.clip_entry.set_placeholder_text("Cole texto ou link para sincronizar com todos os aparelhos...")
            self.clip_entry.connect("activate", self.on_push_clipboard)
            push_clip_btn = Gtk.Button(label="Sincronizar")
            push_clip_btn.connect("clicked", self.on_push_clipboard)
            clip_row.pack_start(self.clip_entry, True, True, 0)
            clip_row.pack_start(push_clip_btn, False, False, 0)
            cf_box.pack_start(clip_row, False, False, 0)

            self.clip_list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
            clip_scroll = Gtk.ScrolledWindow()
            clip_scroll.add(self.clip_list)
            cf_box.pack_start(clip_scroll, True, True, 0)
            stack.add_titled(cf_box, "files", "Arquivos & Clipboard")

            # Tab 4: Notifications & Diagnostics
            notif_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
            self.diag_lbl = Gtk.Label(
                label=f"Ponte Nativa Ativa · Sessao: {detect_display_server().upper()} · Log: {LOG_FILE}"
            )
            self.diag_lbl.set_xalign(0)
            notif_box.pack_start(self.diag_lbl, False, False, 0)
            self.notif_list = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
            notif_scroll = Gtk.ScrolledWindow()
            notif_scroll.add(self.notif_list)
            notif_box.pack_start(notif_scroll, True, True, 0)
            stack.add_titled(notif_box, "alerts", "Sistema & Alertas")

            self.footer_lbl = Gtk.Label(label=f"Downloads recebidos salvos em: {DOWNLOADS_DIR}")
            self.footer_lbl.set_xalign(0)
            self.footer_lbl.get_style_context().add_class("muted")
            root_box.pack_end(self.footer_lbl, False, False, 0)

            self.client = MeshClientThread(self.cfg, lambda ev: GLib.idle_add(self.on_mesh_event, ev))
            self.client.start()
            self.connect("destroy", self.on_quit)

        def on_quit(self, *_):
            self.client.stop()
            Gtk.main_quit()

        def on_apply_connection(self, *_):
            url = self.server_entry.get_text().strip().rstrip("/")
            room = "".join(c for c in self.room_entry.get_text().upper() if c.isalnum())[:8]
            if not (url.startswith("http://") or url.startswith("https://")) or len(room) < 4:
                self.footer_lbl.set_text("Informe uma URL valida (http/https) e codigo de malha com 4+ caracteres.")
                return
            self.cfg["serverUrl"] = url
            self.cfg["roomCode"] = room
            save_config(self.cfg)
            self.client.reconfigure(self.cfg)
            self.footer_lbl.set_text(f"Reconectando em {url} (Malha {room})...")

        def on_target_changed(self, combo):
            self.target_device_id = combo.get_active_id()

        def send_input(self, payload):
            if not self.target_device_id:
                self.footer_lbl.set_text("Selecione um dispositivo alvo na aba Controle Remoto.")
                return
            self.client.send({"type": "input:event", "toDeviceId": self.target_device_id, "input": payload})

        def on_draw_trackpad(self, widget, cr):
            alloc = widget.get_allocation()
            cr.set_source_rgb(0.067, 0.082, 0.106)
            cr.rectangle(0, 0, alloc.width, alloc.height)
            cr.fill()
            cr.set_source_rgb(0.133, 0.161, 0.212)
            cr.set_line_width(1.5)
            cr.rectangle(1, 1, alloc.width - 2, alloc.height - 2)
            cr.stroke()
            cr.set_source_rgb(0.58, 0.64, 0.72)
            cr.move_to(16, 28)
            cr.show_text("Trackpad Nativo — arraste para mover o cursor remoto · clique esquerdo/direito · role")

        def on_trackpad_press(self, _w, ev):
            self._drag_last = (ev.x, ev.y)
            self._press_pos = (ev.x, ev.y)
            return True

        def on_trackpad_motion(self, _w, ev):
            if self._drag_last is None:
                return False
            dx = (ev.x - self._drag_last[0]) * 1.8
            dy = (ev.y - self._drag_last[1]) * 1.8
            self._drag_last = (ev.x, ev.y)
            if abs(dx) >= 1 or abs(dy) >= 1:
                self.send_input({"kind": "move", "nx": 0.5, "ny": 0.5, "dx": round(dx), "dy": round(dy)})
            return True

        def on_trackpad_release(self, _w, ev):
            if self._press_pos and abs(ev.x - self._press_pos[0]) < 4 and abs(ev.y - self._press_pos[1]) < 4:
                btn = "right" if ev.button == 3 else "left"
                self.send_input({"kind": "click", "button": btn})
            self._drag_last = None
            return True

        def on_trackpad_scroll(self, _w, ev):
            dy = 90 if ev.direction == Gdk.ScrollDirection.DOWN else -90
            self.send_input({"kind": "scroll", "dx": 0, "dy": dy})
            return True

        def on_send_text(self, *_):
            txt = self.kb_entry.get_text()
            if txt:
                self.send_input({"kind": "text", "text": txt})
                self.kb_entry.set_text("")

        def on_capture_clipboard(self, *_):
            cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            txt = cb.wait_for_text()
            if txt and txt.strip():
                self._push_clip_text(txt.strip())

        def on_push_clipboard(self, *_):
            txt = self.clip_entry.get_text().strip()
            if txt:
                self._push_clip_text(txt)
                self.clip_entry.set_text("")

        def _push_clip_text(self, txt):
            item = {
                "id": f"clip-{int(time.time() * 1000)}",
                "content": txt,
                "kind": "url" if txt.startswith("http") else "text",
                "sourceDeviceId": DEVICE_ID,
                "sourceDeviceName": self.cfg.get("deviceName") or HOSTNAME,
                "createdAt": int(time.time() * 1000),
            }
            self.client.send({"type": "clipboard:push", "item": item})

        def on_pick_file(self, *_):
            dialog = Gtk.FileChooserDialog(
                title="Selecionar arquivo para enviar na malha",
                parent=self,
                action=Gtk.FileChooserAction.OPEN,
            )
            dialog.add_buttons(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL, Gtk.STOCK_OPEN, Gtk.ResponseType.OK)
            if dialog.run() == Gtk.ResponseType.OK:
                path = dialog.get_filename()
                if path:
                    self.client.send_file(path, self.target_device_id or "all")
            dialog.destroy()

        def rebuild_devices(self):
            for child in self.devices_box.get_children():
                self.devices_box.remove(child)
            prev_target = self.target_device_id
            self.target_combo.remove_all()

            for dev in self.devices:
                tel = dev.get("telemetry") or {}
                row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
                row.get_style_context().add_class("card")
                left = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
                is_self = dev.get("id") == DEVICE_ID
                title = f"{dev.get('name', 'Dispositivo')}" + (" (Este Linux)" if is_self else "")
                lbl_t = Gtk.Label(label=title)
                lbl_t.set_xalign(0)
                cpu = f"CPU {tel['cpuUsage']}%" if tel.get("cpuUsage") is not None else "CPU —"
                mem = f"RAM {tel['memoryUsedGb']}/{tel['memoryTotalGb']} GB" if tel.get("memoryTotalGb") else "RAM —"
                bat = f"Bat {tel['batteryLevel']}%" if tel.get("batteryLevel") is not None else "CA"
                ds = str(tel.get("displayServer") or "web").upper()
                lbl_s = Gtk.Label(label=f"{str(dev.get('os', '')).upper()} · {ds} · {cpu} · {mem} · {bat}")
                lbl_s.set_xalign(0)
                lbl_s.get_style_context().add_class("muted")
                left.pack_start(lbl_t, False, False, 0)
                left.pack_start(lbl_s, False, False, 0)
                row.pack_start(left, True, True, 0)

                if not is_self:
                    self.target_combo.append(dev["id"], dev.get("name", dev["id"]))
                    ping_btn = Gtk.Button(label="Localizar")
                    ping_btn.connect(
                        "clicked",
                        lambda _b, did=dev["id"]: self.client.send({
                            "type": "input:event",
                            "toDeviceId": did,
                            "input": {"kind": "command", "action": "ping"},
                        }),
                    )
                    row.pack_end(ping_btn, False, False, 0)

                self.devices_box.pack_start(row, False, False, 0)

            if prev_target:
                self.target_combo.set_active_id(prev_target)
            if self.target_combo.get_active_id() is None:
                self.target_combo.set_active(0)
            self.devices_box.show_all()

        def rebuild_clipboard(self):
            for child in self.clip_list.get_children():
                self.clip_list.remove(child)
            for item in self.clipboard_items[:25]:
                row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
                row.get_style_context().add_class("card")
                txt = str(item.get("content") or "")
                lbl = Gtk.Label(label=f"[{item.get('sourceDeviceName', 'Malha')}] {txt[:110]}")
                lbl.set_xalign(0)
                lbl.set_line_wrap(True)
                copy_btn = Gtk.Button(label="Copiar")
                copy_btn.connect(
                    "clicked",
                    lambda _b, content=txt: (
                        Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(content, -1),
                        self.footer_lbl.set_text("Texto copiado para a area de transferencia do Linux."),
                    ),
                )
                row.pack_start(lbl, True, True, 0)
                row.pack_end(copy_btn, False, False, 0)
                self.clip_list.pack_start(row, False, False, 0)
            self.clip_list.show_all()

        def rebuild_notifications(self):
            for child in self.notif_list.get_children():
                self.notif_list.remove(child)
            for n in self.notifications[:25]:
                row = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
                row.get_style_context().add_class("card")
                t = Gtk.Label(label=f"{n.get('app', 'App')} · {n.get('sourceDeviceName', '')} — {n.get('title', '')}")
                t.set_xalign(0)
                b = Gtk.Label(label=str(n.get("body") or ""))
                b.set_xalign(0)
                b.get_style_context().add_class("muted")
                row.pack_start(t, False, False, 0)
                if n.get("body"):
                    row.pack_start(b, False, False, 0)
                self.notif_list.pack_start(row, False, False, 0)
            self.notif_list.show_all()

        def on_mesh_event(self, msg):
            t = msg.get("type")
            if t == "local:status":
                st = msg.get("state")
                if st == "connected":
                    self.status_lbl.set_text(f"Conectado · Malha {self.cfg['roomCode']}")
                elif st == "reconnecting":
                    self.status_lbl.set_text("Reconectando...")
                    if msg.get("error"):
                        self.footer_lbl.set_text(f"Conexao: {msg['error']}")
                else:
                    self.status_lbl.set_text("Conectando...")
            elif t == "local:rtt":
                self.status_lbl.set_text(f"Conectado · {self.cfg['roomCode']} · {msg['rttMs']} ms")
            elif t == "local:toast":
                self.footer_lbl.set_text(msg.get("message", ""))
            elif t == "local:file_saved":
                self.footer_lbl.set_text(f"Arquivo recebido e salvo em: {msg['path']}")
            elif t == "mesh:init":
                snap = msg.get("snapshot") or {}
                self.devices = snap.get("devices") or []
                self.clipboard_items = snap.get("clipboard") or []
                self.notifications = snap.get("notifications") or []
                self.rebuild_devices()
                self.rebuild_clipboard()
                self.rebuild_notifications()
            elif t == "mesh:devices_sync":
                self.devices = msg.get("devices") or []
                self.rebuild_devices()
            elif t == "device:joined":
                dev = msg.get("device")
                if dev:
                    self.devices = [d for d in self.devices if d.get("id") != dev.get("id")] + [dev]
                    self.rebuild_devices()
            elif t == "device:updated":
                dev = msg.get("device")
                if dev:
                    self.devices = [dev if d.get("id") == dev.get("id") else d for d in self.devices]
                    self.rebuild_devices()
            elif t == "device:left":
                did = msg.get("deviceId")
                self.devices = [d for d in self.devices if d.get("id") != did]
                self.rebuild_devices()
            elif t == "clipboard:added":
                item = msg.get("item")
                if item:
                    self.clipboard_items = [item] + [c for c in self.clipboard_items if c.get("id") != item.get("id")]
                    self.rebuild_clipboard()
            elif t == "clipboard:deleted":
                cid = msg.get("id")
                self.clipboard_items = [c for c in self.clipboard_items if c.get("id") != cid]
                self.rebuild_clipboard()
            elif t == "notification:added":
                n = msg.get("notification")
                if n:
                    self.notifications = [n] + [x for x in self.notifications if x.get("id") != n.get("id")]
                    self.rebuild_notifications()
            return False

    win = ContinuumWindow()
    win.show_all()
    Gtk.main()


def main():
    if "--bridge-only" in sys.argv:
        cfg = load_config()
        client = MeshClientThread(cfg, lambda _ev: None)
        client.start()
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            client.stop()
        return

    try:
        run_gtk_app()
    except Exception as exc:
        log_msg(f"GTK 3 indisponivel ({exc}); mantendo ponte nativa ativa em segundo plano.")
        cfg = load_config()
        client = MeshClientThread(cfg, lambda _ev: None)
        client.start()
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            client.stop()


if __name__ == "__main__":
    main()
`;
}

/**
 * 100% NATIVE WINDOWS C# / .NET 8 DESKTOP APPLICATION (WinForms + Win32 P/Invoke — ZERO Browser / ZERO WebView)
 * Compiles to a single standalone Continuum-Windows.exe via `dotnet publish` on GitHub Actions!
 */
export function buildWindowsNativeCsproj(): string {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>Continuum</AssemblyName>
    <Version>2.0.0</Version>
    <ApplicationIcon>continuum.ico</ApplicationIcon>
    <PublishSingleFile>true</PublishSingleFile>
    <SelfContained>true</SelfContained>
    <IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>
    <EnableCompressionInSingleFile>true</EnableCompressionInSingleFile>
  </PropertyGroup>
</Project>
`;
}

export function buildWindowsNativeProgramCs(ctx: InstallerContext): string {
  const room = safeStr(ctx.roomCode);
  const serverUrl = safeStr(ctx.appUrl).replace(/\/+$/, '');

  return `using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ContinuumNative;

internal static class Win32Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] public static extern bool LockWorkStation();
}

internal sealed class AppConfig
{
    public string ServerUrl { get; set; } = ${JSON.stringify(serverUrl)};
    public string RoomCode { get; set; } = ${JSON.stringify(room)};
}

internal sealed class MeshDevice
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Os { get; set; } = "";
    public string DisplayServer { get; set; } = "web";
    public string CpuText { get; set; } = "—";
    public string BatteryText { get; set; } = "CA";
}

internal sealed class ContinuumMainForm : Form
{
    private static readonly string ConfigDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Continuum");
    private static readonly string ConfigPath = Path.Combine(ConfigDir, "config.json");
    private static readonly string LogPath = Path.Combine(ConfigDir, "app.log");
    private static readonly string DownloadsDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Continuum");

    private readonly string _deviceId = "win-app-" + new string(Environment.MachineName.ToLowerInvariant().Where(char.IsLetterOrDigit).Take(16).ToArray());
    private AppConfig _cfg = LoadConfig();
    private readonly List<MeshDevice> _devices = new();
    private readonly Dictionary<string, (string FileName, int Total, Dictionary<int, string> Chunks)> _pendingFiles = new();

    private ClientWebSocket? _ws;
    private CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    private readonly TextBox _serverBox = new();
    private readonly TextBox _roomBox = new();
    private readonly Label _statusLabel = new();
    private readonly Label _footerLabel = new();
    private readonly ListView _devicesView = new();
    private readonly ComboBox _targetCombo = new();
    private readonly TextBox _remoteTextBox = new();
    private readonly TextBox _clipInputBox = new();
    private readonly ListBox _clipList = new();
    private readonly ListBox _notifList = new();
    private readonly NotifyIcon _tray = new();

    private Point? _lastDragPoint;
    private Point? _pressPoint;
    private bool _exiting;

    public ContinuumMainForm()
    {
        Text = "Continuum — Aplicativo Nativo Windows";
        Width = 980;
        Height = 680;
        MinimumSize = new Size(780, 560);
        BackColor = Color.FromArgb(9, 11, 14);
        ForeColor = Color.FromArgb(241, 245, 249);
        Font = new Font("Segoe UI", 9.5f);

        try
        {
            var exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (exeIcon != null) { Icon = exeIcon; _tray.Icon = exeIcon; }
        }
        catch { _tray.Icon = SystemIcons.Application; }

        BuildUi();
        SetupTray();

        Load += (_, _) => _ = RunMeshLoopAsync();
        FormClosing += (_, e) =>
        {
            if (!_exiting)
            {
                e.Cancel = true;
                Hide();
            }
        };
    }

    private static AppConfig LoadConfig()
    {
        var cfg = new AppConfig();
        try
        {
            if (File.Exists(ConfigPath))
            {
                var loaded = JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(ConfigPath));
                if (loaded != null) cfg = loaded;
            }
        }
        catch { }
        cfg.ServerUrl = (cfg.ServerUrl ?? "").Trim().TrimEnd('/');
        cfg.RoomCode = new string((cfg.RoomCode ?? "MESH01").ToUpperInvariant().Where(char.IsLetterOrDigit).Take(8).ToArray());
        if (cfg.RoomCode.Length < 4) cfg.RoomCode = "MESH01";
        return cfg;
    }

    private void SaveConfig()
    {
        try
        {
            Directory.CreateDirectory(ConfigDir);
            File.WriteAllText(ConfigPath, JsonSerializer.Serialize(_cfg, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    private static void Log(string msg)
    {
        try
        {
            Directory.CreateDirectory(ConfigDir);
            File.AppendAllText(LogPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {msg}{Environment.NewLine}");
        }
        catch { }
    }

    private void SetupTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Abrir Continuum", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add("Abrir Pasta de Recebidos", null, (_, _) =>
        {
            Directory.CreateDirectory(DownloadsDir);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(DownloadsDir) { UseShellExecute = true });
        });
        menu.Items.Add("Abrir Log", null, (_, _) =>
        {
            if (File.Exists(LogPath)) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(LogPath) { UseShellExecute = true });
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Encerrar Continuum", null, (_, _) =>
        {
            _exiting = true;
            _cts.Cancel();
            _tray.Visible = false;
            Application.Exit();
        });
        _tray.ContextMenuStrip = menu;
        _tray.Text = $"Continuum — Malha {_cfg.RoomCode}";
        _tray.Visible = true;
        _tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
    }

    private void BuildUi()
    {
        var topPanel = new Panel { Dock = DockStyle.Top, Height = 56, BackColor = Color.FromArgb(17, 21, 27), Padding = new Padding(12, 12, 12, 8) };
        var lblSrv = new Label { Text = "Servidor:", AutoSize = true, Left = 12, Top = 18, ForeColor = Color.FromArgb(148, 163, 184) };
        _serverBox.SetBounds(78, 14, 420, 28);
        _serverBox.BackColor = Color.FromArgb(9, 11, 14);
        _serverBox.ForeColor = Color.FromArgb(241, 245, 249);
        _serverBox.Text = _cfg.ServerUrl;

        var lblRoom = new Label { Text = "Malha:", AutoSize = true, Left = 510, Top = 18, ForeColor = Color.FromArgb(148, 163, 184) };
        _roomBox.SetBounds(562, 14, 96, 28);
        _roomBox.BackColor = Color.FromArgb(9, 11, 14);
        _roomBox.ForeColor = Color.FromArgb(241, 245, 249);
        _roomBox.MaxLength = 8;
        _roomBox.Text = _cfg.RoomCode;

        var connectBtn = MakeButton("Conectar", true);
        connectBtn.SetBounds(668, 13, 96, 28);
        connectBtn.Click += (_, _) =>
        {
            var url = _serverBox.Text.Trim().TrimEnd('/');
            var room = new string(_roomBox.Text.ToUpperInvariant().Where(char.IsLetterOrDigit).Take(8).ToArray());
            if ((url.StartsWith("http://") || url.StartsWith("https://")) && room.Length >= 4)
            {
                _cfg.ServerUrl = url;
                _cfg.RoomCode = room;
                SaveConfig();
                _cts.Cancel();
                _cts = new CancellationTokenSource();
                _ = RunMeshLoopAsync();
            }
        };

        _statusLabel.SetBounds(776, 18, 185, 22);
        _statusLabel.ForeColor = Color.FromArgb(96, 165, 250);
        _statusLabel.Text = "Conectando...";
        topPanel.Controls.AddRange(new Control[] { lblSrv, _serverBox, lblRoom, _roomBox, connectBtn, _statusLabel });

        var tabs = new TabControl { Dock = DockStyle.Fill };

        // Tab 1: Devices
        var tabDevices = new TabPage("Dispositivos") { BackColor = Color.FromArgb(9, 11, 14), Padding = new Padding(12) };
        _devicesView.Dock = DockStyle.Fill;
        _devicesView.View = View.Details;
        _devicesView.FullRowSelect = true;
        _devicesView.BackColor = Color.FromArgb(17, 21, 27);
        _devicesView.ForeColor = Color.FromArgb(241, 245, 249);
        _devicesView.Columns.Add("Dispositivo", 260);
        _devicesView.Columns.Add("Sistema", 110);
        _devicesView.Columns.Add("Ponte", 100);
        _devicesView.Columns.Add("CPU", 100);
        _devicesView.Columns.Add("Bateria", 100);
        var pingBtn = MakeButton("Localizar Selecionado", false);
        pingBtn.Dock = DockStyle.Bottom;
        pingBtn.Height = 36;
        pingBtn.Click += async (_, _) =>
        {
            if (_devicesView.SelectedItems.Count > 0 && _devicesView.SelectedItems[0].Tag is string targetId)
            {
                await SendJsonAsync(new { type = "input:event", toDeviceId = targetId, input = new { kind = "command", action = "ping" } });
            }
        };
        tabDevices.Controls.Add(_devicesView);
        tabDevices.Controls.Add(pingBtn);

        // Tab 2: Remote Control
        var tabRemote = new TabPage("Controle Remoto") { BackColor = Color.FromArgb(9, 11, 14), Padding = new Padding(12) };
        _targetCombo.Dock = DockStyle.Top;
        _targetCombo.DropDownStyle = ComboBoxStyle.DropDownList;
        _targetCombo.BackColor = Color.FromArgb(17, 21, 27);
        _targetCombo.ForeColor = Color.FromArgb(241, 245, 249);

        var pad = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(17, 21, 27), BorderStyle = BorderStyle.FixedSingle };
        var padHint = new Label { Text = "Trackpad Nativo Win32 — arraste para mover cursor remoto, clique esquerdo/direito ou use a roda do mouse", Left = 14, Top = 14, AutoSize = true, ForeColor = Color.FromArgb(148, 163, 184) };
        pad.Controls.Add(padHint);
        pad.MouseDown += (_, e) => { _lastDragPoint = e.Location; _pressPoint = e.Location; };
        pad.MouseMove += async (_, e) =>
        {
            if (_lastDragPoint == null) return;
            int dx = (int)((e.X - _lastDragPoint.Value.X) * 1.8);
            int dy = (int)((e.Y - _lastDragPoint.Value.Y) * 1.8);
            _lastDragPoint = e.Location;
            if (Math.Abs(dx) >= 1 || Math.Abs(dy) >= 1)
                await SendRemoteInputAsync(new { kind = "move", nx = 0.5, ny = 0.5, dx, dy });
        };
        pad.MouseUp += async (_, e) =>
        {
            if (_pressPoint != null && Math.Abs(e.X - _pressPoint.Value.X) < 4 && Math.Abs(e.Y - _pressPoint.Value.Y) < 4)
                await SendRemoteInputAsync(new { kind = "click", button = e.Button == MouseButtons.Right ? "right" : "left" });
            _lastDragPoint = null;
        };
        pad.MouseWheel += async (_, e) => await SendRemoteInputAsync(new { kind = "scroll", dx = 0, dy = e.Delta > 0 ? -90 : 90 });

        var remoteBottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 82, BackColor = Color.FromArgb(9, 11, 14), Padding = new Padding(0, 8, 0, 0) };
        _remoteTextBox.Width = 420;
        _remoteTextBox.BackColor = Color.FromArgb(17, 21, 27);
        _remoteTextBox.ForeColor = Color.FromArgb(241, 245, 249);
        var btnSendTxt = MakeButton("Enviar Texto", true);
        btnSendTxt.Click += async (_, _) => { if (!string.IsNullOrEmpty(_remoteTextBox.Text)) { await SendRemoteInputAsync(new { kind = "text", text = _remoteTextBox.Text }); _remoteTextBox.Clear(); } };
        var btnEnter = MakeButton("Enter", false);
        btnEnter.Click += async (_, _) => await SendRemoteInputAsync(new { kind = "key", key = "Enter" });
        var btnVolDown = MakeButton("Vol -", false);
        btnVolDown.Click += async (_, _) => await SendRemoteInputAsync(new { kind = "command", action = "vol_down" });
        var btnVolUp = MakeButton("Vol +", false);
        btnVolUp.Click += async (_, _) => await SendRemoteInputAsync(new { kind = "command", action = "vol_up" });
        var btnPlay = MakeButton("Play/Pause", false);
        btnPlay.Click += async (_, _) => await SendRemoteInputAsync(new { kind = "command", action = "media_play_pause" });
        var btnLock = MakeButton("Bloquear", false);
        btnLock.Click += async (_, _) => await SendRemoteInputAsync(new { kind = "command", action = "lock" });
        remoteBottom.Controls.AddRange(new Control[] { _remoteTextBox, btnSendTxt, btnEnter, btnVolDown, btnVolUp, btnPlay, btnLock });

        tabRemote.Controls.Add(pad);
        tabRemote.Controls.Add(_targetCombo);
        tabRemote.Controls.Add(remoteBottom);

        // Tab 3: Files & Clipboard
        var tabFiles = new TabPage("Arquivos & Clipboard") { BackColor = Color.FromArgb(9, 11, 14), Padding = new Padding(12) };
        var fileBar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 44 };
        var btnSendFile = MakeButton("Enviar Arquivo...", true);
        btnSendFile.Click += async (_, _) => await PickAndSendFileAsync();
        var btnCapClip = MakeButton("Capturar Clipboard do Windows", false);
        btnCapClip.Click += async (_, _) =>
        {
            if (Clipboard.ContainsText()) await PushClipboardAsync(Clipboard.GetText());
        };
        _clipInputBox.Width = 340;
        _clipInputBox.BackColor = Color.FromArgb(17, 21, 27);
        _clipInputBox.ForeColor = Color.FromArgb(241, 245, 249);
        var btnPushClip = MakeButton("Sincronizar", false);
        btnPushClip.Click += async (_, _) => { if (!string.IsNullOrWhiteSpace(_clipInputBox.Text)) { await PushClipboardAsync(_clipInputBox.Text); _clipInputBox.Clear(); } };
        fileBar.Controls.AddRange(new Control[] { btnSendFile, btnCapClip, _clipInputBox, btnPushClip });

        _clipList.Dock = DockStyle.Fill;
        _clipList.BackColor = Color.FromArgb(17, 21, 27);
        _clipList.ForeColor = Color.FromArgb(241, 245, 249);
        _clipList.DoubleClick += (_, _) =>
        {
            if (_clipList.SelectedItem is string s)
            {
                var idx = s.IndexOf("] ");
                var content = idx >= 0 ? s[(idx + 2)..] : s;
                Clipboard.SetText(content);
                _footerLabel.Text = "Copiado para a area de transferencia do Windows.";
            }
        };
        tabFiles.Controls.Add(_clipList);
        tabFiles.Controls.Add(fileBar);

        // Tab 4: Alerts
        var tabAlerts = new TabPage("Sistema & Alertas") { BackColor = Color.FromArgb(9, 11, 14), Padding = new Padding(12) };
        _notifList.Dock = DockStyle.Fill;
        _notifList.BackColor = Color.FromArgb(17, 21, 27);
        _notifList.ForeColor = Color.FromArgb(241, 245, 249);
        tabAlerts.Controls.Add(_notifList);

        tabs.TabPages.AddRange(new[] { tabDevices, tabRemote, tabFiles, tabAlerts });

        _footerLabel.Dock = DockStyle.Bottom;
        _footerLabel.Height = 28;
        _footerLabel.Padding = new Padding(12, 5, 12, 0);
        _footerLabel.BackColor = Color.FromArgb(13, 16, 21);
        _footerLabel.ForeColor = Color.FromArgb(148, 163, 184);
        _footerLabel.Text = $"Ponte Win32 Nativa Integrada · Arquivos salvos em: {DownloadsDir}";

        Controls.Add(tabs);
        Controls.Add(topPanel);
        Controls.Add(_footerLabel);
    }

    private static Button MakeButton(string text, bool primary) => new()
    {
        Text = text,
        AutoSize = true,
        FlatStyle = FlatStyle.Flat,
        BackColor = primary ? Color.FromArgb(59, 130, 246) : Color.FromArgb(23, 28, 36),
        ForeColor = Color.White,
        Padding = new Padding(8, 3, 8, 3),
    };

    private string GetWsUri()
    {
        var uri = new Uri(_cfg.ServerUrl);
        var scheme = uri.Scheme == "https" ? "wss" : "ws";
        return $"{scheme}://{uri.Authority}/ws";
    }

    private async Task SendJsonAsync(object payload)
    {
        if (_ws == null || _ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        await _sendLock.WaitAsync();
        try
        {
            if (_ws.State == WebSocketState.Open)
                await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        finally { _sendLock.Release(); }
    }

    private async Task SendRemoteInputAsync(object input)
    {
        if (_targetCombo.SelectedIndex < 0) return;
        var peers = _devices.Where(d => d.Id != _deviceId).ToList();
        if (_targetCombo.SelectedIndex >= peers.Count) return;
        await SendJsonAsync(new { type = "input:event", toDeviceId = peers[_targetCombo.SelectedIndex].Id, input });
    }

    private async Task PushClipboardAsync(string text)
    {
        var trimmed = text.Trim();
        if (string.IsNullOrEmpty(trimmed)) return;
        await SendJsonAsync(new
        {
            type = "clipboard:push",
            item = new
            {
                id = $"clip-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
                content = trimmed,
                kind = trimmed.StartsWith("http") ? "url" : "text",
                sourceDeviceId = _deviceId,
                sourceDeviceName = $"{Environment.MachineName} (Windows)",
                createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            }
        });
    }

    private async Task PickAndSendFileAsync()
    {
        using var ofd = new OpenFileDialog { Title = "Enviar arquivo pela malha Continuum" };
        if (ofd.ShowDialog() != DialogResult.OK) return;
        var path = ofd.FileName;
        var info = new FileInfo(path);
        var trId = $"file-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
        await SendJsonAsync(new
        {
            type = "file:start",
            record = new
            {
                id = trId,
                fileName = info.Name,
                fileSize = info.Length,
                mimeType = "application/octet-stream",
                fromDeviceId = _deviceId,
                fromDeviceName = $"{Environment.MachineName} (Windows)",
                toDeviceId = "all",
                toDeviceName = "Todos os dispositivos",
                status = "transferring",
                progress = 0,
                speedMbps = 0,
                createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            }
        });

        const int chunkSize = 48 * 1024;
        var data = await File.ReadAllBytesAsync(path);
        int total = Math.Max(1, (data.Length + chunkSize - 1) / chunkSize);
        for (int i = 0; i < total; i++)
        {
            int offset = i * chunkSize;
            int len = Math.Min(chunkSize, data.Length - offset);
            var b64 = Convert.ToBase64String(data, offset, len);
            await SendJsonAsync(new
            {
                type = "file:chunk",
                transferId = trId,
                toDeviceId = "all",
                chunkIndex = i,
                totalChunks = total,
                data = b64,
                progress = Math.Min(99, (int)((i + 1) * 100.0 / total)),
                speedMbps = 10
            });
        }
        await SendJsonAsync(new { type = "file:complete", transferId = trId, toDeviceId = "all" });
        _footerLabel.Text = $"Arquivo enviado: {info.Name}";
    }

    private void ExecuteWin32Input(JsonElement evt)
    {
        var kind = evt.TryGetProperty("kind", out var k) ? k.GetString() : null;
        if (kind == "move")
        {
            if (evt.TryGetProperty("dx", out var dxEl) && evt.TryGetProperty("dy", out var dyEl))
            {
                Win32Native.GetCursorPos(out var pt);
                Win32Native.SetCursorPos(pt.X + (int)dxEl.GetDouble(), pt.Y + (int)dyEl.GetDouble());
            }
            else if (evt.TryGetProperty("nx", out var nxEl) && evt.TryGetProperty("ny", out var nyEl))
            {
                int sw = Math.Max(1, Win32Native.GetSystemMetrics(0));
                int sh = Math.Max(1, Win32Native.GetSystemMetrics(1));
                Win32Native.SetCursorPos((int)(nxEl.GetDouble() * sw), (int)(nyEl.GetDouble() * sh));
            }
        }
        else if (kind == "click")
        {
            if (evt.TryGetProperty("nx", out var nxEl) && evt.TryGetProperty("ny", out var nyEl))
            {
                int sw = Math.Max(1, Win32Native.GetSystemMetrics(0));
                int sh = Math.Max(1, Win32Native.GetSystemMetrics(1));
                Win32Native.SetCursorPos((int)(nxEl.GetDouble() * sw), (int)(nyEl.GetDouble() * sh));
            }
            var btn = evt.TryGetProperty("button", out var b) ? b.GetString() : "left";
            if (btn == "right") { Win32Native.mouse_event(0x0008, 0, 0, 0, 0); Win32Native.mouse_event(0x0010, 0, 0, 0, 0); }
            else { Win32Native.mouse_event(0x0002, 0, 0, 0, 0); Win32Native.mouse_event(0x0004, 0, 0, 0, 0); }
        }
        else if (kind == "scroll" && evt.TryGetProperty("dy", out var dyScroll))
        {
            Win32Native.mouse_event(0x0800, 0, 0, (int)(-dyScroll.GetDouble() * 3), 0);
        }
        else if (kind == "text" && evt.TryGetProperty("text", out var txtEl))
        {
            var txt = txtEl.GetString();
            if (!string.IsNullOrEmpty(txt)) BeginInvoke(() => SendKeys.SendWait(txt));
        }
        else if (kind == "command" && evt.TryGetProperty("action", out var actEl))
        {
            switch (actEl.GetString())
            {
                case "vol_up": Win32Native.keybd_event(0xAF, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xAF, 0, 2, UIntPtr.Zero); break;
                case "vol_down": Win32Native.keybd_event(0xAE, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xAE, 0, 2, UIntPtr.Zero); break;
                case "vol_mute": Win32Native.keybd_event(0xAD, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xAD, 0, 2, UIntPtr.Zero); break;
                case "media_play_pause": Win32Native.keybd_event(0xB3, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xB3, 0, 2, UIntPtr.Zero); break;
                case "media_next": Win32Native.keybd_event(0xB0, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xB0, 0, 2, UIntPtr.Zero); break;
                case "media_prev": Win32Native.keybd_event(0xB1, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xB1, 0, 2, UIntPtr.Zero); break;
                case "lock": Win32Native.LockWorkStation(); break;
                case "ping": System.Media.SystemSounds.Exclamation.Play(); break;
            }
        }
    }

    private void RefreshDevicesUi()
    {
        _devicesView.Items.Clear();
        _targetCombo.Items.Clear();
        foreach (var d in _devices)
        {
            var item = new ListViewItem(d.Id == _deviceId ? $"{d.Name} (Este Windows)" : d.Name) { Tag = d.Id };
            item.SubItems.Add(d.Os.ToUpperInvariant());
            item.SubItems.Add(d.DisplayServer.ToUpperInvariant());
            item.SubItems.Add(d.CpuText);
            item.SubItems.Add(d.BatteryText);
            _devicesView.Items.Add(item);
            if (d.Id != _deviceId) _targetCombo.Items.Add(d.Name);
        }
        if (_targetCombo.Items.Count > 0 && _targetCombo.SelectedIndex < 0) _targetCombo.SelectedIndex = 0;
    }

    private static MeshDevice ParseDevice(JsonElement el)
    {
        var d = new MeshDevice
        {
            Id = el.TryGetProperty("id", out var id) ? id.GetString() ?? "" : "",
            Name = el.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
            Os = el.TryGetProperty("os", out var o) ? o.GetString() ?? "" : ""
        };
        if (el.TryGetProperty("telemetry", out var tel) && tel.ValueKind == JsonValueKind.Object)
        {
            if (tel.TryGetProperty("displayServer", out var ds) && ds.ValueKind == JsonValueKind.String) d.DisplayServer = ds.GetString() ?? "web";
            if (tel.TryGetProperty("cpuUsage", out var cpu) && cpu.ValueKind == JsonValueKind.Number) d.CpuText = $"{cpu.GetInt32()}%";
            if (tel.TryGetProperty("batteryLevel", out var bat) && bat.ValueKind == JsonValueKind.Number) d.BatteryText = $"{bat.GetInt32()}%";
        }
        return d;
    }

    private async Task RunMeshLoopAsync()
    {
        var token = _cts.Token;
        while (!token.IsCancellationRequested)
        {
            try
            {
                BeginInvoke(() => _statusLabel.Text = "Conectando...");
                _ws?.Dispose();
                _ws = new ClientWebSocket();
                _ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                await _ws.ConnectAsync(new Uri(GetWsUri()), token);
                Log($"Conectado em {GetWsUri()} (Malha {_cfg.RoomCode})");

                var ps = SystemInformation.PowerStatus;
                int? batPct = ps.BatteryChargeStatus == BatteryChargeStatus.NoSystemBattery ? null : (int)Math.Round(ps.BatteryLifePercent * 100);
                await SendJsonAsync(new
                {
                    type = "mesh:join",
                    roomCode = _cfg.RoomCode,
                    device = new
                    {
                        id = _deviceId,
                        name = $"{Environment.MachineName} (Windows)",
                        os = "windows",
                        formFactor = "desktop",
                        screenWidth = Screen.PrimaryScreen?.Bounds.Width ?? 1920,
                        screenHeight = Screen.PrimaryScreen?.Bounds.Height ?? 1080,
                        pixelRatio = 1,
                        orientation = "landscape",
                        companionConnected = true,
                        telemetry = new
                        {
                            batteryLevel = batPct,
                            batteryCharging = ps.PowerLineStatus == PowerLineStatus.Online,
                            cpuCores = Environment.ProcessorCount,
                            displayServer = "win32",
                            volume = 72,
                            brightness = 85,
                            openApps = Array.Empty<object>()
                        }
                    }
                });

                BeginInvoke(() => { _statusLabel.Text = $"Conectado · {_cfg.RoomCode}"; _tray.Text = $"Continuum — {_cfg.RoomCode}"; });

                var buf = new byte[32768];
                using var ms = new MemoryStream();
                while (_ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    var res = await _ws.ReceiveAsync(buf, token);
                    if (res.MessageType == WebSocketMessageType.Close) break;
                    ms.Write(buf, 0, res.Count);
                    if (!res.EndOfMessage) continue;
                    var raw = Encoding.UTF8.GetString(ms.ToArray());
                    ms.SetLength(0);
                    HandleMessage(raw);
                }
            }
            catch (Exception ex)
            {
                Log($"Erro de conexao: {ex.Message}");
                BeginInvoke(() => _statusLabel.Text = "Reconectando...");
            }
            try { await Task.Delay(3500, token); } catch { break; }
        }
    }

    private void HandleMessage(string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;

            if (type == "input:event" || type == "companion:input")
            {
                if (root.TryGetProperty("input", out var inp)) ExecuteWin32Input(inp);
                return;
            }
            if (type == "mesh:init" && root.TryGetProperty("snapshot", out var snap))
            {
                var list = snap.GetProperty("devices").EnumerateArray().Select(ParseDevice).ToList();
                var clips = snap.GetProperty("clipboard").EnumerateArray().Select(c => $"[{c.GetProperty("sourceDeviceName").GetString()}] {c.GetProperty("content").GetString()}").ToList();
                var notifs = snap.GetProperty("notifications").EnumerateArray().Select(n => $"{n.GetProperty("app").GetString()} · {n.GetProperty("title").GetString()}").ToList();
                BeginInvoke(() =>
                {
                    _devices.Clear(); _devices.AddRange(list); RefreshDevicesUi();
                    _clipList.Items.Clear(); foreach (var c in clips) _clipList.Items.Add(c);
                    _notifList.Items.Clear(); foreach (var n in notifs) _notifList.Items.Add(n);
                });
            }
            else if (type == "mesh:devices_sync" && root.TryGetProperty("devices", out var devsEl))
            {
                var list = devsEl.EnumerateArray().Select(ParseDevice).ToList();
                BeginInvoke(() => { _devices.Clear(); _devices.AddRange(list); RefreshDevicesUi(); });
            }
            else if ((type == "device:joined" || type == "device:updated") && root.TryGetProperty("device", out var devEl))
            {
                var dev = ParseDevice(devEl);
                BeginInvoke(() =>
                {
                    _devices.RemoveAll(x => x.Id == dev.Id);
                    _devices.Add(dev);
                    RefreshDevicesUi();
                });
            }
            else if (type == "device:left" && root.TryGetProperty("deviceId", out var didEl))
            {
                var did = didEl.GetString();
                BeginInvoke(() => { _devices.RemoveAll(x => x.Id == did); RefreshDevicesUi(); });
            }
            else if (type == "clipboard:added" && root.TryGetProperty("item", out var clipEl))
            {
                var line = $"[{clipEl.GetProperty("sourceDeviceName").GetString()}] {clipEl.GetProperty("content").GetString()}";
                BeginInvoke(() => _clipList.Items.Insert(0, line));
            }
            else if (type == "notification:added" && root.TryGetProperty("notification", out var nEl))
            {
                var line = $"{nEl.GetProperty("app").GetString()} · {nEl.GetProperty("title").GetString()}";
                BeginInvoke(() => _notifList.Items.Insert(0, line));
            }
            else if (type == "file:start" && root.TryGetProperty("record", out var rec))
            {
                var fid = rec.GetProperty("id").GetString() ?? "";
                var from = rec.GetProperty("fromDeviceId").GetString() ?? "";
                var fname = rec.GetProperty("fileName").GetString() ?? "arquivo.bin";
                if (from != _deviceId && !string.IsNullOrEmpty(fid))
                    _pendingFiles[fid] = (fname, 0, new Dictionary<int, string>());
            }
            else if (type == "file:chunk")
            {
                var fid = root.GetProperty("transferId").GetString() ?? "";
                if (_pendingFiles.TryGetValue(fid, out var asm))
                {
                    asm.Total = root.GetProperty("totalChunks").GetInt32();
                    asm.Chunks[root.GetProperty("chunkIndex").GetInt32()] = root.GetProperty("data").GetString() ?? "";
                    _pendingFiles[fid] = asm;
                }
            }
            else if (type == "file:complete")
            {
                var fid = root.GetProperty("transferId").GetString() ?? "";
                if (_pendingFiles.Remove(fid, out var asm))
                {
                    Directory.CreateDirectory(DownloadsDir);
                    var dest = Path.Combine(DownloadsDir, Path.GetFileName(asm.FileName));
                    using var fs = File.Create(dest);
                    for (int i = 0; i < asm.Total; i++)
                    {
                        if (asm.Chunks.TryGetValue(i, out var b64))
                        {
                            var bytes = Convert.FromBase64String(b64);
                            fs.Write(bytes, 0, bytes.Length);
                        }
                    }
                    BeginInvoke(() => _footerLabel.Text = $"Arquivo recebido salvo em: {dest}");
                }
            }
        }
        catch { }
    }

    [STAThread]
    public static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new ContinuumMainForm());
    }
}
`;
}

export function buildWindowsNsisScript(): string {
  return `!include "MUI2.nsh"
Name "Continuum"
OutFile "Continuum-Windows-Setup.exe"
InstallDir "$LOCALAPPDATA\\Continuum"
RequestExecutionLevel user

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "PortugueseBR"

Section "Continuum"
  SetOutPath "$INSTDIR"
  File "publish\\Continuum.exe"
  File "continuum.ico"
  CreateDirectory "$SMPROGRAMS\\Continuum"
  CreateShortcut "$SMPROGRAMS\\Continuum\\Continuum.lnk" "$INSTDIR\\Continuum.exe" "" "$INSTDIR\\continuum.ico"
  CreateShortcut "$DESKTOP\\Continuum.lnk" "$INSTDIR\\Continuum.exe" "" "$INSTDIR\\continuum.ico"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\\Continuum\\Desinstalar Continuum.lnk" "$INSTDIR\\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\\Continuum.lnk"
  Delete "$SMPROGRAMS\\Continuum\\Continuum.lnk"
  Delete "$SMPROGRAMS\\Continuum\\Desinstalar Continuum.lnk"
  RMDir "$SMPROGRAMS\\Continuum"
  Delete "$INSTDIR\\Continuum.exe"
  Delete "$INSTDIR\\continuum.ico"
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
`;
}

/**
 * 100% NATIVE ANDROID KOTLIN APPLICATION (Native Views + OkHttp WebSocket — ZERO WebView!)
 * Compiles cleanly with Gradle 8.7 + JDK 17 + Android SDK 34 into Continuum-Android.apk.
 */
export function buildAndroidNativeProjectEntries(
  ctx: InstallerContext,
  png192: Buffer | null,
  prefix = ''
): ZipEntryInput[] {
  const room = safeStr(ctx.roomCode);
  const serverUrl = safeStr(ctx.appUrl).replace(/\/+$/, '');
  const p = (rel: string) => (prefix ? `${prefix}/${rel}` : rel);

  const settingsKts = `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "ContinuumAndroid"
include(":app")
`;

  const rootBuildKts = `plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
`;

  const gradleProps = `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
`;

  const appBuildKts = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val continuumUrl = (project.findProperty("continuumUrl") as String?)?.trimEnd('/') ?: "${serverUrl}"
val roomCode = (project.findProperty("roomCode") as String?) ?: "${room}"

android {
    namespace = "app.continuum.mesh"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.continuum.mesh"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "2.0.0"

        buildConfigField("String", "DEFAULT_SERVER_URL", "\\"\${continuumUrl}\\"")
        buildConfigField("String", "DEFAULT_ROOM_CODE", "\\"\${roomCode}\\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
`;

  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="Continuum"
        android:supportsRtl="true"
        android:usesCleartextTraffic="true"
        android:theme="@style/Theme.Continuum">
        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|screenSize|keyboardHidden"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

  const mainActivityKt = `package app.continuum.mesh

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.OpenableColumns
import android.util.Base64
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Continuum 100% Native Android Application (Kotlin + OkHttp WebSocket + Multi-Touch Trackpad).
 * Zero WebView — native Android UI talking directly to the Continuum real-time mesh protocol.
 */
class MainActivity : AppCompatActivity() {

    private val bgCanvas = Color.parseColor("#090B0E")
    private val bgSurface = Color.parseColor("#11151B")
    private val bgElevated = Color.parseColor("#171C24")
    private val borderStroke = Color.parseColor("#222936")
    private val accentBlue = Color.parseColor("#3B82F6")
    private val textPrimary = Color.parseColor("#F1F5F9")
    private val textMuted = Color.parseColor("#94A3B8")

    private val httpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private lateinit var deviceId: String
    private var serverUrl: String = BuildConfig.DEFAULT_SERVER_URL
    private var roomCode: String = BuildConfig.DEFAULT_ROOM_CODE

    private val devices = mutableListOf<JSONObject>()
    private val clipboardItems = mutableListOf<JSONObject>()
    private val notifications = mutableListOf<JSONObject>()
    private val pendingFiles = mutableMapOf<String, PendingFile>()

    private lateinit var statusText: TextView
    private lateinit var serverInput: EditText
    private lateinit var roomInput: EditText
    private lateinit var devicesContainer: LinearLayout
    private lateinit var targetSpinner: Spinner
    private lateinit var clipListView: ListView
    private lateinit var notifListView: ListView
    private lateinit var tabMesh: View
    private lateinit var tabTrackpad: View
    private lateinit var tabFiles: View
    private lateinit var tabAlerts: View

    data class PendingFile(val name: String, var total: Int = 0, val chunks: MutableMap<Int, String> = mutableMapOf())

    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) sendSelectedFile(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val prefs = getSharedPreferences("continuum_native", Context.MODE_PRIVATE)
        serverUrl = prefs.getString("server_url", BuildConfig.DEFAULT_SERVER_URL) ?: BuildConfig.DEFAULT_SERVER_URL
        roomCode = prefs.getString("room_code", BuildConfig.DEFAULT_ROOM_CODE) ?: BuildConfig.DEFAULT_ROOM_CODE
        val cleanModel = "\${Build.MANUFACTURER}\${Build.MODEL}".lowercase().filter { it.isLetterOrDigit() }.take(14)
        deviceId = prefs.getString("device_id", null) ?: "android-app-\$cleanModel-\${(1000..9999).random()}".also {
            prefs.edit().putString("device_id", it).apply()
        }

        setContentView(buildRootLayout())
        connectMesh()
    }

    override fun onDestroy() {
        super.onDestroy()
        webSocket?.close(1000, "App closed")
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun cardBg(fill: Int = bgSurface): GradientDrawable = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(8).toFloat()
        setStroke(dp(1), borderStroke)
    }

    private fun makeButton(label: String, primary: Boolean = false, onClick: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply {
            setColor(if (primary) accentBlue else bgElevated)
            cornerRadius = dp(6).toFloat()
            setStroke(dp(1), if (primary) accentBlue else borderStroke)
        }
        setPadding(dp(12), dp(8), dp(12), dp(8))
        setOnClickListener { onClick() }
    }

    private fun buildRootLayout(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(bgCanvas)
        }

        // Top Bar
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(bgSurface)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            gravity = Gravity.CENTER_VERTICAL
        }
        val title = TextView(this).apply {
            text = "Continuum"
            textSize = 18f
            setTextColor(textPrimary)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        statusText = TextView(this).apply {
            text = "Conectando..."
            textSize = 12f
            setTextColor(Color.parseColor("#60A5FA"))
        }
        topBar.addView(title)
        topBar.addView(statusText)
        root.addView(topBar)

        // Content container
        val contentFrame = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        }

        tabMesh = buildMeshTab()
        tabTrackpad = buildTrackpadTab()
        tabFiles = buildFilesTab()
        tabAlerts = buildAlertsTab()

        contentFrame.addView(tabMesh)
        contentFrame.addView(tabTrackpad)
        contentFrame.addView(tabFiles)
        contentFrame.addView(tabAlerts)
        root.addView(contentFrame)

        // Native Bottom Navigation
        val bottomBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(bgSurface)
            setPadding(dp(6), dp(6), dp(6), dp(8))
        }
        listOf(
            "Malha" to 0,
            "Trackpad" to 1,
            "Arquivos" to 2,
            "Alertas" to 3
        ).forEach { (label, idx) ->
            val btn = makeButton(label, idx == 0) { switchTab(idx) }.apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginStart = dp(3)
                    marginEnd = dp(3)
                }
            }
            bottomBar.addView(btn)
        }
        root.addView(bottomBar)
        switchTab(0)
        return root
    }

    private fun switchTab(idx: Int) {
        tabMesh.visibility = if (idx == 0) View.VISIBLE else View.GONE
        tabTrackpad.visibility = if (idx == 1) View.VISIBLE else View.GONE
        tabFiles.visibility = if (idx == 2) View.VISIBLE else View.GONE
        tabAlerts.visibility = if (idx == 3) View.VISIBLE else View.GONE
    }

    private fun buildMeshTab(): View {
        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
        }

        val cfgCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = cardBg()
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
        serverInput = EditText(this).apply {
            setText(serverUrl)
            hint = "https://servidor-continuum"
            setTextColor(textPrimary)
            setHintTextColor(textMuted)
            textSize = 13f
        }
        roomInput = EditText(this).apply {
            setText(roomCode)
            hint = "Codigo da Malha (ex: MESH01)"
            setTextColor(textPrimary)
            setHintTextColor(textMuted)
            textSize = 14f
        }
        val connectBtn = makeButton("Salvar e Conectar na Malha", true) {
            val nextUrl = serverInput.text.toString().trim().trimEnd('/')
            val nextRoom = roomInput.text.toString().uppercase().filter { it.isLetterOrDigit() }.take(8)
            if ((nextUrl.startsWith("http://") || nextUrl.startsWith("https://")) && nextRoom.length >= 4) {
                serverUrl = nextUrl
                roomCode = nextRoom
                getSharedPreferences("continuum_native", Context.MODE_PRIVATE).edit()
                    .putString("server_url", serverUrl)
                    .putString("room_code", roomCode)
                    .apply()
                connectMesh()
            } else {
                Toast.makeText(this, "Informe URL http/https e codigo de malha valido.", Toast.LENGTH_SHORT).show()
            }
        }
        cfgCard.addView(serverInput)
        cfgCard.addView(roomInput)
        cfgCard.addView(connectBtn)
        box.addView(cfgCard)

        val devHeader = TextView(this).apply {
            text = "Dispositivos Conectados"
            setTextColor(textPrimary)
            textSize = 15f
            setPadding(0, dp(16), 0, dp(8))
        }
        box.addView(devHeader)

        devicesContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        box.addView(devicesContainer)
        scroll.addView(box)
        return scroll
    }

    private fun buildTrackpadTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
        }

        targetSpinner = Spinner(this).apply {
            background = cardBg()
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }
        box.addView(targetSpinner)

        val trackpad = NativeTrackpadView(this) { inputJson -> sendRemoteInput(inputJson) }.apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f).apply {
                topMargin = dp(10)
                bottomMargin = dp(10)
            }
        }
        box.addView(trackpad)

        val btnRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        listOf(
            "Vol -" to JSONObject().put("kind", "command").put("action", "vol_down"),
            "Vol +" to JSONObject().put("kind", "command").put("action", "vol_up"),
            "Play" to JSONObject().put("kind", "command").put("action", "media_play_pause"),
            "Scroll ↑" to JSONObject().put("kind", "scroll").put("dx", 0).put("dy", -120),
            "Scroll ↓" to JSONObject().put("kind", "scroll").put("dx", 0).put("dy", 120)
        ).forEach { (lbl, payload) ->
            val b = makeButton(lbl) { sendRemoteInput(payload) }.apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(4)
                }
            }
            btnRow.addView(b)
        }
        box.addView(btnRow)

        val kbRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8), 0, 0)
        }
        val kbInput = EditText(this).apply {
            hint = "Digitar no PC..."
            setTextColor(textPrimary)
            setHintTextColor(textMuted)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val sendKb = makeButton("Enviar", true) {
            val txt = kbInput.text.toString()
            if (txt.isNotEmpty()) {
                sendRemoteInput(JSONObject().put("kind", "text").put("text", txt))
                kbInput.setText("")
            }
        }
        kbRow.addView(kbInput)
        kbRow.addView(sendKb)
        box.addView(kbRow)
        return box
    }

    private fun buildFilesTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
        }

        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val sendFileBtn = makeButton("Enviar Arquivo", true) { filePicker.launch(arrayOf("*/*")) }.apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(6) }
        }
        val syncClipBtn = makeButton("Enviar Clipboard") {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val txt = cm.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()?.trim()
            if (!txt.isNullOrEmpty()) {
                val item = JSONObject()
                    .put("id", "clip-\${System.currentTimeMillis()}")
                    .put("content", txt)
                    .put("kind", if (txt.startsWith("http")) "url" else "text")
                    .put("sourceDeviceId", deviceId)
                    .put("sourceDeviceName", "\${Build.MANUFACTURER} \${Build.MODEL}")
                    .put("createdAt", System.currentTimeMillis())
                sendWs(JSONObject().put("type", "clipboard:push").put("item", item))
                Toast.makeText(this, "Clipboard sincronizado!", Toast.LENGTH_SHORT).show()
            }
        }.apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        actions.addView(sendFileBtn)
        actions.addView(syncClipBtn)
        box.addView(actions)

        clipListView = ListView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f).apply { topMargin = dp(10) }
            setOnItemClickListener { _, _, pos, _ ->
                if (pos < clipboardItems.size) {
                    val content = clipboardItems[pos].optString("content")
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("Continuum", content))
                    Toast.makeText(this@MainActivity, "Copiado para o Android!", Toast.LENGTH_SHORT).show()
                }
            }
        }
        box.addView(clipListView)
        return box
    }

    private fun buildAlertsTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
        }
        notifListView = ListView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        box.addView(notifListView)
        return box
    }

    private fun readBattery(): Pair<Int?, Boolean?> {
        val status = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = status?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = status?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val plugged = status?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) (level * 100) / scale else null
        return pct to (plugged > 0)
    }

    private fun buildWsUrl(): String {
        val uri = Uri.parse(serverUrl)
        val proto = if (uri.scheme == "https") "wss" else "ws"
        val portPart = if (uri.port > 0) ":\${uri.port}" else ""
        return "\$proto://\${uri.host}\$portPart/ws"
    }

    private fun connectMesh() {
        webSocket?.close(1000, "Reconnect")
        statusText.text = "Conectando..."
        val req = Request.Builder().url(buildWsUrl()).build()
        webSocket = httpClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                val (bat, charging) = readBattery()
                val dm = resources.displayMetrics
                val tel = JSONObject()
                    .put("batteryLevel", bat ?: JSONObject.NULL)
                    .put("batteryCharging", charging ?: JSONObject.NULL)
                    .put("cpuCores", Runtime.getRuntime().availableProcessors())
                    .put("volume", 72)
                    .put("brightness", 85)
                    .put("displayServer", "web")
                    .put("openApps", JSONArray())

                val dev = JSONObject()
                    .put("id", deviceId)
                    .put("name", "\${Build.MANUFACTURER} \${Build.MODEL}")
                    .put("os", "android")
                    .put("formFactor", if (resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "mobile")
                    .put("screenWidth", dm.widthPixels)
                    .put("screenHeight", dm.heightPixels)
                    .put("pixelRatio", dm.density)
                    .put("orientation", if (dm.widthPixels > dm.heightPixels) "landscape" else "portrait")
                    .put("telemetry", tel)

                ws.send(JSONObject().put("type", "mesh:join").put("roomCode", roomCode).put("device", dev).toString())
                runOnUiThread { statusText.text = "Conectado · \$roomCode" }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleWsMessage(text)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                runOnUiThread { statusText.text = "Desconectado (\${t.message?.take(24) ?: "erro"})" }
            }
        })
    }

    private fun sendWs(obj: JSONObject) {
        webSocket?.send(obj.toString())
    }

    private fun sendRemoteInput(input: JSONObject) {
        val peers = devices.filter { it.optString("id") != deviceId }
        val idx = targetSpinner.selectedItemPosition
        if (idx in peers.indices) {
            sendWs(JSONObject().put("type", "input:event").put("toDeviceId", peers[idx].optString("id")).put("input", input))
        }
    }

    private fun sendSelectedFile(uri: Uri) {
        Thread {
            try {
                var fileName = "arquivo_android.bin"
                contentResolver.query(uri, null, null, null, null)?.use { c ->
                    val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (c.moveToFirst() && nameIdx >= 0) fileName = c.getString(nameIdx)
                }
                val bytes = contentResolver.openInputStream(uri)?.readBytes() ?: return@Thread
                val trId = "file-\${System.currentTimeMillis()}"
                val record = JSONObject()
                    .put("id", trId)
                    .put("fileName", fileName)
                    .put("fileSize", bytes.size)
                    .put("mimeType", "application/octet-stream")
                    .put("fromDeviceId", deviceId)
                    .put("fromDeviceName", "\${Build.MANUFACTURER} \${Build.MODEL}")
                    .put("toDeviceId", "all")
                    .put("toDeviceName", "Todos os dispositivos")
                    .put("status", "transferring")
                    .put("progress", 0)
                    .put("speedMbps", 0)
                    .put("createdAt", System.currentTimeMillis())
                sendWs(JSONObject().put("type", "file:start").put("record", record))

                val chunkSize = 48 * 1024
                val total = maxOf(1, (bytes.size + chunkSize - 1) / chunkSize)
                for (i in 0 until total) {
                    val start = i * chunkSize
                    val end = minOf(bytes.size, start + chunkSize)
                    val b64 = Base64.encodeToString(bytes.copyOfRange(start, end), Base64.NO_WRAP)
                    sendWs(
                        JSONObject()
                            .put("type", "file:chunk")
                            .put("transferId", trId)
                            .put("toDeviceId", "all")
                            .put("chunkIndex", i)
                            .put("totalChunks", total)
                            .put("data", b64)
                            .put("progress", minOf(99, ((i + 1) * 100) / total))
                            .put("speedMbps", 8)
                    )
                }
                sendWs(JSONObject().put("type", "file:complete").put("transferId", trId).put("toDeviceId", "all"))
                runOnUiThread { Toast.makeText(this, "Enviado: \$fileName", Toast.LENGTH_SHORT).show() }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, "Falha ao enviar: \${e.message}", Toast.LENGTH_SHORT).show() }
            }
        }.start()
    }

    private fun handleWsMessage(raw: String) {
        val msg = try { JSONObject(raw) } catch (_: Exception) { return }
        when (msg.optString("type")) {
            "mesh:init" -> {
                val snap = msg.optJSONObject("snapshot") ?: return
                devices.clear()
                snap.optJSONArray("devices")?.let { arr -> for (i in 0 until arr.length()) devices.add(arr.getJSONObject(i)) }
                clipboardItems.clear()
                snap.optJSONArray("clipboard")?.let { arr -> for (i in 0 until arr.length()) clipboardItems.add(arr.getJSONObject(i)) }
                notifications.clear()
                snap.optJSONArray("notifications")?.let { arr -> for (i in 0 until arr.length()) notifications.add(arr.getJSONObject(i)) }
                runOnUiThread { refreshAllLists() }
            }
            "mesh:devices_sync" -> {
                devices.clear()
                msg.optJSONArray("devices")?.let { arr -> for (i in 0 until arr.length()) devices.add(arr.getJSONObject(i)) }
                runOnUiThread { refreshDevicesUi() }
            }
            "device:joined", "device:updated" -> {
                val dev = msg.optJSONObject("device") ?: return
                val id = dev.optString("id")
                devices.removeAll { it.optString("id") == id }
                devices.add(dev)
                runOnUiThread { refreshDevicesUi() }
            }
            "device:left" -> {
                val id = msg.optString("deviceId")
                devices.removeAll { it.optString("id") == id }
                runOnUiThread { refreshDevicesUi() }
            }
            "clipboard:added" -> {
                msg.optJSONObject("item")?.let { clipboardItems.add(0, it) }
                runOnUiThread { refreshClipboardUi() }
            }
            "notification:added" -> {
                msg.optJSONObject("notification")?.let { notifications.add(0, it) }
                runOnUiThread { refreshNotificationsUi() }
            }
            "file:start" -> {
                val rec = msg.optJSONObject("record") ?: return
                if (rec.optString("fromDeviceId") != deviceId) {
                    pendingFiles[rec.optString("id")] = PendingFile(rec.optString("fileName", "arquivo.bin"))
                }
            }
            "file:chunk" -> {
                val id = msg.optString("transferId")
                pendingFiles[id]?.let { pf ->
                    pf.total = msg.optInt("totalChunks")
                    pf.chunks[msg.optInt("chunkIndex")] = msg.optString("data")
                }
            }
            "file:complete" -> {
                val pf = pendingFiles.remove(msg.optString("transferId")) ?: return
                try {
                    val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Continuum").apply { mkdirs() }
                    val outFile = File(dir, File(pf.name).name)
                    FileOutputStream(outFile).use { fos ->
                        for (i in 0 until pf.total) {
                            pf.chunks[i]?.let { fos.write(Base64.decode(it, Base64.DEFAULT)) }
                        }
                    }
                    runOnUiThread { Toast.makeText(this, "Arquivo recebido: \${outFile.name}", Toast.LENGTH_LONG).show() }
                } catch (_: Exception) { }
            }
            "input:event" -> {
                val inp = msg.optJSONObject("input")
                if (inp?.optString("kind") == "command" && inp.optString("action") == "ping") {
                    runOnUiThread { Toast.makeText(this, "Continuum: Alerta de localizacao recebido!", Toast.LENGTH_LONG).show() }
                }
            }
        }
    }

    private fun refreshAllLists() {
        refreshDevicesUi()
        refreshClipboardUi()
        refreshNotificationsUi()
    }

    private fun refreshDevicesUi() {
        devicesContainer.removeAllViews()
        val peerNames = mutableListOf<String>()
        for (dev in devices) {
            val id = dev.optString("id")
            val isSelf = id == deviceId
            val tel = dev.optJSONObject("telemetry")
            val cpu = if (tel != null && !tel.isNull("cpuUsage")) "CPU \${tel.optInt("cpuUsage")}%" else "CPU —"
            val bat = if (tel != null && !tel.isNull("batteryLevel")) "Bat \${tel.optInt("batteryLevel")}%" else "CA"
            if (!isSelf) peerNames.add(dev.optString("name", id))

            val card = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                background = cardBg()
                setPadding(dp(12), dp(10), dp(12), dp(10))
                gravity = Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    bottomMargin = dp(8)
                }
            }
            val info = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            info.addView(TextView(this).apply {
                text = dev.optString("name") + if (isSelf) " (Este Android)" else ""
                setTextColor(textPrimary)
                textSize = 14f
            })
            info.addView(TextView(this).apply {
                text = "\${dev.optString("os").uppercase()} · \$cpu · \$bat"
                setTextColor(textMuted)
                textSize = 12f
            })
            card.addView(info)
            if (!isSelf) {
                card.addView(makeButton("Ping") {
                    sendWs(JSONObject().put("type", "input:event").put("toDeviceId", id).put("input", JSONObject().put("kind", "command").put("action", "ping")))
                })
            }
            devicesContainer.addView(card)
        }
        targetSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, if (peerNames.isEmpty()) listOf("Nenhum PC pareado") else peerNames)
    }

    private fun refreshClipboardUi() {
        val lines = clipboardItems.map { "[\${it.optString("sourceDeviceName")}] \${it.optString("content").take(90)}" }
        clipListView.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, lines)
    }

    private fun refreshNotificationsUi() {
        val lines = notifications.map { "\${it.optString("app")} · \${it.optString("title")}" }
        notifListView.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, lines)
    }
}

private class NativeTrackpadView(
    context: Context,
    private val onInput: (JSONObject) -> Unit
) : View(context) {

    private val bgPaint = Paint().apply { color = Color.parseColor("#11151B") }
    private val borderPaint = Paint().apply {
        color = Color.parseColor("#222936")
        style = Paint.Style.STROKE
        strokeWidth = 3f
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#94A3B8")
        textSize = 34f
    }

    private var lastX = 0f
    private var lastY = 0f
    private var startX = 0f
    private var startY = 0f
    private var maxPointers = 1

    override fun onDraw(canvas: Canvas) {
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)
        canvas.drawRect(2f, 2f, width - 2f, height - 2f, borderPaint)
        canvas.drawText("Trackpad Nativo Multi-Toque", 32f, 64f, textPaint)
        canvas.drawText("Arraste: mover cursor · 1 toque: clique · 2 dedos: clique direito", 32f, 112f, textPaint)
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastX = ev.x; lastY = ev.y; startX = ev.x; startY = ev.y; maxPointers = 1
                return true
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                maxPointers = maxOf(maxPointers, ev.pointerCount)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = (ev.x - lastX) * 1.9f
                val dy = (ev.y - lastY) * 1.9f
                lastX = ev.x; lastY = ev.y
                if (abs(dx) >= 1f || abs(dy) >= 1f) {
                    onInput(JSONObject().put("kind", "move").put("nx", 0.5).put("ny", 0.5).put("dx", dx.toInt()).put("dy", dy.toInt()))
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                if (abs(ev.x - startX) < 14f && abs(ev.y - startY) < 14f) {
                    val btn = if (maxPointers >= 2) "right" else "left"
                    onInput(JSONObject().put("kind", "click").put("button", btn))
                }
                return true
            }
        }
        return super.onTouchEvent(ev)
    }
}
`;

  const stylesXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.Continuum" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="android:windowBackground">#090B0E</item>
        <item name="android:statusBarColor">#090B0E</item>
        <item name="android:navigationBarColor">#090B0E</item>
        <item name="colorPrimary">#3B82F6</item>
        <item name="colorPrimaryVariant">#2563EB</item>
        <item name="colorOnPrimary">#FFFFFF</item>
    </style>
</resources>
`;

  const icBg = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#090B0E" />
</shape>
`;

  const icFg = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#3B82F6"
        android:pathData="M34,36h26c2.2,0 4,1.8 4,4v28c0,2.2 -1.8,4 -4,4H34c-2.2,0 -4,-1.8 -4,-4V40C30,37.8 31.8,36 34,36z" />
    <path
        android:fillColor="#60A5FA"
        android:pathData="M68,46h10c2.2,0 4,1.8 4,4v18c0,2.2 -1.8,4 -4,4H68c-2.2,0 -4,-1.8 -4,-4V50C64,47.8 65.8,46 68,46z" />
</vector>
`;

  const icAnyDpi = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;

  const entries: ZipEntryInput[] = [
    { name: p('settings.gradle.kts'), content: settingsKts },
    { name: p('build.gradle.kts'), content: rootBuildKts },
    { name: p('gradle.properties'), content: gradleProps },
    { name: p('app/build.gradle.kts'), content: appBuildKts },
    { name: p('app/src/main/AndroidManifest.xml'), content: manifest },
    { name: p('app/src/main/java/app/continuum/mesh/MainActivity.kt'), content: mainActivityKt },
    { name: p('app/src/main/res/values/styles.xml'), content: stylesXml },
    { name: p('app/src/main/res/drawable/ic_launcher_background.xml'), content: icBg },
    { name: p('app/src/main/res/drawable/ic_launcher_foreground.xml'), content: icFg },
    { name: p('app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml'), content: icAnyDpi },
  ];

  if (png192) {
    entries.push({ name: p('app/src/main/res/mipmap-xxxhdpi/ic_launcher.png'), content: png192 });
  }

  return entries;
}
