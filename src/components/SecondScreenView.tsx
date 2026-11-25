import React, { useEffect, useRef, useState } from 'react';
import {
  Cast,
  Keyboard,
  Maximize2,
  Minimize2,
  MonitorPlay,
  MousePointerClick,
  QrCode,
  Radio,
  Square,
} from 'lucide-react';
import type { DeviceNode, RemoteInputPayload, ScreenSessionMeta } from '../types/mesh';
import type { WebRTCStreamStats } from '../hooks/useMeshClient';
import { formatOsLabel } from '../utils/deviceDetector';

interface SecondScreenViewProps {
  devices: DeviceNode[];
  peerDevices: DeviceNode[];
  selfDeviceId: string;
  preferredTargetId: string | null;
  screenSessions: ScreenSessionMeta[];
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  streamRole: 'idle' | 'host' | 'receiver';
  rtcStats: WebRTCStreamStats;
  onStartCast: (
    targetDeviceId: string,
    options: { mode: 'extend' | 'mirror'; resolution: '720p' | '1080p' | 'native'; fps: 30 | 60 }
  ) => Promise<boolean>;
  onStopCast: () => void;
  onSendInput: (targetDeviceId: string, input: RemoteInputPayload) => void;
  onOpenPairing: () => void;
}

export const SecondScreenView: React.FC<SecondScreenViewProps> = ({
  peerDevices,
  selfDeviceId,
  preferredTargetId,
  screenSessions,
  localStream,
  remoteStream,
  streamRole,
  rtcStats,
  onStartCast,
  onStopCast,
  onSendInput,
  onOpenPairing,
}) => {
  const [targetId, setTargetId] = useState<string>(preferredTargetId || peerDevices[0]?.id || '');
  const [mode, setMode] = useState<'extend' | 'mirror'>('extend');
  const [resolution, setResolution] = useState<'720p' | '1080p' | 'native'>('1080p');
  const [fps, setFps] = useState<30 | 60>(60);
  const [touchPassthrough, setTouchPassthrough] = useState(true);
  const [fitMode, setFitMode] = useState<'contain' | 'cover'>('contain');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [quickText, setQuickText] = useState('');
  const [showKeyboardBar, setShowKeyboardBar] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const lastMoveEmitRef = useRef(0);

  useEffect(() => {
    if (preferredTargetId && peerDevices.some((p) => p.id === preferredTargetId)) {
      setTargetId(preferredTargetId);
    } else if (!peerDevices.some((p) => p.id === targetId)) {
      setTargetId(peerDevices[0]?.id || '');
    }
  }, [peerDevices, preferredTargetId, targetId]);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const activeStream = streamRole === 'receiver' ? remoteStream : streamRole === 'host' ? localStream : null;
    if (videoEl.srcObject !== activeStream) {
      videoEl.srcObject = activeStream;
    }
  }, [localStream, remoteStream, streamRole]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Keep mobile/tablet screen awake automatically during Second Screen sessions
  useEffect(() => {
    if (streamRole === 'idle') return;
    let wakeLock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    if (nav.wakeLock?.request) {
      nav.wakeLock
        .request('screen')
        .then((sentinel) => {
          wakeLock = sentinel;
        })
        .catch(() => {
          // Wake lock unavailable or denied
        });
    }
    return () => {
      wakeLock?.release().catch(() => {});
    };
  }, [streamRole]);

  const currentReceiverSession = screenSessions.find((s) => s.receiverDeviceId === selfDeviceId);
  const hostIdForReturn = currentReceiverSession?.hostDeviceId || targetId;

  const toggleFullscreen = async () => {
    if (!stageRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await stageRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Fullscreen unsupported on iOS Safari video wrapper
    }
  };

  const computeNormalizedCoords = (e: React.PointerEvent<HTMLVideoElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
    return { nx, ny };
  };

  const handleVideoPointerMove = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (streamRole !== 'receiver' || !touchPassthrough || !hostIdForReturn) return;
    const now = performance.now();
    if (now - lastMoveEmitRef.current < 28) return;
    lastMoveEmitRef.current = now;
    const { nx, ny } = computeNormalizedCoords(e);
    onSendInput(hostIdForReturn, { kind: 'move', nx, ny });
  };

  const handleVideoPointerDown = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (streamRole !== 'receiver' || !touchPassthrough || !hostIdForReturn) return;
    const { nx, ny } = computeNormalizedCoords(e);
    onSendInput(hostIdForReturn, {
      kind: 'click',
      button: e.button === 2 ? 'right' : 'left',
      nx,
      ny,
    });
  };

  const handleVideoWheel = (e: React.WheelEvent<HTMLVideoElement>) => {
    if (streamRole !== 'receiver' || !touchPassthrough || !hostIdForReturn) return;
    onSendInput(hostIdForReturn, { kind: 'scroll', dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
  };

  const handleQuickTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickText.trim() || !hostIdForReturn) return;
    onSendInput(hostIdForReturn, { kind: 'text', text: quickText });
    setQuickText('');
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[340px_1fr]">
      {/* Control Panel */}
      <section className="flex flex-col justify-between rounded-lg border border-[#222936] bg-[#11151B] p-5">
        <div className="space-y-5">
          <div>
            <h1 className="text-base font-semibold text-[#F1F5F9]">Second Screen sem Fio</h1>
            <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
              Transforme qualquer tablet, celular ou segundo computador em monitor secundário de baixa latência via WebRTC com retorno de toque e mouse.
            </p>
          </div>

          {/* Target Device Selector */}
          <div>
            <label htmlFor="second-screen-target" className="block text-xs font-medium text-[#94A3B8]">
              Dispositivo de destino (Receptor)
            </label>
            {peerDevices.length > 0 ? (
              <select
                id="second-screen-target"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                disabled={streamRole !== 'idle'}
                className="mt-2 h-10 w-full rounded-md border border-[#222936] bg-[#090B0E] px-3 text-sm text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none disabled:opacity-50"
              >
                {peerDevices.map((dev) => (
                  <option key={dev.id} value={dev.id}>
                    {dev.name} ({formatOsLabel(dev.os)} · {dev.screenWidth}×{dev.screenHeight})
                  </option>
                ))}
              </select>
            ) : (
              <div className="mt-2 rounded-md border border-[#222936] bg-[#090B0E] p-3.5 text-xs text-[#94A3B8]">
                Nenhum outro dispositivo pareado ainda.
                <button
                  type="button"
                  onClick={onOpenPairing}
                  className="mt-2.5 inline-flex items-center gap-1.5 font-medium text-[#60A5FA] hover:underline"
                >
                  <QrCode className="h-3.5 w-3.5" />
                  Abrir QR Code ou 2ª janela agora
                </button>
              </div>
            )}
          </div>

          {/* Projection Mode */}
          <div>
            <span className="block text-xs font-medium text-[#94A3B8]">Modo de projeção</span>
            <div className="mt-2 grid grid-cols-2 gap-1.5 rounded-md border border-[#222936] bg-[#090B0E] p-1">
              <button
                type="button"
                disabled={streamRole !== 'idle'}
                onClick={() => setMode('extend')}
                className={`rounded-sm px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                  mode === 'extend'
                    ? 'bg-[#171C24] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                Estender / Janela
              </button>
              <button
                type="button"
                disabled={streamRole !== 'idle'}
                onClick={() => setMode('mirror')}
                className={`rounded-sm px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                  mode === 'mirror'
                    ? 'bg-[#171C24] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                Espelhar Monitor
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-[#64748B]">
              {mode === 'extend'
                ? 'Selecione uma janela dedicada ou segundo display virtual para ampliar sua área de trabalho.'
                : 'Duplica o monitor principal inteiro com sincronização direta.'}
            </p>
          </div>

          {/* Resolution & Frame Rate */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="block text-xs font-medium text-[#94A3B8]">Resolução</span>
              <div className="mt-2 flex flex-col gap-1">
                {(['720p', '1080p', 'native'] as const).map((res) => (
                  <button
                    key={res}
                    type="button"
                    disabled={streamRole !== 'idle'}
                    onClick={() => setResolution(res)}
                    className={`rounded-md border px-3 py-1.5 text-left font-mono text-xs transition-colors ${
                      resolution === res
                        ? 'border-[#3B82F6] bg-[#3B82F6]/15 text-[#F1F5F9]'
                        : 'border-[#222936] bg-[#090B0E] text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    {res === 'native' ? 'Nativo' : res}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-[#94A3B8]">Taxa de quadros</span>
              <div className="mt-2 flex flex-col gap-1">
                {([30, 60] as const).map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    disabled={streamRole !== 'idle'}
                    onClick={() => setFps(rate)}
                    className={`rounded-md border px-3 py-1.5 text-left font-mono text-xs transition-colors tabular-nums ${
                      fps === rate
                        ? 'border-[#3B82F6] bg-[#3B82F6]/15 text-[#F1F5F9]'
                        : 'border-[#222936] bg-[#090B0E] text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    {rate} FPS
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Action Button */}
        <div className="mt-6 border-t border-[#222936] pt-4">
          {streamRole === 'idle' ? (
            <button
              type="button"
              disabled={!targetId}
              onClick={() => onStartCast(targetId, { mode, resolution, fps })}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-[#3B82F6] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#2563EB] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Cast className="h-4 w-4" />
              Iniciar Second Screen
            </button>
          ) : (
            <button
              type="button"
              onClick={onStopCast}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-[#DC2626] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#B91C1C]"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              Encerrar transmissão
            </button>
          )}
        </div>
      </section>

      {/* Live Video Viewport & Receiver Stage */}
      <section
        ref={stageRef}
        className="flex min-h-[480px] flex-col overflow-hidden rounded-lg border border-[#222936] bg-[#090B0E]"
      >
        {/* Top Live Telemetry Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222936] bg-[#11151B] px-5 py-3">
          <div className="flex items-center gap-2.5 text-xs">
            <Radio
              className={`h-3.5 w-3.5 ${streamRole !== 'idle' ? 'text-[#16A34A]' : 'text-[#64748B]'}`}
              aria-hidden="true"
            />
            <span className="font-medium text-[#F1F5F9]">
              {streamRole === 'host'
                ? 'Transmitindo via WebRTC'
                : streamRole === 'receiver'
                  ? 'Recebendo Monitor Secundário'
                  : 'Pronto para receber ou transmitir'}
            </span>
            {streamRole !== 'idle' && (
              <span className="font-mono text-[#94A3B8] tabular-nums">
                · {rtcStats.width && rtcStats.height ? `${rtcStats.width}×${rtcStats.height}` : resolution} ·{' '}
                {rtcStats.fps !== null ? `${rtcStats.fps} FPS` : `${fps} FPS`} ·{' '}
                {rtcStats.rttMs !== null ? `${rtcStats.rttMs} ms` : 'medindo'}
                {rtcStats.bitrateKbps ? ` · ${(rtcStats.bitrateKbps / 1000).toFixed(1)} Mbps` : ''}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {streamRole === 'receiver' && (
              <>
                <button
                  type="button"
                  onClick={() => setTouchPassthrough((v) => !v)}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    touchPassthrough
                      ? 'border-[#3B82F6] bg-[#3B82F6]/15 text-[#60A5FA]'
                      : 'border-[#222936] bg-[#171C24] text-[#94A3B8]'
                  }`}
                >
                  <MousePointerClick className="h-3.5 w-3.5" />
                  Toque ativo
                </button>
                <button
                  type="button"
                  onClick={() => setShowKeyboardBar((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-2.5 py-1.5 text-xs font-medium text-[#CBD5E1] hover:border-[#3B82F6] whitespace-nowrap"
                >
                  <Keyboard className="h-3.5 w-3.5" />
                  Teclado
                </button>
                <button
                  type="button"
                  onClick={() => setFitMode((m) => (m === 'contain' ? 'cover' : 'contain'))}
                  className="rounded-md border border-[#222936] bg-[#171C24] px-2.5 py-1.5 text-xs text-[#CBD5E1] hover:border-[#3B82F6] whitespace-nowrap"
                >
                  {fitMode === 'contain' ? 'Ajustar' : 'Preencher'}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-2.5 py-1.5 text-xs font-medium text-[#CBD5E1] hover:border-[#3B82F6] whitespace-nowrap"
              aria-label="Alternar tela cheia"
            >
              {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              {isFullscreen ? 'Sair' : 'Tela cheia'}
            </button>
          </div>
        </div>

        {/* Video Display Surface */}
        <div className="relative flex flex-1 items-center justify-center bg-[#06080A]">
          {streamRole !== 'idle' ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onPointerMove={handleVideoPointerMove}
              onPointerDown={handleVideoPointerDown}
              onWheel={handleVideoWheel}
              onContextMenu={(e) => {
                if (streamRole === 'receiver') e.preventDefault();
              }}
              className={`h-full w-full ${fitMode === 'cover' ? 'object-cover' : 'object-contain'} ${
                streamRole === 'receiver' && touchPassthrough ? 'cursor-crosshair touch-none' : ''
              }`}
            />
          ) : (
            <div className="flex max-w-md flex-col items-center px-6 text-center">
              <MonitorPlay className="h-10 w-10 text-[#334155]" strokeWidth={1.5} />
              <h2 className="mt-4 text-sm font-semibold text-[#F1F5F9]">
                Superfície Second Screen em espera
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-[#94A3B8]">
                No computador, selecione o dispositivo receptor à esquerda e clique em Iniciar Second Screen. Neste dispositivo, qualquer transmissão enviada pela malha abrirá automaticamente em tempo real.
              </p>
            </div>
          )}
        </div>

        {/* Receiver Inline Remote Keyboard Bar */}
        {streamRole === 'receiver' && showKeyboardBar && (
          <form
            onSubmit={handleQuickTextSubmit}
            className="flex items-center gap-2 border-t border-[#222936] bg-[#11151B] px-4 py-2.5"
          >
            <input
              type="text"
              value={quickText}
              onChange={(e) => setQuickText(e.target.value)}
              placeholder="Digite para enviar texto em tempo real ao computador transmissor..."
              className="h-9 flex-1 rounded-md border border-[#222936] bg-[#090B0E] px-3 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-[#3B82F6] focus:outline-none"
            />
            <button
              type="submit"
              className="h-9 rounded-md bg-[#3B82F6] px-4 text-xs font-medium text-white hover:bg-[#2563EB] whitespace-nowrap"
            >
              Enviar texto
            </button>
          </form>
        )}
      </section>
    </div>
  );
};
