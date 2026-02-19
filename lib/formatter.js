// formatter.js — converts Claude API conversation object to markdown
// Block types: text, tool_use, tool_result, thinking, token_budget

// Truncation limits — generous for wood-chipper use case
// Set to 0 for no truncation
const LIMITS = {
  toolUseMeta: 2000,     // JSON metadata fields in tool_use
  toolUseContent: 0,     // Rich content fields (content, new_str, etc.) — no limit
  toolResult: 0,         // Tool result body — no limit
  thinking: 0,           // Thinking blocks — no limit
};

export function formatConversation(data, meta = {}) {
  const messages = data?.chat_messages || [];
  if (!messages.length) return "<!-- No messages found in capture -->";

  const lines = [];

  // Header
  lines.push(`<!-- float-export v0.1 -->`);
  lines.push(`<!-- conversation: ${data.uuid || meta.conversationId || "unknown"} -->`);
  lines.push(`<!-- exported: ${new Date().toISOString()} -->`);
  lines.push(`<!-- model: ${data.model || "unknown"} -->`);
  lines.push(`<!-- messages: ${messages.length} -->`);
  lines.push("");
  lines.push(`# ${data.name || meta.name || "Claude Conversation"}`);
  lines.push("");

  // Walk the message tree — chat_messages with parent_message_uuid form a tree
  // For now, flatten in order (they come sorted from API)
  for (const msg of messages) {
    const formatted = formatMessage(msg);
    if (formatted) {
      lines.push(formatted);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatMessage(msg) {
  const sender = msg.sender || "unknown";
  const lines = [];

  const label = sender === "human" ? "Human" : "Assistant";
  lines.push(`## ${label}`);
  lines.push("");

  const content = msg.content;

  if (typeof content === "string") {
    lines.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const formatted = formatBlock(block);
      if (formatted) {
        lines.push(formatted);
        lines.push("");
      }
    }
  } else if (msg.text) {
    // Fallback to text field
    lines.push(msg.text);
  }

  // Attachments
  if (msg.attachments?.length) {
    lines.push("");
    lines.push("**Attachments:**");
    for (const att of msg.attachments) {
      lines.push(`- ${att.file_name || att.name || "file"} (${att.file_type || att.content_type || "unknown"})`);
    }
  }

  return lines.join("\n");
}

function formatBlock(block) {
  if (typeof block === "string") return block;

  switch (block.type) {
    case "text":
      return block.text || "";

    case "tool_use":
      return formatToolUse(block);

    case "tool_result":
      return formatToolResult(block);

    case "thinking":
      return formatThinking(block);

    case "token_budget":
      return null; // Internal, skip

    default:
      return `<!-- unknown block type: ${block.type} -->\n\`\`\`json\n${truncate(JSON.stringify(block, null, 2), 1000)}\n\`\`\``;
  }
}

// Fields likely to contain markdown/code content worth rendering raw
const RICH_CONTENT_FIELDS = new Set([
  "content", "new_str", "old_str", "text", "body", "description",
  "message", "prompt", "code", "script", "markdown", "html",
  "new_string", "old_string", "file_text",
]);

function formatToolUse(block) {
  const name = block.name || "unknown_tool";
  const input = block.input || {};

  // Separate rich content fields from metadata fields
  const richFields = {};
  const metaFields = {};

  for (const [key, val] of Object.entries(input)) {
    if (RICH_CONTENT_FIELDS.has(key) && typeof val === "string" && val.includes("\n")) {
      richFields[key] = val;
    } else {
      metaFields[key] = val;
    }
  }

  const lines = [`### Tool Use: \`${name}\``];
  lines.push("");

  // Show metadata fields as compact JSON (file paths, flags, etc.)
  if (Object.keys(metaFields).length > 0) {
    const metaStr = JSON.stringify(metaFields, null, 2);
    lines.push(`\`\`\`json\n${truncate(metaStr, LIMITS.toolUseMeta)}\n\`\`\``);
  }

  // Render rich content fields as raw markdown/code
  for (const [key, val] of Object.entries(richFields)) {
    lines.push("");
    lines.push(`**${key}:**`);
    lines.push("");
    lines.push(truncate(val, LIMITS.toolUseContent));
  }

  return lines.join("\n");
}

function formatToolResult(block) {
  const name = block.name ? ` (${block.name})` : "";
  const isError = block.is_error;
  const prefix = isError ? `Tool Result${name} (ERROR)` : `Tool Result${name}`;

  let body;
  const content = block.content;

  if (typeof content === "string") {
    body = content;
  } else if (Array.isArray(content)) {
    body = content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c.type === "text") return c.text || "";
        if (c.type === "image") return `[image: ${c.source?.type || "embedded"}]`;
        return JSON.stringify(c, null, 2);
      })
      .join("\n");
  } else {
    body = JSON.stringify(content, null, 2);
  }

  // Try to unwrap common JSON wrappers before rendering
  body = unwrapToolOutput(body);

  // If body looks like structured data (JSON), wrap in code fence
  // If it looks like prose/markdown, render raw
  const trimmed = body.trim();
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const looksLikeCode = !trimmed.includes("\n") && trimmed.length < 200;

  if (looksLikeJson) {
    try {
      const parsed = JSON.parse(trimmed);
      const yaml = jsonToYaml(parsed);
      return `### ${prefix}\n\n\`\`\`yaml\n${truncate(yaml, LIMITS.toolResult)}\n\`\`\``;
    } catch {
      return `### ${prefix}\n\n\`\`\`json\n${truncate(body, LIMITS.toolResult)}\n\`\`\``;
    }
  } else if (looksLikeCode || isError) {
    return `### ${prefix}\n\n\`\`\`\n${truncate(body, LIMITS.toolResult)}\n\`\`\``;
  } else {
    // Render as raw markdown — this is where file contents, search results, etc. live
    return `### ${prefix}\n\n${truncate(body, LIMITS.toolResult)}`;
  }
}

