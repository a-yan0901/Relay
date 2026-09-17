package cn.ayan.relay

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Small app-private SQLite store for the Android local mode. Secrets are
 * stored as ciphertext only; the WebView never receives this database or a
 * filesystem path. Lists are deliberately capped because the bridge response
 * is bounded as well.
 */
internal data class AndroidHost(
    val id: String,
    val name: String,
    val address: String,
    val port: Int,
    val username: String,
    val authType: String,
    val credentialCiphertext: String?,
    val groupId: String?,
    val terminalProfileId: String?,
    val jumpHostIdsJson: String,
    val keepaliveIntervalMs: Int,
    val keepaliveCountMax: Int,
    val reconnectEnabled: Boolean,
    val reconnectMaxAttempts: Int,
    val reconnectBaseDelayMs: Int,
    val reconnectMaxDelayMs: Int,
    val tagsJson: String,
    val favorite: Boolean,
    val hostKeyAlgorithm: String?,
    val hostKeyFingerprint: String?,
    val lastConnectedAt: String?,
    val createdAt: String,
    val updatedAt: String
)

internal class AndroidLocalStore(context: Context) : SQLiteOpenHelper(
    context.applicationContext,
    DATABASE_NAME,
    null,
    DATABASE_VERSION
) {
    companion object {
        private const val DATABASE_NAME = "relay-local.db"
        private const val DATABASE_VERSION = 1
        private const val MAX_HOSTS = 256
        private const val MAX_LIST_RESULTS = 128
        private const val META_TABLE = "relay_meta"
        private const val HOST_TABLE = "relay_hosts"
    }

    override fun onCreate(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE $META_TABLE (
                meta_key TEXT PRIMARY KEY NOT NULL,
                meta_value TEXT NOT NULL
            )
            """.trimIndent()
        )
        database.execSQL(
            """
            CREATE TABLE $HOST_TABLE (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                address TEXT NOT NULL,
                port INTEGER NOT NULL,
                username TEXT NOT NULL,
                auth_type TEXT NOT NULL,
                credential_ciphertext TEXT,
                group_id TEXT,
                terminal_profile_id TEXT,
                jump_host_ids_json TEXT NOT NULL,
                keepalive_interval_ms INTEGER NOT NULL,
                keepalive_count_max INTEGER NOT NULL,
                reconnect_enabled INTEGER NOT NULL,
                reconnect_max_attempts INTEGER NOT NULL,
                reconnect_base_delay_ms INTEGER NOT NULL,
                reconnect_max_delay_ms INTEGER NOT NULL,
                tags_json TEXT NOT NULL,
                favorite INTEGER NOT NULL,
                host_key_algorithm TEXT,
                host_key_fingerprint TEXT,
                last_connected_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        database.execSQL("CREATE INDEX relay_hosts_name_idx ON $HOST_TABLE(name COLLATE NOCASE)")
        database.execSQL("CREATE INDEX relay_hosts_group_idx ON $HOST_TABLE(group_id)")
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Versioned migrations will be added before changing the schema. A
        // release build must never silently discard local connection data.
        if (oldVersion != newVersion) error("unsupported local database upgrade")
    }

    fun getMeta(key: String): String? {
        readableDatabase.query(
            META_TABLE,
            arrayOf("meta_value"),
            "meta_key = ?",
            arrayOf(key),
            null,
            null,
            null,
            "1"
        ).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }

    fun putMeta(key: String, value: String) {
        val values = ContentValues().apply {
            put("meta_key", key)
            put("meta_value", value)
        }
        writableDatabase.insertWithOnConflict(META_TABLE, null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun deleteMeta(key: String) {
        writableDatabase.delete(META_TABLE, "meta_key = ?", arrayOf(key))
    }

    fun getHost(id: String): AndroidHost? {
        readableDatabase.query(
            HOST_TABLE,
            HOST_COLUMNS,
            "id = ?",
            arrayOf(id),
            null,
            null,
            null,
            "1"
        ).use { cursor ->
            return if (cursor.moveToFirst()) readHost(cursor) else null
        }
    }

    fun listHosts(query: String?, groupId: String?, favorite: Boolean?, tags: Set<String>): List<AndroidHost> {
        val selection = mutableListOf<String>()
        val arguments = mutableListOf<String>()
        val trimmedQuery = query?.trim().orEmpty()
        if (trimmedQuery.isNotEmpty()) {
            selection += "(name LIKE ? OR address LIKE ? OR username LIKE ?)"
            val pattern = "%$trimmedQuery%"
            arguments += pattern
            arguments += pattern
            arguments += pattern
        }
        if (groupId != null) {
            selection += "group_id = ?"
            arguments += groupId
        }
        if (favorite == true) selection += "favorite = 1"

        val result = ArrayList<AndroidHost>(minOf(MAX_LIST_RESULTS, MAX_HOSTS))
        readableDatabase.query(
            HOST_TABLE,
            HOST_COLUMNS,
            selection.takeIf { it.isNotEmpty() }?.joinToString(" AND "),
            arguments.toTypedArray(),
            null,
            null,
            "favorite DESC, name COLLATE NOCASE ASC",
            MAX_LIST_RESULTS.toString()
        ).use { cursor ->
            while (cursor.moveToNext() && result.size < MAX_LIST_RESULTS) {
                val host = readHost(cursor)
                if (tags.isEmpty() || decodeList(host.tagsJson).containsAll(tags)) result += host
            }
        }
        return result
    }

    fun countHosts(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM $HOST_TABLE", null).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getInt(0) else 0
        }
    }

    fun putHost(host: AndroidHost) {
        require(countHosts() < MAX_HOSTS || getHost(host.id) != null) { "local host limit reached" }
        writableDatabase.insertWithOnConflict(HOST_TABLE, null, hostValues(host), SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun deleteHost(id: String): Boolean = writableDatabase.delete(HOST_TABLE, "id = ?", arrayOf(id)) > 0

    fun updateHostKey(id: String, algorithm: String?, fingerprint: String?): Boolean {
        val values = ContentValues().apply {
            if (algorithm == null) putNull("host_key_algorithm") else put("host_key_algorithm", algorithm)
            if (fingerprint == null) putNull("host_key_fingerprint") else put("host_key_fingerprint", fingerprint)
            put("updated_at", nowIso())
        }
        return writableDatabase.update(HOST_TABLE, values, "id = ?", arrayOf(id)) > 0
    }

    fun markConnected(id: String, at: String = nowIso()) {
        val values = ContentValues().apply {
            put("last_connected_at", at)
            put("updated_at", at)
        }
        writableDatabase.update(HOST_TABLE, values, "id = ?", arrayOf(id))
    }

    private fun hostValues(host: AndroidHost): ContentValues = ContentValues().apply {
        put("id", host.id)
        put("name", host.name)
        put("address", host.address)
        put("port", host.port)
        put("username", host.username)
        put("auth_type", host.authType)
        if (host.credentialCiphertext == null) putNull("credential_ciphertext") else put("credential_ciphertext", host.credentialCiphertext)
        if (host.groupId == null) putNull("group_id") else put("group_id", host.groupId)
        if (host.terminalProfileId == null) putNull("terminal_profile_id") else put("terminal_profile_id", host.terminalProfileId)
        put("jump_host_ids_json", host.jumpHostIdsJson)
        put("keepalive_interval_ms", host.keepaliveIntervalMs)
        put("keepalive_count_max", host.keepaliveCountMax)
        put("reconnect_enabled", if (host.reconnectEnabled) 1 else 0)
        put("reconnect_max_attempts", host.reconnectMaxAttempts)
        put("reconnect_base_delay_ms", host.reconnectBaseDelayMs)
        put("reconnect_max_delay_ms", host.reconnectMaxDelayMs)
        put("tags_json", host.tagsJson)
        put("favorite", if (host.favorite) 1 else 0)
        if (host.hostKeyAlgorithm == null) putNull("host_key_algorithm") else put("host_key_algorithm", host.hostKeyAlgorithm)
        if (host.hostKeyFingerprint == null) putNull("host_key_fingerprint") else put("host_key_fingerprint", host.hostKeyFingerprint)
        if (host.lastConnectedAt == null) putNull("last_connected_at") else put("last_connected_at", host.lastConnectedAt)
        put("created_at", host.createdAt)
        put("updated_at", host.updatedAt)
    }

    private fun readHost(cursor: android.database.Cursor): AndroidHost = AndroidHost(
        id = cursor.getString(0),
        name = cursor.getString(1),
        address = cursor.getString(2),
        port = cursor.getInt(3),
        username = cursor.getString(4),
        authType = cursor.getString(5),
        credentialCiphertext = cursor.getStringOrNull(6),
        groupId = cursor.getStringOrNull(7),
        terminalProfileId = cursor.getStringOrNull(8),
        jumpHostIdsJson = cursor.getString(9),
        keepaliveIntervalMs = cursor.getInt(10),
        keepaliveCountMax = cursor.getInt(11),
        reconnectEnabled = cursor.getInt(12) != 0,
        reconnectMaxAttempts = cursor.getInt(13),
        reconnectBaseDelayMs = cursor.getInt(14),
        reconnectMaxDelayMs = cursor.getInt(15),
        tagsJson = cursor.getString(16),
        favorite = cursor.getInt(17) != 0,
        hostKeyAlgorithm = cursor.getStringOrNull(18),
        hostKeyFingerprint = cursor.getStringOrNull(19),
        lastConnectedAt = cursor.getStringOrNull(20),
        createdAt = cursor.getString(21),
        updatedAt = cursor.getString(22)
    )

    private fun decodeList(value: String): Set<String> = try {
        org.json.JSONArray(value).let { array ->
            buildSet {
                for (index in 0 until minOf(array.length(), 32)) {
                    val item = array.optString(index, "")
                    if (item.isNotEmpty()) add(item)
                }
            }
        }
    } catch (_: Exception) {
        emptySet()
    }

    private fun android.database.Cursor.getStringOrNull(index: Int): String? = if (isNull(index)) null else getString(index)

    private fun nowIso(): String = java.time.Instant.now().toString()

    private val HOST_COLUMNS = arrayOf(
        "id", "name", "address", "port", "username", "auth_type", "credential_ciphertext",
        "group_id", "terminal_profile_id", "jump_host_ids_json", "keepalive_interval_ms",
        "keepalive_count_max", "reconnect_enabled", "reconnect_max_attempts", "reconnect_base_delay_ms",
        "reconnect_max_delay_ms", "tags_json", "favorite", "host_key_algorithm", "host_key_fingerprint",
        "last_connected_at", "created_at", "updated_at"
    )
}
