package cn.ayan.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidWorkspaceCodecTest {
    @Test
    fun validatesTheSharedWorkspaceShape() {
        val state = AndroidWorkspaceCodec.validate(
            AndroidWorkspaceState(
                version = 0,
                tabs = listOf(AndroidWorkspaceTab("tab-1", "host-1", "生产")),
                activeTabId = "tab-1",
                layoutMode = "vertical",
                layoutRatio = 0.6,
                paneTabIds = listOf("tab-1"),
                query = "prod",
                groupId = null,
                favoriteOnly = false
            )
        )

        assertEquals("tab-1", state.activeTabId)
        assertEquals("vertical", state.layoutMode)
        assertEquals(1, state.tabs.size)
    }

    @Test
    fun rejectsDuplicateTabsInvalidActiveTabAndSensitiveState() {
        val duplicateTabs = AndroidWorkspaceState(
            version = 0,
            tabs = listOf(AndroidWorkspaceTab("tab-1", "host-1", null), AndroidWorkspaceTab("tab-1", "host-2", null)),
            activeTabId = "tab-1",
            layoutMode = "single",
            layoutRatio = 0.5,
            paneTabIds = null,
            query = "",
            groupId = null,
            favoriteOnly = false
        )
        assertThrows(NativeVaultFailure::class.java) { AndroidWorkspaceCodec.validate(duplicateTabs) }
        assertThrows(NativeVaultFailure::class.java) {
            AndroidWorkspaceCodec.validate(duplicateTabs.copy(tabs = emptyList(), activeTabId = "missing"))
        }
        assertThrows(NativeVaultFailure::class.java) {
            AndroidWorkspaceCodec.validate(duplicateTabs.copy(tabs = emptyList(), query = "secret\u0000"))
        }
    }

    @Test
    fun keepsStateAndTemplateNamesBounded() {
        val oversizedQuery = "x".repeat(AndroidWorkspaceCodec.MAX_STATE_BYTES)
        assertThrows(NativeVaultFailure::class.java) {
            AndroidWorkspaceCodec.validate(AndroidWorkspaceState(
                version = 0,
                tabs = emptyList(),
                activeTabId = null,
                layoutMode = "single",
                layoutRatio = 0.5,
                paneTabIds = null,
                query = oversizedQuery,
                groupId = null,
                favoriteOnly = false
            ))
        }
        assertEquals("Mobile", AndroidWorkspaceCodec.templateName("Mobile"))
        assertThrows(NativeVaultFailure::class.java) { AndroidWorkspaceCodec.templateName("") }
    }
}
