package cn.ayan.relay

import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidBuiltinTerminalProfilesTest {
    @Test
    fun exposesEverySharedBuiltinTheme() {
        assertEquals(
            listOf(
                "builtin:termius",
                "builtin:termius-light",
                "builtin:everforest-dark",
                "builtin:tokyo-day",
                "builtin:monokai"
            ),
            AndroidBuiltinTerminalProfiles.ids()
        )
    }

    @Test
    fun rejectsUnknownThemeIds() {
        assertEquals(null, AndroidBuiltinTerminalProfiles.json("builtin:missing"))
    }
}
