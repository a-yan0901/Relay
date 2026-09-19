package cn.ayan.relay

import androidx.test.platform.app.InstrumentationRegistry
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidBundlePayloadInstrumentedTest {
    @Test
    fun acceptsWebCompatibleTagsThatAreNotNativeIdentifiers() {
        val payload = """
            {
              "groups": [],
              "hosts": [{
                "id": "host-1",
                "name": "Production",
                "address": "example.com",
                "port": 22,
                "username": "ops",
                "auth": {"type": "password", "password": "secret"},
                "groupId": null,
                "jumpHostIds": [],
                "connectionProfile": {
                  "keepaliveIntervalMs": 10000,
                  "keepaliveCountMax": 3,
                  "reconnect": {"enabled": true, "maxAttempts": 5, "baseDelayMs": 250, "maxDelayMs": 5000}
                },
                "connectionProfileOverrides": null,
                "terminalProfileId": null,
                "tags": ["Ops Team", "生产"],
                "isFavorite": false,
                "hostKeyAlgorithm": null,
                "hostKeyFingerprint": null,
                "credentialSource": {"type": "inline", "authType": "password"},
                "identityId": null
              }],
              "identities": [],
              "terminalProfiles": [],
              "terminalDefaultProfileId": "builtin:termius"
            }
        """.trimIndent().toByteArray()

        val parsed = AndroidBundlePayloadCodec.parse(payload)

        assertEquals("Ops Team", parsed.hosts.getJSONObject(0).getJSONArray("tags").getString(0))
        assertEquals("生产", parsed.hosts.getJSONObject(0).getJSONArray("tags").getString(1))
    }

    @Test
    fun acceptsPemPrivateKeysWithLineBreaks() {
        val payload = """
            {
              "groups": [],
              "hosts": [{
                "id": "private-key-host",
                "name": "Private Key Host",
                "address": "example.com",
                "port": 22,
                "username": "ops",
                "auth": {"type": "private_key", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----"},
                "groupId": null,
                "jumpHostIds": [],
                "connectionProfile": {
                  "keepaliveIntervalMs": 10000,
                  "keepaliveCountMax": 3,
                  "reconnect": {"enabled": true, "maxAttempts": 5, "baseDelayMs": 250, "maxDelayMs": 5000}
                },
                "connectionProfileOverrides": null,
                "terminalProfileId": null,
                "tags": [],
                "isFavorite": false,
                "hostKeyAlgorithm": null,
                "hostKeyFingerprint": null,
                "credentialSource": {"type": "inline", "authType": "private_key"},
                "identityId": null
              }],
              "identities": [],
              "terminalProfiles": [],
              "terminalDefaultProfileId": "builtin:termius"
            }
        """.trimIndent().toByteArray()

        val parsed = AndroidBundlePayloadCodec.parse(payload)

        assertEquals("private_key", parsed.hosts.getJSONObject(0).getJSONObject("auth").getString("type"))
    }

    @Test
    fun acceptsPartialGroupConnectionProfileOverrides() {
        val payload = """
            {
              "groups": [{
                "id": "partial-profile-group",
                "name": "Partial Profile Group",
                "sortOrder": 1,
                "parentId": null,
                "defaultIdentityId": null,
                "connectionProfile": {"keepaliveIntervalMs": 4000}
              }],
              "hosts": [],
              "identities": [],
              "terminalProfiles": [],
              "terminalDefaultProfileId": "builtin:termius"
            }
        """.trimIndent().toByteArray()

        val parsed = AndroidBundlePayloadCodec.parse(payload)

        assertEquals(1, parsed.groups.length())
        assertEquals(4000, parsed.groups.getJSONObject(0).getJSONObject("connectionProfile").getInt("keepaliveIntervalMs"))
    }

    @Test
    fun acceptsCanonicalStringCredentialSources() {
        val payload = """
            {
              "groups": [{
                "id": "canonical-group",
                "name": "Canonical Group",
                "sortOrder": 1,
                "parentId": null,
                "defaultIdentityId": "canonical-identity",
                "connectionProfile": null
              }],
              "hosts": [{
                "id": "canonical-host",
                "name": "Canonical Host",
                "address": "example.com",
                "port": 22,
                "username": "ops",
                "auth": {"type": "password", "password": "fixture-secret"},
                "groupId": "canonical-group",
                "jumpHostIds": [],
                "connectionProfile": {
                  "keepaliveIntervalMs": 10000,
                  "keepaliveCountMax": 3,
                  "reconnect": {"enabled": true, "maxAttempts": 5, "baseDelayMs": 250, "maxDelayMs": 5000}
                },
                "connectionProfileOverrides": null,
                "terminalProfileId": null,
                "tags": [],
                "isFavorite": false,
                "hostKeyAlgorithm": null,
                "hostKeyFingerprint": null,
                "credentialSource": "identity",
                "identityId": "canonical-identity"
              }],
              "identities": [{
                "id": "canonical-identity",
                "name": "Canonical Identity",
                "type": "password",
                "username": "ops",
                "keyFingerprint": null,
                "auth": {"type": "password", "password": "fixture-secret"}
              }],
              "terminalProfiles": [],
              "terminalDefaultProfileId": "builtin:termius"
            }
        """.trimIndent().toByteArray()

        val parsed = AndroidBundlePayloadCodec.parse(payload)

        assertEquals("identity", parsed.hosts.getJSONObject(0).getString("credentialSource"))
    }

    @Test
    fun decryptsAndParsesTheFullFixedCrossPlatformVector() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val vector = context.assets.open("vault-bundle-v1-full-vector.json").use { stream ->
            JSONObject(InputStreamReader(stream, StandardCharsets.UTF_8).readText())
        }
        val plaintext = AndroidBundleCrypto.decryptEnvelope(vector.getString("exportPassword"), vector.getString("bundle"))
        try {
            val payloadSha256 = MessageDigest.getInstance("SHA-256")
                .digest(plaintext)
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }
            val parsed = AndroidBundlePayloadCodec.parse(plaintext)

            assertEquals(vector.getString("payloadSha256"), payloadSha256)
            assertEquals(2, parsed.hosts.length())
            assertEquals(2, parsed.groups.length())
            assertEquals(2, parsed.identities.length())
            assertEquals(1, parsed.terminalProfiles.length())
            assertEquals("Ops Team", parsed.hosts.getJSONObject(0).getJSONArray("tags").getString(0))
            assertEquals("生产", parsed.hosts.getJSONObject(0).getJSONArray("tags").getString(1))
            assertEquals("group", parsed.hosts.getJSONObject(0).getString("credentialSource"))
            assertEquals(4_000, parsed.groups.getJSONObject(0).getJSONObject("connectionProfile").getInt("keepaliveIntervalMs"))
            assertEquals("private_key", parsed.hosts.getJSONObject(1).getJSONObject("auth").getString("type"))
        } finally {
            plaintext.fill(0)
        }
    }
}
