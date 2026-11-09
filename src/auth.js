// API key สำหรับ client และ session login สำหรับหน้า Log Monitor
const crypto = require('crypto');
const config = require('./config');

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

const maskKey = (k) => {
  if (!k) return '';
  if (k.length <= 6) return '****';
  return `${k.slice(0, 4)}****${k.slice(-2)}`;
};

const getApiKey = (req) => req.get('x-api-key') || (req.query && req.query.api_key) || '';

// ---------- API key ----------
function apiKeyAuth(logger, stats) {
  return (req, res, next) => {
    const key = getApiKey(req);
    req.apiKeyMasked = maskKey(key);
    if (!config.requireApiKey) return next();
    if (key && config.apiKeys.some((k) => safeEqual(k, key))) return next();

    stats.authFailures++;
    logger.warn('auth', key ? 'API key ไม่ถูกต้อง' : 'ไม่ได้ส่ง API key', {
      ip: req.ip, path: req.originalUrl, key: req.apiKeyMasked || '(none)',
    });
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing API key' });
  };
}

// ---------- Monitor session (cookie ที่ลงลายเซ็น HMAC) ----------
const COOKIE = 'monitor_session';
const sign = (payload) => crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

function createToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + config.sessionHours * 3600e3 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sign(payload), sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function setSessionCookie(req, res, user) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(createToken(user))}`,
    'Path=/monitor', 'HttpOnly', 'SameSite=Strict', `Max-Age=${config.sessionHours * 3600}`,
  ];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/monitor; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function checkCredentials(user, password) {
  // เทียบทั้งสองค่าเสมอ เพื่อไม่ให้เดาได้จากเวลาตอบกลับ
  const okUser = safeEqual(user || '', config.monitorUser);
  const okPass = safeEqual(password || '', config.monitorPassword);
  return okUser && okPass;
}

function requireMonitorLogin(req, res, next) {
  const s = getSession(req);
  if (s) {
    req.monitorUser = s.u;
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/monitor/login');
}

// ---------- ล็อกการ login ผิดซ้ำ ----------
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const attempts = new Map(); // ip -> { count, lockedUntil }

const loginLimiter = {
  isLocked(ip) {
    const a = attempts.get(ip);
    return Boolean(a && a.lockedUntil && a.lockedUntil > Date.now());
  },
  fail(ip) {
    const a = attempts.get(ip) || { count: 0, lockedUntil: 0 };
    if (a.lockedUntil && a.lockedUntil <= Date.now()) { a.count = 0; a.lockedUntil = 0; }
    a.count++;
    if (a.count >= MAX_ATTEMPTS) a.lockedUntil = Date.now() + LOCK_MS;
    attempts.set(ip, a);
    return a;
  },
  reset(ip) { attempts.delete(ip); },
};

module.exports = {
  apiKeyAuth, maskKey, getSession, setSessionCookie, clearSessionCookie,
  checkCredentials, requireMonitorLogin, loginLimiter, MAX_ATTEMPTS,
};
