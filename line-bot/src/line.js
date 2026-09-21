/* ============================================================
   LINE Messaging API 最小封裝（reply / push / profile）＋ webhook 簽章驗證
   - access token 只從建構參數進來（由環境變數提供），不寫進任何回覆或 log
   - 測試時整個物件用 mock 取代，不會打到 LINE
   ============================================================ */

const API = 'https://api.line.me/v2/bot';

export function createLineClient({ accessToken, fetchFn = globalThis.fetch }) {
  if (!accessToken) throw new Error('missing access token');
  async function call(method, path, body) {
    const r = await fetchFn(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 300); } catch (_) {}
      const err = new Error(`LINE API ${r.status} ${path}: ${detail}`);
      err.status = r.status;
      throw err;
    }
    try { return await r.json(); } catch (_) { return {}; }
  }
  return {
    /* reply token 只能用一次、且要在事件後短時間內用掉 */
    reply: (replyToken, messages) => call('POST', '/message/reply', { replyToken, messages: [].concat(messages) }),
    /* push 會計入官方帳號每月訊息額度；只在使用者按「確認通知」後才用 */
    push: (to, messages) => call('POST', '/message/push', { to, messages: [].concat(messages) }),
    /* 取顯示名稱（對方必須是官方帳號好友）；失敗回 null，不讓流程壞掉 */
    profile: async (userId) => { try { return await call('GET', `/profile/${encodeURIComponent(userId)}`); } catch (_) { return null; } }
  };
}

/* X-Line-Signature = base64( HMAC-SHA256( channelSecret, rawBody ) ) */
export async function verifySignature(channelSecret, rawBody, signature) {
  if (!channelSecret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, typeof rawBody === 'string' ? enc.encode(rawBody) : rawBody);
  const expected = base64(new Uint8Array(mac));
  return timingSafeEqual(expected, String(signature));
}
function base64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
