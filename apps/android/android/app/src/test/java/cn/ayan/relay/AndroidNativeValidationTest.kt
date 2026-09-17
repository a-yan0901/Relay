package cn.ayan.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidNativeValidationTest {
    @Test
    fun normalizesRemotePathsWithoutEscapingRoot() {
        assertEquals("/", AndroidNativeValidation.normalizeRemotePath("/"))
        assertEquals("/var/log", AndroidNativeValidation.normalizeRemotePath("/var/./tmp/../log"))
        assertEquals("relative/file", AndroidNativeValidation.normalizeRemotePath("relative/./file"))
        assertThrows(IllegalArgumentException::class.java) {
            AndroidNativeValidation.normalizeRemotePath("../../etc")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AndroidNativeValidation.normalizeRemotePath("/var\\log")
        }
    }

    @Test
    fun validatesIdentifiersAndDimensions() {
        assertEquals("session-1", AndroidNativeValidation.requireSafeId("session-1"))
        assertThrows(IllegalArgumentException::class.java) {
            AndroidNativeValidation.requireSafeId("../session")
        }
        AndroidNativeValidation.requireDimensions(120, 36)
        assertThrows(IllegalArgumentException::class.java) {
            AndroidNativeValidation.requireDimensions(0, 36)
        }
    }

    @Test
    fun keepsNativeChunksBounded() {
        AndroidNativeValidation.requireChunkSize(ByteArray(32 * 1024))
        assertThrows(IllegalArgumentException::class.java) {
            AndroidNativeValidation.requireChunkSize(ByteArray(32 * 1024 + 1))
        }
    }

    @Test
    fun validatesSystemFileSaveMetadata() {
        assertEquals("report.csv", AndroidNativeValidation.requireFileName("report.csv"))
        assertEquals("text/csv", AndroidNativeValidation.requireMimeType("text/csv"))
        assertThrows(IllegalArgumentException::class.java) {
            AndroidNativeValidation.requireFileName("../report.csv")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AndroidNativeValidation.requireMimeType("text")
        }
    }

    @Test
    fun resolvesJumpHostsInConnectionOrderAndRejectsCycles() {
        val path = AndroidNativeValidation.resolveHostPath(
            "target",
            mapOf("jump-2" to listOf("jump-1"), "jump-1" to emptyList(), "target" to listOf("jump-2"))
        )
        assertEquals(listOf("jump-1", "jump-2", "target"), path)
        assertThrows(IllegalArgumentException::class.java) {
            AndroidNativeValidation.resolveHostPath("target", mapOf("target" to listOf("target")))
        }
    }
}
