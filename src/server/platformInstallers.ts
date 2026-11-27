import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZipBuffer, type ZipEntryInput } from './zipBuilder.ts';
import { buildDebPackage, type TarEntry } from './debBuilder.ts';
import { buildAppImageBinary, type AppDirEntry } from './appimageBuilder.ts';
import {
  buildAndroidNativeProjectEntries,
  buildLinuxNativeAppPy,
  buildWindowsNativeCsproj,
  buildWindowsNativeProgramCs,
  buildWindowsNsisScript,
} from './nativeAppsSource.ts';

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
 * WINDOWS 100% NATIVE DESKTOP APPLICATION (Zero Browser, Zero WebView, Zero Node.js, Zero Terminal)
 * Runs a real Windows Forms (.NET) dark desktop UI + System Tray + Win32 P/Invoke + ClientWebSocket,
 * and also bundles the C# .NET 8 single-file project source for standalone .exe compilation.
 */
export function buildWindowsInstallerZip(ctx: InstallerContext): Buffer {
  const room = safeStr(ctx.roomCode);
  const wsUrl = safeStr(ctx.wsUrl);
  const appUrl = safeStr(ctx.appUrl);

  const installVbs = toCRLF(`' Continuum - Instalador Nativo Plug-and-Play para Windows (Sem Navegador / Sem Terminal)
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
files = Array("Continuum.vbs", "ContinuumApp.ps1", "Desinstalar Continuum.vbs", "continuum.ico", "continuum.svg")
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
shortcut.Description = "Continuum - Aplicativo Nativo Windows (Malha Multiplataforma)"
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
startShortcut.Description = "Continuum - Aplicativo Nativo Windows (Malha Multiplataforma)"
startShortcut.IconLocation = iconPath
startShortcut.Save

Dim uninstShortcut
Set uninstShortcut = shell.CreateShortcut(startMenu & "\\Desinstalar Continuum.lnk")
uninstShortcut.TargetPath = "wscript.exe"
uninstShortcut.Arguments = """" & installDir & "\\Desinstalar Continuum.vbs"""
uninstShortcut.WorkingDirectory = installDir
uninstShortcut.IconLocation = "shell32.dll,31"
uninstShortcut.Save

MsgBox "Continuum Nativo instalado com sucesso!" & vbCrLf & vbCrLf & _
  "- Aplicativo Desktop 100% Nativo Windows (WinForms + Win32, sem navegador)." & vbCrLf & _
  "- Atalho criado na Area de Trabalho e no Menu Iniciar." & vbCrLf & _
  "- Malha pareada automaticamente: ${room}" & vbCrLf & vbCrLf & _
  "O Continuum sera aberto agora.", vbInformation, "Continuum para Windows"

shell.Run "wscript.exe """ & installDir & "\\Continuum.vbs""", 0, False
`);

  const launcherVbs = toCRLF(`' Continuum - Inicializador Nativo Windows (100% WinForms + Bandeja do Sistema, Sem Navegador)
Option Explicit
Dim fso, shell, appDir, appScript

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
appScript = appDir & "\\ContinuumApp.ps1"

shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File """ & appScript & """", 0, False
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
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -Command ""Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*ContinuumApp.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }""", 0, True
MsgBox "Continuum removido com sucesso.", vbInformation, "Continuum"
`);

  const nativeWinFormsAppPs1 = toCRLF(`# Continuum - Aplicativo Desktop 100% Nativo para Windows (.NET WinForms + Win32 + WebSocket)
# Zero navegador, zero WebView, zero Node.js, zero terminal.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

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
$DeviceName = "$($env:COMPUTERNAME) (Windows)"
$DeviceId = "win-app-" + ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9]', '')
$WshShell = New-Object -ComObject WScript.Shell
$LogDir = Join-Path $env:LOCALAPPDATA "Continuum"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir "continuum.log"

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\\ContinuumNativeDesktopAppMutex", [ref]$createdNew)
if (-not $createdNew) { exit 0 }

$cBg = [System.Drawing.Color]::FromArgb(9, 11, 14)
$cPanel = [System.Drawing.Color]::FromArgb(17, 21, 27)
$cText = [System.Drawing.Color]::FromArgb(241, 245, 249)
$cMuted = [System.Drawing.Color]::FromArgb(148, 163, 184)
$cAccent = [System.Drawing.Color]::FromArgb(59, 130, 246)
$cGreen = [System.Drawing.Color]::FromArgb(16, 185, 129)

$script:Running = $true
$script:AllowClose = $false
$script:Ws = $null
$script:Peers = @()
$script:TargetId = $null
$script:LastTrackPt = $null

function Write-AppLog($text) {
  try {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $text
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    if ($script:LogBox -and -not $script:LogBox.IsDisposed) {
      $script:LogBox.AppendText("$line\`r\`n")
    }
  } catch {}
}

function Send-WsJson($obj) {
  if ($null -eq $script:Ws -or $script:Ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { return }
  try {
    $json = ($obj | ConvertTo-Json -Depth 8 -Compress)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $seg = New-Object System.ArraySegment[byte](,$bytes)
    $script:Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait(1500) | Out-Null
  } catch {}
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
        if ($null -ne $evt.nx -and $null -ne $evt.ny) { Move-CursorNormalized $evt.nx $evt.ny }
        if ($evt.button -eq "right") {
          [ContinuumWin32]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
          [ContinuumWin32]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
        } else {
          [ContinuumWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
          [ContinuumWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        }
      }
      "scroll" {
        [ContinuumWin32]::mouse_event(0x0800, 0, 0, (-1 * [int]$evt.dy), [UIntPtr]::Zero)
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
        }
      }
    }
  } catch { Write-AppLog "Aviso ao executar acao Win32: $_" }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Continuum - Aplicativo Nativo Windows (Malha $RoomCode)"
$form.Size = New-Object System.Drawing.Size(920, 620)
$form.StartPosition = "CenterScreen"
$form.BackColor = $cBg
$form.ForeColor = $cText
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)

$icoFile = Join-Path $PSScriptRoot "continuum.ico"
if (Test-Path $icoFile) {
  try { $form.Icon = New-Object System.Drawing.Icon($icoFile) } catch {}
}

$topBar = New-Object System.Windows.Forms.Panel
$topBar.Dock = "Top"
$topBar.Height = 56
$topBar.BackColor = $cPanel
$form.Controls.Add($topBar)

$titleLbl = New-Object System.Windows.Forms.Label
$titleLbl.Text = "CONTINUUM"
$titleLbl.Font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$titleLbl.ForeColor = $cText
$titleLbl.Location = New-Object System.Drawing.Point(18, 14)
$titleLbl.AutoSize = $true
$topBar.Controls.Add($titleLbl)

$statusLbl = New-Object System.Windows.Forms.Label
$statusLbl.Text = "Conectando a malha $RoomCode..."
$statusLbl.ForeColor = $cMuted
$statusLbl.Location = New-Object System.Drawing.Point(155, 19)
$statusLbl.AutoSize = $true
$topBar.Controls.Add($statusLbl)

$roomBox = New-Object System.Windows.Forms.TextBox
$roomBox.Text = $RoomCode
$roomBox.Location = New-Object System.Drawing.Point(680, 14)
$roomBox.Width = 100
$roomBox.BackColor = $cBg
$roomBox.ForeColor = $cText
$roomBox.BorderStyle = "FixedSingle"
$topBar.Controls.Add($roomBox)

$reconnectBtn = New-Object System.Windows.Forms.Button
$reconnectBtn.Text = "Reconectar"
$reconnectBtn.Location = New-Object System.Drawing.Point(790, 12)
$reconnectBtn.Size = New-Object System.Drawing.Size(100, 30)
$reconnectBtn.FlatStyle = "Flat"
$reconnectBtn.BackColor = $cAccent
$reconnectBtn.ForeColor = $cText
$reconnectBtn.FlatAppearance.BorderSize = 0
$topBar.Controls.Add($reconnectBtn)

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = "Fill"
$form.Controls.Add($tabs)
$tabs.BringToFront()

$tabDevices = New-Object System.Windows.Forms.TabPage
$tabDevices.Text = "Dispositivos"
$tabDevices.BackColor = $cBg
$tabs.TabPages.Add($tabDevices)

$peerList = New-Object System.Windows.Forms.ListBox
$peerList.Location = New-Object System.Drawing.Point(18, 18)
$peerList.Size = New-Object System.Drawing.Size(860, 440)
$peerList.BackColor = $cPanel
$peerList.ForeColor = $cText
$peerList.BorderStyle = "FixedSingle"
$peerList.Font = New-Object System.Drawing.Font("Segoe UI", 10.5)
$tabDevices.Controls.Add($peerList)

$peerList.Add_SelectedIndexChanged({
  if ($peerList.SelectedIndex -ge 0 -and $peerList.SelectedIndex -lt $script:Peers.Count) {
    $script:TargetId = $script:Peers[$peerList.SelectedIndex].id
    Write-AppLog "Alvo selecionado: $($script:Peers[$peerList.SelectedIndex].name)"
  }
})

$tabRemote = New-Object System.Windows.Forms.TabPage
$tabRemote.Text = "Controle Remoto"
$tabRemote.BackColor = $cBg
$tabs.TabPages.Add($tabRemote)

$trackpad = New-Object System.Windows.Forms.Panel
$trackpad.Location = New-Object System.Drawing.Point(18, 18)
$trackpad.Size = New-Object System.Drawing.Size(860, 310)
$trackpad.BackColor = $cPanel
$trackpad.BorderStyle = "FixedSingle"
$tabRemote.Controls.Add($trackpad)

$tpHint = New-Object System.Windows.Forms.Label
$tpHint.Text = "TRACKPAD NATIVO WINDOWS — Arraste para mover o cursor remoto, clique esquerdo/direito no alvo selecionado"
$tpHint.ForeColor = $cMuted
$tpHint.Location = New-Object System.Drawing.Point(16, 16)
$tpHint.AutoSize = $true
$trackpad.Controls.Add($tpHint)

$trackpad.Add_MouseDown({
  param($s, $e)
  $script:LastTrackPt = $e.Location
})
$trackpad.Add_MouseMove({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left -and $null -ne $script:LastTrackPt -and $script:TargetId) {
    $dx = ($e.X - $script:LastTrackPt.X) * 2
    $dy = ($e.Y - $script:LastTrackPt.Y) * 2
    $script:LastTrackPt = $e.Location
    Send-WsJson @{ type = "input:event"; targetId = $script:TargetId; input = @{ kind = "move"; dx = $dx; dy = $dy } }
  }
})
$trackpad.Add_MouseClick({
  param($s, $e)
  if ($script:TargetId) {
    $btn = if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) { "right" } else { "left" }
    Send-WsJson @{ type = "input:event"; targetId = $script:TargetId; input = @{ kind = "click"; button = $btn } }
  }
})

$cmdDefs = @(
  @("Vol -", "vol_down", 18),
  @("Vol +", "vol_up", 128),
  @("Mudo", "vol_mute", 238),
  @("Play/Pause", "media_play_pause", 348),
  @("Proxima", "media_next", 478),
  @("Bloquear Tela", "lock", 588),
  @("Tocar Alerta", "ping", 728)
)
foreach ($d in $cmdDefs) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $d[0]
  $b.Tag = $d[1]
  $b.Location = New-Object System.Drawing.Point($d[2], 344)
  $b.Size = New-Object System.Drawing.Size(102, 34)
  $b.FlatStyle = "Flat"
  $b.BackColor = $cPanel
  $b.ForeColor = $cText
  $b.Add_Click({
    param($sender, $args)
    if ($script:TargetId) {
      Send-WsJson @{ type = "input:event"; targetId = $script:TargetId; input = @{ kind = "command"; action = $sender.Tag } }
      Write-AppLog "Comando enviado: $($sender.Tag)"
    }
  })
  $tabRemote.Controls.Add($b)
}

$remoteTxt = New-Object System.Windows.Forms.TextBox
$remoteTxt.Location = New-Object System.Drawing.Point(18, 396)
$remoteTxt.Size = New-Object System.Drawing.Size(720, 28)
$remoteTxt.BackColor = $cPanel
$remoteTxt.ForeColor = $cText
$tabRemote.Controls.Add($remoteTxt)

$sendTxtBtn = New-Object System.Windows.Forms.Button
$sendTxtBtn.Text = "Enviar Texto"
$sendTxtBtn.Location = New-Object System.Drawing.Point(748, 394)
$sendTxtBtn.Size = New-Object System.Drawing.Size(130, 30)
$sendTxtBtn.FlatStyle = "Flat"
$sendTxtBtn.BackColor = $cAccent
$sendTxtBtn.ForeColor = $cText
$sendTxtBtn.Add_Click({
  if ($script:TargetId -and $remoteTxt.Text) {
    Send-WsJson @{ type = "input:event"; targetId = $script:TargetId; input = @{ kind = "text"; text = $remoteTxt.Text } }
    $remoteTxt.Clear()
  }
})
$tabRemote.Controls.Add($sendTxtBtn)

$tabClip = New-Object System.Windows.Forms.TabPage
$tabClip.Text = "Clipboard & Arquivos"
$tabClip.BackColor = $cBg
$tabs.TabPages.Add($tabClip)

$clipBox = New-Object System.Windows.Forms.TextBox
$clipBox.Multiline = $true
$clipBox.Location = New-Object System.Drawing.Point(18, 18)
$clipBox.Size = New-Object System.Drawing.Size(860, 280)
$clipBox.BackColor = $cPanel
$clipBox.ForeColor = $cText
$tabClip.Controls.Add($clipBox)

$sendClipBtn = New-Object System.Windows.Forms.Button
$sendClipBtn.Text = "Enviar Clipboard para Malha"
$sendClipBtn.Location = New-Object System.Drawing.Point(18, 314)
$sendClipBtn.Size = New-Object System.Drawing.Size(220, 36)
$sendClipBtn.FlatStyle = "Flat"
$sendClipBtn.BackColor = $cAccent
$sendClipBtn.ForeColor = $cText
$sendClipBtn.Add_Click({
  $txt = $clipBox.Text
  if (-not $txt) { try { $txt = [System.Windows.Forms.Clipboard]::GetText() } catch {} }
  if ($txt) {
    Send-WsJson @{ type = "clipboard:push"; item = @{ id = [Guid]::NewGuid().ToString(); text = $txt; sourceName = $DeviceName; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } }
    Write-AppLog "Clipboard sincronizado com a malha."
  }
})
$tabClip.Controls.Add($sendClipBtn)

$tabSys = New-Object System.Windows.Forms.TabPage
$tabSys.Text = "Sistema & Log"
$tabSys.BackColor = $cBg
$tabs.TabPages.Add($tabSys)

$script:LogBox = New-Object System.Windows.Forms.TextBox
$script:LogBox.Multiline = $true
$script:LogBox.ReadOnly = $true
$script:LogBox.ScrollBars = "Vertical"
$script:LogBox.Location = New-Object System.Drawing.Point(18, 18)
$script:LogBox.Size = New-Object System.Drawing.Size(860, 440)
$script:LogBox.BackColor = $cPanel
$script:LogBox.ForeColor = $cMuted
$script:LogBox.Font = New-Object System.Drawing.Font("Consolas", 9.5)
$tabSys.Controls.Add($script:LogBox)

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = if ($form.Icon) { $form.Icon } else { [System.Drawing.SystemIcons]::Application }
$tray.Text = "Continuum - Malha $RoomCode"
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Abrir Continuum")
$openItem.Add_Click({ $form.Show(); $form.WindowState = "Normal"; $form.Activate() })
$exitItem = $menu.Items.Add("Encerrar Continuum")
$exitItem.Add_Click({ $script:AllowClose = $true; $script:Running = $false; $form.Close() })
$tray.ContextMenuStrip = $menu
$tray.Add_DoubleClick({ $form.Show(); $form.WindowState = "Normal"; $form.Activate() })

$form.Add_FormClosing({
  param($s, $e)
  if (-not $script:AllowClose) {
    $e.Cancel = $true
    $form.Hide()
  } else {
    $script:Running = $false
    $tray.Visible = $false
    $tray.Dispose()
  }
})

$reconnectBtn.Add_Click({
  $RoomCode = $roomBox.Text.Trim().ToUpper()
  if ($script:Ws) { try { $script:Ws.Abort() } catch {} }
  Write-AppLog "Reconectando na malha $RoomCode..."
})

$form.Show()
Write-AppLog "Continuum Desktop Nativo Windows iniciado (Malha: $RoomCode)."

$buffer = New-Object byte[] 65536
while ($script:Running -and -not $form.IsDisposed) {
  $script:Ws = New-Object System.Net.WebSockets.ClientWebSocket
  $script:Ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
  try {
    $statusLbl.Text = "Conectando a malha $RoomCode..."
    $statusLbl.ForeColor = $cMuted
    $connectTask = $script:Ws.ConnectAsync([Uri]$WsUrl, [System.Threading.CancellationToken]::None)
    while (-not $connectTask.IsCompleted -and $script:Running) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 30
    }
    if ($connectTask.IsFaulted) { throw $connectTask.Exception.InnerException }

    if ($script:Ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $statusLbl.Text = "Conectado na malha $RoomCode (Win32 Nativo)"
      $statusLbl.ForeColor = $cGreen
      $tray.Text = "Continuum - Conectado ($RoomCode)"
      Write-AppLog "Conectado com sucesso em $WsUrl"

      $tel = Collect-WindowsTelemetry
      Send-WsJson @{
        type = "mesh:join"
        roomCode = $RoomCode
        device = @{
          id = $DeviceId
          name = $DeviceName
          os = "windows"
          deviceType = "desktop"
          status = "online"
          companionConnected = $true
          telemetry = $tel
        }
      }

      $lastTelemetry = [DateTime]::UtcNow
      $msgStream = New-Object System.IO.MemoryStream
      $seg = New-Object System.ArraySegment[byte](,$buffer)
      $recvTask = $script:Ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)

      while ($script:Ws.State -eq [System.Net.WebSockets.WebSocketState]::Open -and $script:Running) {
        [System.Windows.Forms.Application]::DoEvents()
        if (([DateTime]::UtcNow - $lastTelemetry).TotalSeconds -ge 4) {
          $lastTelemetry = [DateTime]::UtcNow
          Send-WsJson @{ type = "device:telemetry"; telemetry = (Collect-WindowsTelemetry) }
        }
        if ($recvTask.IsCompleted) {
          if ($recvTask.IsFaulted) { throw $recvTask.Exception.InnerException }
          $res = $recvTask.Result
          if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
          if ($res.Count -gt 0) { $msgStream.Write($buffer, 0, $res.Count) }
          if ($res.EndOfMessage) {
            $txt = [System.Text.Encoding]::UTF8.GetString($msgStream.ToArray())
            $msgStream.SetLength(0)
            try {
              $msg = $txt | ConvertFrom-Json
              if ($msg.type -eq "mesh:state" -and $msg.devices) {
                $script:Peers = @($msg.devices | Where-Object { $_.id -ne $DeviceId })
                $peerList.Items.Clear()
                foreach ($p in $script:Peers) {
                  $peerList.Items.Add("$($p.name) [$($p.os)] - CPU $($p.telemetry.cpuUsage)%") | Out-Null
                }
                if (-not $script:TargetId -and $script:Peers.Count -gt 0) { $script:TargetId = $script:Peers[0].id }
              } elseif ($msg.type -eq "input:event" -and $msg.input) {
                Handle-NativeInput $msg.input
              } elseif ($msg.type -eq "clipboard:push" -and $msg.item -and $msg.item.text) {
                $clipBox.Text = $msg.item.text
                try { [System.Windows.Forms.Clipboard]::SetText($msg.item.text) } catch {}
              }
            } catch {}
          }
          $recvTask = $script:Ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)
        }
        Start-Sleep -Milliseconds 20
      }
      $msgStream.Dispose()
    }
  } catch {
    $statusLbl.Text = "Reconectando na malha $RoomCode..."
    $statusLbl.ForeColor = $cMuted
    Write-AppLog "Conexao interrompida: $_"
  } finally {
    try { $script:Ws.Dispose() } catch {}
  }

  for ($w = 0; $w -lt 60 -and $script:Running; $w++) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
  }
}
`);

  const readmeTxt = toCRLF(`CONTINUUM PARA WINDOWS — APLICATIVO 100% NATIVO (SEM NAVEGADOR / SEM WEBVIEW)
=============================================================================

Como instalar (plug-and-play, sem terminal e sem Node.js):
1. Extraia todos os arquivos deste ZIP para uma pasta.
2. De dois cliques em "Instalar Continuum.vbs".
3. Pronto! O Continuum cria o atalho com icone proprio na Area de Trabalho e no Menu Iniciar
   e abre o aplicativo desktop nativo Windows (WinForms + Win32 + Bandeja do Sistema).

Compilacao para .exe unico (.NET 8 opcional ou via GitHub Actions):
- A pasta "source/" contem o projeto C# .NET 8 (Continuum.Windows.csproj + Program.cs + installer.nsi)
  usado pelo GitHub Actions para compilar Continuum-Windows.exe e Continuum-Windows-Setup.exe.

Malha configurada automaticamente: ${room}
Servidor: ${appUrl}
Log de diagnostico: %LOCALAPPDATA%\\Continuum\\continuum.log
Para remover a qualquer momento, execute "Desinstalar Continuum.vbs".
`);

  const entries: ZipEntryInput[] = [
    { name: 'Continuum-Windows/Instalar Continuum.vbs', content: installVbs },
    { name: 'Continuum-Windows/Continuum.vbs', content: launcherVbs },
    { name: 'Continuum-Windows/ContinuumApp.ps1', content: nativeWinFormsAppPs1 },
    { name: 'Continuum-Windows/Desinstalar Continuum.vbs', content: uninstallVbs },
    { name: 'Continuum-Windows/LEIA-ME.txt', content: readmeTxt },
    { name: 'Continuum-Windows/source/Continuum.Windows.csproj', content: buildWindowsNativeCsproj() },
    { name: 'Continuum-Windows/source/Program.cs', content: buildWindowsNativeProgramCs(ctx) },
    { name: 'Continuum-Windows/source/installer.nsi', content: buildWindowsNsisScript() },
  ];

  const png192 = readPublicAsset('pwa-192x192.png');
  if (png192) {
    const ico = buildIcoFromPng(png192);
    entries.push({ name: 'Continuum-Windows/continuum.ico', content: ico });
    entries.push({ name: 'Continuum-Windows/source/continuum.ico', content: ico });
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
 * LINUX NATIVE `.deb` PACKAGE (Ubuntu, Debian, Linux Mint, Pop!_OS, Zorin OS)
 * 100% Native GTK 3 Desktop Application — ZERO browser / ZERO WebView!
 */
export function buildLinuxDebPackage(ctx: InstallerContext): Buffer {
  const room = safeStr(ctx.roomCode);
  const nativeAppPy = buildLinuxNativeAppPy(ctx);
  const launchBin = `#!/usr/bin/env bash
exec python3 /usr/share/continuum/continuum_app.py "$@"
`;

  const desktopEntry = `[Desktop Entry]
Type=Application
Version=1.0
Name=Continuum
GenericName=Native Device Mesh
Comment=Aplicativo Nativo Linux para Malha de Dispositivos e Controle Remoto (Malha ${room})
Exec=/usr/bin/continuum
Icon=continuum
Terminal=false
Categories=Network;Utility;System;
StartupWMClass=continuum_app.py
`;

  const dataEntries: TarEntry[] = [
    { name: './usr/bin/continuum', content: launchBin, mode: 0o755 },
    { name: './usr/share/continuum/continuum_app.py', content: nativeAppPy, mode: 0o755 },
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
  const installedSizeKb = Math.max(24, Math.ceil(totalBytes / 1024));

  const controlFile = `Package: continuum-mesh
Version: 2.0.0
Section: utils
Priority: optional
Architecture: all
Installed-Size: ${installedSizeKb}
Depends: python3, python3-gi, gir1.2-gtk-3.0
Recommends: xdotool, wmctrl, pulseaudio-utils | wireplumber, playerctl, libnotify-bin
Maintainer: Continuum <support@continuum.local>
Homepage: ${ctx.appUrl}
Description: Continuum - Aplicativo Nativo Linux (GTK 3)
 Aplicativo desktop nativo em GTK 3 (sem navegador e sem WebView) para malha
 de dispositivos em tempo real, trackpad/teclado remoto, clipboard universal,
 transferencia de arquivos e controle nativo do sistema operacional.
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
pkill -f "/usr/share/continuum/continuum_app.py" >/dev/null 2>&1 || true
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
 * LINUX NATIVE `.AppImage` EXECUTABLE (x86_64, Zero-FUSE, Universal: Zorin OS, Ubuntu, Fedora, Arch, Mint)
 * Self-contained ELF binary with Continuum.AppDir + GTK 3 native application.
 */
export function buildLinuxAppImage(ctx: InstallerContext): Buffer {
  const room = safeStr(ctx.roomCode);
  const nativeAppPy = buildLinuxNativeAppPy(ctx);

  const appRun = `#!/usr/bin/env bash
set -e
HERE="$(dirname "$(readlink -f "$0")")"
export APPDIR="\${APPDIR:-$HERE}"
exec python3 "$HERE/usr/share/continuum/continuum_app.py" "$@"
`;

  const desktopEntry = `[Desktop Entry]
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
X-AppImage-Version=2.0.0
`;

  const appdataXml = `<?xml version="1.0" encoding="UTF-8"?>
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
`;

  const entries: AppDirEntry[] = [
    { path: 'AppRun', content: appRun, mode: 0o755 },
    { path: 'continuum.desktop', content: desktopEntry, mode: 0o644 },
    { path: 'usr/bin/continuum', content: appRun, mode: 0o755 },
    { path: 'usr/share/continuum/continuum_app.py', content: nativeAppPy, mode: 0o755 },
    { path: 'usr/share/applications/continuum.desktop', content: desktopEntry, mode: 0o644 },
    { path: 'usr/share/metainfo/app.continuum.mesh.appdata.xml', content: appdataXml, mode: 0o644 },
  ];

  const png512 = readPublicAsset('pwa-512x512.png') ?? readPublicAsset('pwa-192x192.png');
  if (png512) {
    entries.push({ path: 'continuum.png', content: png512, mode: 0o644 });
    entries.push({ path: '.DirIcon', content: png512, mode: 0o644 });
    entries.push({ path: 'usr/share/icons/hicolor/512x512/apps/continuum.png', content: png512, mode: 0o644 });
  }

  const svg = readPublicAsset('icon.svg');
  if (svg) {
    entries.push({ path: 'usr/share/icons/hicolor/scalable/apps/continuum.svg', content: svg, mode: 0o644 });
  }

  return buildAppImageBinary(entries);
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
  echo "[Continuum] Instalando aplicativo nativo GTK 3 a partir de: $SRC_DIR"
  cp -f "$SRC_DIR/continuum-launch.sh" "$APP_DIR/continuum-launch.sh"
  cp -f "$SRC_DIR/continuum_app.py" "$APP_DIR/continuum_app.py"
  cp -f "$SRC_DIR/uninstall-gui.sh" "$APP_DIR/uninstall-gui.sh"
  if [ -f "$SRC_DIR/continuum.svg" ]; then
    cp -f "$SRC_DIR/continuum.svg" "$APP_DIR/continuum.svg"
  fi
  chmod +x "$APP_DIR/continuum-launch.sh" "$APP_DIR/continuum_app.py" "$APP_DIR/uninstall-gui.sh"
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
GenericName=Native Device Mesh
Comment=Aplicativo Nativo Linux GTK 3 (Malha ${room})
Exec=$APP_DIR/continuum-launch.sh
Icon=$ICON_PATH
Terminal=false
Categories=Network;Utility;System;
StartupWMClass=continuum_app.py
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

MSG="$(printf 'Continuum (App Nativo GTK 3) instalado no Menu de Aplicativos!\n\nMalha pareada: %s\nO aplicativo sera aberto agora.' '${room}')"
show_dialog "info" "$MSG"

nohup "$APP_DIR/continuum-launch.sh" >/dev/null 2>&1 &
exit 0
`;

  const uninstallGuiSh = `#!/usr/bin/env bash
rm -rf "$HOME/.local/share/continuum" "$HOME/.local/share/applications/continuum.desktop"
pkill -f "continuum_app.py" >/dev/null 2>&1 || true
if command -v zenity >/dev/null 2>&1; then
  zenity --info --title="Continuum" --text="Continuum removido com sucesso." --width=300 2>/dev/null || true
elif command -v kdialog >/dev/null 2>&1; then
  kdialog --msgbox "Continuum removido com sucesso." --title "Continuum" 2>/dev/null || true
elif command -v notify-send >/dev/null 2>&1; then
  notify-send "Continuum" "Aplicativo removido com sucesso." 2>/dev/null || true
fi
`;

  const launchSh = `#!/usr/bin/env bash
exec python3 "$HOME/.local/share/continuum/continuum_app.py" "$@"
`;
  const nativeAppPy = buildLinuxNativeAppPy(ctx);

  const readmeTxt = `CONTINUUM PARA LINUX (APLICATIVO NATIVO GTK 3 — SEM NAVEGADOR)
==============================================================

Para Ubuntu, Debian, Mint, Pop!_OS e Zorin OS:
- Recomendamos usar o instalador direto "Continuum-Linux.deb" (dois cliques).

Para Fedora, Arch, Manjaro, openSUSE e outras distros (este ZIP):
1. Extraia todos os arquivos deste ZIP em uma pasta.
2. Clique com o botao direito em "Instalar-Continuum.desktop" -> "Permitir Iniciar"
   (ou execute "install-gui.sh") e de dois cliques.
3. O Continuum nativo GTK 3 sera aberto e registrado no Menu de Aplicativos (Malha ${room}).

Servidor configurado: ${ctx.appUrl}
Log de diagnostico: ~/.local/share/continuum/app.log
`;

  const entries: ZipEntryInput[] = [
    { name: 'Continuum-Linux/Instalar-Continuum.desktop', content: installDesktop, executable: true },
    { name: 'Continuum-Linux/install-gui.sh', content: installGuiSh, executable: true },
    { name: 'Continuum-Linux/continuum-launch.sh', content: launchSh, executable: true },
    { name: 'Continuum-Linux/continuum_app.py', content: nativeAppPy, executable: true },
    { name: 'Continuum-Linux/uninstall-gui.sh', content: uninstallGuiSh, executable: true },
    { name: 'Continuum-Linux/LEIA-ME.txt', content: readmeTxt },
  ];

  const svg = readPublicAsset('icon.svg');
  if (svg) entries.push({ name: 'Continuum-Linux/continuum.svg', content: svg });

  return buildZipBuffer(entries);
}

/**
 * ANDROID 100% NATIVE KOTLIN APP PROJECT PACKAGE (ZERO WebView — Native UI + OkHttp WebSocket + Multi-Touch Trackpad)
 */
export function buildAndroidNativeZip(ctx: InstallerContext): Buffer {
  const room = safeStr(ctx.roomCode);
  const png192 = readPublicAsset('pwa-192x192.png');
  const projectEntries = buildAndroidNativeProjectEntries(ctx, png192, 'Continuum-Android');

  const ghWorkflow = `name: Build Continuum Android APK
on:
  workflow_dispatch:
  push:
    branches: [ main, master ]
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
        with:
          gradle-version: 8.7
      - name: Build Native Android APK
        run: gradle assembleDebug --no-daemon
      - uses: actions/upload-artifact@v4
        with:
          name: Continuum-Android-APK
          path: app/build/outputs/apk/debug/*.apk
`;

  const readmeTxt = `CONTINUUM PARA ANDROID — APLICATIVO 100% NATIVO KOTLIN (SEM WEBVIEW)
====================================================================

Este projeto compila um aplicativo Android 100% nativo em Kotlin + OkHttp WebSocket
(SEM WebView e SEM navegador), com:
- Interface nativa escura (Malha, Trackpad Multi-Toque, Arquivos & Clipboard, Alertas)
- Trackpad nativo multi-toque para controlar o cursor do Linux/Windows
- Sincronizacao nativa com ClipboardManager e envio/recebimento de arquivos
- Telemetria real de bateria (BatteryManager) e tela sempre ativa (FLAG_KEEP_SCREEN_ON)

Servidor padrao: ${ctx.appUrl}
Malha padrao: ${room}

Para gerar o arquivo .APK:
1. Abra no Android Studio e clique em Build -> Build APK(s); OU
2. Suba no GitHub e execute Actions -> Build Continuum Android APK.
`;

  return buildZipBuffer([
    ...projectEntries,
    { name: 'Continuum-Android/.github/workflows/build-apk.yml', content: ghWorkflow },
    { name: 'Continuum-Android/LEIA-ME.txt', content: readmeTxt },
  ]);
}
