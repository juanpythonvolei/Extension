import React, { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  GitBranch,
  Globe,
  Laptop,
  Monitor,
  Package,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type { DeviceNode } from '../types/mesh';
import type { ConnectionState } from '../hooks/useMeshClient';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { detectPlatformOS, formatBytes, formatOsLabel } from '../utils/deviceDetector';

interface CompanionAgentViewProps {
  roomCode: string;
  devices: DeviceNode[];
  connectionState: ConnectionState;
  rttMs: number | null;
  onTestBridge: (deviceId: string) => void;
}

type PlatformTab = 'windows' | 'linux' | 'android' | 'ios' | 'repo';

type DiagnosticStatus = 'idle' | 'running' | 'ok' | 'warn' | 'fail';

interface DiagnosticsApiResponse {
  ok: boolean;
  roomCode: string;
  uptimeSec: number;
  appUrl: string;
  wsUrl: string;
  isPrivatePreview: boolean;
  browserClientsCount: number;
  companionCount: number;
  totalDevicesInRoom: number;
  companionDevices: Array<{
    id: string;
    name: string;
    os: string;
    displayServer: string;
    companionLastSeenAt: number | null;
    cpuUsage: number | null;
  }>;
  timestamp: number;
}

interface DiagnosticCheckResult {
  status: DiagnosticStatus;
  metric: string;
  detail: string;
}

interface FullDiagnosticReport {
  ranAt: number | null;
  http: DiagnosticCheckResult;
  ws: DiagnosticCheckResult;
  webrtc: DiagnosticCheckResult;
  bridge: DiagnosticCheckResult;
  apiSnapshot: DiagnosticsApiResponse | null;
}

interface DownloadFeedback {
  state: 'idle' | 'downloading' | 'ok' | 'error';
  activeKey: string | null;
  message: string;
}

interface GitHubReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubReleaseState {
  loading: boolean;
  error: string | null;
  tagName: string | null;
  htmlUrl: string | null;
  publishedAt: string | null;
  assets: GitHubReleaseAsset[];
}

function getInitialPlatformTab(): PlatformTab {
  const params = new URLSearchParams(window.location.search);
  const queryInstall = params.get('install');
  if (
    queryInstall === 'android' ||
    queryInstall === 'windows' ||
    queryInstall === 'linux' ||
    queryInstall === 'ios' ||
    queryInstall === 'repo'
  ) {
    return queryInstall;
  }
  const detected = detectPlatformOS();
  if (detected === 'windows' || detected === 'linux' || detected === 'android' || detected === 'ios') {
    return detected;
  }
  return 'windows';
}

function normalizeServerOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return window.location.origin;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  } catch {
    // ignore invalid intermediate input
  }
  return window.location.origin;
}

function normalizeGithubRepoSlug(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0].replace(/[^A-Za-z0-9_.-]/g, '');
  const repo = parts[1].replace(/[^A-Za-z0-9_.-]/g, '');
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

