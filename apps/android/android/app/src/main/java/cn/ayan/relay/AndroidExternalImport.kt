package cn.ayan.relay

import java.util.Locale

/**
 * Small, allocation-bounded import parser for the Android bridge. It mirrors
 * the shared SSH/CSV, OpenSSH, MobaXterm, Xshell and SecureCRT semantics needed
 * by the local client without pulling the Web parser or a large XML dependency
 * into the APK.
 */
internal object AndroidExternalImportParser {
    private const val MAX_CONNECTIONS = 64
    private const val MAX_WARNINGS = 64
    private const val MAX_LINE_LENGTH = 8 * 1024
    private val privateKeyHeader = Regex("^\\s*-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----", RegexOption.MULTILINE)

    internal data class Credential(
        val type: String,
        val secret: String,
        val passphrase: String? = null,
        val identityFile: String? = null
    )

    internal data class Connection(
        val sourceId: String,
        val name: String,
        val address: String,
        val port: Int,
        val username: String,
        val authType: String,
        val credentialState: String,
        val credential: Credential?,
        val credentialSource: String?,
        val identityFile: String?,
        val groupPath: List<String>,
        val tags: List<String>,
        val jumpHostSourceIds: List<String>,
        val notes: List<String>,
        val sourceFields: Map<String, String>
    )

    internal data class Document(
        val format: String,
        val filename: String,
        val connections: List<Connection>,
        val groups: List<List<String>>,
        val warnings: List<String>
    )

    fun parseCsv(content: String, filename: String): Document {
        val rows = parseCsvRows(content.removePrefix("\uFEFF"))
        if (rows.isEmpty()) return Document("ssh-csv", filename, emptyList(), emptyList(), listOf("CSV 没有表头"))
        val headers = rows.first().map(::normalizeHeader)
        val warnings = ArrayList<String>()
        val connections = ArrayList<Connection>(minOf(MAX_CONNECTIONS, rows.size - 1))
        rows.drop(1).forEachIndexed { rowIndex, values ->
            if (connections.size >= MAX_CONNECTIONS) return@forEachIndexed
            val record = headers.indices.associate { index -> headers[index] to (values.getOrNull(index) ?: "") }
            val sessionType = findValue(record, SESSION_TYPE_ALIASES)
            if (sessionType.isNotEmpty() && !Regex("(?:ssh|sftp)", RegexOption.IGNORE_CASE).containsMatchIn(sessionType)) {
                addWarning(warnings, "$filename:row ${rowIndex + 2} 协议 $sessionType 不是 SSH/SFTP，已跳过")
                return@forEachIndexed
            }
            val name = findValue(record, NAME_ALIASES)
            val address = findValue(record, ADDRESS_ALIASES)
            val username = findValue(record, USERNAME_ALIASES)
            val password = findValue(record, PASSWORD_ALIASES)
            val privateKeyValue = findValue(record, PRIVATE_KEY_ALIASES)
            val passphrase = findValue(record, PASSPHRASE_ALIASES).takeIf { it.isNotEmpty() }
            val privateKey = privateKeyValue.takeIf { privateKeyHeader.containsMatchIn(it) }?.trim()
            val identityFile = findValue(record, IDENTITY_FILE_ALIASES).ifEmpty {
                privateKey?.let { "" } ?: privateKeyValue
            }.takeIf { it.isNotEmpty() }
            val authType = when {
                privateKey != null || identityFile != null -> "private_key"
                password.isNotEmpty() -> "password"
                else -> "unknown"
            }
            val credential = when {
                privateKey != null -> Credential("private_key", privateKey, passphrase, identityFile)
                password.isNotEmpty() -> Credential("password", password)
                else -> null
            }
            val credentialState = when {
                credential != null -> "ready"
                identityFile != null -> "reference-only"
                else -> "needs-user-input"
            }
            val groupPath = normalizePath(findValue(record, GROUP_ALIASES))
            val tags = normalizeTags(findValue(record, TAG_ALIASES))
            val notes = ArrayList<String>()
            if (address.isEmpty()) {
                notes += "缺少主机地址"
                addWarning(warnings, "$filename:row ${rowIndex + 2} 缺少主机地址")
            }
            if (username.isEmpty()) notes += "缺少用户名"
            connections += Connection(
                sourceId = "csv:${rowIndex + 1}",
                name = name.ifEmpty { address.ifEmpty { "CSV row ${rowIndex + 2}" } },
                address = address,
                port = parsePort(findValue(record, PORT_ALIASES)),
                username = username,
                authType = authType,
                credentialState = credentialState,
                credential = credential,
                credentialSource = identityFile,
                identityFile = identityFile,
                groupPath = groupPath,
                tags = tags,
                jumpHostSourceIds = splitReferences(findValue(record, JUMP_ALIASES)).map { "csv:$it" },
                notes = notes,
                sourceFields = mapOf(
                    "name" to (name.ifEmpty { address }),
                    "host" to address,
                    "port" to parsePort(findValue(record, PORT_ALIASES)).toString(),
                    "user" to username
                ).filterValues { it.isNotEmpty() }
            )
        }
        if (rows.size - 1 > MAX_CONNECTIONS) addWarning(warnings, "$filename 超过 Android 导入上限，已截断")
        return document("ssh-csv", filename, connections, warnings)
    }

