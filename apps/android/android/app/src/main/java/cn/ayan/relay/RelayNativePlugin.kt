package cn.ayan.relay

import android.app.Activity
import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import android.os.Handler
import android.os.Looper
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AlertDialog
import java.util.concurrent.atomic.AtomicBoolean

internal fun releaseUriGrantIfOperationFailed(
    operationSucceeded: Boolean,
    release: () -> Unit
) {
    if (!operationSucceeded) release()
}

/**
 * Capacitor-facing boundary. Only this class can turn a user-approved Android
 * activity result into a native file writer; ordinary WebView payloads never
 * carry a content URI or an arbitrary native path.
 */
@CapacitorPlugin(name = "RelayNative")
class RelayNativePlugin : Plugin() {
    companion object {
        const val BRIDGE_VERSION = 1
        const val MAX_FRAME_BYTES = 64 * 1024
        const val MAX_CHUNK_BYTES = 32 * 1024
        const val MAX_IN_FLIGHT_CHUNKS = 4
        const val MAX_ENCODED_CHUNK_BYTES = 48 * 1024
        private val SAFE_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
        private val ALLOWED_OPERATIONS = setOf(
            "vault.status", "vault.setup", "vault.unlock", "vault.lock",
            "system.clipboard.readText", "system.clipboard.writeText",
            "system.confirm", "system.openExternal",
            "system.fileOpen.open",
            "system.fileSave.open", "system.fileSave.write", "system.fileSave.seek", "system.fileSave.close", "system.fileSave.cancel",
            "connection.test",
            "hosts.list", "hosts.get", "hosts.listProfiles", "hosts.getProfile", "hosts.create", "hosts.update", "hosts.delete", "hosts.clearHostKey",
            "identities.list", "identities.get", "identities.create", "identities.update", "identities.delete",
            "groups.list", "groups.get", "groups.create", "groups.update", "groups.delete",
            "workspace.load", "workspace.save", "workspace.listTemplates", "workspace.createTemplate", "workspace.deleteTemplate",
            "terminalProfiles.list", "terminalProfiles.getDefault", "terminalProfiles.create", "terminalProfiles.setDefault", "terminalProfiles.delete",
            "sessions.openShell", "sessions.reconnect", "sessions.write", "sessions.resize", "sessions.hostKeyDecision", "sessions.credential", "sessions.close",
            "files.list", "files.listPage", "files.createDirectory", "files.rename", "files.remove", "files.createTransfer", "files.listTransfers", "files.getTransfer", "files.upload", "files.uploadFromSource", "files.releaseUploadSource", "files.download", "files.pauseTransfer", "files.cancelTransfer", "files.retryTransfer",
            "commands.start", "commands.get", "commands.cancel",
            "snippets.list", "snippets.get", "snippets.create", "snippets.update", "snippets.delete",
            "activity.list",
            "imports.previewExternalImport", "imports.applyExternalImport", "imports.exportOpenSshConfig", "imports.exportCsv", "imports.exportVaultBundle", "imports.readVaultBundleChunk", "imports.releaseVaultBundle", "imports.beginVaultImport", "imports.writeVaultImportChunk", "imports.finishVaultImport", "imports.cancelVaultImport", "imports.previewVaultImport", "imports.applyVaultImport"
        )
    }

    interface Executor {
        fun invoke(request: JSObject, complete: (JSObject) -> Unit)
        fun invokeFileOpenSelection(request: JSObject, uri: String, grantFlags: Int, complete: (JSObject) -> Unit)
        fun invokeFileSaveSelection(request: JSObject, uri: String, grantFlags: Int, complete: (JSObject) -> Unit)
        fun close() {}
    }

    private var executor: Executor? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val pendingEvents = AndroidEventQueue<JSObject>(8) { event ->
        event.optString("kind") == "terminal.output" || event.optString("kind") == "transfer.progress"
    }
    private val eventDrainScheduled = AtomicBoolean(false)
    private val confirmInFlight = AtomicBoolean(false)
    private val fileOpenInFlight = AtomicBoolean(false)
    private val fileSaveInFlight = AtomicBoolean(false)
    @Volatile
    private var confirmDialog: AlertDialog? = null

    override fun load() {
        super.load()
        attachExecutor(AndroidLocalExecutor(getContext(), ::emitNativeEvent, ::revokeUriGrant))
    }

    override fun handleOnDestroy() {
        executor?.close()
        executor = null
        confirmDialog?.dismiss()
        confirmDialog = null
        confirmInFlight.set(false)
        fileOpenInFlight.set(false)
        fileSaveInFlight.set(false)
        pendingEvents.clear()
        mainHandler.removeCallbacksAndMessages(null)
        super.handleOnDestroy()
    }

    fun attachExecutor(next: Executor) {
        executor?.close()
        executor = next
    }

