using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ContinuumNative;

internal static class Win32Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] public static extern bool LockWorkStation();
}

internal sealed class AppConfig
{
    public string ServerUrl { get; set; } = "https://ais-pre-a6iomfzcjhr5udpk6kpqgs-702819737353.us-east1.run.app";
    public string RoomCode { get; set; } = "MESH01";
}

internal sealed class MeshDevice
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Os { get; set; } = "";
    public string DisplayServer { get; set; } = "web";
    public string CpuText { get; set; } = "—";
    public string BatteryText { get; set; } = "CA";
}

internal sealed class ContinuumMainForm : Form
{
    private static readonly string ConfigDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Continuum");
    private static readonly string ConfigPath = Path.Combine(ConfigDir, "config.json");
    private static readonly string LogPath = Path.Combine(ConfigDir, "app.log");
    private static readonly string DownloadsDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Continuum");

    private readonly string _deviceId = "win-app-" + new string(Environment.MachineName.ToLowerInvariant().Where(char.IsLetterOrDigit).Take(16).ToArray());
    private AppConfig _cfg = LoadConfig();
    private readonly List<MeshDevice> _devices = new();
    private readonly Dictionary<string, (string FileName, int Total, Dictionary<int, string> Chunks)> _pendingFiles = new();

    private ClientWebSocket? _ws;
    private CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    private readonly TextBox _serverBox = new();
    private readonly TextBox _roomBox = new();
    private readonly Label _statusLabel = new();
    private readonly Label _footerLabel = new();
    private readonly ListView _devicesView = new();
    private readonly ComboBox _targetCombo = new();
    private readonly TextBox _remoteTextBox = new();
    private readonly TextBox _clipInputBox = new();
    private readonly ListBox _clipList = new();
    private readonly ListBox _notifList = new();
    private readonly NotifyIcon _tray = new();

    private Point? _lastDragPoint;
    private Point? _pressPoint;
    private bool _exiting;

    public ContinuumMainForm()
    {
        Text = "Continuum — Aplicativo Nativo Windows";
        Width = 980;
        Height = 680;
        MinimumSize = new Size(780, 560);
        BackColor = Color.FromArgb(9, 11, 14);
        ForeColor = Color.FromArgb(241, 245, 249);
        Font = new Font("Segoe UI", 9.5f);

        try
        {
            var exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (exeIcon != null) { Icon = exeIcon; _tray.Icon = exeIcon; }
        }
        catch { _tray.Icon = SystemIcons.Application; }

        BuildUi();
        SetupTray();

        Load += (_, _) => _ = RunMeshLoopAsync();
        FormClosing += (_, e) =>
        {
            if (!_exiting)
            {
                e.Cancel = true;
                Hide();
            }
        };
    }

