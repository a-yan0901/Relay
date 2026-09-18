package cn.ayan.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidExternalImportTest {
    @Test
    fun parsesCsvAndSkipsNonSshRows() {
        val document = AndroidExternalImportParser.parseCsv(
            "Name,Host,Port,User,Password,Protocol,Group,Tags\n" +
                "prod,10.0.0.1,2222,root,secret,SSH,prod,blue;ops\n" +
                "web,10.0.0.2,22,root,,RDP,legacy,old\n",
            "connections.csv"
        )

        assertEquals("ssh-csv", document.format)
        assertEquals(1, document.connections.size)
        assertEquals("prod", document.connections[0].name)
        assertEquals(2222, document.connections[0].port)
        assertEquals("ready", document.connections[0].credentialState)
        assertEquals(listOf("prod"), document.connections[0].groupPath)
        assertEquals(listOf("blue", "ops"), document.connections[0].tags)
        assertTrue(document.warnings.single().contains("RDP"))
    }

    @Test
    fun parsesOpenSshHostAndProxyJump() {
        val document = AndroidExternalImportParser.parseOpenSsh(
            "Host app\n" +
                "  HostName app.internal\n" +
                "  User deploy\n" +
                "  Port 2200\n" +
                "  IdentityFile ~/.ssh/id_ed25519\n" +
                "  ProxyJump bastion\n" +
                "Host bastion\n" +
                "  HostName 10.0.0.5\n" +
                "  User ops\n",
            "config"
        )

        assertEquals(2, document.connections.size)
        val app = document.connections.first { it.name == "app" }
        assertEquals("app.internal", app.address)
        assertEquals("private_key", app.authType)
        assertEquals(listOf("openssh:bastion"), app.jumpHostSourceIds)
        assertEquals("reference-only", app.credentialState)
    }

    @Test
    fun parsesMobaXtermSshSessionAndGatewayReference() {
        val fields = listOf("0", "prod.internal", "2222", "deploy", "", "", "", "", "bastion", "22", "ops") + List(24) { "" }
        val document = AndroidExternalImportParser.parseMobaXterm(
            "[Bookmarks]\n" +
                "SubRep=Production\n" +
                "prod=#0#${fields.joinToString("%") }\n",
            "MobaXterm.mxtsessions"
        )

        assertEquals(1, document.connections.size)
        assertEquals("mobaxterm", document.format)
        assertEquals("prod.internal", document.connections[0].address)
        assertEquals(2222, document.connections[0].port)
        assertEquals(listOf("mobaxterm:gateway:bastion:22:ops"), document.connections[0].jumpHostSourceIds)
        assertEquals(listOf("Production"), document.connections[0].groupPath)
    }

    @Test
    fun parsesXshellReferenceCredential() {
        val document = AndroidExternalImportParser.parseXshell(
            "Protocol=SSH\n" +
                "Host=app.internal\n" +
                "UserName=deploy\n" +
                "Port=2200\n" +
                "UserKey=C:/Keys/deploy.key\n" +
                "Directory=Production\n",
            "prod.xsh"
        )

        assertEquals(1, document.connections.size)
        assertEquals("app.internal", document.connections[0].address)
        assertEquals("private_key", document.connections[0].authType)
        assertEquals("reference-only", document.connections[0].credentialState)
        assertEquals("Production", document.connections[0].groupPath.single())
    }

    @Test
    fun parsesSecureCrtIniAndHexPort() {
        val document = AndroidExternalImportParser.parseSecureCrt(
            "S:\"Protocol Name\"=SSH2\n" +
                "S:\"Hostname\"=secure.internal\n" +
                "S:\"Username\"=ops\n" +
                "S:\"Port\"=00000016\n" +
                "S:\"SessionName\"=Production/prod\n",
            "prod.ini"
        )

        assertEquals(1, document.connections.size)
        assertEquals("secure.internal", document.connections[0].address)
        assertEquals(22, document.connections[0].port)
        assertEquals("prod", document.connections[0].name)
        assertEquals(listOf("Production"), document.connections[0].groupPath)
    }
}
