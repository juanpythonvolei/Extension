using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ContinuumWindows;

public sealed class AppConfig
{
    public string RoomCode { get; set; } = "MESH01";
    public string ManualPeer { get; set; } = "";
    public bool AutoLan { get; set; } = true;
    public bool AutoClipboard { get; set; } = true;
    public bool KvmBorderEnabled { get; set; } = false;
    public string KvmEdge { get; set; } = "right";
    public int WsPort { get; set; } = 45891;
    public double Sensitivity { get; set; } = 1.65;
}

public sealed class PeerDevice
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "Dispositivo";
    public string Os { get; set; } = "windows";
    public string Kind { get; set; } = "desktop";
    public double X { get; set; } = 180;
    public double Y { get; set; } = 140;
    public int CpuUsage { get; set; }
    public int RamUsage { get; set; }
    public int? BatteryLevel { get; set; }
    public string LanIp { get; set; } = "";
}

public sealed class DiscoveredHub
{
    public string HubId { get; set; } = "";
    public string HubName { get; set; } = "";
    public string Os { get; set; } = "desktop";
    public string Ip { get; set; } = "";
    public int WsPort { get; set; } = 45891;
    public string RoomCode { get; set; } = "MESH01";
    public long StartedAt { get; set; }
    public int Peers { get; set; }
    public int RemotePeers { get; set; }
    public string Via { get; set; } = "UDP Auto";
    public DateTime LastSeenUtc { get; set; } = DateTime.UtcNow;
    public bool IsLocal { get; set; }
}

public sealed class ClipEntry
{
    public string Id { get; set; } = "";
    public string Content { get; set; } = "";
    public string SourceDeviceName { get; set; } = "";
    public string SourceDeviceId { get; set; } = "";
}

internal static class Win32Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public class MEMORYSTATUSEX
    {
        public uint dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool LockWorkStation();
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

    public static Rectangle GetTargetScreenBounds(int monitorIndex)
    {
        var screens = Screen.AllScreens;
        if (screens.Length == 0) return new Rectangle(0, 0, 1920, 1080);
        if (monitorIndex >= 0 && monitorIndex < screens.Length) return screens[monitorIndex].Bounds;
        return Screen.PrimaryScreen?.Bounds ?? screens[0].Bounds;
    }

    private static void SendKeyCombo(byte modVk, byte keyVk)
    {
        keybd_event(modVk, 0, 0, UIntPtr.Zero);
        keybd_event(keyVk, 0, 0, UIntPtr.Zero);
        keybd_event(keyVk, 0, 2, UIntPtr.Zero);
        keybd_event(modVk, 0, 2, UIntPtr.Zero);
    }

    public static void ExecuteInput(JsonObject ev, int activeMonitorIndex, Action<string, string>? onNotify)
    {
        var kind = ev["kind"]?.GetValue<string>() ?? "";
        if (kind == "abs_move")
        {
            double nx = Math.Clamp(ev["nx"]?.GetValue<double>() ?? 0.5, 0.0, 1.0);
            double ny = Math.Clamp(ev["ny"]?.GetValue<double>() ?? 0.5, 0.0, 1.0);
            var b = GetTargetScreenBounds(activeMonitorIndex);
            int tx = b.Left + (int)Math.Round(nx * Math.Max(1, b.Width - 1));
            int ty = b.Top + (int)Math.Round(ny * Math.Max(1, b.Height - 1));
            SetCursorPos(tx, ty);
        }
        else if (kind == "abs_click")
        {
            double nx = Math.Clamp(ev["nx"]?.GetValue<double>() ?? 0.5, 0.0, 1.0);
            double ny = Math.Clamp(ev["ny"]?.GetValue<double>() ?? 0.5, 0.0, 1.0);
            var b = GetTargetScreenBounds(activeMonitorIndex);
            int tx = b.Left + (int)Math.Round(nx * Math.Max(1, b.Width - 1));
            int ty = b.Top + (int)Math.Round(ny * Math.Max(1, b.Height - 1));
            SetCursorPos(tx, ty);
            var btn = ev["button"]?.GetValue<string>() ?? "left";
            bool dbl = ev["double"]?.GetValue<bool>() ?? false;
            int count = dbl ? 2 : 1;
            for (int i = 0; i < count; i++)
            {
                if (btn == "right") { mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero); }
                else if (btn == "middle") { mouse_event(0x0020, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0040, 0, 0, 0, UIntPtr.Zero); }
                else { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
                if (dbl && i == 0) Thread.Sleep(55);
            }
        }
        else if (kind == "move")
        {
            double dx = (ev["dx"]?.GetValue<double>() ?? 0) * 1.8;
            double dy = (ev["dy"]?.GetValue<double>() ?? 0) * 1.8;
            if (GetCursorPos(out var pt))
                SetCursorPos(pt.X + (int)Math.Round(dx), pt.Y + (int)Math.Round(dy));
        }
        else if (kind == "click")
        {
            var btn = ev["button"]?.GetValue<string>() ?? "left";
            bool dbl = ev["double"]?.GetValue<bool>() ?? false;
            int count = dbl ? 2 : 1;
            for (int i = 0; i < count; i++)
            {
                if (btn == "right") { mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero); }
                else if (btn == "middle") { mouse_event(0x0020, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0040, 0, 0, 0, UIntPtr.Zero); }
                else { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
                if (dbl && i == 0) Thread.Sleep(60);
            }
        }
        else if (kind == "scroll")
        {
            double dy = ev["dy"]?.GetValue<double>() ?? 0;
            mouse_event(0x0800, 0, 0, dy > 0 ? -120 : 120, UIntPtr.Zero);
        }
        else if (kind == "text")
        {
            var txt = ev["text"]?.GetValue<string>() ?? "";
            if (!string.IsNullOrEmpty(txt))
            {
                var safe = txt
                    .Replace("{", "{{}")
                    .Replace("}", "{}}")
                    .Replace("+", "{+}")
                    .Replace("^", "{^}")
                    .Replace("%", "{%}")
                    .Replace("~", "{~}")
                    .Replace("(", "{(}")
                    .Replace(")", "{)}")
                    .Replace("[", "{[}")
                    .Replace("]", "{]}");
                try { SendKeys.SendWait(safe); } catch { }
            }
        }
        else if (kind == "key")
        {
            var k = ev["key"]?.GetValue<string>() ?? "";
            bool ctrl = ev["ctrl"]?.GetValue<bool>() ?? false;
            bool alt = ev["alt"]?.GetValue<bool>() ?? false;
            if (k == "Alt+Tab" || (alt && k == "Tab")) { SendKeyCombo(0x12, 0x09); return; }
            if (k == "Ctrl+C" || (ctrl && (k == "c" || k == "C"))) { SendKeyCombo(0x11, 0x43); return; }
            if (k == "Ctrl+V" || (ctrl && (k == "v" || k == "V"))) { SendKeyCombo(0x11, 0x56); return; }
            if (k == "Ctrl+A" || (ctrl && (k == "a" || k == "A"))) { SendKeyCombo(0x11, 0x41); return; }
            if (k == "Ctrl+Z" || (ctrl && (k == "z" || k == "Z"))) { SendKeyCombo(0x11, 0x5A); return; }
            if (k == "Super" || k == "Meta" || k == "Win")
            {
                keybd_event(0x5B, 0, 0, UIntPtr.Zero);
                keybd_event(0x5B, 0, 2, UIntPtr.Zero);
                return;
            }
            var map = k switch
            {
                "Enter" => "{ENTER}",
                "Backspace" => "{BACKSPACE}",
                "Delete" => "{DELETE}",
                "Escape" => "{ESC}",
                "Tab" => "{TAB}",
                "Space" => " ",
                "ArrowUp" => "{UP}",
                "ArrowDown" => "{DOWN}",
                "ArrowLeft" => "{LEFT}",
                "ArrowRight" => "{RIGHT}",
                "Home" => "{HOME}",
                "End" => "{END}",
                "PageUp" => "{PGUP}",
                "PageDown" => "{PGDN}",
                _ => k.Length == 1 ? k : ""
            };
            if (!string.IsNullOrEmpty(map))
                try { SendKeys.SendWait(map); } catch { }
        }
        else if (kind == "media" || kind == "command")
        {
            var act = ev["action"]?.GetValue<string>() ?? "";
            byte vk = act switch
            {
                "vol_up" => 0xAF,
                "vol_down" => 0xAE,
                "mute" or "vol_mute" => 0xAD,
                "play_pause" or "media_play_pause" => 0xB3,
                "next" or "media_next" => 0xB0,
                "prev" or "media_prev" => 0xB1,
                _ => 0
            };
            if (vk != 0)
            {
                keybd_event(vk, 0, 0, UIntPtr.Zero);
                keybd_event(vk, 0, 2, UIntPtr.Zero);
            }
            else if (act == "lock")
            {
                LockWorkStation();
            }
            else if (act == "ping")
            {
                System.Media.SystemSounds.Exclamation.Play();
                onNotify?.Invoke("Continuum — Localização", "Sinal de localização recebido via rede local!");
            }
        }
    }
}

internal static class ScreenCaptureUtil
{
    private static readonly ImageCodecInfo? JpegCodec = ImageCodecInfo
        .GetImageEncoders()
        .FirstOrDefault(c => c.FormatID == ImageFormat.Jpeg.Guid);

    public static (byte[] JpegBytes, int OutW, int OutH)? CaptureScreenJpeg(int monitorIndex, int maxWidth, long quality)
    {
        try
        {
            var bounds = Win32Native.GetTargetScreenBounds(monitorIndex);
            if (bounds.Width <= 0 || bounds.Height <= 0) return null;

            using var raw = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(raw))
            {
                g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
            }

            int outW = bounds.Width;
            int outH = bounds.Height;
            Bitmap toEncode = raw;
            Bitmap? scaled = null;

            if (bounds.Width > maxWidth)
            {
                double ratio = (double)maxWidth / bounds.Width;
                outW = maxWidth;
                outH = Math.Max(1, (int)Math.Round(bounds.Height * ratio));
                scaled = new Bitmap(outW, outH, PixelFormat.Format24bppRgb);
                using var sg = Graphics.FromImage(scaled);
                sg.InterpolationMode = InterpolationMode.Bilinear;
                sg.CompositingQuality = CompositingQuality.HighSpeed;
                sg.DrawImage(raw, 0, 0, outW, outH);
                toEncode = scaled;
            }

            try
            {
                using var ms = new MemoryStream();
                if (JpegCodec != null)
                {
                    using var ep = new EncoderParameters(1);
                    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                    toEncode.Save(ms, JpegCodec, ep);
                }
                else
                {
                    toEncode.Save(ms, ImageFormat.Jpeg);
                }
                return (ms.ToArray(), outW, outH);
            }
            finally
            {
                scaled?.Dispose();
            }
        }
        catch
        {
            return null;
        }
    }
}

internal static class NetworkUtil
{
    public const int UdpPort = 45890;
    public const int DefaultWsPort = 45891;
    public const string ProtoV5 = "continuum-lan-v5";
    public const string ProtoV4 = "continuum-lan-v4";
    public const string ProtoV3 = "continuum-lan-v3";
    public const string MulticastAddr = "239.255.45.90";

    public static bool IsSupportedProto(string? p) => p == ProtoV5 || p == ProtoV4 || p == ProtoV3;

    public static string GetLocalLanIp()
    {
        try
        {
            using var s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            s.Connect("8.8.8.8", 80);
            if (s.LocalEndPoint is IPEndPoint ep)
            {
                var ip = ep.Address.ToString();
                if (!ip.StartsWith("127.")) return ip;
            }
        }
        catch { }

        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ua.Address.AddressFamily == AddressFamily.InterNetwork)
                    {
                        var ip = ua.Address.ToString();
                        if (!ip.StartsWith("127.") && !ip.StartsWith("169.254.")) return ip;
                    }
                }
            }
        }
        catch { }
        return "127.0.0.1";
    }

    public static string? GetSubnetBroadcast(string ip)
    {
        var parts = (ip ?? "").Split('.');
        if (parts.Length == 4 && !ip.StartsWith("127."))
            return $"{parts[0]}.{parts[1]}.{parts[2]}.255";
        return null;
    }

    public static (string Host, int Port, string WsUrl) ParseEndpoint(string raw)
    {
        var s = (raw ?? "").Trim();
        if (string.IsNullOrEmpty(s)) return ("", DefaultWsPort, "");
        s = Regex.Replace(s, @"^(https?|wss?)://", "", RegexOptions.IgnoreCase);
        int slash = s.IndexOf('/');
        if (slash >= 0) s = s[..slash];
        s = s.Trim();
        if (string.IsNullOrEmpty(s)) return ("", DefaultWsPort, "");

        var dotTrimmed = s.TrimStart('.');
        if (Regex.IsMatch(dotTrimmed, @"^[0-9]{1,3}(:[0-9]{2,5})?$"))
        {
            var myIp = GetLocalLanIp();
            var parts = myIp.Split('.');
            if (parts.Length == 4 && !myIp.StartsWith("127."))
                s = $"{parts[0]}.{parts[1]}.{parts[2]}.{dotTrimmed}";
        }

        string host = s;
        int port = DefaultWsPort;
        int colon = s.LastIndexOf(':');
        if (colon > 0 && int.TryParse(s[(colon + 1)..], out int parsedPort) && parsedPort >= 1 && parsedPort <= 65535)
        {
            host = s[..colon].Trim();
            port = parsedPort;
        }
        if (string.IsNullOrEmpty(host) || host.Contains(' ')) return ("", DefaultWsPort, "");
        return (host, port, $"ws://{host}:{port}/ws");
    }

    public static string NormalizeWsEndpoint(string raw) => ParseEndpoint(raw).WsUrl;

    public static async Task<JsonObject?> ProbeHttpInfoAsync(string host, int port, int timeoutMs)
    {
        try
        {
            using var tcp = new TcpClient();
            using var cts = new CancellationTokenSource(timeoutMs);
            await tcp.ConnectAsync(host, port, cts.Token);
            using var stream = tcp.GetStream();
            var req = Encoding.ASCII.GetBytes($"GET /continuum-info HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
            await stream.WriteAsync(req, cts.Token);
            using var ms = new MemoryStream();
            var buf = new byte[1024];
            while (ms.Length < 4096)
            {
                int n = await stream.ReadAsync(buf, cts.Token);
                if (n <= 0) break;
                ms.Write(buf, 0, n);
            }
            var text = Encoding.UTF8.GetString(ms.ToArray());
            int idx = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            if (idx < 0) return null;
            var obj = JsonNode.Parse(text[(idx + 4)..].Trim()) as JsonObject;
            return obj != null && (obj["ok"]?.GetValue<bool>() ?? false) ? obj : null;
        }
        catch { return null; }
    }
}

// ---------------------------------------------------------------------------
// Embedded RFC-6455 LAN WebSocket Hub v5.0 (Full Fragmentation Reassembly + Screen Relay)
// ---------------------------------------------------------------------------
internal sealed class EmbeddedLanHub : IDisposable
{
    private const string WsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private sealed class ClientSession
    {
        public TcpClient Tcp { get; }
        public NetworkStream Stream { get; }
        public SemaphoreSlim SendLock { get; } = new(1, 1);
        public string? DeviceId { get; set; }
        public string? RoomCode { get; set; }
        public string RemoteIp { get; }

        public ClientSession(TcpClient tcp, string ip)
        {
            Tcp = tcp;
            Stream = tcp.GetStream();
            RemoteIp = ip;
        }
    }

    private sealed class RoomState
    {
        public Dictionary<string, JsonObject> Devices { get; } = new();
        public List<JsonObject> Clipboard { get; } = new();
        public List<JsonObject> Notifications { get; } = new();
    }

