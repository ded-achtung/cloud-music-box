package com.cloudmusicbox.player
import org.junit.Assert.*
import org.junit.Test

class CommandsTest {
    @Test fun validatesReleaseAndDebugAddresses() {
        assertEquals("https://music.example:443",ServerAddress.validate("https://music.example:443/",false))
        assertEquals("http://192.168.1.5:3000",ServerAddress.validate("http://192.168.1.5:3000",true))
        for (url in listOf("http://8.8.8.8", "http://example.com", "https://user:pass@example.com", "https://example.com/path")) {
            assertThrows(IllegalArgumentException::class.java) { ServerAddress.validate(url,true) }
        }
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.validate("http://192.168.1.5",false) }
    }
    @Test fun routesPlaybackCommandsAndRejectsBadSeek() {
        val calls=mutableListOf<String>()
        val fake=object:PlaybackCommands {
            override fun play(){calls.add("play")}; override fun pause(){calls.add("pause")}
            override fun next(){calls.add("next")}; override fun previous(){calls.add("previous")}
            override fun seek(positionMs:Long){calls.add("seek:$positionMs")}
        }
        listOf("play","pause","next","previous","seek").forEach { CommandRouter.execute(it,1234,fake) }
        assertEquals(listOf("play","pause","next","previous","seek:1234"),calls)
        assertThrows(IllegalArgumentException::class.java) { CommandRouter.execute("seek",-1,fake) }
    }
}
