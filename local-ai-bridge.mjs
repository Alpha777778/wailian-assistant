import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOST = process.env.LOCAL_AI_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.LOCAL_AI_BRIDGE_PORT || 8765);
const CODEX_CONFIG_PATH = path.join(process.env.USERPROFILE || '', '.codex', 'config.toml');
const CODEX_AUTH_PATH = path.join(process.env.USERPROFILE || '', '.codex', 'auth.json');
const CLAUDE_SETTINGS_PATH = path.join(process.env.USERPROFILE || '', '.claude', 'settings.json');
const CLAUDE_CREDENTIALS_PATH = path.join(process.env.USERPROFILE || '', '.claude', '.credentials.json');

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, statusCode, payload) {
  withCors(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function isLoopback(remoteAddress = '') {
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextFile(filePath) {
  if (!existsSync(filePath)) return '';
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function extractCodexModel() {
  const text = readTextFile(CODEX_CONFIG_PATH);
  const match = text.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return match?.[1] || 'gpt-5.4';
}

function extractClaudeModel() {
  const settings = readJsonFile(CLAUDE_SETTINGS_PATH);
  return settings?.model || 'claude-sonnet-4-6';
}

function normalizeRequestedModel(provider, model) {
  const value = String(model || '').trim();
  if (!value) return '';
  if (provider === 'codex') {
    return /^(gpt|o\d|codex|oss)/i.test(value) ? value : '';
  }
  if (provider === 'claude') {
    return /^claude/i.test(value) ? value : '';
  }
  return value;
}

function getProviderStatus() {
  const claudeSettings = readJsonFile(CLAUDE_SETTINGS_PATH) || {};
  const claudeCreds = readJsonFile(CLAUDE_CREDENTIALS_PATH) || {};

  return {
    codex: {
      available: existsSync(CODEX_CONFIG_PATH) || existsSync(CODEX_AUTH_PATH),
      defaultModel: extractCodexModel(),
      configPath: CODEX_CONFIG_PATH,
    },
    claude: {
      available: !!(claudeSettings?.env?.ANTHROPIC_AUTH_TOKEN || claudeSettings?.env?.ANTHROPIC_API_KEY || claudeCreds?.claudeAiOauth?.accessToken),
      defaultModel: extractClaudeModel(),
      configPath: CLAUDE_SETTINGS_PATH,
    },
  };
}

function contentToText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

function splitMessages(messages = []) {
  const system = [];
  const conversation = [];
  for (const message of messages) {
    const text = contentToText(message?.content);
    if (!text) continue;
    if (message.role === 'system') system.push(text);
    else conversation.push({ role: message.role || 'user', text });
  }
  return {
    systemText: system.join('\n\n').trim(),
    conversation,
  };
}

function buildCodexPrompt(messages) {
  const { systemText, conversation } = splitMessages(messages);
  const dialogue = conversation
    .map(item => `${String(item.role || 'user').toUpperCase()}:\n${item.text}`)
    .join('\n\n');

  return [
    systemText ? `System instructions:\n${systemText}` : '',
    'Follow the system instructions exactly. Return only the final answer content.',
    dialogue ? `Conversation:\n${dialogue}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildAnthropicMessages(messages) {
  const { conversation } = splitMessages(messages);
  return conversation.map(item => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: item.text,
  }));
}

function buildOpenAiLikeResponse(content, model) {
  return {
    id: `chatcmpl-local-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content,
        },
      },
    ],
  };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function runProcess(command, args, { cwd = __dirname, input = '', timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function runCodexCompletion({ messages, model }) {
  const prompt = buildCodexPrompt(messages);
  const requestedModel = normalizeRequestedModel('codex', model) || extractCodexModel();
  const outputFile = path.join(tmpdir(), `wailian-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--dangerously-bypass-approvals-and-sandbox',
    '--color', 'never',
    '-c', 'model_reasoning_effort="low"',
    '-C', __dirname,
    '-o', outputFile,
  ];

  if (requestedModel) args.push('-m', requestedModel);

  const result = await runProcess('codex', args, { input: prompt });
  const content = existsSync(outputFile) ? readTextFile(outputFile).trim() : '';
  if (existsSync(outputFile)) {
    try { unlinkSync(outputFile); } catch {}
  }

  if (!content && result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Codex exited with code ${result.code}`);
  }
  if (!content) {
    throw new Error('Codex returned empty content');
  }

  return {
    model: requestedModel,
    content,
  };
}

async function runClaudeCompletion({ messages, model, maxTokens = 800, temperature = 0.2 }) {
  const settings = readJsonFile(CLAUDE_SETTINGS_PATH) || {};
  const credentials = readJsonFile(CLAUDE_CREDENTIALS_PATH) || {};
  const baseUrl = String(settings?.env?.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const apiKey = settings?.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const authToken = settings?.env?.ANTHROPIC_AUTH_TOKEN || credentials?.claudeAiOauth?.accessToken || process.env.ANTHROPIC_AUTH_TOKEN || '';

  if (!apiKey && !authToken) {
    throw new Error('Claude credentials were not found in ~/.claude');
  }

  const { systemText } = splitMessages(messages);
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey) headers['x-api-key'] = apiKey;
  else headers.Authorization = `Bearer ${authToken}`;

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: normalizeRequestedModel('claude', model) || extractClaudeModel(),
      max_tokens: Math.min(Math.max(Number(maxTokens) || 800, 64), 4096),
      temperature,
      system: systemText || undefined,
      messages: buildAnthropicMessages(messages),
    }),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}

  if (!response.ok) {
    const errorText = data?.error?.message || text || response.statusText;
    throw new Error(`Claude request failed: ${response.status} ${errorText}`);
  }

  const content = Array.isArray(data?.content)
    ? data.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').trim()
    : '';

  if (!content) {
    throw new Error('Claude returned empty content');
  }

  return {
    model: normalizeRequestedModel('claude', model) || extractClaudeModel(),
    content,
  };
}

async function completeRequest(body) {
  const provider = body?.provider === 'claude' ? 'claude' : 'codex';
  const payload = {
    messages: Array.isArray(body?.messages) ? body.messages : [],
    model: body?.model || '',
    maxTokens: body?.max_tokens,
    temperature: typeof body?.temperature === 'number' ? body.temperature : 0.2,
  };

  if (!payload.messages.length) {
    throw new Error('messages is required');
  }

  if (provider === 'claude') return runClaudeCompletion(payload);
  return runCodexCompletion(payload);
}

const server = createServer(async (req, res) => {
  withCors(res);

  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: 'loopback only' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/providers')) {
    sendJson(res, 200, {
      ok: true,
      host: HOST,
      port: PORT,
      providers: getProviderStatus(),
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    try {
      const body = await parseJsonBody(req);
      const result = await completeRequest(body);
      sendJson(res, 200, buildOpenAiLikeResponse(result.content, result.model));
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[local-ai-bridge] listening on http://${HOST}:${PORT}`);
});
