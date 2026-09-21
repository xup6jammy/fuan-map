/* ============================================================
   Node 18+ 版伺服器（零相依套件；本機測試或任何能跑 Node 的主機）
   啟動：
     LINE_CHANNEL_SECRET=xxx LINE_CHANNEL_ACCESS_TOKEN=yyy node line-bot/server-node.js
   環境變數：
     LINE_CHANNEL_SECRET        Messaging API channel 的 Channel secret（必填）
     LINE_CHANNEL_ACCESS_TOKEN  長期 Channel access token（必填）
     PORT                       預設 3000
     STORE_FILE                 狀態檔路徑，預設 line-bot/data/store.json（已在 .gitignore）
   路由：
     POST /webhook   LINE Webhook
     GET  /health    健康檢查（回 ok，不含任何機密）
   ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBot } from './src/flow.js';
import { createLineClient } from './src/line.js';
import { createWebhook } from './src/webhook.js';
import { FileStore } from './src/store.js';

const SECRET = process.env.LINE_CHANNEL_SECRET || '';
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = process.env.STORE_FILE || path.join(here, 'data', 'store.json');

if (!SECRET || !TOKEN) {
  console.error('缺少環境變數 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN（只放環境變數，不要寫進程式或 GitHub）');
  process.exit(1);
}
fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
const store = new FileStore(STORE_FILE, fs);
const line = createLineClient({ accessToken: TOKEN });
const bot = createBot({ store, line });
const webhook = createWebhook({ bot, channelSecret: SECRET });

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (req.method === 'POST' && req.url === '/webhook') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const out = await webhook({ rawBody, signature: req.headers['x-line-signature'] || '' });
    res.writeHead(out.status, { 'Content-Type': 'text/plain' }); return res.end(out.body);
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`[line-bot] listening on :${PORT}  (POST /webhook)`));
