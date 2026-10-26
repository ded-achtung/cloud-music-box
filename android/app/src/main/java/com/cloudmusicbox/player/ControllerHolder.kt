package com.cloudmusicbox.player

import android.app.Application
import android.content.ComponentName
import androidx.lifecycle.AndroidViewModel
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken

/** Keeps the controller binding across Activity configuration changes. */
class ControllerHolder(app: Application) : AndroidViewModel(app) {
    val future = MediaController.Builder(app, SessionToken(app, ComponentName(app, PlaybackService::class.java))).buildAsync()
    override fun onCleared() { MediaController.releaseFuture(future) }
}
