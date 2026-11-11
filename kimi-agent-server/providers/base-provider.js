import { delayMs, warn } from '../utils.js';

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']);

/**
 * BaseProvider - Abstract base class for all AI providers
 * 
 * All provider implementations must extend this class and implement
 * the required methods to provide OpenAI-compatible API functionality.
 * 
 * @abstract
 */
export class BaseProvider {
  /**
   * Constructor
   * @param {Object} config - Provider configuration (env vars)
   */
  constructor(config) {
    if (new.target === BaseProvider) {
      throw new Error('BaseProvider is abstract and cannot be instantiated directly');
    }
    this.config = config;
  }

  /**
   * Get provider type identifier
   * @returns {string} Provider type (e.g., "straico", "openai")
   */
  getType() {
    throw new Error('getType() must be implemented by subclass');
  }

  /**
   * Get provider instance name
   * @returns {string} Provider instance name
   */
  getName() {
    throw new Error('getName() must be implemented by subclass');
  }

  /**
   * Validate provider configuration
   * @throws {Error} If required configuration is missing
   * @returns {boolean} True if configuration is valid
   */
  validateConfig() {
    throw new Error('validateConfig() must be implemented by subclass');
  }

  /**
   * Transform OpenAI request to provider-specific format
   * @param {Object} openAIRequest - OpenAI-compatible request object
   * @returns {Promise<Object>} Provider-specific request object
   */
  // eslint-disable-next-line no-unused-vars
  transformRequest(openAIRequest) {
    throw new Error('transformRequest() must be implemented by subclass');
  }

  /**
   * Transform provider response to OpenAI-compatible format
   * @param {Object} providerResponse - Provider-specific response object
   * @returns {Object} OpenAI-compatible response object
   */
  // eslint-disable-next-line no-unused-vars
  transformResponse(providerResponse) {
    throw new Error('transformResponse() must be implemented by subclass');
  }

  /**
   * Make API call to provider
   * @param {Object} request - Provider-specific request object
   * @returns {Promise<Object>} Axios response object
   */
  // eslint-disable-next-line no-unused-vars
  async makeRequest(request) {
    throw new Error('makeRequest() must be implemented by subclass');
  }

  /**
   * Check if an error is retryable (transient network or upstream error)
   * @param {Error} error - The error to check
   * @returns {boolean} True if the error is retryable
   */
  _isRetryableError(error) {
    if (error.code && RETRYABLE_ERROR_CODES.has(error.code)) {
      return true;
    }
    if (error.response && RETRYABLE_STATUS_CODES.has(error.response.status)) {
      return true;
    }
    return false;
  }

  /**
   * Make an API request with automatic retry on transient failures.
   * Uses exponential backoff with jitter between retries.
   * @param {Object} request - Provider-specific request object
   * @returns {Promise<Object>} Axios response object
   */
  async makeRequestWithRetry(request) {
    const maxAttempts = parseInt(process.env.RETRY_MAX_ATTEMPTS) || 3;
    const baseDelayMs = parseInt(process.env.RETRY_BASE_DELAY_MS) || 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.makeRequest(request);
      } catch (error) {
        if (attempt === maxAttempts || !this._isRetryableError(error)) {
          throw error;
        }

        const baseDelay = baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.random() * baseDelayMs;
        const delay = baseDelay + jitter;

        const statusCode = error.response?.status || error.code || 'unknown';
        warn(`[Retry] Attempt ${attempt}/${maxAttempts} failed (${statusCode}), retrying in ${Math.round(delay)}ms...`);

        await delayMs(delay);
      }
    }
  }

  /**
   * Check if provider supports native streaming
   * @returns {boolean} True if provider has native streaming support
   */
  supportsStreaming() {
    throw new Error('supportsStreaming() must be implemented by subclass');
  }

  /**
   * Check if provider supports native function calling
   * @returns {boolean} True if provider has native function calling support
   */
  supportsTools() {
    throw new Error('supportsTools() must be implemented by subclass');
  }
}