    @PluginMethod
    fun invoke(call: PluginCall) {
        val request = call.data
        if (request.getInteger("version") != BRIDGE_VERSION ||
            !isSafeId(request.getString("requestId")) ||
            !isSafeOperation(request.getString("operation")) ||
            request.toString().toByteArray(Charsets.UTF_8).size > MAX_FRAME_BYTES ||
            !payloadIsBounded(request)
        ) {
            call.reject("PROTOCOL_INVALID_MESSAGE")
            return
        }
        val operation = request.getString("operation") ?: ""
        if (!operationAllowlisted(operation)) {
            call.reject("CAPABILITY_UNAVAILABLE")
            return
        }
        val activeExecutor = executor
        if (activeExecutor == null) {
            call.reject("CAPABILITY_UNAVAILABLE")
            return
        }
        if (operation == "system.confirm") {
            showConfirm(call, request)
            return
        }
        if (operation == "system.fileOpen.open") {
            beginFileOpen(call, request)
            return
        }
        if (operation == "system.fileSave.open") {
            beginFileSave(call, request)
            return
        }
        try {
            activeExecutor.invoke(request) { response ->
                mainHandler.post { call.resolve(response) }
            }
        } catch (_: Exception) {
            call.reject("INTERNAL_ERROR")
        }
    }

    fun emitNativeEvent(event: JSObject) {
        if (event.toString().toByteArray(Charsets.UTF_8).size > MAX_FRAME_BYTES) return
        if (!pendingEvents.offer(event)) return
        scheduleEventDrain()
    }

    private fun scheduleEventDrain() {
        if (!eventDrainScheduled.compareAndSet(false, true)) return
        mainHandler.post {
            repeat(4) {
                val event = pendingEvents.poll() ?: return@repeat
                notifyListeners("event", JSObject().put("event", event))
            }
            eventDrainScheduled.set(false)
            if (pendingEvents.isNotEmpty()) scheduleEventDrain()
        }
    }

    private fun isSafeId(value: String?): Boolean = value != null && SAFE_ID.matches(value)

    private fun isSafeOperation(operation: String?): Boolean = operation != null && operation.isNotBlank() && operation.length <= 96

    private fun operationAllowlisted(operation: String): Boolean = operation in ALLOWED_OPERATIONS

    private fun showConfirm(call: PluginCall, request: JSObject) {
        val message = request.optJSONObject("payload")?.optString("message", "") ?: ""
        if (message.isEmpty() || message.length > 4 * 1024 || message.any { it.code <= 0x1f || it.code == 0x7f }) {
            call.resolve(failureResponse(request, "PROTOCOL_INVALID_MESSAGE"))
            return
        }
        if (!confirmInFlight.compareAndSet(false, true)) {
            call.resolve(failureResponse(request, "OPERATION_INTERRUPTED", "已有确认对话框正在显示"))
            return
        }
        val completed = AtomicBoolean(false)
        fun finish(confirmed: Boolean) {
            if (!completed.compareAndSet(false, true)) return
            confirmInFlight.set(false)
            confirmDialog = null
            call.resolve(successResponse(request, JSObject().put("confirmed", confirmed)))
        }
        val dialog = AlertDialog.Builder(getActivity())
            .setTitle("Relay")
            .setMessage(message)
            .setNegativeButton("取消") { _, _ -> finish(false) }
            .setPositiveButton("确认") { _, _ -> finish(true) }
            .create()
        dialog.setOnCancelListener { finish(false) }
        dialog.setOnDismissListener { finish(false) }
        confirmDialog = dialog
        try {
            dialog.show()
        } catch (_: Exception) {
            confirmDialog = null
            confirmInFlight.set(false)
            call.resolve(failureResponse(request, "CAPABILITY_UNAVAILABLE"))
        }
    }

