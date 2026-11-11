/**
 * Sync script to update opencode.json with valid Straico models
 *
 * This script:
 * 1. Fetches current models from Straico API
 * 2. Compares with existing opencode.json
 * 3. Updates the provider.straico section with valid models
 *
 * Usage:
 *   node scripts/sync-opencode-config.js
 */

import { readFile, writeFile } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fetchModelLimits, MODEL_LIMITS } from '../utils/model-limits.js';

/**
 * Load environment variables from .env file
 */
function loadEnvFile() {
  try {
    const envPath = join(process.cwd(), '.env');
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, 'utf-8');
      const lines = envContent.split('\n');
      for (const line of lines) {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = match[2];
        }
      }
    }
  } catch (error) {
    // Ignore errors, will fallback to process.env
  }
}

// Load .env file
loadEnvFile();

const STRAICO_API_KEY = process.env.STRAICO_API_KEY;
const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json');

async function fetchStraicoModels() {
  console.log('Fetching models from Straico API...');

  // Use shared model-limits module to fetch models
  await fetchModelLimits();

  // Access the MODEL_LIMITS cache from module
  const modelData = [];
  for (const [modelId, info] of Object.entries(MODEL_LIMITS)) {
    modelData.push({
      id: modelId,
      name: info.name,
      word_limit: info.word_limit,
      max_output: info.max_output,
      model_type: info.model_type,
      metadata: info.metadata,
    });
  }

  return modelData;
}

async function loadOpencodeConfig() {
  console.log(`Loading config from ${OPENCODE_CONFIG_PATH}...`);

  if (!existsSync(OPENCODE_CONFIG_PATH)) {
    return null;
  }

  const content = await readFile(OPENCODE_CONFIG_PATH, 'utf-8');
  return JSON.parse(content);
}

function updateConfigWithModels(config, models) {
  const validModels = {};

  for (const model of models) {
    if (model.model_type === 'chat') {
      validModels[model.id] = {
        name: model.name,
        limit: {
          context: model.word_limit,
          output: model.max_output,
        },
      };
    }
  }

  const options = config.provider?.straico?.options;

  // Build new config - only update the straico section, preserve everything else
  const newConfig = {
    ...config,
    provider: {
      ...config.provider,
      straico: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Straico',
        options: options || { baseURL: 'http://localhost:8000/v1' },
        models: validModels
      }
    }
  };

  return newConfig;
}

function formatConfig(config) {
  // Preserve original structure - use JSON.stringify with spacing
  return JSON.stringify(config, null, 2) + '\n';
}

async function saveConfig(config) {
  console.log(`Saving config to ${OPENCODE_CONFIG_PATH}...`);
  const formatted = formatConfig(config);
  await writeFile(OPENCODE_CONFIG_PATH, formatted, 'utf-8');
}

function compareModels(oldModels, newModels) {
  const oldIds = new Set(Object.keys(oldModels));
  const newIds = new Set(Object.keys(newModels));

  const added = [...newIds].filter(id => !oldIds.has(id));
  const removed = [...oldIds].filter(id => !newIds.has(id));

  return { added, removed };
}

async function main() {
  try {
    console.log('=== Opencode Config Sync ===\n');

    if (!STRAICO_API_KEY) {
      console.log('STRAICO_API_KEY not set, skipping config sync.');
      return;
    }

    // Load existing config
    const existingConfig = await loadOpencodeConfig();

    if (!existingConfig) {
      console.log(`Config file not found at ${OPENCODE_CONFIG_PATH}`);
      console.log('Skipping config sync.');
      return;
    }

    const existingModels = existingConfig.provider?.straico?.models || {};

    // Fetch current models from API
    const apiModels = await fetchStraicoModels();
    console.log(`Found ${apiModels.length} models from Straico API`);

    // Update config - only update the straico section
    const newConfig = updateConfigWithModels(existingConfig, apiModels);
    const newModels = newConfig.provider.straico.models;

    // Compare changes
    const { added, removed } = compareModels(existingModels, newModels);

    console.log('\nModel Changes:');
    console.log(`  Added: ${added.length} models`);
    if (added.length > 0) {
      added.forEach(id => console.log(`    + ${id}`));
    }
    console.log(`  Removed: ${removed.length} models`);
    if (removed.length > 0) {
      removed.forEach(id => console.log(`    - ${id}`));
    }

    // Save updated config
    await saveConfig(newConfig);

    console.log('\n✅ Config updated successfully!');
    console.log(`   Total models: ${Object.keys(newModels).length}`);

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
  }
}

main();
