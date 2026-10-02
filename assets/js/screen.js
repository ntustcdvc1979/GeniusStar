// ============================================================
//  投影幕 —— 主持人切到瀏覽器全螢幕給觀眾看
//  需要主持人身分（全場作答只有 /admins 名單讀得到）。
//  在同一個瀏覽器開過 host.html 登入後，這頁會自動沿用登入狀態。
//
//  鍵盤：→ / ← 翻頁，空白鍵在最終畫面依序公布名次，Esc 關掉轉盤。
// ============================================================

import {
  db, auth, ref, onValue, update, onAuthStateChanged,
  PATH, PHASE, LISTS, LETTERS, DEFAULT_LIMIT_SEC,
  questionsOf, tally, ALL_CORRECT, isKeyLetter, keyLabel, correctCount, secondsLeft, isHost, ptsOf, fmtSec, fastestCorrect, openedAtOf,
  blocksOf, groupBlocks, isSoloMedia, videoEmbed, isVideoUrl, isAudioUrl, webpSrc, TEXT_SIZE_VH, IMG_SIZE_VH,
  buildScoreboard, ranksOf,
  wheelPool, wheelSlots, $, show, escapeHtml, playerUrl, qrDataUrl
} from "./common.js";

import * as snd from "./sounds.js";

let players = {}, questions = {}, keys = {}, answers = {}, stats = {}, state = {},
    board = null, intro = {}, doubles = {};
let ready = false, timeOffset = 0;

const stage = $("#stage");
const body  = $("#s-body");
const badge = $("#s-badge");
const foot  = $("#s-phase");
const tip   = $("#s-tip");

// 每 N 題插一頁戰況（最後一題不插，因為接著就是排行榜）
const STANDINGS_EVERY = 5;
const STANDINGS_TOP   = 10;
const PODIUM_TOP      = 3;
// 名次揭曉完回到主視覺收尾
const FINAL_COVER     = PODIUM_TOP + 1;

let introPage  = 0;   // 開場：黑畫面 →（開場影片）→ 主視覺 → 規則 → 掃碼進場
let revealPage = 0;   // 公布：答案與說明 →（補充說明）→（目前戰況）→ 全場分布
let podiumStep = 0;   // 排行榜：0 還沒開始 → 3 全部揭曉 → 4 主視覺

// ------------------------------------------------------------
//  音效解鎖
// ------------------------------------------------------------
let soundOn = false;

show($("#sound-gate"), true);
$("#btn-sound").addEventListener("click", async () => {
  await snd.unlock();
  soundOn = true;
  show($("#sound-gate"), false);
  // 解鎖的當下畫面上可能已經有東西在靜音播了，一併打開聲音
  unmuteVideo("#s-themevid");
  unmuteVideo("#s-fullvid");
  unmuteVideo("#s-fullaud");
});
$("#btn-nosound").addEventListener("click", e => {
  e.preventDefault();
  show($("#sound-gate"), false);
});

/** 影片一律先靜音自動播（不然會被瀏覽器擋掉），解鎖後才打開聲音 */
function unmuteVideo(sel) {
  const v = $(sel);
  if (!v) return;
  v.muted = false;
  v.volume = 1;
  v.play?.().catch(() => {});
}

// ------------------------------------------------------------
//  登入與資料
// ------------------------------------------------------------
onAuthStateChanged(auth, async user => {
  const ok = await isHost(user);
  if (!ok) {
    body.innerHTML = `<div class="card center stack" style="max-width:60vw; margin:0 auto;">
      <h2 class="title-gold" style="font-size:4.4vh; margin:0;">尚未登入</h2>
      <p class="hint" style="font-size:2.4vh;">請先在同一個瀏覽器開啟
        <a href="host.html" style="color:var(--gold-lt)">主持人控制台</a> 登入，再回到這一頁。</p>
    </div>`;
    return;
  }
  if (ready) return;
  ready = true;
  onValue(ref(db, "/.info/serverTimeOffset"), s => { timeOffset = s.val() || 0; });
  onValue(ref(db, PATH.intro),       s => { intro     = s.val() || {}; paint(); });
  onValue(ref(db, PATH.questions),   s => { questions = s.val() || {}; queuePreload(); paint(); });
  onValue(ref(db, PATH.answerKey),   s => { keys      = s.val() || {}; paint(); });
  onValue(ref(db, PATH.stats),       s => { stats     = s.val() || {}; paint(); });
  onValue(ref(db, PATH.leaderboard), s => { board     = s.val();       paint(); });
  onValue(ref(db, PATH.doubles),     s => { doubles   = s.val() || {}; paint(); });
  onValue(ref(db, PATH.players),     s => { players   = s.val() || {}; onPlayers(); paint(); });
  onValue(ref(db, PATH.answers),     s => { answers   = s.val() || {}; onAnswers(); paint(); });
  onValue(ref(db, PATH.state),       s => { state = s.val() || {}; onStateChange(); onWheel(); onCue(); onNav(); syncPageReport(); paint(); });
});

// ------------------------------------------------------------
//  階段變化 → 音效與頁碼重置
// ------------------------------------------------------------
let lastPhase = null, lastQid = null;

function onStateChange() {
  const phase = state.phase || PHASE.IDLE;
  const qid   = state.qid || null;
  if (phase === lastPhase && qid === lastQid) return;

  // 出題就把轉盤收掉 —— 在那之前它會一直留在畫面上
  if (phase === PHASE.OPEN || qid !== lastQid) closeWheel();

  if (phase !== PHASE.REVEAL) snd.stopRevealBgm();
  if (phase !== PHASE.FINAL)  snd.stopFinalBgm();

  if (phase === PHASE.OPEN) {
    snd.stopBgm();
    if (!wheelAudioBusy()) snd.startBgm();
    startTicker();
  } else {
    snd.stopBgm();
    stopTicker();
    stage.classList.remove("tense", "shake");
    if (phase === PHASE.LOCKED && lastPhase === PHASE.OPEN) snd.timeUp();
    if (phase === PHASE.REVEAL) { snd.fanfare(); if (!wheelAudioBusy()) snd.startRevealBgm(); }
    if (phase === PHASE.FINAL) {
      if (lastPhase !== PHASE.FINAL) podiumStep = 0;
      if (!wheelAudioBusy()) snd.startFinalBgm();
    }
  }

  if (qid !== lastQid) {
    seenAns = new Set(Object.keys(answers[qid] || {}));
    revealPage = 0;
  }
  if (phase === PHASE.REVEAL && lastPhase !== PHASE.REVEAL) revealPage = 0;

  lastPhase = phase;
  lastQid = qid;
}

// ------------------------------------------------------------
//  有人進場／有人送出 → 提示音（一百個人同時按也不會吵成一團）
// ------------------------------------------------------------
const SFX_GAP_MS = 140;
let lastSfx = 0;
function throttledSfx(fn) {
  const now = performance.now();
  if (now - lastSfx < SFX_GAP_MS) return;
  lastSfx = now;
  fn();
}

