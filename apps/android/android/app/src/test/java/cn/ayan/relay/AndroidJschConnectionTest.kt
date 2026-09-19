package cn.ayan.relay

import com.jcraft.jsch.JSchException
import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidJschConnectionTest {
    @Test
    fun mapsPrivateKeyParsingFailuresToAuthenticationFailure() {
        assertEquals("SSH_AUTH_FAILED", mapJschError(JSchException("invalid privatekey")))
    }
}
