// ============================================================
//  純邏輯：計分、排名、解析、排版工具
//  ------------------------------------------------------------
//  這個檔案不碰 Firebase，所以 selftest.html 與 node 都能直接 import 來測。
//  common.js 會把這裡的東西整包再匯出，各頁面照樣從 common.js 拿。
// ============================================================

export const PHASE = {
  IDLE:   "idle",    // 待機（尚未開始 / 題目間空檔）
  OPEN:   "open",    // 題目已出，開放作答
  LOCKED: "locked",  // 停止作答，尚未公布
  REVEAL: "reveal",  // 公布答案與說明
  FINAL:  "final"    // 全部結束，看排行榜
};

/** 題庫：正式題與 DEMO 練習題。DEMO 不計入排行榜。 */
export const LISTS = { MAIN: "main", DEMO: "demo" };
export const LIST_LABEL = { main: "正式題目", demo: "DEMO 練習題" };

export const LETTERS = ["A", "B", "C", "D"];

export const DEFAULT_LIMIT_SEC = 20;

/** 玩家暱稱長度上限（資料庫規則也擋同一個數字） */
export const NAME_MAX = 12;

/**
 * 正解：A～D，或「都正確」—— 那一題只要有送出答案，選哪個都算對。
 * （沒送出的人還是 0 分，「都正確」不會讓沒作答的人白拿分）
 * 資料庫裡就直接存「都正確」三個字；早期存成 "ALL" 的舊題目也照樣認得。
 */
export const ALL_CORRECT = "都正確";
const LEGACY_ALL = "ALL";
export const KEYS = [...LETTERS, ALL_CORRECT, LEGACY_ALL];

/** 這是一個合法的正解嗎 */
export const isKey = key => KEYS.includes(key);

/** 正解是不是「都正確」（含舊的 "ALL"） */
export const isAllKey = key => key === ALL_CORRECT || key === LEGACY_ALL;

/** 選 choice 算不算答對 */
export function isCorrect(choice, key) {
  if (!LETTERS.includes(choice)) return false;
  return isAllKey(key) ? true : choice === key;
}

/** 某個選項字母是不是正解（畫長條圖、標綠色用） */
export const isKeyLetter = (letter, key) => isAllKey(key) || letter === key;

/** 正解要怎麼顯示：A～D 原樣，「都正確」（含舊的 ALL）一律顯示「都正確」 */
export const keyLabel = key => isAllKey(key) ? ALL_CORRECT : (key || "");

/** 這個答案有幾個人答對（作答分布 → 人數） */
export function correctCount(t, key) {
  if (!isKey(key)) return 0;
  return isAllKey(key) ? (t?.total || 0) : (t?.[key] || 0);
}

// ---------- 說明頁排版區塊 ----------

export const BLOCK_TYPES = [
  { t: "head",  name: "小標題" },
  { t: "text",  name: "文字" },
  { t: "img",   name: "圖片" },
  { t: "video", name: "影片" }
];

/** 會佔版面的媒體類型 —— 只有一個的時候讓它佔滿整個說明區 */
export const MEDIA_TYPES = ["img", "video"];

export const BLOCK_SIZES = [1, 2, 3, 4, 5];

/** 區塊寬度。auto = 只佔內容需要的寬，連續的 auto 會緊貼排成一列 */
export const BLOCK_WIDTHS = [
  { w: "full", name: "整行" },
  { w: "half", name: "半行（可並排）" },
  { w: "auto", name: "自動寬（緊貼並排）" }
];

export const BLOCK_ALIGNS = [
  { a: "left",   name: "靠左" },
  { a: "center", name: "置中" },
  { a: "right",  name: "靠右" }
];
export const DEFAULT_BLOCK_SIZE = 3;

/** 文字級距（vh）—— 投影頁還會再依實際高度縮放 */
export const TEXT_SIZE_VH = { 1: 2.4, 2: 3, 3: 3.8, 4: 4.6, 5: 6.2 };
/** 圖片高度上限（vh） */
export const IMG_SIZE_VH  = { 1: 9,   2: 14,  3: 19,  4: 25,  5: 32  };

