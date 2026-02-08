package ai.openclaw.android.voice

/**
 * Cleans assistant text before sending to TTS (ElevenLabs or system).
 * Strips markdown, tags, tool artifacts, URLs, and other non-spoken noise.
 */
object TtsSanitizer {

  private val FENCED_CODE_BLOCK = Regex("```[\\s\\S]*?```", RegexOption.DOT_MATCHES_ALL)
  private val INLINE_CODE = Regex("`[^`]+`")
  private val TTS_TAGS = Regex("""\[\[/?tts:[^\]]*\]\]""")
  private val REPLY_TAGS = Regex("""\[\[\s*reply_to[^\]]*\]\]""")
  private val ANTML_BLOCKS = Regex("""<antml_(?:function_calls|invoke|parameter)[^>]*>[\s\S]*?</antml_\w+>""", RegexOption.DOT_MATCHES_ALL)
  private val XML_TOOL_BLOCKS = Regex("""<(?:function_calls|antml_\w+)[^>]*>[\s\S]*?</(?:function_calls|antml_\w+)>""", RegexOption.DOT_MATCHES_ALL)
  private val HTML_TAGS = Regex("<[^>]+>")
  private val MARKDOWN_HEADERS = Regex("""^#{1,6}\s+""", RegexOption.MULTILINE)
  private val MARKDOWN_BOLD = Regex("""\*\*([^*]+)\*\*""")
  private val MARKDOWN_ITALIC = Regex("""\*([^*]+)\*""")
  private val MARKDOWN_STRIKETHROUGH = Regex("""~~([^~]+)~~""")
  private val MARKDOWN_LINKS = Regex("""\[([^\]]+)\]\([^)]+\)""")
  private val MARKDOWN_IMAGES = Regex("""!\[([^\]]*)\]\([^)]+\)""")
  private val MARKDOWN_HORIZONTAL_RULE = Regex("""^[-*_]{3,}\s*$""", RegexOption.MULTILINE)
  private val MARKDOWN_BLOCKQUOTE = Regex("""^>\s?""", RegexOption.MULTILINE)
  private val MARKDOWN_UNORDERED_LIST = Regex("""^[\s]*[-*+]\s+""", RegexOption.MULTILINE)
  private val MARKDOWN_ORDERED_LIST = Regex("""^[\s]*\d+\.\s+""", RegexOption.MULTILINE)
  private val BARE_URLS = Regex("""https?://\S+""")
  private val EMOJI_SHORTCODES = Regex(""":[a-zA-Z0-9_+-]+:""")
  private val MULTIPLE_NEWLINES = Regex("""\n{3,}""")
  private val MULTIPLE_SPACES = Regex(""" {2,}""")

  private val NOISE_LINES = setOf(
    "NO_REPLY",
    "HEARTBEAT_OK",
    "[read-sync]",
    "[[read_ack]]",
  )

  fun sanitize(text: String): String {
    var result = text

    // Remove tool call blocks first (largest chunks)
    result = ANTML_BLOCKS.replace(result, "")
    result = XML_TOOL_BLOCKS.replace(result, "")

    // Remove fenced code blocks entirely (commands, scripts, etc.)
    result = FENCED_CODE_BLOCK.replace(result, "")

    // Remove inline code
    result = INLINE_CODE.replace(result, "")

    // Remove special tags
    result = TTS_TAGS.replace(result, "")
    result = REPLY_TAGS.replace(result, "")

    // Remove HTML tags
    result = HTML_TAGS.replace(result, "")

    // Remove noise lines
    result = result.lines().filter { line ->
      val trimmed = line.trim()
      trimmed !in NOISE_LINES
    }.joinToString("\n")

    // Strip markdown formatting (keep the text content)
    result = MARKDOWN_IMAGES.replace(result, "$1")
    result = MARKDOWN_LINKS.replace(result, "$1")
    result = MARKDOWN_HEADERS.replace(result, "")
    result = MARKDOWN_BOLD.replace(result, "$1")
    result = MARKDOWN_ITALIC.replace(result, "$1")
    result = MARKDOWN_STRIKETHROUGH.replace(result, "$1")
    result = MARKDOWN_HORIZONTAL_RULE.replace(result, "")
    result = MARKDOWN_BLOCKQUOTE.replace(result, "")
    result = MARKDOWN_UNORDERED_LIST.replace(result, "")
    result = MARKDOWN_ORDERED_LIST.replace(result, "")

    // Remove bare URLs
    result = BARE_URLS.replace(result, "")

    // Remove emoji shortcodes (e.g. :thumbsup:)
    result = EMOJI_SHORTCODES.replace(result, "")

    // Clean up whitespace
    result = MULTIPLE_NEWLINES.replace(result, "\n\n")
    result = MULTIPLE_SPACES.replace(result, " ")

    return result.trim()
  }
}
