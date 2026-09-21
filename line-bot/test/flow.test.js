/* ============================================================
   Bot 流程測試（node --test）。LINE API 全部 mock：不會打到 LINE、不會發任何真實訊息。
   每個測試建立自己的 MemoryStore 與 mock line。
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/flow.js';
import { createWebhook } from '../src/webhook.js';
import { MemoryStore } from '../src/store.js';
import { parsePb } from '../src/messages.js';

/* ---------- mock LINE ---------- */
function mockLine(opts = {}) {
  const calls = { reply: [], push: [], profile: [] };
  return {
    calls,
    reply: async (token, messages) => { calls.reply.push({ token, messages: [].concat(messages) }); },
    push: async (to, messages) => {
      calls.push.push({ to, messages: [].concat(messages) });
      if (opts.pushFail && opts.pushFail.includes(to)) { const e = new Error('LINE API 400 /message/push: blocked'); e.status = 400; throw e; }
    },
    profile: async (userId) => { calls.profile.push(userId); return opts.names && opts.names[userId] ? { displayName: opts.names[userId] } : null; }
  };
}
function setup(opts = {}) {
  const store = new MemoryStore();
  const line = mockLine(opts);
  let t = 1700000000000; let n = 0;
  const bot = createBot({ store, line, now: () => t, rand: () => 'r' + (++n), log: { info() {}, warn() {}, error() {} } });
  return { store, line, bot, tick: ms => { t += ms; } };
}
let evId = 0;
const tokOwner = {};   // replyToken → userId，讓測試能取「某位使用者」收到的最後一則回覆
function base(uid) { ++evId; tokOwner['tok' + evId] = uid; return { webhookEventId: 'ev' + evId, replyToken: 'tok' + evId, source: { type: 'user', userId: uid } }; }
const textEv = (uid, text) => ({ type: 'message', ...base(uid), message: { type: 'text', text } });
const locEv = (uid, lat, lng, address) => ({ type: 'message', ...base(uid), message: { type: 'location', latitude: lat, longitude: lng, address } });
const pbEv = (uid, data) => ({ type: 'postback', ...base(uid), postback: { data } });

/* 最後一則回覆的文字與 quick reply 按鈕 */
function last(line, uid) {
  const rs = uid ? line.calls.reply.filter(r => tokOwner[r.token] === uid) : line.calls.reply;
  const r = rs[rs.length - 1];
  const m = r.messages[0];
  const items = (m.quickReply && m.quickReply.items) || [];
  return { text: m.text, items, btn: label => items.find(i => i.action.label === label || i.action.label === '✓ ' + label) };
}
/* 按某個 quick reply 按鈕（模擬 LINE 送回 postback）*/
async function press(bot, line, uid, label) {
  const b = last(line, uid).btn(label);
  assert.ok(b, `找不到按鈕「${label}」，現有：${last(line, uid).items.map(i => i.action.label).join('/')}`);
  assert.equal(b.action.type, 'postback', `「${label}」不是 postback`);
  return bot.handleEvent(pbEv(uid, b.action.data));
}