/** 把一個區塊補齊預設值 */
export function normalizeBlock(b) {
  const t = ["text", "img", "head", "video"].includes(b?.t) ? b.t : "text";
  const size = BLOCK_SIZES.includes(Math.round(Number(b?.size)))
    ? Math.round(Number(b.size)) : DEFAULT_BLOCK_SIZE;
  return {
    t,
    v: typeof b?.v === "string" ? b.v : "",
    w: ["half", "auto"].includes(b?.w) ? b.w : "full",
    size,
    align: ["center", "right"].includes(b?.align) ? b.align : "left"
  };
}

/**
 * 影片網址 → 實際要放進畫面的來源。
 * YouTube／Vimeo 轉成內嵌網址（要用 iframe），其他一律當成直接播放的影片檔。
 */
export function videoEmbed(url) {
  const u = (url || "").trim();
  if (!u) return { kind: "file", src: "" };
  const yt = u.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/
  );
  if (yt) return { kind: "embed", src: `https://www.youtube.com/embed/${yt[1]}?rel=0` };
  const vi = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vi) return { kind: "embed", src: `https://player.vimeo.com/video/${vi[1]}` };
  return { kind: "file", src: u };
}

const VIDEO_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v)(\?|#|$)/i;

/** 這個網址看起來是影片嗎？ —— YouTube／Vimeo，或常見的影片副檔名 */
export function isVideoUrl(url) {
  const u = (url || "").trim();
  if (!u) return false;
  return videoEmbed(u).kind === "embed" || VIDEO_EXT.test(u);
}

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|oga|opus|flac)(\?|#|$)/i;

/** 這個網址看起來是音檔嗎？ */
export function isAudioUrl(url) {
  const u = (url || "").trim();
  if (!u) return false;
  return AUDIO_EXT.test(u);
}

/**
 * 站內圖片一律用 .webp。舊資料填 .png / .jpg 的話先試同名 .webp，
 * 載不到時再由 onerror 退回原本的路徑。外部網址不動。
 */
export function webpSrc(url) {
  const u = (url || "").trim();
  if (/^(https?:)?\/\//i.test(u) || /^data:/i.test(u)) return u;
  return u.replace(/\.(png|jpe?g)$/i, ".webp");
}

/** 說明只有一張圖或一段影片時 → 讓它佔滿整個說明區 */
export function isSoloMedia(blocks) {
  return blocks.length === 1 && MEDIA_TYPES.includes(blocks[0].t);
}

/**
 * 把區塊分成一列一列。連續的「自動寬」區塊會收進同一列、中間只留一點點縫。
 * 整列的對齊方式取這一列第一個區塊的 align。
 */
export function groupBlocks(blocks) {
  const rows = [];
  for (const b of blocks) {
    const last = rows[rows.length - 1];
    if (b.w === "auto" && last && last.auto) { last.items.push(b); continue; }
    rows.push({ auto: b.w === "auto", align: b.align, items: [b] });
  }
  return rows;
}

/**
 * 取出一題的說明區塊。Firebase 可能把陣列存成物件，兩種都要接得住。
 * 沒有 blocks 但有舊的 exText / exImg 時，自動轉成等效的區塊。
 */
export function blocksOf(q) {
  const raw = q?.blocks;
  const list = Array.isArray(raw) ? raw
             : raw && typeof raw === "object"
               ? Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map(k => raw[k])
               : null;

  if (list && list.length) {
    return list.map(normalizeBlock).filter(b => b.v.trim());
  }

  const out = [];
  const txt = (q?.exText || "").trim();
  const img = (q?.exImg || "").trim();
  if (txt) out.push(normalizeBlock({ t: "text", v: txt, w: img ? "half" : "full", size: 3 }));
  if (img) out.push(normalizeBlock({ t: "img",  v: img, w: txt ? "half" : "full", size: 4 }));
  return out;
}

// ---------- 小工具 ----------

/** 物件 → 陣列，附上 key，並依 order 排序 */
export function toSortedList(obj) {
  if (!obj) return [];
  return Object.entries(obj)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/**
 * 整理玩家輸入的暱稱：去頭尾空白、把連續空白收成一格、截到上限長度。
 * 用 Array.from 算長度，emoji 才不會被切成半個字。
 */
export function cleanName(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, NAME_MAX).join("");
}

/**
 * 解析批次貼上的題目。一行一題，用 | 分隔：
 *   題幹 | A選項 | B選項 | C選項 | D選項 | 正解
 * 正解填 A/B/C/D，或「都正確」（也接受 ALL）。只有兩個選項就少寫兩欄。
 * 回傳 [{ q:{text,a,b,c,d}, key:"A" }…]，格式有問題就丟出帶行內容的錯誤。
 */
export function parseBulkQuestions(raw) {
  const out = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const where = `：${t.slice(0, 30)}…`;

    const parts = t.split("|").map(s => s.trim());
    if (parts.length < 4) throw new Error(`這行欄位不夠${where}`);

    const last = parts.pop();
    const key = /^(都正確|全對|ALL)$/i.test(last) ? ALL_CORRECT : last.toUpperCase();
    if (!isKey(key)) throw new Error(`最後一欄要是正解 A/B/C/D 或「都正確」，讀到的是「${last}」${where}`);

    const [text, a, b, c, d] = parts;
    if (!text || !a || !b) throw new Error(`題幹與 A、B 選項不能空白${where}`);

    const q = { text, a, b };
    if (c) q.c = c;
    if (d) q.d = d;
    if (key !== ALL_CORRECT && !q[key.toLowerCase()]) throw new Error(`正解是 ${key}，但選項 ${key} 沒有填${where}`);

    out.push({ q, key });
  }
  if (!out.length) throw new Error("沒有讀到任何題目");
  return out;
}

/**
 * 把題目匯出成方便閱讀的文字：
 *   第1題
 *   題目:台灣最高的建築物是？
 *   A:台北101
 *   B:高雄85大樓
 *   參考答案:A 台北101
 *   說明:高 508 公尺……
 * 選項只列有填的（兩個選項的題目就只有 A、B 兩行）。
 * 參考答案在字母後面補上那個選項的文字，一眼就知道答案是什麼；
 * 「都正確」就直接寫「都正確」，沒設正解就留空。
 * 說明取後台排版區塊裡的小標題與文字（圖片、影片匯不出來），多段之間換行。
 * @param items [{ q, key, no }] —— no 是題號；q.hidden 的備用題會寫成「第3題（備用）」
 */
export function exportQuestionsText(items) {
  const line = v => String(v ?? "").replace(/\r\n?/g, "\n").trim();
  return items.map(({ q, key, no }) => {
    const answer = !isKey(key) ? ""
      : isAllKey(key) ? ALL_CORRECT
      : [key, line(q?.[key.toLowerCase()])].filter(Boolean).join(" ");
    const explain = blocksOf(q)
      .filter(b => b.t === "head" || b.t === "text")
      .map(b => line(b.v))
      .filter(Boolean)
      .join("\n");
    return [
      `第${no}題${q?.hidden ? "（備用）" : ""}`,
      `題目:${line(q?.text)}`,
      ...LETTERS.filter(L => line(q?.[L.toLowerCase()])).map(L => `${L}:${line(q[L.toLowerCase()])}`),
      `參考答案:${answer}`,
      `說明:${explain}`
    ].join("\n");
  }).join("\n");
}

// ---------- 題庫 ----------

/** 題目屬於哪個題庫（沒寫就當正式題） */
export const listOf = q => (q?.list === LISTS.DEMO ? LISTS.DEMO : LISTS.MAIN);

/**
 * 取出某個題庫的題目，依 order 排序。
 * 後台標成「隱藏」的備用題預設不算在內 —— 控制台選不到、題號不佔位、也不計分。
 * 只有後台要列出全部題目時才傳 { withHidden: true }。
 */
export function questionsOf(questions, list, { withHidden = false } = {}) {
  return toSortedList(questions).filter(q => listOf(q) === list && (withHidden || !q.hidden));
}

// ============================================================
//  計分（個人賽）
//  ------------------------------------------------------------
//  每題答對 +配分，答錯或沒答 0 分。
//  被轉盤抽中的那個人，那一題配分再 ×2。
//  同分時：答對題數多的在前 → 答對題目的作答時間加總較短的在前。
//  DEMO 題庫不計分。
// ============================================================

export const DEFAULT_POINTS = 1;
export const DOUBLE_MULTIPLIER = 2;

/** 這一題值幾分（沒設定就是 1）。只接受 1～99 的整數。 */
export function ptsOf(q) {
  const n = Math.round(Number(q?.pts));
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : DEFAULT_POINTS;
}

/** 統計作答分布：{ uid:{c} … } → {A,B,C,D,total} */
export function tally(answersForQuestion) {
  const out = { A: 0, B: 0, C: 0, D: 0, total: 0 };
  for (const r of Object.values(answersForQuestion || {})) {
    if (!LETTERS.includes(r?.c)) continue;
    out[r.c]++;
    out.total++;
  }
  return out;
}

/**
 * 從出題到按下送出花了幾毫秒。
 * 兩個時間都是伺服器時間（規則強制 t === now），各裝置時鐘不準也不影響。
 * 主持人重新出同一題時 openedAt 會往後跳，舊答案就會算出負數 —— 夾在 0。
 */
export function elapsedMs(answer, openedAt) {
  const t = Number(answer?.t), o = Number(openedAt);
  if (!Number.isFinite(t) || !Number.isFinite(o) || !o) return null;
  return Math.max(0, t - o);
}

/** 毫秒 → 「3.2 秒」 */
export function fmtSec(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + " 秒";
}

/**
 * 一題裡答對的人，依作答時間由快到慢。
 * @returns [{ uid, name, ms }]
 */
export function fastestCorrect(players, answersForQuestion, key, openedAt) {
  if (!isKey(key)) return [];
  return Object.entries(answersForQuestion || {})
    .filter(([, a]) => isCorrect(a?.c, key))
    .map(([uid, a]) => ({ uid, name: players?.[uid]?.name || "（已離開）", ms: elapsedMs(a, openedAt) }))
    .sort((x, y) => (x.ms ?? Infinity) - (y.ms ?? Infinity) || x.name.localeCompare(y.name, "zh-Hant"));
}

/**
 * 全場排名。只算「已公布」、屬於指定題庫、而且有正解的題目。
 * 只列出還在玩家名單裡的人（被主持人移除的就不上榜）。
 *
 * @param players   /players          { uid:{name} }
 * @param answers   /answers          { qid:{ uid:{c,t} } }
 * @param openedAt  { qid: 出題時間 }  —— 由 /stats/{qid}/openedAt 組出來
 * @returns { rows:[…排好…], questionCount }
 *   row：{ uid, name, points, max, correct, answered, timeMs }
 */
export function buildScoreboard(players, questions, answerKeys, answers, revealed,
                                list = LISTS.MAIN, doubles = null, openedAt = null) {
  const qs = questionsOf(questions, list)
    .filter(q => revealed?.[q.id] && isKey(answerKeys?.[q.id]));

  const rows = Object.entries(players || {})
    .filter(([, p]) => p && typeof p.name === "string")
    .map(([uid, p]) => ({ uid, name: p.name, points: 0, max: 0, correct: 0, answered: 0, timeMs: 0 }));

  for (const q of qs) {
    const key = answerKeys[q.id];
    const basePts = ptsOf(q);
    const doubledUid = doubles?.[q.id] || null;

    for (const row of rows) {
      const pts = row.uid === doubledUid ? basePts * DOUBLE_MULTIPLIER : basePts;
      row.max += pts;

      const a = answers?.[q.id]?.[row.uid];
      if (!LETTERS.includes(a?.c)) continue;
      row.answered++;
      if (!isCorrect(a.c, key)) continue;

      row.correct++;
      row.points += pts;
      row.timeMs += elapsedMs(a, openedAt?.[q.id]) ?? 0;
    }
  }

  rows.sort(compareRows);
  return { rows, questionCount: qs.length };
}

/** 排名的比較方式：分數 → 答對題數 → 答對的總作答時間（越短越前）→ 名字 */
export function compareRows(a, b) {
  return b.points - a.points ||
         b.correct - a.correct ||
         a.timeMs - b.timeMs ||
         a.name.localeCompare(b.name, "zh-Hant");
}

/**
 * 名次（同分同秒才並列）。rows 必須已經排好。
 * @returns 跟 rows 一一對應的名次陣列，例如 [1, 2, 2, 4]
 */
export function ranksOf(rows) {
  const out = [];
  rows.forEach((r, i) => {
    const p = rows[i - 1];
    out.push(p && p.points === r.points && p.correct === r.correct && p.timeMs === r.timeMs
      ? out[i - 1] : i + 1);
  });
  return out;
}

// ---------- 倒數計時 ----------

/**
 * 還剩幾秒。用伺服器時間算，避免各裝置時鐘不同步。
 * @param offset /.info/serverTimeOffset 的值
 */
export function secondsLeft(openedAt, limitSec = DEFAULT_LIMIT_SEC, offset = 0) {
  if (!openedAt) return null;
  const now  = Date.now() + (offset || 0);
  const left = limitSec - (now - openedAt) / 1000;
  return Math.max(0, Math.ceil(left));
}

// ============================================================
//  加倍轉盤
// ============================================================

/**
 * [0, n) 的均勻亂數。用 crypto，並把會造成偏差的尾段丟掉重抽。
 */
export function randomIndex(n) {
  if (n <= 1) return 0;
  const c = globalThis.crypto;
  if (!c?.getRandomValues) return Math.floor(Math.random() * n);

  const limit = Math.floor(0xFFFFFFFF / n) * n;
  const buf = new Uint32Array(1);
  let v;
  do { c.getRandomValues(buf); v = buf[0]; } while (v >= limit);
  return v % n;
}

/**
 * 還能被抽的玩家：抽過的就不再出現（抽過 = 出現在 /doubles 裡）。
 * 全部都抽過了就重新開一輪，否則轉盤會變成空的。
 * @returns [{ id, name }] 依暱稱排序
 */
export function wheelPool(players, doubles) {
  const all = Object.entries(players || {})
    .filter(([, p]) => p && typeof p.name === "string")
    .map(([id, p]) => ({ id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant") || a.id.localeCompare(b.id));
  if (!all.length) return [];
  const used = new Set(Object.values(doubles || {}));
  const left = all.filter(p => !used.has(p.id));
  return left.length ? left : all;
}

/** 轉盤上最多畫幾格 —— 再多字就小到台下看不見 */
export const WHEEL_MAX_SLOTS = 20;

/**
 * 轉盤上要畫的格子。人數太多時只挑 WHEEL_MAX_SLOTS 格（一定含中獎者），
 * 中獎的人是主持人端早就抽好的，這裡只是決定畫面上陪跑的是誰。
 * 中獎者放在隨機位置，免得每次都停在同一個角度。
 */
export function wheelSlots(pool, targetId, max = WHEEL_MAX_SLOTS) {
  const target = pool.find(p => p.id === targetId);
  if (!target) return pool.slice(0, max);
  if (pool.length <= max) return pool;

  const others = pool.filter(p => p.id !== targetId);
  for (let i = others.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [others[i], others[j]] = [others[j], others[i]];
  }
  const picked = others.slice(0, max - 1);
  picked.splice(randomIndex(max), 0, target);
  return picked;
}
