const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WATCHDOG_PORT = parseInt(process.env.WATCHDOG_PORT || '8099', 10);
const NODE_EXE = process.execPath || 'node';
const BASE_DIR = process.env.BASE_DIR || path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE_DIR, 'logs');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Support both 'glm-agent-server' and 'DOAI-Proxy' directory names
const glmDir = fs.existsSync(path.join(BASE_DIR, 'glm-agent-server'))
  ? path.join(BASE_DIR, 'glm-agent-server')
  : path.join(BASE_DIR, 'DOAI-Proxy');

const SERVICES = [
  {
    name: 'kimi-agent-server',
    cwd: path.join(BASE_DIR, 'kimi-agent-server'),
    script: 'server.js',
    healthUrl: 'http://127.0.0.1:8001/health',
    ports: [8001, 8000],
    child: null,
    restarts: 0,
    failedChecks: 0,
    status: 'init',
  },
  {
    name: 'glm-agent-server',
    cwd: glmDir,
    script: 'server.js',
    healthUrl: 'http://127.0.0.1:3000/health',
    ports: [3000],
    child: null,
    restarts: 0,
    failedChecks: 0,
    status: 'init',
  },
  {
    name: 'zai-proxy',
    cwd: path.join(BASE_DIR, 'zai-proxy'),
    script: 'server.js',
    healthUrl: 'http://127.0.0.1:8002/health',
    ports: [8002],
    child: null,
    restarts: 0,
    failedChecks: 0,
    status: 'init',
  },
];

function logWatchdog(msg) {
  const line = `[${new Date().toISOString()}] [Watchdog] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'watchdog.log'), line);
  } catch (_) {}
}

function checkHealth(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startService(svc) {
  if (svc.child && !svc.child.killed) {
    return;
  }

  logWatchdog(`Starting service ${svc.name} in ${svc.cwd}...`);
  const logFile = path.join(LOG_DIR, `${svc.name}.log`);
  const outStream = fs.createWriteStream(logFile, { flags: 'a' });

  const child = spawn(NODE_EXE, [svc.script], {
    cwd: svc.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  svc.child = child;
  svc.status = 'starting';
  svc.failedChecks = 0;

  child.stdout.pipe(outStream, { end: false });
  child.stderr.pipe(outStream, { end: false });

  child.on('exit', (code, signal) => {
    logWatchdog(`Service ${svc.name} exited (code=${code}, signal=${signal}). Scheduling auto-restart in 2s...`);
    svc.child = null;
    svc.status = 'stopped';
    svc.restarts += 1;
    setTimeout(() => {
      startService(svc);
    }, 2000);
  });

  child.on('error', (err) => {
    logWatchdog(`Failed to spawn ${svc.name}: ${err.message}`);
    svc.child = null;
    svc.status = 'error';
    setTimeout(() => {
      startService(svc);
    }, 3000);
  });
}

async function monitorHealth() {
  for (const svc of SERVICES) {
    if (!svc.child || svc.child.killed) {
      logWatchdog(`Service ${svc.name} process is not running. Triggering start...`);
      startService(svc);
      continue;
    }

    const healthy = await checkHealth(svc.healthUrl, 3000);
    if (healthy) {
      svc.status = 'healthy';
      svc.failedChecks = 0;
    } else {
      svc.failedChecks += 1;
      logWatchdog(`Service ${svc.name} health check failed (${svc.failedChecks}/3) on ${svc.healthUrl}`);
      if (svc.failedChecks >= 3) {
        logWatchdog(`Service ${svc.name} failed 3 consecutive health checks. Killing PID ${svc.child.pid} to force clean restart...`);
        try {
          svc.child.kill('SIGKILL');
        } catch (_) {}
      }
    }
  }
}

// Startup all services
logWatchdog('Starting Agent Servers Watchdog Manager...');
SERVICES.forEach(svc => startService(svc));

// Heartbeat health check loop every 10 seconds
setInterval(monitorHealth, 10000);

// Status HTTP Server on WATCHDOG_PORT (8099)
const server = http.createServer((req, res) => {
  if (req.url === '/status' || req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      manager: 'agent-servers-watchdog',
      timestamp: new Date().toISOString(),
      services: SERVICES.map(s => ({
        name: s.name,
        status: s.status,
        restarts: s.restarts,
        failedChecks: s.failedChecks,
        pid: s.child?.pid || null,
        ports: s.ports,
        healthUrl: s.healthUrl,
      })),
    }, null, 2));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(WATCHDOG_PORT, () => {
  logWatchdog(`Watchdog status server listening on http://127.0.0.1:${WATCHDOG_PORT}/status`);
});
