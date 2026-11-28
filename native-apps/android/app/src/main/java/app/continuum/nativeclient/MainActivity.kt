package app.continuum.nativeclient

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.SweepGradient
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.OpenableColumns
import android.text.InputType
import android.text.TextUtils
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

private const val APP_VERSION = "5.1.0"
private const val LAN_UDP_PORT = 45890
private const val LAN_WS_PORT = 45891
private const val PROTO_V5 = "continuum-lan-v5"
private const val PROTO_V4 = "continuum-lan-v4"
private const val PROTO_V3 = "continuum-lan-v3"
private const val MULTICAST_ADDR = "239.255.45.90"
private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Refined Obsidian-Sapphire Holographic Palette (60-30-10 discipline)
private val C_BG = Color.parseColor("#060A13")
private val C_SIDEBAR = Color.parseColor("#0A101E")
private val C_SURFACE = Color.parseColor("#0F172A")
private val C_CARD = Color.parseColor("#111B2E")
private val C_CARD_SUBTLE = Color.parseColor("#0B1324")
private val C_BORDER = Color.parseColor("#1E314F")
private val C_BORDER_STRONG = Color.parseColor("#2B4770")
private val C_CYAN = Color.parseColor("#22D3EE")
private val C_BLUE = Color.parseColor("#3B82F6")
private val C_VIOLET = Color.parseColor("#8B5CF6")
private val C_GREEN = Color.parseColor("#10B981")
private val C_AMBER = Color.parseColor("#F59E0B")
private val C_RED = Color.parseColor("#EF4444")
private val C_TEXT = Color.parseColor("#F1F5F9")
private val C_MUTED = Color.parseColor("#94A3B8")
private val C_DIM = Color.parseColor("#64748B")

data class MeshDevice(
    val id: String,
    var name: String,
    var os: String,
    var x: Float,
    var y: Float,
    var cpu: Int,
    var ram: Int,
    var battery: Int?,
    var lanIp: String = ""
)

data class DiscoveredLanHub(
    val hubId: String,
    val hubName: String,
    val os: String,
    val ip: String,
    val wsPort: Int,
    val roomCode: String,
    val via: String,
    val remotePeers: Int,
    val lastSeenMs: Long,
    val needsReverseConnect: Boolean = false
)

data class ClipItem(val id: String, val content: String, val source: String)
data class NotifItem(val id: String, val title: String, val body: String, val source: String)

private fun dp(ctx: Context, value: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), ctx.resources.displayMetrics).toInt()

private fun roundedBg(fill: Int, stroke: Int, radiusDp: Float, ctx: Context, strokeDp: Int = 1): GradientDrawable {
    return GradientDrawable().apply {
        setColor(fill)
        cornerRadius = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, radiusDp, ctx.resources.displayMetrics)
        if (stroke != 0) setStroke(dp(ctx, strokeDp), stroke)
    }
}

private fun primaryGradientBg(ctx: Context, radiusDp: Float = 10f): GradientDrawable {
    return GradientDrawable(
        GradientDrawable.Orientation.TL_BR,
        intArrayOf(Color.parseColor("#0891B2"), C_BLUE, Color.parseColor("#6366F1"))
    ).apply {
        cornerRadius = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, radiusDp, ctx.resources.displayMetrics)
    }
}

private fun getLocalLanIp(): String {
    try {
        val interfaces = NetworkInterface.getNetworkInterfaces() ?: return "127.0.0.1"
        var fallback: String? = null
        while (interfaces.hasMoreElements()) {
            val ni = interfaces.nextElement()
            if (!ni.isUp || ni.isLoopback) continue
            val addrs = ni.inetAddresses
            while (addrs.hasMoreElements()) {
                val addr = addrs.nextElement()
                if (addr is Inet4Address && !addr.isLoopbackAddress) {
                    val ip = addr.hostAddress ?: continue
                    if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) return ip
                    if (fallback == null) fallback = ip
                }
            }
        }
        if (fallback != null) return fallback
    } catch (_: Exception) { }
    return "127.0.0.1"
}

private fun parseLanEndpoint(rawInput: String, localIp: String): Pair<String, Int>? {
    var s = rawInput.trim()
    if (s.isEmpty()) return null
    s = s.replace(Regex("^(https?|wss?)://", RegexOption.IGNORE_CASE), "")
    val slashIdx = s.indexOf('/')
    if (slashIdx >= 0) s = s.substring(0, slashIdx)
    s = s.trim()
    if (s.isEmpty()) return null

    val dotTrimmed = s.removePrefix(".")
    if (dotTrimmed.matches(Regex("^[0-9]{1,3}(:[0-9]{2,5})?\$"))) {
        val parts = localIp.split('.')
        if (parts.size == 4 && !localIp.startsWith("127.")) {
            s = "${parts[0]}.${parts[1]}.${parts[2]}.$dotTrimmed"
        }
    }

    var host = s
    var port = LAN_WS_PORT
    val colonIdx = s.lastIndexOf(':')
    if (colonIdx > 0) {
        val pStr = s.substring(colonIdx + 1)
        val parsedPort = pStr.toIntOrNull()
        if (parsedPort != null && parsedPort in 1..65535) {
            host = s.substring(0, colonIdx).trim()
            port = parsedPort
        }
    }
    if (host.isEmpty() || host.contains(' ')) return null
    return Pair(host, port)
}

