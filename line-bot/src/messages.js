/* ============================================================
   福安 LINE・平安回報 Bot — 固定文案與訊息模板
   ------------------------------------------------------------
   全部寫死，不叫任何 AI 模型。每一題都用 Quick Reply（手機 LINE 才看得到，
   電腦版 LINE 不顯示 Quick Reply，展示請用手機）。
   Postback 的 data 格式：a=動作&s=對話代號&v=值
     s（session id）用來擋「過期按鈕」：舊對話的按鈕按下去，s 對不上就當過期。
   ============================================================ */

export const DEMO_TAG = '【展示演練，非真實求助】';
export const DEMO_FOOT = '這是功能展示訊息，並非真實求助或救援派遣。';
export const DEMO_LOC = { source: 'demo', text: '福安里示範地址（福安街 1 號）' };
/* 未配對家人時的示範模式：家人訊息推播到回報者自己的聊天室 */
export const DEMO_FAMILY_NAME = '示範家人';
export const DEMO_SELF_PREFIX = '（示範模式：尚未配對測試家人，以下是家人會收到的訊息，先送到你自己這裡）';

export const NEED_LIST = ['飲水', '食物', '行動協助', '其他'];
export const PEOPLE_OPTIONS = [
  { v: '1', label: '1 人' },
  { v: '2', label: '2 人' },
  { v: '3+', label: '3 人以上' }
];

/* ---------- 文字指令（完全比對，前後空白忽略）---------- */
export const CMD = {
  START: ['平安回報', '獅仔平安回報'],
  CANCEL: ['取消'],
  RESTART: ['重新開始', '重來'],
  PAIR_CODE: ['配對家人', '配對碼', '取得配對碼'],
  MY_FAMILY: ['我的家人', '我的測試家人'],
  UNPAIR: ['解除配對', '取消配對']
};
export const PAIR_JOIN_RE = /^配對\s*(\d{6})$/;

/* ---------- 小工具 ---------- */
export function pb(action, sessionId, value) {
  /* postback data（上限 300 字元；這裡都很短）*/
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
function qrLocation(label) {
  return { type: 'action', action: { type: 'location', label } };
}
export function text(t, quickItems) {
  const m = { type: 'text', text: t };
  if (quickItems && quickItems.length) m.quickReply = { items: quickItems.slice(0, 13) };
  return m;
}

/* ---------- 時間（台灣時間）---------- */
const TZ = 'Asia/Taipei';
export function fmtFull(ms) {
  const d = new Date(ms);
  const parts = {};
  new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).forEach(p => { parts[p.type] = p.value; });
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
}

/* ---------- 位置文字 ---------- */
export function locLabel(loc) {
  if (!loc || loc.source === 'none') return '未提供';
  if (loc.source === 'demo') return `${loc.text}（示範位置）`;
  /* 使用者自己在 LINE 按「分享位置」送出的位置訊息 */
  const addr = loc.address ? `${loc.address}　` : '';
  return `${addr}${Number(loc.lat).toFixed(5)}, ${Number(loc.lng).toFixed(5)}（使用者分享的位置）`;
}
export function mapUrl(loc) {
  return `https://www.google.com/maps?q=${Number(loc.lat).toFixed(5)},${Number(loc.lng).toFixed(5)}`;
}
export function needsText(d) {
  return (d.needs || []).map(n => (n === '其他' && d.other ? `其他（${d.other}）` : n)).join('、');
}
export function peopleText(v) {
  const o = PEOPLE_OPTIONS.find(x => x.v === v);
  return o ? o.label : '—';
}

