package cn.ayan.relay

import java.nio.charset.StandardCharsets
import org.json.JSONArray
import org.json.JSONObject

internal data class AndroidWorkspaceTab(
    val id: String,
    val hostId: String,
    val title: String?
)

internal data class AndroidWorkspaceState(
    val version: Int,
    val tabs: List<AndroidWorkspaceTab>,
    val activeTabId: String?,
    val layoutMode: String,
    val layoutRatio: Double,
    val paneTabIds: List<String>?,
    val query: String,
    val groupId: String?,
    val favoriteOnly: Boolean
)

/**
 * Bounded native validation for the durable workspace shape. The WebView is
 * not trusted to enforce the shared schema, and keeping this codec small avoids
 * bringing a second JSON/schema library into the Android APK.
 */
internal data class AndroidWorkspaceTemplate(
    val id: String,
    val name: String,
    val stateJson: String,
    val createdAt: String,
    val updatedAt: String
)

internal object AndroidWorkspaceCodec {
    const val MAX_STATE_BYTES = 32 * 1024
    const val MAX_TEMPLATES = 64
    private const val MAX_TABS = 64
    private const val MAX_ID_LENGTH = 128
    private const val MAX_TITLE_LENGTH = 120
    private const val MAX_QUERY_LENGTH = 255
    private val TAB_KEYS = setOf("id", "hostId", "title")
    private val LAYOUT_KEYS = setOf("mode", "ratio", "paneTabIds")
    private val FILTER_KEYS = setOf("query", "groupId", "favoriteOnly")
    private val STATE_KEYS = setOf("version", "tabs", "activeTabId", "layout", "filters")
    private val MODES = setOf("single", "vertical", "horizontal", "grid")

    fun defaultState(): JSONObject = toJson(AndroidWorkspaceState(
        version = 0,
        tabs = emptyList(),
        activeTabId = null,
        layoutMode = "single",
        layoutRatio = 0.5,
        paneTabIds = null,
        query = "",
        groupId = null,
        favoriteOnly = false
    ))

    fun parseStored(value: String): JSONObject = try {
        parse(JSONObject(value))
    } catch (error: NativeVaultFailure) {
        throw error
    } catch (_: Exception) {
        fail()
    }

    fun parse(value: JSONObject): JSONObject {
        assertKeys(value, STATE_KEYS)
        val layout = value.optJSONObject("layout") ?: fail()
        val layoutSettings = parseLayout(layout)
        val filters = value.optJSONObject("filters") ?: fail()
        val state = AndroidWorkspaceState(
            version = integer(value, "version", 0, 1_000_000_000),
            tabs = parseTabs(value.optJSONArray("tabs") ?: fail()),
            activeTabId = nullableIdentifier(value, "activeTabId", required = true),
            layoutMode = layoutSettings.first,
            layoutRatio = layoutSettings.second,
            paneTabIds = parsePaneTabIds(layout),
            query = parseQuery(filters),
            groupId = nullableIdentifier(filters, "groupId", required = true),
            favoriteOnly = parseFavoriteOnly(filters)
        )
        return toJson(validate(state))
    }

    fun validate(state: AndroidWorkspaceState): AndroidWorkspaceState {
        if (state.version !in 0..1_000_000_000 || state.tabs.size > MAX_TABS) fail()
        val tabIds = HashSet<String>(state.tabs.size)
        state.tabs.forEach { tab ->
            identifier(tab.id)
            identifier(tab.hostId)
            if (!tabIds.add(tab.id)) fail()
            if (tab.title != null && (tab.title.length > MAX_TITLE_LENGTH || hasControlCharacter(tab.title))) fail()
        }
        if (state.activeTabId != null && (!tabIds.contains(state.activeTabId) || !isIdentifier(state.activeTabId))) fail()
        if (state.layoutMode !in MODES || !state.layoutRatio.isFinite() || state.layoutRatio !in 0.2..0.8) fail()
        state.paneTabIds?.let { paneTabIds ->
            if (paneTabIds.size > MAX_TABS) fail()
            paneTabIds.forEach(::identifier)
        }
        if (state.query.length > MAX_QUERY_LENGTH || hasControlCharacter(state.query)) fail()
        if (state.groupId != null) identifier(state.groupId)
        return state
    }

    fun templateName(value: String): String {
        if (value.isEmpty() || value.length > MAX_TITLE_LENGTH || hasControlCharacter(value)) fail()
        return value
    }

