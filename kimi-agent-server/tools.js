import fs from 'fs';
import path from 'path';

let activeProjectWorkspace = 'C:/Users/hhjksd';

// ============================================================================
// AGENT RESTRICTIONS & TOOL GUARDRAILS (Protect Context & Prevent 500 Overflows)
// ============================================================================

export const MAX_FILE_READ_SIZE_KB = parseInt(process.env.MAX_FILE_READ_SIZE_KB, 10) || 200;
export const MAX_READ_LINES = parseInt(process.env.MAX_READ_LINES, 10) || 150;
export const MAX_SEARCH_MATCHES = parseInt(process.env.MAX_SEARCH_MATCHES, 10) || 50;

export const BLOCKED_PATH_PATTERNS = [
  /(?:^|[\\/])node_modules(?:[\\/]|$)/i,
  /(?:^|[\\/])\.git(?:[\\/]|$)/i,
  /(?:^|[\\/])(?:dist|build|out|\.next|\.cache|coverage)(?:[\\/]|$)/i,
  /(?:^|[\\/])\.remotion(?:[\\/]|$)/i,
  /(?:^|[\\/])remotion[\\/](?:build|bundle|dist|out)(?:[\\/]|$)/i,
  /(?:^|[\\/])(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i,
  /\.(?:exe|dll|so|dylib|bin|iso|zip|tar|gz|7z)$/i,
  /\.(?:mp4|mov|avi|mkv|webm|flv|wmv)$/i,
  /\.(?:jpg|jpeg|png|gif|webp|svg|ico)$/i,
  /\.(?:mp3|wav|ogg|aac|flac)$/i,
];

export function isPathBlocked(filePath) {
  if (!filePath || typeof filePath !== 'string') return { blocked: false };
  const normalized = filePath.replace(/\\/g, '/');

  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        blocked: true,
        reason: `Access to '${filePath}' is blocked by middleware guardrails (matches rule: ${pattern.toString()}). Inspect package.json or source directories instead.`
      };
    }
  }
  return { blocked: false };
}

export function inspectFileForSafeRead(filePath, requestedOffset = 1, requestedLimit = 200) {
  const blockCheck = isPathBlocked(filePath);
  if (blockCheck.blocked) {
    return {
      allowed: false,
      reason: blockCheck.reason,
    };
  }

  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const sizeKb = stats.size / 1024;
      if (stats.isDirectory()) {
        return {
          allowed: false,
          reason: `Target path '${filePath}' is a directory, not a file. Use search_files({"path":"${filePath}", "target":"files"}) instead.`
        };
      }
      if (sizeKb > MAX_FILE_READ_SIZE_KB) {
        return {
          allowed: true,
          oversized: true,
          sizeKb: Math.round(sizeKb),
          safeOffset: requestedOffset || 1,
          safeLimit: Math.min(requestedLimit || MAX_READ_LINES, MAX_READ_LINES),
          notice: `[NOTICE: File size (${Math.round(sizeKb)} KB) exceeds safety threshold (${MAX_FILE_READ_SIZE_KB} KB). Reading capped to ${MAX_READ_LINES} lines from line ${requestedOffset || 1}. Use specific offset/limit range for deeper sections.]`
        };
      }
    }
  } catch (_) {}

  return {
    allowed: true,
    oversized: false,
    safeOffset: requestedOffset || 1,
    safeLimit: Math.min(requestedLimit || 200, 300),
  };
}

export function setActiveProjectWorkspace(ws) {
  if (ws && typeof ws === 'string') {
    activeProjectWorkspace = ws.trim().replace(/\\/g, '/');
  }
}

export function getActiveProjectWorkspace() {
  return activeProjectWorkspace;
}

const TOOL_INJECTION_SENTINEL = '<!-- proxy-tools-injected -->';

const CORE_PRIORITY_TOOLS = new Set([
  'terminal',
  'process_manage',
  'bash',
  'read_file',
  'write_file',
  'patch',
  'search_files',
  'web_search',
  'web_extract',
  'todo_list',
  'memory',
  'delegate_task',
  'skills_list',
  'skill_view',
  'skill_manage',
  'browser_exec',
  'vision_analyze',
  'execute_code',
  'session_search',
  'clarify',
  'desktop_preview',
  'execute_command',
  'write_to_file',
  'list_dir',
  'read_video',
  'analyze_video',
  'local_search',
  'local_extract',
]);

export function injectToolsIntoSystem(messages, tools) {
  if (!tools || tools.length === 0) {
    return normalizeMessages(messages);
  }

  const toolInstruction = `SYSTEM: Autonomous Principal Systems & Software Engineer (Antigravity-Grade Agent).
You are an autonomous pair programmer with full operational capabilities on this machine.
AUTONOMOUS OPERATING RULES:
1. Zero Passivity: NEVER ask passive questions like "How can I help you?", "The folder is empty, what should I do?", or "Should I proceed?". If a workspace is empty, that is the expected starting state — IMMEDIATELY proceed to create the project files, write the scripts, and complete the goal.
2. Tool Execution Rule: Output ONLY the tool call on line 1, e.g. <<<tool_name:{"param":"value"}>>> or tool_name({"param":"value"}). Do NOT write conversational greetings or commentary before the tool call.
3. PowerPoint / Presentations (.pptx): When asked for PowerPoint, presentations, slides, or .pptx (عرض تقديمي / باوربوينت / شرائح), Python is installed with python-pptx ready. Write a complete Python script using python-pptx in the workspace that creates a professional, multi-slide presentation (Title, Agenda, detailed content slides with bullets, Conclusion) and run it via terminal to produce the .pptx file.
4. Complete Production Artifacts: Write full, working implementations without placeholders or cuts.
5. Task Completion: ONLY after the entire task is 100% completed, tested, and verified on disk, write a clear, professional Arabic/English final summary.
Tools:
- terminal({"command":"..."})
- read_file({"path":"...", "offset":1, "limit":200})
- write_file({"path":"...", "content":"..."})
- patch({"path":"...", "old_string":"...", "new_string":"..."})
- search_files({"pattern":"...", "target":"content"|"files", "path":"."})
- web_search({"query":"...", "limit":5})
- web_extract({"urls":["https://..."]})
- read_video({"path":"...", "max_frames":5})
- todo_list({"todos":[{"id":"1","content":"...","status":"in_progress"|"pending"|"completed"}]})
- memory({"action":"add"|"replace", "target":"memory"|"user", "content":"..."})
- delegate_task({"tasks":[{"goal":"...", "context":"..."}]})
- skills_list({}) / skill_view({"name":"..."})
- vision_analyze({"image_url":"...", "question":"..."})
- clarify({"question":"...", "choices":["..."]})
Rule: To use a tool, output the tool call on line 1, e.g. <<<tool_name:{"param":"value"}>>> or tool_name({"param":"value"}).`;

  const result = normalizeMessages(messages);

  const systemIndex = result.findIndex(m => m.role === 'system');
  if (systemIndex !== -1) {
    if (result[systemIndex].content.includes(TOOL_INJECTION_SENTINEL)) {
      return result;
    }
    result[systemIndex] = {
      role: 'system',
      content: `${result[systemIndex].content}\n\n${toolInstruction}\n${TOOL_INJECTION_SENTINEL}`
    };
  } else {
    result.unshift({ role: 'system', content: `${toolInstruction}\n${TOOL_INJECTION_SENTINEL}` });
  }

  return result;
}

