const DEFAULT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TRACKED_REQUESTS = 10_000;
const AGENT_QUERY_SOURCE_PREFIX = 'agent:';

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseRequestBody(bodyBuffer) {
  if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) {
    return null;
  }

  return parseJson(bodyBuffer.toString('utf8'));
}

function parseMetadataUserId(userId) {
  if (!userId) {
    return null;
  }

  if (typeof userId === 'string') {
    return parseJson(userId);
  }

  if (typeof userId === 'object') {
    return userId;
  }

  return null;
}

function isThinkingEnabled(thinking) {
  if (!thinking) {
    return false;
  }

  if (thinking === false) {
    return false;
  }

  if (typeof thinking === 'object') {
    if (thinking.type === 'disabled' || thinking.enabled === false) {
      return false;
    }
  }

  return true;
}

function isAgentQuerySource(querySource) {
  return typeof querySource === 'string' && querySource.startsWith(AGENT_QUERY_SOURCE_PREFIX);
}

function getLastUserContentBlocks(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last?.role !== 'user') return null;
  return Array.isArray(last?.content) ? last.content : null;
}

// Heuristic: detect auto-inserted text blocks that should not block tool-continuation routing.
// Uses substring matching — not full tag boundary validation. A tool_result whose content
// happens to contain '<system-reminder>' as a literal string would also match, but tool_result
// blocks bypass this function (they're checked by type, not content). Practical risk is low
// since this runs on the local proxy only.
function isAutoInsertedText(block) {
  if (block?.type !== 'text') return false;
  const text = typeof block.text === 'string' ? block.text : '';
  if (!text.trim()) return true;
  if (text.includes('<system-reminder>')) return true;
  if (text.includes('<environment_details>')) return true;
  return false;
}

function analyzeLastMessageContent(body) {
  const content = getLastUserContentBlocks(body);
  if (!Array.isArray(content) || content.length === 0) {
    return { hasToolResult: false, hasUserContent: false, hasError: false };
  }
  let hasToolResult = false;
  let hasUserContent = false;
  let hasError = false;
  for (const block of content) {
    if (block?.type === 'tool_result') {
      hasToolResult = true;
      if (block?.is_error === true) hasError = true;
    } else if (!isAutoInsertedText(block)) {
      // User-written text or unknown block type
      hasUserContent = true;
    }
  }
  return { hasToolResult, hasUserContent, hasError };
}

function detectLastMessageIsToolResult(body) {
  const { hasToolResult, hasUserContent, hasError } = analyzeLastMessageContent(body);
  // Don't route if any tool_result has is_error — Claude should handle errors
  return hasToolResult && !hasUserContent && !hasError;
}

function detectLastMessageHasMixedToolResult(body) {
  const { hasToolResult, hasUserContent } = analyzeLastMessageContent(body);
  return hasToolResult && hasUserContent;
}

export class RequestClassifier {
  constructor(options = {}) {
    this.retryWindowMs = options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
    this.maxTrackedRequests = options.maxTrackedRequests ?? DEFAULT_MAX_TRACKED_REQUESTS;
    this.now = options.now ?? Date.now;
    this.seenRequestIds = new Map();
  }

  classify({ headers = {}, bodyBuffer = Buffer.alloc(0) } = {}) {
    const requestId = normalizeHeaderValue(headers['x-client-request-id']);
    const sessionId = normalizeHeaderValue(headers['x-claude-code-session-id']);
    const isRetry = this.#trackRetry(requestId);
    const body = parseRequestBody(bodyBuffer);
    const userMetadata = parseMetadataUserId(body?.metadata?.user_id);
    const querySource = typeof userMetadata?.querySource === 'string' ? userMetadata.querySource : null;
    const toolCount = Array.isArray(body?.tools) ? body.tools.length : 0;
    const messageCount = Array.isArray(body?.messages) ? body.messages.length : 0;
    const thinking = isThinkingEnabled(body?.thinking);
    const speed = body?.speed ?? null;
    const model = body?.model ?? null;
    const lastMessageIsToolResult = detectLastMessageIsToolResult(body);
    const lastMessageHasMixedToolResult = detectLastMessageHasMixedToolResult(body);
    // Intentional: tool-continuation messages (lastMessageIsToolResult) are always shadow-eligible
    // regardless of thinking mode or tool count, because they represent deterministic follow-ups
    // (tool output → next action) where Codex comparison is most valuable.
    const shadowEligible = lastMessageIsToolResult || (!lastMessageHasMixedToolResult && isAgentQuerySource(querySource) && toolCount <= 5 && !thinking);

    return {
      sessionId,
      requestId,
      querySource,
      model,
      toolCount,
      messageCount,
      isRetry,
      speed,
      thinking,
      shadowEligible,
      lastMessageIsToolResult,
      lastMessageHasMixedToolResult,
      rawBodyBytes: bodyBuffer.length,
      parseOk: body !== null,
      isKnownQuerySource: false,
    };
  }

  #trackRetry(requestId) {
    if (!requestId) {
      return false;
    }

    const now = this.now();

    if (this.seenRequestIds.size >= this.maxTrackedRequests) {
      this.#prune(now, true);
    } else {
      this.#prune(now, false);
    }

    const seenBefore = this.seenRequestIds.has(requestId);
    this.seenRequestIds.set(requestId, now);
    return seenBefore;
  }

  #prune(now, forceOldestRemoval) {
    const cutoff = now - this.retryWindowMs;

    for (const [requestId, seenAt] of this.seenRequestIds) {
      if (seenAt < cutoff) {
        this.seenRequestIds.delete(requestId);
      }
    }

    if (!forceOldestRemoval || this.seenRequestIds.size < this.maxTrackedRequests) {
      return;
    }

    const oldestRequestId = this.seenRequestIds.keys().next().value;
    if (oldestRequestId) {
      this.seenRequestIds.delete(oldestRequestId);
    }
  }
}

export function createRequestClassifier(options) {
  return new RequestClassifier(options);
}
