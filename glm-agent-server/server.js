import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { ProviderFactory } from './providers/index.js';
import { simulateStream, streamToolCalls } from './streaming.js';
import { formatToolCallResponse } from './tools.js';
import {
  logRequest,
  logResponse,
  logRequestDetails,
  logProviderResponse,
  logError,
  generateRequestId,
  info,
  warn,
  error as logErrorFn,
  debug,
} from './utils.js';
import {
  validateRequestBody,
  validateProviderResponse,
  extractToolCalls,
  handleUpstreamError,
  setSSEHeaders,
  writeStreamError,
} from './request-handlers.js';
import {
  MODEL_LIMITS,
  fetchModelLimits,
} from './utils/model-limits.js';

dotenv.config();

const AUTH_MODES = {
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  DISABLED: 'disabled',
  EXTERNAL: 'external'
};

const PROVIDER_TYPE = process.env.PROVIDER_TYPE || 'straico';
const AUTH_MODE = process.env.AUTH_MODE || AUTH_MODES.DISABLED;
const PROXY_API_KEY = process.env.PROXY_API_KEY;
const NODE_ENV = process.env.NODE_ENV || 'development';

let provider;
try {
  provider = ProviderFactory.create(PROVIDER_TYPE, process.env);
  provider.validateConfig();
} catch (error) {
  console.error(`FATAL: Provider configuration invalid: ${error.message}`);
  process.exit(1);
}

const app = express();
const PORT = parseInt(process.env.PROXY_PORT, 10) || 3000;
const SECONDARY_PORT = parseInt(process.env.SECONDARY_PORT || '0', 10);

app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  const requestId = generateRequestId();
  res.setHeader('X-Request-ID', requestId);
  res.locals.requestStartTime = Date.now();
  next();
});

app.get(['/health', '/v1/health'], async (req, res) => {
  res.json({
    status: 'ok',
    service: 'doai-proxy',
    ports: [PORT, SECONDARY_PORT],
    timestamp: new Date().toISOString()
  });
});

app.get(['/v1/models', '/models'], (req, res) => {
  const defaultModels = [
    { id: 'glm-5.2', name: 'GLM-5.2 (Z.ai Agent)', object: 'model', owned_by: 'z.ai' },
    { id: 'glm-5.3', name: 'GLM-5.3 (Z.ai Agent)', object: 'model', owned_by: 'z.ai' },
    { id: 'x-preview-l', name: 'X-Preview-L', object: 'model', owned_by: 'z.ai' },
    { id: 'glm-4.7', name: 'GLM-4.7', object: 'model', owned_by: 'z.ai' },
    { id: 'glm-4-plus', name: 'GLM-4-Plus', object: 'model', owned_by: 'z.ai' },
  ];
  res.json({ object: 'list', data: defaultModels });
});

function isAuxiliaryTitleRequest(body) {
  if (!body || !Array.isArray(body.messages)) return false;
  if (body.response_format?.json_schema?.name === 'session_title') return true;
  for (const m of body.messages) {
    if (typeof m.content === 'string' && m.content.includes('You name chat sessions.')) {
      return true;
    }
  }
  return false;
}

