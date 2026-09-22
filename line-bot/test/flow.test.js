/* ============================================================
   Bot 流程測試（node --test）。LINE API 全部 mock：不會打到 LINE、不會發任何真實訊息、
   不會推播給任何家人或其他使用者。每個測試建立自己的 MemoryStore 與 mock line。
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/flow.js';
import { createWebhook } from '../src/webhook.js';
import { MemoryStore } from '../src/store.js';

function mockLine(opts = {}) {
  const calls = { reply: [], push: [], profile: [] };
  return {
    calls,
    reply: async (token, messages) => { calls.reply.push({ token, messages: [].concat(messages) }); },
    push: async (to, messages) => {
      calls.push.push({ to, messages: [].concat(messages) });
      if (opts.pushFail && opts.pushFail.includes(to)) throw new Error('LINE API 400 /message/push');
    },
    profile: async (userId) => { calls.profile.push(userId); return opts.names && opts.names[userId] ? { displayName: opts.names[userId] } : null; }
  };
}
function setup(opts = {}) {
  const store = new MemoryStore();
  const line = mockLine(opts);
  let t = 1700000000000; let n = 0;
  const bot = createBot({ store, line, now: () => t, rand: () => 'r' + (++n), log: { info() {}, warn() {}, error() {} } });
  return { store, line, bot };
}
let evId = 0;
const tokOwner = {};
function base(uid) { ++evId; tokOwner['tok' + evId] = uid; return { webhookEventId: 'ev' + evId, replyToken: 'tok' + evId, source: { type: 'user', userId: uid } }; }
const textEv = (uid, text) => ({ type: 'message', ...base(uid), message: { type: 'text', text } });
const locEv = (uid, m) => ({ type: 'message', ...base(uid), message: { type: 'location', ...m } });
const pbEv = (uid, data) => ({ type: 'postback', ...base(uid), postback: { data } });

/* 把一則訊息裡所有看得到的文字與按鈕（Flex＋Quick Reply）攤平 */
function flatten(msg) {
  const texts = [], actions = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'text' && typeof n.text === 'string') texts.push(n.text);
    if (n.action && n.type !== 'action') actions.push({ ...n.action, where: 'flex' });
    for (const k of ['contents', 'body', 'header', 'footer']) if (n[k]) walk(n[k]);
  })(msg.type === 'flex' ? msg.contents : null);
  if (msg.type === 'text') texts.push(msg.text);
  if (msg.type === 'flex') texts.push(msg.altText);
  for (const i of (msg.quickReply && msg.quickReply.items) || []) actions.push({ ...i.action, where: 'quick' });
  return { text: texts.join('\n'), actions };
}
function lastReply(line, uid) {
  const rs = line.calls.reply.filter(r => tokOwner[r.token] === uid);
  const ms = rs[rs.length - 1].messages.map(flatten);
  return { text: ms.map(m => m.text).join('\n'), actions: ms.flatMap(m => m.actions) };
}
function btn(line, uid, label, type = 'postback') {
  const b = lastReply(line, uid).actions.find(a => a.label === label && a.type === type);
  assert.ok(b, `找不到「${label}」(${type})，現有：${lastReply(line, uid).actions.map(a => a.label + '/' + a.type).join('、')}`);
  return b;
}
const press = (bot, line, uid, label) => bot.handleEvent(pbEv(uid, btn(line, uid, label).data));
async function toLocation(bot, line, uid) {
  await bot.handleEvent(textEv(uid, '平安回報'));
  await press(bot, line, uid, '需要協助');
}

/* ============================================================ */
test('位置題：獅仔先講清楚要按右上角「分享」，四個選項齊全', async () => {
  const { bot, line } = setup();
  await toLocation(bot, line, 'U0');
  const r = lastReply(line, 'U0');
  assert.match(r.text, /方便告訴我你在哪裡嗎？/);
  assert.match(r.text, /如果選擇分享位置，請在地圖選好位置後，再點右上角『分享』，獅仔才會收到喔。/);
  btn(line, 'U0', '分享目前位置', 'location');           // LINE location action（Quick Reply）
  btn(line, 'U0', '輸入地址或地標'); btn(line, 'U0', '使用示範位置'); btn(line, 'U0', '暫不提供');
});

