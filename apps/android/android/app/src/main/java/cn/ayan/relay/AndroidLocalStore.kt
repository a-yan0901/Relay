package cn.ayan.relay

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteConstraintException
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
    val credentialSource: String,
    val identityId: String?,
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

internal data class AndroidIdentity(
    val id: String,
    val name: String,
    val type: String,
    val username: String,
    val keyFingerprint: String?,
    val credentialCiphertext: String,
    val createdAt: String,
    val updatedAt: String
)

internal data class AndroidGroup(
    val id: String,
    val name: String,
    val parentId: String?,
    val sortOrder: Int,
    val defaultIdentityId: String?,
    val connectionProfileJson: String?,
    val createdAt: String,
    val updatedAt: String
)

internal data class AndroidTerminalProfile(
    val id: String,
    val name: String,
    val appearanceJson: String,
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
        private const val DATABASE_VERSION = 2
        private const val MAX_HOSTS = 256
        private const val MAX_IDENTITIES = 128
        private const val MAX_GROUPS = 256
        private const val MAX_TERMINAL_PROFILES = 100
        private const val MAX_LIST_RESULTS = 128
        private const val META_TABLE = "relay_meta"
        private const val HOST_TABLE = "relay_hosts"
        private const val IDENTITY_TABLE = "relay_identities"
        private const val GROUP_TABLE = "relay_groups"
        private const val TERMINAL_PROFILE_TABLE = "relay_terminal_profiles"
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
                credential_source TEXT NOT NULL DEFAULT 'inline',
                identity_id TEXT,
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
        createAuxiliaryTables(database)
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion == 1 && newVersion == 2) {
            database.execSQL("ALTER TABLE $HOST_TABLE ADD COLUMN credential_source TEXT NOT NULL DEFAULT 'inline'")
            database.execSQL("ALTER TABLE $HOST_TABLE ADD COLUMN identity_id TEXT")
            createAuxiliaryTables(database)
            return
        }
        // A release build must never silently discard local connection data.
        if (oldVersion != newVersion) error("unsupported local database upgrade")
    }

    private fun createAuxiliaryTables(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $IDENTITY_TABLE (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL UNIQUE,
                type TEXT NOT NULL,
                username TEXT NOT NULL,
                key_fingerprint TEXT,
                credential_ciphertext TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $GROUP_TABLE (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL UNIQUE,
                parent_id TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                default_identity_id TEXT,
                connection_profile_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $TERMINAL_PROFILE_TABLE (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL UNIQUE,
                appearance_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_groups_parent_idx ON $GROUP_TABLE(parent_id)")
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_groups_sort_idx ON $GROUP_TABLE(sort_order, name COLLATE NOCASE)")
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_identities_name_idx ON $IDENTITY_TABLE(name COLLATE NOCASE)")
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_profiles_name_idx ON $TERMINAL_PROFILE_TABLE(name COLLATE NOCASE)")
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_hosts_identity_idx ON $HOST_TABLE(identity_id)")
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

    fun listHostsForExport(): List<AndroidHost> {
        val result = ArrayList<AndroidHost>(MAX_HOSTS)
        readableDatabase.query(
            HOST_TABLE,
            HOST_COLUMNS,
            null,
            null,
            null,
            null,
            "name COLLATE NOCASE ASC",
            MAX_HOSTS.toString()
        ).use { cursor ->
            while (cursor.moveToNext() && result.size < MAX_HOSTS) result += readHost(cursor)
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

    fun getIdentity(id: String): AndroidIdentity? {
        readableDatabase.query(
            IDENTITY_TABLE,
            IDENTITY_COLUMNS,
            "id = ?",
            arrayOf(id),
            null,
            null,
            null,
            "1"
        ).use { cursor -> return if (cursor.moveToFirst()) readIdentity(cursor) else null }
    }

    fun listIdentities(): List<AndroidIdentity> {
        val result = ArrayList<AndroidIdentity>(minOf(MAX_LIST_RESULTS, MAX_IDENTITIES))
        readableDatabase.query(
            IDENTITY_TABLE,
            IDENTITY_COLUMNS,
            null,
            null,
            null,
            null,
            "name COLLATE NOCASE ASC",
            MAX_LIST_RESULTS.toString()
        ).use { cursor -> while (cursor.moveToNext() && result.size < MAX_LIST_RESULTS) result += readIdentity(cursor) }
        return result
    }

    fun listIdentitiesForExport(): List<AndroidIdentity> {
        // Keep export bounded independently from the UI page size. The cap is
        // still small enough that a bundle cannot materialize an unbounded
        // credential set in the Android process.
        val result = ArrayList<AndroidIdentity>(MAX_IDENTITIES)
        readableDatabase.query(
            IDENTITY_TABLE,
            IDENTITY_COLUMNS,
            null,
            null,
            null,
            null,
            "name COLLATE NOCASE ASC",
            MAX_IDENTITIES.toString()
        ).use { cursor -> while (cursor.moveToNext() && result.size < MAX_IDENTITIES) result += readIdentity(cursor) }
        return result
    }

    fun countIdentities(): Int = countRows(IDENTITY_TABLE)

    fun countIdentityReferences(id: String): Int {
        val hosts = readableDatabase.rawQuery(
            "SELECT COUNT(*) FROM $HOST_TABLE WHERE credential_source = 'identity' AND identity_id = ?",
            arrayOf(id)
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else 0 }
        val groups = readableDatabase.rawQuery(
            "SELECT COUNT(*) FROM $GROUP_TABLE WHERE default_identity_id = ?",
            arrayOf(id)
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else 0 }
        return hosts + groups
    }

    fun putIdentity(identity: AndroidIdentity): Boolean {
        require(countIdentities() < MAX_IDENTITIES || getIdentity(identity.id) != null) { "local identity limit reached" }
        val values = ContentValues().apply {
            put("id", identity.id)
            put("name", identity.name)
            put("type", identity.type)
            put("username", identity.username)
            if (identity.keyFingerprint == null) putNull("key_fingerprint") else put("key_fingerprint", identity.keyFingerprint)
            put("credential_ciphertext", identity.credentialCiphertext)
            put("created_at", identity.createdAt)
            put("updated_at", identity.updatedAt)
        }
        val existing = getIdentity(identity.id)
        return if (existing == null) {
            try {
                writableDatabase.insertWithOnConflict(IDENTITY_TABLE, null, values, SQLiteDatabase.CONFLICT_ABORT) != -1L
            } catch (_: SQLiteConstraintException) {
                false
            }
        } else {
            writableDatabase.update(IDENTITY_TABLE, values, "id = ?", arrayOf(identity.id)) > 0
        }
    }

    fun deleteIdentity(id: String): Boolean = writableDatabase.delete(IDENTITY_TABLE, "id = ?", arrayOf(id)) > 0

    fun getGroup(id: String): AndroidGroup? {
        readableDatabase.query(
            GROUP_TABLE,
            GROUP_COLUMNS,
            "id = ?",
            arrayOf(id),
            null,
            null,
            null,
            "1"
        ).use { cursor -> return if (cursor.moveToFirst()) readGroup(cursor) else null }
    }

    fun listGroups(): List<AndroidGroup> {
        val result = ArrayList<AndroidGroup>(minOf(MAX_LIST_RESULTS, MAX_GROUPS))
        readableDatabase.query(
            GROUP_TABLE,
            GROUP_COLUMNS,
            null,
            null,
            null,
            null,
            "sort_order ASC, name COLLATE NOCASE ASC",
            MAX_LIST_RESULTS.toString()
        ).use { cursor -> while (cursor.moveToNext() && result.size < MAX_LIST_RESULTS) result += readGroup(cursor) }
        return result
    }

    fun listGroupsForExport(): List<AndroidGroup> {
        val result = ArrayList<AndroidGroup>(MAX_GROUPS)
        readableDatabase.query(
            GROUP_TABLE,
            GROUP_COLUMNS,
            null,
            null,
            null,
            null,
            "sort_order ASC, name COLLATE NOCASE ASC",
            MAX_GROUPS.toString()
        ).use { cursor -> while (cursor.moveToNext() && result.size < MAX_GROUPS) result += readGroup(cursor) }
        return result
    }

    fun countGroups(): Int = countRows(GROUP_TABLE)

    fun putGroup(group: AndroidGroup): Boolean {
        require(countGroups() < MAX_GROUPS || getGroup(group.id) != null) { "local group limit reached" }
        val values = ContentValues().apply {
            put("id", group.id)
            put("name", group.name)
            if (group.parentId == null) putNull("parent_id") else put("parent_id", group.parentId)
            put("sort_order", group.sortOrder)
            if (group.defaultIdentityId == null) putNull("default_identity_id") else put("default_identity_id", group.defaultIdentityId)
            if (group.connectionProfileJson == null) putNull("connection_profile_json") else put("connection_profile_json", group.connectionProfileJson)
            put("created_at", group.createdAt)
            put("updated_at", group.updatedAt)
        }
        val existing = getGroup(group.id)
        return if (existing == null) {
            try {
                writableDatabase.insertWithOnConflict(GROUP_TABLE, null, values, SQLiteDatabase.CONFLICT_ABORT) != -1L
            } catch (_: SQLiteConstraintException) {
                false
            }
        } else {
            writableDatabase.update(GROUP_TABLE, values, "id = ?", arrayOf(group.id)) > 0
        }
    }

    fun deleteGroup(id: String): Boolean {
        val current = getGroup(id) ?: return false
        writableDatabase.beginTransaction()
        try {
            val inUse = readableDatabase.rawQuery(
                "SELECT 1 FROM $HOST_TABLE WHERE group_id = ? AND credential_source = 'group' LIMIT 1",
                arrayOf(id)
            ).use { it.moveToFirst() }
            if (inUse) throw NativeVaultFailure("GROUP_IN_USE")
            val hostValues = ContentValues().apply { putNull("group_id"); put("updated_at", nowIso()) }
            writableDatabase.update(HOST_TABLE, hostValues, "group_id = ?", arrayOf(id))
            val childValues = ContentValues().apply {
                if (current.parentId == null) putNull("parent_id") else put("parent_id", current.parentId)
                put("updated_at", nowIso())
            }
            writableDatabase.update(GROUP_TABLE, childValues, "parent_id = ?", arrayOf(id))
            val deleted = writableDatabase.delete(GROUP_TABLE, "id = ?", arrayOf(id)) > 0
            writableDatabase.setTransactionSuccessful()
            return deleted
        } finally {
            writableDatabase.endTransaction()
        }
    }

    fun getTerminalProfile(id: String): AndroidTerminalProfile? {
        readableDatabase.query(
            TERMINAL_PROFILE_TABLE,
            TERMINAL_PROFILE_COLUMNS,
            "id = ?",
            arrayOf(id),
            null,
            null,
            null,
            "1"
        ).use { cursor -> return if (cursor.moveToFirst()) readTerminalProfile(cursor) else null }
    }

    fun listTerminalProfiles(): List<AndroidTerminalProfile> {
        val result = ArrayList<AndroidTerminalProfile>(MAX_TERMINAL_PROFILES)
        readableDatabase.query(
            TERMINAL_PROFILE_TABLE,
            TERMINAL_PROFILE_COLUMNS,
            null,
            null,
            null,
            null,
            "name COLLATE NOCASE ASC",
            MAX_TERMINAL_PROFILES.toString()
        ).use { cursor -> while (cursor.moveToNext() && result.size < MAX_TERMINAL_PROFILES) result += readTerminalProfile(cursor) }
        return result
    }

    fun countTerminalProfiles(): Int = countRows(TERMINAL_PROFILE_TABLE)

    fun putTerminalProfile(profile: AndroidTerminalProfile): Boolean {
        require(countTerminalProfiles() < MAX_TERMINAL_PROFILES || getTerminalProfile(profile.id) != null) { "local terminal profile limit reached" }
        val values = ContentValues().apply {
            put("id", profile.id)
            put("name", profile.name)
            put("appearance_json", profile.appearanceJson)
            put("created_at", profile.createdAt)
            put("updated_at", profile.updatedAt)
        }
        val existing = getTerminalProfile(profile.id)
        return if (existing == null) {
            try {
                writableDatabase.insertWithOnConflict(TERMINAL_PROFILE_TABLE, null, values, SQLiteDatabase.CONFLICT_ABORT) != -1L
            } catch (_: SQLiteConstraintException) {
                false
            }
        } else {
            writableDatabase.update(TERMINAL_PROFILE_TABLE, values, "id = ?", arrayOf(profile.id)) > 0
        }
    }

    fun deleteTerminalProfile(id: String): Boolean = writableDatabase.delete(TERMINAL_PROFILE_TABLE, "id = ?", arrayOf(id)) > 0

    fun countTerminalProfileReferences(id: String): Int = readableDatabase.rawQuery(
        "SELECT COUNT(*) FROM $HOST_TABLE WHERE terminal_profile_id = ?",
        arrayOf(id)
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else 0 }

    fun getDefaultTerminalProfileId(): String? = getMeta("terminal.default-profile.v1")

    fun setDefaultTerminalProfileId(id: String) { putMeta("terminal.default-profile.v1", id) }

    fun <T> transaction(block: () -> T): T {
        val database = writableDatabase
        database.beginTransaction()
        return try {
            val result = block()
            database.setTransactionSuccessful()
            result
        } finally {
            database.endTransaction()
        }
    }

    private fun hostValues(host: AndroidHost): ContentValues = ContentValues().apply {
        put("id", host.id)
        put("name", host.name)
        put("address", host.address)
        put("port", host.port)
        put("username", host.username)
        put("auth_type", host.authType)
        if (host.credentialCiphertext == null) putNull("credential_ciphertext") else put("credential_ciphertext", host.credentialCiphertext)
        put("credential_source", host.credentialSource)
        if (host.identityId == null) putNull("identity_id") else put("identity_id", host.identityId)
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
        credentialSource = cursor.getString(7),
        identityId = cursor.getStringOrNull(8),
        groupId = cursor.getStringOrNull(9),
        terminalProfileId = cursor.getStringOrNull(10),
        jumpHostIdsJson = cursor.getString(11),
        keepaliveIntervalMs = cursor.getInt(12),
        keepaliveCountMax = cursor.getInt(13),
        reconnectEnabled = cursor.getInt(14) != 0,
        reconnectMaxAttempts = cursor.getInt(15),
        reconnectBaseDelayMs = cursor.getInt(16),
        reconnectMaxDelayMs = cursor.getInt(17),
        tagsJson = cursor.getString(18),
        favorite = cursor.getInt(19) != 0,
        hostKeyAlgorithm = cursor.getStringOrNull(20),
        hostKeyFingerprint = cursor.getStringOrNull(21),
        lastConnectedAt = cursor.getStringOrNull(22),
        createdAt = cursor.getString(23),
        updatedAt = cursor.getString(24)
    )

    private fun readIdentity(cursor: android.database.Cursor): AndroidIdentity = AndroidIdentity(
        id = cursor.getString(0),
        name = cursor.getString(1),
        type = cursor.getString(2),
        username = cursor.getString(3),
        keyFingerprint = cursor.getStringOrNull(4),
        credentialCiphertext = cursor.getString(5),
        createdAt = cursor.getString(6),
        updatedAt = cursor.getString(7)
    )

    private fun readGroup(cursor: android.database.Cursor): AndroidGroup = AndroidGroup(
        id = cursor.getString(0),
        name = cursor.getString(1),
        parentId = cursor.getStringOrNull(2),
        sortOrder = cursor.getInt(3),
        defaultIdentityId = cursor.getStringOrNull(4),
        connectionProfileJson = cursor.getStringOrNull(5),
        createdAt = cursor.getString(6),
        updatedAt = cursor.getString(7)
    )

    private fun readTerminalProfile(cursor: android.database.Cursor): AndroidTerminalProfile = AndroidTerminalProfile(
        id = cursor.getString(0),
        name = cursor.getString(1),
        appearanceJson = cursor.getString(2),
        createdAt = cursor.getString(3),
        updatedAt = cursor.getString(4)
    )

    private fun countRows(table: String): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM $table", null).use { cursor ->
        if (cursor.moveToFirst()) cursor.getInt(0) else 0
    }

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
        "credential_source", "identity_id", "group_id", "terminal_profile_id", "jump_host_ids_json", "keepalive_interval_ms",
        "keepalive_count_max", "reconnect_enabled", "reconnect_max_attempts", "reconnect_base_delay_ms",
        "reconnect_max_delay_ms", "tags_json", "favorite", "host_key_algorithm", "host_key_fingerprint",
        "last_connected_at", "created_at", "updated_at"
    )

    private val IDENTITY_COLUMNS = arrayOf("id", "name", "type", "username", "key_fingerprint", "credential_ciphertext", "created_at", "updated_at")
    private val GROUP_COLUMNS = arrayOf("id", "name", "parent_id", "sort_order", "default_identity_id", "connection_profile_json", "created_at", "updated_at")
    private val TERMINAL_PROFILE_COLUMNS = arrayOf("id", "name", "appearance_json", "created_at", "updated_at")
}
