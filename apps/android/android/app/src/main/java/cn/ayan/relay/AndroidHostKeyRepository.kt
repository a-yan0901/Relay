package cn.ayan.relay

import android.util.Base64
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.UserInfo
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

internal data class AndroidHostKeyChallenge(
    val algorithm: String,
    val fingerprint: String,
    val address: String,
    val port: Int,
    val hostId: String,
    val reason: String,
    val previousAlgorithm: String?,
    val previousFingerprint: String?
)

internal class AndroidHostKeyRepository(
    private val host: AndroidHost,
    private val store: AndroidLocalStore,
    private val allowPrompt: Boolean,
    private val onStatus: (String) -> Unit,
    private val onChallenge: (AndroidHostKeyChallenge) -> Unit
) : HostKeyRepository {
    companion object {
        private const val PROMPT_TIMEOUT_SECONDS = 120L
    }

    private data class Pending(
        val challenge: AndroidHostKeyChallenge,
        val decision: CountDownLatch = CountDownLatch(1),
        @Volatile var accepted: Boolean = false
    )

    private val pending = AtomicReference<Pending?>(null)
    @Volatile
    private var failureCode: String? = null
    @Volatile
    private var lastChallenge: AndroidHostKeyChallenge? = null

    fun failureCode(): String? = failureCode

    fun challenge(): AndroidHostKeyChallenge? = lastChallenge

    fun decide(fingerprint: String, trust: Boolean): Boolean {
        val current = pending.get() ?: return false
        if (current.challenge.fingerprint != fingerprint) return false
        current.accepted = trust
        current.decision.countDown()
        return true
    }

    fun pendingFingerprint(): String? = pending.get()?.challenge?.fingerprint

    fun cancelPending() {
        pending.getAndSet(null)?.let { current ->
            current.accepted = false
            current.decision.countDown()
        }
    }

    override fun check(hostname: String, key: ByteArray): Int {
        val parsed = try {
            HostKey(hostname, key)
        } catch (_: Exception) {
            failureCode = "HOST_KEY_MISMATCH"
            return HostKeyRepository.CHANGED
        }
        val algorithm = parsed.type
        val fingerprint = sha256Fingerprint(key)
        val knownAlgorithm = host.hostKeyAlgorithm
        val knownFingerprint = host.hostKeyFingerprint
        if (!knownAlgorithm.isNullOrEmpty() && !knownFingerprint.isNullOrEmpty() && knownAlgorithm == algorithm && knownFingerprint == fingerprint) {
            lastChallenge = null
            return HostKeyRepository.OK
        }

        val reason = if (knownAlgorithm.isNullOrEmpty() || knownFingerprint.isNullOrEmpty()) "first-seen" else "changed"
        if (!allowPrompt) {
            failureCode = if (reason == "changed") "HOST_KEY_MISMATCH" else "HOST_KEY_REQUIRED"
            return HostKeyRepository.CHANGED
        }

        val challenge = AndroidHostKeyChallenge(
            algorithm = algorithm,
            fingerprint = fingerprint,
            address = host.address,
            port = host.port,
            hostId = host.id,
            reason = reason,
            previousAlgorithm = knownAlgorithm,
            previousFingerprint = knownFingerprint
        )
        lastChallenge = challenge
        val next = Pending(challenge)
        pending.getAndSet(next)?.let { previous ->
            previous.accepted = false
            previous.decision.countDown()
        }
        failureCode = if (reason == "changed") "HOST_KEY_MISMATCH" else "HOST_KEY_REQUIRED"
        onStatus("awaiting-host-key")
        onChallenge(challenge)

        val accepted = try {
            next.decision.await(PROMPT_TIMEOUT_SECONDS, TimeUnit.SECONDS) && next.accepted
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        } finally {
            pending.compareAndSet(next, null)
        }
        if (!accepted) return HostKeyRepository.CHANGED

        if (!store.updateHostKey(host.id, algorithm, fingerprint)) {
            failureCode = "HOST_KEY_MISMATCH"
            return HostKeyRepository.CHANGED
        }
        failureCode = null
        lastChallenge = null
        return HostKeyRepository.OK
    }

    override fun add(hostkey: HostKey, ui: UserInfo?) {
        // Trust is persisted explicitly above after the renderer decision.
    }

    override fun remove(hostname: String?, type: String?) {
        // Host Key removal is an explicit hosts.clearHostKey operation.
    }

    override fun remove(hostname: String?, type: String?, key: ByteArray?) {
        // JSch may call this for an interactive replacement. Never remove a
        // trusted key implicitly during a connection.
    }

    override fun getKnownHostsRepositoryID(): String = "relay-local-host-keys"

    override fun getHostKey(): Array<HostKey> = emptyArray()

    override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()

    private fun sha256Fingerprint(key: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(key)
        return "SHA256:${Base64.encodeToString(digest, Base64.NO_WRAP or Base64.NO_PADDING)}"
    }
}
