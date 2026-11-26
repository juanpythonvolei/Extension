import fs from 'node:fs';
import path from 'node:path';
import { buildZipBuffer, type ZipEntryInput } from './zipBuilder.ts';
import {
  buildIcoFromPng,
  buildLinuxBridgePython,
  readPublicAsset,
  type InstallerContext,
} from './platformInstallers.ts';

function safeStr(val: string): string {
  return val.replace(/[`'"\\$<>|;&\r\n]/g, '');
}

function buildWindowsHeadlessBridgePs1(room: string, wsUrl: string): string {
  return `# Continuum Native Windows Bridge (Headless — Supervised by Electron Desktop App)
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ContinuumWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern bool LockWorkStation();
}
"@

$RoomCode = if ($env:CONTINUUM_ROOM_CODE) { $env:CONTINUUM_ROOM_CODE } else { "${room}" }
$WsUrl = if ($env:CONTINUUM_WS_URL) { $env:CONTINUUM_WS_URL } else { "${wsUrl}" }
$DeviceName = $env:COMPUTERNAME
$DeviceId = "win-native-" + ($DeviceName.ToLower() -replace '[^a-z0-9]', '')
$WshShell = New-Object -ComObject WScript.Shell
$LogDir = Join-Path $env:LOCALAPPDATA "Continuum"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir "bridge.log"

function Write-BridgeLog($text) {
  try {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $text
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
  } catch {}
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\\ContinuumNativeBridgeMutex", [ref]$createdNew)
if (-not $createdNew) { exit 0 }

Write-BridgeLog "Iniciando ponte nativa Windows (Desktop) para malha $RoomCode em $WsUrl"

function Send-WsJson($ws, $obj) {
  if ($null -eq $ws -or $ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { return }
  $json = ($obj | ConvertTo-Json -Depth 6 -Compress)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object System.ArraySegment[byte]($bytes, 0, $bytes.Length)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait(2000) | Out-Null
}

function Get-NativeTelemetry() {
  $cpu = 0
  try { $cpu = [int]((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average) } catch {}
  $osInfo = $null
  try { $osInfo = Get-CimInstance Win32_OperatingSystem } catch {}
  $memTotal = if ($osInfo) { [math]::Round($osInfo.TotalVisibleMemorySize / 1MB, 1) } else { $null }
  $memUsed = if ($osInfo) { [math]::Round(($osInfo.TotalVisibleMemorySize - $osInfo.FreePhysicalMemory) / 1MB, 1) } else { $null }
  $bat = $null
  try { $bat = Get-CimInstance Win32_Battery | Select-Object -First 1 } catch {}
  $apps = @()
  try {
    $procs = Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object -First 8
    $idx = 0
    foreach ($p in $procs) {
      $apps += @{ id = "win-$($p.Id)"; name = $p.ProcessName; title = $p.MainWindowTitle.Substring(0, [math]::Min(60, $p.MainWindowTitle.Length)); focused = ($idx -eq 0); source = "os-agent" }
      $idx++
    }
  } catch {}
  return @{
    cpuCores = [Environment]::ProcessorCount
    cpuUsage = $cpu
    memoryTotalGb = $memTotal
    memoryUsedGb = $memUsed
    batteryLevel = if ($bat) { [int]$bat.EstimatedChargeRemaining } else { $null }
    batteryCharging = if ($bat) { $bat.BatteryStatus -eq 2 } else { $null }
    displayServer = "win32"
    openApps = $apps
  }
}

function Handle-NativeInput($evt) {
  if ($null -eq $evt) { return }
  switch ($evt.kind) {
    "move" {
      if ($null -ne $evt.dx -and $null -ne $evt.dy) {
        $pt = New-Object ContinuumWin32+POINT
        [ContinuumWin32]::GetCursorPos([ref]$pt) | Out-Null
        [ContinuumWin32]::SetCursorPos($pt.X + [int]$evt.dx, $pt.Y + [int]$evt.dy) | Out-Null
      } elseif ($null -ne $evt.nx -and $null -ne $evt.ny) {
        $sw = [ContinuumWin32]::GetSystemMetrics(0); $sh = [ContinuumWin32]::GetSystemMetrics(1)
        if ($sw -le 0) { $sw = 1920 }; if ($sh -le 0) { $sh = 1080 }
        [ContinuumWin32]::SetCursorPos([int]([double]$evt.nx * $sw), [int]([double]$evt.ny * $sh)) | Out-Null
      }
    }
    "click" {
      if ($null -ne $evt.nx -and $null -ne $evt.ny) {
        $sw = [ContinuumWin32]::GetSystemMetrics(0); $sh = [ContinuumWin32]::GetSystemMetrics(1)
        if ($sw -le 0) { $sw = 1920 }; if ($sh -le 0) { $sh = 1080 }
        [ContinuumWin32]::SetCursorPos([int]([double]$evt.nx * $sw), [int]([double]$evt.ny * $sh)) | Out-Null
      }
      if ($evt.button -eq "right") {
        [ContinuumWin32]::mouse_event(0x0008, 0, 0, 0, 0); [ContinuumWin32]::mouse_event(0x0010, 0, 0, 0, 0)
      } else {
        [ContinuumWin32]::mouse_event(0x0002, 0, 0, 0, 0); [ContinuumWin32]::mouse_event(0x0004, 0, 0, 0, 0)
      }
    }
    "scroll" {
      $delta = [int](-1 * [double]$evt.dy * 3)
      [ContinuumWin32]::mouse_event(0x0800, 0, 0, $delta, 0)
    }
    "text" {
      if ($evt.text) {
        $escaped = [string]$evt.text -replace '([+^%~(){}\\[\\]])', '{$1}'
        $WshShell.SendKeys($escaped)
      }
    }
    "key" {
      $map = @{ "Enter" = "{ENTER}"; "Backspace" = "{BACKSPACE}"; "Tab" = "{TAB}"; "Escape" = "{ESC}"; "ArrowUp" = "{UP}"; "ArrowDown" = "{DOWN}"; "ArrowLeft" = "{LEFT}"; "ArrowRight" = "{RIGHT}" }
      $k = if ($map.ContainsKey($evt.key)) { $map[$evt.key] } else { [string]$evt.key }
      if ($evt.ctrl) { $k = "^$k" }
      if ($evt.alt) { $k = "%$k" }
      $WshShell.SendKeys($k)
    }
    "command" {
      switch ($evt.action) {
        "vol_up" { [ContinuumWin32]::keybd_event(0xAF, 0, 0, [UIntPtr]::Zero); [ContinuumWin32]::keybd_event(0xAF, 0, 2, [UIntPtr]::Zero) }
        "vol_down" { [ContinuumWin32]::keybd_event(0xAE, 0, 0, [UIntPtr]::Zero); [ContinuumWin32]::keybd_event(0xAE, 0, 2, [UIntPtr]::Zero) }
        "vol_mute" { [ContinuumWin32]::keybd_event(0xAD, 0, 0, [UIntPtr]::Zero); [ContinuumWin32]::keybd_event(0xAD, 0, 2, [UIntPtr]::Zero) }
        "media_play_pause" { [ContinuumWin32]::keybd_event(0xB3, 0, 0, [UIntPtr]::Zero); [ContinuumWin32]::keybd_event(0xB3, 0, 2, [UIntPtr]::Zero) }
        "media_next" { [ContinuumWin32]::keybd_event(0xB0, 0, 0, [UIntPtr]::Zero); [ContinuumWin32]::keybd_event(0xB0, 0, 2, [UIntPtr]::Zero) }
        "media_prev" { [ContinuumWin32]::keybd_event(0xB1, 0, 0, [UIntPtr]::Zero); [ContinuumWin32]::keybd_event(0xB1, 0, 2, [UIntPtr]::Zero) }
        "lock" { [ContinuumWin32]::LockWorkStation() | Out-Null }
        "ping" { [System.Media.SystemSounds]::Exclamation.Play(); Write-BridgeLog "Ping de diagnostico recebido." }
        "open_url" { if ($evt.payload -match '^https?://') { Start-Process $evt.payload } }
      }
    }
  }
}

$ws = $null
$recvTask = $null
$buf = New-Object byte[] 16384
$msgStream = New-Object System.IO.MemoryStream
$lastTel = [DateTime]::MinValue
$nextReconnect = [DateTime]::MinValue

while ($true) {
  try {
    if (($null -eq $ws -or $ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) -and ([DateTime]::UtcNow -ge $nextReconnect)) {
      if ($null -ne $ws) { try { $ws.Dispose() } catch {} }
      $ws = New-Object System.Net.WebSockets.ClientWebSocket
      $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
      $ct = (New-Object System.Threading.CancellationTokenSource(8000)).Token
      try {
        $ws.ConnectAsync([Uri]$WsUrl, $ct).Wait()
        if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
          Write-BridgeLog "Conectado com sucesso em $WsUrl (Malha $RoomCode)"
          Send-WsJson $ws @{ type = "companion:register"; roomCode = $RoomCode; deviceId = $DeviceId; name = "$DeviceName (Windows)"; os = "windows"; displayServer = "win32" }
          $msgStream.SetLength(0)
          $seg = New-Object System.ArraySegment[byte]($buf, 0, $buf.Length)
          $recvTask = $ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)
        }
      } catch {
        Write-BridgeLog "Falha ao conectar em $WsUrl : $($_.Exception.Message)"
        $nextReconnect = [DateTime]::UtcNow.AddSeconds(4)
      }
    }

    if ($null -ne $ws -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      if ($null -ne $recvTask -and $recvTask.IsCompleted) {
        if ($recvTask.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
          $res = $recvTask.Result
          if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
            $ws.Dispose(); $ws = $null; $recvTask = $null; $msgStream.SetLength(0)
            $nextReconnect = [DateTime]::UtcNow.AddSeconds(3)
          } else {
            if ($res.Count -gt 0) { $msgStream.Write($buf, 0, $res.Count) }
            if ($res.EndOfMessage) {
              $txt = [System.Text.Encoding]::UTF8.GetString($msgStream.ToArray())
              $msgStream.SetLength(0)
              try {
                $parsed = $txt | ConvertFrom-Json
                if ($parsed.type -eq "companion:input") { Handle-NativeInput $parsed.input }
              } catch {}
            }
            $seg = New-Object System.ArraySegment[byte]($buf, 0, $buf.Length)
            $recvTask = $ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)
          }
        } else {
          $ws.Dispose(); $ws = $null; $recvTask = $null; $msgStream.SetLength(0)
          $nextReconnect = [DateTime]::UtcNow.AddSeconds(4)
        }
      }

      if (([DateTime]::UtcNow - $lastTel).TotalSeconds -ge 4) {
        $lastTel = [DateTime]::UtcNow
        Send-WsJson $ws @{ type = "companion:telemetry"; telemetry = (Get-NativeTelemetry) }
      }
    }
  } catch {
    $nextReconnect = [DateTime]::UtcNow.AddSeconds(4)
  }
  Start-Sleep -Milliseconds 60
}
`;
}

/**
 * Generates all files for the standalone multi-platform Native Apps Build Repository.
 * Compiles real Linux (.deb + .AppImage), Windows (NSIS .exe + Portable .exe), and Android (.apk)
 * automatically via GitHub Actions and publishes them to GitHub Releases.
 */
export function buildNativeRepoEntries(ctx: InstallerContext): ZipEntryInput[] {
  const room = safeStr(ctx.roomCode);
  const serverUrl = safeStr(ctx.appUrl).replace(/\/+$/, '');
  const wsUrl = safeStr(ctx.wsUrl);

  const readmeMd = `# Continuum — Repositório de Compilação dos Apps Nativos

Este repositório compila automaticamente os **aplicativos nativos reais** do **Continuum** para **Linux**, **Windows** e **Android** usando **GitHub Actions** (gratuito para repositórios públicos e privados dentro da cota do GitHub), gerando executáveis prontos para instalar com um clique em **Releases**:

| Plataforma | Artefatos Compilados | Experiência de Instalação |
| --- | --- | --- |
| **Linux (Zorin OS, Ubuntu, Mint, Debian, Pop!_OS)** | \`Continuum-Linux-amd64.deb\` | Dois cliques na Central de Programas / Zorin Software |
| **Linux Universal (Fedora, Arch, Manjaro, openSUSE)** | \`Continuum-Linux-x86_64.AppImage\` | Binário portátil — basta executar sem instalar |
| **Windows 10 / 11** | \`Continuum-Windows-Setup.exe\` + \`Continuum-Windows-Portable.exe\` | Assistente gráfico nativo com Menu Iniciar e bandeja |
| **Android (Celular e Tablet)** | \`Continuum-Android.apk\` | Arquivo \`.apk\` nativo em tela cheia com Wake Lock e captura |

---

## Como gerar os aplicativos prontos (3 passos, sem compilar no seu PC)

1. Crie um repositório novo no GitHub (ex.: \`continuum-native\`).
2. Envie o conteúdo desta pasta para o branch \`main\` do repositório:
   \`\`\`bash
   git init -b main
   git add .
   git commit -m "Continuum Native Apps v1.2.0"
   git remote add origin https://github.com/SEU_USUARIO/continuum-native.git
   git push -u origin main
   \`\`\`
3. Abra a aba **Actions** no GitHub e aguarde ~4 minutos. Ao finalizar, todos os instaladores (\`.deb\`, \`.AppImage\`, \`.exe\` e \`.apk\`) estarão publicados na aba **Releases** com \`SHA256SUMS.txt\`.

> **Dica:** Para compilar novamente apontando para outro servidor ou outra malha sem editar código, acesse **Actions → Build Continuum Native Apps → Run workflow** e preencha \`server_url\` e \`room_code\`.

## Configuração Padrão Embutida

- **Servidor:** \`${serverUrl}\`
- **Malha inicial:** \`${room}\`
- **No app Desktop (Linux/Windows):** você também pode trocar o endereço do servidor ou o código da malha a qualquer momento clicando com o botão direito no ícone da bandeja → **Alterar Servidor / Malha**.

## Conectar as Releases ao painel do Continuum

Após a primeira build no GitHub, abra a aba **Instalar Apps** no Continuum e informe \`SEU_USUARIO/continuum-native\` na seção **Repositório de Compilação (GitHub Releases)** para exibir os botões de download direto dos binários compilados dentro do próprio app.
`;

  const gitignore = `node_modules/
desktop/dist/
desktop/node_modules/
android/.gradle/
android/build/
android/app/build/
android/local.properties
.DS_Store
*.log
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
    name: Linux (.deb + .AppImage)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Apply runtime server config
        working-directory: desktop
        env:
          INPUT_SERVER: \${{ inputs.server_url }}
          INPUT_ROOM: \${{ inputs.room_code }}
        run: node scripts/apply-config.js

      - name: Install desktop dependencies
        working-directory: desktop
        run: npm install

      - name: Build Linux .deb and .AppImage
        working-directory: desktop
        run: npx electron-builder --linux deb AppImage --x64

      - name: Normalize output filenames
        working-directory: desktop/dist
        run: |
          mkdir -p out
          cp *.deb out/Continuum-Linux-amd64.deb
          cp *.AppImage out/Continuum-Linux-x86_64.AppImage
          ls -lh out/

      - uses: actions/upload-artifact@v4
        with:
          name: continuum-linux
          path: desktop/dist/out/*

  build-windows:
    name: Windows (.exe Setup + Portable)
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Apply runtime server config
        working-directory: desktop
        env:
          INPUT_SERVER: \${{ inputs.server_url }}
          INPUT_ROOM: \${{ inputs.room_code }}
        run: node scripts/apply-config.js

      - name: Install desktop dependencies
        working-directory: desktop
        run: npm install

      - name: Build Windows NSIS Setup and Portable .exe
        working-directory: desktop
        run: npx electron-builder --win nsis portable --x64

      - name: Normalize output filenames
        working-directory: desktop/dist
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Force -Path out | Out-Null
          Get-ChildItem -Filter "*Setup*.exe" | Select-Object -First 1 | Copy-Item -Destination "out\\Continuum-Windows-Setup.exe"
          Get-ChildItem -Filter "*Portable*.exe" | Select-Object -First 1 | Copy-Item -Destination "out\\Continuum-Windows-Portable.exe"
          Get-ChildItem out

      - uses: actions/upload-artifact@v4
        with:
          name: continuum-windows
          path: desktop/dist/out/*

  build-android:
    name: Android (.apk)
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

      - name: Build Android APK
        working-directory: android
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
          mkdir -p out
          cp app/build/outputs/apk/debug/app-debug.apk out/Continuum-Android.apk
          ls -lh out/

      - uses: actions/upload-artifact@v4
        with:
          name: continuum-android
          path: android/out/Continuum-Android.apk

  publish-release:
    name: Publish GitHub Release
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

      - name: Publish Release with all native binaries
        uses: softprops/action-gh-release@v2
        with:
          tag_name: \${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || 'latest-native' }}
          name: Continuum Native Apps (\${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || 'Build Recente' }})
          make_latest: true
          body: |
            ## Aplicativos Nativos Compilados — Continuum

            - **Linux (Zorin OS, Ubuntu, Mint, Debian, Pop!_OS):** \`Continuum-Linux-amd64.deb\`
            - **Linux Universal (Fedora, Arch, Manjaro):** \`Continuum-Linux-x86_64.AppImage\`
            - **Windows 10/11 (Instalador):** \`Continuum-Windows-Setup.exe\`
            - **Windows 10/11 (Portátil):** \`Continuum-Windows-Portable.exe\`
            - **Android (Celular/Tablet):** \`Continuum-Android.apk\`
          files: release-assets/*
`;

  const desktopPackageJson = JSON.stringify(
    {
      name: 'continuum-desktop',
      productName: 'Continuum',
      version: '1.2.0',
      description: 'Continuum — Ecossistema Multiplataforma e Second Screen sem fio',
      main: 'main.js',
      author: 'Continuum <support@continuum.local>',
      license: 'MIT',
      scripts: {
        start: 'electron .',
        'build:linux': 'electron-builder --linux deb AppImage --x64',
        'build:win': 'electron-builder --win nsis portable --x64',
      },
      devDependencies: {
        electron: '^33.2.0',
        'electron-builder': '^25.1.8',
      },
      build: {
        appId: 'app.continuum.desktop',
        productName: 'Continuum',
        directories: {
          buildResources: 'build',
          output: 'dist',
        },
        files: ['main.js', 'preload.js', 'config.json', 'build/icon.png', 'build/icon.ico'],
        extraResources: [
          {
            from: 'bridge',
            to: 'bridge',
            filter: ['**/*'],
          },
        ],
        linux: {
          target: [
            { target: 'deb', arch: ['x64'] },
            { target: 'AppImage', arch: ['x64'] },
          ],
          icon: 'build/icon.png',
          category: 'Utility',
          maintainer: 'Continuum <support@continuum.local>',
          synopsis: 'Ecossistema Multiplataforma e Second Screen sem fio',
          desktop: {
            Name: 'Continuum',
            GenericName: 'Second Screen and Device Mesh',
            Comment: 'Ecossistema Multiplataforma e Monitor Secundario sem Fio',
            Categories: 'Network;Utility;System;',
            StartupWMClass: 'Continuum',
          },
        },
        deb: {
          depends: [
            'libgtk-3-0',
            'libnotify4',
            'libnss3',
            'libxss1',
            'libxtst6',
            'xdg-utils',
            'libatspi2.0-0',
            'libuuid1',
            'libsecret-1-0',
            'python3',
          ],
          recommends: ['xdotool', 'wmctrl', 'pulseaudio-utils | wireplumber', 'playerctl'],
        },
        win: {
          target: [
            { target: 'nsis', arch: ['x64'] },
            { target: 'portable', arch: ['x64'] },
          ],
          icon: 'build/icon.ico',
        },
        nsis: {
          oneClick: false,
          allowToChangeInstallationDirectory: true,
          createDesktopShortcut: true,
          createStartMenuShortcut: true,
          shortcutName: 'Continuum',
          artifactName: 'Continuum-Windows-Setup.exe',
        },
        portable: {
          artifactName: 'Continuum-Windows-Portable.exe',
        },
      },
    },
    null,
    2
  ) + '\n';

  const desktopConfigJson =
    JSON.stringify(
      {
        serverUrl,
        roomCode: room,
      },
      null,
      2
    ) + '\n';

  const desktopPreloadJs = `const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('continuumNative', {
  isDesktopApp: true,
  platform: process.platform,
  version: '1.2.0',
});
`;

  const desktopApplyConfigJs = `const fs = require('node:fs');
const path = require('node:path');

const cfgPath = path.join(__dirname, '..', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

if (process.env.INPUT_SERVER && process.env.INPUT_SERVER.trim()) {
  cfg.serverUrl = process.env.INPUT_SERVER.trim().replace(/\\/+$/, '');
}
if (process.env.INPUT_ROOM && process.env.INPUT_ROOM.trim()) {
  const cleaned = process.env.INPUT_ROOM.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (cleaned.length >= 4) cfg.roomCode = cleaned;
}

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\\n', 'utf8');
console.log('Continuum Desktop build config:', cfg);
`;

  const desktopMainJs = `const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, nativeImage, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let mainWindow = null;
let tray = null;
let bridgeProc = null;
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function getUserConfigPath() {
  return path.join(app.getPath('userData'), 'continuum-config.json');
}

function loadConfig() {
  const defaultCfgPath = path.join(__dirname, 'config.json');
  let base = { serverUrl: '${serverUrl}', roomCode: '${room}' };
  try {
    base = { ...base, ...JSON.parse(fs.readFileSync(defaultCfgPath, 'utf8')) };
  } catch {
    // ignore
  }
  try {
    const userPath = getUserConfigPath();
    if (fs.existsSync(userPath)) {
      base = { ...base, ...JSON.parse(fs.readFileSync(userPath, 'utf8')) };
    }
  } catch {
    // ignore
  }
  base.serverUrl = String(base.serverUrl || '').replace(/\\/+$/, '');
  base.roomCode = String(base.roomCode || 'MESH01').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'MESH01';
  return base;
}

function saveConfig(cfg) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getUserConfigPath(), JSON.stringify(cfg, null, 2) + '\\n', 'utf8');
}

function getWsUrl(serverUrl) {
  try {
    const parsed = new URL(serverUrl);
    const proto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + parsed.host + '/ws';
  } catch {
    return '${wsUrl}';
  }
}

function getBridgeResourcePath(fileName) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bridge', fileName);
  }
  return path.join(__dirname, 'bridge', fileName);
}

function getBridgeLogPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Continuum', 'bridge.log');
  }
  return path.join(os.homedir(), '.local', 'share', 'continuum', 'bridge.log');
}

function stopBridge() {
  if (bridgeProc) {
    try {
      bridgeProc.kill();
    } catch {
      // ignore
    }
    bridgeProc = null;
  }
}

function startBridge(cfg) {
  stopBridge();
  const wsUrl = getWsUrl(cfg.serverUrl);
  const env = {
    ...process.env,
    CONTINUUM_ROOM_CODE: cfg.roomCode,
    CONTINUUM_WS_URL: wsUrl,
    CONTINUUM_APP_URL: cfg.serverUrl + '/?room=' + encodeURIComponent(cfg.roomCode),
  };

  if (process.platform === 'linux') {
    const script = getBridgeResourcePath('continuum_bridge.py');
    if (fs.existsSync(script)) {
      bridgeProc = spawn('python3', [script], { env, stdio: 'ignore' });
      bridgeProc.on('exit', () => {
        bridgeProc = null;
      });
    }
  } else if (process.platform === 'win32') {
    const script = getBridgeResourcePath('ContinuumBridge.ps1');
    if (fs.existsSync(script)) {
      bridgeProc = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
        { env, windowsHide: true, stdio: 'ignore' }
      );
      bridgeProc.on('exit', () => {
        bridgeProc = null;
      });
    }
  }
}

function openConfigPrompt() {
  const cfg = loadConfig();
  const promptWin = new BrowserWindow({
    width: 480,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: Boolean(mainWindow),
    backgroundColor: '#090B0E',
    title: 'Configurar Servidor e Malha — Continuum',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const html = \`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><style>
body{margin:0;padding:20px;background:#090B0E;color:#F1F5F9;font-family:system-ui,sans-serif;font-size:13px}
label{display:block;color:#94A3B8;margin:12px 0 4px;font-size:12px}
input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:6px;border:1px solid #222936;background:#11151B;color:#F1F5F9;font-family:monospace;font-size:12px}
.row{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
button{padding:8px 14px;border-radius:6px;border:1px solid #222936;background:#171C24;color:#F1F5F9;cursor:pointer;font-size:12px}
button.primary{background:#3B82F6;border-color:#3B82F6;color:#fff}
</style></head>
<body>
  <strong style="font-size:15px">Servidor e Malha do Continuum</strong>
  <form id="f">
    <label>URL do Servidor (https://... ou http://IP:3000)</label>
    <input id="url" type="url" required value="\${cfg.serverUrl.replace(/"/g, '&quot;')}" />
    <label>Codigo da Malha (4 a 8 caracteres)</label>
    <input id="room" type="text" required maxlength="8" value="\${cfg.roomCode.replace(/"/g, '&quot;')}" />
    <div class="row">
      <button type="button" onclick="window.close()">Cancelar</button>
      <button type="submit" class="primary">Salvar e Reconectar</button>
    </div>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const u = encodeURIComponent(document.getElementById('url').value.trim());
      const r = encodeURIComponent(document.getElementById('room').value.trim());
      window.location.href = 'continuum-cfg://save?url=' + u + '&room=' + r;
    });
  </script>
</body></html>\`;

  promptWin.webContents.on('will-navigate', (ev, targetUrl) => {
    if (targetUrl.startsWith('continuum-cfg://save')) {
      ev.preventDefault();
      try {
        const parsed = new URL(targetUrl);
        const nextUrl = String(parsed.searchParams.get('url') || cfg.serverUrl).replace(/\\/+$/, '');
        const nextRoom = String(parsed.searchParams.get('room') || cfg.roomCode)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, 8);
        if (nextUrl.startsWith('http://') || nextUrl.startsWith('https://')) {
          const updated = { serverUrl: nextUrl, roomCode: nextRoom || cfg.roomCode };
          saveConfig(updated);
          startBridge(updated);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(updated.serverUrl + '/?room=' + encodeURIComponent(updated.roomCode));
          }
        }
      } catch {
        // ignore
      }
      promptWin.close();
    }
  });

  promptWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createWindow() {
  const cfg = loadConfig();
  const iconPath = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#090B0E',
    title: 'Continuum',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Enable native getDisplayMedia() capture for Second Screen inside Electron
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      if (sources.length > 0) {
        callback({ video: sources[0] });
        return;
      }
    } catch {
      // fallback
    }
    callback({});
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (ev) => {
    if (!isQuitting && tray) {
      ev.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.loadURL(cfg.serverUrl + '/?room=' + encodeURIComponent(cfg.roomCode));
  startBridge(cfg);
}

function createTray() {
  const iconPath = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 }) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Continuum — Ecossistema Multiplataforma');

  const rebuildMenu = () => {
    const cfg = loadConfig();
    const menu = Menu.buildFromTemplate([
      {
        label: 'Abrir Continuum',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { label: 'Malha atual: ' + cfg.roomCode, enabled: false },
      { type: 'separator' },
      { label: 'Alterar Servidor / Malha...', click: openConfigPrompt },
      {
        label: 'Abrir Log da Ponte Nativa',
        click: () => {
          const logPath = getBridgeLogPath();
          if (fs.existsSync(logPath)) {
            shell.openPath(logPath);
          } else {
            dialog.showMessageBox({ message: 'O log sera criado em: ' + logPath });
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Encerrar Continuum',
        click: () => {
          isQuitting = true;
          stopBridge();
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };

  rebuildMenu();
  tray.on('click', () => {
    rebuildMenu();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBridge();
});
`;

  // Android Kotlin project files (compiles cleanly with Gradle 8.7 + JDK 17 + Android SDK 34)
  const androidSettingsKts = `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "ContinuumAndroid"
include(":app")
`;

  const androidRootBuildKts = `plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
`;

  const androidGradleProps = `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
`;

  const androidAppBuildKts = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val continuumUrl = (project.findProperty("continuumUrl") as String?)?.trimEnd('/') ?: "${serverUrl}"
val roomCode = (project.findProperty("roomCode") as String?) ?: "${room}"

android {
    namespace = "app.continuum.mesh"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.continuum.mesh"
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "1.2.0"

        buildConfigField("String", "CONTINUUM_URL", "\\"\${continuumUrl}/?room=\${roomCode}\\"")
        buildConfigField("String", "ROOM_CODE", "\\"\${roomCode}\\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
`;

  const androidManifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="Continuum"
        android:supportsRtl="true"
        android:usesCleartextTraffic="true"
        android:hardwareAccelerated="true"
        android:theme="@style/Theme.Continuum">
        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

  const androidMainActivityKt = `package app.continuum.mesh

import android.annotation.SuppressLint
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback
        filePathCallback = null
        if (callback == null) return@registerForActivityResult
        if (result.resultCode == RESULT_OK && result.data != null) {
            val data = result.data!!
            val uris = mutableListOf<Uri>()
            data.clipData?.let { clip ->
                for (i in 0 until clip.itemCount) {
                    uris.add(clip.getItemAt(i).uri)
                }
            } ?: data.data?.let { uris.add(it) }
            callback.onReceiveValue(uris.toTypedArray())
        } else {
            callback.onReceiveValue(null)
        }
    }

    inner class ContinuumAndroidBridge {
        @JavascriptInterface
        fun getBatteryLevel(): Int {
            val status = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = status?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = status?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            return if (level >= 0 && scale > 0) (level * 100) / scale else -1
        }

        @JavascriptInterface
        fun isCharging(): Boolean {
            val status = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val plugged = status?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
            return plugged == BatteryManager.BATTERY_PLUGGED_AC ||
                plugged == BatteryManager.BATTERY_PLUGGED_USB ||
                plugged == BatteryManager.BATTERY_PLUGGED_WIRELESS
        }

        @JavascriptInterface
        fun getDeviceModel(): String = "\${Build.MANUFACTURER} \${Build.MODEL}"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this).apply {
            setBackgroundColor(0xFF090B0E.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            addJavascriptInterface(ContinuumAndroidBridge(), "ContinuumAndroid")

            webViewClient = WebViewClient()
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest?) {
                    runOnUiThread { request?.grant(request.resources) }
                }

                override fun onShowFileChooser(
                    webView: WebView?,
                    callback: ValueCallback<Array<Uri>>?,
                    params: FileChooserParams?
                ): Boolean {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = callback
                    val intent = params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    return try {
                        fileChooserLauncher.launch(intent)
                        true
                    } catch (_: Exception) {
                        filePathCallback = null
                        false
                    }
                }
            }
        }

        setContentView(webView)
        enableImmersiveMode()
        webView.loadUrl(BuildConfig.CONTINUUM_URL)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableImmersiveMode()
    }

    @Suppress("DEPRECATION")
    private fun enableImmersiveMode() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            )
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
`;

  const androidStylesXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.Continuum" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="android:windowBackground">#090B0E</item>
        <item name="android:statusBarColor">#090B0E</item>
        <item name="android:navigationBarColor">#090B0E</item>
    </style>
</resources>
`;

  const androidIcLauncherBg = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#090B0E" />
