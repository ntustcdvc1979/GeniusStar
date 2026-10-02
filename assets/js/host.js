// ============================================================
//  主持人控制台
// ============================================================

import {
  db, auth, ref, onValue, set, update, remove, serverTimestamp,
  signInWithGoogle, consumeRedirectResult, authErrorText, signOut, onAuthStateChanged,
  PATH, PHASE, LISTS, LIST_LABEL, LETTERS, DEFAULT_LIMIT_SEC,
  categoryOf, questionsOf, tally, secondsLeft, ptsOf, elapsedMs, fmtSec,
  buildScoreboard, ranksOf, categoryChampions, bestCategoryOf, fastestCorrect, openedAtOf,
  isHost, notHostHtml, $, show, toast, escapeHtml,
  wheelPool, randomIndex, playerUrl, qrDataUrl
} from "./common.js";

let players = {}, questions = {}, keys = {}, answers = {}, stats = {}, state = {}, doubles = {}, opened = {};
let curQid = null, curList = LISTS.MAIN;
let booted = false, timeOffset = 0;
let autoLocked = null;      // 已經自動截止過的題目，避免重複寫入

const PHASE_LABEL = {
  [PHASE.IDLE]:   ["待機中", "pill"],
  [PHASE.OPEN]:   ["開放作答中", "pill live"],
  [PHASE.LOCKED]: ["已截止，尚未公布", "pill lock"],
  [PHASE.REVEAL]: ["已公布答案", "pill live"],
  [PHASE.FINAL]:  ["已公布排行榜", "pill live"]
};

// ------------------------------------------------------------
//  登入
// ------------------------------------------------------------
consumeRedirectResult().then(e => { if (e) $("#login-msg").textContent = authErrorText(e); });

$("#btn-login").addEventListener("click", async () => {
  $("#btn-login").disabled = true;
  $("#login-msg").textContent = "登入中…";
  try { await signInWithGoogle(); }
  catch (e) { $("#login-msg").textContent = authErrorText(e); }
  finally { $("#btn-login").disabled = false; }
});

onAuthStateChanged(auth, async user => {
  const ok = await isHost(user);
  show($("#scr-login"),   !ok);
  show($("#scr-console"),  ok);

  if (user && !user.isAnonymous && !ok) {
    $("#login-msg").innerHTML = notHostHtml(user);
    await signOut(auth);
    return;
  }
  if (ok) {
    $("#tag-who").textContent = user.email;
    if (!booted) { booted = true; attach(); }
  }
});

$("#btn-logout").addEventListener("click", () => signOut(auth).then(() => location.reload()));

// ------------------------------------------------------------
//  資料監聽（登入後才掛，否則會被安全性規則擋下）
// ------------------------------------------------------------
function attach() {
  onValue(ref(db, "/.info/serverTimeOffset"), s => { timeOffset = s.val() || 0; });
  onValue(ref(db, PATH.players),   s => { players = s.val() || {}; paint(); });
  onValue(ref(db, PATH.answerKey), s => { keys    = s.val() || {}; paint(); });
  onValue(ref(db, PATH.answers),   s => { answers = s.val() || {}; paint(); });
  onValue(ref(db, PATH.stats),     s => { stats   = s.val() || {}; paint(); });
  onValue(ref(db, PATH.doubles),   s => { doubles = s.val() || {}; paint(); });
  onValue(ref(db, PATH.opened),    s => { opened  = s.val() || {}; paint(); });
  onValue(ref(db, PATH.state),     s => { state   = s.val() || {}; syncFromState(); paint(); });
  onValue(ref(db, PATH.questions), s => { questions = s.val() || {}; paintQuestionSelect(); paint(); });
  setInterval(tickTimer, 250);
}

function syncFromState() {
  if (state.list && state.list !== curList) { curList = state.list; paintQuestionSelect(); }
  // 直接照 state.qid 對齊 —— openQuestion() 會先把 curQid 設好再寫進資料庫，
  // 拿 curQid 當守門員的話下拉選單就永遠不會更新
  if (state.qid) {
    curQid = state.qid;
    const sel = $("#sel-q");
    if (sel.value !== curQid && sel.querySelector(`option[value="${CSS.escape(curQid)}"]`)) {
      sel.value = curQid;
    }
  }
  $("#sel-list").value         = curList;
  $("#in-limit").value         = state.limitSec ?? DEFAULT_LIMIT_SEC;
  $("#in-shownames").checked   = state.showNames !== false;
}

