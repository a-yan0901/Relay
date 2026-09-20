package cn.ayan.relay

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidShareCacheTest {
    @Test
    fun keeps_recent_share_files_until_the_receiver_can_read_them() {
        val now = 10_000L

        assertFalse(shouldDeleteShareCache(now - RELAY_SHARE_CACHE_TTL_MS + 1, now))
        assertTrue(shouldDeleteShareCache(now - RELAY_SHARE_CACHE_TTL_MS, now))
        assertTrue(shouldDeleteShareCache(now - RELAY_SHARE_CACHE_TTL_MS - 1, now))
    }
}