    public int Port { get; }
    public string HubId { get; }
    public long StartedAt { get; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public bool Active { get; private set; }

    private readonly Func<string> _getRoom;
    private TcpListener? _listener;
    private readonly CancellationTokenSource _cts = new();
    private readonly object _sync = new();
    private readonly HashSet<ClientSession> _clients = new();
    private readonly Dictionary<string, RoomState> _rooms = new();

    public EmbeddedLanHub(string hubId, Func<string> getRoom, int port = NetworkUtil.DefaultWsPort)
    {
        HubId = hubId;
        _getRoom = getRoom;
        Port = port;
    }

    public bool Start()
    {
        try
        {
            _listener = new TcpListener(IPAddress.Any, Port);
            _listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            _listener.Start();
            Active = true;
            _ = Task.Run(AcceptLoopAsync);
            return true;
        }
        catch { Active = false; return false; }
    }

    public int PeerCount(string roomCode)
    {
        lock (_sync) { return _rooms.TryGetValue(roomCode, out var r) ? r.Devices.Count : 0; }
    }

    public int RemotePeerCount(string roomCode)
    {
        lock (_sync)
        {
            return _clients.Count(c =>
                c.RoomCode == roomCode &&
                !string.IsNullOrEmpty(c.RemoteIp) &&
                !c.RemoteIp.StartsWith("127.") &&
                c.RemoteIp != "::1" &&
                c.RemoteIp != "::ffff:127.0.0.1");
        }
    }

    private RoomState GetRoomLocked(string code)
    {
        if (!_rooms.TryGetValue(code, out var r)) { r = new RoomState(); _rooms[code] = r; }
        return r;
    }

    private async Task AcceptLoopAsync()
    {
        while (!_cts.IsCancellationRequested && _listener != null)
        {
            try
            {
                var tcp = await _listener.AcceptTcpClientAsync(_cts.Token);
                try
                {
                    tcp.NoDelay = true;
                    tcp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
                }
                catch { }
                var ip = (tcp.Client.RemoteEndPoint as IPEndPoint)?.Address.ToString() ?? "";
                _ = Task.Run(() => HandleClientAsync(tcp, ip));
            }
            catch (OperationCanceledException) { break; }
            catch { await Task.Delay(150); }
        }
    }

    private static byte[] EncodeServerFrame(string text, byte opcode = 0x1) => EncodeServerFrameBytes(Encoding.UTF8.GetBytes(text), opcode);

    private static byte[] EncodeServerFrameBytes(byte[] payload, byte opcode = 0x1)
    {
        using var ms = new MemoryStream();
        ms.WriteByte((byte)(0x80 | (opcode & 0x0F)));
        if (payload.Length < 126) ms.WriteByte((byte)payload.Length);
        else if (payload.Length < 65536)
        {
            ms.WriteByte(126);
            ms.WriteByte((byte)((payload.Length >> 8) & 0xFF));
            ms.WriteByte((byte)(payload.Length & 0xFF));
        }
        else
        {
            ms.WriteByte(127);
            ulong len = (ulong)payload.Length;
            for (int i = 7; i >= 0; i--) ms.WriteByte((byte)((len >> (8 * i)) & 0xFF));
        }
        ms.Write(payload, 0, payload.Length);
        return ms.ToArray();
    }

    private static async Task<byte[]?> ReadExactAsync(NetworkStream stream, int count, CancellationToken ct)
    {
        var buf = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int n = await stream.ReadAsync(buf.AsMemory(offset, count - offset), ct);
            if (n <= 0) return null;
            offset += n;
        }
        return buf;
    }

    private static async Task<(bool Fin, byte Opcode, byte[] Payload)?> ReadSingleFrameAsync(NetworkStream stream, CancellationToken ct)
    {
        var hdr = await ReadExactAsync(stream, 2, ct);
        if (hdr == null) return null;
        bool fin = (hdr[0] & 0x80) != 0;
        byte opcode = (byte)(hdr[0] & 0x0F);
        bool masked = (hdr[1] & 0x80) != 0;
        long length = hdr[1] & 0x7F;
        if (length == 126)
        {
            var ext = await ReadExactAsync(stream, 2, ct);
            if (ext == null) return null;
            length = (ext[0] << 8) | ext[1];
        }
        else if (length == 127)
        {
            var ext = await ReadExactAsync(stream, 8, ct);
            if (ext == null) return null;
            ulong u = 0;
            for (int i = 0; i < 8; i++) u = (u << 8) | ext[i];
            length = (long)u;
        }
        if (length < 0 || length > 32 * 1024 * 1024) return null;
        byte[]? mask = masked ? await ReadExactAsync(stream, 4, ct) : null;
        byte[] payload = length > 0 ? (await ReadExactAsync(stream, (int)length, ct) ?? Array.Empty<byte>()) : Array.Empty<byte>();
        if (mask != null)
            for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i & 3];
        return (fin, opcode, payload);
    }

    private async Task<(byte Opcode, byte[] Payload)?> ReadMessageAsync(ClientSession session, CancellationToken ct)
    {
        MemoryStream? fragBuf = null;
        byte fragOpcode = 0;

        while (!ct.IsCancellationRequested)
        {
            var frame = await ReadSingleFrameAsync(session.Stream, ct);
            if (frame == null) return null;
            var (fin, opcode, payload) = frame.Value;

            if (opcode == 0x8) return (0x8, payload);
            if (opcode == 0x9)
            {
                await SendRawAsync(session, EncodeServerFrameBytes(payload, 0xA));
                continue;
            }
            if (opcode == 0xA) continue;

            if (opcode == 0x1 || opcode == 0x2)
            {
                if (fin && fragBuf == null) return (opcode, payload);
                fragBuf?.Dispose();
                fragBuf = new MemoryStream();
                fragOpcode = opcode;
                fragBuf.Write(payload, 0, payload.Length);
                if (fin)
                {
                    var full = fragBuf.ToArray();
                    fragBuf.Dispose();
                    return (fragOpcode, full);
                }
            }
            else if (opcode == 0x0)
            {
                if (fragBuf == null) continue;
                if (fragBuf.Length + payload.Length > 32 * 1024 * 1024)
                {
                    fragBuf.Dispose();
                    return null;
                }
                fragBuf.Write(payload, 0, payload.Length);
                if (fin)
                {
                    var full = fragBuf.ToArray();
                    fragBuf.Dispose();
                    return (fragOpcode, full);
                }
            }
        }
        fragBuf?.Dispose();
        return null;
    }

    private async Task SendRawAsync(ClientSession session, byte[] frame)
    {
        await session.SendLock.WaitAsync();
        try { await session.Stream.WriteAsync(frame, 0, frame.Length, _cts.Token); }
        catch { }
        finally { session.SendLock.Release(); }
    }

    private async Task BroadcastRoomAsync(string roomCode, JsonObject payload, ClientSession? exclude = null)
    {
        List<ClientSession> targets;
        lock (_sync) { targets = _clients.Where(c => c.RoomCode == roomCode && c != exclude).ToList(); }
        if (targets.Count == 0) return;
        var frame = EncodeServerFrame(payload.ToJsonString());
        foreach (var t in targets) await SendRawAsync(t, frame);
    }

    private async Task SendToDeviceAsync(string roomCode, string targetId, JsonObject payload, ClientSession? exclude = null)
    {
        List<ClientSession> targets;
        lock (_sync) { targets = _clients.Where(c => c.RoomCode == roomCode && c.DeviceId == targetId && c != exclude).ToList(); }
        if (targets.Count == 0) { await BroadcastRoomAsync(roomCode, payload, exclude); return; }
        var frame = EncodeServerFrame(payload.ToJsonString());
        foreach (var t in targets) await SendRawAsync(t, frame);
    }

    private async Task HandleClientAsync(TcpClient tcp, string remoteIp)
    {
        var session = new ClientSession(tcp, remoteIp);
        try
        {
            var reqBytes = new MemoryStream();
            var buf = new byte[2048];
            while (reqBytes.Length < 8192)
            {
                int n = await session.Stream.ReadAsync(buf, 0, buf.Length, _cts.Token);
                if (n <= 0) return;
                reqBytes.Write(buf, 0, n);
                if (Encoding.UTF8.GetString(reqBytes.ToArray()).Contains("\r\n\r\n")) break;
            }

            var headerText = Encoding.UTF8.GetString(reqBytes.ToArray());
            string? wsKey = null;
            foreach (var line in headerText.Split("\r\n").Skip(1))
            {
                int colon = line.IndexOf(':');
                if (colon > 0 && line[..colon].Trim().Equals("Sec-WebSocket-Key", StringComparison.OrdinalIgnoreCase))
                {
                    wsKey = line[(colon + 1)..].Trim();
                    break;
                }
            }

            if (string.IsNullOrEmpty(wsKey))
            {
                var room = _getRoom();
                var infoObj = new JsonObject
                {
                    ["ok"] = true,
                    ["proto"] = NetworkUtil.ProtoV5,
                    ["hubId"] = HubId,
                    ["hubName"] = Environment.MachineName,
                    ["hub"] = Environment.MachineName,
                    ["os"] = "windows",
                    ["roomCode"] = room,
                    ["wsPort"] = Port,
                    ["ip"] = NetworkUtil.GetLocalLanIp(),
                    ["startedAt"] = StartedAt,
                    ["peers"] = PeerCount(room),
                    ["remotePeers"] = RemotePeerCount(room),
                    ["version"] = "5.0.0",
                };
                var body = Encoding.UTF8.GetBytes(infoObj.ToJsonString());
                var resp = Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
                await session.Stream.WriteAsync(resp);
                await session.Stream.WriteAsync(body);
                return;
            }

            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(wsKey + WsGuid)));
            var upgrade = Encoding.ASCII.GetBytes(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                $"Sec-WebSocket-Accept: {accept}\r\n\r\n");
            await session.Stream.WriteAsync(upgrade, _cts.Token);

            lock (_sync) { _clients.Add(session); }

            while (!_cts.IsCancellationRequested)
            {
                var message = await ReadMessageAsync(session, _cts.Token);
                if (message == null) break;
                var (opcode, payload) = message.Value;
                if (opcode == 0x8) break;
                if (opcode != 0x1) continue;
                JsonObject? msg = null;
                try { msg = JsonNode.Parse(Encoding.UTF8.GetString(payload)) as JsonObject; } catch { }
                if (msg != null) await ProcessMessageAsync(session, msg);
            }
        }
        catch { }
        finally
        {
            string? leftRoom = null;
            string? leftId = null;
            JsonArray? syncedDevs = null;
            lock (_sync)
            {
                _clients.Remove(session);
                leftRoom = session.RoomCode;
                leftId = session.DeviceId;
                if (!string.IsNullOrEmpty(leftRoom) && !string.IsNullOrEmpty(leftId) && _rooms.TryGetValue(leftRoom, out var rm))
                {
                    rm.Devices.Remove(leftId);
                    syncedDevs = new JsonArray(rm.Devices.Values.Select(v => v.DeepClone()).ToArray());
                }
            }
            try { tcp.Close(); } catch { }
            if (!string.IsNullOrEmpty(leftRoom) && !string.IsNullOrEmpty(leftId))
            {
                await BroadcastRoomAsync(leftRoom, new JsonObject { ["type"] = "device:left", ["deviceId"] = leftId });
                if (syncedDevs != null)
                    await BroadcastRoomAsync(leftRoom, new JsonObject { ["type"] = "mesh:devices_sync", ["devices"] = syncedDevs });
            }
        }
    }

    private async Task ProcessMessageAsync(ClientSession session, JsonObject msg)
    {
        var type = msg["type"]?.GetValue<string>() ?? "";
        if (type == "mesh:join")
        {
            var rawRoom = msg["roomCode"]?.GetValue<string>() ?? "MESH01";
            var roomCode = new string(rawRoom.ToUpperInvariant().Where(char.IsLetterOrDigit).Take(12).ToArray());
            if (string.IsNullOrEmpty(roomCode)) roomCode = "MESH01";

            var devIn = msg["device"] as JsonObject ?? new JsonObject();
            var devId = devIn["id"]?.GetValue<string>() ?? $"peer-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";

            JsonObject devRec;
            JsonArray snapDevs, snapClip, snapNotif;
            lock (_sync)
            {
                var rm = GetRoomLocked(roomCode);
                int idx = rm.Devices.Count;
                double defX = 180 + (idx % 3) * 230;
                double defY = 140 + (idx / 3) * 165;
                if (rm.Devices.TryGetValue(devId, out var prev))
                {
                    defX = prev["x"]?.GetValue<double>() ?? defX;
                    defY = prev["y"]?.GetValue<double>() ?? defY;
                }
                devRec = new JsonObject
                {
                    ["id"] = devId,
                    ["name"] = devIn["name"]?.GetValue<string>() ?? "Dispositivo",
                    ["os"] = devIn["os"]?.GetValue<string>() ?? "windows",
                    ["kind"] = devIn["kind"]?.GetValue<string>() ?? "desktop",
                    ["status"] = "online",
                    ["x"] = devIn["x"]?.GetValue<double>() ?? defX,
                    ["y"] = devIn["y"]?.GetValue<double>() ?? defY,
                    ["companionConnected"] = true,
                    ["lanIp"] = session.RemoteIp,
                    ["telemetry"] = devIn["telemetry"]?.DeepClone() ?? new JsonObject(),
                };
                rm.Devices[devId] = devRec;
                session.DeviceId = devId;
                session.RoomCode = roomCode;
                snapDevs = new JsonArray(rm.Devices.Values.Select(v => v.DeepClone()).ToArray());
                snapClip = new JsonArray(rm.Clipboard.Take(40).Select(v => v.DeepClone()).ToArray());
                snapNotif = new JsonArray(rm.Notifications.Take(40).Select(v => v.DeepClone()).ToArray());
            }

            var initPayload = new JsonObject
            {
                ["type"] = "mesh:init",
                ["roomCode"] = roomCode,
                ["hubName"] = Environment.MachineName,
                ["hubIp"] = NetworkUtil.GetLocalLanIp(),
                ["devices"] = snapDevs,
                ["clipboard"] = snapClip,
                ["notifications"] = snapNotif,
            };
            await SendRawAsync(session, EncodeServerFrame(initPayload.ToJsonString()));
            await BroadcastRoomAsync(roomCode, new JsonObject { ["type"] = "device:joined", ["device"] = devRec.DeepClone() }, exclude: session);
            await BroadcastRoomAsync(roomCode, new JsonObject { ["type"] = "mesh:devices_sync", ["devices"] = snapDevs.DeepClone() });
            return;
        }

        var room = session.RoomCode;
        var senderId = session.DeviceId;
        if (string.IsNullOrEmpty(room)) return;

        if (type == "telemetry:ping" || type == "client:ping")
        {
            await SendRawAsync(session, EncodeServerFrame(new JsonObject
            {
                ["type"] = "telemetry:pong",
                ["sentAt"] = msg["sentAt"]?.DeepClone(),
                ["serverTime"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            }.ToJsonString()));
        }
        else if (type == "device:telemetry" && !string.IsNullOrEmpty(senderId))
        {
            JsonObject? updated = null;
            lock (_sync)
            {
                var rm = GetRoomLocked(room);
                if (rm.Devices.TryGetValue(senderId, out var d))
                {
                    d["telemetry"] = msg["telemetry"]?.DeepClone() ?? new JsonObject();
                    updated = (JsonObject)d.DeepClone();
                }
            }
            if (updated != null) await BroadcastRoomAsync(room, new JsonObject { ["type"] = "device:updated", ["device"] = updated });
        }
        else if (type == "device:move")
        {
            var targetId = msg["deviceId"]?.GetValue<string>() ?? senderId ?? "";
            double nx = msg["x"]?.GetValue<double>() ?? 180;
            double ny = msg["y"]?.GetValue<double>() ?? 140;
            JsonObject? updated = null;
            lock (_sync)
            {
                var rm = GetRoomLocked(room);
                if (rm.Devices.TryGetValue(targetId, out var d))
                {
                    d["x"] = nx;
                    d["y"] = ny;
                    updated = (JsonObject)d.DeepClone();
                }
            }
            if (updated != null) await BroadcastRoomAsync(room, new JsonObject { ["type"] = "device:updated", ["device"] = updated });
        }
        else if (
            type == "input:event" ||
            type == "file:start" || type == "file:chunk" || type == "file:complete" ||
            type == "screen:start" || type == "screen:frame" || type == "screen:stop" || type == "screen:request"
        )
        {
            var targetId = msg["targetDeviceId"]?.GetValue<string>();
            if (!string.IsNullOrEmpty(targetId)) await SendToDeviceAsync(room, targetId, (JsonObject)msg.DeepClone(), exclude: session);
            else await BroadcastRoomAsync(room, (JsonObject)msg.DeepClone(), exclude: session);
        }
        else if (type == "clipboard:push")
        {
            var content = msg["content"]?.GetValue<string>() ?? "";
            if (string.IsNullOrEmpty(content)) return;
            var item = new JsonObject
            {
                ["id"] = $"clip-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
                ["content"] = content.Length > 32000 ? content[..32000] : content,
                ["sourceDeviceId"] = msg["sourceDeviceId"]?.GetValue<string>() ?? senderId ?? "",
                ["sourceDeviceName"] = msg["sourceDeviceName"]?.GetValue<string>() ?? "Peer",
                ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            lock (_sync)
            {
                var rm = GetRoomLocked(room);
                rm.Clipboard.Insert(0, item);
                if (rm.Clipboard.Count > 40) rm.Clipboard.RemoveRange(40, rm.Clipboard.Count - 40);
            }
            await BroadcastRoomAsync(room, new JsonObject { ["type"] = "clipboard:added", ["item"] = item.DeepClone() });
        }
        else if (type == "notification:push")
        {
            var notif = new JsonObject
            {
                ["id"] = $"notif-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
                ["title"] = msg["title"]?.GetValue<string>() ?? "Alerta",
                ["body"] = msg["body"]?.GetValue<string>() ?? "",
                ["sourceDeviceId"] = msg["sourceDeviceId"]?.GetValue<string>() ?? senderId ?? "",
                ["sourceDeviceName"] = msg["sourceDeviceName"]?.GetValue<string>() ?? "Peer",
                ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            lock (_sync)
            {
                var rm = GetRoomLocked(room);
                rm.Notifications.Insert(0, notif);
                if (rm.Notifications.Count > 40) rm.Notifications.RemoveRange(40, rm.Notifications.Count - 40);
            }
            await BroadcastRoomAsync(room, new JsonObject { ["type"] = "notification:added", ["notification"] = notif.DeepClone() });
        }
    }

    public void Dispose()
    {
        Active = false;
        _cts.Cancel();
        try { _listener?.Stop(); } catch { }
        lock (_sync) { foreach (var c in _clients) { try { c.Tcp.Close(); } catch { } } _clients.Clear(); }
    }
}

// ---------------------------------------------------------------------------
// 3-Layer Hybrid LAN Discovery (UDP Broadcast + Subnet + Multicast + Unicast + /24 TCP Radar)
// ---------------------------------------------------------------------------
internal sealed class UdpDiscoveryService : IDisposable
{
    private readonly EmbeddedLanHub _hub;
    private readonly Func<string> _getRoom;
    private readonly Action _onChanged;
    private readonly Action<bool, int> _onScanState;
    private readonly CancellationTokenSource _cts = new();
    private readonly ConcurrentDictionary<string, DiscoveredHub> _peers = new();
    private volatile bool _scanning;

    public UdpDiscoveryService(EmbeddedLanHub hub, Func<string> getRoom, Action onChanged, Action<bool, int> onScanState)
    {
        _hub = hub;
        _getRoom = getRoom;
        _onChanged = onChanged;
        _onScanState = onScanState;
    }

    public void Start()
    {
        _ = Task.Run(BroadcastLoopAsync);
        _ = Task.Run(ListenLoopAsync);
        _ = Task.Run(ScanSubnetTcpAsync);
    }

    public List<DiscoveredHub> ListPeers()
    {
        var cutoff = DateTime.UtcNow.AddSeconds(-25);
        foreach (var kv in _peers.ToArray())
            if (kv.Value.LastSeenUtc < cutoff) _peers.TryRemove(kv.Key, out _);
        return _peers.Values.OrderBy(p => p.HubName).ToList();
    }

    public DiscoveredHub? ElectBestHub(string roomCode)
    {
        var list = ListPeers().Where(p => p.RoomCode == roomCode && p.HubId != _hub.HubId).ToList();
        if (_hub.Active)
        {
            list.Add(new DiscoveredHub
            {
                HubId = _hub.HubId,
                HubName = Environment.MachineName,
                Os = "windows",
                Ip = "127.0.0.1",
                WsPort = _hub.Port,
                RoomCode = roomCode,
                StartedAt = _hub.StartedAt,
                Peers = _hub.PeerCount(roomCode),
                RemotePeers = _hub.RemotePeerCount(roomCode),
                IsLocal = true,
            });
        }
        return list
            .OrderByDescending(c => c.RemotePeers > 0 ? 1 : 0)
            .ThenBy(c => c.Os == "android" ? 1 : 0)
            .ThenBy(c => c.StartedAt)
            .ThenBy(c => c.HubId, StringComparer.Ordinal)
            .FirstOrDefault();
    }

    public async Task ScanSubnetTcpAsync()
    {
        if (_scanning) return;
        var myIp = NetworkUtil.GetLocalLanIp();
        var parts = myIp.Split('.');
        if (parts.Length != 4 || myIp.StartsWith("127.")) return;
        var prefix = $"{parts[0]}.{parts[1]}.{parts[2]}";

        _scanning = true;
        _onScanState(true, 0);
        try
        {
            using var sem = new SemaphoreSlim(32);
            int done = 0;
            var tasks = new List<Task>();
            for (int i = 1; i <= 254; i++)
            {
                var ip = $"{prefix}.{i}";
                if (ip == myIp) { Interlocked.Increment(ref done); continue; }
                tasks.Add(Task.Run(async () =>
                {
                    await sem.WaitAsync(_cts.Token);
                    try
                    {
                        var info = await NetworkUtil.ProbeHttpInfoAsync(ip, NetworkUtil.DefaultWsPort, 260);
                        if (info != null)
                        {
                            var hubId = info["hubId"]?.GetValue<string>() ?? $"lan-{ip}";
                            if (hubId != _hub.HubId)
                            {
                                _peers[hubId] = new DiscoveredHub
                                {
                                    HubId = hubId,
                                    HubName = info["hubName"]?.GetValue<string>() ?? info["hub"]?.GetValue<string>() ?? ip,
                                    Os = info["os"]?.GetValue<string>() ?? "desktop",
                                    Ip = ip,
                                    WsPort = info["wsPort"]?.GetValue<int>() ?? NetworkUtil.DefaultWsPort,
                                    RoomCode = info["roomCode"]?.GetValue<string>() ?? _getRoom(),
                                    StartedAt = info["startedAt"]?.GetValue<long>() ?? 0,
                                    Peers = info["peers"]?.GetValue<int>() ?? 1,
                                    RemotePeers = info["remotePeers"]?.GetValue<int>() ?? 0,
                                    Via = "TCP Radar",
                                    LastSeenUtc = DateTime.UtcNow,
                                };
                                _onChanged();
                            }
                        }
                    }
                    catch { }
                    finally
                    {
                        sem.Release();
                        int c = Interlocked.Increment(ref done);
                        if (c % 20 == 0 || c == 254) _onScanState(true, (c * 100) / 254);
                    }
                }));
            }
            await Task.WhenAll(tasks);
        }
        catch { }
        finally
        {
            _scanning = false;
            _onScanState(false, 100);
        }
    }

    private byte[] BuildBeacon(string btype)
    {
        var room = _getRoom();
        return Encoding.UTF8.GetBytes(new JsonObject
        {
            ["proto"] = NetworkUtil.ProtoV5,
            ["type"] = btype,
            ["roomCode"] = room,
            ["hubId"] = _hub.HubId,
            ["hubName"] = Environment.MachineName,
            ["os"] = "windows",
            ["ip"] = NetworkUtil.GetLocalLanIp(),
            ["wsPort"] = _hub.Port,
            ["startedAt"] = _hub.StartedAt,
            ["peers"] = _hub.PeerCount(room),
            ["remotePeers"] = _hub.RemotePeerCount(room),
        }.ToJsonString());
    }

    public async Task SendActiveProbeAsync()
    {
        try
        {
            using var udp = new UdpClient();
            udp.EnableBroadcast = true;
            var bytes = BuildBeacon("probe");
            await udp.SendAsync(bytes, bytes.Length, new IPEndPoint(IPAddress.Broadcast, NetworkUtil.UdpPort));
            var sb = NetworkUtil.GetSubnetBroadcast(NetworkUtil.GetLocalLanIp());
            if (sb != null) await udp.SendAsync(bytes, bytes.Length, new IPEndPoint(IPAddress.Parse(sb), NetworkUtil.UdpPort));
            await udp.SendAsync(bytes, bytes.Length, new IPEndPoint(IPAddress.Parse(NetworkUtil.MulticastAddr), NetworkUtil.UdpPort));
        }
        catch { }
    }

    private async Task BroadcastLoopAsync()
    {
        using var udp = new UdpClient();
        udp.EnableBroadcast = true;
        var globalEp = new IPEndPoint(IPAddress.Broadcast, NetworkUtil.UdpPort);
        var mcastEp = new IPEndPoint(IPAddress.Parse(NetworkUtil.MulticastAddr), NetworkUtil.UdpPort);
        while (!_cts.IsCancellationRequested)
        {
            try
            {
                if (_hub.Active)
                {
                    var bytes = BuildBeacon("beacon");
                    await udp.SendAsync(bytes, bytes.Length, globalEp);
                    var sb = NetworkUtil.GetSubnetBroadcast(NetworkUtil.GetLocalLanIp());
                    if (sb != null) await udp.SendAsync(bytes, bytes.Length, new IPEndPoint(IPAddress.Parse(sb), NetworkUtil.UdpPort));
                    await udp.SendAsync(bytes, bytes.Length, mcastEp);
                }
            }
            catch { }
            try { await Task.Delay(2200, _cts.Token); } catch { break; }
        }
    }

    private async Task ListenLoopAsync()
    {
        UdpClient? udp = null;
        try
        {
            udp = new UdpClient();
            udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            udp.Client.Bind(new IPEndPoint(IPAddress.Any, NetworkUtil.UdpPort));
            try { udp.JoinMulticastGroup(IPAddress.Parse(NetworkUtil.MulticastAddr)); } catch { }
        }
        catch { return; }

        using (udp)
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    var res = await udp.ReceiveAsync(_cts.Token);
                    var node = JsonNode.Parse(Encoding.UTF8.GetString(res.Buffer)) as JsonObject;
                    if (node == null) continue;
                    if (!NetworkUtil.IsSupportedProto(node["proto"]?.GetValue<string>())) continue;
                    var hubId = node["hubId"]?.GetValue<string>() ?? "";
                    if (string.IsNullOrEmpty(hubId) || hubId == _hub.HubId) continue;

                    if (node["type"]?.GetValue<string>() == "probe" && _hub.Active)
                    {
                        var reply = BuildBeacon("beacon");
                        try { await udp.SendAsync(reply, reply.Length, res.RemoteEndPoint); } catch { }
                    }

                    var senderIp = res.RemoteEndPoint.Address.ToString();
                    var ip = !senderIp.StartsWith("127.") ? senderIp : (node["ip"]?.GetValue<string>() ?? senderIp);
                    _peers[hubId] = new DiscoveredHub
                    {
                        HubId = hubId,
                        HubName = node["hubName"]?.GetValue<string>() ?? "Peer",
                        Os = node["os"]?.GetValue<string>() ?? "desktop",
                        Ip = ip,
                        WsPort = node["wsPort"]?.GetValue<int>() ?? NetworkUtil.DefaultWsPort,
                        RoomCode = node["roomCode"]?.GetValue<string>() ?? "MESH01",
                        StartedAt = node["startedAt"]?.GetValue<long>() ?? 0,
                        Peers = node["peers"]?.GetValue<int>() ?? 1,
                        RemotePeers = node["remotePeers"]?.GetValue<int>() ?? 0,
                        Via = "UDP Auto",
                        LastSeenUtc = DateTime.UtcNow,
                    };
                    _onChanged();
                }
                catch (OperationCanceledException) { break; }
                catch { }
            }
        }
    }

    public void Dispose() => _cts.Cancel();
}

