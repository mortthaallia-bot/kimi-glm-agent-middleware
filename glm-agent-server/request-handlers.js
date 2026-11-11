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

export function writeStreamError(res, model) {
  const errorChunk = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'error',
    }],
  };
  res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
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

  const estimatedInputTokens = Math.ceil(JSON.stringify(messages).length / 3.5);
  const totalContextError = validateTotalContext(estimatedInputTokens, body.max_tokens, model);
  if (totalContextError) {
    return { error: totalContextError, status: 400 };
  }

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

export function extractToolCalls(aiResponse, tools) {
  if (!tools) return null;

  const toolCalls = parseToolCall(aiResponse, tools);
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

export async function handleUpstreamError(error, res, responseTime) {
  if (res.headersSent) {
    writeStreamError(res, 'glm-5.2');
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
      },
    };
    await logResponse(res, error.statusCode, errorResponse, responseTime);
    res.status(error.statusCode).json(errorResponse);
  } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ECONNRESET') {
    const errorResponse = {
      error: {
        message: 'Upstream service unavailable',
        type: 'upstream_error',
      },
    };
    await logResponse(res, 502, errorResponse, responseTime);
    res.status(502).json(errorResponse);
  } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    const errorResponse = {
      error: {
        message: 'Upstream service timeout',
        type: 'upstream_error',
      },
    };
    await logResponse(res, 504, errorResponse, responseTime);
    res.status(504).json(errorResponse);
  } else {
    const errorResponse = {
      error: {
        message: error.message,
        type: 'internal_error',
      },
    };
    await logResponse(res, 500, errorResponse, responseTime);
    res.status(500).json(errorResponse);
  }
}