let knownPlayers = null;
let freshJoin = new Set();     // 剛進場的人，暱稱泡泡要跳一下
function onPlayers() {
  const now = new Set(Object.keys(players));
  if (knownPlayers === null) { knownPlayers = now; return; }   // 第一次同步不叫
  const fresh = [...now].filter(u => !knownPlayers.has(u));
  knownPlayers = now;
  freshJoin = new Set(fresh);
  if (fresh.length) throttledSfx(snd.joined);
}

let seenAns = new Set();
let freshAns = new Set();
function onAnswers() {
  const qid = state.qid;
  if (!qid) return;
  const now = Object.keys(answers[qid] || {});
  const fresh = now.filter(u => !seenAns.has(u));
  seenAns = new Set(now);
  freshAns = new Set(fresh);
  if (fresh.length && state.phase === PHASE.OPEN) throttledSfx(snd.confirmed);
}

// ------------------------------------------------------------
//  影片與音檔預載 —— 開頁就把這一場會用到的本機檔案先抓下來
//  一次只抓一支；YouTube／Vimeo 是外部嵌入，沒辦法預載。
// ------------------------------------------------------------
const PRELOAD_TIMEOUT_MS = 90000;

const preloadBox = document.createElement("div");
preloadBox.setAttribute("aria-hidden", "true");
preloadBox.style.cssText =
  "position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;";
document.body.appendChild(preloadBox);

const preloadState = new Map();     // 網址 → waiting／loading／ready／failed／slow
let preloadQueue = [];
let preloadBusy = false;

function localMediaUrls() {
  const urls = new Set();
  const local = s => !/^(https?:)?\/\//i.test(s);
  const addVideo = raw => {
    const s = (raw || "").trim();
    if (!s || !isVideoUrl(s)) return;
    const v = videoEmbed(s);
    if (v.kind === "file" && v.src && local(v.src)) urls.add(v.src);
  };
  const addAudio = raw => {
    const s = (raw || "").trim();
    if (s && isAudioUrl(s) && local(s)) urls.add(s);
  };
  for (const q of Object.values(questions || {})) {
    addVideo(q?.exImgFull);
    addAudio(q?.exAudio);
    for (const b of blocksOf(q)) if (b.t === "video") addVideo(b.v);
  }
  return [...urls];
}

function queuePreload() {
  for (const url of localMediaUrls()) {
    if (preloadState.has(url)) continue;
    preloadState.set(url, "waiting");
    preloadQueue.push(url);
  }
  pumpPreload();
}

function pumpPreload() {
  if (preloadBusy) return;
  const url = preloadQueue.shift();
  if (!url) return;

  preloadBusy = true;
  preloadState.set(url, "loading");

  const v = document.createElement("video");
  v.preload = "auto";
  v.muted = true;
  v.playsInline = true;

  let settled = false;
  const done = how => {
    if (settled) return;
    settled = true;
    preloadState.set(url, how);
    preloadBusy = false;
    pumpPreload();
  };
  v.addEventListener("canplaythrough", () => done("ready"), { once: true });
  v.addEventListener("error",          () => done("failed"), { once: true });
  setTimeout(() => done("slow"), PRELOAD_TIMEOUT_MS);

  preloadBox.appendChild(v);
  v.src = url;
  v.load();
}

/** 在投影頁的 console 打 __preload() 就能看每支檔案的預載狀態 */
window.__preload = () => Object.fromEntries(preloadState);

// ------------------------------------------------------------
//  加倍轉盤
// ------------------------------------------------------------
let lastWheelId = null;

/**
 * 轉盤的聲音走到哪了：
 *   off      平常
 *   spinning 轉盤音樂正在放 —— 這段期間其他背景音樂一律不准開
 *   wow      轉盤停住，正在放那一聲 —— 放完才把原本的背景音樂接回來
 */
let wheelAudio = "off";
const wheelAudioBusy = () => wheelAudio !== "off";

const WOW_GUARD_MS = 5000;
const WOW_HARD_MS  = 120000;

function closeWheel() {
  const had = !!document.querySelector(".wheel-overlay");
  document.querySelector(".wheel-overlay")?.remove();
  snd.stopWheelBgm();
  if (!had) return;
  snd.stopWow();
  wheelAudio = "off";
  resumePhaseBgm();
}

function soloWheelBgm() {
  wheelAudio = "spinning";
  stopCuePlayback();
  clearCueState();
  snd.stopBgm();
  snd.stopRevealBgm();
  snd.stopFinalBgm();
  snd.startWheelBgm();
}

function wheelLanded() {
  wheelAudio = "wow";
  snd.stopWheelBgm();

  let restored = false;
  const restore = () => {
    if (restored || wheelAudio !== "wow") return;
    restored = true;
    wheelAudio = "off";
    resumePhaseBgm();
  };
  snd.wow(restore);

  // 音檔缺了或卡住也一定要把音樂接回來
  const t0 = Date.now();
  const guard = () => {
    if (restored || wheelAudio !== "wow") return;
    if (snd.wowPlaying() && Date.now() - t0 < WOW_HARD_MS) { setTimeout(guard, 1000); return; }
    restore();
  };
  setTimeout(guard, WOW_GUARD_MS);
}

/** 轉盤／音檔結束後，依目前階段把背景音樂接回來（start 本身有防重入） */
function resumePhaseBgm() {
  if (wheelAudio === "spinning") { snd.startWheelBgm(); return; }
  if (wheelAudio === "wow") return;
  const p = state.phase;
  if (p === PHASE.OPEN)        snd.startBgm();
  else if (p === PHASE.REVEAL && !onOwnSoundPage()) snd.startRevealBgm();
  else if (p === PHASE.FINAL)  snd.startFinalBgm();
}

function onWheel() {
  const w = state.wheel;
  if (!w || !w.id) {
    if (lastWheelId !== null) { lastWheelId = null; closeWheel(); }
    return;
  }
  if (w.id === lastWheelId) return;
  lastWheelId = w.id;
  spinWheel(w.uid);
}

