import fs from 'node:fs';
import path from 'node:path';
import { buildZipBuffer, type ZipEntryInput } from './zipBuilder.ts';
import {
  buildIcoFromPng,
  readPublicAsset,
  type InstallerContext,
} from './platformInstallers.ts';
import {
  buildAndroidNativeProjectEntries,
  buildLinuxNativeAppPy,
  buildWindowsNativeCsproj,
  buildWindowsNativeProgramCs,
  buildWindowsNsisScript,
} from './nativeAppsSource.ts';

function safeStr(val: string): string {
  return val.replace(/[`'"\\$<>|;&\r\n]/g, '');
}

function buildLinuxDebScript(room: string, serverUrl: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/dist"
STAGE="$SCRIPT_DIR/.deb-stage"
rm -rf "$STAGE" "$OUT_DIR"
mkdir -p "$OUT_DIR" "$STAGE/DEBIAN" "$STAGE/usr/bin" "$STAGE/usr/share/continuum" "$STAGE/usr/share/applications" "$STAGE/usr/share/icons/hicolor/scalable/apps" "$STAGE/usr/share/icons/hicolor/512x512/apps"

cp "$SCRIPT_DIR/continuum_app.py" "$STAGE/usr/share/continuum/continuum_app.py"
chmod 755 "$STAGE/usr/share/continuum/continuum_app.py"

cat > "$STAGE/usr/bin/continuum" <<'EOF'
#!/usr/bin/env bash
exec python3 /usr/share/continuum/continuum_app.py "$@"
EOF
chmod 755 "$STAGE/usr/bin/continuum"

cat > "$STAGE/usr/share/applications/continuum.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Continuum
GenericName=Native Device Mesh
Comment=Aplicativo Nativo Linux GTK 3 para Malha de Dispositivos (Malha ${room})
Exec=/usr/bin/continuum
Icon=continuum
Terminal=false
Categories=Network;Utility;System;
StartupWMClass=continuum_app.py
EOF
chmod 644 "$STAGE/usr/share/applications/continuum.desktop"

if [ -f "$SCRIPT_DIR/assets/continuum.svg" ]; then
  cp "$SCRIPT_DIR/assets/continuum.svg" "$STAGE/usr/share/icons/hicolor/scalable/apps/continuum.svg"
  chmod 644 "$STAGE/usr/share/icons/hicolor/scalable/apps/continuum.svg"
fi
if [ -f "$SCRIPT_DIR/assets/continuum.png" ]; then
  cp "$SCRIPT_DIR/assets/continuum.png" "$STAGE/usr/share/icons/hicolor/512x512/apps/continuum.png"
  chmod 644 "$STAGE/usr/share/icons/hicolor/512x512/apps/continuum.png"
fi

INSTALLED_KB="$(du -sk "$STAGE/usr" | awk '{print $1}')"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: continuum-mesh
Version: 2.0.0
Section: utils
Priority: optional
Architecture: all
Installed-Size: \${INSTALLED_KB}
Depends: python3, python3-gi, gir1.2-gtk-3.0
Recommends: xdotool, wmctrl, pulseaudio-utils | wireplumber, playerctl, libnotify-bin
Maintainer: Continuum <support@continuum.local>
Homepage: ${serverUrl}
Description: Continuum - Aplicativo Nativo Linux (GTK 3)
 Aplicativo desktop nativo em GTK 3 (sem navegador e sem WebView) para malha
 de dispositivos em tempo real, trackpad/teclado remoto, clipboard universal,
 transferencia de arquivos e controle nativo do sistema operacional.
EOF
chmod 644 "$STAGE/DEBIAN/control"

cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postinst"

cat > "$STAGE/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
pkill -f "/usr/share/continuum/continuum_app.py" >/dev/null 2>&1 || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postrm"

(cd "$STAGE" && find usr -type f -exec md5sum {} + > DEBIAN/md5sums)
chmod 644 "$STAGE/DEBIAN/md5sums"

dpkg-deb --root-owner-group -Zgzip --build "$STAGE" "$OUT_DIR/Continuum-Linux-amd64.deb"
tar -czf "$OUT_DIR/Continuum-Linux-Portable.tar.gz" -C "$SCRIPT_DIR" continuum_app.py assets
rm -rf "$STAGE"
ls -lh "$OUT_DIR"
`;
}

/**
 * Generates all files for the 100% True Native Apps Compilation Repository
 * (ZERO WebView, ZERO Electron, ZERO Browser Wrappers):
 *  - native-apps/linux/   -> Native GTK 3 Linux App (.deb + .tar.gz)
 *  - native-apps/windows/ -> Native C# .NET 8 WinForms/Win32 App (Continuum-Windows.exe + Setup.exe)
 *  - native-apps/android/ -> Native Kotlin + OkHttp + Multi-Touch Trackpad App (Continuum-Android.apk)
 *  - .github/workflows/build-native-apps.yml -> Automated multi-OS GitHub Actions + Releases
 */
export function buildNativeRepoEntries(ctx: InstallerContext): ZipEntryInput[] {
  const room = safeStr(ctx.roomCode);
  const serverUrl = safeStr(ctx.appUrl).replace(/\/+$/, '');

  const readmeMd = `# Continuum — Aplicativos 100% Nativos (Linux, Windows e Android)

Este repositório compila **aplicativos nativos reais** para cada sistema operacional — **sem WebView, sem Electron e sem abrir navegador** — utilizando **GitHub Actions** e publicando todos os instaladores automaticamente em **Releases**:

| Plataforma | Tecnologia Nativa Real | Artefatos Compilados (Releases) |
| --- | --- | --- |
| **Linux (Zorin OS, Ubuntu, Mint, Debian, Fedora, Arch)** | **GTK 3 nativo** + Python 3 stdlib + X11/PipeWire | \`Continuum-Linux-amd64.deb\` + \`Continuum-Linux-Portable.tar.gz\` |
| **Windows 10 / 11** | **C# .NET 8 WinForms + Win32 P/Invoke** | \`Continuum-Windows.exe\` (standalone) + \`Continuum-Windows-Setup.exe\` |
| **Android (Celular e Tablet)** | **Kotlin nativo + Material + OkHttp WebSocket + Trackpad Multi-Toque** | \`Continuum-Android.apk\` |

## Compilação Automática no GitHub

Sempre que você sincronizar ou fizer \`push\` no branch \`main\`, o workflow \`.github/workflows/build-native-apps.yml\` compila os 3 sistemas operacionais em paralelo na nuvem e publica os executáveis finais em **Releases** com \`SHA256SUMS.txt\`.

> **Dica:** Para gerar uma nova build já apontando para outra URL de servidor ou outro código de malha, abra **Actions → Build Continuum Native Apps → Run workflow** e informe \`server_url\` e \`room_code\`. Todos os 3 apps também permitem alterar servidor e malha diretamente dentro da interface nativa sem precisar recompilar.

- **Servidor padrão:** \`${serverUrl}\`
- **Malha padrão:** \`${room}\`
`;

  const workflowYml = `name: Build Continuum Native Apps

on:
  push:
    branches: [ main, master ]
    tags: [ 'v*' ]
  workflow_dispatch:
    inputs:
      server_url:
        description: 'URL publica do servidor Continuum (ex: https://ais-pre-...run.app)'
        required: false
        default: '${serverUrl}'
      room_code:
        description: 'Codigo da malha inicial (ex: ${room})'
        required: false
        default: '${room}'

permissions:
  contents: write

jobs:
  build-linux:
    name: Linux Native GTK3 (.deb + .tar.gz)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Apply optional workflow_dispatch config
        working-directory: native-apps/linux
        env:
          INPUT_SERVER: \${{ inputs.server_url }}
          INPUT_ROOM: \${{ inputs.room_code }}
        run: |
          python3 - <<'PY'
          import os, re
          p = "continuum_app.py"
          src = open(p, encoding="utf-8").read()
          srv = (os.environ.get("INPUT_SERVER") or "").strip().rstrip("/")
          room = re.sub(r"[^A-Z0-9]", "", (os.environ.get("INPUT_ROOM") or "").upper())[:8]
          if srv.startswith(("http://", "https://")):
              ws = ("wss://" if srv.startswith("https://") else "ws://") + srv.split("://", 1)[1] + "/ws"
              src = re.sub(r'DEFAULT_SERVER_URL = ".*?"', f'DEFAULT_SERVER_URL = "{srv}"', src, count=1)
              src = re.sub(r'DEFAULT_WS_URL = ".*?"', f'DEFAULT_WS_URL = "{ws}"', src, count=1)
          if len(room) >= 4:
              src = re.sub(r'DEFAULT_ROOM_CODE = ".*?"', f'DEFAULT_ROOM_CODE = "{room}"', src, count=1)
          open(p, "w", encoding="utf-8").write(src)
          PY
          python3 -m py_compile continuum_app.py

      - name: Build native Linux .deb and portable archive
        working-directory: native-apps/linux
        run: |
          chmod +x build-deb.sh continuum_app.py
          ./build-deb.sh
          dpkg-deb --info dist/Continuum-Linux-amd64.deb

      - uses: actions/upload-artifact@v4
        with:
          name: continuum-linux-native
          path: native-apps/linux/dist/*

  build-windows:
    name: Windows Native C# .NET 8 (.exe + Setup.exe)
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '8.0.x'

      - name: Apply optional workflow_dispatch config
        working-directory: native-apps/windows
        shell: pwsh
        env:
          INPUT_SERVER: \${{ inputs.server_url }}
          INPUT_ROOM: \${{ inputs.room_code }}
        run: |
          $code = Get-Content -Raw -Encoding UTF8 Program.cs
          if ($env:INPUT_SERVER -and $env:INPUT_SERVER.StartsWith("http")) {
            $srv = $env:INPUT_SERVER.Trim().TrimEnd("/")
            $code = [regex]::Replace($code, 'ServerUrl \{ get; set; \} = ".*?";', "ServerUrl { get; set; } = \`"$srv\`";")
          }
          if ($env:INPUT_ROOM -and $env:INPUT_ROOM.Length -ge 4) {
            $rm = ($env:INPUT_ROOM.ToUpper() -replace '[^A-Z0-9]', '')
            if ($rm.Length -gt 8) { $rm = $rm.Substring(0, 8) }
            $code = [regex]::Replace($code, 'RoomCode \{ get; set; \} = ".*?";', "RoomCode { get; set; } = \`"$rm\`";")
          }
          Set-Content -Path Program.cs -Value $code -Encoding UTF8

      - name: Publish single-file native Windows executable
        working-directory: native-apps/windows
        run: dotnet publish Continuum.Windows.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o publish

      - name: Build NSIS Windows Installer
        working-directory: native-apps/windows
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Force -Path dist | Out-Null
          Copy-Item publish\\Continuum.exe dist\\Continuum-Windows.exe
          if (Get-Command makensis -ErrorAction SilentlyContinue) {
            makensis installer.nsi
            Move-Item -Force Continuum-Windows-Setup.exe dist\\Continuum-Windows-Setup.exe
          }
          Get-ChildItem dist

      - uses: actions/upload-artifact@v4
        with:
          name: continuum-windows-native
          path: native-apps/windows/dist/*

  build-android:
    name: Android Native Kotlin (.apk)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17

      - uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: 8.7

      - name: Compile 100% Native Android APK (Zero WebView)
        working-directory: native-apps/android
        env:
          INPUT_SERVER: \${{ inputs.server_url }}
          INPUT_ROOM: \${{ inputs.room_code }}
        run: |
          EXTRA_ARGS=""
          if [ -n "$INPUT_SERVER" ]; then
            EXTRA_ARGS="$EXTRA_ARGS -PcontinuumUrl=$INPUT_SERVER"
          fi
          if [ -n "$INPUT_ROOM" ]; then
            EXTRA_ARGS="$EXTRA_ARGS -ProomCode=$INPUT_ROOM"
          fi
          gradle assembleDebug $EXTRA_ARGS --no-daemon
          mkdir -p dist
          cp app/build/outputs/apk/debug/app-debug.apk dist/Continuum-Android.apk
          ls -lh dist/

      - uses: actions/upload-artifact@v4
        with:
          name: continuum-android-native
          path: native-apps/android/dist/Continuum-Android.apk

  publish-release:
    name: Publish Native Apps Release
    needs: [ build-linux, build-windows, build-android ]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: release-assets
          merge-multiple: true

      - name: Generate SHA256SUMS
        working-directory: release-assets
        run: |
          sha256sum * > SHA256SUMS.txt
          cat SHA256SUMS.txt

      - name: Publish GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: \${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || 'latest-native' }}
          name: Continuum Native Apps v2.0 (\${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || 'Build Recente' }})
          make_latest: true
          body: |
            ## Aplicativos 100% Nativos Compilados — Continuum (Sem WebApp / Sem WebView)

            - **Linux (Zorin OS, Ubuntu, Mint, Debian, Pop!_OS — GTK 3):** \`Continuum-Linux-amd64.deb\`
            - **Linux Portátil (Fedora, Arch, Manjaro — GTK 3):** \`Continuum-Linux-Portable.tar.gz\`
            - **Windows 10/11 (Instalador NSIS — C# .NET 8):** \`Continuum-Windows-Setup.exe\`
            - **Windows 10/11 (Executável Único — C# .NET 8):** \`Continuum-Windows.exe\`
            - **Android (Kotlin + OkHttp + Trackpad Nativo):** \`Continuum-Android.apk\`
          files: release-assets/*
`;

  const png512 = readPublicAsset('pwa-512x512.png');
  const png192 = readPublicAsset('pwa-192x192.png');
  const svg = readPublicAsset('icon.svg');

  const entries: ZipEntryInput[] = [
    { name: 'README.md', content: readmeMd },
    { name: '.github/workflows/build-native-apps.yml', content: workflowYml },
    // Linux 100% Native GTK 3 App
    { name: 'native-apps/linux/continuum_app.py', content: buildLinuxNativeAppPy(ctx), executable: true },
    { name: 'native-apps/linux/build-deb.sh', content: buildLinuxDebScript(room, serverUrl), executable: true },
    // Windows 100% Native C# .NET 8 WinForms + Win32 App
    { name: 'native-apps/windows/Continuum.Windows.csproj', content: buildWindowsNativeCsproj() },
    { name: 'native-apps/windows/Program.cs', content: buildWindowsNativeProgramCs(ctx) },
    { name: 'native-apps/windows/installer.nsi', content: buildWindowsNsisScript() },
    // Android 100% Native Kotlin + OkHttp + Multi-Touch Trackpad App (Zero WebView)
    ...buildAndroidNativeProjectEntries(ctx, png192, 'native-apps/android'),
  ];

  if (svg) {
    entries.push({ name: 'native-apps/linux/assets/continuum.svg', content: svg });
  }
  if (png512) {
    entries.push({ name: 'native-apps/linux/assets/continuum.png', content: png512 });
  }
  if (png192) {
    entries.push({ name: 'native-apps/windows/continuum.ico', content: buildIcoFromPng(png192) });
  }

  return entries;
}

export function buildNativeRepoZip(ctx: InstallerContext): Buffer {
  const entries = buildNativeRepoEntries(ctx).map((entry) => ({
    ...entry,
    name: `continuum-native-apps/${entry.name}`,
  }));
  return buildZipBuffer(entries);
}

/**
 * Materializes the GitHub Actions workflow (.github/workflows/build-native-apps.yml)
 * and native-apps/{linux,windows,android} directly into the workspace root so syncing
 * this project to GitHub automatically compiles all 3 native OS applications!
 */
export function materializeWorkspaceNativeApps(workspaceRoot: string, ctx: InstallerContext): number {
  const entries = buildNativeRepoEntries(ctx).filter((e) => e.name !== 'README.md');
  for (const entry of entries) {
    const dest = path.join(workspaceRoot, entry.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    fs.writeFileSync(dest, data);
    if (entry.executable) {
      fs.chmodSync(dest, 0o755);
    }
  }
  return entries.length;
}
