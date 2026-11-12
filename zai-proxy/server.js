const http = require('http');
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');

const PORT = 8002;
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TOKEN = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImY1NDRkYWJiLTI2OWYtNGJmMi1iMTQ5LWFjMGI0YjljOWU3NyIsImVtYWlsIjoibW9ydHRoYWFsbGlhM0BnbWFpbC5jb20iLCJyZWdpb24iOiJnbG9iYWwiLCJjbGkiOiJ3ZWIifQ.oKUtlXoFJUpL7LLbtvOGk25pnl20VyJ0V-csGOsYS9HWv_GHwf77V_6jGIYHNTt1Nu2lAWgfm3Ty_UyM0Bi6nQ';

let browser = null;
let page = null;
let isReady = false;
let sessionInitialized = false;

const queue = [];
let processing = false;

function formatCompactToolsZai(availableTools) {
  if (!Array.isArray(availableTools) || availableTools.length === 0) {
    return 'CORE: terminal(command,workdir?) | read_file(path,offset?,limit?) | write_file(path,content) | patch(path,old_string,new_string) | search_files(pattern,target?,path?) | web_search(query,limit?) | web_extract(urls) | vision_analyze(image_url,question) | read_video(path,max_frames?) | memory(action,target,content) | delegate_task(tasks)';
  }
  return availableTools
    .filter(t => t && (t.function?.name || t.name))
    .map(t => {
      const fn = t.function || t;
      const props = fn.parameters?.properties ? Object.keys(fn.parameters.properties).slice(0, 5).join(',') : '';
      return `${fn.name}(${props})`;
    })
    .join(' | ');
}

function buildUpstreamPrompt(messages, availableTools = []) {
  let cwd = 'C:/Users/hhjksd';

  for (const m of messages) {
    if (typeof m.content === 'string') {
      const cwdMatch = m.content.match(/Current working directory:\s*([^\r\n]+)/) ||
                       m.content.match(/Root:\s*([^\r\n]+)/);
      if (cwdMatch && cwdMatch[1]) {
        cwd = cwdMatch[1].trim().replace(/\\/g, '/');
      }
    }
  }

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastText = lastMsg
    ? (typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content))
    : '';

  const isToolResultTurn = lastText.startsWith('Tool output:') || lastText.startsWith('[Tool Result]:');

  if (isToolResultTurn && sessionInitialized) {
    return {
      promptText: `${lastText}\nNext: Emit <<<tool_name:{"param":"value"}>>> on line 1 (prefer 1-pass Python script for big reads/3D/pptx) or final natural response.`,
      startNewChat: false
    };
  }

  sessionInitialized = true;
  const compactTools = formatCompactToolsZai(availableTools);
  const microPrompt =
`[SYS] Autonomous Principal Engineer, Deep Researcher & 3D Artist (full OS/CLI/MCP access; Python 3D: trimesh,numpy,scipy; Docs: pypdf,python-pptx).
[WS] ${cwd}
[RULES] Act immediately; batch large reads/3D/pptx in 1 Python script via terminal; call tools on line 1 ONLY: <<<tool_name:{"param":"value"}>>>.
[TOOLS] ${compactTools}
[GOAL] ${lastText}`;

  return {
    promptText: microPrompt,
    startNewChat: true
  };
}

async function initBrowser() {
  console.log('[Z.ai Upstream] Starting Headless Edge Browser...');
  try {
    browser = await puppeteer.launch({
      executablePath: EDGE_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=TrackingPrevention',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
      ]
    });

    page = await browser.newPage();
    page.setDefaultTimeout(15000);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('completions') && req.method() === 'POST') {
        try {
          const postData = JSON.parse(req.postData());
          if (postData.features) {
            postData.features.flags = [];
            postData.features.preview_mode = false;
            postData.features.enable_thinking = false;
            postData.features.reasoning_effort = 'low';
          }
          req.continue({ postData: JSON.stringify(postData) });
          return;
        } catch (e) {}
      }
      req.continue();
    });

    await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded' });

    await page.evaluate((tok) => {
      localStorage.setItem('token', tok);
      sessionStorage.setItem('token', tok);
    }, TOKEN);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1500));
    await dismissPopovers();

    isReady = true;
    console.log(`[Z.ai Upstream] Ready on http://localhost:${PORT}/v1`);
  } catch (err) {
    console.error('[Z.ai Upstream] Initialization error:', err);
    setTimeout(initBrowser, 3000);
  }
}