/** 主持人按下轉盤 → 全螢幕蓋上轉盤並轉到指定的人 */
function spinWheel(targetUid) {
  // 跟主持人端同一支邏輯算出還沒抽過的人；萬一一瞬間不同步、目標不在裡面，就把他補回去
  const pool = wheelPool(players, doubles);
  if (!pool.some(p => p.id === targetUid) && players[targetUid]) {
    pool.push({ id: targetUid, name: players[targetUid].name });
  }
  const gl = wheelSlots(pool, targetUid);
  if (!gl.length) return;

  const n = gl.length;
  const idx = Math.max(0, gl.findIndex(p => p.id === targetUid));
  const seg = 360 / n;

  document.querySelector(".wheel-overlay")?.remove();
  snd.stopWheelBgm();
  const ov = document.createElement("div");
  ov.className = "wheel-overlay";
  ov.innerHTML = `
    <h2 class="title-gold"><span class="emoji">🎡</span> 分數<span class="dbl-word">Double</span>轉盤 <span class="emoji">🎡</span></h2>
    <div class="wheel-stage">
      <div class="wheel-ptr"></div>
      <div class="wheel-hub">×2</div>
      <svg viewBox="-105 -105 210 210" aria-hidden="true">
        <g id="wheel-spin">${wheelSvg(gl, seg)}</g>
      </svg>
    </div>
    <div class="wheel-result pending" id="wheel-result">轉盤轉動中…</div>
    <p class="wheel-hint" id="wheel-hint"></p>`;
  stage.appendChild(ov);
  soloWheelBgm();

  // wheelSvg 從 12 點鐘開始順時針排，第 i 格中心在 i*seg + seg/2 度；
  // 指針固定在 12 點鐘，所以要轉 R = 轉數*360 - 中心角
  const centre = idx * seg + seg / 2;
  const finalR = 6 * 360 - centre;
  const dur    = 5200;
  const spin   = ov.querySelector("#wheel-spin");
  const t0     = performance.now();
  let lastSeg  = null;

  function frame(now) {
    const p = Math.min(1, (now - t0) / dur);
    const r = finalR * (1 - Math.pow(1 - p, 4));     // ease-out：先快後慢
    // 用 SVG 的 transform 屬性繞原點（＝圓心）轉；CSS transform 在 <g> 上原點會跑掉
    spin.setAttribute("transform", `rotate(${r})`);

    const segIdx = Math.floor(r / seg);
    if (segIdx !== lastSeg) { lastSeg = segIdx; snd.wheelTick(); }

    if (p < 1) { requestAnimationFrame(frame); return; }

    snd.wheelStop();
    wheelLanded();
    const res = ov.querySelector("#wheel-result");
    res.className = "wheel-result";
    res.innerHTML = `<span class="who">${escapeHtml(gl[idx].name)}</span>
                     <span class="x2">下一題 ×2</span>`;
    ov.querySelector("#wheel-hint").textContent = "主持人按「下一題」就會關閉";
  }
  requestAnimationFrame(frame);
}

/** 轉盤的扇形與文字 */
function wheelSvg(gl, seg) {
  const R = 100;
  const palette = ["#1f3f9e", "#2a56c6"];
  return gl.map((g, i) => {
    const a0 = (i * seg - 90) * Math.PI / 180;
    const a1 = ((i + 1) * seg - 90) * Math.PI / 180;
    const x0 = (R * Math.cos(a0)).toFixed(2), y0 = (R * Math.sin(a0)).toFixed(2);
    const x1 = (R * Math.cos(a1)).toFixed(2), y1 = (R * Math.sin(a1)).toFixed(2);
    const big = seg > 180 ? 1 : 0;
    const mid = (i * seg + seg / 2 - 90);
    const tx  = (R * 0.6 * Math.cos(mid * Math.PI / 180)).toFixed(2);
    const ty  = (R * 0.6 * Math.sin(mid * Math.PI / 180)).toFixed(2);
    const fs  = Math.max(5, Math.min(11, 150 / gl.length)).toFixed(1);
    const label = Array.from(g.name).length > 6 ? Array.from(g.name).slice(0, 6).join("") + "…" : g.name;
    // 只有一格時畫整個圓（弧線的起點終點重合會畫不出來）
    const shape = gl.length === 1
      ? `<circle r="${R}" fill="${palette[0]}" stroke="#ffc81f" stroke-width="0.8"/>`
      : `<path d="M0 0 L ${x0} ${y0} A ${R} ${R} 0 ${big} 1 ${x1} ${y1} Z"
           fill="${palette[i % 2]}" stroke="#ffc81f" stroke-width="0.8"/>`;
    return `${shape}
      <text x="${tx}" y="${ty}" fill="#fff" font-size="${fs}" font-weight="900"
        text-anchor="middle" dominant-baseline="central"
        transform="rotate(${mid} ${tx} ${ty})">${escapeHtml(label)}</text>`;
  }).join("");
}

// ------------------------------------------------------------
//  主持人放的音檔（上／下課鐘聲、健康操）
//  控制台只寫 state.cue = { id, kind }，出聲的是這一頁。
// ------------------------------------------------------------
const CUE_PILL = { bell: "🔔 上／下課鐘聲", exercise: "🤸 健康操" };

let lastCueId = null;
let cueKind   = null;

function onCue() {
  const c = state.cue;
  if (!c || !c.id) {
    if (lastCueId !== null) { lastCueId = null; stopCuePlayback(); }
    return;
  }
  if (c.id === lastCueId) return;
  lastCueId = c.id;
  startCuePlayback(c.kind);
}

function startCuePlayback(kind) {
  if (!snd.startCue(kind)) return;
  cueKind = kind;
  stopExplainAudio();
  snd.stopBgm(); snd.stopRevealBgm(); snd.stopFinalBgm(); snd.stopWheelBgm();
  document.querySelector(".cue-pill:not(.aud-pill)")?.remove();
  const el = document.createElement("div");
  el.className = "cue-pill";
  el.textContent = CUE_PILL[kind] || "🔊 播放中";
  stage.appendChild(el);
}

/** 只停這一頁的播放，不動資料庫 */
function stopCuePlayback() {
  if (!cueKind) return;
  cueKind = null;
  snd.stopCue();
  document.querySelector(".cue-pill:not(.aud-pill)")?.remove();
  resumePhaseBgm();
}

/** 把 state.cue 收掉 —— 控制台的按鈕靠它跳回「播放」 */
function clearCueState() {
  if (!state.cue) return;
  update(ref(db, PATH.state), { cue: null }).catch(() => {});
}

snd.onCueEnd(() => { stopCuePlayback(); clearCueState(); });

