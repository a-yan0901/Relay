package cn.ayan.relay

import android.util.Base64
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Collections
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * Local implementation of the portable Vault bundle contract.
 *
 * Only one preview is retained and it expires after ten minutes. This is
 * intentional: a preview contains decrypted credential JSON and must not turn
 * into an unbounded in-memory queue on a low-memory device.
 */
internal class AndroidBundleService(
    private val store: AndroidLocalStore,
    private val vault: AndroidVault
) : AutoCloseable {
    companion object {
        private const val PREVIEW_TTL_MS = 10 * 60 * 1000L
        private const val MAX_PREVIEWS = 1
    }

    private data class PendingPreview(
        val payload: AndroidBundlePayload,
        val expiresAt: Long
    )

    private data class PendingExport(
        val bundle: String,
        val expiresAt: Long
    )

    private data class PendingImport(
        val exportPassword: String,
        val content: StringBuilder,
        var bytes: Int,
        val expiresAt: Long
    )

    private data class ConnectionSettings(
        val keepaliveIntervalMs: Int,
        val keepaliveCountMax: Int,
        val reconnectEnabled: Boolean,
        val reconnectMaxAttempts: Int,
        val reconnectBaseDelayMs: Int,
        val reconnectMaxDelayMs: Int
    )

    private val previews = Collections.synchronizedMap(mutableMapOf<String, PendingPreview>())
    private val exports = Collections.synchronizedMap(mutableMapOf<String, PendingExport>())
    private val imports = Collections.synchronizedMap(mutableMapOf<String, PendingImport>())

    fun export(exportPassword: String): JSONObject {
        val payload = AndroidBundlePayloadCodec.create(store, vault)
        return try {
            JSONObject().put("bundle", AndroidBundleCrypto.createEnvelope(exportPassword, payload))
        } finally {
            // createEnvelope also clears on its own; keeping this here makes
            // ownership explicit if the crypto implementation changes.
            payload.fill(0)
        }
    }

    /** Start a chunked export so the Capacitor bridge never carries an 8 MiB frame. */
    fun beginExport(exportPassword: String): JSONObject {
        val payload = AndroidBundlePayloadCodec.create(store, vault)
        val bundle = try {
            AndroidBundleCrypto.createEnvelope(exportPassword, payload)
        } finally {
            payload.fill(0)
        }
        val id = UUID.randomUUID().toString()
        synchronized(exports) {
            pruneExportsLocked()
            exports.clear()
            exports[id] = PendingExport(bundle, System.currentTimeMillis() + PREVIEW_TTL_MS)
        }
        return JSONObject().put("bundleId", id)
    }

    fun readExportChunk(bundleId: String, cursor: Int): JSONObject {
        AndroidNativeValidation.requireSafeId(bundleId)
        val pending = synchronized(exports) {
            pruneExportsLocked()
            exports[bundleId]
        } ?: failNative("VAULT_BUNDLE_PREVIEW_EXPIRED")
        if (cursor < 0 || cursor > pending.bundle.length) failNative("PROTOCOL_INVALID_MESSAGE")
        val end = utf8ChunkEnd(pending.bundle, cursor)
        val bytes = pending.bundle.substring(cursor, end).toByteArray(StandardCharsets.UTF_8)
        return try {
            JSONObject()
                .put("data", Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
                .put("nextCursor", end)
                .put("done", end >= pending.bundle.length)
        } finally {
            bytes.fill(0)
        }
    }

    fun releaseExport(bundleId: String) {
        AndroidNativeValidation.requireSafeId(bundleId)
        synchronized(exports) { exports.remove(bundleId) }
    }

    /** Start a chunked import; only one in-flight assembly is retained. */
    fun beginImport(exportPassword: String): JSONObject {
        if (exportPassword.length !in 8..4096) failNative("VAULT_BUNDLE_INVALID")
        val id = UUID.randomUUID().toString()
        synchronized(imports) {
            pruneImportsLocked()
            imports.clear()
            imports[id] = PendingImport(exportPassword, StringBuilder(), 0, System.currentTimeMillis() + PREVIEW_TTL_MS)
        }
        return JSONObject().put("importId", id)
    }

    fun appendImportChunk(importId: String, encoded: String) {
        AndroidNativeValidation.requireSafeId(importId)
        if (encoded.length > 48 * 1024 || !encoded.matches(Regex("^[A-Za-z0-9_-]*$"))) failNative("PROTOCOL_INVALID_MESSAGE")
        val bytes = try {
            Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        } catch (_: IllegalArgumentException) {
            failNative("PROTOCOL_INVALID_MESSAGE")
        }
        if (bytes.isEmpty() || bytes.size > AndroidNativeValidation.MAX_CHUNK_BYTES) {
            bytes.fill(0)
            failNative("PROTOCOL_INVALID_MESSAGE")
        }
        val chunk = try {
            String(bytes, StandardCharsets.UTF_8)
        } finally {
            bytes.fill(0)
        }
        val chunkBytes = chunk.toByteArray(StandardCharsets.UTF_8)
        try {
            synchronized(imports) {
                pruneImportsLocked()
                val pending = imports[importId] ?: failNative("VAULT_BUNDLE_PREVIEW_EXPIRED")
                if (pending.bytes > AndroidBundleCrypto.MAX_BUNDLE_BYTES - chunkBytes.size) failNative("FILE_TOO_LARGE")
                pending.content.append(chunk)
                pending.bytes += chunkBytes.size
            }
        } finally {
            chunkBytes.fill(0)
        }
    }

    fun finishImport(importId: String): JSONObject {
        AndroidNativeValidation.requireSafeId(importId)
        val pending = synchronized(imports) {
            pruneImportsLocked()
            imports.remove(importId)
        } ?: failNative("VAULT_BUNDLE_PREVIEW_EXPIRED")
        val bundle = pending.content.toString()
        pending.content.setLength(0)
        return try {
            preview(pending.exportPassword, bundle)
        } finally {
            // The immutable String is released as soon as this method returns;
            // the preview retains only the parsed, validated payload.
            pending.content.setLength(0)
        }
    }

    fun cancelImport(importId: String) {
        AndroidNativeValidation.requireSafeId(importId)
        synchronized(imports) { imports.remove(importId)?.content?.setLength(0) }
    }

    fun preview(exportPassword: String, bundle: String): JSONObject {
        val plaintext = AndroidBundleCrypto.decryptEnvelope(exportPassword, bundle)
        val payload = try {
            AndroidBundlePayloadCodec.parse(plaintext)
        } finally {
            plaintext.fill(0)
        }

        val conflicts = JSONArray()
        for (index in 0 until payload.identities.length()) {
            val identity = objectAt(payload.identities, index)
            val id = requiredId(identity, "id")
            store.getIdentity(id)?.let { conflicts.put(conflict("identity", id, it.name)) }
        }
        for (index in 0 until payload.groups.length()) {
            val group = objectAt(payload.groups, index)
            val id = requiredId(group, "id")
            store.getGroup(id)?.let { conflicts.put(conflict("group", id, it.name)) }
        }
        for (index in 0 until payload.hosts.length()) {
            val host = objectAt(payload.hosts, index)
            val id = requiredId(host, "id")
            store.getHost(id)?.let { conflicts.put(conflict("host", id, it.name)) }
        }

        val previewId = UUID.randomUUID().toString()
        val expiresAt = System.currentTimeMillis() + PREVIEW_TTL_MS
        synchronized(previews) {
            prunePreviewsLocked()
            // Replacing an older preview keeps decrypted data bounded to one
            // bundle and makes a new preview the active user operation.
            if (previews.size >= MAX_PREVIEWS) previews.clear()
            previews[previewId] = PendingPreview(payload, expiresAt)
        }
        return JSONObject()
            .put("previewId", previewId)
            .put("hostCount", payload.hosts.length())
            .put("groupCount", payload.groups.length())
            .put("identityCount", payload.identities.length())
            .put("conflicts", conflicts)
            .put("expiresAt", Instant.ofEpochMilli(expiresAt).toString())
    }

    fun apply(previewId: String, resolution: JSONObject): JSONObject {
        AndroidNativeValidation.requireSafeId(previewId)
        val pending = synchronized(previews) {
            prunePreviewsLocked()
            previews[previewId]
        } ?: failNative("VAULT_BUNDLE_PREVIEW_EXPIRED")

        val hostPolicy = resolution.optString("hostConflicts", "")
        val groupPolicy = resolution.optString("groupConflicts", "")
        val identityPolicy = if (!resolution.has("identityConflicts") || resolution.isNull("identityConflicts")) {
            "reuse"
        } else {
            resolution.optString("identityConflicts", "")
        }
        if (hostPolicy !in setOf("skip", "replace") ||
            groupPolicy !in setOf("reuse", "replace") ||
            identityPolicy !in setOf("reuse", "replace")
        ) failNative("VAULT_BUNDLE_INVALID")

        val payload = pending.payload
        val result = store.transaction {
            var importedIdentities = 0
            var skippedIdentities = 0
            var importedGroups = 0
            var skippedGroups = 0
            var importedHosts = 0
            var skippedHosts = 0

            for (index in 0 until payload.identities.length()) {
                val source = objectAt(payload.identities, index)
                val id = requiredId(source, "id")
                val existing = store.getIdentity(id)
                if (existing != null && identityPolicy == "reuse") {
                    skippedIdentities += 1
                    continue
                }
                val auth = objectField(source, "auth")
                val now = Instant.now().toString()
                val identity = AndroidIdentity(
                    id = id,
                    name = requiredText(source, "name", 120),
                    type = requiredText(source, "type", 32),
                    username = requiredText(source, "username", 255),
                    keyFingerprint = nullableText(source, "keyFingerprint", 255),
                    credentialCiphertext = vault.encryptSecret(auth.toString(), "identity:$id:credentials:v1"),
                    createdAt = existing?.createdAt ?: now,
                    updatedAt = now
                )
                if (!store.putIdentity(identity)) failNative("GROUP_ALREADY_EXISTS")
                importedIdentities += 1
            }

            for (group in orderedGroups(payload.groups)) {
                val id = requiredId(group, "id")
                val existing = store.getGroup(id)
                if (existing != null && groupPolicy == "reuse") {
                    skippedGroups += 1
                    continue
                }
                val now = Instant.now().toString()
                val model = AndroidGroup(
                    id = id,
                    name = requiredText(group, "name", 120),
                    parentId = nullableText(group, "parentId", 128),
                    sortOrder = group.optInt("sortOrder", 0),
                    defaultIdentityId = nullableText(group, "defaultIdentityId", 128),
                    connectionProfileJson = nullableObject(group, "connectionProfile")?.toString(),
                    createdAt = existing?.createdAt ?: now,
                    updatedAt = now
                )
                if (!store.putGroup(model)) failNative("GROUP_ALREADY_EXISTS")
                importedGroups += 1
            }

            for (index in 0 until payload.terminalProfiles.length()) {
                val source = objectAt(payload.terminalProfiles, index)
                val id = requiredId(source, "id")
                if (store.getTerminalProfile(id) != null) continue
                val now = Instant.now().toString()
                val profile = AndroidTerminalProfile(
                    id = id,
                    name = requiredText(source, "name", 120),
                    appearanceJson = objectField(source, "appearance").toString(),
                    createdAt = requiredText(source, "createdAt", 64).ifEmpty { now },
                    updatedAt = requiredText(source, "updatedAt", 64).ifEmpty { now }
                )
                if (!store.putTerminalProfile(profile)) failNative("GROUP_ALREADY_EXISTS")
            }
            applyDefaultTerminalProfile(payload)

            for (index in 0 until payload.hosts.length()) {
                val source = objectAt(payload.hosts, index)
                val id = requiredId(source, "id")
                val existing = store.getHost(id)
                if (existing != null && hostPolicy == "skip") {
                    skippedHosts += 1
                    continue
                }
                val host = hostFromBundle(source, existing)
                try {
                    store.putHost(host)
                } catch (_: IllegalArgumentException) {
                    // The database limit is bounded. Convert it into the
                    // shared error instead of leaking an implementation error.
                    failNative("FILE_TOO_LARGE")
                }
                importedHosts += 1
            }
            JSONObject()
                .put("importedHosts", importedHosts)
                .put("importedGroups", importedGroups)
                .put("skippedHosts", skippedHosts)
                .put("skippedGroups", skippedGroups)
                .put("importedIdentities", importedIdentities)
                .put("skippedIdentities", skippedIdentities)
        }
        synchronized(previews) { previews.remove(previewId) }
        return result
    }

    fun clearPreviews() {
        synchronized(previews) { previews.clear() }
        synchronized(exports) { exports.clear() }
        synchronized(imports) {
            imports.values.forEach { it.content.setLength(0) }
            imports.clear()
        }
    }

    override fun close() = clearPreviews()

    private fun hostFromBundle(source: JSONObject, existing: AndroidHost?): AndroidHost {
        val id = requiredId(source, "id")
        val credentialSource = nullableObject(source, "credentialSource")?.optString("type", "inline") ?: "inline"
        val groupId = nullableText(source, "groupId", 128)
        val identityId = if (credentialSource == "identity") {
            nullableObject(source, "credentialSource")?.let { requiredId(it, "identityId") } ?: failNative("VAULT_BUNDLE_INVALID")
        } else {
            null
        }
        val auth = objectField(source, "auth")
        val authType = requiredText(auth, "type", 32)
        when (credentialSource) {
            "inline" -> Unit
            "identity" -> if (store.getIdentity(identityId ?: failNative("IDENTITY_NOT_FOUND")) == null) failNative("IDENTITY_NOT_FOUND")
            "group" -> {
                val group = groupId?.let { store.getGroup(it) } ?: failNative("GROUP_NOT_FOUND")
                if (groupIdentity(group.id) == null) failNative("IDENTITY_NOT_FOUND")
            }
            else -> failNative("VAULT_BUNDLE_INVALID")
        }
        if (credentialSource == "group" && groupId == null) failNative("GROUP_NOT_FOUND")
        val settings = settingsFromBundle(objectField(source, "connectionProfile"), nullableObject(source, "connectionProfileOverrides"))
        val now = Instant.now().toString()
        return AndroidHost(
            id = id,
            name = requiredText(source, "name", 120),
            address = requiredText(source, "address", 253),
            port = source.optInt("port", 22),
            username = requiredText(source, "username", 255),
            authType = authType,
            credentialCiphertext = if (credentialSource == "inline") vault.encryptSecret(auth.toString(), "host:$id:credentials:v1") else null,
            credentialSource = credentialSource,
            identityId = identityId,
            groupId = groupId,
            terminalProfileId = nullableText(source, "terminalProfileId", 128),
            jumpHostIdsJson = arrayField(source, "jumpHostIds").toString(),
            keepaliveIntervalMs = settings.keepaliveIntervalMs,
            keepaliveCountMax = settings.keepaliveCountMax,
            reconnectEnabled = settings.reconnectEnabled,
            reconnectMaxAttempts = settings.reconnectMaxAttempts,
            reconnectBaseDelayMs = settings.reconnectBaseDelayMs,
            reconnectMaxDelayMs = settings.reconnectMaxDelayMs,
            tagsJson = arrayField(source, "tags").toString(),
            favorite = source.optBoolean("isFavorite", false),
            hostKeyAlgorithm = nullableText(source, "hostKeyAlgorithm", 255),
            hostKeyFingerprint = nullableText(source, "hostKeyFingerprint", 255),
            lastConnectedAt = existing?.lastConnectedAt,
            createdAt = existing?.createdAt ?: now,
            updatedAt = now
        )
    }

    private fun settingsFromBundle(profile: JSONObject, overrides: JSONObject?): ConnectionSettings {
        var settings = ConnectionSettings(
            keepaliveIntervalMs = profile.optInt("keepaliveIntervalMs"),
            keepaliveCountMax = profile.optInt("keepaliveCountMax"),
            reconnectEnabled = objectField(profile, "reconnect").optBoolean("enabled"),
            reconnectMaxAttempts = objectField(profile, "reconnect").optInt("maxAttempts"),
            reconnectBaseDelayMs = objectField(profile, "reconnect").optInt("baseDelayMs"),
            reconnectMaxDelayMs = objectField(profile, "reconnect").optInt("maxDelayMs")
        )
        if (overrides != null) {
            val reconnect = nullableObject(overrides, "reconnect")
            settings = settings.copy(
                keepaliveIntervalMs = if (overrides.has("keepaliveIntervalMs")) overrides.optInt("keepaliveIntervalMs") else settings.keepaliveIntervalMs,
                keepaliveCountMax = if (overrides.has("keepaliveCountMax")) overrides.optInt("keepaliveCountMax") else settings.keepaliveCountMax,
                reconnectEnabled = reconnect?.let { if (it.has("enabled")) it.optBoolean("enabled") else settings.reconnectEnabled } ?: settings.reconnectEnabled,
                reconnectMaxAttempts = reconnect?.let { if (it.has("maxAttempts")) it.optInt("maxAttempts") else settings.reconnectMaxAttempts } ?: settings.reconnectMaxAttempts,
                reconnectBaseDelayMs = reconnect?.let { if (it.has("baseDelayMs")) it.optInt("baseDelayMs") else settings.reconnectBaseDelayMs } ?: settings.reconnectBaseDelayMs,
                reconnectMaxDelayMs = reconnect?.let { if (it.has("maxDelayMs")) it.optInt("maxDelayMs") else settings.reconnectMaxDelayMs } ?: settings.reconnectMaxDelayMs
            )
        }
        return settings
    }

    private fun applyDefaultTerminalProfile(payload: AndroidBundlePayload) {
        val id = payload.terminalDefaultProfileId ?: return
        if (id == "builtin:termius" || store.getTerminalProfile(id) != null) store.setDefaultTerminalProfileId(id)
    }

    private fun groupIdentity(groupId: String?): AndroidIdentity? {
        var currentId = groupId
        val visited = HashSet<String>()
        repeat(8) {
            if (currentId == null || !visited.add(currentId!!)) return null
            val group = store.getGroup(currentId!!) ?: return null
            group.defaultIdentityId?.let { return store.getIdentity(it) }
            currentId = group.parentId
        }
        return null
    }

    private fun orderedGroups(groups: JSONArray): List<JSONObject> {
        val byId = HashMap<String, JSONObject>(groups.length())
        for (index in 0 until groups.length()) {
            val group = objectAt(groups, index)
            byId[requiredId(group, "id")] = group
        }
        val result = ArrayList<JSONObject>(groups.length())
        val visiting = HashSet<String>()
        val visited = HashSet<String>()
        fun visit(id: String, depth: Int) {
            if (visited.contains(id)) return
            if (!visiting.add(id) || depth > 8) failNative("VAULT_BUNDLE_INVALID")
            val group = byId[id] ?: failNative("VAULT_BUNDLE_INVALID")
            nullableText(group, "parentId", 128)?.let { visit(it, depth + 1) }
            visiting.remove(id)
            visited.add(id)
            result += group
        }
        byId.keys.forEach { visit(it, 1) }
        return result
    }

    private fun prunePreviewsLocked() {
        val now = System.currentTimeMillis()
        previews.entries.removeIf { it.value.expiresAt <= now }
    }

    private fun pruneExportsLocked() {
        val now = System.currentTimeMillis()
        exports.entries.removeIf { it.value.expiresAt <= now }
    }

    private fun pruneImportsLocked() {
        val now = System.currentTimeMillis()
        imports.entries.removeIf { entry ->
            if (entry.value.expiresAt <= now) {
                entry.value.content.setLength(0)
                true
            } else false
        }
    }

    private fun utf8ChunkEnd(value: String, start: Int): Int {
        if (start >= value.length) return start
        var end = minOf(value.length, start + AndroidNativeValidation.MAX_CHUNK_BYTES)
        if (end < value.length && end > start && Character.isHighSurrogate(value[end - 1])) end -= 1
        while (end > start) {
            val bytes = value.substring(start, end).toByteArray(StandardCharsets.UTF_8)
            val fits = bytes.size <= AndroidNativeValidation.MAX_CHUNK_BYTES
            bytes.fill(0)
            if (fits) return end
            end -= maxOf(1, (end - start) / 8)
        }
        failNative("FILE_TOO_LARGE")
    }

    private fun conflict(type: String, id: String, name: String): JSONObject = JSONObject()
        .put("type", type)
        .put("id", id)
        .put("name", name)

    private fun objectAt(array: JSONArray, index: Int): JSONObject = array.optJSONObject(index) ?: failNative("VAULT_BUNDLE_INVALID")

    private fun objectField(value: JSONObject, key: String): JSONObject = value.optJSONObject(key) ?: failNative("VAULT_BUNDLE_INVALID")

    private fun arrayField(value: JSONObject, key: String): JSONArray = value.optJSONArray(key) ?: failNative("VAULT_BUNDLE_INVALID")

    private fun nullableObject(value: JSONObject, key: String): JSONObject? {
        if (!value.has(key) || value.isNull(key)) return null
        return value.optJSONObject(key) ?: failNative("VAULT_BUNDLE_INVALID")
    }

    private fun requiredId(value: JSONObject, key: String): String = try {
        AndroidNativeValidation.requireSafeId(requiredText(value, key, 128))
    } catch (_: Exception) {
        failNative("VAULT_BUNDLE_INVALID")
    }

    private fun requiredText(value: JSONObject, key: String, maxLength: Int): String {
        val text = value.opt(key)
        if (text !is String || text.isEmpty() || text.length > maxLength || text.any { it.code <= 0x1f || it.code == 0x7f }) failNative("VAULT_BUNDLE_INVALID")
        return text
    }

    private fun nullableText(value: JSONObject, key: String, maxLength: Int): String? {
        if (!value.has(key) || value.isNull(key)) return null
        val text = value.opt(key)
        if (text !is String || text.length > maxLength || text.any { it.code <= 0x1f || it.code == 0x7f }) failNative("VAULT_BUNDLE_INVALID")
        return text.takeIf { it.isNotEmpty() }
    }
}

private fun failNative(code: String): Nothing = throw NativeVaultFailure(code)
