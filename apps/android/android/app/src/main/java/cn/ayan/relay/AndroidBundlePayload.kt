package cn.ayan.relay

import java.nio.charset.StandardCharsets
import org.json.JSONArray
import org.json.JSONObject

/** Parsed, bounded bundle payload retained only while an import preview is alive. */
internal class AndroidBundlePayload internal constructor(
    internal val root: JSONObject
) {
    val groups: JSONArray get() = root.optJSONArray("groups") ?: JSONArray()
    val hosts: JSONArray get() = root.optJSONArray("hosts") ?: JSONArray()
    val identities: JSONArray get() = root.optJSONArray("identities") ?: JSONArray()
    val terminalProfiles: JSONArray get() = root.optJSONArray("terminalProfiles") ?: JSONArray()
    val terminalDefaultProfileId: String? get() = if (!root.has("terminalDefaultProfileId") || root.isNull("terminalDefaultProfileId")) null else root.optString("terminalDefaultProfileId", "").takeIf { it.isNotEmpty() }
}

internal object AndroidBundlePayloadCodec {
    private const val MAX_HOSTS = 256
    private const val MAX_IDENTITIES = 128
    private const val MAX_GROUPS = 256
    private const val MAX_TERMINAL_PROFILES = 100
    private const val MAX_NAME_LENGTH = 120
    private const val MAX_USERNAME_LENGTH = 255
    private const val MAX_PROFILE_BYTES = 16 * 1024
    private val colors = listOf(
        "foreground", "background", "cursor", "cursorAccent", "selectionBackground", "selectionForeground",
        "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack",
        "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
    )

    fun parse(bytes: ByteArray): AndroidBundlePayload {
        if (bytes.isEmpty() || bytes.size > AndroidBundleCrypto.MAX_BUNDLE_BYTES) failPayload()
        val text = try { String(bytes, StandardCharsets.UTF_8) } catch (_: Exception) { failPayload() }
        val root = try { JSONObject(text) } catch (_: Exception) { failPayload() }
        validateRoot(root)
        return AndroidBundlePayload(root)
    }

    fun create(store: AndroidLocalStore, vault: AndroidVault): ByteArray {
        val identityObjects = JSONArray()
        store.listIdentitiesForExport().forEach { identity ->
            val auth = decryptCredential(vault, identity.credentialCiphertext, "identity:${identity.id}:credentials:v1")
            identityObjects.put(JSONObject()
                .put("id", identity.id)
                .put("name", identity.name)
                .put("type", identity.type)
                .put("username", identity.username)
                .put("keyFingerprint", identity.keyFingerprint ?: JSONObject.NULL)
                .put("auth", auth))
        }

        val groups = JSONArray()
        store.listGroupsForExport().forEach { group ->
            groups.put(JSONObject()
                .put("id", group.id)
                .put("name", group.name)
                .put("sortOrder", group.sortOrder)
                .put("parentId", group.parentId ?: JSONObject.NULL)
                .put("defaultIdentityId", group.defaultIdentityId ?: JSONObject.NULL)
                .put("connectionProfile", group.connectionProfileJson?.let { parseObject(it) } ?: JSONObject.NULL))
        }

        val hosts = JSONArray()
        store.listHostsForExport().forEach { host ->
            val auth = hostCredential(host, store, vault)
            val source = when (host.credentialSource) {
                "identity" -> JSONObject().put("type", "identity").put("identityId", host.identityId ?: JSONObject.NULL)
                "group" -> JSONObject().put("type", "group")
                else -> JSONObject().put("type", "inline").put("authType", host.authType)
            }
            hosts.put(JSONObject()
                .put("id", host.id)
                .put("name", host.name)
                .put("address", host.address)
                .put("port", host.port)
                .put("username", host.username)
                .put("auth", auth)
                .put("groupId", host.groupId ?: JSONObject.NULL)
                .put("jumpHostIds", parseArray(host.jumpHostIdsJson))
                .put("connectionProfile", settingsJson(host))
                .put("connectionProfileOverrides", JSONObject.NULL)
                .put("terminalProfileId", host.terminalProfileId ?: JSONObject.NULL)
                .put("tags", parseArray(host.tagsJson))
                .put("isFavorite", host.favorite)
                .put("hostKeyAlgorithm", host.hostKeyAlgorithm ?: JSONObject.NULL)
                .put("hostKeyFingerprint", host.hostKeyFingerprint ?: JSONObject.NULL)
                .put("credentialSource", source)
                .put("identityId", host.identityId ?: JSONObject.NULL))
        }

        val terminalProfiles = JSONArray()
        store.listTerminalProfiles().forEach { profile ->
            terminalProfiles.put(JSONObject()
                .put("id", profile.id)
                .put("name", profile.name)
                .put("appearance", parseObject(profile.appearanceJson))
                .put("createdAt", profile.createdAt)
                .put("updatedAt", profile.updatedAt))
        }

        val root = JSONObject()
            .put("groups", groups)
            .put("hosts", hosts)
            .put("identities", identityObjects)
            .put("terminalProfiles", terminalProfiles)
            .put("terminalDefaultProfileId", store.getDefaultTerminalProfileId() ?: "builtin:termius")
        val serialized = root.toString().toByteArray(StandardCharsets.UTF_8)
        if (serialized.size > AndroidBundleCrypto.MAX_BUNDLE_BYTES) {
            serialized.fill(0)
            failPayload()
        }
        return serialized
    }

