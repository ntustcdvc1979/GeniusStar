// ============================================================
//  題目後台
// ============================================================

import {
  db, auth, ref, onValue, set, update, remove,
  signInWithGoogle, consumeRedirectResult, authErrorText, signOut, onAuthStateChanged,
  PATH, LETTERS, LISTS, LIST_LABEL, ALL_CORRECT, isAllKey, keyLabel,
  listOf, questionsOf, parseBulkQuestions, exportQuestionsText, ptsOf,
  blocksOf, groupBlocks, isSoloMedia, videoEmbed, isVideoUrl, webpSrc, normalizeBlock,
  BLOCK_TYPES, BLOCK_SIZES, DEFAULT_BLOCK_SIZE,
  BLOCK_WIDTHS, BLOCK_ALIGNS,
  TEXT_SIZE_VH, IMG_SIZE_VH,
  $, show, toast, escapeHtml, isHost, notHostHtml
} from "./common.js";

let questions = {}, keys = {}, intro = {};
let editing = null;            // 正在編輯的題目 id；"new" 代表新增
let booted = false;
let curList = LISTS.MAIN;      // 正在編輯哪個題庫
let edBlocks = [];             // 編輯中的說明排版區塊

$("#sel-list").addEventListener("change", () => {
  curList = $("#sel-list").value === LISTS.DEMO ? LISTS.DEMO : LISTS.MAIN;
  closeEditor();
});

/** 預覽圖一律先試 .webp，載不到再退回原本填的路徑 */
function setImg(el, url) {
  const web = webpSrc(url);
  el.onerror = () => { el.onerror = null; if (web !== url) el.src = url; };
  el.src = web;
}

// 開場畫面：主視覺、開場影片、規則圖（都是選填，留空就用內建的）
for (const id of ["heroimg", "rulesimg"]) {
  $(`#in-${id}`).addEventListener("input", () => paintIntroPreview(id));
}
function paintIntroPreview(id) {
  const url = $(`#in-${id}`).value.trim();
  show($(`#${id}-preview`), !!url);
  if (url) setImg($(`#${id}-preview-img`), url);
}
$("#btn-intro").addEventListener("click", async () => {
  const heroImg  = $("#in-heroimg").value.trim();
  const video    = $("#in-video").value.trim();
  const rulesImg = $("#in-rulesimg").value.trim();
  if (video && !isVideoUrl(video)) { toast("開場影片要填 .mp4 之類的影片檔，或 YouTube 網址"); return; }
  await set(ref(db, PATH.intro), { heroImg: heroImg || null, video: video || null, rulesImg: rulesImg || null });
  toast("已儲存開場畫面");
});

// 整頁大圖的預覽
$("#ed-eximgfull").addEventListener("input", paintPreview);
function paintPreview() {
  const full = $("#ed-eximgfull").value.trim();
  show($("#ed-preview-full"), !!full);
  if (!full) return;

  // 填影片就預覽播放器，填圖片就預覽圖
  const vid = isVideoUrl(full);
  show($("#ed-preview-full-img"), !vid);
  show($("#ed-preview-full-vid"), vid);
  if (vid) {
    const v = videoEmbed(full);
    $("#ed-preview-full-vid").innerHTML = v.kind === "embed"
      ? `<iframe src="${escapeHtml(v.src)}" title="整頁影片預覽" frameborder="0"
           style="width:100%;height:100%;border:0" allowfullscreen></iframe>`
      : `<video src="${escapeHtml(v.src)}" controls preload="metadata"
           style="width:100%;height:100%"></video>`;
  } else {
    $("#ed-preview-full-vid").innerHTML = "";   // 停掉可能還在播的影片
    setImg($("#ed-preview-full-img"), full);
  }
}

// 說明音檔的預覽
$("#ed-exaudio").addEventListener("input", paintAudioPreview);
function paintAudioPreview() {
  const url = $("#ed-exaudio").value.trim();
  show($("#ed-preview-aud"), !!url);
  const el = $("#ed-preview-aud-el");
  if (!url) { el.pause(); el.removeAttribute("src"); return; }
  if (el.getAttribute("src") !== url) { el.pause(); el.src = url; }
}

