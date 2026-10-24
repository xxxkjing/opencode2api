#!/usr/bin/env node
/**
 * opencode2api —— 自写网关（Docker 部署即用）
 * 把 OpenAI 兼容 API 转成 opencode serve 协议（v2 /session + /message）
 * 零依赖，纯 node:http + fetch。
 *
 * 环境变量：
 *   OC2A_AUTH           网关 Bearer 鉴权 secret（必填，不填则无鉴权）
 *   OPENCODE_SERVER_URL 默认 http://127.0.0.1:4096
 *   PORT                网关端口，默认 10000
 *   MODELS_URL          models.opencode.ai/api.json，默认官方
 */
import http from 'node:http';
import crypto from 'node:crypto';

const GATEWAY_AUTH=process.env["OC2A_AUTH"] || '';
const SERVER = (process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:4096').replace(/\/$/, '');
const PORT = parseInt(process.env.PORT || '10000', 10);
const MODELS_URL = process.env.MODELS_URL || 'https://models.opencode.ai/api.json';

// ---------- 模型列表（优先 serve 本地 config，fallback api.json） ----------
let MODELS = [];
async function loadModels() {
  // 1) 本地 serve /config/providers（CLI 有 api.json 缓存，最可靠）
  try {
    const r = await fetch(SERVER + '/config/providers', { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const d = await r.json();
      const op = (d.providers || []).find((p) => p.id === 'opencode');
      const ms = op?.models;
      if (ms) {
        MODELS = Object.entries(ms)
          .map(([id, cfg]) => ({
            id: 'opencode/' + id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'opencode',
            context: cfg.limit?.context || null,
            cost: cfg.cost || null,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
        return;
      }
    }
  } catch (e) {
    console.error('[models] serve config failed:', e.message);
  }
  // 2) fallback: models.opencode.ai/api.json
  try {
    const r = await fetch(MODELS_URL, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('models fetch ' + r.status);
    const d = await r.json();
    const op = d.opencode || {};
    MODELS = Object.entries(op.models || {})
      .map(([id, cfg]) => ({
        id: 'opencode/' + id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'opencode',
        context: cfg.limit?.context || null,
        cost: cfg.cost || null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (e) {
    console.error('[models] remote fetch failed:', e.message);
  }
}
loadModels();
setInterval(loadModels, 6 * 3600 * 1000);

// ---------- opencode serve 调用 ----------
async function oc(path, opts = {}) {
  const r = await fetch(SERVER + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-opencode-client': 'cli', 'User-Agent': 'opencode/1.19.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 120000),
  });
  const txt = await r.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { data = txt; }
  if (!r.ok) {
    const err = new Error('opencode ' + r.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data).slice(0, 400)));
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

// 等一条 assistant 消息完成：轮询 /session/{id}/message
async function waitForAssistant(sessionId, maxWaitMs = 120000) {
  const deadline = Date.now() + maxWaitMs;
  let emptyStreak = 0;
  while (Date.now() < deadline) {
    const msgs = await oc(`/session/${sessionId}/message`);
    const list = msgs?.items ?? msgs ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const role = m.info?.role ?? m.role;
      const err = m.info?.error ?? m.error;
      if (err) {
        const msg = typeof err === 'string' ? err : (err.message || JSON.stringify(err).slice(0, 300));
        const e = new Error('model error: ' + msg);
        e.status = 502;
        throw e;
      }
      if (role === 'assistant') {
        const parts = m.parts || [];
        const textParts = parts.filter((p) => p.type === 'text' && p.text);
        if (textParts.length > 0) {
          const text = textParts.map((p) => p.text).join('\n');
          return { text, message: m };
        }
        // assistant 存在但无文本：服务端可能拒绝了请求（额度/地区/禁用），
        // 消息不会再有内容。连续几轮无变化视为终态。
        emptyStreak += 1;
        if (emptyStreak >= 3) return { text: '', message: m };
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('timeout waiting for assistant reply');
}

// ---------- OpenAI -> opencode ----------
function buildPrompt(messages) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const hist = messages.filter((m) => m.role !== 'system');
  const text = hist
    .map((m) => {
      const c = Array.isArray(m.content) ? m.content.map((p) => p.text || p.image_url?.url || '').join(' ') : m.content;
      return `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${c}`;
    })
    .join('\n\n');
  return { sys: sys || undefined, text: text || 'Hello' };
}

async function handleChat(reqBody) {
  const modelRaw = reqBody.model || 'opencode/space-bunny-free';
  const modelID = modelRaw.replace(/^opencode\//, '');
  const { sys, text } = buildPrompt(reqBody.messages || []);

  const session = await oc('/session', {
    method: 'POST',
    body: JSON.stringify({ model: { id: modelID, providerID: 'opencode' } }),
  });
  const sessionId = session.id || session.sessionID;
  if (!sessionId) throw new Error('no session id: ' + JSON.stringify(session).slice(0, 200));

  try {
    // 同步 prompt：serve 会跑 agent loop 但响应流可能不关闭（serve bug）。
    // fire-and-forget 发起，轮询 messages 拿结果。
    oc(`/session/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({
        messageID: 'msg_' + crypto.randomBytes(8).toString('hex'),
        model: { providerID: 'opencode', modelID },
        system: sys,
        parts: [{ type: 'text', text }],
      }),
      timeout: 180000,
    }).catch(() => {});

    const { text: reply } = await waitForAssistant(sessionId);
    return reply;
  } finally {
    try { await oc(`/session/${sessionId}`, { method: 'DELETE' }); } catch {}
  }
}

// ---------- OpenAI 响应 ----------
function openaiResponse(model, content) {
  return {
    id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const path = u.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (GATEWAY_AUTH) {
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + GATEWAY_AUTH) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'auth_error' } }));
      return;
    }
  }

  try {
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: MODELS }));
      return;
    }
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: SERVER, models: MODELS.length, uptime: process.uptime() }));
      return;
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      let body = '';
      for await (const c of req) body += c;
      const reqBody = JSON.parse(body || '{}');
      const modelRaw = reqBody.model || 'opencode/space-bunny-free';
      const reply = await handleChat(reqBody);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openaiResponse(modelRaw, reply)));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found: ' + path, type: 'not_found' } }));
  } catch (e) {
    const status = e.status || 502;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: e.message || String(e),
        type: status === 401 ? 'auth_error' : 'upstream_error',
        upstream: e.data || undefined,
      },
    }));
  }
});

server.listen(PORT, () => {
  console.log(`opencode2api gateway on :${PORT}, opencode server=${SERVER}, auth=${GATEWAY_AUTH ? 'set' : 'EMPTY'}`);
});