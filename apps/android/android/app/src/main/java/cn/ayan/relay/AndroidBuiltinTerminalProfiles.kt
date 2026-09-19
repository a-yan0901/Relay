package cn.ayan.relay

import org.json.JSONObject

/**
 * Built-in terminal profiles shared by the WebView and Android native bridge.
 *
 * Keep these IDs, names and appearance fields aligned with
 * src/shared/terminal-appearance.ts. Returning a fresh JSONObject prevents
 * callers from mutating the canonical definitions kept in this object.
 */
internal object AndroidBuiltinTerminalProfiles {
    private data class Palette(
        val foreground: String,
        val background: String,
        val cursor: String,
        val black: String,
        val red: String,
        val green: String,
        val yellow: String,
        val blue: String,
        val magenta: String,
        val cyan: String,
        val white: String,
        val brightBlack: String,
        val brightRed: String,
        val brightGreen: String,
        val brightYellow: String,
        val brightBlue: String,
        val brightMagenta: String,
        val brightCyan: String,
        val brightWhite: String
    )

    private data class Definition(
        val name: String,
        val palette: Palette
    )

    private const val EPOCH = "1970-01-01T00:00:00.000Z"
    private const val FONT_FAMILY = "\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace"

    private val definitions = linkedMapOf(
        "builtin:termius" to Definition(
            "Termius Dark",
            Palette(
                foreground = "#5cc97c",
                background = "#141728",
                cursor = "#92a0a7",
                black = "#141728",
                red = "#e05b57",
                green = "#5cc97c",
                yellow = "#e7ebed",
                blue = "#225388",
                magenta = "#ee7b79",
                cyan = "#478fef",
                white = "#d6dde0",
                brightBlack = "#333649",
                brightRed = "#e16866",
                brightGreen = "#5cc97c",
                brightYellow = "#ffffff",
                brightBlue = "#346baf",
                brightMagenta = "#ee7b79",
                brightCyan = "#5d9fef",
                brightWhite = "#ffffff"
            )
        ),
        "builtin:termius-light" to Definition(
            "Termius Light",
            Palette(
                foreground = "#333649",
                background = "#d6dde0",
                cursor = "#92a0a7",
                black = "#141728",
                red = "#c24c48",
                green = "#57b26f",
                yellow = "#346baf",
                blue = "#1c4774",
                magenta = "#e16866",
                cyan = "#3166a6",
                white = "#a7b2b9",
                brightBlack = "#333649",
                brightRed = "#e05b57",
                brightGreen = "#57b26f",
                brightYellow = "#346baf",
                brightBlue = "#1c4774",
                brightMagenta = "#e16866",
                brightCyan = "#346baf",
                brightWhite = "#f8f9fa"
            )
        ),
        "builtin:everforest-dark" to Definition(
            "Everforest Dark",
            Palette(
                foreground = "#d3c6aa",
                background = "#2d353b",
                cursor = "#d3c6aa",
                black = "#475258",
                red = "#e67e80",
                green = "#a7c080",
                yellow = "#dbbc7f",
                blue = "#7fbbb3",
                magenta = "#d699b6",
                cyan = "#83c092",
                white = "#d3c6aa",
                brightBlack = "#859289",
                brightRed = "#e69875",
                brightGreen = "#a7c080",
                brightYellow = "#dbbc7f",
                brightBlue = "#7fbbb3",
                brightMagenta = "#d699b6",
                brightCyan = "#83c092",
                brightWhite = "#d3c6aa"
            )
        ),
        "builtin:tokyo-day" to Definition(
            "Tokyo Day",
            Palette(
                foreground = "#3760bf",
                background = "#e1e2e7",
                cursor = "#3760bf",
                black = "#0f0f14",
                red = "#8c4351",
                green = "#33635c",
                yellow = "#8f5e15",
                blue = "#34548a",
                magenta = "#5a4a78",
                cyan = "#0f4b6e",
                white = "#828594",
                brightBlack = "#4c505e",
                brightRed = "#a33c43",
                brightGreen = "#485e30",
                brightYellow = "#8f5e15",
                brightBlue = "#34548a",
                brightMagenta = "#5a4a78",
                brightCyan = "#0f4b6e",
                brightWhite = "#4c505e"
            )
        ),
        "builtin:monokai" to Definition(
            "Monokai",
            Palette(
                foreground = "#f8f8f2",
                background = "#272822",
                cursor = "#f8f8f0",
                black = "#272822",
                red = "#f92672",
                green = "#a6e22e",
                yellow = "#f4bf75",
                blue = "#66d9ef",
                magenta = "#ae81ff",
                cyan = "#a1efe4",
                white = "#f8f8f2",
                brightBlack = "#75715e",
                brightRed = "#f92672",
                brightGreen = "#a6e22e",
                brightYellow = "#f4bf75",
                brightBlue = "#66d9ef",
                brightMagenta = "#ae81ff",
                brightCyan = "#a1efe4",
                brightWhite = "#f9f8f5"
            )
        )
    )

    fun ids(): List<String> = definitions.keys.toList()

    fun json(id: String): JSONObject? {
        val definition = definitions[id] ?: return null
        val palette = definition.palette
        val appearance = JSONObject()
            .put("foreground", palette.foreground)
            .put("background", palette.background)
            .put("cursor", palette.cursor)
            .put("cursorAccent", palette.background)
            .put("selectionBackground", palette.blue)
            .put("selectionForeground", palette.brightWhite)
            .put("black", palette.black)
            .put("red", palette.red)
            .put("green", palette.green)
            .put("yellow", palette.yellow)
            .put("blue", palette.blue)
            .put("magenta", palette.magenta)
            .put("cyan", palette.cyan)
            .put("white", palette.white)
            .put("brightBlack", palette.brightBlack)
            .put("brightRed", palette.brightRed)
            .put("brightGreen", palette.brightGreen)
            .put("brightYellow", palette.brightYellow)
            .put("brightBlue", palette.brightBlue)
            .put("brightMagenta", palette.brightMagenta)
            .put("brightCyan", palette.brightCyan)
            .put("brightWhite", palette.brightWhite)
            .put("fontFamily", FONT_FAMILY)
            .put("fontSize", 13)
            .put("lineHeight", 1.25)
            .put("cursorStyle", "bar")
            .put("cursorBlink", true)
            .put("scrollback", 5_000)
        return JSONObject()
            .put("id", id)
            .put("name", definition.name)
            .put("createdAt", EPOCH)
            .put("updatedAt", EPOCH)
            .put("appearance", appearance)
    }
}