// ============================================================
//  說明頁的排版區塊
// ============================================================
const BLOCK_LABEL = Object.fromEntries(BLOCK_TYPES.map(b => [b.t, b.name]));

$("#blk-add-head").addEventListener("click", () => addBlock("head"));
$("#blk-add-text").addEventListener("click", () => addBlock("text"));
$("#blk-add-img").addEventListener("click",  () => addBlock("img"));
$("#blk-add-video").addEventListener("click", () => addBlock("video"));

function addBlock(t) {
  edBlocks.push(normalizeBlock({ t, v: "", w: "full", size: t === "head" ? 4 : DEFAULT_BLOCK_SIZE }));
  paintBlocks();
}

function paintBlocks() {
  $("#ed-blocks").innerHTML = edBlocks.map((b, i) => `
    <div class="blk" data-i="${i}">
      <div class="blkhead">
        <span class="kind">${BLOCK_LABEL[b.t]}</span>
        <select class="blk-w">
          ${BLOCK_WIDTHS.map(o => `<option value="${o.w}" ${
            b.w === o.w ? "selected" : ""}>${o.name}</option>`).join("")}
        </select>
        <select class="blk-size">
          ${BLOCK_SIZES.map(s => `<option value="${s}" ${b.size === s ? "selected" : ""}>${
            b.t === "img" ? "圖 " : "字 "}${s}</option>`).join("")}
        </select>
        <select class="blk-align">
          ${BLOCK_ALIGNS.map(o => `<option value="${o.a}" ${
            b.align === o.a ? "selected" : ""}>${o.name}</option>`).join("")}
        </select>
        <span style="flex:1 1 auto;"></span>
        <button class="btn ghost mini blk-up">↑</button>
        <button class="btn ghost mini blk-down">↓</button>
        <button class="btn danger mini blk-del">刪除</button>
      </div>
      ${b.t === "img"
        ? `<input class="blk-v" value="${escapeHtml(b.v)}" placeholder="https://… 或 assets/img/explain/檔名.webp">`
        : b.t === "video"
        ? `<input class="blk-v" value="${escapeHtml(b.v)}" placeholder="YouTube／Vimeo 網址，或 assets/video/檔名.mp4">`
        : `<textarea class="blk-v" placeholder="${b.t === "head" ? "小標題文字" : "說明內容，可以換行"}">${escapeHtml(b.v)}</textarea>`}
    </div>`).join("")
    || `<p class="hint" style="text-align:left;">還沒有任何區塊。用下面的按鈕加一個。</p>`;

  paintBlockPreview();
}

$("#ed-blocks").addEventListener("click", e => {
  const box = e.target.closest("[data-i]");
  if (!box) return;
  const i = Number(box.dataset.i);
  if (e.target.classList.contains("blk-del"))  { edBlocks.splice(i, 1); paintBlocks(); }
  else if (e.target.classList.contains("blk-up")   && i > 0)
    { [edBlocks[i - 1], edBlocks[i]] = [edBlocks[i], edBlocks[i - 1]]; paintBlocks(); }
  else if (e.target.classList.contains("blk-down") && i < edBlocks.length - 1)
    { [edBlocks[i + 1], edBlocks[i]] = [edBlocks[i], edBlocks[i + 1]]; paintBlocks(); }
});

$("#ed-blocks").addEventListener("input", e => {
  const box = e.target.closest("[data-i]");
  if (!box) return;
  const b = edBlocks[Number(box.dataset.i)];
  if (e.target.classList.contains("blk-v")) { b.v = e.target.value; paintBlockPreview(); }
});

$("#ed-blocks").addEventListener("change", e => {
  const box = e.target.closest("[data-i]");
  if (!box) return;
  const b = edBlocks[Number(box.dataset.i)];
  if (e.target.classList.contains("blk-w"))     b.w = e.target.value;
  if (e.target.classList.contains("blk-size"))  b.size = Number(e.target.value);
  if (e.target.classList.contains("blk-align")) b.align = e.target.value;
  if (e.target.classList.contains("blk-v"))     { b.v = e.target.value; paintBlocks(); return; }
  paintBlockPreview();
});

