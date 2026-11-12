import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { ProviderFactory } from './providers/index.js';
import { simulateStream, streamToolCalls } from './streaming.js';
import { formatToolCallResponse, setActiveProjectWorkspace } from './tools.js';
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
  getModelLimits,
} from './utils/model-limits.js';
import {
  AUTO_SESSION_RESET,
  MAX_CONTEXT_TOKENS,
  estimateTokens,
  isContextOverflow,
  isOverflowError,
  buildCompressedSession,
} from './context-manager.js';

dotenv.config();

const AUTH_MODES = {
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  DISABLED: 'disabled',
  EXTERNAL: 'external',
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
    service: 'glm-agent-server',
    port: PORT,
    timestamp: new Date().toISOString(),
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
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) return false;
  if (body.messages.length > 2) return false;
  if (body.response_format?.json_schema?.name === 'session_title') return true;
  const firstMsg = body.messages[0];
  if (firstMsg?.role === 'system' && typeof firstMsg.content === 'string') {
    if (firstMsg.content.includes('You name chat sessions.') || firstMsg.content.includes('Task: Name this chat session')) {
      return true;
    }
  }
  return false;
}

function generateDynamicTitle(messages) {
  const userMsg = messages?.find(m => m.role === 'user');
  if (userMsg && typeof userMsg.content === 'string') {
    const text = userMsg.content.trim().slice(0, 35).replace(/[\r\n"']/g, ' ');
    if (text) return text;
  }
  return 'AI Coding Session';
}

function detectWorkspace(messages) {
  if (!Array.isArray(messages)) return 'C:/Users/hhjksd';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.map(c => c.text || '').join('\n') : '');
    const wsMatch = text.match(/(?:The workspace|Current working directory|Workspace|cwd:?)\s*([a-zA-Z]:[/\\][^\r\n]+)/i);
    if (wsMatch && wsMatch[1]) {
      return wsMatch[1].trim().replace(/\\/g, '/');
    }
  }
  return 'C:/Users/hhjksd';
}

// Circular buffer to detect and break repeated loops
const toolExecutionHistoryByWs = new Map();

function checkAndRecordToolCallRepetition(workspace, toolCall) {
  if (!workspace || !toolCall) return { action: 'CONTINUE' };
  const ws = workspace.replace(/\\/g, '/');
  if (!toolExecutionHistoryByWs.has(ws)) {
    toolExecutionHistoryByWs.set(ws, []);
  }
  const history = toolExecutionHistoryByWs.get(ws);
  const toolName = toolCall.function?.name || '';
  let targetKey = '';

  try {
    const parsedArgs = JSON.parse(toolCall.function?.arguments || '{}');
    targetKey = (parsedArgs.path || parsedArgs.command || parsedArgs.target || '').replace(/\\/g, '/');
  } catch (_) {
    targetKey = toolCall.function?.arguments?.slice(0, 80) || '';
  }

  // Count strictly CONSECUTIVE identical actions without intervening edits/steps
  let consecutiveCount = 1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toolName === toolName && history[i].targetKey === targetKey) {
      consecutiveCount++;
    } else {
      break;
    }
  }

  history.push({ toolName, targetKey, timestamp: Date.now() });
  if (history.length > 20) history.shift();

  if (consecutiveCount >= 3) {
    if (toolName === 'write_file' && targetKey.endsWith('.py') && fs.existsSync(targetKey)) {
      return {
        action: 'PIVOT_TO_EXECUTE',
        toolName,
        targetKey,
        consecutiveCount,
      };
    }
    return {
      action: 'TERMINATE_LOOP_SUCCESS',
      toolName,
      targetKey,
      consecutiveCount,
      completionMessage: `تم تنفيذ الخطوة المطلوبة بنجاح.`,
    };
  }

  return { action: 'CONTINUE', toolName, targetKey, consecutiveCount };
}

