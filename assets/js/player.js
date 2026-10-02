// ============================================================
//  玩家端 —— 手機直式，一個人一支手機
//  輸入暱稱 → 等出題 → 選一個答案並確認送出 → 看答案與自己的名次
// ============================================================

import {
  db, ref, onValue, set, serverTimestamp, ensureAnonAuth,
  PATH, PHASE, LETTERS, LISTS, DEFAULT_LIMIT_SEC,
  questionsOf, secondsLeft, ptsOf, elapsedMs, fmtSec, cleanName,
  isAllKey, isCorrect, isKeyLetter, keyLabel,
  $, show, toast, escapeHtml
} from "./common.js";

const scr = {
  join:     $("#scr-join"),
  wait:     $("#scr-wait"),
  question: $("#scr-question"),
  reveal:   $("#scr-reveal"),
  final:    $("#scr-final"),
  error:    $("#scr-error")
};

let uid        = null;
let me         = undefined;   // /players/{uid}；undefined = 還沒讀到，null = 還沒進場
let questions  = {};
let state      = null;
let doubles    = {};
let board      = null;        // /leaderboard（主持人每公布一題就更新一次）
let timeOffset = 0;
let renaming   = false;       // 已經進場、自己按了「改名」

let renderedQid = null;
let revealedQid = null;
let pending     = null;       // 按了選項但還沒確認的字母
let myAnswer    = null;       // /answers/{qid}/{uid}
let unsubMine = null, unsubKey = null, unsubStats = null, unsubRevMine = null;
let tickTimer = null;

function goto(name) {
  for (const [k, el] of Object.entries(scr)) show(el, k === name);
  show($("#idbar"), !!me && name !== "join");
}

function fail(err) {
  console.error(err);
  $("#err-msg").textContent =
    "無法連上伺服器（" + (err?.code || err?.message || "unknown") + "）。請確認網路，或通知工作人員。";
  goto("error");
}

// ------------------------------------------------------------
//  啟動：先匿名登入，才有身分可以寫答案
// ------------------------------------------------------------
(async function boot() {
  goto("wait");
  try {
    uid = (await ensureAnonAuth()).uid;
  } catch (e) {
    $("#err-msg").textContent =
      e?.code === "auth/operation-not-allowed" || e?.code === "auth/admin-restricted-operation"
        ? "Firebase 尚未啟用「匿名」登入方式。請到 Firebase 主控台 → Authentication → 登入方式 啟用匿名登入。"
        : "無法建立連線（" + (e?.code || e?.message) + "）。";
    goto("error");
    return;
  }
  attach();
})();

function attach() {
  onValue(ref(db, "/.info/serverTimeOffset"), s => { timeOffset = s.val() || 0; });
  onValue(ref(db, `${PATH.players}/${uid}`), s => {
    const was = me;
    me = s.val();
    // 原本在場上、突然不見了 → 被主持人移出名單
    if (was && !me) toast("你已被移出名單，請重新輸入暱稱", 3500);
    render();
  }, fail);
  onValue(ref(db, PATH.questions),   s => { questions = s.val() || {}; render(); }, fail);
  onValue(ref(db, PATH.doubles),     s => { doubles   = s.val() || {}; render(); }, fail);
  onValue(ref(db, PATH.leaderboard), s => { board     = s.val();       paintRanks(); }, () => {});
  onValue(ref(db, PATH.state),       s => { state     = s.val() || {}; render(); }, fail);
}

// ------------------------------------------------------------
//  進場：輸入暱稱
// ------------------------------------------------------------
const inName = $("#in-name");
inName.addEventListener("input", () => { $("#btn-join").disabled = !cleanName(inName.value); });
inName.addEventListener("keydown", e => { if (e.key === "Enter" && !$("#btn-join").disabled) join(); });
$("#btn-join").addEventListener("click", join);