/* ---------- 摘要（確認頁、完成頁、家人通知共用同一套模板）---------- */
export function summaryLines(d, opts = {}) {
  const lines = [];
  lines.push(`目前狀況：${d.status === 'help' ? '需要協助' : '平安'}`);
  if (d.status === 'help') {
    lines.push(`需求：${needsText(d)}`);
    lines.push(`需要協助人數：${peopleText(d.people)}`);
  }
  lines.push(`位置：${locLabel(d.loc)}`);
  if (d.loc && d.loc.source === 'real') lines.push(`地圖：${mapUrl(d.loc)}`);
  if (opts.confirmedAt) lines.push(`回報時間：${fmtFull(opts.confirmedAt)}（台灣時間）`);
  return lines;
}
export function familyNotifyText(report, ownerName) {
  return [
    DEMO_TAG,
    `${ownerName || '你的家人'} 的獅仔平安回報`,
    ...summaryLines(report, { confirmedAt: report.confirmedAt }),
    DEMO_FOOT
  ].join('\n');
}

/* ---------- 每一題的訊息 ---------- */
export const M = {
  askStatus(sid) {
    return text('我是獅仔，來關心你。你現在平安嗎？\n（展示演練，不會通知宮廟或派遣救援）', [
      qrPostback('我平安', pb('status', sid, 'safe')),
      qrPostback('需要協助', pb('status', sid, 'help')),
      qrPostback('取消', pb('cancel', sid))
    ]);
  },
  askLocation(sid) {
    return text('方便提供目前位置嗎？也可以略過。\n「分享位置」會打開 LINE 的地圖，由你自己確認後才送出。', [
      qrLocation('分享位置'),
      qrPostback('使用示範位置', pb('loc', sid, 'demo')),
      qrPostback('略過', pb('loc', sid, 'skip')),
      qrPostback('取消', pb('cancel', sid))
    ]);
  },
  askNeeds(sid, d) {
    const sel = d.needs || [];
    const head = sel.length ? `目前選了：${needsText(d)}\n還要加嗎？選好了請按「選好了」。` : '你需要哪方面的協助？可以選多項，選完按「選好了」。';
    return text(head, [
      ...NEED_LIST.map(n => qrPostback((sel.includes(n) ? '✓ ' : '') + n, pb('need', sid, n), n)),
      qrPostback('選好了', pb('needs_done', sid)),
      qrPostback('取消', pb('cancel', sid))
    ]);
  },
  askOther(sid) {
    return text('「其他」是什麼協助？請用一句話輸入（最多 60 字）。', [
      qrPostback('不填了，回上一步', pb('other_back', sid)),
      qrPostback('取消', pb('cancel', sid))
    ]);
  },
  askPeople(sid) {
    return text('包含你，一共有幾位需要協助？', [
      ...PEOPLE_OPTIONS.map(o => qrPostback(o.label, pb('people', sid, o.v))),
      qrPostback('取消', pb('cancel', sid))
    ]);
  },
  askConfirm(sid, d) {
    return text(['我幫你整理好了，請看一下對不對：', '', ...summaryLines(d), '', '按「確認回報」才會記錄（展示用，不會通知宮廟）。'].join('\n'), [
      qrPostback('確認回報', pb('confirm', sid)),
      qrPostback('重新填寫', pb('redo', sid)),
      qrPostback('取消', pb('cancel', sid))
    ]);
  },
  done(sid, report) {
    return text(['示範回報已記錄。', '', ...summaryLines(report, { confirmedAt: report.confirmedAt }), '', '要通知已配對的測試家人嗎？（會由本官方帳號推播，訊息開頭標示「展示演練」）'].join('\n'), [
      qrPostback('通知測試家人', pb('notify', sid)),
      qrPostback('暫不通知', pb('notify_skip', sid))
    ]);
  },
  noFamily(sid) {
    return text('你還沒有配對的測試家人，所以這次沒有發送任何通知。\n\n要配對的話：輸入「配對家人」取得配對碼，請家人加入本官方帳號後傳送「配對 六位數」。', [
      qrPostback('配對家人', pb('pair_code', sid), '配對家人'),
      qrPostback('暫不通知', pb('notify_skip', sid))
    ]);
  },
  notifyPreview(sid, family, previewText, demoSelf) {
    const names = family.map(f => f.name || '（未取得名稱）').join('、');
    const head = demoSelf
      ? `你還沒有配對測試家人，示範模式會把家人收到的訊息推播到「你自己的聊天室」（收件人顯示為「${DEMO_FAMILY_NAME}」）。要通知真正的家人，請先輸入「配對家人」。`
      : `將由本官方帳號推播給 ${family.length} 位測試家人：${names}`;
    return text([head, '', '訊息內容：', previewText, '', '按「確認通知」才會真的送出。'].join('\n'), [
      qrPostback('確認通知', pb('notify_go', sid)),
      qrPostback('取消通知', pb('notify_cancel', sid))
    ]);
  },
  notifyResult(okList, failList, demoSelf) {
    const lines = [];
    if (okList.length) lines.push(demoSelf
      ? `已送出（示範模式）：家人會收到的訊息已推播到你自己的聊天室。要通知真正的家人，請先輸入「配對家人」。`
      : `已送出給 ${okList.length} 位：${okList.join('、')}（LINE API 回傳成功；系統無法得知是否已讀）`);
    if (failList.length) lines.push(`發送失敗 ${failList.length} 位：${failList.join('、')}（可稍後再試，或請家人確認已加入官方帳號且未封鎖）`);
    lines.push('', '本次演練結束。要再演練一次請輸入「平安回報」。');
    return text(lines.join('\n'));
  },
  notifySkipped() { return text('好，這次不通知。本次演練結束，要再演練一次請輸入「平安回報」。'); },
  notifyCancelled() { return text('已取消通知，沒有送出任何訊息。本次回報仍保留。要再演練一次請輸入「平安回報」。'); },
  cancelled() { return text('已取消這次回報，沒有記錄任何內容。要重新開始請輸入「平安回報」。'); },
  expired() {
    return text('這個按鈕已經過期了（可能是之前的對話）。要重新開始請按下面的按鈕。', [
      qrPostback('重新開始', pb('restart', ''), '平安回報')
    ]);
  },
  useButtons() { return '請用下方的按鈕選擇；想放棄可以輸入「取消」。'; },
  alreadyAnswered() { return '這一題已經回答過了，我們接著往下。'; },
  otherTooLong() { return text('太長了，請縮短到 60 字以內。'); },
  needsAtLeastOne() { return '請至少選一項需要的協助。'; },

  /* ---------- 配對 ---------- */
  pairCode(code, minutes) {
    return text([`你的配對碼：${code}（${minutes} 分鐘內有效，只能用一次）`, '', '請測試家人：', '1. 加入本官方帳號', `2. 傳送「配對 ${code}」`, '3. 按「接受」', '', '對方接受後你會收到通知。'].join('\n'));
  },
  pairInvalid() { return text('配對碼無效或已過期。請對方重新輸入「配對家人」取得新的配對碼。'); },
  pairSelf() { return text('這是你自己的配對碼，不能和自己配對。'); },
  pairAlready(ownerName) { return text(`你已經是 ${ownerName} 的測試家人了。`); },
  pairAsk(sid, ownerName, code) {
    return text(`要成為 ${ownerName} 的測試家人嗎？\n接受後，對方做平安回報演練並按「確認通知」時，你會收到開頭標示「展示演練」的訊息。`, [
      qrPostback('接受', pb('pair_accept', sid, code)),
      qrPostback('拒絕', pb('pair_decline', sid, code))
    ]);
  },
  pairDone(ownerName) { return text(`已完成綁定，你現在是 ${ownerName} 的測試家人。要解除請輸入「解除配對」。`); },
  pairDeclined() { return text('已拒絕，沒有綁定。'); },
  pairOwnerNotice(familyName) { return text(`${familyName} 已成為你的測試家人。做平安回報演練時可以選「通知測試家人」。`); },
  myFamily(family, owners) {
    const a = family.length ? `你的測試家人（${family.length} 位）：${family.map(f => f.name).join('、')}` : '你還沒有配對的測試家人。輸入「配對家人」可取得配對碼。';
    const b = owners.length ? `你是這些人的測試家人：${owners.map(o => o.name).join('、')}` : '';
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
