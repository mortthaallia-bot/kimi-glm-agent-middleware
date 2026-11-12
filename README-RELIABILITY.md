# Kimi & GLM Agent Middleware: Context Overflow Protection & Reliability Guide

## Overview
This middleware acts as an OpenAI-compatible bridge between the Hermes Desktop development agent and Moonshot Kimi / GLM upstream models. It includes production-grade reliability features designed to eliminate HTTP 500 errors, context window bloat, and accidental directory crawling.

---

## 1. Context Window Threshold & Auto-Reset

### How it Works
1. **Pre-Request Token Check:** Before each turn is forwarded to the upstream model, the middleware calculates estimated tokens (`JSON.stringify(messages).length / 4`).
2. **Safe Threshold Evaluation:** If the estimated token count exceeds `MAX_CONTEXT_TOKENS` (default: 80,000 tokens, ~65% of Kimi's 128k ceiling), the middleware initiates an automatic session reset.
3. **Structured Compression:**
   - Summarizes past turns into key user goals, files touched, actions taken, and recent diagnostic errors.
   - Condenses the session into: `[System Prompt] + [Auto-Session Reset Summary] + [Last 2–4 Messages]`.
   - Wipes upstream session ID cache to start a clean conversational cascade.
4. **Self-Healing Error Recovery:** If an upstream request fails due to context limits or timeouts (`Kimi stream stalled before first token (25s)` / `REASON_CHAT_CONCURRENCY_EXCEEDED`), the middleware catches the failure, compresses the session, and retries the request **once**. If the retry also fails, it returns a structured OpenAI-compatible error rather than a raw 500 crash.

### Configuration (`.env`)
```bash
# Enable or disable automatic context compression and session reset
AUTO_SESSION_RESET=true

# Maximum context token ceiling before triggering auto-reset (Default: 80000)
MAX_CONTEXT_TOKENS=80000

# Number of recent turns to preserve after summarization (Default: 3)
RESET_KEEP_MESSAGES=3

# Maximum prefill wait time for Moonshot TTFT on large contexts in ms (Default: 25000)
INITIAL_IDLE_TIMEOUT_MS=25000

# Maximum stream idle wait time between tokens in ms (Default: 8000)
STREAM_IDLE_TIMEOUT_MS=8000

# Total maximum request timeout ceiling in ms (Default: 90000)
MAX_TOTAL_TIMEOUT_MS=90000
```

---

## 2. File & Directory Reading Restrictions

### Blocked Paths
The agent is explicitly forbidden from reading or traversing directories that trigger instant context window inflation:
- `node_modules/`
- `.git/`
- Build outputs: `dist/`, `build/`, `out/`, `.next/`, `.cache/`, `coverage/`
- Remotion artifacts: `.remotion/`, `remotion/build/`, `remotion/bundle/`, `remotion/dist/`
- Lockfiles: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`
- Binaries, compressed archives, and media: `.exe`, `.dll`, `.bin`, `.iso`, `.zip`, `.mp4`, `.png`, `.jpg`, etc.

### Behavior on Violation
When the agent issues `read_file` or `patch` targeting a blocked path:
- The middleware intercepts the tool call before file system access.
- It automatically substitutes the tool with a safe terminal command returning:
  `[GUARDRAIL BLOCKED]: Access to '<path>' is blocked by middleware guardrails. Inspect package.json or source directories instead.`
- This informs the agent to correct its course without inflating the context window.

### File Size Limits
- Files exceeding `MAX_FILE_READ_SIZE_KB` (default: 200 KB) are automatically capped to `MAX_READ_LINES` (default: 150 lines) with a notice instructing the agent to specify exact line ranges (`offset` and `limit`).
- `search_files` output is capped to a maximum of 50 matches (`MAX_SEARCH_MATCHES=50`).

### Configuration (`.env`)
```bash
# Maximum allowed file size for full read in KB (Default: 200)
MAX_FILE_READ_SIZE_KB=200

# Maximum lines returned for oversized files (Default: 150)
MAX_READ_LINES=150

# Maximum matches returned by search_files / grep (Default: 50)
MAX_SEARCH_MATCHES=50
```

---

## 3. Running Verification Tests

To verify the auto-reset logic, guardrail filters, and retry limits:

```bash
# Run unit test suite
node --test __tests__/reliability.test.js
```