/* ============================================================ */
test('求助流程：示範位置 → 多選需求（含其他）→ 人數 → 確認 → 記錄', async () => {
  const { bot, line, store } = setup();
  const u = 'U1';
  await bot.handleEvent(textEv(u, '平安回報'));
  assert.match(last(line).text, /你現在平安嗎/);
  await press(bot, line, u, '需要協助');
  assert.match(last(line).text, /目前位置/);
  assert.equal(last(line).btn('分享位置').action.type, 'location', '分享位置要是 LINE location action');
  await press(bot, line, u, '使用示範位置');
  assert.match(last(line).text, /哪方面的協助/);
  await press(bot, line, u, '飲水');
  assert.match(last(line).text, /目前選了：飲水/);
  await press(bot, line, u, '其他');
  assert.match(last(line).text, /「其他」是什麼協助/);
  await bot.handleEvent(textEv(u, '需要充電'));
  assert.match(last(line).text, /目前選了：飲水、其他（需要充電）/);
  await press(bot, line, u, '選好了');
  assert.match(last(line).text, /幾位需要協助/);
  assert.equal(await store.get('report:U1'), null, '確認前不得有正式紀錄');
  await press(bot, line, u, '2 人');
  assert.match(last(line).text, /需求：飲水、其他（需要充電）/);
  assert.match(last(line).text, /需要協助人數：2 人/);
  assert.match(last(line).text, /福安里示範地址（福安街 1 號）（示範位置）/);
  await press(bot, line, u, '確認回報');
  const rep = await store.get('report:U1');
  assert.ok(rep && rep.status === 'help' && rep.people === '2' && rep.loc.source === 'demo', '確認後才有正式紀錄');
  assert.match(last(line).text, /示範回報已記錄/);
  assert.match(last(line).text, /回報時間：2023\/11\/15 06:13（台灣時間）/);
  assert.ok(last(line).btn('通知測試家人') && last(line).btn('暫不通知'));
  assert.equal(line.calls.push.length, 0, '整個流程沒有任何推播');
});

test('平安流程：跳過需求與人數；分享真實位置；略過', async () => {
  const { bot, line, store } = setup();
  const u = 'U2';
  await bot.handleEvent(textEv(u, '平安回報'));
  await press(bot, line, u, '我平安');
  await bot.handleEvent(locEv(u, 25.03300, 121.56500, '台北市信義區'));
  const t = last(line).text;
  assert.match(t, /請看一下對不對/, '平安者位置後直接到確認');
  assert.doesNotMatch(t, /需求：/); assert.doesNotMatch(t, /人數/);
  assert.match(t, /台北市信義區　25\.03300, 121\.56500（使用者分享的位置）/);
  assert.match(t, /地圖：https:\/\/www\.google\.com\/maps\?q=25\.03300,121\.56500/);
  await press(bot, line, u, '確認回報');
  const rep = await store.get('report:U2');
  assert.equal(rep.status, 'safe'); assert.deepEqual(rep.needs, []); assert.equal(rep.people, null); assert.equal(rep.loc.source, 'real');
  /* 略過位置 */
  await bot.handleEvent(textEv(u, '平安回報'));
  await press(bot, line, u, '我平安');
  await press(bot, line, u, '略過');
  assert.match(last(line).text, /位置：未提供/);
  assert.doesNotMatch(last(line).text, /地圖：/);
});

test('求助改平安：新的紀錄不殘留舊需求；同一人只有一筆', async () => {
  const { bot, line, store } = setup();
  const u = 'U3';
  await bot.handleEvent(textEv(u, '平安回報')); await press(bot, line, u, '需要協助'); await press(bot, line, u, '略過');
  await press(bot, line, u, '食物'); await press(bot, line, u, '選好了'); await press(bot, line, u, '3 人以上'); await press(bot, line, u, '確認回報');
  assert.equal((await store.get('report:U3')).needs.length, 1);
  await bot.handleEvent(textEv(u, '平安回報')); await press(bot, line, u, '我平安'); await press(bot, line, u, '使用示範位置'); await press(bot, line, u, '確認回報');
  const rep = await store.get('report:U3');
  assert.equal(rep.status, 'safe'); assert.deepEqual(rep.needs, []); assert.equal(rep.people, null); assert.equal(rep.other, '');
  assert.doesNotMatch(last(line).text, /食物/);
});

test('取消、重新開始、重新填寫', async () => {
  const { bot, line, store } = setup();
  const u = 'U4';
  await bot.handleEvent(textEv(u, '平安回報')); await press(bot, line, u, '需要協助');
  await bot.handleEvent(textEv(u, '取消'));
  assert.match(last(line).text, /已取消/); assert.equal(await store.get('session:U4'), null);
  await bot.handleEvent(textEv(u, '平安回報')); await press(bot, line, u, '需要協助'); await press(bot, line, u, '使用示範位置');
  await bot.handleEvent(textEv(u, '重新開始'));
  assert.match(last(line).text, /你現在平安嗎/);
  await press(bot, line, u, '我平安'); await press(bot, line, u, '略過');
  await press(bot, line, u, '重新填寫');
  assert.match(last(line).text, /你現在平安嗎/);
  assert.equal(await store.get('report:U4'), null, '取消／重填都不會產生紀錄');
});