/** 用投影頁同一套 class 畫預覽，所見即所得 */
function paintBlockPreview() {
  const box = $("#ed-blkpreview");
  const live = edBlocks.filter(b => (b.v || "").trim());
  if (!live.length) {
    box.innerHTML = `<p class="empty">還沒有內容</p>`;
    return;
  }
  // 預覽框比投影幕小，字級等比例縮小。
  // 編輯區還沒顯示出來時量到的是 0，這時候先不要畫，等下一個影格再來。
  if (!box.clientHeight) { requestAnimationFrame(paintBlockPreview); return; }
  const k = box.clientHeight / (window.innerHeight || 900);
  const one = b => {
    const cls = `exblock ${b.w} ${b.align}`;
    if (b.t === "img") {
      return `<div class="${cls}"><img src="${escapeHtml(webpSrc(b.v))}"
        data-fallback="${webpSrc(b.v) !== b.v ? escapeHtml(b.v) : ""}" alt=""
        onerror="const f=this.dataset.fallback; if(f){this.dataset.fallback='';this.src=f;}"
        style="--ih:${(IMG_SIZE_VH[b.size] * k).toFixed(1)}vh"></div>`;
    }
    if (b.t === "video") {
      const v = videoEmbed(b.v);
      const inner = v.kind === "embed"
        ? `<iframe src="${escapeHtml(v.src)}" title="說明影片" frameborder="0" allowfullscreen></iframe>`
        : `<video src="${escapeHtml(v.src)}" controls preload="metadata"></video>`;
      return `<div class="${cls}"><div class="vidbox"
        style="--ih:${(IMG_SIZE_VH[b.size] * k).toFixed(1)}vh">${inner}</div></div>`;
    }
    const tag = b.t === "head" ? "h4" : "p";
    return `<${tag} class="${cls} ${b.t}" style="margin:0; font-size:${
      (TEXT_SIZE_VH[b.size] * k).toFixed(2)}vh">${escapeHtml(b.v)}</${tag}>`;
  };
  const norm = live.map(normalizeBlock);
  box.innerHTML = `<div class="exblocks${isSoloMedia(norm) ? " solo" : ""}">${groupBlocks(norm).map(r => r.auto
    ? `<div class="exrow ${r.align}">${r.items.map(one).join("")}</div>`
    : one(r.items[0])
  ).join("")}</div>`;
}

// ---------- 登入 ----------
onAuthStateChanged(auth, async user => {
  const ok = await isHost(user);
  show($("#scr-login"), !ok);
  show($("#scr-main"),   ok);

  if (user && !user.isAnonymous && !ok) {
    $("#login-msg").innerHTML = notHostHtml(user);
    await signOut(auth);
    return;
  }
  if (ok && !booted) { booted = true; attach(); }
});

consumeRedirectResult().then(e => { if (e) $("#login-msg").textContent = authErrorText(e); });

$("#btn-login").addEventListener("click", async () => {
  $("#btn-login").disabled = true;
  $("#login-msg").textContent = "登入中…";
  try {
    await signInWithGoogle();
  } catch (e) {
    $("#login-msg").textContent = authErrorText(e);
  } finally {
    $("#btn-login").disabled = false;
  }
});
$("#btn-logout").addEventListener("click", () => signOut(auth).then(() => location.reload()));

function attach() {
  onValue(ref(db, PATH.intro),     s => {
    intro = s.val() || {};
    $("#in-heroimg").value  = intro.heroImg  || "";
    $("#in-video").value    = intro.video    || "";
    $("#in-rulesimg").value = intro.rulesImg || "";
    paintIntroPreview("heroimg");
    paintIntroPreview("rulesimg");
  });
  onValue(ref(db, PATH.questions), s => { questions = s.val() || {}; paintQuestions(); });
  onValue(ref(db, PATH.answerKey), s => { keys      = s.val() || {}; paintQuestions(); });
}

