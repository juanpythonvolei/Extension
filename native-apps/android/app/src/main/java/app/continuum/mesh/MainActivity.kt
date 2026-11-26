package app.continuum.mesh

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.OpenableColumns
import android.util.Base64
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ScrollView
import android.widget.Spinner
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
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Continuum 100% Native Android Application (Kotlin + OkHttp WebSocket + Multi-Touch Trackpad).
 * Zero WebView — native Android UI talking directly to the Continuum real-time mesh protocol.
 */
class MainActivity : AppCompatActivity() {

    private val bgCanvas = Color.parseColor("#090B0E")
    private val bgSurface = Color.parseColor("#11151B")
    private val bgElevated = Color.parseColor("#171C24")
    private val borderStroke = Color.parseColor("#222936")
    private val accentBlue = Color.parseColor("#3B82F6")
    private val textPrimary = Color.parseColor("#F1F5F9")
    private val textMuted = Color.parseColor("#94A3B8")

    private val httpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private lateinit var deviceId: String
    private var serverUrl: String = BuildConfig.DEFAULT_SERVER_URL
    private var roomCode: String = BuildConfig.DEFAULT_ROOM_CODE

    private val devices = mutableListOf<JSONObject>()
    private val clipboardItems = mutableListOf<JSONObject>()
    private val notifications = mutableListOf<JSONObject>()
    private val pendingFiles = mutableMapOf<String, PendingFile>()

    private lateinit var statusText: TextView
    private lateinit var serverInput: EditText
    private lateinit var roomInput: EditText
    private lateinit var devicesContainer: LinearLayout
    private lateinit var targetSpinner: Spinner
    private lateinit var clipListView: ListView
    private lateinit var notifListView: ListView
    private lateinit var tabMesh: View
    private lateinit var tabTrackpad: View
    private lateinit var tabFiles: View
    private lateinit var tabAlerts: View

