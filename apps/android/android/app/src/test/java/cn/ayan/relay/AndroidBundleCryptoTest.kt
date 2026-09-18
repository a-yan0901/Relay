package cn.ayan.relay

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class AndroidBundleCryptoTest {
    @Test
    fun derivesTheCanonicalArgon2idKey() {
        val salt = "00112233445566778899aabbccddeeff".hexBytes()
        val key = AndroidBundleCrypto.deriveExportKey("bundle-password", salt)

        assertEquals(
            "a7d950983ce174dcdf2835a329b283140892034a50c3b3b7c1e5e89d0cd311c5",
            key.toHex()
        )
        key.fill(0)
    }

    @Test
    fun encryptsAndDecryptsWithCanonicalAad() {
        val key = ByteArray(32) { it.toByte() }
        val plaintext = "portable bundle".toByteArray()
        val encrypted = AndroidBundleCrypto.encrypt(key, "webssh-vault:payload:v1", plaintext.copyOf())

        assertNotEquals("webssh-vault:payload:v1", encrypted.aad)
        val decrypted = AndroidBundleCrypto.decrypt(key, "webssh-vault:payload:v1", encrypted)
        assertArrayEquals(plaintext, decrypted)
        decrypted.fill(0)
        key.fill(0)
    }

    @Test
    fun serializesAndDecryptsTheV1Envelope() {
        val payload = "{\"hosts\":[]}".toByteArray()
        val serialized = AndroidBundleCrypto.createEnvelope("bundle-password", payload.copyOf())
        val restored = AndroidBundleCrypto.decryptEnvelope("bundle-password", StringBuilder(serialized))

        assertArrayEquals(payload, restored)
        restored.fill(0)
    }

    @Test
    fun decryptsTheNodeV1EnvelopeVector() {
        val serialized = """
            {"format":"webssh-vault","version":1,"kdf":{"algorithm":"argon2id","memoryCost":19456,"timeCost":2,"parallelism":1,"hashLength":32,"salt":"ABEiM0RVZneImaq7zN3u/w=="},"wrappedBundleKey":{"version":1,"nonce":"EBESExQVFhcYGRob","ciphertext":"mj/EMDca0Z/mo9GiZBhvc1GScIexkc6EKfBAJwILmgI=","authTag":"HRioZJTCD/54gDO0WNWXbA==","aad":"d2Vic3NoLXZhdWx0OmJ1bmRsZS1rZXk6djE="},"payload":{"version":1,"nonce":"ICEiIyQlJicoKSor","ciphertext":"qRjBAgPtan04RhmT7TqclqM9n7692z6T","authTag":"oqG7+QqmfoXIrc6pjUqvgQ==","aad":"d2Vic3NoLXZhdWx0OnBheWxvYWQ6djE="}}
        """.trimIndent()
        val restored = AndroidBundleCrypto.decryptEnvelope("bundle-password", serialized)

        assertArrayEquals("{\"groups\":[],\"hosts\":[]}".toByteArray(), restored)
        restored.fill(0)
    }

    @Test
    fun rejectsWrongPasswordAndTamperedAad() {
        val payload = "{\"groups\":[]}".toByteArray()
        val serialized = AndroidBundleCrypto.createEnvelope("bundle-password", payload.copyOf())

        try {
            AndroidBundleCrypto.decryptEnvelope("wrong-password", serialized)
            throw AssertionError("wrong password must fail")
        } catch (error: NativeVaultFailure) {
            assertEquals("VAULT_BUNDLE_INVALID", error.code)
        }

        val key = ByteArray(32) { 7 }
        val encrypted = AndroidBundleCrypto.encrypt(key, "aad:v1", payload.copyOf())
        try {
            AndroidBundleCrypto.decrypt(key, "aad:changed", encrypted)
            throw AssertionError("changed aad must fail")
        } catch (error: NativeVaultFailure) {
            assertEquals("VAULT_BUNDLE_INVALID", error.code)
        } finally {
            key.fill(0)
        }
    }

    private fun String.hexBytes(): ByteArray = ByteArray(length / 2) { index ->
        substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }

    private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