const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ============================================================
//  題目
// ============================================================
async function swapOrder(path, a, b) {
  await update(ref(db, path), { [`${a.id}/order`]: b.order ?? 0, [`${b.id}/order`]: a.order ?? 0 });
}

/** 後台列出全部題目（含隱藏的備用題） */
const allOf = list => questionsOf(questions, list, { withHidden: true });

/** 這題在現場的題號（隱藏的備用題不佔題號，回傳 0） */
const liveNo = q => q.hidden ? 0 : questionsOf(questions, listOf(q)).findIndex(x => x.id === q.id) + 1;

function paintQuestions() {
  const list = allOf(curList);
  const nHidden = list.filter(q => q.hidden).length;
  const other = allOf(curList === LISTS.MAIN ? LISTS.DEMO : LISTS.MAIN).length;
  $("#q-count").textContent = `${LIST_LABEL[curList]} ${list.length - nHidden} 題`
    + (nHidden ? `＋備用 ${nHidden} 題` : "") + `（另一個題庫 ${other} 題）`;
  $("#sel-list").value = curList;

  $("#q-list").innerHTML = list.map(q => {
    const blks  = blocksOf(q);
    const hasEx = blks.length > 0 || !!(q.exImgFull || "").trim() || !!(q.exAudio || "").trim();
    const nImg  = blks.filter(b => b.t === "img").length;
    const nVid  = blks.filter(b => b.t === "video").length;
    return `
    <div class="qitem ${editing === q.id ? "editing" : ""}${q.hidden ? " is-hidden" : ""}" data-qid="${escapeHtml(q.id)}">
      <div class="head">
        <span class="no">${q.hidden ? "備用" : `第 ${liveNo(q)} 題`}</span>
        <span class="txt">${escapeHtml(q.text || "（無題幹）")}</span>
        <span class="ans">${keys[q.id] ? "正解 " + keyLabel(keys[q.id]) : "⚠ 無正解"}</span>
      </div>
      <div class="meta">
        ${q.hidden ? `<span class="flag warn">🙈 已隱藏・不會出題</span>` : ""}
        ${ptsOf(q) !== 1 ? `<span class="flag ok">配分 +${ptsOf(q)}</span>` : ""}
        <span class="flag ${hasEx ? "ok" : "warn"}">${hasEx ? "有說明" : "⚠ 沒有說明"}</span>
        ${blks.length ? `<span class="flag">${blks.length} 個區塊${nImg ? `・${nImg} 圖` : ""}${nVid ? `・${nVid} 影片` : ""}</span>` : ""}
        ${(q.exImgFull || "").trim()
          ? `<span class="flag">${isVideoUrl(q.exImgFull) ? "含整頁影片" : "含整頁大圖"}</span>` : ""}
        ${(q.exAudio || "").trim() ? `<span class="flag">含說明音檔</span>` : ""}
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="btn ghost mini q-edit">編輯</button>
        <button class="btn ghost mini q-up">↑</button>
        <button class="btn ghost mini q-down">↓</button>
        <button class="btn ghost mini q-hide">${q.hidden ? "👁 取消隱藏" : "🙈 隱藏"}</button>
      </div>
    </div>`;
  }).join("") || `<p class="hint" style="text-align:left;">這個題庫還沒有題目。</p>`;
}

$("#q-list").addEventListener("click", async e => {
  const item = e.target.closest("[data-qid]");
  if (!item) return;
  const qid  = item.dataset.qid;
  const list = allOf(curList);
  const i    = list.findIndex(q => q.id === qid);

  if (e.target.classList.contains("q-hide")) {
    const hide = !questions[qid]?.hidden;
    await set(ref(db, `${PATH.questions}/${qid}/hidden`), hide || null);
    toast(hide ? "已隱藏：這題先備著，控制台選不到" : "已取消隱藏：這題會照順序出");
  }
  else if (e.target.classList.contains("q-edit"))  openEditor(qid);
  else if (e.target.classList.contains("q-up")   && i > 0)               await swapOrder(PATH.questions, list[i], list[i - 1]);
  else if (e.target.classList.contains("q-down") && i < list.length - 1) await swapOrder(PATH.questions, list[i], list[i + 1]);
});