const qList  = () => questionsOf(questions, curList);
const qIndex = qid => qList().findIndex(q => q.id === qid);

function paintQuestionSelect() {
  const list = qList();
  $("#sel-q").innerHTML = list.length
    ? list.map((q, i) => `<option value="${escapeHtml(q.id)}">第 ${i + 1} 題　${escapeHtml((q.text || "").slice(0, 24))}</option>`).join("")
    : `<option value="">（這個題庫還沒有題目）</option>`;
  if (!list.some(q => q.id === curQid)) curQid = list[0]?.id || null;
  if (curQid) $("#sel-q").value = curQid;
}

// ------------------------------------------------------------
//  設定
// ------------------------------------------------------------
$("#sel-list").addEventListener("change", async () => {
  curList = $("#sel-list").value === LISTS.DEMO ? LISTS.DEMO : LISTS.MAIN;
  paintQuestionSelect();
  await update(ref(db, PATH.state), { list: curList, qid: curQid || null, phase: PHASE.IDLE });
  toast("已切換到 " + LIST_LABEL[curList]);
});

$("#sel-q").addEventListener("change", async () => {
  curQid = $("#sel-q").value;
  await update(ref(db, PATH.state), { qid: curQid, phase: PHASE.IDLE });
  paint();
});

$("#in-limit").addEventListener("change", async () => {
  const v = Math.max(5, Math.min(600, Number($("#in-limit").value) || DEFAULT_LIMIT_SEC));
  $("#in-limit").value = v;
  await update(ref(db, PATH.state), { limitSec: v });
});

$("#in-shownames").addEventListener("change", async () => {
  await update(ref(db, PATH.state), { showNames: $("#in-shownames").checked });
});

// ------------------------------------------------------------
//  控制動作
// ------------------------------------------------------------
$("#btn-open").addEventListener("click", () => openQuestion(curQid));
$("#btn-lock").addEventListener("click", () => update(ref(db, PATH.state), { phase: PHASE.LOCKED }));
$("#btn-idle").addEventListener("click", () => update(ref(db, PATH.state), { phase: PHASE.IDLE }));
$("#btn-reveal").addEventListener("click", doReveal);
$("#btn-final").addEventListener("click", doFinal);

// ---- 加倍轉盤 ----
$("#btn-wheel").addEventListener("click", async () => {
  // 抽過的人不再放進轉盤；全部抽完會自動重開一輪
  const pool = wheelPool(players, doubles);
  if (!pool.length) { toast("還沒有玩家進場"); return; }

  // 由主持人端抽，寫進 state 讓投影幕轉到同一個人 —— 各個畫面才會一致
  const pick = pool[randomIndex(pool.length)];
  await update(ref(db, PATH.state), {
    pendingDouble: pick.id,
    wheel: { id: Date.now(), uid: pick.id }
  });
  toast(`轉盤：${pick.name} 下一題 ×2（還沒抽過的剩 ${pool.length - 1} 人）`);
});

$("#btn-wheel-clear").addEventListener("click", async () => {
  // 取消要取得乾淨：待生效的、已經蓋在本題上的、還有投影幕上的轉盤都要收掉
  await update(ref(db, PATH.state), { pendingDouble: null, wheel: null });
  if (curQid) await remove(ref(db, `${PATH.doubles}/${curQid}`));
  toast("已取消加倍");
});

// ---- 投影幕翻頁 ----
//  控制台只寫 state.nav = { id, dir }，真正翻頁的是投影頁 ——
//  跟在投影機那台按 → / ← 走的是同一條路。
$("#btn-page-prev").addEventListener("click", () => navScreen(-1));
$("#btn-page-next").addEventListener("click", () => navScreen(+1));

async function navScreen(dir) {
  await update(ref(db, PATH.state), { nav: { id: Date.now(), dir } });
}

// 出題／截止中投影幕沒有分頁，翻頁鈕就先關起來
const PAGED_PHASES = [PHASE.IDLE, PHASE.REVEAL, PHASE.FINAL];