// ------------------------------------------------------------
//  鍵盤與遠端翻頁 —— 兩邊都走 stepPage()，行為一定一致
// ------------------------------------------------------------
addEventListener("keydown", e => {
  if (document.querySelector(".wheel-overlay")) {
    if (e.key === "Escape") { e.preventDefault(); closeWheel(); }
    return;
  }
  const phase = state.phase || PHASE.IDLE;
  if (phase === PHASE.FINAL && [" ", "Enter"].includes(e.key)) { e.preventDefault(); stepPage(+1); return; }
  if (e.key === "ArrowRight") { e.preventDefault(); stepPage(+1); }
  if (e.key === "ArrowLeft")  { e.preventDefault(); stepPage(-1); }
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function stepPage(dir) {
  if (document.querySelector(".wheel-overlay")) return;
  const phase = state.phase || PHASE.IDLE;

  if (phase === PHASE.FINAL) return stepPodium(dir);

  if (phase === PHASE.IDLE) {
    const next = clamp(introPage + dir, 0, introPages().length - 1);
    if (next === introPage) return;
    introPage = next;
    paintNow();
    return;
  }

  if (phase === PHASE.REVEAL) {
    const q = state.qid ? questions[state.qid] : null;
    if (!q) return;
    const next = clamp(revealPage + dir, 0, revealPages(q).length - 1);
    if (next === revealPage) return;
    revealPage = next;
    paintNow();
  }
}

let lastNavId = null;
let navReady  = false;

/** 主持人從控制台按翻頁 —— state.nav 換了新的 id 就翻一頁 */
function onNav() {
  const n = state.nav;
  // 剛開頁面：把現在的指令記下來就好，不要把上一輪留著的補翻一次
  if (!navReady) { navReady = true; lastNavId = n?.id ?? null; return; }
  if (!n || !n.id || n.id === lastNavId) return;
  lastNavId = n.id;
  stepPage(n.dir < 0 ? -1 : +1);
}

/** 把投影幕停在第幾頁寫回 state，控制台的翻頁鈕才不是盲按。只有變了才寫。 */
let lastPageReport = null;
function reportPage() {
  const label = currentPageLabel();
  if (label === lastPageReport) return;
  lastPageReport = label;
  update(ref(db, PATH.state), { screenPage: label }).catch(() => {});
}
/** state 被整包蓋掉時 screenPage 會不見，清掉記憶讓下一次 paint 補寫回去 */
function syncPageReport() {
  if (lastPageReport !== null && state.screenPage == null) lastPageReport = null;
}

function currentPageLabel() {
  const phase = state.phase || PHASE.IDLE;
  if (phase === PHASE.IDLE) {
    const pages = introPages();
    const i = Math.min(introPage, pages.length - 1);
    return `開場 ${i + 1}/${pages.length}　${INTRO_NAME[pages[i]]}`;
  }
  if (phase === PHASE.REVEAL) {
    const q = state.qid ? questions[state.qid] : null;
    if (!q) return "公布答案";
    const pages = revealPages(q);
    const i = Math.min(revealPage, pages.length - 1);
    return `公布答案 ${i + 1}/${pages.length}　${PAGE_NAME[pages[i]] || ""}`;
  }
  if (phase === PHASE.FINAL) {
    const names = ["還沒開始", "第三名", "第二名", "第一名", "主視覺"];
    return `排行榜 ${podiumStep + 1}/${FINAL_COVER + 1}　${names[podiumStep] || ""}`;
  }
  return "";
}

function stepPodium(dir) {
  const next = clamp(podiumStep + dir, 0, FINAL_COVER);
  if (next === podiumStep) return;
  podiumStep = next;
  if (dir > 0 && podiumStep >= 1 && podiumStep <= PODIUM_TOP) {
    podiumStep === PODIUM_TOP ? snd.victory() : snd.fanfare();
  }
  paintNow();
}

// ------------------------------------------------------------
//  倒數
// ------------------------------------------------------------
let ticker = null, lastTickSec = null;

function startTicker() {
  stopTicker();
  lastTickSec = null;
  ticker = setInterval(() => {
    const left = secondsLeft(state.openedAt, state.limitSec || DEFAULT_LIMIT_SEC, timeOffset);
    if (left === null) return;
    paintCountdown(left);
    if (left !== lastTickSec) {
      lastTickSec = left;
      if (left > 0) snd.tick(left);
    }
    stage.classList.toggle("tense", left <= 10);
    stage.classList.toggle("shake", left <= 5 && left > 0);
  }, 200);
}
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

function paintCountdown(left) {
  const el = $("#s-countdown");
  if (!el) return;
  el.textContent = left;
  el.className = "countdown" + (left <= 5 ? " danger" : left <= 10 ? " warn" : "");
}

// ------------------------------------------------------------
//  版面工具
// ------------------------------------------------------------
/** 一路縮字到塞得進框為止 */
function fitToBox(el, box, prop, startVh, minVh = 0.8) {
  let vh = startVh;
  el.style.setProperty(prop, vh.toFixed(2) + "vh");
  for (let i = 0; i < 60 && vh > minVh; i++) {
    if (box.scrollHeight <= box.clientHeight + 1 && box.scrollWidth <= box.clientWidth + 1) break;
    vh = Math.max(minVh, vh * 0.93);
    el.style.setProperty(prop, vh.toFixed(2) + "vh");
  }
}

const activeList = () => state.list === LISTS.DEMO ? LISTS.DEMO : LISTS.MAIN;
const qList  = () => questionsOf(questions, activeList());
const qIndex = qid => qList().findIndex(q => q.id === qid);
/** 題幹外框：單數題黃、偶數題綠 */
const qParity = qid => (qIndex(qid) + 1) % 2 === 1 ? "odd" : "even";

/** 這一題公布後要不要插一頁戰況：每 5 題一次，最後一題不插 */
function showsStandings(qid) {
  if (activeList() !== LISTS.MAIN) return false;
  const list = qList();
  const i = list.findIndex(q => q.id === qid);
  if (i < 0) return false;
  return i !== list.length - 1 && (i + 1) % STANDINGS_EVERY === 0;
}

function revealPages(q) {
  const pages = ["answer"];
  if ((q?.exImgFull || "").trim() || (q?.exAudio || "").trim()) pages.push("fullimg");
  if (showsStandings(q?.id ?? state.qid)) pages.push("standings");
  pages.push("dist");
  return pages;
}

/** 現在是不是停在「補充說明」那一頁 */
function onFullPage() {
  if ((state.phase || PHASE.IDLE) !== PHASE.REVEAL) return false;
  const q = state.qid ? questions[state.qid] : null;
  if (!q) return false;
  const pages = revealPages(q);
  return pages[Math.min(revealPage, pages.length - 1)] === "fullimg";
}

/** 補充說明那一頁放的是影片或音檔 —— 它自己有聲音，講解音樂要讓開 */
function onOwnSoundPage() {
  if (!onFullPage()) return false;
  const q = questions[state.qid];
  return isVideoUrl((q?.exImgFull || "").trim()) || !!(q?.exAudio || "").trim();
}

const PAGE_NAME = {
  answer:    "答案與說明",
  fullimg:   "補充說明",
  standings: "目前戰況",
  dist:      "全場作答分布"
};

const INTRO_NAME = { black: "黑畫面", video: "開場影片", cover: "主視覺", rules: "遊戲規則", join: "掃碼進場" };
/** 開場有幾頁：後台填了開場影片才會多一頁 */
function introPages() {
  const p = ["black"];
  if ((intro.video || "").trim()) p.push("video");
  p.push("cover", "rules", "join");
  return p;
}
// 黑幕、影片、主視覺都是整片鋪滿的畫面，頂部列與頁尾要收起來
const BLEED_PAGES = ["black", "video", "cover"];

function scoreboardNow() {
  return buildScoreboard(players, questions, keys, answers, state.revealed, LISTS.MAIN, doubles, openedAtOf(stats));
}

// ------------------------------------------------------------
//  主分派
//  資料一更新就重畫，一百個人同時送出時會連續觸發 —— 收成每個影格最多畫一次
// ------------------------------------------------------------
let paintQueued = false;
function paint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paintNow(); });
}

