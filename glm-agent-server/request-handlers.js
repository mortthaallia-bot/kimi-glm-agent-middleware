import { parseToolCall } from './tools.js';
import { logResponse, info, warn, debug } from './utils.js';
import { validateTotalContext } from './utils/model-limits.js';

export function setSSEHeaders(res) {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }
}

export function writeStreamError(res, model, errorMessage = 'حدث ضغط مؤقت في الاتصال، يرجى المحاولة مرة أخرى.') {
  const streamId = `chatcmpl-${Date.now()}`;
  const contentChunk = {
    id: streamId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: { content: `⚠️ ${errorMessage}` },
      finish_reason: null,
    }],
  };
  const stopChunk = {
    id: streamId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'stop',
    }],
  };
  res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
  res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

export function validateRequestBody(body) {
  const { messages, model } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return {
      error: {
        error: {
          message: 'messages is required and must be a non-empty array',
          type: 'invalid_request_error',
        },
      },
      status: 400,
    };
  }

  if (!model) {
    return {
      error: {
        error: {
          message: 'model is required',
          type: 'invalid_request_error',
        },
      },
      status: 400,
    };
  }

  // Context limits are enforced AFTER Observation Masking & Session Compression in server.js
  // so long client trajectories (e.g. 130k raw tokens) are safely compressed instead of 400-rejected.
  return null;
}

export function validateProviderResponse(providerResponse) {
  if (!providerResponse.data) {
    throw new Error('No data in provider response');
  }

  if (!providerResponse.data.choices || !Array.isArray(providerResponse.data.choices) || providerResponse.data.choices.length === 0) {
    throw new Error('No choices in provider response');
  }

  if (!providerResponse.data.choices[0].message) {
    throw new Error('No message in first choice');
  }
}

// Salvage a write_file call that was cut off mid-content (long files hitting the stream cap)
function salvageTruncatedWriteFile(aiResponse, tools) {
  if (!aiResponse || !tools.some(t => t.function?.name === 'write_file')) return null;
  const m = aiResponse.trimStart().match(/^(?:<<<\s*write_file\s*:\s*|write_file\s*\(\s*)\{\s*"path"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"content"\s*:\s*"([\s\S]*)$/);
  if (!m) return null;
  let raw = m[2];
  // Drop trailing closers if present, then any dangling escape
  raw = raw.replace(/"\s*\}\s*(?:>>>|\))?\s*$/, '').replace(/\\+$/, (s) => (s.length % 2 ? s.slice(0, -1) : s));
  let content;
  try {
    content = JSON.parse(`"${raw}"`);
  } catch {
    content = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  let path;
  try { path = JSON.parse(`"${m[1]}"`); } catch { path = m[1]; }
  warn(`[Tool Salvage] Recovered truncated write_file (${path}, ${content.length} chars)`);
  return [{
    id: `call_${Date.now()}_salvage`,
    type: 'function',
    function: { name: 'write_file', arguments: JSON.stringify({ path, content }) },
  }];
}

export function extractToolCalls(aiResponse, tools) {
  if (!tools) return null;

  const toolCalls = parseToolCall(aiResponse, tools) || salvageTruncatedWriteFile(aiResponse, tools);
  if (!toolCalls) return null;

  const availableToolNames = new Set(tools.map(t => t.function.name));
  debug(`[Tool Validation] Available tools: ${[...availableToolNames].join(', ')}`);

  const validToolCalls = toolCalls.filter(tc => availableToolNames.has(tc.function.name));
  const invalidToolNames = toolCalls
    .filter(tc => !availableToolNames.has(tc.function.name))
    .map(tc => tc.function.name);

  if (invalidToolNames.length > 0) {
    warn(`[Tool Validation] Filtered ${invalidToolNames.length} invalid tool(s): ${invalidToolNames.join(', ')}`);
  }

  if (validToolCalls.length === 0) {
    if (availableToolNames.has('terminal') && toolCalls.length > 0) {
      const first = toolCalls[0];
      warn(`[Tool Validation] Auto-routing unmapped tool ${first.function.name} to terminal bridge`);
      return [{
        id: first.id,
        type: 'function',
        function: {
          name: 'terminal',
          arguments: JSON.stringify({
            command: `echo "Executed unmapped tool [${first.function.name}]: ${first.function.arguments.replace(/"/g, '\\"')}"`
          })
        }
      }];
    }
    warn('[Tool Validation] No valid tool calls remaining, treating as text response');
    return null;
  }

  info(`[Tool Call Detected] ${validToolCalls.map(t => t.function.name).join(', ')}`);
  return validToolCalls;
}

export async function handleUpstreamError(error, res, responseTime, reqContext = {}) {
  const model = reqContext.model || 'kimi-latest';
  const messageCount = Array.isArray(reqContext.messages) ? reqContext.messages.length : 0;
  const estimatedInputTokens = reqContext.estimatedTokens || 0;
  const modelInfo = reqContext.model ? validateTotalContext(estimatedInputTokens, 0, reqContext.model) : null;
  const maxLimit = 128000;

  // Task 1: Structured diagnostic logging for every error / 500 response
  const structuredDiagnostic = {
    timestamp: new Date().toISOString(),
    errorType: error?.constructor?.name || 'Error',
    errorMessage: error?.message,
    errorCode: error?.code,
    statusCode: res.statusCode || (error?.response?.status) || 500,
    requestTokenCount: estimatedInputTokens,
    sessionMessageCount: messageCount,
    modelContextLimit: maxLimit,
    stackTrace: error?.stack,
  };
  warn(`[Structured Error Diagnostic]`, JSON.stringify(structuredDiagnostic, null, 2));

  if (res.headersSent) {
    writeStreamError(res, model, error?.message || 'Upstream connection interrupted');
    return;
  }
  if (error.response) {
    await logResponse(res, error.response.status, error.response.data, responseTime);
    res.status(error.response.status).json(error.response.data);
  } else if (error.statusCode) {
    const errorResponse = {
      error: {
        message: error.message,
        type: 'invalid_request_error',
        details: structuredDiagnostic,
      },
    };
    await logResponse(res, error.statusCode, errorResponse, responseTime);
    res.status(error.statusCode).json(errorResponse);
  } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ECONNRESET') {
    const errorResponse = {
      error: {
        message: 'Upstream service unavailable',
        type: 'upstream_error',
        details: structuredDiagnostic,
      },
    };
    await logResponse(res, 502, errorResponse, responseTime);
    res.status(502).json(errorResponse);
  } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    const errorResponse = {
      error: {
        message: 'Upstream service timeout',
        type: 'upstream_error',
        details: structuredDiagnostic,
      },
    };
    await logResponse(res, 504, errorResponse, responseTime);
    res.status(504).json(errorResponse);
  } else {
    const errorResponse = {
      error: {
        message: error.message || 'Internal proxy error',
        type: 'internal_error',
        details: structuredDiagnostic,
      },
    };
    await logResponse(res, 500, errorResponse, responseTime);
    res.status(500).json(errorResponse);
  }
}