// ---------------------------------------------------------------------------
// Embedded RFC-6455 LAN Hub on Android (TCP 45891) — Full Fragmented Frame Support
// ---------------------------------------------------------------------------
class EmbeddedAndroidLanHub(
    val hubId: String,
    val hubName: String,
    private val getRoom: () -> String,
    val port: Int = LAN_WS_PORT,
    private val getNeedsReverse: () -> Boolean = { false },
    private val onRemotePeerJoined: ((String, String) -> Unit)? = null
) {
    private class Session(val sock: Socket, val out: OutputStream, val ip: String) {
        @Volatile var deviceId: String? = null
        @Volatile var roomCode: String? = null
    }

    private class RoomData {
        val devices = ConcurrentHashMap<String, JSONObject>()
        val clipboard = mutableListOf<JSONObject>()
        val notifications = mutableListOf<JSONObject>()
    }

    @Volatile var active = false
    val startedAt = System.currentTimeMillis()
    private var serverSocket: ServerSocket? = null
    private val sessions = ConcurrentHashMap.newKeySet<Session>()
    private val rooms = ConcurrentHashMap<String, RoomData>()

    fun start(): Boolean {
        return try {
            val ss = ServerSocket()
            ss.reuseAddress = true
            ss.bind(InetSocketAddress(port))
            serverSocket = ss
            active = true
            Thread {
                while (active) {
                    try {
                        val sock = ss.accept()
                        try { sock.tcpNoDelay = true; sock.keepAlive = true } catch (_: Exception) { }
                        Thread { handleClient(sock) }.apply { isDaemon = true; start() }
                    } catch (_: Exception) {
                        if (!active) break
                    }
                }
            }.apply { isDaemon = true; start() }
            true
        } catch (_: Exception) {
            active = false
            false
        }
    }

    fun stop() {
        active = false
        try { serverSocket?.close() } catch (_: Exception) { }
        sessions.forEach { try { it.sock.close() } catch (_: Exception) { } }
        sessions.clear()
    }

    fun peerCount(room: String): Int = rooms[room]?.devices?.size ?: 0

    fun remotePeerCount(): Int = sessions.count { it.deviceId != null && it.deviceId != hubId }

    fun hasRemotePeers(): Boolean = remotePeerCount() > 0

    private fun getRoomData(code: String): RoomData = rooms.getOrPut(code) { RoomData() }

    private fun encodeFrame(payload: ByteArray, opcode: Int = 0x1): ByteArray {
        val baos = ByteArrayOutputStream(payload.size + 10)
        baos.write(0x80 or (opcode and 0x0F))
        when {
            payload.size < 126 -> baos.write(payload.size)
            payload.size < 65536 -> {
                baos.write(126)
                baos.write((payload.size shr 8) and 0xFF)
                baos.write(payload.size and 0xFF)
            }
            else -> {
                baos.write(127)
                val len = payload.size.toLong()
                for (i in 7 downTo 0) baos.write(((len shr (i * 8)) and 0xFF).toInt())
            }
        }
        baos.write(payload)
        return baos.toByteArray()
    }

    private fun sendText(s: Session, text: String) {
        try {
            val frame = encodeFrame(text.toByteArray(Charsets.UTF_8), 0x1)
            synchronized(s.out) { s.out.write(frame); s.out.flush() }
        } catch (_: Exception) { }
    }

    private fun broadcastRoom(room: String, obj: JSONObject, exclude: Session? = null) {
        val txt = obj.toString()
        sessions.forEach { s ->
            if (s.roomCode == room && s !== exclude) sendText(s, txt)
        }
    }

    private fun sendToDevice(room: String, targetId: String, obj: JSONObject, exclude: Session? = null) {
        val matches = sessions.filter { it.roomCode == room && it.deviceId == targetId && it !== exclude }
        if (matches.isEmpty()) {
            broadcastRoom(room, obj, exclude)
        } else {
            val txt = obj.toString()
            matches.forEach { sendText(it, txt) }
        }
    }

    private fun readExact(ins: InputStream, n: Int): ByteArray? {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = ins.read(buf, off, n - off)
            if (r <= 0) return null
            off += r
        }
        return buf
    }

    private fun handleClient(sock: Socket) {
        val ip = sock.inetAddress?.hostAddress ?: ""
        var session: Session? = null
        try {
            sock.soTimeout = 10000
            val ins = sock.getInputStream()
            val out = sock.getOutputStream()

            val hdrBuf = ByteArrayOutputStream()
            val tmp = ByteArray(1024)
            while (hdrBuf.size() < 8192) {
                val n = ins.read(tmp)
                if (n <= 0) return
                hdrBuf.write(tmp, 0, n)
                if (hdrBuf.toString("UTF-8").contains("\r\n\r\n")) break
            }
            val headersRaw = hdrBuf.toString("UTF-8")
            var wsKey: String? = null
            for (line in headersRaw.split("\r\n").drop(1)) {
                val idx = line.indexOf(':')
                if (idx > 0 && line.substring(0, idx).trim().equals("Sec-WebSocket-Key", ignoreCase = true)) {
                    wsKey = line.substring(idx + 1).trim()
                    break
                }
            }

            if (wsKey.isNullOrBlank()) {
                val room = getRoom()
                val info = JSONObject()
                    .put("ok", true)
                    .put("proto", PROTO_V5)
                    .put("hubId", hubId)
                    .put("hubName", hubName)
                    .put("os", "android")
                    .put("roomCode", room)
                    .put("wsPort", port)
                    .put("ip", getLocalLanIp())
                    .put("startedAt", startedAt)
                    .put("peers", peerCount(room))
                    .put("remotePeers", remotePeerCount())
                    .put("needsReverseConnect", getNeedsReverse())
                    .put("version", APP_VERSION)
                    .toString()
                    .toByteArray(Charsets.UTF_8)
                val resp = ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${info.size}\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII)
                out.write(resp)
                out.write(info)
                out.flush()
                return
            }

            val sha1 = MessageDigest.getInstance("SHA-1").digest((wsKey + WS_GUID).toByteArray(Charsets.US_ASCII))
            val accept = Base64.encodeToString(sha1, Base64.NO_WRAP)
            val handshake = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n"
            out.write(handshake.toByteArray(Charsets.US_ASCII))
            out.flush()
            sock.soTimeout = 0

            val s = Session(sock, out, ip)
            session = s
            sessions.add(s)

            val fragBuf = ByteArrayOutputStream()
            var fragOpcode = 0

            while (active) {
                val h = readExact(ins, 2) ?: break
                val fin = (h[0].toInt() and 0x80) != 0
                val opcode = h[0].toInt() and 0x0F
                val masked = (h[1].toInt() and 0x80) != 0
                var len = (h[1].toInt() and 0x7F).toLong()
                if (len == 126L) {
                    val ext = readExact(ins, 2) ?: break
                    len = (((ext[0].toInt() and 0xFF) shl 8) or (ext[1].toInt() and 0xFF)).toLong()
                } else if (len == 127L) {
                    val ext = readExact(ins, 8) ?: break
                    var u = 0L
                    for (i in 0 until 8) u = (u shl 8) or (ext[i].toLong() and 0xFF)
                    len = u
                }
                if (len < 0 || len > 32 * 1024 * 1024) break
                val mask = if (masked) (readExact(ins, 4) ?: break) else null
                val payload = if (len > 0) (readExact(ins, len.toInt()) ?: break) else ByteArray(0)
                if (mask != null) {
                    for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
                }
                if (opcode == 0x8) break
                if (opcode == 0x9) {
                    synchronized(s.out) { s.out.write(encodeFrame(payload, 0xA)); s.out.flush() }
                    continue
                }
                if (opcode == 0xA) continue

                val finalPayload: ByteArray
                val effOpcode: Int
                if (opcode != 0x0) {
                    if (fin) {
                        effOpcode = opcode
                        finalPayload = payload
                    } else {
                        fragBuf.reset()
                        fragBuf.write(payload)
                        fragOpcode = opcode
                        continue
                    }
                } else {
                    fragBuf.write(payload)
                    if (!fin) continue
                    effOpcode = fragOpcode
                    finalPayload = fragBuf.toByteArray()
                    fragBuf.reset()
                }

                if (effOpcode != 0x1) continue
                try {
                    processMessage(s, JSONObject(String(finalPayload, Charsets.UTF_8)))
                } catch (_: Exception) { }
            }
        } catch (_: Exception) {
        } finally {
            session?.let { s ->
                sessions.remove(s)
                val rm = s.roomCode
                val did = s.deviceId
                if (!rm.isNullOrBlank() && !did.isNullOrBlank()) {
                    val rd = rooms[rm]
                    rd?.devices?.remove(did)
                    broadcastRoom(rm, JSONObject().put("type", "device:left").put("deviceId", did))
                    if (rd != null) {
                        val arr = JSONArray()
                        rd.devices.values.forEach { arr.put(it) }
                        broadcastRoom(rm, JSONObject().put("type", "mesh:devices_sync").put("devices", arr))
                    }
                }
            }
            try { sock.close() } catch (_: Exception) { }
        }
    }

    private fun processMessage(s: Session, msg: JSONObject) {
        when (msg.optString("type")) {
            "mesh:join" -> {
                // Canonical Hub Room Unification: all peers joining this LAN Hub share the Hub's active room
                val room = getRoom().uppercase().replace(Regex("[^A-Z0-9]"), "").take(12).ifEmpty { "MESH01" }
                val devIn = msg.optJSONObject("device") ?: JSONObject()
                val did = devIn.optString("id").ifBlank { "peer-${System.currentTimeMillis()}" }
                val rd = getRoomData(room)
                val idx = rd.devices.size
                val prev = rd.devices[did]
                val devRec = JSONObject()
                    .put("id", did)
                    .put("name", devIn.optString("name", "Dispositivo"))
                    .put("os", devIn.optString("os", "desktop"))
                    .put("kind", devIn.optString("kind", "desktop"))
                    .put("status", "online")
                    .put("x", devIn.optDouble("x", prev?.optDouble("x", 180.0 + (idx % 3) * 210.0) ?: (180.0 + (idx % 3) * 210.0)))
                    .put("y", devIn.optDouble("y", prev?.optDouble("y", 140.0 + (idx / 3) * 155.0) ?: (140.0 + (idx / 3) * 155.0)))
                    .put("companionConnected", true)
                    .put("lanIp", s.ip)
                    .put("telemetry", devIn.optJSONObject("telemetry") ?: JSONObject())
                rd.devices[did] = devRec
                s.deviceId = did
                s.roomCode = room

                val devsArr = JSONArray().apply { rd.devices.values.forEach { put(it) } }
                val clipArr = JSONArray().apply { synchronized(rd.clipboard) { rd.clipboard.take(40).forEach { put(it) } } }
                val notifArr = JSONArray().apply { synchronized(rd.notifications) { rd.notifications.take(40).forEach { put(it) } } }

                sendText(s, JSONObject()
                    .put("type", "mesh:init")
                    .put("roomCode", room)
                    .put("hubName", hubName)
                    .put("hubIp", getLocalLanIp())
                    .put("devices", devsArr)
                    .put("clipboard", clipArr)
                    .put("notifications", notifArr)
                    .toString())
                broadcastRoom(room, JSONObject().put("type", "device:joined").put("device", devRec), s)
                broadcastRoom(room, JSONObject().put("type", "mesh:devices_sync").put("devices", devsArr))
                if (did != hubId) {
                    onRemotePeerJoined?.invoke(room, devRec.optString("name", "Dispositivo"))
                }
            }
            "telemetry:ping" -> {
                sendText(s, JSONObject().put("type", "telemetry:pong").put("sentAt", msg.optLong("sentAt")).put("serverTime", System.currentTimeMillis()).toString())
            }
            "device:telemetry" -> {
                val room = s.roomCode ?: return
                val did = s.deviceId ?: return
                val rd = getRoomData(room)
                val dev = rd.devices[did] ?: return
                dev.put("telemetry", msg.optJSONObject("telemetry") ?: JSONObject())
                broadcastRoom(room, JSONObject().put("type", "device:updated").put("device", dev))
            }
            "device:move" -> {
                val room = s.roomCode ?: return
                val tid = msg.optString("deviceId").ifBlank { s.deviceId ?: return }
                val rd = getRoomData(room)
                val dev = rd.devices[tid] ?: return
                dev.put("x", msg.optDouble("x", 180.0))
                dev.put("y", msg.optDouble("y", 140.0))
                broadcastRoom(room, JSONObject().put("type", "device:updated").put("device", dev))
            }
            "input:event", "file:start", "file:chunk", "file:complete", "screen:start", "screen:frame", "screen:stop", "screen:request" -> {
                val room = s.roomCode ?: return
                val tid = msg.optString("targetDeviceId")
                if (tid.isNotBlank()) sendToDevice(room, tid, msg, s) else broadcastRoom(room, msg, s)
            }
            "clipboard:push" -> {
                val room = s.roomCode ?: return
                val content = msg.optString("content").take(32000)
                if (content.isBlank()) return
                val item = JSONObject()
                    .put("id", "clip-${System.currentTimeMillis()}")
                    .put("content", content)
                    .put("sourceDeviceId", msg.optString("sourceDeviceId").ifBlank { s.deviceId ?: "" })
                    .put("sourceDeviceName", msg.optString("sourceDeviceName", "Peer"))
                    .put("createdAt", System.currentTimeMillis())
                val rd = getRoomData(room)
                synchronized(rd.clipboard) { rd.clipboard.add(0, item); if (rd.clipboard.size > 40) rd.clipboard.removeAt(rd.clipboard.lastIndex) }
                broadcastRoom(room, JSONObject().put("type", "clipboard:added").put("item", item))
            }
            "notification:push" -> {
                val room = s.roomCode ?: return
                val notif = JSONObject()
                    .put("id", "notif-${System.currentTimeMillis()}")
                    .put("title", msg.optString("title", "Alerta"))
                    .put("body", msg.optString("body", ""))
                    .put("sourceDeviceId", msg.optString("sourceDeviceId").ifBlank { s.deviceId ?: "" })
                    .put("sourceDeviceName", msg.optString("sourceDeviceName", "Peer"))
                    .put("createdAt", System.currentTimeMillis())
                val rd = getRoomData(room)
                synchronized(rd.notifications) { rd.notifications.add(0, notif); if (rd.notifications.size > 40) rd.notifications.removeAt(rd.notifications.lastIndex) }
                broadcastRoom(room, JSONObject().put("type", "notification:added").put("notification", notif))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 1. Live Second Screen Canvas (Hardware-Accelerated Native Extended Monitor + Direct Touch)
// ---------------------------------------------------------------------------
class LiveScreenView(
    context: Context,
    private val onAbsMove: (Float, Float) -> Unit,
    private val onAbsClick: (Float, Float, String) -> Unit,
    private val onScroll: (Float) -> Unit
) : View(context) {
    private val density = context.resources.displayMetrics.density
    @Volatile private var currentBitmap: Bitmap? = null
    private val bmpPaint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val bgPaint = Paint().apply { color = Color.parseColor("#04070E") }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(120, 34, 211, 238); style = Paint.Style.STROKE; strokeWidth = 1.5f * density }
    private val hudPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_MUTED; textSize = 13f * density; textAlign = Paint.Align.CENTER }
    private val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_TEXT; textSize = 16f * density; textAlign = Paint.Align.CENTER; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }

    private val destRect = RectF()
    private val srcRect = Rect()
    private var downX = 0f
    private var downY = 0f
    private var lastY = 0f
    private var moved = false
    private var twoFinger = false
    private var downTime = 0L

    fun updateFrame(bmp: Bitmap?) {
        val old = currentBitmap
        currentBitmap = bmp
        if (old != null && old !== bmp && !old.isRecycled) {
            try { old.recycle() } catch (_: Exception) { }
        }
        postInvalidate()
    }

    fun hasStream(): Boolean = currentBitmap != null

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 4 || height <= 4) return
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)

        val bmp = currentBitmap
        if (bmp == null || bmp.isRecycled) {
            val cx = width / 2f
            val cy = height / 2f
            val boxW = min(width * 0.72f, 360f * density)
            val boxH = 128f * density
            canvas.drawRoundRect(RectF(cx - boxW / 2f, cy - boxH / 2f, cx + boxW / 2f, cy + boxH / 2f), 16f * density, 16f * density, borderPaint)
            canvas.drawText("Segunda Tela Pronta para Receber", cx, cy - 10f * density, titlePaint)
            canvas.drawText("Toque em 'Iniciar Extensão do PC' abaixo ou no seu computador.", cx, cy + 18f * density, hudPaint)
            return
        }

        val bw = bmp.width.toFloat()
        val bh = bmp.height.toFloat()
        val scale = min(width / bw, height / bh)
        val dw = bw * scale
        val dh = bh * scale
        val left = (width - dw) / 2f
        val top = (height - dh) / 2f
        srcRect.set(0, 0, bmp.width, bmp.height)
        destRect.set(left, top, left + dw, top + dh)
        canvas.drawBitmap(bmp, srcRect, destRect, bmpPaint)
    }

    private fun toNormalized(x: Float, y: Float): Pair<Float, Float>? {
        if (destRect.width() <= 1f || destRect.height() <= 1f) return null
        val nx = ((x - destRect.left) / destRect.width()).coerceIn(0f, 1f)
        val ny = ((y - destRect.top) / destRect.height()).coerceIn(0f, 1f)
        return Pair(nx, ny)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (currentBitmap == null) return false
        val now = SystemClock.uptimeMillis()
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x; downY = event.y; lastY = event.y
                moved = false; twoFinger = false; downTime = now
                toNormalized(event.x, event.y)?.let { (nx, ny) -> onAbsMove(nx, ny) }
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                twoFinger = event.pointerCount >= 2
                lastY = event.y
            }
            MotionEvent.ACTION_MOVE -> {
                if (abs(event.x - downX) > 6f || abs(event.y - downY) > 6f) moved = true
                if (twoFinger || event.pointerCount >= 2) {
                    val dy = event.y - lastY
                    lastY = event.y
                    if (abs(dy) > 2f) onScroll(dy * 2.5f)
                } else {
                    toNormalized(event.x, event.y)?.let { (nx, ny) -> onAbsMove(nx, ny) }
                }
            }
            MotionEvent.ACTION_UP -> {
                if (!moved && (now - downTime) < 300L) {
                    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    toNormalized(event.x, event.y)?.let { (nx, ny) ->
                        onAbsClick(nx, ny, if (twoFinger) "right" else "left")
                    }
                }
                twoFinger = false
            }
        }
        return true
    }
}

// ---------------------------------------------------------------------------
// 2. Holographic 60 FPS Spatial Device Map View
// ---------------------------------------------------------------------------
class HolographicSpatialMapView(context: Context) : View(context) {
    var devices: MutableList<MeshDevice> = mutableListOf()
    var selfId: String = ""
    var selectedId: String? = null
    var scanning: Boolean = false
    var scanProgress: Int = 0
    var onSelect: ((MeshDevice) -> Unit)? = null
    var onMoved: ((String, Float, Float) -> Unit)? = null

