/* ============================================================
   Deno Deploy 入口（建議的部署方式：連結 GitHub、entrypoint 選這個檔、填兩個環境變數）
   - 儲存用 Deno KV（Deno Deploy 內建、免費、持久保存；本機跑 deno 則存在本機檔案）
   - 環境變數：LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN（在 Deno Deploy 專案設定裡填，不進 GitHub）
   本機試跑：deno run --allow-net --allow-env --unstable-kv line-bot/deno.ts
   ============================================================ */
import { createBot } from './src/flow.js';
import { createLineClient } from './src/line.js';
import { createWebhook } from './src/webhook.js';

const SECRET = Deno.env.get('LINE_CHANNEL_SECRET') || '';
const TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || '';

/* Deno KV 版儲存：介面與 src/store.js 相同 */
class KvStore {
  kv: Deno.Kv;
  constructor(kv: Deno.Kv) { this.kv = kv; }
  async get(key: string) {
    const r = await this.kv.get<{ v: unknown; exp: number }>(['fuan', key]);
    if (!r.value) return null;
    if (r.value.exp && r.value.exp <= Date.now()) { await this.kv.delete(['fuan', key]); return null; }
    return r.value.v;
  }
  async set(key: string, value: unknown, opts: { ttlMs?: number } = {}) {
    const exp = opts.ttlMs ? Date.now() + opts.ttlMs : 0;
    await this.kv.set(['fuan', key], { v: value, exp }, opts.ttlMs ? { expireIn: opts.ttlMs } : undefined);
  }
  async del(key: string) { await this.kv.delete(['fuan', key]); }
}

const kv = await Deno.openKv();
const store = new KvStore(kv);
const ready = !!(SECRET && TOKEN);
const bot = ready ? createBot({ store, line: createLineClient({ accessToken: TOKEN }) }) : null;
const webhook = ready ? createWebhook({ bot, channelSecret: SECRET }) : null;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/health') {
    return new Response(ready ? 'ok' : 'missing env: LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN', { status: ready ? 200 : 500 });
  }
  if (req.method === 'POST' && url.pathname === '/webhook') {
    if (!webhook) return new Response('server not configured', { status: 500 });
    const rawBody = await req.text();
    const out = await webhook({ rawBody, signature: req.headers.get('x-line-signature') || '' });
    return new Response(out.body, { status: out.status });
  }
  return new Response('not found', { status: 404 });
});
