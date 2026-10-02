// ============================================================
//  Firebase 設定 —— 範本
//  ------------------------------------------------------------
//  這個檔案是「範本」，本身不會被用到。
//
//  【本機測試】把這個檔案複製成同目錄的 firebase-config.js，再填入你的設定。
//             firebase-config.js 已列入 .gitignore，不會被 commit。
//
//  【線上版本】由 .github/workflows/deploy.yml 在部署時，
//             從 GitHub repo secret「FIREBASE_CONFIG」自動產生。
//
//  設定值在 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式 → SDK 設定和配置。
//  務必確認有 databaseURL 這一行（Realtime Database 需要，主控台複製的那段有時不含它，
//  要去「建構 → Realtime Database」頁面上方另外複製）。
// ============================================================

export const firebaseConfig = {
  apiKey: "請填入",
  authDomain: "請填入.firebaseapp.com",
  databaseURL: "https://請填入-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "請填入",
  storageBucket: "請填入.appspot.com",
  messagingSenderId: "請填入",
  appId: "請填入"
};
