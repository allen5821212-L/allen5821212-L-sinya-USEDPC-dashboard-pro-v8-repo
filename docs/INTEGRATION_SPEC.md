# 二手 PC 定價：併入二手平台後台的整合規格

> 對象：二手 PC 平台（sinyaweb：React + Vite + tRPC + Drizzle，資料庫 TiDB Cloud Serverless／MySQL 相容）的開發者
> 依據：本儲存庫 v9.0 的定價引擎與資料模型（`js/pricing.js`、`js/model.js`、`js/analytics.js`）
> 版本：2026-10-12 初稿

## 1. 為什麼要搬

GitHub Pages 版是純網頁，有三個靠前端無法解決的限制：

| 限制 | 影響 | 併入後台後 |
|---|---|---|
| 資料存在各自瀏覽器 | 三個人用就是三份清單、三套參數；清除瀏覽資料就不見 | 單一資料庫，所有門市看同一份 |
| 主管 PIN 只在前端 | 懂技術的人可繞過；無法知道「誰」做的 | 帳號登入＋角色權限，伺服器端檢查 |
| 修改紀錄存在本機 | 可被刪改，不能當稽核依據 | 只能新增、不能修改的稽核表 |

## 2. 定價引擎：直接沿用，不要重寫

- `js/pricing.js` 是純函式 ES Module（不碰 DOM、不讀寫儲存），可直接放進平台的共用目錄（例：`shared/pricing/pricing.js`），前端試算與後端計算共用同一份。
- **以後端計算為準**：標價、售出、報表都在伺服器端用 `computePrice(item, policy, today)` 計算；前端只做即時預覽。
- `today` 一律用台灣時區（Asia/Taipei）的日期，避免 UTC 跨日少算一天。
- 驗收：`tests/pricing.test.mjs`、`tests/model.test.mjs`、`tests/analytics.test.mjs` 的測試向量必須在平台上原封不動通過（同一份模組，同樣的數字）。

### 售價模型摘要

```
有參考市價：錨定價 = 參考市價 × 品況係數（成色 × 維修 × 電池 × 配件）× (1 + 門市加成)
沒有市價：  錨定價 = 成本 ÷ (1 − 目標毛利率)        ← 毛利率一律為「毛利 ÷ 售價」
→ 庫齡折扣（分類專用階梯優先，取符合的最大門檻）
→ 成本底線（基本：毛利率 ≥ 10%；≥90 天：成本；≥180 天：成本 × 80%）
   市價錨定且底線高於錨定價（收購成本偏高）→ 底線無法達成，依市價定價並標示
→ 取整（不破底線）→ 尾數往下取（不破底線）→ 市價錨定時不高於錨定價
```

## 3. 資料表（Drizzle／MySQL 相容）

金額一律整數（元，`INT`）；比例用 `DECIMAL(7,4)`；日期用 `DATE`；時間用 `DATETIME`（存 UTC，顯示轉台灣時區）。TiDB 支援 `JSON` 欄位。

### `used_items` 二手商品
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | BIGINT PK | |
| sku | VARCHAR(32) UNIQUE | 庫存編號，例 `U20261012-001` |
| serial | VARCHAR(64) INDEX | 機身序號，可空；重複需提示 |
| store_id | INT | 所在門市 |
| name, category | | category：NB／DT／MON／DIY／OTH |
| spec_cpu, spec_gpu, spec_ram, spec_ssd | VARCHAR | |
| grade | CHAR(1) NULL | A／B／C／D；NULL＝未評 |
| battery | TINYINT NULL | 0–100 |
| warranty_months | SMALLINT NULL | |
| accessories_complete, repair | BOOLEAN | |
| repair_note, note | TEXT | |
| purchase_date, recycle_date | DATE | 原購日、回收（入庫）日 |
| new_price, cost | INT | |
| target_margin | DECIMAL(7,4) NULL | 無市價時使用；NULL＝政策預設 |
| market_price | INT NULL | 參考市價（同型號 A 級二手行情） |
| market_date, market_source | | 查價日期、來源 |
| premium_override | DECIMAL(7,4) NULL | 單品加成；NULL＝門市加成 |
| status | ENUM('stock','sold') | |
| list_price, list_date | | 目前標價（冗餘，以 `price_tags` 最新一筆為準） |
| sold_date, sold_price | | |
| sale_snapshot | JSON | 售出當下的建議價、錨定價、標價、庫齡、定價依據、政策版本 |
| created_by, created_at, updated_at, deleted_at | | 軟刪除 |

### `price_tags` 標價紀錄（只新增）
`id, item_id, price, tagged_at, tagged_by, reason('首次標價'|'調整'|'手動'), policy_version, approval_id NULL`

### `pricing_policies` 定價政策（版本化）
`id, version, policy JSON, status('draft'|'active'|'archived'), effective_from, created_by, approved_by, approved_at, note`
- 同時只有一筆 `active`；變更流程：建立草稿 → 影響預覽 → 核准 → 生效。
- `policy` JSON 結構同 `js/model.js` 的 `defaultPolicy()`。