async function join() {
  const name = cleanName(inName.value);
  if (!name) return;
  $("#btn-join").disabled = true;
  const first = !me;     // 寫進去之後 me 會馬上被監聽更新，要先記下來
  try {
    await set(ref(db, `${PATH.players}/${uid}`), { name, at: me?.at || serverTimestamp() });
    renaming = false;
    inName.blur();
    toast(first ? "嗨，" + name + "！等主持人出題 ✦" : "暱稱已改成 " + name);
  } catch (e) {
    console.error(e);
    toast("進場失敗，請再試一次");
  } finally {
    $("#btn-join").disabled = !cleanName(inName.value);
  }
}

$("#btn-rename").addEventListener("click", () => {
  renaming = true;
  inName.value = me?.name || "";
  $("#btn-join").disabled = !cleanName(inName.value);
  $("#btn-join").textContent = "儲存暱稱";
  goto("join");
  inName.focus();
});

// ------------------------------------------------------------
//  主畫面切換
// ------------------------------------------------------------
/** 題目在「當前題庫」中的序號 */
function questionNo(qid) {
  const list = questionsOf(questions, state?.list || LISTS.MAIN);
  const i = list.findIndex(q => q.id === qid);
  return i < 0 ? "?" : i + 1;
}

function render() {
  if (!state || !uid || me === undefined) return;

  if (!me || renaming) {
    if (!me) { renaming = false; $("#btn-join").textContent = "進場 →"; }
    detachLive(); detachReveal();
    renderedQid = null;
    goto("join");
    return;
  }
  $("#id-name").textContent = me.name;

  const phase = state.phase || PHASE.IDLE;
  const qid   = state.qid || null;
  const q     = qid ? questions[qid] : null;

  if (phase !== PHASE.REVEAL || qid !== revealedQid) detachReveal();
  if (phase !== PHASE.OPEN && phase !== PHASE.LOCKED) { detachLive(); renderedQid = null; }

  if (phase === PHASE.FINAL) { renderFinal(); return; }
  if ((phase === PHASE.OPEN || phase === PHASE.LOCKED) && q) { renderQuestion(qid, q, phase); return; }
  if (phase === PHASE.REVEAL && q) { renderReveal(qid, q); return; }

  $("#wait-title").textContent = "等待主持人出題";
  $("#wait-msg").textContent = phase === PHASE.IDLE
    ? "請把手機拿好，題目馬上就來 ✦"
    : "等待主持人操作…";
  show($("#wait-double"), state.pendingDouble === uid);
  goto("wait");
  paintRanks();
}