    fun parseMobaXterm(content: String, filename: String): Document {
        val sections = parseIniSections(content)
        val warnings = ArrayList<String>()
        val connections = ArrayList<Connection>()
        var bookmarkIndex = 0
        sections.forEach { section ->
            if (!Regex("^Bookmarks(?:_\\d+)?$", RegexOption.IGNORE_CASE).matches(section.name)) return@forEach
            val groupPath = normalizePath(section.values["SubRep"].orEmpty())
            section.values.forEach { (name, encoded) ->
                if (name == "SubRep" || name == "ImgNum" || connections.size >= MAX_CONNECTIONS) return@forEach
                val fields = parseMobaSession(encoded)
                if (fields == null) {
                    addWarning(warnings, "$filename:$name 会话编码无效")
                    return@forEach
                }
                val sessionType = fields["sessionType"].orEmpty()
                if (sessionType !in setOf("0", "7")) {
                    addWarning(warnings, "$filename:$name 不是 SSH/SFTP 会话，已跳过")
                    return@forEach
                }
                val address = fields["remoteHost"].orEmpty().trim()
                val username = fields["username"].orEmpty().trim()
                if (address.isEmpty() || username.isEmpty()) {
                    addWarning(warnings, "$filename:$name 缺少远程主机或用户名，已跳过")
                    return@forEach
                }
                val identityFile = fields["privateKeyPath"].orEmpty().trim().takeIf { it.isNotEmpty() }
                val gatewayHosts = splitReferences(fields["gatewayHost"].orEmpty())
                val gatewayPorts = splitReferences(fields["gatewayPort"].orEmpty())
                val gatewayUsers = splitReferences(fields["gatewayUser"].orEmpty())
                val notes = ArrayList<String>()
                if (fields["localProxyCommand"].orEmpty().isNotEmpty()) notes += "MobaXterm 本地代理命令未转换"
                connections += Connection(
                    sourceId = "mobaxterm:$bookmarkIndex:$name",
                    name = name,
                    address = address,
                    port = parsePort(fields["port"]),
                    username = username,
                    authType = if (identityFile == null) "unknown" else "private_key",
                    credentialState = if (identityFile == null) "needs-user-input" else "reference-only",
                    credential = null,
                    credentialSource = identityFile,
                    identityFile = identityFile,
                    groupPath = groupPath,
                    tags = emptyList(),
                    jumpHostSourceIds = gatewayHosts.mapIndexed { index, host ->
                        "mobaxterm:gateway:$host:${parsePort(gatewayPorts.getOrNull(index))}:${gatewayUsers.getOrNull(index).orEmpty()}"
                    },
                    notes = notes,
                    sourceFields = mapOf(
                        "SessionType" to sessionType,
                        "Host" to address,
                        "Port" to parsePort(fields["port"]).toString(),
                        "Username" to username
                    ).let { base -> if (identityFile == null) base else base + ("IdentityFile" to identityFile) }
                )
                bookmarkIndex += 1
            }
        }
        if (connections.size >= MAX_CONNECTIONS) addWarning(warnings, "$filename 超过 Android 导入上限，已截断")
        if (connections.isEmpty() && (filename.endsWith(".mobaconf", true) || Regex("mobaconf|encrypted", RegexOption.IGNORE_CASE).containsMatchIn(content))) {
            addWarning(warnings, "$filename 可能是受保护的 MobaXterm 配置，无法在没有源密码时读取")
        }
        return document("mobaxterm", filename, connections, warnings)
    }

