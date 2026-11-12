// ============================================================================
// PROMPT OPTIMIZER: Ultra-Low-Token High-Density Prompt & MCP Routing Engine
// Techniques implemented:
// 1. Observation Masking (keeps recent turns 100% verbatim; folds old outputs)
// 2. Progressive Disclosure & Intent-Aware MCP Tool Catalog (eliminates MCP Tax)
// 3. Compact Signature DSL (replaces verbose JSON schemas with ~8-token sigs)
// 4. Single-Pass Script-First Batching (cuts multi-turn file reading bloat)
// ============================================================================

export const CORE_TOOL_NAMES = new Set([
  'terminal', 'bash', 'execute_command',
  'read_file', 'write_file', 'patch', 'search_files', 'list_dir',
  'web_search', 'local_search', 'web_extract', 'local_extract',
  'vision_analyze', 'read_video', 'analyze_video',
  'skills_list', 'skill_view', 'skill_manage',
  'memory', 'todo_list', 'delegate_task', 'clarify',
  'process_manage', 'execute_code', 'session_search', 'browser_exec',
]);

export function stripSystemBloat(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, '')
    .replace(/<context>[\s\S]*?<\/context>/gi, '')
    .replace(/<!--\s*proxy-tools-injected\s*-->[\s\S]*/gi, '')
    .trim();
}

export function extractTextContent(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(c => c && c.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n');
  }
  return msg.content ? String(msg.content) : '';
}

/**
 * Compress full OpenAI tool schemas into tiny descriptors (~500B total vs ~150KB)
 * while preserving exact tool names, parameters, and short descriptions for MCP routing.
 */
export function compressToolMetadata(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools
    .filter(t => t && (t.function?.name || t.name))
    .map(t => {
      const fn = t.function || t;
      const props = fn.parameters?.properties || {};
      const required = new Set(Array.isArray(fn.parameters?.required) ? fn.parameters.required : []);
      const paramList = Object.keys(props).map(p => (required.has(p) ? p : `${p}?`));
      return {
        type: 'function',
        function: {
          name: fn.name,
          description: (fn.description || '').replace(/\s+/g, ' ').trim().slice(0, 100),
          parameters: {
            type: 'object',
            properties: Object.fromEntries(paramList.map(k => [k.replace(/\?$/, ''), { type: 'string' }])),
            required: [...required],
          },
          _compactParams: paramList,
        },
      };
    });
}

function getCompactParams(tool) {
  const fn = tool.function || tool;
  if (Array.isArray(fn._compactParams)) return fn._compactParams;
  const props = fn.parameters?.properties || {};
  const required = new Set(Array.isArray(fn.parameters?.required) ? fn.parameters.required : []);
  return Object.keys(props).map(p => (required.has(p) ? p : `${p}?`));
}

function scoreToolRelevance(tool, queryTokens) {
  if (queryTokens.size === 0) return 0;
  const fn = tool.function || tool;
  const hay = `${fn.name} ${fn.description || ''}`.toLowerCase();
  let score = 0;
  for (const tok of queryTokens) {
    if (hay.includes(tok)) score += 1;
  }
  return score;
}

/**
 * Format ALL tools & MCP servers in ultra-dense signature DSL (~250-550 tokens max).
 * - Core tools use ~6 tokens each.
 * - Dynamic/MCP tools use Intent-Aware Promotion: top matches get short hints;
 *   remaining MCP tools are grouped by prefix so 100% of MCP tools remain callable.
 */
export function formatCompactToolCatalog(availableTools = [], goalText = '', recentText = '') {
  if (!Array.isArray(availableTools) || availableTools.length === 0) {
    return [
      'CORE: terminal(command,workdir?) | read_file(path,offset?,limit?) | write_file(path,content) | patch(path,old_string,new_string) | search_files(pattern,target?,path?)',
      'WEB/MEDIA: local_search(query,limit?) | local_extract(urls) | vision_analyze(image_url,question) | read_video(path,max_frames?)',
      'AGENT: skills_list() | skill_view(name) | memory(action,target,content) | delegate_task(tasks) | clarify(question,choices)',
    ].join('\n');
  }

  const coreSigs = [];
  const dynamicTools = [];

  for (const t of availableTools) {
    const fn = t.function || t;
    if (!fn?.name) continue;
    let displayName = fn.name;
    if (displayName === 'web_search') displayName = 'local_search';
    if (displayName === 'web_extract') displayName = 'local_extract';

    const params = getCompactParams(t).slice(0, 6).join(',');
    const sig = `${displayName}(${params})`;

    if (CORE_TOOL_NAMES.has(fn.name)) {
      coreSigs.push(sig);
    } else {
      dynamicTools.push({ tool: t, name: displayName, params, desc: (fn.description || '').replace(/\s+/g, ' ').trim() });
    }
  }

  const lines = [];
  if (coreSigs.length > 0) {
    lines.push(`CORE: ${coreSigs.join(' | ')}`);
  }

  if (dynamicTools.length > 0) {
    const queryWords = new Set(
      `${goalText} ${recentText}`
        .toLowerCase()
        .split(/[^a-z0-9_\u0600-\u06FF]+/)
        .filter(w => w.length >= 3)
    );

    const scored = dynamicTools
      .map(item => ({ ...item, score: scoreToolRelevance(item.tool, queryWords) }))
      .sort((a, b) => b.score - a.score);

    const promoted = scored.slice(0, 12);
    const remaining = scored.slice(12);

    const promotedStr = promoted
      .map(p => (p.desc ? `${p.name}(${p.params})/*${p.desc.slice(0, 42)}*/` : `${p.name}(${p.params})`))
      .join(' | ');
    lines.push(`MCP_ACTIVE: ${promotedStr}`);

    if (remaining.length > 0) {
      const groups = new Map();
      for (const item of remaining) {
        const prefixMatch = item.name.match(/^(?:mcp_+)?([a-zA-Z0-9-]+?)[_:]/);
        const groupKey = prefixMatch ? prefixMatch[1] : 'other';
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(`${item.name}(${item.params})`);
      }
      const groupLines = [];
      for (const [grp, sigs] of groups.entries()) {
        groupLines.push(`[${grp}] ${sigs.join(', ')}`);
      }
      lines.push(`MCP_ALL: ${groupLines.join(' ; ')}`);
    }
  }

  return lines.join('\n');
}

