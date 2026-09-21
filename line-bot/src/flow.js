/* ============================================================
   福安 LINE・平安回報 Bot — 對話狀態機（純邏輯，不碰網路）
   ------------------------------------------------------------
   handleEvent(event) 收一個 LINE webhook 事件，決定要回什麼、要不要推播，
   全部透過注入的 store（儲存）與 line（LINE API 封裝）完成；測試時兩個都用 mock。

   流程（step）：
     status → location → [needs → (other_text) → people] → confirm → done → notify_confirm
     「我平安」跳過 needs / people。
   原則：
     ・確認回報前，內容只在 session:<userId>（草稿）；按「確認回報」才寫 report:<userId>
     ・同一個人只有一筆 report，確認就是覆蓋更新，不會越積越多
     ・每個按鈕帶 s=session id：對不上就是過期按鈕，回「已過期」＋重新開始
     ・webhookEventId 記錄過就跳過：LINE 重送不會重複記錄、重複通知
     ・推播只在使用者按「確認通知」後，且同一次回報同一個 notifyId 只推一次
   ============================================================ */
import { M, CMD, PAIR_JOIN_RE, NEED_LIST, PEOPLE_OPTIONS, DEMO_LOC, DEMO_FAMILY_NAME, DEMO_SELF_PREFIX, parsePb, text, familyNotifyText } from './messages.js';

const SESSION_TTL = 24 * 60 * 60 * 1000;
const PAIR_TTL = 10 * 60 * 1000;
const EVENT_TTL = 60 * 60 * 1000;
const OTHER_MAX = 60;

function defaultRand(len = 8) {
  const a = new Uint8Array(len); crypto.getRandomValues(a);
  return Array.from(a, b => (b % 36).toString(36)).join('');
}
function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function nextAfterLocation(d) { return d.status === 'help' ? 'needs' : 'confirm'; }

