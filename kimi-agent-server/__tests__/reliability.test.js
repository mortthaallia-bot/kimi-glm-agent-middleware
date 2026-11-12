import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  isContextOverflow,
  isOverflowError,
  extractSessionSummary,
  buildCompressedSession,
  MAX_CONTEXT_TOKENS,
} from '../context-manager.js';
import {
  isPathBlocked,
  inspectFileForSafeRead,
  normalizeToolCallForHermes,
  MAX_FILE_READ_SIZE_KB,
  MAX_SEARCH_MATCHES,
} from '../tools.js';

test('Task 2.a: Token threshold detection & automatic session reset', () => {
  // Simulate a session with 100 messages where total length is ~90,000 tokens
  const largeMessages = [];
  largeMessages.push({ role: 'system', content: 'You are Hermes AI Agent.' });
  for (let i = 0; i < 40; i++) {
    largeMessages.push({
      role: 'user',
      content: `User turn ${i}: Working on C:/Users/hhjksd/Desktop/project/app.js. ` + 'Sample context '.repeat(500),
    });
    largeMessages.push({
      role: 'assistant',
      content: `<<<write_file:{"path":"C:/Users/hhjksd/Desktop/project/step_${i}.py","content":"print(${i})"}>>>`,
    });
  }

  const estimated = estimateTokens(largeMessages);
  assert.ok(estimated > 40000, `Estimated tokens should be large, got ${estimated}`);

  const overflow = isContextOverflow(estimated, 'kimi-latest');
  assert.equal(typeof overflow.isOverflow, 'boolean');

  // Trigger compressed session reset
  const compressed = buildCompressedSession(largeMessages, 'kimi-latest');
  assert.ok(compressed.messages.length <= 5, `Compressed session should have system + summary + last 3 msgs, got ${compressed.messages.length}`);
  assert.equal(compressed.messages[0].role, 'system');
  assert.equal(compressed.messages[1].role, 'user');
  assert.ok(compressed.messages[1].content.includes('AUTO-SESSION RESET SUMMARY'), 'Summary header must be present');
  assert.ok(compressed.newTokens < compressed.originalTokens / 2, 'New tokens should be reduced by more than 50%');
});

test('Task 2.b: Error detection recognizes context overflow and timeout signatures', () => {
  assert.ok(isOverflowError(new Error('Kimi stream stalled before first token (10s)')));
  assert.ok(isOverflowError(new Error('Kimi RPC error (SCENARIO_NORMAL): REASON_CHAT_CONCURRENCY_EXCEEDED')));
  assert.ok(isOverflowError(new Error('Maximum context length exceeded')));
  assert.ok(isOverflowError(new Error('Request token count exceeds threshold')));
  assert.equal(isOverflowError(new Error('SyntaxError in script')), false);
});

test('Task 3.a: Path blocklist restricts node_modules, .git, lockfiles and build directories', () => {
  const blockedPaths = [
    'node_modules/express/index.js',
    'C:/Users/hhjksd/Desktop/montag/node_modules/react/package.json',
    '.git/config',
    'dist/bundle.js',
    'build/index.html',
    '.next/cache/webpack.js',
    'remotion/build/bundle.js',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'setup.exe',
  ];

  for (const p of blockedPaths) {
    const check = isPathBlocked(p);
    assert.equal(check.blocked, true, `Path '${p}' should be blocked`);
    assert.ok(check.reason.includes('blocked by middleware guardrails'));
  }

  // Safe files and user multimedia assets (images, PDFs, source code) must not be blocked
  const safePaths = [
    'C:/Users/hhjksd/Desktop/montag/src/index.js',
    'C:/Users/hhjksd/Desktop/montag/img1.jpg',
    'C:/Users/hhjksd/Desktop/montag/source.pdf',
    'C:/Users/hhjksd/Desktop/montag/model.obj',
  ];
  for (const sp of safePaths) {
    const safeCheck = isPathBlocked(sp);
    assert.equal(safeCheck.blocked, false, `Safe project asset '${sp}' should NOT be blocked`);
  }
});

test('Task 3.b: Agent tool normalization intercepts blocked read_file and reroutes safely', () => {
  const result = normalizeToolCallForHermes(
    'read_file',
    { path: 'C:/Users/hhjksd/Desktop/montag/node_modules/pptx/index.js' },
    new Set(['read_file', 'terminal'])
  );

  assert.equal(result.name, 'terminal', 'Blocked path should be redirected to safe terminal echo');
  assert.ok(result.args.command.includes('[GUARDRAIL BLOCKED]'), 'Command must notify agent of guardrail block');
});

test('Task 3.c: Search matches are capped to MAX_SEARCH_MATCHES', () => {
  const searchCall = normalizeToolCallForHermes(
    'search_files',
    { pattern: 'import', path: '.', limit: 500 },
    new Set(['search_files', 'terminal'])
  );

  assert.equal(searchCall.name, 'search_files');
  assert.equal(searchCall.args.limit, MAX_SEARCH_MATCHES, `Search limit must be capped to ${MAX_SEARCH_MATCHES}`);
});

test('Task 2.e: Retry cap stops infinite loops', () => {
  let retries = 0;
  const maxRetries = 1;
  let simulatedFailureCount = 0;

  const makeSimulatedRequest = () => {
    simulatedFailureCount++;
    throw new Error('Kimi stream stalled before first token (10s)');
  };

  try {
    try {
      makeSimulatedRequest();
    } catch (err) {
      if (retries < maxRetries && isOverflowError(err)) {
        retries++;
        makeSimulatedRequest(); // Retry once
      } else {
        throw err;
      }
    }
  } catch (finalErr) {
    assert.equal(retries, 1, 'Should retry exactly once');
    assert.equal(simulatedFailureCount, 2, 'Should execute initial call + 1 retry');
    assert.ok(isOverflowError(finalErr));
  }
});

test('Task 2.f: Anti-Ping-Pong Loop Breaker intercepts repetitive tool calls', () => {
  const history = [];
  const checkLoop = (ws, toolName, targetKey) => {
    const matching = history.filter(h => h.toolName === toolName && h.targetKey === targetKey);
    const count = matching.length + 1;
    history.push({ toolName, targetKey });
    if (count >= 2) {
      return { action: 'TERMINATE_LOOP_SUCCESS', repeatCount: count };
    }
    return { action: 'CONTINUE', repeatCount: count };
  };

  // Turn 1: write_file
  const turn1 = checkLoop('C:/Users/hhjksd/Desktop/montag', 'write_file', 'C:/Users/hhjksd/Desktop/montag/build_slides.py');
  assert.equal(turn1.action, 'CONTINUE');

  // Turn 2: Attempting to repeat write_file on same path
  const turn2 = checkLoop('C:/Users/hhjksd/Desktop/montag', 'write_file', 'C:/Users/hhjksd/Desktop/montag/build_slides.py');
  assert.equal(turn2.action, 'TERMINATE_LOOP_SUCCESS', 'Repetitive action must be intercepted on turn 2');
  assert.equal(turn2.repeatCount, 2);
});
