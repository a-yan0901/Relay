package cn.ayan.relay

import java.util.ArrayDeque

/**
 * Small, synchronized, lossy queue for renderer events.
 *
 * Output/progress events may be dropped under pressure. Control events are
 * retained by evicting the oldest droppable item first; if a queue contains
 * only control events, the oldest control event is evicted so the newest
 * state can still reach the renderer. The queue never grows beyond capacity.
 */
internal class AndroidEventQueue<T>(
    private val capacity: Int,
    private val isDroppable: (T) -> Boolean
) {
    private val values = ArrayDeque<T>(capacity)

    init {
        require(capacity > 0)
    }

    @Synchronized
    fun offer(value: T): Boolean {
        if (values.size < capacity) {
            values.addLast(value)
            return true
        }
        if (isDroppable(value)) return false

        val iterator = values.iterator()
        var removedDroppable = false
        while (iterator.hasNext()) {
            if (isDroppable(iterator.next())) {
                iterator.remove()
                removedDroppable = true
                break
            }
        }
        if (!removedDroppable) values.removeFirst()
        values.addLast(value)
        return true
    }

    @Synchronized
    fun poll(): T? = if (values.isEmpty()) null else values.removeFirst()

    @Synchronized
    fun isNotEmpty(): Boolean = values.isNotEmpty()

    @Synchronized
    fun clear(): Unit = values.clear()
}
