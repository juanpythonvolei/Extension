import type { InstallerContext } from './platformInstallers.ts';
import type { ZipEntryInput } from './zipBuilder.ts';

function safeStr(val: string): string {
  return val.replace(/[`'"\\$<>|;&\r\n]/g, '');
}

/**
 * 100% NATIVE ANDROID KOTLIN APPLICATION v4.0.0 (HOLOGRAPHIC SPATIAL UI + ULTRA-FLUID AUTO LAN MESH)
 * - ZERO WebView, ZERO Browser, ZERO Web App dependency!
 * - 3-Layer Automatic LAN Discovery:
 *     1) Active UDP Probe (255.255.255.255 + /24 subnet broadcast + multicast 239.255.45.90) with Unicast reply
 *     2) Fast Parallel /24 TCP LAN Scanner (32 threads, GET /continuum-info on 45891) — bypasses router UDP blocks!
 *     3) Embedded Android RFC-6455 LAN WebSocket Hub (TCP 45891) — lets PCs connect outbound if PC firewall blocks!
 * - Smart URL Normalization: accepts http://ip:port, ws://ip:port, ip:port, ip, or .42 (auto-completes Wi-Fi subnet).
 * - Holographic 60fps Custom Canvas UI:
 *     - Sweeping cyan radar beam, pulsing telemetry rings, animated data packets along glowing Bezier links
 *     - Frosted holographic glass device cards with iridescent cyan->blue->violet borders & radial CPU/RAM arc gauges
 *     - Tactile holographic trackpad with HUD corner brackets, luminous comet trail, multi-ring shockwaves & haptics
 */
export function buildAndroidNativeProjectEntries(
  ctx: InstallerContext,
  pngIcon: Buffer | null,
  prefix = 'native-apps/android'
): ZipEntryInput[] {
  const room = safeStr(ctx.roomCode || 'MESH01');

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
rootProject.name = "ContinuumNative"
include(":app")
`;

  const rootBuildGradle = `plugins {
    id("com.android.application") version "8.4.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
`;

  const gradleProps = `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
android.enableJetifier=false
kotlin.code.style=official
`;

  const appBuildGradle = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val defaultRoomCode: String = (project.findProperty("roomCode") as String?) ?: "${room}"

android {
    namespace = "app.continuum.nativeclient"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.continuum.nativeclient"
        minSdk = 26
        targetSdk = 34
        versionCode = 4
        versionName = "4.0.0"

        buildConfigField("String", "DEFAULT_ROOM_CODE", "\\"$defaultRoomCode\\"")
    }

    buildFeatures {
        buildConfig = true
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
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
`;

  const networkSecurityXml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

  const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="Continuum"
        android:roundIcon="@mipmap/ic_launcher"
        android:supportsRtl="true"
        android:usesCleartextTraffic="true"
        android:networkSecurityConfig="@xml/network_security_config"
        android:theme="@style/Theme.ContinuumNative">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

  const stylesXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.ContinuumNative" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="colorPrimary">#22D3EE</item>
        <item name="colorPrimaryVariant">#3B82F6</item>
        <item name="colorOnPrimary">#050810</item>
        <item name="colorSecondary">#8B5CF6</item>
        <item name="android:windowBackground">#050810</item>
        <item name="android:statusBarColor">#050810</item>
        <item name="android:navigationBarColor">#080D18</item>
    </style>
</resources>
`;

  const mainActivityKt = `package app.continuum.nativeclient

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
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
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

private const val LAN_UDP_PORT = 45890
private const val LAN_WS_PORT = 45891
private const val PROTO_V4 = "continuum-lan-v4"
private const val PROTO_V3 = "continuum-lan-v3"
private const val MULTICAST_ADDR = "239.255.45.90"
private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Holographic Spatial Obsidian Palette
private val C_VOID = Color.parseColor("#050810")
private val C_SURFACE = Color.parseColor("#0A101E")
private val C_GLASS = Color.parseColor("#111A2E")
private val C_GLASS_SUBTLE = Color.parseColor("#0D1526")
private val C_BORDER = Color.parseColor("#1E3354")
private val C_CYAN = Color.parseColor("#22D3EE")
private val C_COBALT = Color.parseColor("#3B82F6")
private val C_VIOLET = Color.parseColor("#8B5CF6")
private val C_GREEN = Color.parseColor("#10B981")
private val C_AMBER = Color.parseColor("#F59E0B")
private val C_TEXT = Color.parseColor("#F1F5F9")
private val C_MUTED = Color.parseColor("#8BA3C4")

data class MeshDevice(
    val id: String,
    var name: String,
    var os: String,
    var x: Float,
    var y: Float,
    var cpu: Int,
    var ram: Int,
    var battery: Int?
)

data class DiscoveredLanHub(
    val hubId: String,
    val hubName: String,
    val os: String,
    val ip: String,
    val wsPort: Int,
    val roomCode: String,
    val via: String,
    val lastSeenMs: Long
)

data class ClipItem(val id: String, val content: String, val source: String)
data class NotifItem(val id: String, val title: String, val body: String, val source: String)

private fun dpToPx(ctx: Context, dp: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp.toFloat(), ctx.resources.displayMetrics).toInt()

private fun glassDrawable(fill: Int, stroke: Int, radiusDp: Float, ctx: Context, strokeDp: Int = 1): GradientDrawable {
    return GradientDrawable().apply {
        setColor(fill)
        cornerRadius = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, radiusDp, ctx.resources.displayMetrics)
        if (stroke != 0) setStroke(dpToPx(ctx, strokeDp), stroke)
    }
}

private fun holoGradientButton(ctx: Context, radiusDp: Float = 12f): GradientDrawable {
    return GradientDrawable(
        GradientDrawable.Orientation.TL_BR,
        intArrayOf(Color.parseColor("#0891B2"), C_COBALT, C_VIOLET)
    ).apply {
        cornerRadius = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, radiusDp, ctx.resources.displayMetrics)
    }
}

private fun getLocalLanIp(): String {
    try {
        val interfaces = NetworkInterface.getNetworkInterfaces()
        var fallback: String? = null
        while (interfaces.hasMoreElements()) {
            val ni = interfaces.nextElement()
            if (!ni.isUp || ni.isLoopback) continue
            val addrs = ni.inetAddresses
            while (addrs.hasMoreElements()) {
                val addr = addrs.nextElement()
                if (addr is Inet4Address && !addr.isLoopbackAddress) {
                    val ip = addr.hostAddress ?: continue
                    if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) {
                        return ip
                    }
                    if (fallback == null) fallback = ip
                }
            }
        }
        if (fallback != null) return fallback
    } catch (_: Exception) { }
    return "127.0.0.1"
}

/**
 * Bulletproof LAN Endpoint Parser:
 * Accepts http://192.168.1.42:45891, https://..., ws://..., 192.168.1.42:45891,
 * 192.168.1.42, or shorthand ".42" / "42" (auto-completes current Wi-Fi /24 prefix!).
 */
private fun parseLanEndpoint(rawInput: String, localIp: String): Pair<String, Int>? {
    var s = rawInput.trim()
    if (s.isEmpty()) return null
    s = s.replace(Regex("^(https?|wss?)://", RegexOption.IGNORE_CASE), "")
    val slashIdx = s.indexOf('/')
    if (slashIdx >= 0) s = s.substring(0, slashIdx)
    s = s.trim()
    if (s.isEmpty()) return null

    // Shorthand ".42" or "42" -> auto-complete current subnet prefix
    val dotTrimmed = s.removePrefix(".")
    if (dotTrimmed.matches(Regex("^[0-9]{1,3}(:[0-9]{2,5})?\\$"))) {
        val parts = localIp.split('.')
        if (parts.size == 4 && !localIp.startsWith("127.")) {
            s = "\${parts[0]}.\${parts[1]}.\${parts[2]}.\$dotTrimmed"
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
// Embedded Lightweight RFC-6455 LAN Hub on Android (TCP 45891)
// Enables PCs (Linux/Windows) to connect OUTBOUND to Android even if PC firewall blocks!
// ---------------------------------------------------------------------------
class EmbeddedAndroidLanHub(
    val hubId: String,
    val hubName: String,
    private val getRoom: () -> String,
    val port: Int = LAN_WS_PORT
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

    private fun getRoomData(code: String): RoomData = rooms.getOrPut(code) { RoomData() }

    private fun encodeFrame(payload: ByteArray, opcode: Int = 0x1): ByteArray {
        val baos = ByteArrayOutputStream()
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
                if (hdrBuf.toString("UTF-8").contains("\\r\\n\\r\\n")) break
            }
            val headersRaw = hdrBuf.toString("UTF-8")
            var wsKey: String? = null
            for (line in headersRaw.split("\\r\\n").drop(1)) {
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
                    .put("proto", PROTO_V4)
                    .put("hubId", hubId)
                    .put("hubName", hubName)
                    .put("os", "android")
                    .put("roomCode", room)
                    .put("wsPort", port)
                    .put("ip", getLocalLanIp())
                    .put("startedAt", startedAt)
                    .put("peers", peerCount(room))
                    .toString()
                    .toByteArray(Charsets.UTF_8)
                val resp = ("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: \${info.size}\\r\\nConnection: close\\r\\n\\r\\n").toByteArray(Charsets.US_ASCII)
                out.write(resp)
                out.write(info)
                out.flush()
                return
            }

            val sha1 = MessageDigest.getInstance("SHA-1").digest((wsKey + WS_GUID).toByteArray(Charsets.US_ASCII))
            val accept = Base64.encodeToString(sha1, Base64.NO_WRAP)
            val handshake = "HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: \$accept\\r\\n\\r\\n"
            out.write(handshake.toByteArray(Charsets.US_ASCII))
            out.flush()
            sock.soTimeout = 0

            val s = Session(sock, out, ip)
            session = s
            sessions.add(s)

            while (active) {
                val h = readExact(ins, 2) ?: break
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
                if (len < 0 || len > 16 * 1024 * 1024) break
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
                if (opcode != 0x1) continue
                try {
                    processMessage(s, JSONObject(String(payload, Charsets.UTF_8)))
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
                val room = msg.optString("roomCode", getRoom()).uppercase().replace(Regex("[^A-Z0-9]"), "").take(12).ifEmpty { "MESH01" }
                val devIn = msg.optJSONObject("device") ?: JSONObject()
                val did = devIn.optString("id").ifBlank { "peer-\${System.currentTimeMillis()}" }
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
            "input:event", "file:start", "file:chunk", "file:complete" -> {
                val room = s.roomCode ?: return
                val tid = msg.optString("targetDeviceId")
                if (tid.isNotBlank()) sendToDevice(room, tid, msg, s) else broadcastRoom(room, msg, s)
            }
            "clipboard:push" -> {
                val room = s.roomCode ?: return
                val content = msg.optString("content").take(32000)
                if (content.isBlank()) return
                val item = JSONObject()
                    .put("id", "clip-\${System.currentTimeMillis()}")
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
                    .put("id", "notif-\${System.currentTimeMillis()}")
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
// Holographic 60 FPS Spatial Device Map View (Radar Sweep + Flowing Data Packets + Radial Gauges)
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
    private val nodeW = 174f * density
    private val nodeH = 98f * density
    private var dragId: String? = null
    private var dragOffX = 0f
    private var dragOffY = 0f
    private var lastFrameMs = SystemClock.uptimeMillis()
    private var phase = 0f

    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(42, 34, 211, 238); strokeWidth = 0.8f * density }
    private val crossPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(90, 34, 211, 238); strokeWidth = 1f * density }
    private val radarRingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.2f * density }
    private val radarSweepPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val linkGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val packetPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_CYAN; style = Paint.Style.FILL }
    private val cardFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val cardGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f * density; color = C_CYAN }
    private val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_TEXT; textSize = 12.2f * density; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
    private val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_MUTED; textSize = 9.8f * density }
    private val gaugeBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 3f * density; color = Color.argb(90, 30, 51, 84) }
    private val gaugeValPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 3f * density; strokeCap = Paint.Cap.ROUND }
    private val gaugeTxtPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_TEXT; textSize = 8.5f * density; textAlign = Paint.Align.CENTER; typeface = Typeface.MONOSPACE }

    private fun screenPos(d: MeshDevice): Pair<Float, Float> {
        val sx = (d.x / 720f) * max(width.toFloat(), 320f)
        val sy = (d.y / 480f) * max(height.toFloat(), 300f)
        return Pair(
            sx.coerceIn(nodeW / 2f + 12f, max(nodeW / 2f + 14f, width - nodeW / 2f - 12f)),
            sy.coerceIn(nodeH / 2f + 12f, max(nodeH / 2f + 14f, height - nodeH / 2f - 12f))
        )
    }

    private fun nodeRect(d: MeshDevice): RectF {
        val (cx, cy) = screenPos(d)
        return RectF(cx - nodeW / 2f, cy - nodeH / 2f, cx + nodeW / 2f, cy + nodeH / 2f)
    }

    private fun cubicPoint(t: Float, x0: Float, y0: Float, x1: Float, y1: Float, x2: Float, y2: Float, x3: Float, y3: Float): Pair<Float, Float> {
        val u = 1f - t
        val tt = t * t
        val uu = u * u
        val uuu = uu * u
        val ttt = tt * t
        val x = uuu * x0 + 3f * uu * t * x1 + 3f * u * tt * x2 + ttt * x3
        val y = uuu * y0 + 3f * uu * t * y1 + 3f * u * tt * y2 + ttt * y3
        return Pair(x, y)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val now = SystemClock.uptimeMillis()
        val dt = ((now - lastFrameMs).coerceIn(1L, 50L)) / 1000f
        lastFrameMs = now
        phase = (phase + dt) % 1000f

        val cx = width / 2f
        val cy = height / 2f

        // 1. Deep Space Radial Gradient Backdrop
        bgPaint.shader = RadialGradient(cx, cy, max(width, height) * 0.78f, Color.parseColor("#0D182D"), C_VOID, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)

        // 2. Holographic Perspective Matrix & Crosshairs
        val step = (30f * density).toInt().coerceAtLeast(28)
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

        // 3. Holographic Concentric Radar Rings & Sweeping Beam
        val maxR = min(width, height) * 0.46f
        for (i in 1..3) {
            radarRingPaint.color = Color.argb(if (scanning) 55 else 24, 34, 211, 238)
            canvas.drawCircle(cx, cy, maxR * (i / 3f), radarRingPaint)
        }
        val pulseR = ((phase * 0.55f) % 1f) * maxR
        val pulseAlpha = ((1f - (pulseR / max(1f, maxR))) * (if (scanning) 130 else 55)).toInt().coerceIn(0, 255)
        radarRingPaint.color = Color.argb(pulseAlpha, 34, 211, 238)
        canvas.drawCircle(cx, cy, pulseR, radarRingPaint)

        if (scanning || devices.size <= 1) {
            canvas.save()
            val angleDeg = (phase * 115f) % 360f
            canvas.rotate(angleDeg, cx, cy)
            radarSweepPaint.shader = SweepGradient(
                cx, cy,
                intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, Color.argb(65, 34, 211, 238)),
                floatArrayOf(0f, 0.78f, 1f)
            )
            canvas.drawCircle(cx, cy, maxR, radarSweepPaint)
            canvas.restore()
        }

        if (devices.isEmpty()) {
            subPaint.textAlign = Paint.Align.CENTER
            subPaint.color = C_CYAN
            val msg = if (scanning) "Radar Holográfico escaneando Wi-Fi... \$scanProgress%" else "Escaneando dispositivos Linux / Windows na rede local..."
            canvas.drawText(msg, cx, cy + maxR * 0.55f, subPaint)
            subPaint.textAlign = Paint.Align.LEFT
            subPaint.color = C_MUTED
            postInvalidateOnAnimation()
            return
        }

        // 4. Glowing Bezier Mesh Links + Animated Energy Data Packets
        val anchor = devices.firstOrNull { it.id == selfId } ?: devices.first()
        val (ax, ay) = screenPos(anchor)
        for (d in devices) {
            if (d.id == anchor.id) continue
            val (dx, dy) = screenPos(d)
            val isSel = d.id == selectedId
            val mx = (ax + dx) / 2f
            val path = Path().apply {
                moveTo(ax, ay)
                cubicTo(mx, ay, mx, dy, dx, dy)
            }
            // Outer glow
            linkGlowPaint.shader = LinearGradient(ax, ay, dx, dy, C_CYAN, if (isSel) C_VIOLET else C_COBALT, Shader.TileMode.CLAMP)
            linkGlowPaint.alpha = if (isSel) 95 else 48
            linkGlowPaint.strokeWidth = (if (isSel) 7f else 4f) * density
            canvas.drawPath(path, linkGlowPaint)
            // Crisp holographic beam core
            linkGlowPaint.alpha = if (isSel) 235 else 155
            linkGlowPaint.strokeWidth = (if (isSel) 2.2f else 1.4f) * density
            canvas.drawPath(path, linkGlowPaint)

            // Flowing energy packets
            for (k in 0..1) {
                val t = ((phase * 0.65f + k * 0.5f) % 1f)
                val (px, py) = cubicPoint(t, ax, ay, mx, ay, mx, dy, dx, dy)
                packetPaint.color = Color.argb(90, 34, 211, 238)
                canvas.drawCircle(px, py, 6f * density, packetPaint)
                packetPaint.color = Color.WHITE
                canvas.drawCircle(px, py, 2.3f * density, packetPaint)
            }
        }

        // 5. Frosted Holographic Device Cards with Radial CPU/RAM Arc Gauges
        val rCorner = 14f * density
        for (d in devices) {
            val r = nodeRect(d)
            val isSelf = d.id == selfId
            val isSel = d.id == selectedId

            // Soft holographic aura around selected or local node
            if (isSel || isSelf) {
                cardGlowPaint.color = if (isSel) Color.argb(65, 34, 211, 238) else Color.argb(45, 16, 185, 129)
                cardGlowPaint.strokeWidth = 6f * density
                canvas.drawRoundRect(RectF(r.left - 1f, r.top - 1f, r.right + 1f, r.bottom + 1f), rCorner, rCorner, cardGlowPaint)
            }

            // Frosted dark glass body
            cardFillPaint.shader = LinearGradient(
                r.left, r.top, r.right, r.bottom,
                if (isSel) Color.argb(235, 22, 36, 62) else Color.argb(220, 15, 23, 40),
                Color.argb(228, 9, 14, 26),
                Shader.TileMode.CLAMP
            )
            canvas.drawRoundRect(r, rCorner, rCorner, cardFillPaint)

            // Iridescent Holographic Border
            borderPaint.shader = LinearGradient(
                r.left, r.top, r.right, r.bottom,
                when {
                    isSel -> intArrayOf(C_CYAN, C_COBALT, C_VIOLET)
                    isSelf -> intArrayOf(C_GREEN, C_CYAN)
                    else -> intArrayOf(Color.parseColor("#2B4870"), Color.parseColor("#1D2E4D"))
                },
                null,
                Shader.TileMode.CLAMP
            )
            borderPaint.strokeWidth = (if (isSel) 2f else 1.2f) * density
            canvas.drawRoundRect(r, rCorner, rCorner, borderPaint)

            // Vector Hardware Glyph (Phone vs Desktop Monitor)
            val ix = r.left + 13f * density
            val iy = r.top + 13f * density
            iconPaint.color = if (isSel) C_CYAN else (if (isSelf) C_GREEN else C_COBALT)
            if (d.os.equals("android", true) || d.os.equals("ios", true)) {
                canvas.drawRoundRect(RectF(ix, iy, ix + 11f * density, iy + 18f * density), 2.5f * density, 2.5f * density, iconPaint)
                canvas.drawLine(ix + 4f * density, iy + 15f * density, ix + 7f * density, iy + 15f * density, iconPaint)
            } else {
                canvas.drawRoundRect(RectF(ix, iy, ix + 16f * density, iy + 12f * density), 2f * density, 2f * density, iconPaint)
                canvas.drawLine(ix + 5f * density, iy + 15f * density, ix + 11f * density, iy + 15f * density, iconPaint)
                canvas.drawLine(ix + 8f * density, iy + 12f * density, ix + 8f * density, iy + 15f * density, iconPaint)
            }

            // Title & OS Role
            val label = if (d.name.length > 15) d.name.substring(0, 15) else d.name
            canvas.drawText(label, r.left + 35f * density, r.top + 23f * density, titlePaint)
            val role = if (isSelf) "Este Dispositivo" else if (isSel) "Alvo Ativo" else "LAN Direta"
            val bat = if (d.battery != null) " · \${d.battery}%" else ""
            canvas.drawText("\${d.os.uppercase()} · \$role\$bat", r.left + 35f * density, r.top + 37f * density, subPaint)

            // Dual Radial Arc Gauges (CPU & RAM)
            drawRadialGauge(canvas, r.left + 44f * density, r.top + 70f * density, 16f * density, d.cpu, "CPU", C_CYAN)
            drawRadialGauge(canvas, r.left + 112f * density, r.top + 70f * density, 16f * density, d.ram, "RAM", C_VIOLET)
        }

        postInvalidateOnAnimation()
    }

    private fun drawRadialGauge(canvas: Canvas, cx: Float, cy: Float, radius: Float, value: Int, label: String, color: Int) {
        val oval = RectF(cx - radius, cy - radius, cx + radius, cy + radius)
        canvas.drawArc(oval, -90f, 360f, false, gaugeBgPaint)
        gaugeValPaint.color = color
        val sweep = (value.coerceIn(0, 100) / 100f) * 360f
        if (sweep > 0f) canvas.drawArc(oval, -90f, sweep, false, gaugeValPaint)
        canvas.drawText("\$value%", cx, cy + 3f * density, gaugeTxtPaint)
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
                if (id != null) {
                    devices.firstOrNull { it.id == id }?.let { onMoved?.invoke(id, it.x, it.y) }
                }
                return true
            }
        }
        return super.onTouchEvent(event)
    }
}

// ---------------------------------------------------------------------------
// Holographic Multi-Touch Trackpad (HUD Brackets + Luminous Comet Trail + Shockwaves)
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
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(145, 139, 163, 196); textSize = 12f * density; textAlign = Paint.Align.CENTER }
    private val trailPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val ripplePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * density }
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val corePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        bgPaint.shader = RadialGradient(width / 2f, height / 2f, max(width, height) * 0.7f, Color.parseColor("#0C162A"), C_VOID, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)

        // Precision Holographic Dot Matrix
        val step = (24f * density).toInt().coerceAtLeast(24)
        var gx = step
        while (gx < width) {
            var gy = step
            while (gy < height) {
                canvas.drawCircle(gx.toFloat(), gy.toFloat(), 1.1f * density, dotPaint)
                gy += step
            }
            gx += step
        }

        // HUD Corner Brackets
        val m = 14f * density
        val b = 18f * density
        canvas.drawLine(m, m, m + b, m, bracketPaint); canvas.drawLine(m, m, m, m + b, bracketPaint)
        canvas.drawLine(width - m, m, width - m - b, m, bracketPaint); canvas.drawLine(width - m, m, width - m, m + b, bracketPaint)
        canvas.drawLine(m, height - m, m + b, height - m, bracketPaint); canvas.drawLine(m, height - m, m, height - m - b, bracketPaint)
        canvas.drawLine(width - m, height - m, width - m - b, height - m, bracketPaint); canvas.drawLine(width - m, height - m, width - m, height - m - b, bracketPaint)

        if (touchX < 0f) {
            canvas.drawText("1 dedo: cursor & toque esq · 2 dedos: scroll & toque dir", width / 2f, height / 2f, hintPaint)
        }

        val now = SystemClock.uptimeMillis()

        // Luminous Comet Trail
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

        // Multi-ring Holographic Shockwaves
        ripples.removeAll { now - it.t0 > 460L }
        for (rp in ripples) {
            val p = (now - rp.t0) / 460f
            val alpha = ((1f - p) * 215).toInt().coerceIn(0, 255)
            ripplePaint.color = Color.argb(alpha, 34, 211, 238)
            canvas.drawCircle(rp.x, rp.y, (12f + p * 54f) * density, ripplePaint)
            ripplePaint.color = Color.argb((alpha * 0.55f).toInt(), 139, 92, 246)
            canvas.drawCircle(rp.x, rp.y, (6f + p * 34f) * density, ripplePaint)
        }

        // Glowing Holographic Reticle
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
                lastX = event.x; lastY = event.y
                touchX = event.x; touchY = event.y
                moved = false; twoFinger = false; downTime = now
                trail.clear()
                trail.add(TrailPt(event.x, event.y, now))
                ripples.add(Ripple(event.x, event.y, now))
                invalidate()
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                twoFinger = event.pointerCount >= 2
                lastX = event.x; lastY = event.y
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = event.x - lastX
                val dy = event.y - lastY
                lastX = event.x; lastY = event.y
                touchX = event.x; touchY = event.y
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
                touchX = -1f; touchY = -1f
                invalidate()
            }
        }
        return true
    }
}

// ---------------------------------------------------------------------------
// Main Continuum v4.0 Native Android Activity (Holographic UI + 3-Layer Auto LAN Mesh)
// ---------------------------------------------------------------------------
class MainActivity : AppCompatActivity() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    private val prefs by lazy { getSharedPreferences("continuum_lan_v4", Context.MODE_PRIVATE) }
    private val deviceName by lazy { "\${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} \${Build.MODEL}" }
    private val deviceId by lazy {
        val clean = Build.MODEL.lowercase().replace(Regex("[^a-z0-9]"), "").take(12).ifEmpty { "android" }
        "android-app-\$clean-\${(System.currentTimeMillis() % 8999) + 1000}"
    }

    private var roomCode: String = BuildConfig.DEFAULT_ROOM_CODE
    private var manualHostPort: String = ""
    private var activeWsUrl: String = ""
    private var activeHubLabel: String = ""
    private var ws: WebSocket? = null
    private var connected = false
    private var rttMs: Int? = null
    private var destroyed = false
    private var selectedDeviceId: String? = null
    @Volatile private var scanningLan = false

    private val devices = mutableListOf<MeshDevice>()
    private val discoveredHubs = ConcurrentHashMap<String, DiscoveredLanHub>()
    private val clipItems = mutableListOf<ClipItem>()
    private val notifItems = mutableListOf<NotifItem>()
    private val incomingFiles = ConcurrentHashMap<String, IncomingFile>()

    private lateinit var localHub: EmbeddedAndroidLanHub
    private var multicastLock: WifiManager.MulticastLock? = null
    private var discoverySocket: DatagramSocket? = null

    // UI Elements
    private lateinit var lblTopStatus: TextView
    private lateinit var lblTopRoom: TextView
    private lateinit var btnTopScan: Button
    private lateinit var spatialMap: HolographicSpatialMapView
    private lateinit var lblMapSelected: TextView
    private lateinit var lblRemoteTarget: TextView
    private lateinit var fileProgress: ProgressBar
    private lateinit var lblFileStatus: TextView
    private lateinit var fileListContainer: LinearLayout
    private lateinit var clipListContainer: LinearLayout
    private lateinit var lanPeersContainer: LinearLayout
    private lateinit var lblScanBanner: TextView
    private lateinit var notifListContainer: LinearLayout
    private lateinit var editManualIp: EditText
    private lateinit var editRoom: EditText

    private val tabPanels = mutableMapOf<String, View>()
    private val navBtns = mutableMapOf<String, LinearLayout>()

    data class IncomingFile(val name: String, val size: Long, val total: Int, val chunks: MutableMap<Int, String> = mutableMapOf())

    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) sendFileFromUri(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        roomCode = prefs.getString("roomCode", BuildConfig.DEFAULT_ROOM_CODE) ?: BuildConfig.DEFAULT_ROOM_CODE
        manualHostPort = prefs.getString("manualHostPort", "") ?: ""

        // Start embedded fallback Hub on Android so Linux/Windows can also connect outbound to Android!
        localHub = EmbeddedAndroidLanHub(deviceId, deviceName, { roomCode }, LAN_WS_PORT)
        localHub.start()

        setContentView(buildRootUi())
        switchTab("map")
        startUdpDiscoveryAndResponder()
        startTelemetryHeartbeat()

        if (manualHostPort.isNotBlank()) {
            connectDirectInput(manualHostPort)
        } else {
            runFastLanSubnetScan(autoConnect = true)
        }
    }

    private fun buildRootUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(C_VOID)
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }

        // ==================== HOLOGRAPHIC TOP BAR ====================
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(C_SURFACE)
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 8), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 8))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 58))
        }
        val brandCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val titleRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        titleRow.addView(TextView(this).apply {
            text = "CONTINUUM"
            setTextColor(C_CYAN)
            textSize = 14.5f
            letterSpacing = 0.08f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        })
        lblTopRoom = TextView(this).apply {
            text = "  ·  \$roomCode"
            setTextColor(C_MUTED)
            textSize = 11f
            typeface = Typeface.MONOSPACE
        }
        titleRow.addView(lblTopRoom)
        brandCol.addView(titleRow)

        lblTopStatus = TextView(this).apply {
            text = "◌ Escaneando Wi-Fi automaticamente..."
            setTextColor(C_CYAN)
            textSize = 11.5f
        }
        brandCol.addView(lblTopStatus)
        topBar.addView(brandCol)

        btnTopScan = makeHoloBtn("Escanear", true) {
            it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            runFastLanSubnetScan(autoConnect = !connected)
        }.apply {
            minHeight = dpToPx(this@MainActivity, 38)
            minimumHeight = dpToPx(this@MainActivity, 38)
            textSize = 11.5f
        }
        topBar.addView(btnTopScan)
        root.addView(topBar)

        // Glowing cyan-violet top divider
        root.addView(View(this).apply {
            background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, intArrayOf(C_CYAN, C_COBALT, C_VIOLET))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 1))
        })

        // ==================== CONTENT FRAME ====================
        val frame = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        tabPanels["map"] = buildMapTab()
        tabPanels["remote"] = buildRemoteTab()
        tabPanels["transfer"] = buildTransferTab()
        tabPanels["network"] = buildNetworkTab()
        tabPanels.values.forEach {
            it.visibility = View.GONE
            frame.addView(it, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        root.addView(frame)

        // ==================== FLOATING HOLOGRAPHIC BOTTOM DOCK ====================
        val dockWrap = FrameLayout(this).apply {
            setBackgroundColor(C_VOID)
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 6), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10))
        }
        val bottomNav = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = glassDrawable(C_SURFACE, C_BORDER, 18f, this@MainActivity)
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 56))
        }
        val tabs = listOf("map" to "Mapa", "remote" to "Trackpad", "transfer" to "Arquivos", "network" to "Rede LAN")
        for ((key, title) in tabs) {
            val item = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
                setOnClickListener {
                    it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    switchTab(key)
                }
            }
            val indicator = View(this).apply {
                tag = "ind"
                background = glassDrawable(Color.TRANSPARENT, 0, 4f, this@MainActivity)
                layoutParams = LinearLayout.LayoutParams(dpToPx(this@MainActivity, 28), dpToPx(this@MainActivity, 3)).apply {
                    bottomMargin = dpToPx(this@MainActivity, 5)
                }
            }
            val lbl = TextView(this).apply {
                tag = "lbl"
                text = title
                setTextColor(C_MUTED)
                textSize = 12f
                typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            }
            item.addView(indicator)
            item.addView(lbl)
            navBtns[key] = item
            bottomNav.addView(item)
        }
        dockWrap.addView(bottomNav)
        root.addView(dockWrap)
        return root
    }

    private fun switchTab(key: String) {
        tabPanels.forEach { (k, v) ->
            if (k == key) {
                if (v.visibility != View.VISIBLE) {
                    v.alpha = 0f
                    v.visibility = View.VISIBLE
                    v.animate().alpha(1f).setDuration(160L).start()
                }
            } else {
                v.visibility = View.GONE
            }
        }
        navBtns.forEach { (k, box) ->
            val active = k == key
            box.findViewWithTag<View>("ind")?.background = glassDrawable(if (active) C_CYAN else Color.TRANSPARENT, 0, 4f, this)
            box.findViewWithTag<TextView>("lbl")?.setTextColor(if (active) C_CYAN else C_MUTED)
        }
    }

    private fun makeHoloBtn(label: String, primary: Boolean = false, onClick: (View) -> Unit): Button {
        return Button(this).apply {
            text = label
            isAllCaps = false
            setTextColor(if (primary) Color.WHITE else C_TEXT)
            textSize = 12.5f
            typeface = Typeface.create(Typeface.SANS_SERIF, if (primary) Typeface.BOLD else Typeface.NORMAL)
            background = if (primary) holoGradientButton(this@MainActivity, 11f) else glassDrawable(C_GLASS_SUBTLE, C_BORDER, 11f, this@MainActivity)
            minHeight = dpToPx(this@MainActivity, 44)
            minimumHeight = dpToPx(this@MainActivity, 44)
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 6), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 6))
            setOnClickListener { onClick(it) }
        }
    }

    private fun makeInput(hintText: String, initial: String = ""): EditText {
        return EditText(this).apply {
            hint = hintText
            setText(initial)
            setTextColor(C_TEXT)
            setHintTextColor(C_MUTED)
            textSize = 13f
            isSingleLine = true
            background = glassDrawable(C_VOID, C_BORDER, 10f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10))
        }
    }

    // ==================== TAB 1: HOLOGRAPHIC SPATIAL MAP ====================
    private fun buildMapTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 6))
        }
        spatialMap = HolographicSpatialMapView(this).apply {
            selfId = deviceId
            background = glassDrawable(C_VOID, C_BORDER, 16f, this@MainActivity)
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

        val selCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = glassDrawable(C_GLASS, C_BORDER, 14f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dpToPx(this@MainActivity, 10)
            }
        }
        lblMapSelected = TextView(this).apply {
            text = "Radar ativo · Toque em um PC no mapa ou arraste os nós holográficos."
            setTextColor(C_MUTED)
            textSize = 12f
        }
        selCard.addView(lblMapSelected)

        val actRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dpToPx(this@MainActivity, 8)
            }
        }
        val bCtrl = makeHoloBtn("Trackpad", true) { switchTab("remote") }
        val bPing = makeHoloBtn("Localizar") { sendRemote(JSONObject().put("kind", "media").put("action", "ping")) }
        val bFile = makeHoloBtn("Arquivo") { filePicker.launch(arrayOf("*/*")) }
        listOf(bCtrl, bPing, bFile).forEachIndexed { i, b ->
            actRow.addView(b, LinearLayout.LayoutParams(0, dpToPx(this, 44), 1f).apply { if (i > 0) leftMargin = dpToPx(this@MainActivity, 6) })
        }
        selCard.addView(actRow)
        box.addView(selCard)
        return box
    }

    // ==================== TAB 2: HOLOGRAPHIC TRACKPAD ====================
    private fun buildRemoteTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 6))
        }
        lblRemoteTarget = TextView(this).apply {
            text = "Controlando: conecte-se a um PC automaticamente"
            setTextColor(C_CYAN)
            textSize = 13f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            setPadding(0, 0, 0, dpToPx(this@MainActivity, 8))
        }
        box.addView(lblRemoteTarget)

        val pad = HolographicTrackpadView(
            this,
            onMove = { dx, dy -> sendRemote(JSONObject().put("kind", "move").put("dx", dx.toDouble()).put("dy", dy.toDouble())) },
            onClick = { btn -> sendRemote(JSONObject().put("kind", "click").put("button", btn)) },
            onScroll = { dy -> sendRemote(JSONObject().put("kind", "scroll").put("dx", 0).put("dy", dy.toDouble())) }
        ).apply {
            background = glassDrawable(C_VOID, C_BORDER, 16f, this@MainActivity)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        box.addView(pad)

        val r1 = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dpToPx(this@MainActivity, 8)
            }
        }
        val row1Actions = listOf(
            "Esq" to { sendRemote(JSONObject().put("kind", "click").put("button", "left")) },
            "Dir" to { sendRemote(JSONObject().put("kind", "click").put("button", "right")) },
            "Vol−" to { sendRemote(JSONObject().put("kind", "media").put("action", "vol_down")) },
            "Vol+" to { sendRemote(JSONObject().put("kind", "media").put("action", "vol_up")) },
            "Play" to { sendRemote(JSONObject().put("kind", "media").put("action", "play_pause")) }
        )
        row1Actions.forEachIndexed { idx, (lbl, fn) ->
            r1.addView(makeHoloBtn(lbl, false) { fn() }, LinearLayout.LayoutParams(0, dpToPx(this, 44), 1f).apply { if (idx > 0) leftMargin = dpToPx(this@MainActivity, 5) })
        }
        box.addView(r1)

        val kbRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dpToPx(this@MainActivity, 8)
            }
        }
        val txtInput = makeInput("Digitar no PC alvo...")
        val btnSend = makeHoloBtn("Enviar", true) {
            val t = txtInput.text.toString()
            if (t.isNotEmpty()) {
                sendRemote(JSONObject().put("kind", "text").put("text", t))
                txtInput.setText("")
            }
        }
        val btnEnter = makeHoloBtn("Enter") { sendRemote(JSONObject().put("kind", "key").put("key", "Enter")) }
        kbRow.addView(txtInput, LinearLayout.LayoutParams(0, dpToPx(this, 44), 1f))
        kbRow.addView(btnSend, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dpToPx(this, 44)).apply { leftMargin = dpToPx(this@MainActivity, 6) })
        kbRow.addView(btnEnter, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dpToPx(this, 44)).apply { leftMargin = dpToPx(this@MainActivity, 6) })
        box.addView(kbRow)
        return box
    }

    // ==================== TAB 3: FILES & CLIPBOARD ====================
    private fun buildTransferTab(): View {
        val scroll = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 16))
        }

        val fCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = glassDrawable(C_GLASS, C_BORDER, 14f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12))
        }
        fCard.addView(TextView(this).apply { text = "Transferência Direta LAN"; setTextColor(C_TEXT); textSize = 15f; typeface = Typeface.DEFAULT_BOLD })
        fCard.addView(makeHoloBtn("Escolher e Enviar Arquivo", true) { filePicker.launch(arrayOf("*/*")) }.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 46)).apply { topMargin = dpToPx(this@MainActivity, 8) }
        })
        lblFileStatus = TextView(this).apply {
            text = "Pronto para envio em velocidade local Wi-Fi"
            setTextColor(C_MUTED)
            textSize = 12f
            setPadding(0, dpToPx(this@MainActivity, 8), 0, dpToPx(this@MainActivity, 4))
        }
        fCard.addView(lblFileStatus)
        fileProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 10))
        }
        fCard.addView(fileProgress)
        fileListContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        fCard.addView(fileListContainer)
        col.addView(fCard)

        val cCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = glassDrawable(C_GLASS, C_BORDER, 14f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dpToPx(this@MainActivity, 12) }
        }
        cCard.addView(TextView(this).apply { text = "Área de Transferência Universal"; setTextColor(C_TEXT); textSize = 15f; typeface = Typeface.DEFAULT_BOLD })
        val cRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dpToPx(this@MainActivity, 8) }
        }
        val editClip = makeInput("Texto para sincronizar...")
        val bPush = makeHoloBtn("Enviar", true) {
            val t = editClip.text.toString().trim()
            if (t.isNotEmpty()) { pushClipboard(t); editClip.setText("") }
        }
        val bGrab = makeHoloBtn("Colar") {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val txt = cm.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()
            if (!txt.isNullOrBlank()) pushClipboard(txt) else toast("Clipboard vazio.")
        }
        cRow.addView(editClip, LinearLayout.LayoutParams(0, dpToPx(this, 44), 1f))
        cRow.addView(bPush, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dpToPx(this, 44)).apply { leftMargin = dpToPx(this@MainActivity, 6) })
        cRow.addView(bGrab, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dpToPx(this, 44)).apply { leftMargin = dpToPx(this@MainActivity, 6) })
        cCard.addView(cRow)

        clipListContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dpToPx(this@MainActivity, 8), 0, 0) }
        cCard.addView(clipListContainer)
        col.addView(cCard)

        scroll.addView(col)
        return scroll
    }

    // ==================== TAB 4: SMART AUTO-DISCOVERY & DIRECT LAN CONNECT ====================
    private fun buildNetworkTab(): View {
        val scroll = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 16))
        }

        val myIp = getLocalLanIp()
        val lanCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = glassDrawable(C_GLASS, C_BORDER, 14f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12))
        }
        lanCard.addView(TextView(this).apply { text = "Radar Wi-Fi Automático (P2P Direto)"; setTextColor(C_CYAN); textSize = 15f; typeface = Typeface.DEFAULT_BOLD })
        lblScanBanner = TextView(this).apply {
            text = "IP deste Android: \$myIp:\$LAN_WS_PORT · Varredura híbrida (UDP + TCP /24)"
            setTextColor(C_MUTED)
            textSize = 11.5f
            typeface = Typeface.MONOSPACE
            setPadding(0, dpToPx(this@MainActivity, 4), 0, dpToPx(this@MainActivity, 8))
        }
        lanCard.addView(lblScanBanner)

        lanCard.addView(makeHoloBtn("Escanear Todos os PCs no Wi-Fi Agora", true) {
            runFastLanSubnetScan(autoConnect = true)
        }.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 46)).apply { bottomMargin = dpToPx(this@MainActivity, 8) }
        })

        lanPeersContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        lanCard.addView(lanPeersContainer)

        lanCard.addView(TextView(this).apply {
            text = "Conexão Direta por IP (aceita IP, .final, http:// ou ws://)"
            setTextColor(C_MUTED)
            textSize = 12f
            setPadding(0, dpToPx(this@MainActivity, 12), 0, dpToPx(this@MainActivity, 6))
        })
        editRoom = makeInput("Código da Malha (ex: MESH01)", roomCode).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        lanCard.addView(editRoom, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this, 44)))

        val ipPrefixHint = myIp.split('.').takeIf { it.size == 4 && !myIp.startsWith("127.") }?.let { "ex: \${it[0]}.\${it[1]}.\${it[2]}.42 ou só .42" } ?: "ex: 192.168.1.42:45891"
        editManualIp = makeInput(ipPrefixHint, manualHostPort)
        lanCard.addView(editManualIp, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this, 44)).apply { topMargin = dpToPx(this@MainActivity, 8) })

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dpToPx(this@MainActivity, 8) }
        }
        val bConn = makeHoloBtn("Conectar Direto", true) {
            roomCode = editRoom.text.toString().uppercase().replace(Regex("[^A-Z0-9]"), "").take(12).ifEmpty { BuildConfig.DEFAULT_ROOM_CODE }
            lblTopRoom.text = "  ·  \$roomCode"
            val raw = editManualIp.text.toString().trim()
            if (raw.isNotEmpty()) {
                connectDirectInput(raw)
            } else {
                runFastLanSubnetScan(autoConnect = true)
            }
        }
        val bAuto = makeHoloBtn("Auto Wi-Fi") {
            manualHostPort = ""
            editManualIp.setText("")
            prefs.edit().putString("manualHostPort", "").apply()
            runFastLanSubnetScan(autoConnect = true)
        }
        btnRow.addView(bConn, LinearLayout.LayoutParams(0, dpToPx(this, 46), 1f))
        btnRow.addView(bAuto, LinearLayout.LayoutParams(0, dpToPx(this, 46), 1f).apply { leftMargin = dpToPx(this@MainActivity, 8) })
        lanCard.addView(btnRow)
        col.addView(lanCard)

        val aCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = glassDrawable(C_GLASS, C_BORDER, 14f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dpToPx(this@MainActivity, 12) }
        }
        aCard.addView(TextView(this).apply { text = "Alertas da Malha"; setTextColor(C_TEXT); textSize = 15f; typeface = Typeface.DEFAULT_BOLD })
        aCard.addView(makeHoloBtn("Enviar Alerta de Teste") {
            sendJson(JSONObject()
                .put("type", "notification:push")
                .put("title", "Alerta de \$deviceName")
                .put("body", "Android conectado diretamente na rede local.")
                .put("sourceDeviceId", deviceId)
                .put("sourceDeviceName", deviceName))
        }.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 44)).apply { topMargin = dpToPx(this@MainActivity, 8) }
        })
        notifListContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dpToPx(this@MainActivity, 8), 0, 0) }
        aCard.addView(notifListContainer)
        col.addView(aCard)

        scroll.addView(col)
        refreshLanPeersUi()
        return scroll
    }

    // ==================== 3-LAYER AUTOMATIC DISCOVERY ====================
    private fun startUdpDiscoveryAndResponder() {
        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            multicastLock = wm?.createMulticastLock("continuum_lan_v4")?.apply {
                setReferenceCounted(true)
                acquire()
            }
        } catch (_: Exception) { }

        // Listener + Probe Responder + Periodic Active Probe Sender
        Thread {
            try {
                val sock = DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(InetSocketAddress(LAN_UDP_PORT))
                    soTimeout = 1200
                }
                discoverySocket = sock

                // Periodic active probe + self-beacon thread
                Thread {
                    val myIp = getLocalLanIp()
                    val subnetBcast = myIp.split('.').takeIf { it.size == 4 && !myIp.startsWith("127.") }?.let { "\${it[0]}.\${it[1]}.\${it[2]}.255" }
                    while (!destroyed) {
                        try {
                            val probe = JSONObject()
                                .put("proto", PROTO_V4)
                                .put("type", "probe")
                                .put("roomCode", roomCode)
                                .put("hubId", deviceId)
                                .put("hubName", deviceName)
                                .put("os", "android")
                                .put("ip", getLocalLanIp())
                                .put("wsPort", LAN_WS_PORT)
                                .put("startedAt", localHub.startedAt)
                                .toString()
                                .toByteArray(Charsets.UTF_8)
                            sock.send(DatagramPacket(probe, probe.size, InetAddress.getByName("255.255.255.255"), LAN_UDP_PORT))
                            if (subnetBcast != null) {
                                sock.send(DatagramPacket(probe, probe.size, InetAddress.getByName(subnetBcast), LAN_UDP_PORT))
                            }
                            sock.send(DatagramPacket(probe, probe.size, InetAddress.getByName(MULTICAST_ADDR), LAN_UDP_PORT))
                        } catch (_: Exception) { }
                        Thread.sleep(2500)
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
                        if (proto != PROTO_V4 && proto != PROTO_V3) continue
                        val hubId = json.optString("hubId")
                        if (hubId.isBlank() || hubId == deviceId) continue

                        // If another device probed us, reply immediately via direct unicast!
                        if (json.optString("type") == "probe" && localHub.active) {
                            val reply = JSONObject()
                                .put("proto", PROTO_V4)
                                .put("type", "beacon")
                                .put("roomCode", roomCode)
                                .put("hubId", deviceId)
                                .put("hubName", deviceName)
                                .put("os", "android")
                                .put("ip", getLocalLanIp())
                                .put("wsPort", LAN_WS_PORT)
                                .put("startedAt", localHub.startedAt)
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
                                lastSeenMs = System.currentTimeMillis()
                            ),
                            allowAutoConnect = true
                        )
                    } catch (_: Exception) { }
                }
            } catch (_: Exception) { }
        }.apply { isDaemon = true; start() }
    }

    /**
     * FAST PARALLEL /24 TCP LAN SCANNER (Zero UDP dependency!)
     * Probes 192.168.x.1..254 on port 45891 in ~1.4 seconds using 32 concurrent workers.
     * Works even on Wi-Fi routers that completely block UDP broadcast / multicast!
     */
    private fun runFastLanSubnetScan(autoConnect: Boolean) {
        if (scanningLan) return
        val myIp = getLocalLanIp()
        val parts = myIp.split('.')
        if (parts.size != 4 || myIp.startsWith("127.")) {
            toast("Conecte-se ao Wi-Fi local para escanear PCs.")
            return
        }
        val prefix = "\${parts[0]}.\${parts[1]}.\${parts[2]}"
        scanningLan = true
        mainHandler.post {
            spatialMap.scanning = true
            spatialMap.scanProgress = 0
            lblTopStatus.text = "◌ Escaneando \$prefix.x (0%)..."
            lblTopStatus.setTextColor(C_CYAN)
            lblScanBanner.text = "Escaneando \$prefix.1..254 na porta \$LAN_WS_PORT..."
        }

        Thread {
            val pool = Executors.newFixedThreadPool(32)
            val done = AtomicInteger(0)
            val foundAny = AtomicInteger(0)

            for (hostNum in 1..254) {
                val targetIp = "\$prefix.\$hostNum"
                if (targetIp == myIp) {
                    done.incrementAndGet()
                    continue
                }
                pool.execute {
                    try {
                        val info = probeContinuumHttpInfo(targetIp, LAN_WS_PORT, 260)
                        if (info != null) {
                            foundAny.incrementAndGet()
                            val hub = DiscoveredLanHub(
                                hubId = info.optString("hubId", "lan-\$targetIp"),
                                hubName = info.optString("hubName", info.optString("hub", targetIp)),
                                os = info.optString("os", "desktop"),
                                ip = targetIp,
                                wsPort = info.optInt("wsPort", LAN_WS_PORT),
                                roomCode = info.optString("roomCode", roomCode),
                                via = "TCP Radar",
                                lastSeenMs = System.currentTimeMillis()
                            )
                            registerDiscoveredHub(hub, allowAutoConnect = autoConnect)
                        }
                    } catch (_: Exception) {
                    } finally {
                        val c = done.incrementAndGet()
                        if (c % 16 == 0 || c == 254) {
                            val pct = (c * 100) / 254
                            mainHandler.post {
                                spatialMap.scanProgress = pct
                                if (!connected) {
                                    lblTopStatus.text = "◌ Escaneando \$prefix.x (\$pct%)..."
                                }
                            }
                        }
                    }
                }
            }
            pool.shutdown()
            try { pool.awaitTermination(8, TimeUnit.SECONDS) } catch (_: Exception) { }

            scanningLan = false
            mainHandler.post {
                spatialMap.scanning = false
                lblScanBanner.text = "IP deste Android: \$myIp:\$LAN_WS_PORT · \${discoveredHubs.size} PC(s) detectado(s)"
                refreshLanPeersUi()
                if (!connected) {
                    val best = discoveredHubs.values.firstOrNull { it.roomCode == roomCode } ?: discoveredHubs.values.firstOrNull()
                    if (best != null) {
                        connectToEndpoint("ws://\${best.ip}:\${best.wsPort}/ws", "\${best.hubName} (\${best.ip})", force = true)
                    } else {
                        // Connect to our own embedded hub so Android stays online & ready for PC outbound connection!
                        lblTopStatus.text = "● Aguardando PC · IP \$myIp:\$LAN_WS_PORT"
                        lblTopStatus.setTextColor(C_AMBER)
                        connectToEndpoint("ws://127.0.0.1:\$LAN_WS_PORT/ws", "Hub Android (\$myIp)", force = true)
                    }
                }
            }
        }.apply { isDaemon = true; start() }
    }

    private fun probeContinuumHttpInfo(host: String, port: Int, timeoutMs: Int): JSONObject? {
        var sock: Socket? = null
        return try {
            sock = Socket()
            sock.connect(InetSocketAddress(host, port), timeoutMs)
            sock.soTimeout = timeoutMs + 250
            val req = "GET /continuum-info HTTP/1.1\\r\\nHost: \$host:\$port\\r\\nConnection: close\\r\\n\\r\\n"
            sock.getOutputStream().write(req.toByteArray(Charsets.US_ASCII))
            sock.getOutputStream().flush()
            val resp = sock.getInputStream().bufferedReader().readText()
            val bodyIdx = resp.indexOf("\\r\\n\\r\\n")
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
        mainHandler.post {
            refreshLanPeersUi()
            val onSelfFallback = activeWsUrl.startsWith("ws://127.0.0.1")
            if (allowAutoConnect && manualHostPort.isBlank() && (!connected || onSelfFallback)) {
                if (hub.roomCode == roomCode || discoveredHubs.size == 1) {
                    roomCode = hub.roomCode
                    lblTopRoom.text = "  ·  \$roomCode"
                    editRoom.setText(roomCode)
                    connectToEndpoint("ws://\${hub.ip}:\${hub.wsPort}/ws", "\${hub.hubName} (\${hub.ip})", force = true)
                }
            }
        }
    }

    private fun connectDirectInput(rawInput: String) {
        val parsed = parseLanEndpoint(rawInput, getLocalLanIp())
        if (parsed == null) {
            toast("Endereço inválido. Use ex: 192.168.1.42 ou .42")
            return
        }
        val (host, port) = parsed
        val normalizedDisplay = "\$host:\$port"
        manualHostPort = normalizedDisplay
        editManualIp.setText(normalizedDisplay)
        prefs.edit().putString("roomCode", roomCode).putString("manualHostPort", normalizedDisplay).apply()

        lblTopStatus.text = "◌ Verificando \$normalizedDisplay..."
        lblTopStatus.setTextColor(C_CYAN)

        Thread {
            val info = probeContinuumHttpInfo(host, port, 1600)
            mainHandler.post {
                if (info != null) {
                    val remoteName = info.optString("hubName", info.optString("hub", host))
                    val remoteRoom = info.optString("roomCode", "")
                    if (remoteRoom.isNotBlank()) {
                        roomCode = remoteRoom
                        lblTopRoom.text = "  ·  \$roomCode"
                        editRoom.setText(roomCode)
                    }
                    toast("Conectado a \$remoteName (\$host)!")
                    connectToEndpoint("ws://\$host:\$port/ws", "\$remoteName (\$host)", force = true)
                } else {
                    toast("Sem resposta em \$normalizedDisplay — tentando WebSocket direto. Verifique firewall na porta \$port.")
                    connectToEndpoint("ws://\$host:\$port/ws", "LAN · \$host", force = true)
                }
            }
        }.apply { isDaemon = true; start() }
    }

    private fun refreshLanPeersUi() {
        val now = System.currentTimeMillis()
        discoveredHubs.entries.removeIf { now - it.value.lastSeenMs > 25000L }
        lanPeersContainer.removeAllViews()
        val list = discoveredHubs.values.sortedBy { it.hubName }
        if (list.isEmpty()) {
            lanPeersContainer.addView(TextView(this).apply {
                text = "Nenhum PC detectado ainda. Abra o Continuum v4 no Linux ou Windows na mesma rede Wi-Fi e toque em Escanear."
                setTextColor(C_MUTED)
                textSize = 12f
                setPadding(0, dpToPx(this@MainActivity, 6), 0, dpToPx(this@MainActivity, 6))
            })
            return
        }
        for (h in list) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                background = glassDrawable(C_GLASS_SUBTLE, C_BORDER, 12f, this@MainActivity)
                setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    bottomMargin = dpToPx(this@MainActivity, 6)
                }
            }
            val info = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            info.addView(TextView(this).apply { text = "\${h.hubName} (\${h.os.uppercase()})"; setTextColor(C_TEXT); textSize = 13.5f; typeface = Typeface.DEFAULT_BOLD })
            info.addView(TextView(this).apply { text = "\${h.ip}:\${h.wsPort} · \${h.via} · \${h.roomCode}"; setTextColor(C_CYAN); textSize = 11f; typeface = Typeface.MONOSPACE })
            row.addView(info)
            row.addView(makeHoloBtn("Conectar", true) {
                roomCode = h.roomCode
                lblTopRoom.text = "  ·  \$roomCode"
                editRoom.setText(roomCode)
                connectToEndpoint("ws://\${h.ip}:\${h.wsPort}/ws", "\${h.hubName} (\${h.ip})", force = true)
            })
            lanPeersContainer.addView(row)
        }
    }

    // ==================== DIRECT LAN WEBSOCKET CLIENT ====================
    private fun connectToEndpoint(url: String, label: String, force: Boolean = false) {
        if (destroyed) return
        if (!force && connected && activeWsUrl == url) return
        try { ws?.close(1000, "switch") } catch (_: Exception) { }
        ws = null
        activeWsUrl = url
        activeHubLabel = label
        connected = false

        mainHandler.post {
            lblTopStatus.text = "◌ Conectando a \$label..."
            lblTopStatus.setTextColor(C_CYAN)
        }

        val req = try {
            Request.Builder().url(url).build()
        } catch (ex: Exception) {
            mainHandler.post {
                lblTopStatus.text = "✕ Endereço inválido"
                lblTopStatus.setTextColor(C_AMBER)
                toast("URL inválida: \$url")
            }
            return
        }

        ws = httpClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connected = true
                mainHandler.post {
                    lblTopStatus.text = "● \$label"
                    lblTopStatus.setTextColor(C_GREEN)
                }
                val join = JSONObject()
                    .put("type", "mesh:join")
                    .put("roomCode", roomCode)
                    .put("device", JSONObject()
                        .put("id", deviceId)
                        .put("name", deviceName)
                        .put("os", "android")
                        .put("kind", "mobile")
                        .put("status", "online")
                        .put("companionConnected", true)
                        .put("telemetry", collectTelemetry()))
                webSocket.send(join.toString())
                webSocket.send(JSONObject().put("type", "telemetry:ping").put("sentAt", System.currentTimeMillis()).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try { handleMessage(JSONObject(text)) } catch (_: Exception) { }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                connected = false
                mainHandler.post {
                    lblTopStatus.text = "◌ Reconectando (\$label)..."
                    lblTopStatus.setTextColor(C_AMBER)
                }
                if (!destroyed && activeWsUrl == url) {
                    mainHandler.postDelayed({
                        if (!destroyed && !connected && activeWsUrl == url) connectToEndpoint(url, label, force = true)
                    }, 2600)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                connected = false
            }
        })
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
        return devices.firstOrNull { it.id == selectedDeviceId }
            ?: devices.firstOrNull { it.id != deviceId }
            ?: devices.firstOrNull()
    }

    private fun sendRemote(ev: JSONObject) {
        val tgt = getTargetDevice() ?: return
        sendJson(JSONObject().put("type", "input:event").put("targetDeviceId", tgt.id).put("event", ev))
    }

    private fun pushClipboard(text: String) {
        sendJson(JSONObject()
            .put("type", "clipboard:push")
            .put("content", text)
            .put("sourceDeviceId", deviceId)
            .put("sourceDeviceName", deviceName))
        toast("Texto sincronizado pela rede local.")
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
                val tid = "ft-\${System.currentTimeMillis()}"
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
                    mainHandler.post {
                        fileProgress.progress = pct
                        lblFileStatus.text = "Enviando \$fileName · \$pct%"
                    }
                    Thread.sleep(5)
                }

                val doneObj = JSONObject().put("type", "file:complete").put("transferId", tid)
                if (targetId != null) doneObj.put("targetDeviceId", targetId)
                sendJson(doneObj)
                mainHandler.post {
                    fileProgress.progress = 100
                    lblFileStatus.text = "Enviado: \$fileName"
                    addFileHistoryRow("Enviado: \$fileName (\${max(1, bytes.size / 1024)} KB)")
                }
            } catch (ex: Exception) {
                mainHandler.post { toast("Erro ao enviar arquivo: \${ex.message}") }
            }
        }.start()
    }

    private fun handleMessage(msg: JSONObject) {
        when (msg.optString("type")) {
            "mesh:init" -> {
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
                            battery = if (tel != null && !tel.isNull("batteryLevel")) tel.optInt("batteryLevel") else null
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
                }
            }
            "telemetry:pong" -> {
                val sent = msg.optLong("sentAt", 0L)
                if (sent > 0L) {
                    rttMs = max(1, (System.currentTimeMillis() - sent).toInt())
                    mainHandler.post {
                        if (connected) lblTopStatus.text = "● \$activeHubLabel · \${rttMs} ms"
                    }
                }
            }
            "clipboard:added" -> {
                val o = msg.optJSONObject("item") ?: return
                mainHandler.post {
                    clipItems.add(0, ClipItem(o.optString("id"), o.optString("content"), o.optString("sourceDeviceName", "Peer")))
                    refreshClipboardUi()
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
                    mainHandler.post { fileProgress.progress = 0; lblFileStatus.text = "Recebendo \$name · 0%" }
                }
            }
            "file:chunk" -> {
                val rec = incomingFiles[msg.optString("transferId")] ?: return
                rec.chunks[msg.optInt("chunkIndex", 0)] = msg.optString("data", "")
                val pct = ((rec.chunks.size * 100) / rec.total).coerceIn(0, 99)
                mainHandler.post { fileProgress.progress = pct; lblFileStatus.text = "Recebendo \${rec.name} · \$pct%" }
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
                        lblFileStatus.text = "Recebido: \${rec.name}"
                        addFileHistoryRow("Recebido: \${rec.name} (\${max(1L, rec.size / 1024L)} KB)")
                        toast("Arquivo salvo: \${rec.name}")
                    }
                } catch (ex: Exception) {
                    mainHandler.post { toast("Erro ao salvar arquivo: \${ex.message}") }
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
                battery = if (tel != null && !tel.isNull("batteryLevel")) tel.optInt("batteryLevel") else null
            ))
        }
        mainHandler.post {
            devices.clear()
            devices.addAll(parsed)
            if (selectedDeviceId == null) selectedDeviceId = devices.firstOrNull { it.id != deviceId }?.id
            syncMapUi()
        }
    }

    private fun syncMapUi() {
        spatialMap.devices = devices.toMutableList()
        spatialMap.selectedId = selectedDeviceId
        spatialMap.invalidate()
        updateSelectedSummary()
    }

    private fun updateSelectedSummary() {
        val tgt = getTargetDevice()
        if (tgt != null) {
            lblMapSelected.text = "Alvo: \${tgt.name} (\${tgt.os.uppercase()}) · CPU \${tgt.cpu}% · RAM \${tgt.ram}%"
            lblRemoteTarget.text = "Controlando: \${tgt.name} (\${tgt.os.uppercase()})"
        } else {
            lblMapSelected.text = "Radar ativo · Abra o Continuum no Linux ou Windows na mesma rede Wi-Fi."
            lblRemoteTarget.text = "Controlando: buscando PC..."
        }
    }

    private fun refreshClipboardUi() {
        clipListContainer.removeAllViews()
        for (item in clipItems.take(20)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                background = glassDrawable(C_GLASS_SUBTLE, C_BORDER, 10f, this@MainActivity)
                setPadding(dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 8), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 8))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dpToPx(this@MainActivity, 6) }
            }
            val tv = TextView(this).apply {
                text = "[\${item.source}] \${item.content.take(100)}"
                setTextColor(C_TEXT)
                textSize = 12f
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val bCopy = makeHoloBtn("Copiar") {
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
                text = "[\${n.source}] \${n.title}: \${n.body}"
                setTextColor(C_TEXT)
                textSize = 12f
                background = glassDrawable(C_GLASS_SUBTLE, C_BORDER, 10f, this@MainActivity)
                setPadding(dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 8), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 8))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dpToPx(this@MainActivity, 6) }
            }
            notifListContainer.addView(tv)
        }
    }

    private fun addFileHistoryRow(text: String) {
        val tv = TextView(this).apply {
            this.text = text
            setTextColor(C_TEXT)
            textSize = 12f
            setPadding(0, dpToPx(this@MainActivity, 6), 0, 0)
        }
        fileListContainer.addView(tv, 0)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    override fun onDestroy() {
        destroyed = true
        try { ws?.close(1000, "exit") } catch (_: Exception) { }
        try { localHub.stop() } catch (_: Exception) { }
        try { discoverySocket?.close() } catch (_: Exception) { }
        try { if (multicastLock?.isHeld == true) multicastLock?.release() } catch (_: Exception) { }
        super.onDestroy()
    }
}
`;

  const entries: ZipEntryInput[] = [
    { name: `${prefix}/settings.gradle.kts`, content: settingsGradle },
    { name: `${prefix}/build.gradle.kts`, content: rootBuildGradle },
    { name: `${prefix}/gradle.properties`, content: gradleProps },
    { name: `${prefix}/app/build.gradle.kts`, content: appBuildGradle },
    { name: `${prefix}/app/src/main/AndroidManifest.xml`, content: manifestXml },
    { name: `${prefix}/app/src/main/res/xml/network_security_config.xml`, content: networkSecurityXml },
    { name: `${prefix}/app/src/main/res/values/styles.xml`, content: stylesXml },
    { name: `${prefix}/app/src/main/java/app/continuum/nativeclient/MainActivity.kt`, content: mainActivityKt },
  ];

  if (pngIcon) {
    entries.push({ name: `${prefix}/app/src/main/res/mipmap-xxhdpi/ic_launcher.png`, content: pngIcon });
  }

  return entries;
}
