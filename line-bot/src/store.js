/* ============================================================
   儲存層：三個實作，介面一樣
     get(key) / set(key, value, { ttlMs }) / del(key)
   - MemoryStore：測試用、以及沒設定任何儲存時的退路（重啟就清空）
   - FileStore：本機跑 Node 時寫一個 JSON 檔（單機 Demo 夠用）
   - Deno KV：見 ../deno.ts（部署到 Deno Deploy 時用，會持久保存）
   key 的命名（全部以使用者 LINE userId 為主鍵，userId 不會出現在回覆文字裡）：
     session:<userId>   進行中的對話（草稿）；確認前的內容只在這裡
     report:<userId>    最近一次「確認回報」的正式紀錄（同一人只有一筆，覆蓋更新）
     family:<ownerId>   這個人綁定的測試家人 [{userId,name,boundAt}]
     owners:<familyId>  這個人是誰的測試家人 [{userId,name,boundAt}]
     pair:<code>        待接受的配對碼 {ownerId, ownerName, expiresAt}
     pairOwner:<ownerId> 這個人目前有效的配對碼（重新產生時把舊的作廢）
     event:<webhookEventId> 已處理過的 webhook 事件（TTL），擋重送
   ============================================================ */

export class MemoryStore {
  constructor() { this.m = new Map(); }
  async get(key) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp && e.exp <= Date.now()) { this.m.delete(key); return null; }
    return structuredClone(e.v);
  }
  async set(key, value, opts = {}) {
    this.m.set(key, { v: structuredClone(value), exp: opts.ttlMs ? Date.now() + opts.ttlMs : 0 });
  }
  async del(key) { this.m.delete(key); }
}

/* Node 本機用：整個 Map 序列化到一個 JSON 檔。寫入是覆蓋整檔，Demo 流量下沒問題。 */
export class FileStore extends MemoryStore {
  constructor(path, fs) {
    super();
    this.path = path; this.fs = fs;
    try {
      const raw = fs.readFileSync(path, 'utf8');
      const obj = JSON.parse(raw);
      for (const [k, e] of Object.entries(obj)) this.m.set(k, e);
    } catch (_) { /* 沒有檔案就從空的開始 */ }
  }
  flush() {
    const obj = {};
    for (const [k, e] of this.m) if (!e.exp || e.exp > Date.now()) obj[k] = e;
    try { this.fs.writeFileSync(this.path, JSON.stringify(obj)); } catch (e) { console.error('[store] write failed:', e.message); }
  }
  async set(key, value, opts) { await super.set(key, value, opts); this.flush(); }
  async del(key) { await super.del(key); this.flush(); }
}
