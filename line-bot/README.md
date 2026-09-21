# 福安 LINE・平安回報 Bot（LINE 原生聊天室固定問答）

官方帳號聊天室裡的「平安回報」：使用者傳「平安回報」，Bot 用 Quick Reply 一題一題問，
全部是寫死的問題、選項與摘要模板，**不呼叫任何 AI 模型**。
這個資料夾是獨立的後端（LINE Messaging API webhook），**不會部署到 GitHub Pages**；
GitHub Pages 只放靜態網頁（地圖、`safety-demo.html` 保留不變）。

## 流程

```
「平安回報」
 → 狀況：我平安／需要協助
 → 位置：分享位置（LINE location action，使用者自己確認才送出）／使用示範位置（明確標示）／略過
 → （需要協助才問）需求：飲水／食物／行動協助／其他（其他要輸入一句話）→ 選好了
 → （需要協助才問）人數：1 人／2 人／3 人以上
 → 摘要：確認回報／重新填寫
 → 示範回報已記錄 → 通知測試家人／暫不通知
 → 通知前先看預覽 → 確認通知（才由官方帳號推播給已配對的測試家人）／取消通知
```

隨時可輸入「取消」「重新開始」。亂輸入會回「請用下方的按鈕」並重問同一題；
不在流程中的文字 Bot 不回（交給官方帳號其他設定）。
每顆按鈕帶對話代號：舊對話的按鈕按下去會回「已過期」＋「重新開始」；按到已答過的題目會直接重問目前這題。
LINE 重送同一事件（`webhookEventId`）會被跳過，不會重複記錄或重複通知。

## 資料與隱私

- 以 LINE `userId` 分辨每個人；`userId` 不會出現在任何回覆文字裡。
- 按「確認回報」之前，內容只在草稿 `session:<userId>`；確認後才寫 `report:<userId>`，同一人只有一筆（覆蓋）。
- 通知只在按「確認通知」之後推播；同一次回報的同一個通知代號只會推一次。回覆只說「LINE API 回傳成功／失敗」，不說已讀。
- 推播訊息開頭固定「【展示演練，非真實求助】」，結尾「這是功能展示訊息，並非真實求助或救援派遣。」

## 測試家人配對

1. 回報者傳「配對家人」→ 得到 6 位數配對碼（10 分鐘有效、一次性）。
2. 家人加入官方帳號後傳「配對 123456」→ Bot 問「要成為 ○○ 的測試家人嗎？」→ 按「接受」才綁定；回報者會收到一則綁定通知。
3. 「我的家人」看自己的綁定；「解除配對」可解除（兩邊都能解）。只看得到與自己有關的配對，不能查別人。
4. 未綁定的人按「通知測試家人」會被告知「沒有發送任何通知」，不會假裝已通知。

## 檔案

```
line-bot/
  src/messages.js   固定文案、Quick Reply、摘要與通知模板
  src/flow.js       狀態機（純邏輯；store 與 line 都是注入的）
  src/line.js       LINE API 最小封裝（reply/push/profile）＋ webhook 簽章驗證
  src/webhook.js    驗簽章 → 逐一處理事件（平台無關）
  src/store.js      儲存介面：MemoryStore（測試）、FileStore（Node 本機 JSON 檔）
  server-node.js    Node 18+ 零相依伺服器（POST /webhook、GET /health）
  deno.ts           Deno Deploy 入口（Deno KV 持久儲存）
  test/flow.test.js node --test；LINE API 全部 mock，不會發任何真實訊息
```

## 本機測試

```bash
cd line-bot
npm test                      # 13 個情境，全部 mock
LINE_CHANNEL_SECRET=... LINE_CHANNEL_ACCESS_TOKEN=... node server-node.js   # 本機起 webhook（要配 ngrok 之類才能給 LINE）
```

## 部署（第二階段，需要帳號的人操作）

Channel secret、access token **只放部署平台的環境變數**，不寫進程式、GitHub 或 log。

建議 **Deno Deploy**（免費、連結 GitHub 就能部署、內建 Deno KV 持久儲存、不會像免費 Node 主機那樣睡著）：

1. 到 https://dash.deno.com 用 GitHub 登入 → New Project → 選 repo `xup6jammy/fuan-map`。
2. Entrypoint 選 `line-bot/deno.ts`（Production branch：`main`）。
3. Settings → Environment Variables 加 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`。
4. 部署完成後 Webhook URL 為 `https://<專案名>.deno.dev/webhook`；`https://<專案名>.deno.dev/health` 應回 `ok`。

替代：任何能跑 Node 18 的主機用 `node line-bot/server-node.js`（狀態存 `line-bot/data/store.json`，主機重建就會消失，Demo 可接受）。

## LINE 後台（第二階段）

1. 官方帳號「福安宮廟社區網」的 Messaging API channel：目前 Provider「福安宮廟社區網」底下只有 LINE Login channel「福安地圖」，
   Messaging API 要到 **LINE Official Account Manager → 設定 → Messaging API → 啟用**（選同一個 Provider），
   之後在 LINE Developers 才會看到 Messaging API channel，取得 Channel secret 與長期 Channel access token。
   **不要**把 LINE Login channel「福安地圖」當成 Messaging API channel。
2. Messaging API 分頁：Webhook URL 填上面的網址 → Verify → Use webhook 開啟。
3. 官方帳號的「回應設定」：Webhook 開啟；「自動回應訊息」若有對「平安回報」等關鍵字的回覆要關掉或改掉，否則每次點都會多一則。
4. 圖文選單「平安回報」那格改成「文字」動作，內容 `平安回報`；其他三格不動。

以上完成前，Bot 不會收到任何訊息，也不會發任何訊息。
