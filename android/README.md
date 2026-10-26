# Android Music Player — stage 1

A Kotlin Android application uses Media3 ExoPlayer and a MediaSessionService for the queue and playback. A bundled React interface reuses Cloud Music Box's `TrackCover` and `MarqueeText`; it requests the v1 catalog through a native bridge and never owns an HTML audio player. The Activity reconnects a MediaController to the service after recreation; the queue remains in the service while it is alive. Restoring a queue after the service/process is stopped is not implemented.

## Install the debug APK

Download `cloud-music-player-debug` from the Android player GitHub Actions run for this branch, extract `app-debug.apk`, and install with `adb install -r app-debug.apk`, or transfer it to the phone and approve Android's install prompt. Debug APKs are signed by the build machine's debug key: different runs may require uninstalling the previous debug build. Never distribute this signing key as a release key.

Start Music Server on Ubuntu with `MUSIC_ROOT=/path/to/music HOST=0.0.0.0 npm start` after building it as documented in `music-server/README.md`. Use an explicitly trusted local network; the server currently has no authentication. In the Android app enter e.g. `http://192.168.1.10:3000` and tap Connect. Emulator access to the host uses `http://10.0.2.2:3000`. Set firewall rules yourself as needed. An Android device must be able to reach that address from its own network.

Debug permits cleartext HTTP only for private IPv4 addresses, and HTTPS. Release builds require HTTPS; debug's manifest enables cleartext solely for this test build. The APK updater is **not implemented**: before the first public release, implement signed update metadata, APK integrity checks and user-confirmed installation, with stable application ID and securely held signing key.

## Build

Install Node.js, Java 17, Android SDK 35 and Gradle 8.11.1. From the repository root:

```sh
npm ci
npm install --prefix /tmp/android-vite --no-audit --no-fund vite@5.4.21
/tmp/android-vite/node_modules/.bin/vite build --config android/vite.config.mjs
gradle -p android :app:assembleDebug :app:testDebugUnitTest
```

The APK is `android/app/build/outputs/apk/debug/app-debug.apk`. On an emulator, `gradle -p android :app:connectedDebugAndroidTest` tests a local HTTP catalog and MediaController queue commands. UI bridge is restricted to the bundled asset origin and native catalog requests bypass WebView CORS; the release network policy enforces HTTPS.

Audio background continuity, lock-screen presentation and Bluetooth buttons require physical Android testing, including vendor battery policy and different OS versions. They are not yet verified by emulator tests. Release signing and the updater must be completed before public distribution.
