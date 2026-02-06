package ai.openclaw.android.chat

/**
 * Client-side sanitization for chat messages.
 * Strips Talk Mode system prompts and voice directives from displayed messages.
 */
object ChatSanitize {

  // Talk Mode prompt lines injected by TalkModeManager that should be hidden
  private val TALK_MODE_PROMPT_LINES = listOf(
    "Talk Mode active. Reply in a concise, spoken tone.",
    "You may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {\"voice\":\"<id>\",\"once\":true}.",
  )

  // Pattern for "Assistant speech interrupted at X.Xs." lines
  private val TALK_MODE_INTERRUPTED_PATTERN = Regex("""^Assistant speech interrupted at \d+\.\d+s\.$""")

  // Pattern for voice directive JSON at start of assistant message
  private val VOICE_DIRECTIVE_PATTERN = Regex("""^\s*\{[^}]*"voice"[^}]*\}\s*\n?""")

  /**
   * Sanitize a user message by removing Talk Mode prompt lines.
   */
  fun sanitizeUserMessage(text: String): String {
    val lines = text.lines()
    val filtered = lines.filter { line ->
      val trimmed = line.trim()
      // Skip known talk mode prompt lines
      if (TALK_MODE_PROMPT_LINES.any { it == trimmed }) {
        return@filter false
      }
      // Skip "Assistant speech interrupted" lines
      if (TALK_MODE_INTERRUPTED_PATTERN.matches(trimmed)) {
        return@filter false
      }
      true
    }
    // Remove leading empty lines after filtering
    return filtered.dropWhile { it.isBlank() }.joinToString("\n")
  }

  /**
   * Sanitize an assistant message by removing voice directive JSON from the start.
   */
  fun sanitizeAssistantMessage(text: String): String {
    val trimmed = text.trimStart()
    if (!trimmed.startsWith("{")) {
      return text
    }
    // Check if first line looks like a voice directive JSON
    val firstLineEnd = trimmed.indexOf('\n')
    if (firstLineEnd == -1) {
      return text // Single line, keep as-is
    }
    val firstLine = trimmed.substring(0, firstLineEnd).trim()
    if (firstLine.startsWith("{") && firstLine.endsWith("}")) {
      // Try to detect voice directive keys
      if (firstLine.contains("\"voice\"") || 
          firstLine.contains("\"modelId\"") || 
          firstLine.contains("\"speed\"") ||
          firstLine.contains("\"once\"")) {
        return trimmed.substring(firstLineEnd + 1).trimStart()
      }
    }
    return text
  }

  /**
   * Sanitize message content based on role.
   */
  fun sanitizeMessageContent(role: String, text: String?): String? {
    if (text.isNullOrEmpty()) return text
    return when (role.lowercase()) {
      "user" -> sanitizeUserMessage(text)
      "assistant" -> sanitizeAssistantMessage(text)
      else -> text
    }
  }
}
