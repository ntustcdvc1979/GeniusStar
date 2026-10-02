// ============================================================
//  共用工具：Firebase 初始化、資料路徑、登入、畫面小工具
//  計分與解析這些純邏輯放在 logic.js，這裡整包再匯出一次。
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, onValue, get, set, update, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signInAnonymously, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";
import { escapeHtml } from "./logic.js";

export * from "./logic.js";

export const app  = initializeApp(firebaseConfig);
export const db   = getDatabase(app);
export const auth = getAuth(app);

export {
  ref, onValue, get, set, update, remove, serverTimestamp,
  signOut, onAuthStateChanged
};

/**
 * 玩家用匿名登入。
 * 有了身分，安全性規則才能保證「只能寫自己的答案、送出後不能改」，
 * 重新整理後也讀得回自己這題選了什麼。
 *
 * ⚠ 這代表 Firebase 的「啟用建立帳戶」不能關掉（匿名登入也算建立帳戶）。
 *   權限邊界是 /admins 白名單 —— 匿名使用者拿不到任何主持人權限。
 */
export async function ensureAnonAuth() {
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

/** 用 Google 帳號登入。優先用彈出視窗；被擋掉時退回整頁轉址。 */
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    const fallback = [
      "auth/popup-blocked",
      "auth/cancelled-popup-request",
      "auth/operation-not-supported-in-this-environment"
    ];
    if (fallback.includes(e?.code)) { await signInWithRedirect(auth, provider); return; }
    throw e;
  }
}

/** 頁面載入時處理轉址回來的結果；沒有轉址就什麼也不做 */
export async function consumeRedirectResult() {
  try { await getRedirectResult(auth); } catch (e) { return e; }
  return null;
}

/** 登入成功、但不在主持人名單上時要顯示的說明（附 UID 方便複製） */
export function notHostHtml(user) {
  return `「${escapeHtml(user.email || user.uid)}」不在主持人名單裡。<br>
    請到 Firebase 主控台 → Realtime Database，在 <code>admins</code> 底下新增這組 UID（值填 <code>true</code>）：<br>
    <code style="user-select:all; display:inline-block; margin-top:6px; font-size:14px;">${escapeHtml(user.uid)}</code>`;
}

/** 把 Firebase 的錯誤碼翻成看得懂的中文 */
export function authErrorText(e) {
  const code = e?.code || "";
  const map = {
    "auth/popup-closed-by-user":   "登入視窗被關閉了，請再試一次。",
    "auth/popup-blocked":          "瀏覽器擋掉了登入視窗，請允許彈出視窗後再試。",
    "auth/unauthorized-domain":    "這個網域還沒被授權。請到 Firebase 主控台 → Authentication → 設定 → 授權網域，加入 " + location.hostname + "。",
    "auth/operation-not-allowed":  "Google 登入方式還沒啟用。請到 Firebase 主控台 → Authentication → 登入方式 啟用 Google。",
    "auth/admin-restricted-operation": "這個 Google 帳號還沒有帳號，而專案已關閉自行註冊。請先在 Firebase 主控台把它加為使用者。",
    "auth/network-request-failed":  "網路連線失敗，請確認網路後再試。"
  };
  return map[code] || ("登入失敗：" + (code || e?.message || "未知錯誤"));
}

// ---------- 資料庫路徑 ----------
//  跟 cdfreshmen（大學星攻略）共用同一個 Firebase 專案與資料庫，
//  所以這套系統的資料全部放在 /gs 底下，兩邊才不會互相蓋掉。
//  主持人白名單 /admins 則是兩套共用的 —— 能開大學星攻略控制台的人，這裡也能開。
//
//  /admins/{uid}                     = true                     ← 主持人白名單（共用）
//  /gs/config/intro                  = { rulesImg, heroImg, video }   ← 開場畫面（選填）
//  /gs/questions/{qid}               = { order, text, a,b,c,d, list, pts,
//                                        blocks:[…], exImgFull, exAudio } ← 公開可讀，不含正解
//  /gs/answerKey/{qid}               = "A"～"D"，或 "ALL"（都正確） ← 只有公布後才讀得到
//  /gs/state                         = { phase, list, qid, openedAt, limitSec,
//                                        revealed:{qid:true}, pendingDouble,
//                                        wheel:{id,uid}, cue:{id,kind}, nav:{id,dir}, screenPage }
//  /gs/players/{uid}                 = { name, at }             ← 進場的玩家
//  /gs/answers/{qid}/{uid}           = { c, t }                 ← 送出就定案，t 是伺服器時間
//  /gs/opened/{qid}                  = 伺服器時間                  ← 這題「第一次」出題的時間，作答秒數從這裡算
//  /gs/stats/{qid}                   = { A,B,C,D,total,key,openedAt,correct, fastest:[…] }
//  /gs/doubles/{qid}                 = uid                      ← 轉盤抽中、該題分數 ×2 的人
//  /gs/leaderboard                   = { updatedAt, final, total, rows:[…] }
export const ROOT = "gs";

export const PATH = {
  admins:      "admins",
  intro:       `${ROOT}/config/intro`,
  questions:   `${ROOT}/questions`,
  answerKey:   `${ROOT}/answerKey`,
  state:       `${ROOT}/state`,
  players:     `${ROOT}/players`,
  answers:     `${ROOT}/answers`,
  opened:      `${ROOT}/opened`,
  stats:       `${ROOT}/stats`,
  doubles:     `${ROOT}/doubles`,
  leaderboard: `${ROOT}/leaderboard`
};

/** 從 /stats 拼出每一題的出題時間，計分要用它算作答秒數 */
export function openedAtOf(stats) {
  const out = {};
  for (const [qid, s] of Object.entries(stats || {})) if (s?.openedAt) out[qid] = s.openedAt;
  return out;
}

/**
 * 這個帳號是不是主持人。
 * 光是「登入成功」不代表有權限 —— 必須在資料庫的 /admins/{uid} 被列名。
 */
export async function isHost(user) {
  if (!user || user.isAnonymous) return false;
  try {
    const snap = await get(ref(db, `${PATH.admins}/${user.uid}`));
    return snap.val() === true;
  } catch {
    return false;
  }
}

// ---------- 畫面小工具 ----------

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function show(el, visible = true) {
  if (el) el.classList.toggle("hidden", !visible);
}

let toastTimer;
export function toast(msg, ms = 2200) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  // 不能用 requestAnimationFrame 加 show —— 手機鎖螢幕或分頁在背景時 rAF 會暫停，
  // 等它補跑時收起來的計時器早就跑完了，提示就會永遠卡在畫面上
  void el.offsetWidth;          // 剛建立的元素先排版一次，淡入的 transition 才會跑
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

/** 玩家端網址（QR Code 用） */
export const playerUrl = new URL("index.html", location.href).href;

/** 載入 QR 產生器，回傳 data URL；載不到就丟錯 */
export async function qrDataUrl(text, cell = 8) {
  if (!window.qrcode) {
    await new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
      s.onload = ok; s.onerror = no;
      document.head.appendChild(s);
    });
  }
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cell, 4);
}