// ------------------------------------------------------------
//  作答畫面
// ------------------------------------------------------------
function detachLive() {
  if (unsubMine) { unsubMine(); unsubMine = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  myAnswer = null;
}

function renderQuestion(qid, q, phase) {
  const locked = phase === PHASE.LOCKED;

  if (renderedQid !== qid) {
    detachLive();
    renderedQid = qid;
    pending = null;
    $("#q-no").textContent   = questionNo(qid);
    $("#q-text").textContent = q.text || "";

    const pts = ptsOf(q);
    $("#q-pts").textContent = "+" + pts;
    $("#q-pts").style.display = pts !== 1 ? "" : "none";

    const box = $("#opts");
    box.innerHTML = "";
    for (const L of LETTERS) {
      const label = q[L.toLowerCase()];
      if (!label) continue;
      const btn = document.createElement("button");
      btn.className = "opt";
      btn.dataset.letter = L;
      btn.innerHTML = `<span class="letter">${L}</span><span class="label">${escapeHtml(label)}</span>`;
      btn.addEventListener("click", () => pick(qid, L));
      box.appendChild(btn);
    }

    // 自己的答案讀得回來（規則只放行本人），重新整理也記得選了什麼
    unsubMine = onValue(ref(db, `${PATH.answers}/${qid}/${uid}`), s => {
      myAnswer = s.val();
      paintButtons(qid, (state?.phase || "") !== PHASE.OPEN);
    }, () => {});

    startCountdown();
  }

  $("#q-x2").style.display = doubles[qid] === uid ? "" : "none";
  paintButtons(qid, locked);
  show($("#tag-open"), !locked);
  show($("#tag-lock"), locked);
  goto("question");
}

function paintButtons(qid, locked) {
  const sent = LETTERS.includes(myAnswer?.c) ? myAnswer.c : null;
  const mine = sent || pending;

  for (const btn of $("#opts").children) {
    const L = btn.dataset.letter;
    btn.classList.toggle("picked", L === mine);
    btn.classList.toggle("confirmed", !!sent && L === sent);
    btn.disabled = locked || !!sent;
  }

  const b = $("#btn-confirm");
  b.disabled = locked || !!sent || !pending;
  b.innerHTML = sent ? `已送出 <b>${sent}</b>` : `確認送出 <b>${pending || "—"}</b>`;
  show($("#confirm-box"), !locked || !!sent);

  $("#q-hint").textContent = sent
    ? `已送出 ${sent}，等待主持人公布答案。`
    : locked ? "已截止作答，這題你沒有送出。"
    : pending ? "確定的話就按「確認送出」—— 送出後不能更改，越快送出越好。"
    : "選一個答案，再按確認送出。";
}

function pick(qid, letter) {
  if ((state?.phase || "") !== PHASE.OPEN || state?.qid !== qid) { toast("已截止作答"); return; }
  if (myAnswer?.c) { toast("已經送出，不能更改"); return; }
  pending = letter;
  paintButtons(qid, false);
}

$("#btn-confirm").addEventListener("click", async () => {
  const qid = state?.qid;
  if (!qid || !pending || myAnswer?.c) return;
  if (state?.phase !== PHASE.OPEN) { toast("已截止作答"); return; }

  const b = $("#btn-confirm");
  b.disabled = true;
  try {
    // t 由伺服器蓋時間戳（規則強制 t === now），作答秒數才沒辦法造假
    await set(ref(db, `${PATH.answers}/${qid}/${uid}`), { c: pending, t: serverTimestamp() });
    toast("已送出 " + pending);
  } catch (e) {
    console.error(e);
    toast("送出失敗：可能已經截止了");
    paintButtons(qid, state?.phase !== PHASE.OPEN);
  }
});

// ---------- 倒數 ----------
function startCountdown() {
  if (tickTimer) clearInterval(tickTimer);
  const paint = () => {
    const left = secondsLeft(state?.openedAt, state?.limitSec || DEFAULT_LIMIT_SEC, timeOffset);
    const el = $("#q-timer");
    if (left === null || state?.phase !== PHASE.OPEN) {
      el.textContent = state?.phase === PHASE.LOCKED ? "0" : "–";
      el.className = "timer";
      return;
    }
    el.textContent = left;
    el.className = "timer" + (left <= 5 ? " danger" : left <= 10 ? " warn" : "");
  };
  paint();
  tickTimer = setInterval(paint, 250);
}

// ------------------------------------------------------------
//  公布答案
// ------------------------------------------------------------
function detachReveal() {
  if (unsubKey)     { unsubKey();     unsubKey = null; }
  if (unsubStats)   { unsubStats();   unsubStats = null; }
  if (unsubRevMine) { unsubRevMine(); unsubRevMine = null; }
  revealedQid = null;
}

function renderReveal(qid, q) {
  goto("reveal");
  paintRanks();
  if (revealedQid === qid) return;
  revealedQid = qid;

  $("#r-no").textContent = questionNo(qid);

  let key = null, mine = null, stats = null;

  const repaint = () => {
    const k = key || stats?.key || null;
    $("#r-letter").textContent = k ? keyLabel(k) : "—";
    $("#r-letter").classList.toggle("all", isAllKey(k));
    $("#r-opt").textContent = isAllKey(k) ? "這題選哪個都算對！"
                            : k ? (q[k.toLowerCase()] || "").trim() : "";

    const pts = doubles[qid] === uid ? ptsOf(q) * 2 : ptsOf(q);
    const v = $("#r-verdict");
    const ms = elapsedMs(mine, stats?.openedAt);
    if (!mine?.c) {
      v.className = "verdict"; v.textContent = "這題你沒有作答";
      $("#r-sub").textContent = "";
    } else if (k && isCorrect(mine.c, k)) {
      v.className = "verdict ok"; v.textContent = `答對了！+${pts} 分`;
      $("#r-sub").textContent = `作答時間 ${fmtSec(ms)}` + (doubles[qid] === uid ? "　（轉盤 ×2）" : "");
    } else {
      v.className = "verdict bad"; v.textContent = `你選了 ${mine.c}`;
      $("#r-sub").textContent = "下一題再拚！";
    }

    const t = stats || { A: 0, B: 0, C: 0, D: 0, total: 0 };
    $("#r-total").textContent = `${t.total || 0} 人作答`;
    $("#r-bars").innerHTML = LETTERS
      .filter(L => q[L.toLowerCase()])
      .map(L => {
        const n = t[L] || 0, pct = t.total ? Math.round(n / t.total * 100) : 0;
        return `<div class="bar-row">
          <span class="bar-key">${L}</span>
          <span class="bar-track"><span class="bar-fill${k && isKeyLetter(L, k) ? " is-correct" : ""}" style="width:${pct}%"></span></span>
          <span class="bar-num">${pct}%（${n}）</span>
        </div>`;
      }).join("");
  };

  repaint();
  // 正解：安全性規則規定「已公布」才讀得到
  unsubKey     = onValue(ref(db, `${PATH.answerKey}/${qid}`), s => { key = s.val(); repaint(); }, () => {});
  unsubStats   = onValue(ref(db, `${PATH.stats}/${qid}`),     s => { stats = s.val(); repaint(); }, () => {});
  unsubRevMine = onValue(ref(db, `${PATH.answers}/${qid}/${uid}`), s => { mine = s.val(); repaint(); }, () => {});
}

// ------------------------------------------------------------
//  名次（等待畫面、公布畫面、身分列共用）
// ------------------------------------------------------------
function myRow() {
  const rows = board?.rows || [];
  const i = rows.findIndex(r => r.uid === uid);
  return i < 0 ? null : { ...rows[i], rank: rows[i].rank || i + 1, total: rows.length };
}

function paintRanks() {
  const r = myRow();
  $("#id-score").textContent = (r?.points || 0) + " 分";

  // 正式題至少公布過一題才有名次可言
  const has = !!r && (board?.questions || 0) > 0;
  const note = r ? `${r.points} 分・答對 ${r.correct} 題　共 ${r.total} 人` : "";

  show($("#wait-rank"), has);
  if (has) {
    $("#wait-rank-no").textContent = `第 ${r.rank} 名`;
    $("#wait-rank-note").textContent = note;
  }
  show($("#r-rank"), has);
  if (has) {
    $("#r-rank-no").textContent = `第 ${r.rank} 名`;
    $("#r-rank-note").textContent = note;
  }
  if ((state?.phase || "") === PHASE.FINAL) renderFinal();
}

// ------------------------------------------------------------
//  最終排行榜
// ------------------------------------------------------------
function renderFinal() {
  goto("final");
  const rows = board?.rows || [];
  const top = rows.slice(0, 3);

  $("#final-rows").innerHTML = top.length
    ? top.map((r, i) => `<tr class="${i === 0 ? "top1" : ""}">
        <td>${["🥇", "🥈", "🥉"][(r.rank || i + 1) - 1] || r.rank}</td>
        <td>${escapeHtml(r.name)}${r.uid === uid ? " ←" : ""}</td>
        <td class="n">${r.points}</td>
        <td class="n">${r.correct}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" style="color:#a9bce8;">主持人尚未產生排行榜</td></tr>`;

  const r = myRow();
  show($("#final-me"), !!r);
  if (!r) return;
  $("#final-me-no").textContent = `第 ${r.rank} 名`;
  $("#final-me-note").textContent =
    `${r.points} 分・答對 ${r.correct} 題・答對題目共花 ${fmtSec(r.timeMs)}　（共 ${r.total} 人）`;
}
