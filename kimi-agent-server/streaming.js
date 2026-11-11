import { delayMs } from './utils.js';

const STREAM_MODES = {
  NONE: 'none',
  SMART: 'smart',
};

function validateStreamMode(mode) {
  const validModes = Object.values(STREAM_MODES);
  const normalizedMode = mode ? mode.toLowerCase() : STREAM_MODES.NONE;

  if (!validModes.includes(normalizedMode)) {
    throw new Error(`Invalid STREAM_MODE: ${mode}. Must be one of: ${validModes.join(', ')}`);
  }

  if (normalizedMode === 'simple') {
    throw new Error('STREAM_MODE=simple has been removed. Use STREAM_MODE=none or STREAM_MODE=smart');
  }

  return normalizedMode;
}

async function simulateStreamNone(responseText, res) {
  if (typeof responseText !== 'string') {
    throw new Error('responseText must be a string');
  }

  const streamId = `chatcmpl-${Date.now()}`;

  if (!responseText) {
    const finalChunk = {
      id: streamId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'doai-proxy',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const sseData = {
    id: streamId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'doai-proxy',
    choices: [{
      index: 0,
      delta: { content: responseText },
      finish_reason: null,
    }],
  };

  res.write(`data: ${JSON.stringify(sseData)}\n\n`);

  const finalChunk = {
    id: streamId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'doai-proxy',
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'stop',
    }],
  };

  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function simulateStreamSmart(responseText, res, chunkSize = 15, delay = 80) {
  if (typeof responseText !== 'string') {
    throw new Error('responseText must be a string');
  }

  const streamId = `chatcmpl-${Date.now()}`;

  if (!responseText) {
    const finalChunk = {
      id: streamId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'doai-proxy',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const chunks = smartChunkText(responseText, chunkSize);

  for (const chunk of chunks) {
    await delayMs(delay);

    const sseData = {
      id: streamId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'doai-proxy',
      choices: [{
        index: 0,
        delta: { content: chunk },
        finish_reason: null,
      }],
    };

    res.write(`data: ${JSON.stringify(sseData)}\n\n`);
  }

  const finalChunk = {
    id: streamId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'doai-proxy',
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'stop',
    }],
  };

  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function smartChunkText(text, targetSize) {
  const chunks = [];
  const maxSize = targetSize * 10;
  let pos = 0;

  while (pos < text.length) {
    let endPos = Math.min(pos + targetSize, text.length);

    if (endPos === text.length) {
      chunks.push(text.substring(pos));
      break;
    }

    const safePos = findSafeBoundary(text, pos, endPos, maxSize);
    chunks.push(text.substring(pos, safePos));
    pos = safePos;
  }

  return chunks;
}

function findSafeBoundary(text, start, end, maxSize) {
  const markdownDelimiters = ['**', '__', '```', '`'];

  for (let i = end; i > start; i--) {
    if (text[i] === '\n') {
      return i + 1;
    }
  }

  for (const delim of markdownDelimiters) {
    const delimStart = text.indexOf(delim, start);
    if (delimStart !== -1 && delimStart < end) {
      const delimEnd = delimStart + delim.length;
      if (delimEnd > end) {
        const extendedPos = Math.min(delimEnd, text.length, start + maxSize);
        if (extendedPos > end) {
          return extendedPos;
        }
      }
    }
  }

  for (let i = end; i > start; i--) {
    if (text[i] === ' ' || text[i] === '\t') {
      return i + 1;
    }
  }

  const extendedEnd = Math.min(start + maxSize, text.length);
  for (let i = extendedEnd; i > end; i--) {
    if (text[i] === '\n') {
      return i + 1;
    }
  }

  for (const delim of markdownDelimiters) {
    const delimStart = text.indexOf(delim, start);
    if (delimStart !== -1 && delimStart < extendedEnd) {
      const delimEnd = delimStart + delim.length;
      if (delimEnd > extendedEnd) {
        return delimEnd;
      }
    }
  }

  for (let i = extendedEnd; i > end; i--) {
    if (text[i] === ' ' || text[i] === '\t') {
      return i + 1;
    }
  }

  return end;
}

export async function simulateStream(responseText, res, config = {}) {
  const { chunkSize = 15, delay = 80 } = config;

  const streamMode = validateStreamMode(process.env.STREAM_MODE);

  switch (streamMode) {
  case STREAM_MODES.NONE:
    return simulateStreamNone(responseText, res, delay);
  case STREAM_MODES.SMART:
    return simulateStreamSmart(responseText, res, chunkSize, delay);
  default:
    return simulateStreamNone(responseText, res, delay);
  }
}

export async function streamToolCalls(toolCalls, res, id, model) {
  if (!toolCalls || toolCalls.length === 0) {
    return;
  }

  console.log(`[StreamToolCalls] Starting to stream ${toolCalls.length} tool call(s)`);

  const initDelay = 20;
  const argsDelay = 10;
  const finalDelay = 20;

  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    console.log(`[StreamToolCalls] Tool ${i}: ${toolCall.function.name} (args length: ${toolCall.function.arguments.length})`);

    const initChunk = {
      tool_calls: [{
        index: i,
        id: toolCall.id,
        type: toolCall.type || 'function',
        function: {
          name: toolCall.function.name,
          arguments: '',
        },
      }],
    };

    await delayMs(initDelay);
    res.write(`data: ${JSON.stringify({
      id: id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        delta: initChunk,
        finish_reason: null,
      }],
    })}\n\n`);

    const args = toolCall.function.arguments;

    if (args.length > 0) {
      const argsChunk = {
        tool_calls: [{
          index: i,
          function: {
            arguments: args,
          },
        }],
      };

      await delayMs(argsDelay);
      res.write(`data: ${JSON.stringify({
        id: id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          delta: argsChunk,
          finish_reason: null,
        }],
      })}\n\n`);
      console.log(`[StreamToolCalls] Sent 1 argument chunk for tool ${i}`);
    }
  }

  console.log('[StreamToolCalls] Sending final chunk with finish_reason: \'tool_calls\'');

  const finalChunkData = {
    id: id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'tool_calls',
    }],
  };

  await delayMs(finalDelay);
  res.write(`data: ${JSON.stringify(finalChunkData)}\n\n`);
}
