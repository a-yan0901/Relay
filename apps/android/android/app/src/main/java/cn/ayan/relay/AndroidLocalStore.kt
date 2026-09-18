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

internal data class AndroidSnippet(
    val id: String,
    val name: String,
    val description: String?,
    val tagsJson: String,
    val commandCiphertext: String,
    val variablesJson: String,
    val createdAt: String,
    val updatedAt: String
)

internal data class AndroidTransferRecord(
    val id: String,
    val kind: String,
    val hostId: String,
    val sourcePath: String,
    val targetPath: String,
    val status: String,
    val completedBytes: Long,
    val totalBytes: Long?,
    val checksum: String?,
    val errorCode: String?,
    val createdAt: String,
    val updatedAt: String
)

internal data class AndroidCommandRunRecord(
    val id: String,
    val commandCiphertext: String,
    val hostIdsJson: String,
    val status: String,
    val persistOutput: Boolean,
    val createdAt: String,
    val finishedAt: String?
)

internal data class AndroidCommandTargetRecord(
    val runId: String,
    val hostId: String,
    val status: String,
    val exitCode: Int?,
    val outputCiphertext: String?,
    val outputBytes: Int,
    val outputTruncated: Boolean,
    val errorCode: String?,
    val startedAt: String?,
    val finishedAt: String?
)

internal data class AndroidActivityRecord(
    val id: String,
    val eventType: String,
    val hostId: String?,
    val requestId: String,
    val metadataJson: String,
    val createdAt: String
)

