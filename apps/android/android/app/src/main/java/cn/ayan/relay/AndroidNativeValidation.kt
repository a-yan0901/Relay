package cn.ayan.relay

/**
 * Validation shared by every Android native operation. The WebView is not a
 * trust boundary, so paths, IDs, dimensions and binary chunks are checked
 * again before they reach SQLite, SSH or the Android filesystem.
 */
object AndroidNativeValidation {
    const val MAX_CHUNK_BYTES = 32 * 1024
    private const val MAX_PATH_LENGTH = 4096
    private val SAFE_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

    fun requireSafeId(value: String?): String {
        require(value != null && SAFE_ID.matches(value)) { "invalid native identifier" }
        return value
    }

    fun requireDimensions(cols: Int, rows: Int) {
        require(cols in 1..1000 && rows in 1..500) { "invalid terminal dimensions" }
    }

    fun requireChunkSize(bytes: ByteArray) {
        require(bytes.size <= MAX_CHUNK_BYTES) { "native chunk too large" }
    }

    fun requireFileName(value: String?): String {
        require(value != null && value.isNotEmpty() && value.length <= 255) { "invalid file name" }
        require(!value.contains('/') && !value.contains('\\') && value.none { it.code <= 0x1f || it.code == 0x7f }) { "invalid file name" }
        return value
    }

    fun requireMimeType(value: String?): String {
        require(value != null && value.isNotEmpty() && value.length <= 128 && value.contains('/')) { "invalid mime type" }
        require(value.none { it.code <= 0x1f || it.code == 0x7f }) { "invalid mime type" }
        return value
    }

    fun resolveHostPath(targetId: String?, jumpIdsByHost: Map<String, List<String>>): List<String> {
        val target = requireSafeId(targetId)
        val chain = ArrayList<String>(5)
        val active = HashSet<String>()

        fun visit(hostId: String) {
            requireSafeId(hostId)
            require(jumpIdsByHost.containsKey(hostId)) { "jump host not found" }
            require(active.add(hostId)) { "jump host cycle" }
            require(chain.size < 5) { "jump host path too long" }
            jumpIdsByHost[hostId].orEmpty().forEach(::visit)
            active.remove(hostId)
            chain += hostId
        }

        visit(target)
        return chain
    }

    fun normalizeRemotePath(input: String?): String {
        require(input != null && input.isNotEmpty() && input.length <= MAX_PATH_LENGTH) { "invalid remote path" }
        require(!input.contains('\\') && input.none { it.code <= 0x1f || it.code == 0x7f }) { "invalid remote path" }

        val absolute = input.startsWith('/')
        val segments = ArrayDeque<String>()
        input.split('/').forEach { segment ->
            when {
                segment.isEmpty() || segment == "." -> Unit
                segment == ".." -> {
                    require(segments.isNotEmpty()) { "remote path escapes root" }
                    segments.removeLast()
                }
                else -> segments.addLast(segment)
            }
        }
        val normalized = segments.joinToString("/")
        return when {
            absolute && normalized.isEmpty() -> "/"
            absolute -> "/$normalized"
            normalized.isEmpty() -> "."
            else -> normalized
        }
    }
}