test('亂輸入：流程中回「請用按鈕」並重問同一題；流程外不回', async () => {
  const { bot, line } = setup();
  const u = 'U5';
  const r0 = await bot.handleEvent(textEv(u, '哈囉'));
  assert.equal(r0.ignored, 'text outside session'); assert.equal(line.calls.reply.length, 0);
  await bot.handleEvent(textEv(u, '平安回報'));
  await bot.handleEvent(textEv(u, '我很好'));
  assert.match(last(line).text, /請用下方的按鈕/); assert.match(last(line).text, /你現在平安嗎/);
  await press(bot, line, u, '需要協助');
  await bot.handleEvent(textEv(u, '  平安回報 '));   // 前後空白
  assert.match(last(line).text, /你現在平安嗎/);
  /* 位置訊息在不對的題目送來 */
  await press(bot, line, u, '需要協助'); await press(bot, line, u, '使用示範位置');
  await bot.handleEvent(locEv(u, 25, 121, ''));
  assert.match(last(line).text, /請用下方的按鈕/); assert.match(last(line).text, /哪方面的協助/);
  /* 其他說明太長 */
  await press(bot, line, u, '其他');
  await bot.handleEvent(textEv(u, '一'.repeat(61)));
  assert.match(last(line).text, /太長了/);
  await bot.handleEvent(textEv(u, '需要藥局資訊'));
  assert.match(last(line).text, /其他（需要藥局資訊）/);
  /* 沒選就按選好了 */
  await press(bot, line, u, '其他');   // 取消勾選其他
  await press(bot, line, u, '選好了');
  assert.match(last(line).text, /至少選一項/);
});

test('過期按鈕：舊對話的按鈕、按到已答過的題目、偽造的 postback', async () => {
  const { bot, line } = setup();
  const u = 'U6';
  await bot.handleEvent(textEv(u, '平安回報'));
  const oldBtn = last(line).btn('我平安').action.data;
  await bot.handleEvent(textEv(u, '平安回報'));         // 新對話，舊按鈕過期
  await bot.handleEvent(pbEv(u, oldBtn));
  assert.match(last(line).text, /已經過期/); assert.ok(last(line).btn('重新開始'));
  await press(bot, line, u, '重新開始');
  assert.match(last(line).text, /你現在平安嗎/);
  const statusBtn = last(line).btn('需要協助').action.data;
  await bot.handleEvent(pbEv(u, statusBtn));
  await bot.handleEvent(pbEv(u, statusBtn));            // 再按一次同一題
  assert.match(last(line).text, /已經回答過了/); assert.match(last(line).text, /目前位置/);
  await bot.handleEvent(pbEv(u, 'a=confirm&s=' + parsePb(statusBtn).s));   // 跳題偽造
  assert.match(last(line).text, /已經回答過了/);
  await bot.handleEvent(pbEv(u, 'garbage'));
  assert.match(last(line).text, /已經過期/);
});

test('不同使用者的狀態互不混淆', async () => {
  const { bot, line, store } = setup();
  await bot.handleEvent(textEv('A', '平安回報')); await press(bot, line, 'A', '需要協助');
  await bot.handleEvent(textEv('B', '平安回報')); await press(bot, line, 'B', '我平安');
  await press(bot, line, 'B', '略過'); await press(bot, line, 'B', '確認回報');
  await press(bot, line, 'A', '使用示範位置');   // A 還在自己的流程
  assert.match(last(line, 'A').text, /哪方面的協助/);
  assert.match(last(line, 'B').text, /示範回報已記錄/);
  assert.equal((await store.get('report:B')).status, 'safe'); assert.equal(await store.get('report:A'), null);
  /* B 的按鈕（帶 B 的 session id）被 A 按到：A 的 session id 不同 → 過期 */
  const bBtn = last(line, 'B').btn('暫不通知').action.data;
  await bot.handleEvent(pbEv('A', bBtn));
  assert.match(last(line, 'A').text, /已經過期/);
  assert.ok(await store.get('session:B'), 'B 的 session 不受影響');
});