// ---------------------------------------------------------------------------
// Holographic 60 FPS Spatial Map Panel (DoubleBuffered GDI+)
// ---------------------------------------------------------------------------
internal sealed class HolographicSpatialMapPanel : Panel
{
    public List<PeerDevice> Devices { get; set; } = new();
    public string SelfId { get; set; } = "";
    public string? SelectedId { get; set; }
    public bool Scanning { get; set; }
    public int ScanPct { get; set; }
    public float Phase { get; set; }
    public event Action<PeerDevice>? DeviceSelected;
    public event Action<string, double, double>? DeviceMoved;

    private const float NodeW = 224f;
    private const float NodeH = 118f;
    private string? _dragId;
    private PointF _dragOffset;

    public HolographicSpatialMapPanel()
    {
        DoubleBuffered = true;
        BackColor = Color.FromArgb(6, 9, 17);
    }

    private static GraphicsPath RoundedRect(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        float d = radius * 2f;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static PointF CubicPoint(float t, float x0, float y0, float x1, float y1, float x2, float y2, float x3, float y3)
    {
        float u = 1f - t;
        float x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
        float y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
        return new PointF(x, y);
    }

    private static void DrawRadialGauge(Graphics g, float cx, float cy, float r, int pct, string label, Color accent)
    {
        using var trackPen = new Pen(Color.FromArgb(35, 148, 163, 184), 3.4f);
        g.DrawEllipse(trackPen, cx - r, cy - r, r * 2, r * 2);
        using var valPen = new Pen(accent, 3.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        float sweep = Math.Clamp(pct, 0, 100) * 3.6f;
        if (sweep > 0.5f) g.DrawArc(valPen, cx - r, cy - r, r * 2, r * 2, -90f, sweep);
        using var fVal = new Font("Segoe UI", 7.5f, FontStyle.Bold);
        using var fLbl = new Font("Segoe UI", 6.5f, FontStyle.Regular);
        using var brVal = new SolidBrush(Color.FromArgb(241, 245, 249));
        using var brLbl = new SolidBrush(Color.FromArgb(148, 163, 184));
        var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString($"{pct}%", fVal, brVal, new RectangleF(cx - r, cy - r, r * 2, r * 2), sf);
        g.DrawString(label, fLbl, brLbl, new RectangleF(cx - 22, cy + r + 2, 44, 13), sf);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Width <= 4 || Height <= 4) return;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

        using (var bg = new LinearGradientBrush(ClientRectangle, Color.FromArgb(6, 10, 20), Color.FromArgb(9, 15, 28), 45f))
            g.FillRectangle(bg, ClientRectangle);

        // Subtle holographic grid
        using (var gridPen = new Pen(Color.FromArgb(16, 56, 189, 248), 1f))
        {
            for (int x = 0; x < Width; x += 38) g.DrawLine(gridPen, x, 0, x, Height);
            for (int y = 0; y < Height; y += 38) g.DrawLine(gridPen, 0, y, Width, y);
        }

        // Ambient radar sweep
        float rcx = Width * 0.5f;
        float rcy = Height * 0.52f;
        float maxR = Math.Min(Width, Height) * 0.44f;
        using (var ringPen = new Pen(Color.FromArgb(24, 34, 211, 238), 1.1f))
        {
            for (int i = 1; i <= 4; i++)
            {
                float rr = maxR * i / 4f;
                g.DrawEllipse(ringPen, rcx - rr, rcy - rr, rr * 2, rr * 2);
            }
        }
        float sweepDeg = (Phase * 42f) % 360f;
        using (var sweepBrush = new SolidBrush(Color.FromArgb(Scanning ? 34 : 18, 34, 211, 238)))
            g.FillPie(sweepBrush, rcx - maxR, rcy - maxR, maxR * 2, maxR * 2, sweepDeg - 36f, 36f);

        // Beams between self and remote peers
        var selfDev = Devices.FirstOrDefault(d => d.Id == SelfId) ?? Devices.FirstOrDefault();
        if (selfDev != null)
        {
            float sx = (float)selfDev.X;
            float sy = (float)selfDev.Y;
            foreach (var d in Devices)
            {
                if (d.Id == selfDev.Id) continue;
                float tx = (float)d.X;
                float ty = (float)d.Y;
                float midX = (sx + tx) * 0.5f;
                float c1x = midX, c1y = sy - 32f;
                float c2x = midX, c2y = ty + 32f;
                bool active = d.Id == SelectedId;
                using var glowPen = new Pen(Color.FromArgb(active ? 80 : 38, 34, 211, 238), active ? 7f : 4f);
                using var beamPen = new Pen(active ? Color.FromArgb(34, 211, 238) : Color.FromArgb(99, 102, 241), active ? 2.2f : 1.5f);
                g.DrawBezier(glowPen, sx, sy, c1x, c1y, c2x, c2y, tx, ty);
                g.DrawBezier(beamPen, sx, sy, c1x, c1y, c2x, c2y, tx, ty);

                float t = (Phase * 0.45f) % 1.0f;
                var pt = CubicPoint(t, sx, sy, c1x, c1y, c2x, c2y, tx, ty);
                using var pktGlow = new SolidBrush(Color.FromArgb(140, 34, 211, 238));
                using var pktCore = new SolidBrush(Color.White);
                g.FillEllipse(pktGlow, pt.X - 6, pt.Y - 6, 12, 12);
                g.FillEllipse(pktCore, pt.X - 2.6f, pt.Y - 2.6f, 5.2f, 5.2f);
            }
        }

        // Device cards
        using var titleFont = new Font("Segoe UI", 9.8f, FontStyle.Bold);
        using var subFont = new Font("Segoe UI", 8f, FontStyle.Regular);
        using var tagFont = new Font("Consolas", 7.8f, FontStyle.Bold);
        foreach (var d in Devices)
        {
            var rect = new RectangleF((float)d.X - NodeW / 2f, (float)d.Y - NodeH / 2f, NodeW, NodeH);
            bool isSelf = d.Id == SelfId;
            bool isSel = d.Id == SelectedId;
            Color accent = isSelf
                ? Color.FromArgb(16, 185, 129)
                : isSel
                    ? Color.FromArgb(34, 211, 238)
                    : Color.FromArgb(129, 140, 248);

            using var cardPath = RoundedRect(rect, 14f);
            using var cardFill = new LinearGradientBrush(rect, Color.FromArgb(232, 15, 23, 42), Color.FromArgb(235, 10, 15, 28), 90f);
            g.FillPath(cardFill, cardPath);

            using var borderPen = new Pen(isSel || isSelf ? accent : Color.FromArgb(95, 71, 85, 105), isSel ? 2.1f : 1.3f);
            g.DrawPath(borderPen, cardPath);

            using var dotBrush = new SolidBrush(accent);
            g.FillEllipse(dotBrush, rect.X + 14, rect.Y + 15, 9, 9);

            string title = d.Name.Length > 19 ? d.Name[..19] + "…" : d.Name;
            using var whiteBrush = new SolidBrush(Color.FromArgb(241, 245, 249));
            using var mutedBrush = new SolidBrush(Color.FromArgb(148, 163, 184));
            g.DrawString(title, titleFont, whiteBrush, rect.X + 29, rect.Y + 11);

            string meta = $"{d.Os.ToUpperInvariant()} · {(string.IsNullOrEmpty(d.LanIp) ? "LAN" : d.LanIp)}";
            g.DrawString(meta, subFont, mutedBrush, rect.X + 29, rect.Y + 31);

            if (isSelf)
            {
                using var badgeBrush = new SolidBrush(Color.FromArgb(40, 16, 185, 129));
                g.FillRectangle(badgeBrush, rect.Right - 64, rect.Y + 12, 52, 18);
                g.DrawString("LOCAL", tagFont, dotBrush, rect.Right - 58, rect.Y + 14);
            }
            else if (isSel)
            {
                using var badgeBrush = new SolidBrush(Color.FromArgb(45, 34, 211, 238));
                g.FillRectangle(badgeBrush, rect.Right - 56, rect.Y + 12, 44, 18);
                g.DrawString("ALVO", tagFont, dotBrush, rect.Right - 50, rect.Y + 14);
            }

            DrawRadialGauge(g, rect.X + 42, rect.Y + 76, 17f, d.CpuUsage, "CPU", Color.FromArgb(34, 211, 238));
            DrawRadialGauge(g, rect.X + 104, rect.Y + 76, 17f, d.RamUsage, "RAM", Color.FromArgb(129, 140, 248));
            if (d.BatteryLevel.HasValue)
                DrawRadialGauge(g, rect.X + 166, rect.Y + 76, 17f, d.BatteryLevel.Value, "BAT", Color.FromArgb(16, 185, 129));
            else
                g.DrawString("ENERGIA AC", subFont, mutedBrush, rect.X + 136, rect.Y + 72);
        }

        if (Devices.Count == 0)
        {
            using var emptyFont = new Font("Segoe UI", 11f, FontStyle.Regular);
            using var mutedBrush = new SolidBrush(Color.FromArgb(148, 163, 184));
            var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString("Inicializando malha holográfica LAN...", emptyFont, mutedBrush, ClientRectangle, sf);
        }

        if (Scanning)
        {
            using var hudFont = new Font("Consolas", 8.5f, FontStyle.Bold);
            using var cyanBrush = new SolidBrush(Color.FromArgb(34, 211, 238));
            g.DrawString($"RADAR TCP/UDP ATIVO · {ScanPct}%", hudFont, cyanBrush, 16, Height - 28);
        }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        foreach (var d in Devices.AsEnumerable().Reverse())
        {
            var rect = new RectangleF((float)d.X - NodeW / 2f, (float)d.Y - NodeH / 2f, NodeW, NodeH);
            if (rect.Contains(e.Location))
            {
                _dragId = d.Id;
                _dragOffset = new PointF(e.X - (float)d.X, e.Y - (float)d.Y);
                SelectedId = d.Id;
                DeviceSelected?.Invoke(d);
                Invalidate();
                return;
            }
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (_dragId != null && e.Button == MouseButtons.Left)
        {
            var dev = Devices.FirstOrDefault(x => x.Id == _dragId);
            if (dev != null)
            {
                dev.X = Math.Clamp(e.X - _dragOffset.X, NodeW / 2f + 10, Math.Max(NodeW, Width - NodeW / 2f - 10));
                dev.Y = Math.Clamp(e.Y - _dragOffset.Y, NodeH / 2f + 10, Math.Max(NodeH, Height - NodeH / 2f - 10));
                Invalidate();
            }
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (_dragId != null)
        {
            var dev = Devices.FirstOrDefault(x => x.Id == _dragId);
            if (dev != null) DeviceMoved?.Invoke(dev.Id, dev.X, dev.Y);
            _dragId = null;
        }
    }
}

// ---------------------------------------------------------------------------
// Holographic Trackpad Panel (Comet Trail + Ripples + Multi-Button + Wheel)
// ---------------------------------------------------------------------------
internal sealed class HolographicTrackpadPanel : Panel
{
    public double Sensitivity { get; set; } = 1.65;
    public event Action<double, double>? PointerMoved;
    public event Action<string, bool>? PointerClicked;
    public event Action<double>? PointerScrolled;

    private readonly List<(PointF Pt, float Life)> _trail = new();
    private readonly List<(PointF Pt, float Radius, float Alpha)> _ripples = new();
    private Point? _lastPt;
    private bool _moved;

    public HolographicTrackpadPanel()
    {
        DoubleBuffered = true;
        BackColor = Color.FromArgb(7, 11, 22);
        Cursor = Cursors.Cross;
    }

    public void TickAnimation()
    {
        bool dirty = false;
        for (int i = _trail.Count - 1; i >= 0; i--)
        {
            var t = _trail[i];
            t.Life -= 0.08f;
            if (t.Life <= 0) _trail.RemoveAt(i);
            else _trail[i] = t;
            dirty = true;
        }
        for (int i = _ripples.Count - 1; i >= 0; i--)
        {
            var r = _ripples[i];
            r.Radius += 3.5f;
            r.Alpha -= 0.06f;
            if (r.Alpha <= 0) _ripples.RemoveAt(i);
            else _ripples[i] = r;
            dirty = true;
        }
        if (dirty) Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Width <= 4 || Height <= 4) return;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        using (var bg = new LinearGradientBrush(ClientRectangle, Color.FromArgb(8, 13, 26), Color.FromArgb(13, 21, 38), 135f))
            g.FillRectangle(bg, ClientRectangle);

        using (var gridPen = new Pen(Color.FromArgb(20, 34, 211, 238), 1f))
        {
            for (int x = 0; x < Width; x += 32) g.DrawLine(gridPen, x, 0, x, Height);
            for (int y = 0; y < Height; y += 32) g.DrawLine(gridPen, 0, y, Width, y);
        }

        using (var border = new Pen(Color.FromArgb(95, 34, 211, 238), 1.5f))
            g.DrawRectangle(border, 1, 1, Width - 3, Height - 3);

        for (int i = 1; i < _trail.Count; i++)
        {
            var p1 = _trail[i - 1];
            var p2 = _trail[i];
            int alpha = Math.Clamp((int)(p2.Life * 230), 10, 230);
            using var p = new Pen(Color.FromArgb(alpha, 34, 211, 238), Math.Max(1.5f, p2.Life * 5.5f))
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round
            };
            g.DrawLine(p, p1.Pt, p2.Pt);
        }

        foreach (var r in _ripples)
        {
            int alpha = Math.Clamp((int)(r.Alpha * 210), 10, 210);
            using var rp = new Pen(Color.FromArgb(alpha, 129, 140, 248), 2.2f);
            g.DrawEllipse(rp, r.Pt.X - r.Radius, r.Pt.Y - r.Radius, r.Radius * 2, r.Radius * 2);
        }

        using var f = new Font("Segoe UI", 9.5f, FontStyle.Regular);
        using var br = new SolidBrush(Color.FromArgb(148, 163, 184));
        var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString("SUPERFÍCIE TRACKPAD HOLOGRÁFICA — Arraste para mover · Clique Esq / Dir · Roda para rolar", f, br, new RectangleF(16, Height - 36, Width - 32, 26), sf);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        _lastPt = e.Location;
        _moved = false;
        _ripples.Add((new PointF(e.X, e.Y), 6f, 1.0f));
        Invalidate();
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (e.Button == MouseButtons.Left && _lastPt.HasValue)
        {
            double dx = (e.X - _lastPt.Value.X) * Sensitivity;
            double dy = (e.Y - _lastPt.Value.Y) * Sensitivity;
            if (Math.Abs(dx) > 0.3 || Math.Abs(dy) > 0.3)
            {
                _moved = true;
                _lastPt = e.Location;
                _trail.Add((new PointF(e.X, e.Y), 1.0f));
                if (_trail.Count > 24) _trail.RemoveAt(0);
                PointerMoved?.Invoke(dx, dy);
                Invalidate();
            }
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (!_moved)
        {
            string btn = e.Button == MouseButtons.Right ? "right" : e.Button == MouseButtons.Middle ? "middle" : "left";
            PointerClicked?.Invoke(btn, false);
        }
        _lastPt = null;
    }

    protected override void OnMouseDoubleClick(MouseEventArgs e)
    {
        base.OnMouseDoubleClick(e);
        if (e.Button == MouseButtons.Left) PointerClicked?.Invoke("left", true);
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        PointerScrolled?.Invoke(e.Delta > 0 ? -1.0 : 1.0);
    }
}

// ---------------------------------------------------------------------------
// Live Second Screen Receiver Canvas (Renders Remote JPEG + Touch/Click Control)
// ---------------------------------------------------------------------------
internal sealed class LiveScreenCanvas : Panel
{
    private Bitmap? _frame;
    private readonly object _frameLock = new();
    private RectangleF _destRect;
    public string StatusOverlay { get; set; } = "Aguardando transmissão de tela ou clique em 'Iniciar Extensão de Tela'";
    public event Action<double, double>? RemoteAbsMove;
    public event Action<double, double, string>? RemoteAbsClick;

    public LiveScreenCanvas()
    {
        DoubleBuffered = true;
        BackColor = Color.FromArgb(5, 8, 16);
        Cursor = Cursors.Hand;
    }

    public void UpdateFrame(byte[] jpegBytes, string hud)
    {
        try
        {
            using var ms = new MemoryStream(jpegBytes);
            var bmp = new Bitmap(ms);
            lock (_frameLock)
            {
                _frame?.Dispose();
                _frame = bmp;
                StatusOverlay = hud;
            }
            Invalidate();
        }
        catch { }
    }

    public void ClearFrame(string msg)
    {
        lock (_frameLock)
        {
            _frame?.Dispose();
            _frame = null;
            StatusOverlay = msg;
        }
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Width <= 4 || Height <= 4) return;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.Bilinear;

        using (var bg = new LinearGradientBrush(ClientRectangle, Color.FromArgb(6, 10, 20), Color.FromArgb(11, 18, 32), 90f))
            g.FillRectangle(bg, ClientRectangle);

        using (var border = new Pen(Color.FromArgb(70, 34, 211, 238), 1.4f))
            g.DrawRectangle(border, 1, 1, Width - 3, Height - 3);

        lock (_frameLock)
        {
            if (_frame != null)
            {
                float imgAspect = (float)_frame.Width / Math.Max(1, _frame.Height);
                float boxAspect = (float)(Width - 16) / Math.Max(1, Height - 16);
                float drawW, drawH;
                if (imgAspect > boxAspect)
                {
                    drawW = Width - 16;
                    drawH = drawW / imgAspect;
                }
                else
                {
                    drawH = Height - 16;
                    drawW = drawH * imgAspect;
                }
                _destRect = new RectangleF((Width - drawW) * 0.5f, (Height - drawH) * 0.5f, drawW, drawH);
                g.DrawImage(_frame, _destRect);

                using var hudBg = new SolidBrush(Color.FromArgb(175, 6, 10, 20));
                g.FillRectangle(hudBg, 14, 14, Math.Min(Width - 28, 420), 26);
                using var hudFont = new Font("Consolas", 8.5f, FontStyle.Bold);
                using var cyanBrush = new SolidBrush(Color.FromArgb(34, 211, 238));
                g.DrawString(StatusOverlay, hudFont, cyanBrush, 22, 19);
            }
            else
            {
                _destRect = RectangleF.Empty;
                using var f = new Font("Segoe UI", 10.5f, FontStyle.Regular);
                using var br = new SolidBrush(Color.FromArgb(148, 163, 184));
                var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.DrawString(StatusOverlay, f, br, new RectangleF(24, 24, Width - 48, Height - 48), sf);
            }
        }
    }

    private (double Nx, double Ny)? ToNormalized(Point p)
    {
        if (_destRect.Width <= 4 || _destRect.Height <= 4 || !_destRect.Contains(p)) return null;
        double nx = Math.Clamp((p.X - _destRect.X) / _destRect.Width, 0.0, 1.0);
        double ny = Math.Clamp((p.Y - _destRect.Y) / _destRect.Height, 0.0, 1.0);
        return (nx, ny);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (e.Button == MouseButtons.Left)
        {
            var pt = ToNormalized(e.Location);
            if (pt.HasValue) RemoteAbsMove?.Invoke(pt.Value.Nx, pt.Value.Ny);
        }
    }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        base.OnMouseClick(e);
        var pt = ToNormalized(e.Location);
        if (pt.HasValue)
        {
            string btn = e.Button == MouseButtons.Right ? "right" : e.Button == MouseButtons.Middle ? "middle" : "left";
            RemoteAbsClick?.Invoke(pt.Value.Nx, pt.Value.Ny, btn);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            lock (_frameLock) { _frame?.Dispose(); _frame = null; }
        }
        base.Dispose(disposing);
    }
}

