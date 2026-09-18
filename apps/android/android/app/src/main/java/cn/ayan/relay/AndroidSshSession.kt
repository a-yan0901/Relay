package cn.ayan.relay

import android.util.Base64
import com.jcraft.jsch.ChannelShell
import com.jcraft.jsch.Session
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.ExecutorService
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

internal class AndroidSshSession(
    private val id: String,
    private val host: AndroidHost,
    private val store: AndroidLocalStore,
    private val vault: AndroidVault,
    private val readerExecutor: ExecutorService,
    private val emit: (String, String, JSONObject) -> Unit
) {
    companion object {
        private const val CONNECT_TIMEOUT_MS = 60_000
        private const val OUTPUT_CHUNK_BYTES = 32 * 1024
        private const val SERVICE_INSTANCE = "android-local"
    }

    private val closed = AtomicBoolean(false)
    private val finished = AtomicBoolean(false)
    private val endedReaders = AtomicInteger(0)
    private val resourceLock = Any()
    @Volatile
    private var session: Session? = null
    @Volatile
    private var sshConnection: AndroidJschConnection? = null
    @Volatile
    private var channel: ChannelShell? = null
    @Volatile
    private var output: OutputStream? = null
    @Volatile
    private var repository: AndroidHostKeyRepository? = null

    fun start(request: JSONObject) {
        emitStatus("connecting")
        try {
            val cols = request.optInt("cols", 80)
            val rows = request.optInt("rows", 24)
            AndroidNativeValidation.requireDimensions(cols, rows)
            val term = request.optString("term", "xterm-256color").takeIf { it.isNotEmpty() } ?: "xterm-256color"
            val connection = connectAndroidJsch(
                host = host,
                store = store,
                vault = vault,
                allowHostKeyPrompt = true,
                onStatus = ::emitStatus,
                onChallenge = ::emitHostKeyChallenge,
                onRepository = { repository = it },
                onSession = { nextSession ->
                    session = nextSession
                    if (closed.get()) nextSession.disconnect()
                }
            )
            val sshSession = connection.session
            if (closed.get()) {
                connection.close()
                return
            }
            synchronized(resourceLock) {
                if (closed.get()) {
                    connection.close()
                    return
                }
                sshConnection = connection
            }

            val shell = sshSession.openChannel("shell") as? ChannelShell ?: fail("SSH_CONNECTION_FAILED")
            shell.setPty(true)
            shell.setPtyType(term, cols, rows, 0, 0)
            val stdout = shell.inputStream
            val stderr = shell.extInputStream
            shell.connect(CONNECT_TIMEOUT_MS)
            synchronized(resourceLock) {
                if (closed.get()) {
                    connection.close()
                    return
                }
                channel = shell
                output = shell.outputStream
            }
            store.markConnected(host.id)
            emitStatus("connected")
            readerExecutor.execute { readLoop(stdout, "stdout") }
            readerExecutor.execute { readLoop(stderr, "stderr") }
        } catch (error: Throwable) {
            if (!closed.get()) failConnection(mapConnectionError(error))
        }
    }

    fun write(data: String) {
        if (data.isEmpty()) return
        if (data.toByteArray(StandardCharsets.UTF_8).size > OUTPUT_CHUNK_BYTES) fail("FILE_TOO_LARGE")
        try {
            val bytes = data.toByteArray(StandardCharsets.UTF_8)
            try {
                synchronized(resourceLock) {
                    val stream = output ?: fail("SESSION_INVALID")
                    stream.write(bytes)
                    stream.flush()
                }
            } finally {
                bytes.fill(0)
            }
        } catch (error: Throwable) {
            if (!closed.get()) failConnection(mapConnectionError(error))
        }
    }

    fun resize(cols: Int, rows: Int) {
        AndroidNativeValidation.requireDimensions(cols, rows)
        try {
            synchronized(resourceLock) {
                channel?.setPtySize(cols, rows, 0, 0) ?: fail("SESSION_INVALID")
            }
        } catch (error: Throwable) {
            if (!closed.get()) failConnection(mapConnectionError(error))
        }
    }

    fun decideHostKey(fingerprint: String, trust: Boolean): Boolean = repository?.decide(fingerprint, trust) ?: false

    fun close(clean: Boolean) {
        if (!closed.compareAndSet(false, true)) return
        repository?.cancelPending()
        if (!clean) emitStatus("needs-reopen")
        disconnectResources()
        if (clean) finishClose(true) else finishClose(false)
    }

    fun isClosed(): Boolean = closed.get()

    fun belongsToHost(hostId: String): Boolean = host.id == hostId

    private fun readLoop(input: InputStream, stream: String) {
        val buffer = ByteArray(OUTPUT_CHUNK_BYTES)
        try {
            while (!closed.get()) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count == 0) continue
                val encoded = Base64.encodeToString(buffer, 0, count, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                emit("terminal.output", id, JSONObject()
                    .put("stream", stream)
                    .put("encoding", "base64url")
                    .put("data", encoded))
            }
        } catch (_: IOException) {
            if (!closed.get()) failConnection("SSH_CONNECTION_FAILED")
        } catch (_: Exception) {
            if (!closed.get()) failConnection("SSH_CONNECTION_FAILED")
        } finally {
            buffer.fill(0)
            if (endedReaders.incrementAndGet() >= 2 && !closed.get()) finishRemoteClose()
        }
    }

    private fun finishRemoteClose() {
        if (!finished.compareAndSet(false, true)) return
        closed.set(true)
        val exitStatus = channel?.exitStatus ?: -1
        emit("terminal.exit", id, JSONObject().put("code", if (exitStatus >= 0) exitStatus else JSONObject.NULL))
        disconnectResources()
        emitStatus("interrupted")
        emit("terminal.close", id, JSONObject().put("clean", false))
    }

    private fun failConnection(code: String) {
        if (!finished.compareAndSet(false, true)) return
        closed.set(true)
        disconnectResources()
        emit("terminal.error", id, JSONObject().put("code", code).put("message", errorMessage(code)))
        emitStatus("failed")
        emit("terminal.close", id, JSONObject().put("clean", false))
    }

    private fun finishClose(clean: Boolean) {
        if (!finished.compareAndSet(false, true)) return
        emit("terminal.close", id, JSONObject().put("clean", clean))
    }

    private fun emitStatus(state: String) {
        emit("terminal.status", id, JSONObject().put("state", state).put("serviceInstanceId", SERVICE_INSTANCE))
    }

    private fun emitHostKeyChallenge(challenge: AndroidHostKeyChallenge) {
        val payload = JSONObject()
            .put("algorithm", challenge.algorithm)
            .put("fingerprint", challenge.fingerprint)
            .put("address", challenge.address)
            .put("port", challenge.port)
            .put("hostId", challenge.hostId)
            .put("reason", challenge.reason)
        if (challenge.previousAlgorithm != null && challenge.previousFingerprint != null) {
            payload.put("previous", JSONObject()
                .put("algorithm", challenge.previousAlgorithm)
                .put("fingerprint", challenge.previousFingerprint))
        }
        emit("terminal.host-key", id, payload)
    }

    private fun disconnectResources() {
        synchronized(resourceLock) {
            try { channel?.disconnect() } catch (_: Exception) { }
            val connection = sshConnection
            if (connection != null) {
                connection.close()
            } else {
                try { session?.disconnect() } catch (_: Exception) { }
            }
            channel = null
            output = null
            session = null
            sshConnection = null
        }
    }

    private fun mapConnectionError(error: Throwable): String {
        val repositoryCode = repository?.failureCode()
        if (repositoryCode != null) return repositoryCode
        return mapJschError(error)
    }

    private fun errorMessage(code: String): String = when (code) {
        "HOST_KEY_REQUIRED" -> "需要确认远程主机指纹"
        "HOST_KEY_MISMATCH" -> "远程主机指纹与已保存指纹不一致"
        "SSH_AUTH_FAILED" -> "远程服务器认证失败"
        else -> "无法连接远程服务器"
    }
}

private fun fail(code: String): Nothing = throw NativeVaultFailure(code)
