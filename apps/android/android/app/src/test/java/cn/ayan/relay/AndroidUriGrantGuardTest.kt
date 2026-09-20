package cn.ayan.relay

import android.app.Activity
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
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

    @Test
    fun preservesAUriFromACancelledActivityResultForCleanup() {
        assertTrue(shouldRevokeActivityUriGrant(Activity.RESULT_CANCELED, hasUri = true))
        assertFalse(shouldRevokeActivityUriGrant(Activity.RESULT_OK, hasUri = true))
        assertFalse(shouldRevokeActivityUriGrant(Activity.RESULT_CANCELED, hasUri = false))
    }

    @Test
    fun usesTheFallbackModeWhenTheProviderOmitsGrantFlags() {
        assertEquals(
            android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            grantFlagsFromActivityResult(0, android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        )
    }
}