    fun parseXshell(content: String, filename: String): Document {
        val values = parseKeyValues(content)
        val warnings = ArrayList<String>()
        val protocol = firstValue(values, listOf("Protocol")).lowercase(Locale.ROOT)
        if (protocol.isNotEmpty() && !protocol.contains("ssh")) {
            addWarning(warnings, "$filename 的协议 $protocol 不是 SSH，已跳过")
            return document("xshell", filename, emptyList(), warnings)
        }
        val address = firstValue(values, listOf("Host", "Hostname", "Address"))
        val username = firstValue(values, listOf("UserName", "Username", "User"))
        val identityFile = firstValue(values, listOf("UserKey", "IdentityFile", "PrivateKey")).takeIf { it.isNotEmpty() }
        val protectedPassword = firstValue(values, listOf("Password", "PasswordV2", "EncryptedPassword")).isNotEmpty()
        val proxyHostValue = firstValue(values, listOf("ProxyServer", "JumpHost", "Firewall"))
        val proxyHost = proxyHostValue.takeIf { it.isNotEmpty() && !Regex("^(?:none|no|disabled)$", RegexOption.IGNORE_CASE).matches(it) }
        val proxyPort = parsePort(firstValue(values, listOf("ProxyPort", "JumpPort", "FirewallPort")))
        val proxyUser = firstValue(values, listOf("ProxyUsername", "JumpUser", "FirewallUsername"))
        val authType = if (identityFile != null) "private_key" else if (protectedPassword || protocol.contains("ssh")) "password" else "unknown"
        val notes = ArrayList<String>()
        if (protectedPassword) notes += "Xshell 密码受保护，未尝试解密"
        if (address.isEmpty()) notes += "缺少远程主机"
        val connection = Connection(
            sourceId = "xshell:${fileStem(filename)}",
            name = firstValue(values, listOf("SessionName", "Name")).ifEmpty { fileStem(filename) },
            address = address,
            port = parsePort(firstValue(values, listOf("Port"))),
            username = username,
            authType = authType,
            credentialState = when {
                identityFile != null -> "reference-only"
                protectedPassword -> "needs-source-passphrase"
                else -> "needs-user-input"
            },
            credential = null,
            credentialSource = identityFile,
            identityFile = identityFile,
            groupPath = normalizePath(firstValue(values, listOf("Directory", "Folder", "Group"))),
            tags = emptyList(),
            jumpHostSourceIds = if (proxyHost != null) {
                listOf("xshell:gateway:$proxyHost:$proxyPort:$proxyUser")
            } else {
                splitReferences(firstValue(values, listOf("JumpHosts"))).map { "xshell:$it" }
            },
            notes = notes,
            sourceFields = values.filterKeys { key -> !Regex("password|secret|credential", RegexOption.IGNORE_CASE).containsMatchIn(key) }
        )
        return document("xshell", filename, listOf(connection), warnings)
    }

