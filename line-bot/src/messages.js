/* ============================================================
   福安 LINE・平安回報 Bot — 固定文案與訊息模板
   ------------------------------------------------------------
   全部寫死，不叫任何 AI 模型。
   每一題用 Flex Message 做「大按鈕」（Quick Reply 的字級 LINE 固定、不能放大），
   整格都能按、字級 xxl，長輩好點。
   流程只有三步：狀況 → 位置 → 確認並通知家人（出事時要快，不問需求、人數）。
   Postback 的 data 格式：a=動作&s=對話代號&v=值
     s（session id）用來擋「過期按鈕」：舊對話的按鈕按下去，s 對不上就當過期。
   ============================================================ */

export const HOME_LOC = { source: 'preset', text: '福安里福安街 1 號' };
export const DEFAULT_FAMILY_NAME = '家人';
/* LINE 官方 URL scheme：開啟「傳送位置」畫面，使用者自己確認後才送出位置訊息 */
export const LOCATION_PICKER_URL = 'https://line.me/R/nv/location/';

const C = { green: '#0C8F3B', red: '#B4362A', gray: '#5F5952', ink: '#1F1A17', soft: '#F7F5F0' };

/* ---------- 文字指令（完全比對，前後空白忽略）---------- */
export const CMD = {
  START: ['平安回報', '獅仔平安回報'],
  CANCEL: ['取消'],
  RESTART: ['重新開始', '重來'],
  PAIR_CODE: ['配對家人', '配對碼', '取得配對碼'],
  MY_FAMILY: ['我的家人'],
  UNPAIR: ['解除配對', '取消配對']
};
export const PAIR_JOIN_RE = /^配對\s*(\d{6})$/;

/* ---------- 小工具 ---------- */
export function pb(action, sessionId, value) {
  const p = new URLSearchParams();
  p.set('a', action);
  if (sessionId) p.set('s', sessionId);
  if (value != null && value !== '') p.set('v', String(value));
  return p.toString();
}
export function parsePb(data) {
  try {
    const p = new URLSearchParams(String(data || ''));
    return { a: p.get('a') || '', s: p.get('s') || '', v: p.get('v') || '' };
  } catch (_) { return { a: '', s: '', v: '' }; }
}
function qrPostback(label, data, displayText) {
  return { type: 'action', action: { type: 'postback', label, data, displayText: displayText || label } };
}
function qrLocation(label) { return { type: 'action', action: { type: 'location', label } }; }
export function text(t, quickItems) {
  const m = { type: 'text', text: t };
  if (quickItems && quickItems.length) m.quickReply = { items: quickItems.slice(0, 13) };
  return m;
}

/* ---------- 大按鈕 Flex ---------- */
function bigBtn(label, action, color, sub) {
  const contents = [{ type: 'text', text: label, size: 'xxl', weight: 'bold', color: '#FFFFFF', align: 'center', wrap: true }];
  if (sub) contents.push({ type: 'text', text: sub, size: 'md', color: '#FFFFFF', align: 'center', wrap: true, margin: 'sm' });
  return { type: 'box', layout: 'vertical', backgroundColor: color, cornerRadius: '14px', paddingAll: '20px', action, contents };
}
function pbAction(label, data, displayText) { return { type: 'postback', label: label.slice(0, 20), data, displayText: displayText || label }; }
function uriAction(label, uri) { return { type: 'uri', label: label.slice(0, 20), uri }; }
function rows(lines) {
  return lines.map(([k, v]) => ({
    type: 'box', layout: 'baseline', spacing: 'md', contents: [
      { type: 'text', text: k, size: 'lg', color: C.gray, flex: 2 },
      { type: 'text', text: v, size: 'lg', color: C.ink, weight: 'bold', flex: 5, wrap: true }
    ]
  }));
}
/* bubble：標題（xl）＋ 選配資料列 ＋ 大按鈕 */
export function card(altText, title, buttons, opts = {}) {
  const body = [{ type: 'text', text: title, size: 'xl', weight: 'bold', color: C.ink, wrap: true }];
  if (opts.rows && opts.rows.length) body.push({ type: 'box', layout: 'vertical', spacing: 'md', margin: 'lg', paddingAll: '14px', backgroundColor: C.soft, cornerRadius: '12px', contents: rows(opts.rows) });
  if (opts.note) body.push({ type: 'text', text: opts.note, size: 'md', color: C.gray, wrap: true, margin: 'md' });
  if (buttons.length) body.push({ type: 'box', layout: 'vertical', spacing: 'lg', margin: 'xl', contents: buttons });
  const m = { type: 'flex', altText: altText.slice(0, 400), contents: { type: 'bubble', size: 'giga', body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: body } } };
  if (opts.quick && opts.quick.length) m.quickReply = { items: opts.quick };
  return m;
}

/* ---------- 時間（台灣時間）---------- */
const TZ = 'Asia/Taipei';
export function fmtFull(ms) {
  const parts = {};
  new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).forEach(p => { parts[p.type] = p.value; });
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
}

/* ---------- 位置 ---------- */
export function locLabel(loc) {
  if (!loc || loc.source === 'none') return '未提供';
  if (loc.source === 'preset') return loc.text;
  const addr = loc.address ? `${loc.address} ` : '';
  return `${addr}(${Number(loc.lat).toFixed(5)}, ${Number(loc.lng).toFixed(5)})`;
}
export function mapUrl(loc) { return `https://www.google.com/maps?q=${Number(loc.lat).toFixed(5)},${Number(loc.lng).toFixed(5)}`; }
function statusText(s) { return s === 'help' ? '需要協助' : '平安'; }