function paintNow() {
  if (!ready) return;
  const phase = state.phase || PHASE.IDLE;
  const qid   = state.qid || null;
  const q     = qid ? questions[qid] : null;

  // 待機與最終排行榜跟「某一題」無關，題號、類別、配分整個藏起來
  const onQuestion = !!q && phase !== PHASE.IDLE && phase !== PHASE.FINAL;

  badge.innerHTML = onQuestion ? `第 <b>${qIndex(qid) + 1}</b> 題` : "";
  badge.style.display = onQuestion ? "" : "none";


  const pts = ptsOf(q);
  $("#s-pts").textContent = "+" + pts;
  $("#s-pts").style.display = onQuestion && pts !== 1 ? "" : "none";

  const dblUid = onQuestion ? doubles[qid] : null;
  const dblEl = $("#s-dbl");
  if (dblUid && players[dblUid]) {
    dblEl.textContent = "🎡 " + players[dblUid].name + " ×2";
    dblEl.style.display = "";
  } else {
    dblEl.style.display = "none";
  }

  const pages = introPages();
  introPage = Math.min(introPage, pages.length - 1);
  const introBleed = phase === PHASE.IDLE && BLEED_PAGES.includes(pages[introPage]);
  const finalBleed = phase === PHASE.FINAL && podiumStep === FINAL_COVER;
  stage.classList.toggle("bleed",    introBleed || finalBleed);
  stage.classList.toggle("blackout", phase === PHASE.IDLE && pages[introPage] === "black");

  tip.textContent = "";
  stage.querySelector(".confetti")?.remove();
  if (!onFullPage()) stopExplainAudio();
  reportPage();

  if (phase === PHASE.FINAL)                                 return paintFinal();
  if (phase === PHASE.REVEAL && q)                           return paintRevealPage(qid, q);
  if ((phase === PHASE.OPEN || phase === PHASE.LOCKED) && q)  return paintPlay(qid, q, phase);
  return paintIntro();
}

// ============================================================
//  開場
// ============================================================
function paintIntro() {
  foot.textContent = "開場";
  const pages = introPages();
  const page  = pages[introPage];
  const prev = introPage > 0                ? "← " + INTRO_NAME[pages[introPage - 1]] : "";
  const next = introPage < pages.length - 1 ? INTRO_NAME[pages[introPage + 1]] + " →" : "";
  tip.textContent = [prev, next].filter(Boolean).join("　　");

  if (page === "black") return paintBlack();
  if (page === "video") return paintVideo();
  if (page === "cover") return paintCover();
  if (page === "rules") return paintRules();
  return paintJoin();
}

/** 全黑：投影機先亮著，台下什麼都看不到 —— 主持人按 → 才開場 */
function paintBlack() {
  if (body.firstChild) body.innerHTML = "";
}

/** 開場影片（後台有填才有這一頁），滿版循環播 */
function paintVideo() {
  const src = (intro.video || "").trim();
  const cur = body.querySelector("#s-themevid");
  if (cur && cur.dataset.src === src) return;     // 已經在播就別重建，否則會跳回第一幀

  const v = videoEmbed(src);
  body.innerHTML = v.kind === "embed"
    ? `<iframe class="bleed-img" id="s-themevid" data-src="${escapeHtml(src)}"
         src="${escapeHtml(v.src)}&autoplay=1&playsinline=1&loop=1" title="開場影片"
         frameborder="0" allow="autoplay; encrypted-media"></iframe>`
    : `<video class="bleed-img" id="s-themevid" data-src="${escapeHtml(src)}" src="${escapeHtml(v.src)}"
         autoplay loop muted playsinline></video>`;
  const el = $("#s-themevid");
  el.addEventListener?.("error", () => { body.innerHTML = coverHtml(); });
  if (soundOn && v.kind === "file") unmuteVideo("#s-themevid");
}

/** 內建主視覺 —— 後台沒放主視覺圖、或圖載不出來時用 */
function coverHtml() {
  const stars = [[8, 14, 2.4], [86, 10, 3.2], [16, 76, 2.8], [78, 72, 2.2], [50, 8, 1.8], [92, 46, 2.6], [6, 44, 2]]
    .map(([x, y, s], i) => `<span class="twinkle" style="left:${x}%; top:${y}%; font-size:${s}vh; animation-delay:${i * .37}s">✦</span>`)
    .join("");
  return `<div class="cover" id="s-cover" data-key="builtin">
    ${stars}
    <div class="bigstar">✦</div>
    <h1>崇德機智星</h1>
    <div class="en">GENIUS STAR</div>
  </div>`;
}

/** 主視覺。開場就是對著它講；排行榜揭曉完也會回到這一張。 */
function paintCover() {
  const img = (intro.heroImg || "").trim();
  const key = img || "builtin";
  const cur = body.querySelector("#s-cover");
  if (cur && cur.dataset.key === key) return;    // 免得每次資料更新都閃一下

  if (!img) { body.innerHTML = coverHtml(); return; }
  body.innerHTML = `<img class="bleed-img" id="s-cover" data-key="${escapeHtml(key)}"
    src="${escapeHtml(webpSrc(img))}" alt="崇德機智星">`;
  const el = $("#s-cover");
  el.addEventListener("error", () => {
    if (webpSrc(img) !== img && !el.dataset.retried) { el.dataset.retried = "1"; el.src = img; return; }
    body.innerHTML = coverHtml();
  });
}

/** 規則頁：規則條列 + 進場 QR，旁邊一支手機示意圖（或後台放的規則圖） */
function paintRules() {
  const img = (intro.rulesImg || "").trim();
  body.innerHTML = `
    <h2 class="title-gold intro-title">★ 遊戲規則 ★</h2>
    <div class="rules">
      <div class="ruleside">
        <ol>
          <li>掃 QR Code、輸入 <b>暱稱</b> 就能加入，<b>一人一支手機</b>。</li>
          <li>題目出現後開始 <b>倒數</b>，在手機上選 A／B／C／D。</li>
          <li>按下 <b>確認送出</b> 才算數 —— 送出後不能更改。</li>
          <li>答對 <b>+1 分</b>（有些題目配分更高，看題號旁的徽章）。</li>
          <li>同分比 <b>速度</b>：答對題目的作答時間加起來越短，名次越前面。</li>
          <li>主持人會轉 <b>加倍轉盤</b>，抽中的人下一題分數 <b>×2</b>！</li>
        </ol>
        <div class="qr-mini">
          <div class="qrbox"><img id="s-qr" alt="玩家端 QR Code"></div>
          <div class="cap">
            <b>📱 還沒加入的現在就掃</b>
            <span>${escapeHtml(playerUrl)}</span>
          </div>
        </div>
      </div>
      ${img
        ? `<div class="pic custom"><img id="s-rulesimg" src="${escapeHtml(webpSrc(img))}" alt="規則說明圖"></div>`
        : `<div class="pic"><div class="phones">${phoneFigure()}</div></div>`}
    </div>`;

  const ri = $("#s-rulesimg");
  ri?.addEventListener("error", () => {
    if (webpSrc(img) !== img && !ri.dataset.retried) { ri.dataset.retried = "1"; ri.src = img; return; }
    ri.parentElement.innerHTML = `<div class="phones">${phoneFigure()}</div>`;
    fitPhones();
  });

  paintQr();
  fitPhones();
}