    private static AppConfig LoadConfig()
    {
        var cfg = new AppConfig();
        try
        {
            if (File.Exists(ConfigPath))
            {
                var loaded = JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(ConfigPath));
                if (loaded != null) cfg = loaded;
            }
        }
        catch { }
        cfg.ServerUrl = (cfg.ServerUrl ?? "").Trim().TrimEnd('/');
        cfg.RoomCode = new string((cfg.RoomCode ?? "MESH01").ToUpperInvariant().Where(char.IsLetterOrDigit).Take(8).ToArray());
        if (cfg.RoomCode.Length < 4) cfg.RoomCode = "MESH01";
        return cfg;
    }

    private void SaveConfig()
    {
        try
        {
            Directory.CreateDirectory(ConfigDir);
            File.WriteAllText(ConfigPath, JsonSerializer.Serialize(_cfg, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    private static void Log(string msg)
    {
        try
        {
            Directory.CreateDirectory(ConfigDir);
            File.AppendAllText(LogPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {msg}{Environment.NewLine}");
        }
        catch { }
    }

    private void SetupTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Abrir Continuum", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add("Abrir Pasta de Recebidos", null, (_, _) =>
        {
            Directory.CreateDirectory(DownloadsDir);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(DownloadsDir) { UseShellExecute = true });
        });
        menu.Items.Add("Abrir Log", null, (_, _) =>
        {
            if (File.Exists(LogPath)) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(LogPath) { UseShellExecute = true });
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Encerrar Continuum", null, (_, _) =>
        {
            _exiting = true;
            _cts.Cancel();
            _tray.Visible = false;
            Application.Exit();
        });
        _tray.ContextMenuStrip = menu;
        _tray.Text = $"Continuum — Malha {_cfg.RoomCode}";
        _tray.Visible = true;
        _tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
    }

    private void BuildUi()
    {
        var topPanel = new Panel { Dock = DockStyle.Top, Height = 56, BackColor = Color.FromArgb(17, 21, 27), Padding = new Padding(12, 12, 12, 8) };
        var lblSrv = new Label { Text = "Servidor:", AutoSize = true, Left = 12, Top = 18, ForeColor = Color.FromArgb(148, 163, 184) };
        _serverBox.SetBounds(78, 14, 420, 28);
        _serverBox.BackColor = Color.FromArgb(9, 11, 14);
        _serverBox.ForeColor = Color.FromArgb(241, 245, 249);
        _serverBox.Text = _cfg.ServerUrl;

        var lblRoom = new Label { Text = "Malha:", AutoSize = true, Left = 510, Top = 18, ForeColor = Color.FromArgb(148, 163, 184) };
        _roomBox.SetBounds(562, 14, 96, 28);
        _roomBox.BackColor = Color.FromArgb(9, 11, 14);
        _roomBox.ForeColor = Color.FromArgb(241, 245, 249);
        _roomBox.MaxLength = 8;
        _roomBox.Text = _cfg.RoomCode;

        var connectBtn = MakeButton("Conectar", true);
        connectBtn.SetBounds(668, 13, 96, 28);
        connectBtn.Click += (_, _) =>
        {
            var url = _serverBox.Text.Trim().TrimEnd('/');
            var room = new string(_roomBox.Text.ToUpperInvariant().Where(char.IsLetterOrDigit).Take(8).ToArray());
            if ((url.StartsWith("http://") || url.StartsWith("https://")) && room.Length >= 4)
            {
                _cfg.ServerUrl = url;
                _cfg.RoomCode = room;
                SaveConfig();
                _cts.Cancel();
                _cts = new CancellationTokenSource();
                _ = RunMeshLoopAsync();
            }
        };

        _statusLabel.SetBounds(776, 18, 185, 22);
        _statusLabel.ForeColor = Color.FromArgb(96, 165, 250);
        _statusLabel.Text = "Conectando...";
        topPanel.Controls.AddRange(new Control[] { lblSrv, _serverBox, lblRoom, _roomBox, connectBtn, _statusLabel });

        var tabs = new TabControl { Dock = DockStyle.Fill };

        // Tab 1: Devices
        var tabDevices = new TabPage("Dispositivos") { BackColor = Color.FromArgb(9, 11, 14), Padding = new Padding(12) };
        _devicesView.Dock = DockStyle.Fill;
        _devicesView.View = View.Details;
        _devicesView.FullRowSelect = true;
        _devicesView.BackColor = Color.FromArgb(17, 21, 27);
        _devicesView.ForeColor = Color.FromArgb(241, 245, 249);
        _devicesView.Columns.Add("Dispositivo", 260);
        _devicesView.Columns.Add("Sistema", 110);
        _devicesView.Columns.Add("Ponte", 100);
        _devicesView.Columns.Add("CPU", 100);
        _devicesView.Columns.Add("Bateria", 100);
        var pingBtn = MakeButton("Localizar Selecionado", false);
        pingBtn.Dock = DockStyle.Bottom;
        pingBtn.Height = 36;
        pingBtn.Click += async (_, _) =>
        {
            if (_devicesView.SelectedItems.Count > 0 && _devicesView.SelectedItems[0].Tag is string targetId)
            {
                await SendJsonAsync(new { type = "input:event", toDeviceId = targetId, input = new { kind = "command", action = "ping" } });
            }
        };
        tabDevices.Controls.Add(_devicesView);
        tabDevices.Controls.Add(pingBtn);

        // Tab 2: Remote Control
        var tabRemote = new TabPage("Controle Remoto") { BackColor = Color.FromArgb(9, 11, 14), Padding = new Padding(12) };
        _targetCombo.Dock = DockStyle.Top;
        _targetCombo.DropDownStyle = ComboBoxStyle.DropDownList;
        _targetCombo.BackColor = Color.FromArgb(17, 21, 27);
        _targetCombo.ForeColor = Color.FromArgb(241, 245, 249);

        var pad = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(17, 21, 27), BorderStyle = BorderStyle.FixedSingle };
        var padHint = new Label { Text = "Trackpad Nativo Win32 — arraste para mover cursor remoto, clique esquerdo/direito ou use a roda do mouse", Left = 14, Top = 14, AutoSize = true, ForeColor = Color.FromArgb(148, 163, 184) };
        pad.Controls.Add(padHint);
        pad.MouseDown += (_, e) => { _lastDragPoint = e.Location; _pressPoint = e.Location; };
        pad.MouseMove += async (_, e) =>
        {
            if (_lastDragPoint == null) return;
            int dx = (int)((e.X - _lastDragPoint.Value.X) * 1.8);
            int dy = (int)((e.Y - _lastDragPoint.Value.Y) * 1.8);
            _lastDragPoint = e.Location;
            if (Math.Abs(dx) >= 1 || Math.Abs(dy) >= 1)
                await SendRemoteInputAsync(new { kind = "move", nx = 0.5, ny = 0.5, dx, dy });
        };
        pad.MouseUp += async (_, e) =>
        {
            if (_pressPoint != null && Math.Abs(e.X - _pressPoint.Value.X) < 4 && Math.Abs(e.Y - _pressPoint.Value.Y) < 4)
                await SendRemoteInputAsync(new { kind = "click", button = e.Button == MouseButtons.Right ? "right" : "left" });
            _lastDragPoint = null;
        };
        pad.MouseWheel += async (_, e) => await SendRemoteInputAsync(new { kind = "scroll", dx = 0, dy = e.Delta > 0 ? -90 : 90 });

        var remoteBottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 82, BackColor = Color.FromArgb(9, 11, 14), Padding = new Padding(0, 8, 0, 0) };
        _remoteTextBox.Width = 420;
        _remoteTextBox.BackColor = Color.FromArgb(17, 21, 27);
        _remoteTextBox.ForeColor = Color.FromArgb(241, 245, 249);
        var btnSendTxt = MakeButton("Enviar Texto", true);
        btnSendTxt.Click += async (_, _) => { if (!string.IsNullOrEmpty(_remoteTextBox.Text)) { await SendRemoteInputAsync(new { kind = "text", text = _remoteTextBox.Text }); _remoteTextBox.Clear(); } };
        var btnEnter = MakeButton("Enter", false);
        btnEnter.Click += async (_, _) => await SendRemoteInputAsync(new { kind = "key", key = "Enter" });
        var btnVolDown = MakeButton("Vol -", false);
        btnVolDown.Click += async (_, _) => await SendRemoteInputAsync(new { kind = "command", action = "vol_down" });
        var btnVolUp = MakeButton("Vol +", false);
        btnVolUp.Click += async (_, _) => await SendRemoteInputAsync(new { kind = "command", action = "vol_up" });
        var btnPlay = MakeButton("Play/Pause", false);
        btnPlay.Click += async (_, _) => await SendRemoteInputAsync(new { kind = "command", action = "media_play_pause" });
        var btnLock = MakeButton("Bloquear", false);
        btnLock.Click += async (_, _) => await SendRemoteInputAsync(new { kind = "command", action = "lock" });
        remoteBottom.Controls.AddRange(new Control[] { _remoteTextBox, btnSendTxt, btnEnter, btnVolDown, btnVolUp, btnPlay, btnLock });

        tabRemote.Controls.Add(pad);
        tabRemote.Controls.Add(_targetCombo);
        tabRemote.Controls.Add(remoteBottom);

        // Tab 3: Files & Clipboard
        var tabFiles = new TabPage("Arquivos & Clipboard") { BackColor = Color.FromArgb(9, 11, 14), Padding = new Padding(12) };
        var fileBar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 44 };
        var btnSendFile = MakeButton("Enviar Arquivo...", true);
        btnSendFile.Click += async (_, _) => await PickAndSendFileAsync();
        var btnCapClip = MakeButton("Capturar Clipboard do Windows", false);
        btnCapClip.Click += async (_, _) =>
        {
            if (Clipboard.ContainsText()) await PushClipboardAsync(Clipboard.GetText());
        };
        _clipInputBox.Width = 340;
        _clipInputBox.BackColor = Color.FromArgb(17, 21, 27);
        _clipInputBox.ForeColor = Color.FromArgb(241, 245, 249);
        var btnPushClip = MakeButton("Sincronizar", false);
        btnPushClip.Click += async (_, _) => { if (!string.IsNullOrWhiteSpace(_clipInputBox.Text)) { await PushClipboardAsync(_clipInputBox.Text); _clipInputBox.Clear(); } };
        fileBar.Controls.AddRange(new Control[] { btnSendFile, btnCapClip, _clipInputBox, btnPushClip });

        _clipList.Dock = DockStyle.Fill;
        _clipList.BackColor = Color.FromArgb(17, 21, 27);
        _clipList.ForeColor = Color.FromArgb(241, 245, 249);
        _clipList.DoubleClick += (_, _) =>
        {
            if (_clipList.SelectedItem is string s)
            {
                var idx = s.IndexOf("] ");
                var content = idx >= 0 ? s[(idx + 2)..] : s;
                Clipboard.SetText(content);
                _footerLabel.Text = "Copiado para a area de transferencia do Windows.";
            }
        };
        tabFiles.Controls.Add(_clipList);
        tabFiles.Controls.Add(fileBar);

        // Tab 4: Alerts
        var tabAlerts = new TabPage("Sistema & Alertas") { BackColor = Color.FromArgb(9, 11, 14), Padding = new Padding(12) };
        _notifList.Dock = DockStyle.Fill;
        _notifList.BackColor = Color.FromArgb(17, 21, 27);
        _notifList.ForeColor = Color.FromArgb(241, 245, 249);
        tabAlerts.Controls.Add(_notifList);

        tabs.TabPages.AddRange(new[] { tabDevices, tabRemote, tabFiles, tabAlerts });

        _footerLabel.Dock = DockStyle.Bottom;
        _footerLabel.Height = 28;
        _footerLabel.Padding = new Padding(12, 5, 12, 0);
        _footerLabel.BackColor = Color.FromArgb(13, 16, 21);
        _footerLabel.ForeColor = Color.FromArgb(148, 163, 184);
        _footerLabel.Text = $"Ponte Win32 Nativa Integrada · Arquivos salvos em: {DownloadsDir}";

        Controls.Add(tabs);
        Controls.Add(topPanel);
        Controls.Add(_footerLabel);
    }

    private static Button MakeButton(string text, bool primary) => new()
    {
        Text = text,
        AutoSize = true,
        FlatStyle = FlatStyle.Flat,
        BackColor = primary ? Color.FromArgb(59, 130, 246) : Color.FromArgb(23, 28, 36),
        ForeColor = Color.White,
        Padding = new Padding(8, 3, 8, 3),
    };

    private string GetWsUri()
    {
        var uri = new Uri(_cfg.ServerUrl);
        var scheme = uri.Scheme == "https" ? "wss" : "ws";
        return $"{scheme}://{uri.Authority}/ws";
    }

    private async Task SendJsonAsync(object payload)
    {
        if (_ws == null || _ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        await _sendLock.WaitAsync();
        try
        {
            if (_ws.State == WebSocketState.Open)
                await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        finally { _sendLock.Release(); }
    }

    private async Task SendRemoteInputAsync(object input)
    {
        if (_targetCombo.SelectedIndex < 0) return;
        var peers = _devices.Where(d => d.Id != _deviceId).ToList();
        if (_targetCombo.SelectedIndex >= peers.Count) return;
        await SendJsonAsync(new { type = "input:event", toDeviceId = peers[_targetCombo.SelectedIndex].Id, input });
    }

    private async Task PushClipboardAsync(string text)
    {
        var trimmed = text.Trim();
        if (string.IsNullOrEmpty(trimmed)) return;
        await SendJsonAsync(new
        {
            type = "clipboard:push",
            item = new
            {
                id = $"clip-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
                content = trimmed,
                kind = trimmed.StartsWith("http") ? "url" : "text",
                sourceDeviceId = _deviceId,
                sourceDeviceName = $"{Environment.MachineName} (Windows)",
                createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            }
        });
    }

    private async Task PickAndSendFileAsync()
    {
        using var ofd = new OpenFileDialog { Title = "Enviar arquivo pela malha Continuum" };
        if (ofd.ShowDialog() != DialogResult.OK) return;
        var path = ofd.FileName;
        var info = new FileInfo(path);
        var trId = $"file-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
        await SendJsonAsync(new
        {
            type = "file:start",
            record = new
            {
                id = trId,
                fileName = info.Name,
                fileSize = info.Length,
                mimeType = "application/octet-stream",
                fromDeviceId = _deviceId,
                fromDeviceName = $"{Environment.MachineName} (Windows)",
                toDeviceId = "all",
                toDeviceName = "Todos os dispositivos",
                status = "transferring",
                progress = 0,
                speedMbps = 0,
                createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            }
        });

        const int chunkSize = 48 * 1024;
        var data = await File.ReadAllBytesAsync(path);
        int total = Math.Max(1, (data.Length + chunkSize - 1) / chunkSize);
        for (int i = 0; i < total; i++)
        {
            int offset = i * chunkSize;
            int len = Math.Min(chunkSize, data.Length - offset);
            var b64 = Convert.ToBase64String(data, offset, len);
            await SendJsonAsync(new
            {
                type = "file:chunk",
                transferId = trId,
                toDeviceId = "all",
                chunkIndex = i,
                totalChunks = total,
                data = b64,
                progress = Math.Min(99, (int)((i + 1) * 100.0 / total)),
                speedMbps = 10
            });
        }
        await SendJsonAsync(new { type = "file:complete", transferId = trId, toDeviceId = "all" });
        _footerLabel.Text = $"Arquivo enviado: {info.Name}";
    }

    private void ExecuteWin32Input(JsonElement evt)
    {
        var kind = evt.TryGetProperty("kind", out var k) ? k.GetString() : null;
        if (kind == "move")
        {
            if (evt.TryGetProperty("dx", out var dxEl) && evt.TryGetProperty("dy", out var dyEl))
            {
                Win32Native.GetCursorPos(out var pt);
                Win32Native.SetCursorPos(pt.X + (int)dxEl.GetDouble(), pt.Y + (int)dyEl.GetDouble());
            }
            else if (evt.TryGetProperty("nx", out var nxEl) && evt.TryGetProperty("ny", out var nyEl))
            {
                int sw = Math.Max(1, Win32Native.GetSystemMetrics(0));
                int sh = Math.Max(1, Win32Native.GetSystemMetrics(1));
                Win32Native.SetCursorPos((int)(nxEl.GetDouble() * sw), (int)(nyEl.GetDouble() * sh));
            }
        }
        else if (kind == "click")
        {
            if (evt.TryGetProperty("nx", out var nxEl) && evt.TryGetProperty("ny", out var nyEl))
            {
                int sw = Math.Max(1, Win32Native.GetSystemMetrics(0));
                int sh = Math.Max(1, Win32Native.GetSystemMetrics(1));
                Win32Native.SetCursorPos((int)(nxEl.GetDouble() * sw), (int)(nyEl.GetDouble() * sh));
            }
            var btn = evt.TryGetProperty("button", out var b) ? b.GetString() : "left";
            if (btn == "right") { Win32Native.mouse_event(0x0008, 0, 0, 0, 0); Win32Native.mouse_event(0x0010, 0, 0, 0, 0); }
            else { Win32Native.mouse_event(0x0002, 0, 0, 0, 0); Win32Native.mouse_event(0x0004, 0, 0, 0, 0); }
        }
        else if (kind == "scroll" && evt.TryGetProperty("dy", out var dyScroll))
        {
            Win32Native.mouse_event(0x0800, 0, 0, (int)(-dyScroll.GetDouble() * 3), 0);
        }
        else if (kind == "text" && evt.TryGetProperty("text", out var txtEl))
        {
            var txt = txtEl.GetString();
            if (!string.IsNullOrEmpty(txt)) BeginInvoke(() => SendKeys.SendWait(txt));
        }
        else if (kind == "command" && evt.TryGetProperty("action", out var actEl))
        {
            switch (actEl.GetString())
            {
                case "vol_up": Win32Native.keybd_event(0xAF, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xAF, 0, 2, UIntPtr.Zero); break;
                case "vol_down": Win32Native.keybd_event(0xAE, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xAE, 0, 2, UIntPtr.Zero); break;
                case "vol_mute": Win32Native.keybd_event(0xAD, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xAD, 0, 2, UIntPtr.Zero); break;
                case "media_play_pause": Win32Native.keybd_event(0xB3, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xB3, 0, 2, UIntPtr.Zero); break;
                case "media_next": Win32Native.keybd_event(0xB0, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xB0, 0, 2, UIntPtr.Zero); break;
                case "media_prev": Win32Native.keybd_event(0xB1, 0, 0, UIntPtr.Zero); Win32Native.keybd_event(0xB1, 0, 2, UIntPtr.Zero); break;
                case "lock": Win32Native.LockWorkStation(); break;
                case "ping": System.Media.SystemSounds.Exclamation.Play(); break;
            }
        }
    }

    private void RefreshDevicesUi()
    {
        _devicesView.Items.Clear();
        _targetCombo.Items.Clear();
        foreach (var d in _devices)
        {
            var item = new ListViewItem(d.Id == _deviceId ? $"{d.Name} (Este Windows)" : d.Name) { Tag = d.Id };
            item.SubItems.Add(d.Os.ToUpperInvariant());
            item.SubItems.Add(d.DisplayServer.ToUpperInvariant());
            item.SubItems.Add(d.CpuText);
            item.SubItems.Add(d.BatteryText);
            _devicesView.Items.Add(item);
            if (d.Id != _deviceId) _targetCombo.Items.Add(d.Name);
        }
        if (_targetCombo.Items.Count > 0 && _targetCombo.SelectedIndex < 0) _targetCombo.SelectedIndex = 0;
    }

    private static MeshDevice ParseDevice(JsonElement el)
    {
        var d = new MeshDevice
        {
            Id = el.TryGetProperty("id", out var id) ? id.GetString() ?? "" : "",
            Name = el.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
            Os = el.TryGetProperty("os", out var o) ? o.GetString() ?? "" : ""
        };
        if (el.TryGetProperty("telemetry", out var tel) && tel.ValueKind == JsonValueKind.Object)
        {
            if (tel.TryGetProperty("displayServer", out var ds) && ds.ValueKind == JsonValueKind.String) d.DisplayServer = ds.GetString() ?? "web";
            if (tel.TryGetProperty("cpuUsage", out var cpu) && cpu.ValueKind == JsonValueKind.Number) d.CpuText = $"{cpu.GetInt32()}%";
            if (tel.TryGetProperty("batteryLevel", out var bat) && bat.ValueKind == JsonValueKind.Number) d.BatteryText = $"{bat.GetInt32()}%";
        }
        return d;
    }

    private async Task RunMeshLoopAsync()
    {
        var token = _cts.Token;
        while (!token.IsCancellationRequested)
        {
            try
            {
                BeginInvoke(() => _statusLabel.Text = "Conectando...");
                _ws?.Dispose();
                _ws = new ClientWebSocket();
                _ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                await _ws.ConnectAsync(new Uri(GetWsUri()), token);
                Log($"Conectado em {GetWsUri()} (Malha {_cfg.RoomCode})");

                var ps = SystemInformation.PowerStatus;
                int? batPct = ps.BatteryChargeStatus == BatteryChargeStatus.NoSystemBattery ? null : (int)Math.Round(ps.BatteryLifePercent * 100);
                await SendJsonAsync(new
                {
                    type = "mesh:join",
                    roomCode = _cfg.RoomCode,
                    device = new
                    {
                        id = _deviceId,
                        name = $"{Environment.MachineName} (Windows)",
                        os = "windows",
                        formFactor = "desktop",
                        screenWidth = Screen.PrimaryScreen?.Bounds.Width ?? 1920,
                        screenHeight = Screen.PrimaryScreen?.Bounds.Height ?? 1080,
                        pixelRatio = 1,
                        orientation = "landscape",
                        companionConnected = true,
                        telemetry = new
                        {
                            batteryLevel = batPct,
                            batteryCharging = ps.PowerLineStatus == PowerLineStatus.Online,
                            cpuCores = Environment.ProcessorCount,
                            displayServer = "win32",
                            volume = 72,
                            brightness = 85,
                            openApps = Array.Empty<object>()
                        }
                    }
                });

                BeginInvoke(() => { _statusLabel.Text = $"Conectado · {_cfg.RoomCode}"; _tray.Text = $"Continuum — {_cfg.RoomCode}"; });

                var buf = new byte[32768];
                using var ms = new MemoryStream();
                while (_ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    var res = await _ws.ReceiveAsync(buf, token);
                    if (res.MessageType == WebSocketMessageType.Close) break;
                    ms.Write(buf, 0, res.Count);
                    if (!res.EndOfMessage) continue;
                    var raw = Encoding.UTF8.GetString(ms.ToArray());
                    ms.SetLength(0);
                    HandleMessage(raw);
                }
            }
            catch (Exception ex)
            {
                Log($"Erro de conexao: {ex.Message}");
                BeginInvoke(() => _statusLabel.Text = "Reconectando...");
            }
            try { await Task.Delay(3500, token); } catch { break; }
        }
    }

    private void HandleMessage(string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;

            if (type == "input:event" || type == "companion:input")
            {
                if (root.TryGetProperty("input", out var inp)) ExecuteWin32Input(inp);
                return;
            }
            if (type == "mesh:init" && root.TryGetProperty("snapshot", out var snap))
            {
                var list = snap.GetProperty("devices").EnumerateArray().Select(ParseDevice).ToList();
                var clips = snap.GetProperty("clipboard").EnumerateArray().Select(c => $"[{c.GetProperty("sourceDeviceName").GetString()}] {c.GetProperty("content").GetString()}").ToList();
                var notifs = snap.GetProperty("notifications").EnumerateArray().Select(n => $"{n.GetProperty("app").GetString()} · {n.GetProperty("title").GetString()}").ToList();
                BeginInvoke(() =>
                {
                    _devices.Clear(); _devices.AddRange(list); RefreshDevicesUi();
                    _clipList.Items.Clear(); foreach (var c in clips) _clipList.Items.Add(c);
                    _notifList.Items.Clear(); foreach (var n in notifs) _notifList.Items.Add(n);
                });
            }
            else if (type == "mesh:devices_sync" && root.TryGetProperty("devices", out var devsEl))
            {
                var list = devsEl.EnumerateArray().Select(ParseDevice).ToList();
                BeginInvoke(() => { _devices.Clear(); _devices.AddRange(list); RefreshDevicesUi(); });
            }
            else if ((type == "device:joined" || type == "device:updated") && root.TryGetProperty("device", out var devEl))
            {
                var dev = ParseDevice(devEl);
                BeginInvoke(() =>
                {
                    _devices.RemoveAll(x => x.Id == dev.Id);
                    _devices.Add(dev);
                    RefreshDevicesUi();
                });
            }
            else if (type == "device:left" && root.TryGetProperty("deviceId", out var didEl))
            {
                var did = didEl.GetString();
                BeginInvoke(() => { _devices.RemoveAll(x => x.Id == did); RefreshDevicesUi(); });
            }
            else if (type == "clipboard:added" && root.TryGetProperty("item", out var clipEl))
            {
                var line = $"[{clipEl.GetProperty("sourceDeviceName").GetString()}] {clipEl.GetProperty("content").GetString()}";
                BeginInvoke(() => _clipList.Items.Insert(0, line));
            }
            else if (type == "notification:added" && root.TryGetProperty("notification", out var nEl))
            {
                var line = $"{nEl.GetProperty("app").GetString()} · {nEl.GetProperty("title").GetString()}";
                BeginInvoke(() => _notifList.Items.Insert(0, line));
            }
            else if (type == "file:start" && root.TryGetProperty("record", out var rec))
            {
                var fid = rec.GetProperty("id").GetString() ?? "";
                var from = rec.GetProperty("fromDeviceId").GetString() ?? "";
                var fname = rec.GetProperty("fileName").GetString() ?? "arquivo.bin";
                if (from != _deviceId && !string.IsNullOrEmpty(fid))
                    _pendingFiles[fid] = (fname, 0, new Dictionary<int, string>());
            }
            else if (type == "file:chunk")
            {
                var fid = root.GetProperty("transferId").GetString() ?? "";
                if (_pendingFiles.TryGetValue(fid, out var asm))
                {
                    asm.Total = root.GetProperty("totalChunks").GetInt32();
                    asm.Chunks[root.GetProperty("chunkIndex").GetInt32()] = root.GetProperty("data").GetString() ?? "";
                    _pendingFiles[fid] = asm;
                }
            }
            else if (type == "file:complete")
            {
                var fid = root.GetProperty("transferId").GetString() ?? "";
                if (_pendingFiles.Remove(fid, out var asm))
                {
                    Directory.CreateDirectory(DownloadsDir);
                    var dest = Path.Combine(DownloadsDir, Path.GetFileName(asm.FileName));
                    using var fs = File.Create(dest);
                    for (int i = 0; i < asm.Total; i++)
                    {
                        if (asm.Chunks.TryGetValue(i, out var b64))
                        {
                            var bytes = Convert.FromBase64String(b64);
                            fs.Write(bytes, 0, bytes.Length);
                        }
                    }
                    BeginInvoke(() => _footerLabel.Text = $"Arquivo recebido salvo em: {dest}");
                }
            }
        }
        catch { }
    }

    [STAThread]
    public static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new ContinuumMainForm());
    }
}
