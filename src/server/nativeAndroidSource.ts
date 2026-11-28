import type { InstallerContext } from './platformInstallers.ts';
import type { ZipEntryInput } from './zipBuilder.ts';

function safeStr(val: string): string {
  return val.replace(/[`'"\\$<>|;&\r\n]/g, '');
}

/**
 * 100% NATIVE ANDROID KOTLIN APPLICATION v3.0.0 (ZERO WebView, ZERO Browser)
 * - Automatic Wi-Fi LAN UDP Discovery (UDP 45890 with WifiManager.MulticastLock)
 * - Direct App-to-App LAN WebSocket (ws://<pc-lan-ip>:45891/ws, usesCleartextTraffic=true)
 * - Custom Canvas Interactive Spatial Device Map (touch drag-and-drop synced live with Linux & Windows)
 * - Custom Canvas Tactile Multi-Touch Trackpad (dot-grid, glowing touch reticle & ripple rings)
 * - Live LAN File Transfer with progress bar + ClipboardManager universal sync + Alerts
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
        versionCode = 3
        versionName = "3.0.0"

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
        <item name="colorPrimary">#3B82F6</item>
        <item name="colorPrimaryVariant">#1D4ED8</item>
        <item name="colorOnPrimary">#FFFFFF</item>
        <item name="colorSecondary">#10B981</item>
        <item name="android:windowBackground">#090B0E</item>
        <item name="android:statusBarColor">#090B0E</item>
        <item name="android:navigationBarColor">#0F1319</item>
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
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
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
import java.io.File
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

private const val LAN_UDP_PORT = 45890
private const val LAN_WS_PORT = 45891
private const val PROTO_TAG = "continuum-lan-v3"

private val C_BG = Color.parseColor("#090B0E")
private val C_SURFACE = Color.parseColor("#0F1319")
private val C_CARD = Color.parseColor("#11161E")
private val C_SUBTLE = Color.parseColor("#171D26")
private val C_BORDER = Color.parseColor("#222B3A")
private val C_ACCENT = Color.parseColor("#3B82F6")
private val C_GREEN = Color.parseColor("#10B981")
private val C_AMBER = Color.parseColor("#F59E0B")
private val C_TEXT = Color.parseColor("#F1F5F9")
private val C_MUTED = Color.parseColor("#94A3B8")

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
    val lastSeenMs: Long
)

data class ClipItem(val id: String, val content: String, val source: String)
data class NotifItem(val id: String, val title: String, val body: String, val source: String)

private fun dpToPx(ctx: Context, dp: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp.toFloat(), ctx.resources.displayMetrics).toInt()

private fun roundedBg(fill: Int, stroke: Int = 0, radiusDp: Float = 12f, ctx: Context): GradientDrawable {
    return GradientDrawable().apply {
        setColor(fill)
        cornerRadius = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, radiusDp, ctx.resources.displayMetrics)
        if (stroke != 0) setStroke(dpToPx(ctx, 1), stroke)
    }
}

// ---------------------------------------------------------------------------
// Custom Interactive Spatial Device Map View (Touch Drag-and-Drop Synced Live)
// ---------------------------------------------------------------------------
class SpatialMapView(context: Context) : View(context) {
    var devices: MutableList<MeshDevice> = mutableListOf()
    var selfId: String = ""
    var selectedId: String? = null
    var onSelect: ((MeshDevice) -> Unit)? = null
    var onMoved: ((String, Float, Float) -> Unit)? = null

    private val density = context.resources.displayMetrics.density
    private val nodeW = 168f * density
    private val nodeH = 92f * density
    private var dragId: String? = null
    private var dragOffX = 0f
    private var dragOffY = 0f

    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(55, 89, 112, 153) }
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.6f * density }
    private val cardPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_TEXT; textSize = 12.5f * density; typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) }
    private val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_MUTED; textSize = 10f * density }
    private val monoPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_MUTED; textSize = 9.5f * density; typeface = Typeface.MONOSPACE }
    private val barBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#1D2533") }
    private val barCpuPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_ACCENT }
    private val barRamPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_GREEN }
    private val dotOnlinePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = C_GREEN }

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

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(Color.parseColor("#0A0D12"))

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

        if (devices.isEmpty()) {
            subPaint.textAlign = Paint.Align.CENTER
            canvas.drawText("Buscando Linux/Windows na rede Wi-Fi (UDP 45890)...", width / 2f, height / 2f, subPaint)
            subPaint.textAlign = Paint.Align.LEFT
            return
        }

        val anchor = devices.firstOrNull { it.id == selfId } ?: devices.first()
        val (ax, ay) = screenPos(anchor)
        for (d in devices) {
            if (d.id == anchor.id) continue
            val (dx, dy) = screenPos(d)
            val isSel = d.id == selectedId
            linePaint.color = if (isSel) Color.argb(200, 59, 130, 246) else Color.argb(110, 72, 92, 125)
            linePaint.strokeWidth = (if (isSel) 2.2f else 1.4f) * density
            val p = Path()
            val mx = (ax + dx) / 2f
            p.moveTo(ax, ay)
            p.cubicTo(mx, ay, mx, dy, dx, dy)
            canvas.drawPath(p, linePaint)
        }

        val rCorner = 12f * density
        for (d in devices) {
            val r = nodeRect(d)
            val isSelf = d.id == selfId
            val isSel = d.id == selectedId
            cardPaint.color = if (isSel) Color.parseColor("#182131") else Color.parseColor("#131820")
            canvas.drawRoundRect(r, rCorner, rCorner, cardPaint)

            borderPaint.color = when {
                isSel -> C_ACCENT
                isSelf -> C_GREEN
                else -> C_BORDER
            }
            borderPaint.strokeWidth = (if (isSel) 2f else 1.1f) * density
            canvas.drawRoundRect(r, rCorner, rCorner, borderPaint)

            canvas.drawCircle(r.left + 14f * density, r.top + 18f * density, 3.8f * density, dotOnlinePaint)
            val title = if (d.name.length > 17) d.name.substring(0, 17) else d.name
            canvas.drawText(title, r.left + 24f * density, r.top + 22f * density, textPaint)

            val role = if (isSelf) "Este Celular" else if (isSel) "Alvo" else "LAN"
            val bat = if (d.battery != null) " · \${d.battery}%" else ""
            canvas.drawText("\${d.os.uppercase()} · \$role\$bat", r.left + 12f * density, r.top + 38f * density, subPaint)

            val barX = r.left + 62f * density
            val barW = r.width() - 74f * density
            val barH = 5f * density

            canvas.drawText("CPU \${d.cpu}%", r.left + 12f * density, r.top + 59f * density, monoPaint)
            canvas.drawRoundRect(RectF(barX, r.top + 53f * density, barX + barW, r.top + 53f * density + barH), 3f * density, 3f * density, barBgPaint)
            if (d.cpu > 0) {
                val fw = max(4f * density, barW * min(100, d.cpu) / 100f)
                canvas.drawRoundRect(RectF(barX, r.top + 53f * density, barX + fw, r.top + 53f * density + barH), 3f * density, 3f * density, barCpuPaint)
            }

            canvas.drawText("RAM \${d.ram}%", r.left + 12f * density, r.top + 77f * density, monoPaint)
            canvas.drawRoundRect(RectF(barX, r.top + 71f * density, barX + barW, r.top + 71f * density + barH), 3f * density, 3f * density, barBgPaint)
            if (d.ram > 0) {
                val fw = max(4f * density, barW * min(100, d.ram) / 100f)
                canvas.drawRoundRect(RectF(barX, r.top + 71f * density, barX + fw, r.top + 71f * density + barH), 3f * density, 3f * density, barRamPaint)
            }
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                for (i in devices.indices.reversed()) {
                    val d = devices[i]
                    val r = nodeRect(d)
                    if (r.contains(event.x, event.y)) {
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
// Custom Multi-Touch Tactile Trackpad (Dot-Grid + Glowing Reticle + Ripples)
// ---------------------------------------------------------------------------
class NativeTrackpadView(
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

    private data class Ripple(val x: Float, val y: Float, val t0: Long)
    private val ripples = mutableListOf<Ripple>()

    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(60, 89, 112, 153) }
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(145, 148, 163, 184); textSize = 12f * density; textAlign = Paint.Align.CENTER }
    private val ripplePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * density }
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(65, 59, 130, 246) }
    private val corePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#60A5FA") }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(Color.parseColor("#0B0E14"))

        val step = (22f * density).toInt().coerceAtLeast(22)
        var gx = step
        while (gx < width) {
            var gy = step
            while (gy < height) {
                canvas.drawCircle(gx.toFloat(), gy.toFloat(), 1f * density, dotPaint)
                gy += step
            }
            gx += step
        }

        canvas.drawText("1 dedo: mover & toque esquerdo · 2 dedos: scroll & toque direito", width / 2f, height / 2f, hintPaint)

        val now = SystemClock.uptimeMillis()
        val iter = ripples.iterator()
        while (iter.hasNext()) {
            val rp = iter.next()
            val age = now - rp.t0
            if (age > 420L) {
                iter.remove()
            } else {
                val p = age / 420f
                ripplePaint.color = Color.argb(((1f - p) * 200).toInt().coerceIn(0, 255), 59, 130, 246)
                canvas.drawCircle(rp.x, rp.y, (12f + p * 44f) * density, ripplePaint)
            }
        }

        if (touchX >= 0f && touchY >= 0f) {
            canvas.drawCircle(touchX, touchY, 22f * density, glowPaint)
            canvas.drawCircle(touchX, touchY, 6f * density, corePaint)
        }

        if (ripples.isNotEmpty()) postInvalidateOnAnimation()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastX = event.x
                lastY = event.y
                touchX = event.x
                touchY = event.y
                moved = false
                twoFinger = false
                downTime = SystemClock.uptimeMillis()
                ripples.add(Ripple(event.x, event.y, downTime))
                invalidate()
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                twoFinger = event.pointerCount >= 2
                lastX = event.x
                lastY = event.y
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = event.x - lastX
                val dy = event.y - lastY
                lastX = event.x
                lastY = event.y
                touchX = event.x
                touchY = event.y
                if (abs(dx) > 1.2f || abs(dy) > 1.2f) {
                    moved = true
                    if (twoFinger || event.pointerCount >= 2) {
                        onScroll(dy * 2.4f)
                    } else {
                        onMove(dx * 1.9f, dy * 1.9f)
                    }
                }
                invalidate()
            }
            MotionEvent.ACTION_UP -> {
                val elapsed = SystemClock.uptimeMillis() - downTime
                if (!moved && elapsed < 260L) {
                    onClick(if (twoFinger) "right" else "left")
                    ripples.add(Ripple(event.x, event.y, SystemClock.uptimeMillis()))
                }
                touchX = -1f
                touchY = -1f
                twoFinger = false
                invalidate()
            }
            MotionEvent.ACTION_CANCEL -> {
                touchX = -1f
                touchY = -1f
                invalidate()
            }
        }
        return true
    }
}

// ---------------------------------------------------------------------------
// Main Continuum v3.0 Native Android Activity (Direct LAN P2P Mesh)
// ---------------------------------------------------------------------------
class MainActivity : AppCompatActivity() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val httpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    private val prefs by lazy { getSharedPreferences("continuum_lan_v3", Context.MODE_PRIVATE) }
    private val deviceName by lazy { "\${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} \${Build.MODEL}" }
    private val deviceId by lazy {
        val clean = Build.MODEL.lowercase().replace(Regex("[^a-z0-9]"), "").take(12).ifEmpty { "android" }
        "android-app-\$clean-\${(System.currentTimeMillis() % 8999) + 1000}"
    }

    private var roomCode: String = BuildConfig.DEFAULT_ROOM_CODE
    private var manualLanHost: String = ""
    private var activeWsUrl: String = ""
    private var activeHubLabel: String = ""
    private var ws: WebSocket? = null
    private var connected = false
    private var rttMs: Int? = null
    private var destroyed = false
    private var selectedDeviceId: String? = null

    private val devices = mutableListOf<MeshDevice>()
    private val discoveredHubs = ConcurrentHashMap<String, DiscoveredLanHub>()
    private val clipItems = mutableListOf<ClipItem>()
    private val notifItems = mutableListOf<NotifItem>()
    private val incomingFiles = ConcurrentHashMap<String, IncomingFile>()

    private var multicastLock: WifiManager.MulticastLock? = null
    private var discoverySocket: DatagramSocket? = null
    private var discoveryThread: Thread? = null

    // UI Elements
    private lateinit var lblTopStatus: TextView
    private lateinit var lblTopRoom: TextView
    private lateinit var spatialMap: SpatialMapView
    private lateinit var lblMapSelected: TextView
    private lateinit var lblRemoteTarget: TextView
    private lateinit var fileProgress: ProgressBar
    private lateinit var lblFileStatus: TextView
    private lateinit var fileListContainer: LinearLayout
    private lateinit var clipListContainer: LinearLayout
    private lateinit var lanPeersContainer: LinearLayout
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
        manualLanHost = prefs.getString("manualLanHost", "") ?: ""

        setContentView(buildRootUi())
        switchTab("map")
        startUdpDiscovery()
        startTelemetryHeartbeat()

        if (manualLanHost.isNotBlank()) {
            connectToEndpoint(normalizeWs(manualLanHost), "LAN · \$manualLanHost")
        }
    }

    private fun normalizeWs(raw: String): String {
        val s = raw.trim()
        if (s.startsWith("ws://") || s.startsWith("wss://")) {
            val idx = s.indexOf("://")
            return if (s.indexOf('/', idx + 3) < 0) "\$s/ws" else s
        }
        return if (s.contains(':')) "ws://\$s/ws" else "ws://\$s:\$LAN_WS_PORT/ws"
    }

    private fun buildRootUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(C_BG)
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }

        // ==================== COMPACT 54dp TOP BAR ====================
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(C_SURFACE)
            setPadding(dpToPx(this@MainActivity, 16), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 16), dpToPx(this@MainActivity, 10))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 54))
        }
        val brandCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        brandCol.addView(TextView(this).apply {
            text = "Continuum"
            setTextColor(C_TEXT)
            textSize = 16f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        })
        lblTopStatus = TextView(this).apply {
            text = "● Buscando Linux/Windows no Wi-Fi..."
            setTextColor(C_AMBER)
            textSize = 11.5f
        }
        brandCol.addView(lblTopStatus)
        topBar.addView(brandCol)

        lblTopRoom = TextView(this).apply {
            text = "MALHA \$roomCode"
            setTextColor(C_MUTED)
            textSize = 11.5f
            typeface = Typeface.MONOSPACE
        }
        topBar.addView(lblTopRoom)
        root.addView(topBar)

        root.addView(View(this).apply {
            setBackgroundColor(C_BORDER)
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

        // ==================== 60dp BOTTOM NAVIGATION BAR ====================
        root.addView(View(this).apply {
            setBackgroundColor(C_BORDER)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 1))
        })
        val bottomNav = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(C_SURFACE)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 58))
        }
        val tabs = listOf("map" to "Mapa", "remote" to "Trackpad", "transfer" to "Arquivos", "network" to "Rede LAN")
        for ((key, title) in tabs) {
            val item = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
                setOnClickListener { switchTab(key) }
            }
            val indicator = View(this).apply {
                tag = "ind"
                setBackgroundColor(Color.TRANSPARENT)
                layoutParams = LinearLayout.LayoutParams(dpToPx(this@MainActivity, 28), dpToPx(this@MainActivity, 3)).apply {
                    bottomMargin = dpToPx(this@MainActivity, 6)
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
        root.addView(bottomNav)
        return root
    }

    private fun switchTab(key: String) {
        tabPanels.forEach { (k, v) -> v.visibility = if (k == key) View.VISIBLE else View.GONE }
        navBtns.forEach { (k, box) ->
            val active = k == key
            box.findViewWithTag<View>("ind")?.setBackgroundColor(if (active) C_ACCENT else Color.TRANSPARENT)
            box.findViewWithTag<TextView>("lbl")?.setTextColor(if (active) C_TEXT else C_MUTED)
        }
    }

    private fun makeBtn(label: String, primary: Boolean = false, onClick: () -> Unit): Button {
        return Button(this).apply {
            text = label
            isAllCaps = false
            setTextColor(if (primary) Color.WHITE else C_TEXT)
            textSize = 12.5f
            background = roundedBg(if (primary) C_ACCENT else C_SUBTLE, if (primary) 0 else C_BORDER, 9f, this@MainActivity)
            minHeight = dpToPx(this@MainActivity, 44)
            minimumHeight = dpToPx(this@MainActivity, 44)
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 6), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 6))
            setOnClickListener { onClick() }
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
            background = roundedBg(Color.parseColor("#0B0E14"), C_BORDER, 8f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10))
        }
    }

    // ==================== TAB 1: SPATIAL MAP ====================
    private fun buildMapTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 12))
        }
        spatialMap = SpatialMapView(this).apply {
            selfId = deviceId
            background = roundedBg(Color.parseColor("#0A0D12"), C_BORDER, 12f, this@MainActivity)
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
            background = roundedBg(C_CARD, C_BORDER, 12f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dpToPx(this@MainActivity, 10)
            }
        }
        lblMapSelected = TextView(this).apply {
            text = "Toque em um PC no mapa ou arraste para reorganizar."
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
        val bCtrl = makeBtn("Trackpad", true) { switchTab("remote") }
        val bPing = makeBtn("Localizar") { sendRemote(JSONObject().put("kind", "media").put("action", "ping")) }
        val bFile = makeBtn("Arquivo") { filePicker.launch(arrayOf("*/*")) }
        listOf(bCtrl, bPing, bFile).forEachIndexed { i, b ->
            actRow.addView(b, LinearLayout.LayoutParams(0, dpToPx(this, 44), 1f).apply { if (i > 0) leftMargin = dpToPx(this@MainActivity, 6) })
        }
        selCard.addView(actRow)
        box.addView(selCard)
        return box
    }

    // ==================== TAB 2: MULTI-TOUCH TRACKPAD ====================
    private fun buildRemoteTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 10))
        }
        lblRemoteTarget = TextView(this).apply {
            text = "Controlando: conecte a um Linux/Windows na aba Rede LAN"
            setTextColor(C_TEXT)
            textSize = 13f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            setPadding(0, 0, 0, dpToPx(this@MainActivity, 8))
        }
        box.addView(lblRemoteTarget)

        val pad = NativeTrackpadView(
            this,
            onMove = { dx, dy -> sendRemote(JSONObject().put("kind", "move").put("dx", dx.toDouble()).put("dy", dy.toDouble())) },
            onClick = { btn -> sendRemote(JSONObject().put("kind", "click").put("button", btn)) },
            onScroll = { dy -> sendRemote(JSONObject().put("kind", "scroll").put("dx", 0).put("dy", dy.toDouble())) }
        ).apply {
            background = roundedBg(Color.parseColor("#0B0E14"), C_BORDER, 14f, this@MainActivity)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        box.addView(pad)

        // Thumb-friendly 2 rows of OS actions
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
            r1.addView(makeBtn(lbl, false, fn), LinearLayout.LayoutParams(0, dpToPx(this, 44), 1f).apply { if (idx > 0) leftMargin = dpToPx(this@MainActivity, 5) })
        }
        box.addView(r1)

        val kbRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dpToPx(this@MainActivity, 8)
            }
        }
        val txtInput = makeInput("Digitar no PC alvo...")
        val btnSend = makeBtn("Enviar", true) {
            val t = txtInput.text.toString()
            if (t.isNotEmpty()) {
                sendRemote(JSONObject().put("kind", "text").put("text", t))
                txtInput.setText("")
            }
        }
        val btnEnter = makeBtn("Enter") { sendRemote(JSONObject().put("kind", "key").put("key", "Enter")) }
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

        // Files Card
        val fCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBg(C_CARD, C_BORDER, 12f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12))
        }
        fCard.addView(TextView(this).apply { text = "Transferência Direta LAN"; setTextColor(C_TEXT); textSize = 15f; typeface = Typeface.DEFAULT_BOLD })
        fCard.addView(makeBtn("Escolher e Enviar Arquivo", true) { filePicker.launch(arrayOf("*/*")) }.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this@MainActivity, 46)).apply { topMargin = dpToPx(this@MainActivity, 8) }
        })
        lblFileStatus = TextView(this).apply {
            text = "Pronto para enviar/receber em velocidade Wi-Fi"
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

        // Clipboard Card
        val cCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBg(C_CARD, C_BORDER, 12f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dpToPx(this@MainActivity, 12) }
        }
        cCard.addView(TextView(this).apply { text = "Área de Transferência Universal"; setTextColor(C_TEXT); textSize = 15f; typeface = Typeface.DEFAULT_BOLD })
        val cRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dpToPx(this@MainActivity, 8) }
        }
        val editClip = makeInput("Texto para enviar aos PCs...")
        val bPush = makeBtn("Enviar", true) {
            val t = editClip.text.toString().trim()
            if (t.isNotEmpty()) { pushClipboard(t); editClip.setText("") }
        }
        val bGrab = makeBtn("Colar") {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val txt = cm.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()
            if (!txt.isNullOrBlank()) pushClipboard(txt) else toast("Clipboard vazio.")
        }
        cRow.addView(editClip, LinearLayout.LayoutParams(0, dpToPx(this, 44), 1f))
        cRow.addView(bPush, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dpToPx(this, 44)).apply { leftMargin = dpToPx(this@MainActivity, 6) })
        cRow.addView(bGrab, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dpToPx(this, 44)).apply { leftMargin = dpToPx(this@MainActivity, 6) })
        cCard.addView(cRow)

        clipListContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dpToPx(this@MainActivity, 8), 0, 0)
        }
        cCard.addView(clipListContainer)
        col.addView(cCard)

        scroll.addView(col)
        return scroll
    }

    // ==================== TAB 4: LAN DISCOVERY & ALERTS ====================
    private fun buildNetworkTab(): View {
        val scroll = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 16))
        }

        val lanCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBg(C_CARD, C_BORDER, 12f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12))
        }
        lanCard.addView(TextView(this).apply { text = "PCs Continuum no Mesmo Wi-Fi (Direto)"; setTextColor(C_TEXT); textSize = 15f; typeface = Typeface.DEFAULT_BOLD })
        lanCard.addView(TextView(this).apply {
            text = "Conecta diretamente ao Linux ou Windows na rede local (UDP 45890 / TCP 45891) — sem depender do app web."
            setTextColor(C_MUTED)
            textSize = 12f
            setPadding(0, dpToPx(this@MainActivity, 4), 0, dpToPx(this@MainActivity, 8))
        })

        lanPeersContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        lanCard.addView(lanPeersContainer)

        lanCard.addView(TextView(this).apply {
            text = "Conexão Manual por IP da Rede Local"
            setTextColor(C_MUTED)
            textSize = 12f
            setPadding(0, dpToPx(this@MainActivity, 12), 0, dpToPx(this@MainActivity, 6))
        })
        editRoom = makeInput("Código da Malha (ex: MESH01)", roomCode).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        lanCard.addView(editRoom, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this, 44)))

        editManualIp = makeInput("IP do PC (ex: 192.168.1.42:45891)", manualLanHost)
        lanCard.addView(editManualIp, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpToPx(this, 44)).apply { topMargin = dpToPx(this@MainActivity, 8) })

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dpToPx(this@MainActivity, 8) }
        }
        val bConn = makeBtn("Conectar Direto", true) {
            roomCode = editRoom.text.toString().uppercase().replace(Regex("[^A-Z0-9]"), "").take(12).ifEmpty { BuildConfig.DEFAULT_ROOM_CODE }
            manualLanHost = editManualIp.text.toString().trim()
            prefs.edit().putString("roomCode", roomCode).putString("manualLanHost", manualLanHost).apply()
            lblTopRoom.text = "MALHA \$roomCode"
            if (manualLanHost.isNotEmpty()) {
                connectToEndpoint(normalizeWs(manualLanHost), "LAN · \$manualLanHost")
            } else {
                val match = discoveredHubs.values.firstOrNull { it.roomCode == roomCode } ?: discoveredHubs.values.firstOrNull()
                if (match != null) connectToEndpoint("ws://\${match.ip}:\${match.wsPort}/ws", "\${match.hubName} (\${match.ip})")
                else toast("Aguardando PC na rede Wi-Fi...")
            }
        }
        val bAuto = makeBtn("Auto Wi-Fi") {
            manualLanHost = ""
            editManualIp.setText("")
            prefs.edit().putString("manualLanHost", "").apply()
            val match = discoveredHubs.values.firstOrNull { it.roomCode == roomCode } ?: discoveredHubs.values.firstOrNull()
            if (match != null) connectToEndpoint("ws://\${match.ip}:\${match.wsPort}/ws", "\${match.hubName} (\${match.ip})")
            else toast("Buscando Hubs no Wi-Fi...")
        }
        btnRow.addView(bConn, LinearLayout.LayoutParams(0, dpToPx(this, 46), 1f))
        btnRow.addView(bAuto, LinearLayout.LayoutParams(0, dpToPx(this, 46), 1f).apply { leftMargin = dpToPx(this@MainActivity, 8) })
        lanCard.addView(btnRow)
        col.addView(lanCard)

        // Alerts Card
        val aCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBg(C_CARD, C_BORDER, 12f, this@MainActivity)
            setPadding(dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12), dpToPx(this@MainActivity, 14), dpToPx(this@MainActivity, 12))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dpToPx(this@MainActivity, 12) }
        }
        aCard.addView(TextView(this).apply { text = "Alertas da Malha"; setTextColor(C_TEXT); textSize = 15f; typeface = Typeface.DEFAULT_BOLD })
        aCard.addView(makeBtn("Enviar Alerta de Teste") {
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

    // ==================== UDP LAN DISCOVERY (PORT 45890) ====================
    private fun startUdpDiscovery() {
        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            multicastLock = wm?.createMulticastLock("continuum_lan_discovery")?.apply {
                setReferenceCounted(true)
                acquire()
            }
        } catch (_: Exception) { }

        discoveryThread = Thread {
            try {
                val sock = DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(InetSocketAddress(LAN_UDP_PORT))
                    soTimeout = 1500
                }
                discoverySocket = sock
                val buf = ByteArray(4096)
                while (!destroyed) {
                    try {
                        val packet = DatagramPacket(buf, buf.size)
                        sock.receive(packet)
                        val str = String(packet.data, 0, packet.length, Charsets.UTF_8)
                        val json = JSONObject(str)
                        if (json.optString("proto") != PROTO_TAG) continue
                        val hubId = json.optString("hubId")
                        if (hubId.isBlank()) continue
                        val senderIp = packet.address.hostAddress ?: json.optString("ip")
                        val ip = if (!senderIp.startsWith("127.")) senderIp else json.optString("ip", senderIp)
                        val hub = DiscoveredLanHub(
                            hubId = hubId,
                            hubName = json.optString("hubName", "PC"),
                            os = json.optString("os", "desktop"),
                            ip = ip,
                            wsPort = json.optInt("wsPort", LAN_WS_PORT),
                            roomCode = json.optString("roomCode", roomCode),
                            lastSeenMs = System.currentTimeMillis()
                        )
                        discoveredHubs[hubId] = hub
                        mainHandler.post {
                            refreshLanPeersUi()
                            if (!connected && manualLanHost.isBlank() && hub.roomCode == roomCode) {
                                connectToEndpoint("ws://\${hub.ip}:\${hub.wsPort}/ws", "\${hub.hubName} (\${hub.ip})")
                            }
                        }
                    } catch (_: Exception) { }
                }
            } catch (_: Exception) { }
        }.apply { isDaemon = true; start() }
    }

    private fun refreshLanPeersUi() {
        val now = System.currentTimeMillis()
        discoveredHubs.entries.removeIf { now - it.value.lastSeenMs > 10000L }
        lanPeersContainer.removeAllViews()
        val list = discoveredHubs.values.sortedBy { it.hubName }
        if (list.isEmpty()) {
            lanPeersContainer.addView(TextView(this).apply {
                text = "Nenhum PC Continuum encontrado ainda no Wi-Fi. Abra o Continuum no Linux ou Windows na mesma rede."
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
                background = roundedBg(C_SUBTLE, C_BORDER, 10f, this@MainActivity)
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
            info.addView(TextView(this).apply { text = "\${h.ip}:\${h.wsPort} · Malha \${h.roomCode}"; setTextColor(C_MUTED); textSize = 11.5f; typeface = Typeface.MONOSPACE })
            row.addView(info)
            row.addView(makeBtn("Conectar", true) {
                roomCode = h.roomCode
                lblTopRoom.text = "MALHA \$roomCode"
                editRoom.setText(roomCode)
                connectToEndpoint("ws://\${h.ip}:\${h.wsPort}/ws", "\${h.hubName} (\${h.ip})")
            })
            lanPeersContainer.addView(row)
        }
    }

    // ==================== DIRECT LAN WEBSOCKET CLIENT ====================
    private fun connectToEndpoint(url: String, label: String) {
        if (destroyed) return
        if (connected && activeWsUrl == url) return
        ws?.close(1000, "switch")
        ws = null
        activeWsUrl = url
        activeHubLabel = label
        connected = false

        mainHandler.post {
            lblTopStatus.text = "● Conectando a \$label..."
            lblTopStatus.setTextColor(C_AMBER)
        }

        val req = Request.Builder().url(url).build()
        ws = httpClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connected = true
                mainHandler.post {
                    lblTopStatus.text = "● LAN · \$label"
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
                    lblTopStatus.text = "● Reconectando LAN..."
                    lblTopStatus.setTextColor(C_AMBER)
                }
                if (!destroyed && activeWsUrl == url) {
                    mainHandler.postDelayed({ if (!destroyed && !connected && activeWsUrl == url) connectToEndpoint(url, label) }, 2500)
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
        toast("Enviado para todos os dispositivos da malha.")
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
                        if (connected) lblTopStatus.text = "● LAN · \$activeHubLabel · \${rttMs} ms"
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
            lblMapSelected.text = "Aguardando dispositivos na mesma rede Wi-Fi."
            lblRemoteTarget.text = "Controlando: nenhum PC selecionado"
        }
    }

    private fun refreshClipboardUi() {
        clipListContainer.removeAllViews()
        for (item in clipItems.take(20)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                background = roundedBg(C_SUBTLE, C_BORDER, 9f, this@MainActivity)
                setPadding(dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 8), dpToPx(this@MainActivity, 10), dpToPx(this@MainActivity, 8))
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dpToPx(this@MainActivity, 6) }
            }
            val tv = TextView(this).apply {
                text = "[\${item.source}] \${item.content.take(100)}"
                setTextColor(C_TEXT)
                textSize = 12f
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val bCopy = makeBtn("Copiar") {
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
                background = roundedBg(C_SUBTLE, C_BORDER, 8f, this@MainActivity)
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
        ws?.close(1000, "exit")
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
    { name: `${prefix}/app/src/main/res/values/styles.xml`, content: stylesXml },
    { name: `${prefix}/app/src/main/java/app/continuum/nativeclient/MainActivity.kt`, content: mainActivityKt },
  ];

  if (pngIcon) {
    entries.push({ name: `${prefix}/app/src/main/res/mipmap-xxhdpi/ic_launcher.png`, content: pngIcon });
  }

  return entries;
}