/** 規則頁的手機示意：直接用玩家端真正的元件樣式組出來，跟大家手上看到的一致 */
function phoneFigure() {
  const opts = [["A", "台北 101"], ["B", "高雄 85 大樓"], ["C", "台中國家歌劇院"], ["D", "台南赤崁樓"]];
  return `
    <div class="phone-screen">
      <div class="brand"><span class="t">崇德機智星</span></div>
      <div class="qhead">
        <span class="qbadge">第 <b>3</b> 題</span>
        <span class="timer warn">8</span>
      </div>
      <div class="qpanel"><p>台灣最高的建築物是？</p></div>
      <div class="opts">${opts.map(([L, t]) =>
        `<div class="opt${L === "A" ? " picked" : ""}"><span class="letter">${L}</span><span class="label">${t}</span></div>`).join("")}
      </div>
      <button class="btn wide" style="margin-top:12px;">確認送出 <b>A</b></button>
    </div>`;
}

/** 手機用原尺寸組好再整體縮到放得下，字級比例才不會跑掉 */
function fitPhones() {
  document.querySelectorAll(".rules .phone-screen").forEach(scr => {
    const box = scr.parentElement;
    if (!box) return;
    scr.style.transform = "";
    const w = scr.offsetWidth, h = scr.offsetHeight;
    if (!w || !h) return;
    const k = Math.min(box.clientWidth / w, box.clientHeight / h, 1.6);
    scr.style.transform = `scale(${k.toFixed(3)})`;
  });
}

/** 掃碼進場：QR + 已進場的人數與暱稱 */
function paintJoin() {
  const list = Object.entries(players)
    .filter(([, p]) => p?.name)
    .map(([uid, p]) => ({ uid, name: p.name, at: p.at || 0 }))
    .sort((a, b) => a.at - b.at);

  body.innerHTML = `
    <div class="joinpage">
      <div class="qrside">
        <h3 class="title-gold" style="margin:0; font-size:5vh;">掃碼加入</h3>
        <div class="qrbox"><img id="s-qr" alt="玩家端 QR Code"></div>
        <div class="url">${escapeHtml(playerUrl)}</div>
      </div>
      <div class="side">
        <h3 class="title-gold">已加入 <b>${list.length}</b> 人</h3>
        <div class="namecloud join" id="s-cloud">${chipsHtml(list, freshJoin)}</div>
      </div>
    </div>`;
  freshJoin = new Set();
  paintQr();
  fitCloud($("#s-cloud"));
}

function chipsHtml(list, fresh) {
  if (!list.length) return `<p class="hint" style="font-size:2.6vh;">還沒有人加入，掃左邊的 QR Code ✦</p>`;
  return list.map(p => `<span class="chip${fresh.has(p.uid) ? " fresh" : ""}">${escapeHtml(p.name)}</span>`).join("");
}

/** 暱稱泡泡縮到全部塞得下 */
function fitCloud(el) {
  if (!el) return;
  let px = Math.min(el.clientHeight / 6, 44);
  el.style.setProperty("--chip", px.toFixed(1) + "px");
  for (let i = 0; i < 40 && px > 9; i++) {
    if (el.scrollHeight <= el.clientHeight + 1) break;
    px *= 0.92;
    el.style.setProperty("--chip", px.toFixed(1) + "px");
  }
}

let qrUrlCache = null;
async function paintQr() {
  const img = $("#s-qr");
  if (!img) return;
  if (qrUrlCache) { img.src = qrUrlCache; return; }
  try {
    qrUrlCache = await qrDataUrl(playerUrl, 10);
    const now = $("#s-qr");
    if (now) now.src = qrUrlCache;
  } catch {
    const box = $("#s-qr")?.parentElement;
    if (box) box.innerHTML = `<p style="color:#333; font-size:2vh; padding:2vh;">QR 產生器載不出來<br>請直接把網址給大家</p>`;
  }
}

// ============================================================
//  出題中：題目在上，作答進度在下
// ============================================================
function paintPlay(qid, q, phase) {
  const locked = phase === PHASE.LOCKED;
  foot.textContent = locked ? "已截止作答，準備公布" : "開放作答中";

  const left = secondsLeft(state.openedAt, state.limitSec || DEFAULT_LIMIT_SEC, timeOffset);
  const total = Object.keys(players).length;
  const done = Object.entries(answers[qid] || {})
    .filter(([uid, a]) => LETTERS.includes(a?.c) && players[uid])
    .sort(([, a], [, b]) => (a.t || 0) - (b.t || 0))
    .map(([uid]) => ({ uid, name: players[uid].name }));
  const pct = total ? Math.round(done.length / total * 100) : 0;
  const showNames = state.showNames !== false;

  body.innerHTML = `
    <div class="qblock" id="s-qblock">
      <div style="flex:1 1 auto; min-width:0;">
        <div class="big-q ${qParity(qid)}" id="s-bigq">${escapeHtml(q.text || "")}</div>
        <div class="opt-row">
          ${LETTERS.filter(L => q[L.toLowerCase()]).map(L =>
            `<div class="opt-mini"><span class="k">${L}</span><span class="t">${escapeHtml(q[L.toLowerCase()])}</span></div>`
          ).join("")}
        </div>
      </div>
      <div class="countdown" id="s-countdown">${locked ? 0 : (left ?? "–")}</div>
    </div>
    <div class="progress">
      <div class="count">
        <span class="num">${done.length}<small> / ${total} 人已送出</small></span>
        <div class="track"><div class="fill" style="width:${pct}%"></div></div>
      </div>
      ${showNames ? `<div class="namecloud" id="s-cloud">${
        done.length ? chipsHtml(done, freshAns) : ""}</div>` : ""}
    </div>`;
  freshAns = new Set();

  if (!locked && left !== null) paintCountdown(left);

  // 題目區塊有高度上限，剩下的都留給作答進度
  const qb = $("#s-qblock");
  fitToBox($("#s-bigq"), qb, "font-size", 4.6, 1.8);
  for (const line of qb.querySelectorAll(".opt-mini")) {
    fitToBox(line.querySelector(".t"), line, "font-size", 3, 1.5);
  }
  fitCloud($("#s-cloud"));
  tip.textContent = locked ? "" : `${done.length} / ${total} 人已送出`;
}

// ============================================================
//  公布階段
// ============================================================
function paintRevealPage(qid, q) {
  const pages = revealPages(q);
  revealPage = Math.min(revealPage, pages.length - 1);

  // 補充說明放影片或音檔的那一頁，講解音樂先讓開；翻到別頁再接回來
  if (wheelAudioBusy() || cueKind) { /* 轉盤或主持人放的音檔正在響，音樂不動 */ }
  else if (onOwnSoundPage())        snd.stopRevealBgm();
  else                              snd.startRevealBgm();

  ({ answer: paintReveal, fullimg: paintFullImage, standings: paintStandings, dist: paintDistribution })
    [pages[revealPage]](qid, q);

  const prev = revealPage > 0 ? "← " + PAGE_NAME[pages[revealPage - 1]] : "";
  const next = revealPage < pages.length - 1 ? PAGE_NAME[pages[revealPage + 1]] + " →" : "";
  tip.textContent = [prev, next].filter(Boolean).join("　　");
}

