import React, { useMemo, useState } from 'react';
import {
  AppWindow,
  Bell,
  CheckCheck,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import type { DeviceNode, MeshNotification } from '../types/mesh';
import { formatOsLabel } from '../utils/deviceDetector';

interface SystemTelemetryViewProps {
  devices: DeviceNode[];
  selfDeviceId: string;
  notifications: MeshNotification[];
  onPushNotification: (
    title: string,
    body: string,
    app: string,
    severity: MeshNotification['severity']
  ) => void;
  onMarkNotificationRead: (id: string) => void;
  onDismissNotification: (id: string) => void;
  onClearNotifications: () => void;
  onOpenCompanionTab: () => void;
}

export const SystemTelemetryView: React.FC<SystemTelemetryViewProps> = ({
  devices,
  selfDeviceId,
  notifications,
  onPushNotification,
  onMarkNotificationRead,
  onDismissNotification,
  onClearNotifications,
  onOpenCompanionTab,
}) => {
  const [notifFilter, setNotifFilter] = useState<'all' | 'unread' | 'alert'>('all');
  const [titleDraft, setTitleDraft] = useState('');
  const [bodyDraft, setBodyDraft] = useState('');
  const [appDraft, setAppDraft] = useState('Sistema');
  const [severityDraft, setSeverityDraft] = useState<MeshNotification['severity']>('info');

  const filteredNotifications = useMemo(() => {
    return notifications.filter((n) => {
      if (notifFilter === 'unread') return !n.read;
      if (notifFilter === 'alert') return n.severity === 'alert' || n.severity === 'warning';
      return true;
    });
  }, [notifications, notifFilter]);

  const handleSendNotif = (e: React.FormEvent) => {
    e.preventDefault();
    if (!titleDraft.trim()) return;
    onPushNotification(titleDraft, bodyDraft, appDraft, severityDraft);
    setTitleDraft('');
    setBodyDraft('');
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-5">
      {/* Real-Time System Telemetry Table */}
      <section className="overflow-hidden rounded-lg border border-[#222936] bg-[#11151B]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222936] px-5 py-3.5">
          <div>
            <h1 className="text-base font-semibold text-[#F1F5F9]">Telemetria Real dos Dispositivos</h1>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Métricas coletadas em tempo real via APIs do dispositivo, heartbeat WebSocket e Agente Desktop nativo.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenCompanionTab}
            className="rounded-md border border-[#222936] bg-[#171C24] px-3 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-[#3B82F6] hover:text-[#F1F5F9] whitespace-nowrap"
          >
            Instalar Apps Nativos
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[#222936] bg-[#0D1015] text-[#94A3B8]">
                <th className="px-5 py-2.5 font-medium">Dispositivo</th>
                <th className="px-4 py-2.5 font-medium">Sistema</th>
                <th className="px-4 py-2.5 text-right font-medium">Bateria</th>
                <th className="px-4 py-2.5 text-right font-medium">CPU / Núcleos</th>
                <th className="px-4 py-2.5 text-right font-medium">Memória</th>
                <th className="px-4 py-2.5 text-right font-medium">Latência</th>
                <th className="px-4 py-2.5 text-right font-medium">Vol / Brilho</th>
                <th className="px-5 py-2.5 text-right font-medium">Ponte SO</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#222936]">
              {devices.map((dev) => (
                <tr key={dev.id} className="transition-colors hover:bg-[#171C24]/60">
                  <td className="px-5 py-3">
                    <div className="font-medium text-[#F1F5F9]">
                      {dev.name}
                      {dev.id === selfDeviceId && (
                        <span className="ml-2 text-[11px] font-normal text-[#60A5FA]">Local</span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-[#64748B] tabular-nums">
                      {dev.screenWidth}×{dev.screenHeight} · {dev.pixelRatio}× DPR
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[#CBD5E1]">{formatOsLabel(dev.os)}</td>
                  <td className="px-4 py-3 text-right font-mono text-[#F1F5F9] tabular-nums">
                    {dev.telemetry.batteryLevel !== null
                      ? `${dev.telemetry.batteryLevel}%${dev.telemetry.batteryCharging ? ' ⚡' : ''}`
                      : 'CA'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[#F1F5F9] tabular-nums">
                    {dev.telemetry.cpuUsage !== null
                      ? `${dev.telemetry.cpuUsage}% (${dev.telemetry.cpuCores ?? '?'}c)`
                      : dev.telemetry.cpuCores !== null
                        ? `${dev.telemetry.cpuCores} núcleos`
                        : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[#F1F5F9] tabular-nums">
                    {dev.telemetry.memoryUsedGb !== null && dev.telemetry.memoryTotalGb !== null
                      ? `${dev.telemetry.memoryUsedGb}/${dev.telemetry.memoryTotalGb} GB`
                      : dev.telemetry.memoryTotalGb !== null
                        ? `${dev.telemetry.memoryTotalGb} GB`
                        : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    <span
                      className={
                        dev.telemetry.rttMs !== null && dev.telemetry.rttMs > 120
                          ? 'text-[#D97706]'
                          : 'text-[#16A34A]'
                      }
                    >
                      {dev.telemetry.rttMs !== null ? `${dev.telemetry.rttMs} ms` : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[#CBD5E1] tabular-nums">
                    {dev.telemetry.volume}% / {dev.telemetry.brightness}%
                  </td>
                  <td className="px-5 py-3 text-right">
                    {dev.companionConnected ? (
                      <span className="font-medium text-[#16A34A]">
                        Nativo
                        {dev.telemetry.displayServer && dev.telemetry.displayServer !== 'web'
                          ? ` · ${
                              dev.telemetry.displayServer === 'win32'
                                ? 'Win32'
                                : dev.telemetry.displayServer === 'wayland'
                                  ? 'Wayland'
                                  : 'X11'
                            }`
                          : ''}
                      </span>
                    ) : (
                      <span className="text-[#64748B]">Navegador</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Bottom Split: Open Apps & Unified Notifications */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {/* Open Apps Across Devices */}
        <section className="rounded-lg border border-[#222936] bg-[#11151B]">
          <div className="flex items-center justify-between border-b border-[#222936] px-5 py-3.5">
            <div>
              <h2 className="text-sm font-semibold text-[#F1F5F9]">Apps e Janelas Abertas</h2>
              <p className="mt-0.5 text-xs text-[#94A3B8]">
                Visualização sincronizada de sessões ativas e janelas do sistema (via Agente Desktop).
              </p>
            </div>
            <AppWindow className="h-4 w-4 text-[#64748B]" />
          </div>

          <div className="divide-y divide-[#222936] p-5">
            {devices.map((dev) => (
              <div key={dev.id} className="py-3.5 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-[#F1F5F9]">{dev.name}</span>
                  <span className="text-[#64748B]">
                    {dev.companionConnected ? 'Janelas do SO ao vivo' : 'Sessão Web ativa'}
                  </span>
                </div>
                {dev.telemetry.openApps.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {dev.telemetry.openApps.map((app) => (
                      <li
                        key={app.id}
                        className="flex items-center justify-between gap-3 rounded-sm bg-[#090B0E] px-3 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <span className="font-medium text-[#F1F5F9]">{app.name}</span>
                          <span className="ml-2 text-[#64748B]">· {app.title}</span>
                        </div>
                        <span className="text-[11px] text-[#94A3B8] shrink-0">
                          {app.focused ? 'Em foco' : app.source === 'os-agent' ? 'SO' : 'Web'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-[#64748B]">Nenhuma janela reportada.</p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Unified Notifications Center */}
        <section className="flex flex-col rounded-lg border border-[#222936] bg-[#11151B]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222936] px-5 py-3.5">
            <div>
              <h2 className="text-sm font-semibold text-[#F1F5F9]">Central Unificada de Notificações</h2>
              <p className="mt-0.5 text-xs text-[#94A3B8]">
                Alertas e avisos espelhados e descartados em sincronia entre todos os aparelhos.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="flex items-center rounded-md border border-[#222936] bg-[#090B0E] p-0.5">
                {(
                  [
                    { id: 'all', label: 'Todas' },
                    { id: 'unread', label: 'Não lidas' },
                    { id: 'alert', label: 'Alertas' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setNotifFilter(tab.id)}
                    className={`rounded-sm px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                      notifFilter === tab.id ? 'bg-[#171C24] text-[#F1F5F9]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {notifications.length > 0 && (
                <button
                  type="button"
                  onClick={onClearNotifications}
                  className="rounded-md p-1.5 text-[#64748B] hover:bg-[#171C24] hover:text-[#DC2626]"
                  title="Limpar todas as notificações"
                  aria-label="Limpar todas as notificações"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-1 flex-col p-5">
            {/* Broadcast Notification Composer */}
            <form onSubmit={handleSendNotif} className="space-y-2 border-b border-[#222936] pb-4">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_110px_100px]">
                <input
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  placeholder="Enviar notificação para a malha..."
                  className="h-9 rounded-md border border-[#222936] bg-[#090B0E] px-3 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-[#3B82F6] focus:outline-none"
                />
                <input
                  type="text"
                  value={appDraft}
                  onChange={(e) => setAppDraft(e.target.value)}
                  placeholder="App"
                  className="h-9 rounded-md border border-[#222936] bg-[#090B0E] px-2.5 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-[#3B82F6] focus:outline-none"
                />
                <select
                  aria-label="Prioridade"
                  value={severityDraft}
                  onChange={(e) => setSeverityDraft(e.target.value as MeshNotification['severity'])}
                  className="h-9 rounded-md border border-[#222936] bg-[#090B0E] px-2 text-xs text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
                >
                  <option value="info">Info</option>
                  <option value="warning">Aviso</option>
                  <option value="alert">Alerta</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={bodyDraft}
                  onChange={(e) => setBodyDraft(e.target.value)}
                  placeholder="Detalhes opcionais..."
                  className="h-9 flex-1 rounded-md border border-[#222936] bg-[#090B0E] px-3 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-[#3B82F6] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!titleDraft.trim()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#3B82F6] px-3.5 text-xs font-medium text-white hover:bg-[#2563EB] disabled:opacity-40 whitespace-nowrap"
                >
                  <Send className="h-3.5 w-3.5" />
                  Disparar
                </button>
              </div>
            </form>

            {/* Notifications Feed */}
            <div className="mt-3 flex-1 divide-y divide-[#222936]">
              {filteredNotifications.length === 0 ? (
                <div className="flex flex-col items-center py-10 text-center text-xs text-[#64748B]">
                  <Bell className="h-6 w-6 text-[#2E3748]" />
                  <p className="mt-2">Nenhuma notificação nesta visualização.</p>
                </div>
              ) : (
                filteredNotifications.map((notif) => (
                  <div
                    key={notif.id}
                    className={`flex items-start justify-between gap-3 py-3 ${notif.read ? 'opacity-65' : ''}`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#94A3B8]">
                        <span
                          className={
                            notif.severity === 'alert'
                              ? 'font-medium text-[#DC2626]'
                              : notif.severity === 'warning'
                                ? 'font-medium text-[#D97706]'
                                : 'font-medium text-[#60A5FA]'
                          }
                        >
                          {notif.app}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{notif.sourceDeviceName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{formatTime(notif.createdAt)}</span>
                      </div>
                      <p className="mt-1 text-xs font-medium text-[#F1F5F9]">{notif.title}</p>
                      {notif.body && <p className="mt-0.5 text-xs text-[#94A3B8]">{notif.body}</p>}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {!notif.read && (
                        <button
                          type="button"
                          onClick={() => onMarkNotificationRead(notif.id)}
                          className="rounded-sm p-1.5 text-[#94A3B8] hover:bg-[#171C24] hover:text-[#16A34A]"
                          title="Marcar como lida"
                          aria-label="Marcar como lida"
                        >
                          <CheckCheck className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onDismissNotification(notif.id)}
                        className="rounded-sm p-1.5 text-[#94A3B8] hover:bg-[#171C24] hover:text-[#F1F5F9]"
                        title="Descartar em todos os dispositivos"
                        aria-label="Descartar notificação"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