    private fun validateRoot(root: JSONObject) {
        val groups = root.optJSONArray("groups") ?: failPayload()
        val hosts = root.optJSONArray("hosts") ?: failPayload()
        val identities = root.optJSONArray("identities") ?: JSONArray()
        val profiles = root.optJSONArray("terminalProfiles") ?: JSONArray()
        if (groups.length() > MAX_GROUPS || hosts.length() > MAX_HOSTS || identities.length() > MAX_IDENTITIES || profiles.length() > MAX_TERMINAL_PROFILES) failPayload()

        val identityIds = HashSet<String>()
        for (index in 0 until identities.length()) {
            val identity = objectAt(identities, index)
            val id = identifier(identity, "id")
            if (!identityIds.add(id)) failPayload()
            text(identity, "name", MAX_NAME_LENGTH)
            val type = text(identity, "type", 32)
            if (type != "password" && type != "private_key") failPayload()
            username(identity, "username")
            if (!identity.isNull("keyFingerprint")) text(identity, "keyFingerprint", 255)
            validateAuth(objectField(identity, "auth"), type)
        }

        val groupIds = HashSet<String>()
        for (index in 0 until groups.length()) {
            val group = objectAt(groups, index)
            val id = identifier(group, "id")
            if (!groupIds.add(id)) failPayload()
            text(group, "name", MAX_NAME_LENGTH)
            nullableIdentifier(group, "parentId")
            integer(group, "sortOrder", 0, 1_000_000)
            val defaultIdentityId = nullableIdentifier(group, "defaultIdentityId")
            if (defaultIdentityId != null && !identityIds.contains(defaultIdentityId)) failPayload()
            val profile = nullableObject(group, "connectionProfile")
            if (profile != null) validateProfile(profile, false)
        }
        validateGroupGraph(groups, groupIds)

        val hostIds = HashSet<String>()
        for (index in 0 until hosts.length()) {
            val host = objectAt(hosts, index)
            val id = identifier(host, "id")
            if (!hostIds.add(id)) failPayload()
            text(host, "name", MAX_NAME_LENGTH)
            val address = text(host, "address", 253)
            if (!isHostAddress(address)) failPayload()
            integer(host, "port", 1, 65_535)
            username(host, "username")
            val auth = objectField(host, "auth")
            val authType = text(auth, "type", 32)
            if (authType != "password" && authType != "private_key") failPayload()
            validateAuth(auth, authType)
            nullableIdentifier(host, "groupId")?.let { if (!groupIds.contains(it)) failPayload() }
            val jumps = arrayOfStrings(host, "jumpHostIds", 4, 128)
            if (jumps.contains(id)) failPayload()
            validateProfile(objectField(host, "connectionProfile"), false)
            val overrides = nullableObject(host, "connectionProfileOverrides")
            if (overrides != null) validateProfile(overrides, true)
            nullableIdentifier(host, "terminalProfileId")
            arrayOfStrings(host, "tags", 20, 64)
            if (host.opt("isFavorite") !is Boolean) failPayload()
            nullableText(host, "hostKeyAlgorithm", 255)
            nullableText(host, "hostKeyFingerprint", 255)
            val source = nullableObject(host, "credentialSource")
            val sourceType = source?.let { text(it, "type", 32) } ?: "inline"
            if (sourceType !in setOf("inline", "identity", "group")) failPayload()
            val sourceIdentity = if (sourceType == "identity") source?.let { identifier(it, "identityId") } else null
            if (sourceIdentity != null && !identityIds.contains(sourceIdentity)) failPayload()
            if (sourceType == "group" && host.isNull("groupId")) failPayload()
            val directIdentity = nullableIdentifier(host, "identityId")
            if (sourceType == "identity" && directIdentity != sourceIdentity) failPayload()
            if (sourceType != "identity" && directIdentity != null) failPayload()
        }
        validateHostGraph(hosts, hostIds)

        val profileIds = HashSet<String>()
        for (index in 0 until profiles.length()) {
            val profile = objectAt(profiles, index)
            val id = identifier(profile, "id")
            if (!profileIds.add(id)) failPayload()
            text(profile, "name", MAX_NAME_LENGTH)
            validateAppearance(objectField(profile, "appearance"))
            text(profile, "createdAt", 64)
            text(profile, "updatedAt", 64)
        }
        val defaultProfile = nullableIdentifier(root, "terminalDefaultProfileId")
        if (defaultProfile != null && defaultProfile != "builtin:termius" && !profileIds.contains(defaultProfile)) failPayload()
    }

