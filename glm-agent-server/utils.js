import { appendFile, stat, unlink, rename, readdir, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

const LOG_DIR = 'logs';
await mkdir(LOG_DIR, { recursive: true });

// Log file paths (organized in dedicated logs/ directory)
const LOG_FILE_PATHS = {
  requests: 'logs/requests.log',
  server: 'logs/server.log',
};

// Log rotation configuration
const MAX_LOG_SIZE = (parseInt(process.env.MAX_LOG_SIZE, 10) || 50) * 1024 * 1024;
const MAX_LOG_FILES = parseInt(process.env.MAX_LOG_FILES, 10) || 5;

export function delayMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export async function rotateLogIfNeeded(logFile) {
  try {
    const stats = await stat(logFile);
    const fileSize = stats.size;

    if (fileSize > MAX_LOG_SIZE) {
      const timestamp = new Date().toISOString().split('T')[0];
      await rename(logFile, `${logFile}.${timestamp}`);

      await appendFile(logFile, '', 'utf8');

      await cleanupOldArchives(logFile, MAX_LOG_FILES);

      warn('Log rotation', `Rotated ${logFile} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
      return true;
    }
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      error('Log rotation error', error.message);
    }
    return false;
  }
}

async function cleanupOldArchives(logFile, maxFiles) {
  try {
    const logDir = dirname(logFile);
    const logBase = logFile.split('/').pop();
    const allFiles = await readdir(logDir);

    const logFiles = allFiles.filter(file =>
      file.startsWith(logBase + '.') &&
      file !== logBase
    ).map(file => join(logDir, file));

    if (logFiles.length <= maxFiles) {
      return;
    }

    const fileStats = await Promise.all(
      logFiles.map(async file => {
        const stats = await stat(file);
        return { file, mtime: stats.mtime };
      })
    );

    const sortedFiles = fileStats
      .sort((a, b) => b.mtime - a.mtime)
      .slice(maxFiles);

    for (const { file } of sortedFiles) {
      await unlink(file);
    }
  } catch (error) {
    error('Log cleanup error', error.message);
  }
}

export function shouldLog(level) {
  return LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL];
}

export function debug(...args) {
  if (shouldLog('debug')) {
    console.debug(`[DEBUG] ${new Date().toISOString()}`, ...args);
  }
}

export function info(...args) {
  if (shouldLog('info')) {
    console.log(`[INFO] ${new Date().toISOString()}`, ...args);
  }
}

export function warn(...args) {
  if (shouldLog('warn')) {
    console.warn(`[WARN] ${new Date().toISOString()}`, ...args);
  }
}

export function error(...args) {
  if (shouldLog('error')) {
    console.error(`[ERROR] ${new Date().toISOString()}`, ...args);
  }
}

export function formatError(error, context = {}) {
  const errorData = {
    timestamp: new Date().toISOString(),
    type: error.constructor.name,
    message: error.message,
    code: error.code,
    stack: error.stack,
  };

  if (error.response) {
    errorData.statusCode = error.response.status;
    errorData.statusText = error.response.statusText;
    errorData.data = error.response.data;
  }

  if (Object.keys(context).length > 0) {
    errorData.context = context;
  }

  return errorData;
}

export async function logRequest(req, responseTime = 0) {
  // Rotate log if needed (only checks size if file is already large)
  await rotateLogIfNeeded(LOG_FILE_PATHS.requests);
  
  const logData = {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    query: req.query,
    headers: {
      'content-type': req.headers['content-type'],
      'authorization': req.headers['authorization'] ? '[REDACTED]' : undefined,
    },
    body: req.body,
    responseTime: responseTime,
  };

  info('Request', logData);

  const logEntry = JSON.stringify(logData) + '\n';
  await appendFile(LOG_FILE_PATHS.requests, logEntry, 'utf8');

  return logData;
}

export async function logResponse(res, statusCode, responseData, responseTime = 0) {
  // Rotate log if needed (only checks size if file is already large)
  await rotateLogIfNeeded(LOG_FILE_PATHS.requests);
  
  const logData = {
    timestamp: new Date().toISOString(),
    statusCode: statusCode,
    headers: {
      'content-type': res.get('content-type'),
    },
    body: sanitizeObject(responseData),
    responseTime: responseTime,
  };

  info('Response', logData);

  const logEntry = JSON.stringify(logData) + '\n';
  await appendFile(LOG_FILE_PATHS.requests, logEntry, 'utf8');

  return logData;
}

export function logRequestDetails(model, messages, hasTools) {
  const logData = {
    timestamp: new Date().toISOString(),
    model: model,
    messageCount: messages.length,
    hasTools: hasTools,
    messages: messages.map(m => ({
      role: m.role,
      contentLength: m.content?.length || 0,
    })),
  };

  const logEntry = JSON.stringify(logData, null, 2);
  console.log(logEntry);

  return logData;
}

export function logProviderResponse(response, providerType) {
  const logData = {
    timestamp: new Date().toISOString(),
    provider: providerType,
    statusCode: response.status,
    statusText: response.statusText,
    data: {
      model: response.data.model,
      choices: response.data.choices?.map(c => ({
        index: c.index,
        finishReason: c.finish_reason,
        contentLength: c.message?.content?.length || 0,
      })),
      usage: response.data.usage,
    },
  };

  info(`${providerType} Response`, logData);

  return logData;
}

export function logError(errObject, context = {}) {
  const logData = formatError(errObject, context);
  error('Error', logData);

  return logData;
}

export function formatChatCompletionResponse(data, model) {
  const aiResponse = data.choices[0]?.message?.content || '';

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || model || 'gpt-3.5-turbo',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: aiResponse,
      },
      finish_reason: data.choices[0]?.finish_reason || 'stop',
    }],
    usage: data.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function formatSSEChunk(chunk, id, model, finishReason = null) {
  const delta = { ...chunk };

  const sseData = {
    id: id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: delta,
      finish_reason: finishReason,
    }],
  };

  return `data: ${JSON.stringify(sseData)}\n\n`;
}

export function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export function truncateString(str, maxLength = 100) {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

export function sanitizeObject(obj, keysToRedact = ['password', 'token', 'api_key']) {
  if (!obj || typeof obj !== 'object') return obj;

  const sanitized = { ...obj };

  Object.keys(sanitized).forEach(key => {
    if (keysToRedact.some(redactKey => key.toLowerCase().includes(redactKey))) {
      sanitized[key] = '[REDACTED]';
    } else if (key === 'content' && typeof sanitized[key] === 'string' && sanitized[key].length > 200) {
      sanitized[key] = sanitized[key].substring(0, 200) + '...[TRUNCATED]';
    } else if (typeof sanitized[key] === 'object') {
      sanitized[key] = sanitizeObject(sanitized[key], keysToRedact);
    }
  });

  return sanitized;
}
