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

// ---------- ข้อมูลเวอร์ชัน + SHA-256 (ตามสเปก ZooPos-AutoUpdate-Spec) ----------
// version.txt = ตัวชี้เวอร์ชันที่ปล่อยอยู่ (แก้ไฟล์นี้เป็นขั้นสุดท้าย / ถอยกลับก็แก้ไฟล์นี้)
// ไฟล์ zip   = ZooPos-Setup-<version>.zip (ตั้งได้ด้วย UPDATE_FILE_PATTERN) ถ้าไม่พบจะใช้ update.zip
// ไฟล์เสริม  = <zip>.sha256.txt (จาก build-installer.cmd) ใช้ตรวจว่าไฟล์ที่อัปโหลดครบ
//            = <ชื่อ zip ไม่มี .zip>.notes.txt (ถ้ามี) จะส่งเป็น field "notes"
const VERSION_FILE = path.join(config.updatesDir, 'version.txt');
const hashCache = new Map(); // name -> { key, promise }

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

function cachedSha256(name, file, st) {
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = hashCache.get(name);
  if (hit && hit.key === key) return hit.promise;
  const promise = sha256File(file);
  promise.catch(() => hashCache.delete(name));
  hashCache.set(name, { key, promise });
  return promise;
}

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const readOptional = (file) => fs.promises.readFile(file, 'utf8').then((t) => t.trim()).catch(() => '');

async function getVersion() {
  const version = await readOptional(VERSION_FILE);
  if (!version) throw httpError(404, 'ไม่พบ version.txt หรือไฟล์ว่าง', 'ENOENT');

  const candidates = [...new Set([config.updateFilePattern.replace('{version}', version), 'update.zip'])];
  let name = null;
  let st = null;
  for (const n of candidates) {
    try {
      const s = await fs.promises.stat(path.join(config.updatesDir, n));
      if (s.isFile()) { name = n; st = s; break; }
    } catch { /* ลองชื่อถัดไป */ }
  }
  if (!name) throw httpError(404, `ไม่พบไฟล์อัปเดตของเวอร์ชัน ${version} (${candidates.join(', ')})`, 'ENOENT');

  const file = path.join(config.updatesDir, name);
  const sha256 = await cachedSha256(name, file, st);

  // ตรวจกับไฟล์ .sha256.txt (ถ้ามี) กันกรณีอัปโหลดไม่ครบ / ไฟล์ผิดตัว
  const sidecar = await readOptional(`${file}.sha256.txt`);
  const expected = (sidecar.match(/\b[0-9a-f]{64}\b/i) || [])[0];
  if (expected && expected.toLowerCase() !== sha256) {
    throw httpError(503, `SHA-256 ของ ${name} ไม่ตรงกับ ${name}.sha256.txt (อัปโหลดไม่ครบหรือไฟล์ผิด)`, 'HASH_MISMATCH');
  }

  const notes = await readOptional(path.join(config.updatesDir, name.replace(/\.zip$/i, '') + '.notes.txt'));
  return {
    version,
    file: name,
    size: st.size,
    sha256,
    updatedAt: st.mtime.toISOString(),
    downloadUrl: `/download/${encodeURIComponent(name)}`,
    ...(notes ? { notes } : {}),
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
    res.set('Cache-Control', 'no-store').json(await getVersion());
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn('update', err.message);
      return res.status(404).json({ error: 'Not found', message: 'ไม่พบไฟล์อัปเดต' });
    }
    if (err.code === 'HASH_MISMATCH') {
      logger.error('update', err.message);
      return res.status(503).json({ error: 'Service Unavailable', message: 'ไฟล์อัปเดตบน server ไม่สมบูรณ์' });
    }
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
  express.static(config.updatesDir, {
    index: false,
    dotfiles: 'ignore',
    setHeaders: (res) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
    },
  }),
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

// HTTPS (ถ้าตั้ง HTTPS_PFX หรือ HTTPS_CERT + HTTPS_KEY) ไม่ตั้ง = HTTP
function createServer() {
  if (config.httpsPfx) {
    return require('https').createServer({ pfx: fs.readFileSync(config.httpsPfx), passphrase: config.httpsPassphrase }, app);
  }
  if (config.httpsCert && config.httpsKey) {
    return require('https').createServer({ cert: fs.readFileSync(config.httpsCert), key: fs.readFileSync(config.httpsKey) }, app);
  }
  return require('http').createServer(app);
}
const useHttps = Boolean(config.httpsPfx || (config.httpsCert && config.httpsKey));
const server = createServer();
server.listen(config.port, () => {
  const base = `${useHttps ? 'https' : 'http'}://${SERVER_IP}:${config.port}`;
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