    private val density = context.resources.displayMetrics.density
    private val nodeW = 186f * density
    private val nodeH = 104f * density
    private var dragId: String? = null
    private var dragOffX = 0f
    private var dragOffY = 0f
    private var lastFrameMs = SystemClock.uptimeMillis()
    private var phase = 0f

    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val crossPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(65, 34, 211, 238); strokeWidth = 1f * density }
    private val radarRingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.2f * density }
    private val radarSweepPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val linkGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val packetPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_CYAN; style = Paint.Style.FILL }
    private val cardFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val cardGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.6f * density; color = C_CYAN }
    private val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_TEXT; textSize = 12.5f * density; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
    private val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_MUTED; textSize = 10f * density }
    private val gaugeBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 3f * density; color = Color.argb(95, 30, 51, 84) }
    private val gaugeValPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 3f * density; strokeCap = Paint.Cap.ROUND }
    private val gaugeTxtPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_TEXT; textSize = 8.8f * density; textAlign = Paint.Align.CENTER; typeface = Typeface.MONOSPACE }

    private fun screenPos(d: MeshDevice): Pair<Float, Float> {
        val sx = (d.x / 720f) * max(width.toFloat(), 320f)
        val sy = (d.y / 480f) * max(height.toFloat(), 300f)
        return Pair(
            sx.coerceIn(nodeW / 2f + 16f, max(nodeW / 2f + 18f, width - nodeW / 2f - 16f)),
            sy.coerceIn(nodeH / 2f + 16f, max(nodeH / 2f + 18f, height - nodeH / 2f - 16f))
        )
    }

    private fun nodeRect(d: MeshDevice): RectF {
        val (cx, cy) = screenPos(d)
        return RectF(cx - nodeW / 2f, cy - nodeH / 2f, cx + nodeW / 2f, cy + nodeH / 2f)
    }

    private fun cubicPoint(t: Float, x0: Float, y0: Float, x1: Float, y1: Float, x2: Float, y2: Float, x3: Float, y3: Float): Pair<Float, Float> {
        val u = 1f - t
        val x = u * u * u * x0 + 3f * u * u * t * x1 + 3f * u * t * t * x2 + t * t * t * x3
        val y = u * u * u * y0 + 3f * u * u * t * y1 + 3f * u * t * t * y2 + t * t * t * y3
        return Pair(x, y)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 4 || height <= 4) return
        val now = SystemClock.uptimeMillis()
        val dt = ((now - lastFrameMs).coerceIn(1L, 50L)) / 1000f
        lastFrameMs = now
        phase = (phase + dt) % 1000f

        val cx = width / 2f
        val cy = height / 2f
        val maxR = min(width, height) * 0.44f

        bgPaint.shader = RadialGradient(cx, cy, max(width, height) * 0.78f, Color.parseColor("#0D182D"), C_BG, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)

        val step = (34f * density).toInt().coerceAtLeast(32)
        var gx = step
        while (gx < width) {
            var gy = step
            while (gy < height) {
                canvas.drawLine(gx - 2.5f * density, gy.toFloat(), gx + 2.5f * density, gy.toFloat(), crossPaint)
                canvas.drawLine(gx.toFloat(), gy - 2.5f * density, gx.toFloat(), gy + 2.5f * density, crossPaint)
                gy += step
            }
            gx += step
        }

        for (i in 1..3) {
            radarRingPaint.color = Color.argb(if (scanning) 50 else 22, 34, 211, 238)
            canvas.drawCircle(cx, cy, maxR * (i / 3f), radarRingPaint)
        }
        val pulseR = ((phase * 0.5f) % 1f) * maxR
        val pulseAlpha = ((1f - (pulseR / max(1f, maxR))) * (if (scanning) 125 else 50)).toInt().coerceIn(0, 255)
        radarRingPaint.color = Color.argb(pulseAlpha, 34, 211, 238)
        canvas.drawCircle(cx, cy, pulseR, radarRingPaint)

        if (scanning || devices.size <= 1) {
            canvas.save()
            canvas.rotate((phase * 110f) % 360f, cx, cy)
            radarSweepPaint.shader = SweepGradient(
                cx, cy,
                intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, Color.argb(60, 34, 211, 238)),
                floatArrayOf(0f, 0.78f, 1f)
            )
            canvas.drawCircle(cx, cy, maxR, radarSweepPaint)
            canvas.restore()
        }

        if (devices.isEmpty()) {
            subPaint.textAlign = Paint.Align.CENTER
            subPaint.color = C_CYAN
            val msg = if (scanning) "Radar escaneando dispositivos Wi-Fi... $scanProgress%" else "Aguardando dispositivos Linux ou Windows na mesma rede..."
            canvas.drawText(msg, cx, cy + maxR * 0.52f, subPaint)
            subPaint.textAlign = Paint.Align.LEFT
            subPaint.color = C_MUTED
            postInvalidateOnAnimation()
            return
        }

        val anchor = devices.firstOrNull { it.id == selfId } ?: devices.first()
        val (ax, ay) = screenPos(anchor)
        for (d in devices) {
            if (d.id == anchor.id) continue
            val (dx, dy) = screenPos(d)
            val isSel = d.id == selectedId
            val mx = (ax + dx) / 2f
            val path = Path().apply { moveTo(ax, ay); cubicTo(mx, ay, mx, dy, dx, dy) }
            linkGlowPaint.shader = LinearGradient(ax, ay, dx, dy, C_CYAN, if (isSel) C_VIOLET else C_BLUE, Shader.TileMode.CLAMP)
            linkGlowPaint.alpha = if (isSel) 90 else 44
            linkGlowPaint.strokeWidth = (if (isSel) 7f else 4f) * density
            canvas.drawPath(path, linkGlowPaint)
            linkGlowPaint.alpha = if (isSel) 235 else 155
            linkGlowPaint.strokeWidth = (if (isSel) 2.2f else 1.4f) * density
            canvas.drawPath(path, linkGlowPaint)

            for (k in 0..1) {
                val t = ((phase * 0.6f + k * 0.5f) % 1f)
                val (px, py) = cubicPoint(t, ax, ay, mx, ay, mx, dy, dx, dy)
                packetPaint.color = Color.argb(90, 34, 211, 238)
                canvas.drawCircle(px, py, 6f * density, packetPaint)
                packetPaint.color = Color.WHITE
                canvas.drawCircle(px, py, 2.3f * density, packetPaint)
            }
        }

        val rCorner = 14f * density
        for (d in devices) {
            val r = nodeRect(d)
            val isSelf = d.id == selfId
            val isSel = d.id == selectedId

            if (isSel || isSelf) {
                cardGlowPaint.color = if (isSel) Color.argb(65, 34, 211, 238) else Color.argb(45, 16, 185, 129)
                cardGlowPaint.strokeWidth = 6f * density
                canvas.drawRoundRect(RectF(r.left - 1f, r.top - 1f, r.right + 1f, r.bottom + 1f), rCorner, rCorner, cardGlowPaint)
            }

            cardFillPaint.shader = LinearGradient(
                r.left, r.top, r.right, r.bottom,
                if (isSel) Color.argb(238, 22, 36, 62) else Color.argb(225, 15, 23, 40),
                Color.argb(235, 9, 14, 26),
                Shader.TileMode.CLAMP
            )
            canvas.drawRoundRect(r, rCorner, rCorner, cardFillPaint)

            borderPaint.shader = LinearGradient(
                r.left, r.top, r.right, r.bottom,
                when {
                    isSel -> intArrayOf(C_CYAN, C_BLUE, C_VIOLET)
                    isSelf -> intArrayOf(C_GREEN, C_CYAN)
                    else -> intArrayOf(C_BORDER_STRONG, C_BORDER)
                },
                null,
                Shader.TileMode.CLAMP
            )
            borderPaint.strokeWidth = (if (isSel) 2f else 1.2f) * density
            canvas.drawRoundRect(r, rCorner, rCorner, borderPaint)

            val ix = r.left + 14f * density
            val iy = r.top + 14f * density
            iconPaint.color = if (isSel) C_CYAN else (if (isSelf) C_GREEN else C_BLUE)
            if (d.os.equals("android", true) || d.os.equals("ios", true)) {
                canvas.drawRoundRect(RectF(ix, iy, ix + 11f * density, iy + 18f * density), 2.5f * density, 2.5f * density, iconPaint)
                canvas.drawLine(ix + 4f * density, iy + 15f * density, ix + 7f * density, iy + 15f * density, iconPaint)
            } else {
                canvas.drawRoundRect(RectF(ix, iy, ix + 16f * density, iy + 12f * density), 2f * density, 2f * density, iconPaint)
                canvas.drawLine(ix + 5f * density, iy + 15f * density, ix + 11f * density, iy + 15f * density, iconPaint)
                canvas.drawLine(ix + 8f * density, iy + 12f * density, ix + 8f * density, iy + 15f * density, iconPaint)
            }

            val label = if (d.name.length > 16) d.name.substring(0, 16) else d.name
            canvas.drawText(label, r.left + 38f * density, r.top + 24f * density, titlePaint)
            val role = if (isSelf) "Este Dispositivo" else if (isSel) "Alvo Ativo" else "LAN Direta"
            val bat = if (d.battery != null) " · ${d.battery}%" else ""
            canvas.drawText("${d.os.uppercase()} · $role$bat", r.left + 38f * density, r.top + 39f * density, subPaint)

            drawRadialGauge(canvas, r.left + 46f * density, r.top + 74f * density, 16f * density, d.cpu, "CPU", C_CYAN)
            drawRadialGauge(canvas, r.left + 120f * density, r.top + 74f * density, 16f * density, d.ram, "RAM", C_VIOLET)
        }
        postInvalidateOnAnimation()
    }

    private fun drawRadialGauge(canvas: Canvas, cx: Float, cy: Float, radius: Float, value: Int, label: String, color: Int) {
        val oval = RectF(cx - radius, cy - radius, cx + radius, cy + radius)
        canvas.drawArc(oval, -90f, 360f, false, gaugeBgPaint)
        gaugeValPaint.color = color
        val sweep = (value.coerceIn(0, 100) / 100f) * 360f
        if (sweep > 0f) canvas.drawArc(oval, -90f, sweep, false, gaugeValPaint)
        canvas.drawText("$value%", cx, cy + 3f * density, gaugeTxtPaint)
        canvas.drawText(label, cx + radius + 16f * density, cy + 3f * density, subPaint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                for (i in devices.indices.reversed()) {
                    val d = devices[i]
                    if (nodeRect(d).contains(event.x, event.y)) {
                        performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                        selectedId = d.id
                        dragId = d.id
                        val (cx, cy) = screenPos(d)
                        dragOffX = cx - event.x
                        dragOffY = cy - event.y
                        onSelect?.invoke(d)
                        invalidate()
                        return true
                    }
                }
            }
            MotionEvent.ACTION_MOVE -> {
                val id = dragId ?: return false
                val d = devices.firstOrNull { it.id == id } ?: return false
                val nx = ((event.x + dragOffX) / max(width.toFloat(), 320f)) * 720f
                val ny = ((event.y + dragOffY) / max(height.toFloat(), 300f)) * 480f
                d.x = nx.coerceIn(90f, 630f)
                d.y = ny.coerceIn(60f, 420f)
                invalidate()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val id = dragId
                dragId = null
                if (id != null) devices.firstOrNull { it.id == id }?.let { onMoved?.invoke(id, it.x, it.y) }
                return true
            }
        }
        return super.onTouchEvent(event)
    }
}

// ---------------------------------------------------------------------------
// 3. Holographic Multi-Touch Trackpad View
// ---------------------------------------------------------------------------
class HolographicTrackpadView(
    context: Context,
    private val onMove: (Float, Float) -> Unit,
    private val onClick: (String) -> Unit,
    private val onScroll: (Float) -> Unit
) : View(context) {
    private val density = context.resources.displayMetrics.density
    private var lastX = 0f
    private var lastY = 0f
    private var touchX = -1f
    private var touchY = -1f
    private var moved = false
    private var twoFinger = false
    private var downTime = 0L

    private data class TrailPt(val x: Float, val y: Float, val t0: Long)
    private data class Ripple(val x: Float, val y: Float, val t0: Long)
    private val trail = mutableListOf<TrailPt>()
    private val ripples = mutableListOf<Ripple>()

    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(65, 34, 211, 238) }
    private val bracketPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(145, 34, 211, 238); style = Paint.Style.STROKE; strokeWidth = 2f * density; strokeCap = Paint.Cap.ROUND }
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(155, 148, 163, 184); textSize = 12.5f * density; textAlign = Paint.Align.CENTER }
    private val trailPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val ripplePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * density }
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val corePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 4 || height <= 4) return
        bgPaint.shader = RadialGradient(width / 2f, height / 2f, max(width, height) * 0.7f, Color.parseColor("#0C162A"), C_BG, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)

        val step = (26f * density).toInt().coerceAtLeast(24)
        var gx = step
        while (gx < width) {
            var gy = step
            while (gy < height) {
                canvas.drawCircle(gx.toFloat(), gy.toFloat(), 1.1f * density, dotPaint)
                gy += step
            }
            gx += step
        }

        val m = 16f * density
        val b = 20f * density
        canvas.drawLine(m, m, m + b, m, bracketPaint); canvas.drawLine(m, m, m, m + b, bracketPaint)
        canvas.drawLine(width - m, m, width - m - b, m, bracketPaint); canvas.drawLine(width - m, m, width - m, m + b, bracketPaint)
        canvas.drawLine(m, height - m, m + b, height - m, bracketPaint); canvas.drawLine(m, height - m, m, height - m - b, bracketPaint)
        canvas.drawLine(width - m, height - m, width - m - b, height - m, bracketPaint); canvas.drawLine(width - m, height - m, width - m, height - m - b, bracketPaint)

        if (touchX < 0f) {
            canvas.drawText("1 dedo: mover e tocar (esq.)  ·  2 dedos: rolar e tocar (dir.)", width / 2f, height / 2f, hintPaint)
        }

        val now = SystemClock.uptimeMillis()
        trail.removeAll { now - it.t0 > 260L }
        for (i in 1 until trail.size) {
            val p0 = trail[i - 1]
            val p1 = trail[i]
            val age = (now - p1.t0) / 260f
            val alpha = ((1f - age) * 210).toInt().coerceIn(0, 255)
            trailPaint.color = Color.argb(alpha, 34, 211, 238)
            trailPaint.strokeWidth = (1f - age) * 7f * density + 1.5f * density
            canvas.drawLine(p0.x, p0.y, p1.x, p1.y, trailPaint)
        }

        ripples.removeAll { now - it.t0 > 460L }
        for (rp in ripples) {
            val p = (now - rp.t0) / 460f
            val alpha = ((1f - p) * 215).toInt().coerceIn(0, 255)
            ripplePaint.color = Color.argb(alpha, 34, 211, 238)
            canvas.drawCircle(rp.x, rp.y, (12f + p * 54f) * density, ripplePaint)
            ripplePaint.color = Color.argb((alpha * 0.55f).toInt(), 139, 92, 246)
            canvas.drawCircle(rp.x, rp.y, (6f + p * 34f) * density, ripplePaint)
        }

        if (touchX >= 0f && touchY >= 0f) {
            glowPaint.shader = RadialGradient(touchX, touchY, 34f * density, Color.argb(145, 34, 211, 238), Color.TRANSPARENT, Shader.TileMode.CLAMP)
            canvas.drawCircle(touchX, touchY, 34f * density, glowPaint)
            canvas.drawCircle(touchX, touchY, 5.5f * density, corePaint)
        }

        if (ripples.isNotEmpty() || trail.isNotEmpty()) postInvalidateOnAnimation()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val now = SystemClock.uptimeMillis()
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastX = event.x; lastY = event.y; touchX = event.x; touchY = event.y
                moved = false; twoFinger = false; downTime = now
                trail.clear(); trail.add(TrailPt(event.x, event.y, now))
                ripples.add(Ripple(event.x, event.y, now))
                invalidate()
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                twoFinger = event.pointerCount >= 2; lastX = event.x; lastY = event.y
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = event.x - lastX; val dy = event.y - lastY
                lastX = event.x; lastY = event.y; touchX = event.x; touchY = event.y
                trail.add(TrailPt(event.x, event.y, now))
                if (trail.size > 26) trail.removeAt(0)
                if (abs(dx) > 1.1f || abs(dy) > 1.1f) {
                    moved = true
                    if (twoFinger || event.pointerCount >= 2) onScroll(dy * 2.5f)
                    else onMove(dx * 2.0f, dy * 2.0f)
                }
                invalidate()
            }
            MotionEvent.ACTION_UP -> {
                if (!moved && (now - downTime) < 260L) {
                    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    onClick(if (twoFinger) "right" else "left")
                    ripples.add(Ripple(event.x, event.y, now))
                }
                touchX = -1f; touchY = -1f; twoFinger = false
                invalidate()
            }
            MotionEvent.ACTION_CANCEL -> {
                touchX = -1f; touchY = -1f; invalidate()
            }
        }
        return true
    }
}

