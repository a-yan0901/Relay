package cn.ayan.relay

import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.Channel
import com.jcraft.jsch.Proxy
import com.jcraft.jsch.SocketFactory
import com.jcraft.jsch.Session
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.nio.charset.StandardCharsets

internal data class AndroidJschConnection(
    val jsch: JSch,
    val session: Session,
    val hostKeyRepository: AndroidHostKeyRepository,
    val dependencies: List<AndroidJschConnection> = emptyList()
) {
    fun close() {
        try {
            session.disconnect()
        } catch (_: Exception) {
            // The remote socket may already have been reset.
        }
        dependencies.asReversed().forEach { it.close() }
    }
}

internal fun connectAndroidJsch(
    host: AndroidHost,
    store: AndroidLocalStore,
    vault: AndroidVault,
    allowHostKeyPrompt: Boolean,
    onStatus: (String) -> Unit = {},
    onChallenge: (AndroidHostKeyChallenge) -> Unit = {},
    onRepository: (AndroidHostKeyRepository) -> Unit = {},
    onSession: (Session) -> Unit = {}
): AndroidJschConnection {
    val jumpIdsByHost = HashMap<String, List<String>>()
    val hostsById = HashMap<String, AndroidHost>()
    val visiting = HashSet<String>()

    fun collectPath(current: AndroidHost) {
        if (!visiting.add(current.id)) return
        hostsById[current.id] = current
        val jumpIds = parseJumpHostIds(current.jumpHostIdsJson)
        jumpIdsByHost[current.id] = jumpIds
        jumpIds.forEach { jumpId ->
            val jumpHost = store.getHost(jumpId) ?: failJsch("HOST_NOT_FOUND")
            collectPath(jumpHost)
        }
        visiting.remove(current.id)
    }

    collectPath(host)
    val path = AndroidNativeValidation.resolveHostPath(host.id, jumpIdsByHost)
    val connected = ArrayList<AndroidJschConnection>(path.size)
    var proxySession: Session? = null
    try {
        path.forEach { hostId ->
            val hop = hostsById[hostId] ?: failJsch("HOST_NOT_FOUND")
            val connection = connectSingleAndroidJsch(
                host = hop,
                store = store,
                vault = vault,
                allowHostKeyPrompt = allowHostKeyPrompt,
                proxySession = proxySession,
                onStatus = onStatus,
                onChallenge = onChallenge,
                onRepository = onRepository,
                onSession = onSession
            )
            connected += connection
            proxySession = connection.session
        }
    } catch (error: Throwable) {
        connected.asReversed().forEach { it.close() }
        throw error
    }
    val target = connected.lastOrNull() ?: failJsch("SSH_CONNECTION_FAILED")
    return target.copy(dependencies = connected.dropLast(1))
}

private fun connectSingleAndroidJsch(
    host: AndroidHost,
    store: AndroidLocalStore,
    vault: AndroidVault,
    allowHostKeyPrompt: Boolean,
    proxySession: Session?,
    onStatus: (String) -> Unit,
    onChallenge: (AndroidHostKeyChallenge) -> Unit,
    onRepository: (AndroidHostKeyRepository) -> Unit,
    onSession: (Session) -> Unit
): AndroidJschConnection {
    val jsch = JSch()
    val repository = AndroidHostKeyRepository(
        host = host,
        store = store,
        allowPrompt = allowHostKeyPrompt,
        onStatus = onStatus,
        onChallenge = onChallenge
    )
    onRepository(repository)
    jsch.hostKeyRepository = repository
    val credential = credentialForHost(host, store, vault)
    val session = try {
        jsch.getSession(host.username, host.address, host.port)
    } catch (_: JSchException) {
        failJsch("SSH_CONNECTION_FAILED")
    }
    try {
        session.setConfig("StrictHostKeyChecking", "yes")
        session.setConfig("PreferredAuthentications", "publickey,password")
        session.setTimeout(60_000)
        session.setDaemonThread(true)
        session.serverAliveInterval = host.keepaliveIntervalMs
        session.serverAliveCountMax = host.keepaliveCountMax
        if (proxySession != null) session.setProxy(AndroidJumpProxy(proxySession))
        onSession(session)
        when (credential.optString("type")) {
            "password" -> session.setPassword(credential.optString("password"))
            "private_key" -> {
                val privateKey = credential.optString("privateKey")
                if (privateKey.isEmpty() || privateKey.length > 32 * 1024) failJsch("VAULT_CRYPTO_FAILED")
                val passphrase = if (credential.has("passphrase")) credential.optString("passphrase").toByteArray(StandardCharsets.UTF_8) else null
                try {
                    jsch.addIdentity("relay-${host.id}", privateKey.toByteArray(StandardCharsets.UTF_8), null, passphrase)
                } finally {
                    passphrase?.fill(0)
                }
            }
            else -> failJsch("VAULT_CRYPTO_FAILED")
        }
        session.connect(60_000)
        return AndroidJschConnection(jsch, session, repository)
    } catch (error: NativeVaultFailure) {
        session.disconnect()
        throw error
    } catch (error: Throwable) {
        session.disconnect()
        val code = repository.failureCode() ?: mapJschError(error)
        failJsch(code)
    }
}

