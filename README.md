# 📘 YouTube 頻道全自動雲端監控系統（公開＋會員）

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![YouTube Data API v3](https://img.shields.io/badge/YouTube-Data_API_v3-FF0000?logo=youtube&logoColor=white)
![Discord Webhook](https://img.shields.io/badge/Discord-Webhook-5865F2?logo=discord&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

**GCP × Cloudflare Workers × Discord 完整建置與復現手冊**

> 🌟 **最推薦的 VTuber，請務必記得訂閱她 (Favorite V-Tuber, please remember to subscribe to her)：[白星優米 (Umi)](https://youtube.com/@umitw46?si=YAS3N6vEymUu1UDW)**

---

## 目錄

- [第一章：系統架構、功能特色與免費配額精算](#第一章系統架構功能特色與免費配額精算)
  - [1.1 系統功能總覽](#11-系統功能總覽)
  - [1.2 四大雲端服務免費額度與每日消耗精算表](#12-四大雲端服務免費額度與每日消耗精算表)
- [第二章：前置準備 — 取得目標 YouTube 頻道 ID 與清單規則](#第二章前置準備--取得目標-youtube-頻道-id-與清單規則)
- [第三章：階段一 — Google Cloud (GCP) 專案與 API 金鑰申請](#第三章階段一--google-cloud-gcp-專案與-api-金鑰申請)
  - [3.1 申請步驟](#31-申請步驟)
  - [3.2 階段一獨立測試方式](#32-階段一獨立測試方式)
- [第四章：階段二 — Discord 伺服器 Webhook 建立與推播測試](#第四章階段二--discord-伺服器-webhook-建立與推播測試)
  - [4.1 設定步驟](#41-設定步驟)
  - [4.2 階段二獨立測試方式](#42-階段二獨立測試方式)
- [第五章：階段三 — Cloudflare Workers 與 KV 資料庫建置](#第五章階段三--cloudflare-workers-與-kv-資料庫建置)
  - [5.1 步驟 1：建立 Workers KV 狀態資料庫 (YT_STATE)](#51-步驟-1建立-workers-kv-狀態資料庫-yt_state)
  - [5.2 步驟 2：建立 Worker 執行容器](#52-步驟-2建立-worker-執行容器)
  - [5.3 步驟 3：綁定 KV 命名空間與環境變數（關鍵步驟）](#53-步驟-3綁定-kv-命名空間與環境變數關鍵步驟)
- [第六章：階段四 — 部署正式版監控程式碼](#第六章階段四--部署正式版監控程式碼)
- [第七章：階段五 — 全系統上線驗證與模擬測試流程](#第七章階段五--全系統上線驗證與模擬測試流程)
  - [7.1 測試一：執行首次初始化並檢查 KV 狀態機](#71-測試一執行首次初始化並檢查-kv-狀態機)
  - [7.2 測試二：使用一鍵模擬網址驗證三種通知排版](#72-測試二使用一鍵模擬網址驗證三種通知排版)
  - [7.3 測試三：模擬真實新片上架與每分鐘 Cron 自動觸發](#73-測試三模擬真實新片上架與每分鐘-cron-自動觸發)
- [第八章：系統內部狀態機解析與 AI 除錯指南（Troubleshooting）](#第八章系統內部狀態機解析與-ai-除錯指南troubleshooting)
  - [8.1 monitor_state JSON 結構說明](#81-monitor_state-json-結構說明)
  - [8.2 建置常見錯誤與排解速查表](#82-建置常見錯誤與排解速查表)
  - [8.3 AI 快速除錯提示詞範本](#83-ai-快速除錯提示詞範本)

---

## 第一章：系統架構、功能特色與免費配額精算

### 1.1 系統功能總覽

本系統採用 100% 全雲端無伺服器（Serverless）架構，無須準備個人電腦或長開主機，即可完全免費達成以下功能：

- **每分鐘高頻率巡檢**：透過 Cloudflare Workers 的定時觸發器（Cron Triggers，`* * * * *`），每 1 分鐘自動檢查一次目標 YouTube 頻道。
- **公開與會員限定雙棲監控**：同時監控頻道的「一般公開清單（`UU...`）」與「頻道會員專屬清單（`UUMO...`）」，無論是一般公開直播或會員限定直播皆能捕捉。
- **三階段智慧通知（關播不打擾）**：
  1. 🎬 **一般新影片 / Shorts 上架**：立即發送 `@everyone` 通知。
  2. ⏳ **建立直播待機室（`upcoming`）**：立即發送 `@everyone` 預告通知，並將該待機室加入每分鐘密切追蹤清單。
  3. 🔴 **直播正式開始（`upcoming` 轉 `live` 或突襲開台）**：當頻道主按下開始串流時，於 1 分鐘內發送 `@everyone` 開台通知。
  4. ⏹️ **直播結束（`live` 轉 `none`）**：系統自動將該直播從追蹤清單移除並歸檔，不發送關播通知以免洗版。
- **首次啟動防洗版機制**：首次部署時，系統會自動將頻道過去的舊影片寫入已讀資料庫，不會一次狂發舊片通知洗版；但若當下正好有「待機中」或「直播中」的項目，則會立即發送通知。

> ⚠️ **YouTube 隱私限制說明**：本系統可自動抓到「公開（Public）」與「會員限定（Members-only）」之影片與待機室；但若為「不公開（Unlisted）」影片，因 YouTube 官方不會將其列入任何 API 清單中，必須知道該影片的直接連結才能查詢。

### 1.2 四大雲端服務免費額度與每日消耗精算表

| 雲端環節 | 所需帳號與綁卡需求 | 官方免費額度上限 | 系統每日實際消耗量（每分鐘 1 次） | 額度佔比與安全評估 |
| :--- | :--- | :--- | :--- | :--- |
| **1. YouTube Data API v3** | Google Cloud (GCP)<br>免綁信用卡 | 每日 10,000 點 (Units)<br>*(台灣時間每日 15:00 或 16:00 重置)* | 約 2,880 ～ 4,320 點 / 日<br>*(每分鐘讀取 UU 公開清單扣 1 點 + UUMO 會員清單扣 1 點 + 有追蹤直播時查 `videos.list` 扣 1 點)* | **約 28.8% ～ 43.2%**<br>絕不使用高消耗的 `search.list`（每次 100 點），配額永遠充裕。 |
| **2. Discord Webhook** | Discord 帳號<br>完全免費 | 每分鐘上限 30 則請求<br>無每月總則數上限 | 約 0 ～ 10 則 / 日<br>*(僅在發新片、開待機室、正式開播瞬間發送)* | **低於 0.1%**<br>絕對不會觸發速率限制。 |
| **3. Cloudflare Workers** | Cloudflare 帳號<br>免費方案 (Free) 免綁卡 | 每日 100,000 次請求<br>*(台灣時間每日 08:00 重置)* | 固定 1,440 次請求 / 日<br>*(每分鐘 Cron 排程觸發 1 次)* | **僅佔 1.44%**<br>剩餘免費額度高達 98% 以上。 |
| **4. Cloudflare Workers KV** | Cloudflare 帳號<br>免費方案 (Free) 免綁卡 | 每日 100,000 次讀取<br>每日 1,000 次寫入 | 讀取：1,440 次 / 日<br>寫入：約 0 ～ 10 次 / 日 | **讀取 1.44% / 寫入 < 1%**<br>僅在狀態改變時才寫入 KV，完美避開 1,000 次寫入限制。 |

---

## 第二章：前置準備 — 取得目標 YouTube 頻道 ID 與清單規則

在開始設定雲端平台前，請先取得你要監控的 YouTube 頻道 ID。本手冊以 **白星優米（Umi，`@umitw46`）** 為預設範例，**【若你要監控其他頻道，請依以下步驟取得並替換為該頻道的 ID】**：

1. 在電腦瀏覽器打開 **【你要監控的目標 YouTube 頻道首頁】**（範例為白星優米：[https://www.youtube.com/@umitw46](https://www.youtube.com/@umitw46)）。
2. 點擊頻道名稱下方的「**…更多內容 (…more)**」展開頻道簡介。
3. 滑到視窗最底部，點擊「**分享頻道 (Share channel)**」➔「**複製頻道 ID (Copy channel ID)**」。
4. 你會獲得一串以 `UC` 開頭、總長 24 碼的字串（範例中白星優米的頻道 ID 為 `UCzGz6LnrLQ49h5Nio2uwQGw`；**【若監控其他頻道，請記下你複製到的 24 碼 UC ID】**）。

### 📌 頻道 ID 與播放清單自動轉換規則（系統內建自動轉換）

以白星優米的頻道 ID 為例，轉換規則如下（**【若監控其他頻道，同樣是將該頻道 ID 開頭的 `UC` 替換即可】**）：

- **原始頻道 ID (`UC...`)**：`UCzGz6LnrLQ49h5Nio2uwQGw`（共 24 碼）
- **一般公開影片清單 (`UU...`)**：將開頭 `UC` 改為 `UU` ➔ `UUzGz6LnrLQ49h5Nio2uwQGw`
- **頻道會員限定清單 (`UUMO...`)**：將開頭 `UC` 改為 `UUMO` ➔ `UUMOzGz6LnrLQ49h5Nio2uwQGw`

*(註：第六章提供的程式碼已內建自動轉換功能，無論你在環境變數填入 `UC...` 或 `UU...`，系統都會自動推導並同時監控 `UU` 與 `UUMO` 兩個清單。)*

---

## 第三章：階段一 — Google Cloud (GCP) 專案與 API 金鑰申請

### 3.1 申請步驟

1. 前往 [Google Cloud 控制台 (Google Cloud Console)](https://console.cloud.google.com/) 並使用 Google 帳號登入（無須啟用付費試用或綁定信用卡）。
2. 點擊畫面左上角的專案下拉選單 ➔ 點擊右上角「**新增專案 (New project)**」。
3. 在「**專案名稱 (Project name)**」輸入 **`yt-live-monitor`**（或 **【自訂你喜歡的專案名稱】**）➔ 點擊「**建立 (Create)**」。
4. 確認畫面左上角已切換至剛建立的專案後，點擊左側導覽選單「**API 和服務 (APIs & Services)**」➔「**程式庫 (Library)**」。
5. 在搜尋框輸入 `YouTube Data API v3`，點擊搜尋結果進入後，按下藍色的「**啟用 (Enable)**」按鈕。
6. 啟用完成後，點擊左側選單的「**憑證 (Credentials)**」➔ 點擊上方「**+ 建立憑證 (+ Create credentials)**」➔ 選擇「**API 金鑰 (API key)**」。
7. 複製畫面彈出的 `AIzaSy...` 開頭金鑰（即 **【你的 Google Cloud API 金鑰】**）並妥善保存（前後請勿複製到多餘空白格）。

### 3.2 階段一獨立測試方式

下方網址已預先填入白星優米的公開清單（`UUzGz6LnrLQ49h5Nio2uwQGw`），新手只需將網址最後方的 **`【請替換為你的API_Key】`** 改為剛取得的金鑰，貼入瀏覽器網址列按 Enter 即可直接測試（**【若想測試其他頻道，也可同時將 `playlistId=` 後方替換為該頻道的 UU 清單 ID】**）：

```text
[https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=UUzGz6LnrLQ49h5Nio2uwQGw&maxResults=1&key=](https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=UUzGz6LnrLQ49h5Nio2uwQGw&maxResults=1&key=)【請替換為你的API_Key】
```

- **驗證通過標準**：瀏覽器顯示包含 `"kind": "youtube#playlistItemListResponse"` 的 JSON 資料，並顯示頻道最新一部影片的標題與 `videoId`。

---

## 第四章：階段二 — Discord 伺服器 Webhook 建立與推播測試

### 4.1 設定步驟

1. 打開 Discord，進入 **【你擁有管理權限的 Discord 伺服器】**。
2. 在 **【你要接收通知的文字頻道】** 名稱旁，點擊「**編輯頻道（齒輪圖示 Edit Channel）**」。
3. 點選左側選單的「**整合 (Integrations)**」➔ 點選「**Webhook (Webhooks)**」➔ 點擊「**新 Webhook (New Webhook)**」。
4. 點開剛建立的 Webhook，自訂顯示名稱（範例為 **`優米開台通知`**，**【請自訂為你想要的通知機器人名稱】**）與頭像，點擊「**複製 Webhook 網址 (Copy Webhook URL)**」，最後點擊右下角「**儲存變更 (Save Changes)**」。

### 4.2 階段二獨立測試方式

打開電腦上的「**終端機 (Terminal)**」，將下方指令最後方的 **`【請替換為你的Discord_Webhook網址】`** 替換為剛複製的網址後貼上執行：

```bash
curl -H "Content-Type: application/json" \
     -d '{"content": "@everyone 優米開台通知 開始直播囉！快進來～\n📺 **影片名稱**：【測試訊息】系統連線測試\n🕒 **預計開始時間**：2026-10-18 20:00 (UTC+8)\n🔗 **直播連結**：[https://www.youtube.com/@umitw46](https://www.youtube.com/@umitw46)"}' \
     "【請替換為你的Discord_Webhook網址】"
```

- **驗證通過標準**：Discord 頻道立即收到帶有 `@everyone` 標記的測試通知。

---

## 第五章：階段三 — Cloudflare Workers 與 KV 資料庫建置

請前往 [Cloudflare 儀表板 (Cloudflare Dashboard)](https://dash.cloudflare.com/) 免費註冊並登入帳號（選擇免費 Free $0 方案即可）。

### 5.1 步驟 1：建立 Workers KV 狀態資料庫 (`YT_STATE`)

1. 在 Cloudflare 左側黑色導覽選單中，展開「**儲存空間和資料庫 (Storage & Databases)**」並點選「**Workers KV**」。
2. 點擊右上角「**建立命名空間 (Create a namespace)**」按鈕，將名稱設為 **`YT_STATE`** 並建立。
3. 建立完成後點進 `YT_STATE`，上方會顯示「**指標 (Metrics)**」、「**KV 組 (KV Pairs)**」、「**設定 (Settings)**」三個分頁，此時「KV 組」下方顯示「目前沒有任何項目。」屬於正常空白狀態。

### 5.2 步驟 2：建立 Worker 執行容器

1. 在左側導覽選單點選「**運算 (Compute)**」➔「**Workers & Pages**」。
2. 點擊右上角「**建立 (Create application)**」➔ 選擇「**建立 Worker (Create Worker)**」。
3. 將名稱輸入為 **【請自訂你的 Worker 名稱，範例：`umi-yt-monitor`】**（建議加上個人專屬字尾如 **`umi-yt-monitor-你的縮寫`** 以免與他人重複），點擊右下角「**部署 (Deploy)**」。

### 5.3 步驟 3：綁定 KV 命名空間與環境變數（關鍵步驟）

進入剛建立的 Worker（如 `umi-yt-monitor`）管理頁面，點選上方「**設定 (Settings)**」分頁（右側導覽列會顯示「變數與機密」、「個繫結」、「可觀察性」、「觸發事件」等項目）：

1. **綁定 KV 命名空間（個繫結 / Bindings）**：
   - 滑動至「**個繫結 (Bindings)**」區塊，點擊右上角的「**+ 新增繫結 (+ Add)**」按鈕。
   - 選擇「**KV 命名空間 (KV namespace)**」：
     - **名稱 (Variable name)**：嚴格輸入 **`YT_STATE`**（全大寫，請勿更改）。
     - **值 / KV 命名空間 (Value / KV namespace)**：下拉選擇剛剛建立的 **`YT_STATE`**。
   - 儲存後，「個繫結」列表中會顯示類型為 KV 命名空間、名稱為 `YT_STATE`、值為 `YT_STATE`。
2. **設定 API 金鑰與 Webhook（執行時變數與機密 / Variables and Secrets）**：
   - 在「**執行時變數與機密 (Variables and Secrets)**」區塊，點擊右上角的「**+ 新增變數 (+ Add)**」按鈕，依序新增以下變數：

| 類型 (Type) | 名稱 (Variable name) | 值 (Value) — **粗體處請填入你的個人設定** | 必填說明 |
| :--- | :--- | :--- | :--- |
| **機密 (Secret)** 或 純文字 (Text) | `YOUTUBE_API_KEY` | **【填入階段一取得的 `AIzaSy...` 金鑰】** | **必填** |
| **機密 (Secret)** 或 純文字 (Text) | `DISCORD_WEBHOOK_URL` | **【填入階段二取得的 Discord Webhook 網址】** | **必填** |
| **純文字 (Text)** | `UPLOAD_PLAYLIST_ID` | 範例為 `UUzGz6LnrLQ49h5Nio2uwQGw`<br>**【若要監控其他頻道，請填入該頻道的 `UC` 或 `UU` 開頭 24 碼 ID】** | **選填**（程式碼已預設白星優米 ID；若監控其他頻道則**必填**） |
| **純文字 (Text)** | `CHANNEL_NAME` | 範例為 `優米`<br>**【若要監控其他頻道，請填入你想在通知顯示的稱呼，如：`某某實況主`】** | **選填**（程式碼已預設為 `優米`；若監控其他頻道則建議填寫） |
| **機密 (Secret)** 或 純文字 (Text) | `ADMIN_TOKEN` | **【選填：自訂一組英文數字管理密碼，如：`MySecret123`】** | **選填**（未填時可直接點擊網址測試；若有設定，測試網址需加上 `&token=密碼`，可防止外人亂點洗版） |

3. **開啟可觀察性日誌（Observability）**：
   - 滑動至「**可觀察性 (Observability)**」區塊，確認「**Workers 日誌 (Workers Logs)**」右側開關為藍色啟用狀態，並勾選「包括叫用記錄」與「將記錄保留到 Workers 儀表板」。
4. **設定每分鐘定時排程（觸發事件 / Triggers）**：
   - 滑動至「**觸發事件 (Triggers)**」區塊，在 **Cron 觸發器 (Cron Triggers)** 點擊新增觸發器，設定為每 1 分鐘執行一次（Cron 表達式為 `* * * * *`）。
   - 設定完成後，在 Worker 概觀架構圖左側會顯示「觸發器 1」，中間顯示「Workers 日誌：已啟用」，右側顯示「繫結 1：YT_STATE -> YT_STATE」。

---

## 第六章：階段四 — 部署正式版監控程式碼

1. 在你的 Worker（如 `umi-yt-monitor`）管理頁面右上角，點擊「**編輯程式碼 (Edit code / `</>`)**」。
2. 將左側 `worker.js`（或 `index.js`）內的預設程式碼全部清空，複製貼上本儲存庫 [`src/worker.js`](./src/worker.js) 內的完整正式版程式碼，並點擊右上角「**部署 (Deploy)**」。

---

## 第七章：階段五 — 全系統上線驗證與模擬測試流程

部署完成後，請依序執行以下三項驗證，確認系統 100% 正常運作：

### 7.1 測試一：執行首次初始化並檢查 KV 狀態機

1. 在瀏覽器打開 **【你的 Worker 網址】**（例如 `https://umi-yt-monitor.` + **`【你的Cloudflare子網域】`** + `.workers.dev/`）。
   *(註：若你在第五章有額外設定 `ADMIN_TOKEN` 密碼，請在網址後方加上 **`?token=【你的密碼】`**)*
2. 畫面應顯示 `"status": "initialized"`（或 `"status": "ok"`），並列出目前的 `state` 結構。
3. 回到 Cloudflare 後台的「**儲存空間和資料庫 (Storage & Databases)**」➔「**Workers KV**」➔ 點進 `YT_STATE` ➔ 切換至「**KV 組 (KV Pairs)**」分頁，會看到系統已自動建立名為 `monitor_state` 的資料項目。

### 7.2 測試二：使用一鍵模擬網址驗證三種通知排版

直接在瀏覽器將下方網址中的 **`【你的worker網址】`** 替換後打開，確認 Discord 頻道能立即收到對應的通知（此測試不會修改 `monitor_state` 資料庫；若有設定 `ADMIN_TOKEN`，請在網址最後加上 **`&token=【你的密碼】`**）：

- **測試正式開播通知**：`https://` + **`【你的worker網址】`** + `.workers.dev/?test=live`
- **測試直播待機室通知**：`https://` + **`【你的worker網址】`** + `.workers.dev/?test=upcoming`
- **測試一般新影片通知**：`https://` + **`【你的worker網址】`** + `.workers.dev/?test=video`

### 7.3 測試三：模擬真實新片上架與每分鐘 Cron 自動觸發

1. 進入 `YT_STATE` ➔「**KV 組 (KV Pairs)**」，編輯 `monitor_state` 的值（Value）。
2. 將 `"notifiedVideos": ["影片ID_1", "影片ID_2", ...]` 中的第一個 **`"影片ID_1",`** 刪除並儲存。
3. **不要手動點任何網址**，等待最多 60 秒讓 Cron 自動執行。
4. **驗證標準**：Discord 會在 1 分鐘內自動跳出該部影片的通知，且回到 `monitor_state` 查看時，`影片ID_1` 已自動被補回清單中。

---

## 第八章：系統內部狀態機解析與 AI 除錯指南（Troubleshooting）

### 8.1 `monitor_state` JSON 結構說明

系統在 `YT_STATE` 中維護的 `monitor_state` 結構如下（以下以白星優米頻道為範例）：

```json
{
  "initialized": true,
  "memberInitialized": true,
  "notifiedVideos": [
    "2ompVmKJfTQ",
    "KDuHUQLwHPA"
  ],
  "activeStreams": {
    "JxkRpkA-sWk": {
      "status": "upcoming",
      "title": "這裡是記錄生活用的頻道｜加油優米",
      "scheduledStartTime": "2026-12-25T16:00:00Z",
      "isMembersOnly": false
    },
    "MemberStream_Example_ID": {
      "status": "upcoming",
      "title": "會員限定直播標題範例",
      "scheduledStartTime": "2026-10-20T12:00:00Z",
      "isMembersOnly": true
    }
  }
}
```

- **`notifiedVideos`**：存放已經發過通知的一般影片或已關播的直播 ID（最多保留最近 80 筆），避免重複通知。
- **`activeStreams`**：存放目前正在「待機中（`upcoming`）」或「直播中（`live`）」的影片 ID。每分鐘巡檢時會持續追蹤這些 ID，一旦狀態從 `upcoming` 變為 `live` 即發送開台通知；一旦變為 `none`（關播）則自動移入 `notifiedVideos`。

### 8.2 建置常見錯誤與排解速查表

| 錯誤訊息或現象 | 發生原因 | 解決方法 |
| :--- | :--- | :--- |
| `"YT_STATE_BOUND": false` 或變數為 `false` | Worker 尚未完成 KV 綁定或未設定環境變數 | 進入 Worker 的「設定 ➔ 個繫結 / 執行時變數與機密」補齊 `YT_STATE`、`YOUTUBE_API_KEY` 與 `DISCORD_WEBHOOK_URL`。 |
| `YouTube playlistItems API 錯誤 (400): Invalid Value` | 環境變數複製時混入空白字元，或 `UPLOAD_PLAYLIST_ID` 填成網址 | 第六章程式碼已內建自動去空白與 `UC` 轉 `UU` 防呆；若仍報錯，請檢查 `YOUTUBE_API_KEY` 是否複製完整（標準為 `AIzaSy` 開頭共 39 碼）。 |
| 編輯器點測試出現 `GET /__scheduled` 異常 | 在右側測試面板誤用 HTTP GET 呼叫內部排程路徑 | 直接在瀏覽器打開 **`https://【你的worker網址】.workers.dev/`** 即可觸發完整檢查與診斷回報。 |
| 某支已建立的待機室沒有通知 | 該待機室為「之前首次初始化前」就已存在，或剛手動修改過 KV | 打開 `YT_STATE` ➔ `monitor_state`，檢查該影片 ID 是否被誤放在 `notifiedVideos` 中；若是，將該 ID 從 `notifiedVideos` 刪除並儲存，下一分鐘即會補發通知並納入 `activeStreams`。 |

### 8.3 AI 快速除錯提示詞範本

若未來系統發生任何異常，請複製本手冊連同以下文字（請將粗體處替換為你的實際情況）貼給 AI：

> 「以上是我的 YouTube 雲端監控系統完整規格與程式碼。目前我遇到的問題是：**【請描述你遇到的問題】**。這是我在瀏覽器打開 Worker 網址看到的回應：**【請貼上瀏覽器顯示的 JSON】**，這是目前 KV `monitor_state` 的值：**【請貼上 Value】**。請幫我找出原因並提供修正方式。」

---

## 授權條款 (License)

本專案採用 [MIT 授權條款 (MIT License)](./LICENSE) 開源授權。
Favorite V-Tuber, please remember to subscribe to her: **Umi (白星優米)** https://youtube.com/@umitw46?si=YAS3N6vEymUu1UDW
