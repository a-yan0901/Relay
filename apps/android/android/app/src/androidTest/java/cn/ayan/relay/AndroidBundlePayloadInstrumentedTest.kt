package cn.ayan.relay

import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.KeyStore
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
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

    @Test
    fun exportsClearsAndImportsTheAndroidBundleWithoutPartialWrites() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.deleteDatabase("relay-local.db")
        deleteVaultKey()

        val store = AndroidLocalStore(context)
        val vault = AndroidVault(store)
        val service = AndroidBundleService(store, vault)
        val password = "relay-bundle-roundtrip-2026"
        val identityId = "roundtrip-identity"
        val groupId = "roundtrip-group"
        val groupHostId = "roundtrip-group-host"
        val inlineHostId = "roundtrip-inline-host"
        val profileId = "roundtrip-profile"

        try {
            vault.setup("relay-device-test-2026")
            val now = "2026-09-19T00:00:00.000Z"
            val identity = AndroidIdentity(
                id = identityId,
                name = "Roundtrip Identity",
                type = "password",
                username = "ops",
                keyFingerprint = null,
                credentialCiphertext = vault.encryptSecret(
                    JSONObject().put("type", "password").put("password", "roundtrip-secret").toString(),
                    "identity:$identityId:credentials:v1"
                ),
                createdAt = now,
                updatedAt = now
            )
            store.putIdentity(identity)
            store.putGroup(AndroidGroup(
                id = groupId,
                name = "生产 / Roundtrip",
                parentId = null,
                sortOrder = 1,
                defaultIdentityId = identityId,
                connectionProfileJson = JSONObject().put("keepaliveIntervalMs", 4_000).toString(),
                createdAt = now,
                updatedAt = now
            ))
            val appearance = AndroidBuiltinTerminalProfiles.json("builtin:everforest-dark")!!.getJSONObject("appearance")
            store.putTerminalProfile(AndroidTerminalProfile(profileId, "Roundtrip Profile", appearance.toString(), now, now))
            store.setDefaultTerminalProfileId(profileId)
            store.putHost(roundtripHost(groupHostId, "Group Host", groupId, profileId, "group", null, null, now))
            store.putHost(roundtripHost(
                inlineHostId,
                "Inline Host",
                null,
                profileId,
                "inline",
                null,
                vault.encryptSecret(
                    JSONObject().put("type", "password").put("password", "inline-secret").toString(),
                    "host:$inlineHostId:credentials:v1"
                ),
                now
            ))

            val started = service.beginExport(password)
            val bundleId = started.getString("bundleId")
            val bundle = StringBuilder()
            var cursor = 0
            var done = false
            while (!done) {
                val chunk = service.readExportChunk(bundleId, cursor)
                val bytes = Base64.decode(chunk.getString("data"), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                try {
                    bundle.append(String(bytes, StandardCharsets.UTF_8))
                } finally {
                    bytes.fill(0)
                }
                cursor = chunk.getInt("nextCursor")
                done = chunk.getBoolean("done")
            }
            service.releaseExport(bundleId)

            assertThrows(NativeVaultFailure::class.java) { service.preview("wrong-password", bundle) }
            val tampered = JSONObject(bundle.toString())
            val authTag = tampered.getJSONObject("payload").getString("authTag")
            tampered.getJSONObject("payload").put("authTag", authTag.dropLast(1) + if (authTag.last() == 'A') 'B' else 'A')
            assertThrows(NativeVaultFailure::class.java) { service.preview(password, tampered.toString()) }
            assertEquals(2, store.countHosts())
            assertEquals(1, store.countGroups())
            assertEquals(1, store.countIdentities())

            store.deleteHost(groupHostId)
            store.deleteHost(inlineHostId)
            store.deleteGroup(groupId)
            store.deleteIdentity(identityId)
            store.deleteTerminalProfile(profileId)
            store.setDefaultTerminalProfileId("builtin:termius")

            val preview = service.preview(password, bundle)
            assertEquals(2, preview.getInt("hostCount"))
            assertEquals(1, preview.getInt("groupCount"))
            assertEquals(1, preview.getInt("identityCount"))
            val result = service.apply(preview.getString("previewId"), JSONObject()
                .put("hostConflicts", "replace")
                .put("groupConflicts", "replace")
                .put("identityConflicts", "replace"))

            assertEquals(2, result.getInt("importedHosts"))
            assertEquals(1, result.getInt("importedGroups"))
            assertEquals(1, result.getInt("importedIdentities"))
            assertEquals("group", store.getHost(groupHostId)!!.credentialSource)
            assertEquals("inline", store.getHost(inlineHostId)!!.credentialSource)
            assertEquals("roundtrip-secret", vault.decryptSecret(store.getIdentity(identityId)!!.credentialCiphertext, "identity:$identityId:credentials:v1").let { JSONObject(it).getString("password") })
            assertEquals("inline-secret", vault.decryptSecret(store.getHost(inlineHostId)!!.credentialCiphertext!!, "host:$inlineHostId:credentials:v1").let { JSONObject(it).getString("password") })
            assertEquals(profileId, store.getDefaultTerminalProfileId())
        } finally {
            service.close()
            vault.close()
            store.close()
            context.deleteDatabase("relay-local.db")
            deleteVaultKey()
        }
    }

    private fun roundtripHost(
        id: String,
        name: String,
        groupId: String?,
        profileId: String,
        credentialSource: String,
        identityId: String?,
        credentialCiphertext: String?,
        now: String
    ): AndroidHost = AndroidHost(
        id = id,
        name = name,
        address = "example.com",
        port = 22,
        username = "ops",
        authType = "password",
        credentialCiphertext = credentialCiphertext,
        credentialSource = credentialSource,
        identityId = identityId,
        groupId = groupId,
        terminalProfileId = profileId,
        jumpHostIdsJson = "[]",
        keepaliveIntervalMs = 10_000,
        keepaliveCountMax = 3,
        reconnectEnabled = true,
        reconnectMaxAttempts = 5,
        reconnectBaseDelayMs = 250,
        reconnectMaxDelayMs = 5_000,
        tagsJson = "[\"Ops Team\",\"生产\"]",
        favorite = true,
        hostKeyAlgorithm = "ssh-ed25519",
        hostKeyFingerprint = "SHA256:roundtrip",
        lastConnectedAt = null,
        createdAt = now,
        updatedAt = now
    )

    private fun deleteVaultKey() {
        KeyStore.getInstance("AndroidKeyStore").apply {
            load(null)
            if (containsAlias("relay.vault.root.v1")) deleteEntry("relay.vault.root.v1")
        }
    }
}
