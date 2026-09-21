/* ============================================================
   Webhook 入口（平台無關）：驗簽章 → 逐一交給 bot.handleEvent
   Node（server-node.js）與 Deno Deploy（deno.ts）都呼叫這一支。
   回傳 { status, body }：401 簽章不對、400 不是 JSON、200 其餘（LINE 只要 200 就好）
   ============================================================ */
import { verifySignature } from './line.js';

export function createWebhook({ bot, channelSecret, log = console }) {
  return async function handle({ rawBody, signature }) {
    if (!(await verifySignature(channelSecret, rawBody, signature))) {
      log.warn('[webhook] bad signature');
      return { status: 401, body: 'bad signature' };
    }
    let payload;
    try { payload = JSON.parse(rawBody); } catch (_) { return { status: 400, body: 'bad json' }; }
    const events = Array.isArray(payload && payload.events) ? payload.events : [];
    /* LINE 的「Verify」按鈕會送空 events，直接 200 */
    const results = [];
    for (const ev of events) {
      try { results.push(await bot.handleEvent(ev)); }
      catch (e) { log.error('[webhook] event failed:', e && e.message); results.push({ error: true }); }
    }
    return { status: 200, body: 'ok', results };
  };
}
