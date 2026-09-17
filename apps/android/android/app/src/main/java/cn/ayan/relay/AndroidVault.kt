package cn.ayan.relay

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec
import javax.crypto.SecretKeyFactory

internal class AndroidVault(private val store: AndroidLocalStore) {
    companion object {
        private const val SALT_KEY = "vault.salt.v1"
        private const val VERIFIER_KEY = "vault.verifier.v1"
        private const val WRAPPED_KEY_KEY = "vault.wrapped-key.v1"
        private const val KEY_ALIAS = "relay.vault.root.v1"
        private const val PBKDF2_ITERATIONS = 120_000
        private const val KEY_BYTES = 32
        private const val GCM_TAG_BITS = 128
        private const val NONCE_BYTES = 12
        private val random = SecureRandom()
    }

    @Volatile
    private var unlockedKey: ByteArray? = null

    fun phase(): String = when {
        store.getMeta(SALT_KEY) == null -> "uninitialized"
        unlockedKey != null -> "unlocked"
        else -> "locked"
    }

    @Synchronized
    fun setup(masterPassword: String) {
        validatePassword(masterPassword)
        if (store.getMeta(SALT_KEY) != null) fail("SETUP_ALREADY_COMPLETE")
        val salt = randomBytes(16)
        val derived = derive(masterPassword, salt)
        val vaultKey = randomBytes(KEY_BYTES)
        try {
            store.putMeta(SALT_KEY, encode(salt))
            store.putMeta(VERIFIER_KEY, encode(sha256(derived)))
            store.putMeta(WRAPPED_KEY_KEY, keystoreEncrypt(passwordWrap(derived, vaultKey.copyOf())))
            unlockedKey = vaultKey
        } finally {
            derived.fill(0)
            salt.fill(0)
        }
    }

    @Synchronized
    fun unlock(masterPassword: String) {
        validatePassword(masterPassword)
        val salt = decodeRequired(store.getMeta(SALT_KEY))
        val expectedVerifier = decodeRequired(store.getMeta(VERIFIER_KEY))
        val wrapped = store.getMeta(WRAPPED_KEY_KEY) ?: fail("VAULT_CONFIG_INVALID")
        val derived = derive(masterPassword, salt)
        try {
            if (!MessageDigest.isEqual(expectedVerifier, sha256(derived))) fail("VAULT_UNLOCK_FAILED")
            val vaultKey = passwordUnwrap(derived, keystoreDecrypt(wrapped))
            if (vaultKey.size != KEY_BYTES) fail("VAULT_CONFIG_INVALID")
            unlockedKey?.fill(0)
            unlockedKey = vaultKey
        } catch (error: NativeVaultFailure) {
            throw error
        } catch (_: Exception) {
            fail("VAULT_UNLOCK_FAILED")
        } finally {
            salt.fill(0)
            expectedVerifier.fill(0)
            derived.fill(0)
        }
    }

    @Synchronized
    fun lock() {
        unlockedKey?.fill(0)
        unlockedKey = null
    }

    fun requireKey(): ByteArray = unlockedKey?.copyOf() ?: fail("VAULT_LOCKED")

    fun encryptSecret(value: String, aad: String): String {
        val key = requireKey()
        try {
            return aesEncrypt(key, value.toByteArray(StandardCharsets.UTF_8), aad.toByteArray(StandardCharsets.UTF_8))
        } finally {
            key.fill(0)
        }
    }

    fun decryptSecret(value: String, aad: String): String {
        val key = requireKey()
        try {
            return String(aesDecrypt(key, value, aad.toByteArray(StandardCharsets.UTF_8)), StandardCharsets.UTF_8)
        } finally {
            key.fill(0)
        }
    }

    fun close() = lock()

    private fun passwordWrap(derived: ByteArray, vaultKey: ByteArray): String = aesEncrypt(derived, vaultKey, "relay-vault-key:v1".toByteArray(StandardCharsets.UTF_8))

    private fun passwordUnwrap(derived: ByteArray, wrapped: String): ByteArray = aesDecrypt(derived, wrapped, "relay-vault-key:v1".toByteArray(StandardCharsets.UTF_8))

    private fun derive(password: String, salt: ByteArray): ByteArray {
        val chars = password.toCharArray()
        return try {
            val spec = PBEKeySpec(chars, salt, PBKDF2_ITERATIONS, KEY_BYTES * 8)
            try {
                SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
            } finally {
                spec.clearPassword()
            }
        } finally {
            chars.fill('\u0000')
        }
    }

    private fun keystoreKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun keystoreEncrypt(value: String): String = aesEncrypt(keystoreKey(), value.toByteArray(StandardCharsets.UTF_8), "relay-keystore:v1".toByteArray(StandardCharsets.UTF_8))

    private fun keystoreDecrypt(value: String): String = String(aesDecrypt(keystoreKey(), value, "relay-keystore:v1".toByteArray(StandardCharsets.UTF_8)), StandardCharsets.UTF_8)

    private fun aesEncrypt(key: ByteArray, plaintext: ByteArray, aad: ByteArray): String = aesEncrypt(SecretKeySpec(key, "AES"), plaintext, aad)

    private fun aesEncrypt(key: SecretKey, plaintext: ByteArray, aad: ByteArray): String {
        val nonce = randomBytes(NONCE_BYTES)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, nonce))
            cipher.updateAAD(aad)
            val ciphertext = cipher.doFinal(plaintext)
            "${encode(nonce)}.${encode(ciphertext)}"
        } finally {
            nonce.fill(0)
            plaintext.fill(0)
        }
    }

    private fun aesDecrypt(key: ByteArray, value: String, aad: ByteArray): ByteArray = aesDecrypt(SecretKeySpec(key, "AES"), value, aad)

    private fun aesDecrypt(key: SecretKey, value: String, aad: ByteArray): ByteArray {
        val parts = value.split('.', limit = 2)
        if (parts.size != 2) fail("VAULT_CONFIG_INVALID")
        val nonce = decodeRequired(parts[0])
        val ciphertext = decodeRequired(parts[1])
        try {
            if (nonce.size != NONCE_BYTES) fail("VAULT_CONFIG_INVALID")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, nonce))
            cipher.updateAAD(aad)
            return cipher.doFinal(ciphertext)
        } catch (error: NativeVaultFailure) {
            throw error
        } catch (_: Exception) {
            fail("VAULT_UNLOCK_FAILED")
        } finally {
            nonce.fill(0)
            ciphertext.fill(0)
        }
    }

    private fun validatePassword(value: String) {
        if (value.length < 8 || value.length > 4096) fail("MASTER_PASSWORD_INVALID")
    }

    private fun randomBytes(size: Int): ByteArray = ByteArray(size).also(random::nextBytes)

    private fun sha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)

    private fun encode(value: ByteArray): String = Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun decodeRequired(value: String?): ByteArray {
        if (value.isNullOrEmpty() || value.length > 64 * 1024) fail("VAULT_CONFIG_INVALID")
        return try {
            Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        } catch (_: IllegalArgumentException) {
            fail("VAULT_CONFIG_INVALID")
        }
    }
}

internal class NativeVaultFailure(val code: String) : RuntimeException(code)

private fun fail(code: String): Nothing = throw NativeVaultFailure(code)
