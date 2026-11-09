// การตั้งค่าทั้งหมดของ server อ่านจาก environment variables (ตั้งได้ใน ecosystem.config.js)
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const config = {
  root,
  port: Number(process.env.PORT) || 80,
  updatesDir: path.join(root, 'public', 'updates'),
  logDir: process.env.LOG_DIR ? path.resolve(root, process.env.LOG_DIR) : path.join(root, 'logs'),
  logRetentionDays: Number(process.env.LOG_RETENTION_DAYS) || 30,

  // API key: ใส่ได้หลายตัว คั่นด้วย comma
  apiKeys: list(process.env.API_KEYS || 'ada65-946aed54aw'),
  // ตั้งเป็น false ชั่วคราวได้ ถ้าโปรแกรม client รุ่นเก่ายังไม่ส่ง API key มา
  requireApiKey: process.env.REQUIRE_API_KEY !== 'false',

  // บัญชีเข้าหน้า Log Monitor
  monitorUser: process.env.MONITOR_USER || 'admin',
  monitorPassword: process.env.MONITOR_PASSWORD || 'admin1234',
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionHours: Number(process.env.SESSION_HOURS) || 8,

  // เปิดเมื่อมี reverse proxy (IIS / nginx) อยู่ด้านหน้า เพื่อให้ได้ IP จริงของ client
  trustProxy: process.env.TRUST_PROXY === 'true',
};

config.usingDefaultPassword = !process.env.MONITOR_PASSWORD;
config.usingRandomSecret = !process.env.SESSION_SECRET;

module.exports = config;