function paintPageNav() {
  const phase = state.phase || PHASE.IDLE;
  const paged = PAGED_PHASES.includes(phase);
  const where = (state.screenPage || "").trim();

  const tag = $("#page-tag");
  tag.textContent = paged ? (where || "投影幕還沒連上") : "這個階段沒有分頁";
  tag.className   = paged && where ? "pill live" : "pill";

  $("#btn-page-prev").disabled = !paged;
  $("#btn-page-next").disabled = !paged;

  $("#page-hint").textContent = paged
    ? (phase === PHASE.FINAL ? "排行榜是一次揭曉一個名次，按「下一頁」往下跑。" : "")
    : "出題與截止中投影幕只有一頁，公布答案或回到待機之後才翻得動。";
}

// ---- 投影幕播放（鐘聲／健康操） ----
const CUE_LABEL = {
  bell:     { name: "上／下課鐘聲", icon: "🔔" },
  exercise: { name: "健康操",       icon: "🤸" }
};

for (const kind of Object.keys(CUE_LABEL)) {
  $(`#btn-cue-${kind}`).addEventListener("click", () => toggleCue(kind));
}

async function toggleCue(kind) {
  if (state.cue?.kind === kind) {                // 再按一次同一顆 = 喊停
    await update(ref(db, PATH.state), { cue: null });
    toast(`已停止${CUE_LABEL[kind].name}`);
    return;
  }
  await update(ref(db, PATH.state), { cue: { id: Date.now(), kind } });
  toast(`投影幕播放：${CUE_LABEL[kind].name}`);
}

function paintCue() {
  const playing = state.cue?.kind || null;
  const tag = $("#cue-tag");
  if (playing) { tag.textContent = "播放中：" + CUE_LABEL[playing].name; tag.className = "pill live"; }
  else         { tag.textContent = "沒有在播"; tag.className = "pill"; }

  for (const [kind, { name, icon }] of Object.entries(CUE_LABEL)) {
    const btn = $(`#btn-cue-${kind}`);
    const on  = playing === kind;
    btn.textContent = on ? `⏹ 停止${name}` : `${icon} ${name}`;
    btn.className   = on ? "btn" : "btn ghost";
  }
}

$("#btn-prev").addEventListener("click", () => step(-1));
$("#btn-next").addEventListener("click", () => step(+1));

async function step(dir) {
  const list = qList();
  const i = qIndex(curQid);
  const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
  if (!next) return;
  if (next.id === curQid && i >= 0) { toast(dir > 0 ? "已經是最後一題" : "已經是第一題"); return; }
  await openQuestion(next.id);
}

async function openQuestion(qid) {
  if (!qid) { toast("請先選擇題目"); return; }
  const n = Object.keys(answers[qid] || {}).length;
  if (n && !confirm(`這題已經有 ${n} 人作答過了。
重新出題會再倒數一次，但已經送出的人不能改答案，作答秒數仍從第一次出題算起。

要整題重來請先按「清除本題作答」。確定要重新出題嗎？`)) return;
  curQid = qid;
  autoLocked = null;
  {
    const sel = $("#sel-q");
    if (sel.querySelector(`option[value="${CSS.escape(qid)}"]`)) sel.value = qid;
  }

  // 轉盤抽到的加倍在這裡蓋章到這一題，然後就用掉了
  const dbl = state.pendingDouble || null;
  if (dbl) {
    await set(ref(db, `${PATH.doubles}/${qid}`), dbl);
    toast((players[dbl]?.name || "某人") + " 這題 ×2");
  }

  // 作答秒數從「第一次」出題算起 —— 重新出題不能讓先前送出的人變成 0 秒
  if (!opened[qid]) await set(ref(db, `${PATH.opened}/${qid}`), serverTimestamp());

  await update(ref(db, PATH.state), {
    pendingDouble: null,
    qid,
    list: curList,
    phase: PHASE.OPEN,
    openedAt: serverTimestamp(),
    limitSec: Math.max(5, Number($("#in-limit").value) || DEFAULT_LIMIT_SEC)
  });
  toast("第 " + (qIndex(qid) + 1) + " 題　開始倒數");
}

