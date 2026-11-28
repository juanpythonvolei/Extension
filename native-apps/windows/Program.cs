using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
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
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ContinuumWindows;

public sealed class AppConfig
{
    public string RoomCode { get; set; } = "MESH01";
    public string ManualPeer { get; set; } = "";
    public bool AutoLan { get; set; } = true;
    public int WsPort { get; set; } = 45891;
    public double Sensitivity { get; set; } = 1.6;
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
    public DateTime LastSeenUtc { get; set; } = DateTime.UtcNow;
    public bool IsLocal { get; set; }
}

public sealed class ClipEntry
{
    public string Id { get; set; } = "";
    public string Content { get; set; } = "";
    public string SourceDeviceName { get; set; } = "";
}

public sealed class NotifEntry
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";
    public string SourceDeviceName { get; set; } = "";
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

    public static void ExecuteInput(JsonObject ev, Action<string, string>? onNotify)
    {
        var kind = ev["kind"]?.GetValue<string>() ?? "";
        if (kind == "move")
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
            int wheel = dy > 0 ? -120 : 120;
            mouse_event(0x0800, 0, 0, wheel, UIntPtr.Zero);
        }
        else if (kind == "text")
        {
            var txt = ev["text"]?.GetValue<string>() ?? "";
            if (!string.IsNullOrEmpty(txt))
            {
                var safe = txt.Replace("{", "{{}").Replace("}", "{}}").Replace("+", "{+}").Replace("^", "{^}").Replace("%", "{%}").Replace("~", "{~}").Replace("(", "{(}").Replace(")", "{)}");
                try { SendKeys.SendWait(safe); } catch { }
            }
        }
        else if (kind == "key")
        {
            var k = ev["key"]?.GetValue<string>() ?? "";
            var map = k switch
            {
                "Enter" => "{ENTER}",
                "Backspace" => "{BACKSPACE}",
                "Escape" => "{ESC}",
                "Tab" => "{TAB}",
                "Space" => " ",
                "ArrowUp" => "{UP}",
                "ArrowDown" => "{DOWN}",
                "ArrowLeft" => "{LEFT}",
                "ArrowRight" => "{RIGHT}",
                _ => ""
            };
            if (!string.IsNullOrEmpty(map))
                try { SendKeys.SendWait(map); } catch { }
        }
        else if (kind == "media")
        {
            var act = ev["action"]?.GetValue<string>() ?? "";
            byte vk = act switch
            {
                "vol_up" => 0xAF,
                "vol_down" => 0xAE,
                "mute" => 0xAD,
                "play_pause" => 0xB3,
                "next" => 0xB0,
                "prev" => 0xB1,
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

internal static class NetworkUtil
{
    public const int UdpPort = 45890;
    public const int DefaultWsPort = 45891;
    public const string ProtoTag = "continuum-lan-v3";

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

    public static string NormalizeWsEndpoint(string raw)
    {
        var s = (raw ?? "").Trim();
        if (string.IsNullOrEmpty(s)) return "";
        if (s.StartsWith("ws://", StringComparison.OrdinalIgnoreCase) || s.StartsWith("wss://", StringComparison.OrdinalIgnoreCase))
        {
            var idx = s.IndexOf("://", StringComparison.Ordinal);
            if (s.IndexOf('/', idx + 3) < 0) return s + "/ws";
            return s;
        }
        if (s.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) return "ws://" + s[7..].TrimEnd('/') + "/ws";
        if (s.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return "wss://" + s[8..].TrimEnd('/') + "/ws";
        return s.Contains(':') ? $"ws://{s}/ws" : $"ws://{s}:{DefaultWsPort}/ws";
    }
}

// ---------------------------------------------------------------------------
// Embedded RFC-6455 LAN WebSocket Mesh Hub (TCP 45891, zero admin privileges)
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

    private TcpListener? _listener;
    private readonly CancellationTokenSource _cts = new();
    private readonly object _sync = new();
    private readonly HashSet<ClientSession> _clients = new();
    private readonly Dictionary<string, RoomState> _rooms = new();

    public EmbeddedLanHub(string hubId, int port = NetworkUtil.DefaultWsPort)
    {
        HubId = hubId;
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
        catch
        {
            Active = false;
            return false;
        }
    }

    public int PeerCount(string roomCode)
    {
        lock (_sync)
        {
            return _rooms.TryGetValue(roomCode, out var r) ? r.Devices.Count : 0;
        }
    }

    private RoomState GetRoomLocked(string code)
    {
        if (!_rooms.TryGetValue(code, out var r))
        {
            r = new RoomState();
            _rooms[code] = r;
        }
        return r;
    }

    private async Task AcceptLoopAsync()
    {
        while (!_cts.IsCancellationRequested && _listener != null)
        {
            try
            {
                var tcp = await _listener.AcceptTcpClientAsync(_cts.Token);
                var ip = (tcp.Client.RemoteEndPoint as IPEndPoint)?.Address.ToString() ?? "";
                _ = Task.Run(() => HandleClientAsync(tcp, ip));
            }
            catch (OperationCanceledException) { break; }
            catch { await Task.Delay(150); }
        }
    }

    private static byte[] EncodeServerFrame(string text, byte opcode = 0x1)
    {
        var payload = Encoding.UTF8.GetBytes(text);
        return EncodeServerFrameBytes(payload, opcode);
    }

    private static byte[] EncodeServerFrameBytes(byte[] payload, byte opcode = 0x1)
    {
        using var ms = new MemoryStream();
        ms.WriteByte((byte)(0x80 | (opcode & 0x0F)));
        if (payload.Length < 126)
        {
            ms.WriteByte((byte)payload.Length);
        }
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

    private static async Task<(byte Opcode, byte[] Payload)?> ReadFrameAsync(NetworkStream stream, CancellationToken ct)
    {
        var hdr = await ReadExactAsync(stream, 2, ct);
        if (hdr == null) return null;
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
        if (length < 0 || length > 16 * 1024 * 1024) return null;
        byte[]? mask = masked ? await ReadExactAsync(stream, 4, ct) : null;
        byte[] payload = length > 0 ? (await ReadExactAsync(stream, (int)length, ct) ?? Array.Empty<byte>()) : Array.Empty<byte>();
        if (mask != null)
        {
            for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i & 3];
        }
        return (opcode, payload);
    }

    private async Task SendRawAsync(ClientSession session, byte[] frame)
    {
        await session.SendLock.WaitAsync();
        try
        {
            await session.Stream.WriteAsync(frame, 0, frame.Length, _cts.Token);
        }
        catch { }
        finally { session.SendLock.Release(); }
    }

    private async Task BroadcastRoomAsync(string roomCode, JsonObject payload, ClientSession? exclude = null)
    {
        List<ClientSession> targets;
        lock (_sync)
        {
            targets = _clients.Where(c => c.RoomCode == roomCode && c != exclude).ToList();
        }
        var frame = EncodeServerFrame(payload.ToJsonString());
        foreach (var t in targets) await SendRawAsync(t, frame);
    }

    private async Task SendToDeviceAsync(string roomCode, string targetId, JsonObject payload, ClientSession? exclude = null)
    {
        List<ClientSession> targets;
        lock (_sync)
        {
            targets = _clients.Where(c => c.RoomCode == roomCode && c.DeviceId == targetId && c != exclude).ToList();
        }
        if (targets.Count == 0)
        {
            await BroadcastRoomAsync(roomCode, payload, exclude);
            return;
        }
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
                var str = Encoding.UTF8.GetString(reqBytes.ToArray());
                if (str.Contains("\r\n\r\n")) break;
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
                var body = Encoding.UTF8.GetBytes($"{{\"ok\":true,\"proto\":\"{NetworkUtil.ProtoTag}\",\"hub\":\"{Environment.MachineName}\"}}");
                var resp = Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
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
                var frame = await ReadFrameAsync(session.Stream, _cts.Token);
                if (frame == null) break;
                var (opcode, payload) = frame.Value;
                if (opcode == 0x8) break;
                if (opcode == 0x9)
                {
                    await SendRawAsync(session, EncodeServerFrameBytes(payload, 0xA));
                    continue;
                }
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
                double defY = 130 + (idx / 3) * 165;
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

        if (type == "telemetry:ping")
        {
            var pong = new JsonObject
            {
                ["type"] = "telemetry:pong",
                ["sentAt"] = msg["sentAt"]?.DeepClone(),
                ["serverTime"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            await SendRawAsync(session, EncodeServerFrame(pong.ToJsonString()));
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
            if (updated != null)
                await BroadcastRoomAsync(room, new JsonObject { ["type"] = "device:updated", ["device"] = updated });
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
            if (updated != null)
                await BroadcastRoomAsync(room, new JsonObject { ["type"] = "device:updated", ["device"] = updated });
        }
        else if (type == "input:event" || type == "file:start" || type == "file:chunk" || type == "file:complete")
        {
            var targetId = msg["targetDeviceId"]?.GetValue<string>();
            if (!string.IsNullOrEmpty(targetId))
                await SendToDeviceAsync(room, targetId, (JsonObject)msg.DeepClone(), exclude: session);
            else
                await BroadcastRoomAsync(room, (JsonObject)msg.DeepClone(), exclude: session);
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
        lock (_sync)
        {
            foreach (var c in _clients) { try { c.Tcp.Close(); } catch { } }
            _clients.Clear();
        }
    }
}

// ---------------------------------------------------------------------------
// UDP Auto-Discovery Beacon & Leader Election (UDP 45890)
// ---------------------------------------------------------------------------
internal sealed class UdpDiscoveryService : IDisposable
{
    private readonly EmbeddedLanHub _hub;
    private readonly Func<string> _getRoom;
    private readonly Action _onChanged;
    private readonly CancellationTokenSource _cts = new();
    private readonly ConcurrentDictionary<string, DiscoveredHub> _peers = new();

    public UdpDiscoveryService(EmbeddedLanHub hub, Func<string> getRoom, Action onChanged)
    {
        _hub = hub;
        _getRoom = getRoom;
        _onChanged = onChanged;
    }

    public void Start()
    {
        _ = Task.Run(BroadcastLoopAsync);
        _ = Task.Run(ListenLoopAsync);
    }

    public List<DiscoveredHub> ListPeers()
    {
        var cutoff = DateTime.UtcNow.AddSeconds(-9);
        foreach (var kv in _peers.ToArray())
        {
            if (kv.Value.LastSeenUtc < cutoff) _peers.TryRemove(kv.Key, out _);
        }
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
                IsLocal = true,
            });
        }
        return list.OrderBy(c => c.StartedAt).ThenBy(c => c.HubId, StringComparer.Ordinal).FirstOrDefault();
    }

    private async Task BroadcastLoopAsync()
    {
        using var udp = new UdpClient();
        udp.EnableBroadcast = true;
        var ep = new IPEndPoint(IPAddress.Broadcast, NetworkUtil.UdpPort);
        while (!_cts.IsCancellationRequested)
        {
            try
            {
                if (_hub.Active)
                {
                    var room = _getRoom();
                    var payload = new JsonObject
                    {
                        ["proto"] = NetworkUtil.ProtoTag,
                        ["roomCode"] = room,
                        ["hubId"] = _hub.HubId,
                        ["hubName"] = Environment.MachineName,
                        ["os"] = "windows",
                        ["ip"] = NetworkUtil.GetLocalLanIp(),
                        ["wsPort"] = _hub.Port,
                        ["startedAt"] = _hub.StartedAt,
                        ["peers"] = _hub.PeerCount(room),
                    };
                    var bytes = Encoding.UTF8.GetBytes(payload.ToJsonString());
                    await udp.SendAsync(bytes, bytes.Length, ep);
                }
            }
            catch { }
            try { await Task.Delay(2000, _cts.Token); } catch { break; }
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
                    if (node["proto"]?.GetValue<string>() != NetworkUtil.ProtoTag) continue;
                    var hubId = node["hubId"]?.GetValue<string>() ?? "";
                    if (string.IsNullOrEmpty(hubId) || hubId == _hub.HubId) continue;

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
// Custom DoubleBuffered Interactive Spatial Device Map (GDI+)
// ---------------------------------------------------------------------------
internal sealed class SpatialMapPanel : Panel
{
    public List<PeerDevice> Devices { get; set; } = new();
    public string SelfId { get; set; } = "";
    public string? SelectedId { get; set; }
    public event Action<PeerDevice>? DeviceSelected;
    public event Action<string, double, double>? DeviceMoved;

    private const float NodeW = 198f;
    private const float NodeH = 104f;
    private string? _dragId;
    private PointF _dragOffset;

    public SpatialMapPanel()
    {
        DoubleBuffered = true;
        BackColor = Color.FromArgb(10, 12, 16);
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

    private RectangleF GetNodeRect(PeerDevice d) => new((float)d.X - NodeW / 2f, (float)d.Y - NodeH / 2f, NodeW, NodeH);

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

        // Subtle Obsidian dot grid
        using (var dotBrush = new SolidBrush(Color.FromArgb(48, 82, 102, 138)))
        {
            for (int gx = 20; gx < Width; gx += 28)
                for (int gy = 20; gy < Height; gy += 28)
                    g.FillEllipse(dotBrush, gx - 1, gy - 1, 2.2f, 2.2f);
        }

        if (Devices.Count == 0)
        {
            using var f = new Font("Segoe UI", 10.5f);
            using var br = new SolidBrush(Color.FromArgb(148, 163, 184));
            var txt = "Aguardando dispositivos na rede local (UDP 45890 / TCP 45891)...";
            var sz = g.MeasureString(txt, f);
            g.DrawString(txt, f, br, (Width - sz.Width) / 2f, (Height - sz.Height) / 2f);
            return;
        }

        // Mesh Bezier links
        var anchor = Devices.FirstOrDefault(d => d.Id == SelfId) ?? Devices[0];
        foreach (var d in Devices)
        {
            if (d.Id == anchor.Id) continue;
            bool sel = d.Id == SelectedId;
            using var pen = new Pen(sel ? Color.FromArgb(190, 59, 130, 246) : Color.FromArgb(115, 72, 92, 125), sel ? 2.2f : 1.4f);
            float mx = (float)(anchor.X + d.X) / 2f;
            g.DrawBezier(pen, (float)anchor.X, (float)anchor.Y, mx, (float)anchor.Y, mx, (float)d.Y, (float)d.X, (float)d.Y);
        }

        using var titleFont = new Font("Segoe UI Semibold", 9.5f);
        using var subFont = new Font("Segoe UI", 8.2f);
        using var monoFont = new Font("Consolas", 8f);
        using var inkBrush = new SolidBrush(Color.FromArgb(241, 245, 249));
        using var mutedBrush = new SolidBrush(Color.FromArgb(148, 163, 184));
        using var greenBrush = new SolidBrush(Color.FromArgb(16, 185, 129));
        using var blueBrush = new SolidBrush(Color.FromArgb(59, 130, 246));
        using var trackBrush = new SolidBrush(Color.FromArgb(28, 36, 50));

        foreach (var d in Devices)
        {
            var r = GetNodeRect(d);
            bool isSelf = d.Id == SelfId;
            bool isSel = d.Id == SelectedId;

            using var path = RoundedRect(r, 11f);
            using var bg = new SolidBrush(isSel ? Color.FromArgb(24, 33, 49) : Color.FromArgb(19, 24, 32));
            g.FillPath(bg, path);

            var borderColor = isSel ? Color.FromArgb(59, 130, 246) : (isSelf ? Color.FromArgb(180, 16, 185, 129) : Color.FromArgb(37, 46, 62));
            using var borderPen = new Pen(borderColor, isSel ? 1.8f : 1.1f);
            g.DrawPath(borderPen, path);

            g.FillEllipse(greenBrush, r.X + 12, r.Y + 15, 8, 8);
            var label = d.Name.Length > 20 ? d.Name[..20] : d.Name;
            g.DrawString(label, titleFont, inkBrush, r.X + 25, r.Y + 11);

            var role = isSelf ? "Este PC" : (isSel ? "Alvo" : "Peer LAN");
            var batTxt = d.BatteryLevel.HasValue ? $" · {d.BatteryLevel}%" : "";
            g.DrawString($"{d.Os.ToUpperInvariant()} · {role}{batTxt}", subFont, mutedBrush, r.X + 12, r.Y + 31);

            // CPU meter
            float barX = r.X + 68, barW = r.Width - 82;
            g.DrawString($"CPU {d.CpuUsage}%", monoFont, mutedBrush, r.X + 12, r.Y + 53);
            g.FillRectangle(trackBrush, barX, r.Y + 56, barW, 6);
            if (d.CpuUsage > 0) g.FillRectangle(blueBrush, barX, r.Y + 56, Math.Max(4f, barW * Math.Min(100, d.CpuUsage) / 100f), 6);

            // RAM meter
            g.DrawString($"RAM {d.RamUsage}%", monoFont, mutedBrush, r.X + 12, r.Y + 73);
            g.FillRectangle(trackBrush, barX, r.Y + 76, barW, 6);
            if (d.RamUsage > 0) g.FillRectangle(greenBrush, barX, r.Y + 76, Math.Max(4f, barW * Math.Min(100, d.RamUsage) / 100f), 6);
        }

        using var hintBrush = new SolidBrush(Color.FromArgb(110, 148, 163, 184));
        g.DrawString("Arraste os dispositivos para posicionar no espaço · Clique para selecionar alvo", subFont, hintBrush, 14, Height - 24);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        for (int i = Devices.Count - 1; i >= 0; i--)
        {
            var d = Devices[i];
            if (GetNodeRect(d).Contains(e.Location))
            {
                SelectedId = d.Id;
                _dragId = d.Id;
                _dragOffset = new PointF((float)d.X - e.X, (float)d.Y - e.Y);
                DeviceSelected?.Invoke(d);
                Invalidate();
                return;
            }
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (_dragId == null) return;
        var d = Devices.FirstOrDefault(x => x.Id == _dragId);
        if (d == null) return;
        d.X = Math.Clamp(e.X + _dragOffset.X, 106, Math.Max(120, Width - 106));
        d.Y = Math.Clamp(e.Y + _dragOffset.Y, 60, Math.Max(80, Height - 60));
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (_dragId != null)
        {
            var id = _dragId;
            _dragId = null;
            var d = Devices.FirstOrDefault(x => x.Id == id);
            if (d != null) DeviceMoved?.Invoke(id, d.X, d.Y);
        }
    }
}

// ---------------------------------------------------------------------------
// Custom DoubleBuffered Tactile Trackpad Panel (GDI+ dot-grid + ripples)
// ---------------------------------------------------------------------------
internal sealed class TrackpadPanel : Panel
{
    public double Sensitivity { get; set; } = 1.6;
    public event Action<double, double>? PointerMoved;
    public event Action<string>? Clicked;
    public event Action<int>? Scrolled;

    private Point? _lastPt;
    private Point? _cursorPt;
    private bool _moved;
    private readonly List<(PointF Pt, long T0)> _ripples = new();

    public TrackpadPanel()
    {
        DoubleBuffered = true;
        BackColor = Color.FromArgb(11, 14, 20);
        Cursor = Cursors.Cross;
    }

    public bool HasActiveRipples => _ripples.Count > 0;

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        using (var dot = new SolidBrush(Color.FromArgb(55, 89, 112, 153)))
        {
            for (int gx = 24; gx < Width; gx += 24)
                for (int gy = 24; gy < Height; gy += 24)
                    g.FillEllipse(dot, gx - 1, gy - 1, 2f, 2f);
        }

        using (var f = new Font("Segoe UI", 9.5f))
        using (var br = new SolidBrush(Color.FromArgb(125, 148, 163, 184)))
        {
            var hint = "Superfície Tátil de Precisão · Arraste para mover · Clique Esq/Dir · Scroll do mouse";
            var sz = g.MeasureString(hint, f);
            g.DrawString(hint, f, br, (Width - sz.Width) / 2f, (Height - sz.Height) / 2f);
        }

        long now = Environment.TickCount64;
        _ripples.RemoveAll(r => now - r.T0 > 450);
        foreach (var r in _ripples)
        {
            float p = (now - r.T0) / 450f;
            int alpha = Math.Clamp((int)((1f - p) * 185), 0, 255);
            float rad = 10f + p * 38f;
            using var pen = new Pen(Color.FromArgb(alpha, 59, 130, 246), 2f);
            g.DrawEllipse(pen, r.Pt.X - rad, r.Pt.Y - rad, rad * 2f, rad * 2f);
        }

        if (_cursorPt.HasValue)
        {
            var pt = _cursorPt.Value;
            using var glow = new SolidBrush(Color.FromArgb(60, 59, 130, 246));
            using var core = new SolidBrush(Color.FromArgb(96, 165, 250));
            g.FillEllipse(glow, pt.X - 18, pt.Y - 18, 36, 36);
            g.FillEllipse(core, pt.X - 5, pt.Y - 5, 10, 10);
        }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        _cursorPt = e.Location;
        _ripples.Add((e.Location, Environment.TickCount64));
        if (e.Button == MouseButtons.Right)
            Clicked?.Invoke("right");
        else
        {
            _lastPt = e.Location;
            _moved = false;
        }
        Invalidate();
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (_lastPt.HasValue)
        {
            double dx = (e.X - _lastPt.Value.X) * Sensitivity;
            double dy = (e.Y - _lastPt.Value.Y) * Sensitivity;
            _lastPt = e.Location;
            _cursorPt = e.Location;
            if (Math.Abs(dx) > 0.4 || Math.Abs(dy) > 0.4)
            {
                _moved = true;
                PointerMoved?.Invoke(Math.Round(dx, 2), Math.Round(dy, 2));
            }
            Invalidate();
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button == MouseButtons.Left && _lastPt.HasValue && !_moved)
        {
            Clicked?.Invoke("left");
            _ripples.Add((e.Location, Environment.TickCount64));
        }
        _lastPt = null;
        _cursorPt = null;
        Invalidate();
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        Scrolled?.Invoke(e.Delta < 0 ? 45 : -45);
    }
}

// ---------------------------------------------------------------------------
// Main Continuum v3.0 Native Windows Desktop Form
// ---------------------------------------------------------------------------
public sealed class ContinuumForm : Form
{
    private static readonly Color CBg = Color.FromArgb(9, 11, 14);
    private static readonly Color CSidebar = Color.FromArgb(15, 19, 25);
    private static readonly Color CCard = Color.FromArgb(17, 22, 30);
    private static readonly Color CSubtle = Color.FromArgb(12, 16, 22);
    private static readonly Color CBorder = Color.FromArgb(31, 39, 53);
    private static readonly Color CText = Color.FromArgb(241, 245, 249);
    private static readonly Color CMuted = Color.FromArgb(148, 163, 184);
    private static readonly Color CAccent = Color.FromArgb(59, 130, 246);
    private static readonly Color CGreen = Color.FromArgb(16, 185, 129);
    private static readonly Color CAmber = Color.FromArgb(245, 158, 11);

    private readonly string _deviceId;
    private readonly string _deviceName;
    private readonly string _configPath;
    private readonly string _downloadsDir;
    private readonly AppConfig _cfg;
    private readonly EmbeddedLanHub _hub;
    private readonly UdpDiscoveryService _discovery;

    private ClientWebSocket? _ws;
    private CancellationTokenSource _wsCts = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private volatile bool _connected;
    private string _connectedUrl = "";
    private string _connectedHubLabel = "Hub Local LAN";
    private int? _rttMs;
    private bool _allowExit;

    private readonly List<PeerDevice> _devices = new();
    private string? _selectedId;
    private readonly Dictionary<string, (string Name, long Size, int Total, Dictionary<int, string> Chunks)> _incomingFiles = new();

    // UI references
    private readonly Dictionary<string, Button> _navButtons = new();
    private readonly Dictionary<string, Panel> _views = new();
    private readonly Label _lblPageTitle;
    private readonly Label _lblConnStatus;
    private readonly Label _lblHubMeta;
    private readonly Label _lblSelected;
    private readonly Label _lblRemoteTarget;
    private readonly Label _lblToast;
    private readonly TextBox _txtRoomTop;
    private readonly TextBox _txtManualIp;
    private readonly SpatialMapPanel _mapPanel;
    private readonly TrackpadPanel _trackpad;
    private readonly ProgressBar _fileProgress;
    private readonly Label _lblFileStatus;
    private readonly ListBox _listFiles;
    private readonly ListBox _listClipboard;
    private readonly ListBox _listLanPeers;
    private readonly ListBox _listNotifs;
    private readonly NotifyIcon _tray;
    private readonly System.Windows.Forms.Timer _uiTimer;

    private readonly List<ClipEntry> _clipItems = new();
    private readonly List<DiscoveredHub> _lanPeers = new();

    public ContinuumForm()
    {
        var cleanHost = new string(Environment.MachineName.ToLowerInvariant().Where(char.IsLetterOrDigit).Take(14).ToArray());
        if (string.IsNullOrEmpty(cleanHost)) cleanHost = "win";
        _deviceId = $"win-app-{cleanHost}-{Environment.ProcessId % 9000 + 1000}";
        _deviceName = $"{Environment.MachineName} (Windows)";

        var appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Continuum");
        Directory.CreateDirectory(appData);
        _configPath = Path.Combine(appData, "config.json");
        _downloadsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Continuum");
        _cfg = LoadConfig();

        _hub = new EmbeddedLanHub(_deviceId, _cfg.WsPort > 0 ? _cfg.WsPort : NetworkUtil.DefaultWsPort);
        _hub.Start();
        _discovery = new UdpDiscoveryService(_hub, () => _cfg.RoomCode, OnLanPeersDiscovered);
        _discovery.Start();

        Text = "Continuum 3.0 — Malha Direta LAN";
        Size = new Size(1120, 720);
        MinimumSize = new Size(920, 600);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = CBg;
        ForeColor = CText;
        Font = new Font("Segoe UI", 9.5f);

        // ==================== SIDEBAR (232px) ====================
        var sidebar = new Panel { Dock = DockStyle.Left, Width = 232, BackColor = CSidebar, Padding = new Padding(14) };
        sidebar.Paint += (s, e) =>
        {
            using var pen = new Pen(CBorder);
            e.Graphics.DrawLine(pen, sidebar.Width - 1, 0, sidebar.Width - 1, sidebar.Height);
        };

        var lblBrand = new Label { Text = "Continuum", Font = new Font("Segoe UI", 14f, FontStyle.Bold), ForeColor = CText, Dock = DockStyle.Top, Height = 30 };
        var lblSub = new Label { Text = "v3.0.0 · Malha Direta LAN", Font = new Font("Segoe UI", 8.5f), ForeColor = CMuted, Dock = DockStyle.Top, Height = 24 };

        var hubBox = new Panel { Dock = DockStyle.Bottom, Height = 82, BackColor = CSubtle, Padding = new Padding(10) };
        hubBox.Paint += (s, e) => ControlPaint.DrawBorder(e.Graphics, hubBox.ClientRectangle, CBorder, ButtonBorderStyle.Solid);
        var lblHubH = new Label { Text = "HUB LAN EMBUTIDO", Font = new Font("Segoe UI", 7.5f, FontStyle.Bold), ForeColor = CMuted, Dock = DockStyle.Top, Height = 16 };
        var lblHubIp = new Label { Text = $"{NetworkUtil.GetLocalLanIp()}:{_hub.Port}", Font = new Font("Consolas", 9.5f, FontStyle.Bold), ForeColor = CText, Dock = DockStyle.Top, Height = 22 };
        _lblHubMeta = new Label { Text = $"Malha {_cfg.RoomCode} · 1 nó", Font = new Font("Segoe UI", 8.2f), ForeColor = CMuted, Dock = DockStyle.Top, Height = 20 };
        hubBox.Controls.Add(_lblHubMeta);
        hubBox.Controls.Add(lblHubIp);
        hubBox.Controls.Add(lblHubH);

        var navHost = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 12, 0, 12), BackColor = CSidebar };
        var navSpecs = new[] { ("map", "Mapa Espacial"), ("remote", "Controle Remoto"), ("transfer", "Arquivos & Clipboard"), ("network", "Rede LAN & Alertas") };
        foreach (var (key, title) in navSpecs.Reverse())
        {
            var btn = new Button
            {
                Text = "  " + title,
                Dock = DockStyle.Top,
                Height = 40,
                FlatStyle = FlatStyle.Flat,
                TextAlign = ContentAlignment.MiddleLeft,
                ForeColor = CMuted,
                BackColor = CSidebar,
                Font = new Font("Segoe UI Semibold", 9.5f),
                Cursor = Cursors.Hand,
                Margin = new Padding(0, 2, 0, 2),
            };
            btn.FlatAppearance.BorderSize = 0;
            btn.FlatAppearance.MouseOverBackColor = Color.FromArgb(24, 31, 44);
            btn.Click += (_, _) => SwitchTab(key);
            navHost.Controls.Add(btn);
            _navButtons[key] = btn;
        }

        sidebar.Controls.Add(navHost);
        sidebar.Controls.Add(hubBox);
        sidebar.Controls.Add(lblSub);
        sidebar.Controls.Add(lblBrand);

        // ==================== MAIN CONTENT AREA ====================
        var mainHost = new Panel { Dock = DockStyle.Fill, BackColor = CBg };

        // Top Bar
        var topbar = new Panel { Dock = DockStyle.Top, Height = 56, BackColor = Color.FromArgb(14, 18, 23), Padding = new Padding(16, 10, 16, 10) };
        topbar.Paint += (s, e) =>
        {
            using var pen = new Pen(CBorder);
            e.Graphics.DrawLine(pen, 0, topbar.Height - 1, topbar.Width, topbar.Height - 1);
        };
        _lblPageTitle = new Label { Text = "Mapa Espacial de Dispositivos", Font = new Font("Segoe UI", 11.5f, FontStyle.Bold), ForeColor = CText, AutoSize = true, Location = new Point(16, 16) };
        var topRight = new FlowLayoutPanel { Dock = DockStyle.Right, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, BackColor = Color.Transparent, Padding = new Padding(0, 3, 0, 0) };
        _lblConnStatus = new Label { Text = "● Inicializando Hub LAN...", ForeColor = CAmber, AutoSize = true, Margin = new Padding(0, 6, 14, 0), Font = new Font("Segoe UI Semibold", 9f) };
        _txtRoomTop = new TextBox { Text = _cfg.RoomCode, Width = 88, BackColor = CBg, ForeColor = CText, BorderStyle = BorderStyle.FixedSingle, Font = new Font("Consolas", 9.5f), Margin = new Padding(0, 3, 6, 0) };
        var btnRoom = MakeSecondaryButton("Trocar Malha", 104);
        btnRoom.Click += (_, _) => ApplyConnection(_txtRoomTop.Text, _txtManualIp?.Text ?? "", string.IsNullOrWhiteSpace(_txtManualIp?.Text));
        topRight.Controls.Add(_lblConnStatus);
        topRight.Controls.Add(_txtRoomTop);
        topRight.Controls.Add(btnRoom);
        topbar.Controls.Add(_lblPageTitle);
        topbar.Controls.Add(topRight);

        // Bottom Toast Bar
        var toastBar = new Panel { Dock = DockStyle.Bottom, Height = 30, BackColor = CBg, Padding = new Padding(16, 4, 16, 4) };
        _lblToast = new Label { Text = $"Hub LAN ativo em {NetworkUtil.GetLocalLanIp()}:{_hub.Port} · Comunicação direta entre apps", ForeColor = CMuted, Dock = DockStyle.Fill, Font = new Font("Segoe UI", 8.5f) };
        toastBar.Controls.Add(_lblToast);

        var contentHost = new Panel { Dock = DockStyle.Fill, BackColor = CBg, Padding = new Padding(14) };

        // ==================== VIEW 1: SPATIAL MAP ====================
        var viewMap = new Panel { Dock = DockStyle.Fill, BackColor = CBg };
        var selBar = new Panel { Dock = DockStyle.Bottom, Height = 54, BackColor = CCard, Padding = new Padding(12, 10, 12, 10) };
        selBar.Paint += (s, e) => ControlPaint.DrawBorder(e.Graphics, selBar.ClientRectangle, CBorder, ButtonBorderStyle.Solid);
        _lblSelected = new Label { Text = "Clique em um dispositivo no mapa ou arraste para reorganizar.", ForeColor = CMuted, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft };
        var selBtns = new FlowLayoutPanel { Dock = DockStyle.Right, AutoSize = true, WrapContents = false, BackColor = CCard };
        var btnSelCtrl = MakePrimaryButton("Controlar", 96);
        btnSelCtrl.Click += (_, _) => SwitchTab("remote");
        var btnSelPing = MakeSecondaryButton("Localizar", 88);
        btnSelPing.Click += (_, _) => SendRemoteEvent(new JsonObject { ["kind"] = "media", ["action"] = "ping" });
        var btnSelFile = MakeSecondaryButton("Enviar Arquivo", 112);
        btnSelFile.Click += (_, _) => PickAndSendFile();
        selBtns.Controls.Add(btnSelCtrl);
        selBtns.Controls.Add(btnSelPing);
        selBtns.Controls.Add(btnSelFile);
        selBar.Controls.Add(_lblSelected);
        selBar.Controls.Add(selBtns);

        _mapPanel = new SpatialMapPanel { Dock = DockStyle.Fill, SelfId = _deviceId };
        _mapPanel.DeviceSelected += dev => { _selectedId = dev.Id; UpdateSelectedUi(); };
        _mapPanel.DeviceMoved += (id, x, y) => _ = SendJsonAsync(new JsonObject { ["type"] = "device:move", ["deviceId"] = id, ["x"] = x, ["y"] = y });

        var mapFrame = new Panel { Dock = DockStyle.Fill, Padding = new Padding(1), BackColor = CBorder };
        mapFrame.Controls.Add(_mapPanel);
        viewMap.Controls.Add(mapFrame);
        viewMap.Controls.Add(new Panel { Dock = DockStyle.Bottom, Height = 10 });
        viewMap.Controls.Add(selBar);
        _views["map"] = viewMap;

        // ==================== VIEW 2: TRACKPAD & MEDIA ====================
        var viewRemote = new Panel { Dock = DockStyle.Fill, BackColor = CBg };
        var remTop = new Panel { Dock = DockStyle.Top, Height = 38, BackColor = CBg };
        _lblRemoteTarget = new Label { Text = "Controlando: selecione um peer", Font = new Font("Segoe UI", 10.5f, FontStyle.Bold), ForeColor = CText, Dock = DockStyle.Left, AutoSize = true, Padding = new Padding(0, 6, 0, 0) };
        var sensTrack = new TrackBar { Minimum = 8, Maximum = 32, Value = Math.Clamp((int)(_cfg.Sensitivity * 10), 8, 32), Width = 140, Dock = DockStyle.Right, TickStyle = TickStyle.None };
        sensTrack.ValueChanged += (_, _) => { _cfg.Sensitivity = sensTrack.Value / 10.0; _trackpad.Sensitivity = _cfg.Sensitivity; };
        var lblSens = new Label { Text = "Sensibilidade", ForeColor = CMuted, Dock = DockStyle.Right, AutoSize = true, Padding = new Padding(0, 8, 6, 0) };
        remTop.Controls.Add(_lblRemoteTarget);
        remTop.Controls.Add(sensTrack);
        remTop.Controls.Add(lblSens);

        var kbRow = new Panel { Dock = DockStyle.Bottom, Height = 40, BackColor = CBg, Padding = new Padding(0, 6, 0, 0) };
        var txtRemote = new TextBox { Dock = DockStyle.Fill, BackColor = CSubtle, ForeColor = CText, BorderStyle = BorderStyle.FixedSingle, Font = new Font("Segoe UI", 10f) };
        var btnSendTxt = MakePrimaryButton("Enviar Texto", 108);
        btnSendTxt.Dock = DockStyle.Right;
        var btnEnter = MakeSecondaryButton("Enter", 68);
        btnEnter.Dock = DockStyle.Right;
        void SendTyped()
        {
            if (!string.IsNullOrEmpty(txtRemote.Text))
            {
                SendRemoteEvent(new JsonObject { ["kind"] = "text", ["text"] = txtRemote.Text });
                txtRemote.Clear();
            }
        }
        btnSendTxt.Click += (_, _) => SendTyped();
        txtRemote.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; SendTyped(); } };
        btnEnter.Click += (_, _) => SendRemoteEvent(new JsonObject { ["kind"] = "key", ["key"] = "Enter" });
        kbRow.Controls.Add(txtRemote);
        kbRow.Controls.Add(btnSendTxt);
        kbRow.Controls.Add(btnEnter);

        var actFlow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 44, BackColor = CBg, Padding = new Padding(0, 6, 0, 0) };
        var acts = new (string Label, Action Act)[]
        {
            ("Clique Esq", () => SendRemoteEvent(new JsonObject { ["kind"] = "click", ["button"] = "left" })),
            ("Clique Dir", () => SendRemoteEvent(new JsonObject { ["kind"] = "click", ["button"] = "right" })),
            ("Vol −", () => SendRemoteEvent(new JsonObject { ["kind"] = "media", ["action"] = "vol_down" })),
            ("Vol +", () => SendRemoteEvent(new JsonObject { ["kind"] = "media", ["action"] = "vol_up" })),
            ("Mudo", () => SendRemoteEvent(new JsonObject { ["kind"] = "media", ["action"] = "mute" })),
            ("Play/Pause", () => SendRemoteEvent(new JsonObject { ["kind"] = "media", ["action"] = "play_pause" })),
            ("Próxima", () => SendRemoteEvent(new JsonObject { ["kind"] = "media", ["action"] = "next" })),
            ("Bloquear", () => SendRemoteEvent(new JsonObject { ["kind"] = "media", ["action"] = "lock" })),
            ("Localizar", () => SendRemoteEvent(new JsonObject { ["kind"] = "media", ["action"] = "ping" })),
        };
        foreach (var (lbl, act) in acts)
        {
            var b = MakeSecondaryButton(lbl, 86);
            b.Click += (_, _) => act();
            actFlow.Controls.Add(b);
        }

        _trackpad = new TrackpadPanel { Dock = DockStyle.Fill, Sensitivity = _cfg.Sensitivity };
        _trackpad.PointerMoved += (dx, dy) => SendRemoteEvent(new JsonObject { ["kind"] = "move", ["dx"] = dx, ["dy"] = dy });
        _trackpad.Clicked += btn => SendRemoteEvent(new JsonObject { ["kind"] = "click", ["button"] = btn });
        _trackpad.Scrolled += dy => SendRemoteEvent(new JsonObject { ["kind"] = "scroll", ["dx"] = 0, ["dy"] = dy });
        var tpFrame = new Panel { Dock = DockStyle.Fill, Padding = new Padding(1), BackColor = CBorder };
        tpFrame.Controls.Add(_trackpad);

        viewRemote.Controls.Add(tpFrame);
        viewRemote.Controls.Add(actFlow);
        viewRemote.Controls.Add(kbRow);
        viewRemote.Controls.Add(remTop);
        _views["remote"] = viewRemote;

        // ==================== VIEW 3: FILES & CLIPBOARD ====================
        var viewTransfer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = CBg };
        viewTransfer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));
        viewTransfer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50f));

        var fileCard = new Panel { Dock = DockStyle.Fill, BackColor = CCard, Padding = new Padding(14), Margin = new Padding(0, 0, 6, 0) };
        fileCard.Paint += (s, e) => ControlPaint.DrawBorder(e.Graphics, fileCard.ClientRectangle, CBorder, ButtonBorderStyle.Solid);
        var lblFh = new Label { Text = "Transferência Direta LAN", Font = new Font("Segoe UI", 11f, FontStyle.Bold), ForeColor = CText, Dock = DockStyle.Top, Height = 26 };
        var fileBtns = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 42, BackColor = CCard };
        var btnSendFile = MakePrimaryButton("Escolher e Enviar Arquivo", 180);
        btnSendFile.Click += (_, _) => PickAndSendFile();
        var btnOpenDl = MakeSecondaryButton("Abrir Downloads", 124);
        btnOpenDl.Click += (_, _) => { Directory.CreateDirectory(_downloadsDir); Process.Start(new ProcessStartInfo("explorer.exe", _downloadsDir) { UseShellExecute = true }); };
        fileBtns.Controls.Add(btnSendFile);
        fileBtns.Controls.Add(btnOpenDl);
        _lblFileStatus = new Label { Text = "Pronto para transferência em velocidade local", ForeColor = CMuted, Dock = DockStyle.Top, Height = 22 };
        _fileProgress = new ProgressBar { Dock = DockStyle.Top, Height = 12, Maximum = 100, Style = ProgressBarStyle.Continuous };
        _listFiles = new ListBox { Dock = DockStyle.Fill, BackColor = CSubtle, ForeColor = CText, BorderStyle = BorderStyle.FixedSingle, IntegralHeight = false };
        fileCard.Controls.Add(_listFiles);
        fileCard.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8 });
        fileCard.Controls.Add(_fileProgress);
        fileCard.Controls.Add(_lblFileStatus);
        fileCard.Controls.Add(fileBtns);
        fileCard.Controls.Add(lblFh);

        var clipCard = new Panel { Dock = DockStyle.Fill, BackColor = CCard, Padding = new Padding(14), Margin = new Padding(6, 0, 0, 0) };
        clipCard.Paint += (s, e) => ControlPaint.DrawBorder(e.Graphics, clipCard.ClientRectangle, CBorder, ButtonBorderStyle.Solid);
        var lblCh = new Label { Text = "Área de Transferência Universal", Font = new Font("Segoe UI", 11f, FontStyle.Bold), ForeColor = CText, Dock = DockStyle.Top, Height = 26 };
        var clipInputRow = new Panel { Dock = DockStyle.Top, Height = 36, BackColor = CCard };
        var txtClip = new TextBox { Dock = DockStyle.Fill, BackColor = CSubtle, ForeColor = CText, BorderStyle = BorderStyle.FixedSingle };
        var btnPushClip = MakePrimaryButton("Enviar", 72);
        btnPushClip.Dock = DockStyle.Right;
        var btnGrabClip = MakeSecondaryButton("Capturar", 78);
        btnGrabClip.Dock = DockStyle.Right;
        btnPushClip.Click += (_, _) => { if (!string.IsNullOrWhiteSpace(txtClip.Text)) { PushClipboard(txtClip.Text); txtClip.Clear(); } };
        btnGrabClip.Click += (_, _) => { try { if (Clipboard.ContainsText()) PushClipboard(Clipboard.GetText()); } catch { } };
        clipInputRow.Controls.Add(txtClip);
        clipInputRow.Controls.Add(btnPushClip);
        clipInputRow.Controls.Add(btnGrabClip);
        var btnCopySel = MakeSecondaryButton("Copiar Item Selecionado", 170);
        btnCopySel.Dock = DockStyle.Bottom;
        btnCopySel.Click += (_, _) =>
        {
            int idx = _listClipboard.SelectedIndex;
            if (idx >= 0 && idx < _clipItems.Count)
            {
                try { Clipboard.SetText(_clipItems[idx].Content); ShowToast("Copiado para a área de transferência do Windows."); } catch { }
            }
        };
        _listClipboard = new ListBox { Dock = DockStyle.Fill, BackColor = CSubtle, ForeColor = CText, BorderStyle = BorderStyle.FixedSingle, IntegralHeight = false };
        clipCard.Controls.Add(_listClipboard);
        clipCard.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8 });
        clipCard.Controls.Add(clipInputRow);
        clipCard.Controls.Add(lblCh);
        clipCard.Controls.Add(btnCopySel);

        viewTransfer.Controls.Add(fileCard, 0, 0);
        viewTransfer.Controls.Add(clipCard, 1, 0);
        _views["transfer"] = viewTransfer;

        // ==================== VIEW 4: LAN DISCOVERY & ALERTS ====================
        var viewNet = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = CBg };
        viewNet.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55f));
        viewNet.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45f));

        var lanCard = new Panel { Dock = DockStyle.Fill, BackColor = CCard, Padding = new Padding(14), Margin = new Padding(0, 0, 6, 0) };
        lanCard.Paint += (s, e) => ControlPaint.DrawBorder(e.Graphics, lanCard.ClientRectangle, CBorder, ButtonBorderStyle.Solid);
        var lblLh = new Label { Text = "Rede Local Direta (P2P · Sem App Web)", Font = new Font("Segoe UI", 11f, FontStyle.Bold), ForeColor = CText, Dock = DockStyle.Top, Height = 26 };
        var lblLs = new Label { Text = $"Hub local em {NetworkUtil.GetLocalLanIp()}:{_hub.Port} (UDP {NetworkUtil.UdpPort}). Apps Continuum no Linux e Android na mesma rede Wi-Fi conectam-se diretamente.", ForeColor = CMuted, Dock = DockStyle.Top, Height = 40 };
        var manRow = new Panel { Dock = DockStyle.Top, Height = 36, BackColor = CCard };
        _txtManualIp = new TextBox { Text = _cfg.ManualPeer, Dock = DockStyle.Fill, BackColor = CSubtle, ForeColor = CText, BorderStyle = BorderStyle.FixedSingle, PlaceholderText = "IP manual (ex: 192.168.1.42:45891)" };
        var btnConnIp = MakePrimaryButton("Conectar IP", 92);
        btnConnIp.Dock = DockStyle.Right;
        var btnAutoLan = MakeSecondaryButton("Auto LAN", 82);
        btnAutoLan.Dock = DockStyle.Right;
        btnConnIp.Click += (_, _) => ApplyConnection(_txtRoomTop.Text, _txtManualIp.Text, false);
        btnAutoLan.Click += (_, _) => { _txtManualIp.Clear(); ApplyConnection(_txtRoomTop.Text, "", true); };
        manRow.Controls.Add(_txtManualIp);
        manRow.Controls.Add(btnConnIp);
        manRow.Controls.Add(btnAutoLan);

        var btnConnectDisc = MakePrimaryButton("Conectar ao Hub Selecionado", 200);
        btnConnectDisc.Dock = DockStyle.Bottom;
        btnConnectDisc.Click += (_, _) =>
        {
            int idx = _listLanPeers.SelectedIndex;
            if (idx >= 0 && idx < _lanPeers.Count)
            {
                var p = _lanPeers[idx];
                _txtRoomTop.Text = p.RoomCode;
                _txtManualIp.Text = $"{p.Ip}:{p.WsPort}";
                ApplyConnection(p.RoomCode, $"{p.Ip}:{p.WsPort}", false);
            }
        };
        _listLanPeers = new ListBox { Dock = DockStyle.Fill, BackColor = CSubtle, ForeColor = CText, BorderStyle = BorderStyle.FixedSingle, IntegralHeight = false };
        lanCard.Controls.Add(_listLanPeers);
        lanCard.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8 });
        lanCard.Controls.Add(manRow);
        lanCard.Controls.Add(lblLs);
        lanCard.Controls.Add(lblLh);
        lanCard.Controls.Add(btnConnectDisc);

        var alertCard = new Panel { Dock = DockStyle.Fill, BackColor = CCard, Padding = new Padding(14), Margin = new Padding(6, 0, 0, 0) };
        alertCard.Paint += (s, e) => ControlPaint.DrawBorder(e.Graphics, alertCard.ClientRectangle, CBorder, ButtonBorderStyle.Solid);
        var lblAh = new Label { Text = "Alertas da Malha LAN", Font = new Font("Segoe UI", 11f, FontStyle.Bold), ForeColor = CText, Dock = DockStyle.Top, Height = 26 };
        var btnTestAlert = MakeSecondaryButton("Enviar Alerta de Teste", 160);
        btnTestAlert.Dock = DockStyle.Top;
        btnTestAlert.Click += (_, _) => _ = SendJsonAsync(new JsonObject
        {
            ["type"] = "notification:push",
            ["title"] = $"Alerta de {Environment.MachineName}",
            ["body"] = "Comunicação direta LAN ativa no Windows.",
            ["sourceDeviceId"] = _deviceId,
            ["sourceDeviceName"] = _deviceName,
        });
        _listNotifs = new ListBox { Dock = DockStyle.Fill, BackColor = CSubtle, ForeColor = CText, BorderStyle = BorderStyle.FixedSingle, IntegralHeight = false };
        alertCard.Controls.Add(_listNotifs);
        alertCard.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8 });
        alertCard.Controls.Add(btnTestAlert);
        alertCard.Controls.Add(lblAh);

        viewNet.Controls.Add(lanCard, 0, 0);
        viewNet.Controls.Add(alertCard, 1, 0);
        _views["network"] = viewNet;

        foreach (var v in _views.Values)
        {
            v.Visible = false;
            contentHost.Controls.Add(v);
        }

        mainHost.Controls.Add(contentHost);
        mainHost.Controls.Add(toastBar);
        mainHost.Controls.Add(topbar);

        Controls.Add(mainHost);
        Controls.Add(sidebar);

        // System Tray
        _tray = new NotifyIcon { Text = "Continuum 3.0 — Malha LAN", Icon = SystemIcons.Application, Visible = true };
        var trayMenu = new ContextMenuStrip();
        trayMenu.Items.Add("Abrir Continuum", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
        trayMenu.Items.Add("Sair", null, (_, _) => { _allowExit = true; Close(); });
        _tray.ContextMenuStrip = trayMenu;
        _tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };

        _uiTimer = new System.Windows.Forms.Timer { Interval = 45 };
        _uiTimer.Tick += (_, _) => { if (_trackpad.HasActiveRipples) _trackpad.Invalidate(); };
        _uiTimer.Start();

        SwitchTab("map");
        _ = Task.Run(RunWebSocketLoopAsync);
        _ = Task.Run(RunTelemetryLoopAsync);
    }

    private static Button MakePrimaryButton(string text, int width)
    {
        var b = new Button { Text = text, Width = width, Height = 32, FlatStyle = FlatStyle.Flat, BackColor = CAccent, ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 8.8f), Cursor = Cursors.Hand };
        b.FlatAppearance.BorderSize = 0;
        return b;
    }

    private static Button MakeSecondaryButton(string text, int width)
    {
        var b = new Button { Text = text, Width = width, Height = 32, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(23, 29, 38), ForeColor = CText, Font = new Font("Segoe UI", 8.8f), Cursor = Cursors.Hand };
        b.FlatAppearance.BorderColor = Color.FromArgb(42, 52, 70);
        b.FlatAppearance.BorderSize = 1;
        return b;
    }

    private void SwitchTab(string key)
    {
        foreach (var kv in _views) kv.Value.Visible = kv.Key == key;
        foreach (var kv in _navButtons)
        {
            bool active = kv.Key == key;
            kv.Value.BackColor = active ? Color.FromArgb(23, 32, 48) : CSidebar;
            kv.Value.ForeColor = active ? Color.White : CMuted;
        }
        _lblPageTitle.Text = key switch
        {
            "map" => "Mapa Espacial de Dispositivos",
            "remote" => "Controle Remoto · Trackpad & Mídia",
            "transfer" => "Arquivos & Área de Transferência",
            _ => "Rede Local Direta (P2P) & Alertas",
        };
    }

    private void RunUi(Action act)
    {
        if (IsDisposed) return;
        if (InvokeRequired) BeginInvoke(act); else act();
    }

    private void ShowToast(string msg) => RunUi(() => _lblToast.Text = msg);

    private AppConfig LoadConfig()
    {
        try
        {
            if (File.Exists(_configPath))
                return JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(_configPath)) ?? new AppConfig();
        }
        catch { }
        return new AppConfig();
    }

    private void SaveConfig()
    {
        try { File.WriteAllText(_configPath, JsonSerializer.Serialize(_cfg, new JsonSerializerOptions { WriteIndented = true })); } catch { }
    }

    private void ApplyConnection(string room, string manualPeer, bool autoLan)
    {
        var cleanRoom = new string((room ?? "").ToUpperInvariant().Where(char.IsLetterOrDigit).Take(12).ToArray());
        _cfg.RoomCode = string.IsNullOrEmpty(cleanRoom) ? "MESH01" : cleanRoom;
        _cfg.ManualPeer = (manualPeer ?? "").Trim();
        _cfg.AutoLan = autoLan;
        SaveConfig();
        ReconnectWs();
    }

    private void ReconnectWs()
    {
        var old = _wsCts;
        _wsCts = new CancellationTokenSource();
        try { old.Cancel(); } catch { }
    }

    private void OnLanPeersDiscovered()
    {
        var peers = _discovery.ListPeers();
        RunUi(() =>
        {
            _lanPeers.Clear();
            _lanPeers.AddRange(peers);
            _listLanPeers.Items.Clear();
            foreach (var p in peers)
                _listLanPeers.Items.Add($"{p.HubName} ({p.Os.ToUpperInvariant()}) · {p.Ip}:{p.WsPort} · Malha {p.RoomCode}");
        });

        if (_cfg.AutoLan && string.IsNullOrWhiteSpace(_cfg.ManualPeer))
        {
            var best = _discovery.ElectBestHub(_cfg.RoomCode);
            if (best != null && !best.IsLocal)
            {
                var desired = $"ws://{best.Ip}:{best.WsPort}/ws";
                if (_connected && !string.Equals(_connectedUrl, desired, StringComparison.OrdinalIgnoreCase))
                    ReconnectWs();
            }
        }
    }

    private (string Url, string Label) ResolveTargetWs()
    {
        if (!string.IsNullOrWhiteSpace(_cfg.ManualPeer))
            return (NetworkUtil.NormalizeWsEndpoint(_cfg.ManualPeer), $"Peer LAN ({_cfg.ManualPeer})");
        if (_cfg.AutoLan)
        {
            var best = _discovery.ElectBestHub(_cfg.RoomCode);
            if (best != null && !best.IsLocal)
                return ($"ws://{best.Ip}:{best.WsPort}/ws", $"Hub LAN · {best.HubName} ({best.Ip})");
        }
        return ($"ws://127.0.0.1:{_hub.Port}/ws", $"Hub Local ({NetworkUtil.GetLocalLanIp()}:{_hub.Port})");
    }

    private JsonObject CollectTelemetry()
    {
        int ramPct = 0;
        try
        {
            var mem = new Win32Native.MEMORYSTATUSEX();
            if (Win32Native.GlobalMemoryStatusEx(mem)) ramPct = (int)mem.dwMemoryLoad;
        }
        catch { }

        var ps = SystemInformation.PowerStatus;
        int? bat = ps.BatteryChargeStatus == BatteryChargeStatus.NoSystemBattery ? null : (int)Math.Round(ps.BatteryLifePercent * 100);
        return new JsonObject
        {
            ["cpuUsage"] = 14,
            ["memoryUsagePercent"] = ramPct,
            ["batteryLevel"] = bat,
            ["networkType"] = "LAN Direta",
            ["lanIp"] = NetworkUtil.GetLocalLanIp(),
            ["displayServer"] = "win32",
        };
    }

    private async Task SendJsonAsync(JsonObject obj)
    {
        var ws = _ws;
        if (ws == null || ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(obj.ToJsonString());
        await _sendLock.WaitAsync();
        try
        {
            if (ws.State == WebSocketState.Open)
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch { }
        finally { _sendLock.Release(); }
    }

    private PeerDevice? GetTargetDevice()
    {
        if (!string.IsNullOrEmpty(_selectedId))
        {
            var exact = _devices.FirstOrDefault(d => d.Id == _selectedId);
            if (exact != null) return exact;
        }
        return _devices.FirstOrDefault(d => d.Id != _deviceId) ?? _devices.FirstOrDefault();
    }

    private void SendRemoteEvent(JsonObject ev)
    {
        var tgt = GetTargetDevice();
        if (tgt == null) { ShowToast("Selecione um dispositivo alvo no Mapa Espacial."); return; }
        _ = SendJsonAsync(new JsonObject { ["type"] = "input:event", ["targetDeviceId"] = tgt.Id, ["event"] = ev });
    }

    private void PushClipboard(string text)
    {
        _ = SendJsonAsync(new JsonObject
        {
            ["type"] = "clipboard:push",
            ["content"] = text,
            ["sourceDeviceId"] = _deviceId,
            ["sourceDeviceName"] = _deviceName,
        });
        ShowToast("Texto sincronizado com todos os dispositivos da malha.");
    }

    private void PickAndSendFile()
    {
        using var ofd = new OpenFileDialog { Title = "Enviar Arquivo via Rede Local" };
        if (ofd.ShowDialog(this) != DialogResult.OK) return;
        var path = ofd.FileName;
        var tgt = GetTargetDevice();
        var targetId = tgt != null && tgt.Id != _deviceId ? tgt.Id : null;

        _ = Task.Run(async () =>
        {
            try
            {
                var info = new FileInfo(path);
                var tid = $"ft-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
                const int chunkSize = 48 * 1024;
                int total = Math.Max(1, (int)((info.Length + chunkSize - 1) / chunkSize));

                var startObj = new JsonObject
                {
                    ["type"] = "file:start",
                    ["transferId"] = tid,
                    ["fileName"] = info.Name,
                    ["fileSize"] = info.Length,
                    ["totalChunks"] = total,
                    ["sourceDeviceId"] = _deviceId,
                    ["sourceDeviceName"] = _deviceName,
                };
                if (!string.IsNullOrEmpty(targetId)) startObj["targetDeviceId"] = targetId;
                await SendJsonAsync(startObj);

                var buf = new byte[chunkSize];
                using var fs = File.OpenRead(path);
                for (int i = 0; i < total; i++)
                {
                    int read = await fs.ReadAsync(buf, 0, chunkSize);
                    var chunkObj = new JsonObject
                    {
                        ["type"] = "file:chunk",
                        ["transferId"] = tid,
                        ["chunkIndex"] = i,
                        ["data"] = Convert.ToBase64String(buf, 0, read),
                    };
                    if (!string.IsNullOrEmpty(targetId)) chunkObj["targetDeviceId"] = targetId;
                    await SendJsonAsync(chunkObj);
                    int pct = (int)(((i + 1) * 100.0) / total);
                    RunUi(() => { _fileProgress.Value = Math.Clamp(pct, 0, 100); _lblFileStatus.Text = $"Enviando {info.Name} · {pct}%"; });
                    await Task.Delay(4);
                }

                var doneObj = new JsonObject { ["type"] = "file:complete", ["transferId"] = tid };
                if (!string.IsNullOrEmpty(targetId)) doneObj["targetDeviceId"] = targetId;
                await SendJsonAsync(doneObj);
                RunUi(() =>
                {
                    _fileProgress.Value = 100;
                    _lblFileStatus.Text = $"Concluído: {info.Name}";
                    _listFiles.Items.Insert(0, $"Enviado: {info.Name} ({Math.Max(1, info.Length / 1024)} KB)");
                });
            }
            catch (Exception ex) { ShowToast($"Erro ao enviar arquivo: {ex.Message}"); }
        });
    }

    private void UpdateSelectedUi()
    {
        var tgt = GetTargetDevice();
        if (tgt != null)
        {
            _lblSelected.Text = $"Alvo ativo: {tgt.Name} ({tgt.Os.ToUpperInvariant()}) · CPU {tgt.CpuUsage}% · RAM {tgt.RamUsage}%";
            _lblRemoteTarget.Text = $"Controlando: {tgt.Name} ({tgt.Os.ToUpperInvariant()})";
        }
        else
        {
            _lblSelected.Text = "Aguardando outros dispositivos Continuum na mesma rede Wi-Fi.";
            _lblRemoteTarget.Text = "Controlando: nenhum peer conectado";
        }
    }

    private void UpdateDevicesFromJson(JsonArray? arr)
    {
        if (arr == null) return;
        var parsed = new List<PeerDevice>();
        int idx = 0;
        foreach (var node in arr)
        {
            if (node is not JsonObject o) continue;
            var tel = o["telemetry"] as JsonObject;
            parsed.Add(new PeerDevice
            {
                Id = o["id"]?.GetValue<string>() ?? "",
                Name = o["name"]?.GetValue<string>() ?? "Dispositivo",
                Os = o["os"]?.GetValue<string>() ?? "desktop",
                Kind = o["kind"]?.GetValue<string>() ?? "desktop",
                X = o["x"]?.GetValue<double>() ?? (180 + (idx % 3) * 230),
                Y = o["y"]?.GetValue<double>() ?? (130 + (idx / 3) * 165),
                CpuUsage = tel?["cpuUsage"]?.GetValue<int>() ?? 0,
                RamUsage = tel?["memoryUsagePercent"]?.GetValue<int>() ?? 0,
                BatteryLevel = tel?["batteryLevel"]?.GetValue<int?>(),
                LanIp = o["lanIp"]?.GetValue<string>() ?? "",
            });
            idx++;
        }

        RunUi(() =>
        {
            _devices.Clear();
            _devices.AddRange(parsed);
            if (string.IsNullOrEmpty(_selectedId))
                _selectedId = _devices.FirstOrDefault(d => d.Id != _deviceId)?.Id;
            _mapPanel.Devices = _devices.ToList();
            _mapPanel.SelectedId = _selectedId;
            _mapPanel.Invalidate();
            _lblHubMeta.Text = $"Malha {_cfg.RoomCode} · {_devices.Count} nó(s)";
            UpdateSelectedUi();
        });
    }

    private async Task RunTelemetryLoopAsync()
    {
        while (!IsDisposed)
        {
            await Task.Delay(2500);
            if (_connected)
            {
                await SendJsonAsync(new JsonObject { ["type"] = "device:telemetry", ["telemetry"] = CollectTelemetry() });
                await SendJsonAsync(new JsonObject { ["type"] = "telemetry:ping", ["sentAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
            }
        }
    }

    private async Task RunWebSocketLoopAsync()
    {
        await Task.Delay(350);
        while (!IsDisposed)
        {
            var ct = _wsCts.Token;
            var (url, label) = ResolveTargetWs();
            _connectedUrl = url;
            _connectedHubLabel = label;
            RunUi(() => { _lblConnStatus.Text = $"● Conectando ({label})..."; _lblConnStatus.ForeColor = CAmber; });

            using var ws = new ClientWebSocket();
            try
            {
                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeoutCts.CancelAfter(5000);
                await ws.ConnectAsync(new Uri(url), timeoutCts.Token);
                _ws = ws;
                _connected = true;

                RunUi(() => { _lblConnStatus.Text = $"● {label}"; _lblConnStatus.ForeColor = CGreen; });

                await SendJsonAsync(new JsonObject
                {
                    ["type"] = "mesh:join",
                    ["roomCode"] = _cfg.RoomCode,
                    ["device"] = new JsonObject
                    {
                        ["id"] = _deviceId,
                        ["name"] = _deviceName,
                        ["os"] = "windows",
                        ["kind"] = "desktop",
                        ["status"] = "online",
                        ["companionConnected"] = true,
                        ["telemetry"] = CollectTelemetry(),
                    }
                });
                await SendJsonAsync(new JsonObject { ["type"] = "telemetry:ping", ["sentAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });

                var recvBuf = new byte[64 * 1024];
                var sb = new StringBuilder();
                while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                {
                    var res = await ws.ReceiveAsync(new ArraySegment<byte>(recvBuf), ct);
                    if (res.MessageType == WebSocketMessageType.Close) break;
                    sb.Append(Encoding.UTF8.GetString(recvBuf, 0, res.Count));
                    if (!res.EndOfMessage) continue;
                    var raw = sb.ToString();
                    sb.Clear();
                    HandleServerMessage(raw);
                }
            }
            catch { }
            finally
            {
                _connected = false;
                _ws = null;
                RunUi(() => { _lblConnStatus.Text = $"● Reconectando ({label})..."; _lblConnStatus.ForeColor = CAmber; });
            }

            if (!ct.IsCancellationRequested)
                try { await Task.Delay(1800, ct); } catch { }
        }
    }

    private void HandleServerMessage(string raw)
    {
        JsonObject? msg;
        try { msg = JsonNode.Parse(raw) as JsonObject; } catch { return; }
        if (msg == null) return;
        var type = msg["type"]?.GetValue<string>() ?? "";

        if (type == "mesh:init")
        {
            UpdateDevicesFromJson(msg["devices"] as JsonArray);
            var clips = msg["clipboard"] as JsonArray;
            if (clips != null)
            {
                RunUi(() =>
                {
                    _clipItems.Clear();
                    _listClipboard.Items.Clear();
                    foreach (var n in clips)
                    {
                        if (n is not JsonObject c) continue;
                        var entry = new ClipEntry { Id = c["id"]?.GetValue<string>() ?? "", Content = c["content"]?.GetValue<string>() ?? "", SourceDeviceName = c["sourceDeviceName"]?.GetValue<string>() ?? "Peer" };
                        _clipItems.Add(entry);
                        _listClipboard.Items.Add($"[{entry.SourceDeviceName}] {entry.Content.Replace("\n", " ")}");
                    }
                });
            }
        }
        else if (type == "mesh:devices_sync")
        {
            UpdateDevicesFromJson(msg["devices"] as JsonArray);
        }
        else if (type == "device:joined" || type == "device:updated")
        {
            if (msg["device"] is JsonObject o)
            {
                var id = o["id"]?.GetValue<string>() ?? "";
                var tel = o["telemetry"] as JsonObject;
                RunUi(() =>
                {
                    var existing = _devices.FirstOrDefault(d => d.Id == id);
                    if (existing == null)
                    {
                        existing = new PeerDevice { Id = id };
                        _devices.Add(existing);
                    }
                    existing.Name = o["name"]?.GetValue<string>() ?? existing.Name;
                    existing.Os = o["os"]?.GetValue<string>() ?? existing.Os;
                    existing.X = o["x"]?.GetValue<double>() ?? existing.X;
                    existing.Y = o["y"]?.GetValue<double>() ?? existing.Y;
                    if (tel != null)
                    {
                        existing.CpuUsage = tel["cpuUsage"]?.GetValue<int>() ?? existing.CpuUsage;
                        existing.RamUsage = tel["memoryUsagePercent"]?.GetValue<int>() ?? existing.RamUsage;
                        existing.BatteryLevel = tel["batteryLevel"]?.GetValue<int?>() ?? existing.BatteryLevel;
                    }
                    _mapPanel.Devices = _devices.ToList();
                    _mapPanel.Invalidate();
                    UpdateSelectedUi();
                });
            }
        }
        else if (type == "telemetry:pong")
        {
            var sent = msg["sentAt"]?.GetValue<long>() ?? 0;
            if (sent > 0)
            {
                _rttMs = (int)Math.Max(1, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - sent);
                RunUi(() => { if (_connected) _lblConnStatus.Text = $"● {_connectedHubLabel} · {_rttMs} ms"; });
            }
        }
        else if (type == "clipboard:added" && msg["item"] is JsonObject cObj)
        {
            var entry = new ClipEntry { Id = cObj["id"]?.GetValue<string>() ?? "", Content = cObj["content"]?.GetValue<string>() ?? "", SourceDeviceName = cObj["sourceDeviceName"]?.GetValue<string>() ?? "Peer" };
            RunUi(() =>
            {
                _clipItems.Insert(0, entry);
                _listClipboard.Items.Insert(0, $"[{entry.SourceDeviceName}] {entry.Content.Replace("\n", " ")}");
            });
        }
        else if (type == "notification:added" && msg["notification"] is JsonObject nObj)
        {
            var title = nObj["title"]?.GetValue<string>() ?? "Alerta";
            var body = nObj["body"]?.GetValue<string>() ?? "";
            var src = nObj["sourceDeviceName"]?.GetValue<string>() ?? "";
            RunUi(() =>
            {
                _listNotifs.Items.Insert(0, $"[{src}] {title}: {body}");
                if (nObj["sourceDeviceId"]?.GetValue<string>() != _deviceId)
                    _tray.ShowBalloonTip(3000, title, body, ToolTipIcon.Info);
            });
        }
        else if (type == "input:event" && msg["event"] is JsonObject evObj)
        {
            var target = msg["targetDeviceId"]?.GetValue<string>();
            if (string.IsNullOrEmpty(target) || target == _deviceId)
            {
                RunUi(() => Win32Native.ExecuteInput(evObj, (t, b) => _tray.ShowBalloonTip(3000, t, b, ToolTipIcon.Info)));
            }
        }
        else if (type == "file:start")
        {
            var tid = msg["transferId"]?.GetValue<string>() ?? "";
            if (!string.IsNullOrEmpty(tid) && msg["sourceDeviceId"]?.GetValue<string>() != _deviceId)
            {
                var name = Path.GetFileName(msg["fileName"]?.GetValue<string>() ?? "arquivo.bin");
                long sz = msg["fileSize"]?.GetValue<long>() ?? 0;
                int tot = Math.Max(1, msg["totalChunks"]?.GetValue<int>() ?? 1);
                _incomingFiles[tid] = (name, sz, tot, new Dictionary<int, string>());
                RunUi(() => { _fileProgress.Value = 0; _lblFileStatus.Text = $"Recebendo {name} · 0%"; });
            }
        }
        else if (type == "file:chunk")
        {
            var tid = msg["transferId"]?.GetValue<string>() ?? "";
            if (_incomingFiles.TryGetValue(tid, out var rec))
            {
                int idx = msg["chunkIndex"]?.GetValue<int>() ?? 0;
                rec.Chunks[idx] = msg["data"]?.GetValue<string>() ?? "";
                int pct = Math.Clamp((int)((rec.Chunks.Count * 100.0) / rec.Total), 0, 99);
                RunUi(() => { _fileProgress.Value = pct; _lblFileStatus.Text = $"Recebendo {rec.Name} · {pct}%"; });
            }
        }
        else if (type == "file:complete")
        {
            var tid = msg["transferId"]?.GetValue<string>() ?? "";
            if (_incomingFiles.Remove(tid, out var rec))
            {
                try
                {
                    Directory.CreateDirectory(_downloadsDir);
                    var outPath = Path.Combine(_downloadsDir, rec.Name);
                    using (var fs = File.Create(outPath))
                    {
                        for (int i = 0; i < rec.Total; i++)
                        {
                            if (rec.Chunks.TryGetValue(i, out var b64) && !string.IsNullOrEmpty(b64))
                            {
                                var bytes = Convert.FromBase64String(b64);
                                fs.Write(bytes, 0, bytes.Length);
                            }
                        }
                    }
                    RunUi(() =>
                    {
                        _fileProgress.Value = 100;
                        _lblFileStatus.Text = $"Recebido: {rec.Name}";
                        _listFiles.Items.Insert(0, $"Recebido: {rec.Name} ({Math.Max(1, rec.Size / 1024)} KB)");
                        _tray.ShowBalloonTip(3000, "Continuum — Arquivo Recebido", $"{rec.Name} salvo em Downloads\\Continuum", ToolTipIcon.Info);
                    });
                }
                catch (Exception ex) { ShowToast($"Erro ao salvar arquivo: {ex.Message}"); }
            }
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_allowExit && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            _tray.ShowBalloonTip(2000, "Continuum continua ativo", "Hub LAN em execução na bandeja do sistema.", ToolTipIcon.Info);
            return;
        }
        _uiTimer.Stop();
        _tray.Visible = false;
        _tray.Dispose();
        _wsCts.Cancel();
        _discovery.Dispose();
        _hub.Dispose();
        base.OnFormClosing(e);
    }
}

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var mutex = new Mutex(true, "Global\\ContinuumWindowsNativeV3Mutex", out bool isNew);
        if (!isNew) return;
        Application.Run(new ContinuumForm());
    }
}