test('1. 分享 LINE 位置 → 確認卡 → 位置正確，繼續 → 送出', async () => {
  const { bot, line, store } = setup();
  const u = 'U1';
  await toLocation(bot, line, u);
  await bot.handleEvent(locEv(u, { latitude: 25.033, longitude: 121.565, address: '台北市信義區市府路1號', title: '位置資訊' }));
  let r = lastReply(line, u);
  assert.match(r.text, /獅仔收到的位置是：/); assert.match(r.text, /台北市信義區市府路1號/); assert.match(r.text, /25\.03300, 121\.56500/);
  btn(line, u, '重新提供位置');
  assert.equal((await store.get('session:U1')).loc, null, '按確認前不算定位成功');
  await press(bot, line, u, '位置正確，繼續');
  r = lastReply(line, u);
  assert.match(r.text, /確認後立刻通知家人/); assert.match(r.text, /需要協助/); assert.match(r.text, /台北市信義區市府路1號/);
  await press(bot, line, u, '送出並通知家人');
  const rep = await store.get('report:U1');
  assert.equal(rep.status, 'help'); assert.equal(rep.loc.source, 'real'); assert.equal(rep.loc.lat, 25.033);
  assert.equal(line.calls.push.length, 1); assert.equal(line.calls.push[0].to, u, '沒配對家人時只推回自己的聊天室');
  assert.match(line.calls.push[0].messages[0].text, /地圖：https:\/\/www\.google\.com\/maps\?q=25\.03300,121\.56500/);
});

test('位置訊息沒有地址：只顯示經緯度，不捏造地址', async () => {
  const { bot, line } = setup();
  await toLocation(bot, line, 'U1b');
  await bot.handleEvent(locEv('U1b', { latitude: 24.9, longitude: 121.2 }));
  const t = lastReply(line, 'U1b').text;
  assert.match(t, /LINE 沒有提供地址，以下是經緯度/); assert.match(t, /24\.90000, 121\.20000/);
  assert.doesNotMatch(t, /市|區|路|號/, '不可出現自行補上的地址');
});

test('2. 關閉地圖沒分享 → 不跳題 → 改用手動輸入', async () => {
  const { bot, line, store } = setup();
  const u = 'U2';
  await toLocation(bot, line, u);
  /* 使用者點「分享目前位置」但沒按分享就關掉地圖：LINE 不會送任何事件過來 → 什麼都不發生 */
  const s = await store.get('session:U2');
  assert.equal(s.step, 'location'); assert.equal(s.loc, null);
  /* 回到聊天室亂打字：留在位置題並提示 */
  await bot.handleEvent(textEv(u, '我不會按'));
  assert.match(lastReply(line, u).text, /請先按「輸入地址或地標」/); assert.match(lastReply(line, u).text, /方便告訴我你在哪裡嗎/);
  assert.equal((await store.get('session:U2')).status, 'help', '沒有重新開始');
  await press(bot, line, u, '輸入地址或地標');
  assert.match(lastReply(line, u).text, /請直接打字/);
  await bot.handleEvent(textEv(u, '福安宮前面'));
  assert.match(lastReply(line, u).text, /獅仔收到的位置是：[\s\S]*福安宮前面/);
  await press(bot, line, u, '位置正確，繼續');
  await press(bot, line, u, '送出並通知家人');
  const rep = await store.get('report:U2');
  assert.deepEqual(rep.loc, { source: 'manual', text: '福安宮前面' });
  assert.match(line.calls.push[0].messages[0].text, /位置：福安宮前面（自行輸入）/);
});