export function createBot({ store, line, now = () => Date.now(), rand = defaultRand, log = console }) {
  const S = {
    session: id => `session:${id}`, report: id => `report:${id}`, family: id => `family:${id}`, owners: id => `owners:${id}`,
    pair: code => `pair:${code}`, pairOwner: id => `pairOwner:${id}`, pairSession: id => `pairSession:${id}`, event: id => `event:${id}`
  };
  const short = id => String(id || '').slice(0, 6) + '…';   // log 只留 userId 前幾碼

  /* ---------- 回覆／推播（吞掉錯誤，不讓一個事件的失敗影響其他事件）---------- */
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
    const s = { id: rand(), step: 'status', status: null, loc: null, needs: [], other: '', people: null, createdAt: now() };
    await saveSession(uid, s);
    return s;
  }
  function promptFor(s, report) {
    switch (s.step) {
      case 'status': return M.askStatus(s.id);
      case 'location': return M.askLocation(s.id);
      case 'needs': return M.askNeeds(s.id, s);
      case 'other_text': return M.askOther(s.id);
      case 'people': return M.askPeople(s.id);
      case 'confirm': return M.askConfirm(s.id, s);
      case 'done': return report ? M.done(s.id, report) : M.expired();
      case 'notify_confirm': return report && s.preview ? M.notifyPreview(s.id, s.previewFamily || [], s.preview, s.demoSelf) : M.expired();
      default: return M.expired();
    }
  }
  /* 回覆「請用按鈕」＋把目前這題再問一次（亂輸入、按到別題的按鈕都走這裡）*/
  async function reprompt(uid, s, token, lead) {
    const report = s.step === 'done' || s.step === 'notify_confirm' ? await store.get(S.report(uid)) : null;
    const p = promptFor(s, report);
    if (lead) p.text = lead + '\n\n' + p.text;
    return reply(token, p);
  }

  /* ---------- 名稱（對方要是好友才拿得到；拿不到就用中性稱呼）---------- */
  async function nameOf(uid, fallback) {
    const p = await line.profile(uid);
    return (p && p.displayName) ? String(p.displayName).slice(0, 20) : fallback;
  }

  /* ============================================================
     入口：一個事件
     ============================================================ */
  async function handleEvent(ev) {
    if (!ev || !ev.source || !ev.source.userId) return { ignored: 'no userId' };
    /* 擋重送：LINE 可能對同一事件重送（deliveryContext.isRedelivery），先記再處理 */
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

  /* ---------- 文字 ---------- */
  async function onText(uid, token, t) {
    if (CMD.START.includes(t) || CMD.RESTART.includes(t)) { const s = await startSession(uid); await reply(token, M.askStatus(s.id)); return { started: s.id }; }
    if (CMD.CANCEL.includes(t)) { await clearSession(uid); await reply(token, M.cancelled()); return { cancelled: true }; }
    if (CMD.PAIR_CODE.includes(t)) return pairCode(uid, token);
    if (CMD.MY_FAMILY.includes(t)) return myFamily(uid, token);
    if (CMD.UNPAIR.includes(t)) return unpairMenu(uid, token);
    const m = PAIR_JOIN_RE.exec(t);
    if (m) return pairJoin(uid, token, m[1]);

    const s = await getSession(uid);
    if (!s) return { ignored: 'text outside session' };   // 沒在流程中：不回，交給官方帳號其他設定
    if (s.step === 'other_text') {
      if (t.length > OTHER_MAX) { await reply(token, M.otherTooLong()); return { rejected: 'too long' }; }
      s.other = t; if (!s.needs.includes('其他')) s.needs.push('其他');
      s.step = 'needs'; await saveSession(uid, s);
      await reply(token, M.askNeeds(s.id, s)); return { step: s.step };
    }
    await reprompt(uid, s, token, M.useButtons());
    return { reprompted: s.step };
  }

  /* ---------- 位置訊息（使用者在 LINE 按「分享位置」、自己確認送出的）---------- */
  async function onLocation(uid, token, msg) {
    const s = await getSession(uid);
    if (!s) return { ignored: 'location outside session' };
    if (s.step !== 'location') { await reprompt(uid, s, token, M.useButtons()); return { reprompted: s.step }; }
    s.loc = { source: 'real', lat: Number(msg.latitude), lng: Number(msg.longitude), address: String(msg.address || '').slice(0, 100), title: String(msg.title || '').slice(0, 60) };
    if (!isFinite(s.loc.lat) || !isFinite(s.loc.lng)) { await reprompt(uid, s, token, '這個位置讀不到座標，請再試一次。'); return { rejected: 'bad location' }; }
    s.step = nextAfterLocation(s); await saveSession(uid, s);
    await reply(token, promptFor(s)); return { step: s.step };
  }

  /* ---------- 按鈕 ---------- */
  const STEP_OF = { status: 'status', loc: 'location', need: 'needs', needs_done: 'needs', other_back: 'other_text', people: 'people',
    confirm: 'confirm', redo: 'confirm', notify: 'done', notify_skip: 'done', notify_go: 'notify_confirm', notify_cancel: 'notify_confirm' };

  async function onPostback(uid, token, { a, s: sid, v }) {
    if (a === 'restart') { const s = await startSession(uid); await reply(token, M.askStatus(s.id)); return { started: s.id }; }
    if (a === 'pair_code') return pairCode(uid, token);
    if (['pair_accept', 'pair_decline', 'unbind_family', 'unbind_owner', 'unbind_none'].includes(a)) return onPairPostback(uid, token, a, sid, v);

    const s = await getSession(uid);
    if (!s || s.id !== sid) { await reply(token, M.expired()); return { expired: true }; }
    if (a === 'cancel') { await clearSession(uid); await reply(token, M.cancelled()); return { cancelled: true }; }
    const want = STEP_OF[a];
    if (!want) { await reprompt(uid, s, token, M.useButtons()); return { reprompted: s.step }; }
    if (s.step !== want) { await reprompt(uid, s, token, M.alreadyAnswered()); return { reprompted: s.step }; }

    switch (a) {
      case 'status':
        if (v !== 'safe' && v !== 'help') return reprompt(uid, s, token, M.useButtons());
        s.status = v; if (v === 'safe') { s.needs = []; s.other = ''; s.people = null; }
        s.step = 'location'; break;
      case 'loc':
        if (v === 'demo') s.loc = { ...DEMO_LOC };
        else if (v === 'skip') s.loc = { source: 'none' };
        else return reprompt(uid, s, token, M.useButtons());
        s.step = nextAfterLocation(s); break;
      case 'need':
        if (!NEED_LIST.includes(v)) return reprompt(uid, s, token, M.useButtons());
        if (s.needs.includes(v)) { s.needs = s.needs.filter(x => x !== v); if (v === '其他') s.other = ''; }
        else { s.needs.push(v); if (v === '其他') s.step = 'other_text'; }
        break;
      case 'other_back':
        s.needs = s.needs.filter(x => x !== '其他'); s.other = ''; s.step = 'needs'; break;
      case 'needs_done':
        if (!s.needs.length) { await saveSession(uid, s); return reprompt(uid, s, token, M.needsAtLeastOne()); }
        if (s.needs.includes('其他') && !s.other) { s.step = 'other_text'; break; }
        s.step = 'people'; break;
      case 'people':
        if (!PEOPLE_OPTIONS.some(o => o.v === v)) return reprompt(uid, s, token, M.useButtons());
        s.people = v; s.step = 'confirm'; break;
      case 'redo': {
        const n = await startSession(uid); await reply(token, M.askStatus(n.id)); return { started: n.id };
      }
      case 'confirm': {
        /* 只有這裡會寫正式紀錄；同一人永遠只有一筆（覆蓋）。平安者不帶任何求助欄位。 */
        const report = {
          id: rand(), status: s.status, loc: s.loc || { source: 'none' },
          needs: s.status === 'help' ? s.needs.slice() : [], other: s.status === 'help' && s.needs.includes('其他') ? s.other : '',
          people: s.status === 'help' ? s.people : null, confirmedAt: now(), notifies: {}
        };
        await store.set(S.report(uid), report);
        s.step = 'done'; s.reportId = report.id; await saveSession(uid, s);
        await reply(token, M.done(s.id, report)); return { confirmed: report.id };
      }
      case 'notify': {
        const report = await store.get(S.report(uid));
        if (!report || report.id !== s.reportId) { await clearSession(uid); await reply(token, M.expired()); return { expired: true }; }
        let family = (await store.get(S.family(uid))) || [];
        const ownerName = s.ownerName || (s.ownerName = await nameOf(uid, '你的家人'));
        s.preview = familyNotifyText(report, ownerName);
        /* 還沒配對家人：示範模式——把「家人會收到的訊息」真的推播到回報者自己的聊天室，
           畫面上明講是示範、送到自己這裡；不假裝有別人收到 */
        s.demoSelf = !family.length;
        if (s.demoSelf) family = [{ userId: uid, name: DEMO_FAMILY_NAME }];
        s.previewFamily = family.map(f => ({ userId: f.userId, name: f.name }));
        s.notifyId = rand(); s.step = 'notify_confirm'; await saveSession(uid, s);
        await reply(token, M.notifyPreview(s.id, family, s.preview, s.demoSelf)); return { step: s.step };
      }
      case 'notify_skip':
        await clearSession(uid); await reply(token, M.notifySkipped()); return { finished: 'skipped' };
      case 'notify_cancel':
        await clearSession(uid); await reply(token, M.notifyCancelled()); return { finished: 'cancelled' };
      case 'notify_go':
        return notifyGo(uid, token, s);
    }
    await saveSession(uid, s);
    await reply(token, promptFor(s));
    return { step: s.step };
  }

  /* ---------- 真的推播給已綁定的測試家人 ---------- */
  async function notifyGo(uid, token, s) {
    const report = await store.get(S.report(uid));
    if (!report || report.id !== s.reportId || !s.notifyId) { await clearSession(uid); await reply(token, M.expired()); return { expired: true }; }
    /* 同一次通知只送一次：先在 report 上占位再送（LINE 重送或連點都會撞到占位）*/
    if (report.notifies[s.notifyId]) {
      const r = report.notifies[s.notifyId];
      await reply(token, M.notifyResult(r.ok || [], r.fail || []));
      return { alreadySent: true };
    }
    report.notifies[s.notifyId] = { startedAt: now(), ok: [], fail: [] };
    await store.set(S.report(uid), report);
    const family = s.previewFamily || [];
    const ok = [], fail = [];
    const body = s.demoSelf ? DEMO_SELF_PREFIX + '\n' + s.preview : s.preview;
    for (const f of family) {
      try { await line.push(f.userId, text(body)); ok.push(f.name || '家人'); }
      catch (e) { log.error('[push failed]', short(f.userId), e && e.message); fail.push(f.name || '家人'); }
    }
    report.notifies[s.notifyId] = { startedAt: report.notifies[s.notifyId].startedAt, doneAt: now(), ok, fail };
    await store.set(S.report(uid), report);
    await clearSession(uid);
    await reply(token, M.notifyResult(ok, fail, s.demoSelf));
    return { notified: ok.length, failed: fail.length, demoSelf: !!s.demoSelf };
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
