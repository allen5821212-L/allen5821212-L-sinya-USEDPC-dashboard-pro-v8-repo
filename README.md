# SINYA Used PC Dashboard – Optimizer V8.0

**V8.0 新功能**
- 原生 **.xlsx** 匯出（純前端、無外部 CDN）
- 逾期降價「多階梯」編輯器（門檻天數×調整％，可增刪排序）
- **最低毛利率底線**（不得低於成本 × (1+底線)）
- **不得低於市場價 X％** 保護（可允許略低，例如 -0.05 代表可低 5%）
- 批次調整支援「只套用目前篩選結果」與「依分類套用」

**延續功能**
- 單品毛利率即時連動，清單匯總（二手總價／毛利總額）自動更新  
- 市場價 ×（1+調整%）；若市場價空白→自動回退 Margin  
- 庫存天數＝「回收日 → 今天」  
- 四捨五入（1/10/50/100）＋進位/捨去/四捨五入、尾數 9/99  
- 搜尋、表頭點擊排序  
- LocalStorage 保存/讀取清單與設定、JSON 匯入/匯出  
- 匯出 CSV、Excel（.xls）

## 部署（GitHub Pages）
1. 新建公開 repo，將本專案所有檔案放在 **root**  
2. 可保留 `.github/workflows/pages.yml` 使用 **GitHub Actions** 自動部署；或刪除後改用 Branch 部署  
3. Settings → Pages 設定來源完成後即可上線

## .xlsx 實作說明
- 採用 OOXML（workbook/worksheet）並以簡易 **ZIP（STORED）** 實作打包，純前端產出，Mac/Win Excel 與 Google Sheets 皆可開啟  
- 若需多 Sheet、樣式、數字格式、寬度自動化等，可在後續版本擴充

## 授權
MIT（見 `LICENSE`）
