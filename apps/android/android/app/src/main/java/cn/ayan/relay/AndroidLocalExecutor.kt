package cn.ayan.relay

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Base64
import com.getcapacitor.JSObject
import com.jcraft.jsch.ChannelSftp
import com.jcraft.jsch.SftpException
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Collections
import java.util.LinkedHashMap
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android's local-mode executor. It is intentionally an adapter instead of a
 * second Web server: the WebView can ask for bounded operations, while SQLite,
 * Keystore and JSch remain on the native side.
 */
internal class AndroidLocalExecutor(
    context: Context,
    private val emitToWeb: (JSObject) -> Unit
) : RelayNativePlugin.Executor, AutoCloseable {
    companion object {
        private const val MAX_OPERATION_QUEUE = 16
        private const val MAX_CONNECTION_QUEUE = 4
        private const val MAX_SESSIONS = 4
        private const val MAX_RETAINED_REQUESTS = 32
        private const val MAX_TRANSFERS = 32
        private const val MAX_DOWNLOADS = 4
        private const val MAX_FILE_WRITERS = 4
        private const val MAX_SFTP_ENTRIES = 256
        private const val MAX_OUTPUT_CHUNK = 32 * 1024
        private const val MAX_FRAME_BYTES = 64 * 1024
        private const val MAX_ENCODED_CHUNK_BYTES = 48 * 1024
    }

    private val appContext = context.applicationContext
    private val store = AndroidLocalStore(appContext)
    private val vault = AndroidVault(store)
    private val bundleService = AndroidBundleService(store, vault)
    private val operationExecutor = boundedExecutor("relay-android-op", 2, MAX_OPERATION_QUEUE)
    private val connectionExecutor = boundedExecutor("relay-android-ssh", MAX_SESSIONS, MAX_CONNECTION_QUEUE)
    private val readerExecutor = boundedExecutor("relay-android-read", MAX_SESSIONS, MAX_SESSIONS * 2)
    private val sessions = Collections.synchronizedMap(mutableMapOf<String, AndroidSshSession>())
    private val sessionLock = Any()
    private val sessionRequests = Collections.synchronizedMap(object : LinkedHashMap<String, JSONObject>(MAX_RETAINED_REQUESTS, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JSONObject>?): Boolean = size > MAX_RETAINED_REQUESTS
    })
    private val transfers = Collections.synchronizedMap(LinkedHashMap<String, AndroidTransfer>())
    private val fileWriters = Collections.synchronizedMap(mutableMapOf<String, AndroidFileWriter>())
    private val sequence = AtomicLong(0)
    private val generation = AtomicLong(1)
    private val closed = AtomicBoolean(false)

    override fun invoke(request: JSObject, complete: (JSObject) -> Unit) {
        if (closed.get()) {
            complete(failure(request, "SERVICE_RESTARTED"))
            return
        }
        val operation = request.optString("operation", "")
        if (operation == "sessions.hostKeyDecision" || operation == "sessions.credential" || operation == "sessions.close" || operation == "vault.lock") {
            complete(runSafely(request))
            return
        }
        val executor = if (operation == "sessions.openShell" || operation == "sessions.reconnect") connectionExecutor else operationExecutor
        try {
            executor.execute {
                val response = runSafely(request)
                complete(response)
            }
        } catch (_: RejectedExecutionException) {
            complete(failure(request, "OPERATION_INTERRUPTED", "本机任务队列已满，请稍后重试"))
        }
    }

    override fun invokeFileSaveSelection(request: JSObject, uri: String, complete: (JSObject) -> Unit) {
        if (closed.get()) {
            complete(failure(request, "SERVICE_RESTARTED"))
            return
        }
        try {
            operationExecutor.execute { complete(runSafely(request, uri)) }
        } catch (_: RejectedExecutionException) {
            complete(failure(request, "OPERATION_INTERRUPTED", "本机任务队列已满，请稍后重试"))
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        generation.incrementAndGet()
        synchronized(sessionLock) {
            sessions.values.toList().forEach { session -> session.close(true) }
            sessions.clear()
        }
        synchronized(transfers) {
            transfers.values.forEach { it.closeDownload() }
            transfers.clear()
        }
        synchronized(fileWriters) {
            fileWriters.values.forEach { it.cancel() }
            fileWriters.clear()
        }
        bundleService.close()
        vault.close()
        operationExecutor.shutdownNow()
        connectionExecutor.shutdownNow()
        readerExecutor.shutdownNow()
        store.close()
    }

    private fun runSafely(request: JSObject, selectedFileUri: String? = null): JSObject = try {
        success(request, dispatch(request.optString("operation", ""), request.optJSONObject("payload") ?: JSONObject(), selectedFileUri))
    } catch (error: NativeVaultFailure) {
        failure(request, error.code)
    } catch (error: SftpException) {
        failure(request, mapSftpError(error))
    } catch (error: RejectedExecutionException) {
        failure(request, "OPERATION_INTERRUPTED", "本机任务队列已满，请稍后重试")
    } catch (_: IllegalArgumentException) {
        failure(request, "PROTOCOL_INVALID_MESSAGE")
    } catch (error: Throwable) {
        failure(request, mapJschError(error))
    }

    private fun dispatch(operation: String, payload: JSONObject, selectedFileUri: String? = null): Any? = when (operation) {
        "vault.status" -> JSONObject().put("phase", vault.phase())
        "vault.setup" -> {
            vault.setup(requiredText(payload, "masterPassword", 4096))
            JSONObject().put("phase", "unlocked")
        }
        "vault.unlock" -> {
            vault.unlock(requiredText(payload, "masterPassword", 4096))
            JSONObject().put("phase", "unlocked")
        }
        "vault.lock" -> {
            closeAllSessions()
            bundleService.clearPreviews()
            vault.lock()
            JSONObject.NULL
        }
        "system.clipboard.readText" -> readClipboard()
        "system.clipboard.writeText" -> {
            writeClipboard(requiredText(payload, "text", 64 * 1024))
            JSONObject.NULL
        }
        "system.openExternal" -> {
            openExternal(requiredText(payload, "url", 2048))
            JSONObject.NULL
        }
        "system.confirm" -> failNative("CAPABILITY_UNAVAILABLE")
        "system.fileSave.open" -> openFileWriter(payload, selectedFileUri ?: failNative("CAPABILITY_UNAVAILABLE"))
        "system.fileSave.write" -> writeFileWriter(payload)
        "system.fileSave.seek" -> seekFileWriter(payload)
        "system.fileSave.close" -> closeFileWriter(requiredText(payload, "writerId", 128), cancel = false)
        "system.fileSave.cancel" -> closeFileWriter(requiredText(payload, "writerId", 128), cancel = true)
        "connection.test" -> connectionTest(requiredText(payload, "hostId", 128))
        "hosts.list" -> hostsList(payload)
        "hosts.get" -> hostMetadata(requireHost(requiredText(payload, "id", 128)))
        "hosts.listProfiles" -> hostsListProfiles()
        "hosts.getProfile" -> hostProfile(requireHost(requiredText(payload, "hostId", 128)))
        "hosts.create" -> createHost(payload.optJSONObject("input") ?: failNative("HOST_VALIDATION_FAILED"))
        "hosts.update" -> updateHost(requiredText(payload, "id", 128), payload.optJSONObject("input") ?: failNative("HOST_VALIDATION_FAILED"))
        "hosts.delete" -> deleteHost(requiredText(payload, "id", 128))
        "hosts.clearHostKey" -> clearHostKey(requiredText(payload, "id", 128))
        "groups.list" -> groupsList()
        "groups.get" -> groupJson(requireGroup(requiredText(payload, "id", 128)))
        "groups.create" -> createGroup(payload.optJSONObject("input") ?: failNative("HOST_VALIDATION_FAILED"))
        "groups.update" -> updateGroup(requiredText(payload, "id", 128), payload.optJSONObject("input") ?: failNative("HOST_VALIDATION_FAILED"))
        "groups.delete" -> deleteGroup(requiredText(payload, "id", 128))
        "identities.list" -> identitiesList()
        "identities.get" -> identityMetadata(requireIdentity(requiredText(payload, "id", 128)))
        "identities.create" -> createIdentity(payload.optJSONObject("input") ?: failNative("HOST_VALIDATION_FAILED"))
        "identities.update" -> updateIdentity(requiredText(payload, "id", 128), payload.optJSONObject("input") ?: failNative("HOST_VALIDATION_FAILED"))
        "identities.delete" -> deleteIdentity(requiredText(payload, "id", 128))
        "workspace.load" -> workspaceLoad()
        "workspace.save" -> workspaceSave(payload)
        "workspace.listTemplates" -> JSONArray()
        "workspace.createTemplate", "workspace.deleteTemplate" -> failNative("CAPABILITY_UNAVAILABLE")
        "terminalProfiles.list" -> terminalProfilesList()
        "terminalProfiles.getDefault" -> terminalProfileDefault()
        "terminalProfiles.create" -> createTerminalProfile(payload.optJSONObject("input") ?: failNative("HOST_VALIDATION_FAILED"))
        "terminalProfiles.setDefault" -> setDefaultTerminalProfile(requiredText(payload, "id", 128))
        "terminalProfiles.delete" -> deleteTerminalProfile(requiredText(payload, "id", 128))
        "sessions.openShell" -> openShell(payload.optJSONObject("request") ?: failNative("PROTOCOL_INVALID_MESSAGE"))
        "sessions.reconnect" -> reconnect(requiredText(payload, "sessionId", 128))
        "sessions.write" -> sessionWrite(payload)
        "sessions.resize" -> sessionResize(payload)
        "sessions.hostKeyDecision" -> hostKeyDecision(payload)
        "sessions.credential" -> failNative("CAPABILITY_UNAVAILABLE")
        "sessions.close" -> sessionClose(requiredText(payload, "sessionId", 128))
        "files.list" -> filesList(payload)
        "files.createDirectory" -> filesMkdir(payload)
        "files.rename" -> filesRename(payload)
        "files.remove" -> filesRemove(payload)
        "files.createTransfer" -> createTransfer(payload.optJSONObject("request") ?: failNative("SFTP_PATH_INVALID"))
        "files.listTransfers" -> listTransfers()
        "files.getTransfer" -> getTransfer(requiredText(payload, "transferId", 128))
        "files.upload" -> upload(payload)
        "files.download" -> download(payload)
        "files.pauseTransfer" -> pauseTransfer(requiredText(payload, "transferId", 128))
        "files.cancelTransfer" -> cancelTransfer(requiredText(payload, "transferId", 128))
        "files.retryTransfer" -> retryTransfer(requiredText(payload, "transferId", 128))
        "commands.start", "commands.get", "commands.cancel" -> failNative("CAPABILITY_UNAVAILABLE")
        "snippets.list" -> JSONArray()
        "snippets.get", "snippets.create", "snippets.update", "snippets.delete" -> failNative("CAPABILITY_UNAVAILABLE")
        "activity.list" -> JSONObject().put("items", JSONArray()).put("hasMore", false)
        "imports.exportVaultBundle" -> {
            requireUnlocked()
            bundleService.beginExport(requiredText(payload, "exportPassword", 4096))
        }
        "imports.readVaultBundleChunk" -> {
            requireUnlocked()
            bundleService.readExportChunk(requiredText(payload, "bundleId", 128), intField(payload, "cursor", 0, 0, AndroidBundleCrypto.MAX_BUNDLE_BYTES))
        }
        "imports.releaseVaultBundle" -> {
            requireUnlocked()
            bundleService.releaseExport(requiredText(payload, "bundleId", 128))
            JSONObject.NULL
        }
        "imports.beginVaultImport" -> {
            requireUnlocked()
            bundleService.beginImport(requiredText(payload, "exportPassword", 4096))
        }
        "imports.writeVaultImportChunk" -> {
            requireUnlocked()
            bundleService.appendImportChunk(requiredText(payload, "importId", 128), requiredText(payload, "data", 48 * 1024))
            JSONObject.NULL
        }
        "imports.finishVaultImport" -> {
            requireUnlocked()
            bundleService.finishImport(requiredText(payload, "importId", 128))
        }
        "imports.cancelVaultImport" -> {
            requireUnlocked()
            bundleService.cancelImport(requiredText(payload, "importId", 128))
            JSONObject.NULL
        }
        "imports.previewVaultImport" -> {
            requireUnlocked()
            bundleService.preview(requiredText(payload, "exportPassword", 4096), requiredText(payload, "bundle", AndroidBundleCrypto.MAX_BUNDLE_BYTES))
        }
        "imports.applyVaultImport" -> {
            requireUnlocked()
            bundleService.apply(requiredText(payload, "previewId", 128), payload.optJSONObject("resolution") ?: failNative("VAULT_BUNDLE_INVALID"))
        }
        "imports.previewExternalImport", "imports.applyExternalImport", "imports.exportOpenSshConfig", "imports.exportCsv" -> failNative("CAPABILITY_UNAVAILABLE")
        else -> failNative("CAPABILITY_UNAVAILABLE")
    }

    private fun requireUnlocked() {
        if (vault.phase() != "unlocked") failNative(if (vault.phase() == "uninitialized") "VAULT_NOT_INITIALIZED" else "VAULT_LOCKED")
    }

    private fun requireHost(id: String): AndroidHost {
        requireUnlocked()
        AndroidNativeValidation.requireSafeId(id)
        return store.getHost(id) ?: failNative("HOST_NOT_FOUND")
    }

    private fun hostsList(payload: JSONObject): JSONArray {
        requireUnlocked()
        val tags = parseStringSet(payload.optJSONArray("tags"), 32, 64)
        val favorite = if (payload.has("favorite") && !payload.isNull("favorite")) payload.optBoolean("favorite") else null
        val groupId = nullableText(payload, "groupId", 128)
        val query = nullableText(payload, "query", 255)
        val output = JSONArray()
        store.listHosts(query, groupId, favorite, tags).forEach { output.put(hostMetadata(it)) }
        return output
    }

    private fun hostsListProfiles(): JSONArray {
        requireUnlocked()
        val output = JSONArray()
        store.listHosts(null, null, null, emptySet()).forEach { output.put(hostProfile(it)) }
        return output
    }

    private fun createHost(input: JSONObject): JSONObject {
        requireUnlocked()
        val id = UUID.randomUUID().toString()
        val host = hostFromInput(id, input, null)
        store.putHost(host)
        return hostMetadata(host)
    }

    private fun updateHost(id: String, input: JSONObject): JSONObject {
        requireUnlocked()
        val current = requireHost(id)
        val host = hostFromInput(id, input, current)
        store.putHost(host)
        return hostMetadata(host)
    }

    private fun deleteHost(id: String): JSONObject {
        requireUnlocked()
        requireHost(id)
        sessionsForHost(id).forEach { session -> session.close(true) }
        if (!store.deleteHost(id)) failNative("HOST_NOT_FOUND")
        return JSONObject()
    }

    private fun clearHostKey(id: String): JSONObject {
        requireUnlocked()
        requireHost(id)
        if (!store.updateHostKey(id, null, null)) failNative("HOST_NOT_FOUND")
        return JSONObject()
    }

    private fun requireIdentity(id: String): AndroidIdentity {
        requireUnlocked()
        AndroidNativeValidation.requireSafeId(id)
        return store.getIdentity(id) ?: failNative("IDENTITY_NOT_FOUND")
    }

    private fun requireGroup(id: String): AndroidGroup {
        requireUnlocked()
        AndroidNativeValidation.requireSafeId(id)
        return store.getGroup(id) ?: failNative("GROUP_NOT_FOUND")
    }

    private fun identitiesList(): JSONArray {
        requireUnlocked()
        val output = JSONArray()
        store.listIdentities().forEach { output.put(identityMetadata(it)) }
        return output
    }

    private fun identityMetadata(identity: AndroidIdentity): JSONObject = JSONObject()
        .put("id", identity.id)
        .put("name", identity.name)
        .put("type", identity.type)
        .put("username", identity.username)
        .put("keyFingerprint", identity.keyFingerprint ?: JSONObject.NULL)
        .put("usageCount", store.countIdentityReferences(identity.id))
        .put("createdAt", identity.createdAt)
        .put("updatedAt", identity.updatedAt)

    private fun createIdentity(input: JSONObject): JSONObject {
        requireUnlocked()
        val identity = identityFromInput(UUID.randomUUID().toString(), input, null)
        if (!store.putIdentity(identity)) failNative("GROUP_ALREADY_EXISTS")
        return identityMetadata(identity)
    }

    private fun updateIdentity(id: String, input: JSONObject): JSONObject {
        val current = requireIdentity(id)
        val identity = identityFromInput(id, input, current)
        if (!store.putIdentity(identity)) failNative("GROUP_ALREADY_EXISTS")
        return identityMetadata(identity)
    }

    private fun deleteIdentity(id: String): JSONObject {
        val identity = requireIdentity(id)
        if (store.countIdentityReferences(identity.id) > 0) failNative("IDENTITY_IN_USE")
        if (!store.deleteIdentity(identity.id)) failNative("IDENTITY_NOT_FOUND")
        return JSONObject()
    }

    private fun identityFromInput(id: String, input: JSONObject, current: AndroidIdentity?): AndroidIdentity {
        val name = textField(input, "name", current?.name, 120)
        val type = if (input.has("type")) requiredText(input, "type", 32) else current?.type ?: failNative("HOST_VALIDATION_FAILED")
        if (type != "password" && type != "private_key") failNative("HOST_VALIDATION_FAILED")
        val username = textField(input, "username", current?.username, 255)
        if (username.any { it.isWhitespace() }) failNative("HOST_VALIDATION_FAILED")
        val auth = if (input.has("auth") && !input.isNull("auth")) input.optJSONObject("auth") ?: failNative("HOST_VALIDATION_FAILED") else null
        val authJson: JSONObject
        val keyFingerprint: String?
        if (auth != null) {
            authJson = validateAuth(auth)
            if (authJson.optString("type") != type) failNative("HOST_VALIDATION_FAILED")
            keyFingerprint = null
        } else {
            if (current == null || current.type != type) failNative("HOST_VALIDATION_FAILED")
            authJson = try { JSONObject(vault.decryptSecret(current.credentialCiphertext, "identity:${current.id}:credentials:v1")) } catch (_: Exception) { failNative("VAULT_CRYPTO_FAILED") }
            keyFingerprint = current.keyFingerprint
        }
        val now = Instant.now().toString()
        return AndroidIdentity(
            id = id,
            name = name,
            type = type,
            username = username,
            keyFingerprint = keyFingerprint,
            credentialCiphertext = if (auth != null) vault.encryptSecret(authJson.toString(), "identity:$id:credentials:v1") else current!!.credentialCiphertext,
            createdAt = current?.createdAt ?: now,
            updatedAt = now
        )
    }

    private fun groupsList(): JSONArray {
        requireUnlocked()
        val output = JSONArray()
        store.listGroups().forEach { output.put(groupJson(it)) }
        return output
    }

    private fun groupJson(group: AndroidGroup): JSONObject = JSONObject()
        .put("id", group.id)
        .put("name", group.name)
        .put("parentId", group.parentId ?: JSONObject.NULL)
        .put("sortOrder", group.sortOrder)
        .put("defaultIdentityId", group.defaultIdentityId ?: JSONObject.NULL)
        .put("connectionProfile", group.connectionProfileJson?.let { jsonObjectOrNull(it) } ?: JSONObject.NULL)

    private fun createGroup(input: JSONObject): JSONObject {
        requireUnlocked()
        val group = groupFromInput(UUID.randomUUID().toString(), input, null)
        if (!store.putGroup(group)) failNative("GROUP_ALREADY_EXISTS")
        return groupJson(group)
    }

    private fun updateGroup(id: String, input: JSONObject): JSONObject {
        val current = requireGroup(id)
        val group = groupFromInput(id, input, current)
        if (!store.putGroup(group)) failNative("GROUP_ALREADY_EXISTS")
        return groupJson(group)
    }

    private fun deleteGroup(id: String): JSONObject {
        requireGroup(id)
        if (!store.deleteGroup(id)) failNative("GROUP_NOT_FOUND")
        return JSONObject()
    }

    private fun groupFromInput(id: String, input: JSONObject, current: AndroidGroup?): AndroidGroup {
        val name = textField(input, "name", current?.name, 120)
        val parentId = if (input.has("parentId")) nullableText(input, "parentId", 128) else current?.parentId
        validateGroupParent(id, parentId)
        val sortOrder = intField(input, "sortOrder", current?.sortOrder ?: 0, 0, 1_000_000)
        val defaultIdentityId = if (input.has("defaultIdentityId")) nullableText(input, "defaultIdentityId", 128) else current?.defaultIdentityId
        if (defaultIdentityId != null) requireIdentity(defaultIdentityId)
        val connectionProfileJson = if (!input.has("connectionProfile") || input.isNull("connectionProfile")) {
            if (input.has("connectionProfile")) null else current?.connectionProfileJson
        } else normalizeProfilePatch(input.optJSONObject("connectionProfile") ?: failNative("HOST_VALIDATION_FAILED")).toString()
        val now = Instant.now().toString()
        return AndroidGroup(id, name, parentId, sortOrder, defaultIdentityId, connectionProfileJson, current?.createdAt ?: now, now)
    }

    private fun validateGroupParent(groupId: String, parentId: String?) {
        if (parentId == null) return
        AndroidNativeValidation.requireSafeId(parentId)
        if (parentId == groupId) failNative("GROUP_CYCLE")
        val seen = HashSet<String>()
        var cursor: String? = parentId
        var depth = 1
        while (cursor != null) {
            if (!seen.add(cursor)) failNative("GROUP_CYCLE")
            val group = store.getGroup(cursor) ?: failNative("GROUP_NOT_FOUND")
            depth += 1
            if (depth > 8) failNative("GROUP_DEPTH_EXCEEDED")
            cursor = group.parentId
        }
    }

    private fun terminalProfilesList(): JSONArray {
        requireUnlocked()
        val output = JSONArray().put(termiusProfile())
        store.listTerminalProfiles().forEach { output.put(terminalProfileJson(it)) }
        return output
    }

    private fun terminalProfileDefault(): JSONObject {
        requireUnlocked()
        val id = store.getDefaultTerminalProfileId()
        return if (id == null || id == "builtin:termius") termiusProfile() else store.getTerminalProfile(id)?.let(::terminalProfileJson) ?: termiusProfile()
    }

    private fun createTerminalProfile(input: JSONObject): JSONObject {
        requireUnlocked()
        val name = textField(input, "name", null, 120)
        val appearance = validateAppearance(input.optJSONObject("appearance") ?: failNative("HOST_VALIDATION_FAILED"))
        val now = Instant.now().toString()
        val profile = AndroidTerminalProfile(UUID.randomUUID().toString(), name, appearance.toString(), now, now)
        if (!store.putTerminalProfile(profile)) failNative("GROUP_ALREADY_EXISTS")
        return terminalProfileJson(profile)
    }

    private fun setDefaultTerminalProfile(id: String): JSONObject {
        requireUnlocked()
        AndroidNativeValidation.requireSafeId(id)
        val profile = if (id == "builtin:termius") termiusProfile() else store.getTerminalProfile(id)?.let(::terminalProfileJson) ?: failNative("NOT_FOUND")
        store.setDefaultTerminalProfileId(id)
        return profile
    }

    private fun deleteTerminalProfile(id: String): JSONObject {
        requireUnlocked()
        AndroidNativeValidation.requireSafeId(id)
        if (id == "builtin:termius" || store.getTerminalProfile(id) == null) failNative("NOT_FOUND")
        if (store.getDefaultTerminalProfileId() == id || store.countTerminalProfileReferences(id) > 0) failNative("TERMINAL_PROFILE_IN_USE")
        if (!store.deleteTerminalProfile(id)) failNative("NOT_FOUND")
        return JSONObject()
    }

    private fun terminalProfileJson(profile: AndroidTerminalProfile): JSONObject = JSONObject()
        .put("id", profile.id)
        .put("name", profile.name)
        .put("appearance", jsonObjectOrNull(profile.appearanceJson) ?: failNative("INTERNAL_ERROR"))
        .put("createdAt", profile.createdAt)
        .put("updatedAt", profile.updatedAt)

    private fun hostFromInput(id: String, input: JSONObject, current: AndroidHost?): AndroidHost {
        val name = textField(input, "name", current?.name, 120)
        val address = textField(input, "address", current?.address, 253)
        val port = intField(input, "port", current?.port ?: 22, 1, 65_535)
        val username = textField(input, "username", current?.username, 255)
        if (username.any { it.isWhitespace() }) failNative("HOST_VALIDATION_FAILED")
        if (!isHostAddress(address)) failNative("HOST_VALIDATION_FAILED")
        val groupId = if (input.has("groupId")) nullableText(input, "groupId", 128) else current?.groupId
        val terminalProfileId = if (input.has("terminalProfileId")) nullableText(input, "terminalProfileId", 128) else current?.terminalProfileId
        val jumpHostIds = if (input.has("jumpHostIds")) parseStringList(input.optJSONArray("jumpHostIds"), 4, 128) else decodeList(current?.jumpHostIdsJson)
        val tags = if (input.has("tags")) parseStringList(input.optJSONArray("tags"), 20, 64) else decodeList(current?.tagsJson)
        val settings = mergeSettings(current, input.optJSONObject("connectionProfile"))
        val favorite = if (input.has("isFavorite")) input.optBoolean("isFavorite") else current?.favorite ?: false

        val source = if (input.has("credentialSource") && !input.isNull("credentialSource")) input.optJSONObject("credentialSource") ?: failNative("HOST_VALIDATION_FAILED") else null
        val auth = if (input.has("auth") && !input.isNull("auth")) input.optJSONObject("auth") else null
        val credentialCiphertext: String?
        val authType: String
        val credentialSource: String
        val identityId: String?
        if (auth != null) {
            if (source != null && source.optString("type") != "inline") failNative("HOST_VALIDATION_FAILED")
            val parsedAuth = validateAuth(auth)
            authType = parsedAuth.optString("type")
            credentialCiphertext = vault.encryptSecret(parsedAuth.toString(), "host:$id:credentials:v1")
            credentialSource = "inline"
            identityId = null
        } else {
            credentialSource = source?.optString("type") ?: current?.credentialSource ?: "inline"
            when (credentialSource) {
                "inline" -> {
                    val existing = current ?: failNative("HOST_VALIDATION_FAILED")
                    authType = existing.authType
                    credentialCiphertext = existing.credentialCiphertext
                    identityId = null
                    if (credentialCiphertext == null) failNative("AUTH_REQUIRED")
                }
                "identity" -> {
                    identityId = source?.let { nullableText(it, "identityId", 128) } ?: current?.identityId
                    val identity = identityId?.let(::requireIdentity) ?: failNative("IDENTITY_NOT_FOUND")
                    authType = identity.type
                    credentialCiphertext = null
                }
                "group" -> {
                    identityId = null
                    val group = groupId?.let { requireGroup(it) } ?: failNative("GROUP_NOT_FOUND")
                    authType = groupIdentity(group.id)?.type ?: failNative("IDENTITY_NOT_FOUND")
                    credentialCiphertext = null
                }
                else -> failNative("HOST_VALIDATION_FAILED")
            }
        }
        val now = Instant.now().toString()
        return AndroidHost(
            id = id,
            name = name,
            address = address,
            port = port,
            username = username,
            authType = authType,
            credentialCiphertext = credentialCiphertext,
            credentialSource = credentialSource,
            identityId = identityId,
            groupId = groupId,
            terminalProfileId = terminalProfileId,
            jumpHostIdsJson = JSONArray(jumpHostIds).toString(),
            keepaliveIntervalMs = settings.keepaliveIntervalMs,
            keepaliveCountMax = settings.keepaliveCountMax,
            reconnectEnabled = settings.reconnectEnabled,
            reconnectMaxAttempts = settings.reconnectMaxAttempts,
            reconnectBaseDelayMs = settings.reconnectBaseDelayMs,
            reconnectMaxDelayMs = settings.reconnectMaxDelayMs,
            tagsJson = JSONArray(tags).toString(),
            favorite = favorite,
            hostKeyAlgorithm = current?.hostKeyAlgorithm,
            hostKeyFingerprint = current?.hostKeyFingerprint,
            lastConnectedAt = current?.lastConnectedAt,
            createdAt = current?.createdAt ?: now,
            updatedAt = now
        )
    }

    private fun hostMetadata(host: AndroidHost): JSONObject {
        val identity = hostIdentity(host)
        val source = when (host.credentialSource) {
            "identity" -> JSONObject().put("type", "identity").put("identityId", host.identityId ?: JSONObject.NULL)
            "group" -> JSONObject().put("type", "group")
            else -> JSONObject().put("type", "inline").put("authType", host.authType)
        }
        return JSONObject()
            .put("id", host.id)
            .put("name", host.name)
            .put("address", host.address)
            .put("port", host.port)
            .put("username", host.username)
            .put("authType", identity?.type ?: host.authType)
            .put("groupId", host.groupId ?: JSONObject.NULL)
            .put("terminalProfileId", host.terminalProfileId ?: JSONObject.NULL)
            .put("tags", JSONArray(decodeList(host.tagsJson)))
            .put("isFavorite", host.favorite)
            .put("hostKeyAlgorithm", host.hostKeyAlgorithm ?: JSONObject.NULL)
            .put("hostKeyFingerprint", host.hostKeyFingerprint ?: JSONObject.NULL)
            .put("lastConnectedAt", host.lastConnectedAt ?: JSONObject.NULL)
            .put("createdAt", host.createdAt)
            .put("updatedAt", host.updatedAt)
            .put("jumpHostIds", JSONArray(decodeList(host.jumpHostIdsJson)))
            .put("connectionProfile", settingsJson(host))
            .put("connectionProfileOverrides", JSONObject.NULL)
            .put("credentialSource", source)
            .also { output ->
                if (identity != null) output.put("identityName", identity.name).put("identitySource", if (host.credentialSource == "group") "group" else "host")
            }
    }

    private fun hostProfile(host: AndroidHost): JSONObject = JSONObject()
        .put("hostId", host.id)
        .put("address", host.address)
        .put("port", host.port)
        .put("username", host.username)
        .put("authType", host.authType)
        .put("jumpHostIds", JSONArray(decodeList(host.jumpHostIdsJson)))
        .put("keepaliveIntervalMs", host.keepaliveIntervalMs)
        .put("keepaliveCountMax", host.keepaliveCountMax)
        .put("reconnect", JSONObject()
            .put("enabled", host.reconnectEnabled)
            .put("maxAttempts", host.reconnectMaxAttempts)
            .put("baseDelayMs", host.reconnectBaseDelayMs)
            .put("maxDelayMs", host.reconnectMaxDelayMs))
        .put("hostKeyAlgorithm", host.hostKeyAlgorithm ?: JSONObject.NULL)
        .put("hostKeyFingerprint", host.hostKeyFingerprint ?: JSONObject.NULL)

    private fun hostIdentity(host: AndroidHost): AndroidIdentity? = when (host.credentialSource) {
        "identity" -> host.identityId?.let { store.getIdentity(it) }
        "group" -> groupIdentity(host.groupId)
        else -> null
    }

    private fun groupIdentity(groupId: String?): AndroidIdentity? {
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

    private fun workspaceLoad(): JSONObject {
        requireUnlocked()
        val value = store.getMeta("workspace.v1") ?: defaultWorkspace().toString()
        return try {
            JSONObject(value)
        } catch (_: Exception) {
            defaultWorkspace()
        }
    }

    private fun workspaceSave(payload: JSONObject): JSONObject {
        requireUnlocked()
        val expectedVersion = payload.optInt("expectedVersion", -1)
        if (expectedVersion < 0) failNative("WORKSPACE_INVALID")
        val current = workspaceLoad()
        if (current.optInt("version", 0) != expectedVersion) failNative("WORKSPACE_VERSION_CONFLICT")
        val state = payload.optJSONObject("state") ?: failNative("WORKSPACE_INVALID")
        val normalized = JSONObject(state.toString()).put("version", expectedVersion + 1)
        if (normalized.toString().toByteArray(StandardCharsets.UTF_8).size > MAX_FRAME_BYTES / 2) failNative("FILE_TOO_LARGE")
        store.putMeta("workspace.v1", normalized.toString())
        return normalized
    }

    private fun defaultWorkspace(): JSONObject = JSONObject()
        .put("version", 0)
        .put("tabs", JSONArray())
        .put("activeTabId", JSONObject.NULL)
        .put("layout", JSONObject().put("mode", "single").put("ratio", 0.5))
        .put("filters", JSONObject().put("query", "").put("groupId", JSONObject.NULL).put("favoriteOnly", false))

    private fun openShell(request: JSONObject): JSONObject {
        requireUnlocked()
        val sessionId = AndroidNativeValidation.requireSafeId(request.optString("requestId", ""))
        val hostId = AndroidNativeValidation.requireSafeId(request.optString("hostId", ""))
        val host = requireHost(hostId)
        AndroidNativeValidation.requireDimensions(request.optInt("cols", 80), request.optInt("rows", 24))
        val session = AndroidSshSession(sessionId, host, store, vault, readerExecutor) { kind, eventSessionId, payload ->
            emitEvent(kind, eventSessionId, payload)
        }
        synchronized(sessionLock) {
            sessions.remove(sessionId)?.close(true)
            if (sessions.size >= MAX_SESSIONS) failNative("SSH_SESSION_LIMIT")
            sessions[sessionId] = session
        }
        sessionRequests[sessionId] = JSONObject(request.toString())
        try {
            connectionExecutor.execute { session.start(request) }
        } catch (_: RejectedExecutionException) {
            synchronized(sessionLock) {
                if (sessions[sessionId] === session) sessions.remove(sessionId)
            }
            failNative("SSH_SESSION_LIMIT")
        }
        return JSONObject().put("sessionId", sessionId).put("hostId", host.id)
    }

    private fun reconnect(sessionId: String): JSONObject {
        requireUnlocked()
        AndroidNativeValidation.requireSafeId(sessionId)
        val existing = sessions[sessionId]
        if (existing != null && !existing.isClosed()) return JSONObject().put("sessionId", sessionId)
        val request = sessionRequests[sessionId] ?: failNative("SESSION_NEEDS_REOPEN")
        return openShell(request)
    }

    private fun sessionWrite(payload: JSONObject): JSONObject {
        requireUnlocked()
        val id = AndroidNativeValidation.requireSafeId(payload.optString("sessionId", ""))
        val data = payload.optString("data", "")
        if (data.isEmpty()) return JSONObject()
        if (data.toByteArray(StandardCharsets.UTF_8).size > MAX_OUTPUT_CHUNK) failNative("FILE_TOO_LARGE")
        val session = sessions[id] ?: failNative("SESSION_INVALID")
        session.write(data)
        return JSONObject()
    }

    private fun sessionResize(payload: JSONObject): JSONObject {
        requireUnlocked()
        val id = AndroidNativeValidation.requireSafeId(payload.optString("sessionId", ""))
        val session = sessions[id] ?: failNative("SESSION_INVALID")
        session.resize(payload.optInt("cols", 0), payload.optInt("rows", 0))
        return JSONObject()
    }

    private fun hostKeyDecision(payload: JSONObject): JSONObject {
        val id = AndroidNativeValidation.requireSafeId(payload.optString("sessionId", ""))
        val session = sessions[id] ?: failNative("SESSION_INVALID")
        val fingerprint = requiredText(payload, "fingerprint", 255)
        val decision = payload.optString("decision", "reject")
        val accepted = session.decideHostKey(fingerprint, decision == "trust")
        if (!accepted && decision == "trust") failNative("PROTOCOL_INVALID_MESSAGE")
        return JSONObject().put("accepted", accepted)
    }

    private fun sessionClose(id: String): JSONObject {
        requireUnlocked()
        sessions.remove(id)?.close(true)
        return JSONObject()
    }

    private fun closeAllSessions() {
        synchronized(sessionLock) {
            sessions.values.toList().forEach { it.close(true) }
            sessions.clear()
        }
    }

    private fun sessionsForHost(hostId: String): List<AndroidSshSession> = synchronized(sessionLock) {
        sessions.values.filter { session -> session.belongsToHost(hostId) && !session.isClosed() }
    }

    private fun emitEvent(kind: String, sessionId: String, payload: JSONObject) {
        if (closed.get()) return
        val event = JSObject()
            .put("version", RelayNativePlugin.BRIDGE_VERSION)
            .put("generation", generation.get())
            .put("sequence", sequence.incrementAndGet())
            .put("kind", kind)
            .put("sessionId", sessionId)
            .put("payload", payload)
        if (event.toString().toByteArray(StandardCharsets.UTF_8).size <= MAX_FRAME_BYTES) emitToWeb(event)
    }

    private fun connectionTest(hostId: String): JSONObject {
        val host = requireHost(hostId)
        var keyRepository: AndroidHostKeyRepository? = null
        return try {
            val connection = connectAndroidJsch(host, store, vault, false, onRepository = { keyRepository = it })
            connection.close()
            JSONObject().put("ok", true)
        } catch (error: NativeVaultFailure) {
            if (error.code == "HOST_KEY_REQUIRED" || error.code == "HOST_KEY_MISMATCH") {
                JSONObject().put("ok", false).put("hostKey", keyRepository?.challenge()?.let(::hostKeyJson) ?: JSONObject.NULL)
            } else throw error
        }
    }

    private fun hostKeyJson(challenge: AndroidHostKeyChallenge): JSONObject = JSONObject()
        .put("algorithm", challenge.algorithm)
        .put("fingerprint", challenge.fingerprint)
        .put("address", challenge.address)
        .put("port", challenge.port)
        .put("reason", challenge.reason)
        .also { output ->
            if (challenge.previousAlgorithm != null && challenge.previousFingerprint != null) {
                output.put("previous", JSONObject()
                    .put("algorithm", challenge.previousAlgorithm)
                    .put("fingerprint", challenge.previousFingerprint))
            }
        }

    private fun openFileWriter(payload: JSONObject, selectedUri: String): JSONObject {
        val name = AndroidNativeValidation.requireFileName(requiredText(payload, "name", 255))
        AndroidNativeValidation.requireMimeType(requiredText(payload, "mimeType", 128))
        val uri = try { Uri.parse(selectedUri) } catch (_: Exception) { failNative("PROTOCOL_INVALID_MESSAGE") }
        if (uri.scheme != ContentResolver.SCHEME_CONTENT || uri.authority.isNullOrEmpty()) failNative("CAPABILITY_UNAVAILABLE")
        val tempFile = try {
            File.createTempFile("relay-export-", ".part", appContext.cacheDir)
        } catch (_: Exception) {
            failNative("CAPABILITY_UNAVAILABLE")
        }
        val writer = try {
            AndroidFileWriter(appContext.contentResolver, uri, tempFile)
        } catch (_: Exception) {
            tempFile.delete()
            failNative("CAPABILITY_UNAVAILABLE")
        }
        val writerId = UUID.randomUUID().toString()
        synchronized(fileWriters) {
            if (fileWriters.size >= MAX_FILE_WRITERS) {
                writer.close()
                failNative("OPERATION_INTERRUPTED")
            }
            fileWriters[writerId] = writer
        }
        return JSONObject().put("writerId", writerId).put("name", name)
    }

    private fun writer(id: String): AndroidFileWriter {
        AndroidNativeValidation.requireSafeId(id)
        return fileWriters[id] ?: failNative("OPERATION_INTERRUPTED")
    }

    private fun writeFileWriter(payload: JSONObject): JSONObject {
        val fileWriter = writer(requiredText(payload, "writerId", 128))
        val bytes = decodeChunk(payload.optString("data", ""))
        try {
            fileWriter.write(bytes)
        } finally {
            bytes.fill(0)
        }
        return JSONObject()
    }

    private fun seekFileWriter(payload: JSONObject): JSONObject {
        val position = longField(payload, "position", 0L, Long.MAX_VALUE)
        writer(requiredText(payload, "writerId", 128)).seek(position)
        return JSONObject()
    }

    private fun closeFileWriter(id: String, cancel: Boolean): JSONObject {
        val fileWriter = fileWriters[id] ?: return JSONObject()
        try {
            if (cancel) fileWriter.cancel() else fileWriter.close()
        } finally {
            fileWriters.remove(id)
        }
        return JSONObject()
    }

    private fun filesList(payload: JSONObject): JSONArray {
        val host = requireHost(requiredText(payload, "hostId", 128))
        val path = AndroidNativeValidation.normalizeRemotePath(requiredText(payload, "path", 4096))
        return withSftpValue(host) { sftp ->
            val selected = ArrayList<ChannelSftp.LsEntry>(MAX_SFTP_ENTRIES)
            sftp.ls(path, ChannelSftp.LsEntrySelector { entry ->
                if (entry.filename != "." && entry.filename != "..") selected += entry
                if (selected.size >= MAX_SFTP_ENTRIES) ChannelSftp.LsEntrySelector.BREAK else ChannelSftp.LsEntrySelector.CONTINUE
            })
            val entries = selected
                .sortedWith(compareBy<ChannelSftp.LsEntry>({ if (it.attrs.isDir) 0 else 1 }, { it.filename.lowercase(Locale.ROOT) }))
            JSONArray().also { output ->
                entries.forEach { entry ->
                    val childPath = if (path == "/") "/${entry.filename}" else "$path/${entry.filename}"
                    val attrs = entry.attrs
                    val type = when {
                        attrs.isDir -> "directory"
                        attrs.isLink -> "symlink"
                        attrs.isReg -> "file"
                        else -> "other"
                    }
                    output.put(JSONObject()
                        .put("name", entry.filename)
                        .put("path", childPath)
                        .put("type", type)
                        .put("size", maxOf(0L, attrs.size))
                        .put("mode", attrs.permissions)
                        .put("modifiedAt", Instant.ofEpochSecond(attrs.mTime.toLong()).toString()))
                }
            }
        }
    }

    private fun filesMkdir(payload: JSONObject): JSONObject {
        val host = requireHost(requiredText(payload, "hostId", 128))
        val path = AndroidNativeValidation.normalizeRemotePath(requiredText(payload, "path", 4096))
        withSftp(host) { it.mkdir(path) }
        return JSONObject()
    }

    private fun filesRename(payload: JSONObject): JSONObject {
        val host = requireHost(requiredText(payload, "hostId", 128))
        val from = AndroidNativeValidation.normalizeRemotePath(requiredText(payload, "from", 4096))
        val to = AndroidNativeValidation.normalizeRemotePath(requiredText(payload, "to", 4096))
        withSftp(host) { it.rename(from, to) }
        return JSONObject()
    }

    private fun filesRemove(payload: JSONObject): JSONObject {
        val host = requireHost(requiredText(payload, "hostId", 128))
        val path = AndroidNativeValidation.normalizeRemotePath(requiredText(payload, "path", 4096))
        withSftp(host) { sftp ->
            val attrs = sftp.lstat(path)
            if (attrs.isDir) sftp.rmdir(path) else sftp.rm(path)
        }
        return JSONObject()
    }

    private fun withSftp(host: AndroidHost, operation: (ChannelSftp) -> Unit) {
        withSftpValue(host) { sftp -> operation(sftp); Unit }
    }

    private fun <T> withSftpValue(host: AndroidHost, operation: (ChannelSftp) -> T): T {
        val connection = connectAndroidJsch(host, store, vault, false)
        var sftp: ChannelSftp? = null
        try {
            val opened = connection.session.openChannel("sftp") as? ChannelSftp ?: failNative("SFTP_CONNECTION_FAILED")
            sftp = opened
            opened.setBulkRequests(4)
            opened.connect(60_000)
            return operation(opened)
        } catch (error: NativeVaultFailure) {
            throw error
        } catch (error: SftpException) {
            throw error
        } catch (error: Throwable) {
            throw NativeVaultFailure(mapJschError(error))
        } finally {
            try { sftp?.disconnect() } catch (_: Exception) { }
            connection.close()
        }
    }

    private fun createTransfer(request: JSONObject): JSONObject {
        requireUnlocked()
        val kind = request.optString("kind", "")
        if (kind != "upload" && kind != "download") failNative("SFTP_PATH_INVALID")
        val hostId = AndroidNativeValidation.requireSafeId(request.optString("hostId", ""))
        requireHost(hostId)
        val sourcePath = AndroidNativeValidation.normalizeRemotePath(requiredText(request, "sourcePath", 4096))
        val targetPath = AndroidNativeValidation.normalizeRemotePath(requiredText(request, "targetPath", 4096))
        synchronized(transfers) {
            if (transfers.size >= MAX_TRANSFERS) failNative("SFTP_TRANSFER_FAILED")
        }
        val now = Instant.now().toString()
        val transfer = AndroidTransfer(
            id = UUID.randomUUID().toString(),
            kind = kind,
            hostId = hostId,
            sourcePath = sourcePath,
            targetPath = targetPath,
            totalBytes = nullableLong(request, "totalBytes"),
            createdAt = now,
            updatedAt = now
        )
        transfers[transfer.id] = transfer
        return transferJson(transfer)
    }

    private fun listTransfers(): JSONArray {
        requireUnlocked()
        val output = JSONArray()
        synchronized(transfers) { transfers.values.take(MAX_TRANSFERS).forEach { output.put(transferJson(it)) } }
        return output
    }

    private fun getTransfer(id: String): Any? {
        requireUnlocked()
        AndroidNativeValidation.requireSafeId(id)
        return transfers[id]?.let(::transferJson) ?: JSONObject.NULL
    }

    private fun upload(payload: JSONObject): JSONObject {
        requireUnlocked()
        val transfer = getTransferRecord(requiredText(payload, "transferId", 128))
        return synchronized(transfer) { uploadLocked(payload, transfer) }
    }

    private fun uploadLocked(payload: JSONObject, transfer: AndroidTransfer): JSONObject {
        if (transfer.kind != "upload") failNative("TRANSFER_RESUME_INVALID")
        val resume = payload.optJSONObject("resume") ?: failNative("TRANSFER_RESUME_INVALID")
        val expectedOffset = longField(resume, "expectedOffset", 0L, Long.MAX_VALUE)
        if (expectedOffset != transfer.completedBytes) failNative("TRANSFER_RESUME_INVALID")
        val previousChecksum = nullableText(resume, "checksum", 64)
        if (expectedOffset > 0 && transfer.checksum != null && previousChecksum != transfer.checksum) failNative("TRANSFER_RESUME_INVALID")
        val encoded = payload.optString("data", "")
        val bytes = decodeChunk(encoded)
        val final = payload.optBoolean("final", false)
        val nextChecksum = payload.optString("nextChecksum", "")
        if (!nextChecksum.matches(Regex("^[a-fA-F0-9]{64}$"))) failNative("TRANSFER_RESUME_INVALID")
        if (transfer.status == "cancelled" || transfer.status == "completed") failNative("TRANSFER_CANCELLED")
        transfer.status = "running"
        try {
            if (bytes.isNotEmpty()) {
                val host = requireHost(transfer.hostId)
                withSftpValue(host) { sftp ->
                    val mode = if (transfer.completedBytes == 0L) ChannelSftp.OVERWRITE else ChannelSftp.APPEND
                    sftp.put(ByteArrayInputStream(bytes), transfer.targetPath, mode)
                }
                transfer.completedBytes += bytes.size.toLong()
            }
        } finally {
            bytes.fill(0)
        }
        transfer.checksum = nextChecksum.lowercase(Locale.ROOT)
        transfer.updatedAt = Instant.now().toString()
        if (final) transfer.status = "completed"
        val result = transferJson(transfer)
        emitTransferProgress(transfer)
        return result
    }

    private fun download(payload: JSONObject): JSONObject {
        requireUnlocked()
        val transfer = getTransferRecord(requiredText(payload, "transferId", 128))
        return synchronized(transfer) { downloadLocked(payload, transfer) }
    }

    private fun downloadLocked(payload: JSONObject, transfer: AndroidTransfer): JSONObject {
        if (transfer.kind != "download") failNative("TRANSFER_RESUME_INVALID")
        if (transfer.status == "cancelled") failNative("TRANSFER_CANCELLED")
        val offset = longField(payload, "offset", 0L, Long.MAX_VALUE)
        if (offset != transfer.completedBytes) failNative("TRANSFER_RESUME_INVALID")
        if (transfer.input == null) openDownload(transfer, offset)
        val input = transfer.input ?: failNative("SFTP_TRANSFER_FAILED")
        val buffer = ByteArray(MAX_OUTPUT_CHUNK)
        return try {
            val count = input.read(buffer)
            if (count < 0) {
                transfer.closeDownload()
                transfer.status = "completed"
                transfer.updatedAt = Instant.now().toString()
                emitTransferProgress(transfer)
                JSONObject().put("data", "").put("done", true)
            } else if (count == 0) {
                JSONObject().put("data", "").put("done", false)
            } else {
                transfer.status = "running"
                transfer.completedBytes += count.toLong()
                transfer.updatedAt = Instant.now().toString()
                val encoded = Base64.encodeToString(buffer, 0, count, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                emitTransferProgress(transfer)
                JSONObject().put("data", encoded).put("done", false)
            }
        } finally {
            buffer.fill(0)
        }
    }

    private fun openDownload(transfer: AndroidTransfer, offset: Long) {
        synchronized(transfers) {
            val activeDownloads = transfers.values.count { it.input != null }
            if (activeDownloads >= MAX_DOWNLOADS) failNative("SFTP_TRANSFER_FAILED")
        }
        val host = requireHost(transfer.hostId)
        val connection = connectAndroidJsch(host, store, vault, false)
        try {
            val opened = connection.session.openChannel("sftp") as? ChannelSftp ?: failNative("SFTP_CONNECTION_FAILED")
            opened.setBulkRequests(4)
            opened.connect(60_000)
            val attrs = opened.stat(transfer.sourcePath)
            if (transfer.totalBytes == null) transfer.totalBytes = maxOf(0L, attrs.size)
            transfer.connection = connection
            transfer.sftp = opened
            transfer.input = opened.get(transfer.sourcePath, null, offset)
        } catch (error: Throwable) {
            connection.close()
            throw error
        }
    }

    private fun pauseTransfer(id: String): JSONObject {
        requireUnlocked()
        val transfer = getTransferRecord(id)
        return synchronized(transfer) {
            if (transfer.status == "completed" || transfer.status == "cancelled") return@synchronized transferJson(transfer)
            transfer.status = "paused"
            transfer.updatedAt = Instant.now().toString()
            transfer.closeDownload()
            transferJson(transfer)
        }
    }

    private fun cancelTransfer(id: String): JSONObject {
        requireUnlocked()
        val transfer = getTransferRecord(id)
        return synchronized(transfer) {
            transfer.status = "cancelled"
            transfer.updatedAt = Instant.now().toString()
            transfer.closeDownload()
            transferJson(transfer)
        }
    }

    private fun retryTransfer(id: String): JSONObject {
        requireUnlocked()
        val transfer = getTransferRecord(id)
        return synchronized(transfer) {
            if (transfer.status !in setOf("failed", "paused", "interrupted")) return@synchronized transferJson(transfer)
            transfer.status = "queued"
            transfer.errorCode = null
            transfer.updatedAt = Instant.now().toString()
            transfer.closeDownload()
            transferJson(transfer)
        }
    }

    private fun getTransferRecord(id: String): AndroidTransfer {
        AndroidNativeValidation.requireSafeId(id)
        return transfers[id] ?: failNative("TRANSFER_NOT_FOUND")
    }

    private fun transferJson(transfer: AndroidTransfer): JSONObject = synchronized(transfer) { JSONObject()
        .put("id", transfer.id)
        .put("kind", transfer.kind)
        .put("hostId", transfer.hostId)
        .put("sourcePath", transfer.sourcePath)
        .put("targetPath", transfer.targetPath)
        .put("status", transfer.status)
        .put("completedBytes", transfer.completedBytes)
        .put("totalBytes", transfer.totalBytes ?: JSONObject.NULL)
        .put("createdAt", transfer.createdAt)
        .put("updatedAt", transfer.updatedAt)
        .put("checkpoint", JSONObject()
            .put("transferId", transfer.id)
            .put("offset", transfer.completedBytes)
            .put("totalBytes", transfer.totalBytes ?: JSONObject.NULL)
            .put("checksum", transfer.checksum ?: JSONObject.NULL))
        .also { if (transfer.errorCode != null) it.put("errorCode", transfer.errorCode) } }

    private fun emitTransferProgress(transfer: AndroidTransfer) {
        val event = JSObject()
            .put("version", RelayNativePlugin.BRIDGE_VERSION)
            .put("generation", generation.get())
            .put("sequence", sequence.incrementAndGet())
            .put("kind", "transfer.progress")
            .put("transferId", transfer.id)
            .put("payload", JSONObject().put("job", transferJson(transfer)))
        if (event.toString().toByteArray(StandardCharsets.UTF_8).size <= MAX_FRAME_BYTES) emitToWeb(event)
    }

    private fun readClipboard(): String {
        val manager = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: failNative("CAPABILITY_UNAVAILABLE")
        val text = manager.primaryClip?.getItemAt(0)?.coerceToText(appContext)?.toString() ?: ""
        if (text.length > 64 * 1024) failNative("FILE_TOO_LARGE")
        return text
    }

    private fun writeClipboard(text: String) {
        val manager = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: failNative("CAPABILITY_UNAVAILABLE")
        manager.setPrimaryClip(ClipData.newPlainText("Relay", text))
    }

    private fun openExternal(value: String) {
        val uri = try { Uri.parse(value) } catch (_: Exception) { failNative("PROTOCOL_INVALID_MESSAGE") }
        if (uri.scheme != "http" && uri.scheme != "https") failNative("CAPABILITY_UNAVAILABLE")
        try {
            appContext.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            failNative("CAPABILITY_UNAVAILABLE")
        }
    }

    private fun validateAuth(auth: JSONObject): JSONObject {
        val type = auth.optString("type", "")
        if (type == "password") {
            val password = requiredText(auth, "password", 4096)
            if (password.isEmpty()) failNative("HOST_VALIDATION_FAILED")
            return JSONObject().put("type", type).put("password", password)
        }
        if (type == "private_key") {
            val privateKey = requiredText(auth, "privateKey", 32 * 1024)
            val output = JSONObject().put("type", type).put("privateKey", privateKey)
            if (auth.has("passphrase") && !auth.isNull("passphrase")) output.put("passphrase", requiredText(auth, "passphrase", 4096))
            if (auth.has("identityFile") && !auth.isNull("identityFile")) output.put("identityFile", requiredText(auth, "identityFile", 4096))
            return output
        }
        failNative("HOST_VALIDATION_FAILED")
    }

    private data class ConnectionSettings(
        val keepaliveIntervalMs: Int,
        val keepaliveCountMax: Int,
        val reconnectEnabled: Boolean,
        val reconnectMaxAttempts: Int,
        val reconnectBaseDelayMs: Int,
        val reconnectMaxDelayMs: Int
    )

    private fun mergeSettings(current: AndroidHost?, patch: JSONObject?): ConnectionSettings {
        val base = current?.let {
            ConnectionSettings(it.keepaliveIntervalMs, it.keepaliveCountMax, it.reconnectEnabled, it.reconnectMaxAttempts, it.reconnectBaseDelayMs, it.reconnectMaxDelayMs)
        } ?: ConnectionSettings(10_000, 3, true, 5, 250, 5_000)
        if (patch == null || patch == JSONObject.NULL) return base
        val reconnect = patch.optJSONObject("reconnect")
        val settings = ConnectionSettings(
            keepaliveIntervalMs = intField(patch, "keepaliveIntervalMs", base.keepaliveIntervalMs, 0, 600_000),
            keepaliveCountMax = intField(patch, "keepaliveCountMax", base.keepaliveCountMax, 0, 100),
            reconnectEnabled = reconnect?.let { if (it.has("enabled")) it.optBoolean("enabled") else base.reconnectEnabled } ?: base.reconnectEnabled,
            reconnectMaxAttempts = reconnect?.let { intField(it, "maxAttempts", base.reconnectMaxAttempts, 0, 20) } ?: base.reconnectMaxAttempts,
            reconnectBaseDelayMs = reconnect?.let { intField(it, "baseDelayMs", base.reconnectBaseDelayMs, 0, 60_000) } ?: base.reconnectBaseDelayMs,
            reconnectMaxDelayMs = reconnect?.let { intField(it, "maxDelayMs", base.reconnectMaxDelayMs, 0, 600_000) } ?: base.reconnectMaxDelayMs
        )
        if (settings.reconnectMaxDelayMs < settings.reconnectBaseDelayMs) failNative("HOST_VALIDATION_FAILED")
        return settings
    }

    private fun settingsJson(host: AndroidHost): JSONObject = JSONObject()
        .put("keepaliveIntervalMs", host.keepaliveIntervalMs)
        .put("keepaliveCountMax", host.keepaliveCountMax)
        .put("reconnect", JSONObject()
            .put("enabled", host.reconnectEnabled)
            .put("maxAttempts", host.reconnectMaxAttempts)
            .put("baseDelayMs", host.reconnectBaseDelayMs)
            .put("maxDelayMs", host.reconnectMaxDelayMs))

    private fun termiusProfile(): JSONObject = JSONObject()
        .put("id", "builtin:termius")
        .put("name", "Termius Dark")
        .put("createdAt", "1970-01-01T00:00:00.000Z")
        .put("updatedAt", "1970-01-01T00:00:00.000Z")
        .put("appearance", JSONObject()
            .put("foreground", "#5cc97c")
            .put("background", "#141728")
            .put("cursor", "#92a0a7")
            .put("cursorAccent", "#141728")
            .put("selectionBackground", "#225388")
            .put("selectionForeground", "#ffffff")
            .put("black", "#141728")
            .put("red", "#e05b57")
            .put("green", "#5cc97c")
            .put("yellow", "#e7ebed")
            .put("blue", "#225388")
            .put("magenta", "#ee7b79")
            .put("cyan", "#478fef")
            .put("white", "#d6dde0")
            .put("brightBlack", "#333649")
            .put("brightRed", "#e16866")
            .put("brightGreen", "#5cc97c")
            .put("brightYellow", "#ffffff")
            .put("brightBlue", "#346baf")
            .put("brightMagenta", "#ee7b79")
            .put("brightCyan", "#5d9fef")
            .put("brightWhite", "#ffffff")
            .put("fontFamily", "\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace")
            .put("fontSize", 13)
            .put("lineHeight", 1.25)
            .put("cursorStyle", "bar")
            .put("cursorBlink", true)
            .put("scrollback", 5_000))

    private fun jsonObjectOrNull(value: String): JSONObject? = try {
        JSONObject(value)
    } catch (_: Exception) {
        null
    }

    private fun normalizeProfilePatch(input: JSONObject): JSONObject {
        val output = JSONObject()
        if (input.has("keepaliveIntervalMs")) output.put("keepaliveIntervalMs", intField(input, "keepaliveIntervalMs", 0, 0, 600_000))
        if (input.has("keepaliveCountMax")) output.put("keepaliveCountMax", intField(input, "keepaliveCountMax", 0, 0, 100))
        if (input.has("reconnect")) {
            val reconnect = input.optJSONObject("reconnect") ?: failNative("HOST_VALIDATION_FAILED")
            val normalized = JSONObject()
            if (reconnect.has("enabled")) {
                if (reconnect.opt("enabled") !is Boolean) failNative("HOST_VALIDATION_FAILED")
                normalized.put("enabled", reconnect.optBoolean("enabled"))
            }
            if (reconnect.has("maxAttempts")) normalized.put("maxAttempts", intField(reconnect, "maxAttempts", 0, 0, 20))
            if (reconnect.has("baseDelayMs")) normalized.put("baseDelayMs", intField(reconnect, "baseDelayMs", 0, 0, 60_000))
            if (reconnect.has("maxDelayMs")) normalized.put("maxDelayMs", intField(reconnect, "maxDelayMs", 0, 0, 600_000))
            if (normalized.has("baseDelayMs") && normalized.has("maxDelayMs") && normalized.optInt("maxDelayMs") < normalized.optInt("baseDelayMs")) failNative("HOST_VALIDATION_FAILED")
            output.put("reconnect", normalized)
        }
        return output
    }

    private fun validateAppearance(input: JSONObject): JSONObject {
        val output = JSONObject()
        val colors = listOf(
            "foreground", "background", "cursor", "cursorAccent", "selectionBackground", "selectionForeground",
            "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack",
            "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
        )
        colors.forEach { key ->
            val value = requiredText(input, key, 7)
            if (!value.matches(Regex("^#[0-9a-fA-F]{6}$"))) failNative("HOST_VALIDATION_FAILED")
            output.put(key, value.lowercase(Locale.ROOT))
        }
        output.put("fontFamily", requiredText(input, "fontFamily", 160))
        output.put("fontSize", intField(input, "fontSize", 13, 10, 24))
        val lineHeight = input.opt("lineHeight")
        if (lineHeight !is Number || lineHeight.toDouble() !in 1.0..2.0) failNative("HOST_VALIDATION_FAILED")
        output.put("lineHeight", lineHeight.toDouble())
        val cursorStyle = requiredText(input, "cursorStyle", 16)
        if (cursorStyle !in setOf("block", "bar", "underline")) failNative("HOST_VALIDATION_FAILED")
        output.put("cursorStyle", cursorStyle)
        if (input.opt("cursorBlink") !is Boolean) failNative("HOST_VALIDATION_FAILED")
        output.put("cursorBlink", input.optBoolean("cursorBlink"))
        output.put("scrollback", intField(input, "scrollback", 5_000, 500, 20_000))
        return output
    }

    private fun requiredText(value: JSONObject, key: String, maxLength: Int): String {
        val text = if (value.has(key) && !value.isNull(key)) value.optString(key, "") else ""
        if (text.isEmpty() || text.length > maxLength || text.any { it.code <= 0x1f || it.code == 0x7f }) failNative("PROTOCOL_INVALID_MESSAGE")
        return text
    }

    private fun textField(value: JSONObject, key: String, fallback: String?, maxLength: Int): String {
        val text = if (value.has(key)) requiredText(value, key, maxLength) else fallback ?: failNative("HOST_VALIDATION_FAILED")
        if (text.isEmpty()) failNative("HOST_VALIDATION_FAILED")
        return text
    }

    private fun nullableText(value: JSONObject, key: String, maxLength: Int): String? {
        if (!value.has(key) || value.isNull(key)) return null
        val text = value.optString(key, "")
        if (text.length > maxLength || text.any { it.code <= 0x1f || it.code == 0x7f }) failNative("PROTOCOL_INVALID_MESSAGE")
        return text.takeIf { it.isNotEmpty() }
    }

    private fun intField(value: JSONObject, key: String, fallback: Int, min: Int, max: Int): Int {
        if (!value.has(key) || value.isNull(key)) return fallback
        val raw = value.opt(key)
        if (raw !is Number) failNative("HOST_VALIDATION_FAILED")
        val result = raw.toLong()
        if (result !in min.toLong()..max.toLong()) failNative("HOST_VALIDATION_FAILED")
        return result.toInt()
    }

    private fun longField(value: JSONObject, key: String, min: Long, max: Long): Long {
        val raw = value.opt(key)
        if (raw !is Number) failNative("PROTOCOL_INVALID_MESSAGE")
        val result = raw.toLong()
        if (result !in min..max) failNative("PROTOCOL_INVALID_MESSAGE")
        return result
    }

    private fun nullableLong(value: JSONObject, key: String): Long? {
        if (!value.has(key) || value.isNull(key)) return null
        return longField(value, key, 0, Long.MAX_VALUE)
    }

    private fun parseStringList(value: JSONArray?, maxItems: Int, maxLength: Int): List<String> {
        if (value == null) return emptyList()
        if (value.length() > maxItems) failNative("HOST_VALIDATION_FAILED")
        val seen = LinkedHashMap<String, Boolean>()
        for (index in 0 until value.length()) {
            val item = value.optString(index, "")
            if (item.isEmpty() || item.length > maxLength || item.any { it.code <= 0x1f || it.code == 0x7f }) failNative("HOST_VALIDATION_FAILED")
            seen[item] = true
        }
        return seen.keys.toList()
    }

    private fun parseStringSet(value: JSONArray?, maxItems: Int, maxLength: Int): Set<String> = parseStringList(value, maxItems, maxLength).toSet()

    private fun decodeList(value: String?): List<String> = try {
        if (value.isNullOrEmpty()) emptyList() else parseStringList(JSONArray(value), 32, 128)
    } catch (_: Exception) {
        emptyList()
    }

    private fun isHostAddress(value: String): Boolean {
        if (value.isEmpty() || value.length > 253 || value.any { it.isWhitespace() || it.code <= 0x1f || it.code == 0x7f }) return false
        return !value.contains('/') && !value.contains('?') && !value.contains('#') && !value.contains('\\') && !value.startsWith('[') && !value.endsWith(']')
    }

    private fun decodeChunk(encoded: String): ByteArray {
        if (encoded.length > MAX_ENCODED_CHUNK_BYTES || !encoded.matches(Regex("^[A-Za-z0-9_-]*$"))) failNative("PROTOCOL_INVALID_MESSAGE")
        return try {
            Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING).also { AndroidNativeValidation.requireChunkSize(it) }
        } catch (_: IllegalArgumentException) {
            failNative("PROTOCOL_INVALID_MESSAGE")
        }
    }

    private fun success(request: JSObject, result: Any?): JSObject {
        val response = JSObject()
            .put("version", RelayNativePlugin.BRIDGE_VERSION)
            .put("requestId", request.optString("requestId", "invalid"))
            .put("ok", true)
            .put("result", result ?: JSONObject.NULL)
        return if (response.toString().toByteArray(StandardCharsets.UTF_8).size <= MAX_FRAME_BYTES) response else failure(request, "FILE_TOO_LARGE")
    }

    private fun failure(request: JSObject, code: String, message: String = errorMessage(code)): JSObject = JSObject()
        .put("version", RelayNativePlugin.BRIDGE_VERSION)
        .put("requestId", request.optString("requestId", "invalid"))
        .put("ok", false)
        .put("error", JSONObject().put("code", code).put("message", message.take(4096)))

    private fun errorMessage(code: String): String = when (code) {
        "VAULT_NOT_INITIALIZED" -> "请先完成初始化"
        "VAULT_LOCKED" -> "Vault 已锁定，请先解锁"
        "VAULT_UNLOCK_FAILED" -> "主密码错误或 Vault 已损坏"
        "HOST_KEY_REQUIRED" -> "需要确认远程主机指纹"
        "HOST_KEY_MISMATCH" -> "远程主机指纹与已保存指纹不一致"
        "SSH_AUTH_FAILED" -> "远程服务器认证失败"
        "SFTP_NOT_FOUND" -> "远程文件或目录不存在"
        "SFTP_PERMISSION_DENIED" -> "没有远程文件权限"
        "SFTP_CONNECTION_FAILED" -> "SFTP 连接失败"
        "OPERATION_INTERRUPTED" -> "本机任务已中断，请稍后重试"
        else -> "本机操作失败"
    }

    private fun mapSftpError(error: SftpException): String = when (error.id) {
        ChannelSftp.SSH_FX_NO_SUCH_FILE -> "SFTP_NOT_FOUND"
        ChannelSftp.SSH_FX_PERMISSION_DENIED -> "SFTP_PERMISSION_DENIED"
        ChannelSftp.SSH_FX_NO_CONNECTION, ChannelSftp.SSH_FX_CONNECTION_LOST -> "SFTP_CONNECTION_FAILED"
        else -> "SFTP_TRANSFER_FAILED"
    }

    private fun boundedExecutor(name: String, threads: Int, queueSize: Int): ExecutorService = ThreadPoolExecutor(
        threads,
        threads,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(queueSize),
        namedDaemonFactory(name),
        ThreadPoolExecutor.AbortPolicy()
    )

    private fun namedDaemonFactory(prefix: String): ThreadFactory {
        val threadNumber = AtomicInteger()
        return ThreadFactory { runnable ->
            Thread(runnable, "$prefix-${threadNumber.incrementAndGet()}").apply { isDaemon = true }
        }
    }

    private class AndroidFileWriter(
        private val resolver: ContentResolver,
        private val uri: Uri,
        private val tempFile: File
    ) {
        private val output = FileOutputStream(tempFile)
        private var closed = false

        @Synchronized
        fun write(bytes: ByteArray) {
            if (closed) throw NativeVaultFailure("OPERATION_INTERRUPTED")
            try {
                output.write(bytes)
                output.flush()
            } catch (_: Exception) {
                throw NativeVaultFailure("SFTP_TRANSFER_FAILED")
            }
        }

        @Synchronized
        fun seek(position: Long) {
            if (closed) throw NativeVaultFailure("OPERATION_INTERRUPTED")
            try {
                output.channel.position(position)
            } catch (_: Exception) {
                throw NativeVaultFailure("CAPABILITY_UNAVAILABLE")
            }
        }

        @Synchronized
        fun close() {
            if (closed) return
            try {
                output.flush()
                output.close()
                val descriptor = resolver.openFileDescriptor(uri, "rwt") ?: throw NativeVaultFailure("CAPABILITY_UNAVAILABLE")
                try {
                    ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { target ->
                        FileInputStream(tempFile).use { source ->
                            val buffer = ByteArray(AndroidNativeValidation.MAX_CHUNK_BYTES)
                            try {
                                while (true) {
                                    val count = source.read(buffer)
                                    if (count < 0) break
                                    if (count > 0) target.write(buffer, 0, count)
                                }
                                target.flush()
                            } finally {
                                buffer.fill(0)
                            }
                        }
                    }
                } finally {
                    tempFile.delete()
                }
                closed = true
            } catch (error: NativeVaultFailure) {
                tempFile.delete()
                throw error
            } catch (_: Exception) {
                tempFile.delete()
                throw NativeVaultFailure("SFTP_TRANSFER_FAILED")
            }
        }

        @Synchronized
        fun cancel() {
            if (closed) return
            try { output.close() } catch (_: Exception) { }
            closed = true
            tempFile.delete()
        }
    }

    private class AndroidTransfer(
        val id: String,
        val kind: String,
        val hostId: String,
        val sourcePath: String,
        val targetPath: String,
        var totalBytes: Long?,
        val createdAt: String,
        var updatedAt: String,
        var status: String = "queued",
        var completedBytes: Long = 0,
        var checksum: String? = null,
        var errorCode: String? = null,
        var connection: AndroidJschConnection? = null,
        var sftp: ChannelSftp? = null,
        var input: InputStream? = null
    ) {
        @Synchronized
        fun closeDownload() {
            try { input?.close() } catch (_: Exception) { }
            try { sftp?.disconnect() } catch (_: Exception) { }
            connection?.close()
            input = null
            sftp = null
            connection = null
        }
    }
}

private fun failNative(code: String): Nothing = throw NativeVaultFailure(code)
