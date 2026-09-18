package cn.ayan.relay

import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.bouncycastle.util.encoders.Base64 as BcBase64

/**
 * Portable Vault bundle crypto. This is deliberately separate from the
 * device-local Vault: the bundle must match the Node/Web AES-GCM envelope and
 * Argon2id parameters, while the local Vault remains protected by Keystore.
 *
 * Methods which accept plaintext consume and clear the supplied byte array.
 * Callers should pass a copy when they still need their original buffer.
 */
internal data class AndroidEncryptedJson(
    val version: Int,
    val nonce: String,
    val ciphertext: String,
    val authTag: String,
    val aad: String
)

internal object AndroidBundleCrypto {
    const val FORMAT = "webssh-vault"
    const val VERSION = 1
    const val ARGON2_MEMORY_KIB = 19_456
    const val ARGON2_TIME_COST = 2
    const val ARGON2_PARALLELISM = 1
    const val ARGON2_HASH_LENGTH = 32
    const val SALT_BYTES = 16
    const val KEY_BYTES = 32
    const val NONCE_BYTES = 12
    const val TAG_BYTES = 16
    const val MAX_BUNDLE_BYTES = 8 * 1024 * 1024

    private const val PASSWORD_MIN_LENGTH = 8
    private const val PASSWORD_MAX_LENGTH = 4096
    private const val MAX_AAD_LENGTH = 1024
    private const val BUNDLE_WRAP_AAD = "webssh-vault:bundle-key:v1"
    private const val BUNDLE_PAYLOAD_AAD = "webssh-vault:payload:v1"
    private val random = SecureRandom()

    fun deriveExportKey(password: String, salt: ByteArray): ByteArray {
        if (password.length !in PASSWORD_MIN_LENGTH..PASSWORD_MAX_LENGTH || salt.size != SALT_BYTES) failBundle()
        val passwordBytes = password.toByteArray(StandardCharsets.UTF_8)
        val saltCopy = salt.copyOf()
        val parameters = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withMemoryAsKB(ARGON2_MEMORY_KIB)
            .withIterations(ARGON2_TIME_COST)
            .withParallelism(ARGON2_PARALLELISM)
            .withSalt(saltCopy)
            .build()
        val output = ByteArray(ARGON2_HASH_LENGTH)
        try {
            Argon2BytesGenerator().apply { init(parameters) }.generateBytes(passwordBytes, output)
            return output
        } catch (_: Exception) {
            output.fill(0)
            failBundle()
        } finally {
            passwordBytes.fill(0)
            saltCopy.fill(0)
            parameters.clear()
        }
    }

