package ai.openclaw.android.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class TtsSanitizerTest {

  @Test
  fun `strips markdown bold and italic`() {
    assertEquals("hello world", TtsSanitizer.sanitize("**hello** *world*"))
  }

  @Test
  fun `strips fenced code blocks`() {
    val input = "Here's the fix:\n```kotlin\nfun main() {}\n```\nDone."
    assertEquals("Here's the fix:\n\nDone.", TtsSanitizer.sanitize(input))
  }

  @Test
  fun `strips inline code`() {
    assertEquals("Run the command to start.", TtsSanitizer.sanitize("Run `the command` to start."))
  }

  @Test
  fun `strips tts tags`() {
    assertEquals("Hello there", TtsSanitizer.sanitize("[[tts:nova]]Hello there[[/tts:nova]]"))
  }

  @Test
  fun `strips reply tags`() {
    assertEquals("Got it.", TtsSanitizer.sanitize("[[reply_to_current]] Got it."))
  }

  @Test
  fun `strips URLs`() {
    assertEquals("Check this out", TtsSanitizer.sanitize("Check this out https://example.com"))
  }

  @Test
  fun `strips NO_REPLY and HEARTBEAT_OK lines`() {
    assertEquals("", TtsSanitizer.sanitize("NO_REPLY"))
    assertEquals("", TtsSanitizer.sanitize("HEARTBEAT_OK"))
  }

  @Test
  fun `strips markdown links keeping text`() {
    assertEquals("click here for info", TtsSanitizer.sanitize("[click here](https://example.com) for info"))
  }

  @Test
  fun `strips headers`() {
    assertEquals("Title\nSome text", TtsSanitizer.sanitize("## Title\nSome text"))
  }

  @Test
  fun `strips antml function call blocks`() {
    val input = "Let me check.\n<antml_function_calls>\n<antml_invoke name=\"exec\">\n</antml_invoke>\n</antml_function_calls>\nDone."
    assertEquals("Let me check.\n\nDone.", TtsSanitizer.sanitize(input))
  }

  @Test
  fun `strips list markers`() {
    assertEquals("First\nSecond", TtsSanitizer.sanitize("- First\n- Second"))
  }

  @Test
  fun `handles clean text unchanged`() {
    assertEquals("Just a normal sentence.", TtsSanitizer.sanitize("Just a normal sentence."))
  }

  @Test
  fun `strips read-sync noise`() {
    assertEquals("", TtsSanitizer.sanitize("[read-sync]\n[[read_ack]]"))
  }
}
