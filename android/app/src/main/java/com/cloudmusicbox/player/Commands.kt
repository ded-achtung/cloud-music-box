package com.cloudmusicbox.player

interface PlaybackCommands {
    fun play(); fun pause(); fun next(); fun previous(); fun seek(positionMs: Long)
}
object CommandRouter {
    fun execute(command: String, positionMs: Long, player: PlaybackCommands) {
        when (command) {
            "play" -> player.play()
            "pause" -> player.pause()
            "next" -> player.next()
            "previous" -> player.previous()
            "seek" -> { require(positionMs >= 0); player.seek(positionMs) }
            else -> throw IllegalArgumentException("Unknown playback command")
        }
    }
}
