package com.cloudmusicbox.player

import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.ViewModelProvider
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.Executor

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var future: ListenableFuture<MediaController>
    private var controller: MediaController? = null
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var tracks = JSONArray()
    private var server = ""
    private val origin = "https://appassets.androidplatform.net"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = getPreferences(MODE_PRIVATE).getString("server", "") ?: ""
        future = ViewModelProvider(this)[ControllerHolder::class.java].future
        future.addListener({ try { controller = future.get() } catch (_: Exception) { } }, Executor { main.post(it) })
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = false
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.toString() != "$origin/assets/ui/index.html"
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(TextView(this).apply {
                text = "Обновите Android System WebView и перезапустите приложение."
                textSize = 18f
                setPadding(32, 64, 32, 32)
            })
            return
        }
        WebViewCompat.addWebMessageListener(web, "NativeMusic", setOf(origin), object : WebViewCompat.WebMessageListener {
            override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
                if (!isMainFrame || sourceOrigin.toString() != origin) return
                val request = try { JSONObject(message.data ?: return) } catch (_: Exception) { return }
                handle(request, replyProxy)
            }
        })
        setContentView(web)
        web.loadUrl("$origin/assets/ui/index.html")
    }
    private fun send(reply: JavaScriptReplyProxy, id: Int, result: Any? = null, error: String? = null) {
        val response = JSONObject().put("id", id)
        if (error != null) response.put("error", error) else response.put("result", result ?: JSONObject.NULL)
        reply.postMessage(response.toString())
    }
    private fun handle(req: JSONObject, reply: JavaScriptReplyProxy) {
        val id = req.optInt("id", -1)
        try {
            when (val action = req.getString("action")) {
                "config" -> send(reply, id, JSONObject().put("server", server).put("debug", BuildConfig.DEBUG))
                "load" -> {
                    val validated = ServerAddress.validate(req.getString("server"), BuildConfig.DEBUG)
                    io.execute {
                        try {
                            val list = CatalogClient(validated).tracks()
                            main.post { server = validated; tracks = list; getPreferences(MODE_PRIVATE).edit().putString("server",server).apply(); send(reply,id,list) }
                        } catch (e: Exception) { main.post { send(reply,id,error=e.message ?: "Unable to load catalog") } }
                    }
                }
                "artwork" -> {
                    val selectedServer = server
                    val path = req.getString("path")
                    io.execute {
                        try {
                            val bytes = CatalogClient(selectedServer).artwork(path)
                            val mime = when {
                                bytes.size >= 8 && bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte() -> "image/png"
                                bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() -> "image/jpeg"
                                bytes.size >= 4 && String(bytes,0,4,Charsets.US_ASCII) == "GIF8" -> "image/gif"
                                bytes.size >= 12 && String(bytes,8,4,Charsets.US_ASCII) == "WEBP" -> "image/webp"
                                else -> throw IllegalArgumentException("Unsupported artwork format")
                            }
                            main.post { send(reply,id,"data:$mime;base64," + Base64.encodeToString(bytes,Base64.NO_WRAP)) }
                        } catch (e: Exception) { main.post { send(reply,id,error=e.message ?: "Artwork unavailable") } }
                    }
                }
                "select" -> {
                    val player = controller ?: throw IllegalStateException("Player is connecting")
                    val index = req.getInt("index")
                    require(index in 0 until tracks.length())
                    val items = (0 until tracks.length()).map { i ->
                        val t=tracks.getJSONObject(i); val trackId=t.getString("id")
                        val artists=t.optJSONArray("artists") ?: JSONArray()
                        val artist=(0 until artists.length()).joinToString(", ") { artists.optString(it) }
                        val art=t.optString("artworkUrl", "").takeIf { it.matches(Regex("/api/v1/artworks/[a-f0-9]{64}")) }
                        val metadata=MediaMetadata.Builder().setTitle(t.optString("title")).setArtist(artist)
                        if (art != null) metadata.setArtworkUri(Uri.parse(server + art))
                        MediaItem.Builder().setMediaId(trackId).setUri("$server/api/v1/tracks/$trackId/stream").setMediaMetadata(metadata.build()).build()
                    }
                    player.setMediaItems(items,index,0); player.prepare(); player.play()
                    send(reply,id,snapshot(player))
                }
                "state" -> send(reply,id,controller?.let { snapshot(it) } ?: JSONObject().put("connected",false))
                "play", "pause", "next", "previous", "seek" -> {
                    val p=controller ?: throw IllegalStateException("Player is connecting")
                    val commands=object : PlaybackCommands {
                        override fun play() { p.play() }; override fun pause() { p.pause() }
                        override fun next() { p.seekToNextMediaItem() }; override fun previous() { p.seekToPreviousMediaItem() }
                        override fun seek(positionMs: Long) { p.seekTo(positionMs) }
                    }
                    CommandRouter.execute(action,req.optLong("positionMs",0),commands);send(reply,id,snapshot(p))
                }
                else -> throw IllegalArgumentException("Unknown command")
            }
        } catch (e: Exception) { send(reply,id,error=e.message ?: "Operation failed") }
    }
    private fun snapshot(p: MediaController): JSONObject {
        val duration = p.duration.takeIf { it != C.TIME_UNSET && it >= 0 } ?: 0
        return JSONObject().put("connected",true).put("playing",p.isPlaying).put("playWhenReady",p.playWhenReady)
            .put("buffering",p.playbackState == Player.STATE_BUFFERING).put("index",p.currentMediaItemIndex)
            .put("count",p.mediaItemCount).put("id",p.currentMediaItem?.mediaId ?: "")
            .put("title",p.mediaMetadata.title?.toString() ?: "").put("artist",p.mediaMetadata.artist?.toString() ?: "")
            .put("positionMs",p.currentPosition).put("durationMs",duration).put("error",p.playerError?.message ?: "")
    }
    override fun onDestroy() {
        io.shutdownNow(); web.destroy(); controller = null
        super.onDestroy()
    }
}
