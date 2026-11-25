import React, { useEffect, useState } from 'react';
import {
  Activity,
  Cast,
  Download,
  ExternalLink,
  FolderSync,
  Gamepad2,
  LayoutGrid,
  MousePointer2,
  QrCode,
  X,
} from 'lucide-react';
import { useMeshClient } from './hooks/useMeshClient';
import type { WorkspaceSection } from './types/mesh';
import { SpatialDisplayMap } from './components/SpatialDisplayMap';
import { SecondScreenView } from './components/SecondScreenView';
import { RemoteControlView } from './components/RemoteControlView';
import { FilesAndClipboardView } from './components/FilesAndClipboardView';
import { SystemTelemetryView } from './components/SystemTelemetryView';
import { CompanionAgentView } from './components/CompanionAgentView';
import { PairingModal } from './components/PairingModal';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';

interface NavItem {
  id: WorkspaceSection;
  label: string;
  shortLabel: string;
  icon: React.FC<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'map', label: 'Mapa Espacial', shortLabel: 'Mapa', icon: LayoutGrid },
  { id: 'second-screen', label: 'Second Screen', shortLabel: 'Tela', icon: Cast },
  { id: 'remote', label: 'Controle Remoto', shortLabel: 'Controle', icon: Gamepad2 },
  { id: 'files', label: 'Arquivos & Clipboard', shortLabel: 'Arquivos', icon: FolderSync },
  { id: 'system', label: 'Sistema & Alertas', shortLabel: 'Sistema', icon: Activity },
  { id: 'companion', label: 'Instalar Apps', shortLabel: 'Instalar', icon: Download },
];

