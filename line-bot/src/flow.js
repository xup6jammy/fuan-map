/* ============================================================
   福安 LINE・平安回報 Bot — 對話狀態機（純邏輯，不碰網路）
   ------------------------------------------------------------
   handleEvent(event) 收一個 LINE webhook 事件，決定要回什麼、要不要推播，
   全部透過注入的 store（儲存）與 line（LINE API 封裝）完成；測試時兩個都用 mock。

   流程（出事時要快，只問兩題）：
     status（我平安／需要協助）→ location（傳送目前位置／在家／不提供）→ confirm（送出並通知家人）
   家人：預設就有。已配對的家人帳號會收到推播；沒有配對時推播到回報者自己的聊天室（Demo 用）。
   原則：
     ・按「送出並通知家人」前，內容只在 session:<userId>；按下才寫 report:<userId>（同一人一筆，覆蓋）
     ・每個按鈕帶 s=session id：對不上就是過期按鈕
     ・webhookEventId 記錄過就跳過：LINE 重送不會重複記錄、重複通知
     ・同一次回報對同一位家人只推一次；失敗的可以按「再試一次」只補送失敗的
   ============================================================ */
import { M, CMD, PAIR_JOIN_RE, HOME_LOC, DEFAULT_FAMILY_NAME, parsePb, text, familyNotifyText } from './messages.js';

const SESSION_TTL = 24 * 60 * 60 * 1000;
const PAIR_TTL = 10 * 60 * 1000;
const EVENT_TTL = 60 * 60 * 1000;

function defaultRand(len = 8) {
  const a = new Uint8Array(len); crypto.getRandomValues(a);
  return Array.from(a, b => (b % 36).toString(36)).join('');
}
function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