// ------------------------------------------------------------
//  排行榜：每公布一題就算一次寫進 /leaderboard，玩家手機就看得到自己的名次
// ------------------------------------------------------------
/** 這題第一次出題的時間（舊資料沒有 /opened 就退回 state 或統計裡的） */
function openedAtFor(qid) {
  return opened[qid] || stats[qid]?.openedAt || (state.qid === qid && state.openedAt) || null;
}

function computeBoard(extraRevealed = {}, extraOpened = {}) {
  return buildScoreboard(
    players, questions, keys, answers,
    { ...(state.revealed || {}), ...extraRevealed },
    LISTS.MAIN, doubles,
    { ...openedAtOf(stats), ...extraOpened });
}

async function publishBoard(board, final) {
  const ranks = ranksOf(board.rows);
  const rows = board.rows.map((r, i) => {
    const { byCat, ...rest } = r;          // byCat 不用送到玩家端
    const best = bestCategoryOf(r, board.cats);
    return best
      ? { ...rest, rank: ranks[i], bestCat: best.cat.id, bestCatPoints: best.points, bestCatMax: best.max }
      : { ...rest, rank: ranks[i] };
  });
  await set(ref(db, PATH.leaderboard), {
    updatedAt: Date.now(), final: !!final, questions: board.questionCount, rows
  });
}

/** 公布答案：先算好統計寫進 /stats，再把這題標記為已公布 */
async function doReveal() {
  const qid = curQid;
  if (!qid) return;
  const key = keys[qid];
  if (!key) { toast("這題還沒設定正解，請先到後台補上"); return; }

  const openedAt = openedAtFor(qid);
  const t = tally(answers[qid]);
  const fastest = fastestCorrect(players, answers[qid], key, openedAt)
    .slice(0, 5)
    .map(f => ({ uid: f.uid, name: f.name, ms: f.ms ?? 0 }));

  await set(ref(db, `${PATH.stats}/${qid}`), {
    ...t, key, correct: t[key] || 0, openedAt, fastest
  });
  await update(ref(db, PATH.state), { phase: PHASE.REVEAL, qid, [`revealed/${qid}`]: true });

  if (questions[qid] && (questions[qid].list || LISTS.MAIN) === LISTS.MAIN) {
    await publishBoard(computeBoard({ [qid]: true }, { [qid]: openedAt }), false);
  }
  toast("已公布答案：" + key);
}

/** 結束：算出最終排行榜，投影幕與玩家手機都會切過去 */
async function doFinal() {
  if (!confirm("要結束遊戲並公布最終排行榜嗎？")) return;
  await publishBoard(computeBoard(), true);
  await update(ref(db, PATH.state), { phase: PHASE.FINAL });
  toast("排行榜已公布");
}

$("#btn-clear-q").addEventListener("click", async () => {
  const qid = curQid;
  if (!qid) return;
  if (!confirm(`清除第 ${qIndex(qid) + 1} 題的所有作答，讓這題可以重來？`)) return;
  await Promise.all([
    remove(ref(db, `${PATH.answers}/${qid}`)),
    remove(ref(db, `${PATH.stats}/${qid}`)),
    remove(ref(db, `${PATH.opened}/${qid}`)),
    remove(ref(db, `${PATH.doubles}/${qid}`)),
    remove(ref(db, `${PATH.state}/revealed/${qid}`))
  ]);
  await update(ref(db, PATH.state), { phase: PHASE.IDLE });
  // 這題的分數拿掉之後，玩家手機上的名次也要跟著更新
  const { [qid]: _, ...rest } = state.revealed || {};
  await publishBoard(buildScoreboard(players, questions, keys, answers, rest, LISTS.MAIN, doubles,
    openedAtOf(stats)), false);
  toast("已清除本題");
});