// Unwrap common JSON wrappers that hide readable content
// e.g. {"returncode":0,"stdout":"actual content\nhere","stderr":""}
function unwrapToolOutput(body) {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return body;

  try {
    const parsed = JSON.parse(trimmed);

    // Bash/command output: { returncode, stdout, stderr }
    if ("stdout" in parsed && "returncode" in parsed) {
      const parts = [];
      if (parsed.stdout?.trim()) parts.push(parsed.stdout.trim());
      if (parsed.stderr?.trim()) parts.push(`**stderr:**\n${parsed.stderr.trim()}`);
      if (parts.length > 0) {
        const rc = parsed.returncode !== 0 ? ` (exit ${parsed.returncode})` : "";
        return parts.join("\n\n") + (rc ? `\n\n_${rc}_` : "");
      }
    }

    // Single-value wrappers: { "output": "...", "result": "..." }
    const singleKeys = ["output", "result", "text", "content", "message", "data"];
    for (const key of singleKeys) {
      if (typeof parsed[key] === "string" && Object.keys(parsed).length <= 3) {
        return parsed[key];
      }
    }
  } catch {
    // Not valid JSON, return as-is
  }

  return body;
}

function formatThinking(block) {
  const text = block.thinking || "";
  if (!text) return null;

  const summary = block.summaries?.length
    ? `\n\n**Summary:** ${block.summaries.map((s) => s.summary || s).join(" ")}`
    : "";

  return `<details>\n<summary>Thinking${block.cut_off ? " (truncated)" : ""}</summary>\n\n${truncate(text, LIMITS.thinking)}${summary}\n\n</details>`;
}

function truncate(str, max) {
  if (!str || !max || str.length <= max) return str;
  return str.slice(0, max) + "\n... (truncated)";
}

// ═══════════════════════════════════════════════════════════
// Outliner format — conversation as a typed block tree
// Uses prefix:: syntax, indentation for nesting,
// collapsible sections for tool calls and thinking
// ═══════════════════════════════════════════════════════════

export function formatForOutliner(data, meta = {}) {
  const messages = data?.chat_messages || [];
  if (!messages.length) return "export:: empty conversation";

  const lines = [];

  // Header block
  const title = data.name || meta.name || "Claude Conversation";
  lines.push(`export:: ${title}`);
  lines.push(`  model:: ${data.model || "unknown"}`);
  lines.push(`  messages:: ${messages.length}`);
  lines.push(`  exported:: ${new Date().toISOString()}`);
  lines.push(`  id:: ${data.uuid || meta.conversationId || "unknown"}`);

  for (const msg of messages) {
    lines.push("");
    const blocks = outlinerMessage(msg);
    lines.push(...blocks);
  }

  return lines.join("\n");
}

function outlinerMessage(msg) {
  const sender = msg.sender || "unknown";
  const content = msg.content;
  const lines = [];

  if (sender === "human" || sender === "user") {
    // Human messages — inline short ones, nest long ones
    const text = extractPlainText(content) || msg.text || "";
    const firstLine = text.split("\n")[0].slice(0, 120);
    const rest = text.split("\n").slice(1).join("\n").trim();

    lines.push(`user:: ${firstLine}`);
    if (rest) {
      for (const line of rest.split("\n")) {
        lines.push(`  ${line}`);
      }
    }

    // Attachments as nested blocks
    if (msg.attachments?.length) {
      for (const att of msg.attachments) {
        lines.push(`  attachment:: ${att.file_name || att.name || "file"} (${att.file_type || "unknown"})`);
      }
    }
  } else {
    // Assistant messages — walk content blocks
    lines.push(`response::`);

    if (typeof content === "string") {
      for (const line of content.split("\n")) {
        lines.push(`  ${line}`);
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const blockLines = outlinerBlock(block);
        if (blockLines) {
          lines.push(...blockLines);
        }
      }
    } else if (msg.text) {
      for (const line of msg.text.split("\n")) {
        lines.push(`  ${line}`);
      }
    }
  }

  return lines;
}

function outlinerBlock(block) {
  if (typeof block === "string") {
    return block.split("\n").map((l) => `  ${l}`);
  }

  switch (block.type) {
    case "text":
      return outlinerText(block);
    case "tool_use":
      return outlinerToolUse(block);
    case "tool_result":
      return outlinerToolResult(block);
    case "thinking":
      return outlinerThinking(block);
    case "token_budget":
      return null;
    default:
      return [`  unknown:: ${block.type}`];
  }
}

