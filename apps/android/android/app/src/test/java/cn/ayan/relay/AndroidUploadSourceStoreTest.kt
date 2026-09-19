package cn.ayan.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidUploadSourceStoreTest {
    @Test
    fun storesOpaqueSourceMetadataAndReleasesItOnce() {
        val store = AndroidUploadSourceStore(now = { 1_000L })

        val source = store.put("content://picker/1", "large.bin", 32L * 1024L * 1024L)

        assertEquals("large.bin", source.name)
        assertEquals(32L * 1024L * 1024L, source.size)
        assertEquals("content://picker/1", store.take(source.sourceId)?.uri)
        assertNull(store.take(source.sourceId))
        assertEquals(0, store.size())
    }

    @Test
    fun retainsTheExactGrantModeAndPersistableStateForLaterRelease() {
        val store = AndroidUploadSourceStore(now = { 1_000L })

        val source = store.put("content://picker/3", "grant.bin", 4L, grantFlags = 1, persistable = true)

        assertEquals(1, source.grantFlags)
        assertTrue(source.persistable)
    }

    @Test
    fun expiresStaleUrisAndClearsAllHandles() {
        var now = 1_000L
        val store = AndroidUploadSourceStore(now = { now }, ttlMs = 100L)
        val source = store.put("content://picker/2", "stale.bin", 12L)

        now += 101L

        assertNull(store.take(source.sourceId))
        assertTrue(store.isEmpty())
    }
}