    fun encrypt(key: ByteArray, aad: String, plaintext: ByteArray): AndroidEncryptedJson {
        requireKey(key)
        val aadBytes = aadBytes(aad)
        val nonce = randomBytes(NONCE_BYTES)
        var combined: ByteArray? = null
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
            cipher.updateAAD(aadBytes)
            combined = cipher.doFinal(plaintext)
            if (combined.size < TAG_BYTES) failBundle()
            val ciphertext = combined.copyOfRange(0, combined.size - TAG_BYTES)
            val tag = combined.copyOfRange(combined.size - TAG_BYTES, combined.size)
            return AndroidEncryptedJson(
                version = VERSION,
                nonce = encode(nonce),
                ciphertext = encode(ciphertext),
                authTag = encode(tag),
                aad = encode(aadBytes)
            ).also {
                ciphertext.fill(0)
                tag.fill(0)
            }
        } catch (error: NativeVaultFailure) {
            throw error
        } catch (_: Exception) {
            failBundle()
        } finally {
            plaintext.fill(0)
            nonce.fill(0)
            aadBytes.fill(0)
            combined?.fill(0)
        }
    }

    fun decrypt(key: ByteArray, aad: String, encrypted: AndroidEncryptedJson): ByteArray {
        requireKey(key)
        if (encrypted.version != VERSION) failBundle()
        val aadBytes = aadBytes(aad)
        val expectedAad = encode(aadBytes)
        if (encrypted.aad != expectedAad) {
            aadBytes.fill(0)
            failBundle()
        }
        val nonce = decode(encrypted.nonce, NONCE_BYTES)
        val ciphertext = decode(encrypted.ciphertext, null)
        val tag = decode(encrypted.authTag, TAG_BYTES)
        val combined = ByteArray(ciphertext.size + tag.size)
        ciphertext.copyInto(combined)
        tag.copyInto(combined, ciphertext.size)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
            cipher.updateAAD(aadBytes)
            return cipher.doFinal(combined)
        } catch (_: Exception) {
            failBundle()
        } finally {
            aadBytes.fill(0)
            nonce.fill(0)
            ciphertext.fill(0)
            tag.fill(0)
            combined.fill(0)
        }
    }

    fun createEnvelope(exportPassword: String, payload: ByteArray): String {
        if (payload.size > MAX_BUNDLE_BYTES) failBundle()
        val salt = randomBytes(SALT_BYTES)
        val bundleKey = randomBytes(KEY_BYTES)
        var exportKey: ByteArray? = null
        try {
            exportKey = deriveExportKey(exportPassword, salt)
            val wrapped = encrypt(exportKey, BUNDLE_WRAP_AAD, bundleKey.copyOf())
            val encryptedPayload = encrypt(bundleKey, BUNDLE_PAYLOAD_AAD, payload.copyOf())
            val serialized = "{" +
                "\"format\":${quote(FORMAT)}," +
                "\"version\":$VERSION," +
                "\"kdf\":{" +
                    "\"algorithm\":${quote("argon2id")}," +
                    "\"memoryCost\":$ARGON2_MEMORY_KIB," +
                    "\"timeCost\":$ARGON2_TIME_COST," +
                    "\"parallelism\":$ARGON2_PARALLELISM," +
                    "\"hashLength\":$ARGON2_HASH_LENGTH," +
                    "\"salt\":${quote(encode(salt))}" +
                "}," +
                "\"wrappedBundleKey\":${encryptedJson(wrapped)}," +
                "\"payload\":${encryptedJson(encryptedPayload)}" +
            "}"
            if (serialized.toByteArray(StandardCharsets.UTF_8).size > MAX_BUNDLE_BYTES) failBundle()
            return serialized
        } finally {
            payload.fill(0)
            salt.fill(0)
            bundleKey.fill(0)
            exportKey?.fill(0)
        }
    }

    fun decryptEnvelope(exportPassword: String, serialized: CharSequence): ByteArray {
        if (utf8ByteLength(serialized) > MAX_BUNDLE_BYTES) failBundle()
        val root = try { BundleJsonParser(serialized).parse() } catch (error: NativeVaultFailure) {
            throw error
        } catch (_: Exception) {
            failBundle()
        }
        if (root.string("format") != FORMAT || root.integer("version") != VERSION) failBundle()
        val kdf = root.objectValue("kdf")
        if (kdf.string("algorithm") != "argon2id" ||
            kdf.integer("memoryCost") != ARGON2_MEMORY_KIB ||
            kdf.integer("timeCost") != ARGON2_TIME_COST ||
            kdf.integer("parallelism") != ARGON2_PARALLELISM ||
            kdf.integer("hashLength") != ARGON2_HASH_LENGTH
        ) failBundle()
        val salt = decode(kdf.string("salt"), SALT_BYTES)
        var exportKey: ByteArray? = null
        var bundleKey: ByteArray? = null
        try {
            exportKey = deriveExportKey(exportPassword, salt)
            bundleKey = decrypt(exportKey, BUNDLE_WRAP_AAD, parseEncrypted(root.objectValue("wrappedBundleKey")))
            if (bundleKey.size != KEY_BYTES) failBundle()
            return decrypt(bundleKey, BUNDLE_PAYLOAD_AAD, parseEncrypted(root.objectValue("payload")))
        } catch (error: NativeVaultFailure) {
            throw error
        } catch (_: Exception) {
            failBundle()
        } finally {
            salt.fill(0)
            exportKey?.fill(0)
            bundleKey?.fill(0)
        }
    }

    private fun parseEncrypted(value: BundleJsonObject): AndroidEncryptedJson {
        return AndroidEncryptedJson(
            version = value.integer("version"),
            nonce = value.string("nonce"),
            ciphertext = value.string("ciphertext"),
            authTag = value.string("authTag"),
            aad = value.string("aad")
        )
    }

    private fun encryptedJson(value: AndroidEncryptedJson): String = "{" +
        "\"version\":${value.version}," +
        "\"nonce\":${quote(value.nonce)}," +
        "\"ciphertext\":${quote(value.ciphertext)}," +
        "\"authTag\":${quote(value.authTag)}," +
        "\"aad\":${quote(value.aad)}" +
        "}"

    private fun quote(value: String): String = buildString(value.length + 2) {
        append('"')
        value.forEach { character ->
            when (character) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character.code < 0x20) append("\\u%04x".format(character.code)) else append(character)
            }
        }
        append('"')
    }

    private fun requireKey(key: ByteArray) {
        if (key.size != KEY_BYTES) failBundle()
    }

    private fun aadBytes(aad: String): ByteArray {
        if (aad.isEmpty() || aad.length > MAX_AAD_LENGTH) failBundle()
        return aad.toByteArray(StandardCharsets.UTF_8)
    }

    private fun randomBytes(size: Int): ByteArray = ByteArray(size).also(random::nextBytes)

    private fun encode(value: ByteArray): String = String(BcBase64.encode(value), StandardCharsets.US_ASCII)

    private fun decode(value: String, expectedLength: Int?): ByteArray {
        if (value.isEmpty() || value.length > MAX_BUNDLE_BYTES || !value.matches(Regex("^[A-Za-z0-9+/]*={0,2}$"))) failBundle()
        val decoded = try { BcBase64.decode(value) } catch (_: Exception) { failBundle() }
        if (expectedLength != null && decoded.size != expectedLength) failBundle()
        if (decoded.size > MAX_BUNDLE_BYTES) failBundle()
        return decoded
    }

    private fun utf8ByteLength(value: CharSequence): Int {
        var bytes = 0L
        var index = 0
        while (index < value.length) {
            val character = value[index]
            bytes += when {
                character.code <= 0x7f -> 1
                character.code <= 0x7ff -> 2
                Character.isHighSurrogate(character) && index + 1 < value.length && Character.isLowSurrogate(value[index + 1]) -> {
                    index += 1
                    4
                }
                else -> 3
            }
            if (bytes > MAX_BUNDLE_BYTES) return MAX_BUNDLE_BYTES + 1
            index += 1
        }
        return bytes.toInt()
    }
}

