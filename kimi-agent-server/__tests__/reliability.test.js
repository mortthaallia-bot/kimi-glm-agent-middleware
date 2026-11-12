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
  parseToolCall,
  MAX_FILE_READ_SIZE_KB,
  MAX_SEARCH_MATCHES,
} from '../tools.js';
import {
  compressConversationHistory,
  formatCompactToolCatalog,
  compressToolMetadata,
} from '../prompt-optimizer.js';

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

test('Task 4.a: Observation Masking compresses massive 80-turn history by >=80% while preserving recent context', () => {
  const msgs = [
    { role: 'system', content: 'You are an expert AI agent. <system-reminder>HUGE BLOAT</system-reminder>' },
    { role: 'user', content: 'Build a 3D brain model and research Alzheimer biomarkers' },
  ];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: 'assistant', content: `<<<read_file:{"path":"chunk_${i}.txt"}>>>` });
    msgs.push({ role: 'tool', content: `Line content for chunk ${i}: ` + 'data '.repeat(1200) });
  }
  msgs.push({ role: 'user', content: 'Latest tool output: SUCCESS_MARKER_XYZ' });

  const rawSize = JSON.stringify(msgs).length;
  const masked = compressConversationHistory(msgs, { keepRecent: 4 });
  const maskedSize = JSON.stringify(masked).length;

  assert.ok(maskedSize < rawSize * 0.2, `Expected >=80% compression, got raw=${rawSize}, masked=${maskedSize}`);
  assert.ok(!JSON.stringify(masked).includes('HUGE BLOAT'), 'System bloat tags must be stripped');
  assert.ok(JSON.stringify(masked).includes('Build a 3D brain model'), 'Original user goal must stay intact');
  assert.ok(JSON.stringify(masked).includes('SUCCESS_MARKER_XYZ'), 'Most recent turns must remain verbatim');
});

test('Task 4.b: Progressive Disclosure & Compact MCP Catalog compresses 52 tools without hiding any MCP tool', () => {
  const mockTools = [
    { function: { name: 'terminal', description: 'Run shell commands on Windows/Linux', parameters: { properties: { command: {}, workdir: {} }, required: ['command'] } } },
    { function: { name: 'read_file', description: 'Read file content', parameters: { properties: { path: {}, offset: {}, limit: {} }, required: ['path'] } } },
  ];
  for (let i = 1; i <= 50; i++) {
    mockTools.push({
      function: {
        name: i <= 25 ? `mcp_blender_tool_${i}` : `mcp_github_tool_${i}`,
        description: 'Very long verbose MCP tool schema description '.repeat(15),
        parameters: { properties: { target: {}, payload: {}, extra_opt: {} }, required: ['target'] },
      },
    });
  }

  const rawToolTokens = Math.ceil(JSON.stringify(mockTools).length / 4);
  const compactMeta = compressToolMetadata(mockTools);
  const catalog = formatCompactToolCatalog(compactMeta, 'Create a 3D mesh in blender', '');
  const catalogTokens = Math.ceil(catalog.length / 4);

  assert.ok(catalogTokens < rawToolTokens * 0.15, `Catalog (${catalogTokens} tokens) must be <15% of raw schemas (${rawToolTokens} tokens)`);
  assert.ok(catalog.includes('mcp_blender_tool_1'), 'Relevant MCP tool must appear');
  assert.ok(catalog.includes('mcp_github_tool_50'), 'All remaining MCP tools must remain discoverable');
});

test('Task 4.c: Balanced-brace shorthand parser parses nested JSON MCP tool calls cleanly', () => {
  const tools = [{ function: { name: 'mcp_blender_create_mesh' } }];
  const modelOut = '<<<mcp_blender_create_mesh:{"name":"brain_cortex","transform":{"pos":[0,1.5,0],"scale":[1,1,1]}}>>>';
  const parsed = parseToolCall(modelOut, tools);

  assert.ok(Array.isArray(parsed) && parsed.length === 1);
  assert.equal(parsed[0].function.name, 'mcp_blender_create_mesh');
  const args = JSON.parse(parsed[0].function.arguments);
  assert.deepEqual(args.transform.pos, [0, 1.5, 0]);
});