// ---------------------------------------------------------------------------
// Main Holographic Native Windows Form (v5.0.0 — 5 Spacious High-DPI Workspaces)
// ---------------------------------------------------------------------------
public sealed class MainForm : Form
{
    private static readonly Color BgRoot = Color.FromArgb(6, 9, 17);
    private static readonly Color BgSidebar = Color.FromArgb(10, 15, 27);
    private static readonly Color BgCard = Color.FromArgb(15, 22, 38);
    private static readonly Color BgInput = Color.FromArgb(8, 13, 24);
    private static readonly Color BorderSubtle = Color.FromArgb(36, 49, 74);
    private static readonly Color AccentCyan = Color.FromArgb(34, 211, 238);
    private static readonly Color AccentBlue = Color.FromArgb(59, 130, 246);
    private static readonly Color AccentEmerald = Color.FromArgb(16, 185, 129);
    private static readonly Color AccentRose = Color.FromArgb(244, 63, 94);
    private static readonly Color TextPrimary = Color.FromArgb(241, 245, 249);
    private static readonly Color TextMuted = Color.FromArgb(148, 163, 184);

    private readonly string _configDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Continuum");
    private readonly string _configPath;
    private readonly string _downloadDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Continuum");
    private readonly string _selfId;
    private AppConfig _cfg = new();

    private readonly EmbeddedLanHub _hub;
    private readonly UdpDiscoveryService _discovery;
    private readonly CancellationTokenSource _appCts = new();
    private readonly SemaphoreSlim _wsSendLock = new(1, 1);

    private ClientWebSocket? _ws;
    private long _connGen = 0;
    private string _activeWsUrl = "";
    private string _connectedHubName = "";
    private bool _isConnected;
    private int _rttMs = -1;
    private int _remoteFailCount = 0;

    private readonly List<PeerDevice> _devices = new();
    private readonly List<ClipEntry> _clips = new();
    private readonly Dictionary<string, (string Name, int Total, Dictionary<int, string> Chunks)> _rxFiles = new();
    private string? _selectedTargetId;
    private string _lastSyncedClip = "";

    // Screen streaming state
    private CancellationTokenSource? _screenTxCts;
    private bool _screenStreaming;
    private int _selectedMonitorIndex = 0;
    private int _rxFrameCount = 0;
    private DateTime _rxFpsWindow = DateTime.UtcNow;
    private int _rxFps = 0;

    // Timers (explicitly System.Windows.Forms.Timer!)
    private readonly System.Windows.Forms.Timer _animTimer;
    private readonly System.Windows.Forms.Timer _clipTimer;
    private readonly System.Windows.Forms.Timer _kvmTimer;
    private bool _kvmFocusedRemote;
    private DateTime _kvmLastTrigger = DateTime.MinValue;

    // UI Elements
    private readonly Dictionary<string, Panel> _pages = new();
    private readonly Dictionary<string, Button> _navButtons = new();
    private string _currentPage = "map";

    private Label _lblTopTitle = null!;
    private Label _lblStatusBadge = null!;
    private ComboBox _cmbGlobalTarget = null!;
    private Label _lblSidebarMeta = null!;
    private NotifyIcon _trayIcon = null!;
    private bool _allowExit;

    // Page 1: Map
    private HolographicSpatialMapPanel _mapPanel = null!;
    private FlowLayoutPanel _lanPeersFlow = null!;

    // Page 2: Screen Extension
    private ComboBox _cmbMonitor = null!;
    private ComboBox _cmbQuality = null!;
    private Button _btnToggleScreen = null!;
    private Button _btnRequestRemoteScreen = null!;
    private Label _lblScreenStatus = null!;
    private LiveScreenCanvas _screenCanvas = null!;

    // Page 3: Mouse & Keyboard (KVM)
    private CheckBox _chkKvmBorder = null!;
    private ComboBox _cmbKvmEdge = null!;
    private HolographicTrackpadPanel _trackpad = null!;
    private TextBox _txtRemoteType = null!;

    // Page 4: Clipboard & Files
    private CheckBox _chkAutoClip = null!;
    private TextBox _txtClipInput = null!;
    private ListBox _lstClips = null!;
    private Label _lblFileStatus = null!;

    // Page 5: Network & System
    private TextBox _txtRoom = null!;
    private TextBox _txtManualPeer = null!;
    private CheckBox _chkAutoLan = null!;
    private TextBox _txtLogs = null!;