test('3. 手動輸入地址：太短重問；中途改分享 LINE 位置也可以', async () => {
  const { bot, line, store } = setup();
  const u = 'U3';
  await toLocation(bot, line, u);
  await press(bot, line, u, '輸入地址或地標');
  await bot.handleEvent(textEv(u, '家'));
  assert.match(lastReply(line, u).text, /請輸入 2～80 個字/);
  await bot.handleEvent(textEv(u, '中山路 100 號'));
  assert.match(lastReply(line, u).text, /中山路 100 號/);
  assert.equal((await store.get('session:U3')).step, 'loc_confirm');
  /* 在確認卡階段又分享了 LINE 位置：以最新的為準 */
  const oldOk = btn(line, u, '位置正確，繼續').data;
  await bot.handleEvent(locEv(u, { latitude: 25.1, longitude: 121.5, address: '台北市士林區' }));
  assert.match(lastReply(line, u).text, /台北市士林區/);
  await bot.handleEvent(pbEv(u, oldOk));                         // 舊卡（中山路）按了無效
  assert.match(lastReply(line, u).text, /這張位置卡片已經過期/);
  assert.equal((await store.get('session:U3')).pendingLoc.address, '台北市士林區');
});

test('4. 使用示範位置：確認卡、送出摘要、家人通知都標「示範位置」', async () => {
  const { bot, line, store } = setup();
  const u = 'U4';
  await toLocation(bot, line, u);
  await press(bot, line, u, '使用示範位置');
  assert.match(lastReply(line, u).text, /【示範位置】不是你的真實位置/);
  await press(bot, line, u, '位置正確，繼續');
  assert.match(lastReply(line, u).text, /福安里福安街 1 號（示範位置）/);
  await press(bot, line, u, '送出並通知家人');
  assert.equal((await store.get('report:U4')).loc.source, 'demo');
  assert.match(line.calls.push[0].messages[0].text, /位置：福安里福安街 1 號（示範位置）/);
});

test('5. 略過位置：記為未提供，並清掉先前選過的位置', async () => {
  const { bot, line, store } = setup();
  const u = 'U5';
  await toLocation(bot, line, u);
  await press(bot, line, u, '使用示範位置');                     // 先選了示範（待確認）
  const staleOk = btn(line, u, '位置正確，繼續').data;
  /* 往上捲回位置題，按「暫不提供」 */
  const askLoc = line.calls.reply.filter(r => tokOwner[r.token] === u).map(r => r.messages.map(flatten)).find(ms => ms.some(m => /方便告訴我/.test(m.text)));
  const skip = askLoc.flatMap(m => m.actions).find(a => a.label === '暫不提供' && a.type === 'postback');
  await bot.handleEvent(pbEv(u, skip.data));
  let s = await store.get('session:U5');
  assert.deepEqual(s.loc, { source: 'none' }); assert.equal(s.pendingLoc, null);
  assert.match(lastReply(line, u).text, /位置[\s\S]*未提供/);
  await bot.handleEvent(pbEv(u, staleOk));                       // 舊的示範確認卡
  s = await store.get('session:U5');
  assert.deepEqual(s.loc, { source: 'none' }, '舊確認卡不能把示範位置套回來');
  await press(bot, line, u, '送出並通知家人');
  assert.deepEqual((await store.get('report:U5')).loc, { source: 'none' });
  assert.match(line.calls.push[0].messages[0].text, /位置：未提供/);
});