    fun ensureSize(state: JSONObject) {
        if (state.toString().toByteArray(StandardCharsets.UTF_8).size > MAX_STATE_BYTES) fail()
    }

    private fun parseTabs(value: JSONArray): List<AndroidWorkspaceTab> {
        if (value.length() > MAX_TABS) fail()
        val result = ArrayList<AndroidWorkspaceTab>(value.length())
        for (index in 0 until value.length()) {
            val tab = value.optJSONObject(index) ?: fail()
            assertKeys(tab, TAB_KEYS)
            val title = if (tab.has("title")) {
                val raw = tab.opt("title")
                if (raw !is String) fail()
                raw
            } else null
            result += AndroidWorkspaceTab(identifier(tab, "id"), identifier(tab, "hostId"), title)
        }
        return result
    }

    private fun parseLayout(value: JSONObject): Pair<String, Double> {
        assertKeys(value, LAYOUT_KEYS)
        val mode = value.opt("mode") as? String ?: fail()
        val ratio = value.opt("ratio") as? Number ?: fail()
        return mode to ratio.toDouble()
    }

    private fun parsePaneTabIds(value: JSONObject): List<String>? {
        if (!value.has("paneTabIds")) return null
        val paneTabIds = value.optJSONArray("paneTabIds") ?: fail()
        if (paneTabIds.length() > MAX_TABS) fail()
        return List(paneTabIds.length()) { index -> identifier(paneTabIds, index) }
    }

    private fun parseQuery(value: JSONObject): String {
        assertKeys(value, FILTER_KEYS)
        val query = value.opt("query") as? String ?: fail()
        if (query.length > MAX_QUERY_LENGTH || hasControlCharacter(query)) fail()
        return query
    }

    private fun parseFavoriteOnly(value: JSONObject): Boolean {
        assertKeys(value, FILTER_KEYS)
        return value.opt("favoriteOnly") as? Boolean ?: fail()
    }

    private fun toJson(state: AndroidWorkspaceState): JSONObject {
        val validated = validate(state)
        val tabs = JSONArray()
        validated.tabs.forEach { tab ->
            val value = JSONObject().put("id", tab.id).put("hostId", tab.hostId)
            if (tab.title != null) value.put("title", tab.title)
            tabs.put(value)
        }
        val layout = JSONObject()
            .put("mode", validated.layoutMode)
            .put("ratio", validated.layoutRatio)
        validated.paneTabIds?.let { ids -> layout.put("paneTabIds", JSONArray(ids)) }
        val result = JSONObject()
            .put("version", validated.version)
            .put("tabs", tabs)
            .put("activeTabId", validated.activeTabId ?: JSONObject.NULL)
            .put("layout", layout)
            .put("filters", JSONObject()
                .put("query", validated.query)
                .put("groupId", validated.groupId ?: JSONObject.NULL)
                .put("favoriteOnly", validated.favoriteOnly))
        ensureSize(result)
        return result
    }

    private fun assertKeys(value: JSONObject, allowed: Set<String>) {
        val keys = value.keys()
        while (keys.hasNext()) if (keys.next() !in allowed) fail()
    }

    private fun identifier(value: JSONObject, key: String): String {
        val raw = value.opt(key) as? String ?: fail()
        return identifier(raw)
    }

    private fun identifier(value: JSONArray, index: Int): String {
        val raw = value.opt(index) as? String ?: fail()
        return identifier(raw)
    }

    private fun identifier(value: String): String {
        if (!isIdentifier(value)) fail()
        return value
    }

    private fun isIdentifier(value: String): Boolean {
        if (value.isEmpty() || value.length > MAX_ID_LENGTH || hasControlCharacter(value)) return false
        return try {
            AndroidNativeValidation.requireSafeId(value)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun nullableIdentifier(value: JSONObject, key: String, required: Boolean): String? {
        if (!value.has(key)) {
            if (required) fail()
            return null
        }
        if (value.isNull(key)) return null
        return identifier(value, key)
    }

    private fun integer(value: JSONObject, key: String, minimum: Int, maximum: Int): Int {
        val number = value.opt(key) as? Number ?: fail()
        val result = number.toLong()
        if (number.toDouble() != result.toDouble() || result !in minimum..maximum) fail()
        return result.toInt()
    }

    private fun hasControlCharacter(value: String): Boolean = value.any { it.code <= 0x1f || it.code == 0x7f }

    private fun fail(): Nothing = throw NativeVaultFailure("WORKSPACE_INVALID")
}