function formatDisplayServer(ds?: string): string {
  if (ds === 'win32') return 'Win32';
  if (ds === 'wayland') return 'Wayland';
  if (ds === 'x11') return 'X11';
  return 'Web';
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${seconds % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return `há ${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  return `há ${mins}m`;
}

function hasValidMagicBytes(bytes: Uint8Array, expectedKind: 'deb' | 'zip'): boolean {
  if (expectedKind === 'deb') {
    // Standard Debian ar archive magic: "!<arch>\n"
    const sig = [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a];
    if (bytes.length < sig.length) return false;
    return sig.every((b, idx) => bytes[idx] === b);
  }
  // Standard ZIP local file header: "PK\x03\x04"
  if (bytes.length < 4) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function probeWebRtcStun(): Promise<DiagnosticCheckResult> {
  if (typeof RTCPeerConnection === 'undefined') {
    return {
      status: 'fail',
      metric: 'Indisponível',
      detail: 'Este navegador não expõe RTCPeerConnection para Second Screen P2P.',
    };
  }

  const startedAt = performance.now();
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  });

  const types = new Set<string>();
  try {
    pc.createDataChannel('continuum-diag-probe');

    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => resolve(), 2600);

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          window.clearTimeout(timeout);
          resolve();
          return;
        }
        const candStr = ev.candidate.candidate || '';
        const match = candStr.match(/\btyp\s+(host|srflx|prflx|relay)\b/);
        if (match) {
          types.add(match[1]);
          if (types.has('srflx')) {
            window.clearTimeout(timeout);
            resolve();
          }
        }
      };

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          window.clearTimeout(timeout);
          resolve();
        }
      };

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => {
          window.clearTimeout(timeout);
          resolve();
        });
    });

    const elapsedMs = Math.max(1, Math.round(performance.now() - startedAt));
    const list = Array.from(types);

    if (types.has('srflx')) {
      return {
        status: 'ok',
        metric: `${elapsedMs} ms · ${list.join(' + ')}`,
        detail: 'Candidatos LAN (host) e públicos STUN (srflx) coletados. Second Screen P2P pronto.',
      };
    }
    if (types.has('host')) {
      return {
        status: 'warn',
        metric: `${elapsedMs} ms · host`,
        detail: 'Apenas candidatos locais (LAN) coletados; redes com NAT estrito podem limitar transmissão externa.',
      };
    }
    return {
      status: 'fail',
      metric: `${elapsedMs} ms · 0 ICE`,
      detail: 'Nenhum candidato ICE foi coletado. Verifique firewall ou bloqueio de WebRTC no navegador.',
    };
  } catch {
    return {
      status: 'fail',
      metric: 'Erro ICE',
      detail: 'Falha ao inicializar teste de coleta ICE WebRTC.',
    };
  } finally {
    try {
      pc.close();
    } catch {
      // ignore
    }
  }
}

export const CompanionAgentView: React.FC<CompanionAgentViewProps> = ({
  roomCode,
  devices,
  connectionState,
  rttMs,
  onTestBridge,
}) => {
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformTab>(() => getInitialPlatformTab());
  const [mobileQrUrl, setMobileQrUrl] = useState<string>('');
  const [serverDraft, setServerDraft] = useState<string>(() => {
    try {
      return localStorage.getItem('continuum_installer_server') || window.location.origin;
    } catch {
      return window.location.origin;
    }
  });
  const [downloadFeedback, setDownloadFeedback] = useState<DownloadFeedback>({
    state: 'idle',
    activeKey: null,
    message: '',
  });
  const [githubRepoDraft, setGithubRepoDraft] = useState<string>(() => {
    try {
      return localStorage.getItem('continuum_github_repo') || '';
    } catch {
      return '';
    }
  });
  const [releaseState, setReleaseState] = useState<GitHubReleaseState>({
    loading: false,
    error: null,
    tagName: null,
    htmlUrl: null,
    publishedAt: null,
    assets: [],
  });
  const [diagRunning, setDiagRunning] = useState(false);
  const [testedDeviceId, setTestedDeviceId] = useState<string | null>(null);
  const [diagReport, setDiagReport] = useState<FullDiagnosticReport>({
    ranAt: null,
    http: { status: 'idle', metric: '—', detail: 'Clique em Executar Diagnóstico para verificar o servidor.' },
    ws: { status: 'idle', metric: '—', detail: 'Aguardando verificação do canal WebSocket da malha.' },
    webrtc: { status: 'idle', metric: '—', detail: 'Verifica coleta real de candidatos STUN/ICE para Second Screen.' },
    bridge: { status: 'idle', metric: '—', detail: 'Valida acoplamento de pontes nativas Windows/Linux na malha.' },
    apiSnapshot: null,
  });

  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();

  const detectedOs = detectPlatformOS();
  const connectedCompanions = devices.filter((d) => d.companionConnected);
  const effectiveServer = normalizeServerOrigin(serverDraft);
  const isCustomServer = effectiveServer !== window.location.origin;
  const isPrivatePreviewHost = (() => {
    try {
      return new URL(effectiveServer).hostname.startsWith('ais-dev-');
    } catch {
      return false;
    }
  })();

  const serverQueryParam = isCustomServer ? `&server=${encodeURIComponent(effectiveServer)}` : '';
  const mobileInstallLink = `${effectiveServer}${window.location.pathname}?room=${encodeURIComponent(
    roomCode
  )}&install=${selectedPlatform === 'ios' ? 'ios' : 'android'}`;

  useEffect(() => {
    try {
      if (effectiveServer === window.location.origin) {
        localStorage.removeItem('continuum_installer_server');
      } else {
        localStorage.setItem('continuum_installer_server', effectiveServer);
      }
    } catch {
      // ignore storage errors
    }
  }, [effectiveServer]);

  useEffect(() => {
    if (selectedPlatform !== 'android' && selectedPlatform !== 'ios') return;
    let active = true;
    QRCode.toDataURL(mobileInstallLink, {
      width: 200,
      margin: 2,
      color: { dark: '#F1F5F9', light: '#090B0E' },
    })
      .then((url) => {
        if (active) setMobileQrUrl(url);
      })
      .catch(() => {
        if (active) setMobileQrUrl('');
      });
    return () => {
      active = false;
    };
  }, [mobileInstallLink, selectedPlatform]);

  /**
   * Verified authenticated binary download via fetch() + Blob.
   * Prevents browser download managers inside sandboxed iframes from saving an HTML auth redirect
   * as a corrupted .deb or .zip file.
   */
  const downloadVerifiedPackage = useCallback(
    async (key: string, url: string, fileName: string, expectedKind: 'deb' | 'zip') => {
      setDownloadFeedback({
        state: 'downloading',
        activeKey: key,
        message: `Baixando e validando assinatura binária de ${fileName}...`,
      });
      try {
        const resp = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        });

        const contentType = (resp.headers.get('content-type') || '').toLowerCase();
        if (!resp.ok) {
          throw new Error(`Servidor retornou HTTP ${resp.status}.`);
        }
        if (contentType.includes('text/html')) {
          throw new Error(
            'O proxy retornou HTML em vez do pacote binário. Abra o Continuum pela URL compartilhada (ou fora do iframe) e tente novamente.'
          );
        }

        const buffer = await resp.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        if (!hasValidMagicBytes(bytes, expectedKind)) {
          throw new Error(
            expectedKind === 'deb'
              ? 'Assinatura binária inválida: o arquivo recebido não é um pacote Debian (.deb) íntegro.'
              : 'Assinatura binária inválida: o arquivo recebido não é um pacote .ZIP íntegro.'
          );
        }

        const mimeType =
          expectedKind === 'deb' ? 'application/vnd.debian.binary-package' : 'application/zip';
        const blob = new Blob([buffer], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);

        setDownloadFeedback({
          state: 'ok',
          activeKey: null,
          message: `${fileName} validado (${formatBytes(bytes.length)}, assinatura ${
            expectedKind === 'deb' ? 'Debian ar' : 'ZIP PK'
          } íntegra) e salvo com sucesso.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Falha desconhecida ao baixar o pacote.';
        setDownloadFeedback({
          state: 'error',
          activeKey: null,
          message: msg,
        });
      }
    },
    []
  );

  const fetchGitHubReleases = useCallback(async (rawSlug: string) => {
    const slug = normalizeGithubRepoSlug(rawSlug);
    if (!slug) {
      setReleaseState({
        loading: false,
        error: 'Informe no formato usuario/repositorio (ex: joao/continuum-native).',
        tagName: null,
        htmlUrl: null,
        publishedAt: null,
        assets: [],
      });
      return;
    }

    try {
      localStorage.setItem('continuum_github_repo', slug);
    } catch {
      // ignore
    }

    setReleaseState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const resp = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (resp.status === 404) {
        throw new Error('Nenhuma Release publicada encontrada neste repositório ainda. Aguarde a conclusão do GitHub Actions.');
      }
      if (!resp.ok) {
        throw new Error(`GitHub API retornou HTTP ${resp.status}. Verifique se o repositório é público.`);
      }
      const data = (await resp.json()) as {
        tag_name?: string;
        html_url?: string;
        published_at?: string;
        assets?: GitHubReleaseAsset[];
      };
      const assets = Array.isArray(data.assets)
        ? data.assets.filter((a) => /\.(deb|appimage|exe|apk)$/i.test(a.name))
        : [];
      setReleaseState({
        loading: false,
        error: assets.length === 0 ? 'Release encontrada, mas sem arquivos .deb, .AppImage, .exe ou .apk anexados.' : null,
        tagName: data.tag_name || 'latest',
        htmlUrl: data.html_url || `https://github.com/${slug}/releases`,
        publishedAt: data.published_at || null,
        assets,
      });
    } catch (err) {
      setReleaseState({
        loading: false,
        error: err instanceof Error ? err.message : 'Não foi possível consultar as Releases do GitHub.',
        tagName: null,
        htmlUrl: null,
        publishedAt: null,
        assets: [],
      });
    }
  }, []);

  const runDiagnostics = useCallback(async () => {
    setDiagRunning(true);
    setDiagReport((prev) => ({
      ...prev,
      http: { status: 'running', metric: 'Testando...', detail: 'Consultando /api/diagnostics...' },
      ws: { status: 'running', metric: 'Testando...', detail: 'Verificando estado do WebSocket...' },
      webrtc: { status: 'running', metric: 'Coletando ICE...', detail: 'Testando servidores STUN...' },
      bridge: { status: 'running', metric: 'Verificando...', detail: 'Inspecionando pontes acopladas...' },
    }));

    // 1. Real HTTP Diagnostics probe
    let httpResult: DiagnosticCheckResult;
    let apiSnapshot: DiagnosticsApiResponse | null = null;
    const httpStart = performance.now();
    try {
      const resp = await fetch(
        `/api/diagnostics?room=${encodeURIComponent(roomCode)}${serverQueryParam}`,
        { cache: 'no-store' }
      );
      const httpMs = Math.max(1, Math.round(performance.now() - httpStart));
      if (!resp.ok) {
        httpResult = {
          status: 'fail',
          metric: `HTTP ${resp.status}`,
          detail: 'Servidor respondeu com erro na rota de diagnóstico.',
        };
      } else {
        const data = (await resp.json()) as DiagnosticsApiResponse;
        apiSnapshot = data;
        httpResult = data.isPrivatePreview
          ? {
              status: 'warn',
              metric: `${httpMs} ms · uptime ${formatUptime(data.uptimeSec)}`,
              detail:
                'Servidor online, porém em URL privada ais-dev-*. Pontes desktop externas exigem URL compartilhada (ais-pre-*) ou servidor local.',
            }
          : {
              status: 'ok',
              metric: `${httpMs} ms · uptime ${formatUptime(data.uptimeSec)}`,
              detail: `Endpoint pronto para instaladores: ${data.appUrl} (${data.totalDevicesInRoom} nó(s) na malha ${data.roomCode}).`,
            };
      }
    } catch {
      httpResult = {
        status: 'fail',
        metric: 'Sem resposta',
        detail: 'Não foi possível alcançar /api/diagnostics no servidor.',
      };
    }

    // 2. Real WebSocket Mesh check
    const wsResult: DiagnosticCheckResult =
      connectionState === 'connected'
        ? {
            status: 'ok',
            metric: rttMs !== null ? `${rttMs} ms · Malha ${roomCode}` : `Conectado · ${roomCode}`,
            detail: `Canal WebSocket /ws autenticado na sala ${roomCode} com ${devices.length} dispositivo(s) sincronizado(s).`,
          }
        : connectionState === 'reconnecting'
          ? {
              status: 'warn',
              metric: 'Reconectando',
              detail: 'Conexão WebSocket oscilou e está restabelecendo a sessão automaticamente.',
            }
          : {
              status: 'fail',
              metric: 'Desconectado',
              detail: 'WebSocket /ws ainda não estabeleceu conexão com o servidor.',
            };

    // 3. Real WebRTC STUN/ICE probe
    const webrtcResult = await probeWebRtcStun();

    // 4. Native OS Bridge inspection
    const liveCompanions = devices.filter((d) => d.companionConnected);
    const hasWayland = liveCompanions.some((d) => d.telemetry.displayServer === 'wayland');
    let bridgeResult: DiagnosticCheckResult;
    if (liveCompanions.length > 0) {
      const summary = liveCompanions
        .map((d) => `${d.name} (${formatDisplayServer(d.telemetry.displayServer)})`)
        .join(', ');
      bridgeResult = hasWayland
        ? {
            status: 'warn',
            metric: `${liveCompanions.length} ativa(s) · Wayland`,
            detail: `Acoplada em ${summary}. No Wayland, telemetria e Second Screen funcionam normalmente; controle global de cursor/teclas requer sessão X11/Xorg.`,
          }
        : {
            status: 'ok',
            metric: `${liveCompanions.length} ponte(s) ativa(s)`,
            detail: `Controle nativo acoplado sem duplicidade em: ${summary}.`,
          };
    } else if (isPrivatePreviewHost) {
      bridgeResult = {
        status: 'warn',
        metric: '0 pontes acopladas',
        detail:
          'Nenhuma ponte conectada. Como o endereço atual é um preview privado (ais-dev-*), configure acima a URL compartilhada (ais-pre-*) antes de baixar o instalador.',
      };
    } else {
      bridgeResult = {
        status: 'warn',
        metric: '0 pontes acopladas',
        detail:
          'Nenhuma ponte Windows/Linux conectada nesta sala. Instale o pacote .DEB ou .ZIP acima; em caso de falha, consulte bridge.log na máquina.',
      };
    }

    setDiagReport({
      ranAt: Date.now(),
      http: httpResult,
      ws: wsResult,
      webrtc: webrtcResult,
      bridge: bridgeResult,
      apiSnapshot,
    });
    setDiagRunning(false);
  }, [connectionState, devices, isPrivatePreviewHost, roomCode, rttMs, serverQueryParam]);

  const handleTriggerBridgeTest = (deviceId: string) => {
    onTestBridge(deviceId);
    setTestedDeviceId(deviceId);
    window.setTimeout(() => {
      setTestedDeviceId((cur) => (cur === deviceId ? null : cur));
    }, 2200);
  };

  const platformTabs: Array<{ id: PlatformTab; label: string; icon: React.FC<{ className?: string }> }> = [
    { id: 'linux', label: 'Linux', icon: Laptop },
    { id: 'windows', label: 'Windows', icon: Monitor },
    { id: 'android', label: 'Android', icon: Smartphone },
    { id: 'ios', label: 'iOS', icon: Smartphone },
    { id: 'repo', label: 'Repositório CI', icon: GitBranch },
  ];

  const windowsUrl = `/api/download-app/windows?room=${encodeURIComponent(roomCode)}${serverQueryParam}`;
  const linuxDebUrl = `/api/download-app/linux-deb?room=${encodeURIComponent(roomCode)}${serverQueryParam}`;
  const linuxUrl = `/api/download-app/linux?room=${encodeURIComponent(roomCode)}${serverQueryParam}`;
  const androidNativeUrl = `/api/download-app/android?room=${encodeURIComponent(roomCode)}${serverQueryParam}`;
  const nativeRepoUrl = `/api/download-app/native-repo?room=${encodeURIComponent(roomCode)}${serverQueryParam}`;

  const renderStatusBadge = (status: DiagnosticStatus) => {
    if (status === 'ok') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#16A34A]">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          Operacional
        </span>
      );
    }
    if (status === 'warn') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#D97706]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Atenção
        </span>
      );
    }
    if (status === 'fail') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#DC2626]">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          Falha
        </span>
      );
    }
    if (status === 'running') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#60A5FA]">
          <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
          Testando
        </span>
      );
    }
    return <span className="text-xs text-[#64748B]">Aguardando</span>;
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        {/* Primary OS Plug-and-Play Installer Center */}
        <section className="rounded-lg border border-[#222936] bg-[#11151B] p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#222936] pb-4">
            <div>
              <h1 className="text-base font-semibold text-[#F1F5F9]">Instalar Aplicativos Nativos (Plug &amp; Play)</h1>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[#94A3B8]">
                Baixe pacotes validados com verificação de integridade binária para a malha{' '}
                <span className="font-mono font-medium text-[#F1F5F9]">{roomCode}</span>, ou use o{' '}
                <strong className="font-medium text-[#CBD5E1]">Repositório CI</strong> para compilar executáveis nativos (.deb, .AppImage, .exe e .apk) via GitHub Actions.
              </p>
            </div>
            <span className="text-xs text-[#94A3B8]">
              Sistema atual: <strong className="font-medium text-[#F1F5F9]">{formatOsLabel(detectedOs)}</strong>
            </span>
          </div>

          {/* Embedded Server Endpoint Bar */}
          <div className="mt-4 rounded-md border border-[#222936] bg-[#0D1015] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="installer-server-url"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[#CBD5E1]"
              >
                <Globe className="h-3.5 w-3.5 text-[#60A5FA]" />
                Endereço do servidor embutido nos instaladores
              </label>
              {isCustomServer && (
                <button
                  type="button"
                  onClick={() => setServerDraft(window.location.origin)}
                  className="inline-flex items-center gap-1 text-[11px] text-[#94A3B8] hover:text-[#F1F5F9]"
                >
                  <RotateCcw className="h-3 w-3" />
                  Restaurar padrão
                </button>
              )}
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                id="installer-server-url"
                type="url"
                value={serverDraft}
                onChange={(e) => setServerDraft(e.target.value)}
                placeholder="https://seu-endereco-compartilhado-ou-ip-local"
                className="h-8 flex-1 rounded-md border border-[#222936] bg-[#090B0E] px-3 font-mono text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-[#3B82F6] focus:outline-none"
              />
              <span className="font-mono text-[11px] text-[#64748B] shrink-0">
                Malha {roomCode}
              </span>
            </div>
            {isPrivatePreviewHost && (
              <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-[#D97706]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  O endereço <span className="font-mono">ais-dev-*</span> exige autenticação do navegador. Para que a ponte nativa do Windows/Linux conecte sem redirecionamento de login, informe acima a URL pública compartilhada (<span className="font-mono">ais-pre-*</span>) ou o IP da sua rede local antes de baixar.
                </span>
              </p>
            )}
          </div>

          {/* Verified Binary Download Feedback Banner */}
          {downloadFeedback.state !== 'idle' && (
            <div
              role="status"
              className={`mt-3 flex items-start gap-2 rounded-md border px-3.5 py-2.5 text-xs ${
                downloadFeedback.state === 'ok'
                  ? 'border-[#16A34A]/40 bg-[#16A34A]/10 text-[#CBD5E1]'
                  : downloadFeedback.state === 'error'
                    ? 'border-[#DC2626]/40 bg-[#DC2626]/10 text-[#F1F5F9]'
                    : 'border-[#3B82F6]/40 bg-[#3B82F6]/10 text-[#CBD5E1]'
              }`}
            >
              {downloadFeedback.state === 'ok' && (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#16A34A]" />
              )}
              {downloadFeedback.state === 'error' && (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
              )}
              {downloadFeedback.state === 'downloading' && (
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[#60A5FA]" />
              )}
              <span className="leading-relaxed">{downloadFeedback.message}</span>
            </div>
          )}

          {/* OS Segmented Selector */}
          <div className="mt-4 flex flex-wrap gap-1.5 rounded-md border border-[#222936] bg-[#090B0E] p-1">
            {platformTabs.map((tab) => {
              const Icon = tab.icon;
              const active = selectedPlatform === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSelectedPlatform(tab.id)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-sm px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                    active ? 'bg-[#171C24] text-[#F1F5F9]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                  }`}
                >
                  <Icon className={`h-3.5 w-3.5 ${active ? 'text-[#3B82F6]' : 'text-[#64748B]'}`} />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* LINUX PLUG-AND-PLAY (.DEB NATIVO COM DPKG-DEB + UNIVERSAL .ZIP) */}
          {selectedPlatform === 'linux' && (
            <div className="mt-5 space-y-5">
              <div className="flex flex-col justify-between gap-4 rounded-md border border-[#222936] bg-[#090B0E] p-5 sm:flex-row sm:items-center">
                <div>
                  <h2 className="text-sm font-semibold text-[#F1F5F9]">Instalador Nativo Linux (.DEB · v1.1.1 — Zorin OS / Ubuntu / Debian)</h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
                    Empacotado com o <span className="font-mono text-[#CBD5E1]">dpkg-deb</span> oficial do Debian + <span className="font-mono text-[#CBD5E1]">md5sums</span> e baixado com validação de assinatura binária (evita corrupção por proxy). Compatível com Zorin Software, Central de Programas, GDebi, PipeWire/PulseAudio e X11/Wayland.
                  </p>
                  <p className="mt-2 text-[11px] text-[#64748B]">
                    dpkg-deb autêntico · Download binário validado · Menu GNOME/Zorin/KDE · Ponte Python 3 sem pip
                  </p>
                </div>
                <button
                  type="button"
                  disabled={downloadFeedback.state === 'downloading'}
                  onClick={() =>
                    downloadVerifiedPackage('linux-deb', linuxDebUrl, 'Continuum-Linux.deb', 'deb')
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-[#3B82F6] px-5 py-3 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  {downloadFeedback.activeKey === 'linux-deb' ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Baixar Instalador (.DEB)
                </button>
              </div>

              <div className="flex flex-col justify-between gap-4 rounded-md border border-[#222936] bg-[#0D1015] p-4 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F1F5F9]">
                    <Package className="h-3.5 w-3.5 text-[#60A5FA]" />
                    Pacote Universal Linux (.ZIP — Fedora, Arch, Manjaro, openSUSE)
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
                    Extraia a pasta e dê dois cliques em <span className="font-mono text-[#CBD5E1]">Instalar-Continuum.desktop</span> (ou clique direito → Permitir Iniciar). Registra o app no seu Menu e na Área de Trabalho com diálogo gráfico.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={downloadFeedback.state === 'downloading'}
                  onClick={() =>
                    downloadVerifiedPackage('linux-zip', linuxUrl, 'Continuum-Linux-Universal.zip', 'zip')
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-[#2E3748] bg-[#171C24] px-4 py-2.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  <Download className="h-3.5 w-3.5 text-[#60A5FA]" />
                  Baixar Universal (.ZIP)
                </button>
              </div>

              <div className="flex flex-col justify-between gap-3 rounded-md border border-[#222936] bg-[#0D1015] p-4 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F1F5F9]">
                    <GitBranch className="h-3.5 w-3.5 text-[#60A5FA]" />
                    Quer o executável Electron compilado (.DEB + .AppImage)?
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
                    Use a aba <strong className="font-medium text-[#CBD5E1]">Repositório CI</strong> para baixar o monorepo pronto para GitHub Actions que compila binários nativos independentes de navegador.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedPlatform('repo')}
                  className="rounded-md border border-[#2E3748] bg-[#171C24] px-3.5 py-2 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] whitespace-nowrap shrink-0"
                >
                  Abrir Repositório CI
                </button>
              </div>
            </div>
          )}

          {/* WINDOWS PLUG-AND-PLAY */}
          {selectedPlatform === 'windows' && (
            <div className="mt-5 space-y-5">
              <div className="flex flex-col justify-between gap-4 rounded-md border border-[#222936] bg-[#090B0E] p-5 sm:flex-row sm:items-center">
                <div>
                  <h2 className="text-sm font-semibold text-[#F1F5F9]">Continuum para Windows 10 e 11 · v1.1.1</h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
                    Instalador gráfico nativo (.VBS + Ponte .NET integrada) com ícone <span className="font-mono text-[#CBD5E1]">.ICO</span> próprio, cursor absoluto para toque Second Screen e log local (<span className="font-mono text-[#CBD5E1]">bridge.log</span>).
                  </p>
                  <p className="mt-2 text-[11px] text-[#64748B]">
                    Menu Iniciar · Atalho com ícone nativo · Bandeja com Log · Sem Node.js ou Python · Desinstalador incluso
                  </p>
                </div>
                <button
                  type="button"
                  disabled={downloadFeedback.state === 'downloading'}
                  onClick={() =>
                    downloadVerifiedPackage('windows', windowsUrl, 'Continuum-Windows.zip', 'zip')
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-[#3B82F6] px-5 py-3 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  {downloadFeedback.activeKey === 'windows' ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Baixar para Windows (.ZIP)
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  {
                    step: '01. Extraia o pacote',
                    desc: 'Clique com o botão direito em Continuum-Windows.zip e selecione Extrair Tudo.',
                  },
                  {
                    step: '02. Dois cliques no instalador',
                    desc: 'Abra "Instalar Continuum.vbs". Ele registra atalhos com ícone nativo sem abrir terminal.',
                  },
                  {
                    step: '03. Plug & Play na malha',
                    desc: `A janela dedicada abre acoplada à ponte Win32 na malha ${roomCode} (sem duplicar o PC no mapa).`,
                  },
                ].map((item) => (
                  <div key={item.step} className="rounded-md border border-[#222936] bg-[#0D1015] p-4">
                    <p className="text-xs font-semibold text-[#F1F5F9]">{item.step}</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-[#94A3B8]">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ANDROID PLUG-AND-PLAY + NATIVE KOTLIN APK PROJECT */}
          {selectedPlatform === 'android' && (
            <div className="mt-5 space-y-5">
              <div className="grid grid-cols-1 gap-4 rounded-md border border-[#222936] bg-[#090B0E] p-5 sm:grid-cols-[1fr_176px]">
                <div className="flex flex-col justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-[#F1F5F9]">Instalação Direta no Android (1 Toque)</h2>
                    <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
                      Instale o Continuum diretamente na gaveta de aplicativos do Android como um WebAPK nativo em tela cheia, com tela sempre ativa (Wake Lock) durante o Second Screen — zero terminal e zero configuração.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    {isInstalled && detectedOs === 'android' ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#16A34A]">
                        <CheckCircle2 className="h-4 w-4" />
                        Aplicativo já instalado neste Android
                      </span>
                    ) : isInstallable ? (
                      <button
                        type="button"
                        onClick={install}
                        className="inline-flex items-center gap-2 rounded-md bg-[#3B82F6] px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-[#2563EB]"
                      >
                        <Download className="h-4 w-4" />
                        Instalar App Android Agora
                      </button>
                    ) : (
                      <p className="text-xs text-[#60A5FA]">
                        Aponte a câmera do seu celular ou tablet Android para o QR Code ao lado e toque em Instalar App.
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-col items-center justify-center rounded-md border border-[#222936] bg-[#11151B] p-2.5">
                  {mobileQrUrl ? (
                    <img
                      src={mobileQrUrl}
                      alt="QR Code de instalação direta no Android"
                      className="h-36 w-36 rounded-xs"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="flex h-36 w-36 items-center justify-center text-[11px] text-[#64748B]">
                      Gerando QR...
                    </div>
                  )}
                  <span className="mt-1.5 font-mono text-[10px] text-[#94A3B8]">Malha {roomCode}</span>
                </div>
              </div>

              <div className="flex flex-col justify-between gap-4 rounded-md border border-[#222936] bg-[#0D1015] p-4 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F1F5F9]">
                    <Package className="h-3.5 w-3.5 text-[#60A5FA]" />
                    Pacote Nativo Android Kotlin (Geração de .APK)
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
                    Projeto Android completo em Kotlin (<span className="font-mono text-[#CBD5E1]">MainActivity.kt</span>) pronto para compilar o <span className="font-mono text-[#CBD5E1]">.apk</span> no Android Studio ou automaticamente via <strong className="font-medium text-[#CBD5E1]">Repositório CI</strong>.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={downloadFeedback.state === 'downloading'}
                  onClick={() =>
                    downloadVerifiedPackage('android', androidNativeUrl, 'Continuum-Android-Native.zip', 'zip')
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-[#2E3748] bg-[#171C24] px-4 py-2.5 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  <Download className="h-3.5 w-3.5 text-[#60A5FA]" />
                  Baixar Projeto Kotlin (.ZIP)
                </button>
              </div>
            </div>
          )}

          {/* IOS PLUG-AND-PLAY */}
          {selectedPlatform === 'ios' && (
            <div className="mt-5 grid grid-cols-1 gap-4 rounded-md border border-[#222936] bg-[#090B0E] p-5 sm:grid-cols-[1fr_176px]">
              <div className="space-y-3">
                <h2 className="text-sm font-semibold text-[#F1F5F9]">Continuum para iPhone e iPad (iOS / iPadOS)</h2>
                <p className="text-xs leading-relaxed text-[#94A3B8]">
                  No iOS, o Continuum instala-se em modo tela cheia nativo diretamente pelo Safari sem precisar de App Store ou cabo USB.
                </p>
                <ol className="space-y-1.5 text-xs text-[#CBD5E1]">
                  <li>1. Escaneie o QR Code ao lado com a câmera do iPhone ou iPad (ou use o Safari).</li>
                  <li>2. Toque no ícone Compartilhar na barra inferior do Safari.</li>
                  <li>3. Escolha Adicionar à Tela de Início para abrir sempre em tela cheia já pareado à malha {roomCode}.</li>
                </ol>
                {isIOS && isInstalled && (
                  <p className="inline-flex items-center gap-1.5 text-xs font-medium text-[#16A34A]">
                    <CheckCircle2 className="h-4 w-4" />
                    Já rodando como aplicativo instalado no iOS
                  </p>
                )}
              </div>

              <div className="flex flex-col items-center justify-center rounded-md border border-[#222936] bg-[#11151B] p-2.5">
                {mobileQrUrl ? (
                  <img
                    src={mobileQrUrl}
                    alt="QR Code de instalação no iPhone ou iPad"
                    className="h-36 w-36 rounded-xs"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="flex h-36 w-36 items-center justify-center text-[11px] text-[#64748B]">
                    Gerando QR...
                  </div>
                )}
                <span className="mt-1.5 font-mono text-[10px] text-[#94A3B8]">Malha {roomCode}</span>
              </div>
            </div>
          )}

          {/* NATIVE APPS BUILD REPOSITORY (GITHUB ACTIONS CI/CD + RELEASES) */}
          {selectedPlatform === 'repo' && (
            <div className="mt-5 space-y-5">
              <div className="flex flex-col justify-between gap-4 rounded-md border border-[#222936] bg-[#090B0E] p-5 sm:flex-row sm:items-center">
                <div>
                  <h2 className="text-sm font-semibold text-[#F1F5F9]">
                    Repositório de Compilação Nativa (GitHub Actions · v1.2.0)
                  </h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
                    Monorepo completo já configurado com Electron Desktop (Linux + Windows), Android Kotlin e pipeline automático do GitHub Actions. Ao enviar para o GitHub, os servidores na nuvem compilam e publicam em <strong className="font-medium text-[#CBD5E1]">Releases</strong>:
                  </p>
                  <p className="mt-2 font-mono text-[11px] text-[#60A5FA]">
                    Continuum-Linux-amd64.deb · .AppImage · Windows-Setup.exe · Continuum-Android.apk
                  </p>
                </div>
                <button
                  type="button"
                  disabled={downloadFeedback.state === 'downloading'}
                  onClick={() =>
                    downloadVerifiedPackage('native-repo', nativeRepoUrl, 'Continuum-Native-Repo.zip', 'zip')
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-[#3B82F6] px-5 py-3 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  {downloadFeedback.activeKey === 'native-repo' ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Baixar Repositório (.ZIP)
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  {
                    step: '01. Crie o repo no GitHub',
                    desc: 'Extraia Continuum-Native-Repo.zip e envie os arquivos para um repositório no seu GitHub.',
                  },
                  {
                    step: '02. Compilação automática',
                    desc: 'O workflow build-native-apps.yml compila Linux (.deb/.AppImage), Windows (.exe) e Android (.apk) na nuvem.',
                  },
                  {
                    step: '03. Baixe direto das Releases',
                    desc: 'Conecte o nome do repositório abaixo para baixar os binários compilados direto por esta tela.',
                  },
                ].map((item) => (
                  <div key={item.step} className="rounded-md border border-[#222936] bg-[#0D1015] p-4">
                    <p className="text-xs font-semibold text-[#F1F5F9]">{item.step}</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-[#94A3B8]">{item.desc}</p>
                  </div>
                ))}
              </div>

              {/* Connect GitHub Releases Directly */}
              <div className="rounded-md border border-[#222936] bg-[#0D1015] p-4">
                <p className="text-xs font-semibold text-[#F1F5F9]">
                  Conectar Releases compiladas do seu GitHub
                </p>
                <p className="mt-1 text-xs text-[#94A3B8]">
                  Após publicar no GitHub, informe <span className="font-mono text-[#CBD5E1]">usuario/repositorio</span> para listar e baixar diretamente os instaladores compilados (.deb, .AppImage, .exe e .apk).
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    fetchGitHubReleases(githubRepoDraft);
                  }}
                  className="mt-3 flex flex-col gap-2 sm:flex-row"
                >
                  <input
                    type="text"
                    value={githubRepoDraft}
                    onChange={(e) => setGithubRepoDraft(e.target.value)}
                    placeholder="ex: seu-usuario/continuum-native"
                    className="h-9 flex-1 rounded-md border border-[#222936] bg-[#090B0E] px-3 font-mono text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-[#3B82F6] focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={releaseState.loading}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[#2E3748] bg-[#171C24] px-4 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-[#3B82F6] disabled:opacity-50 whitespace-nowrap"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${releaseState.loading ? 'animate-spin' : ''}`} />
                    Buscar Releases
                  </button>
                </form>

                {releaseState.error && (
                  <p className="mt-2.5 flex items-start gap-1.5 text-xs text-[#D97706]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{releaseState.error}</span>
                  </p>
                )}

                {releaseState.assets.length > 0 && (
                  <div className="mt-3.5 border-t border-[#222936] pt-3">
                    <div className="flex items-center justify-between text-[11px] text-[#94A3B8]">
                      <span>
                        Release <strong className="font-mono text-[#F1F5F9]">{releaseState.tagName}</strong>
                      </span>
                      {releaseState.htmlUrl && (
                        <a
                          href={releaseState.htmlUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[#60A5FA] hover:underline"
                        >
                          Ver no GitHub
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <ul className="mt-2 divide-y divide-[#222936]">
                      {releaseState.assets.map((asset) => (
                        <li key={asset.name} className="flex items-center justify-between gap-3 py-2 text-xs">
                          <div className="min-w-0">
                            <p className="truncate font-mono text-[#F1F5F9]">{asset.name}</p>
                            <p className="font-mono text-[11px] text-[#64748B] tabular-nums">
                              {formatBytes(asset.size)}
                            </p>
                          </div>
                          <a
                            href={asset.browser_download_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] whitespace-nowrap shrink-0"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Baixar
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Right Column: Live Connected Native Bridges & Package Summary */}
        <aside className="flex flex-col gap-5">
          <div className="rounded-lg border border-[#222936] bg-[#11151B] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#F1F5F9]">Pontes Nativas Acopladas</h2>
              <span className="font-mono text-xs text-[#94A3B8] tabular-nums">
                {connectedCompanions.length} / {devices.length}
              </span>
            </div>

            {connectedCompanions.length === 0 ? (
              <div className="mt-4 flex flex-col items-center rounded-md border border-[#222936] bg-[#090B0E] px-4 py-7 text-center">
                <Cpu className="h-6 w-6 text-[#334155]" />
                <p className="mt-2 text-xs font-medium text-[#CBD5E1]">Aguardando aplicativo nativo</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[#64748B]">
                  Ao instalar o pacote no Windows ou Linux, a ponte nativa acopla automaticamente ao nó do PC sem criar dispositivos duplicados.
                </p>
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-[#222936]">
                {connectedCompanions.map((dev) => (
                  <li key={dev.id} className="flex items-center justify-between gap-3 py-3 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-[#F1F5F9]">{dev.name}</p>
                      <p className="mt-0.5 text-[11px] text-[#94A3B8]">
                        {formatOsLabel(dev.os)} · {formatDisplayServer(dev.telemetry.displayServer)} ·{' '}
                        <span className="font-mono tabular-nums">
                          {dev.telemetry.cpuUsage !== null ? `CPU ${dev.telemetry.cpuUsage}%` : 'Online'}
                        </span>
                      </p>
                      {dev.telemetry.companionLastSeenAt && (
                        <p className="mt-0.5 font-mono text-[10px] text-[#64748B] tabular-nums">
                          Sinal {formatAgo(dev.telemetry.companionLastSeenAt)}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleTriggerBridgeTest(dev.id)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#222936] bg-[#171C24] px-2.5 py-1.5 text-[11px] font-medium text-[#CBD5E1] transition-colors hover:border-[#3B82F6] hover:text-[#F1F5F9] whitespace-nowrap shrink-0"
                    >
                      <BellRing className="h-3 w-3 text-[#60A5FA]" />
                      {testedDeviceId === dev.id ? 'Enviado' : 'Testar Ponte'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-[#222936] bg-[#11151B] p-5">
            <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#F1F5F9]">
              <Sparkles className="h-3.5 w-3.5 text-[#60A5FA]" />
              O que cada formato entrega
            </h2>
            <div className="mt-3 divide-y divide-[#222936] text-xs">
              {[
                {
                  os: 'Linux (.DEB instantâneo)',
                  detail: 'Gerado com dpkg-deb real + md5sums + validação binária no download para Zorin OS, Ubuntu e Mint',
                },
                {
                  os: 'Windows (.ZIP instantâneo)',
                  detail: 'Instalador gráfico .VBS, ícone .ICO, bandeja com log e controle nativo Win32 sem Node.js',
                },
                {
                  os: 'Android / iOS (1 toque)',
                  detail: 'Instalação direta via QR Code com Wake Lock + projeto Kotlin para geração de .APK',
                },
                {
                  os: 'Repositório CI (Compilado)',
                  detail: 'Compila binários Electron (.deb, .AppImage, .exe) e Android (.apk) automaticamente no GitHub Actions',
                },
              ].map((row) => (
                <div key={row.os} className="py-2.5">
                  <p className="font-medium text-[#F1F5F9]">{row.os}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-[#94A3B8]">{row.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {/* Integrated Connection & Native Bridge Diagnostics Panel */}
      <section className="overflow-hidden rounded-lg border border-[#222936] bg-[#11151B]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#222936] px-6 py-4">
          <div>
            <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-[#F1F5F9]">
              <Activity className="h-4 w-4 text-[#60A5FA]" />
              Painel de Diagnóstico da Conexão
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Testa em tempo real o servidor HTTP, a latência da malha WebSocket, a coleta ICE/STUN do Second Screen e o acoplamento das pontes nativas.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {diagReport.ranAt && (
              <span className="font-mono text-[11px] text-[#64748B] tabular-nums">
                Último teste:{' '}
                {new Date(diagReport.ranAt).toLocaleTimeString('pt-BR', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
            )}
            <button
              type="button"
              onClick={runDiagnostics}
              disabled={diagRunning}
              className="inline-flex items-center gap-2 rounded-md bg-[#3B82F6] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${diagRunning ? 'animate-spin' : ''}`} />
              {diagRunning ? 'Executando...' : 'Executar Diagnóstico Completo'}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[#222936] bg-[#0D1015] text-[#94A3B8]">
                <th className="w-48 px-6 py-2.5 font-medium">Camada</th>
                <th className="w-36 px-4 py-2.5 font-medium">Status</th>
                <th className="w-52 px-4 py-2.5 font-medium">Medição Real</th>
                <th className="px-6 py-2.5 font-medium">Diagnóstico Técnico</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#222936]">
              {[
                { label: 'Servidor HTTP / API', item: diagReport.http },
                { label: 'Malha WebSocket (/ws)', item: diagReport.ws },
                { label: 'WebRTC / STUN (P2P)', item: diagReport.webrtc },
                { label: 'Ponte Nativa do SO', item: diagReport.bridge },
              ].map((row) => (
                <tr key={row.label} className="hover:bg-[#171C24]/50">
                  <td className="px-6 py-3 font-medium text-[#F1F5F9] whitespace-nowrap">{row.label}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{renderStatusBadge(row.item.status)}</td>
                  <td className="px-4 py-3 font-mono text-[#CBD5E1] tabular-nums whitespace-nowrap">
                    {row.item.metric}
                  </td>
                  <td className="px-6 py-3 leading-relaxed text-[#94A3B8]">{row.item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
