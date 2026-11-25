import React, { useMemo, useRef, useState } from 'react';
import {
  Battery,
  BellRing,
  Cast,
  FolderUp,
  Gamepad2,
  Laptop,
  Monitor,
  Move,
  QrCode,
  RotateCw,
  Smartphone,
  Star,
  Tablet,
  Wifi,
} from 'lucide-react';
import type { DeviceNode, ScreenSessionMeta, WorkspaceSection } from '../types/mesh';
import { formatFormFactorLabel, formatOsLabel } from '../utils/deviceDetector';

interface SpatialDisplayMapProps {
  devices: DeviceNode[];
  selfDeviceId: string;
  screenSessions: ScreenSessionMeta[];
  selectedDeviceId: string | null;
  onSelectDevice: (id: string) => void;
  onMoveDevice: (id: string, x: number, y: number) => void;
  onUpdateDevice: (id: string, patch: Partial<DeviceNode>) => void;
  onRenameDevice: (id: string, name: string) => void;
  onLocateDevice: (id: string) => void;
  onOpenSectionForDevice: (section: WorkspaceSection, deviceId: string) => void;
  onOpenPairing: () => void;
}

function getVisualDimensions(device: DeviceNode): { w: number; h: number } {
  const rawW = device.screenWidth || 1920;
  const rawH = device.screenHeight || 1080;
  const maxSide = Math.max(rawW, rawH);
  const minSide = Math.min(rawW, rawH);
  const ratio = Math.max(0.45, Math.min(2.2, maxSide / Math.max(1, minSide)));

  let baseLong = 236;
  if (device.formFactor === 'laptop') baseLong = 212;
  if (device.formFactor === 'tablet') baseLong = 176;
  if (device.formFactor === 'mobile') baseLong = 148;

  const baseShort = Math.max(76, Math.round(baseLong / ratio));
  return device.orientation === 'portrait'
    ? { w: baseShort, h: baseLong }
    : { w: baseLong, h: baseShort };
}

function DeviceFormIcon({ formFactor, className }: { formFactor: DeviceNode['formFactor']; className?: string }) {
  if (formFactor === 'mobile') return <Smartphone className={className} aria-hidden="true" />;
  if (formFactor === 'tablet') return <Tablet className={className} aria-hidden="true" />;
  if (formFactor === 'laptop') return <Laptop className={className} aria-hidden="true" />;
  return <Monitor className={className} aria-hidden="true" />;
}