function isToolResultLike(msg, text) {
  if (!msg) return false;
  if (msg.role === 'tool') return true;
  if (msg.role !== 'user') return false;
  const t = text.trim();
  return (
    t.startsWith('Tool output:') ||
    t.startsWith('[Tool Result]:') ||
    t.startsWith('Tool Result:') ||
    t.startsWith('{"tool_call_id"') ||
    t.startsWith('Command executed with exit code') ||
    t.startsWith('Exit code:') ||
    t.startsWith('stdout:')
  );
}

/**
 * Observation Masking + History Folding:
 * - Preserves system + initial user request + last `keepRecent` messages verbatim.
 * - Masks old verbose tool outputs (>220 chars) and bulky assistant dumps (>600 chars)
 *   into concise 1-line trace anchors.
 */
export function compressConversationHistory(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const keepRecent = options.keepRecent ?? (parseInt(process.env.OBSERVATION_KEEP_RECENT, 10) || 6);
  const oldToolCap = options.oldToolCap ?? 220;
  const recentToolCap = options.recentToolCap ?? (parseInt(process.env.RECENT_TOOL_MAX_CHARS, 10) || 10000);
  const cutoffIdx = Math.max(0, messages.length - keepRecent);

  const firstUserIdx = messages.findIndex(m => m.role === 'user' && !isToolResultLike(m, extractTextContent(m)));

  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isRecent = i >= cutoffIdx;
    const isFirstUser = i === firstUserIdx;

    if (msg.role === 'system') {
      const sysText = stripSystemBloat(extractTextContent(msg));
      const compactSys = sysText.length > 2500
        ? `${sysText.slice(0, 1800)}\n...[system trimmed: ${sysText.length - 2200} chars]...\n${sysText.slice(-400)}`
        : sysText;
      if (compactSys) {
        result.push({ role: 'system', content: compactSys });
      }
      continue;
    }

    const rawText = extractTextContent(msg);
    const cleanedText = stripSystemBloat(rawText);

    if (isToolResultLike(msg, rawText)) {
      if (!isRecent) {
        const singleLine = cleanedText.replace(/\s+/g, ' ').trim();
        const masked = singleLine.length > oldToolCap
          ? `[Obs masked (${singleLine.length}c): ${singleLine.slice(0, oldToolCap)}...]`
          : singleLine;
        result.push({ ...msg, content: masked });
      } else {
        const capped = cleanedText.length > recentToolCap
          ? `${cleanedText.slice(0, recentToolCap)}\n[TRUNCATED ${cleanedText.length - recentToolCap} chars]`
          : cleanedText;
        result.push({ ...msg, content: capped });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 && !cleanedText) {
        if (!isRecent) {
          const sigs = msg.tool_calls.map(tc => `${tc.function?.name || 'tool'}(${(tc.function?.arguments || '').slice(0, 60)})`).join(', ');
          result.push({ role: 'assistant', content: `TOOL_CALL: ${sigs}` });
        } else {
          result.push(msg);
        }
        continue;
      }

      if (!isRecent && cleanedText.length > 600) {
        const collapsed = `${cleanedText.slice(0, 450).replace(/\s+/g, ' ')}...[masked ${cleanedText.length - 450}c]`;
        result.push({ ...msg, content: collapsed });
        continue;
      }
    }

    if (!isRecent && !isFirstUser && cleanedText.length > 1500) {
      result.push({ ...msg, content: `${cleanedText.slice(0, 1200)}...[trimmed]` });
      continue;
    }

    result.push(typeof msg.content === 'string' ? { ...msg, content: cleanedText || rawText } : msg);
  }

  return result;
}

/**
 * High-Density Autonomous System Prompt (~220 tokens vs ~1,800 tokens).
 * Zero intelligence compromise: explicit rules for deep research, 3D modeling,
 * MCP execution, and single-pass Python batching to avoid 40-turn context bloat.
 */
export function buildUltraCompactPrompt({ cwd, toolCatalog, promptBody }) {
  return `[SYS] Autonomous Principal Engineer, Deep Researcher & 3D Technical Artist (Antigravity-grade, full OS/FS/CLI/MCP access).
[WS] ${cwd}
[STACK] Python 3D (trimesh,numpy,scipy -> .glb/.gltf/.obj/.stl with manifold/bounds check), Docs/Slides (pypdf,python-pptx,Pillow), Shell, All MCP servers.
[RULES]
1. Act immediately; zero passive questions or canned filler.
2. Call tools on line 1 ONLY: <<<tool_name:{"param":"value"}>>> (or any MCP tool above). Never fabricate outputs.
3. BATCHING (CRITICAL): For large PDFs/files/datasets/presentations/3D, write & run 1 Python script via terminal to inspect/extract/build/verify in one pass instead of sequential 200-line read_file loops.
4. DEEP RESEARCH: Triangulate via local_search -> local_extract; cross-verify & cite real sources.
5. OUTPUT: After verified completion on disk, deliver your full, natural, insightful Arabic/English response.
[TOOLS]
${toolCatalog}
${promptBody}`;
}
