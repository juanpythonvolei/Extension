import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClipboardItem,
  DeviceNode,
  FileTransferRecord,
  MeshNotification,
  MeshStateSnapshot,
  RemoteInputPayload,
  ScreenSessionMeta,
} from '../types/mesh';
import {
  buildLocalDevicePayload,
  collectRealTelemetry,
  getInitialRoomCode,
  getOrCreateTabDeviceId,
  playLocateChime,
} from '../utils/deviceDetector';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface RemoteCursorState {
  visible: boolean;
  nx: number;
  ny: number;
  fromName: string;
  clicking: boolean;
  lastUpdated: number;
}

export interface IncomingCommandToast {
  id: string;
  message: string;
  fromName: string;
  url?: string;
}

export interface WebRTCStreamStats {
  fps: number | null;
  bitrateKbps: number | null;
  rttMs: number | null;
  width: number | null;
  height: number | null;
}

interface PendingFileAssembly {
  record: FileTransferRecord;
  chunks: Map<number, string>;
  totalChunks: number;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function useMeshClient() {
  const [roomCode, setRoomCode] = useState<string>(() => getInitialRoomCode());
  const [selfDeviceId] = useState<string>(() => getOrCreateTabDeviceId());
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [rttMs, setRttMs] = useState<number | null>(null);

  const [devices, setDevices] = useState<DeviceNode[]>([]);
  const [clipboard, setClipboard] = useState<ClipboardItem[]>([]);
  const [notifications, setNotifications] = useState<MeshNotification[]>([]);
  const [transfers, setTransfers] = useState<FileTransferRecord[]>([]);
  const [screenSessions, setScreenSessions] = useState<ScreenSessionMeta[]>([]);

  // Live WebRTC Second Screen state
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [streamRole, setStreamRole] = useState<'idle' | 'host' | 'receiver'>('idle');
  const [rtcStats, setRtcStats] = useState<WebRTCStreamStats>({
    fps: null,
    bitrateKbps: null,
    rttMs: null,
    width: null,
    height: null,
  });

  // Incoming remote cursor & feedback
  const [remoteCursor, setRemoteCursor] = useState<RemoteCursorState>({
    visible: false,
    nx: 0.5,
    ny: 0.5,
    fromName: '',
    clicking: false,
    lastUpdated: 0,
  });
  const [toasts, setToasts] = useState<IncomingCommandToast[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const roomCodeRef = useRef(roomCode);
  roomCodeRef.current = roomCode;

  const customNameRef = useRef<string | null>(
    (() => {
      try {
        return localStorage.getItem('continuum_device_name');
      } catch {
        return null;
      }
    })()
  );

  const rttRef = useRef<number | null>(null);
  const devicesRef = useRef<DeviceNode[]>(devices);
  devicesRef.current = devices;

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;
  const localStreamRef = useRef<MediaStream | null>(null);
  localStreamRef.current = localStream;

  const pendingFilesRef = useRef<Map<string, PendingFileAssembly>>(new Map());
  const cursorHideTimerRef = useRef<number | null>(null);
  const lastBytesRef = useRef<{ bytes: number; ts: number }>({ bytes: 0, ts: 0 });

  const pushToast = useCallback((message: string, fromName = 'Continuum', url?: string) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [{ id, message, fromName, url }, ...prev].slice(0, 4));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5200);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const sendWs = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const handleIncomingInput = useCallback(
    (input: RemoteInputPayload, fromName: string) => {
      if (input.kind === 'move') {
        setRemoteCursor((prev) => {
          const nextNx =
            typeof input.dx === 'number' && typeof input.dy === 'number'
              ? Math.max(0.01, Math.min(0.99, prev.nx + input.dx / Math.max(window.innerWidth, 800)))
              : Math.max(0.01, Math.min(0.99, input.nx));
          const nextNy =
            typeof input.dx === 'number' && typeof input.dy === 'number'
              ? Math.max(0.01, Math.min(0.99, prev.ny + input.dy / Math.max(window.innerHeight, 600)))
              : Math.max(0.01, Math.min(0.99, input.ny));
          return {
            visible: true,
            nx: nextNx,
            ny: nextNy,
            fromName,
            clicking: false,
            lastUpdated: Date.now(),
          };
        });
        if (cursorHideTimerRef.current) window.clearTimeout(cursorHideTimerRef.current);
        cursorHideTimerRef.current = window.setTimeout(() => {
          setRemoteCursor((prev) => ({ ...prev, visible: false }));
        }, 4000);
        return;
      }

      if (input.kind === 'click') {
        setRemoteCursor((prev) => {
          const nx = typeof input.nx === 'number' ? input.nx : prev.nx;
          const ny = typeof input.ny === 'number' ? input.ny : prev.ny;
          const clientX = Math.round(nx * window.innerWidth);
          const clientY = Math.round(ny * window.innerHeight);
          const targetEl = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
          if (targetEl && input.button === 'left') {
            targetEl.focus?.();
            targetEl.click?.();
          }
          return {
            visible: true,
            nx,
            ny,
            fromName,
            clicking: true,
            lastUpdated: Date.now(),
          };
        });
        window.setTimeout(() => {
          setRemoteCursor((prev) => ({ ...prev, clicking: false }));
        }, 180);
        return;
      }

      if (input.kind === 'scroll') {
        window.scrollBy({ left: input.dx, top: input.dy, behavior: 'auto' });
        return;
      }

      if (input.kind === 'text' && input.text) {
        const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
          const start = active.selectionStart ?? active.value.length;
          const end = active.selectionEnd ?? active.value.length;
          const nextVal = active.value.slice(0, start) + input.text + active.value.slice(end);
          const proto = active.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) {
            setter.call(active, nextVal);
            active.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else {
          pushToast(`Texto remoto recebido: "${input.text.slice(0, 60)}"`, fromName);
        }
        return;
      }

      if (input.kind === 'key') {
        if (input.key === 'Backspace') {
          const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
          if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.value.length > 0) {
            const proto = active.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) {
              setter.call(active, active.value.slice(0, -1));
              active.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
        } else {
          pushToast(`Atalho remoto: ${input.ctrl ? 'Ctrl+' : ''}${input.alt ? 'Alt+' : ''}${input.key}`, fromName);
        }
        return;
      }

      if (input.kind === 'command') {
        if (input.action === 'ping') {
          playLocateChime();
          pushToast('Alerta de localização disparado neste dispositivo.', fromName);
        } else if (input.action === 'open_url' && input.payload) {
          pushToast(`Link enviado: ${input.payload}`, fromName, input.payload);
        } else {
          const labels: Record<string, string> = {
            vol_up: 'Volume aumentado (+8%)',
            vol_down: 'Volume reduzido (-8%)',
            vol_mute: 'Áudio alternado (mudo)',
            brightness_up: 'Brilho aumentado (+10%)',
            brightness_down: 'Brilho reduzido (-10%)',
            media_play_pause: 'Mídia: Reproduzir / Pausar',
            media_next: 'Mídia: Próxima faixa',
            media_prev: 'Mídia: Faixa anterior',
            lock: 'Solicitação de bloqueio de tela',
          };
          pushToast(labels[input.action] || `Comando: ${input.action}`, fromName);
        }
      }
    },
    [pushToast]
  );

  const cleanupRtc = useCallback((notifyServer = false) => {
    const sessId = activeSessionIdRef.current;
    if (notifyServer && sessId) {
      sendWs({ type: 'rtc:session_stop', sessionId: sessId });
    }
    if (dataChannelRef.current) {
      try {
        dataChannelRef.current.close();
      } catch {
        // ignore
      }
      dataChannelRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    pendingIceRef.current = [];
    setLocalStream(null);
    setRemoteStream(null);
    setActiveSessionId(null);
    setStreamRole('idle');
    setRtcStats({ fps: null, bitrateKbps: null, rttMs: null, width: null, height: null });
    lastBytesRef.current = { bytes: 0, ts: 0 };
  }, [sendWs]);

  const flushPendingIce = useCallback(async (pc: RTCPeerConnection) => {
    const queued = pendingIceRef.current.splice(0, pendingIceRef.current.length);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // ignore stale candidates
      }
    }
  }, []);

