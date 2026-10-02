// ============================================================
//  計分與解析邏輯的自我檢查
//  selftest.html 會在瀏覽器裡跑；也可以直接用 node 跑：
//    node assets/js/selftest.js
// ============================================================

import {
  buildScoreboard, ranksOf, fastestCorrect, isCorrect, isKey, keyLabel, correctCount, ALL_CORRECT,
  tally, elapsedMs, fmtSec, cleanName, parseBulkQuestions, questionsOf, ptsOf,
  wheelPool, wheelSlots, randomIndex, secondsLeft, blocksOf, groupBlocks, videoEmbed, webpSrc,
  LISTS, WHEEL_MAX_SLOTS, isAllKey, TEXT_SIZE_VH
} from "./logic.js";

export function run() {
  const log = [];
  let fails = 0;
  const ok = (name, cond, extra = "") => {
    if (!cond) fails++;
    log.push({ pass: !!cond, text: `${name}${extra ? "   " + extra : ""}` });
  };

  // ════════ 佈景 ════════
  //  四位玩家。q1/q2 正式、q3 正式（配分 3）、q4 正式未公布、q5 DEMO。
  const players = { u1: { name: "阿明" }, u2: { name: "小華" }, u3: { name: "大雄" }, u4: { name: "靜香" } };
  const questions = {
    q1: { order: 0, text: "T1", a: "a", b: "b", list: "main" },
    q2: { order: 1, text: "T2", a: "a", b: "b", list: "main" },
    q3: { order: 2, text: "T3", a: "a", b: "b", list: "main", pts: 3 },
    q4: { order: 3, text: "T4", a: "a", b: "b", list: "main" },
    q5: { order: 0, text: "D1", a: "a", b: "b", list: "demo" }
  };
  const keys = { q1: "A", q2: "B", q3: "A", q4: "A", q5: "A" };
  const revealed = { q1: true, q2: true, q3: true, q5: true };
  const openedAt = { q1: 1000, q2: 50000, q3: 90000, q4: 120000, q5: 0 };
  const answers = {
    q1: { u1: { c: "A", t: 3000 }, u2: { c: "A", t: 2000 }, u3: { c: "B", t: 1500 }, u4: { c: "A", t: 9000 } },
    q2: { u1: { c: "B", t: 51000 }, u2: { c: "B", t: 56000 }, u4: { c: "A", t: 52000 } },
    q3: { u1: { c: "B", t: 91000 }, u3: { c: "A", t: 95000 }, u4: { c: "A", t: 99000 } },
    q4: { u1: { c: "A", t: 121000 } },                // 未公布，不算
    q5: { u1: { c: "A", t: 1 } }                      // DEMO，不算
  };

  // ════════ 1. 小工具 ════════
  ok("tally 只數 ABCD", JSON.stringify(tally({ x: { c: "A" }, y: { c: "Z" }, z: { c: "C" } })) ===
    JSON.stringify({ A: 1, B: 0, C: 1, D: 0, total: 2 }));
  ok("elapsedMs 正常", elapsedMs({ t: 3500 }, 1000) === 2500);
  ok("elapsedMs 重新出題造成負數 → 0", elapsedMs({ t: 500 }, 1000) === 0);
  ok("elapsedMs 沒有出題時間 → null", elapsedMs({ t: 500 }, null) === null);
  ok("fmtSec", fmtSec(1234) === "1.23 秒" && fmtSec(12345) === "12.3 秒" && fmtSec(null) === "—");
  ok("cleanName 去空白、收空格、截 12 字", cleanName("  王   小明  ") === "王 小明" &&
    Array.from(cleanName("一二三四五六七八九十甲乙丙丁")).length === 12);
  ok("cleanName emoji 不切半", cleanName("😀".repeat(20)) === "😀".repeat(12));
  ok("cleanName 空字串", cleanName("   ") === "");
  ok("ptsOf 預設 1、範圍外退回 1", ptsOf({}) === 1 && ptsOf({ pts: 3 }) === 3 && ptsOf({ pts: 0 }) === 1 && ptsOf({ pts: 100 }) === 1);
  ok("secondsLeft", secondsLeft(Date.now() - 4200, 20, 0) === 16 && secondsLeft(null) === null);

  // ════════ 2. 最快答對 ════════
  const f1 = fastestCorrect(players, answers.q1, "A", openedAt.q1);
  ok("最快答對：小華 1 秒 → 阿明 2 秒 → 靜香 8 秒，答錯的大雄不在裡面",
    f1.map(f => f.uid).join() === "u2,u1,u4" && f1[0].ms === 1000, JSON.stringify(f1.map(f => [f.name, f.ms])));
  ok("最快答對：沒有正解就是空的", fastestCorrect(players, answers.q1, null, 0).length === 0);

  // ════════ 3. 全場計分 ════════
  //  q1(A, 1分)：u1 ✔2s  u2 ✔1s  u3 ✘    u4 ✔8s
  //  q2(B, 1分)：u1 ✔1s  u2 ✔6s  u3 沒答 u4 ✘
  //  q3(A, 3分)：u1 ✘    u2 沒答 u3 ✔5s  u4 ✔9s
  //  → u1 2分 3s / u2 2分 7s / u3 3分 5s / u4 4分 17s
  const board = buildScoreboard(players, questions, keys, answers, revealed, LISTS.MAIN, null, openedAt);
  const by = Object.fromEntries(board.rows.map(r => [r.uid, r]));
  ok("只算已公布的正式題（3 題）", board.questionCount === 3);
  ok("分數", by.u1.points === 2 && by.u2.points === 2 && by.u3.points === 3 && by.u4.points === 4,
    board.rows.map(r => `${r.name}:${r.points}`).join(" "));
  ok("答對用時", by.u1.timeMs === 3000 && by.u2.timeMs === 7000 && by.u3.timeMs === 5000 && by.u4.timeMs === 17000);
  ok("滿分 = 1+1+3", by.u1.max === 5);
  ok("作答題數", by.u1.answered === 3 && by.u2.answered === 2 && by.u3.answered === 2);
  ok("排序：靜香 4 → 大雄 3 → 阿明 2（3 秒）→ 小華 2（7 秒）",
    board.rows.map(r => r.uid).join() === "u4,u3,u1,u2", board.rows.map(r => r.name).join(" > "));
  ok("名次", ranksOf(board.rows).join() === "1,2,3,4");

  // 同分同題數同秒 → 並列
  const tie = ranksOf([
    { points: 3, correct: 2, timeMs: 100 }, { points: 3, correct: 2, timeMs: 100 }, { points: 1, correct: 1, timeMs: 5 }
  ]);
  ok("同分同秒並列，下一名跳號", tie.join() === "1,1,3");

  // 被移出的玩家不上榜
  const { u3: _, ...rest } = players;
  const b2 = buildScoreboard(rest, questions, keys, answers, revealed, LISTS.MAIN, null, openedAt);
  ok("移出名單的玩家不上榜", b2.rows.length === 3 && !b2.rows.some(r => r.uid === "u3"));

  // 轉盤加倍
  const b3 = buildScoreboard(players, questions, keys, answers, revealed, LISTS.MAIN, { q1: "u2", q2: "u4" }, openedAt);
  const by3 = Object.fromEntries(b3.rows.map(r => [r.uid, r]));
  ok("轉盤加倍：小華 q1 答對 ×2 → 3 分，滿分也跟著加倍", by3.u2.points === 3 && by3.u2.max === 6);
  ok("轉盤加倍：靜香 q2 答錯 → 不加分", by3.u4.points === 4 && by3.u4.max === 6);

  // DEMO 題庫
  const bd = buildScoreboard(players, questions, keys, answers, revealed, LISTS.DEMO, null, openedAt);
  ok("DEMO 題庫自己算自己的", bd.questionCount === 1 && bd.rows.find(r => r.uid === "u1").points === 1);

  // 沒有正解的題目不算
  const b4 = buildScoreboard(players, questions, { ...keys, q3: undefined }, answers, revealed, LISTS.MAIN, null, openedAt);
  ok("沒設正解的題目不計分", b4.questionCount === 2);

  // ════════ 4. 都正確 ════════
  ok("都正確：選什麼都算對", ["A", "B", "C", "D"].every(L => isCorrect(L, ALL_CORRECT)));
  ok("都正確：沒作答還是不算對", !isCorrect(undefined, ALL_CORRECT) && !isCorrect("Z", ALL_CORRECT));
  ok("一般正解：只有那個字母對", isCorrect("B", "B") && !isCorrect("A", "B"));
  ok("「都正確」直接存成中文", ALL_CORRECT === "都正確");
  ok("isKey", isKey("都正確") && isKey("D") && !isKey("E") && !isKey(""));
  ok("舊資料的 ALL 也當成都正確", isKey("ALL") && isAllKey("ALL") && isCorrect("C", "ALL") && keyLabel("ALL") === "都正確");
  ok("keyLabel", keyLabel("都正確") === "都正確" && keyLabel("C") === "C");
  ok("correctCount", correctCount({ A: 2, B: 3, C: 0, D: 1, total: 6 }, "ALL") === 6 &&
    correctCount({ A: 2, B: 3, total: 5 }, "B") === 3 && correctCount({ total: 5 }, null) === 0);

  //  q2 改成都正確：u1 u2 u4 有作答 → 全部答對；u3 沒作答 → 0 分
  const bAll = buildScoreboard(players, questions, { ...keys, q2: ALL_CORRECT }, answers, revealed, LISTS.MAIN, null, openedAt);
  const byAll = Object.fromEntries(bAll.rows.map(r => [r.uid, r]));
  ok("都正確的題目：有作答的人都拿分", byAll.u1.points === 2 && byAll.u2.points === 2 && byAll.u4.points === 5,
    bAll.rows.map(r => `${r.name}:${r.points}`).join(" "));
  ok("都正確的題目：沒作答的人不拿分", byAll.u3.points === 3 && byAll.u3.correct === 1);
  ok("都正確的題目：作答時間照算", byAll.u4.timeMs === 17000 + 2000);
  ok("都正確：最快答對列出所有作答的人",
    fastestCorrect(players, answers.q2, ALL_CORRECT, openedAt.q2).map(f => f.uid).join() === "u1,u4,u2");

  // ════════ 5. 轉盤 ════════
  const pool = wheelPool(players, { q1: "u1" });
  ok("轉盤：抽過的不再出現", pool.length === 3 && !pool.some(p => p.id === "u1"));
  ok("轉盤：全部抽完重開一輪", wheelPool(players, { a: "u1", b: "u2", c: "u3", d: "u4" }).length === 4);
  ok("轉盤：沒有玩家 → 空", wheelPool({}, null).length === 0);

  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`p${i}`, { name: `玩家${i}` }]));
  let slotsOk = true;
  for (let k = 0; k < 200; k++) {
    const p = wheelPool(many, null);
    const target = p[randomIndex(p.length)].id;
    const s = wheelSlots(p, target);
    if (s.length !== WHEEL_MAX_SLOTS || !s.some(x => x.id === target) || new Set(s.map(x => x.id)).size !== s.length) {
      slotsOk = false; break;
    }
  }
  ok(`轉盤：80 人只畫 ${WHEEL_MAX_SLOTS} 格、一定含中獎者、不重複（200 次）`, slotsOk);
  ok("轉盤：人少就全部畫", wheelSlots(pool, pool[0].id).length === 3);

  const counts = [0, 0, 0];
  for (let k = 0; k < 3000; k++) counts[randomIndex(3)]++;
  ok("randomIndex 大致均勻", counts.every(c => c > 850 && c < 1150), counts.join("/"));

  // ════════ 6. 批次匯入與題庫 ════════
  const bulk = parseBulkQuestions("台灣最高的建築？|101|85|歌劇院|赤崁樓|A\n只有兩個選項？|甲|乙|B\n你喜歡哪個？|貓|狗|都正確\n開放題|甲|乙|丙|all");
  ok("批次匯入：四行四題", bulk.length === 4 && bulk[0].key === "A" && bulk[1].q.c === undefined && bulk[1].q.d === undefined);
  ok("批次匯入：「都正確」與 ALL 都認得", bulk[2].key === ALL_CORRECT && bulk[3].key === ALL_CORRECT && bulk[3].q.c === "丙");
  let threw2 = false;
  try { parseBulkQuestions("題目|甲|乙|丙|親善大使"); } catch { threw2 = true; }
  ok("批次匯入：最後一欄不是正解會擋下（類別欄已拿掉）", threw2);
  let threw = false;
  try { parseBulkQuestions("題目|甲|乙|C"); } catch { threw = true; }
  ok("批次匯入：正解選項沒填會擋下", threw);
  ok("題庫篩選", questionsOf(questions, LISTS.MAIN).length === 4 && questionsOf(questions, LISTS.DEMO).length === 1);

  // 隱藏的備用題：現場看不到、不佔題號、不計分；後台看得到
  const withHidden = { ...questions, q2: { ...questions.q2, hidden: true } };
  ok("隱藏題：現場題號跳過它", questionsOf(withHidden, LISTS.MAIN).map(q => q.id).join() === "q1,q3,q4");
  ok("隱藏題：後台列得出來", questionsOf(withHidden, LISTS.MAIN, { withHidden: true }).length === 4);
  const bh = buildScoreboard(players, withHidden, keys, answers, revealed, LISTS.MAIN, null, openedAt);
  ok("隱藏題：不計分", bh.questionCount === 2 && bh.rows.find(r => r.uid === "u1").points === 1);
  ok("說明文字放大了", TEXT_SIZE_VH[3] >= 3.6 && TEXT_SIZE_VH[1] < TEXT_SIZE_VH[5]);

  // ════════ 7. 說明排版 ════════
  ok("舊格式 exText/exImg 自動轉區塊", blocksOf({ exText: "x", exImg: "a.png" }).map(b => b.t + b.w).join() === "texthalf,imghalf");
  ok("連續自動寬併成一列", groupBlocks([{ w: "auto" }, { w: "auto" }, { w: "full" }]).length === 2);
  ok("YouTube 轉內嵌", videoEmbed("https://youtu.be/abcdefg").kind === "embed");
  ok("站內 png → webp，外部不動", webpSrc("assets/a.png") === "assets/a.webp" && webpSrc("https://x/a.png") === "https://x/a.png");

  return { log, fails };
}

// 用 node 直接跑的時候印出結果
if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const { log, fails } = run();
  for (const l of log) console.log(`${l.pass ? "PASS" : "FAIL"}  ${l.text}`);
  console.log(`\n${log.length - fails} / ${log.length} 通過`);
  process.exitCode = fails ? 1 : 0;
}