private fun failBundle(): Nothing = throw NativeVaultFailure("VAULT_BUNDLE_INVALID")

private data class BundleJsonObject(private val fields: Map<String, Any>) {
    fun string(key: String): String = fields[key] as? String ?: failBundle()
    fun integer(key: String): Int = (fields[key] as? BundleJsonNumber)?.value?.toIntOrNull() ?: failBundle()
    fun objectValue(key: String): BundleJsonObject = fields[key] as? BundleJsonObject ?: failBundle()
}

private data class BundleJsonNumber(val value: String)

/** Small bounded parser for the fixed envelope shape; payload JSON is parsed by the executor. */
private class BundleJsonParser(private val input: CharSequence) {
    private var position = 0

    fun parse(): BundleJsonObject {
        skipWhitespace()
        val value = parseObject()
        skipWhitespace()
        if (position != input.length) failBundle()
        return value
    }

    private fun parseObject(): BundleJsonObject {
        expect('{')
        skipWhitespace()
        val fields = LinkedHashMap<String, Any>()
        if (peek('}')) {
            position += 1
            return BundleJsonObject(fields)
        }
        while (true) {
            skipWhitespace()
            val key = parseString()
            if (fields.containsKey(key)) failBundle()
            skipWhitespace()
            expect(':')
            skipWhitespace()
            fields[key] = when {
                peek('{') -> parseObject()
                peek('"') -> parseString()
                peekNumber() -> BundleJsonNumber(parseNumber())
                else -> failBundle()
            }
            skipWhitespace()
            when {
                peek('}') -> {
                    position += 1
                    return BundleJsonObject(fields)
                }
                peek(',') -> position += 1
                else -> failBundle()
            }
        }
    }

    private fun parseString(): String {
        expect('"')
        val output = StringBuilder()
        while (position < input.length) {
            val character = input[position++]
            when {
                character == '"' -> return output.toString()
                character == '\\' -> {
                    if (position >= input.length) failBundle()
                    when (val escaped = input[position++]) {
                        '"', '\\', '/' -> output.append(escaped)
                        'b' -> output.append('\b')
                        'f' -> output.append('\u000C')
                        'n' -> output.append('\n')
                        'r' -> output.append('\r')
                        't' -> output.append('\t')
                        'u' -> output.append(parseUnicode())
                        else -> failBundle()
                    }
                }
                character.code < 0x20 -> failBundle()
                else -> output.append(character)
            }
        }
        failBundle()
    }

    private fun parseUnicode(): Char {
        if (position + 4 > input.length) failBundle()
        val value = input.subSequence(position, position + 4).toString().toIntOrNull(16) ?: failBundle()
        position += 4
        return value.toChar()
    }

    private fun parseNumber(): String {
        val start = position
        if (peek('-')) position += 1
        if (position >= input.length || !input[position].isDigit()) failBundle()
        if (input[position] == '0') position += 1 else while (position < input.length && input[position].isDigit()) position += 1
        if (position < input.length && input[position] == '.') {
            position += 1
            if (position >= input.length || !input[position].isDigit()) failBundle()
            while (position < input.length && input[position].isDigit()) position += 1
        }
        if (position < input.length && (input[position] == 'e' || input[position] == 'E')) {
            position += 1
            if (position < input.length && (input[position] == '+' || input[position] == '-')) position += 1
            if (position >= input.length || !input[position].isDigit()) failBundle()
            while (position < input.length && input[position].isDigit()) position += 1
        }
        return input.subSequence(start, position).toString()
    }

    private fun peekNumber(): Boolean = position < input.length && (input[position] == '-' || input[position].isDigit())

    private fun skipWhitespace() { while (position < input.length && input[position].isWhitespace()) position += 1 }

    private fun peek(character: Char): Boolean = position < input.length && input[position] == character

    private fun expect(character: Char) {
        if (!peek(character)) failBundle()
        position += 1
    }
}
