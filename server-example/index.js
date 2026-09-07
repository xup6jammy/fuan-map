/* ============================================================
   福安 LINE 推播範例伺服器（Node 18+，只靠 express）
   ------------------------------------------------------------
   做兩件事：
   1. /webhook   收 LINE 的訊息事件。使用者在地圖按「釘到聊天室」時，index.html 會多送一行
                 「📌 釘選：某某宮」——這裡看到就記下 userId ↔ 廟名（favorites.json）。
                 使用者傳「取消釘選：某某宮」或「我的釘選」也處理。
   2. 每天早上   看明天是不是農曆初一、十五、或某位神明聖誕；是的話，找出釘了相關宮廟的人，
                 用 Messaging API push 一張卡片（卡片上的按鈕開回地圖 ?temple=）。

   ★ 這不是純前端能做的：LIFF 沒有「之後再通知使用者」的能力，一定要有一台會記帳、會定時跑的伺服器。
   ★ push 訊息算進 LINE 官方帳號的每月訊息額度（免費方案額度很小，超過要升方案），
     所以只推「跟他釘的廟有關的那一天」，不群發。
   ★ 神明聖誕日期是民間通行說法（lunar.js 檔頭有寫），推播前請跟廟方確認。

   環境變數：CHANNEL_SECRET、CHANNEL_ACCESS_TOKEN（Messaging API 的，不是 LIFF 的）
             LIFF_ID（預設 2011335067-mhkycNOg）
   啟動：    npm i express && node server-example/index.js
   驗證：    LINE Developers → Messaging API → Webhook URL 填 https://你的網域/webhook
   ============================================================ */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = process.env.CHANNEL_SECRET || '';
const TOKEN = process.env.CHANNEL_ACCESS_TOKEN || '';
const LIFF_ID = process.env.LIFF_ID || '2011335067-mhkycNOg';
const SITE_URL = 'https://xup6jammy.github.io/fuan-map/';
const DB = path.join(__dirname, 'favorites.json');       // { userId: ["廟名", ...] }
const ROOT = path.join(__dirname, '..');

/* ---------- 跟前端共用的資料：lunar.js、data/temples.json ---------- */
const win = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'lunar.js'), 'utf8'))(win);
const TEMPLES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'temples.json'), 'utf8')).temples;
const byName = Object.fromEntries(TEMPLES.map(t => [t.name, t]));

function lunarOf(date){                                   // 跟 index.html 同一套
  const iso = date.toISOString().slice(0, 10);
  let hit = null;
  for(const row of win.LUNAR_NEW_MONTH){ if(row[0] <= iso) hit = row; else break; }
  if(!hit) return null;
  const day = Math.round((new Date(iso) - new Date(hit[0])) / 86400000) + 1;
  return (day < 1 || day > 30) ? null : { month: hit[1], day, leap: !!hit[2] };
}

/* ---------- 釘選記帳 ---------- */
const PIN_TAG = '📌 釘選：';
const UNPIN_TAG = '取消釘選：';
function loadDb(){ try{ return JSON.parse(fs.readFileSync(DB, 'utf8')); }catch(_){ return {}; } }
function saveDb(db){ fs.writeFileSync(DB, JSON.stringify(db, null, 1)); }

/* ---------- LINE API ---------- */
async function lineApi(p, body){
  const r = await fetch('https://api.line.me/v2/bot/message/' + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(body)
  });
  if(!r.ok) console.error('LINE API', p, r.status, await r.text());
}
const reply = (token, messages) => lineApi('reply', { replyToken: token, messages });
const push = (to, messages) => lineApi('push', { to, messages });

