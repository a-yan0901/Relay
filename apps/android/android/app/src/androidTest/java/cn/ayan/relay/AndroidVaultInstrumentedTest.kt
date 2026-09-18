package cn.ayan.relay

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore

@RunWith(AndroidJUnit4::class)
class AndroidVaultInstrumentedTest {
    @Test
    fun setupUnlockAndSecretRoundTripUseDeviceKeystore() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.deleteDatabase("relay-local.db")
        KeyStore.getInstance("AndroidKeyStore").apply {
            load(null)
            if (containsAlias("relay.vault.root.v1")) deleteEntry("relay.vault.root.v1")
        }

        val vault = AndroidVault(AndroidLocalStore(context))
        assertEquals("uninitialized", vault.phase())

        vault.setup("relay-device-test-2026")
        assertEquals("unlocked", vault.phase())
        val ciphertext = vault.encryptSecret("device-secret", "instrumentation:aad")
        assertEquals("device-secret", vault.decryptSecret(ciphertext, "instrumentation:aad"))

        vault.lock()
        assertEquals("locked", vault.phase())
        assertThrows(NativeVaultFailure::class.java) { vault.requireKey() }

        vault.unlock("relay-device-test-2026")
        assertEquals("unlocked", vault.phase())
        assertEquals("device-secret", vault.decryptSecret(ciphertext, "instrumentation:aad"))
    }
}
