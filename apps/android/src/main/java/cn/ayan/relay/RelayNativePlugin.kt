package cn.ayan.relay

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor-facing boundary only. SSH/Vault/SFTP executors are injected by the
 * Android application once the real-device feasibility gate selects a library.
 * Keeping this class small prevents arbitrary WebView calls from becoming
 * native filesystem or process access.
 */
@CapacitorPlugin(name = "RelayNative")
class RelayNativePlugin : Plugin() {
    companion object {
        const val BRIDGE_VERSION = 1
        const val MAX_FRAME_BYTES = 64 * 1024
        const val MAX_CHUNK_BYTES = 32 * 1024
        const val MAX_IN_FLIGHT_CHUNKS = 4
        private val ALLOWED_OPERATIONS = setOf(
            "vault.status", "vault.setup", "vault.unlock", "vault.lock",
            "system.clipboard.readText", "system.clipboard.writeText",
            "connection.test",
            "hosts.list", "hosts.get", "hosts.listProfiles", "hosts.getProfile", "hosts.create", "hosts.update", "hosts.delete", "hosts.clearHostKey",
            "identities.list", "identities.get", "identities.create", "identities.update", "identities.delete",
            "groups.list", "groups.get", "groups.create", "groups.update", "groups.delete",
            "workspace.load", "workspace.save", "workspace.listTemplates", "workspace.createTemplate", "workspace.deleteTemplate",
            "terminalProfiles.list", "terminalProfiles.getDefault", "terminalProfiles.create", "terminalProfiles.setDefault", "terminalProfiles.delete",
            "sessions.openShell", "sessions.reconnect", "sessions.write", "sessions.resize", "sessions.hostKeyDecision", "sessions.credential", "sessions.close",
            "files.list", "files.createDirectory", "files.rename", "files.remove", "files.createTransfer", "files.listTransfers", "files.getTransfer", "files.upload", "files.download", "files.pauseTransfer", "files.cancelTransfer", "files.retryTransfer",
            "commands.start", "commands.get", "commands.cancel",
            "snippets.list", "snippets.get", "snippets.create", "snippets.update", "snippets.delete",
            "activity.list",
            "imports.previewExternalImport", "imports.applyExternalImport", "imports.exportOpenSshConfig", "imports.exportCsv", "imports.exportVaultBundle", "imports.previewVaultImport", "imports.applyVaultImport"
        )
    }

    interface Executor {
        fun invoke(request: JSObject, complete: (JSObject) -> Unit)
    }

    private var executor: Executor? = null

    fun attachExecutor(next: Executor) {
        executor = next
    }

    @PluginMethod
    fun invoke(call: PluginCall) {
        val request = call.data
        if (request.getInteger("version") != BRIDGE_VERSION ||
            request.getString("requestId").isNullOrBlank() ||
            request.getString("operation").isNullOrBlank() ||
            request.toString().toByteArray(Charsets.UTF_8).size > MAX_FRAME_BYTES
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
        activeExecutor.invoke(request) { response -> call.resolve(response) }
    }

    fun emitNativeEvent(event: JSObject) {
        notifyListeners("event", JSObject().put("event", event))
    }

    private fun operationAllowlisted(operation: String): Boolean = operation in ALLOWED_OPERATIONS
}