private fun credentialForHost(host: AndroidHost, store: AndroidLocalStore, vault: AndroidVault): org.json.JSONObject {
    val credentialCiphertext: String
    val aad: String
    when (host.credentialSource) {
        "inline" -> {
            credentialCiphertext = host.credentialCiphertext ?: failJsch("AUTH_REQUIRED")
            aad = "host:${host.id}:credentials:v1"
        }
        "identity" -> {
            val identityId = host.identityId ?: failJsch("IDENTITY_NOT_FOUND")
            val identity = store.getIdentity(identityId) ?: failJsch("IDENTITY_NOT_FOUND")
            credentialCiphertext = identity.credentialCiphertext
            aad = "identity:${identity.id}:credentials:v1"
        }
        "group" -> {
            val identity = groupIdentity(store, host.groupId) ?: failJsch("IDENTITY_NOT_FOUND")
            credentialCiphertext = identity.credentialCiphertext
            aad = "identity:${identity.id}:credentials:v1"
        }
        else -> failJsch("HOST_VALIDATION_FAILED")
    }
    return org.json.JSONObject(vault.decryptSecret(credentialCiphertext, aad))
}

private fun groupIdentity(store: AndroidLocalStore, groupId: String?): AndroidIdentity? {
    var currentId = groupId
    val visited = HashSet<String>()
    repeat(8) {
        if (currentId == null || !visited.add(currentId!!)) return null
        val group = store.getGroup(currentId!!) ?: return null
        val identityId = group.defaultIdentityId
        if (identityId != null) return store.getIdentity(identityId)
        currentId = group.parentId
    }
    return null
}

private class AndroidJumpProxy(private val jumpSession: Session) : Proxy {
    @Volatile
    private var channel: Channel? = null
    @Volatile
    private var input: InputStream? = null
    @Volatile
    private var output: OutputStream? = null

    override fun connect(socketFactory: SocketFactory?, host: String, port: Int, timeout: Int) {
        val forwarder = jumpSession.getStreamForwarder(host, port)
        try {
            // JSch starts the direct-tcpip pump only when its input stream was
            // requested before connect(). Request both bounded stream handles
            // first; otherwise a successful channel open would carry no data.
            val forwarderInput = forwarder.inputStream
            val forwarderOutput = forwarder.outputStream
            forwarder.connect(timeout)
            input = forwarderInput
            output = forwarderOutput
            channel = forwarder
        } catch (error: Throwable) {
            try { forwarder.disconnect() } catch (_: Exception) { }
            throw error
        }
    }

    override fun getInputStream(): InputStream = input ?: throw JSchException("jump proxy is not connected")

    override fun getOutputStream(): OutputStream = output ?: throw JSchException("jump proxy is not connected")

    override fun getSocket(): Socket? = null

    override fun close() {
        try { channel?.disconnect() } catch (_: Exception) { }
        channel = null
        input = null
        output = null
    }
}

private fun parseJumpHostIds(value: String): List<String> {
    return try {
        val array = org.json.JSONArray(value)
        require(array.length() <= 4) { "jump path too long" }
        buildList(array.length()) {
            for (index in 0 until array.length()) add(AndroidNativeValidation.requireSafeId(array.optString(index, "")))
        }
    } catch (_: NativeVaultFailure) {
        throw NativeVaultFailure("HOST_VALIDATION_FAILED")
    } catch (_: Exception) {
        throw NativeVaultFailure("HOST_VALIDATION_FAILED")
    }
}

internal fun mapJschError(error: Throwable): String {
    val message = error.message?.lowercase().orEmpty()
    return if (message.contains("auth") || message.contains("authentication") || message.contains("publickey")) "SSH_AUTH_FAILED" else "SSH_CONNECTION_FAILED"
}

private fun failJsch(code: String): Nothing = throw NativeVaultFailure(code)
