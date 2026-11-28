#!/usr/bin/env python3
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

DEFAULT_SERVER_URL = "https://ais-pre-a6iomfzcjhr5udpk6kpqgs-702819737353.us-east1.run.app"
DEFAULT_WS_URL = "wss://ais-pre-a6iomfzcjhr5udpk6kpqgs-702819737353.us-east1.run.app/ws"
DEFAULT_ROOM_CODE = "MESH01"

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
            f.write(f"[{ts}] {msg}\n")
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
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host_header}\r\n"
            f"Origin: {self.origin}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode("ascii"))
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(1024)
            if not chunk:
                raise ConnectionError("Handshake fechado pelo servidor")
            resp += chunk
        status_line = resp.split(b"\r\n", 1)[0].decode("ascii", "ignore")
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

    ok_init, _ = Gtk.init_check(sys.argv)
    if not ok_init:
        raise RuntimeError("Display grafico X11/Wayland indisponivel para GTK 3.")

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
    try:
        screen = Gdk.Screen.get_default()
        if screen is not None:
            provider = Gtk.CssProvider()
            provider.load_from_data(css)
            Gtk.StyleContext.add_provider_for_screen(
                screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            )
    except Exception as css_exc:
        log_msg(f"Aviso CSS GTK 3 ignorado: {css_exc}")

    class ContinuumWindow(Gtk.Window):
        def __init__(self):
            super().__init__(title="Continuum — Aplicativo Nativo Linux")
            self.set_default_size(980, 680)
            self.set_border_width(0)
            self.set_position(Gtk.WindowPosition.CENTER)

            for icon_cand in (
                os.path.join(os.environ.get("APPDIR", ""), "continuum.png"),
                "/usr/share/icons/hicolor/512x512/apps/continuum.png",
            ):
                if icon_cand and os.path.isfile(icon_cand):
                    try:
                        self.set_icon_from_file(icon_cand)
                        break
                    except Exception:
                        pass

            self.cfg = load_config()
            self.devices = []
            self.clipboard_items = []
            self.notifications = []
            self.target_device_id = None
            self._drag_last = None
            self._press_pos = None

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
    win.present()
    Gtk.main()