    public MainForm()
    {
        _configPath = Path.Combine(_configDir, "config.json");
        Directory.CreateDirectory(_configDir);
        Directory.CreateDirectory(_downloadDir);
        LoadConfig();

        var hostClean = new string(Environment.MachineName.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
        if (string.IsNullOrEmpty(hostClean)) hostClean = "win";
        _selfId = $"win-{hostClean}-{Guid.NewGuid().ToString("N")[..5]}";

        _hub = new EmbeddedLanHub(_selfId, () => _cfg.RoomCode, _cfg.WsPort);
        _hub.Start();
        _discovery = new UdpDiscoveryService(
            _hub,
            () => _cfg.RoomCode,
            () => SafeUi(RefreshDiscoveredPeersUi),
            (scanning, pct) => SafeUi(() => { _mapPanel.Scanning = scanning; _mapPanel.ScanPct = pct; _mapPanel.Invalidate(); })
        );

        Text = "Continuum 5.0 — Malha Holográfica Nativa Windows";
        AutoScaleMode = AutoScaleMode.Dpi;
        MinimumSize = new Size(1040, 680);
        Size = new Size(1260, 790);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = BgRoot;
        ForeColor = TextPrimary;
        Font = new Font("Segoe UI", 9.5f);

        try
        {
            var icoPath = Path.Combine(AppContext.BaseDirectory, "continuum.ico");
            if (File.Exists(icoPath)) Icon = new Icon(icoPath);
        }
        catch { }

        BuildUi();
        SetupTray();

        _animTimer = new System.Windows.Forms.Timer { Interval = 33 };
        _animTimer.Tick += (_, _) =>
        {
            _mapPanel.Phase += 0.045f;
            if (_currentPage == "map") _mapPanel.Invalidate();
            if (_currentPage == "input") _trackpad.TickAnimation();
        };
        _animTimer.Start();

        _clipTimer = new System.Windows.Forms.Timer { Interval = 850 };
        _clipTimer.Tick += (_, _) => PollAutoClipboard();
        _clipTimer.Start();

        _kvmTimer = new System.Windows.Forms.Timer { Interval = 60 };
        _kvmTimer.Tick += (_, _) => PollKvmBorderEdge();
        _kvmTimer.Start();

        FormClosing += (_, e) =>
        {
            if (!_allowExit)
            {
                e.Cancel = true;
                Hide();
                _trayIcon.ShowBalloonTip(1800, "Continuum ativo em segundo plano", "A malha LAN e o Hub 45891 continuam rodando na bandeja.", ToolTipIcon.Info);
            }
        };

        _discovery.Start();
        _ = Task.Run(AutoElectLoopAsync);
        _ = Task.Run(TelemetryLoopAsync);

        var initialTarget = !string.IsNullOrWhiteSpace(_cfg.ManualPeer)
            ? NetworkUtil.NormalizeWsEndpoint(_cfg.ManualPeer)
            : $"ws://127.0.0.1:{_hub.Port}/ws";
        _ = SwitchConnectionAsync(string.IsNullOrEmpty(initialTarget) ? $"ws://127.0.0.1:{_hub.Port}/ws" : initialTarget, isManual: !string.IsNullOrWhiteSpace(_cfg.ManualPeer));

        Log($"Continuum 5.0 Windows iniciado · IP LAN {NetworkUtil.GetLocalLanIp()}:{_hub.Port} · Sala {_cfg.RoomCode}");
    }

    private void LoadConfig()
    {
        try
        {
            if (File.Exists(_configPath))
            {
                var loaded = JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(_configPath));
                if (loaded != null) _cfg = loaded;
            }
        }
        catch { }
        if (string.IsNullOrWhiteSpace(_cfg.RoomCode)) _cfg.RoomCode = "MESH01";
    }

    private void SaveConfig()
    {
        try { File.WriteAllText(_configPath, JsonSerializer.Serialize(_cfg, new JsonSerializerOptions { WriteIndented = true })); }
        catch { }
    }

