// หน้า Log Monitor (/monitor) ต้อง login ด้วย user / password
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const auth = require('./auth');

const VIEWS = path.join(__dirname, '..', 'views');

function monitorRouter({ logger, stats, getVersion }) {
  const router = express.Router();

  // ---------- Login / Logout ----------
  router.get('/login', (req, res) => {
    if (auth.getSession(req)) return res.redirect('/monitor');
    res.sendFile(path.join(VIEWS, 'login.html'));
  });

  router.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const ip = req.ip;
    const { username = '', password = '' } = req.body || {};

    if (auth.loginLimiter.isLocked(ip)) {
      logger.warn('monitor', 'login ถูกล็อก (ผิดเกินจำนวนครั้ง)', { ip, username });
      return res.redirect('/monitor/login?error=locked');
    }
    if (!auth.checkCredentials(username, password)) {
      const a = auth.loginLimiter.fail(ip);
      logger.warn('monitor', 'login ไม่สำเร็จ', { ip, username, attempt: a.count });
      return res.redirect(`/monitor/login?error=${a.lockedUntil ? 'locked' : 'invalid'}`);
    }
    auth.loginLimiter.reset(ip);
    auth.setSessionCookie(req, res, username);
    logger.info('monitor', `ผู้ใช้ ${username} เข้าสู่ระบบ`, { ip });
    res.redirect('/monitor');
  });

  router.post('/logout', (req, res) => {
    const s = auth.getSession(req);
    if (s) logger.info('monitor', `ผู้ใช้ ${s.u} ออกจากระบบ`, { ip: req.ip });
    auth.clearSessionCookie(res);
    res.redirect('/monitor/login');
  });

  // ---------- ทุกอย่างหลังจากนี้ต้อง login ----------
  router.use(auth.requireMonitorLogin);

  router.get('/', (req, res) => res.sendFile(path.join(VIEWS, 'monitor.html')));

  router.get('/api/me', (req, res) => res.json({ user: req.monitorUser }));

  router.get('/api/logs', async (req, res, next) => {
    try {
      const { level, category, q, limit, date } = req.query;
      res.json(await logger.query({ level, category, q, limit, date }));
    } catch (err) { next(err); }
  });

  router.get('/api/stats', async (req, res) => {
    const mem = process.memoryUsage();
    let version = null;
    try { version = await getVersion(); } catch { /* ไม่มีไฟล์ */ }
    res.json({
      startedAt: new Date(stats.startedAt).toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      pid: process.pid,
      port: config.port,
      memoryMB: { rss: +(mem.rss / 1048576).toFixed(1), heapUsed: +(mem.heapUsed / 1048576).toFixed(1) },
      requests: stats.requests,
      status: stats.status,
      versionChecks: stats.versionChecks,
      downloads: stats.downloads,
      authFailures: stats.authFailures,
      errors: stats.errors,
      requireApiKey: config.requireApiKey,
      version,
    });
  });

  router.get('/api/files', async (req, res) => res.json(await logger.listFiles()));

  router.get('/api/files/:name', (req, res) => {
    const file = logger.filePath(req.params.name);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
    res.download(file);
  });

  // Live log ผ่าน Server-Sent Events
  router.get('/api/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const onLog = (entry) => res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    logger.on('log', onLog);
    req.on('close', () => {
      clearInterval(ping);
      logger.off('log', onLog);
    });
  });

  return router;
}

module.exports = { monitorRouter };