    private fun validateAuth(auth: JSONObject, expectedType: String) {
        val type = text(auth, "type", 32)
        if (type != expectedType) failPayload()
        when (type) {
            "password" -> text(auth, "password", 4096)
            "private_key" -> {
                text(auth, "privateKey", 32 * 1024)
                nullableText(auth, "passphrase", 4096)
                nullableText(auth, "identityFile", 4096)
            }
            else -> failPayload()
        }
    }

    private fun validateProfile(profile: JSONObject, patch: Boolean) {
        if (profile.toString().toByteArray(StandardCharsets.UTF_8).size > MAX_PROFILE_BYTES) failPayload()
        if (profile.has("keepaliveIntervalMs")) integer(profile, "keepaliveIntervalMs", 0, 600_000)
        if (profile.has("keepaliveCountMax")) integer(profile, "keepaliveCountMax", 0, 100)
        val reconnect = nullableObject(profile, "reconnect")
        if (reconnect != null) {
            if (reconnect.has("enabled") && reconnect.opt("enabled") !is Boolean) failPayload()
            if (reconnect.has("maxAttempts")) integer(reconnect, "maxAttempts", 0, 20)
            if (reconnect.has("baseDelayMs")) integer(reconnect, "baseDelayMs", 0, 60_000)
            if (reconnect.has("maxDelayMs")) integer(reconnect, "maxDelayMs", 0, 600_000)
            if (reconnect.has("baseDelayMs") && reconnect.has("maxDelayMs") && reconnect.optInt("maxDelayMs") < reconnect.optInt("baseDelayMs")) failPayload()
        }
        if (!patch) {
            if (!profile.has("keepaliveIntervalMs") || !profile.has("keepaliveCountMax") || reconnect == null || !reconnect.has("enabled") || !reconnect.has("maxAttempts") || !reconnect.has("baseDelayMs") || !reconnect.has("maxDelayMs")) failPayload()
        }
    }

