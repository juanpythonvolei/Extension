import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
Version: 5.1.0
Section: utils
Priority: optional
Architecture: all
Installed-Size: \${INSTALLED_KB}
Depends: python3, python3-gi, gir1.2-gtk-3.0
Recommends: xdotool, wmctrl, pulseaudio-utils | wireplumber, playerctl, libnotify-bin
Maintainer: Continuum <support@continuum.local>
Homepage: ${serverUrl}
Description: Continuum 5.1 - Aplicativo Nativo Linux (Extensao de Tela + KVM + Clipboard Auto)
 Aplicativo desktop nativo em GTK 3 + Cairo 60 FPS com 5 espacos de trabalho,
 Extensao de Monitor/Segunda Tela em tempo real via LAN, Mouse e Teclado Continuo (KVM),
 Area de Transferencia Universal Automatica e protocolo LAN Zero-Loop v5.1.
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

function buildLinuxAppImageScript(room: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/dist"
APPDIR="$SCRIPT_DIR/.Continuum.AppDir"
RUNTIME_BIN="$SCRIPT_DIR/.appimage-runtime-x86_64"
PAYLOAD_TGZ="$SCRIPT_DIR/.appdir-payload.tar.gz"

mkdir -p "$OUT_DIR"
rm -rf "$APPDIR" "$RUNTIME_BIN" "$PAYLOAD_TGZ"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/continuum" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/512x512/apps" "$APPDIR/usr/share/icons/hicolor/scalable/apps" "$APPDIR/usr/share/metainfo"

cp "$SCRIPT_DIR/continuum_app.py" "$APPDIR/usr/share/continuum/continuum_app.py"
chmod 755 "$APPDIR/usr/share/continuum/continuum_app.py"

cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
set -e
HERE="$(dirname "$(readlink -f "$0")")"
export APPDIR="\${APPDIR:-$HERE}"

PY=""
for cand in /usr/bin/python3 /usr/local/bin/python3 "$(command -v python3 2>/dev/null || true)"; do
  if [ -n "$cand" ] && [ -x "$cand" ] && "$cand" -c "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk" >/dev/null 2>&1; then
    PY="$cand"
    break
  fi
done

if [ -z "$PY" ]; then
  for cand in /usr/bin/python3 /usr/local/bin/python3 "$(command -v python3 2>/dev/null || true)"; do
    if [ -n "$cand" ] && [ -x "$cand" ] && "$cand" -c "import tkinter" >/dev/null 2>&1; then
      PY="$cand"
      break
    fi
  done
fi

if [ -z "$PY" ]; then
  PY="$(command -v python3 2>/dev/null || echo /usr/bin/python3)"
fi

exec "$PY" "$HERE/usr/share/continuum/continuum_app.py" "$@"
EOF
chmod 755 "$APPDIR/AppRun"
cp "$APPDIR/AppRun" "$APPDIR/usr/bin/continuum"

cat > "$APPDIR/continuum.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Continuum
GenericName=Native Device Mesh
Comment=Aplicativo Nativo Linux GTK 3 para Malha de Dispositivos (Malha ${room})
Exec=continuum
Icon=continuum
Terminal=false
Categories=Network;Utility;System;
StartupWMClass=continuum_app.py
X-AppImage-Version=5.1.0
EOF
chmod 644 "$APPDIR/continuum.desktop"
cp "$APPDIR/continuum.desktop" "$APPDIR/usr/share/applications/continuum.desktop"

cat > "$APPDIR/usr/share/metainfo/app.continuum.mesh.appdata.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>app.continuum.mesh</id>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>
  <name>Continuum</name>
  <summary>Aplicativo nativo GTK 3 para malha de dispositivos, trackpad remoto e clipboard universal</summary>
  <description>
    <p>Continuum conecta dispositivos Linux, Windows e Android em tempo real com aplicativo desktop nativo GTK 3, sem navegador e sem WebView.</p>
  </description>
  <launchable type="desktop-id">continuum.desktop</launchable>
</component>
EOF

if [ -f "$SCRIPT_DIR/assets/continuum.png" ]; then
  cp "$SCRIPT_DIR/assets/continuum.png" "$APPDIR/continuum.png"
  cp "$SCRIPT_DIR/assets/continuum.png" "$APPDIR/.DirIcon"
  cp "$SCRIPT_DIR/assets/continuum.png" "$APPDIR/usr/share/icons/hicolor/512x512/apps/continuum.png"
fi
if [ -f "$SCRIPT_DIR/assets/continuum.svg" ]; then
  cp "$SCRIPT_DIR/assets/continuum.svg" "$APPDIR/usr/share/icons/hicolor/scalable/apps/continuum.svg"
fi

# Compile Zero-FUSE static x86_64 ELF AppImage runtime (works on Zorin OS 16/17, Ubuntu 20-24, Fedora, Arch without libfuse2!)
gcc -O2 -Wall -Wextra -s -static "$SCRIPT_DIR/appimage_runtime.c" -o "$RUNTIME_BIN"
tar -czf "$PAYLOAD_TGZ" -C "$APPDIR" .

python3 - "$RUNTIME_BIN" "$PAYLOAD_TGZ" "$OUT_DIR/Continuum-Linux-x86_64.AppImage" <<'PY'
import struct, sys
runtime_path, payload_path, out_path = sys.argv[1:4]
runtime = open(runtime_path, "rb").read()
payload = open(payload_path, "rb").read()
footer = b"CONT_APPIMG_V1" + bytes(2) + struct.pack("<QQ", len(runtime), len(payload))
with open(out_path, "wb") as f:
    f.write(runtime)
    f.write(payload)
    f.write(footer)
PY

chmod +x "$OUT_DIR/Continuum-Linux-x86_64.AppImage"
rm -rf "$APPDIR" "$RUNTIME_BIN" "$PAYLOAD_TGZ"
ls -lh "$OUT_DIR/Continuum-Linux-x86_64.AppImage"
`;
}

/**
 * Generates all files for the 100% True Native Apps Compilation Repository
 * (ZERO WebView, ZERO Electron, ZERO Browser Wrappers):
 *  - native-apps/linux/   -> Native GTK 3 Linux App (.AppImage + .deb + .tar.gz)
 *  - native-apps/windows/ -> Native C# .NET 8 WinForms/Win32 App (Continuum-Windows.exe + Setup.exe)
 *  - native-apps/android/ -> Native Kotlin + OkHttp + Multi-Touch Trackpad App (Continuum-Android.apk)
 *  - .github/workflows/build-native-apps.yml -> Automated multi-OS GitHub Actions + Releases
 */
export function buildNativeRepoEntries(ctx: InstallerContext): ZipEntryInput[] {
  const room = safeStr(ctx.roomCode);
  const serverUrl = safeStr(ctx.appUrl).replace(/\/+$/, '');

  const readmeMd = `# Continuum v5.1 — Extensão de Tela, KVM Contínuo, Clipboard Automático & Malha Instantânea (Linux, Windows e Android)

Este repositório compila **aplicativos 100% nativos** — **sem WebView, sem Electron e sem depender do app web** — com interface **holográfica espaçosa em 5 áreas de trabalho** (incluindo barra lateral nativa para Tablets Android) e **protocolo direto LAN Zero-Loop v5.1**:

| Plataforma | Tecnologia Nativa Real | Artefatos Compilados (Releases) |
| --- | --- | --- |
| **Linux (Zorin OS, Ubuntu, Mint, Debian, Fedora, Arch)** | **GTK 3 + Cairo 60 FPS** + Extensão de Tela + KVM + Hub 45891 | \`Continuum-Linux-x86_64.AppImage\` (Zero-FUSE) + \`Continuum-Linux-amd64.deb\` + \`Continuum-Linux-Portable.tar.gz\` |
| **Windows 10 / 11** | **C# .NET 8 WinForms + GDI+ 60 FPS** + High-DPI + Extensão de Tela | \`Continuum-Windows.exe\` (standalone) + \`Continuum-Windows-Setup.exe\` |
| **Android (Celular e Tablet)** | **Kotlin + Canvas Holográfico + Segunda Tela + Hub Embutido** | \`Continuum-Android.apk\` |

## Novidades da v5.1 (Conexão Direta Instantânea + Sala Unificada no Hub LAN)

1. **Troca Instantânea de Conexão no Linux + Sala Unificada no Hub:** Encerramento imediato de socket via \`shutdown(SHUT_RDWR)\` ao clicar em **Conectar**, unificação automática da sala do Hub LAN (impedindo dispositivos conectados ao mesmo PC de ficarem isolados em salas diferentes) e eleição determinística Desktop-First com retorno automático ao Hub local.
2. **Extensão de Monitor / Segunda Tela Nativa:** Streaming direto de tela JPEG pela LAN (Linux GDK/grim, Windows GDI+ CopyFromScreen) para Android Tablet/Celular ou outro PC, com toque direto no cursor do PC e modo Tela Cheia.
3. **Teclado & Mouse Contínuo (KVM) + Área de Transferência Universal Automática:** Troca por borda de tela, trackpad holográfico com botões dedicados, atalhos (\`Alt+Tab\`, \`Ctrl+C/V\`, mídia) e sincronização automática bidirecional do Clipboard do sistema.

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
    name: Linux Native GTK3 (.AppImage + .deb + .tar.gz)
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

      - name: Build native Linux .deb, .AppImage and portable archive
        working-directory: native-apps/linux
        run: |
          chmod +x build-deb.sh build-appimage.sh continuum_app.py
          ./build-deb.sh
          ./build-appimage.sh
          dpkg-deb --info dist/Continuum-Linux-amd64.deb
          file dist/Continuum-Linux-x86_64.AppImage

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
          rm -rf app/src/main/java/app/continuum/mesh
          gradle assembleDebug $EXTRA_ARGS --no-daemon --stacktrace
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
          name: Continuum Native Apps v5.1 (\${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || 'Conexão Instantânea + Extensão de Tela + KVM' }})
          make_latest: true
          body: |
            ## Continuum v5.1 — Conexão Instantânea, Sala Unificada no Hub LAN, Extensão de Tela & KVM

            - **Conexão 1-Clique Instantânea e Mapa Sempre Sincronizado (v5.1):** Desbloqueio imediato de socket no Linux ao clicar em Conectar, unificação automática de sala no Hub LAN (PC e Tablet sempre aparecem juntos no Mapa Espacial), eleição determinística Desktop-First sem troca cruzada e barra de avisos dedicada no Linux.
            - **Extensão de Monitor / Segunda Tela Nativa:** Transmita qualquer monitor Linux ou Windows diretamente pela rede local para o Tablet/Celular Android ou outro PC com controle por toque direto e modo Tela Cheia.
            - **Mouse & Teclado Contínuo (KVM) + Clipboard Automático:** Borda de tela contínua, trackpad holográfico espaçoso com atalhos de sistema e área de transferência universal sincronizada automaticamente nos 3 sistemas.
            - **UI Lapidada em 5 Espaços de Trabalho:** Layout limpo, sem botões espremidos, com barra lateral responsiva em Tablets Android e High-DPI PerMonitorV2 no Windows.

            ### Artefatos Compilados
            - **Linux AppImage Universal Zero-FUSE (GTK 3 + Cairo 60 FPS):** \`Continuum-Linux-x86_64.AppImage\`
            - **Linux Instalador .DEB (Zorin OS, Ubuntu, Mint, Debian):** \`Continuum-Linux-amd64.deb\`
            - **Linux Portátil:** \`Continuum-Linux-Portable.tar.gz\`
            - **Windows 10/11 (Instalador NSIS — C# .NET 8 + GDI+ 60 FPS):** \`Continuum-Windows-Setup.exe\`
            - **Windows 10/11 (Executável Único — C# .NET 8 + GDI+ 60 FPS):** \`Continuum-Windows.exe\`
            - **Android (Kotlin + Segunda Tela + Barra Lateral Tablet + Hub LAN):** \`Continuum-Android.apk\`
          files: release-assets/*
`;

  const png512 = readPublicAsset('pwa-512x512.png');
  const png192 = readPublicAsset('pwa-192x192.png');
  const svg = readPublicAsset('icon.svg');
  const appimageRuntimeC = fs.readFileSync(path.resolve(__dirname, 'appimageRuntime.c'), 'utf8');

  const entries: ZipEntryInput[] = [
    { name: 'README.md', content: readmeMd },
    { name: '.github/workflows/build-native-apps.yml', content: workflowYml },
    // Linux 100% Native GTK 3 App (.AppImage Zero-FUSE + .deb + .tar.gz)
    { name: 'native-apps/linux/continuum_app.py', content: buildLinuxNativeAppPy(ctx), executable: true },
    { name: 'native-apps/linux/appimage_runtime.c', content: appimageRuntimeC },
    { name: 'native-apps/linux/build-deb.sh', content: buildLinuxDebScript(room, serverUrl), executable: true },
    { name: 'native-apps/linux/build-appimage.sh', content: buildLinuxAppImageScript(room), executable: true },
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
  const androidJavaDir = path.join(workspaceRoot, 'native-apps', 'android', 'app', 'src', 'main', 'java');
  if (fs.existsSync(androidJavaDir)) {
    fs.rmSync(androidJavaDir, { recursive: true, force: true });
  }
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