function deepLink(name){ return 'https://liff.line.me/' + LIFF_ID + '?temple=' + encodeURIComponent(name); }
function noticeFlex(t, title, line){
  return { type: 'flex', altText: title + '｜' + t.name, contents: { type: 'bubble', size: 'kilo',
    hero: { type: 'image', url: SITE_URL + 'temple.png', size: 'full', aspectRatio: '20:13', aspectMode: 'fit', backgroundColor: '#F6F4ED' },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
      { type: 'text', text: t.name + (t.deity ? '・' + t.deity : ''), size: 'sm', color: '#8C8778', wrap: true },
      { type: 'text', text: line, size: 'sm', color: '#3A2E2A', wrap: true } ] },
    footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', color: '#0C8F3B', height: 'sm', action: { type: 'uri', label: '在地圖上看', uri: deepLink(t.name) } },
      { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '導航', uri: 'https://www.google.com/maps/dir/?api=1&destination=' + t.lat + ',' + t.lng } } ] } } };
}

/* ---------- 1. webhook ---------- */
const app = express();
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const sig = crypto.createHmac('sha256', SECRET).update(req.body).digest('base64');
  if(sig !== req.get('x-line-signature')) return res.sendStatus(403);
  res.sendStatus(200);                                     // 先回 200，LINE 才不會重送
  const db = loadDb();
  for(const ev of JSON.parse(req.body).events || []){
    if(ev.type !== 'message' || ev.message.type !== 'text' || !ev.source.userId) continue;
    const uid = ev.source.userId, text = ev.message.text.trim();
    const mine = db[uid] || (db[uid] = []);
    if(text.startsWith(PIN_TAG)){
      const name = text.slice(PIN_TAG.length).trim();
      if(!byName[name]) continue;                         // 不認識的廟名不記
      if(!mine.includes(name)) mine.push(name);
      saveDb(db);
      await reply(ev.replyToken, [{ type: 'text', text: '記住了，' + name + '有大日子（初一、十五、神明聖誕）前一天會提醒你。傳「取消釘選：' + name + '」就不提醒。' }]);
    }else if(text.startsWith(UNPIN_TAG)){
      const name = text.slice(UNPIN_TAG.length).trim();
      db[uid] = mine.filter(n => n !== name); saveDb(db);
      await reply(ev.replyToken, [{ type: 'text', text: '好，' + name + '不再提醒。' }]);
    }else if(text === '我的釘選'){
      await reply(ev.replyToken, [{ type: 'text', text: mine.length ? '你釘的宮廟：\n' + mine.join('\n') : '還沒釘任何宮廟，到福安地圖按「釘到聊天室」就會記下來。' }]);
    }
  }
});

/* ---------- 2. 每天早上 9 點：明天有大日子就推 ---------- */
function tomorrowEvents(){
  const d = new Date(); d.setDate(d.getDate() + 1);
  const l = lunarOf(d);
  if(!l || l.leap) return [];
  const out = [];
  if(l.day === 1 || l.day === 15) out.push({ title: '明天農曆' + (l.day === 1 ? '初一' : '十五'), match: () => true,
    line: '初一十五香客多，早點去或搭大眾運輸比較順。' });
  for(const b of win.GOD_BIRTHDAY){
    if(b.md === l.month + '.' + l.day) out.push({ title: '明天是' + b.name, match: t => (t.deity || '').includes(b.key),
      line: '主祀神明聖誕，廟方通常有祝壽活動，人潮會比平常多。' });
  }
  return out;
}
async function dailyPush(){
  const events = tomorrowEvents();
  if(!events.length) return console.log('明天沒有大日子，不推');
  const db = loadDb(); let n = 0;
  for(const [uid, names] of Object.entries(db)){
    const msgs = [];
    for(const name of names){
      const t = byName[name]; if(!t) continue;
      const ev = events.find(e => e.match(t));
      if(ev) msgs.push(noticeFlex(t, ev.title, ev.line));
    }
    if(msgs.length){ await push(uid, msgs.slice(0, 5)); n++; }   // 一次最多 5 則
  }
  console.log('推了 %d 位使用者', n);
}
function scheduleDaily(hour){
  const now = new Date(), next = new Date(now);
  next.setHours(hour, 0, 0, 0); if(next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => { dailyPush().catch(console.error); scheduleDaily(hour); }, next - now);
}
if(process.argv.includes('--push-now')){ dailyPush().then(() => process.exit()); }
else { scheduleDaily(9); app.listen(process.env.PORT || 3000, () => console.log('webhook on :' + (process.env.PORT || 3000))); }
