package my.maxcom.box.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PinHashTest {
    @Test
    fun roundTrip() {
        val s = PinHash.make("123456")
        assertTrue(PinHash.verify("123456", s))
        assertFalse(s.contains("123456"))
        assertTrue(s.contains(";100000;"))
    }

    @Test
    fun wrongPinFails() {
        val s = PinHash.make("12345678")
        assertFalse(PinHash.verify("12345679", s))
        assertFalse(PinHash.verify("1234", s))
    }

    @Test
    fun saltIsRandom() {
        assertNotEquals(PinHash.make("432100"), PinHash.make("432100"))
    }

    @Test
    fun malformedStoredIsFalseNotAnError() {
        for (bad in listOf("", "x", "pbkdf2-sha256;100000;AAAA;BBBB", "pbkdf2-sha256;abc;AAAA;BBBB", "md5;1;2;3", "a;b;c;d;e", "pbkdf2-sha256;100000;!!;!!", "pbkdf2-sha256;5;AAAAAAAAAAAAAAAAAAAAAA==;AAAA")) {
            assertFalse(bad, PinHash.verify("123456", bad))
        }
    }

    @Test
    fun nonDigitOrWrongLengthRefused() {
        for (bad in listOf("", "123", "1234", "12345", "123456789", "12a456", "12 456", "١٢٣٤٥٦", "12-456")) {
            assertFalse(bad, PinHash.isValidPin(bad))
            assertFalse(PinHash.verify(bad, PinHash.make("123456")))
            var threw = false
            try { PinHash.make(bad) } catch (_: IllegalArgumentException) { threw = true }
            assertTrue(bad, threw)
        }
        assertTrue(PinHash.isValidPin("000000"))
        assertTrue(PinHash.isValidPin("00000000"))
    }

    @Test
    fun anOlderFourDigitPinStillVerifiesButCannotBeSetAgain() {
        val old = PinHash.makeLegacy("1234")
        assertTrue(PinHash.verify("1234", old))
        assertFalse(PinHash.verify("1235", old))
        assertFalse(PinHash.isValidPin("1234"))
    }

    @Test
    fun aRebootOrAClockJumpNeverShortensTheLock() {
        val boot1 = 7L
        val t0 = 5_000_000L // monotonic ms in boot 1
        var s = LockState()
        repeat(5) { s = Lockout.onWrong(s, t0, boot1) }
        assertTrue(Lockout.isLocked(s, t0))
        assertEquals(boot1, s.bootId)
        // same boot: still locked until the end, then cleared
        assertEquals(s, Lockout.rebase(s, t0 + 1000, boot1))
        assertEquals(LockState(0, 0L, boot1), Lockout.rebase(s, s.lockedUntilMs, boot1))
        // after a reboot the monotonic clock is small again: the lock restarts in full, never shorter
        val after = Lockout.rebase(s, 3_000L, 8L)
        assertTrue(Lockout.isLocked(after, 3_000L))
        assertEquals(Lockout.LOCK_MS, Lockout.remainingMs(after, 3_000L))
        assertEquals(8L, after.bootId)
        // an unlocked state just takes the new boot id
        assertEquals(LockState(2, 0L, 8L), Lockout.rebase(LockState(2, 0L, 7L), 10L, 8L))
    }

    @Test
    fun lockoutFiveWrongTriesLockFiveMinutes() {
        var s = LockState()
        val t0 = 1_000_000L
        repeat(4) { s = Lockout.onWrong(s, t0); assertFalse(Lockout.isLocked(s, t0)) }
        s = Lockout.onWrong(s, t0)
        assertTrue(Lockout.isLocked(s, t0))
        assertTrue(Lockout.isLocked(s, t0 + Lockout.LOCK_MS - 1))
        assertFalse(Lockout.isLocked(s, t0 + Lockout.LOCK_MS))
        assertEquals(Lockout.LOCK_MS, Lockout.remainingMs(s, t0))
        // a wrong try while locked does not extend the lock
        assertEquals(s, Lockout.onWrong(s, t0 + 1000))
        // after the lock the counter starts again
        val after = Lockout.onWrong(s, t0 + Lockout.LOCK_MS)
        assertEquals(LockState(1, 0L), after)
        assertEquals(LockState(), Lockout.onSuccess())
    }
}