/** 正解大字與說明同時出現，底下是答對人數與最快答對的前五名 */
function paintReveal(qid, q) {
  foot.textContent = "已公布答案";
  const key = keys[qid] || stats[qid]?.key;
  const t = tally(answers[qid]);
  const right = correctCount(t, key);
  const total = Object.keys(players).length;
  const fast = (stats[qid]?.fastest
    ? Object.values(stats[qid].fastest)
    : fastestCorrect(players, answers[qid], key, stats[qid]?.openedAt)).slice(0, 5);

  body.innerHTML = `
    <div class="reveal-top">
      <div class="reveal-ans">
        <div class="title-gold" style="font-size:2.8vh;"><span class="emoji">🎉</span> 正確答案 <span class="emoji">🎉</span></div>
        <div class="reveal-letter${key === ALL_CORRECT ? " all" : ""}">${key ? escapeHtml(keyLabel(key)) : "—"}</div>
        ${key === ALL_CORRECT ? `<div class="reveal-opt">這題選哪個都算對！</div>`
          : optionText(q, key) ? `<div class="reveal-opt">${escapeHtml(optionText(q, key))}</div>` : ""}
      </div>
      <div class="reveal-ex">
        <h3 class="title-gold" style="font-size:3vh; margin:0 0 1vh;"><span class="emoji">💡</span> 說明</h3>
        <div class="exblocks${isSoloMedia(blocksOf(q)) ? " solo" : ""}" id="s-exblocks">${blocksHtml(q)}</div>
      </div>
    </div>
    <div class="revstrip">
      <div class="rate">
        <div class="big">${right}<small> / ${t.total}</small></div>
        <div class="cap">人答對${t.total ? `（${Math.round(right / t.total * 100)}%）` : ""}　共 ${total} 人</div>
      </div>
      <div class="fast">
        <h4><span class="emoji">⚡</span> 最快答對</h4>
        <div class="fastrow">
          ${[0, 1, 2, 3, 4].map(i => {
            const f = fast[i];
            return f
              ? `<div class="fastcard${i === 0 ? " first" : ""}" style="animation-delay:${(4 - i) * .12}s">
                   <span class="no">${i === 0 ? "🥇 第一快" : `第 ${i + 1} 快`}</span>
                   <span class="nm">${escapeHtml(players[f.uid]?.name || f.name)}</span>
                   <span class="ms">${fmtSec(f.ms)}</span>
                 </div>`
              : `<div class="fastcard empty"><span class="nm">—</span></div>`;
          }).join("")}
        </div>
      </div>
    </div>`;

  fitBlocks($("#s-exblocks"));
  const opt = $(".reveal-opt");
  if (opt) fitToBox(opt, $(".reveal-ans"), "--ofs", 2.8, 1.2);
}

function optionText(q, key) {
  if (!q || !key || key === ALL_CORRECT) return "";
  return (q[String(key).toLowerCase()] || "").trim();
}

/** 把後台排好的說明區塊畫出來 */
function blocksHtml(q) {
  const blocks = blocksOf(q);
  if (!blocks.length) return "";
  const one = b => {
    const cls = `exblock ${b.w} ${b.align}`;
    if (b.t === "img") {
      return `<div class="${cls}"><img src="${escapeHtml(webpSrc(b.v))}"
        data-fallback="${webpSrc(b.v) !== b.v ? escapeHtml(b.v) : ""}" alt=""
        style="--ih:${IMG_SIZE_VH[b.size]}vh"
        onerror="window.__imgErr(this)"></div>`;
    }
    if (b.t === "video") {
      const v = videoEmbed(b.v);
      const inner = v.kind === "embed"
        ? `<iframe src="${escapeHtml(v.src)}" title="說明影片" frameborder="0"
             allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`
        : `<video src="${escapeHtml(v.src)}" controls playsinline preload="metadata"></video>`;
      return `<div class="${cls}"><div class="vidbox" style="--ih:${IMG_SIZE_VH[b.size]}vh">${inner}</div></div>`;
    }
    const tag = b.t === "head" ? "h4" : "p";
    return `<${tag} class="${cls} ${b.t}" style="--fs:${TEXT_SIZE_VH[b.size]}vh">${escapeHtml(b.v)}</${tag}>`;
  };
  return groupBlocks(blocks).map(r => r.auto
    ? `<div class="exrow ${r.align}">${r.items.map(one).join("")}</div>`
    : one(r.items[0])
  ).join("");
}

// inline 的 onerror 在全域執行，看不到 module 內的函式 —— 掛到 window 上
// 先退回原始副檔名（.webp → 原本的 .png/.jpg），還是不行就換成提示文字
window.__imgErr = function (img) {
  const back = img.dataset.fallback;
  if (back) { img.dataset.fallback = ""; img.src = back; return; }
  img.replaceWith(Object.assign(document.createElement("span"), { className: "imgfail", textContent: "圖片載不出來" }));
};

/** 排太滿就整體縮小，保證一頁塞得下 */
function fitBlocks(el) {
  if (!el) return;
  let k = 1;
  el.style.setProperty("--blk-scale", k);
  for (let i = 0; i < 24 && k > 0.45; i++) {
    if (el.scrollHeight <= el.clientHeight + 1) break;
    k -= 0.04;
    el.style.setProperty("--blk-scale", k.toFixed(2));
  }
}

/**
 * 補充說明那一頁：整頁大圖／影片，外加選填的說明音檔。只播一次，不加 loop；
 * 資料一有更新就會重畫，所以內容沒換就不重建 DOM，否則會一直跳回開頭重播。
 */
function paintFullImage(qid, q) {
  foot.textContent = "補充說明";
  const url   = (q.exImgFull || "").trim();
  const audio = (q.exAudio   || "").trim();

  if (isVideoUrl(url)) return paintFullVideo(url);   // 影片自己有聲音，說明音檔就略過

  const key = `${qid}|${url}|${audio}`;
  const cur = body.querySelector("#s-fullpage");
  if (cur && cur.dataset.key === key) return;

  const pic = url
    ? `<img src="${escapeHtml(webpSrc(url))}" data-fallback="${webpSrc(url) !== url ? escapeHtml(url) : ""}"
           alt="補充說明大圖" onerror="window.__imgErr(this)">`
    : `<p class="hint" style="font-size:3.2vh;">🔊 播放說明音檔中…</p>`;

  body.innerHTML = `<div class="fullimg" id="s-fullpage" data-key="${escapeHtml(key)}">${pic}</div>`;
  if (audio) addExplainAudio(audio);
}

function addExplainAudio(src) {
  const el = document.createElement("audio");
  el.id = "s-fullaud";
  el.src = src;
  el.autoplay = true;
  el.muted = true;
  el.preload = "auto";
  el.addEventListener("error", () => document.querySelector(".aud-pill")?.remove());
  el.addEventListener("ended", () => document.querySelector(".aud-pill")?.remove(), { once: true });
  body.appendChild(el);

  document.querySelector(".aud-pill")?.remove();
  const p = document.createElement("div");
  p.className = "cue-pill aud-pill";
  p.textContent = "🔊 說明音檔播放中";
  stage.appendChild(p);

  if (soundOn) { el.muted = false; el.volume = 1; el.play?.().catch(() => {}); }
}

