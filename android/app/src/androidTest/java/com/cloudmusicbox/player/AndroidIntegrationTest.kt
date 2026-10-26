package com.cloudmusicbox.player

import android.content.ComponentName
import androidx.media3.common.MediaItem
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.core.app.ApplicationProvider
import androidx.test.core.app.ActivityScenario
import androidx.lifecycle.ViewModelProvider
import android.view.ViewGroup
import android.webkit.WebView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.ServerSocket
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

@RunWith(AndroidJUnit4::class)
class AndroidIntegrationTest {
    @Test fun fetchesCatalogFromHttpServer() {
        val server = ServerSocket(0)
        val worker=thread {
            repeat(2) {
                server.accept().use { socket ->
                    val reader=socket.getInputStream().bufferedReader()
                    val line=reader.readLine(); while (reader.readLine()?.isNotEmpty() == true) { }
                    val body=if (line.contains("server-info")) """{"api":{"major":1}}""" else """{"items":[{"id":"track-1","title":"Song","artists":["Artist"],"artworkUrl":null}],"pagination":{"nextOffset":null}}"""
                    val bytes=body.toByteArray()
                    socket.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray());write(bytes);flush() }
                }
            }
        }
        try {
            val list=CatalogClient("http://127.0.0.1:${server.localPort}").tracks()
            assertEquals(1,list.length());assertEquals("Song",list.getJSONObject(0).getString("title"))
        } finally { server.close();worker.join(1000) }
    }
    @Test fun nativeMediaControllerAcceptsQueueAndPlaybackCommands() {
        val context=ApplicationProvider.getApplicationContext<android.content.Context>()
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        lateinit var future: com.google.common.util.concurrent.ListenableFuture<MediaController>
        instrumentation.runOnMainSync { future=MediaController.Builder(context,SessionToken(context,ComponentName(context,PlaybackService::class.java))).buildAsync() }
        val p=future.get(20,TimeUnit.SECONDS)
        try {
            fun waitFor(check: () -> Boolean) {
                repeat(100) {
                    var ready=false
                    instrumentation.runOnMainSync { ready=check() }
                    if (ready) return
                    Thread.sleep(50)
                }
                throw AssertionError("MediaController state did not update")
            }
            instrumentation.runOnMainSync { p.setMediaItems(listOf(MediaItem.fromUri("http://127.0.0.1:1/a"),MediaItem.fromUri("http://127.0.0.1:1/b"))) }
            waitFor { p.mediaItemCount == 2 }
            instrumentation.runOnMainSync { p.seekToNextMediaItem() }
            waitFor { p.currentMediaItemIndex == 1 }
            instrumentation.runOnMainSync { p.seekToPreviousMediaItem() }
            waitFor { p.currentMediaItemIndex == 0 }
            instrumentation.runOnMainSync { p.seekTo(1200) }
            waitFor { p.currentPosition == 1200L }
            instrumentation.runOnMainSync { p.play() }
            waitFor { p.playWhenReady }
            instrumentation.runOnMainSync { p.pause() }
            waitFor { !p.playWhenReady }
        } finally { instrumentation.runOnMainSync { MediaController.releaseFuture(future) } }
    }
    @Test fun retainsQueueAcrossActivityRecreation() {
        val scenario=ActivityScenario.launch(MainActivity::class.java)
        try {
            lateinit var first: com.google.common.util.concurrent.ListenableFuture<MediaController>
            scenario.onActivity { first=ViewModelProvider(it)[ControllerHolder::class.java].future }
            val player=first.get(20,TimeUnit.SECONDS)
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                player.setMediaItems(listOf(MediaItem.fromUri("http://127.0.0.1:1/a"),MediaItem.fromUri("http://127.0.0.1:1/b")))
            }
            repeat(100) {
                var ready=false
                InstrumentationRegistry.getInstrumentation().runOnMainSync { ready=player.mediaItemCount == 2 }
                if (ready) return@repeat
                Thread.sleep(50)
            }
            scenario.recreate()
            scenario.onActivity {
                assertSame(first,ViewModelProvider(it)[ControllerHolder::class.java].future)
                assertEquals(2,player.mediaItemCount)
            }
        } finally { scenario.close() }
    }

    @Test fun bundledReactUiLoadsWithRestrictedNativeBridge() {
        val scenario=ActivityScenario.launch(MainActivity::class.java)
        try {
            lateinit var view: WebView
            scenario.onActivity { view=it.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView }
            var loaded=false
            repeat(100) {
                val latch=CountDownLatch(1);val result=AtomicReference<String>()
                InstrumentationRegistry.getInstrumentation().runOnMainSync {
                    view.evaluateJavascript("Boolean(window.NativeMusic && document.querySelector('header'))") { value -> result.set(value);latch.countDown() }
                }
                latch.await(3,TimeUnit.SECONDS)
                if (result.get() == "true") { loaded=true; return@repeat }
                Thread.sleep(100)
            }
            assertTrue("Bundled React UI or native bridge did not load",loaded)
        } finally { scenario.close() }
    }

}
