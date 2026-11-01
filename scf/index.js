/**
 * 拍拍学 · 豆包 Ark + 在线发音 转发代理（腾讯云 SCF 云函数）
 *
 * 为什么需要它：
 *   1. 浏览器直连 ark.cn-beijing.volces.com 会被 CORS 拦截，需要服务端转发豆包请求；
 *   2. 整句发音：有道 dictvoice 只支持单词（整句 HTTP 500），百度 gettts 支持整句
 *      但对浏览器请求做 Referer 防盗链（带 Referer 返回空），必须由服务端转发。
 *
 * 函数本身不持有任何密钥：Authorization 由前端带上、原样透传给豆包。
 * 本文件任何地方都不会打印 Authorization 的值，也不要加这样的日志。
 *
 * 路由：
 *   POST /api/ark        → 转发豆包 /api/v3/chat/completions（对话、视觉识别、查词）
 *   GET  /api/ark        → 转发豆包 /api/v3/models（拉取可用模型列表）
 *   GET  /api/ark?tts=文本 → 转发百度整句发音，返回 audio/mpeg
 *   GET  /api/ark?debug=1 → 返回收到的事件结构（仅 DEBUG=1 时开放）
 *
 * 防滥用（可用环境变量覆盖）：
 *   ALLOWED_ORIGINS  允许的浏览器来源，逗号分隔。留空 = 不限制（不建议）
 *   RATE_MAX_PER_IP  每个 IP 每窗口请求上限，默认 30
 *   RATE_MAX_PER_KEY 每把 key 每窗口请求上限，默认 60
 *   RATE_WINDOW_MS   限流窗口，默认 60000ms
 *   MAX_BODY_BYTES   请求体上限，默认 1MB
 *   DEBUG=1          开放 ?debug=1 / ?slowtest= 调试路由
 *
 * ⚠️ 这里的内存限流只在单个函数实例内生效，实例间不共享，冷启动后清零。
 *    真正的兜底请在「函数 URL / API 网关」层配置限流和配额。
 *
 * 部署要点：
 *   - 文件名 index.js，CommonJS（require）
 *   - 入口函数 main_handler（同时导出 main 兼容 CloudBase）
 *   - 只用内置 https / crypto 模块，无外部依赖
 */

const https = require('https');
const crypto = require('crypto');

const UPSTREAM_HOST = 'ark.cn-beijing.volces.com';
const CHAT_PATH = '/api/v3/chat/completions';
const MODELS_PATH = '/api/v3/models';
const BAIDU_TTS_HOST = 'fanyi.baidu.com';
const BAIDU_TTS_PATH = '/gettts?lan=en&spd=3&source=web&text=';

// ---------- 配置 ----------
// 默认值写死成线上域名 + 本地调试地址；换部署域名时记得同步修改（前端 CSP 也要改）
const ALLOWED_ORIGINS = String(
  process.env.ALLOWED_ORIGINS ||
  'https://zpl-essie.github.io,http://localhost:3000,http://127.0.0.1:3000'
).split(',').map(function (s) { return s.trim(); }).filter(Boolean);

const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60 * 1000);
const RATE_MAX_PER_IP = Number(process.env.RATE_MAX_PER_IP || 30);
const RATE_MAX_PER_KEY = Number(process.env.RATE_MAX_PER_KEY || 60);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const DEBUG = process.env.DEBUG === '1';

// 本地/局域网预览放行（serve.py 会把手机接到 http://192.168.x.x:3000），
// 生产域名请写进上面的 ALLOWED_ORIGINS。
const DEV_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.[0-9.]+|10\.[0-9.]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9.]+)(:[0-9]+)?$/;

// 单实例内存限流：bucketKey -> { count, resetAt }
const buckets = new Map();

