const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "Google Chat",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;

// Talk Mode prompt lines that should be stripped from chat history
const TALK_MODE_PROMPT_LINES = [
  "Talk Mode active. Reply in a concise, spoken tone.",
  'You may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {"voice":"<id>","once":true}.',
];

// Pattern for "Assistant speech interrupted at X.Xs." lines
const TALK_MODE_INTERRUPTED_PATTERN = /^Assistant speech interrupted at \d+\.\d+s\.$/;

function looksLikeEnvelopeHeader(header: string): boolean {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) {
    return true;
  }
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) {
    return true;
  }
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

function stripTalkModePrompt(text: string): string {
  // Split into lines and filter out talk mode system lines
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    // Skip known talk mode prompt lines
    if (TALK_MODE_PROMPT_LINES.includes(trimmed)) {
      return false;
    }
    // Skip "Assistant speech interrupted" lines
    if (TALK_MODE_INTERRUPTED_PATTERN.test(trimmed)) {
      return false;
    }
    return true;
  });
  // Remove leading empty lines after stripping
  while (filtered.length > 0 && filtered[0].trim() === "") {
    filtered.shift();
  }
  return filtered.join("\n");
}

// Strip JSON voice directive from start of assistant message (e.g., {"voice":"id"}\n)
function stripVoiceDirective(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) {
    return text;
  }
  // Look for JSON on first line that looks like a voice directive
  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd === -1) {
    return text; // Single line, keep as-is
  }
  const firstLine = trimmed.slice(0, firstLineEnd).trim();
  // Check if it looks like a voice directive JSON
  if (firstLine.startsWith("{") && firstLine.endsWith("}")) {
    try {
      const parsed = JSON.parse(firstLine);
      // If it has voice/model/speed etc. keys, it's likely a directive
      if (parsed.voice || parsed.modelId || parsed.speed || parsed.once !== undefined) {
        return trimmed.slice(firstLineEnd + 1).trimStart();
      }
    } catch {
      // Not valid JSON, keep as-is
    }
  }
  return text;
}

export function stripEnvelope(text: string): string {
  let result = text;

  // First strip talk mode prompts
  result = stripTalkModePrompt(result);

  // Then strip envelope headers
  const match = result.match(ENVELOPE_PREFIX);
  if (!match) {
    return result;
  }
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) {
    return result;
  }
  return result.slice(match[0].length);
}

function stripMessageIdHints(text: string): string {
  if (!text.includes("[message_id:")) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
  return filtered.length === lines.length ? text : filtered.join("\n");
}

function stripEnvelopeFromContent(content: unknown[]): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== "text" || typeof entry.text !== "string") {
      return item;
    }
    const stripped = stripMessageIdHints(stripEnvelope(entry.text));
    if (stripped === entry.text) {
      return item;
    }
    changed = true;
    return {
      ...entry,
      text: stripped,
    };
  });
  return { content: next, changed };
}

export function stripEnvelopeFromMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";

  // For user messages: strip envelope headers, message IDs, and talk mode prompts
  // For assistant messages: strip voice directives
  if (role !== "user" && role !== "assistant") {
    return message;
  }

  let changed = false;
  const next: Record<string, unknown> = { ...entry };

  const stripFn =
    role === "user"
      ? (text: string) => stripMessageIdHints(stripEnvelope(text))
      : (text: string) => stripVoiceDirective(text);

  if (typeof entry.content === "string") {
    const stripped = stripFn(entry.content);
    if (stripped !== entry.content) {
      next.content = stripped;
      changed = true;
    }
  } else if (Array.isArray(entry.content)) {
    if (role === "user") {
      const updated = stripEnvelopeFromContent(entry.content);
      if (updated.changed) {
        next.content = updated.content;
        changed = true;
      }
    } else {
      // For assistant, strip voice directives from text parts
      const updated = entry.content.map((item) => {
        if (!item || typeof item !== "object") return item;
        const part = item as Record<string, unknown>;
        if (part.type !== "text" || typeof part.text !== "string") return item;
        const stripped = stripVoiceDirective(part.text);
        if (stripped === part.text) return item;
        changed = true;
        return { ...part, text: stripped };
      });
      if (changed) {
        next.content = updated;
      }
    }
  } else if (typeof entry.text === "string") {
    const stripped = stripFn(entry.text);
    if (stripped !== entry.text) {
      next.text = stripped;
      changed = true;
    }
  }

  return changed ? next : message;
}

export function stripEnvelopeFromMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next = messages.map((message) => {
    const stripped = stripEnvelopeFromMessage(message);
    if (stripped !== message) {
      changed = true;
    }
    return stripped;
  });
  return changed ? next : messages;
}