function stopExplainAudio() {
  const el = document.getElementById("s-fullaud");
  if (el) { el.pause(); el.remove(); }
  document.querySelector(".aud-pill")?.remove();
}

function paintFullVideo(url) {
  if (body.querySelector("#s-fullvid")) return;
  const v = videoEmbed(url);
  body.innerHTML = v.kind === "embed"
    ? `<div class="fullimg"><iframe id="s-fullvid" class="fullvid"
         src="${escapeHtml(v.src)}&autoplay=1&playsinline=1" title="補充說明影片"
         frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`
    : `<div class="fullimg"><video id="s-fullvid" class="fullvid"
         src="${escapeHtml(v.src)}" autoplay muted playsinline controls></video></div>`;
  $("#s-fullvid").addEventListener?.("error", e => {
    if (e.target.tagName === "VIDEO") e.target.parentElement.innerHTML =
      `<p class="hint" style="font-size:2.6vh">影片載不出來，請確認後台填的網址</p>`;
  });
  if (soundOn && v.kind === "file") unmuteVideo("#s-fullvid");
}

function paintDistribution(qid, q) {
  foot.textContent = "全場作答分布";
  const key = keys[qid];
  const t   = tally(answers[qid]);

  body.innerHTML = `
    <div class="big-q ${qParity(qid)}" style="font-size:3.2vh; padding:1.8vh 2vw; flex:0 0 auto;">${escapeHtml(q.text || "")}</div>
    <div class="bars screen-bars" style="flex:0 0 auto; margin-top:1.6vh;">
      ${LETTERS.filter(L => q[L.toLowerCase()]).map(L => {
        const n = t[L], pct = t.total ? Math.round(n / t.total * 100) : 0;
        return `<div class="bar-row">
          <span class="bar-key">${L}</span>
          <span class="bar-opt">${escapeHtml(q[L.toLowerCase()])}</span>
          <span class="bar-track"><span class="bar-fill${key && isKeyLetter(L, key) ? " is-correct" : ""}" style="width:${pct}%"></span></span>
          <span class="bar-num">${pct}%（${n}）</span>
        </div>`;
      }).join("")}
    </div>
    <p class="hint center" style="font-size:2.2vh; margin:1.4vh 0 0;">
      共 ${t.total} 人作答　正解 <b style="color:var(--gold)">${key ? keyLabel(key) : "—"}</b>
    </p>`;
}

/** 每五題插播：目前戰況 */
function paintStandings(qid) {
  foot.textContent = "目前戰況";
  const all = scoreboardNow().rows;
  const ranks = ranksOf(all);
  const rows = all.slice(0, STANDINGS_TOP);
  const done = qIndex(qid) + 1;
  const medal = r => ["🥇", "🥈", "🥉"][r - 1] || r;

  body.innerHTML = `
    <h2 class="title-gold intro-title" style="margin:0 0 .6vh;"><span class="emoji">⚡</span> 目前戰況 <span class="emoji">⚡</span></h2>
    <p class="hint center" style="font-size:2.3vh; margin:0 0 1.6vh;">已完成 ${done} 題　顯示前 ${STANDINGS_TOP} 名（共 ${all.length} 人）</p>
    <div class="card" style="overflow:hidden; flex:1 1 auto; min-height:0;">
      <table class="rank rank-screen">
        <thead><tr>
          <th style="width:9vh;">#</th><th>暱稱</th>
          <th class="n">總分</th><th class="n">答對</th><th class="n">答對用時</th>
        </tr></thead>
        <tbody>${
          rows.length
            ? rows.map((r, i) => `<tr class="${ranks[i] === 1 ? "top1" : ""}">
                <td>${medal(ranks[i])}</td>
                <td>${escapeHtml(r.name)}</td>
                <td class="n">${r.points}</td>
                <td class="n">${r.correct}</td>
                <td class="n">${fmtSec(r.timeMs)}</td>
              </tr>`).join("")
            : `<tr><td colspan="5" class="hint">尚無資料</td></tr>`
        }</tbody>
      </table>
    </div>`;
  const t = $(".rank-screen");
  fitToBox(t, t.parentElement, "--rfs", 3.4);
}

// ============================================================
//  最終：排行榜（只公布前三名，逐一揭曉）→ 主視覺
// ============================================================
function paintFinal() {
  const rows = board?.final ? (board.rows || []) : scoreboardNow().rows;

  if (podiumStep >= FINAL_COVER)  { foot.textContent = "結束畫面"; return paintCover(); }

  foot.textContent = "排行榜";
  tip.textContent = podiumStep === 0
    ? "按空白鍵開始公布 →"
    : podiumStep < PODIUM_TOP
      ? `按空白鍵公布第 ${PODIUM_TOP - podiumStep} 名 →`
      : "按空白鍵看主視覺 →";

  const top = rows.slice(0, PODIUM_TOP);
  // 版面順序是 2 - 1 - 3，揭曉順序是 3 → 2 → 1
  const layout = [
    { rank: 2, cls: "p2", medal: "🥈" },
    { rank: 1, cls: "p1", medal: "🥇" },
    { rank: 3, cls: "p3", medal: "🥉" }
  ];

  body.innerHTML = `
    <h2 class="title-gold podium-title" style="margin:0 0 .8vh;">★ 排行榜 ★</h2>
    <div class="podium">
      ${layout.map(({ rank, cls, medal }) => {
        const r = top[rank - 1];
        const shown = podiumStep >= PODIUM_TOP - rank + 1;    // 第三名在第 1 步、第一名在第 3 步
        if (!r) return `<div class="place ${cls}"></div>`;
        return `<div class="place ${cls} ${shown ? "shown" : ""}">
          <div class="medal">${medal}</div>
          <div class="gname">${escapeHtml(r.name)}</div>
          <div class="score">${r.points} 分</div>
          <div class="detail">答對 ${r.correct} 題・用時 ${fmtSec(r.timeMs)}</div>
          <div class="block">${rank}</div>
        </div>`;
      }).join("")}
    </div>`;

  if (podiumStep >= PODIUM_TOP && top.length) dropConfetti();
}

function dropConfetti() {
  stage.querySelector(".confetti")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "confetti";
  const colors = ["#ffc81f", "#35a8ff", "#e6266f", "#2fd96b", "#8b5cf6", "#fff"];
  let html = "";
  for (let i = 0; i < 90; i++) {
    html += `<i style="left:${(Math.random() * 100).toFixed(1)}%; background:${colors[i % colors.length]};
      animation-duration:${(2.6 + Math.random() * 2.6).toFixed(2)}s; animation-delay:${(Math.random() * 1.6).toFixed(2)}s"></i>`;
  }
  wrap.innerHTML = html;
  stage.appendChild(wrap);
  setTimeout(() => wrap.remove(), 9000);
}