test('重複 webhook（同一 webhookEventId）不重複處理、不重複通知', async () => {
  const { bot, line, store } = setup({ names: { F1: '小明' } });
  const o = 'O1', f = 'F1';
  /* 先綁定家人 */
  await bot.handleEvent(textEv(o, '配對家人'));
  const code = /配對碼：(\d{6})/.exec(last(line).text)[1];
  await bot.handleEvent(textEv(f, '配對 ' + code)); await press(bot, line, f, '接受');
  /* 回報並通知 */
  await bot.handleEvent(textEv(o, '平安回報')); await press(bot, line, o, '我平安'); await press(bot, line, o, '略過');
  const confirmEv = pbEv(o, last(line).btn('確認回報').action.data);
  await bot.handleEvent(confirmEv);
  const r2 = await bot.handleEvent(confirmEv);           // LINE 重送同一事件
  assert.equal(r2.skipped, 'duplicate');
  const before = (await store.get('report:O1')).id;
  await bot.handleEvent(pbEv(o, confirmEv.postback.data)); // 不同事件 id、同一顆按鈕再按：題目已過 → 不會再寫一筆
  assert.equal((await store.get('report:O1')).id, before);
  await press(bot, line, o, '通知測試家人');
  assert.match(last(line).text, /將由本官方帳號推播給 1 位測試家人：小明/);
  assert.match(last(line).text, /【展示演練，非真實求助】/);
  const goEv = pbEv(o, last(line).btn('確認通知').action.data);
  await bot.handleEvent(goEv);
  assert.equal(line.calls.push.filter(p => p.to === f).length, 1);
  assert.match(last(line).text, /已送出給 1 位：小明/); assert.match(last(line).text, /無法得知是否已讀/);
  await bot.handleEvent(goEv);                              // 重送
  await bot.handleEvent(pbEv(o, goEv.postback.data));       // 連點（新事件 id）→ session 已結束 → 過期
  assert.equal(line.calls.push.filter(p => p.to === f).length, 1, '推播只有一次');
});

test('家人配對：產碼、接受、拒絕、自己配自己、無效碼、重複綁定、解除、未綁定時不假裝通知', async () => {
  const { bot, line, store } = setup({ names: { O2: '阿公', F2: '孫女' } });
  const o = 'O2', f = 'F2';
  await bot.handleEvent(textEv(f, '配對 000000'));
  assert.match(last(line).text, /無效或已過期/);
  await bot.handleEvent(textEv(o, '配對家人'));
  const code = /配對碼：(\d{6})/.exec(last(line).text)[1];
  assert.doesNotMatch(last(line).text, /O2|F2/, '回覆不含 userId');
  await bot.handleEvent(textEv(o, '配對' + code));
  assert.match(last(line).text, /不能和自己配對/);
  await bot.handleEvent(textEv(f, '配對 ' + code));
  assert.match(last(line).text, /要成為 阿公 的測試家人嗎/);
  await press(bot, line, f, '拒絕');
  assert.match(last(line).text, /已拒絕/); assert.equal(await store.get('family:O2'), null);
  await bot.handleEvent(textEv(f, '配對 ' + code));
  await press(bot, line, f, '接受');
  assert.match(last(line).text, /已完成綁定，你現在是 阿公 的測試家人/);
  assert.equal(line.calls.push.length, 1, '綁定後推播通知 owner 一次'); assert.equal(line.calls.push[0].to, o);
  assert.match(line.calls.push[0].messages[0].text, /孫女 已成為你的測試家人/);
  assert.equal(await store.get('pair:' + code), null, '配對碼一次性');
  await bot.handleEvent(textEv(f, '配對 ' + code));
  assert.match(last(line).text, /無效或已過期/);
  await bot.handleEvent(textEv(o, '我的家人'));
  assert.match(last(line).text, /你的測試家人（1 位）：孫女/);
  await bot.handleEvent(textEv(f, '我的家人'));
  assert.match(last(line).text, /你是這些人的測試家人：阿公/);
  /* 未綁定的人要通知 */
  await bot.handleEvent(textEv('X', '平安回報')); await press(bot, line, 'X', '我平安'); await press(bot, line, 'X', '略過'); await press(bot, line, 'X', '確認回報');
  await press(bot, line, 'X', '通知測試家人');
  assert.match(last(line).text, /還沒有配對的測試家人，所以這次沒有發送任何通知/);
  assert.equal(line.calls.push.length, 1, '沒有多推播');
  /* 解除（家人那端）*/
  await bot.handleEvent(textEv(f, '解除配對'));
  await press(bot, line, f, '不再當 阿公 的家人');
  assert.match(last(line).text, /已解除與 阿公 的配對/);
  assert.deepEqual(await store.get('family:O2'), []); assert.deepEqual(await store.get('owners:F2'), []);
});

