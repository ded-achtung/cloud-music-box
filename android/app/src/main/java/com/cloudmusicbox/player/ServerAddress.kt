package com.cloudmusicbox.player

import java.net.URI

object ServerAddress {
    fun validate(input: String, allowLocalHttp: Boolean): String {
        val uri = URI(input.trim())
        require(uri.scheme == "https" || (uri.scheme == "http" && allowLocalHttp)) { "Use HTTPS; debug builds also allow private IPv4 HTTP." }
        require(uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null) { "Enter a server address without credentials, query, or fragment." }
        require(uri.port == -1 || uri.port in 1..65535) { "Invalid port." }
        require(uri.path.isNullOrEmpty() || uri.path == "/") { "Use the server origin without a path." }
        if (uri.scheme == "http") {
            val p = uri.host.split('.').map { it.toIntOrNull() }
            require(p.size == 4 && p.all { it != null && it in 0..255 }) { "Debug HTTP requires a private IPv4 address." }
            val a = p[0]!!; val b = p[1]!!
            require(a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b in 16..31)) { "Debug HTTP requires a private IPv4 address." }
        }
        return URI(uri.scheme, null, uri.host, uri.port, null, null, null).toASCIIString()
    }
}
