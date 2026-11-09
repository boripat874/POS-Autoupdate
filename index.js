const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const config = require('./src/config');
const { Logger } = require('./src/logger');
const { apiKeyAuth } = require('./src/auth');
const { swaggerRouter } = require('./src/swagger');
const { monitorRouter } = require('./src/monitor');

const logger = new Logger({ dir: config.logDir, retentionDays: config.logRetentionDays });

// ตัวนับสถิติสำหรับหน้า Monitor
const stats = {
  startedAt: Date.now(),
  requests: 0,
  status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
  versionChecks: 0,
  downloads: 0,
  authFailures: 0,
  errors: 0,
};

// หา IP ของเครื่องอัตโนมัติ (ข้ามการ์ดเสมือนของ VirtualBox / VMware / Hyper-V / WSL / Docker)
function getLocalIp() {
  const virtual = /virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|loopback/i;
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  const real = candidates.find((c) => !virtual.test(c.name));
  return (real || candidates[0] || { address: 'localhost' }).address;
}

// ---------- ข้อมูลเวอร์ชัน + SHA-256 (cache ตาม mtime/size ของไฟล์) ----------
const VERSION_FILE = path.join(config.updatesDir, 'version.txt');
const UPDATE_FILE = path.join(config.updatesDir, 'update.zip');
let hashCache = { key: '', sha256: '' };

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

async function getVersion() {
  const [text, st] = await Promise.all([
    fs.promises.readFile(VERSION_FILE, 'utf8'),
    fs.promises.stat(UPDATE_FILE),
  ]);
  const key = `${st.mtimeMs}:${st.size}`;
  if (hashCache.key !== key) hashCache = { key, sha256: await sha256File(UPDATE_FILE) };
  return {
    version: text.trim(),
    file: 'update.zip',
    size: st.size,
    sha256: hashCache.sha256,
    updatedAt: st.mtime.toISOString(),
    downloadUrl: '/download/update.zip',
  };
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

// บันทึกทุก request ลง system log (ยกเว้นหน้า monitor / ไฟล์ของ swagger เพื่อไม่ให้ log รก)
const QUIET = /^\/(monitor|docs\/assets|favicon\.ico)/;
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    stats.requests++;
    const cls = `${Math.floor(res.statusCode / 100)}xx`;
    if (stats.status[cls] !== undefined) stats.status[cls]++;
    if (QUIET.test(req.originalUrl)) return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger.write(level, 'http', `${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms`, {
      ip: req.ip,
      ua: req.get('user-agent') || '',
      ...(req.apiKeyMasked ? { key: req.apiKeyMasked } : {}),
    });
  });
  next();
});

const requireKey = apiKeyAuth(logger, stats);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), time: new Date().toISOString() });
});

// รูปแบบเดิม: คืนเลขเวอร์ชันเป็นข้อความ
app.get('/check-version', requireKey, (req, res, next) => {
  stats.versionChecks++;
  res.type('text/plain').sendFile(VERSION_FILE, (err) => err && next(err));
});

// รูปแบบใหม่: JSON + SHA-256
app.get('/api/version', requireKey, async (req, res, next) => {
  stats.versionChecks++;
  try {
    res.json(await getVersion());
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found', message: 'ไม่พบไฟล์อัปเดต' });
    next(err);
  }
});

// ดาวน์โหลดไฟล์อัปเดต
app.use(
  '/download',
  requireKey,
  (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode === 200) {
        stats.downloads++;
        logger.info('update', `ดาวน์โหลด ${req.path.replace(/^\//, '')}`, { ip: req.ip });
      }
    });
    next();
  },
  express.static(config.updatesDir, { index: false, dotfiles: 'ignore' }),
);

app.use('/docs', swaggerRouter(logger));
app.use('/monitor', monitorRouter({ logger, stats, getVersion }));

app.get('/', (req, res) => res.redirect('/docs'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  stats.errors++;
  const status = err.status || err.statusCode || 500;
  if (status >= 500) logger.error('server', err.message || 'Internal error', { path: req.originalUrl, stack: err.stack });
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 ? 'Internal Server Error' : err.message });
});

// ---------- Start ----------
const SERVER_IP = getLocalIp();
const server = app.listen(config.port, () => {
  const base = `http://${SERVER_IP}:${config.port}`;
  logger.info('system', `Update Server เริ่มทำงานที่ ${base}`, { pid: process.pid, node: process.version });
  logger.info('system', `Swagger UI: ${base}/docs · Log Monitor: ${base}/monitor`);
  if (!config.requireApiKey) logger.warn('system', 'REQUIRE_API_KEY=false ทุกคนเรียก API ได้โดยไม่ต้องใช้ key');
  if (config.usingDefaultPassword) logger.warn('system', 'ยังใช้รหัสผ่าน Monitor ค่าเริ่มต้น ควรตั้ง MONITOR_PASSWORD');
  if (config.usingRandomSecret) logger.warn('system', 'ไม่ได้ตั้ง SESSION_SECRET ผู้ใช้ Monitor จะต้อง login ใหม่ทุกครั้งที่ restart');
});

server.on('error', (err) => {
  logger.error('system', `เปิดพอร์ต ${config.port} ไม่ได้: ${err.message}`, { code: err.code });
  setTimeout(() => process.exit(1), 200);
});

function shutdown(signal) {
  logger.info('system', `ได้รับ ${signal} กำลังปิด server`);
  server.close(() => {
    logger.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('system', `unhandledRejection: ${reason && reason.message ? reason.message : reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error('system', `uncaughtException: ${err.message}`, { stack: err.stack });
  setTimeout(() => process.exit(1), 200); // ให้ pm2 restart
});