export function createBot({ store, line, now = () => Date.now(), rand = defaultRand, log = console }) {
  const S = {
    session: id => `session:${id}`, report: id => `report:${id}`, family: id => `family:${id}`, owners: id => `owners:${id}`,
    pair: code => `pair:${code}`, pairOwner: id => `pairOwner:${id}`, pairSession: id => `pairSession:${id}`, event: id => `event:${id}`
  };
  const short = id => String(id || '').slice(0, 6) + '…';

  async function reply(token, messages) {
    if (!messages || !token) return false;
    try { await line.reply(token, messages); return true; }
    catch (e) { log.error('[reply failed]', e.message); return false; }
  }

  /* ---------- session ---------- */
  async function getSession(uid) { return store.get(S.session(uid)); }
  async function saveSession(uid, s) { s.updatedAt = now(); await store.set(S.session(uid), s, { ttlMs: SESSION_TTL }); }
  async function clearSession(uid) { await store.del(S.session(uid)); }
  async function startSession(uid) {
    const s = { id: rand(), step: 'status', status: null, loc: null, createdAt: now() };
    await saveSession(uid, s);
    return s;
  }
  function promptFor(s) {
    if (s.step === 'status') return M.askStatus(s.id);
    if (s.step === 'location') return M.askLocation(s.id);
    if (s.step === 'confirm') return M.askConfirm(s.id, s);
    return M.expired();
  }
  async function reprompt(uid, s, token, lead) {
    return reply(token, lead ? [lead, promptFor(s)] : promptFor(s));
  }
  async function nameOf(uid, fallback) {
    const p = await line.profile(uid);
    return (p && p.displayName) ? String(p.displayName).slice(0, 20) : fallback;
  }
  /* 家人名單：已配對的帳號；沒有就用回報者自己的聊天室當「家人」（預設已加好家人） */
  async function familyOf(uid) {
    const family = (await store.get(S.family(uid))) || [];
    return family.length ? family.map(f => ({ userId: f.userId, name: f.name || DEFAULT_FAMILY_NAME }))
                         : [{ userId: uid, name: DEFAULT_FAMILY_NAME }];
  }

  /* ============================================================ */
  async function handleEvent(ev) {
    if (!ev || !ev.source || !ev.source.userId) return { ignored: 'no userId' };
    if (ev.webhookEventId) {
      const k = S.event(ev.webhookEventId);
      if (await store.get(k)) { log.info('[dup event]', ev.webhookEventId); return { skipped: 'duplicate' }; }
      await store.set(k, 1, { ttlMs: EVENT_TTL });
    }
    const uid = ev.source.userId, token = ev.replyToken;
    try {
      if (ev.type === 'message' && ev.message && ev.message.type === 'text') return await onText(uid, token, normText(ev.message.text));
      if (ev.type === 'message' && ev.message && ev.message.type === 'location') return await onLocation(uid, token, ev.message);
      if (ev.type === 'postback' && ev.postback) return await onPostback(uid, token, parsePb(ev.postback.data));
      return { ignored: ev.type };
    } catch (e) {
      log.error('[event error]', short(uid), e && e.message);
      return { error: e && e.message };
    }
  }

  async function onText(uid, token, t) {
    if (CMD.START.includes(t) || CMD.RESTART.includes(t)) { const s = await startSession(uid); await reply(token, M.askStatus(s.id)); return { started: s.id }; }
    if (CMD.CANCEL.includes(t)) { await clearSession(uid); await reply(token, M.cancelled()); return { cancelled: true }; }
    if (CMD.PAIR_CODE.includes(t)) return pairCode(uid, token);
    if (CMD.MY_FAMILY.includes(t)) return myFamily(uid, token);
    if (CMD.UNPAIR.includes(t)) return unpairMenu(uid, token);
    const m = PAIR_JOIN_RE.exec(t);
    if (m) return pairJoin(uid, token, m[1]);
    const s = await getSession(uid);
    if (!s || s.step === 'done') return { ignored: 'text outside session' };
    await reprompt(uid, s, token, M.useButtons());
    return { reprompted: s.step };
  }

  /* 位置訊息：使用者在 LINE 位置畫面自己確認送出的 */
  async function onLocation(uid, token, msg) {
    const s = await getSession(uid);
    if (!s || s.step === 'done') return { ignored: 'location outside session' };
    if (s.step !== 'location') { await reprompt(uid, s, token, M.useButtons()); return { reprompted: s.step }; }
    const lat = Number(msg.latitude), lng = Number(msg.longitude);
    if (!isFinite(lat) || !isFinite(lng)) { await reprompt(uid, s, token, text('這個位置讀不到座標，請再試一次。')); return { rejected: 'bad location' }; }
    s.loc = { source: 'real', lat, lng, address: String(msg.address || '').slice(0, 100) };
    s.step = 'confirm'; await saveSession(uid, s);
    await reply(token, promptFor(s)); return { step: s.step };
  }

  const STEP_OF = { status: 'status', loc: 'location', confirm: 'confirm', redo: 'confirm' };

  async function onPostback(uid, token, { a, s: sid, v }) {
    if (a === 'restart') { const s = await startSession(uid); await reply(token, M.askStatus(s.id)); return { started: s.id }; }
    if (a === 'pair_code') return pairCode(uid, token);
    if (['pair_accept', 'pair_decline', 'unbind_family', 'unbind_owner', 'unbind_none'].includes(a)) return onPairPostback(uid, token, a, sid, v);

    const s = await getSession(uid);
    if (!s || s.id !== sid) { await reply(token, M.expired()); return { expired: true }; }
    const want = STEP_OF[a];
    /* 「再試一次」＝在 done 狀態再按 confirm：只補送失敗的 */
    if (a === 'confirm' && s.step === 'done') return sendToFamily(uid, token, s);
    if (!want || s.step !== want) { await reprompt(uid, s, token, s.step === 'done' ? null : M.useButtons()); return { reprompted: s.step }; }

    if (a === 'status') {
      if (v !== 'safe' && v !== 'help') return reprompt(uid, s, token, M.useButtons());
      s.status = v;
      if (v === 'safe') {
        /* 平安：不用再問，記一筆、回一句關懷就結束 */
        const report = { id: rand(), status: 'safe', loc: { source: 'none' }, confirmedAt: now(), sent: {} };
        await store.set(S.report(uid), report);
        await clearSession(uid);
        await reply(token, M.safeCare());
        return { safe: report.id };
      }
      s.step = 'location';
    } else if (a === 'loc') {
      if (v === 'home') s.loc = { ...HOME_LOC };
      else if (v === 'skip') s.loc = { source: 'none' };
      else return reprompt(uid, s, token, M.useButtons());
      s.step = 'confirm';
    } else if (a === 'redo') {
      const n = await startSession(uid); await reply(token, M.askStatus(n.id)); return { started: n.id };
    } else if (a === 'confirm') {
      const report = { id: rand(), status: s.status, loc: s.loc || { source: 'none' }, confirmedAt: now(), sent: {} };
      await store.set(S.report(uid), report);
      s.step = 'done'; s.reportId = report.id; s.ownerName = await nameOf(uid, '');
      s.family = await familyOf(uid);
      await saveSession(uid, s);
      return sendToFamily(uid, token, s);
    }
    await saveSession(uid, s);
    await reply(token, promptFor(s));
    return { step: s.step };
  }

  /* 推播給家人：每位家人每份回報只推一次（report.sent 記錄）；失敗的留著讓「再試一次」補送 */
  async function sendToFamily(uid, token, s) {
    const report = await store.get(S.report(uid));
    if (!report || report.id !== s.reportId) { await clearSession(uid); await reply(token, M.expired()); return { expired: true }; }
    const body = text(familyNotifyText(report, s.ownerName));
    const ok = [], fail = [];
    for (const f of s.family || []) {
      if (report.sent[f.userId]) { ok.push(f.name); continue; }
      try { await line.push(f.userId, body); report.sent[f.userId] = now(); ok.push(f.name); }
      catch (e) { log.error('[push failed]', short(f.userId), e && e.message); fail.push(f.name); }
      await store.set(S.report(uid), report);
    }
    if (fail.length) { await saveSession(uid, s); await reply(token, M.sendFailed(s.id, report, ok, fail)); return { notified: ok.length, failed: fail.length }; }
    await saveSession(uid, s);   // 留在 done：之後同一顆按鈕再按不會重送
    await reply(token, M.sent(report, ok));
    return { notified: ok.length, failed: 0 };
  }

  /* ============================================================
     測試家人配對
     ============================================================ */
  function genCode() { let c = ''; const a = new Uint8Array(6); crypto.getRandomValues(a); for (const b of a) c += String(b % 10); return c; }

  async function pairCode(uid, token) {
    const old = await store.get(S.pairOwner(uid));
    if (old) await store.del(S.pair(old));
    let code = genCode();
    for (let i = 0; i < 5 && await store.get(S.pair(code)); i++) code = genCode();
    const ownerName = await nameOf(uid, '對方');
    await store.set(S.pair(code), { ownerId: uid, ownerName, expiresAt: now() + PAIR_TTL }, { ttlMs: PAIR_TTL });
    await store.set(S.pairOwner(uid), code, { ttlMs: PAIR_TTL });
    await reply(token, M.pairCode(code, PAIR_TTL / 60000));
    return { pairCode: true };
  }
  async function pairJoin(uid, token, code) {
    const p = await store.get(S.pair(code));
    if (!p || p.expiresAt <= now()) { await reply(token, M.pairInvalid()); return { pairInvalid: true }; }
    if (p.ownerId === uid) { await reply(token, M.pairSelf()); return { pairSelf: true }; }
    const family = (await store.get(S.family(p.ownerId))) || [];
    if (family.some(f => f.userId === uid)) { await reply(token, M.pairAlready(p.ownerName)); return { pairAlready: true }; }
    const ps = { id: rand(), code };
    await store.set(S.pairSession(uid), ps, { ttlMs: PAIR_TTL });
    await reply(token, M.pairAsk(ps.id, p.ownerName, code));
    return { pairAsked: true };
  }
  async function onPairPostback(uid, token, a, sid, v) {
    const ps = await store.get(S.pairSession(uid));
    if (!ps || ps.id !== sid) { await reply(token, M.expired()); return { expired: true }; }
    if (a === 'pair_accept' || a === 'pair_decline') {
      if (ps.code !== v) { await reply(token, M.expired()); return { expired: true }; }
      await store.del(S.pairSession(uid));
      if (a === 'pair_decline') { await reply(token, M.pairDeclined()); return { pairDeclined: true }; }
      const p = await store.get(S.pair(v));
      if (!p || p.expiresAt <= now() || p.ownerId === uid) { await reply(token, M.pairInvalid()); return { pairInvalid: true }; }
      const familyName = await nameOf(uid, '家人');
      const family = ((await store.get(S.family(p.ownerId))) || []).filter(f => f.userId !== uid);
      family.push({ userId: uid, name: familyName, boundAt: now() });
      await store.set(S.family(p.ownerId), family);
      const owners = ((await store.get(S.owners(uid))) || []).filter(o => o.userId !== p.ownerId);
      owners.push({ userId: p.ownerId, name: p.ownerName, boundAt: now() });
      await store.set(S.owners(uid), owners);
      await store.del(S.pair(v)); await store.del(S.pairOwner(p.ownerId));
      await reply(token, M.pairDone(p.ownerName));
      try { await line.push(p.ownerId, M.pairOwnerNotice(familyName)); } catch (e) { log.error('[owner notice failed]', e && e.message); }
      return { paired: true };
    }
    if (a === 'unbind_none') { await store.del(S.pairSession(uid)); await reply(token, M.unbindNone()); return { unbindNone: true }; }
    if (a === 'unbind_family') {
      const family = (await store.get(S.family(uid))) || [];
      const f = family.find(x => x.userId === v);
      if (!f) { await reply(token, M.expired()); return { expired: true }; }
      await store.set(S.family(uid), family.filter(x => x.userId !== v));
      await store.set(S.owners(v), ((await store.get(S.owners(v))) || []).filter(o => o.userId !== uid));
      await store.del(S.pairSession(uid));
      await reply(token, M.unbound(f.name)); return { unbound: v };
    }
    if (a === 'unbind_owner') {
      const owners = (await store.get(S.owners(uid))) || [];
      const o = owners.find(x => x.userId === v);
      if (!o) { await reply(token, M.expired()); return { expired: true }; }
      await store.set(S.owners(uid), owners.filter(x => x.userId !== v));
      await store.set(S.family(v), ((await store.get(S.family(v))) || []).filter(f => f.userId !== uid));
      await store.del(S.pairSession(uid));
      await reply(token, M.unbound(o.name)); return { unbound: v };
    }
    await reply(token, M.expired()); return { expired: true };
  }
  async function myFamily(uid, token) {
    const family = (await store.get(S.family(uid))) || [];
    const owners = (await store.get(S.owners(uid))) || [];
    await reply(token, M.myFamily(family, owners)); return { listed: true };
  }
  async function unpairMenu(uid, token) {
    const family = (await store.get(S.family(uid))) || [];
    const owners = (await store.get(S.owners(uid))) || [];
    const ps = { id: rand() };
    await store.set(S.pairSession(uid), ps, { ttlMs: PAIR_TTL });
    await reply(token, M.unpairMenu(ps.id, family, owners)); return { unpairMenu: true };
  }

  return { handleEvent };
}
