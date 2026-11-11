import { StraicoProvider } from './straico-provider.js';

/**
 * ProviderFactory - Factory for creating provider instances
 *
 * Instantiates the appropriate provider based on PROVIDER_TYPE
 */
export class ProviderFactory {
  /**
   * Create provider instance based on provider type
   * @param {string} providerType - Provider type (e.g., "straico", "openai")
   * @param {Object} env - Environment variables (process.env)
   * @returns {BaseProvider} Provider instance
   * @throws {Error} If provider type is unknown
   */
  static create(providerType, env) {
    const type = providerType?.toLowerCase() || 'straico';

    switch (type) {
    case 'straico':
      return new StraicoProvider(env);

    case 'openai':
      throw new Error('OpenAI provider is not implemented yet. Use PROVIDER_TYPE=straico');

    case 'anthropic':
      throw new Error('Anthropic provider is not implemented yet. Use PROVIDER_TYPE=straico');

    default:
      throw new Error(
        `Unknown provider type: ${providerType}. Supported: straico, openai (coming soon), anthropic (coming soon)`
      );
    }
  }
}
