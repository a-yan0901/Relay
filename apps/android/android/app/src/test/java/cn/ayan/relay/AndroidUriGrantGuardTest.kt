package cn.ayan.relay

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidUriGrantGuardTest {
    @Test
    fun releasesTheActivityGrantWhenSelectionProcessingFails() {
        var released = false

        releaseUriGrantIfOperationFailed(false) { released = true }

        assertTrue(released)
    }

    @Test
    fun keepsTheActivityGrantForAStoredSuccessfulSelection() {
        var released = false

        releaseUriGrantIfOperationFailed(true) { released = true }

        assertFalse(released)
    }
}
