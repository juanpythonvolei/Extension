import React, { useEffect, useRef, useState } from 'react';
import {
  BellRing,
  CornerDownLeft,
  Delete,
  ExternalLink,
  Keyboard,
  Lock,
  Pause,
  QrCode,
  Send,
  SkipBack,
  SkipForward,
  Sun,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { DeviceNode, RemoteCommandAction, RemoteInputPayload } from '../types/mesh';
import { formatOsLabel } from '../utils/deviceDetector';

interface RemoteControlViewProps {
  devices: DeviceNode[];
  peerDevices: DeviceNode[];
  selfDeviceId: string;
  preferredTargetId: string | null;
  onSendInput: (targetDeviceId: string, input: RemoteInputPayload) => void;
  onOpenPairing: () => void;
}

export const RemoteControlView: React.FC<RemoteControlViewProps> = ({
  devices,
  peerDevices,
  selfDeviceId,
  preferredTargetId,
  onSendInput,
  onOpenPairing,
}) => {
  const [targetId, setTargetId] = useState<string>(preferredTargetId || peerDevices[0]?.id || selfDeviceId);
  const [sensitivity, setSensitivity] = useState<number>(1.6);
  const [textDraft, setTextDraft] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [padState, setPadState] = useState<{ active: boolean; lastAction: string }>({
    active: false,
    lastAction: 'Arraste para mover o cursor · Toque para clicar',
  });

  const lastPointerRef = useRef<{ x: number; y: number; downX: number; downY: number; downAt: number } | null>(null);
  const lastEmitRef = useRef<number>(0);

  useEffect(() => {
    if (preferredTargetId && devices.some((d) => d.id === preferredTargetId)) {
      setTargetId(preferredTargetId);
    } else if (!devices.some((d) => d.id === targetId)) {
      setTargetId(peerDevices[0]?.id || selfDeviceId);
    }
  }, [devices, peerDevices, preferredTargetId, selfDeviceId, targetId]);

  const targetDevice = devices.find((d) => d.id === targetId) ?? null;

  const dispatchInput = (input: RemoteInputPayload, label?: string) => {
    if (!targetId) return;
    onSendInput(targetId, input);
    if (label) {
      setPadState((prev) => ({ ...prev, lastAction: label }));
    }
  };

  const handlePadPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    lastPointerRef.current = {
      x: e.clientX,
      y: e.clientY,
      downX: e.clientX,
      downY: e.clientY,
      downAt: performance.now(),
    };
    setPadState({ active: true, lastAction: 'Movendo cursor em tempo real' });
  };

  const handlePadPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = lastPointerRef.current;
    if (!prev) return;
    const dx = (e.clientX - prev.x) * sensitivity;
    const dy = (e.clientY - prev.y) * sensitivity;
    prev.x = e.clientX;
    prev.y = e.clientY;

    const now = performance.now();
    if (now - lastEmitRef.current < 20) return;
    lastEmitRef.current = now;

    if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
      const rect = e.currentTarget.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
      dispatchInput({ kind: 'move', nx, ny, dx: Math.round(dx), dy: Math.round(dy) });
    }
  };

  const handlePadPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = lastPointerRef.current;
    lastPointerRef.current = null;
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }

    if (prev) {
      const dist = Math.hypot(e.clientX - prev.downX, e.clientY - prev.downY);
      const dt = performance.now() - prev.downAt;
      if (dist < 6 && dt < 240) {
        dispatchInput({ kind: 'click', button: e.button === 2 ? 'right' : 'left' }, 'Clique enviado');
      }
    }
    setPadState((s) => ({ ...s, active: false }));
  };

  const handlePadWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    dispatchInput({ kind: 'scroll', dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) }, 'Rolagem enviada');
  };

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textDraft) return;
    dispatchInput({ kind: 'text', text: textDraft }, `Texto enviado (${textDraft.length} caracteres)`);
    setTextDraft('');
  };

  const handleSendUrl = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlDraft.trim();
    if (!trimmed) return;
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    dispatchInput({ kind: 'command', action: 'open_url', payload: normalized }, 'Link enviado ao destino');
    setUrlDraft('');
  };

  const sendCommand = (action: RemoteCommandAction, label: string) => {
    dispatchInput({ kind: 'command', action }, label);
  };

  const shortcuts = [
    { label: 'Esc', payload: { kind: 'key' as const, key: 'Escape' } },
    { label: 'Alt + Tab', payload: { kind: 'key' as const, key: 'Tab', alt: true } },
    { label: 'Ctrl + C', payload: { kind: 'key' as const, key: 'c', ctrl: true } },
    { label: 'Ctrl + V', payload: { kind: 'key' as const, key: 'v', ctrl: true } },
    { label: 'Ctrl + Z', payload: { kind: 'key' as const, key: 'z', ctrl: true } },
    { label: 'Super / Win', payload: { kind: 'key' as const, key: 'Meta', meta: true } },
  ];

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_340px]">
      {/* Trackpad & Virtual Keyboard */}
      <section className="flex flex-col rounded-lg border border-[#222936] bg-[#11151B]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222936] px-5 py-3.5">
          <div>
            <h1 className="text-base font-semibold text-[#F1F5F9]">Trackpad e Teclado Remoto</h1>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Controle ponteiro, cliques, rolagem e digitação em baixa latência em qualquer dispositivo da malha.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="remote-target-select" className="sr-only">
              Dispositivo alvo
            </label>
            <select
              id="remote-target-select"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="h-9 rounded-md border border-[#222936] bg-[#090B0E] px-3 text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
            >
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({formatOsLabel(d.os)}{d.id === selfDeviceId ? ' · Local' : ''})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-4 p-5">
          {/* Precision Touchpad Surface */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_52px]">
            <div
              onPointerDown={handlePadPointerDown}
              onPointerMove={handlePadPointerMove}
              onPointerUp={handlePadPointerUp}
              onWheel={handlePadWheel}
              onContextMenu={(e) => {
                e.preventDefault();
                dispatchInput({ kind: 'click', button: 'right' }, 'Clique direito enviado');
              }}
              className={`spatial-grid relative flex min-h-[260px] flex-col items-center justify-center rounded-md border transition-colors select-none touch-none ${
                padState.active
                  ? 'border-[#3B82F6] bg-[#0D131D]'
                  : 'border-[#2E3748] bg-[#090B0E] hover:border-[#475569]'
              }`}
            >
              <p className="pointer-events-none text-xs font-medium text-[#94A3B8]">
                Superfície Trackpad Multi-Toque
              </p>
              <p className="pointer-events-none mt-1 text-[11px] text-[#64748B]">{padState.lastAction}</p>
              {targetDevice && (
                <span className="pointer-events-none absolute right-3 bottom-2.5 font-mono text-[11px] text-[#64748B] tabular-nums">
                  Alvo: {targetDevice.name}
                </span>
              )}
            </div>

            {/* Dedicated Vertical Scroll Strip */}
            <div className="flex flex-row items-center justify-between gap-2 rounded-md border border-[#222936] bg-[#090B0E] p-1.5 sm:flex-col">
              <button
                type="button"
                onClick={() => dispatchInput({ kind: 'scroll', dx: 0, dy: -160 }, 'Rolagem para cima')}
                className="flex h-10 flex-1 items-center justify-center rounded-sm bg-[#171C24] text-xs font-medium text-[#CBD5E1] hover:bg-[#1E2532] sm:w-full"
                aria-label="Rolar para cima"
              >
                ▲
              </button>
              <span className="text-[10px] text-[#64748B] sm:writing-mode-vertical">Scroll</span>
              <button
                type="button"
                onClick={() => dispatchInput({ kind: 'scroll', dx: 0, dy: 160 }, 'Rolagem para baixo')}
                className="flex h-10 flex-1 items-center justify-center rounded-sm bg-[#171C24] text-xs font-medium text-[#CBD5E1] hover:bg-[#1E2532] sm:w-full"
                aria-label="Rolar para baixo"
              >
                ▼
              </button>
            </div>
          </div>

          {/* Left / Right Click & Sensitivity Row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_180px]">
            <button
              type="button"
              onClick={() => dispatchInput({ kind: 'click', button: 'left' }, 'Clique esquerdo enviado')}
              className="h-11 rounded-md border border-[#222936] bg-[#171C24] text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] active:bg-[#1E293B]"
            >
              Clique Esquerdo
            </button>
            <button
              type="button"
              onClick={() => dispatchInput({ kind: 'click', button: 'right' }, 'Clique direito enviado')}
              className="h-11 rounded-md border border-[#222936] bg-[#171C24] text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] active:bg-[#1E293B]"
            >
              Clique Direito
            </button>
            <div className="col-span-2 flex flex-col justify-center rounded-md border border-[#222936] bg-[#090B0E] px-3 py-1.5 sm:col-span-1">
              <div className="flex items-center justify-between text-[11px] text-[#94A3B8]">
                <span>Sensibilidade</span>
                <span className="font-mono text-[#F1F5F9] tabular-nums">{sensitivity.toFixed(1)}×</span>
              </div>
              <input
                type="range"
                min={0.6}
                max={3.0}
                step={0.2}
                value={sensitivity}
                onChange={(e) => setSensitivity(Number(e.target.value))}
                className="mt-1 h-1.5 w-full accent-[#3B82F6]"
                aria-label="Sensibilidade do trackpad"
              />
            </div>
          </div>

          {/* Remote Keyboard Input */}
          <div className="border-t border-[#222936] pt-4">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#94A3B8]">
                <Keyboard className="h-3.5 w-3.5" />
                Teclado Remoto em Tempo Real
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => dispatchInput({ kind: 'key', key: 'Backspace' }, 'Backspace enviado')}
                  className="inline-flex items-center gap-1 rounded-md border border-[#222936] bg-[#171C24] px-2.5 py-1 text-[11px] text-[#CBD5E1] hover:border-[#3B82F6]"
                >
                  <Delete className="h-3 w-3" />
                  Apagar
                </button>
                <button
                  type="button"
                  onClick={() => dispatchInput({ kind: 'key', key: 'Enter' }, 'Enter enviado')}
                  className="inline-flex items-center gap-1 rounded-md border border-[#222936] bg-[#171C24] px-2.5 py-1 text-[11px] text-[#CBD5E1] hover:border-[#3B82F6]"
                >
                  <CornerDownLeft className="h-3 w-3" />
                  Enter
                </button>
              </div>
            </div>

            <form onSubmit={handleSendText} className="mt-2.5 flex items-center gap-2">
              <input
                type="text"
                value={textDraft}
                onChange={(e) => setTextDraft(e.target.value)}
                placeholder="Digite uma frase ou comando para enviar ao dispositivo selecionado..."
                className="h-10 flex-1 rounded-md border border-[#222936] bg-[#090B0E] px-3 text-sm text-[#F1F5F9] placeholder-[#64748B] focus:border-[#3B82F6] focus:outline-none"
              />
              <button
                type="submit"
                disabled={!textDraft}
                className="inline-flex h-10 items-center gap-1.5 rounded-md bg-[#3B82F6] px-4 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <Send className="h-3.5 w-3.5" />
                Enviar
              </button>
            </form>

            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {shortcuts.map((sc) => (
                <button
                  key={sc.label}
                  type="button"
                  onClick={() => dispatchInput(sc.payload, `Atalho ${sc.label} enviado`)}
                  className="rounded-md border border-[#222936] bg-[#090B0E] px-2.5 py-1.5 font-mono text-[11px] text-[#CBD5E1] transition-colors hover:border-[#3B82F6] hover:text-[#F1F5F9]"
                >
                  {sc.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Right Column: Hardware & OS Quick Actions */}
      <aside className="flex flex-col justify-between gap-5 rounded-lg border border-[#222936] bg-[#11151B] p-5">
        <div className="space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-[#F1F5F9]">Funções Básicas do Dispositivo</h2>
            <p className="mt-1 text-xs text-[#94A3B8]">
              {targetDevice
                ? `${targetDevice.name} · ${targetDevice.companionConnected ? 'Agente nativo ativo' : 'Sincronizado via navegador'}`
                : 'Selecione um dispositivo'}
            </p>
          </div>

          {/* Volume Controls */}
          <div className="space-y-2 border-t border-[#222936] pt-4">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 text-[#CBD5E1]">
                <Volume2 className="h-3.5 w-3.5 text-[#94A3B8]" />
                Volume
              </span>
              <span className="font-mono text-[#F1F5F9] tabular-nums">
                {targetDevice ? `${targetDevice.telemetry.volume}%` : '—'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => sendCommand('vol_down', 'Volume -8%')}
                className="h-9 rounded-md border border-[#222936] bg-[#171C24] text-xs font-medium text-[#F1F5F9] hover:border-[#3B82F6]"
              >
                -
              </button>
              <button
                type="button"
                onClick={() => sendCommand('vol_mute', 'Alternar mudo')}
                className="inline-flex h-9 items-center justify-center rounded-md border border-[#222936] bg-[#171C24] text-xs font-medium text-[#F1F5F9] hover:border-[#3B82F6]"
                aria-label="Silenciar"
              >
                <VolumeX className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => sendCommand('vol_up', 'Volume +8%')}
                className="h-9 rounded-md border border-[#222936] bg-[#171C24] text-xs font-medium text-[#F1F5F9] hover:border-[#3B82F6]"
              >
                +
              </button>
            </div>
          </div>

          {/* Brightness Controls */}
          <div className="space-y-2 border-t border-[#222936] pt-4">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 text-[#CBD5E1]">
                <Sun className="h-3.5 w-3.5 text-[#94A3B8]" />
                Brilho da Tela
              </span>
              <span className="font-mono text-[#F1F5F9] tabular-nums">
                {targetDevice ? `${targetDevice.telemetry.brightness}%` : '—'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => sendCommand('brightness_down', 'Brilho -10%')}
                className="h-9 rounded-md border border-[#222936] bg-[#171C24] text-xs font-medium text-[#F1F5F9] hover:border-[#3B82F6]"
              >
                Reduzir
              </button>
              <button
                type="button"
                onClick={() => sendCommand('brightness_up', 'Brilho +10%')}
                className="h-9 rounded-md border border-[#222936] bg-[#171C24] text-xs font-medium text-[#F1F5F9] hover:border-[#3B82F6]"
              >
                Aumentar
              </button>
            </div>
          </div>

          {/* Media Playback */}
          <div className="space-y-2 border-t border-[#222936] pt-4">
            <span className="block text-xs text-[#CBD5E1]">Controle de Mídia</span>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => sendCommand('media_prev', 'Faixa anterior')}
                className="inline-flex h-10 items-center justify-center rounded-md border border-[#222936] bg-[#171C24] text-[#F1F5F9] hover:border-[#3B82F6]"
                aria-label="Faixa anterior"
              >
                <SkipBack className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => sendCommand('media_play_pause', 'Reproduzir / Pausar')}
                className="inline-flex h-10 items-center justify-center rounded-md bg-[#3B82F6] text-white hover:bg-[#2563EB]"
                aria-label="Reproduzir ou pausar"
              >
                <Pause className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => sendCommand('media_next', 'Próxima faixa')}
                className="inline-flex h-10 items-center justify-center rounded-md border border-[#222936] bg-[#171C24] text-[#F1F5F9] hover:border-[#3B82F6]"
                aria-label="Próxima faixa"
              >
                <SkipForward className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Open URL on Target */}
          <form onSubmit={handleSendUrl} className="space-y-2 border-t border-[#222936] pt-4">
            <label htmlFor="remote-url-input" className="block text-xs text-[#CBD5E1]">
              Enviar link para abrir no destino
            </label>
            <div className="flex items-center gap-2">
              <input
                id="remote-url-input"
                type="text"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="https://..."
                className="h-9 flex-1 rounded-md border border-[#222936] bg-[#090B0E] px-2.5 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-[#3B82F6] focus:outline-none"
              />
              <button
                type="submit"
                disabled={!urlDraft.trim()}
                className="inline-flex h-9 items-center gap-1 rounded-md border border-[#222936] bg-[#171C24] px-3 text-xs text-[#F1F5F9] hover:border-[#3B82F6] disabled:opacity-40 whitespace-nowrap"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Enviar
              </button>
            </div>
          </form>

          {/* Utility Triggers */}
          <div className="grid grid-cols-2 gap-2 border-t border-[#222936] pt-4">
            <button
              type="button"
              onClick={() => sendCommand('ping', 'Alerta sonoro disparado')}
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-3 text-xs font-medium text-[#F1F5F9] hover:border-[#3B82F6]"
            >
              <BellRing className="h-3.5 w-3.5 text-[#60A5FA]" />
              Localizar
            </button>
            <button
              type="button"
              onClick={() => sendCommand('lock', 'Bloqueio enviado')}
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-3 text-xs font-medium text-[#F1F5F9] hover:border-[#DC2626]"
            >
              <Lock className="h-3.5 w-3.5 text-[#94A3B8]" />
              Bloquear
            </button>
          </div>
        </div>

        {peerDevices.length === 0 && (
          <button
            type="button"
            onClick={onOpenPairing}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-[#222936] bg-[#090B0E] px-3 py-2.5 text-xs font-medium text-[#60A5FA] hover:border-[#3B82F6]"
          >
            <QrCode className="h-3.5 w-3.5" />
            Parear celular ou PC para controlar à distância
          </button>
        )}
      </aside>
    </div>
  );
};