function outlinerText(block) {
  const text = block.text || "";
  if (!text.trim()) return null;
  return text.split("\n").map((l) => `  ${l}`);
}

function outlinerToolUse(block) {
  const name = block.name || "unknown";
  const input = block.input || {};
  const lines = [];

  // Build a compact summary for the tool call header
  const summary = toolCallSummary(name, input);
  lines.push(`  tool:: ${name} ${summary}`);

  // Nest input fields
  for (const [key, val] of Object.entries(input)) {
    if (typeof val === "string" && val.includes("\n")) {
      // Multiline content — nest deeply
      lines.push(`    ${key}::`);
      for (const line of val.split("\n")) {
        lines.push(`      ${line}`);
      }
    } else if (typeof val === "string" && val.length > 120) {
      // Long string — nest
      lines.push(`    ${key}:: ${val.slice(0, 120)}...`);
    } else if (typeof val === "object" && val !== null) {
      lines.push(`    ${key}:: ${JSON.stringify(val)}`);
    } else {
      lines.push(`    ${key}:: ${val}`);
    }
  }

  return lines;
}

function outlinerToolResult(block) {
  const name = block.name || "";
  const isError = block.is_error;
  const label = isError ? `result:: ERROR${name ? " " + name : ""}` : `result::${name ? " " + name : ""}`;
  const lines = [];

  let body = extractToolResultText(block.content);
  body = unwrapToolOutput(body);

  const firstLine = body.split("\n")[0].slice(0, 120);
  const rest = body.split("\n").slice(1);

  lines.push(`    ${label} ${firstLine}`);
  for (const line of rest) {
    lines.push(`      ${line}`);
  }

  return lines;
}

function outlinerThinking(block) {
  const text = block.thinking || "";
  if (!text.trim()) return null;

  const lines = [];
  const preview = text.split("\n")[0].slice(0, 80);
  lines.push(`  thinking:: ${preview}${text.includes("\n") ? "..." : ""}`);

  // Full content nested underneath (collapsible in outliner)
  for (const line of text.split("\n")) {
    lines.push(`    ${line}`);
  }

  if (block.summaries?.length) {
    lines.push(`    summary:: ${block.summaries.map((s) => s.summary || s).join(" ")}`);
  }

  return lines;
}

function extractPlainText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("\n");
}

function extractToolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c.type === "text") return c.text || "";
        if (c.type === "image") return "[image]";
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

// Compact summary for tool call headers
function toolCallSummary(name, input) {
  // Common patterns — show the most useful field inline
  if (input.file_path) return `→ ${input.file_path}`;
  if (input.path) return `→ ${input.path}`;
  if (input.command) return `→ ${input.command.split("\n")[0].slice(0, 80)}`;
  if (input.pattern) return `→ ${input.pattern}`;
  if (input.query) return `→ ${input.query.slice(0, 80)}`;
  if (input.url) return `→ ${input.url.slice(0, 80)}`;
  if (input.skill) return `→ ${input.skill}`;
  if (input.title) return `→ ${input.title.slice(0, 80)}`;
  return "";
}

// ═══════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════

// Convert JSON-parsed object to readable YAML-like format
// Uses block scalars for multiline strings (much more readable than escaped \n)
function jsonToYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);

  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return String(obj);
  if (typeof obj === "number") return String(obj);

  if (typeof obj === "string") {
    if (obj.includes("\n")) {
      // Block scalar — render multiline strings readable
      const lines = obj.split("\n").map((l) => pad + "  " + l);
      return "|\n" + lines.join("\n");
    }
    // Quote if it contains special chars
    if (/[:#{}[\],&*?|>!%@`]/.test(obj) || obj === "" || obj !== obj.trim()) {
      return JSON.stringify(obj);
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    // Simple arrays (all scalars, short) on one line
    if (obj.every((v) => typeof v !== "object" || v === null) && JSON.stringify(obj).length < 80) {
      return "[" + obj.map((v) => typeof v === "string" ? JSON.stringify(v) : String(v)).join(", ") + "]";
    }
    return obj
      .map((item) => {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          const entries = Object.entries(item);
          const first = entries[0];
          const rest = entries.slice(1);
          let result = `${pad}- ${first[0]}: ${jsonToYaml(first[1], indent + 2)}`;
          for (const [k, v] of rest) {
            result += `\n${pad}  ${k}: ${jsonToYaml(v, indent + 2)}`;
          }
          return result;
        }
        return `${pad}- ${jsonToYaml(item, indent + 1)}`;
      })
      .join("\n");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, val]) => {
        const yamlVal = jsonToYaml(val, indent + 1);
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          return `${pad}${key}:\n${yamlVal}`;
        }
        if (typeof val === "string" && val.includes("\n")) {
          return `${pad}${key}: ${yamlVal}`;
        }
        return `${pad}${key}: ${yamlVal}`;
      })
      .join("\n");
  }

  return String(obj);
}
