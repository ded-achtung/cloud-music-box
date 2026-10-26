package com.cloudmusicbox.player

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

class CatalogClient(private val base: String) {
    private fun get(path: String, limit: Int): ByteArray {
        val connection = URL(base + path).openConnection() as HttpURLConnection
        connection.connectTimeout = 10000
        connection.readTimeout = 30000
        connection.instanceFollowRedirects = false
        return try {
            if (connection.responseCode != 200) throw IllegalStateException("Server returned HTTP ${connection.responseCode}")
            connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    require(output.size() + n <= limit) { "Server response is too large" }
                    output.write(chunk, 0, n)
                }
                output.toByteArray()
            }
        } finally { connection.disconnect() }
    }
    fun tracks(): JSONArray {
        val info = JSONObject(get("/api/v1/server-info", 1024 * 1024).toString(Charsets.UTF_8))
        require(info.getJSONObject("api").getInt("major") == 1) { "Incompatible server API" }
        val all = JSONArray()
        var offset = 0
        repeat(1000) {
            val page = JSONObject(get("/api/v1/tracks?limit=100&offset=$offset", 5 * 1024 * 1024).toString(Charsets.UTF_8))
            val items = page.getJSONArray("items")
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i)
                require(item.getString("id").matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "Invalid track ID" }
                all.put(item)
            }
            val pagination = page.getJSONObject("pagination")
            if (pagination.isNull("nextOffset")) return all
            val next = pagination.getInt("nextOffset")
            require(next > offset) { "Invalid pagination" }
            offset = next
        }
        throw IllegalStateException("Catalog exceeds page limit")
    }
    fun artwork(path: String): ByteArray {
        require(path.matches(Regex("/api/v1/artworks/[a-f0-9]{64}"))) { "Invalid artwork path" }
        return get(path, 5 * 1024 * 1024)
    }
}