def run_tk_app():
    import tkinter as tk
    from tkinter import filedialog, ttk

    cfg = load_config()
    root = tk.Tk()
    root.title("Continuum — Aplicativo Nativo Linux")
    root.geometry("940x640")
    root.configure(bg="#090B0E")

    ev_q = queue.Queue()
    state = {"devices": [], "target_id": None, "drag_last": None}

    top = tk.Frame(root, bg="#11151B", padx=12, pady=10)
    top.pack(fill="x")
    tk.Label(top, text="CONTINUUM", fg="#F1F5F9", bg="#11151B", font=("Sans", 12, "bold")).pack(side="left")
    status_var = tk.StringVar(value=f"Conectando ({cfg['roomCode']})...")
    tk.Label(top, textvariable=status_var, fg="#60A5FA", bg="#11151B", font=("Sans", 10)).pack(side="left", padx=14)

    room_var = tk.StringVar(value=cfg["roomCode"])
    srv_var = tk.StringVar(value=cfg["serverUrl"])
    tk.Entry(top, textvariable=srv_var, width=36, bg="#090B0E", fg="#F1F5F9", insertbackground="#F1F5F9").pack(side="left", padx=4)
    tk.Entry(top, textvariable=room_var, width=9, bg="#090B0E", fg="#F1F5F9", insertbackground="#F1F5F9").pack(side="left", padx=4)

    client = MeshClientThread(cfg, lambda ev: ev_q.put(ev))

    def reconnect():
        cfg["serverUrl"] = srv_var.get().strip().rstrip("/")
        cfg["roomCode"] = "".join(c for c in room_var.get().upper() if c.isalnum())[:8] or "MESH01"
        save_config(cfg)
        client.reconfigure(cfg)
        status_var.set(f"Reconectando ({cfg['roomCode']})...")

    tk.Button(top, text="Conectar", command=reconnect, bg="#3B82F6", fg="#FFFFFF", relief="flat", padx=10).pack(side="left", padx=4)

    nb = ttk.Notebook(root)
    nb.pack(fill="both", expand=True, padx=12, pady=10)

    tab_dev = tk.Frame(nb, bg="#090B0E")
    nb.add(tab_dev, text="Dispositivos")
    dev_list = tk.Listbox(tab_dev, bg="#11151B", fg="#F1F5F9", selectbackground="#3B82F6", font=("Sans", 10))
    dev_list.pack(fill="both", expand=True, padx=8, pady=8)

    def on_select_dev(_ev):
        sel = dev_list.curselection()
        if sel:
            idx = sel[0]
            peers = [d for d in state["devices"] if d.get("id") != DEVICE_ID]
            if 0 <= idx < len(peers):
                state["target_id"] = peers[idx].get("id")

    dev_list.bind("<<ListboxSelect>>", on_select_dev)

    tab_rem = tk.Frame(nb, bg="#090B0E")
    nb.add(tab_rem, text="Controle Remoto")
    pad = tk.Canvas(tab_rem, bg="#11151B", height=280, highlightthickness=1, highlightbackground="#222936")
    pad.pack(fill="both", expand=True, padx=8, pady=8)
    pad.create_text(16, 20, anchor="nw", fill="#94A3B8", text="Trackpad Nativo — arraste para mover o cursor remoto · clique esquerdo/direito")

    def send_inp(payload):
        if state["target_id"]:
            client.send({"type": "input:event", "toDeviceId": state["target_id"], "input": payload})

    pad.bind("<ButtonPress-1>", lambda e: state.__setitem__("drag_last", (e.x, e.y)))
    def on_drag(e):
        last = state["drag_last"]
        if last:
            dx, dy = (e.x - last[0]) * 2, (e.y - last[1]) * 2
            state["drag_last"] = (e.x, e.y)
            if abs(dx) >= 1 or abs(dy) >= 1:
                send_inp({"kind": "move", "nx": 0.5, "ny": 0.5, "dx": round(dx), "dy": round(dy)})
    pad.bind("<B1-Motion>", on_drag)
    pad.bind("<ButtonRelease-1>", lambda _e: send_inp({"kind": "click", "button": "left"}))
    pad.bind("<Button-3>", lambda _e: send_inp({"kind": "click", "button": "right"}))

    btn_row = tk.Frame(tab_rem, bg="#090B0E")
    btn_row.pack(fill="x", padx=8, pady=4)
    for lbl, act in [("Vol -", "vol_down"), ("Vol +", "vol_up"), ("Play/Pause", "media_play_pause"), ("Bloquear", "lock"), ("Localizar", "ping")]:
        tk.Button(btn_row, text=lbl, command=lambda a=act: send_inp({"kind": "command", "action": a}), bg="#171C24", fg="#F1F5F9", relief="flat", padx=10, pady=5).pack(side="left", padx=4)

    tab_cf = tk.Frame(nb, bg="#090B0E")
    nb.add(tab_cf, text="Arquivos & Clipboard")
    clip_box = tk.Text(tab_cf, height=10, bg="#11151B", fg="#F1F5F9", insertbackground="#F1F5F9")
    clip_box.pack(fill="both", expand=True, padx=8, pady=8)

    cf_bar = tk.Frame(tab_cf, bg="#090B0E")
    cf_bar.pack(fill="x", padx=8, pady=6)
    def push_clip():
        txt = clip_box.get("1.0", "end").strip()
        if txt:
            client.send({"type": "clipboard:push", "item": {"id": f"clip-{int(time.time()*1000)}", "content": txt, "kind": "url" if txt.startswith("http") else "text", "sourceDeviceId": DEVICE_ID, "sourceDeviceName": cfg["deviceName"], "createdAt": int(time.time()*1000)}})
    def pick_file():
        p = filedialog.askopenfilename(title="Selecionar arquivo para enviar")
        if p:
            client.send_file(p, state["target_id"] or "all")
    tk.Button(cf_bar, text="Sincronizar Clipboard", command=push_clip, bg="#3B82F6", fg="#FFFFFF", relief="flat", padx=12, pady=6).pack(side="left", padx=4)
    tk.Button(cf_bar, text="Enviar Arquivo...", command=pick_file, bg="#171C24", fg="#F1F5F9", relief="flat", padx=12, pady=6).pack(side="left", padx=4)

    def poll():
        while True:
            try:
                msg = ev_q.get_nowait()
            except queue.Empty:
                break
            t = msg.get("type")
            if t == "local:status":
                status_var.set(f"{msg.get('state')} · {cfg['roomCode']}")
            elif t in ("mesh:init", "mesh:devices_sync", "device:joined", "device:updated", "device:left"):
                if t == "mesh:init":
                    state["devices"] = (msg.get("snapshot") or {}).get("devices") or []
                elif t == "mesh:devices_sync":
                    state["devices"] = msg.get("devices") or []
                elif t in ("device:joined", "device:updated") and msg.get("device"):
                    d = msg["device"]
                    state["devices"] = [x for x in state["devices"] if x.get("id") != d.get("id")] + [d]
                elif t == "device:left":
                    state["devices"] = [x for x in state["devices"] if x.get("id") != msg.get("deviceId")]
                dev_list.delete(0, "end")
                peers = [d for d in state["devices"] if d.get("id") != DEVICE_ID]
                for p in peers:
                    dev_list.insert("end", f"{p.get('name', 'Dispositivo')} [{str(p.get('os', '')).upper()}]")
                if not state["target_id"] and peers:
                    state["target_id"] = peers[0].get("id")
            elif t == "clipboard:added" and msg.get("item"):
                clip_box.delete("1.0", "end")
                clip_box.insert("1.0", str(msg["item"].get("content") or ""))
        root.after(120, poll)

    client.start()
    root.after(120, poll)
    root.protocol("WM_DELETE_WINDOW", lambda: (client.stop(), root.destroy()))
    root.mainloop()