    data class PendingFile(val name: String, var total: Int = 0, val chunks: MutableMap<Int, String> = mutableMapOf())

    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) sendSelectedFile(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val prefs = getSharedPreferences("continuum_native", Context.MODE_PRIVATE)
        serverUrl = prefs.getString("server_url", BuildConfig.DEFAULT_SERVER_URL) ?: BuildConfig.DEFAULT_SERVER_URL
        roomCode = prefs.getString("room_code", BuildConfig.DEFAULT_ROOM_CODE) ?: BuildConfig.DEFAULT_ROOM_CODE
        val cleanModel = "${Build.MANUFACTURER}${Build.MODEL}".lowercase().filter { it.isLetterOrDigit() }.take(14)
        deviceId = prefs.getString("device_id", null) ?: "android-app-$cleanModel-${(1000..9999).random()}".also {
            prefs.edit().putString("device_id", it).apply()
        }

        setContentView(buildRootLayout())
        connectMesh()
    }

    override fun onDestroy() {
        super.onDestroy()
        webSocket?.close(1000, "App closed")
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun cardBg(fill: Int = bgSurface): GradientDrawable = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(8).toFloat()
        setStroke(dp(1), borderStroke)
    }

    private fun makeButton(label: String, primary: Boolean = false, onClick: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply {
            setColor(if (primary) accentBlue else bgElevated)
            cornerRadius = dp(6).toFloat()
            setStroke(dp(1), if (primary) accentBlue else borderStroke)
        }
        setPadding(dp(12), dp(8), dp(12), dp(8))
        setOnClickListener { onClick() }
    }

    private fun buildRootLayout(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(bgCanvas)
        }

        // Top Bar
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(bgSurface)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            gravity = Gravity.CENTER_VERTICAL
        }
        val title = TextView(this).apply {
            text = "Continuum"
            textSize = 18f
            setTextColor(textPrimary)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        statusText = TextView(this).apply {
            text = "Conectando..."
            textSize = 12f
            setTextColor(Color.parseColor("#60A5FA"))
        }
        topBar.addView(title)
        topBar.addView(statusText)
        root.addView(topBar)

        // Content container
        val contentFrame = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        }

        tabMesh = buildMeshTab()
        tabTrackpad = buildTrackpadTab()
        tabFiles = buildFilesTab()
        tabAlerts = buildAlertsTab()

        contentFrame.addView(tabMesh)
        contentFrame.addView(tabTrackpad)
        contentFrame.addView(tabFiles)
        contentFrame.addView(tabAlerts)
        root.addView(contentFrame)

        // Native Bottom Navigation
        val bottomBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(bgSurface)
            setPadding(dp(6), dp(6), dp(6), dp(8))
        }
        listOf(
            "Malha" to 0,
            "Trackpad" to 1,
            "Arquivos" to 2,
            "Alertas" to 3
        ).forEach { (label, idx) ->
            val btn = makeButton(label, idx == 0) { switchTab(idx) }.apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginStart = dp(3)
                    marginEnd = dp(3)
                }
            }
            bottomBar.addView(btn)
        }
        root.addView(bottomBar)
        switchTab(0)
        return root
    }

    private fun switchTab(idx: Int) {
        tabMesh.visibility = if (idx == 0) View.VISIBLE else View.GONE
        tabTrackpad.visibility = if (idx == 1) View.VISIBLE else View.GONE
        tabFiles.visibility = if (idx == 2) View.VISIBLE else View.GONE
        tabAlerts.visibility = if (idx == 3) View.VISIBLE else View.GONE
    }

    private fun buildMeshTab(): View {
        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
        }

        val cfgCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = cardBg()
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
        serverInput = EditText(this).apply {
            setText(serverUrl)
            hint = "https://servidor-continuum"
            setTextColor(textPrimary)
            setHintTextColor(textMuted)
            textSize = 13f
        }
        roomInput = EditText(this).apply {
            setText(roomCode)
            hint = "Codigo da Malha (ex: MESH01)"
            setTextColor(textPrimary)
            setHintTextColor(textMuted)
            textSize = 14f
        }
        val connectBtn = makeButton("Salvar e Conectar na Malha", true) {
            val nextUrl = serverInput.text.toString().trim().trimEnd('/')
            val nextRoom = roomInput.text.toString().uppercase().filter { it.isLetterOrDigit() }.take(8)
            if ((nextUrl.startsWith("http://") || nextUrl.startsWith("https://")) && nextRoom.length >= 4) {
                serverUrl = nextUrl
                roomCode = nextRoom
                getSharedPreferences("continuum_native", Context.MODE_PRIVATE).edit()
                    .putString("server_url", serverUrl)
                    .putString("room_code", roomCode)
                    .apply()
                connectMesh()
            } else {
                Toast.makeText(this, "Informe URL http/https e codigo de malha valido.", Toast.LENGTH_SHORT).show()
            }
        }
        cfgCard.addView(serverInput)
        cfgCard.addView(roomInput)
        cfgCard.addView(connectBtn)
        box.addView(cfgCard)

        val devHeader = TextView(this).apply {
            text = "Dispositivos Conectados"
            setTextColor(textPrimary)
            textSize = 15f
            setPadding(0, dp(16), 0, dp(8))
        }
        box.addView(devHeader)

        devicesContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        box.addView(devicesContainer)
        scroll.addView(box)
        return scroll
    }

    private fun buildTrackpadTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
        }

        targetSpinner = Spinner(this).apply {
            background = cardBg()
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }
        box.addView(targetSpinner)

        val trackpad = NativeTrackpadView(this) { inputJson -> sendRemoteInput(inputJson) }.apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f).apply {
                topMargin = dp(10)
                bottomMargin = dp(10)
            }
        }
        box.addView(trackpad)

        val btnRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        listOf(
            "Vol -" to JSONObject().put("kind", "command").put("action", "vol_down"),
            "Vol +" to JSONObject().put("kind", "command").put("action", "vol_up"),
            "Play" to JSONObject().put("kind", "command").put("action", "media_play_pause"),
            "Scroll ↑" to JSONObject().put("kind", "scroll").put("dx", 0).put("dy", -120),
            "Scroll ↓" to JSONObject().put("kind", "scroll").put("dx", 0).put("dy", 120)
        ).forEach { (lbl, payload) ->
            val b = makeButton(lbl) { sendRemoteInput(payload) }.apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(4)
                }
            }
            btnRow.addView(b)
        }
        box.addView(btnRow)

        val kbRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8), 0, 0)
        }
        val kbInput = EditText(this).apply {
            hint = "Digitar no PC..."
            setTextColor(textPrimary)
            setHintTextColor(textMuted)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val sendKb = makeButton("Enviar", true) {
            val txt = kbInput.text.toString()
            if (txt.isNotEmpty()) {
                sendRemoteInput(JSONObject().put("kind", "text").put("text", txt))
                kbInput.setText("")
            }
        }
        kbRow.addView(kbInput)
        kbRow.addView(sendKb)
        box.addView(kbRow)
        return box
    }

    private fun buildFilesTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
        }

        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val sendFileBtn = makeButton("Enviar Arquivo", true) { filePicker.launch(arrayOf("*/*")) }.apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(6) }
        }
        val syncClipBtn = makeButton("Enviar Clipboard") {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val txt = cm.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()?.trim()
            if (!txt.isNullOrEmpty()) {
                val item = JSONObject()
                    .put("id", "clip-${System.currentTimeMillis()}")
                    .put("content", txt)
                    .put("kind", if (txt.startsWith("http")) "url" else "text")
                    .put("sourceDeviceId", deviceId)
                    .put("sourceDeviceName", "${Build.MANUFACTURER} ${Build.MODEL}")
                    .put("createdAt", System.currentTimeMillis())
                sendWs(JSONObject().put("type", "clipboard:push").put("item", item))
                Toast.makeText(this, "Clipboard sincronizado!", Toast.LENGTH_SHORT).show()
            }
        }.apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        actions.addView(sendFileBtn)
        actions.addView(syncClipBtn)
        box.addView(actions)

        clipListView = ListView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f).apply { topMargin = dp(10) }
            setOnItemClickListener { _, _, pos, _ ->
                if (pos < clipboardItems.size) {
                    val content = clipboardItems[pos].optString("content")
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("Continuum", content))
                    Toast.makeText(this@MainActivity, "Copiado para o Android!", Toast.LENGTH_SHORT).show()
                }
            }
        }
        box.addView(clipListView)
        return box
    }

    private fun buildAlertsTab(): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
        }
        notifListView = ListView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        box.addView(notifListView)
        return box
    }

    private fun readBattery(): Pair<Int?, Boolean?> {
        val status = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = status?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = status?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val plugged = status?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) (level * 100) / scale else null
        return pct to (plugged > 0)
    }

    private fun buildWsUrl(): String {
        val uri = Uri.parse(serverUrl)
        val proto = if (uri.scheme == "https") "wss" else "ws"
        val portPart = if (uri.port > 0) ":${uri.port}" else ""
        return "$proto://${uri.host}$portPart/ws"
    }

    private fun connectMesh() {
        webSocket?.close(1000, "Reconnect")
        statusText.text = "Conectando..."
        val req = Request.Builder().url(buildWsUrl()).build()
        webSocket = httpClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                val (bat, charging) = readBattery()
                val dm = resources.displayMetrics
                val tel = JSONObject()
                    .put("batteryLevel", bat ?: JSONObject.NULL)
                    .put("batteryCharging", charging ?: JSONObject.NULL)
                    .put("cpuCores", Runtime.getRuntime().availableProcessors())
                    .put("volume", 72)
                    .put("brightness", 85)
                    .put("displayServer", "web")
                    .put("openApps", JSONArray())

                val dev = JSONObject()
                    .put("id", deviceId)
                    .put("name", "${Build.MANUFACTURER} ${Build.MODEL}")
                    .put("os", "android")
                    .put("formFactor", if (resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "mobile")
                    .put("screenWidth", dm.widthPixels)
                    .put("screenHeight", dm.heightPixels)
                    .put("pixelRatio", dm.density)
                    .put("orientation", if (dm.widthPixels > dm.heightPixels) "landscape" else "portrait")
                    .put("telemetry", tel)

                ws.send(JSONObject().put("type", "mesh:join").put("roomCode", roomCode).put("device", dev).toString())
                runOnUiThread { statusText.text = "Conectado · $roomCode" }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleWsMessage(text)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                runOnUiThread { statusText.text = "Desconectado (${t.message?.take(24) ?: "erro"})" }
            }
        })
    }

    private fun sendWs(obj: JSONObject) {
        webSocket?.send(obj.toString())
    }

    private fun sendRemoteInput(input: JSONObject) {
        val peers = devices.filter { it.optString("id") != deviceId }
        val idx = targetSpinner.selectedItemPosition
        if (idx in peers.indices) {
            sendWs(JSONObject().put("type", "input:event").put("toDeviceId", peers[idx].optString("id")).put("input", input))
        }
    }

    private fun sendSelectedFile(uri: Uri) {
        Thread {
            try {
                var fileName = "arquivo_android.bin"
                contentResolver.query(uri, null, null, null, null)?.use { c ->
                    val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (c.moveToFirst() && nameIdx >= 0) fileName = c.getString(nameIdx)
                }
                val bytes = contentResolver.openInputStream(uri)?.readBytes() ?: return@Thread
                val trId = "file-${System.currentTimeMillis()}"
                val record = JSONObject()
                    .put("id", trId)
                    .put("fileName", fileName)
                    .put("fileSize", bytes.size)
                    .put("mimeType", "application/octet-stream")
                    .put("fromDeviceId", deviceId)
                    .put("fromDeviceName", "${Build.MANUFACTURER} ${Build.MODEL}")
                    .put("toDeviceId", "all")
                    .put("toDeviceName", "Todos os dispositivos")
                    .put("status", "transferring")
                    .put("progress", 0)
                    .put("speedMbps", 0)
                    .put("createdAt", System.currentTimeMillis())
                sendWs(JSONObject().put("type", "file:start").put("record", record))

                val chunkSize = 48 * 1024
                val total = maxOf(1, (bytes.size + chunkSize - 1) / chunkSize)
                for (i in 0 until total) {
                    val start = i * chunkSize
                    val end = minOf(bytes.size, start + chunkSize)
                    val b64 = Base64.encodeToString(bytes.copyOfRange(start, end), Base64.NO_WRAP)
                    sendWs(
                        JSONObject()
                            .put("type", "file:chunk")
                            .put("transferId", trId)
                            .put("toDeviceId", "all")
                            .put("chunkIndex", i)
                            .put("totalChunks", total)
                            .put("data", b64)
                            .put("progress", minOf(99, ((i + 1) * 100) / total))
                            .put("speedMbps", 8)
                    )
                }
                sendWs(JSONObject().put("type", "file:complete").put("transferId", trId).put("toDeviceId", "all"))
                runOnUiThread { Toast.makeText(this, "Enviado: $fileName", Toast.LENGTH_SHORT).show() }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, "Falha ao enviar: ${e.message}", Toast.LENGTH_SHORT).show() }
            }
        }.start()
    }

    private fun handleWsMessage(raw: String) {
        val msg = try { JSONObject(raw) } catch (_: Exception) { return }
        when (msg.optString("type")) {
            "mesh:init" -> {
                val snap = msg.optJSONObject("snapshot") ?: return
                devices.clear()
                snap.optJSONArray("devices")?.let { arr -> for (i in 0 until arr.length()) devices.add(arr.getJSONObject(i)) }
                clipboardItems.clear()
                snap.optJSONArray("clipboard")?.let { arr -> for (i in 0 until arr.length()) clipboardItems.add(arr.getJSONObject(i)) }
                notifications.clear()
                snap.optJSONArray("notifications")?.let { arr -> for (i in 0 until arr.length()) notifications.add(arr.getJSONObject(i)) }
                runOnUiThread { refreshAllLists() }
            }
            "mesh:devices_sync" -> {
                devices.clear()
                msg.optJSONArray("devices")?.let { arr -> for (i in 0 until arr.length()) devices.add(arr.getJSONObject(i)) }
                runOnUiThread { refreshDevicesUi() }
            }
            "device:joined", "device:updated" -> {
                val dev = msg.optJSONObject("device") ?: return
                val id = dev.optString("id")
                devices.removeAll { it.optString("id") == id }
                devices.add(dev)
                runOnUiThread { refreshDevicesUi() }
            }
            "device:left" -> {
                val id = msg.optString("deviceId")
                devices.removeAll { it.optString("id") == id }
                runOnUiThread { refreshDevicesUi() }
            }
            "clipboard:added" -> {
                msg.optJSONObject("item")?.let { clipboardItems.add(0, it) }
                runOnUiThread { refreshClipboardUi() }
            }
            "notification:added" -> {
                msg.optJSONObject("notification")?.let { notifications.add(0, it) }
                runOnUiThread { refreshNotificationsUi() }
            }
            "file:start" -> {
                val rec = msg.optJSONObject("record") ?: return
                if (rec.optString("fromDeviceId") != deviceId) {
                    pendingFiles[rec.optString("id")] = PendingFile(rec.optString("fileName", "arquivo.bin"))
                }
            }
            "file:chunk" -> {
                val id = msg.optString("transferId")
                pendingFiles[id]?.let { pf ->
                    pf.total = msg.optInt("totalChunks")
                    pf.chunks[msg.optInt("chunkIndex")] = msg.optString("data")
                }
            }
            "file:complete" -> {
                val pf = pendingFiles.remove(msg.optString("transferId")) ?: return
                try {
                    val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Continuum").apply { mkdirs() }
                    val outFile = File(dir, File(pf.name).name)
                    FileOutputStream(outFile).use { fos ->
                        for (i in 0 until pf.total) {
                            pf.chunks[i]?.let { fos.write(Base64.decode(it, Base64.DEFAULT)) }
                        }
                    }
                    runOnUiThread { Toast.makeText(this, "Arquivo recebido: ${outFile.name}", Toast.LENGTH_LONG).show() }
                } catch (_: Exception) { }
            }
            "input:event" -> {
                val inp = msg.optJSONObject("input")
                if (inp?.optString("kind") == "command" && inp.optString("action") == "ping") {
                    runOnUiThread { Toast.makeText(this, "Continuum: Alerta de localizacao recebido!", Toast.LENGTH_LONG).show() }
                }
            }
        }
    }

    private fun refreshAllLists() {
        refreshDevicesUi()
        refreshClipboardUi()
        refreshNotificationsUi()
    }

    private fun refreshDevicesUi() {
        devicesContainer.removeAllViews()
        val peerNames = mutableListOf<String>()
        for (dev in devices) {
            val id = dev.optString("id")
            val isSelf = id == deviceId
            val tel = dev.optJSONObject("telemetry")
            val cpu = if (tel != null && !tel.isNull("cpuUsage")) "CPU ${tel.optInt("cpuUsage")}%" else "CPU —"
            val bat = if (tel != null && !tel.isNull("batteryLevel")) "Bat ${tel.optInt("batteryLevel")}%" else "CA"
            if (!isSelf) peerNames.add(dev.optString("name", id))

            val card = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                background = cardBg()
                setPadding(dp(12), dp(10), dp(12), dp(10))
                gravity = Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    bottomMargin = dp(8)
                }
            }
            val info = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            info.addView(TextView(this).apply {
                text = dev.optString("name") + if (isSelf) " (Este Android)" else ""
                setTextColor(textPrimary)
                textSize = 14f
            })
            info.addView(TextView(this).apply {
                text = "${dev.optString("os").uppercase()} · $cpu · $bat"
                setTextColor(textMuted)
                textSize = 12f
            })
            card.addView(info)
            if (!isSelf) {
                card.addView(makeButton("Ping") {
                    sendWs(JSONObject().put("type", "input:event").put("toDeviceId", id).put("input", JSONObject().put("kind", "command").put("action", "ping")))
                })
            }
            devicesContainer.addView(card)
        }
        targetSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, if (peerNames.isEmpty()) listOf("Nenhum PC pareado") else peerNames)
    }

    private fun refreshClipboardUi() {
        val lines = clipboardItems.map { "[${it.optString("sourceDeviceName")}] ${it.optString("content").take(90)}" }
        clipListView.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, lines)
    }

    private fun refreshNotificationsUi() {
        val lines = notifications.map { "${it.optString("app")} · ${it.optString("title")}" }
        notifListView.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, lines)
    }
}