    fun parseSecureCrt(content: String, filename: String): Document {
        val xml = filename.endsWith(".xml", true) || content.trimStart().startsWith("<")
        val records = if (xml) parseXmlRecords(content) else listOf(parseSecureIni(content))
        val warnings = ArrayList<String>()
        val connections = ArrayList<Connection>()
        records.forEachIndexed { index, record ->
            val protocol = firstValue(record, listOf("Protocol Name", "Protocol", "Protocol Type"))
            if (protocol.isNotEmpty() && !Regex("(?:ssh|sftp)", RegexOption.IGNORE_CASE).containsMatchIn(protocol)) {
                addWarning(warnings, "$filename:${index + 1} 的协议 $protocol 不是 SSH/SFTP，已跳过")
                return@forEachIndexed
            }
            val address = firstValue(record, listOf("Hostname", "Host", "Address"))
            if (address.isEmpty()) {
                addWarning(warnings, "$filename:${index + 1} 未找到 SecureCRT 主机字段")
                return@forEachIndexed
            }
            val identityFile = firstValue(record, listOf("IdentityFile", "Identity File", "PublicKeyFile", "PublicKey", "KeyFile")).takeIf { it.isNotEmpty() }
            val protectedPassword = firstValue(record, listOf("Password", "PasswordV2", "Password V2", "EncryptedPassword")).isNotEmpty()
            val firewallValue = firstValue(record, listOf("Firewall", "Firewall Name", "JumpHost", "ProxyServer", "Proxy Server"))
            val firewall = firewallValue.takeIf { it.isNotEmpty() && !Regex("^(?:none|no|disabled)$", RegexOption.IGNORE_CASE).matches(it) }
            val firewallPort = parsePort(firstValue(record, listOf("FirewallPort", "Firewall Port", "JumpPort", "ProxyPort")))
            val firewallUser = firstValue(record, listOf("FirewallUsername", "Firewall Username", "JumpUser", "ProxyUsername", "Proxy Username"))
            val sessionName = firstValue(record, listOf("SessionName", "Name")).ifEmpty { fileStem(filename) }
            val sessionPath = normalizePath(sessionName)
            val name = sessionPath.lastOrNull() ?: sessionName
            val authType = if (identityFile != null) "private_key" else if (protectedPassword) "password" else "unknown"
            val notes = ArrayList<String>()
            if (protectedPassword) notes += "SecureCRT 密码受保护，未尝试解密"
            connections += Connection(
                sourceId = "securecrt:${fileStem(filename)}:$index",
                name = name,
                address = address,
                port = parseSecurePort(firstValue(record, listOf("Port", "Port Number", "SSH2 Port"))),
                username = firstValue(record, listOf("Username", "User")),
                authType = authType,
                credentialState = when {
                    identityFile != null -> "reference-only"
                    protectedPassword -> "needs-source-passphrase"
                    else -> "needs-user-input"
                },
                credential = null,
                credentialSource = identityFile,
                identityFile = identityFile,
                groupPath = if (sessionPath.size > 1) sessionPath.dropLast(1) else normalizePath(firstValue(record, listOf("Folder", "Group"))),
                tags = emptyList(),
                jumpHostSourceIds = if (firewall != null) listOf("securecrt:gateway:$firewall:$firewallPort:$firewallUser") else emptyList(),
                notes = notes,
                sourceFields = record.filterKeys { key -> !Regex("password|secret|credential", RegexOption.IGNORE_CASE).containsMatchIn(key) }
            )
        }
        return document("securecrt", filename, connections, warnings)
    }

