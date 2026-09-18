package cn.ayan.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidEventQueueTest {
    @Test
    fun controlEventsReplaceQueuedOutputWhenTheBoundIsReached() {
        val queue = AndroidEventQueue<String>(2) { it == "output" }

        assertTrue(queue.offer("output"))
        assertTrue(queue.offer("output"))
        assertTrue(queue.offer("status"))

        assertEquals("output", queue.poll())
        assertEquals("status", queue.poll())
        assertFalse(queue.isNotEmpty())
    }

    @Test
    fun outputIsDroppedWhenOnlyControlEventsArePending() {
        val queue = AndroidEventQueue<String>(2) { it == "output" }

        assertTrue(queue.offer("status"))
        assertTrue(queue.offer("close"))
        assertFalse(queue.offer("output"))

        assertEquals("status", queue.poll())
        assertEquals("close", queue.poll())
    }

    @Test
    fun latestControlEventWinsWhenTheQueueContainsOnlyControlEvents() {
        val queue = AndroidEventQueue<String>(2) { false }

        assertTrue(queue.offer("status-1"))
        assertTrue(queue.offer("status-2"))
        assertTrue(queue.offer("status-3"))

        assertEquals("status-2", queue.poll())
        assertEquals("status-3", queue.poll())
    }
}