function normalizeMessages(messages) {
  return messages.map(msg => {
    const normalized = { role: msg.role };

    if (msg.role === 'assistant' && msg.tool_calls) {
      normalized.content = msg.tool_calls.map(tc =>
        `TOOL_CALL: ${tc.function.name}\nARGUMENTS: ${tc.function.arguments}`
      ).join('\n\n');
    } else if (typeof msg.content === 'string') {
      normalized.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter(c => c.type === 'text' && (!c.text || !c.text.includes('<system-reminder>')))
        .map(c => c.text);
      normalized.content = textParts.join('\n');
    } else if (msg.content) {
      normalized.content = String(msg.content);
    } else {
      normalized.content = '';
    }

    return normalized;
  });
}

/**
 * Sanitize Windows / Git Bash terminal commands to prevent exit code 1 ("خطأ رقم ادخال 1")
 */
function normalizeWindowsOrMsysPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return rawPath;
  let cleaned = rawPath
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/\\ /g, ' ')
    .replace(/\\/g, '/');
  // Convert MSYS /c/Users/... or /d/... to C:/Users/... so Windows spawn cwd works
  cleaned = cleaned.replace(/^\/([a-zA-Z])\//, (_, drive) => `${drive.toUpperCase()}:/`);
  return cleaned;
}

