import axios from 'axios';
import { Agent } from 'https';
import { BaseProvider } from './base-provider.js';
import { injectToolsIntoSystem } from '../tools.js';
import { formatChatCompletionResponse } from '../utils.js';
import { summarizeIfNeeded } from '../summarizer.js';
import { compressConversationHistory, compressToolMetadata } from '../prompt-optimizer.js';

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
      apiKey: config.STRAICO_API_KEY || 'zai-local-key',
      apiUrl: config.STRAICO_API_URL || 'http://localhost:8001/v1',
      timeout: parseInt(config.STRAICO_API_TIMEOUT) || 300000,
    };
  }

  getType() {
    return 'straico';
  }

  getName() {
    return 'straico';
  }

  validateConfig() {
    if (!this.config.apiKey) {
      throw new Error('STRAICO_API_KEY is required');
    }
    return true;
  }

  async transformRequest(openAIRequest) {
    const { messages, model, tools, isToolRequest, ...otherParams } = openAIRequest;

    const useSmartSelector = !model || model === 'auto';
    const maskedMessages = compressConversationHistory(messages);
    let processedMessages = injectToolsIntoSystem(maskedMessages, tools);

    const summarizationResult = await summarizeIfNeeded(processedMessages, model);
    processedMessages = summarizationResult.messages;

    const toolResultMaxLength = parseInt(process.env.TOOL_RESULT_MAX_LENGTH) || 10000;
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

    const compactTools = compressToolMetadata(tools);

    if (useSmartSelector) {
      return {
        model: 'glm-5.2',
        messages: processedMessages,
        tools: compactTools,
      };
    }

    const straicoRequest = {
      model: model,
      messages: processedMessages,
      tools: compactTools,
    };

    if (otherParams.temperature !== undefined) {
      straicoRequest.temperature = otherParams.temperature;
    } else {
      straicoRequest.temperature = 0.3;
    }

    if (otherParams.max_tokens !== undefined) {
      straicoRequest.max_tokens = otherParams.max_tokens;
    }

    return straicoRequest;
  }

  async makeRequest(request) {
    const url = `${this.config.apiUrl}/chat/completions`;
    const requestSize = JSON.stringify(request).length;
    const estimatedTokens = Math.ceil(requestSize / 4);

    console.log(`[StraicoProvider] Calling Upstream: ${url} with model: ${request.model} (~${estimatedTokens} tokens)`);

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
