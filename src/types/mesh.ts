export type PlatformOS = 'windows' | 'linux' | 'macos' | 'android' | 'ios' | 'unknown';
export type DeviceFormFactor = 'desktop' | 'laptop' | 'tablet' | 'mobile';
export type ScreenOrientationMode = 'landscape' | 'portrait';

export interface OpenAppItem {
  id: string;
  name: string;
  title: string;
  source: 'browser' | 'os-agent';
  focused: boolean;
}

export interface DeviceTelemetry {
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  cpuCores: number | null;
  cpuUsage: number | null;
  memoryTotalGb: number | null;
  memoryUsedGb: number | null;
  networkType: string | null;
  downlinkMbps: number | null;
  rttMs: number | null;
  volume: number;
  brightness: number;
  displayServer?: 'x11' | 'wayland' | 'win32' | 'web';
  companionLastSeenAt?: number | null;
  openApps: OpenAppItem[];
}

export interface DeviceNode {
  id: string;
  name: string;
  os: PlatformOS;
  formFactor: DeviceFormFactor;
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
  orientation: ScreenOrientationMode;
  x: number;
  y: number;
  isPrimary: boolean;
  edgeFlowEnabled: boolean;
  companionConnected: boolean;
  online: boolean;
  connectedAt: number;
  lastSeenAt: number;
  telemetry: DeviceTelemetry;
}

export interface ClipboardItem {
  id: string;
  content: string;
  kind: 'text' | 'url' | 'code';
  sourceDeviceId: string;
  sourceDeviceName: string;
  createdAt: number;
}

export interface MeshNotification {
  id: string;
  title: string;
  body: string;
  app: string;
  severity: 'info' | 'warning' | 'alert';
  sourceDeviceId: string;
  sourceDeviceName: string;
  createdAt: number;
  read: boolean;
}

export interface FileTransferRecord {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  fromDeviceId: string;
  fromDeviceName: string;
  toDeviceId: string | 'all';
  toDeviceName: string;
  status: 'transferring' | 'completed' | 'failed';
  progress: number;
  speedMbps: number;
  createdAt: number;
  downloadUrl?: string;
}

export interface ScreenSessionMeta {
  id: string;
  hostDeviceId: string;
  hostDeviceName: string;
  receiverDeviceId: string;
  receiverDeviceName: string;
  mode: 'extend' | 'mirror';
  resolution: '720p' | '1080p' | 'native';
  fps: 30 | 60;
  status: 'negotiating' | 'active';
  startedAt: number;
}

export type RemoteCommandAction =
  | 'vol_up'
  | 'vol_down'
  | 'vol_mute'
  | 'brightness_up'
  | 'brightness_down'
  | 'media_play_pause'
  | 'media_next'
  | 'media_prev'
  | 'lock'
  | 'ping'
  | 'open_url';

export type RemoteInputPayload =
  | { kind: 'move'; nx: number; ny: number; dx?: number; dy?: number }
  | { kind: 'click'; button: 'left' | 'right' | 'middle'; nx?: number; ny?: number; double?: boolean }
  | { kind: 'scroll'; dx: number; dy: number }
  | {
      kind: 'key';
      key: string;
      code?: string;
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
      meta?: boolean;
    }
  | { kind: 'text'; text: string }
  | { kind: 'command'; action: RemoteCommandAction; payload?: string };

export interface MeshStateSnapshot {
  roomCode: string;
  devices: DeviceNode[];
  clipboard: ClipboardItem[];
  notifications: MeshNotification[];
  transfers: FileTransferRecord[];
  screenSessions: ScreenSessionMeta[];
}

export type WorkspaceSection =
  | 'map'
  | 'second-screen'
  | 'remote'
  | 'files'
  | 'system'
  | 'companion';
