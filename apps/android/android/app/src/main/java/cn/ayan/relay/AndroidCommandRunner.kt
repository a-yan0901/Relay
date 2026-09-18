package cn.ayan.relay

import com.jcraft.jsch.ChannelExec
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Collections
import java.util.LinkedHashMap
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject

/**
 * Bounded native batch command runner. It deliberately keeps the mobile
 * target set smaller than the Web contract and never exposes a raw SSH
 * connection or an unbounded output buffer to the WebView.
 */
internal class AndroidCommandRunner(
    private val store: AndroidLocalStore,
    private val vault: AndroidVault,
    private val emit: (String, String, JSONObject) -> Unit
) : AutoCloseable {
    companion object {
        private const val MAX_RUNS = 32
        private const val MAX_HOSTS = 8
        private const val MAX_COMMAND_BYTES = 48 * 1024
        private const val MAX_OUTPUT_BYTES = 16 * 1024
        private const val MAX_RETURN_OUTPUT_BYTES = 4 * 1024
        private const val MAX_TIMEOUT_MS = 10 * 60 * 1000
        private const val RUN_TTL_MS = 15 * 60 * 1000L
        private const val WORKER_COUNT = 4
        private val destructivePatterns = listOf(
            Regex("\\brm\\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\\b", RegexOption.IGNORE_CASE),
            Regex("\\b(?:shutdown|reboot|poweroff)\\b", RegexOption.IGNORE_CASE),
            Regex("\\bmkfs(?:\\.[a-z0-9_-]+)?\\b", RegexOption.IGNORE_CASE),
            Regex("\\bdd\\s+[^\\n]*\\bof=/dev/", RegexOption.IGNORE_CASE),
            Regex("\\b(?:drop\\s+database|drop\\s+table|truncate\\s+table)\\b", RegexOption.IGNORE_CASE),
            Regex(":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}")
        )
    }

    private class Target(
        val hostId: String,
        var status: String = "queued",
        var exitCode: Int? = null,
        var output: String = "",
        var outputBytes: Int = 0,
        var truncated: Boolean = false,
        var errorCode: String? = null,
        var startedAt: String? = null,
        var finishedAt: String? = null
    )

    private class Run(
        val id: String,
        val requestId: String,
        val command: String,
        val commandCiphertext: String,
        val hostIds: List<String>,
        val persistOutput: Boolean,
        val targetSelection: JSONObject?,
        val createdAt: String,
        val targets: LinkedHashMap<String, Target>,
        val cancelled: AtomicBoolean = AtomicBoolean(false),
        val channels: MutableMap<String, ChannelExec> = mutableMapOf(),
        var status: String = "queued",
        var finishedAt: String? = null,
        var remaining: AtomicInteger = AtomicInteger(hostIds.size)
    )

    private val runs = Collections.synchronizedMap(object : LinkedHashMap<String, Run>(MAX_RUNS, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Run>?): Boolean = size > MAX_RUNS
    })
    private val executor: ExecutorService = ThreadPoolExecutor(
        WORKER_COUNT,
        WORKER_COUNT,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(16),
        namedThreadFactory(),
        ThreadPoolExecutor.AbortPolicy()
    )
    private val restored = AtomicBoolean(false)

    fun start(input: JSONObject): JSONObject {
        ensureRestored()
        prune()
        store.trimCommandRuns(MAX_RUNS - 1)
        val command = requiredCommand(input, "command")
        val variables = parseVariables(input.optJSONObject("variables"))
        val declared = variables.keys.toList()
        val expanded = AndroidAutomationValidation.expandCommand(command, variables, declared)
        val hostIds = parseHostIds(input.optJSONArray("hostIds"))
        val confirmed = !input.has("confirmed") || input.optBoolean("confirmed")
        if ((hostIds.size > 1 || destructivePatterns.any { it.containsMatchIn(expanded) }) && !confirmed) {
            failNative("COMMAND_RUN_VALIDATION_FAILED")
        }
        val targetSelection = input.optJSONObject("targetSelection")?.let { JSONObject(it.toString()) }
        val persistOutput = input.optBoolean("persistOutput", false)
        val requestId = "android-command-${UUID.randomUUID()}"
        val id = UUID.randomUUID().toString()
        val targets = LinkedHashMap<String, Target>()
        hostIds.forEach { targets[it] = Target(it) }
        val commandCiphertext = vault.encryptSecret(
            JSONObject()
                .put("command", expanded)
                .put("requestId", requestId)
                .put("targetSelection", targetSelection ?: JSONObject.NULL)
                .toString(),
            commandAad(id)
        )
        val run = Run(id, requestId, expanded, commandCiphertext, hostIds, persistOutput, targetSelection, Instant.now().toString(), targets)
        synchronized(runs) {
            pruneLocked()
            if (runs.size >= MAX_RUNS) failNative("OPERATION_INTERRUPTED")
            runs[id] = run
        }
        persistRun(run)
        hostIds.forEach { persistTarget(run, run.targets[it] ?: return@forEach) }
        publish(run)
        hostIds.forEach { hostId ->
            try {
                executor.execute { executeTarget(run, hostId, input.optInt("timeoutMs", 60_000).coerceIn(1_000, MAX_TIMEOUT_MS)) }
            } catch (_: RejectedExecutionException) {
                val target = run.targets[hostId]
                if (target != null) finishAndPersist(run, target, "interrupted", null, "OPERATION_INTERRUPTED", "")
            }
        }
        return runJson(run)
    }

    fun get(id: String): JSONObject? {
        ensureRestored()
        AndroidNativeValidation.requireSafeId(id)
        prune()
        return runs[id]?.let(::runJson)
    }

    fun cancel(id: String) {
        ensureRestored()
        AndroidNativeValidation.requireSafeId(id)
        val run = runs[id] ?: failNative("COMMAND_RUN_NOT_FOUND")
        synchronized(run) {
            if (run.status in setOf("completed", "failed", "cancelled", "interrupted")) return
            run.cancelled.set(true)
            run.targets.values.filter { it.status == "queued" }.forEach { target ->
                finishAndPersist(run, target, "cancelled", null, "COMMAND_RUN_CANCELLED", "")
            }
            run.channels.values.toList().forEach { channel -> try { channel.disconnect() } catch (_: Exception) { } }
        }
        publish(run)
    }

    fun restore() {
        if (vault.phase() != "unlocked" || !restored.compareAndSet(false, true)) return
        store.trimCommandRuns(MAX_RUNS)
        store.listCommandRuns().forEach { record ->
            try {
                val commandPayload = JSONObject(vault.decryptSecret(record.commandCiphertext, commandAad(record.id)))
                val command = requiredCommand(commandPayload, "command")
                val requestId = commandPayload.optString("requestId", "android-command-${record.id}")
                val hostIds = parseStoredHostIds(record.hostIdsJson)
                val targetSelection = commandPayload.optJSONObject("targetSelection")?.let { JSONObject(it.toString()) }
                val targets = LinkedHashMap<String, Target>()
                val persistedTargets = store.listCommandTargets(record.id).associateBy { it.hostId }
                hostIds.forEach { hostId ->
                    val target = persistedTargets[hostId]
                    val output = if (record.persistOutput && target?.outputCiphertext != null) {
                        try { vault.decryptSecret(target.outputCiphertext, outputAad(record.id, hostId)).take(MAX_RETURN_OUTPUT_BYTES) } catch (_: Exception) { "" }
                    } else ""
                    targets[hostId] = Target(
                        hostId = hostId,
                        status = target?.status ?: "interrupted",
                        exitCode = target?.exitCode,
                        output = output,
                        outputBytes = target?.outputBytes ?: 0,
                        truncated = target?.outputTruncated ?: false,
                        errorCode = target?.errorCode,
                        startedAt = target?.startedAt,
                        finishedAt = target?.finishedAt
                    )
                }
                val run = Run(
                    id = record.id,
                    requestId = requestId,
                    command = command,
                    commandCiphertext = record.commandCiphertext,
                    hostIds = hostIds,
                    persistOutput = record.persistOutput,
                    targetSelection = targetSelection,
                    createdAt = record.createdAt,
                    targets = targets,
                    status = record.status,
                    finishedAt = record.finishedAt,
                    remaining = AtomicInteger(targets.values.count { it.finishedAt == null })
                )
                synchronized(runs) {
                    if (runs.size < MAX_RUNS) runs[run.id] = run
                }
            } catch (_: Exception) {
                // A corrupt historical task must not prevent the local Vault from opening.
            }
        }
        prune()
    }

    fun interruptForLock(errorCode: String = "VAULT_LOCKED") {
        interruptRuns(errorCode, shutdown = false)
    }

    override fun close() {
        interruptRuns("SERVICE_RESTARTED", shutdown = true)
    }

    private fun interruptRuns(errorCode: String, shutdown: Boolean) {
        synchronized(runs) {
            runs.values.toList().forEach { run ->
                run.targets.values.filter { it.finishedAt == null }.forEach { target ->
                    finishAndPersist(run, target, "interrupted", null, errorCode, "")
                }
                synchronized(run) {
                    run.channels.values.toList().forEach { channel -> try { channel.disconnect() } catch (_: Exception) { } }
                }
                persistRun(run)
            }
            runs.clear()
        }
        restored.set(false)
        if (shutdown) executor.shutdownNow()
    }

    private fun executeTarget(run: Run, hostId: String, timeoutMs: Int) {
        val target = synchronized(run) { run.targets[hostId] ?: return }
        if (synchronized(run) { target.finishedAt != null }) return
        if (run.cancelled.get()) {
            finishAndPersist(run, target, "cancelled", null, "COMMAND_RUN_CANCELLED", "")
            publish(run)
            return
        }
        synchronized(run) {
            target.status = "running"
            target.startedAt = Instant.now().toString()
            if (run.status == "queued") run.status = "running"
        }
        persistTarget(run, target)
        persistRun(run)
        publish(run)
        var connection: AndroidJschConnection? = null
        var channel: ChannelExec? = null
        try {
            val host = store.getHost(hostId) ?: failNative("HOST_NOT_FOUND")
            connection = connectAndroidJsch(host, store, vault, false)
            val opened = connection.session.openChannel("exec") as? ChannelExec ?: failNative("COMMAND_RUN_TARGET_FAILED")
            channel = opened
            val stdout = opened.inputStream
            val stderr = BoundedOutput(MAX_OUTPUT_BYTES)
            opened.setErrStream(stderr)
            opened.setCommand(run.command)
            synchronized(run) {
                run.channels[hostId] = opened
            }
            opened.connect(timeoutMs)
            val output = readOutput(opened, stdout, stderr, run, timeoutMs)
            val exitCode = opened.exitStatus.takeIf { it >= 0 } ?: 0
            val status = if (run.cancelled.get()) "cancelled" else if (exitCode == 0) "completed" else "failed"
            finishAndPersist(run, target, status, if (status == "cancelled") null else exitCode, if (status == "cancelled") "COMMAND_RUN_CANCELLED" else if (status == "failed") "COMMAND_RUN_TARGET_FAILED" else null, output.text, output.bytesWritten, output.truncated)
        } catch (error: Throwable) {
            val cancelled = run.cancelled.get() || error is NativeVaultFailure && error.code == "COMMAND_RUN_CANCELLED"
            val code = if (cancelled) "COMMAND_RUN_CANCELLED" else if (error is NativeVaultFailure) error.code else mapCommandError(error)
            finishAndPersist(run, target, if (cancelled) "cancelled" else "failed", null, code, "")
        } finally {
            synchronized(run) { run.channels.remove(hostId) }
            try { channel?.disconnect() } catch (_: Exception) { }
            connection?.close()
        }
        publish(run)
    }

    private data class CommandOutput(val text: String, val bytesWritten: Int, val truncated: Boolean)

    private fun readOutput(channel: ChannelExec, stdout: InputStream, stderr: BoundedOutput, run: Run, timeoutMs: Int): CommandOutput {
        val output = BoundedOutput(MAX_OUTPUT_BYTES)
        val buffer = ByteArray(8 * 1024)
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs.toLong())
        try {
            while (true) {
                if (run.cancelled.get()) failNative("COMMAND_RUN_CANCELLED")
                val available = stdout.available()
                if (available > 0) {
                    val count = stdout.read(buffer, 0, minOf(buffer.size, available))
                    if (count > 0) output.write(buffer, 0, count)
                } else if (channel.isClosed) {
                    break
                } else {
                    if (System.nanoTime() > deadline) failNative("COMMAND_RUN_TIMEOUT")
                    Thread.sleep(10)
                }
            }
            while (stdout.available() > 0) {
                val count = stdout.read(buffer, 0, minOf(buffer.size, stdout.available()))
                if (count <= 0) break
                output.write(buffer, 0, count)
            }
            output.append(stderr)
            return CommandOutput(output.text(), output.bytesWritten, output.wasTruncated)
        } finally {
            buffer.fill(0)
        }
    }

    private fun finishTarget(run: Run, target: Target, status: String, exitCode: Int?, errorCode: String?, output: String, outputBytes: Int = output.toByteArray(StandardCharsets.UTF_8).size, truncated: Boolean = false) {
        synchronized(run) {
            if (target.finishedAt != null) return
            target.status = status
            target.exitCode = exitCode
            target.outputBytes = outputBytes
            target.truncated = truncated || outputBytes > MAX_RETURN_OUTPUT_BYTES
            target.output = output.take(MAX_RETURN_OUTPUT_BYTES)
            target.errorCode = errorCode
            target.finishedAt = Instant.now().toString()
            if (run.remaining.decrementAndGet() <= 0) {
                run.status = when {
                    run.cancelled.get() || run.targets.values.any { it.status == "cancelled" } -> "cancelled"
                    run.targets.values.any { it.status == "failed" } -> "failed"
                    run.targets.values.any { it.status == "interrupted" } -> "interrupted"
                    else -> "completed"
                }
                run.finishedAt = target.finishedAt
            }
        }
    }

    private fun finishAndPersist(run: Run, target: Target, status: String, exitCode: Int?, errorCode: String?, output: String, outputBytes: Int = output.toByteArray(StandardCharsets.UTF_8).size, truncated: Boolean = false) {
        finishTarget(run, target, status, exitCode, errorCode, output, outputBytes, truncated)
        persistTarget(run, target)
        persistRun(run)
    }

    private fun publish(run: Run) = emit("command.progress", run.id, JSONObject().put("run", runJson(run)))

    private fun runJson(run: Run): JSONObject = synchronized(run) {
        val targets = JSONArray()
        run.targets.values.forEach { target ->
            targets.put(JSONObject()
                .put("hostId", target.hostId)
                .put("status", target.status)
                .put("exitCode", target.exitCode ?: JSONObject.NULL)
                .put("output", target.output)
                .put("outputBytes", target.outputBytes)
                .put("truncated", target.truncated)
                .put("errorCode", target.errorCode ?: JSONObject.NULL)
                .put("startedAt", target.startedAt ?: JSONObject.NULL)
                .put("finishedAt", target.finishedAt ?: JSONObject.NULL))
        }
        val summary = JSONObject()
            .put("total", run.targets.size)
            .put("queued", run.targets.values.count { it.status == "queued" })
            .put("running", run.targets.values.count { it.status == "running" })
            .put("completed", run.targets.values.count { it.status == "completed" })
            .put("failed", run.targets.values.count { it.status == "failed" })
            .put("cancelled", run.targets.values.count { it.status == "cancelled" })
            .put("interrupted", run.targets.values.count { it.status == "interrupted" })
            .put("anomalyCount", run.targets.values.count { it.status == "failed" || it.status == "interrupted" })
            .put("truncatedCount", run.targets.values.count { it.truncated })
        JSONObject()
            .put("id", run.id)
            .put("requestId", run.requestId)
            .put("command", run.command)
            .put("hostIds", JSONArray(run.hostIds))
            .put("persistOutput", run.persistOutput)
            .put("status", run.status)
            .put("targets", targets)
            .put("targetSelection", run.targetSelection ?: JSONObject.NULL)
            .put("summary", summary)
            .put("createdAt", run.createdAt)
            .put("finishedAt", run.finishedAt ?: JSONObject.NULL)
    }

    private fun parseHostIds(value: JSONArray?): List<String> {
        val array = value ?: failNative("COMMAND_RUN_VALIDATION_FAILED")
        if (array.length() == 0 || array.length() > MAX_HOSTS) failNative("COMMAND_RUN_VALIDATION_FAILED")
        val ids = LinkedHashSet<String>()
        for (index in 0 until array.length()) {
            val id = AndroidNativeValidation.requireSafeId(array.optString(index, ""))
            val hostExists = store.getHost(id) != null
            if (!ids.add(id) || !hostExists) failNative(if (!hostExists) "HOST_NOT_FOUND" else "COMMAND_RUN_VALIDATION_FAILED")
        }
        return ids.toList()
    }

    private fun parseVariables(value: JSONObject?): Map<String, String> {
        if (value == null) return emptyMap()
        if (value.length() > 64) failNative("COMMAND_RUN_VALIDATION_FAILED")
        val output = LinkedHashMap<String, String>()
        val keys = value.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            AndroidAutomationValidation.validateVariableName(key)
            val raw = value.opt(key) as? String ?: failNative("COMMAND_RUN_VALIDATION_FAILED")
            AndroidAutomationValidation.validateVariableValue(raw)
            output[key] = raw
        }
        return output
    }

    private fun requiredCommand(input: JSONObject, key: String): String {
        val value = if (input.has(key) && !input.isNull(key)) input.optString(key, "") else ""
        if (value.isEmpty() || value.length > MAX_COMMAND_BYTES || value.trim().isEmpty() || value.any { it.code == 0 || it.code == 0x7f }) failNative("COMMAND_RUN_VALIDATION_FAILED")
        return value
    }

    private fun mapCommandError(error: Throwable): String = when (error) {
        is NativeVaultFailure -> error.code
        else -> mapJschError(error)
    }

    private fun ensureRestored() {
        if (vault.phase() != "unlocked") failNative("VAULT_LOCKED")
        restore()
    }

    private fun persistRun(run: Run) {
        val record = synchronized(run) {
            AndroidCommandRunRecord(
                id = run.id,
                commandCiphertext = run.commandCiphertext,
                hostIdsJson = JSONArray(run.hostIds).toString(),
                status = run.status,
                persistOutput = run.persistOutput,
                createdAt = run.createdAt,
                finishedAt = run.finishedAt
            )
        }
        store.putCommandRun(record)
    }

    private fun persistTarget(run: Run, target: Target) {
        val record = synchronized(run) {
            val outputCiphertext = if (run.persistOutput && target.finishedAt != null) {
                vault.encryptSecret(target.output, outputAad(run.id, target.hostId))
            } else null
            AndroidCommandTargetRecord(
                runId = run.id,
                hostId = target.hostId,
                status = target.status,
                exitCode = target.exitCode,
                outputCiphertext = outputCiphertext,
                outputBytes = target.outputBytes,
                outputTruncated = target.truncated,
                errorCode = target.errorCode,
                startedAt = target.startedAt,
                finishedAt = target.finishedAt
            )
        }
        store.putCommandTarget(record)
    }

    private fun parseStoredHostIds(value: String): List<String> {
        val array = try { JSONArray(value) } catch (_: Exception) { failNative("COMMAND_RUN_VALIDATION_FAILED") }
        if (array.length() == 0 || array.length() > MAX_HOSTS) failNative("COMMAND_RUN_VALIDATION_FAILED")
        val ids = LinkedHashSet<String>()
        for (index in 0 until array.length()) {
            val id = AndroidNativeValidation.requireSafeId(array.optString(index, ""))
            if (!ids.add(id)) failNative("COMMAND_RUN_VALIDATION_FAILED")
        }
        return ids.toList()
    }

    private fun prune() { synchronized(runs) { pruneLocked() } }

    private fun pruneLocked() {
        val cutoff = System.currentTimeMillis() - RUN_TTL_MS
        val iterator = runs.entries.iterator()
        while (iterator.hasNext()) {
            val run = iterator.next().value
            if (run.finishedAt != null && (Instant.parse(run.finishedAt!!).toEpochMilli() <= cutoff || runs.size >= MAX_RUNS)) {
                iterator.remove()
                store.deleteCommandRun(run.id)
            }
        }
    }

    private fun commandAad(id: String): String = "command-run:$id:command:v1"

    private fun outputAad(runId: String, hostId: String): String = "command-run:$runId:host:$hostId:output:v1"

    private fun namedThreadFactory(): ThreadFactory {
        val counter = AtomicInteger()
        return ThreadFactory { runnable -> Thread(runnable, "relay-android-command-${counter.incrementAndGet()}").apply { isDaemon = true } }
    }

    private class BoundedOutput(private val limit: Int) : OutputStream() {
        private val buffer = ByteArrayOutputStream(minOf(limit, 8 * 1024))
        private var truncated = false
        private var totalBytes = 0

        @get:Synchronized
        val bytesWritten: Int
            get() = totalBytes

        @get:Synchronized
        val wasTruncated: Boolean
            get() = truncated

        @Synchronized
        override fun write(value: Int) { write(byteArrayOf(value.toByte()), 0, 1) }

        @Synchronized
        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            if (length <= 0) return
            totalBytes = (totalBytes + length).coerceAtMost(Int.MAX_VALUE)
            val remaining = limit - buffer.size()
            if (remaining <= 0) { truncated = true; return }
            val count = minOf(remaining, length)
            buffer.write(bytes, offset, count)
            if (count < length) truncated = true
        }

        @Synchronized
        fun append(other: BoundedOutput) {
            val bytes = other.bytes()
            try {
                val currentTotal = totalBytes
                write(bytes, 0, bytes.size)
                totalBytes = (currentTotal + other.bytesWritten).coerceAtMost(Int.MAX_VALUE)
                truncated = truncated || other.wasTruncated
            } finally {
                bytes.fill(0)
            }
        }

        @Synchronized
        fun bytes(): ByteArray = buffer.toByteArray()

        @Synchronized
        fun text(): String = buffer.toByteArray().toString(StandardCharsets.UTF_8)
    }
}

private fun failNative(code: String): Nothing = throw NativeVaultFailure(code)
