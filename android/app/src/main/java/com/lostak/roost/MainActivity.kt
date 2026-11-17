package com.lostak.roost

import android.app.AlertDialog
import android.app.Dialog
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

/**
 * Roost for Android. Shows Roost Mobile (Roost's own dashboard + modules, built by
 * android/scripts/build-web.js) in a WebView and backs it with the phone, not Claude:
 *  - statements and settings: a private file in the app's storage
 *  - laptop sync: roost-sync.json.gz, which Roost on the computer writes into a cloud folder
 *    (mobile_sync_dir), picked once through the Android file picker (Google Drive, OneDrive, ...)
 *  - Excel export: the phone's Downloads folder
 *  - updates: checks the GitHub "android" release and offers the new APK
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("roost", MODE_PRIVATE) }
    private val dataFile by lazy { File(filesDir, "roost-data.json") }
    private val origin = "https://appassets.androidplatform.net"

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private var syncPickCb: String? = null
    private val pickSync = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val cb = syncPickCb ?: return@registerForActivityResult
        syncPickCb = null
        var info = "null"
        if (uri != null) {
            try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
            prefs.edit().putString("syncUri", uri.toString()).apply()
            info = syncInfo() ?: "null"
        }
        js("window.__roostCb && window.__roostCb(${JSONObject.quote(cb)}, ${JSONObject.quote(info)})")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web = WebView(this)
        val frame = android.widget.FrameLayout(this).apply { setBackgroundColor(android.graphics.Color.WHITE); addView(web) }
        setContentView(frame)
        // Android 15 draws apps edge to edge (under the status and navigation bars). Pad the page so
        // nothing sits under them, and lift it above the keyboard when it's open.
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            allowFileAccess = false
            allowContentAccess = false
        }
        web.addJavascriptInterface(Bridge(), "RoostAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(req.url)
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.host == "appassets.androidplatform.net") return false
                openExternal(u); return true
            }
            override fun onPageFinished(view: WebView, url: String) { if (firstLoad) { firstLoad = false; autoSync() } }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                return try { pickFiles.launch(params.createIntent().apply { putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) }); true }
                catch (e: Exception) { fileCallback = null; false }
            }
            // window.open: the year-end report writes into a blank window; real links go to the browser.
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                val child = WebView(this@MainActivity)
                child.settings.javaScriptEnabled = true
                val dlg = Dialog(this@MainActivity, android.R.style.Theme_DeviceDefault_Light_NoActionBar)
                child.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean { openExternal(req.url); dlg.dismiss(); return true }
                }
                child.webChromeClient = object : WebChromeClient() { override fun onCloseWindow(w: WebView) { dlg.dismiss() } }
                dlg.setContentView(child, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                dlg.show()
                (resultMsg.obj as WebView.WebViewTransport).webView = child
                resultMsg.sendToTarget()
                return true
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (web.canGoBack()) web.goBack() else finish() }
        })
        web.loadUrl("$origin/assets/www/index.html")
        checkForUpdate()
    }

    private var firstLoad = true
    private var lastAutoSync = 0L
    override fun onResume() {
        super.onResume()
        if (!firstLoad && System.currentTimeMillis() - lastAutoSync > 30 * 60_000) autoSync()
    }
    /** Pull the latest from the computer on open (and after 30+ minutes away), once a sync file is picked. */
    private fun autoSync() {
        if (prefs.getString("syncUri", null) == null) return
        lastAutoSync = System.currentTimeMillis()
        js("setTimeout(function(){ if (window.RM && RM.sync) RM.readyP.then(function(){ RM.sync(); }); }, 800)")
    }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }
    private fun openExternal(u: Uri) = try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}

    private fun syncUri(): Uri? = prefs.getString("syncUri", null)?.let { Uri.parse(it) }
    private fun syncInfo(): String? {
        val uri = syncUri() ?: return null
        return try {
            var name = "roost-sync.json.gz"; var modified: Long? = null
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = c.getString(it) ?: name }
                    c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED).takeIf { it >= 0 && !c.isNull(it) }?.let { modified = c.getLong(it) }
                }
            } ?: return null
            JSONObject().put("name", name).put("modified", modified?.let { Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL).toString()
        } catch (e: Exception) { null }
    }

    inner class Bridge {
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
        @JavascriptInterface fun load(): String = try { if (dataFile.exists()) dataFile.readText() else "{}" } catch (e: Exception) { "{}" }
        @JavascriptInterface fun save(json: String) {
            synchronized(this) {
                val tmp = File(filesDir, "roost-data.json.tmp")
                tmp.writeText(json)
                if (!tmp.renameTo(dataFile)) { dataFile.writeText(json); tmp.delete() }
            }
        }
        @JavascriptInterface fun syncFileInfo(): String? = syncInfo()
        @JavascriptInterface fun pickSyncFile(cb: String) = runOnUiThread {
            syncPickCb = cb
            try { pickSync.launch(arrayOf("*/*")) } catch (e: Exception) { syncPickCb = null; js("window.__roostCb(${JSONObject.quote(cb)}, 'null')") }
        }
        @JavascriptInterface fun readSyncFile(): String? {
            val uri = syncUri() ?: return null
            return try { contentResolver.openInputStream(uri)?.use { Base64.encodeToString(it.readBytes(), Base64.NO_WRAP) } } catch (e: Exception) { null }
        }
        @JavascriptInterface fun clearSyncFile() { prefs.edit().remove("syncUri").apply() }
        @JavascriptInterface fun saveDownload(name: String, b64: String): String = try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            val mime = if (name.endsWith(".xlsx")) "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" else "application/octet-stream"
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw Exception("couldn't create the file")
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw Exception("couldn't write the file")
            "ok"
        } catch (e: Exception) { e.message ?: "save failed" }
    }

    /** Offers the newer APK from the GitHub release (CI publishes version.json next to it). */
    private fun checkForUpdate() {
        Thread {
            try {
                val c = URL(BuildConfig.UPDATE_URL).openConnection() as HttpURLConnection
                c.connectTimeout = 8000; c.readTimeout = 8000; c.instanceFollowRedirects = true
                val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
                val code = j.optInt("versionCode", 0); val apk = j.optString("apk")
                if (code > BuildConfig.VERSION_CODE && apk.isNotEmpty() && prefs.getInt("skipped", 0) != code) runOnUiThread {
                    AlertDialog.Builder(this)
                        .setTitle("Roost update available")
                        .setMessage("Version ${j.optString("versionName")} is ready. Download it, then tap the file to install. Your statements stay on this phone.")
                        .setPositiveButton("Download") { _, _ -> openExternal(Uri.parse(apk)) }
                        .setNegativeButton("Later", null)
                        .setNeutralButton("Skip this version") { _, _ -> prefs.edit().putInt("skipped", code).apply() }
                        .show()
                }
            } catch (_: Exception) { /* offline: try next launch */ }
        }.start()
    }
}