$("#q-add").addEventListener("click", () => openEditor("new"));

function openEditor(qid) {
  editing = qid;
  const q = qid === "new" ? {} : (questions[qid] || {});
  $("#ed-title").textContent = qid === "new"
    ? `新增題目（${LIST_LABEL[curList]}）`
    : `編輯${q.hidden ? "備用題" : `第 ${liveNo({ id: qid, ...q })} 題`}（${LIST_LABEL[listOf(q)]}）`;
  $("#ed-hidden").checked = !!q.hidden;

  $("#ed-pts").value    = ptsOf(q);
  $("#ed-list").value   = qid === "new" ? curList : listOf(q);
  $("#ed-text").value   = q.text || "";
  // blocksOf 會把舊的 exText / exImg 自動轉成區塊，舊題目不用重編
  edBlocks = blocksOf(q);
  $("#ed-eximgfull").value = q.exImgFull || "";
  $("#ed-exaudio").value   = q.exAudio || "";
  for (const L of LETTERS) $("#ed-" + L.toLowerCase()).value = q[L.toLowerCase()] || "";
  // 舊題目存的是 "ALL"，下拉選單要對到「都正確」那一格
  const k = qid === "new" ? "A" : keys[qid];
  $("#ed-key").value = isAllKey(k) ? ALL_CORRECT : (k || "A");

  paintPreview();
  paintAudioPreview();
  show($("#ed-del"), qid !== "new");
  show($("#editor"), true);
  // 一定要等編輯區顯示出來才畫預覽，否則量到的高度是 0，圖片會變成 max-height:0
  paintBlocks();
  paintQuestions();
  $("#editor").scrollIntoView({ behavior: "smooth", block: "center" });
}

function closeEditor() {
  editing = null;
  show($("#editor"), false);
  paintQuestions();
}

$("#ed-cancel").addEventListener("click", closeEditor);

$("#ed-save").addEventListener("click", async () => {
  const text = $("#ed-text").value.trim();
  if (!text) { toast("請輸入題幹"); return; }

  const data = { text };
  data.list = $("#ed-list").value === LISTS.DEMO ? LISTS.DEMO : LISTS.MAIN;
  if ($("#ed-hidden").checked) data.hidden = true;

  const pts = Math.round(Number($("#ed-pts").value));
  if (!Number.isFinite(pts) || pts < 1 || pts > 99) { toast("配分要是 1～99 的整數"); return; }
  if (pts !== 1) data.pts = pts;

  const blocks = edBlocks
    .map(normalizeBlock)
    .filter(b => b.v.trim())
    .map(b => ({ ...b, v: b.v.trim() }));
  if (blocks.length) data.blocks = blocks;

  const exImgFull = $("#ed-eximgfull").value.trim();
  if (exImgFull) data.exImgFull = exImgFull;

  const exAudio = $("#ed-exaudio").value.trim();
  if (exAudio) data.exAudio = exAudio;

  for (const L of LETTERS) {
    const v = $("#ed-" + L.toLowerCase()).value.trim();
    if (v) data[L.toLowerCase()] = v;
  }
  if (!data.a || !data.b) { toast("至少要填 A、B 兩個選項"); return; }

  const key = $("#ed-key").value;
  if (key !== ALL_CORRECT && !data[key.toLowerCase()]) { toast(`正解設為 ${key}，但選項 ${key} 是空的`); return; }

  const qid = editing === "new" ? newId("q") : editing;
  data.order = editing === "new"
    ? allOf(data.list).length
    : (questions[qid]?.order ?? 0);

  await set(ref(db, `${PATH.questions}/${qid}`), data);
  await set(ref(db, `${PATH.answerKey}/${qid}`), key);
  toast("已儲存");
  closeEditor();
});