export const SpatialDisplayMap: React.FC<SpatialDisplayMapProps> = ({
  devices,
  selfDeviceId,
  screenSessions,
  selectedDeviceId,
  onSelectDevice,
  onMoveDevice,
  onUpdateDevice,
  onRenameDevice,
  onLocateDevice,
  onOpenSectionForDevice,
  onOpenPairing,
}) => {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const lastEmitRef = useRef<number>(0);

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');

  const selectedDevice = useMemo(
    () => devices.find((d) => d.id === selectedDeviceId) ?? devices.find((d) => d.id === selfDeviceId) ?? devices[0] ?? null,
    [devices, selectedDeviceId, selfDeviceId]
  );

  // Compute adjacency links for mouse/keyboard edge flow visualization
  const flowLinks = useMemo(() => {
    const links: Array<{ id: string; x1: number; y1: number; x2: number; y2: number; activeCast: boolean }> = [];
    for (let i = 0; i < devices.length; i++) {
      for (let j = i + 1; j < devices.length; j++) {
        const a = devices[i];
        const b = devices[j];
        if (!a.edgeFlowEnabled || !b.edgeFlowEnabled) continue;
        const dimA = getVisualDimensions(a);
        const dimB = getVisualDimensions(b);
        const cxA = a.x + dimA.w / 2;
        const cyA = a.y + dimA.h / 2;
        const cxB = b.x + dimB.w / 2;
        const cyB = b.y + dimB.h / 2;
        const dist = Math.hypot(cxA - cxB, cyA - cyB);
        if (dist <= 380) {
          const activeCast = screenSessions.some(
            (s) =>
              (s.hostDeviceId === a.id && s.receiverDeviceId === b.id) ||
              (s.hostDeviceId === b.id && s.receiverDeviceId === a.id)
          );
          links.push({ id: `${a.id}-${b.id}`, x1: cxA, y1: cyA, x2: cxB, y2: cyB, activeCast });
        }
      }
    }
    return links;
  }, [devices, screenSessions]);

  const handlePointerDown = (e: React.PointerEvent, device: DeviceNode) => {
    e.stopPropagation();
    onSelectDevice(device.id);
    setEditingName(false);

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    dragOffsetRef.current = {
      dx: e.clientX - rect.left - device.x,
      dy: e.clientY - rect.top - device.y,
    };
    setDraggingId(device.id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent, device: DeviceNode) => {
    if (draggingId !== device.id) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const dim = getVisualDimensions(device);
    let nextX = Math.round(e.clientX - rect.left - dragOffsetRef.current.dx);
    let nextY = Math.round(e.clientY - rect.top - dragOffsetRef.current.dy);

    nextX = Math.max(16, Math.min(rect.width - dim.w - 16, nextX));
    nextY = Math.max(16, Math.min(rect.height - dim.h - 16, nextY));

    // Magnetic edge snap to other devices within 18px threshold
    const SNAP = 18;
    const GAP = 12;
    for (const other of devices) {
      if (other.id === device.id) continue;
      const oDim = getVisualDimensions(other);

      // Snap right edge of other -> left edge of dragged
      if (Math.abs(nextX - (other.x + oDim.w + GAP)) < SNAP) {
        nextX = other.x + oDim.w + GAP;
      }
      // Snap left edge of other -> right edge of dragged
      if (Math.abs(nextX + dim.w + GAP - other.x) < SNAP) {
        nextX = other.x - dim.w - GAP;
      }
      // Snap top alignment
      if (Math.abs(nextY - other.y) < SNAP) {
        nextY = other.y;
      }
      // Snap bottom alignment
      if (Math.abs(nextY + dim.h - (other.y + oDim.h)) < SNAP) {
        nextY = other.y + oDim.h - dim.h;
      }
      // Snap vertical stacking
      if (Math.abs(nextY - (other.y + oDim.h + GAP)) < SNAP) {
        nextY = other.y + oDim.h + GAP;
      }
      if (Math.abs(nextY + dim.h + GAP - other.y) < SNAP) {
        nextY = other.y - dim.h - GAP;
      }
    }

    const now = performance.now();
    if (now - lastEmitRef.current > 24) {
      lastEmitRef.current = now;
      onMoveDevice(device.id, nextX, nextY);
    }
  };

  const handlePointerUp = (e: React.PointerEvent, device: DeviceNode) => {
    if (draggingId !== device.id) return;
    setDraggingId(null);
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  const handleAutoArrange = () => {
    const sorted = [...devices].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    let cursorX = 64;
    const baseY = 128;
    sorted.forEach((dev) => {
      const dim = getVisualDimensions(dev);
      onMoveDevice(dev.id, cursorX, baseY + Math.max(0, Math.round((150 - dim.h) / 2)));
      cursorX += dim.w + 20;
    });
  };

  const startRename = () => {
    if (!selectedDevice) return;
    setDraftName(selectedDevice.name);
    setEditingName(true);
  };

  const commitRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedDevice && draftName.trim()) {
      onRenameDevice(selectedDevice.id, draftName.trim());
    }
    setEditingName(false);
  };

  return (
    <div className="grid h-full grid-cols-1 gap-5 xl:grid-cols-[1fr_320px]">
      {/* Spatial Display Canvas */}
      <div className="flex min-h-[500px] flex-col overflow-hidden rounded-lg border border-[#222936] bg-[#11151B]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222936] px-5 py-3.5">
          <div>
            <h1 className="text-base font-semibold text-[#F1F5F9]">Mapa Espacial de Dispositivos</h1>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Arraste as telas para definir o alinhamento físico, o fluxo contínuo de cursor e o Second Screen.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAutoArrange}
              disabled={devices.length < 2}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-3 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-[#3B82F6] hover:text-[#F1F5F9] disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap"
            >
              <Move className="h-3.5 w-3.5" />
              Alinhar telas
            </button>
          </div>
        </div>

        <div
          ref={canvasRef}
          className="spatial-grid relative flex-1 min-h-[380px] select-none overflow-hidden touch-none"
        >
          {/* SVG Bridge Connections */}
          <svg className="pointer-events-none absolute inset-0 h-full w-full">
            {flowLinks.map((link) => (
              <g key={link.id}>
                <line
                  x1={link.x1}
                  y1={link.y1}
                  x2={link.x2}
                  y2={link.y2}
                  stroke={link.activeCast ? '#3B82F6' : '#334155'}
                  strokeWidth={link.activeCast ? 2.5 : 1.5}
                  strokeDasharray={link.activeCast ? undefined : '5 5'}
                />
                <circle
                  cx={(link.x1 + link.x2) / 2}
                  cy={(link.y1 + link.y2) / 2}
                  r={3.5}
                  fill={link.activeCast ? '#60A5FA' : '#64748B'}
                />
              </g>
            ))}
          </svg>

          {/* Connected Device Nodes */}
          {devices.map((device, index) => {
            const dim = getVisualDimensions(device);
            const isSelected = selectedDevice?.id === device.id;
            const isSelf = device.id === selfDeviceId;
            const isDragging = draggingId === device.id;
            const activeSession = screenSessions.find(
              (s) => s.hostDeviceId === device.id || s.receiverDeviceId === device.id
            );

            return (
              <div
                key={device.id}
                onPointerDown={(e) => handlePointerDown(e, device)}
                onPointerMove={(e) => handlePointerMove(e, device)}
                onPointerUp={(e) => handlePointerUp(e, device)}
                style={{
                  transform: `translate3d(${device.x}px, ${device.y}px, 0)`,
                  width: `${dim.w}px`,
                  height: `${dim.h}px`,
                }}
                className={`absolute top-0 left-0 flex flex-col justify-between rounded-md border p-3 transition-shadow ${
                  isDragging ? 'z-30 cursor-grabbing' : 'z-10 cursor-grab'
                } ${
                  isSelected
                    ? 'border-[#3B82F6] bg-[#171C24] shadow-[0_0_0_1px_rgba(59,130,246,0.35)]'
                    : 'border-[#2E3748] bg-[#11151B]/95 hover:border-[#475569]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <DeviceFormIcon
                      formFactor={device.formFactor}
                      className={`h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-[#60A5FA]' : 'text-[#94A3B8]'}`}
                    />
                    <span className="truncate text-xs font-semibold text-[#F1F5F9]">
                      {device.name}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] font-medium text-[#64748B] tabular-nums shrink-0">
                    {index + 1}
                  </span>
                </div>

                <div className="space-y-1">
                  <div className="font-mono text-[11px] text-[#94A3B8] tabular-nums">
                    {device.screenWidth}×{device.screenHeight}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-[#64748B]">
                    <span className="truncate">
                      {formatOsLabel(device.os)}
                      {isSelf ? ' · Este' : ''}
                      {device.isPrimary ? ' · Principal' : ''}
                    </span>
                    {device.telemetry.rttMs !== null && (
                      <span className="font-mono text-[#94A3B8] tabular-nums shrink-0">
                        {device.telemetry.rttMs}ms
                      </span>
                    )}
                  </div>
                  {activeSession && (
                    <div className="pt-0.5 text-[11px] font-medium text-[#60A5FA]">
                      {activeSession.hostDeviceId === device.id ? 'Transmitindo tela' : 'Monitor secundário'}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Single-device contextual guidance */}
          {devices.length <= 1 && (
            <div className="absolute right-5 bottom-5 left-5 flex flex-col items-start justify-between gap-3 rounded-md border border-[#222936] bg-[#11151B]/95 p-4 sm:flex-row sm:items-center">
              <div>
                <p className="text-sm font-medium text-[#F1F5F9]">
                  Aguardando outros dispositivos na malha
                </p>
                <p className="mt-0.5 text-xs text-[#94A3B8]">
                  Escaneie o QR Code no seu celular, tablet ou outro PC — ou abra uma segunda janela para testar o Second Screen e o arraste espacial agora.
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenPairing}
                className="inline-flex items-center gap-2 rounded-md bg-[#3B82F6] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] whitespace-nowrap shrink-0"
              >
                <QrCode className="h-3.5 w-3.5" />
                Conectar dispositivo
              </button>
            </div>
          )}
        </div>

        {/* Spatial Legend Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#222936] bg-[#0D1015] px-5 py-2.5 text-xs text-[#94A3B8]">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Dispositivos conectados:{' '}
              <strong className="font-mono font-medium text-[#F1F5F9] tabular-nums">{devices.length}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Sessões Second Screen:{' '}
              <strong className="font-mono font-medium text-[#F1F5F9] tabular-nums">{screenSessions.length}</strong>
            </span>
          </div>
          <span className="text-[11px] text-[#64748B]">
            Encaixe magnético automático ao aproximar bordas
          </span>
        </div>
      </div>

      {/* Right Device Inspector */}
      <aside className="flex flex-col rounded-lg border border-[#222936] bg-[#11151B]">
        {selectedDevice ? (
          <>
            <div className="border-b border-[#222936] p-5">
              <div className="flex items-start justify-between gap-2">
                {editingName ? (
                  <form onSubmit={commitRename} className="flex flex-1 items-center gap-2">
                    <input
                      type="text"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      autoFocus
                      maxLength={48}
                      className="w-full rounded-md border border-[#3B82F6] bg-[#090B0E] px-2.5 py-1 text-sm text-[#F1F5F9] focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="rounded-md bg-[#3B82F6] px-2.5 py-1 text-xs font-medium text-white"
                    >
                      Salvar
                    </button>
                  </form>
                ) : (
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-[#F1F5F9]">{selectedDevice.name}</h2>
                    <p className="mt-1 text-xs text-[#94A3B8]">
                      {formatFormFactorLabel(selectedDevice.formFactor)} · {formatOsLabel(selectedDevice.os)}
                      {selectedDevice.id === selfDeviceId ? ' · Local' : ''}
                    </p>
                  </div>
                )}
                {!editingName && (
                  <button
                    type="button"
                    onClick={startRename}
                    className="rounded-md border border-[#222936] px-2.5 py-1 text-xs text-[#94A3B8] transition-colors hover:border-[#3B82F6] hover:text-[#F1F5F9] shrink-0"
                  >
                    Renomear
                  </button>
                )}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[#222936] pt-4 text-xs">
                <div>
                  <span className="text-[#64748B]">Resolução</span>
                  <p className="mt-0.5 font-mono text-[#F1F5F9] tabular-nums">
                    {selectedDevice.screenWidth}×{selectedDevice.screenHeight}
                  </p>
                </div>
                <div>
                  <span className="text-[#64748B]">Latência (RTT)</span>
                  <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[#F1F5F9] tabular-nums">
                    <Wifi className="h-3 w-3 text-[#16A34A]" />
                    {selectedDevice.telemetry.rttMs !== null ? `${selectedDevice.telemetry.rttMs} ms` : '—'}
                  </p>
                </div>
                <div>
                  <span className="text-[#64748B]">Bateria</span>
                  <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[#F1F5F9] tabular-nums">
                    <Battery className="h-3 w-3 text-[#94A3B8]" />
                    {selectedDevice.telemetry.batteryLevel !== null
                      ? `${selectedDevice.telemetry.batteryLevel}%${selectedDevice.telemetry.batteryCharging ? ' ⚡' : ''}`
                      : 'Alimentação CA'}
                  </p>
                </div>
                <div>
                  <span className="text-[#64748B]">Agente Desktop</span>
                  <p className="mt-0.5 text-[#F1F5F9]">
                    {selectedDevice.companionConnected ? (
                      <span className="text-[#16A34A]">Nativo ativo</span>
                    ) : (
                      <span className="text-[#94A3B8]">Modo navegador</span>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Display Arrangement Controls */}
            <div className="space-y-3 border-b border-[#222936] p-5">
              <p className="text-xs font-medium text-[#94A3B8]">Configuração da Tela</p>

              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[#CBD5E1]">Orientação</span>
                <button
                  type="button"
                  onClick={() =>
                    onUpdateDevice(selectedDevice.id, {
                      orientation: selectedDevice.orientation === 'landscape' ? 'portrait' : 'landscape',
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6]"
                >
                  <RotateCw className="h-3.5 w-3.5 text-[#94A3B8]" />
                  {selectedDevice.orientation === 'landscape' ? 'Paisagem' : 'Retrato'}
                </button>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[#CBD5E1]">Fluxo de mouse/teclado</span>
                <button
                  type="button"
                  onClick={() =>
                    onUpdateDevice(selectedDevice.id, {
                      edgeFlowEnabled: !selectedDevice.edgeFlowEnabled,
                    })
                  }
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                    selectedDevice.edgeFlowEnabled
                      ? 'border-[#3B82F6] bg-[#3B82F6]/15 text-[#60A5FA]'
                      : 'border-[#222936] bg-[#171C24] text-[#94A3B8]'
                  }`}
                >
                  {selectedDevice.edgeFlowEnabled ? 'Ativo' : 'Desativado'}
                </button>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[#CBD5E1]">Monitor principal</span>
                <button
                  type="button"
                  disabled={selectedDevice.isPrimary}
                  onClick={() => onUpdateDevice(selectedDevice.id, { isPrimary: true })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-3 py-1.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] disabled:cursor-default disabled:border-[#3B82F6]/40 disabled:text-[#60A5FA]"
                >
                  <Star className="h-3.5 w-3.5" />
                  {selectedDevice.isPrimary ? 'Principal' : 'Definir'}
                </button>
              </div>
            </div>

            {/* Direct Actions */}
            <div className="flex flex-1 flex-col justify-between gap-2.5 p-5">
              <div className="space-y-2">
                <p className="text-xs font-medium text-[#94A3B8]">Ações Rápidas</p>
                <button
                  type="button"
                  onClick={() => onOpenSectionForDevice('second-screen', selectedDevice.id)}
                  className="flex w-full items-center justify-between rounded-md bg-[#3B82F6] px-3.5 py-2.5 text-xs font-medium text-white transition-colors hover:bg-[#2563EB]"
                >
                  <span>Estender tela (Second Screen)</span>
                  <Cast className="h-4 w-4 shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={() => onOpenSectionForDevice('remote', selectedDevice.id)}
                  className="flex w-full items-center justify-between rounded-md border border-[#222936] bg-[#171C24] px-3.5 py-2.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6]"
                >
                  <span>Controlar mouse e teclado</span>
                  <Gamepad2 className="h-4 w-4 text-[#94A3B8] shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={() => onOpenSectionForDevice('files', selectedDevice.id)}
                  className="flex w-full items-center justify-between rounded-md border border-[#222936] bg-[#171C24] px-3.5 py-2.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6]"
                >
                  <span>Enviar arquivo agora</span>
                  <FolderUp className="h-4 w-4 text-[#94A3B8] shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={() => onLocateDevice(selectedDevice.id)}
                  className="flex w-full items-center justify-between rounded-md border border-[#222936] bg-[#171C24] px-3.5 py-2.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6]"
                >
                  <span>Localizar dispositivo (toque)</span>
                  <BellRing className="h-4 w-4 text-[#94A3B8] shrink-0" />
                </button>
              </div>

              <div className="pt-2 font-mono text-[11px] text-[#64748B] tabular-nums">
                Posição espacial: X {selectedDevice.x} · Y {selectedDevice.y}
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-[#94A3B8]">
            Conectando ao servidor em tempo real...
          </div>
        )}
      </aside>
    </div>
  );
};