    fun parseOpenSsh(content: String, filename: String): Document {
        val global = LinkedHashMap<String, String>()
        val blocks = ArrayList<Block>()
        var current: Block? = null
        val warnings = ArrayList<String>()
        content.split(Regex("\\r?\\n")).forEachIndexed { lineIndex, original ->
            if (original.length > MAX_LINE_LENGTH) {
                addWarning(warnings, "$filename:${lineIndex + 1} 配置行过长，已跳过")
                return@forEachIndexed
            }
            val line = stripComment(original).trim()
            if (line.isEmpty()) return@forEachIndexed
            val separator = line.indexOfFirst { it == '=' || it.isWhitespace() }
            if (separator <= 0) {
                addWarning(warnings, "$filename:${lineIndex + 1} 无法解析配置行")
                return@forEachIndexed
            }
            val key = line.substring(0, separator).lowercase(Locale.ROOT)
            val value = line.substring(separator).replace(Regex("^\\s*(?:=\\s*)?"), "").trim()
            if (key == "host") {
                current = Block(tokenize(value), LinkedHashMap())
                blocks += current!!
            } else if (current != null) {
                current!!.values[key] = value
            } else {
                global[key] = value
            }
        }
        val connections = ArrayList<Connection>()
        blocks.filter { block -> block.patterns.any { !hasWildcard(it) } }.forEach { block ->
            block.patterns.filterNot(::hasWildcard).forEach { alias ->
                if (connections.size >= MAX_CONNECTIONS) return@forEach
                val values = LinkedHashMap<String, String>().apply {
                    putAll(global)
                    blocks.filter { it.patterns.any(::hasWildcard) }.forEach { putAll(it.values) }
                    putAll(block.values)
                }
                val address = values["hostname"]?.replace("%h", alias) ?: alias
                val identityFile = values["identityfile"]?.takeIf { it.isNotEmpty() }
                val proxyJump = values["proxyjump"].orEmpty()
                val notes = ArrayList<String>()
                if (values["proxycommand"] != null) notes += "ProxyCommand 未转换为跳板机"
                if (address.contains('%')) notes += "HostName 包含未解析的 OpenSSH token"
                connections += Connection(
                    sourceId = "openssh:$alias",
                    name = alias,
                    address = address,
                    port = parsePort(values["port"]),
                    username = values["user"].orEmpty(),
                    authType = if (identityFile == null) "unknown" else "private_key",
                    credentialState = if (identityFile == null) "needs-user-input" else "reference-only",
                    credential = null,
                    credentialSource = identityFile,
                    identityFile = identityFile,
                    groupPath = emptyList(),
                    tags = emptyList(),
                    jumpHostSourceIds = splitReferences(proxyJump).map { "openssh:$it" },
                    notes = notes,
                    sourceFields = mapOf("Host" to alias, "hostname" to address, "port" to parsePort(values["port"]).toString(), "user" to values["user"].orEmpty()).filterValues { it.isNotEmpty() }
                )
                if (values["proxycommand"] != null) addWarning(warnings, "$filename:$alias 使用了不支持的 ProxyCommand")
                if (address.contains('%')) addWarning(warnings, "$filename:$alias 的 HostName 包含未解析 token")
            }
        }
        if (connections.size >= MAX_CONNECTIONS) addWarning(warnings, "$filename 超过 Android 导入上限，已截断")
        return document("openssh-config", filename, connections, warnings)
    }

    private data class Block(val patterns: List<String>, val values: LinkedHashMap<String, String>)

    private data class IniSection(val name: String, val values: LinkedHashMap<String, String>)

    private val MOBA_FIELDS = listOf(
        "sessionType", "remoteHost", "port", "username", "empty1", "x11Forward", "compression", "command",
        "gatewayHost", "gatewayPort", "gatewayUser", "noExit", "useUsername", "remoteEnv", "privateKeyPath",
        "gatewayPrivateKeyPath", "sshBrowserType", "followSshPath", "empty2", "proxyType", "proxyHost", "proxyPort",
        "proxyLogin", "adaptRemoteLocals", "fileBrowser", "fileBrowserProtocol", "localProxyCommand", "sshVersion",
        "keyExchangeAlgorithm", "hostKeyTypes", "ciphers", "disconnectNoAuth", "preferredHostKeyAlgorithm",
        "useSshAgentAuth", "allowAgentForwarding"
    )

    private fun document(format: String, filename: String, connections: List<Connection>, warnings: List<String>): Document {
        val groups = connections.map { it.groupPath }.filter { it.isNotEmpty() }.distinctBy { it.joinToString("\u001f") }
        return Document(format, filename, connections, groups, warnings)
    }

