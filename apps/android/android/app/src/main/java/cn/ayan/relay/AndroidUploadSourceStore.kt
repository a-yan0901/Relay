package cn.ayan.relay

import java.util.LinkedHashMap
import java.util.UUID

internal data class AndroidUploadSource(
    val sourceId: String,
    val uri: String,
    val name: String,
    val size: Long?
)

/** Keeps picker URI grants behind an opaque, short-lived native handle. */
internal class AndroidUploadSourceStore(
    private val now: () -> Long = { System.currentTimeMillis() },
    private val ttlMs: Long = 10 * 60 * 1000L
) {
    private data class Entry(val source: AndroidUploadSource, val expiresAt: Long)

    private val entries = LinkedHashMap<String, Entry>()

    @Synchronized
    fun put(uri: String, name: String, size: Long?): AndroidUploadSource {
        prune()
        val source = AndroidUploadSource(
            sourceId = "source-${UUID.randomUUID()}",
            uri = uri,
            name = name,
            size = size
        )
        entries[source.sourceId] = Entry(source, now() + ttlMs)
        return source
    }

    @Synchronized
    fun take(sourceId: String): AndroidUploadSource? {
        prune()
        return entries.remove(sourceId)?.source
    }

    @Synchronized
    fun clear() {
        entries.clear()
    }

    @Synchronized
    fun size(): Int {
        prune()
        return entries.size
    }

    @Synchronized
    fun isEmpty(): Boolean = size() == 0

    private fun prune() {
        val timestamp = now()
        entries.entries.removeIf { it.value.expiresAt <= timestamp }
    }
}