test('配對碼逾時失效；owner 端解除', async () => {
  const { bot, line, store, tick } = setup({ names: { O3: '媽媽', F3: '兒子' } });
  await bot.handleEvent(textEv('O3', '配對家人'));
  const code = /配對碼：(\d{6})/.exec(last(line).text)[1];
  tick(11 * 60 * 1000);
  await bot.handleEvent(textEv('F3', '配對 ' + code));
  assert.match(last(line).text, /無效或已過期/);
  await bot.handleEvent(textEv('O3', '配對家人'));
  const code2 = /配對碼：(\d{6})/.exec(last(line).text)[1];
  await bot.handleEvent(textEv('F3', '配對 ' + code2)); await press(bot, line, 'F3', '接受');
  await bot.handleEvent(textEv('O3', '解除配對'));
  await press(bot, line, 'O3', '解除：兒子');
  assert.match(last(line).text, /已解除與 兒子 的配對/);
  assert.deepEqual(await store.get('family:O3'), []); assert.deepEqual(await store.get('owners:F3'), []);
  await bot.handleEvent(textEv('O3', '解除配對'));
  assert.match(last(line).text, /目前沒有任何配對/);
});

test('通知：預覽 → 確認通知才推播；取消通知不推播且紀錄保留；部分失敗要分開講；不附已讀', async () => {
  const { bot, line, store } = setup({ names: { O4: '爺爺', F4: '大姑', F5: '二姑' }, pushFail: ['F5'] });
  const o = 'O4';
  for (const f of ['F4', 'F5']) {
    await bot.handleEvent(textEv(o, '配對家人'));
    const code = /配對碼：(\d{6})/.exec(last(line).text)[1];
    await bot.handleEvent(textEv(f, '配對 ' + code)); await press(bot, line, f, '接受');
  }
  const pushesBefore = line.calls.push.length;
  await bot.handleEvent(textEv(o, '平安回報')); await press(bot, line, o, '需要協助'); await press(bot, line, o, '使用示範位置');
  await press(bot, line, o, '行動協助'); await press(bot, line, o, '選好了'); await press(bot, line, o, '1 人'); await press(bot, line, o, '確認回報');
  await press(bot, line, o, '通知測試家人');
  assert.match(last(line).text, /推播給 2 位測試家人：大姑、二姑/);
  assert.equal(line.calls.push.length, pushesBefore, '預覽階段沒有推播');
  await press(bot, line, o, '取消通知');
  assert.match(last(line).text, /已取消通知，沒有送出任何訊息。本次回報仍保留/);
  assert.equal(line.calls.push.length, pushesBefore);
  assert.ok(await store.get('report:O4'), '紀錄保留');
  /* 再來一次，這次確認 */
  await bot.handleEvent(textEv(o, '平安回報')); await press(bot, line, o, '需要協助'); await press(bot, line, o, '使用示範位置');
  await press(bot, line, o, '飲水'); await press(bot, line, o, '選好了'); await press(bot, line, o, '2 人'); await press(bot, line, o, '確認回報');
  await press(bot, line, o, '通知測試家人'); await press(bot, line, o, '確認通知');
  const sent = line.calls.push.slice(pushesBefore);
  assert.equal(sent.length, 2);
  const msg = sent[0].messages[0].text;
  assert.ok(msg.startsWith('【展示演練，非真實求助】\n爺爺 的獅仔平安回報'), msg);
  assert.match(msg, /目前狀況：需要協助\n需求：飲水\n需要協助人數：2 人\n位置：福安里示範地址（福安街 1 號）（示範位置）\n回報時間：.*（台灣時間）\n這是功能展示訊息/);
  assert.match(last(line).text, /已送出給 1 位：大姑/); assert.match(last(line).text, /發送失敗 1 位：二姑/);
  assert.doesNotMatch(last(line).text, /家人已讀|已讀取|已收到關懷/); assert.match(last(line).text, /無法得知是否已讀/);
  const rep = await store.get('report:O4');
  const rec = Object.values(rep.notifies)[0];
  assert.deepEqual(rec.ok, ['大姑']); assert.deepEqual(rec.fail, ['二姑']);
});

