# Continuum Native Windows Bridge (Headless — Supervised by Electron Desktop App)
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

$RoomCode = if ($env:CONTINUUM_ROOM_CODE) { $env:CONTINUUM_ROOM_CODE } else { "MESH01" }
$WsUrl = if ($env:CONTINUUM_WS_URL) { $env:CONTINUUM_WS_URL } else { "wss://ais-pre-a6iomfzcjhr5udpk6kpqgs-702819737353.us-east1.run.app/ws" }
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
$mutex = New-Object System.Threading.Mutex($true, "Global\ContinuumNativeBridgeMutex", [ref]$createdNew)
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
        $escaped = [string]$evt.text -replace '([+^%~(){}\[\]])', '{$1}'
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