### `approvals` 核准
`id, type('below_cost_tag'|'below_cost_sale'|'delete_item'|'policy_change'|'bulk_import'|'replace_import'), item_id NULL, payload JSON, requested_by, requested_at, status('pending'|'approved'|'rejected'), decided_by, decided_at, comment`

### `audit_log` 稽核（只新增、不可修改）
`id, at, actor_id, action, entity, entity_id, before JSON, after JSON, ip`

### `market_quotes` 市價查價歷史（第二階段）
`id, model_key, price, source, quoted_at, quoted_by`：同型號多筆查價取近期中位數，取代手打單一數字。

## 4. 角色與權限

| 動作 | 店員 | 店長 | 定價主管 | 總經理 |
|---|:-:|:-:|:-:|:-:|
| 新增、編輯商品、查價、回收估價 | ✓ | ✓ | ✓ | ✓ |
| 標價／售出（不低於成本） | ✓ | ✓ | ✓ | ✓ |
| 標價／售出（低於成本） | 送審 | 核准（額度內） | 核准 | 核准 |
| 刪除商品 | — | ✓ | ✓ | ✓ |
| 匯入（依編號更新） | — | ✓ | ✓ | ✓ |
| 取代整份資料 | — | — | ✓ | ✓ |
| 定價政策：草稿與預覽 | — | 檢視 | ✓ | ✓ |
| 定價政策：核准生效 | — | — | — | ✓ |
| 檢視稽核紀錄 | — | 本門市 | ✓ | ✓ |

所有權限在**伺服器端**檢查（tRPC middleware），前端只控制顯示。

## 5. tRPC 程序

| 程序 | 說明 |
|---|---|
| `usedItems.list({ status, category, keyword, minDays, view, storeId, sort, page })` | 回傳列與即時計算結果（price、mode、warnings、retag） |
| `usedItems.get(id)` / `create` / `update` / `remove` | `update` 寫入 audit（影響售價的欄位要記 before/after） |
| `usedItems.tag({ id })` | 依目前政策計算並寫入 `price_tags`；低於成本時建立 `approvals` 並回傳 pending |
| `usedItems.tagBatch({ filter })` | 批次重新標價 |
| `usedItems.sell({ id, soldDate, soldPrice })` / `unsell` | 寫 `sale_snapshot`；低於成本需核准 |
| `pricing.preview({ item })` | 新增表單即時試算 |
| `pricing.estimate({ ... })` | 回收估價（`estimateBuyback`） |
| `pricing.policy.active()` / `draft.save` / `draft.preview` / `approve` | `preview` 回傳差異與影響（改變件數、合計、低於成本件數） |
| `approvals.list` / `decide({ id, approve, comment })` | |
| `reports.overview({ from, to, storeId })` | 對應 `js/analytics.js` 的各函式 |
| `reports.calibration()` | 階梯與殘值校正 |
| `io.importExcel(file, mode)` / `io.exportExcel(filter)` / `io.tagList(filter)` | 解析規則沿用 `js/io.js` |
| `audit.list({ entity, actor, from, to })` | |

## 6. 排程

- **每日 00:10（台灣時間）**：重算在庫商品建議價，產生「需重新標價」清單（建議價與最新標價差距 ≥ `retagThreshold` 或未標價），推播給各門市店長。
- **每週**：市價超過 `marketStaleDays` 未更新的商品清單。
- 新品價可由既有的競價監控爬蟲提供（回收估價的「新品價 × 殘值係數」）。

## 7. 資料移轉

1. 在 GitHub Pages 版「資料管理」→「下載完整備份（JSON）」。
2. 匯入腳本對應欄位：`items[]` → `used_items`（`sku` 保留；`margin` 已是財會毛利率）、`priceHistory[]` → `price_tags`、`policy` → `pricing_policies`（version 1, active）、`audit[]` → `audit_log`（actor 標為 legacy）。
3. 對帳：匯入前後在庫件數、在庫成本、建議售價合計三個數字必須一致。

## 8. 驗收清單

- [ ] 測試向量（`tests/*.test.mjs`）在平台上全數通過
- [ ] 同一筆商品，平台與 GitHub Pages 版建議價相同（抽 20 筆比對）
- [ ] 店員低於成本標價 → 產生待核准，店長核准後才寫入標價
- [ ] 政策變更：草稿 → 預覽影響 → 總經理核准 → 生效；稽核表有完整 before/after
- [ ] 重複匯入同一份 Excel 不會產生重複資料
- [ ] 手機寬度可完成新增、查價、標價、售出

## 9. 分階段

| 階段 | 內容 |
|---|---|
| 一 | 資料表、定價引擎共用、商品 CRUD、標價／售出、角色權限、稽核 |
| 二 | 核准流程介面、經營總覽、校正建議、每日重新標價排程 |
| 三 | POS／ERP 串接（售出自動回寫）、市價查價歷史與中位數、多門市調撥 |

## 10. 待決議

1. 角色對應的實際職稱與人員；店長核准低於成本的額度上限。
2. 多門市庫存是否分開計算庫齡（調撥後是否重算）。
3. 售出資料來源：POS 自動回寫，或維持人工按「售出」。
4. 標價是否要列印標籤（格式、印表機）。
