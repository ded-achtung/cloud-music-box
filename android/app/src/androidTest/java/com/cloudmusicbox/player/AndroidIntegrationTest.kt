package com.cloudmusicbox.player

import android.content.ComponentName
import androidx.media3.common.MediaItem
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.core.app.ApplicationProvider
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
            instrumentation.runOnMainSync {
                p.setMediaItems(listOf(MediaItem.fromUri("http://127.0.0.1:1/a"),MediaItem.fromUri("http://127.0.0.1:1/b")))
                assertEquals(2,p.mediaItemCount)
                p.seekToNextMediaItem();assertEquals(1,p.currentMediaItemIndex)
                p.seekToPreviousMediaItem();assertEquals(0,p.currentMediaItemIndex)
                p.seekTo(1200);assertEquals(1200,p.currentPosition)
                p.play();assertTrue(p.playWhenReady)
                p.pause();assertFalse(p.playWhenReady)
            }
        } finally { instrumentation.runOnMainSync { MediaController.releaseFuture(future) } }
    }
}