test('6. 重新提供位置：只重做位置，保留「需要協助」', async () => {
  const { bot, line, store } = setup();
  const u = 'U6';
  await toLocation(bot, line, u);
  await press(bot, line, u, '使用示範位置');
  await press(bot, line, u, '重新提供位置');
  let s = await store.get('session:U6');
  assert.equal(s.step, 'location'); assert.equal(s.status, 'help'); assert.equal(s.loc, null); assert.equal(s.pendingLoc, null);
  assert.match(lastReply(line, u).text, /方便告訴我你在哪裡嗎/);
  assert.doesNotMatch(lastReply(line, u).text, /你現在平安嗎/, '不回到第一題');
  await bot.handleEvent(locEv(u, { latitude: 25, longitude: 121.5, address: '新北市板橋區' }));
  await press(bot, line, u, '位置正確，繼續');
  /* 在最後送出頁也可以只改位置 */
  await press(bot, line, u, '重新提供位置');
  s = await store.get('session:U6');
  assert.equal(s.step, 'location'); assert.equal(s.status, 'help'); assert.equal(s.loc, null);
  await press(bot, line, u, '輸入地址或地標');
  await bot.handleEvent(textEv(u, '板橋車站'));
  await press(bot, line, u, '位置正確，繼續');
  assert.match(lastReply(line, u).text, /需要協助/); assert.match(lastReply(line, u).text, /板橋車站/);
  await press(bot, line, u, '送出並通知家人');
  const rep = await store.get('report:U6');
  assert.equal(rep.status, 'help'); assert.equal(rep.loc.text, '板橋車站');
});

test('7. 舊確認按鈕不影響新回報（跨回報、同回報、重複 webhook）', async () => {
  const { bot, line, store } = setup();
  const u = 'U7';
  /* 第一次回報：分享位置 A，拿到確認卡但不按 */
  await toLocation(bot, line, u);
  await bot.handleEvent(locEv(u, { latitude: 22.6, longitude: 120.3, address: '高雄市舊位置' }));
  const oldOk = btn(line, u, '位置正確，繼續').data, oldRedo = btn(line, u, '重新提供位置').data;
  /* 開始新的回報 */
  await toLocation(bot, line, u);
  await bot.handleEvent(pbEv(u, oldOk));
  assert.match(lastReply(line, u).text, /已經過期/);
  let s = await store.get('session:U7');
  assert.equal(s.step, 'location'); assert.equal(s.loc, null); assert.equal(s.pendingLoc, null, '舊位置沒被套進新回報');
  await bot.handleEvent(pbEv(u, oldRedo));
  assert.match(lastReply(line, u).text, /已經過期/);
  /* 新回報裡：先示範、再改手動；示範那張卡作廢 */
  await press(bot, line, u, '使用示範位置');
  const demoOk = btn(line, u, '位置正確，繼續').data;
  await press(bot, line, u, '重新提供位置');
  await bot.handleEvent(pbEv(u, demoOk));
  assert.match(lastReply(line, u).text, /這張位置卡片已經過期/);
  assert.equal((await store.get('session:U7')).loc, null);
  await press(bot, line, u, '輸入地址或地標');
  await bot.handleEvent(textEv(u, '福安宮'));
  const okEv = pbEv(u, btn(line, u, '位置正確，繼續').data);
  await bot.handleEvent(okEv);
  assert.equal((await bot.handleEvent(okEv)).skipped, 'duplicate', 'LINE 重送同一事件被跳過');
  await bot.handleEvent(pbEv(u, okEv.postback.data));            // 連點（新事件 id）
  s = await store.get('session:U7');
  assert.equal(s.step, 'confirm'); assert.equal(s.loc.text, '福安宮');
  const sendEv = pbEv(u, btn(line, u, '送出並通知家人').data);
  await bot.handleEvent(sendEv); await bot.handleEvent(sendEv); await bot.handleEvent(pbEv(u, sendEv.postback.data));
  assert.equal(line.calls.push.length, 1, '只推一次');
  assert.equal((await store.get('report:U7')).loc.text, '福安宮');
  /* 回報完成後，舊位置訊息／舊卡都不會開新紀錄 */
  await bot.handleEvent(pbEv(u, demoOk));
  assert.equal((await store.get('report:U7')).loc.text, '福安宮');
});

