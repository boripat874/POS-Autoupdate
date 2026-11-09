// System logger: เขียน log เป็นไฟล์รายวัน (JSON ทีละบรรทัด) + เก็บล่าสุดไว้ในหน่วยความจำ
// และส่ง event 'log' ให้หน้า Monitor แสดงแบบ real-time
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LEVELS = ['debug', 'info', 'warn', 'error'];
const FILE_RE = /^system-(\d{4}-\d{2}-\d{2})\.log$/;

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

class Logger extends EventEmitter {
  constructor({ dir, retentionDays = 30, bufferSize = 2000 }) {
    super();
    this.setMaxListeners(100);
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.bufferSize = bufferSize;
    this.buffer = [];
    this.seq = 0;
    this.stream = null;
    this.streamDate = null;
    fs.mkdirSync(dir, { recursive: true });
    this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup(), 6 * 3600 * 1000);
    this.cleanupTimer.unref();
  }

  getStream(now) {
    const date = localDate(now);
    if (this.streamDate !== date) {
      if (this.stream) this.stream.end();
      this.stream = fs.createWriteStream(path.join(this.dir, `system-${date}.log`), { flags: 'a' });
      this.stream.on('error', (err) => console.error('[logger] write error:', err.message));
      this.streamDate = date;
    }
    return this.stream;
  }

  write(level, category, message, meta) {
    const now = new Date();
    const entry = { id: ++this.seq, time: now.toISOString(), level, category, message };
    if (meta && Object.keys(meta).length) entry.meta = meta;

    this.buffer.push(entry);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();

    this.getStream(now).write(JSON.stringify(entry) + '\n');

    const line = `[${localTime(now)}] ${level.toUpperCase().padEnd(5)} [${category}] ${message}`;
    (level === 'error' ? console.error : console.log)(meta ? `${line} ${JSON.stringify(meta)}` : line);

    this.emit('log', entry);
    return entry;
  }

  debug(c, m, meta) { return this.write('debug', c, m, meta); }
  info(c, m, meta) { return this.write('info', c, m, meta); }
  warn(c, m, meta) { return this.write('warn', c, m, meta); }
  error(c, m, meta) { return this.write('error', c, m, meta); }

  // ค้นหา log: ถ้าระบุ date จะอ่านจากไฟล์ ไม่ระบุจะใช้ข้อมูลในหน่วยความจำ
  async query({ level, category, q, limit = 500, date } = {}) {
    let rows;
    if (date && date !== localDate(new Date())) {
      rows = await this.readFile(date);
    } else if (date) {
      // วันนี้: อ่านจากไฟล์เพื่อให้ได้ log ตั้งแต่ก่อน restart ด้วย
      rows = await this.readFile(date);
      if (!rows.length) rows = this.buffer.slice();
    } else {
      rows = this.buffer.slice();
    }

    const minIdx = level ? LEVELS.indexOf(level) : -1;
    const needle = q ? String(q).toLowerCase() : '';
    const filtered = rows.filter((e) => {
      if (minIdx > -1 && LEVELS.indexOf(e.level) < minIdx) return false;
      if (category && e.category !== category) return false;
      if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) return false;
      return true;
    });
    const n = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    return filtered.slice(-n);
  }

  async readFile(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const file = path.join(this.dir, `system-${date}.log`);
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch { return []; }
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* ข้ามบรรทัดที่เสีย */ }
    }
    return rows;
  }

  async listFiles() {
    let names = [];
    try { names = await fs.promises.readdir(this.dir); } catch { return []; }
    const files = [];
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const st = await fs.promises.stat(path.join(this.dir, name));
      files.push({ name, date: m[1], size: st.size, modified: st.mtime.toISOString() });
    }
    return files.sort((a, b) => b.date.localeCompare(a.date));
  }

  filePath(name) {
    return FILE_RE.test(name) ? path.join(this.dir, name) : null;
  }

  // ลบไฟล์ log ที่เก่ากว่า retentionDays
  cleanup() {
    const cutoff = Date.now() - this.retentionDays * 86400 * 1000;
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      if (new Date(`${m[1]}T00:00:00`).getTime() < cutoff) {
        try { fs.unlinkSync(path.join(this.dir, name)); } catch { /* ignore */ }
      }
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
    if (this.stream) this.stream.end();
  }
}

module.exports = { Logger, LEVELS };