    private fun validateAppearance(appearance: JSONObject) {
        colors.forEach { key ->
            val value = text(appearance, key, 7)
            if (!value.matches(Regex("^#[0-9a-fA-F]{6}$"))) failPayload()
        }
        text(appearance, "fontFamily", 160)
        integer(appearance, "fontSize", 10, 24)
        val lineHeight = appearance.opt("lineHeight")
        if (lineHeight !is Number || lineHeight.toDouble() !in 1.0..2.0) failPayload()
        if (text(appearance, "cursorStyle", 16) !in setOf("block", "bar", "underline")) failPayload()
        if (appearance.opt("cursorBlink") !is Boolean) failPayload()
        integer(appearance, "scrollback", 500, 20_000)
    }

    private fun validateGroupGraph(groups: JSONArray, groupIds: Set<String>) {
        val parents = HashMap<String, String?>()
        for (index in 0 until groups.length()) {
            val group = objectAt(groups, index)
            val id = identifier(group, "id")
            val parent = nullableIdentifier(group, "parentId")
            if (parent == id || (parent != null && !groupIds.contains(parent))) failPayload()
            parents[id] = parent
        }
        parents.keys.forEach { start ->
            val visited = HashSet<String>()
            var cursor: String? = start
            var depth = 0
            while (cursor != null) {
                if (!visited.add(cursor)) failPayload()
                depth += 1
                if (depth > 8) failPayload()
                cursor = parents[cursor]
            }
        }
    }

    private fun validateHostGraph(hosts: JSONArray, hostIds: Set<String>) {
        val jumps = HashMap<String, List<String>>()
        for (index in 0 until hosts.length()) {
            val host = objectAt(hosts, index)
            val id = identifier(host, "id")
            val ids = arrayOfStrings(host, "jumpHostIds", 4, 128)
            if (ids.any { !hostIds.contains(it) }) failPayload()
            jumps[id] = ids
        }
        hostIds.forEach { id ->
            try {
                AndroidNativeValidation.resolveHostPath(id, jumps)
            } catch (_: Exception) {
                failPayload()
            }
        }
    }

    private fun hostCredential(host: AndroidHost, store: AndroidLocalStore, vault: AndroidVault): JSONObject = when (host.credentialSource) {
        "inline" -> decryptCredential(vault, host.credentialCiphertext ?: failPayload(), "host:${host.id}:credentials:v1")
        "identity" -> {
            val identityId = host.identityId ?: failPayload()
            val identity = store.getIdentity(identityId) ?: failPayload()
            decryptCredential(vault, identity.credentialCiphertext, "identity:${identity.id}:credentials:v1")
        }
        "group" -> {
            val identity = groupIdentity(store, host.groupId) ?: failPayload()
            decryptCredential(vault, identity.credentialCiphertext, "identity:${identity.id}:credentials:v1")
        }
        else -> failPayload()
    }

    private fun decryptCredential(vault: AndroidVault, ciphertext: String, aad: String): JSONObject = try {
        JSONObject(vault.decryptSecret(ciphertext, aad))
    } catch (_: Exception) {
        failPayload()
    }

    private fun groupIdentity(store: AndroidLocalStore, groupId: String?): AndroidIdentity? {
        var currentId = groupId
        val visited = HashSet<String>()
        repeat(8) {
            if (currentId == null || !visited.add(currentId!!)) return null
            val group = store.getGroup(currentId!!) ?: return null
            if (group.defaultIdentityId != null) return store.getIdentity(group.defaultIdentityId)
            currentId = group.parentId
        }
        return null
    }