  // Connect & maintain WebSocket lifecycle
  useEffect(() => {
    let unmounted = false;

    const connect = async () => {
      if (unmounted) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.addEventListener('open', async () => {
        if (unmounted) return;
        setConnectionState('connected');
        const devicePayload = await buildLocalDevicePayload(
          selfDeviceId,
          customNameRef.current,
          rttRef.current
        );
        ws.send(
          JSON.stringify({
            type: 'mesh:join',
            roomCode: roomCodeRef.current,
            device: devicePayload,
          })
        );
        // Immediate ping for real RTT
        ws.send(JSON.stringify({ type: 'telemetry:ping', sentAt: performance.now() }));
      });

      ws.addEventListener('message', async (ev) => {
        if (unmounted) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }

        const type = String(msg.type ?? '');

        if (type === 'telemetry:pong') {
          const sentAt = Number(msg.sentAt);
          if (Number.isFinite(sentAt)) {
            const measured = Math.max(1, Math.round(performance.now() - sentAt));
            rttRef.current = measured;
            setRttMs(measured);
          }
          return;
        }

        if (type === 'mesh:init') {
          const snap = msg.snapshot as MeshStateSnapshot;
          if (!snap) return;
          setDevices(snap.devices);
          setClipboard(snap.clipboard);
          setNotifications(snap.notifications);
          setTransfers((prev) => {
            const urlMap = new Map(prev.map((t) => [t.id, t.downloadUrl]));
            return snap.transfers.map((t) => ({ ...t, downloadUrl: urlMap.get(t.id) ?? t.downloadUrl }));
          });
          setScreenSessions(snap.screenSessions);
          return;
        }

        if (type === 'mesh:devices_sync') {
          setDevices((msg.devices as DeviceNode[]) || []);
          return;
        }

        if (type === 'device:joined') {
          const dev = msg.device as DeviceNode;
          setDevices((prev) => {
            if (prev.some((d) => d.id === dev.id)) {
              return prev.map((d) => (d.id === dev.id ? dev : d));
            }
            return [...prev, dev];
          });
          if (dev.id !== selfDeviceId) {
            pushToast(`${dev.name} entrou na malha.`, 'Malha');
          }
          return;
        }

        if (type === 'device:updated') {
          const dev = msg.device as DeviceNode;
          setDevices((prev) => prev.map((d) => (d.id === dev.id ? dev : d)));
          return;
        }

        if (type === 'device:left') {
          const deviceId = String(msg.deviceId ?? '');
          setDevices((prev) => prev.filter((d) => d.id !== deviceId));
          return;
        }

        if (type === 'layout:moved') {
          const deviceId = String(msg.deviceId ?? '');
          const x = Number(msg.x);
          const y = Number(msg.y);
          setDevices((prev) => prev.map((d) => (d.id === deviceId ? { ...d, x, y } : d)));
          return;
        }

        if (type === 'clipboard:added') {
          const item = msg.item as ClipboardItem;
          setClipboard((prev) => (prev.some((c) => c.id === item.id) ? prev : [item, ...prev].slice(0, 40)));
          if (item.sourceDeviceId !== selfDeviceId) {
            pushToast('Novo item sincronizado na área de transferência.', item.sourceDeviceName);
          }
          return;
        }

        if (type === 'clipboard:deleted') {
          const id = String(msg.id ?? '');
          setClipboard((prev) => prev.filter((c) => c.id !== id));
          return;
        }

        if (type === 'notification:added') {
          const notification = msg.notification as MeshNotification;
          setNotifications((prev) =>
            prev.some((n) => n.id === notification.id) ? prev : [notification, ...prev].slice(0, 60)
          );
          if (notification.sourceDeviceId !== selfDeviceId) {
            pushToast(`${notification.app}: ${notification.title}`, notification.sourceDeviceName);
          }
          return;
        }

        if (type === 'notification:updated') {
          const notification = msg.notification as MeshNotification;
          setNotifications((prev) => prev.map((n) => (n.id === notification.id ? notification : n)));
          return;
        }

        if (type === 'notification:dismissed') {
          const id = String(msg.id ?? '');
          setNotifications((prev) => prev.filter((n) => n.id !== id));
          return;
        }

        if (type === 'notification:cleared') {
          setNotifications([]);
          return;
        }

        if (type === 'file:start') {
          const record = msg.record as FileTransferRecord;
          setTransfers((prev) => (prev.some((t) => t.id === record.id) ? prev : [record, ...prev].slice(0, 40)));
          if (record.fromDeviceId !== selfDeviceId) {
            pendingFilesRef.current.set(record.id, {
              record,
              chunks: new Map(),
              totalChunks: 0,
            });
            pushToast(`Recebendo arquivo: ${record.fileName}`, record.fromDeviceName);
          }
          return;
        }

        if (type === 'file:chunk') {
          const transferId = String(msg.transferId ?? '');
          const chunkIndex = Number(msg.chunkIndex);
          const totalChunks = Number(msg.totalChunks);
          const data = String(msg.data ?? '');
          const progress = Number(msg.progress) || 0;
          const speedMbps = Number(msg.speedMbps) || 0;

          const assembly = pendingFilesRef.current.get(transferId);
          if (assembly) {
            assembly.totalChunks = totalChunks;
            assembly.chunks.set(chunkIndex, data);
          }
          setTransfers((prev) =>
            prev.map((t) => (t.id === transferId ? { ...t, progress, speedMbps } : t))
          );
          return;
        }

        if (type === 'file:complete') {
          const transferId = String(msg.transferId ?? '');
          const assembly = pendingFilesRef.current.get(transferId);
          let downloadUrl: string | undefined;
          if (assembly) {
            const orderedParts: BlobPart[] = [];
            for (let i = 0; i < assembly.totalChunks; i++) {
              const part = assembly.chunks.get(i);
              if (part) {
                const arr = base64ToUint8Array(part);
                orderedParts.push(arr.buffer as ArrayBuffer);
              }
            }
            const blob = new Blob(orderedParts, { type: assembly.record.mimeType || 'application/octet-stream' });
            downloadUrl = URL.createObjectURL(blob);
            pendingFilesRef.current.delete(transferId);
            pushToast(`Arquivo pronto para download: ${assembly.record.fileName}`, assembly.record.fromDeviceName);
          }
          setTransfers((prev) =>
            prev.map((t) =>
              t.id === transferId
                ? { ...t, status: 'completed', progress: 100, downloadUrl: downloadUrl ?? t.downloadUrl }
                : t
            )
          );
          return;
        }

        if (type === 'input:event') {
          const input = msg.input as RemoteInputPayload;
          const fromName = String(msg.fromDeviceName || 'Remoto');
          handleIncomingInput(input, fromName);
          return;
        }

        // WebRTC Second Screen signaling
        if (type === 'rtc:session_started') {
          const session = msg.session as ScreenSessionMeta;
          setScreenSessions((prev) =>
            prev.some((s) => s.id === session.id) ? prev : [...prev, session]
          );
          return;
        }

        if (type === 'rtc:session_updated') {
          const session = msg.session as ScreenSessionMeta;
          setScreenSessions((prev) => prev.map((s) => (s.id === session.id ? session : s)));
          return;
        }

        if (type === 'rtc:session_stopped') {
          const sessionId = String(msg.sessionId ?? '');
          setScreenSessions((prev) => prev.filter((s) => s.id !== sessionId));
          if (activeSessionIdRef.current === sessionId) {
            cleanupRtc(false);
            pushToast('Sessão Second Screen encerrada.', 'Second Screen');
          }
          return;
        }

        if (type === 'rtc:offer') {
          const fromDeviceId = String(msg.fromDeviceId ?? '');
          const sessionId = String(msg.sessionId ?? '');
          const sdp = msg.sdp as RTCSessionDescriptionInit;
          if (!fromDeviceId || !sdp) return;

          cleanupRtc(false);
          const pc = new RTCPeerConnection(RTC_CONFIG);
          pcRef.current = pc;
          setActiveSessionId(sessionId);
          setStreamRole('receiver');

          pc.onicecandidate = (e) => {
            if (e.candidate) {
              sendWs({
                type: 'rtc:ice',
                toDeviceId: fromDeviceId,
                sessionId,
                candidate: e.candidate,
              });
            }
          };

          pc.ontrack = (e) => {
            const incomingStream = e.streams[0] || new MediaStream([e.track]);
            setRemoteStream(incomingStream);
          };

          pc.ondatachannel = (e) => {
            dataChannelRef.current = e.channel;
          };

          pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
              cleanupRtc(false);
            }
          };

          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          await flushPendingIce(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendWs({
            type: 'rtc:answer',
            toDeviceId: fromDeviceId,
            sessionId,
            sdp: answer,
          });
          pushToast('Transmissão Second Screen recebida em tempo real.', 'Second Screen');
          return;
        }

        if (type === 'rtc:answer') {
          const sdp = msg.sdp as RTCSessionDescriptionInit;
          if (pcRef.current && sdp) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
            await flushPendingIce(pcRef.current);
          }
          return;
        }

        if (type === 'rtc:ice') {
          const candidate = msg.candidate as RTCIceCandidateInit;
          if (candidate) {
            if (pcRef.current && pcRef.current.remoteDescription) {
              try {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
              } catch {
                // ignore late candidates
              }
            } else {
              pendingIceRef.current.push(candidate);
            }
          }
        }
      });