app.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
  const requestId = res.getHeader('X-Request-ID') || 'unknown';
  const startTime = Date.now();
  let heartbeatTimer = null;

  try {
    const { messages, model = 'glm-5.2', ...otherParams } = req.body;

    // Fast-path for Hermes Desktop background session title generation (prevents 30s timeouts and queue collisions)
    if (isAuxiliaryTitleRequest(req.body)) {
      const titleJson = JSON.stringify({ title: 'Fadak Office Motion Project' });
      const streamId = `chatcmpl-${Date.now()}`;
      if (req.body.stream) {
        setSSEHeaders(res);
        res.write(`data: ${JSON.stringify({
          id: streamId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: titleJson }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: streamId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      } else {
        return res.json({
          id: streamId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: titleJson }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        });
      }
    }

    const incomingSize = JSON.stringify(req.body).length;
    const incomingEstimatedTokens = Math.ceil(incomingSize / 4);
    info(`[Incoming Request] Model: ${model}, Size: ${incomingSize} chars (~${incomingEstimatedTokens} tokens), Messages: ${messages?.length ?? 0}, Tools: ${req.body.tools?.length ?? 0}`);

    const validationError = validateRequestBody({ ...req.body, model });
    if (validationError) {
      return res.status(validationError.status).json(validationError.error);
    }

    // Start SSE stream and heartbeat immediately so Hermes Desktop never hits the 60s stale watchdog
    const streamId = `chatcmpl-${Date.now()}`;
    if (req.body.stream) {
      setSSEHeaders(res);
      res.write(`data: ${JSON.stringify({
        id: streamId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      })}\n\n`);

      heartbeatTimer = setInterval(() => {
        try {
          // Send active SSE data chunk so Hermes Desktop stream activity watchdog never counts 60s idle
          res.write(`data: ${JSON.stringify({
            id: streamId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: null }]
          })}\n\n`);
        } catch (e) {}
      }, 3000);
    }

    const providerRequest = await provider.transformRequest({
      model,
      messages,
      tools: req.body.tools,
      ...otherParams,
      isToolRequest: true,
    });

    const providerResponse = await provider.makeRequestWithRetry(providerRequest);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    validateProviderResponse(providerResponse);

    let aiResponse = providerResponse.data.choices[0].message.content || '';

    const validToolCalls = extractToolCalls(aiResponse, req.body.tools);

    if (validToolCalls) {
      const toolResponse = formatToolCallResponse(validToolCalls);

      if (req.body.stream) {
        setSSEHeaders(res);
        try {
          await streamToolCalls(validToolCalls, res, toolResponse.id, model);
          res.write('data: [DONE]\n\n');
          res.end();

          const responseTime = Date.now() - startTime;
          info(`[Request Complete] ${requestId} - ${responseTime}ms - Official tool_calls streamed (${validToolCalls.map(t => t.function.name).join(', ')})`);
          return;
        } catch (streamError) {
          logErrorFn('Failed to stream tool_calls:', streamError);
          writeStreamError(res, model);
          return;
        }
      } else {
        return res.json(toolResponse);
      }
    }

    if (aiResponse === '.' && req.body.tools) {
      aiResponse = '';
    }

    // If model emitted <<<clarify:{...}>>> in a session without clarify tool, format cleanly as Markdown
    if (aiResponse.includes('<<<clarify:')) {
      aiResponse = aiResponse.replace(/<<<\s*clarify\s*:\s*(\{[\s\S]*?\})\s*>+/gi, (_, jsonStr) => {
        try {
          const parsed = JSON.parse(jsonStr);
          const q = parsed.question || '';
          const choices = Array.isArray(parsed.choices) ? parsed.choices.map((c, i) => `${i + 1}. ${c}`).join('\n') : '';
          return choices ? `${q}\n\n${choices}` : q;
        } catch {
          return '';
        }
      });
    }

    if (req.body.stream) {
      setSSEHeaders(res);
      try {
        await simulateStream(aiResponse, res, {
          chunkSize: parseInt(process.env.STREAM_CHUNK_SIZE) || 30,
          delay: parseInt(process.env.STREAM_DELAY_MS) || 15,
        });
        const responseTime = Date.now() - startTime;
        info(`[Request Complete] ${requestId} - ${responseTime}ms - Text streaming complete`);
        return;
      } catch (streamError) {
        logErrorFn('Streaming error:', streamError);
        writeStreamError(res, model);
        return;
      }
    } else {
      const response = provider.transformResponse(providerResponse);
      return res.json(response);
    }
  } catch (error) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    const responseTime = Date.now() - startTime;
    logErrorFn(`[Error Processing Request] ${requestId}: ${error.message}`);
    await handleUpstreamError(error, res, responseTime);
  }
});

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 DOAI-Proxy Middleware Active on http://localhost:${PORT}/v1`);
  console.log(`   - tools.js: Tool Injection & Parsing ENABLED`);
  console.log(`   - streaming.js: Official OpenAI delta.tool_calls Stream Interception ENABLED`);
  console.log('='.repeat(60));
});

if (SECONDARY_PORT && SECONDARY_PORT !== PORT) {
  app.listen(SECONDARY_PORT, () => {
    console.log(`🚀 DOAI-Proxy Mirror Port Active on http://localhost:${SECONDARY_PORT}/v1`);
  });
}