    private fun settingsJson(host: AndroidHost): JSONObject = JSONObject()
        .put("keepaliveIntervalMs", host.keepaliveIntervalMs)
        .put("keepaliveCountMax", host.keepaliveCountMax)
        .put("reconnect", JSONObject()
            .put("enabled", host.reconnectEnabled)
            .put("maxAttempts", host.reconnectMaxAttempts)
            .put("baseDelayMs", host.reconnectBaseDelayMs)
            .put("maxDelayMs", host.reconnectMaxDelayMs))

    private fun parseObject(value: String): JSONObject = try { JSONObject(value) } catch (_: Exception) { failPayload() }

    private fun parseArray(value: String): JSONArray = try { JSONArray(value) } catch (_: Exception) { failPayload() }

    private fun objectAt(array: JSONArray, index: Int): JSONObject = array.optJSONObject(index) ?: failPayload()

    private fun objectField(value: JSONObject, key: String): JSONObject = value.optJSONObject(key) ?: failPayload()

    private fun text(value: JSONObject, key: String, maxLength: Int): String {
        val raw = value.opt(key)
        if (raw !is String || raw.isEmpty() || raw.length > maxLength || raw.any { it.code <= 0x1f || it.code == 0x7f }) failPayload()
        return raw
    }

    private fun username(value: JSONObject, key: String): String {
        val result = text(value, key, MAX_USERNAME_LENGTH)
        if (result.any { it.isWhitespace() }) failPayload()
        return result
    }

    private fun identifier(value: JSONObject, key: String): String {
        val result = text(value, key, 128)
        return try { AndroidNativeValidation.requireSafeId(result) } catch (_: Exception) { failPayload() }
    }

    private fun nullableIdentifier(value: JSONObject, key: String): String? = nullableText(value, key, 128)?.let {
        try { AndroidNativeValidation.requireSafeId(it) } catch (_: Exception) { failPayload() }
    }

    private fun nullableText(value: JSONObject, key: String, maxLength: Int): String? {
        if (!value.has(key) || value.isNull(key)) return null
        val raw = value.opt(key)
        if (raw !is String || raw.length > maxLength || raw.any { it.code <= 0x1f || it.code == 0x7f }) failPayload()
        return raw.takeIf { it.isNotEmpty() }
    }

    private fun nullableObject(value: JSONObject, key: String): JSONObject? {
        if (!value.has(key) || value.isNull(key)) return null
        return value.optJSONObject(key) ?: failPayload()
    }

    private fun integer(value: JSONObject, key: String, min: Int, max: Int): Int {
        val raw = value.opt(key)
        if (raw !is Number || raw.toLong() !in min.toLong()..max.toLong() || raw.toDouble() != raw.toLong().toDouble()) failPayload()
        return raw.toInt()
    }

    private fun arrayOfStrings(value: JSONObject, key: String, maxItems: Int, maxLength: Int): List<String> {
        val array = value.optJSONArray(key) ?: failPayload()
        if (array.length() > maxItems) failPayload()
        val result = ArrayList<String>(array.length())
        for (index in 0 until array.length()) {
            val item = array.opt(index)
            if (item !is String || item.isEmpty() || item.length > maxLength || item.any { it.code <= 0x1f || it.code == 0x7f }) failPayload()
            try { AndroidNativeValidation.requireSafeId(item) } catch (_: Exception) { failPayload() }
            if (result.contains(item)) failPayload()
            result += item
        }
        return result
    }

    private fun isHostAddress(value: String): Boolean = value.isNotEmpty() && value.length <= 253 && value.none { it.isWhitespace() || it.code <= 0x1f || it.code == 0x7f } && !value.contains('/') && !value.contains('?') && !value.contains('#') && !value.contains('\\') && !value.startsWith('[') && !value.endsWith(']')
}

private fun failPayload(): Nothing = throw NativeVaultFailure("VAULT_BUNDLE_INVALID")