$("#btn-reset").addEventListener("click", async () => {
  if (!confirm("確定清除「所有」作答紀錄、統計與排行榜？玩家名單會保留。此動作無法復原。")) return;
  if (!confirm("再確認一次：所有人的答案都會消失。")) return;
  await Promise.all([
    remove(ref(db, PATH.answers)),
    remove(ref(db, PATH.stats)),
    remove(ref(db, PATH.opened)),
    remove(ref(db, PATH.doubles)),
    remove(ref(db, PATH.leaderboard)),
    set(ref(db, PATH.state), {
      phase: PHASE.IDLE, list: curList, qid: curQid || null, revealed: null,
      limitSec: Number($("#in-limit").value) || DEFAULT_LIMIT_SEC,
      showNames: $("#in-shownames").checked
    })
  ]);
  toast("已清除");
});

$("#btn-clear-p").addEventListener("click", async () => {
  const n = Object.keys(players).length;
  if (!confirm(`清空玩家名單（目前 ${n} 人）？所有人的手機都會回到輸入暱稱的畫面。`)) return;
  await remove(ref(db, PATH.players));
  await update(ref(db, PATH.state), { pendingDouble: null, wheel: null });
  toast("已清空玩家名單");
});

// ------------------------------------------------------------
//  倒數：歸零就自動截止（由控制台負責寫，投影頁只是顯示）
// ------------------------------------------------------------
function tickTimer() {
  const el = $("#tag-timer");
  const phase = state.phase || PHASE.IDLE;

  if (phase !== PHASE.OPEN) {
    el.textContent = phase === PHASE.LOCKED ? "0" : "–";
    el.className = "timer";
    return;
  }
  const left = secondsLeft(state.openedAt, state.limitSec || DEFAULT_LIMIT_SEC, timeOffset);
  el.textContent = left ?? "–";
  el.className = "timer" + (left <= 5 ? " danger" : left <= 10 ? " warn" : "");

  if (left === 0 && autoLocked !== state.qid) {
    autoLocked = state.qid;
    update(ref(db, PATH.state), { phase: PHASE.LOCKED }).catch(() => {});
  }
}

