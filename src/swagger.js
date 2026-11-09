// Swagger UI ที่ /docs และ OpenAPI spec ที่ /docs/openapi.json
// ถ้าติดตั้ง swagger-ui-dist แล้ว (npm install) จะใช้ไฟล์ในเครื่อง ไม่ต้องต่ออินเทอร์เน็ต
// ถ้ายังไม่ได้ติดตั้ง จะโหลดหน้า UI จาก CDN แทน
const path = require('path');
const express = require('express');
const pkg = require('../package.json');

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Auto Update API',
    version: pkg.version,
    description:
      'API สำหรับให้โปรแกรม client เช็คเวอร์ชันและดาวน์โหลดไฟล์อัปเดต\n\n' +
      'ทุก endpoint ยกเว้น `/health` ต้องส่ง API key ทาง header `x-api-key` ' +
      '(หรือ query `api_key`) กดปุ่ม **Authorize** ด้านขวาเพื่อใส่ key ก่อนทดลองเรียก',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Update', description: 'เช็คเวอร์ชันและดาวน์โหลดอัปเดต' },
    { name: 'System', description: 'สถานะ server' },
  ],
  components: {
    securitySchemes: {
      ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      ApiKeyQuery: { type: 'apiKey', in: 'query', name: 'api_key' },
    },
    schemas: {
      VersionInfo: {
        type: 'object',
        properties: {
          version: { type: 'string', example: '2.0.0' },
          file: { type: 'string', example: 'update.zip' },
          size: { type: 'integer', example: 51901 },
          sha256: { type: 'string', example: '3f2a...e91c' },
          updatedAt: { type: 'string', format: 'date-time' },
          downloadUrl: { type: 'string', example: '/download/update.zip' },
        },
      },
      Health: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
          uptimeSeconds: { type: 'integer', example: 3600 },
          time: { type: 'string', format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Unauthorized' },
          message: { type: 'string', example: 'Invalid or missing API key' },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: 'API key ไม่ถูกต้องหรือไม่ได้ส่งมา',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
  security: [{ ApiKeyHeader: [] }, { ApiKeyQuery: [] }],
  paths: {
    '/check-version': {
      get: {
        tags: ['Update'],
        summary: 'เวอร์ชันล่าสุด (ข้อความล้วน)',
        description: 'คืนค่าเนื้อหาของ version.txt เช่น `2.0.0` (รูปแบบเดิม ใช้กับ client รุ่นปัจจุบัน)',
        responses: {
          200: { description: 'เลขเวอร์ชัน', content: { 'text/plain': { schema: { type: 'string', example: '2.0.0' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/api/version': {
      get: {
        tags: ['Update'],
        summary: 'ข้อมูลเวอร์ชันล่าสุด (JSON + SHA-256)',
        description: 'ใช้ค่า `sha256` ตรวจว่าไฟล์ที่ดาวน์โหลดมาครบและไม่ถูกแก้ไข ก่อนติดตั้ง',
        responses: {
          200: { description: 'ข้อมูลเวอร์ชัน', content: { 'application/json': { schema: { $ref: '#/components/schemas/VersionInfo' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'ไม่พบไฟล์อัปเดต' },
        },
      },
    },
    '/download/{file}': {
      get: {
        tags: ['Update'],
        summary: 'ดาวน์โหลดไฟล์อัปเดต',
        parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string', default: 'update.zip' } }],
        responses: {
          200: { description: 'ไฟล์', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'ไม่พบไฟล์' },
        },
      },
    },
    '/health': {
      get: {
        tags: ['System'],
        summary: 'ตรวจสถานะ server (ไม่ต้องใช้ API key)',
        security: [],
        responses: {
          200: { description: 'ทำงานปกติ', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } },
        },
      },
    },
  },
};

function resolveLocalDist() {
  try {
    return path.dirname(require.resolve('swagger-ui-dist/package.json'));
  } catch {
    return null;
  }
}

function html(assetBase) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auto Update API · Swagger</title>
  <link rel="stylesheet" href="${assetBase}/swagger-ui.css" />
  <style>body{margin:0} .topbar{display:none}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${assetBase}/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/docs/openapi.json',
      dom_id: '#swagger-ui',
      persistAuthorization: true,
      displayRequestDuration: true,
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>`;
}

function swaggerRouter(logger) {
  const router = express.Router();
  const dist = resolveLocalDist();
  const assetBase = dist ? '/docs/assets' : 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5';
  if (dist) {
    router.use('/assets', express.static(dist, { index: false }));
  } else {
    logger.warn('docs', 'ไม่พบ swagger-ui-dist ในเครื่อง ใช้ CDN แทน (รัน npm install เพื่อใช้แบบออฟไลน์)');
  }
  const page = html(assetBase);
  router.get('/openapi.json', (req, res) => res.json(spec));
  router.get('/', (req, res) => res.type('html').send(page));
  return router;
}

module.exports = { swaggerRouter, spec };