      ws.addEventListener('close', () => {
        if (unmounted) return;
        setConnectionState('reconnecting');
        reconnectTimerRef.current = window.setTimeout(() => {
          connect();
        }, 2000);
      });

      ws.addEventListener('error', () => {
        ws.close();
      });
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [cleanupRtc, flushPendingIce, handleIncomingInput, pushToast, selfDeviceId, sendWs]);

  // Periodic real RTT ping + browser telemetry heartbeat
  useEffect(() => {
    const interval = window.setInterval(async () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      sendWs({ type: 'telemetry:ping', sentAt: performance.now() });
      const selfNode = devicesRef.current.find((d) => d.id === selfDeviceId);
      const freshTelemetry = await collectRealTelemetry(rttRef.current, selfNode?.telemetry);
      sendWs({
        type: 'device:update',
        deviceId: selfDeviceId,
        patch: {
          screenWidth: window.screen.width || window.innerWidth,
          screenHeight: window.screen.height || window.innerHeight,
          telemetry: freshTelemetry,
        },
      });
    }, 5000);
    return () => window.clearInterval(interval);
  }, [selfDeviceId, sendWs]);

  // Poll real WebRTC connection stats while streaming
  useEffect(() => {
    if (streamRole === 'idle') return;
    const timer = window.setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let fps: number | null = null;
        let width: number | null = null;
        let height: number | null = null;
        let rtt: number | null = null;
        let bytes = 0;

        stats.forEach((report) => {
          if (
            (streamRole === 'receiver' && report.type === 'inbound-rtp' && report.kind === 'video') ||
            (streamRole === 'host' && report.type === 'outbound-rtp' && report.kind === 'video')
          ) {
            if (typeof report.framesPerSecond === 'number') fps = Math.round(report.framesPerSecond);
            if (typeof report.frameWidth === 'number') width = report.frameWidth;
            if (typeof report.frameHeight === 'number') height = report.frameHeight;
            bytes = Number(report.bytesReceived ?? report.bytesSent ?? 0);
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (typeof report.currentRoundTripTime === 'number') {
              rtt = Math.max(1, Math.round(report.currentRoundTripTime * 1000));
            }
          }
        });

        const now = performance.now();
        let bitrateKbps: number | null = null;
        if (bytes > 0 && lastBytesRef.current.ts > 0 && bytes >= lastBytesRef.current.bytes) {
          const dtSec = (now - lastBytesRef.current.ts) / 1000;
          if (dtSec > 0.2) {
            bitrateKbps = Math.round(((bytes - lastBytesRef.current.bytes) * 8) / (dtSec * 1000));
          }
        }
        if (bytes > 0) {
          lastBytesRef.current = { bytes, ts: now };
        }
        setRtcStats({ fps, bitrateKbps, rttMs: rtt ?? rttRef.current, width, height });
      } catch {
        // stats unavailable
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [streamRole]);

  // Actions exposed to UI
  const switchRoom = useCallback(
    async (newCode: string) => {
      const cleaned = newCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (cleaned.length < 4) return;
      cleanupRtc(true);
      setRoomCode(cleaned);
      roomCodeRef.current = cleaned;
      try {
        localStorage.setItem('continuum_last_room', cleaned);
        const url = new URL(window.location.href);
        url.searchParams.set('room', cleaned);
        window.history.replaceState({}, '', url.toString());
      } catch {
        // ignore
      }
      const devicePayload = await buildLocalDevicePayload(
        selfDeviceId,
        customNameRef.current,
        rttRef.current
      );
      sendWs({
        type: 'mesh:join',
        roomCode: cleaned,
        device: devicePayload,
      });
      pushToast(`Conectado à malha ${cleaned}.`, 'Pareamento');
    },
    [cleanupRtc, pushToast, selfDeviceId, sendWs]
  );

  const renameDevice = useCallback(
    (deviceId: string, name: string) => {
      const trimmed = name.trim().slice(0, 48);
      if (!trimmed) return;
      if (deviceId === selfDeviceId) {
        customNameRef.current = trimmed;
        try {
          localStorage.setItem('continuum_device_name', trimmed);
        } catch {
          // ignore
        }
      }
      setDevices((prev) => prev.map((d) => (d.id === deviceId ? { ...d, name: trimmed } : d)));
      sendWs({ type: 'device:update', deviceId, patch: { name: trimmed } });
    },
    [selfDeviceId, sendWs]
  );

  const updateDeviceNode = useCallback(
    (deviceId: string, patch: Partial<DeviceNode>) => {
      setDevices((prev) =>
        prev.map((d) => {
          if (patch.isPrimary) {
            return { ...d, isPrimary: d.id === deviceId };
          }
          return d.id === deviceId ? { ...d, ...patch } : d;
        })
      );
      sendWs({ type: 'device:update', deviceId, patch });
    },
    [sendWs]
  );

  const moveDevicePosition = useCallback(
    (deviceId: string, x: number, y: number) => {
      setDevices((prev) => prev.map((d) => (d.id === deviceId ? { ...d, x, y } : d)));
      sendWs({ type: 'layout:move', deviceId, x, y });
    },
    [sendWs]
  );

  const pushClipboard = useCallback(
    (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const isUrl = /^https?:\/\/\S+$/i.test(trimmed);
      const isCode = /[{};=<>]|function\s|const\s|import\s|def\s/.test(trimmed);
      const selfNode = devicesRef.current.find((d) => d.id === selfDeviceId);
      const item: ClipboardItem = {
        id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        content: trimmed,
        kind: isUrl ? 'url' : isCode ? 'code' : 'text',
        sourceDeviceId: selfDeviceId,
        sourceDeviceName: selfNode?.name || 'Este dispositivo',
        createdAt: Date.now(),
      };
      setClipboard((prev) => [item, ...prev].slice(0, 40));
      sendWs({ type: 'clipboard:push', item });
    },
    [selfDeviceId, sendWs]
  );

  const deleteClipboardItem = useCallback(
    (id: string) => {
      setClipboard((prev) => prev.filter((c) => c.id !== id));
      sendWs({ type: 'clipboard:delete', id });
    },
    [sendWs]
  );

  const pushNotification = useCallback(
    (title: string, body: string, app = 'Continuum', severity: MeshNotification['severity'] = 'info') => {
      const selfNode = devicesRef.current.find((d) => d.id === selfDeviceId);
      const notification: MeshNotification = {
        id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: title.trim(),
        body: body.trim(),
        app: app.trim() || 'Continuum',
        severity,
        sourceDeviceId: selfDeviceId,
        sourceDeviceName: selfNode?.name || 'Este dispositivo',
        createdAt: Date.now(),
        read: false,
      };
      setNotifications((prev) => [notification, ...prev].slice(0, 60));
      sendWs({ type: 'notification:push', notification });
    },
    [selfDeviceId, sendWs]
  );

  const markNotificationRead = useCallback(
    (id: string) => {
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
      sendWs({ type: 'notification:read', id });
    },
    [sendWs]
  );

  const dismissNotification = useCallback(
    (id: string) => {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      sendWs({ type: 'notification:dismiss', id });
    },
    [sendWs]
  );

  const clearNotifications = useCallback(() => {
    setNotifications([]);
    sendWs({ type: 'notification:clear_all' });
  }, [sendWs]);

  const sendRemoteInput = useCallback(
    (toDeviceId: string, input: RemoteInputPayload) => {
      // Prefer ultra-low-latency WebRTC DataChannel if connected to active host
      if (dataChannelRef.current && dataChannelRef.current.readyState === 'open' && streamRole === 'receiver') {
        try {
          dataChannelRef.current.send(JSON.stringify(input));
          return;
        } catch {
          // fallback to WS
        }
      }
      sendWs({ type: 'input:event', toDeviceId, input });
    },
    [sendWs, streamRole]
  );

  const sendFileToMesh = useCallback(
    async (file: File, toDeviceId: string | 'all') => {
      const selfNode = devicesRef.current.find((d) => d.id === selfDeviceId);
      const targetNode = toDeviceId === 'all' ? null : devicesRef.current.find((d) => d.id === toDeviceId);
      const transferId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const localDownloadUrl = URL.createObjectURL(file);

      const record: FileTransferRecord = {
        id: transferId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        fromDeviceId: selfDeviceId,
        fromDeviceName: selfNode?.name || 'Este dispositivo',
        toDeviceId,
        toDeviceName: targetNode ? targetNode.name : 'Todos os dispositivos',
        status: 'transferring',
        progress: 0,
        speedMbps: 0,
        createdAt: Date.now(),
        downloadUrl: localDownloadUrl,
      };

      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        const failedRecord: FileTransferRecord = { ...record, status: 'failed' };
        setTransfers((prev) => [failedRecord, ...prev].slice(0, 40));
        pushToast(`Falha ao enviar ${file.name}: malha desconectada.`, 'Transferência');
        return;
      }

      setTransfers((prev) => [record, ...prev].slice(0, 40));
      if (!sendWs({ type: 'file:start', record: { ...record, downloadUrl: undefined } })) {
        setTransfers((prev) =>
          prev.map((t) => (t.id === transferId ? { ...t, status: 'failed' } : t))
        );
        pushToast(`Falha ao iniciar envio de ${file.name}.`, 'Transferência');
        return;
      }

      const chunkSize = 48 * 1024;
      const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
      const startedAt = performance.now();

      try {
        for (let idx = 0; idx < totalChunks; idx++) {
          if (wsRef.current?.readyState !== WebSocket.OPEN) {
            throw new Error('Conexão WebSocket interrompida');
          }
          const slice = file.slice(idx * chunkSize, (idx + 1) * chunkSize);
          const buf = await slice.arrayBuffer();
          const b64 = arrayBufferToBase64(buf);
          const sentBytes = Math.min(file.size, (idx + 1) * chunkSize);
          const elapsedSec = Math.max(0.05, (performance.now() - startedAt) / 1000);
          const speedMbps = Number(((sentBytes / (1024 * 1024)) / elapsedSec).toFixed(2));
          const progress = Math.min(99, Math.round(((idx + 1) / totalChunks) * 100));

          const ok = sendWs({
            type: 'file:chunk',
            transferId,
            toDeviceId,
            chunkIndex: idx,
            totalChunks,
            data: b64,
            progress,
            speedMbps,
          });
          if (!ok) {
            throw new Error('Conexão WebSocket interrompida');
          }

          setTransfers((prev) =>
            prev.map((t) => (t.id === transferId ? { ...t, progress, speedMbps } : t))
          );

          // Yield briefly to keep UI at 60fps
          if (idx % 4 === 3) {
            await new Promise((r) => setTimeout(r, 4));
          }
        }

        if (!sendWs({ type: 'file:complete', transferId, toDeviceId })) {
          throw new Error('Falha ao finalizar transferência');
        }
        setTransfers((prev) =>
          prev.map((t) => (t.id === transferId ? { ...t, status: 'completed', progress: 100 } : t))
        );
        pushToast(`Arquivo enviado: ${file.name}`, record.toDeviceName);
      } catch {
        setTransfers((prev) =>
          prev.map((t) => (t.id === transferId ? { ...t, status: 'failed' } : t))
        );
        pushToast(`Transferência interrompida: ${file.name}. Verifique a conexão.`, 'Transferência');
      }
    },
    [pushToast, selfDeviceId, sendWs]
  );

  const clearTransfers = useCallback(() => {
    setTransfers((prev) => {
      prev.forEach((t) => {
        if (t.status !== 'transferring' && t.downloadUrl && t.downloadUrl.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(t.downloadUrl);
          } catch {
            // ignore
          }
        }
      });
      return prev.filter((t) => t.status === 'transferring');
    });
  }, []);

  const startSecondScreenCast = useCallback(
    async (
      targetDeviceId: string,
      options: { mode: 'extend' | 'mirror'; resolution: '720p' | '1080p' | 'native'; fps: 30 | 60 }
    ) => {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        pushToast('Captura de tela não suportada neste navegador móvel. Inicie a transmissão a partir do computador.', 'Second Screen');
        return false;
      }

      const targetDevice = devicesRef.current.find((d) => d.id === targetDeviceId);
      const selfNode = devicesRef.current.find((d) => d.id === selfDeviceId);
      if (!targetDevice) {
        pushToast('Selecione um dispositivo conectado como tela secundária.', 'Second Screen');
        return false;
      }

      try {
        const videoConstraints: MediaTrackConstraints = {
          frameRate: { ideal: options.fps, max: options.fps },
        };
        if (options.resolution === '720p') {
          videoConstraints.width = { ideal: 1280 };
          videoConstraints.height = { ideal: 720 };
        } else if (options.resolution === '1080p') {
          videoConstraints.width = { ideal: 1920 };
          videoConstraints.height = { ideal: 1080 };
        }

        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: false,
        });

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack && 'contentHint' in videoTrack) {
          (videoTrack as MediaStreamTrack & { contentHint: string }).contentHint = 'motion';
        }

        cleanupRtc(true);

        const sessionId = `rtc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const pc = new RTCPeerConnection(RTC_CONFIG);
        pcRef.current = pc;
        localStreamRef.current = stream;
        setLocalStream(stream);
        setActiveSessionId(sessionId);
        setStreamRole('host');

        // Low-latency input return DataChannel
        const dc = pc.createDataChannel('continuum-input', { ordered: false, maxRetransmits: 0 });
        dataChannelRef.current = dc;
        dc.onmessage = (e) => {
          try {
            const payload = JSON.parse(String(e.data)) as RemoteInputPayload;
            handleIncomingInput(payload, targetDevice.name);
            // Also mirror to local companion agent via WS if connected
            if (selfNode?.companionConnected) {
              sendWs({ type: 'input:event', toDeviceId: selfDeviceId, input: payload });
            }
          } catch {
            // ignore
          }
        };

        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        videoTrack.onended = () => {
          cleanupRtc(true);
        };

        pc.onicecandidate = (e) => {
          if (e.candidate) {
            sendWs({
              type: 'rtc:ice',
              toDeviceId: targetDeviceId,
              sessionId,
              candidate: e.candidate,
            });
          }
        };

        const sessionMeta: ScreenSessionMeta = {
          id: sessionId,
          hostDeviceId: selfDeviceId,
          hostDeviceName: selfNode?.name || 'Computador',
          receiverDeviceId: targetDeviceId,
          receiverDeviceName: targetDevice.name,
          mode: options.mode,
          resolution: options.resolution,
          fps: options.fps,
          status: 'negotiating',
          startedAt: Date.now(),
        };

        sendWs({ type: 'rtc:session_start', session: sessionMeta });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendWs({
          type: 'rtc:offer',
          toDeviceId: targetDeviceId,
          sessionId,
          sdp: offer,
        });

        pushToast(`Second Screen iniciado para ${targetDevice.name}.`, 'Second Screen');
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Captura cancelada';
        if (!/cancel|denied|abort/i.test(msg)) {
          pushToast(`Não foi possível iniciar a captura: ${msg}`, 'Second Screen');
        }
        return false;
      }
    },
    [cleanupRtc, handleIncomingInput, pushToast, selfDeviceId, sendWs]
  );

  const stopSecondScreenCast = useCallback(() => {
    cleanupRtc(true);
  }, [cleanupRtc]);

  const selfDevice = devices.find((d) => d.id === selfDeviceId) ?? null;
  const peerDevices = devices.filter((d) => d.id !== selfDeviceId);

  return {
    roomCode,
    selfDeviceId,
    selfDevice,
    peerDevices,
    devices,
    clipboard,
    notifications,
    transfers,
    screenSessions,
    connectionState,
    rttMs,
    localStream,
    remoteStream,
    activeSessionId,
    streamRole,
    rtcStats,
    remoteCursor,
    toasts,
    dismissToast,
    switchRoom,
    renameDevice,
    updateDeviceNode,
    moveDevicePosition,
    pushClipboard,
    deleteClipboardItem,
    pushNotification,
    markNotificationRead,
    dismissNotification,
    clearNotifications,
    sendRemoteInput,
    sendFileToMesh,
    clearTransfers,
    startSecondScreenCast,
    stopSecondScreenCast,
  };
}
