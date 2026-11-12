import axios from 'axios';
import { Agent } from 'https';
import { BaseProvider } from './base-provider.js';
import { injectToolsIntoSystem } from '../tools.js';
import { formatChatCompletionResponse } from '../utils.js';
import { summarizeIfNeeded } from '../summarizer.js';
import { compressConversationHistory, compressToolMetadata } from '../prompt-optimizer.js';

const DEFAULT_KIMI_TOKEN = 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhY2NvdW50IiwiYXVkIjpbImtpbWkuYWkiXSwiZXhwIjoxODAyMDE5MTUzLCJpYXQiOjE3OTQyNDMxNTMsImp0aSI6ImRib3Zra2I0bDlhOW8zMHRqNHMwIiwidHlwIjoicmVmcmVzaCIsImFwcF9pZCI6ImtpbWkiLCJzdWIiOiJkODJoNXZrbnZqNGpoa2Zka2FhZyIsImFic3RyYWN0X3VzZXJfaWQiOiJkODJoNXZjbnZqNGpoa2ZkanZrMCIsImRldmljZV9pZCI6Ijc3MDYyMTU2MDczNzIzNzU1NTQiLCJyZWdpb24iOiJvdmVyc2VhcyIsIm1lbWJlcnNoaXAiOnsibGV2ZWwiOjEwfSwiY29kZV9tZW1iZXJzaGlwIjp7ImxldmVsIjoxMH19.XCCpYFc0pr6HJa4Fv0heUXzeigR14aYi9w9FH3H9QcKvDrqr9g0r6QPLYsTPIIz750KkLTQ9EwZXXRDR2UUKQg';

const httpsAgent = new Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 120000,
});

export class StraicoProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.config = {
      apiKey: config.STRAICO_API_KEY || DEFAULT_KIMI_TOKEN,
      apiUrl: config.STRAICO_API_URL || 'http://localhost:8000/v1',
      timeout: parseInt(config.STRAICO_API_TIMEOUT, 10) || 80000,
    };
  }

  getType() {
    return 'straico';
  }

  getName() {
    return 'kimi';
  }

  validateConfig() {
    if (!this.config.apiKey) {
      throw new Error('STRAICO_API_KEY (Kimi JWT token) is required');
    }
    return true;
  }

  async transformRequest(openAIRequest) {
    const { messages, model, tools, isToolRequest, ...otherParams } = openAIRequest;

    const useSmartSelector = !model || model === 'auto';
    // Apply Observation Masking first so massive 80+ turn histories shrink by ~85% before tool injection
    const maskedMessages = compressConversationHistory(messages);
    let processedMessages = injectToolsIntoSystem(maskedMessages, tools);

    const summarizationResult = await summarizeIfNeeded(processedMessages, model);
    processedMessages = summarizationResult.messages;

    const toolResultMaxLength = parseInt(process.env.TOOL_RESULT_MAX_LENGTH, 10) || 10000;
    const hasToolResultLimit = !isNaN(toolResultMaxLength) && toolResultMaxLength > 0;

    if (isToolRequest) {
      const enhancedMessages = [];

      for (let i = 0; i < processedMessages.length; i++) {
        const msg = processedMessages[i];

        if (msg.role === 'tool') {
          const toolResult = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);

          const trimmed = hasToolResultLimit && toolResult.length > toolResultMaxLength
            ? `${toolResult.substring(0, toolResultMaxLength)}\n[TRUNCATED]`
            : toolResult;

          enhancedMessages.push({
            role: 'user',
            content: `Tool output:\n${trimmed}\n\nNext: <<<tool_name:{"param":"value"}>>> or final response.`
          });
          continue;
        }

        if (msg.role === 'assistant' && (!msg.content || msg.content.trim() === '')) {
          continue;
        }

        enhancedMessages.push(msg);
      }

      processedMessages = enhancedMessages;

      if (processedMessages.length === 0) {
        const error = new Error('No messages remaining after filtering tool and empty assistant messages');
        error.statusCode = 400;
        throw error;
      }
    }

    const resolvedModel = useSmartSelector ? 'kimi-latest' : model;
    const compactTools = compressToolMetadata(tools);

    const kimiRequest = {
      model: resolvedModel,
      messages: processedMessages,
      tools: compactTools,
      isToolRequest: Boolean(isToolRequest),
    };

    if (otherParams.temperature !== undefined) {
      kimiRequest.temperature = otherParams.temperature;
    } else {
      kimiRequest.temperature = 0.2;
    }

    if (otherParams.max_tokens !== undefined) {
      kimiRequest.max_tokens = otherParams.max_tokens;
    }

    return kimiRequest;
  }

  async makeRequest(request) {
    const url = `${this.config.apiUrl}/chat/completions`;
    const requestSize = JSON.stringify(request).length;
    const estimatedTokens = Math.ceil(requestSize / 4);

    console.log(`[KimiProvider] Calling Kimi Upstream: ${url} with model: ${request.model} (~${estimatedTokens} tokens)`);

    const axiosConfig = {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: this.config.timeout,
    };

    if (url.startsWith('https://')) {
      axiosConfig.httpsAgent = httpsAgent;
    }

    const response = await axios.post(url, request, axiosConfig);
    return response;
  }

  transformResponse(providerResponse) {
    return formatChatCompletionResponse(providerResponse.data, providerResponse.data.model);
  }

  supportsStreaming() {
    return false;
  }

  supportsTools() {
    return false;
  }
}