$("#ed-del").addEventListener("click", async () => {
  if (editing === "new" || !editing) return;
  if (!confirm("刪除這一題？相關作答紀錄也會一起刪除。")) return;
  const qid = editing;
  await Promise.all([
    remove(ref(db, `${PATH.questions}/${qid}`)),
    remove(ref(db, `${PATH.answerKey}/${qid}`)),
    remove(ref(db, `${PATH.answers}/${qid}`)),
    remove(ref(db, `${PATH.stats}/${qid}`)),
    remove(ref(db, `${PATH.opened}/${qid}`)),
    remove(ref(db, `${PATH.doubles}/${qid}`)),
    remove(ref(db, `${PATH.state}/revealed/${qid}`))
  ]);
  toast("已刪除");
  closeEditor();
});

// ============================================================
//  批次貼上
// ============================================================
/** 匯入到目前選的題庫。replace 只清掉「這個題庫」的題目，另一個題庫不動。 */
async function writeBulk(items, replace) {
  if (replace) {
    const doomed = allOf(curList);
    await Promise.all(doomed.flatMap(q => [
      remove(ref(db, `${PATH.questions}/${q.id}`)),
      remove(ref(db, `${PATH.answerKey}/${q.id}`)),
      remove(ref(db, `${PATH.answers}/${q.id}`)),
      remove(ref(db, `${PATH.stats}/${q.id}`)),
      remove(ref(db, `${PATH.opened}/${q.id}`)),
      remove(ref(db, `${PATH.doubles}/${q.id}`)),
      remove(ref(db, `${PATH.state}/revealed/${q.id}`))
    ]));
  }
  const base = replace ? 0 : allOf(curList).length;
  const qs = {}, ks = {};
  items.forEach(({ q, key }, i) => {
    const id = newId("q");
    qs[id] = { ...q, list: curList, order: base + i };
    ks[id] = key;
  });
  await update(ref(db, PATH.questions), qs);
  await update(ref(db, PATH.answerKey), ks);
}

$("#bulk-append").addEventListener("click", () => runBulk(false));
$("#bulk-replace").addEventListener("click", () => {
  if (!confirm(`會刪除「${LIST_LABEL[curList]}」的全部題目與其作答紀錄（另一個題庫不受影響），確定嗎？`)) return;
  runBulk(true);
});

async function runBulk(replace) {
  try {
    const items = parseBulkQuestions($("#bulk-in").value);
    await writeBulk(items, replace);
    $("#bulk-in").value = "";
    toast(`已匯入 ${items.length} 題`);
  } catch (e) {
    alert("匯入失敗：\n" + e.message);
  }
}

// ============================================================
//  匯出：目前題庫 → 第x題／題目／參考答案／說明 的文字
// ============================================================
$("#ex-run").addEventListener("click", () => {
  const all = allOf(curList);
  const list = $("#ex-hidden").checked ? all : all.filter(q => !q.hidden);
  const out = $("#ex-out");

  if (!list.length) {
    out.value = "";
    show(out, false);
    $("#ex-copy").disabled = true;
    toast("這個題庫沒有可以匯出的題目");
    return;
  }

  // 依匯出的順序編號；隱藏的備用題會註明「（備用）」
  out.value = exportQuestionsText(list.map((q, i) => ({ q, key: keys[q.id], no: i + 1 })));
  show(out, true);
  $("#ex-copy").disabled = false;

  // 沒設正解的題目「參考答案」會是空的 —— 先講清楚
  const noKey = list.filter(q => !keys[q.id]).length;
  const nHidden = list.filter(q => q.hidden).length;
  $("#ex-note").textContent = `${LIST_LABEL[curList]}：匯出 ${list.length} 題`
    + (nHidden ? `（含隱藏的備用題 ${nHidden} 題）` : "")
    + (noKey ? `　⚠ 其中 ${noKey} 題還沒設正解，參考答案是空的` : "");
  show($("#ex-note"), true);
  out.focus();
  out.select();
});

$("#ex-copy").addEventListener("click", async () => {
  const out = $("#ex-out");
  try {
    await navigator.clipboard.writeText(out.value);
  } catch {
    // 不是 https 或瀏覽器不給剪貼簿權限時，退回舊方法
    out.focus();
    out.select();
    document.execCommand("copy");
  }
  toast("已複製到剪貼簿");
});