/* ---------- 摘要（確認頁、完成頁、家人通知共用）---------- */
export function summaryRows(d, at) {
  const r = [['狀況', statusText(d.status)], ['位置', locLabel(d.loc)]];
  if (at) r.push(['時間', fmtFull(at)]);
  return r;
}
export function familyNotifyText(report, ownerName) {
  const lines = [`【平安回報】${ownerName || '家人'}`, `狀況：${statusText(report.status)}`, `位置：${locLabel(report.loc)}`];
  if (report.loc && report.loc.source === 'real') lines.push(`地圖：${mapUrl(report.loc)}`);
  lines.push(`時間：${fmtFull(report.confirmedAt)}`);
  return lines.join('\n');
}

/* ---------- 每一題 ---------- */
export const M = {
  askStatus(sid) {
    return card('你現在平安嗎？', '我是獅仔，你現在平安嗎？', [
      bigBtn('我平安', pbAction('我平安', pb('status', sid, 'safe')), C.green),
      bigBtn('需要協助', pbAction('需要協助', pb('status', sid, 'help')), C.red)
    ]);
  },
  askLocation(sid) {
    return card('你在哪裡？', '你現在在哪裡？', [
      bigBtn('傳送目前位置', uriAction('傳送目前位置', LOCATION_PICKER_URL), C.green, '開啟地圖，確認後送出'),
      bigBtn('在家', pbAction('在家', pb('loc', sid, 'home')), C.gray, HOME_LOC.text),
      bigBtn('不提供', pbAction('不提供', pb('loc', sid, 'skip')), C.gray)
    ], { quick: [qrLocation('傳送目前位置')] });
  },
  askConfirm(sid, d) {
    const help = d.status === 'help';
    return card(`${statusText(d.status)}・${locLabel(d.loc)}`, help ? '確認後立刻通知家人' : '確認後通知家人你平安', [
      bigBtn('送出並通知家人', pbAction('送出並通知家人', pb('confirm', sid)), help ? C.red : C.green),
      bigBtn('重新填寫', pbAction('重新填寫', pb('redo', sid)), C.gray)
    ], { rows: summaryRows(d) });
  },
  sent(report, names) {
    return card(`已通知${names.join('、')}`, `已通知${names.join('、')}`, [], { rows: summaryRows(report, report.confirmedAt) });
  },
  sendFailed(sid, report, okNames, failNames) {
    const title = okNames.length ? `已通知${okNames.join('、')}；${failNames.join('、')}發送失敗` : '通知發送失敗';
    return card(title, title, [bigBtn('再試一次', pbAction('再試一次', pb('confirm', sid)), C.red)], { rows: summaryRows(report, report.confirmedAt) });
  },
  safeCare() {
    return text('知道你平安就好 🙏\n最近天氣變化大，記得多喝水、照顧好自己。\n有任何需要，隨時按「平安回報」找獅仔。');
  },
  cancelled() { return text('已取消。要重新回報請按「平安回報」。'); },
  expired() {
    return card('按鈕已過期', '這個按鈕已經過期了', [bigBtn('重新開始', pbAction('重新開始', pb('restart', ''), '平安回報'), C.green)]);
  },
  useButtons() { return text('請按下面的按鈕。'); },

  /* ---------- 配對 ---------- */
  pairCode(code, minutes) {
    return text([`你的配對碼：${code}（${minutes} 分鐘內有效，只能用一次）`, '', '請家人：', '1. 加入本官方帳號', `2. 傳送「配對 ${code}」`, '3. 按「接受」', '', '對方接受後你會收到通知。'].join('\n'));
  },
  pairInvalid() { return text('配對碼無效或已過期。請對方重新輸入「配對家人」取得新的配對碼。'); },
  pairSelf() { return text('這是你自己的配對碼，不能和自己配對。'); },
  pairAlready(ownerName) { return text(`你已經是 ${ownerName} 的家人了。`); },
  pairAsk(sid, ownerName, code) {
    return text(`要成為 ${ownerName} 的家人嗎？\n接受後，對方按「平安回報」送出時，你會收到通知。`, [
      qrPostback('接受', pb('pair_accept', sid, code)),
      qrPostback('拒絕', pb('pair_decline', sid, code))
    ]);
  },
  pairDone(ownerName) { return text(`已完成綁定，你現在是 ${ownerName} 的家人。要解除請輸入「解除配對」。`); },
  pairDeclined() { return text('已拒絕，沒有綁定。'); },
  pairOwnerNotice(familyName) { return text(`${familyName} 已成為你的家人，你的平安回報會通知對方。`); },
  myFamily(family, owners) {
    const a = family.length ? `你的家人（${family.length} 位）：${family.map(f => f.name).join('、')}` : '你還沒有配對家人（目前通知會送到你自己的聊天室）。輸入「配對家人」可取得配對碼。';
    const b = owners.length ? `你是這些人的家人：${owners.map(o => o.name).join('、')}` : '';
    return text([a, b].filter(Boolean).join('\n\n'));
  },
  unpairMenu(sid, family, owners) {
    if (!family.length && !owners.length) return text('目前沒有任何配對。');
    const items = [
      ...family.map(f => qrPostback(`解除：${(f.name || '家人').slice(0, 14)}`, pb('unbind_family', sid, f.userId))),
      ...owners.map(o => qrPostback(`不再當 ${(o.name || '對方').slice(0, 12)} 的家人`, pb('unbind_owner', sid, o.userId)))
    ].slice(0, 12);
    items.push(qrPostback('不用了', pb('unbind_none', sid)));
    return text('要解除哪一個配對？', items);
  },
  unbound(name) { return text(`已解除與 ${name} 的配對。`); },
  unbindNone() { return text('好，沒有變更。'); }
};
