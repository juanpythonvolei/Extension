import type { DeviceFormFactor, DeviceNode, DeviceTelemetry, PlatformOS } from '../types/mesh';

interface BatteryManagerLike {
  level: number;
  charging: boolean;
}

interface NetworkInfoLike {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

export function detectPlatformOS(): PlatformOS {
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || '').toLowerCase();

  if (/iphone|ipad|ipod/.test(ua) || (platform === 'macintel' && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }
  if (/android/.test(ua)) {
    return 'android';
  }
  if (/win/.test(platform) || /windows/.test(ua)) {
    return 'windows';
  }
  if (/linux/.test(platform) || /linux|x11/.test(ua)) {
    return 'linux';
  }
  if (/mac/.test(platform) || /macintosh/.test(ua)) {
    return 'macos';
  }
  return 'unknown';
}

export function detectFormFactor(os: PlatformOS): DeviceFormFactor {
  const minDim = Math.min(window.screen.width, window.screen.height);
  const maxDim = Math.max(window.screen.width, window.screen.height);
  const hasTouch = navigator.maxTouchPoints > 0;

  if (os === 'android' || os === 'ios') {
    if (minDim >= 600 || /ipad|tablet/i.test(navigator.userAgent)) {
      return 'tablet';
    }
    return 'mobile';
  }
  if (hasTouch && maxDim <= 1366) {
    return 'tablet';
  }
  if (maxDim <= 1600) {
    return 'laptop';
  }
  return 'desktop';
}

export function getDefaultDeviceName(os: PlatformOS, formFactor: DeviceFormFactor): string {
  const osLabels: Record<PlatformOS, string> = {
    windows: 'Windows',
    linux: 'Linux',
    macos: 'macOS',
    android: 'Android',
    ios: 'iOS',
    unknown: 'Estação',
  };
  const formLabels: Record<DeviceFormFactor, string> = {
    desktop: 'Workstation',
    laptop: 'Notebook',
    tablet: 'Tablet',
    mobile: 'Smartphone',
  };
  return `${formLabels[formFactor]} ${osLabels[os]}`;
}

export function getOrCreateTabDeviceId(): string {
  const key = 'continuum_tab_device_id';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const generated = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem(key, generated);
    return generated;
  } catch {
    return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }
}

export function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function getInitialRoomCode(): string {
  const params = new URLSearchParams(window.location.search);
  const urlRoom = params.get('room')?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (urlRoom && urlRoom.length >= 4) {
    try {
      localStorage.setItem('continuum_last_room', urlRoom);
    } catch {
      // ignore storage errors
    }
    return urlRoom;
  }
  try {
    const stored = localStorage.getItem('continuum_last_room');
    if (stored && stored.length >= 4) return stored;
    const created = generateRoomCode();
    localStorage.setItem('continuum_last_room', created);
    return created;
  } catch {
    return generateRoomCode();
  }
}

export async function collectRealTelemetry(rttMs: number | null, prev?: DeviceTelemetry): Promise<DeviceTelemetry> {
  let batteryLevel: number | null = prev?.batteryLevel ?? null;
  let batteryCharging: boolean | null = prev?.batteryCharging ?? null;

  const nativeAndroid = (
    window as unknown as {
      ContinuumAndroid?: { getBatteryPercent?: () => number; getDeviceModel?: () => string };
    }
  ).ContinuumAndroid;

  if (nativeAndroid && typeof nativeAndroid.getBatteryPercent === 'function') {
    try {
      const pct = nativeAndroid.getBatteryPercent();
      if (typeof pct === 'number' && pct >= 0 && pct <= 100) {
        batteryLevel = pct;
      }
    } catch {
      // ignore bridge error
    }
  } else {
    try {
      const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
      if (typeof nav.getBattery === 'function') {
        const bat = await nav.getBattery();
        batteryLevel = Math.round(bat.level * 100);
        batteryCharging = Boolean(bat.charging);
      }
    } catch {
      // Battery API unavailable on this browser
    }
  }

  const navExt = navigator as Navigator & {
    deviceMemory?: number;
    connection?: NetworkInfoLike;
  };

  const cpuCores = typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null;
  const memoryTotalGb = typeof navExt.deviceMemory === 'number' ? navExt.deviceMemory : prev?.memoryTotalGb ?? null;
  const networkType = navExt.connection?.effectiveType ?? null;
  const downlinkMbps = typeof navExt.connection?.downlink === 'number' ? navExt.connection.downlink : null;

  const browserAppTitle = document.title || 'Continuum Hub';
  const existingOsApps = (prev?.openApps ?? []).filter((a) => a.source === 'os-agent');

  return {
    batteryLevel,
    batteryCharging,
    cpuCores,
    cpuUsage: prev?.cpuUsage ?? null,
    memoryTotalGb,
    memoryUsedGb: prev?.memoryUsedGb ?? null,
    networkType,
    downlinkMbps,
    rttMs: rttMs ?? prev?.rttMs ?? null,
    volume: prev?.volume ?? 72,
    brightness: prev?.brightness ?? 85,
    openApps: [
      ...existingOsApps,
      {
        id: 'browser-continuum',
        name: 'Continuum',
        title: browserAppTitle,
        source: 'browser',
        focused: document.visibilityState === 'visible',
      },
    ],
  };
}

export async function buildLocalDevicePayload(
  deviceId: string,
  customName: string | null,
  rttMs: number | null
): Promise<Partial<DeviceNode>> {
  const os = detectPlatformOS();
  const formFactor = detectFormFactor(os);
  const w = window.screen.width || window.innerWidth || 1920;
  const h = window.screen.height || window.innerHeight || 1080;
  const telemetry = await collectRealTelemetry(rttMs);

  return {
    id: deviceId,
    name: customName || getDefaultDeviceName(os, formFactor),
    os,
    formFactor,
    screenWidth: w,
    screenHeight: h,
    pixelRatio: Number(window.devicePixelRatio?.toFixed(2)) || 1,
    orientation: w >= h ? 'landscape' : 'portrait',
    telemetry,
  };
}

export function playLocateChime(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const notes = [880, 1174.66, 1318.51];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.14);
      gain.gain.setValueAtTime(0.001, ctx.currentTime + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + idx * 0.14 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.14 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + idx * 0.14);
      osc.stop(ctx.currentTime + idx * 0.14 + 0.38);
    });
  } catch {
    // AudioContext blocked until user gesture
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatOsLabel(os: PlatformOS): string {
  switch (os) {
    case 'windows':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'macos':
      return 'macOS';
    case 'android':
      return 'Android';
    case 'ios':
      return 'iOS';
    default:
      return 'Web';
  }
}

export function formatFormFactorLabel(form: DeviceFormFactor): string {
  switch (form) {
    case 'desktop':
      return 'Desktop';
    case 'laptop':
      return 'Notebook';
    case 'tablet':
      return 'Tablet';
    case 'mobile':
      return 'Smartphone';
  }
}