    private fun parseCsvRows(content: String): List<List<String>> {
        val rows = ArrayList<List<String>>()
        val row = ArrayList<String>()
        val value = StringBuilder()
        var quoted = false
        var index = 0
        while (index < content.length) {
            val character = content[index]
            if (quoted) {
                if (character == '"' && index + 1 < content.length && content[index + 1] == '"') {
                    value.append('"')
                    index += 1
                } else if (character == '"') {
                    quoted = false
                } else value.append(character)
            } else if (character == '"' && value.isEmpty()) {
                quoted = true
            } else if (character == ',') {
                row += value.toString()
                value.setLength(0)
            } else if (character == '\n') {
                row += value.toString().removeSuffix("\r")
                if (row.any { it.isNotEmpty() }) rows += row.toList()
                row.clear()
                value.setLength(0)
            } else value.append(character)
            index += 1
        }
        if (value.isNotEmpty() || row.isNotEmpty()) {
            row += value.toString().removeSuffix("\r")
            if (row.any { it.isNotEmpty() }) rows += row.toList()
        }
        return rows
    }

    private fun normalizeHeader(value: String): String = value.trim().replace(Regex("([a-z0-9])([A-Z])"), "$1 $2").replace(Regex("[^a-zA-Z0-9]+"), "").lowercase(Locale.ROOT)

    private fun findValue(record: Map<String, String>, aliases: List<String>): String = aliases.firstNotNullOfOrNull { alias -> record[alias]?.trim()?.takeIf { it.isNotEmpty() } }.orEmpty()

    private fun parsePort(value: String?): Int = value?.trim()?.toIntOrNull()?.takeIf { it in 1..65_535 } ?: 22

    private fun normalizePath(value: String): List<String> = value.split(Regex("[\\\\/]")).map { it.trim() }.filter { it.isNotEmpty() }.take(16)

    private fun normalizeTags(value: String): List<String> = value.split(Regex("[;,]")).map { it.trim() }.filter { it.isNotEmpty() }.distinct().take(20)

    private fun splitReferences(value: String): List<String> = value.split(Regex("\\s*,\\s*|\\s*;\\s*")).map { it.trim() }.filter { it.isNotEmpty() && !it.equals("none", true) }.take(16)

    private fun stripComment(value: String): String {
        var quoted = false
        var escaped = false
        value.forEachIndexed { index, character ->
            if (escaped) {
                escaped = false
                return@forEachIndexed
            }
            if (character == '\\') {
                escaped = true
                return@forEachIndexed
            }
            if (character == '"') quoted = !quoted
            if (character == '#' && !quoted) return value.substring(0, index)
        }
        return value
    }

    private fun tokenize(value: String): List<String> = value.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.take(16)

    private fun parseIniSections(content: String): List<IniSection> {
        val sections = ArrayList<IniSection>()
        var current: IniSection? = null
        content.removePrefix("\uFEFF").split(Regex("\\r?\\n")).forEach { line ->
            val section = Regex("^\\s*\\[([^]]+)]\\s*$").find(line)
            if (section != null) {
                current = IniSection(section.groupValues[1], LinkedHashMap())
                sections += current!!
                return@forEach
            }
            val active = current ?: return@forEach
            val separator = line.indexOf('=')
            if (separator > 0) active.values[line.substring(0, separator).trim()] = line.substring(separator + 1).trim()
        }
        return sections
    }

    private fun parseMobaSession(value: String): Map<String, String>? {
        val groups = value.split('#')
        if (groups.size < 3) return null
        val fields = groups[2].split('%')
        if (fields.size < 4) return null
        return MOBA_FIELDS.mapIndexed { index, key -> key to (fields.getOrNull(index) ?: "") }.toMap()
    }

    private fun parseKeyValues(content: String): Map<String, String> {
        val values = LinkedHashMap<String, String>()
        content.removePrefix("\uFEFF").split(Regex("\\r?\\n")).forEach { line ->
            val separator = line.indexOf('=')
            if (separator <= 0) return@forEach
            values[normalizeHeader(line.substring(0, separator))] = line.substring(separator + 1).trim()
        }
        return values
    }