    private fun beginFileSave(call: PluginCall, request: JSObject) {
        if (!fileSaveInFlight.compareAndSet(false, true)) {
            call.resolve(failureResponse(request, "OPERATION_INTERRUPTED", "已有文件保存对话框正在显示"))
            return
        }
        val payload = request.optJSONObject("payload")
        val name = payload?.optString("name", "") ?: ""
        val mimeType = payload?.optString("mimeType", "") ?: ""
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, name)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        try {
            startActivityForResult(call, intent, "fileSaveActivity")
        } catch (_: Exception) {
            fileSaveInFlight.set(false)
            call.resolve(failureResponse(request, "CAPABILITY_UNAVAILABLE"))
        }
    }

    private fun beginFileOpen(call: PluginCall, request: JSObject) {
        if (!fileOpenInFlight.compareAndSet(false, true)) {
            call.resolve(failureResponse(request, "OPERATION_INTERRUPTED", "已有文件选择对话框正在显示"))
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        try {
            startActivityForResult(call, intent, "fileOpenActivity")
        } catch (_: Exception) {
            fileOpenInFlight.set(false)
            call.resolve(failureResponse(request, "CAPABILITY_UNAVAILABLE"))
        }
    }

    @ActivityCallback
    fun fileOpenActivity(call: PluginCall, result: ActivityResult) {
        fileOpenInFlight.set(false)
        val request = call.data
        val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
        if (uri == null) {
            call.resolve(failureResponse(request, "CAPABILITY_UNAVAILABLE", "已取消文件选择"))
            return
        }
        val activeExecutor = executor
        val modeFlags = (result.data?.flags ?: 0) and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val grantFlags = if (modeFlags == 0) Intent.FLAG_GRANT_READ_URI_PERMISSION else modeFlags
        if (activeExecutor == null) {
            revokeUriGrant(uri, grantFlags)
            call.resolve(failureResponse(request, "SERVICE_RESTARTED"))
            return
        }
        try {
            activeExecutor.invokeFileOpenSelection(request, uri.toString(), grantFlags) { response ->
                mainHandler.post {
                    releaseUriGrantIfOperationFailed(response.optBoolean("ok", false)) { revokeUriGrant(uri, grantFlags) }
                    call.resolve(response)
                }
            }
        } catch (_: Exception) {
            revokeUriGrant(uri, grantFlags)
            call.resolve(failureResponse(request, "CAPABILITY_UNAVAILABLE"))
        }
    }

    @ActivityCallback
    fun fileSaveActivity(call: PluginCall, result: ActivityResult) {
        fileSaveInFlight.set(false)
        val request = call.data
        val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
        if (uri == null) {
            call.resolve(failureResponse(request, "CAPABILITY_UNAVAILABLE", "已取消文件保存"))
            return
        }
        val activeExecutor = executor
        val modeFlags = (result.data?.flags ?: 0) and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val grantFlags = if (modeFlags == 0) Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION else modeFlags
        if (activeExecutor == null) {
            revokeUriGrant(uri, grantFlags)
            call.resolve(failureResponse(request, "SERVICE_RESTARTED"))
            return
        }
        try {
            activeExecutor.invokeFileSaveSelection(request, uri.toString(), grantFlags) { response ->
                mainHandler.post {
                    releaseUriGrantIfOperationFailed(response.optBoolean("ok", false)) { revokeUriGrant(uri, grantFlags) }
                    call.resolve(response)
                }
            }
        } catch (_: Exception) {
            revokeUriGrant(uri, grantFlags)
            call.resolve(failureResponse(request, "CAPABILITY_UNAVAILABLE"))
        }
    }

    private fun revokeUriGrant(uri: android.net.Uri, flags: Int) {
        try { getActivity()?.revokeUriPermission(uri, flags) } catch (_: Exception) { }
        try { getContext().revokeUriPermission(uri, flags) } catch (_: Exception) { }
    }

    private fun successResponse(request: JSObject, result: JSObject): JSObject = JSObject()
        .put("version", BRIDGE_VERSION)
        .put("requestId", request.optString("requestId", "invalid"))
        .put("ok", true)
        .put("result", result)

    private fun failureResponse(request: JSObject, code: String, message: String = "本机操作失败"): JSObject = JSObject()
        .put("version", BRIDGE_VERSION)
        .put("requestId", request.optString("requestId", "invalid"))
        .put("ok", false)
        .put("error", JSObject().put("code", code).put("message", message.take(4096)))

    private fun payloadIsBounded(request: JSObject): Boolean {
        val payload = request.optJSONObject("payload") ?: return false
        val operation = request.getString("operation") ?: return false
        if (operation == "system.confirm") {
            val message = payload.optString("message", "")
            if (message.isEmpty() || message.length > 4 * 1024 || message.any { it.code <= 0x1f || it.code == 0x7f }) return false
        }
        if (operation == "system.fileSave.write") {
            val data = payload.optString("data", "")
            if (data.length > MAX_ENCODED_CHUNK_BYTES) return false
            val writerId = payload.optString("writerId", "")
            if (!isSafeId(writerId)) return false
        }
        if (operation == "sessions.write") {
            if (payload.optString("data", "").toByteArray(Charsets.UTF_8).size > MAX_CHUNK_BYTES) return false
            if (!isSafeId(payload.optString("sessionId", ""))) return false
        }
        if (operation == "files.upload" && payload.optString("data", "").length > MAX_ENCODED_CHUNK_BYTES) return false
        if (operation == "files.uploadFromSource") {
            if (!isSafeId(payload.optString("transferId", "")) || !isSafeId(payload.optString("sourceId", ""))) return false
            val resume = payload.optJSONObject("resume")
            if (resume != null && (!isSafeId(resume.optString("transferId", "")) || resume.optLong("expectedOffset", -1L) < 0L)) return false
        }
        if (operation == "imports.writeVaultImportChunk" && payload.optString("data", "").length > MAX_ENCODED_CHUNK_BYTES) return false
        if (operation == "system.fileSave.seek") {
            val writerId = payload.optString("writerId", "")
            if (!isSafeId(writerId) || payload.optLong("position", -1L) < 0L) return false
        }
        if (operation == "system.fileSave.close" || operation == "system.fileSave.cancel") {
            if (!isSafeId(payload.optString("writerId", ""))) return false
        }
        if (operation == "system.fileSave.open") {
            val name = payload.optString("name", "")
            val mimeType = payload.optString("mimeType", "")
            if (name.isBlank() || name.length > 255 || name.contains('\u0000') || name.contains('/') || name.contains('\\')) return false
            if (mimeType.isBlank() || mimeType.length > 128 || !mimeType.contains('/')) return false
        }
        return true
    }
}