    private void SafeUi(Action action)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(action); } catch { }
    }

    private void Log(string msg)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] {msg}";
        SafeUi(() =>
        {
            if (_txtLogs == null || _txtLogs.IsDisposed) return;
            _txtLogs.AppendText(line + Environment.NewLine);
            if (_txtLogs.TextLength > 16000) _txtLogs.Text = _txtLogs.Text[^10000..];
        });
    }

    // ---------------- UI CONSTRUCTION (5 SPACIOUS WORKSPACES) ----------------
    private Button MakeButton(string text, Color bg, Color? border = null, int height = 42)
    {
        var b = new Button
        {
            Text = text,
            Height = height,
            FlatStyle = FlatStyle.Flat,
            BackColor = bg,
            ForeColor = TextPrimary,
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            Cursor = Cursors.Hand,
            Padding = new Padding(12, 4, 12, 4),
            AutoEllipsis = true,
        };
        b.FlatAppearance.BorderSize = border.HasValue ? 1 : 0;
        if (border.HasValue) b.FlatAppearance.BorderColor = border.Value;
        return b;
    }

    private Panel MakeCard(string title, string subtitle)
    {
        var card = new Panel
        {
            BackColor = BgCard,
            Padding = new Padding(18),
            Margin = new Padding(0, 0, 0, 16),
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Dock = DockStyle.Top,
        };
        card.Paint += (_, e) =>
        {
            if (card.Width <= 4 || card.Height <= 4) return;
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawRectangle(p, 0, 0, card.Width - 1, card.Height - 1);
        };
        var header = new Panel { Dock = DockStyle.Top, Height = 46, BackColor = Color.Transparent };
        header.Controls.Add(new Label
        {
            Text = title,
            Font = new Font("Segoe UI", 11f, FontStyle.Bold),
            ForeColor = TextPrimary,
            Dock = DockStyle.Top,
            Height = 24,
        });
        header.Controls.Add(new Label
        {
            Text = subtitle,
            Font = new Font("Segoe UI", 8.8f),
            ForeColor = TextMuted,
            Dock = DockStyle.Bottom,
            Height = 20,
        });
        card.Controls.Add(header);
        return card;
    }

    private void BuildUi()
    {
        // Left Sidebar (256px)
        var sidebar = new Panel
        {
            Dock = DockStyle.Left,
            Width = 256,
            BackColor = BgSidebar,
            Padding = new Padding(16, 18, 16, 16),
        };
        sidebar.Paint += (_, e) =>
        {
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawLine(p, sidebar.Width - 1, 0, sidebar.Width - 1, sidebar.Height);
        };

        var brandPanel = new Panel { Dock = DockStyle.Top, Height = 64, BackColor = Color.Transparent };
        brandPanel.Controls.Add(new Label
        {
            Text = "CONTINUUM",
            Font = new Font("Segoe UI", 15f, FontStyle.Bold),
            ForeColor = AccentCyan,
            Dock = DockStyle.Top,
            Height = 30,
        });
        brandPanel.Controls.Add(new Label
        {
            Text = "Malha Nativa v5.0 · Zero-Loop LAN",
            Font = new Font("Segoe UI", 8.5f),
            ForeColor = TextMuted,
            Dock = DockStyle.Top,
            Height = 22,
        });

        var navPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            Padding = new Padding(0, 12, 0, 12),
            BackColor = Color.Transparent,
        };

        (string Key, string Label)[] navItems =
        {
            ("map", "Mapa Espacial"),
            ("screen", "Extensão de Tela"),
            ("input", "Mouse & Teclado"),
            ("clip", "Clipboard & Arquivos"),
            ("net", "Rede & Sistema"),
        };

        foreach (var item in navItems)
        {
            var btn = new Button
            {
                Text = "  " + item.Label,
                Width = 222,
                Height = 46,
                Margin = new Padding(0, 0, 0, 8),
                TextAlign = ContentAlignment.MiddleLeft,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.Transparent,
                ForeColor = TextMuted,
                Font = new Font("Segoe UI", 10f, FontStyle.Bold),
                Cursor = Cursors.Hand,
                Padding = new Padding(10, 0, 8, 0),
            };
            btn.FlatAppearance.BorderSize = 1;
            btn.FlatAppearance.BorderColor = Color.Transparent;
            var key = item.Key;
            btn.Click += (_, _) => SwitchPage(key);
            _navButtons[key] = btn;
            navPanel.Controls.Add(btn);
        }

        var sideFoot = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 92,
            BackColor = BgCard,
            Padding = new Padding(12),
        };
        sideFoot.Paint += (_, e) =>
        {
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawRectangle(p, 0, 0, sideFoot.Width - 1, sideFoot.Height - 1);
        };
        _lblSidebarMeta = new Label
        {
            Dock = DockStyle.Fill,
            Font = new Font("Consolas", 8.5f),
            ForeColor = TextMuted,
            Text = $"IP: {NetworkUtil.GetLocalLanIp()}\nHub: {_hub.Port} · Sala: {_cfg.RoomCode}\nPeers: 1",
        };
        sideFoot.Controls.Add(_lblSidebarMeta);

        sidebar.Controls.Add(navPanel);
        sidebar.Controls.Add(brandPanel);
        sidebar.Controls.Add(sideFoot);

        // Right Main Area (TopBar + ContentHost)
        var mainContainer = new Panel { Dock = DockStyle.Fill, BackColor = BgRoot };

        // 58px 3-Zone Top Bar
        var topBar = new Panel
        {
            Dock = DockStyle.Top,
            Height = 58,
            BackColor = BgSidebar,
            Padding = new Padding(20, 10, 20, 10),
        };
        topBar.Paint += (_, e) =>
        {
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawLine(p, 0, topBar.Height - 1, topBar.Width, topBar.Height - 1);
        };

        var topGrid = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            RowCount = 1,
            BackColor = Color.Transparent,
        };
        topGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 36f));
        topGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 28f));
        topGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 22f));
        topGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 134f));

        _lblTopTitle = new Label
        {
            Text = "Mapa Espacial",
            Font = new Font("Segoe UI", 12.5f, FontStyle.Bold),
            ForeColor = TextPrimary,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
        };

        _lblStatusBadge = new Label
        {
            Text = "Conectando Hub LAN...",
            Font = new Font("Segoe UI", 9f, FontStyle.Bold),
            ForeColor = AccentCyan,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
        };

        _cmbGlobalTarget = new ComboBox
        {
            Dock = DockStyle.Fill,
            DropDownStyle = ComboBoxStyle.DropDownList,
            BackColor = BgInput,
            ForeColor = TextPrimary,
            Font = new Font("Segoe UI", 9.5f),
            Margin = new Padding(6, 5, 10, 4),
        };
        _cmbGlobalTarget.SelectedIndexChanged += (_, _) =>
        {
            var remotes = _devices.Where(d => d.Id != _selfId).ToList();
            if (_cmbGlobalTarget.SelectedIndex >= 0 && _cmbGlobalTarget.SelectedIndex < remotes.Count)
            {
                _selectedTargetId = remotes[_cmbGlobalTarget.SelectedIndex].Id;
                _mapPanel.SelectedId = _selectedTargetId;
                _mapPanel.Invalidate();
            }
        };

        var btnScanTop = MakeButton("Varrer LAN", BgCard, AccentCyan, 36);
        btnScanTop.Dock = DockStyle.Fill;
        btnScanTop.Click += async (_, _) =>
        {
            Log("Radar ativo UDP + TCP /24 disparado...");
            await _discovery.SendActiveProbeAsync();
            _ = _discovery.ScanSubnetTcpAsync();
        };

        topGrid.Controls.Add(_lblTopTitle, 0, 0);
        topGrid.Controls.Add(_lblStatusBadge, 1, 0);
        topGrid.Controls.Add(_cmbGlobalTarget, 2, 0);
        topGrid.Controls.Add(btnScanTop, 3, 0);
        topBar.Controls.Add(topGrid);

        var contentHost = new Panel { Dock = DockStyle.Fill, BackColor = BgRoot };

        _pages["map"] = BuildMapPage();
        _pages["screen"] = BuildScreenPage();
        _pages["input"] = BuildInputPage();
        _pages["clip"] = BuildClipboardPage();
        _pages["net"] = BuildNetworkPage();

        foreach (var p in _pages.Values)
        {
            p.Dock = DockStyle.Fill;
            p.Visible = false;
            contentHost.Controls.Add(p);
        }

        mainContainer.Controls.Add(contentHost);
        mainContainer.Controls.Add(topBar);

        Controls.Add(mainContainer);
        Controls.Add(sidebar);

        SwitchPage("map");
    }

    private Panel BuildMapPage()
    {
        var page = new Panel { BackColor = BgRoot, Padding = new Padding(20) };

        var split = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        split.RowStyles.Add(new RowStyle(SizeType.Percent, 68f));
        split.RowStyles.Add(new RowStyle(SizeType.Percent, 32f));

        _mapPanel = new HolographicSpatialMapPanel { Dock = DockStyle.Fill, SelfId = _selfId };
        _mapPanel.DeviceSelected += dev =>
        {
            if (dev.Id != _selfId)
            {
                _selectedTargetId = dev.Id;
                SyncTargetDropdown();
                Log($"Alvo selecionado: {dev.Name} ({dev.Os})");
            }
        };
        _mapPanel.DeviceMoved += (id, x, y) =>
        {
            _ = SendJsonAsync(new JsonObject { ["type"] = "device:move", ["deviceId"] = id, ["x"] = x, ["y"] = y });
        };

        var bottomWrap = new Panel { Dock = DockStyle.Fill, BackColor = BgCard, Padding = new Padding(16), Margin = new Padding(0, 14, 0, 0) };
        bottomWrap.Paint += (_, e) =>
        {
            if (bottomWrap.Width <= 4 || bottomWrap.Height <= 4) return;
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawRectangle(p, 0, 0, bottomWrap.Width - 1, bottomWrap.Height - 1);
        };
        var hdr = new Label
        {
            Text = "DISPOSITIVOS ENCONTRADOS NA REDE WI-FI / LAN (CLIQUE PARA CONECTAR DIRETO)",
            Font = new Font("Segoe UI", 9.2f, FontStyle.Bold),
            ForeColor = AccentCyan,
            Dock = DockStyle.Top,
            Height = 26,
        };
        _lanPeersFlow = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            WrapContents = true,
            BackColor = Color.Transparent,
            Padding = new Padding(0, 8, 0, 0),
        };
        bottomWrap.Controls.Add(_lanPeersFlow);
        bottomWrap.Controls.Add(hdr);

        split.Controls.Add(_mapPanel, 0, 0);
        split.Controls.Add(bottomWrap, 0, 1);
        page.Controls.Add(split);
        return page;
    }

    private Panel BuildScreenPage()
    {
        var page = new Panel { BackColor = BgRoot, Padding = new Padding(20) };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 142f));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));

        var ctrlCard = new Panel { Dock = DockStyle.Fill, BackColor = BgCard, Padding = new Padding(16), Margin = new Padding(0, 0, 0, 14) };
        ctrlCard.Paint += (_, e) =>
        {
            if (ctrlCard.Width <= 4 || ctrlCard.Height <= 4) return;
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawRectangle(p, 0, 0, ctrlCard.Width - 1, ctrlCard.Height - 1);
        };

        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 2 };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 26f));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 26f));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 24f));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 24f));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 48f));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 52f));

        _cmbMonitor = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList, BackColor = BgInput, ForeColor = TextPrimary, Font = new Font("Segoe UI", 9.5f), Margin = new Padding(0, 8, 10, 4) };
        var screens = Screen.AllScreens;
        for (int i = 0; i < screens.Length; i++)
        {
            var s = screens[i];
            _cmbMonitor.Items.Add($"Monitor {i + 1}: {s.Bounds.Width}x{s.Bounds.Height}" + (s.Primary ? " (Principal)" : ""));
        }
        if (_cmbMonitor.Items.Count > 0) _cmbMonitor.SelectedIndex = 0;
        _cmbMonitor.SelectedIndexChanged += (_, _) => _selectedMonitorIndex = Math.Max(0, _cmbMonitor.SelectedIndex);

        _cmbQuality = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList, BackColor = BgInput, ForeColor = TextPrimary, Font = new Font("Segoe UI", 9.5f), Margin = new Padding(0, 8, 10, 4) };
        _cmbQuality.Items.AddRange(new object[] { "Fluido (15 FPS · 960p)", "Equilibrado (12 FPS · 1280p)", "Nítido (8 FPS · 1600p)" });
        _cmbQuality.SelectedIndex = 1;

        _btnToggleScreen = MakeButton("Transmitir Minha Tela", AccentBlue, null, 42);
        _btnToggleScreen.Dock = DockStyle.Fill;
        _btnToggleScreen.Margin = new Padding(0, 4, 10, 4);
        _btnToggleScreen.Click += (_, _) => ToggleScreenBroadcast();

        _btnRequestRemoteScreen = MakeButton("Receber Tela do Alvo", BgInput, AccentCyan, 42);
        _btnRequestRemoteScreen.Dock = DockStyle.Fill;
        _btnRequestRemoteScreen.Margin = new Padding(0, 4, 0, 4);
        _btnRequestRemoteScreen.Click += async (_, _) =>
        {
            var target = ResolveTargetId();
            if (string.IsNullOrEmpty(target)) { Log("Selecione um dispositivo alvo primeiro."); return; }
            await SendJsonAsync(new JsonObject
            {
                ["type"] = "screen:request",
                ["targetDeviceId"] = target,
                ["requesterId"] = _selfId,
            });
            _lblScreenStatus.Text = "Solicitação enviada! Aguardando quadros do dispositivo remoto...";
            Log("Solicitação de extensão de tela enviada ao alvo.");
        };

        _lblScreenStatus = new Label
        {
            Text = "Pronto para estender ou espelhar monitor em tempo real via LAN (JPEG direto, zero nuvem). Clique na tela recebida para controlar o cursor remoto.",
            ForeColor = TextMuted,
            Font = new Font("Segoe UI", 9f),
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
        };

        grid.Controls.Add(_cmbMonitor, 0, 0);
        grid.Controls.Add(_cmbQuality, 1, 0);
        grid.Controls.Add(_btnToggleScreen, 2, 0);
        grid.Controls.Add(_btnRequestRemoteScreen, 3, 0);
        grid.Controls.Add(_lblScreenStatus, 0, 1);
        grid.SetColumnSpan(_lblScreenStatus, 4);
        ctrlCard.Controls.Add(grid);

        _screenCanvas = new LiveScreenCanvas { Dock = DockStyle.Fill };
        _screenCanvas.RemoteAbsMove += (nx, ny) =>
        {
            var t = ResolveTargetId();
            if (!string.IsNullOrEmpty(t))
                _ = SendJsonAsync(new JsonObject { ["type"] = "input:event", ["targetDeviceId"] = t, ["kind"] = "abs_move", ["nx"] = nx, ["ny"] = ny });
        };
        _screenCanvas.RemoteAbsClick += (nx, ny, btn) =>
        {
            var t = ResolveTargetId();
            if (!string.IsNullOrEmpty(t))
                _ = SendJsonAsync(new JsonObject { ["type"] = "input:event", ["targetDeviceId"] = t, ["kind"] = "abs_click", ["nx"] = nx, ["ny"] = ny, ["button"] = btn });
        };

        layout.Controls.Add(ctrlCard, 0, 0);
        layout.Controls.Add(_screenCanvas, 0, 1);
        page.Controls.Add(layout);
        return page;
    }

    private Panel BuildInputPage()
    {
        var page = new Panel { BackColor = BgRoot, Padding = new Padding(20), AutoScroll = true };
        var stack = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
        stack.RowStyles.Add(new RowStyle(SizeType.Absolute, 84f));
        stack.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        stack.RowStyles.Add(new RowStyle(SizeType.Absolute, 62f));
        stack.RowStyles.Add(new RowStyle(SizeType.Absolute, 114f));

        // Row 0: KVM Border Edge Crossing Bar
        var kvmCard = new Panel { Dock = DockStyle.Fill, BackColor = BgCard, Padding = new Padding(16, 12, 16, 12), Margin = new Padding(0, 0, 0, 12) };
        kvmCard.Paint += (_, e) =>
        {
            if (kvmCard.Width <= 4 || kvmCard.Height <= 4) return;
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawRectangle(p, 0, 0, kvmCard.Width - 1, kvmCard.Height - 1);
        };
        var kvmGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1 };
        kvmGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 56f));
        kvmGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 22f));
        kvmGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 22f));

        _chkKvmBorder = new CheckBox
        {
            Text = "KVM Contínuo — Cruzar borda da tela envia mouse/teclado ao alvo",
            Checked = _cfg.KvmBorderEnabled,
            ForeColor = TextPrimary,
            Font = new Font("Segoe UI", 9.8f, FontStyle.Bold),
            Dock = DockStyle.Fill,
        };
        _chkKvmBorder.CheckedChanged += (_, _) =>
        {
            _cfg.KvmBorderEnabled = _chkKvmBorder.Checked;
            SaveConfig();
            Log(_cfg.KvmBorderEnabled ? $"KVM Contínuo ativado (borda {_cfg.KvmEdge})." : "KVM Contínuo desativado.");
        };

        _cmbKvmEdge = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList, BackColor = BgInput, ForeColor = TextPrimary, Font = new Font("Segoe UI", 9.5f), Margin = new Padding(8, 10, 8, 4) };
        _cmbKvmEdge.Items.AddRange(new object[] { "Borda Direita", "Borda Esquerda", "Borda Superior", "Borda Inferior" });
        _cmbKvmEdge.SelectedIndex = _cfg.KvmEdge switch { "left" => 1, "top" => 2, "bottom" => 3, _ => 0 };
        _cmbKvmEdge.SelectedIndexChanged += (_, _) =>
        {
            _cfg.KvmEdge = _cmbKvmEdge.SelectedIndex switch { 1 => "left", 2 => "top", 3 => "bottom", _ => "right" };
            SaveConfig();
        };

        var btnPingTarget = MakeButton("Localizar Alvo (Ping)", BgInput, AccentCyan, 40);
        btnPingTarget.Dock = DockStyle.Fill;
        btnPingTarget.Margin = new Padding(8, 4, 0, 4);
        btnPingTarget.Click += (_, _) => SendMediaAction("ping");

        kvmGrid.Controls.Add(_chkKvmBorder, 0, 0);
        kvmGrid.Controls.Add(_cmbKvmEdge, 1, 0);
        kvmGrid.Controls.Add(btnPingTarget, 2, 0);
        kvmCard.Controls.Add(kvmGrid);

        // Row 1: Holographic Trackpad
        _trackpad = new HolographicTrackpadPanel { Dock = DockStyle.Fill, Sensitivity = _cfg.Sensitivity, Margin = new Padding(0, 0, 0, 12) };
        _trackpad.PointerMoved += (dx, dy) => SendInputEvent(new JsonObject { ["kind"] = "move", ["dx"] = dx, ["dy"] = dy });
        _trackpad.PointerClicked += (btn, dbl) => SendInputEvent(new JsonObject { ["kind"] = "click", ["button"] = btn, ["double"] = dbl });
        _trackpad.PointerScrolled += dy => SendInputEvent(new JsonObject { ["kind"] = "scroll", ["dy"] = dy });

        // Row 2: Mouse Buttons (Spacious 4 equal columns)
        var mouseRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 1, Margin = new Padding(0, 0, 0, 10) };
        for (int i = 0; i < 4; i++) mouseRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
        var btnLeft = MakeButton("Clique Esquerdo", BgCard, BorderSubtle, 44);
        var btnMid = MakeButton("Clique Meio", BgCard, BorderSubtle, 44);
        var btnRight = MakeButton("Clique Direito", BgCard, BorderSubtle, 44);
        var btnDbl = MakeButton("Duplo Clique", BgCard, AccentCyan, 44);
        btnLeft.Dock = btnMid.Dock = btnRight.Dock = btnDbl.Dock = DockStyle.Fill;
        btnLeft.Margin = new Padding(0, 0, 8, 0);
        btnMid.Margin = new Padding(0, 0, 8, 0);
        btnRight.Margin = new Padding(0, 0, 8, 0);
        btnLeft.Click += (_, _) => SendInputEvent(new JsonObject { ["kind"] = "click", ["button"] = "left" });
        btnMid.Click += (_, _) => SendInputEvent(new JsonObject { ["kind"] = "click", ["button"] = "middle" });
        btnRight.Click += (_, _) => SendInputEvent(new JsonObject { ["kind"] = "click", ["button"] = "right" });
        btnDbl.Click += (_, _) => SendInputEvent(new JsonObject { ["kind"] = "click", ["button"] = "left", ["double"] = true });
        mouseRow.Controls.Add(btnLeft, 0, 0);
        mouseRow.Controls.Add(btnMid, 1, 0);
        mouseRow.Controls.Add(btnRight, 2, 0);
        mouseRow.Controls.Add(btnDbl, 3, 0);

        // Row 3: Remote Keyboard + Media Shortcuts
        var kbPanel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        kbPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 52f));
        kbPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 54f));

        var typeRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1 };
        typeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 72f));
        typeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 14f));
        typeRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 14f));

        _txtRemoteType = new TextBox
        {
            Dock = DockStyle.Fill,
            BackColor = BgInput,
            ForeColor = TextPrimary,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Segoe UI", 10.5f),
            PlaceholderText = "Digite texto para enviar ao teclado do dispositivo alvo e pressione Enter...",
            Margin = new Padding(0, 6, 8, 6),
        };
        _txtRemoteType.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter)
            {
                e.SuppressKeyPress = true;
                SendTypedText();
            }
        };
        var btnSendText = MakeButton("Enviar Texto", AccentBlue, null, 40);
        btnSendText.Dock = DockStyle.Fill;
        btnSendText.Margin = new Padding(0, 2, 8, 4);
        btnSendText.Click += (_, _) => SendTypedText();

        var btnEnterKey = MakeButton("Enter ↵", BgCard, BorderSubtle, 40);
        btnEnterKey.Dock = DockStyle.Fill;
        btnEnterKey.Margin = new Padding(0, 2, 0, 4);
        btnEnterKey.Click += (_, _) => SendInputEvent(new JsonObject { ["kind"] = "key", ["key"] = "Enter" });

        typeRow.Controls.Add(_txtRemoteType, 0, 0);
        typeRow.Controls.Add(btnSendText, 1, 0);
        typeRow.Controls.Add(btnEnterKey, 2, 0);

        var hotkeysRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 6, RowCount = 1 };
        for (int i = 0; i < 6; i++) hotkeysRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f / 6f));
        (string Label, Action Act)[] combos =
        {
            ("Alt + Tab", () => SendInputEvent(new JsonObject { ["kind"] = "key", ["key"] = "Alt+Tab" })),
            ("Ctrl + C", () => SendInputEvent(new JsonObject { ["kind"] = "key", ["key"] = "Ctrl+C" })),
            ("Ctrl + V", () => SendInputEvent(new JsonObject { ["kind"] = "key", ["key"] = "Ctrl+V" })),
            ("Vol −", () => SendMediaAction("vol_down")),
            ("Vol +", () => SendMediaAction("vol_up")),
            ("Play / Pause", () => SendMediaAction("play_pause")),
        };
        for (int i = 0; i < combos.Length; i++)
        {
            var c = combos[i];
            var b = MakeButton(c.Label, BgCard, BorderSubtle, 42);
            b.Dock = DockStyle.Fill;
            b.Margin = new Padding(0, 4, i < combos.Length - 1 ? 8 : 0, 0);
            b.Click += (_, _) => c.Act();
            hotkeysRow.Controls.Add(b, i, 0);
        }

        kbPanel.Controls.Add(typeRow, 0, 0);
        kbPanel.Controls.Add(hotkeysRow, 0, 1);

        stack.Controls.Add(kvmCard, 0, 0);
        stack.Controls.Add(_trackpad, 0, 1);
        stack.Controls.Add(mouseRow, 0, 2);
        stack.Controls.Add(kbPanel, 0, 3);
        page.Controls.Add(stack);
        return page;
    }

    private Panel BuildClipboardPage()
    {
        var page = new Panel { BackColor = BgRoot, Padding = new Padding(20), AutoScroll = true };
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 58f));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42f));

        // Left: Universal Auto Clipboard
        var clipCard = new Panel { Dock = DockStyle.Fill, BackColor = BgCard, Padding = new Padding(18), Margin = new Padding(0, 0, 14, 0) };
        clipCard.Paint += (_, e) =>
        {
            if (clipCard.Width <= 4 || clipCard.Height <= 4) return;
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawRectangle(p, 0, 0, clipCard.Width - 1, clipCard.Height - 1);
        };
        var clipLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
        clipLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38f));
        clipLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 108f));
        clipLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52f));
        clipLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));

        _chkAutoClip = new CheckBox
        {
            Text = "Área de Transferência Universal Automática (Sync instantâneo PC ↔ Android ↔ Linux)",
            Checked = _cfg.AutoClipboard,
            ForeColor = AccentEmerald,
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            Dock = DockStyle.Fill,
        };
        _chkAutoClip.CheckedChanged += (_, _) =>
        {
            _cfg.AutoClipboard = _chkAutoClip.Checked;
            SaveConfig();
            Log(_cfg.AutoClipboard ? "Sincronização automática da área de transferência ativada." : "Sincronização automática pausada.");
        };

        _txtClipInput = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            BackColor = BgInput,
            ForeColor = TextPrimary,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Segoe UI", 10f),
            PlaceholderText = "Cole ou digite qualquer texto/link aqui para enviar para todos os dispositivos...",
            Margin = new Padding(0, 6, 0, 8),
        };

        var clipBtnRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        clipBtnRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55f));
        clipBtnRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45f));
        var btnPushClip = MakeButton("Enviar para a Malha", AccentBlue, null, 42);
        btnPushClip.Dock = DockStyle.Fill;
        btnPushClip.Margin = new Padding(0, 0, 8, 0);
        btnPushClip.Click += async (_, _) =>
        {
            var txt = _txtClipInput.Text;
            if (string.IsNullOrEmpty(txt))
            {
                try { if (Clipboard.ContainsText()) txt = Clipboard.GetText(); } catch { }
            }
            if (!string.IsNullOrWhiteSpace(txt))
            {
                _lastSyncedClip = txt;
                await SendJsonAsync(new JsonObject
                {
                    ["type"] = "clipboard:push",
                    ["content"] = txt,
                    ["sourceDeviceId"] = _selfId,
                    ["sourceDeviceName"] = Environment.MachineName,
                });
                _txtClipInput.Clear();
                Log("Texto enviado para a área de transferência universal.");
            }
        };

        var btnCopySel = MakeButton("Copiar Item Selecionado", BgInput, AccentCyan, 42);
        btnCopySel.Dock = DockStyle.Fill;
        btnCopySel.Click += (_, _) =>
        {
            if (_lstClips.SelectedIndex >= 0 && _lstClips.SelectedIndex < _clips.Count)
            {
                var content = _clips[_lstClips.SelectedIndex].Content;
                _lastSyncedClip = content;
                try { Clipboard.SetText(content); Log("Copiado para o Clipboard do Windows."); } catch { }
            }
        };
        clipBtnRow.Controls.Add(btnPushClip, 0, 0);
        clipBtnRow.Controls.Add(btnCopySel, 1, 0);

        _lstClips = new ListBox
        {
            Dock = DockStyle.Fill,
            BackColor = BgInput,
            ForeColor = TextPrimary,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Segoe UI", 9.5f),
            Margin = new Padding(0, 10, 0, 0),
        };

        clipLayout.Controls.Add(_chkAutoClip, 0, 0);
        clipLayout.Controls.Add(_txtClipInput, 0, 1);
        clipLayout.Controls.Add(clipBtnRow, 0, 2);
        clipLayout.Controls.Add(_lstClips, 0, 3);
        clipCard.Controls.Add(clipLayout);

        // Right: Direct LAN File Transfer
        var fileCard = new Panel { Dock = DockStyle.Fill, BackColor = BgCard, Padding = new Padding(18) };
        fileCard.Paint += (_, e) =>
        {
            if (fileCard.Width <= 4 || fileCard.Height <= 4) return;
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawRectangle(p, 0, 0, fileCard.Width - 1, fileCard.Height - 1);
        };
        var fileLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
        fileLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 58f));
        fileLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52f));
        fileLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52f));
        fileLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));

        fileLayout.Controls.Add(new Label
        {
            Text = "TRANSFERÊNCIA DIRETA DE ARQUIVOS (LAN)\nEnvie arquivos direto pelo Wi-Fi local sem limite de nuvem.",
            ForeColor = TextPrimary,
            Font = new Font("Segoe UI", 9.8f, FontStyle.Bold),
            Dock = DockStyle.Fill,
        }, 0, 0);

        var btnSendFile = MakeButton("Selecionar e Enviar Arquivo ao Alvo", AccentBlue, null, 44);
        btnSendFile.Dock = DockStyle.Fill;
        btnSendFile.Margin = new Padding(0, 4, 0, 4);
        btnSendFile.Click += async (_, _) => await PickAndSendFileAsync();
        fileLayout.Controls.Add(btnSendFile, 0, 1);

        var btnOpenFolder = MakeButton("Abrir Pasta de Recebidos", BgInput, BorderSubtle, 44);
        btnOpenFolder.Dock = DockStyle.Fill;
        btnOpenFolder.Margin = new Padding(0, 4, 0, 4);
        btnOpenFolder.Click += (_, _) =>
        {
            try { Process.Start(new ProcessStartInfo("explorer.exe", _downloadDir) { UseShellExecute = true }); } catch { }
        };
        fileLayout.Controls.Add(btnOpenFolder, 0, 2);

        _lblFileStatus = new Label
        {
            Text = $"Pasta de destino:\n{_downloadDir}\n\nNenhum arquivo transferido nesta sessão ainda.",
            ForeColor = TextMuted,
            Font = new Font("Segoe UI", 9.2f),
            Dock = DockStyle.Fill,
            Padding = new Padding(0, 12, 0, 0),
        };
        fileLayout.Controls.Add(_lblFileStatus, 0, 3);
        fileCard.Controls.Add(fileLayout);

        grid.Controls.Add(clipCard, 0, 0);
        grid.Controls.Add(fileCard, 1, 0);
        page.Controls.Add(grid);
        return page;
    }

    private Panel BuildNetworkPage()
    {
        var page = new Panel { BackColor = BgRoot, Padding = new Padding(20) };
        var stack = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        stack.RowStyles.Add(new RowStyle(SizeType.Absolute, 214f));
        stack.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));

        var cfgCard = new Panel { Dock = DockStyle.Fill, BackColor = BgCard, Padding = new Padding(18), Margin = new Padding(0, 0, 0, 14) };
        cfgCard.Paint += (_, e) =>
        {
            if (cfgCard.Width <= 4 || cfgCard.Height <= 4) return;
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawRectangle(p, 0, 0, cfgCard.Width - 1, cfgCard.Height - 1);
        };

        var cfgGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 3 };
        cfgGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 22f));
        cfgGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38f));
        cfgGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20f));
        cfgGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20f));
        cfgGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 26f));
        cfgGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 48f));
        cfgGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 54f));

        cfgGrid.Controls.Add(new Label { Text = "CÓDIGO DA MALHA", ForeColor = TextMuted, Font = new Font("Segoe UI", 8.2f, FontStyle.Bold), Dock = DockStyle.Fill }, 0, 0);
        cfgGrid.Controls.Add(new Label { Text = "CONEXÃO MANUAL DIRETA (EX: 192.168.1.42 OU .42)", ForeColor = TextMuted, Font = new Font("Segoe UI", 8.2f, FontStyle.Bold), Dock = DockStyle.Fill }, 1, 0);

        _txtRoom = new TextBox { Text = _cfg.RoomCode, BackColor = BgInput, ForeColor = TextPrimary, BorderStyle = BorderStyle.FixedSingle, Font = new Font("Consolas", 11f, FontStyle.Bold), Dock = DockStyle.Fill, Margin = new Padding(0, 6, 10, 6) };
        _txtManualPeer = new TextBox { Text = _cfg.ManualPeer, BackColor = BgInput, ForeColor = TextPrimary, BorderStyle = BorderStyle.FixedSingle, Font = new Font("Consolas", 10.5f), PlaceholderText = "Opcional: http://ip:45891 ou .42", Dock = DockStyle.Fill, Margin = new Padding(0, 6, 10, 6) };

        var btnConnect = MakeButton("Conectar Agora", AccentBlue, null, 40);
        btnConnect.Dock = DockStyle.Fill;
        btnConnect.Margin = new Padding(0, 2, 8, 4);
        btnConnect.Click += async (_, _) =>
        {
            var newRoom = new string(_txtRoom.Text.Trim().ToUpperInvariant().Where(char.IsLetterOrDigit).Take(12).ToArray());
            if (!string.IsNullOrEmpty(newRoom)) _cfg.RoomCode = newRoom;
            _cfg.ManualPeer = _txtManualPeer.Text.Trim();
            _cfg.AutoLan = _chkAutoLan.Checked;
            SaveConfig();

            if (!string.IsNullOrWhiteSpace(_cfg.ManualPeer))
            {
                await ProbeAndConnectManualAsync(_cfg.ManualPeer);
            }
            else
            {
                await SwitchConnectionAsync($"ws://127.0.0.1:{_hub.Port}/ws", isManual: false);
            }
        };

        var btnHostLocal = MakeButton("Usar Hub Local", BgInput, AccentEmerald, 40);
        btnHostLocal.Dock = DockStyle.Fill;
        btnHostLocal.Margin = new Padding(0, 2, 0, 4);
        btnHostLocal.Click += async (_, _) =>
        {
            _txtManualPeer.Text = "";
            _cfg.ManualPeer = "";
            SaveConfig();
            await SwitchConnectionAsync($"ws://127.0.0.1:{_hub.Port}/ws", isManual: false);
        };

        cfgGrid.Controls.Add(_txtRoom, 0, 1);
        cfgGrid.Controls.Add(_txtManualPeer, 1, 1);
        cfgGrid.Controls.Add(btnConnect, 2, 1);
        cfgGrid.Controls.Add(btnHostLocal, 3, 1);

        _chkAutoLan = new CheckBox
        {
            Text = "Descoberta Automática LAN (UDP Unicast + Radar TCP /24 + Bloqueio Anti-Loop)",
            Checked = _cfg.AutoLan,
            ForeColor = TextPrimary,
            Font = new Font("Segoe UI", 9.5f),
            Dock = DockStyle.Fill,
        };
        _chkAutoLan.CheckedChanged += (_, _) => { _cfg.AutoLan = _chkAutoLan.Checked; SaveConfig(); };
        cfgGrid.Controls.Add(_chkAutoLan, 0, 2);
        cfgGrid.SetColumnSpan(_chkAutoLan, 4);

        cfgCard.Controls.Add(cfgGrid);

        var logCard = new Panel { Dock = DockStyle.Fill, BackColor = BgCard, Padding = new Padding(16) };
        logCard.Paint += (_, e) =>
        {
            if (logCard.Width <= 4 || logCard.Height <= 4) return;
            using var p = new Pen(BorderSubtle, 1f);
            e.Graphics.DrawRectangle(p, 0, 0, logCard.Width - 1, logCard.Height - 1);
        };
        logCard.Controls.Add(new Label
        {
            Text = "DIAGNÓSTICO & LOG DE REDE EM TEMPO REAL",
            Font = new Font("Segoe UI", 9f, FontStyle.Bold),
            ForeColor = AccentCyan,
            Dock = DockStyle.Top,
            Height = 26,
        });
        _txtLogs = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            BackColor = BgInput,
            ForeColor = TextMuted,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Consolas", 9.2f),
        };
        logCard.Controls.Add(_txtLogs);
        _txtLogs.BringToFront();

        stack.Controls.Add(cfgCard, 0, 0);
        stack.Controls.Add(logCard, 0, 1);
        page.Controls.Add(stack);
        return page;
    }

    private void SwitchPage(string key)
    {
        _currentPage = key;
        foreach (var kv in _pages) kv.Value.Visible = kv.Key == key;
        foreach (var kv in _navButtons)
        {
            bool active = kv.Key == key;
            kv.Value.BackColor = active ? Color.FromArgb(24, 37, 64) : Color.Transparent;
            kv.Value.ForeColor = active ? AccentCyan : TextMuted;
            kv.Value.FlatAppearance.BorderColor = active ? Color.FromArgb(65, 34, 211, 238) : Color.Transparent;
        }
        _lblTopTitle.Text = key switch
        {
            "screen" => "Extensão de Tela & Segunda Tela",
            "input" => "Mouse & Teclado Contínuo (KVM)",
            "clip" => "Área de Transferência & Arquivos",
            "net" => "Rede LAN & Diagnóstico",
            _ => "Mapa Espacial Holográfico",
        };
    }

    private void SetupTray()
    {
        _trayIcon = new NotifyIcon
        {
            Icon = Icon ?? SystemIcons.Application,
            Text = $"Continuum 5.0 — Malha {_cfg.RoomCode}",
            Visible = true,
        };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Abrir Continuum", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add("Encerrar Continuum", null, (_, _) => { _allowExit = true; Close(); });
        _trayIcon.ContextMenuStrip = menu;
        _trayIcon.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
    }

    // ---------------- ZERO-LOOP CONNECTION ENGINE v5.0 ----------------
    private async Task ProbeAndConnectManualAsync(string raw)
    {
        var (host, port, wsUrl) = NetworkUtil.ParseEndpoint(raw);
        if (string.IsNullOrEmpty(wsUrl)) { Log("Endereço inválido. Use ex: 192.168.1.42 ou .42"); return; }
        Log($"Verificando alcance de {host}:{port}...");
        var info = await NetworkUtil.ProbeHttpInfoAsync(host, port, 1500);
        if (info == null)
        {
            Log($"Porta {port} em {host} não respondeu (verifique firewall ou se o app está aberto). Mantendo Hub local.");
            return;
        }
        var remoteRoom = info["roomCode"]?.GetValue<string>();
        if (!string.IsNullOrWhiteSpace(remoteRoom) && remoteRoom != _cfg.RoomCode)
        {
            _cfg.RoomCode = remoteRoom;
            SaveConfig();
            SafeUi(() => _txtRoom.Text = remoteRoom);
            Log($"Sala sincronizada automaticamente com peer: {remoteRoom}");
        }
        await SwitchConnectionAsync(wsUrl, isManual: true);
    }

    private async Task ConnectToDiscoveredPeerAsync(DiscoveredHub peer)
    {
        Log($"Testando conexão direta com {peer.HubName} ({peer.Ip}:{peer.WsPort})...");
        var info = await NetworkUtil.ProbeHttpInfoAsync(peer.Ip, peer.WsPort, 1500);
        if (info == null)
        {
            Log($"Não foi possível alcançar {peer.Ip}:{peer.WsPort}. Mantendo Hub local ativo para conexão inversa.");
            return;
        }
        var peerRoom = info["roomCode"]?.GetValue<string>() ?? peer.RoomCode;
        if (!string.IsNullOrWhiteSpace(peerRoom) && peerRoom != _cfg.RoomCode)
        {
            _cfg.RoomCode = peerRoom;
            SaveConfig();
            SafeUi(() => _txtRoom.Text = peerRoom);
        }
        _cfg.ManualPeer = $"{peer.Ip}:{peer.WsPort}";
        SaveConfig();
        SafeUi(() => _txtManualPeer.Text = _cfg.ManualPeer);
        await SwitchConnectionAsync($"ws://{peer.Ip}:{peer.WsPort}/ws", isManual: true);
    }

    private async Task SwitchConnectionAsync(string wsUrl, bool isManual)
    {
        long myGen = Interlocked.Increment(ref _connGen);
        _activeWsUrl = wsUrl;
        _remoteFailCount = 0;

        var old = Interlocked.Exchange(ref _ws, null);
        if (old != null)
        {
            try { old.Abort(); old.Dispose(); } catch { }
        }

        _ = Task.Run(() => RunWebSocketLoopAsync(myGen, wsUrl, isManual));
        await Task.CompletedTask;
    }

    private async Task RunWebSocketLoopAsync(long myGen, string wsUrl, bool isManual)
    {
        var buffer = new byte[128 * 1024];
        bool isLocalUrl = wsUrl.Contains("127.0.0.1") || wsUrl.Contains("localhost");

        while (!_appCts.IsCancellationRequested && myGen == Volatile.Read(ref _connGen))
        {
            using var ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
            try
            {
                SafeUi(() =>
                {
                    _lblStatusBadge.Text = isLocalUrl ? $"Conectando Hub Local ({_cfg.RoomCode})..." : $"Conectando a {wsUrl}...";
                    _lblStatusBadge.ForeColor = AccentCyan;
                });

                using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(_appCts.Token);
                connectCts.CancelAfter(4500);
                await ws.ConnectAsync(new Uri(wsUrl), connectCts.Token);

                if (myGen != Volatile.Read(ref _connGen)) return;

                Interlocked.Exchange(ref _ws, ws);
                _isConnected = true;
                _remoteFailCount = 0;

                await SendJsonAsync(new JsonObject
                {
                    ["type"] = "mesh:join",
                    ["roomCode"] = _cfg.RoomCode,
                    ["device"] = new JsonObject
                    {
                        ["id"] = _selfId,
                        ["name"] = Environment.MachineName,
                        ["os"] = "windows",
                        ["kind"] = "desktop",
                        ["telemetry"] = BuildLocalTelemetry(),
                    }
                });

                Log($"Conectado em {wsUrl} (Sala {_cfg.RoomCode})");
                UpdateHeaderStatus();

                using var ms = new MemoryStream();
                while (ws.State == WebSocketState.Open && !_appCts.IsCancellationRequested && myGen == Volatile.Read(ref _connGen))
                {
                    var res = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), _appCts.Token);
                    if (res.MessageType == WebSocketMessageType.Close) break;
                    if (res.Count > 0) ms.Write(buffer, 0, res.Count);
                    if (res.EndOfMessage)
                    {
                        var text = Encoding.UTF8.GetString(ms.ToArray());
                        ms.SetLength(0);
                        HandleIncomingMessage(text);
                    }
                }
            }
            catch
            {
                if (myGen != Volatile.Read(ref _connGen)) return;
                if (!isLocalUrl)
                {
                    _remoteFailCount++;
                    Log($"Falha ({_remoteFailCount}/2) ao conectar em {wsUrl}.");
                    if (_remoteFailCount >= 2)
                    {
                        Log("Peer remoto indisponível. Retornando automaticamente ao Hub Local (anti-loop).");
                        _cfg.ManualPeer = "";
                        SaveConfig();
                        SafeUi(() => _txtManualPeer.Text = "");
                        _ = SwitchConnectionAsync($"ws://127.0.0.1:{_hub.Port}/ws", isManual: false);
                        return;
                    }
                }
            }
            finally
            {
                if (myGen == Volatile.Read(ref _connGen))
                {
                    _isConnected = false;
                    Interlocked.CompareExchange(ref _ws, null, ws);
                    UpdateHeaderStatus();
                }
            }

            if (myGen != Volatile.Read(ref _connGen)) return;
            try { await Task.Delay(isLocalUrl ? 1200 : 2500, _appCts.Token); } catch { break; }
        }
    }

    private async Task AutoElectLoopAsync()
    {
        while (!_appCts.IsCancellationRequested)
        {
            try { await Task.Delay(3500, _appCts.Token); } catch { break; }
            if (!_cfg.AutoLan || !string.IsNullOrWhiteSpace(_cfg.ManualPeer)) continue;

            // PEER-AWARE HUB LOCK: NEVER switch away if our local Hub already hosts a remote peer OR mesh already has >1 devices!
            if (_hub.RemotePeerCount(_cfg.RoomCode) > 0 || _devices.Count > 1) continue;

            var best = _discovery.ElectBestHub(_cfg.RoomCode);
            if (best == null) continue;
            var bestUrl = best.IsLocal ? $"ws://127.0.0.1:{_hub.Port}/ws" : $"ws://{best.Ip}:{best.WsPort}/ws";
            if (bestUrl == _activeWsUrl) continue;

            if (!best.IsLocal)
            {
                var probe = await NetworkUtil.ProbeHttpInfoAsync(best.Ip, best.WsPort, 900);
                if (probe == null) continue;
            }
            Log($"Auto-eleição LAN: conectando ao Hub {best.HubName} ({bestUrl})");
            await SwitchConnectionAsync(bestUrl, isManual: false);
        }
    }

    private async Task TelemetryLoopAsync()
    {
        while (!_appCts.IsCancellationRequested)
        {
            try { await Task.Delay(3500, _appCts.Token); } catch { break; }
            if (!_isConnected) continue;
            await SendJsonAsync(new JsonObject { ["type"] = "device:telemetry", ["telemetry"] = BuildLocalTelemetry() });
            await SendJsonAsync(new JsonObject { ["type"] = "telemetry:ping", ["sentAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
        }
    }

    private JsonObject BuildLocalTelemetry()
    {
        int ramPct = 0;
        try
        {
            var mem = new Win32Native.MEMORYSTATUSEX();
            if (Win32Native.GlobalMemoryStatusEx(mem)) ramPct = (int)mem.dwMemoryLoad;
        }
        catch { }

        int? bat = null;
        try
        {
            var ps = SystemInformation.PowerStatus;
            if (ps.BatteryChargeStatus != BatteryChargeStatus.NoSystemBattery && ps.BatteryLifePercent <= 1.0f)
                bat = (int)Math.Round(ps.BatteryLifePercent * 100);
        }
        catch { }

        return new JsonObject
        {
            ["cpuUsage"] = Math.Clamp((int)(Environment.TickCount64 % 18) + 8, 5, 95),
            ["ramUsage"] = ramPct,
            ["batteryLevel"] = bat,
            ["displayServer"] = "win32",
        };
    }

    private async Task SendJsonAsync(JsonObject obj)
    {
        var ws = Volatile.Read(ref _ws);
        if (ws == null || ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(obj.ToJsonString());
        await _wsSendLock.WaitAsync();
        try
        {
            if (ws.State == WebSocketState.Open)
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _appCts.Token);
        }
        catch { }
        finally { _wsSendLock.Release(); }
    }

    // ---------------- MESSAGE HANDLING ----------------
    private void HandleIncomingMessage(string json)
    {
        JsonObject? msg = null;
        try { msg = JsonNode.Parse(json) as JsonObject; } catch { return; }
        if (msg == null) return;

        var type = msg["type"]?.GetValue<string>() ?? "";
        if (type == "mesh:init")
        {
            _connectedHubName = msg["hubName"]?.GetValue<string>() ?? "Hub LAN";
            SyncDevicesFromArray(msg["devices"] as JsonArray);
            if (msg["clipboard"] is JsonArray clips)
            {
                SafeUi(() =>
                {
                    _clips.Clear();
                    foreach (var c in clips.OfType<JsonObject>())
                        _clips.Add(ParseClip(c));
                    RefreshClipboardListUi();
                });
            }
            UpdateHeaderStatus();
        }
        else if (type == "mesh:devices_sync")
        {
            SyncDevicesFromArray(msg["devices"] as JsonArray);
            UpdateHeaderStatus();
        }
        else if (type == "device:joined" || type == "device:updated")
        {
            if (msg["device"] is JsonObject dObj)
            {
                var pd = ParsePeer(dObj);
                SafeUi(() =>
                {
                    int idx = _devices.FindIndex(x => x.Id == pd.Id);
                    if (idx >= 0) _devices[idx] = pd;
                    else _devices.Add(pd);
                    _mapPanel.Devices = _devices.ToList();
                    _mapPanel.Invalidate();
                    SyncTargetDropdown();
                    UpdateHeaderStatus();
                });
            }
        }
        else if (type == "device:left")
        {
            var id = msg["deviceId"]?.GetValue<string>() ?? "";
            SafeUi(() =>
            {
                _devices.RemoveAll(x => x.Id == id);
                _mapPanel.Devices = _devices.ToList();
                _mapPanel.Invalidate();
                SyncTargetDropdown();
                UpdateHeaderStatus();
            });
        }
        else if (type == "telemetry:pong")
        {
            long sentAt = msg["sentAt"]?.GetValue<long>() ?? 0;
            if (sentAt > 0)
            {
                _rttMs = (int)Math.Max(1, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - sentAt);
                UpdateHeaderStatus();
            }
        }
        else if (type == "input:event")
        {
            SafeUi(() => Win32Native.ExecuteInput(msg, _selectedMonitorIndex, (t, b) => _trayIcon.ShowBalloonTip(2500, t, b, ToolTipIcon.Info)));
        }
        else if (type == "clipboard:added")
        {
            if (msg["item"] is JsonObject itemObj)
            {
                var clip = ParseClip(itemObj);
                SafeUi(() =>
                {
                    _clips.Insert(0, clip);
                    if (_clips.Count > 40) _clips.RemoveRange(40, _clips.Count - 40);
                    RefreshClipboardListUi();
                    if (_cfg.AutoClipboard && clip.SourceDeviceId != _selfId && !string.IsNullOrEmpty(clip.Content) && clip.Content != _lastSyncedClip)
                    {
                        _lastSyncedClip = clip.Content;
                        try { Clipboard.SetText(clip.Content); } catch { }
                        Log($"Clipboard sincronizado automaticamente de {clip.SourceDeviceName}.");
                    }
                });
            }
        }
        else if (type == "screen:request")
        {
            var reqId = msg["requesterId"]?.GetValue<string>();
            SafeUi(() =>
            {
                if (!_screenStreaming)
                {
                    Log("Pedido de Extensão de Tela recebido! Iniciando transmissão do monitor...");
                    StartScreenBroadcast(reqId);
                }
            });
        }
        else if (type == "screen:frame")
        {
            var b64 = msg["data"]?.GetValue<string>() ?? "";
            var srcName = msg["sourceName"]?.GetValue<string>() ?? "Peer";
            int w = msg["width"]?.GetValue<int>() ?? 0;
            int h = msg["height"]?.GetValue<int>() ?? 0;
            if (!string.IsNullOrEmpty(b64))
            {
                try
                {
                    var bytes = Convert.FromBase64String(b64);
                    _rxFrameCount++;
                    if ((DateTime.UtcNow - _rxFpsWindow).TotalSeconds >= 1.0)
                    {
                        _rxFps = _rxFrameCount;
                        _rxFrameCount = 0;
                        _rxFpsWindow = DateTime.UtcNow;
                    }
                    SafeUi(() => _screenCanvas.UpdateFrame(bytes, $"AO VIVO · {srcName} · {w}x{h} · {_rxFps} FPS"));
                }
                catch { }
            }
        }
        else if (type == "screen:stop")
        {
            SafeUi(() => _screenCanvas.ClearFrame("Transmissão remota encerrada."));
        }
        else if (type == "file:start")
        {
            var fid = msg["fileId"]?.GetValue<string>() ?? "";
            var name = Path.GetFileName(msg["name"]?.GetValue<string>() ?? "arquivo.bin");
            int total = msg["totalChunks"]?.GetValue<int>() ?? 1;
            if (!string.IsNullOrEmpty(fid)) _rxFiles[fid] = (name, total, new Dictionary<int, string>());
        }
        else if (type == "file:chunk")
        {
            var fid = msg["fileId"]?.GetValue<string>() ?? "";
            int idx = msg["index"]?.GetValue<int>() ?? 0;
            var data = msg["data"]?.GetValue<string>() ?? "";
            if (_rxFiles.TryGetValue(fid, out var st)) st.Chunks[idx] = data;
        }
        else if (type == "file:complete")
        {
            var fid = msg["fileId"]?.GetValue<string>() ?? "";
            if (_rxFiles.TryGetValue(fid, out var st))
            {
                _rxFiles.Remove(fid);
                try
                {
                    var dest = Path.Combine(_downloadDir, st.Name);
                    using var fs = File.Create(dest);
                    for (int i = 0; i < st.Total; i++)
                        if (st.Chunks.TryGetValue(i, out var c))
                        {
                            var bytes = Convert.FromBase64String(c);
                            fs.Write(bytes, 0, bytes.Length);
                        }
                    SafeUi(() => _lblFileStatus.Text = $"Arquivo recebido com sucesso!\nSalvo em: {dest}");
                    Log($"Arquivo recebido: {dest}");
                }
                catch (Exception ex) { Log($"Erro ao salvar arquivo: {ex.Message}"); }
            }
        }
    }

    // ---------------- SCREEN EXTENSION BROADCAST ----------------
    private void ToggleScreenBroadcast()
    {
        if (_screenStreaming) StopScreenBroadcast();
        else StartScreenBroadcast(ResolveTargetId());
    }

    private void StartScreenBroadcast(string? targetId)
    {
        StopScreenBroadcast();
        _screenStreaming = true;
        _screenTxCts = new CancellationTokenSource();
        var ct = _screenTxCts.Token;

        int preset = _cmbQuality.SelectedIndex;
        int maxW = preset == 0 ? 960 : preset == 2 ? 1600 : 1280;
        int delayMs = preset == 0 ? 66 : preset == 2 ? 125 : 85;
        long quality = preset == 0 ? 52L : preset == 2 ? 72L : 62L;

        _btnToggleScreen.Text = "Parar Transmissão";
        _btnToggleScreen.BackColor = AccentRose;
        _lblScreenStatus.Text = $"Transmitindo Monitor {_selectedMonitorIndex + 1} ({maxW}p) pela LAN...";

        _ = Task.Run(async () =>
        {
            await SendJsonAsync(new JsonObject
            {
                ["type"] = "screen:start",
                ["targetDeviceId"] = targetId ?? "",
                ["sourceDeviceId"] = _selfId,
                ["sourceName"] = Environment.MachineName,
            });

            while (!ct.IsCancellationRequested && _screenStreaming)
            {
                var sw = Stopwatch.StartNew();
                var cap = ScreenCaptureUtil.CaptureScreenJpeg(_selectedMonitorIndex, maxW, quality);
                if (cap.HasValue && _isConnected)
                {
                    await SendJsonAsync(new JsonObject
                    {
                        ["type"] = "screen:frame",
                        ["targetDeviceId"] = targetId ?? "",
                        ["sourceDeviceId"] = _selfId,
                        ["sourceName"] = Environment.MachineName,
                        ["width"] = cap.Value.OutW,
                        ["height"] = cap.Value.OutH,
                        ["data"] = Convert.ToBase64String(cap.Value.JpegBytes),
                    });
                }
                int wait = Math.Max(15, delayMs - (int)sw.ElapsedMilliseconds);
                try { await Task.Delay(wait, ct); } catch { break; }
            }
        });
    }

    private void StopScreenBroadcast()
    {
        if (!_screenStreaming) return;
        _screenStreaming = false;
        try { _screenTxCts?.Cancel(); _screenTxCts?.Dispose(); } catch { }
        _screenTxCts = null;
        _ = SendJsonAsync(new JsonObject { ["type"] = "screen:stop", ["sourceDeviceId"] = _selfId });
        SafeUi(() =>
        {
            _btnToggleScreen.Text = "Transmitir Minha Tela";
            _btnToggleScreen.BackColor = AccentBlue;
            _lblScreenStatus.Text = "Transmissão encerrada. Clique em 'Transmitir Minha Tela' para retomar.";
        });
    }

    // ---------------- AUTO CLIPBOARD & KVM BORDER ----------------
    private void PollAutoClipboard()
    {
        if (!_cfg.AutoClipboard || !_isConnected) return;
        try
        {
            if (!Clipboard.ContainsText()) return;
            var txt = Clipboard.GetText();
            if (string.IsNullOrWhiteSpace(txt) || txt == _lastSyncedClip || txt.Length > 30000) return;
            _lastSyncedClip = txt;
            _ = SendJsonAsync(new JsonObject
            {
                ["type"] = "clipboard:push",
                ["content"] = txt,
                ["sourceDeviceId"] = _selfId,
                ["sourceDeviceName"] = Environment.MachineName,
            });
        }
        catch { }
    }

    private void PollKvmBorderEdge()
    {
        if (!_cfg.KvmBorderEnabled || !_isConnected) return;
        var target = ResolveTargetId();
        if (string.IsNullOrEmpty(target)) return;
        if (!Win32Native.GetCursorPos(out var pt)) return;
        var b = Screen.PrimaryScreen?.Bounds ?? new Rectangle(0, 0, 1920, 1080);

        bool hit = _cfg.KvmEdge switch
        {
            "left" => pt.X <= b.Left + 1,
            "top" => pt.Y <= b.Top + 1,
            "bottom" => pt.Y >= b.Bottom - 2,
            _ => pt.X >= b.Right - 2,
        };
        if (hit && (DateTime.UtcNow - _kvmLastTrigger).TotalMilliseconds > 900)
        {
            _kvmLastTrigger = DateTime.UtcNow;
            _kvmFocusedRemote = !_kvmFocusedRemote;
            Win32Native.SetCursorPos(b.Left + b.Width / 2, b.Top + b.Height / 2);
            SwitchPage("input");
            Activate();
            Log("KVM Contínuo: borda alcançada — controle focado no Trackpad/Teclado remoto.");
        }
    }

    // ---------------- HELPERS ----------------
    private string? ResolveTargetId()
    {
        if (!string.IsNullOrEmpty(_selectedTargetId) && _devices.Any(d => d.Id == _selectedTargetId && d.Id != _selfId))
            return _selectedTargetId;
        var first = _devices.FirstOrDefault(d => d.Id != _selfId);
        return first?.Id;
    }

    private void SendInputEvent(JsonObject ev)
    {
        var t = ResolveTargetId();
        if (string.IsNullOrEmpty(t)) return;
        ev["type"] = "input:event";
        ev["targetDeviceId"] = t;
        _ = SendJsonAsync(ev);
    }

    private void SendMediaAction(string action) =>
        SendInputEvent(new JsonObject { ["kind"] = "media", ["action"] = action });

    private void SendTypedText()
    {
        var txt = _txtRemoteType.Text;
        if (string.IsNullOrEmpty(txt)) return;
        SendInputEvent(new JsonObject { ["kind"] = "text", ["text"] = txt });
        _txtRemoteType.Clear();
    }

    private async Task PickAndSendFileAsync()
    {
        var target = ResolveTargetId();
        if (string.IsNullOrEmpty(target)) { Log("Selecione um dispositivo alvo para enviar arquivo."); return; }
        using var ofd = new OpenFileDialog { Title = "Enviar arquivo via LAN Continuum" };
        if (ofd.ShowDialog() != DialogResult.OK) return;
        var path = ofd.FileName;
        var bytes = await File.ReadAllBytesAsync(path);
        var fid = Guid.NewGuid().ToString("N")[..10];
        const int chunkSz = 48 * 1024;
        int total = Math.Max(1, (int)Math.Ceiling(bytes.Length / (double)chunkSz));
        await SendJsonAsync(new JsonObject { ["type"] = "file:start", ["targetDeviceId"] = target, ["fileId"] = fid, ["name"] = Path.GetFileName(path), ["totalChunks"] = total });
        for (int i = 0; i < total; i++)
        {
            int off = i * chunkSz;
            int len = Math.Min(chunkSz, bytes.Length - off);
            var slice = new byte[len];
            Array.Copy(bytes, off, slice, 0, len);
            await SendJsonAsync(new JsonObject { ["type"] = "file:chunk", ["targetDeviceId"] = target, ["fileId"] = fid, ["index"] = i, ["data"] = Convert.ToBase64String(slice) });
        }
        await SendJsonAsync(new JsonObject { ["type"] = "file:complete", ["targetDeviceId"] = target, ["fileId"] = fid });
        _lblFileStatus.Text = $"Enviado com sucesso: {Path.GetFileName(path)} ({bytes.Length / 1024} KB)";
        Log($"Arquivo enviado via LAN: {Path.GetFileName(path)}");
    }

    private static PeerDevice ParsePeer(JsonObject obj)
    {
        var tel = obj["telemetry"] as JsonObject;
        return new PeerDevice
        {
            Id = obj["id"]?.GetValue<string>() ?? "",
            Name = obj["name"]?.GetValue<string>() ?? "Dispositivo",
            Os = obj["os"]?.GetValue<string>() ?? "desktop",
            Kind = obj["kind"]?.GetValue<string>() ?? "desktop",
            X = obj["x"]?.GetValue<double>() ?? 180,
            Y = obj["y"]?.GetValue<double>() ?? 140,
            LanIp = obj["lanIp"]?.GetValue<string>() ?? "",
            CpuUsage = tel?["cpuUsage"]?.GetValue<int>() ?? 0,
            RamUsage = tel?["ramUsage"]?.GetValue<int>() ?? 0,
            BatteryLevel = tel?["batteryLevel"]?.GetValue<int?>(),
        };
    }

    private static ClipEntry ParseClip(JsonObject obj) => new()
    {
        Id = obj["id"]?.GetValue<string>() ?? "",
        Content = obj["content"]?.GetValue<string>() ?? "",
        SourceDeviceName = obj["sourceDeviceName"]?.GetValue<string>() ?? "Peer",
        SourceDeviceId = obj["sourceDeviceId"]?.GetValue<string>() ?? "",
    };

    private void SyncDevicesFromArray(JsonArray? arr)
    {
        if (arr == null) return;
        var list = arr.OfType<JsonObject>().Select(ParsePeer).ToList();
        SafeUi(() =>
        {
            _devices.Clear();
            _devices.AddRange(list);
            _mapPanel.Devices = _devices.ToList();
            if (string.IsNullOrEmpty(_selectedTargetId) || !_devices.Any(d => d.Id == _selectedTargetId && d.Id != _selfId))
                _selectedTargetId = _devices.FirstOrDefault(d => d.Id != _selfId)?.Id;
            _mapPanel.SelectedId = _selectedTargetId;
            _mapPanel.Invalidate();
            SyncTargetDropdown();
        });
    }

    private void SyncTargetDropdown()
    {
        var remotes = _devices.Where(d => d.Id != _selfId).ToList();
        _cmbGlobalTarget.Items.Clear();
        if (remotes.Count == 0)
        {
            _cmbGlobalTarget.Items.Add("Nenhum alvo remoto ainda");
            _cmbGlobalTarget.SelectedIndex = 0;
            return;
        }
        int selIdx = 0;
        for (int i = 0; i < remotes.Count; i++)
        {
            _cmbGlobalTarget.Items.Add($"Alvo: {remotes[i].Name} ({remotes[i].Os})");
            if (remotes[i].Id == _selectedTargetId) selIdx = i;
        }
        _cmbGlobalTarget.SelectedIndex = selIdx;
    }

    private void RefreshClipboardListUi()
    {
        _lstClips.Items.Clear();
        foreach (var c in _clips)
        {
            var preview = c.Content.Replace("\r", " ").Replace("\n", " ");
            if (preview.Length > 92) preview = preview[..92] + "…";
            _lstClips.Items.Add($"[{c.SourceDeviceName}] {preview}");
        }
    }

    private void RefreshDiscoveredPeersUi()
    {
        var peers = _discovery.ListPeers();
        _lanPeersFlow.Controls.Clear();
        if (peers.Count == 0)
        {
            _lanPeersFlow.Controls.Add(new Label
            {
                Text = "Nenhum outro dispositivo detectado ainda. Abra o Continuum no Linux ou Android no mesmo Wi-Fi ou clique em 'Varrer LAN'.",
                ForeColor = TextMuted,
                Font = new Font("Segoe UI", 9.5f),
                AutoSize = true,
                Padding = new Padding(0, 8, 0, 0),
            });
            return;
        }
        foreach (var peer in peers)
        {
            var card = new Panel
            {
                Width = 280,
                Height = 82,
                BackColor = BgInput,
                Padding = new Padding(12, 10, 12, 10),
                Margin = new Padding(0, 0, 12, 12),
                Cursor = Cursors.Hand,
            };
            card.Paint += (_, e) =>
            {
                using var p = new Pen(Color.FromArgb(80, 34, 211, 238), 1.2f);
                e.Graphics.DrawRectangle(p, 0, 0, card.Width - 1, card.Height - 1);
            };
            var lblName = new Label { Text = $"{peer.HubName} ({peer.Os.ToUpperInvariant()})", ForeColor = TextPrimary, Font = new Font("Segoe UI", 9.8f, FontStyle.Bold), Dock = DockStyle.Top, Height = 22 };
            var lblMeta = new Label { Text = $"{peer.Ip}:{peer.WsPort} · Sala {peer.RoomCode} · {peer.Via}", ForeColor = TextMuted, Font = new Font("Consolas", 8.2f), Dock = DockStyle.Top, Height = 18 };
            var btnJoin = MakeButton("Conectar Direto", AccentBlue, null, 28);
            btnJoin.Dock = DockStyle.Bottom;
            var captured = peer;
            btnJoin.Click += async (_, _) => await ConnectToDiscoveredPeerAsync(captured);

            card.Controls.Add(btnJoin);
            card.Controls.Add(lblMeta);
            card.Controls.Add(lblName);
            _lanPeersFlow.Controls.Add(card);
        }
    }

    private void UpdateHeaderStatus()
    {
        SafeUi(() =>
        {
            var rttTxt = _rttMs > 0 ? $" · {_rttMs}ms" : "";
            _lblStatusBadge.Text = _isConnected
                ? $"ONLINE · {_devices.Count} nó(s) · {_connectedHubName}{rttTxt}"
                : "RECONECTANDO MALHA LAN...";
            _lblStatusBadge.ForeColor = _isConnected ? AccentEmerald : AccentRose;
            _lblSidebarMeta.Text = $"IP: {NetworkUtil.GetLocalLanIp()}\nHub: {_hub.Port} · Sala: {_cfg.RoomCode}\nDispositivos: {_devices.Count}";
        });
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            StopScreenBroadcast();
            _appCts.Cancel();
            _animTimer.Dispose();
            _clipTimer.Dispose();
            _kvmTimer.Dispose();
            _discovery.Dispose();
            _hub.Dispose();
            _trayIcon?.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm());
    }
}