// ---------------------------------------------------------------------------
// Main Continuum v5.0 Native Android Activity (Responsive Tablet Sidebar + Phone Dock)
// ---------------------------------------------------------------------------
class MainActivity : AppCompatActivity() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private val prefs by lazy { getSharedPreferences("continuum_lan_v5", Context.MODE_PRIVATE) }
    private val deviceName by lazy { "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}" }
    private val deviceId by lazy {
        val clean = Build.MODEL.lowercase().replace(Regex("[^a-z0-9]"), "").take(12).ifEmpty { "android" }
        "android-app-$clean-${(System.currentTimeMillis() % 8999) + 1000}"
    }

    private val connGen = AtomicInteger(0)
    private var roomCode: String = BuildConfig.DEFAULT_ROOM_CODE
    private var manualHostPort: String = ""
    private var activeWsUrl: String = ""
    private var activeHubLabel: String = ""
    private var ws: WebSocket? = null
    @Volatile private var connected = false
    private var consecutiveFailures = 0
    private var rttMs: Int? = null
    @Volatile private var destroyed = false
    private var selectedDeviceId: String? = null
    @Volatile private var scanningLan = false
    @Volatile private var needsReverseConnect = false
    private var isTabletMode = false
    private var fullscreenScreen = false
    private var autoClipboardSync = true
    private var lastSyncedClip: String = ""

    private var screenFpsCount = 0
    private var screenFpsLastMs = SystemClock.uptimeMillis()
    private var screenFps = 0
    private var screenResText = ""

    private val devices = mutableListOf<MeshDevice>()
    private val discoveredHubs = ConcurrentHashMap<String, DiscoveredLanHub>()
    private val clipItems = mutableListOf<ClipItem>()
    private val notifItems = mutableListOf<NotifItem>()
    private val incomingFiles = ConcurrentHashMap<String, IncomingFile>()

    private lateinit var localHub: EmbeddedAndroidLanHub
    private var multicastLock: WifiManager.MulticastLock? = null
    private var discoverySocket: DatagramSocket? = null
    private var clipListener: ClipboardManager.OnPrimaryClipChangedListener? = null

    // Shell & UI References
    private var sidebarView: View? = null
    private var bottomDockView: View? = null
    private lateinit var topBarView: View
    private lateinit var lblTopSection: TextView
    private lateinit var lblTopStatus: TextView
    private lateinit var lblSidebarStatus: TextView
    private lateinit var lblSidebarRoom: TextView
    private lateinit var spatialMap: HolographicSpatialMapView
    private lateinit var lblMapSelected: TextView
    private lateinit var liveScreenView: LiveScreenView
    private lateinit var lblScreenStatus: TextView
    private lateinit var screenControlsBar: View
    private lateinit var btnExitFullscreen: Button
    private lateinit var lblRemoteTarget: TextView
    private lateinit var fileProgress: ProgressBar
    private lateinit var lblFileStatus: TextView
    private lateinit var fileListContainer: LinearLayout
    private lateinit var clipListContainer: LinearLayout
    private lateinit var lanPeersContainer: LinearLayout
    private lateinit var telemetryContainer: LinearLayout
    private lateinit var lblScanBanner: TextView
    private lateinit var notifListContainer: LinearLayout
    private lateinit var editManualIp: EditText
    private lateinit var editRoom: EditText

    private val tabPanels = mutableMapOf<String, View>()
    private val navItems = mutableMapOf<String, View>()
    private val tabTitles = mapOf(
        "map" to "Mapa Espacial",
        "screen" to "Segunda Tela",
        "remote" to "Mouse & Teclado",
        "transfer" to "Clipboard & Arquivos",
        "network" to "Rede & Sistema"
    )

    data class IncomingFile(val name: String, val size: Long, val total: Int, val chunks: MutableMap<Int, String> = mutableMapOf())

    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) sendFileFromUri(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        roomCode = prefs.getString("roomCode", BuildConfig.DEFAULT_ROOM_CODE) ?: BuildConfig.DEFAULT_ROOM_CODE
        manualHostPort = prefs.getString("manualHostPort", "") ?: ""
        autoClipboardSync = prefs.getBoolean("autoClipboardSync", true)

        val dm = resources.displayMetrics
        isTabletMode = resources.configuration.smallestScreenWidthDp >= 580 || dm.widthPixels > dm.heightPixels * 1.15f

        localHub = EmbeddedAndroidLanHub(
            hubId = deviceId,
            hubName = deviceName,
            getRoom = { roomCode },
            port = LAN_WS_PORT,
            getNeedsReverse = { needsReverseConnect },
            onRemotePeerJoined = { _, peerName ->
                needsReverseConnect = false
                val localUrl = "ws://127.0.0.1:$LAN_WS_PORT/ws"
                mainHandler.post {
                    if (activeWsUrl != localUrl) {
                        manualHostPort = ""
                        prefs.edit().putString("manualHostPort", "").apply()
                        toast("$peerName conectou ao seu dispositivo! Sincronizando mapa...")
                        connectToEndpoint(localUrl, "Hub Local (${getLocalLanIp()})", force = true)
                    } else {
                        toast("$peerName entrou na malha!")
                    }
                }
            }
        )
        localHub.start()

        setContentView(buildRootUi())
        switchTab("map")
        setupAutoClipboardListener()
        startUdpDiscoveryAndResponder()
        startTelemetryHeartbeat()

        // Always connect cleanly to our embedded local hub first so PCs can join immediately,
        // while simultaneously scanning Wi-Fi for PC hubs!
        if (manualHostPort.isNotBlank()) {
            connectDirectInput(manualHostPort)
        } else {
            connectToEndpoint("ws://127.0.0.1:$LAN_WS_PORT/ws", "Hub Local (${getLocalLanIp()})", force = true)
            runFastLanSubnetScan(autoConnect = true)
        }
    }

    private fun buildRootUi(): View {
        val outer = LinearLayout(this).apply {
            orientation = if (isTabletMode) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
            setBackgroundColor(C_BG)
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }

        val tabs = listOf(
            Triple("map", "Mapa Espacial", "Mapa"),
            Triple("screen", "Segunda Tela", "Tela"),
            Triple("remote", "Mouse & Teclado", "Mouse"),
            Triple("transfer", "Clipboard & Arquivos", "Clip"),
            Triple("network", "Rede & Sistema", "Rede")
        )

        // ==================== TABLET LEFT SIDEBAR (224dp, Web-App Parity) ====================
        if (isTabletMode) {
            val side = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(C_SIDEBAR)
                layoutParams = LinearLayout.LayoutParams(dp(this@MainActivity, 224), ViewGroup.LayoutParams.MATCH_PARENT)
            }
            val brand = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(this@MainActivity, 18), dp(this@MainActivity, 16), dp(this@MainActivity, 18), dp(this@MainActivity, 14))
            }
            brand.addView(TextView(this).apply {
                text = "Continuum"
                setTextColor(C_TEXT)
                textSize = 18f
                typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            })
            brand.addView(TextView(this).apply {
                text = "Malha Nativa v$APP_VERSION"
                setTextColor(C_CYAN)
                textSize = 11.5f
            })
            side.addView(brand)
            side.addView(hairline())

            val navList = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(this@MainActivity, 12), dp(this@MainActivity, 12), dp(this@MainActivity, 12), dp(this@MainActivity, 12))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            }
            for ((key, fullLabel, _) in tabs) {
                val btn = TextView(this).apply {
                    text = fullLabel
                    setTextColor(C_MUTED)
                    textSize = 14f
                    gravity = Gravity.CENTER_VERTICAL
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                    setPadding(dp(this@MainActivity, 14), dp(this@MainActivity, 12), dp(this@MainActivity, 14), dp(this@MainActivity, 12))
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this@MainActivity, 46)).apply {
                        bottomMargin = dp(this@MainActivity, 6)
                    }
                    setOnClickListener {
                        it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                        switchTab(key)
                    }
                }
                navItems[key] = btn
                navList.addView(btn)
            }
            side.addView(navList)
            side.addView(hairline())

            val footer = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(this@MainActivity, 16), dp(this@MainActivity, 12), dp(this@MainActivity, 16), dp(this@MainActivity, 16))
            }
            lblSidebarRoom = TextView(this).apply {
                text = "Malha: $roomCode"
                setTextColor(C_TEXT)
                textSize = 12.5f
                typeface = Typeface.MONOSPACE
            }
            lblSidebarStatus = TextView(this).apply {
                text = "IP: ${getLocalLanIp()}:$LAN_WS_PORT"
                setTextColor(C_MUTED)
                textSize = 11.5f
                setPadding(0, dp(this@MainActivity, 4), 0, 0)
            }
            footer.addView(lblSidebarRoom)
            footer.addView(lblSidebarStatus)
            side.addView(footer)

            sidebarView = side
            outer.addView(side)
            outer.addView(View(this).apply {
                setBackgroundColor(C_BORDER)
                layoutParams = LinearLayout.LayoutParams(dp(this@MainActivity, 1), ViewGroup.LayoutParams.MATCH_PARENT)
            })
        } else {
            lblSidebarRoom = TextView(this)
            lblSidebarStatus = TextView(this)
        }

        // ==================== MAIN COLUMN ====================
        val mainCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = if (isTabletMode) {
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
            } else {
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            }
        }

        // Clean 3-Zone Top Bar (58dp)
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(C_SIDEBAR)
            setPadding(dp(this@MainActivity, 16), dp(this@MainActivity, 8), dp(this@MainActivity, 16), dp(this@MainActivity, 8))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this@MainActivity, 58))
        }
        val titleStack = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                rightMargin = dp(this@MainActivity, 12)
            }
        }
        lblTopSection = TextView(this).apply {
            text = "Mapa Espacial"
            setTextColor(C_TEXT)
            textSize = 15.5f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
        lblTopStatus = TextView(this).apply {
            text = "Iniciando radar Wi-Fi..."
            setTextColor(C_CYAN)
            textSize = 11.5f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        titleStack.addView(lblTopSection)
        titleStack.addView(lblTopStatus)
        topBar.addView(titleStack)

        val btnScan = makeBtn("Escanear Wi-Fi", primary = true, heightDp = 40) {
            it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            runFastLanSubnetScan(autoConnect = !connected || activeWsUrl.startsWith("ws://127.0.0.1"))
        }
        topBar.addView(btnScan, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(this, 40)))
        topBarView = topBar
        mainCol.addView(topBar)
        mainCol.addView(hairline())

        // Content Frame
        val frame = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        tabPanels["map"] = buildMapTab()
        tabPanels["screen"] = buildScreenTab()
        tabPanels["remote"] = buildRemoteTab()
        tabPanels["transfer"] = buildTransferTab()
        tabPanels["network"] = buildNetworkTab()
        tabPanels.values.forEach {
            it.visibility = View.GONE
            frame.addView(it, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        mainCol.addView(frame)

        // ==================== PHONE BOTTOM NAVIGATION BAR ====================
        if (!isTabletMode) {
            val dock = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setBackgroundColor(C_SIDEBAR)
                setPadding(dp(this@MainActivity, 6), dp(this@MainActivity, 6), dp(this@MainActivity, 6), dp(this@MainActivity, 8))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this@MainActivity, 62))
            }
            for ((key, _, shortLabel) in tabs) {
                val cell = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
                    setOnClickListener {
                        it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                        switchTab(key)
                    }
                }
                val ind = View(this).apply {
                    tag = "ind"
                    background = roundedBg(Color.TRANSPARENT, 0, 3f, this@MainActivity)
                    layoutParams = LinearLayout.LayoutParams(dp(this@MainActivity, 26), dp(this@MainActivity, 3)).apply {
                        bottomMargin = dp(this@MainActivity, 6)
                    }
                }
                val lbl = TextView(this).apply {
                    tag = "lbl"
                    text = shortLabel
                    setTextColor(C_MUTED)
                    textSize = 12f
                    maxLines = 1
                    typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
                }
                cell.addView(ind)
                cell.addView(lbl)
                navItems[key] = cell
                dock.addView(cell)
            }
            bottomDockView = dock
            mainCol.addView(hairline())
            mainCol.addView(dock)
        }

        outer.addView(mainCol)
        return outer
    }

    private fun hairline(): View = View(this).apply {
        setBackgroundColor(C_BORDER)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this@MainActivity, 1))
    }

    private fun switchTab(key: String) {
        if (fullscreenScreen && key != "screen") setScreenFullscreen(false)
        tabPanels.forEach { (k, v) ->
            if (k == key) {
                if (v.visibility != View.VISIBLE) {
                    v.alpha = 0f
                    v.visibility = View.VISIBLE
                    v.animate().alpha(1f).setDuration(140L).start()
                }
            } else {
                v.visibility = View.GONE
            }
        }
        lblTopSection.text = tabTitles[key] ?: "Continuum"
        navItems.forEach { (k, v) ->
            val active = k == key
            if (isTabletMode && v is TextView) {
                v.setTextColor(if (active) C_TEXT else C_MUTED)
                v.typeface = Typeface.create(Typeface.SANS_SERIF, if (active) Typeface.BOLD else Typeface.NORMAL)
                v.background = if (active) roundedBg(C_CARD, C_CYAN, 10f, this) else null
            } else if (v is LinearLayout) {
                v.findViewWithTag<View>("ind")?.background = roundedBg(if (active) C_CYAN else Color.TRANSPARENT, 0, 3f, this)
                v.findViewWithTag<TextView>("lbl")?.setTextColor(if (active) C_CYAN else C_MUTED)
            }
        }
    }

    private fun makeBtn(label: String, primary: Boolean = false, heightDp: Int = 44, onClick: (View) -> Unit): Button {
        return Button(this).apply {
            text = label
            isAllCaps = false
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setTextColor(if (primary) Color.WHITE else C_TEXT)
            textSize = 13f
            typeface = Typeface.create(Typeface.SANS_SERIF, if (primary) Typeface.BOLD else Typeface.NORMAL)
            background = if (primary) primaryGradientBg(this@MainActivity, 10f) else roundedBg(C_CARD_SUBTLE, C_BORDER_STRONG, 10f, this@MainActivity)
            minWidth = 0
            minimumWidth = 0
            minHeight = dp(this@MainActivity, heightDp)
            minimumHeight = dp(this@MainActivity, heightDp)
            setPadding(dp(this@MainActivity, 14), dp(this@MainActivity, 8), dp(this@MainActivity, 14), dp(this@MainActivity, 8))
            setOnClickListener { onClick(it) }
        }
    }

    private fun makeInput(hintText: String, initial: String = ""): EditText {
        return EditText(this).apply {
            hint = hintText
            setText(initial)
            setTextColor(C_TEXT)
            setHintTextColor(C_DIM)
            textSize = 13.5f
            isSingleLine = true
            background = roundedBg(C_BG, C_BORDER_STRONG, 10f, this@MainActivity)
            setPadding(dp(this@MainActivity, 14), dp(this@MainActivity, 10), dp(this@MainActivity, 14), dp(this@MainActivity, 10))
        }
    }

    private fun makeCard(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = roundedBg(C_CARD, C_BORDER, 14f, this@MainActivity)
        setPadding(dp(this@MainActivity, 16), dp(this@MainActivity, 16), dp(this@MainActivity, 16), dp(this@MainActivity, 16))
    }

    // ==================== TAB 1: MAPA ESPACIAL ====================
    private fun buildMapTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(this@MainActivity, 16), dp(this@MainActivity, 14), dp(this@MainActivity, 16), dp(this@MainActivity, 14))
        }
        spatialMap = HolographicSpatialMapView(this).apply {
            selfId = deviceId
            background = roundedBg(C_BG, C_BORDER, 16f, this@MainActivity)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            onSelect = { dev ->
                selectedDeviceId = dev.id
                updateSelectedSummary()
            }
            onMoved = { id, x, y ->
                sendJson(JSONObject().put("type", "device:move").put("deviceId", id).put("x", x.toDouble()).put("y", y.toDouble()))
            }
        }
        box.addView(spatialMap)

        val selCard = makeCard().apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(this@MainActivity, 12)
            }
        }
        lblMapSelected = TextView(this).apply {
            text = "Arraste os dispositivos no mapa para posicionar monitores e selecione o PC alvo."
            setTextColor(C_MUTED)
            textSize = 12.5f
        }
        selCard.addView(lblMapSelected)

        val actRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(this@MainActivity, 12)
            }
        }
        val bScreen = makeBtn("Segunda Tela", true) {
            switchTab("screen")
            requestPcScreenExtension()
        }
        val bCtrl = makeBtn("Mouse & Teclado") { switchTab("remote") }
        val bFile = makeBtn("Enviar Arquivo") { filePicker.launch(arrayOf("*/*")) }
        listOf(bScreen, bCtrl, bFile).forEachIndexed { idx, b ->
            actRow.addView(b, LinearLayout.LayoutParams(0, dp(this, 44), 1f).apply {
                if (idx > 0) leftMargin = dp(this@MainActivity, 8)
            })
        }
        selCard.addView(actRow)
        box.addView(selCard)
        return box
    }

    // ==================== TAB 2: SEGUNDA TELA / EXTENSÃO DE MONITOR ====================
    private fun buildScreenTab(): View {
        val root = FrameLayout(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(this@MainActivity, 12), dp(this@MainActivity, 10), dp(this@MainActivity, 12), dp(this@MainActivity, 10))
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = roundedBg(C_CARD, C_BORDER, 12f, this@MainActivity)
            setPadding(dp(this@MainActivity, 14), dp(this@MainActivity, 10), dp(this@MainActivity, 14), dp(this@MainActivity, 10))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(this@MainActivity, 10)
            }
        }
        lblScreenStatus = TextView(this).apply {
            text = "Aguardando transmissão de tela do PC..."
            setTextColor(C_TEXT)
            textSize = 13f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                rightMargin = dp(this@MainActivity, 10)
            }
        }
        val bReq = makeBtn("Pedir Tela", true, 40) { requestPcScreenExtension() }
        val bFull = makeBtn("Tela Cheia", false, 40) { setScreenFullscreen(true) }
        bar.addView(lblScreenStatus)
        bar.addView(bReq, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(this, 40)))
        bar.addView(bFull, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(this, 40)).apply {
            leftMargin = dp(this@MainActivity, 8)
        })
        screenControlsBar = bar
        col.addView(bar)

        liveScreenView = LiveScreenView(
            this,
            onAbsMove = { nx, ny -> sendRemote(JSONObject().put("kind", "abs_move").put("nx", nx.toDouble()).put("ny", ny.toDouble())) },
            onAbsClick = { nx, ny, btn -> sendRemote(JSONObject().put("kind", "abs_click").put("nx", nx.toDouble()).put("ny", ny.toDouble()).put("button", btn)) },
            onScroll = { dy -> sendRemote(JSONObject().put("kind", "scroll").put("dx", 0).put("dy", dy.toDouble())) }
        ).apply {
            background = roundedBg(Color.parseColor("#04070E"), C_BORDER, 14f, this@MainActivity)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        col.addView(liveScreenView)
        root.addView(col)

        // Subtle floating Exit Fullscreen button (only visible in fullscreen mode)
        btnExitFullscreen = makeBtn("Sair Tela Cheia", false, 38) { setScreenFullscreen(false) }.apply {
            alpha = 0.78f
            visibility = View.GONE
        }
        root.addView(btnExitFullscreen, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(this, 38)).apply {
            gravity = Gravity.TOP or Gravity.END
            topMargin = dp(this@MainActivity, 12)
            rightMargin = dp(this@MainActivity, 12)
        })
        return root
    }

    private fun setScreenFullscreen(enabled: Boolean) {
        fullscreenScreen = enabled
        sidebarView?.visibility = if (enabled) View.GONE else View.VISIBLE
        bottomDockView?.visibility = if (enabled) View.GONE else View.VISIBLE
        topBarView.visibility = if (enabled) View.GONE else View.VISIBLE
        screenControlsBar.visibility = if (enabled) View.GONE else View.VISIBLE
        btnExitFullscreen.visibility = if (enabled) View.VISIBLE else View.GONE
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = if (enabled) {
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        } else {
            View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    private fun requestPcScreenExtension() {
        val tgt = getTargetDevice()
        if (tgt == null || tgt.id == deviceId) {
            toast("Conecte-se primeiro a um computador Linux ou Windows.")
            return
        }
        sendJson(JSONObject()
            .put("type", "screen:request")
            .put("sourceDeviceId", deviceId)
            .put("sourceDeviceName", deviceName)
            .put("targetDeviceId", tgt.id))
        lblScreenStatus.text = "Solicitando extensão de tela para ${tgt.name}..."
        toast("Solicitação de extensão enviada para ${tgt.name}!")
    }

    // ==================== TAB 3: MOUSE, TRACKPAD & TECLADO ====================
    private fun buildRemoteTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(this@MainActivity, 16), dp(this@MainActivity, 12), dp(this@MainActivity, 16), dp(this@MainActivity, 12))
        }
        lblRemoteTarget = TextView(this).apply {
            text = "Alvo: aguardando PC na rede local"
            setTextColor(C_CYAN)
            textSize = 13.5f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            setPadding(0, 0, 0, dp(this@MainActivity, 8))
        }
        box.addView(lblRemoteTarget)

        val pad = HolographicTrackpadView(
            this,
            onMove = { dx, dy -> sendRemote(JSONObject().put("kind", "move").put("dx", dx.toDouble()).put("dy", dy.toDouble())) },
            onClick = { btn -> sendRemote(JSONObject().put("kind", "click").put("button", btn)) },
            onScroll = { dy -> sendRemote(JSONObject().put("kind", "scroll").put("dx", 0).put("dy", dy.toDouble())) }
        ).apply {
            background = roundedBg(C_BG, C_BORDER, 16f, this@MainActivity)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        box.addView(pad)

        // Row 1: Mouse Buttons (Spacious 3-button row — NEVER squeezed!)
        val mouseRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(this@MainActivity, 10)
            }
        }
        val mouseBtns = listOf(
            "Clique Esq." to { sendRemote(JSONObject().put("kind", "click").put("button", "left")) },
            "Clique Meio" to { sendRemote(JSONObject().put("kind", "click").put("button", "middle")) },
            "Clique Dir." to { sendRemote(JSONObject().put("kind", "click").put("button", "right")) }
        )
        mouseBtns.forEachIndexed { idx, (lbl, fn) ->
            mouseRow.addView(makeBtn(lbl, false, 44) { fn() }, LinearLayout.LayoutParams(0, dp(this, 44), 1f).apply {
                if (idx > 0) leftMargin = dp(this@MainActivity, 8)
            })
        }
        box.addView(mouseRow)

        // Row 2: Live Keyboard Input
        val kbRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(this@MainActivity, 10)
            }
        }
        val txtInput = makeInput("Digitar texto no computador...")
        val btnSend = makeBtn("Enviar", true, 44) {
            val t = txtInput.text.toString()
            if (t.isNotEmpty()) {
                sendRemote(JSONObject().put("kind", "text").put("text", t))
                txtInput.setText("")
            }
        }
        val btnEnter = makeBtn("Enter", false, 44) { sendRemote(JSONObject().put("kind", "key").put("key", "Enter")) }
        kbRow.addView(txtInput, LinearLayout.LayoutParams(0, dp(this, 44), 1f))
        kbRow.addView(btnSend, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(this, 44)).apply { leftMargin = dp(this@MainActivity, 8) })
        kbRow.addView(btnEnter, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(this, 44)).apply { leftMargin = dp(this@MainActivity, 8) })
        box.addView(kbRow)

        // Row 3: Keyboard Shortcuts + Media (4 clean buttons, spaced evenly)
        val shortcutRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(this@MainActivity, 10)
            }
        }
        val shortcuts = listOf(
            "Vol −" to { sendRemote(JSONObject().put("kind", "media").put("action", "vol_down")) },
            "Vol +" to { sendRemote(JSONObject().put("kind", "media").put("action", "vol_up")) },
            "Play/Pause" to { sendRemote(JSONObject().put("kind", "media").put("action", "play_pause")) },
            "Alt+Tab" to { sendRemote(JSONObject().put("kind", "key").put("key", "Alt+Tab")) }
        )
        shortcuts.forEachIndexed { idx, (lbl, fn) ->
            shortcutRow.addView(makeBtn(lbl, false, 42) { fn() }, LinearLayout.LayoutParams(0, dp(this, 42), 1f).apply {
                if (idx > 0) leftMargin = dp(this@MainActivity, 8)
            })
        }
        box.addView(shortcutRow)
        return box
    }

    // ==================== TAB 4: CLIPBOARD AUTOMÁTICO & ARQUIVOS ====================
    private fun buildTransferTab(): View {
        val scroll = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(this@MainActivity, 16), dp(this@MainActivity, 14), dp(this@MainActivity, 16), dp(this@MainActivity, 20))
        }

        // Card 1: Universal Auto-Sync Clipboard
        val cCard = makeCard()
        val cHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val cTitleCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        cTitleCol.addView(TextView(this).apply { text = "Área de Transferência Universal"; setTextColor(C_TEXT); textSize = 15.5f; typeface = Typeface.DEFAULT_BOLD })
        cTitleCol.addView(TextView(this).apply { text = "Sincroniza automaticamente tudo o que você copia entre PC e Tablet."; setTextColor(C_MUTED); textSize = 12f })
        val swAutoClip = Switch(this).apply {
            isChecked = autoClipboardSync
            text = "Auto"
            setTextColor(C_CYAN)
            setOnCheckedChangeListener { _, checked ->
                autoClipboardSync = checked
                prefs.edit().putBoolean("autoClipboardSync", checked).apply()
                toast(if (checked) "Sincronização automática de clipboard ativada!" else "Sincronização automática pausada.")
            }
        }
        cHeader.addView(cTitleCol)
        cHeader.addView(swAutoClip)
        cCard.addView(cHeader)

        val editClip = makeInput("Cole ou digite um texto para enviar à malha...")
        cCard.addView(editClip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this, 46)).apply {
            topMargin = dp(this@MainActivity, 12)
        })

        val cBtns = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(this@MainActivity, 10)
            }
        }
        val bPush = makeBtn("Enviar Texto", true, 44) {
            val t = editClip.text.toString().trim()
            if (t.isNotEmpty()) { pushClipboard(t); editClip.setText("") }
        }
        val bGrab = makeBtn("Enviar Meu Clipboard", false, 44) {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = cm.primaryClip
            val txt = if (clip != null && clip.itemCount > 0) clip.getItemAt(0)?.coerceToText(this)?.toString() else null
            if (!txt.isNullOrBlank()) pushClipboard(txt) else toast("Clipboard vazio.")
        }
        cBtns.addView(bPush, LinearLayout.LayoutParams(0, dp(this, 44), 1f))
        cBtns.addView(bGrab, LinearLayout.LayoutParams(0, dp(this, 44), 1f).apply { leftMargin = dp(this@MainActivity, 10) })
        cCard.addView(cBtns)

        clipListContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(this@MainActivity, 12), 0, 0) }
        cCard.addView(clipListContainer)
        col.addView(cCard)

        // Card 2: Direct LAN File Transfer
        val fCard = makeCard().apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(this@MainActivity, 14)
            }
        }
        fCard.addView(TextView(this).apply { text = "Transferência Direta de Arquivos"; setTextColor(C_TEXT); textSize = 15.5f; typeface = Typeface.DEFAULT_BOLD })
        fCard.addView(makeBtn("Escolher e Enviar Arquivo via Wi-Fi", true, 46) { filePicker.launch(arrayOf("*/*")) }.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this@MainActivity, 46)).apply { topMargin = dp(this@MainActivity, 12) }
        })
        lblFileStatus = TextView(this).apply {
            text = "Pronto para envio direto na rede local"
            setTextColor(C_MUTED)
            textSize = 12.5f
            setPadding(0, dp(this@MainActivity, 10), 0, dp(this@MainActivity, 6))
        }
        fCard.addView(lblFileStatus)
        fileProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this@MainActivity, 10))
        }
        fCard.addView(fileProgress)
        fileListContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        fCard.addView(fileListContainer)
        col.addView(fCard)

        scroll.addView(col)
        return scroll
    }

    // ==================== TAB 5: REDE LAN & SISTEMA ====================
    private fun buildNetworkTab(): View {
        val scroll = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(this@MainActivity, 16), dp(this@MainActivity, 14), dp(this@MainActivity, 16), dp(this@MainActivity, 20))
        }

        val myIp = getLocalLanIp()
        val lanCard = makeCard()
        lanCard.addView(TextView(this).apply { text = "Dispositivos na Rede Wi-Fi"; setTextColor(C_TEXT); textSize = 15.5f; typeface = Typeface.DEFAULT_BOLD })
        lblScanBanner = TextView(this).apply {
            text = "Este dispositivo: $myIp:$LAN_WS_PORT · Hub LAN ativo"
            setTextColor(C_CYAN)
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setPadding(0, dp(this@MainActivity, 4), 0, dp(this@MainActivity, 12))
        }
        lanCard.addView(lblScanBanner)

        lanCard.addView(makeBtn("Escanear Dispositivos no Wi-Fi", true, 46) {
            runFastLanSubnetScan(autoConnect = !connected || activeWsUrl.startsWith("ws://127.0.0.1"))
        }.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this@MainActivity, 46)).apply { bottomMargin = dp(this@MainActivity, 12) }
        })

        lanPeersContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        lanCard.addView(lanPeersContainer)

        lanCard.addView(TextView(this).apply {
            text = "Conexão Manual (aceita IP, .final, http:// ou ws://)"
            setTextColor(C_MUTED)
            textSize = 12.5f
            setPadding(0, dp(this@MainActivity, 14), 0, dp(this@MainActivity, 8))
        })

        editRoom = makeInput("Código da Malha (ex: MESH01)", roomCode).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        lanCard.addView(editRoom, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this, 46)))

        val ipPrefixHint = myIp.split('.').takeIf { it.size == 4 && !myIp.startsWith("127.") }?.let { "ex: ${it[0]}.${it[1]}.${it[2]}.42 ou .42" } ?: "ex: 192.168.1.42:45891"
        editManualIp = makeInput(ipPrefixHint, manualHostPort)
        lanCard.addView(editManualIp, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this, 46)).apply { topMargin = dp(this@MainActivity, 10) })

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(this@MainActivity, 10) }
        }
        val bConn = makeBtn("Conectar Direto", true, 46) {
            roomCode = editRoom.text.toString().uppercase().replace(Regex("[^A-Z0-9]"), "").take(12).ifEmpty { BuildConfig.DEFAULT_ROOM_CODE }
            lblSidebarRoom.text = "Malha: $roomCode"
            val raw = editManualIp.text.toString().trim()
            if (raw.isNotEmpty()) connectDirectInput(raw) else runFastLanSubnetScan(autoConnect = true)
        }
        val bAuto = makeBtn("Modo Automático", false, 46) {
            manualHostPort = ""
            editManualIp.setText("")
            prefs.edit().putString("manualHostPort", "").apply()
            connectToEndpoint("ws://127.0.0.1:$LAN_WS_PORT/ws", "Hub Local (${getLocalLanIp()})", force = true)
            runFastLanSubnetScan(autoConnect = true)
        }
        btnRow.addView(bConn, LinearLayout.LayoutParams(0, dp(this, 46), 1f))
        btnRow.addView(bAuto, LinearLayout.LayoutParams(0, dp(this, 46), 1f).apply { leftMargin = dp(this@MainActivity, 10) })
        lanCard.addView(btnRow)
        col.addView(lanCard)

        // Live Telemetry Card
        val telCard = makeCard().apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(this@MainActivity, 14)
            }
        }
        telCard.addView(TextView(this).apply { text = "Telemetria dos Dispositivos Conectados"; setTextColor(C_TEXT); textSize = 15.5f; typeface = Typeface.DEFAULT_BOLD })
        telemetryContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(this@MainActivity, 10), 0, 0) }
        telCard.addView(telemetryContainer)
        col.addView(telCard)

        // Alerts Card
        val aCard = makeCard().apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(this@MainActivity, 14)
            }
        }
        aCard.addView(TextView(this).apply { text = "Alertas da Malha"; setTextColor(C_TEXT); textSize = 15.5f; typeface = Typeface.DEFAULT_BOLD })
        aCard.addView(makeBtn("Enviar Alerta de Teste", false, 44) {
            sendJson(JSONObject()
                .put("type", "notification:push")
                .put("title", "Alerta de $deviceName")
                .put("body", "Conectado diretamente na rede local.")
                .put("sourceDeviceId", deviceId)
                .put("sourceDeviceName", deviceName))
        }.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(this@MainActivity, 44)).apply { topMargin = dp(this@MainActivity, 10) }
        })
        notifListContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(this@MainActivity, 10), 0, 0) }
        aCard.addView(notifListContainer)
        col.addView(aCard)

        scroll.addView(col)
        refreshLanPeersUi()
        return scroll
    }

    // ==================== AUTO-SYNC OS CLIPBOARD ====================
    private fun setupAutoClipboardListener() {
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val listener = ClipboardManager.OnPrimaryClipChangedListener {
                if (!autoClipboardSync || !connected) return@OnPrimaryClipChangedListener
                val clip = cm.primaryClip
                if (clip != null && clip.itemCount > 0) {
                    val txt = clip.getItemAt(0)?.coerceToText(this)?.toString()?.trim() ?: ""
                    if (txt.isNotEmpty() && txt != lastSyncedClip) {
                        lastSyncedClip = txt
                        sendJson(JSONObject()
                            .put("type", "clipboard:push")
                            .put("content", txt)
                            .put("sourceDeviceId", deviceId)
                            .put("sourceDeviceName", deviceName)
                            .put("auto", true))
                    }
                }
            }
            cm.addPrimaryClipChangedListener(listener)
            clipListener = listener
        } catch (_: Exception) { }
    }

    // ==================== 3-LAYER DISCOVERY (ZERO RECONNECT LOOPS!) ====================
    private fun startUdpDiscoveryAndResponder() {
        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            multicastLock = wm?.createMulticastLock("continuum_lan_v5")?.apply {
                setReferenceCounted(true)
                acquire()
            }
        } catch (_: Exception) { }

        Thread {
            try {
                val sock = DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(InetSocketAddress(LAN_UDP_PORT))
                    soTimeout = 1200
                }
                discoverySocket = sock

                Thread {
                    while (!destroyed) {
                        try {
                            val myIp = getLocalLanIp()
                            val subnetBcast = myIp.split('.').takeIf { it.size == 4 && !myIp.startsWith("127.") }?.let { "${it[0]}.${it[1]}.${it[2]}.255" }
                            val probe = JSONObject()
                                .put("proto", PROTO_V5)
                                .put("type", "probe")
                                .put("roomCode", roomCode)
                                .put("hubId", deviceId)
                                .put("hubName", deviceName)
                                .put("os", "android")
                                .put("ip", myIp)
                                .put("wsPort", LAN_WS_PORT)
                                .put("startedAt", localHub.startedAt)
                                .put("peers", localHub.peerCount(roomCode))
                                .put("remotePeers", localHub.remotePeerCount())
                                .put("needsReverseConnect", needsReverseConnect)
                                .toString()
                                .toByteArray(Charsets.UTF_8)
                            sock.send(DatagramPacket(probe, probe.size, InetAddress.getByName("255.255.255.255"), LAN_UDP_PORT))
                            if (subnetBcast != null) sock.send(DatagramPacket(probe, probe.size, InetAddress.getByName(subnetBcast), LAN_UDP_PORT))
                            sock.send(DatagramPacket(probe, probe.size, InetAddress.getByName(MULTICAST_ADDR), LAN_UDP_PORT))
                        } catch (_: Exception) { }
                        Thread.sleep(2600)
                    }
                }.apply { isDaemon = true; start() }

                val buf = ByteArray(4096)
                while (!destroyed) {
                    try {
                        val packet = DatagramPacket(buf, buf.size)
                        sock.receive(packet)
                        val str = String(packet.data, 0, packet.length, Charsets.UTF_8)
                        val json = JSONObject(str)
                        val proto = json.optString("proto")
                        if (proto != PROTO_V5 && proto != PROTO_V4 && proto != PROTO_V3) continue
                        val hubId = json.optString("hubId")
                        if (hubId.isBlank() || hubId == deviceId) continue

                        if (json.optString("type") == "probe" && localHub.active) {
                            val reply = JSONObject()
                                .put("proto", PROTO_V5)
                                .put("type", "beacon")
                                .put("roomCode", roomCode)
                                .put("hubId", deviceId)
                                .put("hubName", deviceName)
                                .put("os", "android")
                                .put("ip", getLocalLanIp())
                                .put("wsPort", LAN_WS_PORT)
                                .put("startedAt", localHub.startedAt)
                                .put("peers", localHub.peerCount(roomCode))
                                .put("remotePeers", localHub.remotePeerCount())
                                .put("needsReverseConnect", needsReverseConnect)
                                .toString()
                                .toByteArray(Charsets.UTF_8)
                            try { sock.send(DatagramPacket(reply, reply.size, packet.address, packet.port)) } catch (_: Exception) { }
                        }

                        val senderIp = packet.address.hostAddress ?: json.optString("ip")
                        val ip = if (!senderIp.startsWith("127.")) senderIp else json.optString("ip", senderIp)
                        registerDiscoveredHub(
                            DiscoveredLanHub(
                                hubId = hubId,
                                hubName = json.optString("hubName", "PC"),
                                os = json.optString("os", "desktop"),
                                ip = ip,
                                wsPort = json.optInt("wsPort", LAN_WS_PORT),
                                roomCode = json.optString("roomCode", roomCode),
                                via = "UDP Auto",
                                remotePeers = json.optInt("remotePeers", 0),
                                lastSeenMs = System.currentTimeMillis()
                            ),
                            allowAutoConnect = true
                        )
                    } catch (_: Exception) { }
                }
            } catch (_: Exception) { }
        }.apply { isDaemon = true; start() }
    }

    private fun runFastLanSubnetScan(autoConnect: Boolean) {
        if (scanningLan) return
        val myIp = getLocalLanIp()
        val parts = myIp.split('.')
        if (parts.size != 4 || myIp.startsWith("127.")) {
            mainHandler.post { toast("Conecte-se ao Wi-Fi local para escanear PCs.") }
            return
        }
        val prefix = "${parts[0]}.${parts[1]}.${parts[2]}"
        scanningLan = true
        mainHandler.post {
            spatialMap.scanning = true
            spatialMap.scanProgress = 0
            lblScanBanner.text = "Escaneando $prefix.1..254 na porta $LAN_WS_PORT..."
        }

        Thread {
            val pool = Executors.newFixedThreadPool(32)
            val done = AtomicInteger(0)
            for (hostNum in 1..254) {
                val targetIp = "$prefix.$hostNum"
                if (targetIp == myIp) { done.incrementAndGet(); continue }
                pool.execute {
                    try {
                        val info = probeContinuumHttpInfo(targetIp, LAN_WS_PORT, 260)
                        if (info != null) {
                            val hub = DiscoveredLanHub(
                                hubId = info.optString("hubId", "lan-$targetIp"),
                                hubName = info.optString("hubName", info.optString("hub", targetIp)),
                                os = info.optString("os", "desktop"),
                                ip = targetIp,
                                wsPort = info.optInt("wsPort", LAN_WS_PORT),
                                roomCode = info.optString("roomCode", roomCode),
                                via = "TCP Radar",
                                remotePeers = info.optInt("remotePeers", 0),
                                lastSeenMs = System.currentTimeMillis()
                            )
                            registerDiscoveredHub(hub, allowAutoConnect = autoConnect)
                        }
                    } catch (_: Exception) {
                    } finally {
                        val c = done.incrementAndGet()
                        if (c % 20 == 0 || c == 254) {
                            val pct = (c * 100) / 254
                            mainHandler.post { spatialMap.scanProgress = pct }
                        }
                    }
                }
            }
            pool.shutdown()
            try { pool.awaitTermination(8, TimeUnit.SECONDS) } catch (_: Exception) { }
            scanningLan = false
            mainHandler.post {
                spatialMap.scanning = false
                lblScanBanner.text = "Este dispositivo: $myIp:$LAN_WS_PORT · ${discoveredHubs.size} peer(s) detectado(s)"
                refreshLanPeersUi()
            }
        }.apply { isDaemon = true; start() }
    }

    private fun probeContinuumHttpInfo(host: String, port: Int, timeoutMs: Int): JSONObject? {
        var sock: Socket? = null
        return try {
            sock = Socket()
            sock.connect(InetSocketAddress(host, port), timeoutMs)
            sock.soTimeout = timeoutMs + 250
            val req = "GET /continuum-info HTTP/1.1\r\nHost: $host:$port\r\nConnection: close\r\n\r\n"
            sock.getOutputStream().write(req.toByteArray(Charsets.US_ASCII))
            sock.getOutputStream().flush()
            val resp = sock.getInputStream().bufferedReader().readText()
            val bodyIdx = resp.indexOf("\r\n\r\n")
            if (bodyIdx < 0) return null
            val json = JSONObject(resp.substring(bodyIdx + 4).trim())
            if (json.optBoolean("ok", false)) json else null
        } catch (_: Exception) {
            null
        } finally {
            try { sock?.close() } catch (_: Exception) { }
        }
    }

    private fun registerDiscoveredHub(hub: DiscoveredLanHub, allowAutoConnect: Boolean) {
        if (hub.hubId == deviceId) return
        discoveredHubs[hub.hubId] = hub
        mainHandler.post { refreshLanPeersUi() }

        // RULE: NEVER abandon a working mesh! If localHub already has a PC connected OR we already have >1 device, STAY PUT!
        if (!allowAutoConnect || manualHostPort.isNotBlank()) return
        if (localHub.hasRemotePeers() || (connected && devices.size > 1)) return

        // Deterministic tie-breaker between two Android devices: lower hubId hosts
        if (hub.os.equals("android", ignoreCase = true) && hub.remotePeers == 0 && hub.hubId > deviceId) return

        val onSelfOnly = activeWsUrl.startsWith("ws://127.0.0.1")
        if (!connected || onSelfOnly) {
            // Pre-probe via TCP BEFORE switching so we NEVER jump into a firewalled PC!
            Thread {
                val reachable = probeContinuumHttpInfo(hub.ip, hub.wsPort, 700)
                if (reachable != null) {
                    needsReverseConnect = false
                    mainHandler.post {
                        if (localHub.hasRemotePeers() || (connected && devices.size > 1)) return@post
                        val rRoom = reachable.optString("roomCode", hub.roomCode)
                        if (rRoom.isNotBlank()) {
                            roomCode = rRoom
                            lblSidebarRoom.text = "Malha: $roomCode"
                            editRoom.setText(roomCode)
                        }
                        connectToEndpoint("ws://${hub.ip}:${hub.wsPort}/ws", "${hub.hubName} (${hub.ip})", force = false)
                    }
                } else if (!hub.os.equals("android", ignoreCase = true)) {
                    // PC firewall blocked port 45891 -> signal Desktop to reverse-connect to Android's Hub!
                    needsReverseConnect = true
                }
            }.apply { isDaemon = true; start() }
        }
    }

    private fun connectDirectInput(rawInput: String) {
        val parsed = parseLanEndpoint(rawInput, getLocalLanIp())
        if (parsed == null) {
            toast("Endereço inválido. Use ex: 192.168.1.42 ou .42")
            return
        }
        val (host, port) = parsed
        val normalizedDisplay = "$host:$port"
        manualHostPort = normalizedDisplay
        editManualIp.setText(normalizedDisplay)
        prefs.edit().putString("roomCode", roomCode).putString("manualHostPort", normalizedDisplay).apply()

        lblTopStatus.text = "Verificando $normalizedDisplay..."
        lblTopStatus.setTextColor(C_CYAN)

        Thread {
            val info = probeContinuumHttpInfo(host, port, 1500)
            mainHandler.post {
                if (info != null) {
                    val remoteName = info.optString("hubName", info.optString("hub", host))
                    val remoteRoom = info.optString("roomCode", "")
                    if (remoteRoom.isNotBlank()) {
                        roomCode = remoteRoom
                        lblSidebarRoom.text = "Malha: $roomCode"
                        editRoom.setText(roomCode)
                    }
                    connectToEndpoint("ws://$host:$port/ws", "$remoteName ($host)", force = true)
                } else {
                    toast("PC não respondeu na porta $port (verifique o firewall). Mantendo Hub local ativo para o PC conectar aqui!")
                    manualHostPort = ""
                    connectToEndpoint("ws://127.0.0.1:$LAN_WS_PORT/ws", "Hub Local (${getLocalLanIp()})", force = true)
                }
            }
        }.apply { isDaemon = true; start() }
    }

    private fun refreshLanPeersUi() {
        val now = System.currentTimeMillis()
        discoveredHubs.entries.removeIf { now - it.value.lastSeenMs > 28000L }
        lanPeersContainer.removeAllViews()
        val list = discoveredHubs.values.sortedBy { it.hubName }
        if (list.isEmpty()) {
            lanPeersContainer.addView(TextView(this).apply {
                text = "Nenhum computador encontrado ainda. Abra o Continuum no Linux ou Windows na mesma rede Wi-Fi."
                setTextColor(C_MUTED)
                textSize = 12.5f
                setPadding(0, dp(this@MainActivity, 4), 0, dp(this@MainActivity, 4))
            })
            return
        }
        for (h in list) {
            val isAlreadyJoined = devices.any { it.lanIp == h.ip || it.id == h.hubId } || activeWsUrl == "ws://${h.ip}:${h.wsPort}/ws"
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                background = roundedBg(C_CARD_SUBTLE, if (isAlreadyJoined) C_GREEN else C_BORDER, 12f, this@MainActivity)
                setPadding(dp(this@MainActivity, 14), dp(this@MainActivity, 12), dp(this@MainActivity, 14), dp(this@MainActivity, 12))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    bottomMargin = dp(this@MainActivity, 8)
                }
            }
            val info = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    rightMargin = dp(this@MainActivity, 10)
                }
            }
            info.addView(TextView(this).apply { text = "${h.hubName} (${h.os.uppercase()})"; setTextColor(C_TEXT); textSize = 14f; typeface = Typeface.DEFAULT_BOLD })
            info.addView(TextView(this).apply { text = "${h.ip}:${h.wsPort} · ${h.via} · ${h.roomCode}"; setTextColor(C_CYAN); textSize = 11.5f; typeface = Typeface.MONOSPACE })
            row.addView(info)

            if (isAlreadyJoined && connected) {
                row.addView(TextView(this).apply {
                    text = "Conectado"
                    setTextColor(C_GREEN)
                    textSize = 12.5f
                    typeface = Typeface.DEFAULT_BOLD
                    setPadding(dp(this@MainActivity, 10), dp(this@MainActivity, 6), dp(this@MainActivity, 6), dp(this@MainActivity, 6))
                })
            } else {
                row.addView(makeBtn("Conectar", true, 40) {
                    connectDirectInput("${h.ip}:${h.wsPort}")
                })
            }
            lanPeersContainer.addView(row)
        }
    }

    // ==================== STABLE WEBSOCKET CLIENT (ZERO RECONNECT LOOPS!) ====================
    private fun connectToEndpoint(url: String, label: String, force: Boolean = false) {
        if (destroyed) return
        if (!force && connected && activeWsUrl == url) return

        val myGen = connGen.incrementAndGet()
        val prevWs = ws
        ws = null
        try { prevWs?.close(1000, "switch") } catch (_: Exception) { }

        val switchedEndpoint = activeWsUrl != url
        activeWsUrl = url
        activeHubLabel = label
        connected = false
        consecutiveFailures = 0

        mainHandler.post {
            if (switchedEndpoint) {
                devices.clear()
                syncMapUi()
            }
            lblTopStatus.text = "Conectando a $label..."
            lblTopStatus.setTextColor(C_CYAN)
        }

        val req = try {
            Request.Builder().url(url).build()
        } catch (_: Exception) {
            mainHandler.post {
                lblTopStatus.text = "Endereço inválido"
                lblTopStatus.setTextColor(C_AMBER)
            }
            return
        }

        val newWs = httpClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (myGen != connGen.get()) {
                    try { webSocket.close(1000, "stale") } catch (_: Exception) { }
                    return
                }
                connected = true
                consecutiveFailures = 0
                mainHandler.post {
                    lblTopStatus.text = "Conectado · $label"
                    lblTopStatus.setTextColor(C_GREEN)
                    refreshLanPeersUi()
                }
                val join = JSONObject()
                    .put("type", "mesh:join")
                    .put("roomCode", roomCode)
                    .put("device", JSONObject()
                        .put("id", deviceId)
                        .put("name", deviceName)
                        .put("os", "android")
                        .put("kind", if (isTabletMode) "tablet" else "mobile")
                        .put("status", "online")
                        .put("companionConnected", true)
                        .put("telemetry", collectTelemetry()))
                webSocket.send(join.toString())
                webSocket.send(JSONObject().put("type", "telemetry:ping").put("sentAt", System.currentTimeMillis()).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (myGen != connGen.get()) return
                try { handleMessage(JSONObject(text)) } catch (_: Exception) { }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (myGen != connGen.get() || destroyed) return
                connected = false
                consecutiveFailures++
                val isSelf = url.startsWith("ws://127.0.0.1")
                if (!isSelf && consecutiveFailures >= 2) {
                    // Firewall / unreachable PC -> stop looping and fall back cleanly to local Android Hub!
                    manualHostPort = ""
                    mainHandler.post {
                        lblTopStatus.text = "PC inacessível · Hub Local ativo (${getLocalLanIp()}:$LAN_WS_PORT)"
                        lblTopStatus.setTextColor(C_AMBER)
                        connectToEndpoint("ws://127.0.0.1:$LAN_WS_PORT/ws", "Hub Local (${getLocalLanIp()})", force = true)
                    }
                    return
                }
                mainHandler.post {
                    lblTopStatus.text = "Reconectando a $label..."
                    lblTopStatus.setTextColor(C_AMBER)
                }
                mainHandler.postDelayed({
                    if (!destroyed && myGen == connGen.get() && !connected) {
                        connectToEndpoint(url, label, force = true)
                    }
                }, 3000)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (myGen != connGen.get()) return
                connected = false
            }
        })
        ws = newWs
    }

    private fun startTelemetryHeartbeat() {
        val r = object : Runnable {
            override fun run() {
                if (destroyed) return
                if (connected) {
                    sendJson(JSONObject().put("type", "device:telemetry").put("telemetry", collectTelemetry()))
                    sendJson(JSONObject().put("type", "telemetry:ping").put("sentAt", System.currentTimeMillis()))
                }
                mainHandler.postDelayed(this, 3000)
            }
        }
        mainHandler.postDelayed(r, 3000)
    }

    private fun collectTelemetry(): JSONObject {
        val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val pct = if (level >= 0 && scale > 0) (level * 100) / scale else 100
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        return JSONObject()
            .put("cpuUsage", 10)
            .put("memoryUsagePercent", 32)
            .put("batteryLevel", pct)
            .put("isCharging", charging)
            .put("networkType", "Wi-Fi LAN")
            .put("lanIp", getLocalLanIp())
    }

    private fun sendJson(obj: JSONObject) {
        if (connected) ws?.send(obj.toString())
    }

    private fun getTargetDevice(): MeshDevice? {
        return devices.firstOrNull { it.id == selectedDeviceId && it.id != deviceId }
            ?: devices.firstOrNull { it.id != deviceId }
            ?: devices.firstOrNull()
    }

    private fun sendRemote(ev: JSONObject) {
        val tgt = getTargetDevice() ?: return
        sendJson(JSONObject().put("type", "input:event").put("targetDeviceId", tgt.id).put("event", ev))
    }

    private fun pushClipboard(text: String) {
        lastSyncedClip = text
        sendJson(JSONObject()
            .put("type", "clipboard:push")
            .put("content", text)
            .put("sourceDeviceId", deviceId)
            .put("sourceDeviceName", deviceName))
        toast("Texto sincronizado com todos os dispositivos.")
    }

    private fun sendFileFromUri(uri: Uri) {
        Thread {
            try {
                var fileName = "arquivo.bin"
                contentResolver.query(uri, null, null, null, null)?.use { c ->
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (c.moveToFirst() && idx >= 0) fileName = c.getString(idx)
                }
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@Thread
                val tid = "ft-${System.currentTimeMillis()}"
                val chunkSize = 48 * 1024
                val total = max(1, (bytes.size + chunkSize - 1) / chunkSize)
                val tgt = getTargetDevice()
                val targetId = if (tgt != null && tgt.id != deviceId) tgt.id else null

                val startObj = JSONObject()
                    .put("type", "file:start")
                    .put("transferId", tid)
                    .put("fileName", fileName)
                    .put("fileSize", bytes.size)
                    .put("totalChunks", total)
                    .put("sourceDeviceId", deviceId)
                    .put("sourceDeviceName", deviceName)
                if (targetId != null) startObj.put("targetDeviceId", targetId)
                sendJson(startObj)

                for (i in 0 until total) {
                    val start = i * chunkSize
                    val end = min(bytes.size, start + chunkSize)
                    val slice = bytes.copyOfRange(start, end)
                    val chObj = JSONObject()
                        .put("type", "file:chunk")
                        .put("transferId", tid)
                        .put("chunkIndex", i)
                        .put("data", Base64.encodeToString(slice, Base64.NO_WRAP))
                    if (targetId != null) chObj.put("targetDeviceId", targetId)
                    sendJson(chObj)
                    val pct = ((i + 1) * 100) / total
                    mainHandler.post { fileProgress.progress = pct; lblFileStatus.text = "Enviando $fileName · $pct%" }
                    Thread.sleep(4)
                }

                val doneObj = JSONObject().put("type", "file:complete").put("transferId", tid)
                if (targetId != null) doneObj.put("targetDeviceId", targetId)
                sendJson(doneObj)
                mainHandler.post {
                    fileProgress.progress = 100
                    lblFileStatus.text = "Enviado: $fileName"
                    addFileHistoryRow("Enviado: $fileName (${max(1, bytes.size / 1024)} KB)")
                }
            } catch (ex: Exception) {
                mainHandler.post { toast("Erro ao enviar arquivo: ${ex.message}") }
            }
        }.start()
    }

    private fun handleMessage(msg: JSONObject) {
        when (msg.optString("type")) {
            "mesh:init" -> {
                val initRoom = msg.optString("roomCode", "").trim()
                if (initRoom.isNotBlank() && initRoom != roomCode) {
                    roomCode = initRoom
                    mainHandler.post {
                        lblSidebarRoom.text = "Malha: $roomCode"
                        editRoom.setText(roomCode)
                    }
                }
                parseDevices(msg.optJSONArray("devices"))
                val clips = msg.optJSONArray("clipboard")
                if (clips != null) {
                    mainHandler.post {
                        clipItems.clear()
                        for (i in 0 until clips.length()) {
                            val o = clips.optJSONObject(i) ?: continue
                            clipItems.add(ClipItem(o.optString("id"), o.optString("content"), o.optString("sourceDeviceName", "Peer")))
                        }
                        refreshClipboardUi()
                    }
                }
                mainHandler.post {
                    if (connected) {
                        lblTopStatus.text = "Conectado · $activeHubLabel · ${devices.size} disp."
                        lblTopStatus.setTextColor(C_GREEN)
                    }
                }
            }
            "mesh:devices_sync" -> parseDevices(msg.optJSONArray("devices"))
            "device:joined", "device:updated" -> {
                val o = msg.optJSONObject("device") ?: return
                val id = o.optString("id")
                val tel = o.optJSONObject("telemetry")
                mainHandler.post {
                    val existing = devices.firstOrNull { it.id == id }
                    if (existing == null) {
                        devices.add(MeshDevice(
                            id = id,
                            name = o.optString("name", "Peer"),
                            os = o.optString("os", "desktop"),
                            x = o.optDouble("x", 220.0).toFloat(),
                            y = o.optDouble("y", 180.0).toFloat(),
                            cpu = tel?.optInt("cpuUsage", 0) ?: 0,
                            ram = tel?.optInt("memoryUsagePercent", 0) ?: 0,
                            battery = if (tel != null && !tel.isNull("batteryLevel")) tel.optInt("batteryLevel") else null,
                            lanIp = o.optString("lanIp", "")
                        ))
                    } else {
                        existing.name = o.optString("name", existing.name)
                        existing.os = o.optString("os", existing.os)
                        existing.x = o.optDouble("x", existing.x.toDouble()).toFloat()
                        existing.y = o.optDouble("y", existing.y.toDouble()).toFloat()
                        if (tel != null) {
                            existing.cpu = tel.optInt("cpuUsage", existing.cpu)
                            existing.ram = tel.optInt("memoryUsagePercent", existing.ram)
                            if (!tel.isNull("batteryLevel")) existing.battery = tel.optInt("batteryLevel")
                        }
                    }
                    syncMapUi()
                    refreshLanPeersUi()
                }
            }
            "device:left" -> {
                val id = msg.optString("deviceId")
                mainHandler.post {
                    devices.removeAll { it.id == id }
                    syncMapUi()
                    refreshLanPeersUi()
                }
            }
            "telemetry:pong" -> {
                val sent = msg.optLong("sentAt", 0L)
                if (sent > 0L) {
                    rttMs = max(1, (System.currentTimeMillis() - sent).toInt())
                    mainHandler.post {
                        if (connected) {
                            val count = devices.size
                            lblTopStatus.text = "Conectado · $activeHubLabel · ${rttMs} ms · $count disp."
                        }
                    }
                }
            }
            "screen:start" -> {
                val srcName = msg.optString("sourceDeviceName", "Computador")
                val w = msg.optInt("width", 1280)
                val h = msg.optInt("height", 720)
                screenResText = "${w}×${h}"
                mainHandler.post {
                    lblScreenStatus.text = "Recebendo tela de $srcName ($screenResText)"
                    switchTab("screen")
                }
            }
            "screen:frame" -> {
                val b64 = msg.optString("data")
                if (b64.isNotEmpty()) {
                    try {
                        val bytes = Base64.decode(b64, Base64.DEFAULT)
                        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        if (bmp != null) {
                            val w = msg.optInt("width", bmp.width)
                            val h = msg.optInt("height", bmp.height)
                            screenFpsCount++
                            val now = SystemClock.uptimeMillis()
                            if (now - screenFpsLastMs >= 1000L) {
                                screenFps = screenFpsCount
                                screenFpsCount = 0
                                screenFpsLastMs = now
                                mainHandler.post {
                                    lblScreenStatus.text = "Segunda Tela Ativa · ${w}×${h} · ${screenFps} FPS · Toque para controlar"
                                }
                            }
                            liveScreenView.updateFrame(bmp)
                        }
                    } catch (_: Exception) { }
                }
            }
            "screen:stop" -> {
                mainHandler.post {
                    liveScreenView.updateFrame(null)
                    lblScreenStatus.text = "Transmissão de tela encerrada."
                    if (fullscreenScreen) setScreenFullscreen(false)
                }
            }
            "clipboard:added" -> {
                val o = msg.optJSONObject("item") ?: return
                val content = o.optString("content")
                val srcId = o.optString("sourceDeviceId")
                mainHandler.post {
                    clipItems.add(0, ClipItem(o.optString("id"), content, o.optString("sourceDeviceName", "Peer")))
                    refreshClipboardUi()
                    if (autoClipboardSync && srcId != deviceId && content.isNotBlank() && content != lastSyncedClip) {
                        lastSyncedClip = content
                        try {
                            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            cm.setPrimaryClip(ClipData.newPlainText("Continuum", content))
                        } catch (_: Exception) { }
                    }
                }
            }
            "notification:added" -> {
                val o = msg.optJSONObject("notification") ?: return
                mainHandler.post {
                    notifItems.add(0, NotifItem(o.optString("id"), o.optString("title", "Alerta"), o.optString("body", ""), o.optString("sourceDeviceName", "")))
                    refreshNotifsUi()
                }
            }
            "input:event" -> {
                val ev = msg.optJSONObject("event") ?: return
                if (ev.optString("kind") == "media" && ev.optString("action") == "ping") {
                    mainHandler.post { toast("Sinal de localização recebido via LAN!") }
                }
            }
            "file:start" -> {
                val tid = msg.optString("transferId")
                if (tid.isNotBlank() && msg.optString("sourceDeviceId") != deviceId) {
                    val name = File(msg.optString("fileName", "arquivo.bin")).name
                    incomingFiles[tid] = IncomingFile(name, msg.optLong("fileSize", 0L), max(1, msg.optInt("totalChunks", 1)))
                    mainHandler.post { fileProgress.progress = 0; lblFileStatus.text = "Recebendo $name · 0%" }
                }
            }
            "file:chunk" -> {
                val rec = incomingFiles[msg.optString("transferId")] ?: return
                rec.chunks[msg.optInt("chunkIndex", 0)] = msg.optString("data", "")
                val pct = ((rec.chunks.size * 100) / rec.total).coerceIn(0, 99)
                mainHandler.post { fileProgress.progress = pct; lblFileStatus.text = "Recebendo ${rec.name} · $pct%" }
            }
            "file:complete" -> {
                val rec = incomingFiles.remove(msg.optString("transferId")) ?: return
                try {
                    val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
                    dir.mkdirs()
                    val out = File(dir, rec.name)
                    FileOutputStream(out).use { fos ->
                        for (i in 0 until rec.total) {
                            val b64 = rec.chunks[i] ?: continue
                            fos.write(Base64.decode(b64, Base64.DEFAULT))
                        }
                    }
                    mainHandler.post {
                        fileProgress.progress = 100
                        lblFileStatus.text = "Recebido: ${rec.name}"
                        addFileHistoryRow("Recebido: ${rec.name} (${max(1L, rec.size / 1024L)} KB)")
                        toast("Arquivo salvo: ${rec.name}")
                    }
                } catch (ex: Exception) {
                    mainHandler.post { toast("Erro ao salvar arquivo: ${ex.message}") }
                }
            }
        }
    }

    private fun parseDevices(arr: JSONArray?) {
        if (arr == null) return
        val parsed = mutableListOf<MeshDevice>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val tel = o.optJSONObject("telemetry")
            parsed.add(MeshDevice(
                id = o.optString("id"),
                name = o.optString("name", "Peer"),
                os = o.optString("os", "desktop"),
                x = o.optDouble("x", (180 + (i % 3) * 200).toDouble()).toFloat(),
                y = o.optDouble("y", (130 + (i / 3) * 160).toDouble()).toFloat(),
                cpu = tel?.optInt("cpuUsage", 0) ?: 0,
                ram = tel?.optInt("memoryUsagePercent", 0) ?: 0,
                battery = if (tel != null && !tel.isNull("batteryLevel")) tel.optInt("batteryLevel") else null,
                lanIp = o.optString("lanIp", "")
            ))
        }
        mainHandler.post {
            devices.clear()
            devices.addAll(parsed)
            if (selectedDeviceId == null || devices.none { it.id == selectedDeviceId }) {
                selectedDeviceId = devices.firstOrNull { it.id != deviceId }?.id
            }
            syncMapUi()
            refreshLanPeersUi()
        }
    }

    private fun syncMapUi() {
        spatialMap.devices = devices.toMutableList()
        spatialMap.selectedId = selectedDeviceId
        spatialMap.invalidate()
        updateSelectedSummary()
        refreshTelemetryUi()
    }

    private fun updateSelectedSummary() {
        val tgt = getTargetDevice()
        if (tgt != null && tgt.id != deviceId) {
            lblMapSelected.text = "Alvo: ${tgt.name} (${tgt.os.uppercase()}) · CPU ${tgt.cpu}% · RAM ${tgt.ram}%"
            lblRemoteTarget.text = "Controlando: ${tgt.name} (${tgt.os.uppercase()})"
        } else {
            lblMapSelected.text = "Aguardando computador na rede Wi-Fi · IP deste dispositivo: ${getLocalLanIp()}:$LAN_WS_PORT"
            lblRemoteTarget.text = "Controlando: aguardando PC na rede local..."
        }
    }

    private fun refreshTelemetryUi() {
        telemetryContainer.removeAllViews()
        for (d in devices) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                background = roundedBg(C_CARD_SUBTLE, C_BORDER, 10f, this@MainActivity)
                setPadding(dp(this@MainActivity, 14), dp(this@MainActivity, 10), dp(this@MainActivity, 14), dp(this@MainActivity, 10))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(this@MainActivity, 8) }
            }
            val bat = if (d.battery != null) " · Bateria ${d.battery}%" else ""
            row.addView(TextView(this).apply { text = "${d.name} (${d.os.uppercase()})"; setTextColor(C_TEXT); textSize = 13.5f; typeface = Typeface.DEFAULT_BOLD })
            row.addView(TextView(this).apply { text = "CPU ${d.cpu}% · RAM ${d.ram}%$bat"; setTextColor(C_CYAN); textSize = 12f; typeface = Typeface.MONOSPACE })
            telemetryContainer.addView(row)
        }
    }

    private fun refreshClipboardUi() {
        clipListContainer.removeAllViews()
        for (item in clipItems.take(20)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                background = roundedBg(C_CARD_SUBTLE, C_BORDER, 10f, this@MainActivity)
                setPadding(dp(this@MainActivity, 12), dp(this@MainActivity, 10), dp(this@MainActivity, 12), dp(this@MainActivity, 10))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(this@MainActivity, 8) }
            }
            val tv = TextView(this).apply {
                text = "[${item.source}] ${item.content.take(120)}"
                setTextColor(C_TEXT)
                textSize = 12.5f
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { rightMargin = dp(this@MainActivity, 8) }
            }
            val bCopy = makeBtn("Copiar", false, 38) {
                lastSyncedClip = item.content
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Continuum", item.content))
                toast("Copiado!")
            }
            row.addView(tv)
            row.addView(bCopy)
            clipListContainer.addView(row)
        }
    }

    private fun refreshNotifsUi() {
        notifListContainer.removeAllViews()
        for (n in notifItems.take(20)) {
            val tv = TextView(this).apply {
                text = "[${n.source}] ${n.title}: ${n.body}"
                setTextColor(C_TEXT)
                textSize = 12.5f
                background = roundedBg(C_CARD_SUBTLE, C_BORDER, 10f, this@MainActivity)
                setPadding(dp(this@MainActivity, 12), dp(this@MainActivity, 10), dp(this@MainActivity, 12), dp(this@MainActivity, 10))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(this@MainActivity, 8) }
            }
            notifListContainer.addView(tv)
        }
    }

    private fun addFileHistoryRow(text: String) {
        val tv = TextView(this).apply {
            this.text = text
            setTextColor(C_TEXT)
            textSize = 12.5f
            setPadding(0, dp(this@MainActivity, 8), 0, 0)
        }
        fileListContainer.addView(tv, 0)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    override fun onDestroy() {
        destroyed = true
        connGen.incrementAndGet()
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipListener?.let { cm.removePrimaryClipChangedListener(it) }
        } catch (_: Exception) { }
        try { ws?.close(1000, "exit") } catch (_: Exception) { }
        try { localHub.stop() } catch (_: Exception) { }
        try { discoverySocket?.close() } catch (_: Exception) { }
        try { if (multicastLock?.isHeld == true) multicastLock?.release() } catch (_: Exception) { }
        super.onDestroy()
    }
}