private class NativeTrackpadView(
    context: Context,
    private val onInput: (JSONObject) -> Unit
) : View(context) {

    private val bgPaint = Paint().apply { color = Color.parseColor("#11151B") }
    private val borderPaint = Paint().apply {
        color = Color.parseColor("#222936")
        style = Paint.Style.STROKE
        strokeWidth = 3f
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#94A3B8")
        textSize = 34f
    }

    private var lastX = 0f
    private var lastY = 0f
    private var startX = 0f
    private var startY = 0f
    private var maxPointers = 1

    override fun onDraw(canvas: Canvas) {
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)
        canvas.drawRect(2f, 2f, width - 2f, height - 2f, borderPaint)
        canvas.drawText("Trackpad Nativo Multi-Toque", 32f, 64f, textPaint)
        canvas.drawText("Arraste: mover cursor · 1 toque: clique · 2 dedos: clique direito", 32f, 112f, textPaint)
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastX = ev.x; lastY = ev.y; startX = ev.x; startY = ev.y; maxPointers = 1
                return true
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                maxPointers = maxOf(maxPointers, ev.pointerCount)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = (ev.x - lastX) * 1.9f
                val dy = (ev.y - lastY) * 1.9f
                lastX = ev.x; lastY = ev.y
                if (abs(dx) >= 1f || abs(dy) >= 1f) {
                    onInput(JSONObject().put("kind", "move").put("nx", 0.5).put("ny", 0.5).put("dx", dx.toInt()).put("dy", dy.toInt()))
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                if (abs(ev.x - startX) < 14f && abs(ev.y - startY) < 14f) {
                    val btn = if (maxPointers >= 2) "right" else "left"
                    onInput(JSONObject().put("kind", "click").put("button", btn))
                }
                return true
            }
        }
        return super.onTouchEvent(ev)
    }
}