    private fun parseSecureIni(content: String): Map<String, String> {
        val values = LinkedHashMap<String, String>()
        content.removePrefix("\uFEFF").split(Regex("\\r?\\n")).forEach { line ->
            val separator = line.indexOf('=')
            if (separator <= 0) return@forEach
            val rawKey = line.substring(0, separator).trim()
            val key = Regex("\"([^\"]+)\"").find(rawKey)?.groupValues?.get(1)
                ?: rawKey.substringAfterLast(':').trim().trim('"')
            values[normalizeHeader(key)] = line.substring(separator + 1).trim().trim('"')
        }
        return values
    }

    private fun parseXmlRecords(content: String): List<Map<String, String>> {
        val sessionPattern = Regex("(?is)<session\\b[^>]*>.*?</session\\s*>")
        val blocks = sessionPattern.findAll(content).map { it.value }.toList().ifEmpty { listOf(content) }
        return blocks.map { block ->
            val values = LinkedHashMap<String, String>()
            Regex("(?is)<[^>]*?(?:name|key|property)\\s*=\\s*[\"']([^\"']+)[\"'][^>]*>(.*?)</[^>]+>").findAll(block).forEach { match ->
                values[normalizeHeader(match.groupValues[1])] = stripXml(match.groupValues[2])
            }
            Regex("(?is)<[^>]*?(?:name|key|property)\\s*=\\s*[\"']([^\"']+)[\"'][^>]*?(?:value)\\s*=\\s*[\"']([^\"']*)[\"'][^>]*/?>").findAll(block).forEach { match ->
                values[normalizeHeader(match.groupValues[1])] = match.groupValues[2].trim()
            }
            Regex("(?is)<(hostname|host|address|username|user|port|protocol|sessionname)\\s*>(.*?)</\\1\\s*>").findAll(block).forEach { match ->
                values[normalizeHeader(match.groupValues[1])] = stripXml(match.groupValues[2])
            }
            values
        }
    }

    private fun stripXml(value: String): String = value.replace(Regex("<[^>]+>"), "").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").trim()

    private fun firstValue(values: Map<String, String>, keys: List<String>): String = keys.firstNotNullOfOrNull { values[normalizeHeader(it)]?.trim()?.takeIf { value -> value.isNotEmpty() } }.orEmpty()

    private fun fileStem(filename: String): String = filename.substringAfterLast('/').substringAfterLast('\\').replace(Regex("\\.(?:xsh|ini|xml)$", RegexOption.IGNORE_CASE), "").ifEmpty { "SSH session" }

    private fun parseSecurePort(value: String): Int = if (Regex("^[0-9a-f]{8}$", RegexOption.IGNORE_CASE).matches(value)) parsePort(value.toLongOrNull(16)?.toString()) else parsePort(value)

    private fun hasWildcard(value: String): Boolean = value.any { it == '*' || it == '?' || it == '!' }

    private fun addWarning(warnings: MutableList<String>, value: String) {
        if (warnings.size < MAX_WARNINGS) warnings += value.take(512)
    }

    private val NAME_ALIASES = listOf("name", "label", "title", "session", "sessionname", "connection")
    private val ADDRESS_ALIASES = listOf("host", "address", "hostname", "hostnameip", "remotehost", "ip", "server")
    private val PORT_ALIASES = listOf("port", "sshport", "portnumber")
    private val USERNAME_ALIASES = listOf("user", "username", "login")
    private val PASSWORD_ALIASES = listOf("password", "pass")
    private val PASSPHRASE_ALIASES = listOf("passphrase", "keypassphrase")
    private val PRIVATE_KEY_ALIASES = listOf("privatekey", "key", "privatekeycontent", "keycontent")
    private val IDENTITY_FILE_ALIASES = listOf("identityfile", "identity", "keypath", "privatekeypath", "keyfile", "keyfilepath")
    private val GROUP_ALIASES = listOf("group", "groups", "folder", "folderpath", "foldername", "path")
    private val TAG_ALIASES = listOf("tags", "tag", "labels")
    private val JUMP_ALIASES = listOf("jumphost", "jumphosts", "jump", "proxyjump", "bastion", "gatewayhost")
    private val SESSION_TYPE_ALIASES = listOf("sessiontype", "protocol", "protocolname", "type")
}
