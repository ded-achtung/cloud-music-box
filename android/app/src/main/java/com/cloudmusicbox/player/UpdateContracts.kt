package com.cloudmusicbox.player

/** Update support is deliberately not implemented in stage 1. */
data class UpdateDescriptor(
    val versionName: String,
    val versionCode: Long,
    val downloadUrl: String,
    val sha256: String,
    val minSdk: Int,
    val supportedApiMajors: Set<Int>
)
interface UpdateRepository {
    /** Implementations must authenticate the manifest before returning an update. */
    fun check(serverOrigin: String): UpdateDescriptor?
}
interface UpdateInstaller {
    /** A future implementation must verify the APK and request system installation. */
    fun install(update: UpdateDescriptor)
}