</shape>
`;

  const androidIcLauncherFg = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#3B82F6"
        android:pathData="M34,36h26c2.2,0 4,1.8 4,4v28c0,2.2 -1.8,4 -4,4H34c-2.2,0 -4,-1.8 -4,-4V40C30,37.8 31.8,36 34,36z" />
    <path
        android:fillColor="#60A5FA"
        android:pathData="M68,46h10c2.2,0 4,1.8 4,4v18c0,2.2 -1.8,4 -4,4H68c-2.2,0 -4,-1.8 -4,-4V50C64,47.8 65.8,46 68,46z" />
</vector>
`;

  const androidIcLauncherAnyDpi = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;

  const entries: ZipEntryInput[] = [
    { name: 'README.md', content: readmeMd },
    { name: '.gitignore', content: gitignore },
    { name: '.github/workflows/build-native-apps.yml', content: workflowYml },
    { name: 'desktop/package.json', content: desktopPackageJson },
    { name: 'desktop/config.json', content: desktopConfigJson },
    { name: 'desktop/main.js', content: desktopMainJs },
    { name: 'desktop/preload.js', content: desktopPreloadJs },
    { name: 'desktop/scripts/apply-config.js', content: desktopApplyConfigJs },
    {
      name: 'desktop/bridge/continuum_bridge.py',
      content: buildLinuxBridgePython(room, wsUrl),
      executable: true,
    },
    {
      name: 'desktop/bridge/ContinuumBridge.ps1',
      content: buildWindowsHeadlessBridgePs1(room, wsUrl).replace(/\r?\n/g, '\r\n'),
    },
    { name: 'android/settings.gradle.kts', content: androidSettingsKts },
    { name: 'android/build.gradle.kts', content: androidRootBuildKts },
    { name: 'android/gradle.properties', content: androidGradleProps },
    { name: 'android/app/build.gradle.kts', content: androidAppBuildKts },
    { name: 'android/app/src/main/AndroidManifest.xml', content: androidManifest },
    { name: 'android/app/src/main/java/app/continuum/mesh/MainActivity.kt', content: androidMainActivityKt },
    { name: 'android/app/src/main/res/values/styles.xml', content: androidStylesXml },
    { name: 'android/app/src/main/res/drawable/ic_launcher_background.xml', content: androidIcLauncherBg },
    { name: 'android/app/src/main/res/drawable/ic_launcher_foreground.xml', content: androidIcLauncherFg },
    { name: 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', content: androidIcLauncherAnyDpi },
  ];

  const png512 = readPublicAsset('pwa-512x512.png');
  if (png512) {
    entries.push({ name: 'desktop/build/icon.png', content: png512 });
  }
  const png192 = readPublicAsset('pwa-192x192.png');
  if (png192) {
    entries.push({ name: 'desktop/build/icon.ico', content: buildIcoFromPng(png192) });
    entries.push({ name: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', content: png192 });
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
 * Writes the complete Native Apps Build Repository directly into a local directory
 * (e.g. /native-apps-repo in this workspace).
 */
export function materializeNativeRepo(targetDir: string, ctx: InstallerContext): number {
  const entries = buildNativeRepoEntries(ctx);
  for (const entry of entries) {
    const dest = path.join(targetDir, entry.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    fs.writeFileSync(dest, data);
    if (entry.executable) {
      fs.chmodSync(dest, 0o755);
    }
  }
  return entries.length;
}
