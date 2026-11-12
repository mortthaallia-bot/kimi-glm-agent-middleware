import { getModelLimits } from './utils/model-limits.js';
import { warn, info, error as logError } from './utils.js';

export const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS, 10) || 80000;
export const AUTO_SESSION_RESET = process.env.AUTO_SESSION_RESET !== 'false';
export const RESET_KEEP_MESSAGES = parseInt(process.env.RESET_KEEP_MESSAGES, 10) || 3;
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(messages) {
  if (!messages || !Array.isArray(messages)) return 0;
  return Math.ceil(JSON.stringify(messages).length / CHARS_PER_TOKEN);
}

export function isContextOverflow(estimatedTokens, modelId) {
  const modelInfo = getModelLimits(modelId);
  const maxLimit = modelInfo ? modelInfo.word_limit : 128000;
  const safeThreshold = Math.min(MAX_CONTEXT_TOKENS, Math.floor(maxLimit * 0.75));

  return {
    isOverflow: estimatedTokens >= safeThreshold,
    estimatedTokens,
    safeThreshold,
    maxLimit,
  };
}

export function isOverflowError(err) {
  if (!err) return false;
  const msg = (err.message || String(err)).toLowerCase();
  return (
    msg.includes('context') ||
    msg.includes('token') ||
    msg.includes('too large') ||
    msg.includes('stalled before first token') ||
    msg.includes('concurrency_exceeded') ||
    msg.includes('rate_limit') ||
    msg.includes('maximum context length')
  );
}

export function extractSessionSummary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'No prior session context available.';
  }

  const userGoals = [];
  const filesTouched = new Set();
  const toolsExecuted = [];
  const errorStates = [];

  for (const m of messages) {
    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.map(c => c.text || '').join('\n') : '');

    if (m.role === 'user') {
      const clean = content
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
        .replace(/The workspace [^\r\n]+ exists but is empty\.?/gi, '')
        .replace(/(?:Current working directory|Workspace):\s*[^\r\n]+/gi, '')
        .trim();
      if (clean && !clean.startsWith('Tool output:') && clean.length > 5) {
        userGoals.push(clean.slice(0, 300));
      }
    }

    // Extract file paths from tools or text
    const pathMatches = content.matchAll(/(?:["'\s]|^)([a-zA-Z]:\/[^\s"'<>:\*\?\|]+|\.\/[^\s"'<>:\*\?\|]+|[a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]{1,6})(?:["'\s]|$)/g);
    for (const match of pathMatches) {
      const candidate = match[1].replace(/\\/g, '/');
      if (candidate.length > 3 && !candidate.includes('<') && !candidate.startsWith('http')) {
        filesTouched.add(candidate);
      }
    }

    if (m.role === 'assistant') {
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          toolsExecuted.push(`${tc.function.name}(${(tc.function.arguments || '').slice(0, 60)})`);
        }
      } else if (content.includes('<<<')) {
        const toolMatch = content.match(/<<<([a-zA-Z0-9_-]+):/);
        if (toolMatch) toolsExecuted.push(toolMatch[1]);
      }
    }

    if (content.toLowerCase().includes('error') || content.toLowerCase().includes('failed') || content.toLowerCase().includes('exit code 1')) {
      const line = content.split('\n').find(l => /error|failed|exit code/i.test(l));
      if (line) errorStates.push(line.trim().slice(0, 150));
    }
  }

  const primaryGoal = userGoals[userGoals.length - 1] || userGoals[0] || 'Autonomous task execution';
  const recentFiles = Array.from(filesTouched).slice(-8).join(', ') || 'None explicitly specified';
  const recentActions = toolsExecuted.slice(-6).join(' -> ') || 'Initial exploration';
  const recentErrors = errorStates.slice(-2).join(' | ') || 'None unresolved';

  return `### AUTO-SESSION RESET SUMMARY (Context Overflow Protection)
- **Primary Goal:** ${primaryGoal}
- **Files Touched / References:** ${recentFiles}
- **Recent Agent Operations:** ${recentActions}
- **Latest Status / Diagnostics:** ${recentErrors}
- **Continuity Instruction:** Context window was safely refreshed. Continue executing the task without interruption.`;
}

export function buildCompressedSession(messages, modelId) {
  const summaryText = extractSessionSummary(messages);

  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');
  const recent = nonSystemMsgs.slice(-RESET_KEEP_MESSAGES);

  const newMessages = [];
  if (systemMsg) {
    newMessages.push(systemMsg);
  }

  newMessages.push({
    role: 'user',
    content: summaryText,
  });

  for (const m of recent) {
    newMessages.push(m);
  }

  const originalTokens = estimateTokens(messages);
  const newTokens = estimateTokens(newMessages);

  info(`[Session Reset] Context compressed: ${messages.length} msgs (~${originalTokens} tokens) -> ${newMessages.length} msgs (~${newTokens} tokens). Saved ~${originalTokens - newTokens} tokens.`);

  return {
    messages: newMessages,
    originalTokens,
    newTokens,
    summaryText,
  };
}
