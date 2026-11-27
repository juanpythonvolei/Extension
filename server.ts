import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ClipboardItem,
  DeviceNode,
  FileTransferRecord,
  MeshNotification,
  MeshStateSnapshot,
  RemoteInputPayload,
  ScreenSessionMeta,
} from './src/types/mesh.ts';
import {
  buildAndroidNativeZip,
  buildLinuxAppImage,
  buildLinuxDebPackage,
  buildLinuxInstallerZip,
  buildWindowsInstallerZip,
} from './src/server/platformInstallers.ts';
import { buildNativeRepoZip } from './src/server/nativeRepoBuilder.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

interface RoomClient {
  ws: WebSocket;
  deviceId: string;
  roomCode: string;
  isCompanion: boolean;
}

interface MeshRoom {
  code: string;
  devices: Map<string, DeviceNode>;
  clients: Map<string, WebSocket>;
  companions: Map<string, WebSocket>;
  clipboard: ClipboardItem[];
  notifications: MeshNotification[];
  transfers: FileTransferRecord[];
  screenSessions: Map<string, ScreenSessionMeta>;
  lastActivityAt: number;
}

const rooms = new Map<string, MeshRoom>();

function sanitizeRoomCode(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  if (cleaned.length >= 4) return cleaned;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function getOrCreateRoom(code: string): MeshRoom {
  const existing = rooms.get(code);
  if (existing) {
    existing.lastActivityAt = Date.now();
    return existing;
  }
  const room: MeshRoom = {
    code,
    devices: new Map(),
    clients: new Map(),
    companions: new Map(),
    clipboard: [],
    notifications: [],
    transfers: [],
    screenSessions: new Map(),
    lastActivityAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function getSnapshot(room: MeshRoom): MeshStateSnapshot {
  return {
    roomCode: room.code,
    devices: Array.from(room.devices.values()),
    clipboard: room.clipboard.slice(0, 40),
    notifications: room.notifications.slice(0, 60),
    transfers: room.transfers.slice(0, 40),
    screenSessions: Array.from(room.screenSessions.values()),
  };
}

function sendJson(ws: WebSocket | undefined, payload: unknown) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcastRoom(room: MeshRoom, payload: unknown, excludeDeviceId?: string) {
  const serialized = JSON.stringify(payload);
  for (const [devId, clientWs] of room.clients.entries()) {
    if (excludeDeviceId && devId === excludeDeviceId) continue;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(serialized);
    }
  }
}

function computeDefaultSlot(room: MeshRoom, formFactor: DeviceNode['formFactor']): { x: number; y: number } {
  const existing = Array.from(room.devices.values());
  if (existing.length === 0) {
    return { x: 260, y: 150 };
  }
  let maxRight = 260;
  let baseY = 150;
  for (const d of existing) {
    const scaleW = d.formFactor === 'mobile' ? 110 : d.formFactor === 'tablet' ? 170 : 250;
    const rightEdge = d.x + scaleW + 24;
    if (rightEdge > maxRight) {
      maxRight = rightEdge;
      baseY = d.y;
    }
  }
  return {
    x: Math.min(maxRight, 760),
    y: formFactor === 'mobile' ? baseY + 40 : baseY,
  };
}

function buildCompanionScript(roomCode: string, wsUrl: string, targetOs: 'windows' | 'linux'): string {
  const safeRoom = sanitizeRoomCode(roomCode);
  const safeWs = wsUrl.replace(/[`'"\\]/g, '');
  const isWin = targetOs === 'windows';

  return `#!/usr/bin/env node
/**
 * Continuum Desktop Companion Agent (${isWin ? 'Windows' : 'Linux'})
 * Conecta o sistema operacional diretamente à malha Continuum em tempo real.
 *
 * Requisitos: Node.js 22+ (WebSocket nativo) ou pacote 'ws'.
 * Uso: node continuum-agent-${targetOs}.mjs
 */

import os from 'node:os';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const ROOM_CODE = ${JSON.stringify(safeRoom)};
const WS_URL = ${JSON.stringify(safeWs)};
const TARGET_OS = ${JSON.stringify(targetOs)};
const DEVICE_NAME = os.hostname() || (${isWin ? "'Desktop Windows'" : "'Estação Linux'"});
const DEVICE_ID = 'companion-' + os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);

let prevCpuTimes = getCpuTotals();

function getCpuTotals() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const key of Object.keys(cpu.times)) {
      total += cpu.times[key];
    }
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function sampleCpuUsage() {
  const curr = getCpuTotals();
  const idleDiff = curr.idle - prevCpuTimes.idle;
  const totalDiff = curr.total - prevCpuTimes.total;
  prevCpuTimes = curr;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
}

async function listOpenWindows() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne \\"\\"} | Select-Object -First 8 ProcessName,MainWindowTitle | ConvertTo-Json -Compress"',
        { timeout: 2500 }
      );
      if (!stdout.trim()) return [];
      const parsed = JSON.parse(stdout);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((item, idx) => ({
        id: 'win-' + idx + '-' + item.ProcessName,
        name: String(item.ProcessName || 'App'),
        title: String(item.MainWindowTitle || item.ProcessName || 'Janela'),
        source: 'os-agent',
        focused: idx === 0,
      }));
    } else if (process.platform === 'linux') {
      const { stdout } = await execAsync('wmctrl -l 2>/dev/null | head -n 8', { timeout: 2000 });
      return stdout
        .split('\\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, idx) => {
          const parts = line.split(/\\s+/);
          const title = parts.slice(3).join(' ') || 'Janela Linux';
          return {
            id: 'lin-' + idx + '-' + parts[0],
            name: title.split(' - ').pop() || title.slice(0, 22),
            title,
            source: 'os-agent',
            focused: idx === 0,
          };
        });
    }
  } catch {
    return [];
  }
  return [];
}

