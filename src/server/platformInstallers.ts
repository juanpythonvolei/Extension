import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZipBuffer, type ZipEntryInput } from './zipBuilder.ts';
import { buildDebPackage, type TarEntry } from './debBuilder.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface InstallerContext {
  roomCode: string;
  appUrl: string;
  wsUrl: string;
}

function safeStr(val: string): string {
  return val.replace(/[`'"\\$<>|;&\r\n]/g, '');
}

function toCRLF(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export function readPublicAsset(fileName: string): Buffer | null {
  try {
    const assetPath = path.resolve(__dirname, '../../public', fileName);
    if (fs.existsSync(assetPath)) {
      return fs.readFileSync(assetPath);
    }
  } catch {
    // fallback ignored
  }
  return null;
}

/**
 * Wraps a PNG image (e.g. 192x192) inside a standard Windows ICO container (Vista+ PNG-in-ICO).
 * Natively supported by Windows Explorer, Start Menu shortcuts, and System.Drawing.Icon.
 */
export function buildIcoFromPng(pngBuf: Buffer): Buffer {
  const width = pngBuf.length >= 24 ? pngBuf.readUInt32BE(16) : 192;
  const height = pngBuf.length >= 24 ? pngBuf.readUInt32BE(20) : 192;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = ICO
  header.writeUInt16LE(1, 4); // count: 1 image

  const entry = Buffer.alloc(16);
  entry[0] = width >= 256 ? 0 : width;
  entry[1] = height >= 256 ? 0 : height;
  entry[2] = 0; // color palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8); // image data size
  entry.writeUInt32LE(22, 12); // image data offset (6 + 16)

  return Buffer.concat([header, entry, pngBuf]);
}

/**
 * WINDOWS PLUG-AND-PLAY PACKAGE (Zero Terminal, Zero Node.js)
 * Uses built-in Windows WScript + .NET WinForms + System.Net.WebSockets + native .ico + Edge/Chrome App Mode.
 */
export function buildWindowsInstallerZip(ctx: InstallerContext): Buffer {
  const room = safeStr(ctx.roomCode);
  const appUrl = safeStr(`${ctx.appUrl}/?room=${room}`);
  const wsUrl = safeStr(ctx.wsUrl);

  const installVbs = toCRLF(`' Continuum - Instalador Plug-and-Play para Windows (Sem Terminal)
Option Explicit
Dim fso, shell, srcDir, installDir, startMenu, desktop, shortcut, startShortcut, iconPath

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

srcDir = fso.GetParentFolderName(WScript.ScriptFullName)
installDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\Continuum"

If Not fso.FolderExists(installDir) Then
  fso.CreateFolder(installDir)
End If

Dim files, f
files = Array("Continuum.vbs", "ContinuumBridge.ps1", "Desinstalar Continuum.vbs", "continuum.ico", "continuum.svg")
For Each f In files
  If fso.FileExists(srcDir & "\\" & f) Then
    fso.CopyFile srcDir & "\\" & f, installDir & "\\" & f, True
  End If
Next

If fso.FileExists(installDir & "\\continuum.ico") Then
  iconPath = installDir & "\\continuum.ico,0"
Else
  iconPath = "shell32.dll,15"
End If

' Atalho na Area de Trabalho
desktop = shell.SpecialFolders("Desktop")
Set shortcut = shell.CreateShortcut(desktop & "\\Continuum.lnk")
shortcut.TargetPath = "wscript.exe"
shortcut.Arguments = """" & installDir & "\\Continuum.vbs"""
shortcut.WorkingDirectory = installDir
shortcut.Description = "Continuum - Ecossistema Multiplataforma e Second Screen"
shortcut.IconLocation = iconPath
shortcut.Save

' Atalho no Menu Iniciar
startMenu = shell.ExpandEnvironmentStrings("%APPDATA%") & "\\Microsoft\\Windows\\Start Menu\\Programs\\Continuum"
If Not fso.FolderExists(startMenu) Then
  fso.CreateFolder(startMenu)
End If

Set startShortcut = shell.CreateShortcut(startMenu & "\\Continuum.lnk")
startShortcut.TargetPath = "wscript.exe"
startShortcut.Arguments = """" & installDir & "\\Continuum.vbs"""
startShortcut.WorkingDirectory = installDir
startShortcut.Description = "Continuum - Ecossistema Multiplataforma e Second Screen"
startShortcut.IconLocation = iconPath
startShortcut.Save

Dim uninstShortcut
Set uninstShortcut = shell.CreateShortcut(startMenu & "\\Desinstalar Continuum.lnk")
uninstShortcut.TargetPath = "wscript.exe"
uninstShortcut.Arguments = """" & installDir & "\\Desinstalar Continuum.vbs"""
uninstShortcut.WorkingDirectory = installDir
uninstShortcut.IconLocation = "shell32.dll,31"
uninstShortcut.Save

MsgBox "Continuum instalado com sucesso!" & vbCrLf & vbCrLf & _
  "- Atalho com icone proprio criado na Area de Trabalho e no Menu Iniciar." & vbCrLf & _
  "- Malha pareada automaticamente: ${room}" & vbCrLf & vbCrLf & _
  "O aplicativo sera aberto agora em modo nativo.", vbInformation, "Continuum para Windows"

shell.Run "wscript.exe """ & installDir & "\\Continuum.vbs""", 0, False
`);

  const launcherVbs = toCRLF(`' Continuum - Inicializador Nativo Windows (Janela App + Bandeja do Sistema)
Option Explicit
Dim fso, shell, appDir, bridgeScript, appUrl, browserPath

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
bridgeScript = appDir & "\\ContinuumBridge.ps1"
appUrl = "${appUrl}"

' 1. Inicia a Ponte Nativa do Sistema na Bandeja do Windows (sem janela de console)
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & bridgeScript & """", 0, False

' 2. Abre a interface do Continuum em janela dedicada estilo app nativo (Edge ou Chrome)
Dim candidates, c
candidates = Array( _
  shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\\Microsoft\\Edge\\Application\\msedge.exe", _
  shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\\Microsoft\\Edge\\Application\\msedge.exe", _
  shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\\Google\\Chrome\\Application\\chrome.exe", _
  shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\\Google\\Chrome\\Application\\chrome.exe", _
  shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\Google\\Chrome\\Application\\chrome.exe", _
  shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" _
)

browserPath = ""
For Each c In candidates
  If fso.FileExists(c) Then
    browserPath = c
    Exit For
  End If
Next

If browserPath <> "" Then
  shell.Run """" & browserPath & """ --app=""" & appUrl & """ --new-window", 1, False
Else
  shell.Run appUrl, 1, False
End If
`);

  const uninstallVbs = toCRLF(`' Continuum - Desinstalador Windows
Option Explicit
Dim fso, shell, desktop, startMenu, installDir, resp

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

resp = MsgBox("Deseja remover o Continuum e seus atalhos deste computador?", vbYesNo + vbQuestion, "Desinstalar Continuum")
If resp <> vbYes Then WScript.Quit

desktop = shell.SpecialFolders("Desktop")
startMenu = shell.ExpandEnvironmentStrings("%APPDATA%") & "\\Microsoft\\Windows\\Start Menu\\Programs\\Continuum"
installDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\Continuum"

On Error Resume Next
If fso.FileExists(desktop & "\\Continuum.lnk") Then fso.DeleteFile desktop & "\\Continuum.lnk", True
If fso.FolderExists(startMenu) Then fso.DeleteFolder startMenu, True
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -Command ""Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*ContinuumBridge.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }""", 0, True
MsgBox "Continuum removido com sucesso.", vbInformation, "Continuum"
`);

  const bridgePs1 = toCRLF(`# Continuum Native Windows Bridge (Pure .NET - Sem Node.js e Sem Terminal)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ContinuumWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool LockWorkStation();
}
"@

$RoomCode = if ($env:CONTINUUM_ROOM_CODE) { $env:CONTINUUM_ROOM_CODE } else { "${room}" }
$WsUrl = if ($env:CONTINUUM_WS_URL) { $env:CONTINUUM_WS_URL } else { "${wsUrl}" }
$AppUrl = if ($env:CONTINUUM_APP_URL) { $env:CONTINUUM_APP_URL } else { "${appUrl}" }
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

Write-BridgeLog "Iniciando ponte nativa Windows para malha $RoomCode em $WsUrl"

$tray = New-Object System.Windows.Forms.NotifyIcon
$icoFile = Join-Path $PSScriptRoot "continuum.ico"
if (Test-Path $icoFile) {
  try { $tray.Icon = New-Object System.Drawing.Icon($icoFile) } catch { $tray.Icon = [System.Drawing.SystemIcons]::Application }
} else {
  $tray.Icon = [System.Drawing.SystemIcons]::Application
}
$tray.Text = "Continuum - Malha $RoomCode"
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Abrir Continuum")
$openItem.Add_Click({ Start-Process $AppUrl })
$logItem = $menu.Items.Add("Abrir Log de Diagnostico")
$logItem.Add_Click({ if (Test-Path $LogPath) { Start-Process notepad.exe $LogPath } })
$statusItem = $menu.Items.Add("Malha: $RoomCode (Conectando...)")
$statusItem.Enabled = $false
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("Encerrar Ponte Nativa")
$script:Running = $true
$exitItem.Add_Click({
  $script:Running = $false
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$tray.ContextMenuStrip = $menu

function Send-WsJson($ws, $obj) {
  if ($ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { return }
  $json = ($obj | ConvertTo-Json -Depth 6 -Compress)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object System.ArraySegment[byte](,$bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait(2500) | Out-Null
}

function Collect-WindowsTelemetry {
  $cpuUsage = 0
  try {
    $cpuLoad = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    if ($null -ne $cpuLoad) { $cpuUsage = [int][Math]::Round($cpuLoad) }
  } catch {}

  $totalGb = 0
  $usedGb = 0
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $totalGb = [Math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    $freeGb = [Math]::Round($os.FreePhysicalMemory / 1MB, 1)
    $usedGb = [Math]::Round($totalGb - $freeGb, 1)
  } catch {}

  $batLevel = $null
  $batCharging = $null
  try {
    $ps = [System.Windows.Forms.SystemInformation]::PowerStatus
    if ($ps.BatteryLifePercent -le 1.0 -and $ps.BatteryChargeStatus -ne [System.Windows.Forms.BatteryChargeStatus]::NoSystemBattery) {
      $batLevel = [int][Math]::Round($ps.BatteryLifePercent * 100)
      $batCharging = ($ps.PowerLineStatus -eq [System.Windows.Forms.PowerLineStatus]::Online)
    }
  } catch {}

  $apps = @()
  try {
    $procs = Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object -First 8
    $i = 0
    foreach ($p in $procs) {
      $apps += @{
        id = "win-$i-$($p.ProcessName)"
        name = "$($p.ProcessName)"
        title = "$($p.MainWindowTitle)"
        source = "os-agent"
        focused = ($i -eq 0)
      }
      $i++
    }
  } catch {}

  return @{
    cpuCores = [Environment]::ProcessorCount
    cpuUsage = $cpuUsage
    memoryTotalGb = $totalGb
    memoryUsedGb = $usedGb
    batteryLevel = $batLevel
    batteryCharging = $batCharging
    displayServer = "win32"
    openApps = $apps
  }
}

function Move-CursorNormalized($nx, $ny) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $tx = [int][Math]::Max(0, [Math]::Min($bounds.Width - 1, [Math]::Round($nx * $bounds.Width)))
  $ty = [int][Math]::Max(0, [Math]::Min($bounds.Height - 1, [Math]::Round($ny * $bounds.Height)))
  [ContinuumWin32]::SetCursorPos($tx, $ty) | Out-Null
}

function Handle-NativeInput($evt) {
  try {
    switch ($evt.kind) {
      "move" {
        $pt = New-Object ContinuumWin32+POINT
        [ContinuumWin32]::GetCursorPos([ref]$pt) | Out-Null
        if ($null -ne $evt.dx -and $null -ne $evt.dy) {
          [ContinuumWin32]::SetCursorPos($pt.X + [int]$evt.dx, $pt.Y + [int]$evt.dy) | Out-Null
        } elseif ($null -ne $evt.nx -and $null -ne $evt.ny) {
          Move-CursorNormalized $evt.nx $evt.ny
        }
      }
      "click" {
        if ($null -ne $evt.nx -and $null -ne $evt.ny) {
          Move-CursorNormalized $evt.nx $evt.ny
        }
        if ($evt.button -eq "right") {
          [ContinuumWin32]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
          [ContinuumWin32]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
        } else {
          [ContinuumWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
          [ContinuumWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        }
      }
      "scroll" {
        $wheelDelta = -1 * [int]$evt.dy
        [ContinuumWin32]::mouse_event(0x0800, 0, 0, $wheelDelta, [UIntPtr]::Zero)
      }
      "text" {
        if ($evt.text) {
          $escaped = ($evt.text -replace '([+^%~(){}\\[\\]])', '{$1}')
          $WshShell.SendKeys($escaped)
        }
      }
      "key" {
        if ($evt.key -eq "Enter") { $WshShell.SendKeys("{ENTER}") }
        elseif ($evt.key -eq "Backspace") { $WshShell.SendKeys("{BACKSPACE}") }
        elseif ($evt.key -eq "Escape") { $WshShell.SendKeys("{ESC}") }
        elseif ($evt.key -eq "Tab" -and $evt.alt) { $WshShell.SendKeys("%{TAB}") }
        elseif ($evt.ctrl -and $evt.key) { $WshShell.SendKeys("^$($evt.key.ToLower())") }
      }
      "command" {
        switch ($evt.action) {
          "vol_up" { $WshShell.SendKeys([char]175) }
          "vol_down" { $WshShell.SendKeys([char]174) }
          "vol_mute" { $WshShell.SendKeys([char]173) }
          "media_play_pause" { $WshShell.SendKeys([char]179) }
          "media_next" { $WshShell.SendKeys([char]176) }
          "media_prev" { $WshShell.SendKeys([char]177) }
          "lock" { [ContinuumWin32]::LockWorkStation() | Out-Null }
          "ping" { [System.Media.SystemSounds]::Asterisk.Play() }
          "open_url" {
            if ($evt.payload -match '^https?://') { Start-Process $evt.payload }
          }
        }
      }
    }
  } catch {
    Write-BridgeLog "Aviso ao processar comando remoto: $_"
  }
}

$buffer = New-Object byte[] 65536
while ($script:Running) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
  try {
    $uri = [Uri]$WsUrl
    $connectTask = $ws.ConnectAsync($uri, [System.Threading.CancellationToken]::None)
    while (-not $connectTask.IsCompleted -and $script:Running) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 40
    }
    if ($connectTask.IsFaulted) {
      throw $connectTask.Exception.InnerException
    }
    if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $statusItem.Text = "Malha: $RoomCode (Conectado)"
      Write-BridgeLog "Conectado com sucesso a malha $RoomCode."
      Send-WsJson $ws @{
        type = "companion:register"
        roomCode = $RoomCode
        deviceId = $DeviceId
        name = $DeviceName
        os = "windows"
        displayServer = "win32"
      }

      $lastTelemetry = [DateTime]::MinValue
      $msgStream = New-Object System.IO.MemoryStream
      $seg = New-Object System.ArraySegment[byte](,$buffer)
      $recvTask = $ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)

      while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open -and $script:Running) {
        [System.Windows.Forms.Application]::DoEvents()

        if (([DateTime]::UtcNow - $lastTelemetry).TotalSeconds -ge 4) {
          $lastTelemetry = [DateTime]::UtcNow
          Send-WsJson $ws @{
            type = "companion:telemetry"
            telemetry = (Collect-WindowsTelemetry)
          }
        }

        if ($recvTask.IsCompleted) {
          if ($recvTask.IsFaulted) { throw $recvTask.Exception.InnerException }
          $res = $recvTask.Result
          if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
          if ($res.Count -gt 0) {
            $msgStream.Write($buffer, 0, $res.Count)
          }
          if ($res.EndOfMessage) {
            $txt = [System.Text.Encoding]::UTF8.GetString($msgStream.ToArray())
            $msgStream.SetLength(0)
            try {
              $msg = $txt | ConvertFrom-Json
              if ($msg.type -eq "input:event" -and $msg.input) {
                Handle-NativeInput $msg.input
              }
            } catch {}
          }
          $recvTask = $ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)
        }
        Start-Sleep -Milliseconds 20
      }
      $msgStream.Dispose()
    }
  } catch {
    $statusItem.Text = "Malha: $RoomCode (Reconectando...)"
    Write-BridgeLog "Falha de conexao WebSocket: $_"
  } finally {
    try { $ws.Dispose() } catch {}
  }

  for ($w = 0; $w -lt 60 -and $script:Running; $w++) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
  }
}
`);

  const readmeTxt = toCRLF(`CONTINUUM PARA WINDOWS (PLUG-AND-PLAY)
======================================

Como instalar (sem terminal e sem instalar Node.js):
1. Extraia todos os arquivos deste ZIP para uma pasta.
2. De dois cliques em "Instalar Continuum.vbs".
3. Pronto! O Continuum cria o atalho com icone proprio na Area de Trabalho e no Menu Iniciar,
   inicia a ponte nativa na bandeja do Windows e abre o app em janela dedicada.

Malha configurada automaticamente: ${room}
Servidor: ${ctx.appUrl}
Log de diagnostico: %LOCALAPPDATA%\\Continuum\\bridge.log
Para remover a qualquer momento, execute "Desinstalar Continuum.vbs".
`);

  const entries: ZipEntryInput[] = [
    { name: 'Continuum-Windows/Instalar Continuum.vbs', content: installVbs },
    { name: 'Continuum-Windows/Continuum.vbs', content: launcherVbs },
    { name: 'Continuum-Windows/ContinuumBridge.ps1', content: bridgePs1 },
    { name: 'Continuum-Windows/Desinstalar Continuum.vbs', content: uninstallVbs },
    { name: 'Continuum-Windows/LEIA-ME.txt', content: readmeTxt },
  ];

  const png192 = readPublicAsset('pwa-192x192.png');
  if (png192) {
    entries.push({ name: 'Continuum-Windows/continuum.ico', content: buildIcoFromPng(png192) });
  }
  const svg = readPublicAsset('icon.svg');
  if (svg) entries.push({ name: 'Continuum-Windows/continuum.svg', content: svg });

  return buildZipBuffer(entries);
}

export function buildLinuxBridgePython(room: string, wsUrl: string): string {
  return `#!/usr/bin/env python3
"""
Continuum Native Linux Bridge (Pure Python 3 Stdlib - Zero pip install)
Conecta o sistema Linux a malha Continuum com Host TLS compativel com proxies reversos,
deteccao X11/Wayland, controle PipeWire/PulseAudio, cursor absoluto (Second Screen)
e log de diagnostico em ~/.local/share/continuum/bridge.log.
"""

import base64
import datetime
import glob
import json
import os
import shutil
import socket
import ssl
import struct
import subprocess
import time
import urllib.parse

ROOM_CODE = os.environ.get("CONTINUUM_ROOM_CODE") or ${JSON.stringify(room)}
WS_URL = os.environ.get("CONTINUUM_WS_URL") or ${JSON.stringify(wsUrl)}
HOSTNAME = socket.gethostname() or "Estacao Linux"
DEVICE_ID = "linux-native-" + "".join(c for c in HOSTNAME.lower() if c.isalnum())[:14]
LOG_DIR = os.path.expanduser("~/.local/share/continuum")
LOG_FILE = os.path.join(LOG_DIR, "bridge.log")

_prev_cpu = None


def log_msg(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\\n")
    except Exception:
        pass


def detect_display_server():
    session = (os.environ.get("XDG_SESSION_TYPE") or "").lower()
    if session == "wayland" or os.environ.get("WAYLAND_DISPLAY"):
        return "wayland"
    return "x11"


def sample_cpu_percent():
    global _prev_cpu
    try:
        with open("/proc/stat", "r", encoding="utf-8") as f:
            parts = [int(x) for x in f.readline().split()[1:8]]
        idle = parts[3] + parts[4]
        total = sum(parts)
        if _prev_cpu is None:
            _prev_cpu = (idle, total)
            return 0
        d_idle = idle - _prev_cpu[0]
        d_total = total - _prev_cpu[1]
        _prev_cpu = (idle, total)
        if d_total <= 0:
            return 0
        return max(0, min(100, round((1.0 - d_idle / d_total) * 100)))
    except Exception:
        return None


def sample_memory_gb():
    try:
        info = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if ":" in line:
                    k, v = line.split(":", 1)
                    info[k.strip()] = int(v.strip().split()[0])
        total = round(info.get("MemTotal", 0) / (1024 * 1024), 1)
        avail = round(info.get("MemAvailable", 0) / (1024 * 1024), 1)
        used = round(max(0.0, total - avail), 1)
        return total, used
    except Exception:
        return None, None


def sample_battery():
    try:
        caps = glob.glob("/sys/class/power_supply/BAT*/capacity")
        if not caps:
            return None, None
        with open(caps[0], "r", encoding="utf-8") as f:
            level = int(f.read().strip())
        status_path = os.path.join(os.path.dirname(caps[0]), "status")
        with open(status_path, "r", encoding="utf-8") as f:
            charging = f.read().strip().lower() == "charging"
        return level, charging
    except Exception:
        return None, None


def get_display_geometry():
    try:
        if shutil.which("xdotool"):
            out = subprocess.check_output(["xdotool", "getdisplaygeometry"], stderr=subprocess.DEVNULL, timeout=1.0).decode("utf-8", "ignore").strip()
            parts = out.split()
            if len(parts) == 2:
                return int(parts[0]), int(parts[1])
    except Exception:
        pass
    return 1920, 1080


def list_open_windows():
    try:
        if not shutil.which("wmctrl"):
            return []
        out = subprocess.check_output(["wmctrl", "-l"], stderr=subprocess.DEVNULL, timeout=1.5).decode("utf-8", "ignore")
        apps = []
        for idx, line in enumerate(out.splitlines()[:8]):
            parts = line.split(None, 3)
            if len(parts) == 4:
                title = parts[3].strip()
                apps.append({
                    "id": f"lin-{idx}-{parts[0]}",
                    "name": title.split(" - ")[-1][:24] or "App",
                    "title": title[:80],
                    "source": "os-agent",
                    "focused": idx == 0,
                })
        return apps
    except Exception:
        return []


def move_cursor_normalized(nx, ny):
    w, h = get_display_geometry()
    tx = max(0, min(w - 1, int(round(float(nx) * w))))
    ty = max(0, min(h - 1, int(round(float(ny) * h))))
    if shutil.which("xdotool"):
        subprocess.Popen(["xdotool", "mousemove", str(tx), str(ty)])


def adjust_volume(action):
    # Suporta PipeWire (Ubuntu 24.04 / Fedora) e PulseAudio (Ubuntu 22.04 / Mint)
    if shutil.which("wpctl"):
        if action == "vol_up":
            subprocess.Popen(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%+"])
            return
        if action == "vol_down":
            subprocess.Popen(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"])
            return
        if action == "vol_mute":
            subprocess.Popen(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"])
            return
    if shutil.which("pactl"):
        if action == "vol_up":
            subprocess.Popen(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "+5%"])
        elif action == "vol_down":
            subprocess.Popen(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "-5%"])
        elif action == "vol_mute":
            subprocess.Popen(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle"])


def handle_native_input(inp):
    kind = inp.get("kind")
    try:
        if kind == "move":
            dx, dy = inp.get("dx"), inp.get("dy")
            nx, ny = inp.get("nx"), inp.get("ny")
            if isinstance(dx, (int, float)) and isinstance(dy, (int, float)):
                if shutil.which("xdotool"):
                    subprocess.Popen(["xdotool", "mousemove_relative", "--", str(int(dx)), str(int(dy))])
                elif shutil.which("ydotool"):
                    subprocess.Popen(["ydotool", "mousemove", "--", str(int(dx)), str(int(dy))])
            elif isinstance(nx, (int, float)) and isinstance(ny, (int, float)):
                move_cursor_normalized(nx, ny)
        elif kind == "click":
            nx, ny = inp.get("nx"), inp.get("ny")
            if isinstance(nx, (int, float)) and isinstance(ny, (int, float)):
                move_cursor_normalized(nx, ny)
            btn = "3" if inp.get("button") == "right" else "2" if inp.get("button") == "middle" else "1"
            if shutil.which("xdotool"):
                subprocess.Popen(["xdotool", "click", btn])
        elif kind == "scroll":
            dy = inp.get("dy", 0)
            if shutil.which("xdotool"):
                subprocess.Popen(["xdotool", "click", "5" if dy > 0 else "4"])
        elif kind == "text" and inp.get("text"):
            if shutil.which("xdotool"):
                subprocess.Popen(["xdotool", "type", "--delay", "1", str(inp["text"])])
        elif kind == "key" and inp.get("key"):
            key_map = {"Enter": "Return", "Backspace": "BackSpace", "Escape": "Escape", "Tab": "Tab", "Meta": "Super_L"}
            k = key_map.get(inp["key"], inp["key"])
            if inp.get("ctrl"):
                k = f"ctrl+{k}"
            if inp.get("alt"):
                k = f"alt+{k}"
            if shutil.which("xdotool"):
                subprocess.Popen(["xdotool", "key", k])
        elif kind == "command":
            act = inp.get("action")
            if act in ("vol_up", "vol_down", "vol_mute"):
                adjust_volume(act)
            elif act == "media_play_pause" and shutil.which("playerctl"):
                subprocess.Popen(["playerctl", "play-pause"])
            elif act == "media_next" and shutil.which("playerctl"):
                subprocess.Popen(["playerctl", "next"])
            elif act == "media_prev" and shutil.which("playerctl"):
                subprocess.Popen(["playerctl", "previous"])
            elif act == "lock":
                subprocess.Popen(["loginctl", "lock-session"])
            elif act == "ping" and shutil.which("notify-send"):
                subprocess.Popen(["notify-send", "Continuum", "Ping de diagnostico recebido neste Linux."])
            elif act == "open_url":
                url = str(inp.get("payload", ""))
                if url.startswith(("http://", "https://")):
                    subprocess.Popen(["xdg-open", url])
    except Exception as exc:
        log_msg(f"Aviso ao executar comando nativo: {exc}")


class SimpleWS:
    def __init__(self, url):
        parsed = urllib.parse.urlparse(url)
        is_tls = parsed.scheme == "wss"
        host = parsed.hostname
        port = parsed.port or (443 if is_tls else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        # RFC-6455 / HTTP 1.1: omit default ports (:443 for wss, :80 for ws) in Host header
        default_port = 443 if is_tls else 80
        host_header = host if port == default_port else f"{host}:{port}"
        origin_proto = "https" if is_tls else "http"

        raw_sock = socket.create_connection((host, port), timeout=12)
        if is_tls:
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            self.sock = raw_sock

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {path} HTTP/1.1\\r\\n"
            f"Host: {host_header}\\r\\n"
            f"Origin: {origin_proto}://{host_header}\\r\\n"
            "Upgrade: websocket\\r\\n"
            "Connection: Upgrade\\r\\n"
            f"Sec-WebSocket-Key: {key}\\r\\n"
            "Sec-WebSocket-Version: 13\\r\\n\\r\\n"
        )
        self.sock.sendall(req.encode("ascii"))
        resp = b""
        while b"\\r\\n\\r\\n" not in resp:
            chunk = self.sock.recv(2048)
            if not chunk:
                raise ConnectionError("Handshake fechado pelo servidor")
            resp += chunk
        status_line = resp.split(b"\\r\\n", 1)[0].decode("ascii", "ignore")
        if "101" not in status_line:
            if "302" in status_line or "401" in status_line or "403" in status_line:
                raise ConnectionError(
                    f"Servidor exigiu autenticacao ({status_line}). Use a URL compartilhada (publica) ou local na central Instalar Apps."
                )
            raise ConnectionError(f"Falha no upgrade WebSocket: {status_line}")
        self.sock.settimeout(0.25)
        self._frag_buf = bytearray()

    def _send_frame(self, opcode, payload):
        mask = os.urandom(4)
        header = bytearray([0x80 | (opcode & 0x0F)])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(payload[i] ^ mask[i % 4] for i in range(length))
        self.sock.sendall(bytes(header) + masked)

    def send_json(self, obj):
        self._send_frame(0x1, json.dumps(obj).encode("utf-8"))

    def send_ping(self):
        self._send_frame(0x9, b"ping")

    def recv_exact(self, n):
        buf = bytearray()
        self.sock.settimeout(5.0)
        try:
            while len(buf) < n:
                chunk = self.sock.recv(n - len(buf))
                if not chunk:
                    raise ConnectionError("Socket fechado durante leitura")
                buf.extend(chunk)
            return bytes(buf)
        finally:
            self.sock.settimeout(0.25)

    def poll_message(self):
        try:
            head = self.sock.recv(2)
        except socket.timeout:
            return None
        if not head:
            raise ConnectionError("Conexao encerrada pelo servidor")
        if len(head) < 2:
            head += self.recv_exact(2 - len(head))
        fin = (head[0] & 0x80) != 0
        opcode = head[0] & 0x0F
        masked = (head[1] & 0x80) != 0
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", self.recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self.recv_exact(8))[0]
        mask_key = self.recv_exact(4) if masked else None
        data = self.recv_exact(length) if length > 0 else b""
        if mask_key:
            data = bytes(data[i] ^ mask_key[i % 4] for i in range(len(data)))
        if opcode == 0x8:
            raise ConnectionError("Frame de fechamento recebido")
        if opcode == 0x9:
            self._send_frame(0xA, data[:125])
            return None
        if opcode == 0xA:
            return None
        if opcode in (0x0, 0x1):
            self._frag_buf.extend(data)
            if fin:
                full = bytes(self._frag_buf)
                self._frag_buf.clear()
                return json.loads(full.decode("utf-8", "ignore"))
        return None

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def main():
    display_srv = detect_display_server()
    log_msg(f"Iniciando ponte nativa Linux ({display_srv}) para malha {ROOM_CODE} em {WS_URL}")
    while True:
        ws = None
        try:
            ws = SimpleWS(WS_URL)
            ws.send_json({
                "type": "companion:register",
                "roomCode": ROOM_CODE,
                "deviceId": DEVICE_ID,
                "name": HOSTNAME,
                "os": "linux",
                "displayServer": display_srv,
            })
            log_msg(f"Conectado a malha {ROOM_CODE} como {HOSTNAME}.")
            last_push = 0.0
            last_ping = time.time()
            while True:
                now = time.time()
                if now - last_push >= 4.0:
                    last_push = now
                    total_gb, used_gb = sample_memory_gb()
                    bat_lvl, bat_chg = sample_battery()
                    ws.send_json({
                        "type": "companion:telemetry",
                        "telemetry": {
                            "cpuCores": os.cpu_count(),
                            "cpuUsage": sample_cpu_percent(),
                            "memoryTotalGb": total_gb,
                            "memoryUsedGb": used_gb,
                            "batteryLevel": bat_lvl,
                            "batteryCharging": bat_chg,
                            "displayServer": display_srv,
                            "openApps": list_open_windows(),
                        },
                    })
                if now - last_ping >= 20.0:
                    last_ping = now
                    ws.send_ping()
                msg = ws.poll_message()
                if msg and msg.get("type") == "input:event" and msg.get("input"):
                    handle_native_input(msg["input"])
        except Exception as exc:
            log_msg(f"Desconectado ({exc}). Reconectando em 3s...")
            time.sleep(3)
        finally:
            if ws:
                ws.close()


if __name__ == "__main__":
    main()
`;
}

function buildLinuxLauncherScript(bridgePath: string, appUrl: string): string {
  return `#!/usr/bin/env bash
APP_URL="${appUrl}"
BRIDGE_PATH="${bridgePath}"

# Inicia a ponte nativa em segundo plano (evita duplicatas)
if [ -f "$BRIDGE_PATH" ] && ! pgrep -f "$BRIDGE_PATH" >/dev/null 2>&1; then
  nohup python3 "$BRIDGE_PATH" >/dev/null 2>&1 &
fi

# Abre o Continuum em modo aplicativo dedicado (sem barra de endereco)
for BROWSER in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge vivaldi; do
  if command -v "$BROWSER" >/dev/null 2>&1; then
    nohup "$BROWSER" --app="$APP_URL" --class=Continuum >/dev/null 2>&1 &
    exit 0
  fi
done

if command -v firefox >/dev/null 2>&1; then
  nohup firefox --new-window "$APP_URL" >/dev/null 2>&1 &
  exit 0
fi

if command -v gio >/dev/null 2>&1; then
  nohup gio open "$APP_URL" >/dev/null 2>&1 &
  exit 0
fi

if command -v xdg-open >/dev/null 2>&1; then
  nohup xdg-open "$APP_URL" >/dev/null 2>&1 &
  exit 0
fi
`;
}

/**
 * LINUX NATIVE `.deb` PACKAGE (Ubuntu, Debian, Linux Mint, Pop!_OS, Zorin, Elementary)
 * Double-click -> Opens Software Center / Discover / GDebi -> 1 click "Install" -> Zero terminal!
 */
export function buildLinuxDebPackage(ctx: InstallerContext): Buffer {
  const room = safeStr(ctx.roomCode);
  const appUrl = safeStr(`${ctx.appUrl}/?room=${room}`);
  const wsUrl = safeStr(ctx.wsUrl);

  const bridgePy = buildLinuxBridgePython(room, wsUrl);
  const launchBin = buildLinuxLauncherScript('/usr/share/continuum/continuum_bridge.py', appUrl);

  const desktopEntry = `[Desktop Entry]
Type=Application
Version=1.0
Name=Continuum
GenericName=Second Screen and Device Mesh
Comment=Ecossistema Multiplataforma e Monitor Secundario sem Fio (Malha ${room})
Exec=/usr/bin/continuum
Icon=continuum
Terminal=false
Categories=Network;Utility;System;
StartupWMClass=Continuum
`;

  const dataEntries: TarEntry[] = [
    { name: './usr/bin/continuum', content: launchBin, mode: 0o755 },
    { name: './usr/share/continuum/continuum_bridge.py', content: bridgePy, mode: 0o755 },
    { name: './usr/share/applications/continuum.desktop', content: desktopEntry, mode: 0o644 },
  ];

  const svg = readPublicAsset('icon.svg');
  if (svg) {
    dataEntries.push({
      name: './usr/share/icons/hicolor/scalable/apps/continuum.svg',
      content: svg,
      mode: 0o644,
    });
  }

  const png512 = readPublicAsset('pwa-512x512.png');
  if (png512) {
    dataEntries.push({
      name: './usr/share/icons/hicolor/512x512/apps/continuum.png',
      content: png512,
      mode: 0o644,
    });
  }

  const totalBytes = dataEntries.reduce(
    (acc, item) => acc + (typeof item.content === 'string' ? Buffer.byteLength(item.content, 'utf8') : item.content.length),
    0
  );
  const installedSizeKb = Math.max(16, Math.ceil(totalBytes / 1024));

  const controlFile = `Package: continuum-mesh
Version: 1.1.1
Section: utils
Priority: optional
Architecture: all
Installed-Size: ${installedSizeKb}
Depends: python3
Recommends: xdotool, wmctrl, pulseaudio-utils | wireplumber, playerctl
Maintainer: Continuum <support@continuum.local>
Homepage: ${ctx.appUrl}
Description: Continuum - Ecossistema Multiplataforma e Second Screen
 Aplicativo multiplataforma em tempo real para integracao de dispositivos,
 Second Screen sem fio, controle remoto de mouse/teclado e transferencia de arquivos.
 Malha configurada: ${room}
`;

  const postinst = `#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi
exit 0
`;

  const postrm = `#!/bin/sh
set -e
pkill -f "/usr/share/continuum/continuum_bridge.py" >/dev/null 2>&1 || true
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
exit 0
`;

  const controlEntries: TarEntry[] = [
    { name: './control', content: controlFile, mode: 0o644 },
    { name: './postinst', content: postinst, mode: 0o755 },
    { name: './postrm', content: postrm, mode: 0o755 },
  ];

  return buildDebPackage(controlEntries, dataEntries);
}

/**
 * LINUX UNIVERSAL PLUG-AND-PLAY PACKAGE (.ZIP for Fedora, Arch, Manjaro, openSUSE, SteamOS)
 */
export function buildLinuxInstallerZip(ctx: InstallerContext): Buffer {
  const room = safeStr(ctx.roomCode);
  const appUrl = safeStr(`${ctx.appUrl}/?room=${room}`);
  const wsUrl = safeStr(ctx.wsUrl);

  const installDesktop = `[Desktop Entry]
Type=Application
Version=1.0
Name=Instalar Continuum
Comment=Instala o aplicativo Continuum no Menu de Aplicativos
Exec=python3 -c "import os,sys,subprocess,urllib.parse; p=sys.argv[1] if len(sys.argv)>1 else ''; p=urllib.parse.unquote(p[7:]) if p.startswith('file://') else p; d=os.path.dirname(os.path.abspath(p)) if p else os.getcwd(); subprocess.Popen(['/bin/bash', os.path.join(d, 'install-gui.sh')])" %k
Icon=utilities-system-monitor
Terminal=false
Categories=Utility;Network;
`;

  const installGuiSh = `#!/usr/bin/env bash

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/.local/share/continuum"
DESKTOP_DIR="$HOME/.local/share/applications"
LOG_FILE="$APP_DIR/install.log"

show_dialog() {
  local kind="$1"
  local msg="$2"
  if command -v zenity >/dev/null 2>&1; then
    if [ "$kind" = "error" ]; then
      zenity --error --title="Continuum para Linux" --text="$msg" --width=380 2>/dev/null || true
    else
      zenity --info --title="Continuum para Linux" --text="$msg" --width=380 2>/dev/null || true
    fi
  elif command -v kdialog >/dev/null 2>&1; then
    if [ "$kind" = "error" ]; then
      kdialog --error "$msg" --title "Continuum para Linux" 2>/dev/null || true
    else
      kdialog --msgbox "$msg" --title "Continuum para Linux" 2>/dev/null || true
    fi
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$kind" "$msg" <<'PYEOF' 2>/dev/null || true
import sys
try:
    import tkinter as tk
    from tkinter import messagebox
    root = tk.Tk()
    root.withdraw()
    if sys.argv[1] == "error":
        messagebox.showerror("Continuum para Linux", sys.argv[2])
    else:
        messagebox.showinfo("Continuum para Linux", sys.argv[2])
except Exception:
    pass
PYEOF
  fi
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "Continuum" "$msg" 2>/dev/null || true
  fi
}

mkdir -p "$APP_DIR" "$DESKTOP_DIR" 2>/dev/null || {
  show_dialog "error" "Nao foi possivel criar a pasta de instalacao em $APP_DIR."
  exit 1
}

{
  echo "[Continuum] Instalando a partir de: $SRC_DIR"
  cp -f "$SRC_DIR/continuum-launch.sh" "$APP_DIR/continuum-launch.sh"
  cp -f "$SRC_DIR/continuum_bridge.py" "$APP_DIR/continuum_bridge.py"
  cp -f "$SRC_DIR/uninstall-gui.sh" "$APP_DIR/uninstall-gui.sh"
  if [ -f "$SRC_DIR/continuum.svg" ]; then
    cp -f "$SRC_DIR/continuum.svg" "$APP_DIR/continuum.svg"
  fi
  chmod +x "$APP_DIR/continuum-launch.sh" "$APP_DIR/continuum_bridge.py" "$APP_DIR/uninstall-gui.sh"
} >"$LOG_FILE" 2>&1 || {
  show_dialog "error" "Erro ao copiar arquivos do Continuum. Veja o log em: $LOG_FILE"
  exit 1
}

ICON_PATH="$APP_DIR/continuum.svg"
if [ ! -f "$ICON_PATH" ]; then
  ICON_PATH="utilities-system-monitor"
fi

cat > "$DESKTOP_DIR/continuum.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Continuum
GenericName=Second Screen and Device Mesh
Comment=Ecossistema Multiplataforma e Monitor Secundario sem Fio (Malha ${room})
Exec=$APP_DIR/continuum-launch.sh
Icon=$ICON_PATH
Terminal=false
Categories=Network;Utility;System;
StartupWMClass=Continuum
EOF

chmod +x "$DESKTOP_DIR/continuum.desktop" || true

DESKTOP_USER_DIR=""
if command -v xdg-user-dir >/dev/null 2>&1; then
  DESKTOP_USER_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
fi
if [ -n "$DESKTOP_USER_DIR" ] && [ -d "$DESKTOP_USER_DIR" ] && [ "$DESKTOP_USER_DIR" != "$HOME" ]; then
  cp -f "$DESKTOP_DIR/continuum.desktop" "$DESKTOP_USER_DIR/continuum.desktop" 2>/dev/null || true
  chmod +x "$DESKTOP_USER_DIR/continuum.desktop" 2>/dev/null || true
  if command -v gio >/dev/null 2>&1; then
    gio set "$DESKTOP_USER_DIR/continuum.desktop" metadata::trusted true 2>/dev/null || true
  fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

MSG="$(printf 'Continuum instalado no Menu de Aplicativos!\n\nMalha pareada: %s\nO aplicativo sera aberto agora.' '${room}')"
show_dialog "info" "$MSG"

nohup "$APP_DIR/continuum-launch.sh" >/dev/null 2>&1 &
exit 0
`;

  const uninstallGuiSh = `#!/usr/bin/env bash
rm -rf "$HOME/.local/share/continuum" "$HOME/.local/share/applications/continuum.desktop"
pkill -f "continuum_bridge.py" >/dev/null 2>&1 || true
if command -v zenity >/dev/null 2>&1; then
  zenity --info --title="Continuum" --text="Continuum removido com sucesso." --width=300 2>/dev/null || true
elif command -v kdialog >/dev/null 2>&1; then
  kdialog --msgbox "Continuum removido com sucesso." --title "Continuum" 2>/dev/null || true
elif command -v notify-send >/dev/null 2>&1; then
  notify-send "Continuum" "Aplicativo removido com sucesso." 2>/dev/null || true
fi
`;

  const launchSh = buildLinuxLauncherScript('$HOME/.local/share/continuum/continuum_bridge.py', appUrl);
  const bridgePy = buildLinuxBridgePython(room, wsUrl);

  const readmeTxt = `CONTINUUM PARA LINUX (PACOTE UNIVERSAL)
=======================================

Para Ubuntu, Debian, Mint, Pop!_OS e Zorin OS:
- Recomendamos usar o instalador direto "Continuum-Linux.deb" (basta dar dois cliques).

Para Fedora, Arch, Manjaro, openSUSE e outras distros (este ZIP):
1. Extraia todos os arquivos deste ZIP em uma pasta.
2. Clique com o botao direito em "Instalar-Continuum.desktop" -> "Permitir Iniciar"
   (ou "Executar como programa" em "install-gui.sh") e de dois cliques.
3. O Continuum e registrado automaticamente no seu Menu de Aplicativos ja conectado
   a malha ${room}.

Servidor configurado: ${ctx.appUrl}
Log de diagnostico: ~/.local/share/continuum/bridge.log
`;

  const entries: ZipEntryInput[] = [
    { name: 'Continuum-Linux/Instalar-Continuum.desktop', content: installDesktop, executable: true },
    { name: 'Continuum-Linux/install-gui.sh', content: installGuiSh, executable: true },
    { name: 'Continuum-Linux/continuum-launch.sh', content: launchSh, executable: true },
    { name: 'Continuum-Linux/continuum_bridge.py', content: bridgePy, executable: true },
    { name: 'Continuum-Linux/uninstall-gui.sh', content: uninstallGuiSh, executable: true },
    { name: 'Continuum-Linux/LEIA-ME.txt', content: readmeTxt },
  ];

  const svg = readPublicAsset('icon.svg');
  if (svg) entries.push({ name: 'Continuum-Linux/continuum.svg', content: svg });

  return buildZipBuffer(entries);
}

/**
 * ANDROID NATIVE KOTLIN APP PROJECT PACKAGE (Pre-configured for 1-click APK build via GitHub Actions or Android Studio)
 */
export function buildAndroidNativeZip(ctx: InstallerContext): Buffer {
  const room = safeStr(ctx.roomCode);
  const appUrl = safeStr(`${ctx.appUrl}/?room=${room}&platform=android-native`);

  const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />

    <application
        android:allowBackup="true"
        android:label="Continuum"
        android:supportsRtl="true"
        android:theme="@style/Theme.Material3.Dark.NoActionBar"
        android:usesCleartextTraffic="true">
        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|screenSize|keyboardHidden|smallestScreenSize"
            android:exported="true"
            android:hardwareAccelerated="true"
            android:launchMode="singleTask">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

  const mainActivityKt = `package app.continuum.mesh

import android.annotation.SuppressLint
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        webView = WebView(this)
        setContentView(webView)

        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true

        webView.addJavascriptInterface(NativeDeviceBridge(), "ContinuumAndroid")
        webView.webViewClient = WebViewClient()
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                request.grant(request.resources)
            }
        }

        webView.loadUrl("${appUrl}")
    }

    inner class NativeDeviceBridge {
        @JavascriptInterface
        fun getDeviceModel(): String = "\${Build.MANUFACTURER} \${Build.MODEL}"

        @JavascriptInterface
        fun getBatteryPercent(): Int {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            return if (level >= 0 && scale > 0) (level * 100) / scale else -1
        }
    }
}
`;

  const appBuildGradle = `plugins {
    id("com.android.application") version "8.7.2"
    id("org.jetbrains.kotlin.android") version "2.0.21"
}

android {
    namespace = "app.continuum.mesh"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.continuum.mesh"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
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
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
}
`;

  const settingsGradle = `pluginManagement {
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

  const ghWorkflow = `name: Build Continuum Android APK
on:
  workflow_dispatch:
  push:
    branches: [ main ]
jobs:
  build-apk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - uses: gradle/actions/setup-gradle@v4
      - name: Build Debug APK
        run: gradle assembleDebug
      - uses: actions/upload-artifact@v4
        with:
          name: Continuum-Android-APK
          path: app/build/outputs/apk/debug/*.apk
`;

  const readmeTxt = `CONTINUUM PARA ANDROID - PROJETO NATIVO KOTLIN (APK)
====================================================

Este pacote contem o aplicativo Android nativo em Kotlin ja configurado
para a malha ${room} (${ctx.appUrl}), com modo imersivo tela cheia, tela sempre ativa
(FLAG_KEEP_SCREEN_ON) para Second Screen e ponte nativa de bateria/modelo.

Opcao mais rapida no celular (Zero compilacao):
- Abra o Continuum no Chrome do Android usando o QR Code e toque em "Instalar App".
  O Android instala automaticamente um WebAPK nativo na sua gaveta de apps.

Para gerar o arquivo .APK assinavel sem usar terminal:
1. Abra esta pasta no Android Studio e clique em Build -> Build APK(s); OU
2. Suba para um repositorio GitHub e clique em Actions -> Build Continuum Android APK.
`;

  return buildZipBuffer([
    { name: 'Continuum-Android/settings.gradle.kts', content: settingsGradle },
    { name: 'Continuum-Android/app/build.gradle.kts', content: appBuildGradle },
    { name: 'Continuum-Android/app/src/main/AndroidManifest.xml', content: manifestXml },
    { name: 'Continuum-Android/app/src/main/java/app/continuum/mesh/MainActivity.kt', content: mainActivityKt },
    { name: 'Continuum-Android/.github/workflows/build-apk.yml', content: ghWorkflow },
    { name: 'Continuum-Android/LEIA-ME.txt', content: readmeTxt },
  ]);
}