function hitLimit(bucketKey, max) {
  const now = Date.now();
  if (buckets.size > 2000) { // 顺手清理过期桶，避免内存无限增长
    buckets.forEach(function (b, k) {
      if (now >= b.resetAt) buckets.delete(k);
    });
  }
  const b = buckets.get(bucketKey);
  if (!b || now >= b.resetAt) {
    buckets.set(bucketKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (b.count >= max) return false;
  b.count++;
  return true;
}

function clientIp(event, headers) {
  // 优先用平台给的 sourceIp（可信）；X-Forwarded-For 客户端可伪造，只作兜底
  const rc = event.requestContext || {};
  const ip = (rc.http && rc.http.sourceIp) || rc.sourceIp;
  if (ip) return String(ip);
  const xff = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  if (xff) return String(xff).split(',')[0].trim();
  return 'unknown';
}

// 只在内存里存 key 的哈希，不存原文
function keyFingerprint(authHeader) {
  return crypto.createHash('sha256').update(String(authHeader)).digest('hex').slice(0, 16);
}

// 返回可用的响应 Origin：允许的来源原样回显，未配置时放开，其余返回空（拒绝）
function resolveOrigin(event) {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || '';
  if (!ALLOWED_ORIGINS.length) return '*';
  if (!origin) return '';            // 非浏览器客户端（curl 等），不下发 ACAO，但放行
  if (DEV_ORIGIN_RE.test(origin)) return origin;
  return ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : null; // null = 明确拒绝
}

function corsHeaders(origin, extra) {
  const h = Object.assign({
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  }, extra || {});
  if (origin && origin !== '') h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function respond(statusCode, body, origin) {
  return {
    statusCode: statusCode,
    headers: corsHeaders(origin, { 'Content-Type': 'application/json; charset=utf-8' }),
    body: body,
    isBase64Encoded: false
  };
}

// 兼容 SCF 函数 URL / API 网关 / CloudBase 各种事件形态，把查询参数解析成对象
function parseQuery(event) {
  const q = {};
  const put = (k, v) => {
    if (k == null) return;
    const key = decodeURIComponent(String(k));
    if (v == null) { q[key] = ''; return; }
    if (Array.isArray(v)) v = v[0];
    q[key] = decodeURIComponent(String(v));
  };
  const eat = (cand) => {
    if (!cand) return;
    if (typeof cand === 'string') {
      cand.replace(/^\?/, '').split('&').forEach(function (pair) {
        if (!pair) return;
        const i = pair.indexOf('=');
        put(pair.slice(0, i), i < 0 ? '' : pair.slice(i + 1));
      });
    } else if (typeof cand === 'object') {
      Object.keys(cand).forEach(function (k) { put(k, cand[k]); });
    }
  };
  // 已知的各种字段名（不同触发器/兼容模式下放查询串的位置不一样）
  eat(event.queryStringParameters);
  eat(event.queryString);
  eat(event.multiValueQueryStringParameters);
  eat(event.rawQuery);
  eat(event.rawQueryString);
  eat(event.queries);
  if (event.requestContext) {
    eat(event.requestContext.queryString);
    eat(event.requestContext.queryStringParameters);
    if (event.requestContext.http) {
      eat(event.requestContext.http.queryString);
      eat(event.requestContext.http.rawQueryString);
    }
  }
  return q;
}

// 转发到豆包，原样带回状态码和响应体（401/404 等信息不会被吃掉）
function forward(method, path, authHeader, payload) {
  return new Promise(function (resolve, reject) {
    const headers = { 'Authorization': authHeader };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request({
      host: UPSTREAM_HOST,
      path: path,
      method: method,
      headers: headers
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, function () { req.destroy(new Error('上游请求超时')); });

    if (payload) req.write(payload);
    req.end();
  });
}

// 转发百度发音：服务端请求不带 Referer，百度返回正常 audio/mpeg（浏览器直连会被盗链拦截）
function forwardBaiduTTS(text) {
  return new Promise(function (resolve, reject) {
    // 百度单段文本上限约几百字符，对话单句足够；超长按硬截断保护
    const safe = String(text).slice(0, 500);
    const req = https.request({
      host: BAIDU_TTS_HOST,
      path: BAIDU_TTS_PATH + encodeURIComponent(safe),
      method: 'GET',
      headers: {
        // 故意不带 Referer / Origin（百度对跨站 Referer 返回空响应）
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'audio/webm,audio/ogg,audio/wav,audio/*;q=0.9'
      }
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks),
          contentType: res.headers['content-type'] || 'audio/mpeg'
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { req.destroy(new Error('TTS请求超时')); });
    req.end();
  });
}

exports.main = async (event) => {
  const q = parseQuery(event);
  const headers = event.headers || {};
  const method = String(event.httpMethod || event.requestContext?.httpMethod || 'GET').toUpperCase();
  const origin = resolveOrigin(event);

  // 来源不在白名单：直接拒绝，避免别的网站把本函数当免费代理
  if (origin === null) {
    return respond(403, JSON.stringify({ error: '来源不在白名单' }), '');
  }

  // 浏览器在发真实请求前会先来一次 OPTIONS 预检，必须放行
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  // 每个 IP 先过一道总限流（TTS 等免 key 路由也受保护）
  // 取不到真实 IP 时不做 IP 限流，避免所有用户共用一个桶被误伤
  const ip = clientIp(event, headers);
  if (ip !== 'unknown' && !hitLimit('ip:' + ip, RATE_MAX_PER_IP)) {
    return respond(429, JSON.stringify({ error: '请求过于频繁，请稍后再试' }), origin);
  }

  // 调试：?debug=1 返回收到的事件结构和解析结果（确认查询参数格式用，仅 DEBUG=1 开放）
  if (q.debug && DEBUG) {
    return respond(200, JSON.stringify({
      parsedQuery: q,
      httpMethod: event.httpMethod,
      path: event.path || event.rawPath,
      queryString: event.queryString,
      queryStringParameters: event.queryStringParameters,
      rawQuery: event.rawQuery,
      eventKeys: Object.keys(event),
      headerKeys: Object.keys(headers) // 只回 key 名，不回 value（避免密钥泄露）
    }, null, 2), origin);
  }

  // TTS 代理路由：?tts=文本 → 百度整句发音
  if (q.tts) {
    try {
      const upstream = await forwardBaiduTTS(q.tts);
      // 百度异常时可能返回非音频（防盗链/限流），给前端一个明确状态
      const ct = String(upstream.contentType || '');
      if (upstream.statusCode !== 200 || upstream.body.length === 0 || !/audio|mpeg|octet/i.test(ct)) {
        return respond(502, JSON.stringify({ error: 'TTS上游异常', status: upstream.statusCode, contentType: ct, bytes: upstream.body.length }), origin);
      }
      return {
        statusCode: 200,
        headers: corsHeaders(origin, {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=86400'
        }),
        body: upstream.body.toString('base64'),
        isBase64Encoded: true
      };
    } catch (err) {
      return respond(502, JSON.stringify({ error: 'TTS 代理失败：' + err.message }), origin);
    }
  }

  // 测试路由（无需 key）：?slowtest=8000 → 停 8 秒后返回，验证超时配置（仅 DEBUG=1 开放）
  if (q.slowtest && DEBUG) {
    const ms = Math.min(Number(q.slowtest) || 5000, 55000);
    const start = Date.now();
    await new Promise(function (r) { setTimeout(r, ms); });
    return respond(200, JSON.stringify({ ok: true, sleptMs: ms, realMs: Date.now() - start }), origin);
  }

  const auth = headers.authorization || headers.Authorization;
  if (!auth) {
    // 注意：这里绝对不能回显 event.headers 的具体值，否则等于开了个密钥读取接口
    return respond(401, JSON.stringify({ error: '缺少 Authorization 头' }), origin);
  }

  // 同一把 key 再限一次流，保护用户自己的额度不被脚本刷爆
  if (!hitLimit('key:' + keyFingerprint(auth), RATE_MAX_PER_KEY)) {
    return respond(429, JSON.stringify({ error: '这把 key 请求过于频繁，请稍后再试' }), origin);
  }

  // GET → 拉取账号可用的模型列表
  if (method === 'GET') {
    try {
      const upstream = await forward('GET', MODELS_PATH, auth, null);
      return respond(upstream.statusCode, upstream.body, origin);
    } catch (err) {
      return respond(502, JSON.stringify({ error: '转发失败：' + err.message }), origin);
    }
  }

  if (method !== 'POST') {
    return respond(405, JSON.stringify({ error: '只支持 GET / POST' }), origin);
  }

  let payload = event.body || '';
  if (event.isBase64Encoded) {
    payload = Buffer.from(payload, 'base64').toString('utf8');
  }
  if (Buffer.byteLength(payload) > MAX_BODY_BYTES) {
    return respond(413, JSON.stringify({ error: '请求体过大' }), origin);
  }

  try {
    const upstream = await forward('POST', CHAT_PATH, auth, payload);
    return respond(upstream.statusCode, upstream.body, origin);
  } catch (err) {
    return respond(502, JSON.stringify({ error: '转发失败：' + err.message }), origin);
  }
};

// SCF 默认入口 main_handler，CloudBase 用 main，都指向同一个函数
exports.main_handler = exports.main;
