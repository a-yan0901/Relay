package cn.ayan.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidAutomationValidationTest {
    @Test
    fun dispatchesSessionCloseOffTheMainThread() {
        assertEquals(AndroidOperationExecutor.OPERATION, androidOperationExecutor("sessions.close"))
        assertEquals(AndroidOperationExecutor.CONNECTION, androidOperationExecutor("sessions.openShell"))
        assertEquals(AndroidOperationExecutor.DIRECT, androidOperationExecutor("sessions.hostKeyDecision"))
    }

    @Test
    fun validatesSnippetVariablesAndNormalizesTags() {
        val snippet = AndroidAutomationValidation.validateSnippet(
            "Deploy",
            "safe",
            listOf(" prod ", "prod", "ops"),
            "echo {{host}} {{host}}",
            listOf("host")
        )
        assertEquals(listOf("prod", "ops"), snippet.tags)
        assertEquals(listOf("host"), snippet.variables)
    }

    @Test
    fun rejectsUndeclaredOrMalformedVariables() {
        assertThrows(NativeVaultFailure::class.java) {
            AndroidAutomationValidation.validateVariables("echo {{host}}", emptyList())
        }
        assertThrows(NativeVaultFailure::class.java) {
            AndroidAutomationValidation.validateVariables("echo {{bad-name}}", listOf("bad-name"))
        }
        assertThrows(NativeVaultFailure::class.java) {
            AndroidAutomationValidation.validateVariables("echo {{host}", listOf("host"))
        }
    }

    @Test
    fun expandsOnlyDeclaredBoundedValues() {
        assertEquals("echo relay", AndroidAutomationValidation.expandCommand("echo {{host}}", mapOf("host" to "relay"), listOf("host")))
        assertThrows(NativeVaultFailure::class.java) {
            AndroidAutomationValidation.expandCommand("echo {{host}}", mapOf("other" to "relay"), listOf("host"))
        }
    }
}
