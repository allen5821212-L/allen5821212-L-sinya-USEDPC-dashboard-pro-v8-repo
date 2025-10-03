# SINYA USEDPC Dashboard — v8.1 (Fixed)

上傳到 GitHub Pages 後即可使用（單一靜態頁）。

## 這版修了什麼？
- **計算順序固定**：毛利 → 階梯降價 → 最低毛利率底線 → 市價下限％ → 四捨五入 → 尾數優化（不打破約束）。
- **診斷模式**：切換開關後，每列會顯示中間值方便追錯。
- **批次套用僅作用於目前篩選結果**（已明確）。
- **維修紀錄連動**：打勾顯示備註欄位；表格可即時編輯並存回。
- **匯入/匯出**：JSON/CSV 原生可用；XLSX 需在上線環境使用（已掛 CDN）。
- **LocalStorage 情境儲存**：可一鍵儲存/載入。

## 檔案結構
```
index.html
style.css
script.js
README.md
CHANGELOG.md
VERSION
```

## 部署
1. 建立新的 GitHub Repo（建議 public）。
2. 上傳上述所有檔案（或直接上傳 zip 解壓後的內容）。
3. 到 **Settings → Pages**，Source 選擇 `Deploy from a branch`，分支選 `main`，資料夾選 `/root`。
4. 儲存後等幾十秒，左上角會出現 Pages 網址，打開即用。

## 自測資料
預設內含 3 筆測資（測 A/B/C）對應你提出的檢核案例。  
也可在「匯出/匯出」區段匯出 JSON，再修改後匯入。

## 注意
- XLSX 需在上線後才會載入 CDN。若你在本地開啟 `index.html`，XLSX 匯出/匯入按鈕會提示「尚未載入」。  
- 若需完全離線的 XLSX，請將 `xlsx.full.min.js` 下載到本專案並以相對路徑引用。