async function executeNativeInput(input) {
  try {
    if (process.platform === 'win32') {
      if (input.kind === 'command') {
        const keyMap = {
          vol_up: '[char]175',
          vol_down: '[char]174',
          vol_mute: '[char]173',
          media_play_pause: '[char]179',
          media_next: '[char]176',
          media_prev: '[char]177',
        };
        if (keyMap[input.action]) {
          await execAsync(
            \`powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).SendKeys(\${keyMap[input.action]})"\`
          );
        } else if (input.action === 'lock') {
          await execAsync('rundll32.exe user32.dll,LockWorkStation');
        } else if (input.action === 'open_url' && typeof input.payload === 'string' && /^https?:\\/\\//i.test(input.payload)) {
          await execFileAsync('cmd', ['/c', 'start', '', input.payload]);
        }
      } else if (input.kind === 'text' && input.text) {
        const escaped = String(input.text).replace(/[+^%~(){}\\[\\]]/g, '{$&}').replace(/"/g, '""');
        await execAsync(\`powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).SendKeys(\\"\${escaped}\\")"\`);
      }
    } else if (process.platform === 'linux') {
      if (input.kind === 'move' && typeof input.dx === 'number' && typeof input.dy === 'number') {
        await execFileAsync('xdotool', ['mousemove_relative', '--', String(Math.round(input.dx)), String(Math.round(input.dy))]);
      } else if (input.kind === 'click') {
        const btn = input.button === 'right' ? '3' : input.button === 'middle' ? '2' : '1';
        await execFileAsync('xdotool', ['click', btn]);
      } else if (input.kind === 'scroll' && typeof input.dy === 'number') {
        const dir = input.dy > 0 ? '5' : '4';
        await execFileAsync('xdotool', ['click', dir]);
      } else if (input.kind === 'text' && input.text) {
        await execFileAsync('xdotool', ['type', '--delay', '1', String(input.text)]);
      } else if (input.kind === 'command') {
        if (input.action === 'vol_up') await execAsync('pactl set-sink-volume @DEFAULT_SINK@ +5%');
        if (input.action === 'vol_down') await execAsync('pactl set-sink-volume @DEFAULT_SINK@ -5%');
        if (input.action === 'vol_mute') await execAsync('pactl set-sink-mute @DEFAULT_SINK@ toggle');
        if (input.action === 'media_play_pause') await execAsync('playerctl play-pause');
        if (input.action === 'media_next') await execAsync('playerctl next');
        if (input.action === 'media_prev') await execAsync('playerctl previous');
        if (input.action === 'open_url' && typeof input.payload === 'string' && /^https?:\\/\\//i.test(input.payload)) {
          await execFileAsync('xdg-open', [input.payload]);
        }
      }
    }
  } catch (err) {
    console.warn('[Continuum Agent] Aviso ao executar comando nativo:', err?.message || err);
  }
}

async function resolveWebSocketImpl() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  const mod = await import('ws');
  return mod.default || mod.WebSocket;
}

async function start() {
  const WS = await resolveWebSocketImpl();
  console.log(\`[Continuum Agent] Conectando à malha \${ROOM_CODE} em \${WS_URL}...\`);

  const connect = () => {
    const ws = new WS(WS_URL);
    let telemetryTimer = null;

    const send = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };

    const pushTelemetry = async () => {
      const totalGb = +(os.totalmem() / 1073741824).toFixed(1);
      const freeGb = +(os.freemem() / 1073741824).toFixed(1);
      const usedGb = +(totalGb - freeGb).toFixed(1);
      const openApps = await listOpenWindows();
      send({
        type: 'companion:telemetry',
        telemetry: {
          cpuCores: os.cpus().length,
          cpuUsage: sampleCpuUsage(),
          memoryTotalGb: totalGb,
          memoryUsedGb: usedGb,
          openApps,
        },
      });
    };

    ws.addEventListener('open', async () => {
      console.log(\`[Continuum Agent] Online como "\${DEVICE_NAME}" na malha \${ROOM_CODE}.\`);
      send({
        type: 'companion:register',
        roomCode: ROOM_CODE,
        deviceId: DEVICE_ID,
        name: DEVICE_NAME,
        os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      });
      await pushTelemetry();
      telemetryTimer = setInterval(pushTelemetry, 4000);
    });

    ws.addEventListener('message', async (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.type === 'input:event' && msg.input) {
          await executeNativeInput(msg.input);
        }
      } catch {
        // Ignora pacotes malformados
      }
    });

    ws.addEventListener('close', () => {
      if (telemetryTimer) clearInterval(telemetryTimer);
      console.log('[Continuum Agent] Desconectado. Tentando reconectar em 3s...');
      setTimeout(connect, 3000);
    });

    ws.addEventListener('error', (err) => {
      console.error('[Continuum Agent] Erro na conexão:', err?.message || 'falha de socket');
    });
  };

  connect();
}

start();
`;
}

async function bootstrap() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    let totalDevices = 0;
    for (const room of rooms.values()) {
      totalDevices += room.devices.size;
    }
    res.json({ ok: true, rooms: rooms.size, devices: totalDevices, timestamp: Date.now() });
  });

  app.get('/api/companion-script', (req, res) => {
    const roomCode = sanitizeRoomCode(req.query.room);
    const targetOs = req.query.os === 'linux' ? 'linux' : 'windows';
    const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'wss' : 'ws';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const wsUrl = `${proto}://${host}/ws`;
    const script = buildCompanionScript(roomCode, wsUrl, targetOs);

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="continuum-agent-${targetOs}.mjs"`);
    res.send(script);
  });

  const serverStartedAt = Date.now();

  function resolveServerEndpoints(req: express.Request): {
    appUrl: string;
    wsUrl: string;
    isPrivatePreview: boolean;
  } {
    const customServerRaw = typeof req.query.server === 'string' ? req.query.server.trim() : '';
    if (customServerRaw) {
      try {
        const parsed = new URL(customServerRaw);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          const origin = parsed.origin;
          const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
          return {
            appUrl: origin,
            wsUrl: `${wsProto}//${parsed.host}/ws`,
            isPrivatePreview: parsed.hostname.startsWith('ais-dev-'),
          };
        }
      } catch {
        // Fallback to request origin
      }
    }

    const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.secure;
    const httpProto = isHttps ? 'https' : 'http';
    const wsProto = isHttps ? 'wss' : 'ws';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`);
    return {
      appUrl: `${httpProto}://${host}`,
      wsUrl: `${wsProto}://${host}/ws`,
      isPrivatePreview: host.startsWith('ais-dev-'),
    };
  }

  app.get('/api/diagnostics', (req, res) => {
    const roomCode = sanitizeRoomCode(req.query.room);
    const room = rooms.get(roomCode);
    const endpoints = resolveServerEndpoints(req);
    const roomDevices = room ? Array.from(room.devices.values()) : [];
    const companionDevices = roomDevices
      .filter((d) => d.companionConnected)
      .map((d) => ({
        id: d.id,
        name: d.name,
        os: d.os,
        displayServer: d.telemetry.displayServer ?? 'web',
        companionLastSeenAt: d.telemetry.companionLastSeenAt ?? d.lastSeenAt,
        cpuUsage: d.telemetry.cpuUsage,
      }));

    res.json({
      ok: true,
      roomCode,
      uptimeSec: Math.round((Date.now() - serverStartedAt) / 1000),
      appUrl: endpoints.appUrl,
      wsUrl: endpoints.wsUrl,
      isPrivatePreview: endpoints.isPrivatePreview,
      browserClientsCount: room ? room.clients.size : 0,
      companionCount: Math.max(room ? room.companions.size : 0, companionDevices.length),
      totalDevicesInRoom: roomDevices.length,
      companionDevices,
      timestamp: Date.now(),
    });
  });

  app.get('/api/download-app/:platform', (req, res) => {
    const platform = String(req.params.platform || '').toLowerCase();
    const roomCode = sanitizeRoomCode(req.query.room);
    const endpoints = resolveServerEndpoints(req);
    const ctx = {
      roomCode,
      appUrl: endpoints.appUrl,
      wsUrl: endpoints.wsUrl,
    };

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (platform === 'windows') {
      const zip = buildWindowsInstallerZip(ctx);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="Continuum-Windows.zip"');
      res.send(zip);
      return;
    }

    if (platform === 'linux-appimage') {
      const appImage = buildLinuxAppImage(ctx);
      res.setHeader('Content-Type', 'application/vnd.appimage');
      res.setHeader('Content-Disposition', 'attachment; filename="Continuum-Linux-x86_64.AppImage"');
      res.send(appImage);
      return;
    }

    if (platform === 'linux-deb') {
      const deb = buildLinuxDebPackage(ctx);
      res.setHeader('Content-Type', 'application/vnd.debian.binary-package');
      res.setHeader('Content-Disposition', 'attachment; filename="Continuum-Linux.deb"');
      res.send(deb);
      return;
    }

    if (platform === 'linux') {
      const zip = buildLinuxInstallerZip(ctx);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="Continuum-Linux-Universal.zip"');
      res.send(zip);
      return;
    }

    if (platform === 'android') {
      const zip = buildAndroidNativeZip(ctx);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="Continuum-Android-Native.zip"');
      res.send(zip);
      return;
    }

    if (platform === 'native-repo') {
      const zip = buildNativeRepoZip(ctx);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="Continuum-Native-Repo.zip"');
      res.send(zip);
      return;
    }

    res.status(400).json({ error: 'Plataforma inválida. Use windows, linux-appimage, linux-deb, linux, android ou native-repo.' });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024 * 1024,
  });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  const clientMeta = new WeakMap<WebSocket, RoomClient>();

  wss.on('connection', (ws) => {
    ws.on('message', (rawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      const type = String(msg.type ?? '');

      if (type === 'telemetry:ping') {
        sendJson(ws, { type: 'telemetry:pong', sentAt: msg.sentAt, serverTime: Date.now() });
        return;
      }

      if (type === 'mesh:join') {
        const roomCode = sanitizeRoomCode(msg.roomCode);
        const rawDevice = (msg.device ?? {}) as Partial<DeviceNode>;
        const deviceId = String(rawDevice.id || `dev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`).slice(0, 64);

        // Detach from previous room if switching rooms
        const prev = clientMeta.get(ws);
        if (prev && prev.roomCode !== roomCode) {
          const oldRoom = rooms.get(prev.roomCode);
          if (oldRoom) {
            oldRoom.clients.delete(prev.deviceId);
            oldRoom.devices.delete(prev.deviceId);
            broadcastRoom(oldRoom, { type: 'device:left', deviceId: prev.deviceId });
          }
        }

        const room = getOrCreateRoom(roomCode);
        const rawOs = rawDevice.os ?? 'unknown';
        const rawForm = rawDevice.formFactor ?? 'desktop';

        // If a standalone native companion of the same OS connected BEFORE this browser window,
        // merge them cleanly into ONE unified node so the Spatial Map never shows duplicate PCs!
        let mergedCompanionNode: DeviceNode | undefined;
        if (rawForm === 'desktop' || rawForm === 'laptop') {
          const orphanCompanion = Array.from(room.devices.values()).find(
            (d) =>
              d.id !== deviceId &&
              d.companionConnected &&
              !room.clients.has(d.id) &&
              room.companions.has(d.id) &&
              (d.os === rawOs || rawOs === 'unknown')
          );
          if (orphanCompanion) {
            mergedCompanionNode = orphanCompanion;
            const compWs = room.companions.get(orphanCompanion.id);
            room.companions.delete(orphanCompanion.id);
            room.devices.delete(orphanCompanion.id);
            if (compWs) {
              room.companions.set(deviceId, compWs);
              clientMeta.set(compWs, { ws: compWs, deviceId, roomCode, isCompanion: true });
            }
          }
        }

        const existingNode = room.devices.get(deviceId) ?? mergedCompanionNode;
        const slot = existingNode
          ? { x: existingNode.x, y: existingNode.y }
          : computeDefaultSlot(room, rawForm);

        const isPrimary =
          existingNode?.isPrimary ??
          (room.devices.size === 0 || (rawForm === 'desktop' && !Array.from(room.devices.values()).some((d) => d.isPrimary)));

        const node: DeviceNode = {
          id: deviceId,
          name: String(rawDevice.name || existingNode?.name || 'Dispositivo').slice(0, 48),
          os: rawOs !== 'unknown' ? rawOs : existingNode?.os ?? 'unknown',
          formFactor: rawForm,
          screenWidth: Number(rawDevice.screenWidth) || 1920,
          screenHeight: Number(rawDevice.screenHeight) || 1080,
          pixelRatio: Number(rawDevice.pixelRatio) || 1,
          orientation: rawDevice.orientation === 'portrait' ? 'portrait' : 'landscape',
          x: typeof rawDevice.x === 'number' && room.devices.has(deviceId) ? rawDevice.x : slot.x,
          y: typeof rawDevice.y === 'number' && room.devices.has(deviceId) ? rawDevice.y : slot.y,
          isPrimary,
          edgeFlowEnabled: existingNode?.edgeFlowEnabled ?? true,
          companionConnected:
            room.companions.has(deviceId) ||
            Boolean(existingNode?.companionConnected) ||
            Boolean(rawDevice.companionConnected),
          online: true,
          connectedAt: existingNode?.connectedAt ?? Date.now(),
          lastSeenAt: Date.now(),
          telemetry: {
            batteryLevel: rawDevice.telemetry?.batteryLevel ?? existingNode?.telemetry.batteryLevel ?? null,
            batteryCharging: rawDevice.telemetry?.batteryCharging ?? existingNode?.telemetry.batteryCharging ?? null,
            cpuCores: existingNode?.telemetry.cpuCores ?? rawDevice.telemetry?.cpuCores ?? null,
            cpuUsage: existingNode?.telemetry.cpuUsage ?? rawDevice.telemetry?.cpuUsage ?? null,
            memoryTotalGb: existingNode?.telemetry.memoryTotalGb ?? rawDevice.telemetry?.memoryTotalGb ?? null,
            memoryUsedGb: existingNode?.telemetry.memoryUsedGb ?? rawDevice.telemetry?.memoryUsedGb ?? null,
            networkType: rawDevice.telemetry?.networkType ?? null,
            downlinkMbps: rawDevice.telemetry?.downlinkMbps ?? null,
            rttMs: rawDevice.telemetry?.rttMs ?? null,
            volume: typeof rawDevice.telemetry?.volume === 'number' ? rawDevice.telemetry.volume : 72,
            brightness: typeof rawDevice.telemetry?.brightness === 'number' ? rawDevice.telemetry.brightness : 85,
            displayServer:
              rawDevice.telemetry?.displayServer && rawDevice.telemetry.displayServer !== 'web'
                ? rawDevice.telemetry.displayServer
                : existingNode?.telemetry.displayServer ?? 'web',
            companionLastSeenAt:
              rawDevice.companionConnected
                ? Date.now()
                : existingNode?.telemetry.companionLastSeenAt ?? null,
            openApps: [
              ...(existingNode?.telemetry.openApps ?? []).filter((a) => a.source === 'os-agent'),
              ...(Array.isArray(rawDevice.telemetry?.openApps) ? rawDevice.telemetry.openApps : []),
            ],
          },
        };

        room.devices.set(deviceId, node);
        room.clients.set(deviceId, ws);
        clientMeta.set(ws, { ws, deviceId, roomCode, isCompanion: false });

        // Send authoritative full state to joining client
        sendJson(ws, { type: 'mesh:init', snapshot: getSnapshot(room), selfDeviceId: deviceId });
        if (mergedCompanionNode) {
          broadcastRoom(room, { type: 'mesh:devices_sync', devices: Array.from(room.devices.values()) }, deviceId);
        } else {
          broadcastRoom(room, { type: 'device:joined', device: node }, deviceId);
        }
        return;
      }

      if (type === 'companion:register') {
        const roomCode = sanitizeRoomCode(msg.roomCode);
        const room = getOrCreateRoom(roomCode);
        const deviceId = String(msg.deviceId || `companion-${Date.now()}`).slice(0, 64);
        const compOs = (msg.os as DeviceNode['os']) || 'windows';
        const displayServer =
          msg.displayServer === 'wayland' || msg.displayServer === 'x11' || msg.displayServer === 'win32'
            ? msg.displayServer
            : compOs === 'windows'
              ? 'win32'
              : 'x11';

        // Prefer attaching to a matching-OS uncoupled desktop/laptop browser node first
        const devicesArr = Array.from(room.devices.values());
        const matchingDesktop =
          devicesArr.find(
            (d) => (d.formFactor === 'desktop' || d.formFactor === 'laptop') && !d.companionConnected && d.os === compOs
          ) ??
          devicesArr.find(
            (d) => (d.formFactor === 'desktop' || d.formFactor === 'laptop') && !d.companionConnected
          );

        if (matchingDesktop) {
          const targetId = matchingDesktop.id;
          matchingDesktop.companionConnected = true;
          matchingDesktop.lastSeenAt = Date.now();
          matchingDesktop.telemetry.displayServer = displayServer;
          matchingDesktop.telemetry.companionLastSeenAt = Date.now();
          room.companions.set(targetId, ws);
          clientMeta.set(ws, { ws, deviceId: targetId, roomCode, isCompanion: true });
          broadcastRoom(room, { type: 'device:updated', device: matchingDesktop });
        } else {
          const slot = computeDefaultSlot(room, 'desktop');
          const node: DeviceNode = {
            id: deviceId,
            name: String(msg.name || 'Desktop (Nativo)'),
            os: compOs,
            formFactor: 'desktop',
            screenWidth: 1920,
            screenHeight: 1080,
            pixelRatio: 1,
            orientation: 'landscape',
            x: slot.x,
            y: slot.y,
            isPrimary: room.devices.size === 0,
            edgeFlowEnabled: true,
            companionConnected: true,
            online: true,
            connectedAt: Date.now(),
            lastSeenAt: Date.now(),
            telemetry: {
              batteryLevel: null,
              batteryCharging: null,
              cpuCores: null,
              cpuUsage: 0,
              memoryTotalGb: null,
              memoryUsedGb: null,
              networkType: 'lan',
              downlinkMbps: null,
              rttMs: 1,
              volume: 70,
              brightness: 85,
              displayServer,
              companionLastSeenAt: Date.now(),
              openApps: [],
            },
          };
          room.devices.set(deviceId, node);
          room.companions.set(deviceId, ws);
          clientMeta.set(ws, { ws, deviceId, roomCode, isCompanion: true });
          broadcastRoom(room, { type: 'device:joined', device: node });
        }
        return;
      }

      const meta = clientMeta.get(ws);
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      room.lastActivityAt = Date.now();

      if (type === 'companion:telemetry') {
        const node = room.devices.get(meta.deviceId);
        if (!node) return;
        const incoming = (msg.telemetry ?? {}) as Partial<DeviceNode['telemetry']>;
        const existingBrowserApps = node.telemetry.openApps.filter((a) => a.source === 'browser');
        const incomingOsApps = Array.isArray(incoming.openApps) ? incoming.openApps : [];
        node.telemetry = {
          ...node.telemetry,
          cpuCores: incoming.cpuCores ?? node.telemetry.cpuCores,
          cpuUsage: incoming.cpuUsage ?? node.telemetry.cpuUsage,
          memoryTotalGb: incoming.memoryTotalGb ?? node.telemetry.memoryTotalGb,
          memoryUsedGb: incoming.memoryUsedGb ?? node.telemetry.memoryUsedGb,
          batteryLevel: incoming.batteryLevel ?? node.telemetry.batteryLevel,
          batteryCharging: incoming.batteryCharging ?? node.telemetry.batteryCharging,
          displayServer: incoming.displayServer ?? node.telemetry.displayServer,
          companionLastSeenAt: Date.now(),
          openApps: incomingOsApps.length > 0 ? [...incomingOsApps, ...existingBrowserApps] : node.telemetry.openApps,
        };
        node.companionConnected = true;
        node.lastSeenAt = Date.now();
        broadcastRoom(room, { type: 'device:updated', device: node });
        return;
      }

      if (type === 'device:update') {
        const targetId = String(msg.deviceId || meta.deviceId);
        const node = room.devices.get(targetId);
        if (!node) return;
        const patch = (msg.patch ?? {}) as Partial<DeviceNode>;
        if (typeof patch.name === 'string' && patch.name.trim()) node.name = patch.name.trim().slice(0, 48);
        if (typeof patch.edgeFlowEnabled === 'boolean') node.edgeFlowEnabled = patch.edgeFlowEnabled;
        if (patch.orientation === 'landscape' || patch.orientation === 'portrait') node.orientation = patch.orientation;
        if (typeof patch.isPrimary === 'boolean' && patch.isPrimary) {
          for (const d of room.devices.values()) d.isPrimary = d.id === node.id;
          broadcastRoom(room, { type: 'mesh:devices_sync', devices: Array.from(room.devices.values()) });
          return;
        }
        if (patch.telemetry) {
          node.telemetry = { ...node.telemetry, ...patch.telemetry };
        }
        node.lastSeenAt = Date.now();
        broadcastRoom(room, { type: 'device:updated', device: node });
        return;
      }

      if (type === 'layout:move') {
        const targetId = String(msg.deviceId || meta.deviceId);
        const node = room.devices.get(targetId);
        if (!node) return;
        const x = Number(msg.x);
        const y = Number(msg.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        node.x = Math.max(0, Math.min(2000, Math.round(x)));
        node.y = Math.max(0, Math.min(1200, Math.round(y)));
        node.lastSeenAt = Date.now();
        broadcastRoom(room, { type: 'layout:moved', deviceId: node.id, x: node.x, y: node.y }, meta.deviceId);
        return;
      }

      if (type === 'clipboard:push') {
        const item = msg.item as ClipboardItem | undefined;
        if (!item || !item.id || !item.content) return;
        if (room.clipboard.some((c) => c.id === item.id)) return;
        const sanitized: ClipboardItem = {
          id: String(item.id).slice(0, 64),
          content: String(item.content).slice(0, 20000),
          kind: item.kind === 'url' || item.kind === 'code' ? item.kind : 'text',
          sourceDeviceId: meta.deviceId,
          sourceDeviceName: room.devices.get(meta.deviceId)?.name || 'Dispositivo',
          createdAt: Date.now(),
        };
        room.clipboard = [sanitized, ...room.clipboard].slice(0, 40);
        broadcastRoom(room, { type: 'clipboard:added', item: sanitized });
        return;
      }

      if (type === 'clipboard:delete') {
        const id = String(msg.id ?? '');
        room.clipboard = room.clipboard.filter((c) => c.id !== id);
        broadcastRoom(room, { type: 'clipboard:deleted', id });
        return;
      }

      if (type === 'notification:push') {
        const n = msg.notification as MeshNotification | undefined;
        if (!n || !n.id || !n.title) return;
        if (room.notifications.some((x) => x.id === n.id)) return;
        const sanitized: MeshNotification = {
          id: String(n.id).slice(0, 64),
          title: String(n.title).slice(0, 120),
          body: String(n.body ?? '').slice(0, 400),
          app: String(n.app || 'Continuum').slice(0, 48),
          severity: n.severity === 'warning' || n.severity === 'alert' ? n.severity : 'info',
          sourceDeviceId: meta.deviceId,
          sourceDeviceName: room.devices.get(meta.deviceId)?.name || 'Dispositivo',
          createdAt: Date.now(),
          read: false,
        };
        room.notifications = [sanitized, ...room.notifications].slice(0, 60);
        broadcastRoom(room, { type: 'notification:added', notification: sanitized });
        return;
      }

      if (type === 'notification:read') {
        const id = String(msg.id ?? '');
        const found = room.notifications.find((n) => n.id === id);
        if (found) {
          found.read = true;
          broadcastRoom(room, { type: 'notification:updated', notification: found });
        }
        return;
      }

      if (type === 'notification:dismiss') {
        const id = String(msg.id ?? '');
        room.notifications = room.notifications.filter((n) => n.id !== id);
        broadcastRoom(room, { type: 'notification:dismissed', id });
        return;
      }

      if (type === 'notification:clear_all') {
        room.notifications = [];
        broadcastRoom(room, { type: 'notification:cleared' });
        return;
      }

      if (type === 'file:start') {
        const record = msg.record as FileTransferRecord | undefined;
        if (!record || !record.id) return;
        if (!room.transfers.some((t) => t.id === record.id)) {
          room.transfers = [record, ...room.transfers].slice(0, 40);
        }
        const payload = { type: 'file:start', record };
        if (record.toDeviceId === 'all') {
          broadcastRoom(room, payload);
        } else {
          sendJson(room.clients.get(record.toDeviceId), payload);
          sendJson(room.clients.get(meta.deviceId), payload);
        }
        return;
      }

      if (type === 'file:chunk') {
        const toDeviceId = String(msg.toDeviceId || 'all');
        const payload = {
          type: 'file:chunk',
          transferId: msg.transferId,
          chunkIndex: msg.chunkIndex,
          totalChunks: msg.totalChunks,
          data: msg.data,
          progress: msg.progress,
          speedMbps: msg.speedMbps,
        };
        const rec = room.transfers.find((t) => t.id === msg.transferId);
        if (rec) {
          rec.progress = Number(msg.progress) || rec.progress;
          rec.speedMbps = Number(msg.speedMbps) || rec.speedMbps;
        }
        if (toDeviceId === 'all') {
          broadcastRoom(room, payload, meta.deviceId);
        } else {
          sendJson(room.clients.get(toDeviceId), payload);
        }
        return;
      }

      if (type === 'file:complete') {
        const transferId = String(msg.transferId ?? '');
        const toDeviceId = String(msg.toDeviceId || 'all');
        const rec = room.transfers.find((t) => t.id === transferId);
        if (rec) {
          rec.status = 'completed';
          rec.progress = 100;
        }
        const payload = { type: 'file:complete', transferId };
        if (toDeviceId === 'all') {
          broadcastRoom(room, payload);
        } else {
          sendJson(room.clients.get(toDeviceId), payload);
          sendJson(room.clients.get(meta.deviceId), payload);
        }
        return;
      }

      if (type === 'input:event') {
        const toDeviceId = String(msg.toDeviceId ?? '');
        const input = msg.input as RemoteInputPayload | undefined;
        if (!toDeviceId || !input) return;

        // Update device volume/brightness state if command targets it
        const targetNode = room.devices.get(toDeviceId);
        if (targetNode && input.kind === 'command') {
          let changed = false;
          if (input.action === 'vol_up') {
            targetNode.telemetry.volume = Math.min(100, targetNode.telemetry.volume + 8);
            changed = true;
          } else if (input.action === 'vol_down') {
            targetNode.telemetry.volume = Math.max(0, targetNode.telemetry.volume - 8);
            changed = true;
          } else if (input.action === 'vol_mute') {
            targetNode.telemetry.volume = targetNode.telemetry.volume > 0 ? 0 : 65;
            changed = true;
          } else if (input.action === 'brightness_up') {
            targetNode.telemetry.brightness = Math.min(100, targetNode.telemetry.brightness + 10);
            changed = true;
          } else if (input.action === 'brightness_down') {
            targetNode.telemetry.brightness = Math.max(10, targetNode.telemetry.brightness - 10);
            changed = true;
          }
          if (changed) {
            broadcastRoom(room, { type: 'device:updated', device: targetNode });
          }
        }

        const outbound = {
          type: 'input:event',
          fromDeviceId: meta.deviceId,
          fromDeviceName: room.devices.get(meta.deviceId)?.name || 'Remoto',
          input,
        };
        sendJson(room.clients.get(toDeviceId), outbound);
        sendJson(room.companions.get(toDeviceId), outbound);
        return;
      }

      // WebRTC Second Screen signaling
      if (type === 'rtc:session_start') {
        const session = msg.session as ScreenSessionMeta | undefined;
        if (!session || !session.id) return;
        room.screenSessions.set(session.id, session);
        broadcastRoom(room, { type: 'rtc:session_started', session });
        return;
      }

      if (type === 'rtc:session_stop') {
        const sessionId = String(msg.sessionId ?? '');
        room.screenSessions.delete(sessionId);
        broadcastRoom(room, { type: 'rtc:session_stopped', sessionId });
        return;
      }

      if (type === 'rtc:offer' || type === 'rtc:answer' || type === 'rtc:ice') {
        const toDeviceId = String(msg.toDeviceId ?? '');
        if (!toDeviceId) return;
        sendJson(room.clients.get(toDeviceId), {
          ...msg,
          fromDeviceId: meta.deviceId,
        });
        if (type === 'rtc:answer' && typeof msg.sessionId === 'string') {
          const sess = room.screenSessions.get(msg.sessionId);
          if (sess) {
            sess.status = 'active';
            broadcastRoom(room, { type: 'rtc:session_updated', session: sess });
          }
        }
        return;
      }
    });

    ws.on('close', () => {
      const meta = clientMeta.get(ws);
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room) return;

      if (meta.isCompanion) {
        room.companions.delete(meta.deviceId);
        const node = room.devices.get(meta.deviceId);
        if (node) {
          if (room.clients.has(meta.deviceId)) {
            node.companionConnected = false;
            broadcastRoom(room, { type: 'device:updated', device: node });
          } else {
            room.devices.delete(meta.deviceId);
            broadcastRoom(room, { type: 'device:left', deviceId: meta.deviceId });
          }
        }
      } else {
        // Only remove if this socket is still the active socket for the device
        if (room.clients.get(meta.deviceId) === ws) {
          room.clients.delete(meta.deviceId);
          room.devices.delete(meta.deviceId);

          // Stop any screen sessions involving this device
          for (const [sessId, sess] of room.screenSessions.entries()) {
            if (sess.hostDeviceId === meta.deviceId || sess.receiverDeviceId === meta.deviceId) {
              room.screenSessions.delete(sessId);
              broadcastRoom(room, { type: 'rtc:session_stopped', sessionId: sessId });
            }
          }

          broadcastRoom(room, { type: 'device:left', deviceId: meta.deviceId });
        }
      }

      if (room.clients.size === 0 && room.companions.size === 0) {
        setTimeout(() => {
          const check = rooms.get(meta.roomCode);
          if (check && check.clients.size === 0 && check.companions.size === 0 && Date.now() - check.lastActivityAt > 15 * 60 * 1000) {
            rooms.delete(meta.roomCode);
          }
        }, 15 * 60 * 1000 + 500);
      }
    });
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Continuum] Real-time mesh server listening on http://0.0.0.0:${PORT}`);
  });
}

bootstrap();