test('位置確認後再傳位置、未到位置題先傳位置：都不會亂套', async () => {
  const { bot, line, store } = setup();
  const u = 'U8';
  await bot.handleEvent(textEv(u, '平安回報'));
  await bot.handleEvent(locEv(u, { latitude: 25, longitude: 121 }));
  assert.equal((await store.get('session:U8')).step, 'status');
  await press(bot, line, u, '需要協助');
  await press(bot, line, u, '使用示範位置'); await press(bot, line, u, '位置正確，繼續');
  await bot.handleEvent(locEv(u, { latitude: 25, longitude: 121, address: '另一個地方' }));
  assert.match(lastReply(line, u).text, /位置已經確認過了/);
  assert.equal((await store.get('session:U8')).loc.source, 'demo');
});

test('保留功能：我平安直接關懷結束、取消、流程外文字不回', async () => {
  const { bot, line, store } = setup();
  const u = 'U9';
  assert.equal((await bot.handleEvent(textEv(u, '哈囉'))).ignored, 'text outside session');
  await bot.handleEvent(textEv(u, '平安回報'));
  await press(bot, line, u, '我平安');
  assert.match(lastReply(line, u).text, /知道你平安就好/);
  assert.equal((await store.get('report:U9')).status, 'safe'); assert.equal(line.calls.push.length, 0);
  await toLocation(bot, line, u);
  await bot.handleEvent(textEv(u, '取消'));
  assert.match(lastReply(line, u).text, /已取消/); assert.equal(await store.get('session:U9'), null);
});

test('保留功能：已配對家人會收到；不同使用者互不影響', async () => {
  const { bot, line } = setup({ names: { O1: '阿公', F1: '孫女' } });
  await bot.handleEvent(textEv('O1', '配對家人'));
  const code = /配對碼：(\d{6})/.exec(lastReply(line, 'O1').text)[1];
  await bot.handleEvent(textEv('F1', '配對 ' + code)); await press(bot, line, 'F1', '接受');
  await toLocation(bot, line, 'O1');
  await toLocation(bot, line, 'B1');
  await press(bot, line, 'O1', '暫不提供');
  await press(bot, line, 'O1', '送出並通知家人');
  const toF = line.calls.push.filter(p => p.to === 'F1');
  assert.equal(toF.length, 1); assert.match(toF[0].messages[0].text, /【平安回報】阿公/);
  assert.match(lastReply(line, 'B1').text, /方便告訴我你在哪裡嗎/, 'B1 仍在自己的位置題');
});

test('webhook：簽章錯誤 401、正確簽章會處理', async () => {
  const { bot, line } = setup();
  const secret = 'test-secret';
  const webhook = createWebhook({ bot, channelSecret: secret, log: { warn() {}, error() {} } });
  const body = JSON.stringify({ events: [textEv('W1', '平安回報')] });
  const { createHmac } = await import('node:crypto');
  assert.equal((await webhook({ rawBody: body, signature: 'bad' })).status, 401);
  const out = await webhook({ rawBody: body, signature: createHmac('sha256', secret).update(body).digest('base64') });
  assert.equal(out.status, 200); assert.match(lastReply(line, 'W1').text, /你現在平安嗎/);
});

test('Flex 結構：位置確認卡是兩顆大按鈕，文字不超過 LINE 限制', async () => {
  const { bot, line } = setup();
  await toLocation(bot, line, 'U10');
  const ask = line.calls.reply.at(-1).messages[0];
  assert.equal(ask.type, 'flex'); assert.ok(ask.quickReply.items.length <= 13);
  assert.ok(ask.quickReply.items.every(i => i.action.label.length <= 20));
  await press(bot, line, 'U10', '使用示範位置');
  const card = line.calls.reply.at(-1).messages[0];
  const acts = flatten(card).actions;
  assert.deepEqual(acts.map(a => a.label), ['位置正確，繼續', '重新提供位置']);
  assert.ok(card.altText.length <= 400);
  assert.ok(acts.every(a => a.data.length <= 300));
});
