import axios from 'axios';
import { getModelLimits } from './utils/model-limits.js';

const SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summarizer for a coding assistant session.

Produce a concise but thorough summary of the conversation that preserves:

1. **Key decisions and their rationale** — what was decided and why
2. **File paths and locations** — every file that was read, edited, or discussed (preserve exact paths)
3. **Code changes** — function signatures, variable names, class names, and any code that was written or modified (preserve exact identifiers)
4. **Error states and resolutions** — error messages encountered and how they were resolved
5. **Current task state** — what was being worked on most recently, what's done, what's pending
6. **Important context** — environment details, constraints, user preferences mentioned

Rules:
- Preserve file paths, variable names, function names, and error messages EXACTLY as they appeared — do not paraphrase these
- Be specific, not generic. "Changed handleAuth() in src/middleware.js to validate tokens before checking permissions" is good. "Made some changes to authentication" is bad.
- If code was discussed, include the key snippets verbatim
- Order information chronologically
- Keep the summary under 2000 tokens`;

const MIN_SAVINGS_PCT = 0.3;
const MIN_CANDIDATES = 3;
const DEFAULT_THRESHOLD_PCT = 70;
const DEFAULT_KEEP_MESSAGES = 10;
const DEFAULT_TIMEOUT = 15000;
const CHARS_PER_TOKEN = 4;

function estimateTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / CHARS_PER_TOKEN);
}

function shouldSummarize(messages, modelId) {
  if (process.env.SUMMARIZATION_ENABLED !== 'true') {
    return { shouldSummarize: false };
  }

  const modelInfo = getModelLimits(modelId);
  if (!modelInfo) {
    return { shouldSummarize: false };
  }

  const tokenEstimate = estimateTokens(messages);
  const thresholdPct = parseInt(process.env.SUMMARIZATION_THRESHOLD_PCT) || DEFAULT_THRESHOLD_PCT;
  const threshold = Math.floor(modelInfo.word_limit * (thresholdPct / 100));

  if (tokenEstimate < threshold) {
    return { shouldSummarize: false };
  }

  const keepCount = parseInt(process.env.SUMMARIZATION_KEEP_MESSAGES) || DEFAULT_KEEP_MESSAGES;
  const nonSystemMessages = messages.filter(m => m.role !== 'system');
  const candidateCount = nonSystemMessages.length - keepCount;

  if (candidateCount < MIN_CANDIDATES) {
    return { shouldSummarize: false };
  }

  const savingsPct = 1 - (keepCount / nonSystemMessages.length);
  if (savingsPct < MIN_SAVINGS_PCT) {
    return { shouldSummarize: false };
  }

  return {
    shouldSummarize: true,
    tokenEstimate,
    modelLimit: modelInfo.word_limit,
    threshold,
    candidateCount,
    keepCount,
  };
}

function splitMessages(messages, keepCount) {
  const systemMessages = [];
  const nonSystemMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessages.push(msg);
    } else {
      nonSystemMessages.push(msg);
    }
  }

  const splitIndex = Math.max(0, nonSystemMessages.length - keepCount);
  return {
    systemMessages,
    candidates: nonSystemMessages.slice(0, splitIndex),
    recentMessages: nonSystemMessages.slice(splitIndex),
  };
}

async function makeSummaryRequest(candidateMessages) {
  const apiUrl = process.env.STRAICO_API_URL || 'https://api.straico.com/v2';
  const apiKey = process.env.STRAICO_API_KEY;
  const timeout = parseInt(process.env.SUMMARIZATION_TIMEOUT) || DEFAULT_TIMEOUT;
  const summarizationModel = process.env.SUMMARIZATION_MODEL;

  const useSmartSelector = !summarizationModel || summarizationModel === 'auto';

  const summaryMessages = [
    { role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT },
    ...candidateMessages,
  ];

  const request = useSmartSelector
    ? {
      smart_llm_selector: { quantity: 1, pricing_method: 'balance' },
      messages: summaryMessages,
    }
    : {
      model: summarizationModel,
      messages: summaryMessages,
      temperature: 0.3,
    };

  console.log(`[Summarizer] Calling API for summarization (model: ${useSmartSelector ? 'smart_llm_selector' : summarizationModel}, candidates: ${candidateMessages.length})`);

  const response = await axios.post(
    `${apiUrl}/chat/completions`,
    request,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout,
    }
  );

  return response.data.choices[0].message.content;
}

export async function summarizeIfNeeded(messages, modelId) {
  const decision = shouldSummarize(messages, modelId);

  if (!decision.shouldSummarize) {
    return { messages, wasSummarized: false };
  }

  console.log(`[Summarizer] Threshold exceeded: ~${decision.tokenEstimate} tokens / ${decision.modelLimit} limit (${decision.candidateCount} candidates to summarize)`);

  const { systemMessages, candidates, recentMessages } = splitMessages(messages, decision.keepCount);

  if (candidates.length < MIN_CANDIDATES) {
    return { messages, wasSummarized: false };
  }

  try {
    const summary = await makeSummaryRequest(candidates);

    const summaryMessage = {
      role: 'user',
      content: `[Conversation Summary - earlier messages condensed]:\n${summary}`,
    };

    const result = [...systemMessages, summaryMessage, ...recentMessages];
    const newTokenEstimate = estimateTokens(result);

    console.log(`[Summarizer] Summarized ${candidates.length} messages into 1 summary. ` +
      `${messages.length} → ${result.length} messages. ` +
      `~${decision.tokenEstimate} → ~${newTokenEstimate} tokens (saved ~${decision.tokenEstimate - newTokenEstimate})`);

    return { messages: result, wasSummarized: true };
  } catch (error) {
    console.warn(`[Summarizer] Summarization failed: ${error.message}. Sending full message history.`);
    return { messages, wasSummarized: false };
  }
}

export { shouldSummarize, splitMessages, estimateTokens };