test('平安通知不含求助欄位；真實位置附地圖連結；暫不通知', async () => {
  const { bot, line } = setup({ names: { O5: '奶奶', F6: '孫子' } });
  await bot.handleEvent(textEv('O5', '配對家人'));
  const code = /配對碼：(\d{6})/.exec(last(line).text)[1];
  await bot.handleEvent(textEv('F6', '配對 ' + code)); await press(bot, line, 'F6', '接受');
  await bot.handleEvent(textEv('O5', '平安回報')); await press(bot, line, 'O5', '我平安');
  await bot.handleEvent(locEv('O5', 24.9, 121.2, '桃園市中壢區'));
  await press(bot, line, 'O5', '確認回報'); await press(bot, line, 'O5', '通知測試家人'); await press(bot, line, 'O5', '確認通知');
  const msg = line.calls.push[line.calls.push.length - 1].messages[0].text;
  assert.match(msg, /目前狀況：平安/); assert.doesNotMatch(msg, /需求|人數/);
  assert.match(msg, /桃園市中壢區　24\.90000, 121\.20000（使用者分享的位置）\n地圖：https:\/\/www\.google\.com\/maps\?q=24\.90000,121\.20000/);
  await bot.handleEvent(textEv('O5', '平安回報')); await press(bot, line, 'O5', '我平安'); await press(bot, line, 'O5', '略過'); await press(bot, line, 'O5', '確認回報');
  const n = line.calls.push.length;
  await press(bot, line, 'O5', '暫不通知');
  assert.match(last(line).text, /這次不通知/); assert.equal(line.calls.push.length, n);
});

test('webhook：簽章錯誤 401、空 events 200、正確簽章會處理事件', async () => {
  const { bot, line } = setup();
  const secret = 'test-secret';
  const webhook = createWebhook({ bot, channelSecret: secret, log: { warn() {}, error() {} } });
  const body = JSON.stringify({ events: [textEv('W1', '平安回報')] });
  const { createHmac } = await import('node:crypto');
  const sig = createHmac('sha256', secret).update(body).digest('base64');
  assert.equal((await webhook({ rawBody: body, signature: 'bad' })).status, 401);
  assert.equal((await webhook({ rawBody: JSON.stringify({ events: [] }), signature: createHmac('sha256', secret).update(JSON.stringify({ events: [] })).digest('base64') })).status, 200);
  assert.equal(line.calls.reply.length, 0);
  const out = await webhook({ rawBody: body, signature: sig });
  assert.equal(out.status, 200); assert.equal(line.calls.reply.length, 1);
  assert.match(last(line).text, /你現在平安嗎/);
});