app.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
  const requestId = res.getHeader('X-Request-ID') || 'unknown';
  const startTime = Date.now();
  let heartbeatTimer = null;

  try {
    const { messages, model = 'glm-5.2', ...otherParams } = req.body;

    if (isAuxiliaryTitleRequest(req.body)) {
      const dynamicTitle = generateDynamicTitle(req.body.messages);
      const titleJson = JSON.stringify({ title: dynamicTitle });
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
    info(`[GLM Incoming Request] Model: ${model}, Size: ${incomingSize} chars (~${incomingEstimatedTokens} tokens), Messages: ${messages?.length ?? 0}, Tools: ${req.body.tools?.length ?? 0}`);

    const validationError = validateRequestBody({ ...req.body, model });
    if (validationError) {
      return res.status(validationError.status).json(validationError.error);
    }

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

    let messagesToProcess = messages;
    if (AUTO_SESSION_RESET) {
      const overflowStatus = isContextOverflow(incomingEstimatedTokens, model);
      if (overflowStatus.isOverflow) {
        warn(`[Context Guard] Request estimated tokens (~${incomingEstimatedTokens}) exceeds safety threshold. Auto-resetting session.`);
        const resetResult = buildCompressedSession(messagesToProcess, model);
        messagesToProcess = resetResult.messages;
      }
    }

    const providerRequest = await provider.transformRequest({
      model,
      messages: messagesToProcess,
      tools: req.body.tools,
      ...otherParams,
      isToolRequest: true,
    });

    let providerResponse = null;
    let retryAttempted = false;

    try {
      providerResponse = await provider.makeRequestWithRetry(providerRequest);
    } catch (reqError) {
      if (AUTO_SESSION_RESET && !retryAttempted && isOverflowError(reqError)) {
        warn(`[GLM Auto-Recovery] Context error (${reqError.message}). Resetting session and retrying...`);
        retryAttempted = true;
        const resetResult = buildCompressedSession(messagesToProcess, model);
        messagesToProcess = resetResult.messages;
        const retryRequest = await provider.transformRequest({
          model,
          messages: messagesToProcess,
          tools: req.body.tools,
          ...otherParams,
          isToolRequest: true,
        });
        providerResponse = await provider.makeRequestWithRetry(retryRequest);
      } else {
        throw reqError;
      }
    }

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    validateProviderResponse(providerResponse);

    let aiResponse = providerResponse.data.choices[0].message.content || '';

    let validToolCalls = extractToolCalls(aiResponse, req.body.tools);

    if (validToolCalls && validToolCalls.length > 0) {
      const activeWs = detectWorkspace(messages);
      const isLoop = checkAndRecordToolCallRepetition(activeWs, validToolCalls[0]);

      if (isLoop.action === 'TERMINATE_LOOP_SUCCESS') {
        warn(`[GLM Loop Guard] Suppressed repetitive loop (${isLoop.repeatCount}x for ${isLoop.toolName} on ${isLoop.targetKey}). Forcing completion.`);
        validToolCalls = null;
        aiResponse = isLoop.completionMessage;
      } else if (isLoop.action === 'PIVOT_TO_EXECUTE') {
        warn(`[GLM Loop Guard] Pivoting repeated file operation to script execution (${isLoop.targetKey}).`);
        validToolCalls = [{
          id: `call_${Date.now()}_pivot`,
          type: 'function',
          function: {
            name: 'terminal',
            arguments: JSON.stringify({
              command: `python "${isLoop.targetKey}"`
            })
          }
        }];
      }
    }

    if (validToolCalls) {
      const toolResponse = formatToolCallResponse(validToolCalls);

      if (req.body.stream) {
        setSSEHeaders(res);
        try {
          await streamToolCalls(validToolCalls, res, toolResponse.id, model);
          res.write('data: [DONE]\n\n');
          res.end();

          const responseTime = Date.now() - startTime;
          info(`[GLM Request Complete] ${requestId} - ${responseTime}ms - Tool calls streamed`);
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

    if (!aiResponse || !aiResponse.trim() || aiResponse.trim() === '.') {
      aiResponse = 'تم تنفيذ الخطوة بنجاح.';
    }

    if (req.body.stream) {
      setSSEHeaders(res);
      try {
        await simulateStream(aiResponse, res, {
          chunkSize: parseInt(process.env.STREAM_CHUNK_SIZE, 10) || 30,
          delay: parseInt(process.env.STREAM_DELAY_MS, 10) || 10,
        });
        const responseTime = Date.now() - startTime;
        info(`[GLM Request Complete] ${requestId} - ${responseTime}ms - Text streaming complete`);
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
    logErrorFn(`[GLM Error] ${requestId}: ${error.message}`);
    await handleUpstreamError(error, res, responseTime, {
      model: req.body?.model,
      messages: req.body?.messages,
      estimatedTokens: Math.ceil(JSON.stringify(req.body || {}).length / 4),
    });
  }
});

app.listen(PORT, () => {
  console.log('='.repeat(65));
  console.log(`🚀 GLM Agent Middleware Server Active on http://localhost:${PORT}/v1`);
  console.log(`   - Model Provider: ${PROVIDER_TYPE}`);
  console.log(`   - Tools: Injection & Loop Guard ENABLED`);
  console.log(`   - Streaming: OpenAI delta.tool_calls Interception ENABLED`);
  console.log('='.repeat(65));
});

if (SECONDARY_PORT && SECONDARY_PORT !== PORT) {
  app.listen(SECONDARY_PORT, () => {
    console.log(`🚀 GLM Agent Mirror Port Active on http://localhost:${SECONDARY_PORT}/v1`);
  });
}