// ------------------------------------------------------------
//  畫面
// ------------------------------------------------------------
function paint() {
  const phase = state.phase || PHASE.IDLE;
  const [label, cls] = PHASE_LABEL[phase] || PHASE_LABEL[PHASE.IDLE];
  $("#tag-phase").textContent = label;
  $("#tag-phase").className   = cls;

  const qid = curQid;
  const q   = qid ? questions[qid] : null;
  const key = qid ? keys[qid] : null;

  const cat = categoryOf(q?.cat);
  $("#live-cat").textContent = q ? cat.name : "—";
  $("#live-cat").style.setProperty("--cat", cat.color);

  $("#live-q").textContent = q
    ? `第 ${qIndex(qid) + 1} 題${ptsOf(q) !== 1 ? `（本題 +${ptsOf(q)}）` : ""}　${q.text || ""}`
    : "尚未選擇題目";
  $("#live-key").textContent = key || "（未設定）";

  const nPlayers = Object.keys(players).length;
  const t = tally(answers[qid]);
  $("#live-count").textContent = `已送出 ${t.total} / ${nPlayers} 人`;
  $("#live-bars").innerHTML = bars(q, t, key);

  const openedAt = openedAtFor(qid);
  const fast = fastestCorrect(players, answers[qid], key, openedAt).slice(0, 5);
  $("#live-fast").innerHTML = fast.length
    ? fast.map(f => `<li>${escapeHtml(f.name)}<small>${fmtSec(f.ms)}</small></li>`).join("")
    : `<li class="hint" style="list-style:none; margin-left:-1.4em; text-align:left;">還沒有人答對</li>`;

  // 排行榜
  const board = computeBoard();
  const ranks = ranksOf(board.rows);
  const top = board.rows.slice(0, 30);
  $("#rank-note").textContent = board.rows.length > 30 ? `顯示前 30 名，共 ${board.rows.length} 人` : "";
  $("#rank-rows").innerHTML = top.length
    ? top.map((r, i) => {
        const a = answers[qid]?.[r.uid];
        const now = LETTERS.includes(a?.c)
          ? `${a.c}${key && a.c === key ? " ✓" : ""}<small style="opacity:.6"> ${fmtSec(elapsedMs(a, openedAt))}</small>`
          : "–";
        return `<tr class="${i === 0 && r.points ? "top1" : ""}">
          <td>${ranks[i]}</td>
          <td>${escapeHtml(r.name)}${doubles[qid] === r.uid ? " 🎡" : ""}</td>
          <td class="n">${r.points}</td>
          <td class="n">${r.correct}</td>
          <td class="n">${fmtSec(r.timeMs)}</td>
          <td class="n">${now}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:#a9bce8;">還沒有玩家進場</td></tr>`;

  const pending = state.pendingDouble;
  const thisQ   = qid ? doubles[qid] : null;
  const tag = $("#dbl-tag");
  if (pending)    { tag.textContent = "下一題 ×2：" + (players[pending]?.name || "?"); tag.className = "pill live"; }
  else if (thisQ) { tag.textContent = "本題 ×2："   + (players[thisQ]?.name   || "?"); tag.className = "pill live"; }
  else            { tag.textContent = "尚未抽"; tag.className = "pill"; }

  paintPageNav();
  paintCue();
  paintChamps(board);
  paintPlayers(board);
}

function bars(q, t, key) {
  if (!q) return `<p class="hint" style="text-align:left;">—</p>`;
  const total = t.total || 0;
  return LETTERS.filter(L => q[L.toLowerCase()]).map(L => {
    const n = t[L], pct = total ? Math.round(n / total * 100) : 0;
    return `<div class="bar-row">
      <span class="bar-key">${L}</span>
      <span class="bar-track"><span class="bar-fill${L === key ? " is-correct" : ""}" style="width:${pct}%"></span></span>
      <span class="bar-num">${n}（${pct}%）</span>
    </div>`;
  }).join("");
}

function paintChamps(board) {
  const champs = categoryChampions(board);
  $("#mx-champs").innerHTML = champs.length
    ? champs.map(({ cat, best }) => `
        <div class="row" style="align-items:center; gap:8px;">
          <span class="cat-pill" style="--cat:${cat.color}">${escapeHtml(cat.name)}</span>
          <span style="font-weight:800;">${best ? escapeHtml(best.name) : "—"}</span>
          <span style="color:var(--gold-lt); font-weight:800;">${best ? `${best.points}/${best.max}` : ""}</span>
        </div>`).join("")
    : `<p class="hint" style="text-align:left; margin:0;">還沒有已公布的正式題目。</p>`;
}

function paintPlayers(board) {
  const scoreOf = new Map(board.rows.map(r => [r.uid, r.points]));
  const list = Object.entries(players)
    .map(([uid, p]) => ({ uid, name: p?.name || "", at: p?.at || 0 }))
    .sort((a, b) => a.at - b.at);
  $("#p-count").textContent = list.length + " 人";

  const f = $("#p-filter").value.trim().toLowerCase();
  const shown = f ? list.filter(p => p.name.toLowerCase().includes(f)) : list;
  $("#p-list").innerHTML = shown.length
    ? shown.map(p => `<div class="pline" data-uid="${escapeHtml(p.uid)}">
        <span class="nm">${escapeHtml(p.name)}</span>
        <span class="sc">${scoreOf.get(p.uid) || 0} 分</span>
        <button class="btn ghost mini p-kick">移出</button>
      </div>`).join("")
    : `<p class="hint" style="text-align:left;">${list.length ? "沒有符合的暱稱" : "還沒有玩家進場。"}</p>`;
}

$("#p-filter").addEventListener("input", () => paintPlayers(computeBoard()));

$("#p-list").addEventListener("click", async e => {
  if (!e.target.classList.contains("p-kick")) return;
  const uid = e.target.closest("[data-uid]").dataset.uid;
  if (!confirm(`把「${players[uid]?.name}」移出名單？`)) return;
  await remove(ref(db, `${PATH.players}/${uid}`));
  toast("已移出");
});

// ------------------------------------------------------------
//  QR Code
// ------------------------------------------------------------
$("#btn-qr").addEventListener("click", async () => {
  $("#qr-url").textContent = playerUrl;
  show($("#qr-box"), true);
  try {
    $("#qr-img").src = await qrDataUrl(playerUrl, 8);
  } catch {
    $("#qr-url").textContent = "（QR 產生器載入失敗，請直接把網址給大家）\n" + playerUrl;
  }
});
$("#btn-qr-close").addEventListener("click", () => show($("#qr-box"), false));