internal class AndroidLocalStore(context: Context) : SQLiteOpenHelper(
    context.applicationContext,
    DATABASE_NAME,
    null,
        DATABASE_VERSION
) {
    companion object {
        private const val DATABASE_NAME = "relay-local.db"
        private const val DATABASE_VERSION = 6
        private const val MAX_HOSTS = 256
        private const val MAX_IDENTITIES = 128
        private const val MAX_GROUPS = 256
        private const val MAX_TERMINAL_PROFILES = 100
        private const val MAX_SNIPPETS = 256
        private const val MAX_TRANSFERS = 32
        private const val MAX_COMMAND_RUNS = 32
        private const val MAX_COMMAND_TARGETS = 256
        private const val MAX_ACTIVITY_EVENTS = 512
        private const val MAX_LIST_RESULTS = 128
        private const val META_TABLE = "relay_meta"
        private const val HOST_TABLE = "relay_hosts"
        private const val IDENTITY_TABLE = "relay_identities"
        private const val GROUP_TABLE = "relay_groups"
        private const val TERMINAL_PROFILE_TABLE = "relay_terminal_profiles"
        private const val SNIPPET_TABLE = "relay_snippets"
        private const val TRANSFER_TABLE = "relay_transfers"
        private const val COMMAND_RUN_TABLE = "relay_command_runs"
        private const val COMMAND_TARGET_TABLE = "relay_command_targets"
        private const val ACTIVITY_TABLE = "relay_activity_events"
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
        if (oldVersion < 2) {
            database.execSQL("ALTER TABLE $HOST_TABLE ADD COLUMN credential_source TEXT NOT NULL DEFAULT 'inline'")
            database.execSQL("ALTER TABLE $HOST_TABLE ADD COLUMN identity_id TEXT")
        }
        if (oldVersion < 3) createSnippetTable(database)
        if (oldVersion < 4) createTransferTable(database)
        if (oldVersion < 5) createCommandTables(database)
        if (oldVersion < 6) createActivityTable(database)
        createAuxiliaryTables(database)
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
        createSnippetTable(database)
        createTransferTable(database)
        createCommandTables(database)
        createActivityTable(database)
    }

    private fun createSnippetTable(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $SNIPPET_TABLE (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                tags_json TEXT NOT NULL,
                command_ciphertext TEXT NOT NULL,
                variables_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_snippets_name_idx ON $SNIPPET_TABLE(name COLLATE NOCASE)")
    }

    private fun createTransferTable(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $TRANSFER_TABLE (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                host_id TEXT NOT NULL,
                source_path TEXT NOT NULL,
                target_path TEXT NOT NULL,
                status TEXT NOT NULL,
                completed_bytes INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER,
                checksum TEXT,
                error_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_transfers_updated_idx ON $TRANSFER_TABLE(updated_at DESC)")
    }

    private fun createCommandTables(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $COMMAND_RUN_TABLE (
                id TEXT PRIMARY KEY NOT NULL,
                command_ciphertext TEXT NOT NULL,
                host_ids_json TEXT NOT NULL,
                status TEXT NOT NULL,
                persist_output INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                finished_at TEXT
            )
            """.trimIndent()
        )
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $COMMAND_TARGET_TABLE (
                run_id TEXT NOT NULL,
                host_id TEXT NOT NULL,
                status TEXT NOT NULL,
                exit_code INTEGER,
                output_ciphertext TEXT,
                output_bytes INTEGER NOT NULL DEFAULT 0,
                output_truncated INTEGER NOT NULL DEFAULT 0,
                error_code TEXT,
                started_at TEXT,
                finished_at TEXT,
                PRIMARY KEY (run_id, host_id)
            )
            """.trimIndent()
        )
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_command_runs_created_idx ON $COMMAND_RUN_TABLE(created_at DESC)")
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_command_targets_run_idx ON $COMMAND_TARGET_TABLE(run_id)")
    }

    private fun createActivityTable(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $ACTIVITY_TABLE (
                id TEXT PRIMARY KEY NOT NULL,
                event_type TEXT NOT NULL,
                host_id TEXT,
                request_id TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_activity_created_idx ON $ACTIVITY_TABLE(created_at DESC)")
        database.execSQL("CREATE INDEX IF NOT EXISTS relay_activity_request_idx ON $ACTIVITY_TABLE(request_id)")
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

    fun getSnippet(id: String): AndroidSnippet? {
        readableDatabase.query(
            SNIPPET_TABLE,
            SNIPPET_COLUMNS,
            "id = ?",
            arrayOf(id),
            null,
            null,
            null,
            "1"
        ).use { cursor -> return if (cursor.moveToFirst()) readSnippet(cursor) else null }
    }

    fun listSnippets(): List<AndroidSnippet> {
        val result = ArrayList<AndroidSnippet>(minOf(MAX_LIST_RESULTS, MAX_SNIPPETS))
        readableDatabase.query(
            SNIPPET_TABLE,
            SNIPPET_COLUMNS,
            null,
            null,
            null,
            null,
            "name COLLATE NOCASE ASC",
            MAX_LIST_RESULTS.toString()
        ).use { cursor -> while (cursor.moveToNext() && result.size < MAX_LIST_RESULTS) result += readSnippet(cursor) }
        return result
    }

    fun countSnippets(): Int = countRows(SNIPPET_TABLE)

    fun putSnippet(snippet: AndroidSnippet): Boolean {
        require(countSnippets() < MAX_SNIPPETS || getSnippet(snippet.id) != null) { "local snippet limit reached" }
        val values = ContentValues().apply {
            put("id", snippet.id)
            put("name", snippet.name)
            if (snippet.description == null) putNull("description") else put("description", snippet.description)
            put("tags_json", snippet.tagsJson)
            put("command_ciphertext", snippet.commandCiphertext)
            put("variables_json", snippet.variablesJson)
            put("created_at", snippet.createdAt)
            put("updated_at", snippet.updatedAt)
        }
        val existing = getSnippet(snippet.id)
        return if (existing == null) {
            try {
                writableDatabase.insertWithOnConflict(SNIPPET_TABLE, null, values, SQLiteDatabase.CONFLICT_ABORT) != -1L
            } catch (_: SQLiteConstraintException) {
                false
            }
        } else {
            writableDatabase.update(SNIPPET_TABLE, values, "id = ?", arrayOf(snippet.id)) > 0
        }
    }

    fun deleteSnippet(id: String): Boolean = writableDatabase.delete(SNIPPET_TABLE, "id = ?", arrayOf(id)) > 0

    fun getTransfer(id: String): AndroidTransferRecord? {
        readableDatabase.query(
            TRANSFER_TABLE,
            TRANSFER_COLUMNS,
            "id = ?",
            arrayOf(id),
            null,
            null,
            null,
            "1"
        ).use { cursor -> return if (cursor.moveToFirst()) readTransfer(cursor) else null }
    }

    fun listTransfers(): List<AndroidTransferRecord> {
        val result = ArrayList<AndroidTransferRecord>(MAX_TRANSFERS)
        readableDatabase.query(
            TRANSFER_TABLE,
            TRANSFER_COLUMNS,
            null,
            null,
            null,
            null,
            "updated_at DESC",
            MAX_TRANSFERS.toString()
        ).use { cursor -> while (cursor.moveToNext() && result.size < MAX_TRANSFERS) result += readTransfer(cursor) }
        return result
    }

    fun countTransfers(): Int = countRows(TRANSFER_TABLE)

    fun putTransfer(transfer: AndroidTransferRecord) {
        require(countTransfers() < MAX_TRANSFERS || getTransfer(transfer.id) != null) { "local transfer limit reached" }
        val values = ContentValues().apply {
            put("id", transfer.id)
            put("kind", transfer.kind)
            put("host_id", transfer.hostId)
            put("source_path", transfer.sourcePath)
            put("target_path", transfer.targetPath)
            put("status", transfer.status)
            put("completed_bytes", transfer.completedBytes)
            if (transfer.totalBytes == null) putNull("total_bytes") else put("total_bytes", transfer.totalBytes)
            if (transfer.checksum == null) putNull("checksum") else put("checksum", transfer.checksum)
            if (transfer.errorCode == null) putNull("error_code") else put("error_code", transfer.errorCode)
            put("created_at", transfer.createdAt)
            put("updated_at", transfer.updatedAt)
        }
        writableDatabase.insertWithOnConflict(TRANSFER_TABLE, null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun deleteTransfer(id: String): Boolean = writableDatabase.delete(TRANSFER_TABLE, "id = ?", arrayOf(id)) > 0

    fun getCommandRun(id: String): AndroidCommandRunRecord? {
        readableDatabase.query(
            COMMAND_RUN_TABLE,
            COMMAND_RUN_COLUMNS,
            "id = ?",
            arrayOf(id),
            null,
            null,
            null,
            "1"
        ).use { cursor -> return if (cursor.moveToFirst()) readCommandRun(cursor) else null }
    }

    fun listCommandRuns(): List<AndroidCommandRunRecord> {
        val result = ArrayList<AndroidCommandRunRecord>(MAX_COMMAND_RUNS)
        readableDatabase.query(
            COMMAND_RUN_TABLE,
            COMMAND_RUN_COLUMNS,
            null,
            null,
            null,
            null,
            "created_at DESC",
            MAX_COMMAND_RUNS.toString()
        ).use { cursor -> while (cursor.moveToNext() && result.size < MAX_COMMAND_RUNS) result += readCommandRun(cursor) }
        return result
    }

    fun countCommandRuns(): Int = countRows(COMMAND_RUN_TABLE)

    fun putCommandRun(run: AndroidCommandRunRecord) {
        require(countCommandRuns() < MAX_COMMAND_RUNS || getCommandRun(run.id) != null) { "local command run limit reached" }
        val values = ContentValues().apply {
            put("id", run.id)
            put("command_ciphertext", run.commandCiphertext)
            put("host_ids_json", run.hostIdsJson)
            put("status", run.status)
            put("persist_output", if (run.persistOutput) 1 else 0)
            put("created_at", run.createdAt)
            if (run.finishedAt == null) putNull("finished_at") else put("finished_at", run.finishedAt)
        }
        val existing = getCommandRun(run.id)
        if (existing == null) {
            writableDatabase.insertWithOnConflict(COMMAND_RUN_TABLE, null, values, SQLiteDatabase.CONFLICT_ABORT)
        } else {
            writableDatabase.update(COMMAND_RUN_TABLE, values, "id = ?", arrayOf(run.id))
        }
    }

    fun getCommandTarget(runId: String, hostId: String): AndroidCommandTargetRecord? {
        readableDatabase.query(
            COMMAND_TARGET_TABLE,
            COMMAND_TARGET_COLUMNS,
            "run_id = ? AND host_id = ?",
            arrayOf(runId, hostId),
            null,
            null,
            null,
            "1"
        ).use { cursor -> return if (cursor.moveToFirst()) readCommandTarget(cursor) else null }
    }

    fun listCommandTargets(runId: String): List<AndroidCommandTargetRecord> {
        val result = ArrayList<AndroidCommandTargetRecord>(MAX_COMMAND_TARGETS)
        readableDatabase.query(
            COMMAND_TARGET_TABLE,
            COMMAND_TARGET_COLUMNS,
            "run_id = ?",
            arrayOf(runId),
            null,
            null,
            "rowid ASC",
            MAX_COMMAND_TARGETS.toString()
        ).use { cursor -> while (cursor.moveToNext() && result.size < MAX_COMMAND_TARGETS) result += readCommandTarget(cursor) }
        return result
    }

    fun countCommandTargets(runId: String): Int = readableDatabase.rawQuery(
        "SELECT COUNT(*) FROM $COMMAND_TARGET_TABLE WHERE run_id = ?",
        arrayOf(runId)
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else 0 }

    fun putCommandTarget(target: AndroidCommandTargetRecord) {
        require(countCommandTargets(target.runId) < MAX_COMMAND_TARGETS || getCommandTarget(target.runId, target.hostId) != null) { "local command target limit reached" }
        val values = ContentValues().apply {
            put("run_id", target.runId)
            put("host_id", target.hostId)
            put("status", target.status)
            if (target.exitCode == null) putNull("exit_code") else put("exit_code", target.exitCode)
            if (target.outputCiphertext == null) putNull("output_ciphertext") else put("output_ciphertext", target.outputCiphertext)
            put("output_bytes", target.outputBytes)
            put("output_truncated", if (target.outputTruncated) 1 else 0)
            if (target.errorCode == null) putNull("error_code") else put("error_code", target.errorCode)
            if (target.startedAt == null) putNull("started_at") else put("started_at", target.startedAt)
            if (target.finishedAt == null) putNull("finished_at") else put("finished_at", target.finishedAt)
        }
        writableDatabase.insertWithOnConflict(COMMAND_TARGET_TABLE, null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun deleteCommandRun(id: String): Boolean = transaction {
        writableDatabase.delete(COMMAND_TARGET_TABLE, "run_id = ?", arrayOf(id))
        writableDatabase.delete(COMMAND_RUN_TABLE, "id = ?", arrayOf(id)) > 0
    }

    fun trimCommandRuns(maxRuns: Int) {
        require(maxRuns >= 0) { "invalid command run retention" }
        transaction {
            val count = writableDatabase.rawQuery("SELECT COUNT(*) FROM $COMMAND_RUN_TABLE", null).use { cursor ->
                if (cursor.moveToFirst()) cursor.getInt(0) else 0
            }
            val removeCount = count - maxRuns
            if (removeCount <= 0) return@transaction
            writableDatabase.query(
                COMMAND_RUN_TABLE,
                arrayOf("id"),
                "status NOT IN (?, ?)",
                arrayOf("queued", "running"),
                null,
                null,
                "COALESCE(finished_at, created_at) ASC",
                removeCount.toString()
            ).use { cursor ->
                val ids = ArrayList<String>(removeCount)
                while (cursor.moveToNext()) ids += cursor.getString(0)
                ids.forEach {
                    writableDatabase.delete(COMMAND_TARGET_TABLE, "run_id = ?", arrayOf(it))
                    writableDatabase.delete(COMMAND_RUN_TABLE, "id = ?", arrayOf(it))
                }
            }
        }
    }

    fun markActiveCommandRunsInterrupted(errorCode: String, finishedAt: String): Int = transaction {
        val runCount = writableDatabase.update(
            COMMAND_RUN_TABLE,
            ContentValues().apply {
                put("status", "interrupted")
                put("finished_at", finishedAt)
            },
            "status IN (?, ?)",
            arrayOf("queued", "running")
        )
        writableDatabase.update(
            COMMAND_TARGET_TABLE,
            ContentValues().apply {
                put("status", "interrupted")
                put("error_code", errorCode)
                put("finished_at", finishedAt)
            },
            "status IN (?, ?)",
            arrayOf("queued", "running")
        )
        runCount
    }

    fun putActivity(event: AndroidActivityRecord) {
        val values = ContentValues().apply {
            put("id", event.id)
            put("event_type", event.eventType)
            if (event.hostId == null) putNull("host_id") else put("host_id", event.hostId)
            put("request_id", event.requestId)
            put("metadata_json", event.metadataJson)
            put("created_at", event.createdAt)
        }
        writableDatabase.insertWithOnConflict(ACTIVITY_TABLE, null, values, SQLiteDatabase.CONFLICT_REPLACE)
        val count = countRows(ACTIVITY_TABLE)
        val overflow = count - MAX_ACTIVITY_EVENTS
        if (overflow > 0) {
            writableDatabase.query(
                ACTIVITY_TABLE,
                arrayOf("id"),
                null,
                null,
                null,
                null,
                "created_at ASC, rowid ASC",
                overflow.toString()
            ).use { cursor ->
                val ids = ArrayList<String>(overflow)
                while (cursor.moveToNext()) ids += cursor.getString(0)
                ids.forEach { writableDatabase.delete(ACTIVITY_TABLE, "id = ?", arrayOf(it)) }
            }
        }
    }

    fun listActivities(): List<AndroidActivityRecord> {
        val result = ArrayList<AndroidActivityRecord>(MAX_ACTIVITY_EVENTS)
        readableDatabase.query(
            ACTIVITY_TABLE,
            ACTIVITY_COLUMNS,
            null,
            null,
            null,
            null,
            "created_at DESC, rowid DESC",
            MAX_ACTIVITY_EVENTS.toString()
        ).use { cursor -> while (cursor.moveToNext() && result.size < MAX_ACTIVITY_EVENTS) result += readActivity(cursor) }
        return result
    }

    fun countActivities(): Int = countRows(ACTIVITY_TABLE)

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

    private fun readSnippet(cursor: android.database.Cursor): AndroidSnippet = AndroidSnippet(
        id = cursor.getString(0),
        name = cursor.getString(1),
        description = cursor.getStringOrNull(2),
        tagsJson = cursor.getString(3),
        commandCiphertext = cursor.getString(4),
        variablesJson = cursor.getString(5),
        createdAt = cursor.getString(6),
        updatedAt = cursor.getString(7)
    )

    private fun readTransfer(cursor: android.database.Cursor): AndroidTransferRecord = AndroidTransferRecord(
        id = cursor.getString(0),
        kind = cursor.getString(1),
        hostId = cursor.getString(2),
        sourcePath = cursor.getString(3),
        targetPath = cursor.getString(4),
        status = cursor.getString(5),
        completedBytes = cursor.getLong(6),
        totalBytes = cursor.getLongOrNull(7),
        checksum = cursor.getStringOrNull(8),
        errorCode = cursor.getStringOrNull(9),
        createdAt = cursor.getString(10),
        updatedAt = cursor.getString(11)
    )

    private fun readCommandRun(cursor: android.database.Cursor): AndroidCommandRunRecord = AndroidCommandRunRecord(
        id = cursor.getString(0),
        commandCiphertext = cursor.getString(1),
        hostIdsJson = cursor.getString(2),
        status = cursor.getString(3),
        persistOutput = cursor.getInt(4) != 0,
        createdAt = cursor.getString(5),
        finishedAt = cursor.getStringOrNull(6)
    )

    private fun readCommandTarget(cursor: android.database.Cursor): AndroidCommandTargetRecord = AndroidCommandTargetRecord(
        runId = cursor.getString(0),
        hostId = cursor.getString(1),
        status = cursor.getString(2),
        exitCode = cursor.getIntOrNull(3),
        outputCiphertext = cursor.getStringOrNull(4),
        outputBytes = cursor.getInt(5),
        outputTruncated = cursor.getInt(6) != 0,
        errorCode = cursor.getStringOrNull(7),
        startedAt = cursor.getStringOrNull(8),
        finishedAt = cursor.getStringOrNull(9)
    )

    private fun readActivity(cursor: android.database.Cursor): AndroidActivityRecord = AndroidActivityRecord(
        id = cursor.getString(0),
        eventType = cursor.getString(1),
        hostId = cursor.getStringOrNull(2),
        requestId = cursor.getString(3),
        metadataJson = cursor.getString(4),
        createdAt = cursor.getString(5)
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

    private fun android.database.Cursor.getLongOrNull(index: Int): Long? = if (isNull(index)) null else getLong(index)

    private fun android.database.Cursor.getIntOrNull(index: Int): Int? = if (isNull(index)) null else getInt(index)

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
    private val SNIPPET_COLUMNS = arrayOf("id", "name", "description", "tags_json", "command_ciphertext", "variables_json", "created_at", "updated_at")
    private val TRANSFER_COLUMNS = arrayOf("id", "kind", "host_id", "source_path", "target_path", "status", "completed_bytes", "total_bytes", "checksum", "error_code", "created_at", "updated_at")
    private val COMMAND_RUN_COLUMNS = arrayOf("id", "command_ciphertext", "host_ids_json", "status", "persist_output", "created_at", "finished_at")
    private val COMMAND_TARGET_COLUMNS = arrayOf("run_id", "host_id", "status", "exit_code", "output_ciphertext", "output_bytes", "output_truncated", "error_code", "started_at", "finished_at")
    private val ACTIVITY_COLUMNS = arrayOf("id", "event_type", "host_id", "request_id", "metadata_json", "created_at")
}