export function sanitizeTerminalCommand(rawArgs) {
  const args = { ...rawArgs };
  let cmd = (args.command || args.cmd || args.script || '').trim();
  if (!cmd) return args;

  // 1. Extract leading `cd /d "path" && rest`, `cd /c/path\ with\ spaces && rest`, or `cd path && rest` into `workdir`
  const cdRegex = /^cd(?:\s+\/d)?\s+(.+?)\s*(?:&&|;)\s*([\s\S]+)$/i;
  const cdMatch = cmd.match(cdRegex);
  if (cdMatch) {
    const rawDir = normalizeWindowsOrMsysPath(cdMatch[1]);
    const restCmd = (cdMatch[2] || '').trim();
    if (rawDir && restCmd) {
      args.workdir = rawDir;
      cmd = restCmd;
    }
  }

  // 1b. If the entire command is just `cd <path>`, normalize it
  if (/^cd(?:\s+\/d)?\s+(.+)$/i.test(cmd) && !cmd.includes('&&') && !cmd.includes(';')) {
    const m = cmd.match(/^cd(?:\s+\/d)?\s+(.+)$/i);
    if (m) {
      const targetDir = normalizeWindowsOrMsysPath(m[1]);
      args.workdir = targetDir;
      cmd = 'pwd && ls -la';
    }
  }

  // 2. Replace any remaining `cd /d ` with `cd ` and normalize backslashes inside cd quotes
  cmd = cmd.replace(/\bcd\s+\/d\s+/gi, 'cd ');
  cmd = cmd.replace(/\bcd\s+"([^"]+)"/gi, (_, p1) => `cd "${normalizeWindowsOrMsysPath(p1)}"`);
  // Unescape bash `\ ` inside quoted or unquoted paths if any remain
  cmd = cmd.replace(/\\ /g, ' ');

  // 2b. Convert Windows `dir` commands to POSIX `ls -la` with forward slashes
  if (/^dir(?:\s+|$)/i.test(cmd)) {
    cmd = cmd.replace(/^dir(?:\s+\/[a-zA-Z]+)*/i, 'ls -la').replace(/\\/g, '/');
  }

  // 3. Convert cmd.exe `if exist <target> (cmdA) else (cmdB)` (including paths with spaces) to POSIX bash
  cmd = cmd.replace(
    /if\s+exist\s+(?:"([^"]+)"|'([^']+)'|([^\s(]+))\s*\(\s*([^)]+?)\s*\)\s*else\s*\(\s*([^)]+?)\s*\)/gi,
    (_, q1, q2, q3, tr, fa) => {
      const target = (q1 || q2 || q3 || '').replace(/\\/g, '/');
      return `if [ -e "${target}" ]; then ${tr.trim()}; else ${fa.trim()}; fi`;
    }
  );

  // 4. Make `git clone` idempotent so cloning an already-existing folder returns exit code 0 instead of 128/1
  if (/\bgit\s+clone\b/i.test(cmd) && !cmd.includes('if [ -d')) {
    cmd = cmd.replace(
      /\bgit\s+clone\s+(?:--progress\s+)?(?:--depth\s+\d+\s+)?["']?(https?:\/\/[^\s"'&;]+)["']?(?:\s+["']?([^\s"'&;]+)["']?)?/gi,
      (fullMatch, rawUrl, explicitDir) => {
        const repoUrl = rawUrl.replace(/["']+$/g, '');
        const urlParts = repoUrl.replace(/\/+$/, '').split('/');
        const lastSegment = urlParts[urlParts.length - 1] || '';
        const repoBase = lastSegment.replace(/\.git$/i, '');
        const cleanExplicit = (explicitDir || '').trim().replace(/^["']+|["']+$/g, '');
        const targetFolder = (cleanExplicit && cleanExplicit !== '.' && cleanExplicit !== './')
          ? cleanExplicit.replace(/\.git$/i, '')
          : repoBase;
        if (!targetFolder) return fullMatch;
        return `if [ -d "${targetFolder}" ]; then echo "Repository '${targetFolder}' already exists at $(pwd)/${targetFolder}"; ls -la "${targetFolder}"; else git clone --depth 1 "${repoUrl}" "${targetFolder}"; fi`;
      }
    );
  }

  if (args.workdir && typeof args.workdir === 'string') {
    args.workdir = normalizeWindowsOrMsysPath(args.workdir);
  } else if (activeProjectWorkspace) {
    args.workdir = normalizeWindowsOrMsysPath(activeProjectWorkspace);
  } else {
    args.workdir = 'C:/Users/hhjksd';
  }

  const bashPathPrefix = 'export PATH="/c/Users/hhjksd/AppData/Local/hermes/tools/ffmpeg:/c/Users/hhjksd/AppData/Local/hermes/tools/python-3.14.9+20261021-win32-x64:/c/Users/hhjksd/AppData/Local/hermes/tools/git-2.56.0-win32-x64/bin:/c/Users/hhjksd/AppData/Local/hermes/tools/git-2.56.0-win32-x64/usr/bin:/c/Users/hhjksd/AppData/Local/hermes/git/mingw64/bin:/c/Users/hhjksd/AppData/Local/hermes/git/usr/bin:/c/Users/hhjksd/AppData/Local/hermes/git/bin:/c/Users/hhjksd/AppData/Local/hermes/tools/node-26.12.1-win32-x64:/c/Users/hhjksd/AppData/Local/hermes/tools/npm-12.0.2-win32-x64/bin:/c/Users/hhjksd/AppData/Local/hermes/tools:$PATH"; ';
  if (!cmd.includes('/hermes/git/usr/bin')) {
    cmd = bashPathPrefix + cmd;
  }

  args.command = cmd;
  delete args.cmd;
  return args;
}

/**
 * Normalize tool names and parameters to match Hermes Desktop's tool definitions
 */
export function normalizeToolCallForHermes(toolName, rawArgs, availableToolNames = null) {
  let name = (toolName || '').trim();
  const lower = name.toLowerCase();
  let args = typeof rawArgs === 'object' && rawArgs !== null ? { ...rawArgs } : {};

  const hasTool = (candidate) => !availableToolNames || availableToolNames.has(candidate);

  // 1. Terminal / command execution aliases
  if (['run', 'exec', 'execute_command', 'shell', 'cmd', 'bash', 'terminal', 'run_command'].includes(lower)) {
    if (hasTool('terminal')) name = 'terminal';
    else if (hasTool('bash')) name = 'bash';
    args = sanitizeTerminalCommand(args);
  }
  // 2. Process / background task management
  else if (['process', 'process_manage', 'manage_task', 'command_status'].includes(lower)) {
    name = 'process_manage';
    if (!args.action) args.action = 'list';
    if (!args.session_id && (args.task_id || args.taskId || args.id || args.pid)) {
      args.session_id = String(args.task_id || args.taskId || args.id || args.pid);
      delete args.task_id;
      delete args.taskId;
      delete args.id;
      delete args.pid;
    }
  }
  // 3. File write aliases
  else if (['write', 'write_to_file', 'create_file', 'save_file', 'write_file'].includes(lower)) {
    name = 'write_file';
    if (!args.path && (args.file_path || args.filePath || args.filename || args.target_file)) {
      args.path = args.file_path || args.filePath || args.filename || args.target_file;
      delete args.file_path;
      delete args.filePath;
      delete args.filename;
      delete args.target_file;
    }
    if (args.path && typeof args.path === 'string') {
      args.path = normalizeWindowsOrMsysPath(args.path);

      // Check if path is blocked (node_modules, .git, lockfiles, build caches)
      const blockCheck = isPathBlocked(args.path);
      if (blockCheck.blocked) {
        if (hasTool('terminal')) {
          // Re-route safely to terminal echo warning rather than letting agent crash context
          return {
            name: 'terminal',
            args: {
              command: `echo "[GUARDRAIL BLOCKED]: ${blockCheck.reason.replace(/"/g, '\\"')}"`
            }
          };
        }
      }

      // Safe size inspection
      const readSafety = inspectFileForSafeRead(args.path, args.offset, args.limit);
      if (!readSafety.allowed) {
        if (hasTool('terminal')) {
          return {
            name: 'terminal',
            args: {
              command: `echo "[GUARDRAIL BLOCKED]: ${readSafety.reason.replace(/"/g, '\\"')}"`
            }
          };
        }
      }

      if (readSafety.oversized) {
        args.offset = readSafety.safeOffset;
        args.limit = readSafety.safeLimit;
      }

      try {
        const parentDir = path.dirname(args.path);
        if (parentDir && !fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
      } catch (_) {}
    }
    if (args.content === undefined && (args.code !== undefined || args.text !== undefined || args.data !== undefined)) {
      args.content = String(args.code ?? args.text ?? args.data ?? '');
      delete args.code;
      delete args.text;
      delete args.data;
    }
  }
  // 4. File read aliases
  else if (['read', 'view_file', 'read_file', 'cat', 'open_file'].includes(lower)) {
    name = 'read_file';
    if (!args.path && (args.file_path || args.filePath || args.filename || args.target_file)) {
      args.path = args.file_path || args.filePath || args.filename || args.target_file;
      delete args.file_path;
      delete args.filePath;
      delete args.filename;
      delete args.target_file;
    }
    if (args.path && typeof args.path === 'string') {
      args.path = normalizeWindowsOrMsysPath(args.path);

      // Check if path is blocked (node_modules, .git, lockfiles, build caches)
      const blockCheck = isPathBlocked(args.path);
      if (blockCheck.blocked) {
        if (hasTool('terminal')) {
          // Re-route safely to terminal echo warning rather than letting agent crash context
          return {
            name: 'terminal',
            args: {
              command: `echo "[GUARDRAIL BLOCKED]: ${blockCheck.reason.replace(/"/g, '\\"')}"`
            }
          };
        }
      }

      // Safe size inspection
      const readSafety = inspectFileForSafeRead(args.path, args.offset, args.limit);
      if (!readSafety.allowed) {
        if (hasTool('terminal')) {
          return {
            name: 'terminal',
            args: {
              command: `echo "[GUARDRAIL BLOCKED]: ${readSafety.reason.replace(/"/g, '\\"')}"`
            }
          };
        }
      }

      if (readSafety.oversized) {
        args.offset = readSafety.safeOffset;
        args.limit = readSafety.safeLimit;
      }

      try {
        const parentDir = path.dirname(args.path);
        if (parentDir && !fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
      } catch (_) {}
    }
    if (args.start_line && !args.offset) {
      args.offset = Number(args.start_line) || 1;
      delete args.start_line;
    }
    if (args.path && /\.(mp4|mov|avi|webm|mkv|flv|wmv)$/i.test(args.path)) {
      return normalizeToolCallForHermes('read_video', args, availableToolNames);
    }
  }
  // 5. Patch / surgical file edit aliases
  else if (['edit', 'edit_file', 'replace', 'replace_in_file', 'str_replace', 'patch', 'multi_edit'].includes(lower)) {
    name = 'patch';
    if (!args.path && (args.file_path || args.filePath || args.filename || args.target_file)) {
      args.path = args.file_path || args.filePath || args.filename || args.target_file;
      delete args.file_path;
      delete args.filePath;
      delete args.filename;
      delete args.target_file;
    }
    if (args.path && typeof args.path === 'string') {
      args.path = normalizeWindowsOrMsysPath(args.path);

      // Check if path is blocked (node_modules, .git, lockfiles, build caches)
      const blockCheck = isPathBlocked(args.path);
      if (blockCheck.blocked) {
        if (hasTool('terminal')) {
          // Re-route safely to terminal echo warning rather than letting agent crash context
          return {
            name: 'terminal',
            args: {
              command: `echo "[GUARDRAIL BLOCKED]: ${blockCheck.reason.replace(/"/g, '\\"')}"`
            }
          };
        }
      }

      // Safe size inspection
      const readSafety = inspectFileForSafeRead(args.path, args.offset, args.limit);
      if (!readSafety.allowed) {
        if (hasTool('terminal')) {
          return {
            name: 'terminal',
            args: {
              command: `echo "[GUARDRAIL BLOCKED]: ${readSafety.reason.replace(/"/g, '\\"')}"`
            }
          };
        }
      }

      if (readSafety.oversized) {
        args.offset = readSafety.safeOffset;
        args.limit = readSafety.safeLimit;
      }

      try {
        const parentDir = path.dirname(args.path);
        if (parentDir && !fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
      } catch (_) {}
    }
    if (args.old_string === undefined && (args.target !== undefined || args.old !== undefined || args.search !== undefined || args.old_str !== undefined)) {
      args.old_string = args.target ?? args.old ?? args.search ?? args.old_str;
      delete args.target;
      delete args.old;
      delete args.search;
      delete args.old_str;
    }
    if (args.new_string === undefined && (args.replacement !== undefined || args.new !== undefined || args.replace !== undefined || args.new_str !== undefined)) {
      args.new_string = args.replacement ?? args.new ?? args.replace ?? args.new_str;
      delete args.replacement;
      delete args.new;
      delete args.replace;
      delete args.new_str;
    }
    if (!args.mode) {
      args.mode = args.patch ? 'patch' : 'replace';
    }
  }
  // 6. Search files / grep / find / list_dir aliases
  else if (['search', 'grep', 'rg', 'grep_search', 'find', 'find_by_name', 'list_dir', 'ls', 'glob', 'search_files'].includes(lower)) {
    name = 'search_files';
    if (!args.pattern) {
      args.pattern = args.query || args.regex || args.glob || args.name || '*';
      delete args.query;
      delete args.regex;
      delete args.glob;
      delete args.name;
    }
    if (!args.path && (args.dir || args.directory || args.folder || args.search_path)) {
      args.path = args.dir || args.directory || args.folder || args.search_path;
      delete args.dir;
      delete args.directory;
      delete args.folder;
      delete args.search_path;
    }
    if (args.path && typeof args.path === 'string') {
      args.path = normalizeWindowsOrMsysPath(args.path);

      // Check if path is blocked (node_modules, .git, lockfiles, build caches)
      const blockCheck = isPathBlocked(args.path);
      if (blockCheck.blocked) {
        if (hasTool('terminal')) {
          // Re-route safely to terminal echo warning rather than letting agent crash context
          return {
            name: 'terminal',
            args: {
              command: `echo "[GUARDRAIL BLOCKED]: ${blockCheck.reason.replace(/"/g, '\\"')}"`
            }
          };
        }
      }

      try {
        const parentDir = path.dirname(args.path);
        if (parentDir && !fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
      } catch (_) {}
    }
    if (['list_dir', 'ls', 'find', 'find_by_name', 'glob'].includes(lower)) {
      args.target = 'files';
    } else if (!args.target) {
      args.target = 'content';
    }
    if (!args.limit || Number(args.limit) > MAX_SEARCH_MATCHES) {
      args.limit = MAX_SEARCH_MATCHES;
    }
  }
  // 7. Web Search (Research capability)
  else if (['web_search', 'local_search', 'search_online', 'net_search', 'search_web', 'google', 'bing', 'internet_search', 'ddg', 'websearch'].includes(lower)) {
    name = 'web_search';
    if (!args.query && (args.q || args.search_query || args.keyword || args.text || args.term)) {
      args.query = String(args.q || args.search_query || args.keyword || args.text || args.term);
      delete args.q;
      delete args.search_query;
      delete args.keyword;
      delete args.text;
      delete args.term;
    }
    if (!args.limit && (args.num || args.max_results || args.count)) {
      args.limit = Number(args.num || args.max_results || args.count) || 5;
      delete args.num;
      delete args.max_results;
      delete args.count;
    }
  }
  // 8. Web Extract / URL Reader
  else if (['web_extract', 'local_extract', 'fetch_page', 'url_extract', 'fetch_url', 'read_url', 'read_url_content', 'scrape', 'webfetch', 'curl_url', 'extract_url'].includes(lower)) {
    name = 'web_extract';
    if (!Array.isArray(args.urls)) {
      const single = args.urls || args.url || args.link || args.href || args.target_url;
      args.urls = single ? (Array.isArray(single) ? single : [String(single)]) : [];
      delete args.url;
      delete args.link;
      delete args.href;
      delete args.target_url;
    }
  }
  // 9. Todo / Task List Planning
  else if (['todo_list', 'todo', 'todowrite', 'plan', 'task_list', 'tasks', 'checklist'].includes(lower)) {
    name = 'todo_list';
    const rawList = args.todos || args.items || args.tasks || args.list;
    if (Array.isArray(rawList)) {
      args.todos = rawList.map((item, idx) => {
        if (typeof item === 'string') {
          return { id: String(idx + 1), content: item, status: idx === 0 ? 'in_progress' : 'pending' };
        }
        return {
          id: String(item.id || idx + 1),
          content: String(item.content || item.title || item.task || item.description || `Step ${idx + 1}`),
          status: ['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status) ? item.status : 'pending',
          ...(item.parent ? { parent: String(item.parent) } : {}),
        };
      });
      delete args.items;
      delete args.tasks;
      delete args.list;
    }
  }
  // 10. Persistent Memory
  else if (['memory', 'remember', 'save_memory', 'update_memory'].includes(lower)) {
    name = 'memory';
    if (!args.action) args.action = 'add';
    if (!args.target) args.target = 'memory';
    if (!args.content && (args.text || args.note || args.value || args.fact)) {
      args.content = String(args.text || args.note || args.value || args.fact);
      delete args.text;
      delete args.note;
      delete args.value;
      delete args.fact;
    }
  }
  // 11. Subagent Delegation
  else if (['delegate_task', 'invoke_subagent', 'subagent', 'spawn_agent', 'delegate'].includes(lower)) {
    name = 'delegate_task';
    if (!Array.isArray(args.tasks) && (args.goal || args.prompt || args.task)) {
      args.tasks = [{
        goal: String(args.goal || args.prompt || args.task),
        ...(args.context ? { context: String(args.context) } : {}),
      }];
      delete args.goal;
      delete args.prompt;
      delete args.task;
      delete args.context;
    }
  }
  // 12. Skills Discovery & Loading
  else if (['skills_list', 'list_skills'].includes(lower)) {
    name = 'skills_list';
  }
  else if (['skill_view', 'view_skill', 'load_skill', 'use_skill', 'read_skill'].includes(lower)) {
    name = 'skill_view';
    if (!args.name && (args.skill || args.skill_name || args.id)) {
      args.name = String(args.skill || args.skill_name || args.id);
      delete args.skill;
      delete args.skill_name;
      delete args.id;
    }
  }
  else if (['skill_manage', 'manage_skill', 'create_skill'].includes(lower)) {
    name = 'skill_manage';
  }
  // 13. Vision / Image Analysis
  else if (['vision_analyze', 'analyze_image', 'view_image', 'inspect_image', 'vision'].includes(lower)) {
    name = 'vision_analyze';
    if (!args.image_url && (args.image || args.path || args.url || args.file)) {
      args.image_url = String(args.image || args.path || args.url || args.file);
      delete args.image;
      delete args.path;
      delete args.url;
      delete args.file;
    }
    if (!args.question && (args.prompt || args.query)) {
      args.question = String(args.prompt || args.query);
      delete args.prompt;
      delete args.query;
    }
    if (!args.question) {
      args.question = 'Describe this image and extract all key details.';
    }
  }
  // 13b. Video Reading & Keyframe Inspection
  else if (['read_video', 'analyze_video', 'inspect_video', 'video_analyze', 'view_video', 'readvideo'].includes(lower)) {
    name = 'read_video';
    if (!args.path && (args.video_path || args.video || args.file_path || args.file || args.target)) {
      args.path = args.video_path || args.video || args.file_path || args.file || args.target;
      delete args.video_path;
      delete args.video;
      delete args.file_path;
      delete args.file;
      delete args.target;
    }
    if (args.path && typeof args.path === 'string') {
      args.path = normalizeWindowsOrMsysPath(args.path);
    }
    args.max_frames = Number(args.max_frames || args.frames || args.num_frames) || 5;
  }
  // 14. Clarify / Ask User Question
  else if (['clarify', 'ask_question', 'ask_user'].includes(lower)) {
    name = 'clarify';
    if (!args.question && (args.prompt || args.text || args.query)) {
      args.question = String(args.prompt || args.text || args.query);
      delete args.prompt;
      delete args.text;
      delete args.query;
    }
    if (!args.choices && Array.isArray(args.options)) {
      args.choices = args.options;
      delete args.options;
    }
  }
  // 15. Browser Automation & Desktop Preview & Code Execution & Session Search
  else if (['browser_exec', 'browser', 'browser_navigate'].includes(lower)) {
    name = 'browser_exec';
    if (!args.code && args.url) {
      args.code = `page.goto(${JSON.stringify(args.url)})\nprint(page.title())`;
      delete args.url;
    }
  }
  else if (['execute_code', 'run_python', 'python_exec'].includes(lower)) {
    name = 'execute_code';
    if (!args.code && (args.script || args.source)) {
      args.code = String(args.script || args.source);
      delete args.script;
      delete args.source;
    }
  }
  else if (['session_search', 'search_history', 'search_sessions'].includes(lower)) {
    name = 'session_search';
    if (!args.query && (args.q || args.pattern)) {
      args.query = String(args.q || args.pattern);
      delete args.q;
      delete args.pattern;
    }
  }
  else if (['desktop_preview', 'preview', 'open_preview'].includes(lower)) {
    name = 'desktop_preview';
  }

  // Fallback routing if the current session pinned a smaller toolset:
  if (availableToolNames && !availableToolNames.has(name)) {
    // Route 1: If Hermes Desktop's `tool_call` deferred bridge is in `availableToolNames`, wrap into `tool_call`
    if (availableToolNames.has('tool_call')) {
      return {
        name: 'tool_call',
        args: {
          calls: [{ name, arguments: args }],
        },
      };
    }
    // Route 2: If in a legacy session with only `terminal`, fallback `web_search` and `web_extract` to curl via Jina/DuckDuckGo
    if (name === 'web_search' && availableToolNames.has('terminal')) {
      const q = encodeURIComponent(args.query || '');
      return {
        name: 'terminal',
        args: sanitizeTerminalCommand({
          command: `curl -sL -A "Mozilla/5.0" "https://s.jina.ai/${q}" | head -c 12000`,
        }),
      };
    }
    if (name === 'web_extract' && availableToolNames.has('terminal')) {
      const targetUrl = Array.isArray(args.urls) && args.urls[0] ? args.urls[0] : '';
      return {
        name: 'terminal',
        args: sanitizeTerminalCommand({
          command: `curl -sL -A "Mozilla/5.0" "https://r.jina.ai/${targetUrl}" | head -c 15000`,
        }),
      };
    }
    // Route 3: Video inspection fallback to local python video_inspector.py
    if ((name === 'read_video' || name === 'analyze_video') && availableToolNames.has('terminal')) {
      const videoPath = args.path || '';
      const frames = args.max_frames || 5;
      return {
        name: 'terminal',
        args: sanitizeTerminalCommand({
          command: `python "C:/Users/hhjksd/AppData/Local/hermes/tools/video_inspector.py" "${videoPath}" --frames ${frames}`,
        }),
      };
    }
    // Route 4: AI Vision Analysis fallback to local python vision_analyzer.py
    if ((name === 'vision_analyze' || name === 'analyze_image' || name === 'view_image' || name === 'inspect_image') && availableToolNames.has('terminal')) {
      const imgPath = args.image_url || args.image || args.path || args.file || '';
      const q = (args.question || args.prompt || args.query || 'Describe this frame in extreme detail.').replace(/"/g, '\\"');
      return {
        name: 'terminal',
        args: sanitizeTerminalCommand({
          command: `python "C:/Users/hhjksd/AppData/Local/hermes/tools/vision_analyzer.py" "${imgPath}" "${q}"`,
        }),
      };
    }
  }

  return { name, args };
}

export function parseToolCall(responseText, tools = null) {
  if (!responseText || typeof responseText !== 'string') {
    return null;
  }

  const availableToolNames = tools && Array.isArray(tools)
    ? new Set(tools.map(t => t?.function?.name).filter(Boolean))
    : null;

  const parsers = [
    { name: 'Direct Function Call', parser: (txt) => parseDirectFunctionCall(txt, availableToolNames) },
    { name: 'Shorthand Format', parser: (txt) => parseShorthandFormat(txt, availableToolNames) },
    { name: 'Text Format', parser: (txt) => parseTextFormat(txt, availableToolNames) },
    { name: 'XML Action Format', parser: (txt) => parseActionXML(txt, availableToolNames) },
    { name: 'Minimax XML', parser: (txt) => parseMinimaxXML(txt, availableToolNames) },
    { name: 'Claude XML', parser: (txt) => parseClaudeXML(txt, availableToolNames) },
    { name: 'OpenAI Native', parser: (txt) => parseOpenAIToolCalls(txt, availableToolNames) },
    { name: 'Auto-Healed Truncated WriteFile', parser: (txt) => healTruncatedWriteFile(txt, availableToolNames) },
  ];

  const triedParsers = [];

  for (const { name, parser } of parsers) {
    try {
      const toolCalls = parser(responseText);
      if (toolCalls && toolCalls.length > 0) {
        console.log(`[Tool Parsing] Successfully parsed tool calls using ${name}`);
        return toolCalls;
      }
      triedParsers.push(name);
    } catch (error) {
      console.warn(`[Tool Parsing] ${name} parser failed: ${error.message}`);
      triedParsers.push(name + ' (failed)');
    }
  }

  console.warn(`[Tool Parsing] No tool calls detected. Tried parsers: ${triedParsers.join(', ')}`);
  return null;
}

function extractBalancedBraces(text, startIndex) {
  let braceCount = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          return { jsonStr: text.substring(startIndex, i + 1), endIndex: i + 1 };
        }
      }
    }
  }
  return null;
}

function parseDirectFunctionCall(responseText, availableToolNames) {
  const toolCalls = [];
  if (!responseText || typeof responseText !== 'string') return toolCalls;

  const validTools = new Set([...CORE_PRIORITY_TOOLS]);
  if (availableToolNames) {
    for (const t of availableToolNames) validTools.add(t.toLowerCase());
  }
  ['run', 'exec', 'bash', 'cmd', 'shell', 'read', 'view_file', 'cat', 'write', 'create_file', 'edit', 'replace', 'search', 'grep', 'find', 'read_video', 'analyze_video', 'video_analyze', 'local_search', 'local_extract'].forEach(t => validTools.add(t));

  const pattern = /(?:^|[\n`\s])([a-zA-Z0-9_.-]+)\s*(?:\(\s*\{|:\s*\{)/g;
  let match;

  while ((match = pattern.exec(responseText)) !== null) {
    const rawName = match[1];
    if (!validTools.has(rawName.toLowerCase())) continue;

    const braceIndex = responseText.indexOf('{', match.index);
    if (braceIndex === -1) continue;

    const extracted = extractBalancedBraces(responseText, braceIndex);
    if (extracted) {
      try {
        const rawArgs = safeParseToolJson(extracted.jsonStr);
        if (rawArgs) {
          const { name, args } = normalizeToolCallForHermes(rawName, rawArgs, availableToolNames);
          toolCalls.push(createToolCallObject(name, args, toolCalls.length));
          pattern.lastIndex = extracted.endIndex;
        }
      } catch (err) {
        console.warn(`[Tool Parsing] Direct function call parse failed for ${rawName}:`, err.message);
      }
    }
  }

  return toolCalls;
}

function healTruncatedWriteFile(responseText, availableToolNames) {
  if (!responseText || typeof responseText !== 'string') return null;

  // Match <<<write_file:{"path":"...", "content":"... or <write_to_file><path>...
  const match = responseText.match(/<<<\s*(?:write_file|write_to_file)\s*:\s*\{\s*"(?:path|file_path|filePath)"\s*:\s*"([^"]+)"\s*,\s*"(?:content|code|text)"\s*:\s*"([\s\S]+)$/i);
  if (!match) return null;

  const rawPath = match[1];
  let rawContent = match[2];

  // Strip trailing unclosed delimiters if present
  rawContent = rawContent.replace(/"\s*\}?\s*>{0,3}\s*$/, '');

  let content = '';
  try {
    content = JSON.parse(`"${rawContent}"`);
  } catch (_) {
    content = rawContent
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  if (rawPath && content && content.length > 10) {
    console.log(`[Tool Parsing] Auto-healed unclosed write_file tool call for: ${rawPath} (${content.length} chars)`);
    const { name, args } = normalizeToolCallForHermes('write_file', { path: rawPath, content }, availableToolNames);
    return [createToolCallObject(name, args, 0)];
  }
  return null;
}

function safeParseToolJson(rawJsonStr) {
  if (!rawJsonStr || typeof rawJsonStr !== 'string') return null;
  const trimmed = rawJsonStr.trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  // Repair invalid JSON backslash escapes (such as bash `\ ` in `اعلان\ لمكتب\ فدك` or Windows `C:\Users\...`)
  let repaired = '';
  let inString = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '"' && (i === 0 || trimmed[i - 1] !== '\\')) {
      inString = !inString;
      repaired += ch;
      continue;
    }
    if (inString && ch === '\\') {
      const next = trimmed[i + 1];
      if (next === '\\') {
        repaired += '\\\\';
        i++;
        continue;
      }
      if (next === '"' || next === '/') {
        repaired += '\\' + next;
        i++;
        continue;
      }
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(trimmed.slice(i + 2, i + 6))) {
        repaired += '\\u' + trimmed.slice(i + 2, i + 6);
        i += 5;
        continue;
      }
      if (next === ' ') {
        // Bash escaped space `\ ` inside JSON string -> normal space
        repaired += ' ';
        i++;
        continue;
      }
      if (next && 'bfnrt'.includes(next)) {
        repaired += '\\' + next;
        i++;
        continue;
      }
      repaired += '\\\\';
      continue;
    }
    if (inString && ch === '\n') {
      repaired += '\\n';
      continue;
    }
    if (inString && ch === '\r') {
      repaired += '\\r';
      continue;
    }
    if (inString && ch === '\t') {
      repaired += '\\t';
      continue;
    }
    repaired += ch;
  }

  try {
    return JSON.parse(repaired);
  } catch (_) {}

  // Fallback regex extraction if JSON has unescaped quotes
  const cmdMatch = trimmed.match(/^\{\s*"(?:command|cmd|script)"\s*:\s*"([\s\S]*)"\s*\}$/);
  if (cmdMatch) {
    return { command: cmdMatch[1].replace(/\\"/g, '"').replace(/\\ /g, ' ') };
  }
  const pathOnlyMatch = trimmed.match(/^\{\s*"(?:path|file_path|filePath)"\s*:\s*"([\s\S]*)"\s*\}$/);
  if (pathOnlyMatch) {
    return { path: pathOnlyMatch[1].replace(/\\"/g, '"').replace(/\\ /g, ' ') };
  }
  return null;
}

function parseShorthandFormat(responseText, availableToolNames) {
  const toolCalls = [];

  // 1. <<<tool_name:{"param":"value"}>>>
  const shorthandMatches = responseText.matchAll(/<<<\s*([a-zA-Z0-9_.-]+)\s*:\s*(\{[\s\S]*?\})\s*>+/g);
  for (const match of shorthandMatches) {
    try {
      const rawName = match[1];
      const rawArgs = safeParseToolJson(match[2]);
      if (rawArgs) {
        const { name, args } = normalizeToolCallForHermes(rawName, rawArgs, availableToolNames);
        toolCalls.push(createToolCallObject(name, args, toolCalls.length));
      }
    } catch (e) {}
  }

  // 2. <<<TOOL_CALL>>> {"name": "...", "arguments": {...}} <<<END>>> (or >>>)
  const blockMatches = responseText.matchAll(/<<<TOOL_CALL>>>([\s\S]*?)(?:<<<END>+|>+)/gi);
  for (const match of blockMatches) {
    try {
      let cleaned = match[1].trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = safeParseToolJson(cleaned);
      if (parsed) {
        const rawName = parsed.name || parsed.tool || parsed.function;
        const rawArgs = parsed.arguments || parsed.args || parsed.parameters || parsed;
        if (rawName) {
          const { name, args } = normalizeToolCallForHermes(rawName, rawArgs, availableToolNames);
          toolCalls.push(createToolCallObject(name, args, toolCalls.length));
        }
      }
    } catch (e) {}
  }

  // 3. <<<tool_name("arg1")>>> or <<<tool_name({"param":"val"})>>>
  if (toolCalls.length === 0) {
    const fnCallMatches = responseText.matchAll(/<<<\s*([a-zA-Z0-9_.-]+)\s*\(([\s\S]*?)\)\s*>+/g);
    for (const match of fnCallMatches) {
      try {
        const rawName = match[1].trim();
        const inner = match[2].trim();
        let rawArgs = null;
        if (inner.startsWith('{')) {
          rawArgs = safeParseToolJson(inner);
        } else {
          const strMatch = inner.match(/^["']([\s\S]*)["']$/);
          const val = strMatch ? strMatch[1].replace(/\\"/g, '"').replace(/\\ /g, ' ') : inner;
          if (/^(run|terminal|bash|exec|execute_command|shell|cmd)$/i.test(rawName)) {
            rawArgs = { command: val };
          } else if (/^(read|read_file|view_file)$/i.test(rawName)) {
            rawArgs = { path: val };
          } else if (/^(web_search|search_web|google|bing|internet_search)$/i.test(rawName)) {
            rawArgs = { query: val };
          } else if (/^(web_extract|fetch_url|read_url)$/i.test(rawName)) {
            rawArgs = { urls: [val] };
          } else if (/^(search_files|grep|find|list_dir|ls)$/i.test(rawName)) {
            rawArgs = { pattern: val };
          } else if (/^(skill_view|view_skill|load_skill)$/i.test(rawName)) {
            rawArgs = { name: val };
          }
        }
        if (rawArgs) {
          const { name, args } = normalizeToolCallForHermes(rawName, rawArgs, availableToolNames);
          toolCalls.push(createToolCallObject(name, args, toolCalls.length));
        }
      } catch (e) {}
    }
  }

  return toolCalls;
}

function parseActionXML(responseText, availableToolNames) {
  const toolCalls = [];

  // <execute_command><command>...</command></execute_command>
  const execMatches = responseText.matchAll(/<execute_command>\s*<command>([\s\S]*?)<\/command>\s*<\/execute_command>/gi);
  for (const m of execMatches) {
    const { name, args } = normalizeToolCallForHermes('terminal', { command: m[1].trim() }, availableToolNames);
    toolCalls.push(createToolCallObject(name, args, toolCalls.length));
  }

  // <write_to_file><path>...</path><content>...</content></write_to_file>
  const writeMatches = responseText.matchAll(/<write_to_file>\s*<path>([\s\S]*?)<\/path>\s*<content>([\s\S]*?)<\/content>\s*<\/write_to_file>/gi);
  for (const m of writeMatches) {
    const { name, args } = normalizeToolCallForHermes('write_file', { path: m[1].trim(), content: m[2] }, availableToolNames);
    toolCalls.push(createToolCallObject(name, args, toolCalls.length));
  }

  // <read_file><path>...</path></read_file>
  const readMatches = responseText.matchAll(/<read_file>\s*<path>([\s\S]*?)<\/path>\s*<\/read_file>/gi);
  for (const m of readMatches) {
    const { name, args } = normalizeToolCallForHermes('read_file', { path: m[1].trim() }, availableToolNames);
    toolCalls.push(createToolCallObject(name, args, toolCalls.length));
  }

  return toolCalls;
}

function parseMinimaxXML(responseText, availableToolNames) {
  const minimaxMatch = responseText.match(/<minimax:tool_call>(.*?)<\/minimax:tool_call>/s);
  if (!minimaxMatch) return [];

  const toolCalls = [];
  const invokeMatches = minimaxMatch[1].matchAll(/<invoke\s+([^>]+)>(.*?)<\/invoke>/gs);

  for (const invokeMatch of invokeMatches) {
    const attrs = invokeMatch[1];
    const innerContent = invokeMatch[2];

    let toolName = '';
    const args = {};

    const attrPairs = attrs.matchAll(/(\w+):\s*"([^"]*)"/g);
    for (const attrPair of attrPairs) {
      const [, attrName, attrValue] = attrPair;
      if (!toolName) {
        toolName = extractToolName(attrName);
      }

      const mappedName = mapToolAttribute(attrName);
      if (mappedName) {
        args[mappedName] = attrValue;
      }
    }

    const paramMatches = innerContent.matchAll(/<parameter\s+name="([^"]+)">([^<]*)<\/parameter>/g);
    for (const paramMatch of paramMatches) {
      args[paramMatch[1]] = paramMatch[2].trim();
    }

    if (toolName && Object.keys(args).length > 0) {
      const normalized = normalizeToolCallForHermes(toolName, args, availableToolNames);
      toolCalls.push(createToolCallObject(normalized.name, normalized.args, toolCalls.length));
    }
  }

  return toolCalls;
}

function parseClaudeXML(responseText, availableToolNames) {
  const toolCalls = [];
  const functionCallMatches = responseText.matchAll(/<invoke\s+name="([^"]+)">\s*<parameter_list>\s*(.*?)\s*<\/parameter_list>\s*<\/invoke>/gs);

  for (const match of functionCallMatches) {
    const [, toolName, parametersXml] = match;
    const args = {};

    const paramMatches = parametersXml.matchAll(/<parameter\s+name="([^"]+)">(.*?)<\/parameter>/gs);
    for (const paramMatch of paramMatches) {
      const [, paramName, paramValue] = paramMatch;
      args[paramName] = paramValue.trim();
    }

    if (toolName && Object.keys(args).length > 0) {
      const normalized = normalizeToolCallForHermes(toolName, args, availableToolNames);
      toolCalls.push(createToolCallObject(normalized.name, normalized.args, toolCalls.length));
    }
  }

  return toolCalls;
}

function parseOpenAIToolCalls(responseText, availableToolNames) {
  const toolCalls = [];

  try {
    const toolCallMatch = responseText.match(/"tool_calls"\s*:\s*\[(.*?)\]/s);
    if (!toolCallMatch) return [];

    const toolCallArray = `[${toolCallMatch[1]}]`;
    const parsedToolCalls = JSON.parse(toolCallArray);

    for (const toolCall of parsedToolCalls) {
      if (toolCall.function && toolCall.function.name) {
        const rawArgs = typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : (toolCall.function.parameters || {});
        const normalized = normalizeToolCallForHermes(toolCall.function.name, rawArgs, availableToolNames);
        toolCalls.push({
          id: toolCall.id || createToolCallId(toolCalls.length),
          type: toolCall.type || 'function',
          function: {
            name: normalized.name,
            arguments: JSON.stringify(normalized.args),
          },
        });
      }
    }
  } catch (error) {
    return [];
  }

  return toolCalls;
}

function parseTextFormat(responseText, availableToolNames) {
  const toolCalls = [];
  let currentIndex = 0;

  const patterns = [
    /TOOL_CALL:\s*([a-zA-Z0-9_-]+)[\s\S]*?ARGUMENTS:\s*\{/i,
    /TOOL_CALL:\s*([a-zA-Z0-9_-]+)ARGUMENTS:\s*\{/i,
  ];

  while (currentIndex < responseText.length) {
    let toolCallMatch = null;

    for (const pattern of patterns) {
      toolCallMatch = responseText.substring(currentIndex).match(pattern);
      if (toolCallMatch) break;
    }

    if (!toolCallMatch) break;

    const rawToolName = toolCallMatch[1];
    const fullMatchText = toolCallMatch[0];
    const matchStartIndex = currentIndex + toolCallMatch.index;
    const argsStartIndex = matchStartIndex + fullMatchText.lastIndexOf('{');

    let braceCount = 0;
    let argsEndIndex = argsStartIndex;
    let foundClosingBrace = false;
    let inString = false;
    let escaped = false;

    for (let i = argsStartIndex; i < responseText.length; i++) {
      const char = responseText[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === '{') {
          braceCount++;
        } else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            argsEndIndex = i + 1;
            foundClosingBrace = true;
            break;
          }
        }
      }
    }

    if (!foundClosingBrace) {
      console.warn('[Tool Parsing] Incomplete JSON for tool call:', rawToolName);
      break;
    }

    const argsString = responseText.substring(argsStartIndex, argsEndIndex);

    try {
      const rawArgs = safeParseToolJson(argsString);
      if (!rawArgs) break;
      const { name, args } = normalizeToolCallForHermes(rawToolName, rawArgs, availableToolNames);
      toolCalls.push(createToolCallObject(name, args, toolCalls.length));
      currentIndex = argsEndIndex;
    } catch (error) {
      console.error('Failed to parse tool call arguments:', error);
      break;
    }
  }

  return toolCalls;
}

function mapToolAttribute(attrName) {
  const mappings = {
    'readfilePath': 'path',
    'bashcommand': 'command',
  };
  return mappings[attrName] || attrName;
}

function extractToolName(attrName) {
  if (attrName === 'bash' || attrName === 'bashcommand') return 'terminal';
  if (attrName === 'read' || attrName === 'readfilePath') return 'read_file';
  return attrName;
}

function createToolCallObject(toolName, args, index) {
  return {
    id: createToolCallId(index),
    type: 'function',
    function: {
      name: toolName,
      arguments: JSON.stringify(args),
    },
  };
}

function createToolCallId(index) {
  return `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}_${index}`;
}

export function formatToolCallResponse(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) {
    return null;
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'glm-5.2',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        tool_calls: toolCalls,
        content: null,
      },
      finish_reason: 'tool_calls',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function formatToolResultMessage(toolCallId, result) {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: typeof result === 'string' ? result : JSON.stringify(result),
  };
}