export default function App() {
  const mesh = useMeshClient();
  const [section, setSection] = useState<WorkspaceSection>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('install') ? 'companion' : 'map';
  });
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);

  // Automatically switch to Second Screen view when receiving an incoming live video stream
  useEffect(() => {
    if (mesh.streamRole === 'receiver' && mesh.remoteStream) {
      setSection('second-screen');
    }
  }, [mesh.streamRole, mesh.remoteStream]);

  const activeNav = NAV_ITEMS.find((item) => item.id === section) ?? NAV_ITEMS[0];
  const unreadNotifs = mesh.notifications.filter((n) => !n.read).length;

  const handleOpenSectionForDevice = (nextSection: WorkspaceSection, deviceId: string) => {
    setSelectedDeviceId(deviceId);
    setSection(nextSection);
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#090B0E] text-[#F1F5F9] lg:flex-row">
      {/* Desktop Left Sidebar (248px) */}
      <aside className="hidden lg:flex lg:w-[248px] lg:shrink-0 lg:flex-col lg:border-r lg:border-[#222936] lg:bg-[#0D1015]">
        <div className="flex h-14 items-center border-b border-[#222936] px-5">
          <span className="font-display text-base font-bold tracking-tight text-[#F1F5F9] whitespace-nowrap">
            Continuum
          </span>
        </div>

        <nav className="flex-1 space-y-1 p-3" aria-label="Navegação principal">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-sm font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-[#171C24] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:bg-[#11151B] hover:text-[#F1F5F9]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-[#3B82F6]' : 'text-[#64748B]'}`} />
                  {item.label}
                </span>
                {item.id === 'system' && unreadNotifs > 0 && (
                  <span className="font-mono text-[11px] font-semibold text-[#60A5FA] tabular-nums">
                    {unreadNotifs}
                  </span>
                )}
                {item.id === 'second-screen' && mesh.streamRole !== 'idle' && (
                  <span className="text-[11px] font-medium text-[#16A34A]">Ativo</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Live Real Mesh Connection Block */}
        <div className="border-t border-[#222936] p-4 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-[#94A3B8]">Malha</span>
            <button
              type="button"
              onClick={() => setPairingOpen(true)}
              className="font-mono font-semibold tracking-wider text-[#F1F5F9] hover:text-[#60A5FA] tabular-nums"
            >
              {mesh.roomCode}
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-[#94A3B8]">
            <span className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  mesh.connectionState === 'connected'
                    ? 'bg-[#16A34A]'
                    : mesh.connectionState === 'reconnecting'
                      ? 'bg-[#D97706]'
                      : 'bg-[#64748B]'
                }`}
                aria-hidden="true"
              />
              {mesh.connectionState === 'connected'
                ? 'Conectado'
                : mesh.connectionState === 'reconnecting'
                  ? 'Reconectando'
                  : 'Conectando'}
            </span>
            <span className="font-mono tabular-nums">
              {mesh.rttMs !== null ? `${mesh.rttMs} ms` : '—'}
            </span>
          </div>
          <div className="mt-1.5 text-[11px] text-[#64748B]">
            {mesh.devices.length} {mesh.devices.length === 1 ? 'dispositivo' : 'dispositivos'} online
          </div>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar Contract: Breadcrumb on Left, 1–2 Actions on Right */}
        <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-4 border-b border-[#222936] bg-[#090B0E]/95 px-4 backdrop-blur-xs lg:h-14 lg:px-6">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="font-display font-semibold text-[#F1F5F9] lg:text-[#94A3B8] lg:font-normal whitespace-nowrap">
              Continuum
            </span>
            <span className="text-[#475569]" aria-hidden="true">
              /
            </span>
            <span className="truncate font-medium text-[#F1F5F9]">{activeNav.label}</span>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <PWAInstallButton />
            <button
              type="button"
              onClick={() => setPairingOpen(true)}
              className="inline-flex items-center gap-2 rounded-md bg-[#3B82F6] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B82F6] whitespace-nowrap shrink-0"
            >
              <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
              Parear Dispositivo
            </button>
          </div>
        </header>

        {/* Active Workspace Viewport */}
        <main className="flex-1 p-4 pb-20 lg:p-6 lg:pb-6">
          {section === 'map' && (
            <SpatialDisplayMap
              devices={mesh.devices}
              selfDeviceId={mesh.selfDeviceId}
              screenSessions={mesh.screenSessions}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={setSelectedDeviceId}
              onMoveDevice={mesh.moveDevicePosition}
              onUpdateDevice={mesh.updateDeviceNode}
              onRenameDevice={mesh.renameDevice}
              onLocateDevice={(id) => mesh.sendRemoteInput(id, { kind: 'command', action: 'ping' })}
              onOpenSectionForDevice={handleOpenSectionForDevice}
              onOpenPairing={() => setPairingOpen(true)}
            />
          )}

          {section === 'second-screen' && (
            <SecondScreenView
              devices={mesh.devices}
              peerDevices={mesh.peerDevices}
              selfDeviceId={mesh.selfDeviceId}
              preferredTargetId={selectedDeviceId}
              screenSessions={mesh.screenSessions}
              localStream={mesh.localStream}
              remoteStream={mesh.remoteStream}
              streamRole={mesh.streamRole}
              rtcStats={mesh.rtcStats}
              onStartCast={mesh.startSecondScreenCast}
              onStopCast={mesh.stopSecondScreenCast}
              onSendInput={mesh.sendRemoteInput}
              onOpenPairing={() => setPairingOpen(true)}
            />
          )}

          {section === 'remote' && (
            <RemoteControlView
              devices={mesh.devices}
              peerDevices={mesh.peerDevices}
              selfDeviceId={mesh.selfDeviceId}
              preferredTargetId={selectedDeviceId}
              onSendInput={mesh.sendRemoteInput}
              onOpenPairing={() => setPairingOpen(true)}
            />
          )}

          {section === 'files' && (
            <FilesAndClipboardView
              peerDevices={mesh.peerDevices}
              preferredTargetId={selectedDeviceId}
              transfers={mesh.transfers}
              clipboard={mesh.clipboard}
              onSendFile={mesh.sendFileToMesh}
              onClearTransfers={mesh.clearTransfers}
              onPushClipboard={mesh.pushClipboard}
              onDeleteClipboard={mesh.deleteClipboardItem}
            />
          )}

          {section === 'system' && (
            <SystemTelemetryView
              devices={mesh.devices}
              selfDeviceId={mesh.selfDeviceId}
              notifications={mesh.notifications}
              onPushNotification={mesh.pushNotification}
              onMarkNotificationRead={mesh.markNotificationRead}
              onDismissNotification={mesh.dismissNotification}
              onClearNotifications={mesh.clearNotifications}
              onOpenCompanionTab={() => setSection('companion')}
            />
          )}

          {section === 'companion' && (
            <CompanionAgentView
              roomCode={mesh.roomCode}
              devices={mesh.devices}
              connectionState={mesh.connectionState}
              rttMs={mesh.rttMs}
              onTestBridge={(id) => mesh.sendRemoteInput(id, { kind: 'command', action: 'ping' })}
            />
          )}
        </main>
      </div>

      {/* Compact Mobile Bottom Navigation (56px, keeps total sticky < 15%) */}
      <nav
        aria-label="Navegação móvel"
        className="fixed right-0 bottom-0 left-0 z-30 flex h-14 items-center justify-around border-t border-[#222936] bg-[#0D1015]/95 px-1 backdrop-blur-xs lg:hidden"
      >
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={`flex min-w-[44px] flex-col items-center justify-center gap-0.5 rounded-md px-1.5 py-1 text-[10px] font-medium transition-colors ${
                isActive ? 'text-[#60A5FA]' : 'text-[#94A3B8]'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="truncate">{item.shortLabel}</span>
            </button>
          );
        })}
      </nav>

      {/* Pairing Modal */}
      <PairingModal
        open={pairingOpen}
        roomCode={mesh.roomCode}
        deviceCount={mesh.devices.length}
        onClose={() => setPairingOpen(false)}
        onSwitchRoom={mesh.switchRoom}
      />

      {/* Live Remote Cursor Overlay when controlled by another device */}
      {mesh.remoteCursor.visible && (
        <div
          className="pointer-events-none fixed top-0 left-0 z-50 transition-transform duration-75"
          style={{
            transform: `translate3d(${Math.round(mesh.remoteCursor.nx * window.innerWidth)}px, ${Math.round(
              mesh.remoteCursor.ny * window.innerHeight
            )}px, 0)`,
          }}
        >
          <div className="relative">
            <MousePointer2
              className={`h-5 w-5 fill-[#3B82F6] text-white transition-transform ${
                mesh.remoteCursor.clicking ? 'scale-75' : 'scale-100'
              }`}
            />
            <span className="ml-4 rounded-sm border border-[#3B82F6]/50 bg-[#11151B] px-2 py-0.5 text-[11px] font-medium text-[#F1F5F9] whitespace-nowrap">
              {mesh.remoteCursor.fromName}
            </span>
          </div>
        </div>
      )}

      {/* Real-Time Event Toasts */}
      {mesh.toasts.length > 0 && (
        <div className="fixed right-4 bottom-16 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 lg:bottom-4">
          {mesh.toasts.map((toast) => (
            <div
              key={toast.id}
              role="status"
              className="flex items-start justify-between gap-3 rounded-md border border-[#2E3748] bg-[#171C24] p-3.5 text-xs shadow-lg"
            >
              <div className="min-w-0">
                <p className="font-medium text-[#60A5FA]">{toast.fromName}</p>
                <p className="mt-0.5 text-[#F1F5F9] break-words">{toast.message}</p>
                {toast.url && (
                  <a
                    href={toast.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 font-medium text-[#60A5FA] hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Abrir link
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={() => mesh.dismissToast(toast.id)}
                className="rounded-sm p-1 text-[#94A3B8] hover:text-[#F1F5F9]"
                aria-label="Fechar aviso"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <OfflineIndicator />
    </div>
  );
}