async function dismissPopovers() {
  try {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const maybeLater = btns.find(b => b.innerText && b.innerText.includes('Maybe Later'));
      if (maybeLater) maybeLater.click();
      const closeBtn = document.querySelector('.driver-popover-close-btn');
      if (closeBtn) closeBtn.click();
    });
  } catch (e) {}
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  const item = queue.shift();
  try {
    await handleCompletion(item.messages, item.res, item.model, item.tools);
  } catch (err) {
    console.error('[Z.ai Upstream] Request handling error:', err);
    if (!item.res.headersSent) {
      item.res.writeHead(500, { 'Content-Type': 'application/json' });
      item.res.end(JSON.stringify({ error: { message: err.message } }));
    }
  } finally {
    processing = false;
    processQueue();
  }
}

async function handleCompletion(messages, res, requestedModel, availableTools = []) {
  const { promptText, startNewChat } = buildUpstreamPrompt(messages, availableTools);
  const reqId = 'chatcmpl-' + crypto.randomUUID();
  const modelName = requestedModel || 'glm-5.2';

  let rawFullContent = '';
  let completed = false;

  if (startNewChat) {
    try {
      const currentUrl = page.url();
      if (currentUrl.includes('/c/')) {
        await page.evaluate(() => {
          const btn = document.getElementById('sidebar-new-chat-button') || document.querySelector('a[href="/"]');
          if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 350));
      }
    } catch (e) {}
  }

  await dismissPopovers();

  return new Promise(async (resolve, reject) => {
    let responseHandler = null;

    const timeoutTimer = setTimeout(async () => {
      if (completed) return;
      completed = true;
      if (responseHandler) page.off('response', responseHandler);

      if (!rawFullContent) {
        try {
          const domText = await page.evaluate(() => {
            const el = document.querySelectorAll('.chat-item, [data-message-role="assistant"], .prose');
            return el.length ? el[el.length - 1].innerText : '';
          });
          if (domText) rawFullContent = domText;
        } catch (e) {}
      }

      finishResponse(rawFullContent || 'OK');
      resolve();
    }, 60000);

    function finishResponse(finalText) {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutTimer);
      if (responseHandler) page.off('response', responseHandler);

      console.log(`[Z.ai Upstream] Completed (${finalText.length} chars): ${finalText.substring(0, 120).replace(/\n/g, ' ')}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: reqId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: finalText },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: Math.ceil(promptText.length / 4),
          completion_tokens: Math.ceil(finalText.length / 4),
          total_tokens: Math.ceil((promptText.length + finalText.length) / 4)
        }
      }));
    }

    responseHandler = async (interceptedRes) => {
      if (interceptedRes.url().includes('completions')) {
        try {
          const bodyText = await interceptedRes.text();
          const lines = bodyText.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
              try {
                const parsed = JSON.parse(line.substring(6));
                const delta = parsed.data?.delta_content || parsed.data?.edit_content || '';
                if (delta) {
                  rawFullContent += delta;
                }
              } catch (e) {}
            }
          }

          if (bodyText.includes('[DONE]') || interceptedRes.status() === 200) {
            setTimeout(() => {
              finishResponse(rawFullContent);
              resolve();
            }, 250);
          }
        } catch (e) {}
      }
    };

    page.on('response', responseHandler);

    try {
      await page.waitForSelector('#chat-input', { timeout: 8000 });

      await page.evaluate((val) => {
        const textarea = document.getElementById('chat-input');
        if (!textarea) return;
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(textarea, val);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }, promptText);

      await page.focus('#chat-input');
      await page.keyboard.type(' ');
      await new Promise(r => setTimeout(r, 60));

      const clicked = await page.evaluate(() => {
        const btn = document.getElementById('send-message-button');
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        await page.keyboard.press('Enter');
      }
    } catch (err) {
      clearTimeout(timeoutTimer);
      if (responseHandler) page.off('response', responseHandler);
      reject(err);
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'zai-upstream', ready: isReady }));
    return;
  }

  if (req.url === '/v1/models' || req.url === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'glm-5.2', object: 'model', name: 'GLM-5.2', max_output: 16384, word_limit: 256000 },
        { id: 'glm-5.3', object: 'model', name: 'GLM-5.3', max_output: 16384, word_limit: 256000 },
      ]
    }));
    return;
  }

  if ((req.url === '/v1/chat/completions' || req.url === '/chat/completions') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const messages = payload.messages || [];
        const model = payload.model || 'glm-5.2';
        const tools = payload.tools || [];

        if (!isReady) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Z.ai Upstream initializing' } }));
          return;
        }

        queue.push({ messages, res, model, tools });
        processQueue();
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found' } }));
});

server.listen(PORT, async () => {
  console.log(`[Z.ai Upstream] Listening on http://localhost:${PORT}/v1`);
  await initBrowser();
});