def show_graphical_error(title, body):
    try:
        if shutil.which("zenity"):
            subprocess.Popen(["zenity", "--error", "--width=460", f"--title={title}", f"--text={body}"])
            return
        if shutil.which("kdialog"):
            subprocess.Popen(["kdialog", "--error", body, "--title", title])
            return
        if shutil.which("notify-send"):
            subprocess.Popen(["notify-send", "-u", "critical", title, body])
    except Exception:
        pass


def main():
    import traceback

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

    log_msg(f"Iniciando Continuum Linux GUI (python={sys.executable}, DISPLAY={os.environ.get('DISPLAY')}, WAYLAND={os.environ.get('WAYLAND_DISPLAY')})")
    try:
        run_gtk_app()
        return
    except Exception as gtk_exc:
        log_msg(f"Falha ao iniciar GTK 3: {gtk_exc}\n{traceback.format_exc()}")

    try:
        log_msg("Tentando fallback grafico nativo Tkinter...")
        run_tk_app()
        return
    except Exception as tk_exc:
        log_msg(f"Falha tambem no fallback Tkinter: {tk_exc}\n{traceback.format_exc()}")
        msg = (
            f"Nao foi possivel abrir a janela nativa do Continuum.\n\n"
            f"Instale GTK 3 para Python no Linux:\n"
            f"sudo apt install python3-gi gir1.2-gtk-3.0\n\n"
            f"Log completo salvo em:\n{LOG_FILE}"
        )
        print(msg, file=sys.stderr)
        show_graphical_error("Continuum — Erro ao Abrir Interface", msg)
        sys.exit(1)


if __name__ == "__main__":
    main()
