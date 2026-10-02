// ============================================================
//  音效 —— 提示音用 Web Audio 即時合成，作答背景音樂則是 assets/audio 下的音檔
//  ------------------------------------------------------------
//  瀏覽器規定必須先有使用者手勢才能出聲，所以投影頁上有一顆
//  「開啟音效」按鈕，按下時呼叫 unlock()。
// ============================================================

let ctx = null;
let master = null;
let enabled = false;

/** 使用者按下按鈕後呼叫，之後才發得出聲音 */
export async function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") await ctx.resume();
  enabled = ctx.state === "running";
  // 先把音樂接起來開始緩衝、撞擊聲先解碼好，正式要用時才不會卡住
  if (enabled) {
    quizBgm.prime(); revealBgm.prime(); finalBgm.prime(); wheelBgm.prime();
    wowSfx.prime();
    for (const c of Object.values(cues)) c.prime();
    loadRevealSfx();
  }
  return enabled;
}

export const isEnabled = () => enabled;

export function setVolume(v) {
  if (master) master.gain.value = Math.max(0, Math.min(1, v));
}

// ---------- 基本積木 ----------

/** 一個帶包封的振盪器音 */
function blip({ freq, dur = 0.12, type = "sine", gain = 0.3, at = 0, glideTo = null }) {
  if (!enabled) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g   = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);

  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** 白噪音爆點，用來做打擊感 */
function noise({ dur = 0.12, gain = 0.2, at = 0, hp = 800 }) {
  if (!enabled) return;
  const t = ctx.currentTime + at;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = "highpass";
  filt.frequency.value = hp;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  src.connect(filt).connect(g).connect(master);
  src.start(t);
}

// ---------- 對外的音效 ----------

/**
 * 最後幾秒的重音。BGM 本身已經有節拍，所以只在剩 10 秒內加尖銳的提示音。
 * @param left 剩餘秒數
 */
export function tick(left) {
  if (!enabled || left > 10) return;
  if (left <= 5) {
    blip({ freq: 1320, dur: 0.085, type: "square", gain: 0.24 });
    noise({ dur: 0.05, gain: 0.1, hp: 2600 });
  } else {
    blip({ freq: 990, dur: 0.07, type: "square", gain: 0.17 });
  }
}

// ============================================================
//  音檔類音樂／音效
//  ------------------------------------------------------------
//  長的（作答、解說背景音樂）用 <audio> 串流，接進 master 後淡入淡出；
//  短的（公布答案的撞擊聲）先整段解碼成 buffer，觸發時零延遲。
//  路徑一律用 import.meta.url 解析，換哪一頁引用都不會斷。
// ============================================================

const AUDIO = name => new URL(`../audio/${name}`, import.meta.url).href;

/**
 * 一首可以淡入淡出的循環音樂。
 * <audio> 與 MediaElementSource 都只建一次 —— 同一個元素接第二次
 * createMediaElementSource 會丟 InvalidStateError。
 */
function makeTrack(file, { volume = 0.5, fadeIn = 0.8, fadeOut = 0.5 } = {}) {
  const t = { on: false, el: null, src: null, gain: null };

  function ensure() {
    if (!t.el) {
      t.el = new Audio(AUDIO(file));
      t.el.loop = true;          // 講解時間比曲子長就接著繞回去
      t.el.preload = "auto";
    }
    if (!t.src && ctx) {
      t.src  = ctx.createMediaElementSource(t.el);
      t.gain = ctx.createGain();
      t.gain.gain.value = 0.0001;
      t.src.connect(t.gain).connect(master);
    }
    return t.el;
  }

  return {
    /** 解鎖時先接起來開始緩衝，真正要播才不會卡在下載 */
    prime() { if (enabled) ensure(); },

    start() {
      if (!enabled || t.on) return;
      const el = ensure();
      if (!t.gain) return;

      t.on = true;
      try { el.currentTime = 0; } catch { /* seek 不動就照樣播 */ }

      const now = ctx.currentTime;
      t.gain.gain.cancelScheduledValues(now);
      t.gain.gain.setValueAtTime(0.0001, now);
      t.gain.gain.exponentialRampToValueAtTime(volume, now + fadeIn);
      el.play().catch(() => {});   // 沒解鎖就播不出來，不用吵
    },

    stop() {
      if (!t.on) return;
      t.on = false;
      const el = t.el;
      if (!el) return;
      if (!enabled || !t.gain) { el.pause(); return; }

      const now = ctx.currentTime;
      t.gain.gain.cancelScheduledValues(now);
      t.gain.gain.setValueAtTime(Math.max(t.gain.gain.value, 0.0001), now);
      t.gain.gain.exponentialRampToValueAtTime(0.0001, now + fadeOut);
      // 淡出跑完才 pause；期間又被重新叫起來就不要停
      setTimeout(() => { if (!t.on) el.pause(); }, fadeOut * 1000 + 60);
    }
  };
}

const quizBgm   = makeTrack("bgm-quiz.mp3",   { volume: 0.5, fadeIn: 0.8, fadeOut: 0.5 });
const revealBgm = makeTrack("bgm-reveal.mp3", { volume: 0.4, fadeIn: 1.2, fadeOut: 0.8 });
const finalBgm  = makeTrack("bgm-final.mp3",  { volume: 0.45, fadeIn: 1.0, fadeOut: 0.8 });
const wheelBgm  = makeTrack("bgm-wheel.mp3",  { volume: 0.42, fadeIn: 0.4, fadeOut: 0.6 });

/** 開放作答 → 緊張的循環 */
export function startBgm() { quizBgm.start(); }
export function stopBgm()  { quizBgm.stop();  }

/** 公布答案後的講解 → 鋼琴弦樂鋪底，壓低一點讓主持人講得下去 */
export function startRevealBgm() { revealBgm.start(); }
export function stopRevealBgm()  { revealBgm.stop();  }

/** 排行榜 → funk 墊在揭曉名次底下 */
export function startFinalBgm() { finalBgm.start(); }
export function stopFinalBgm()  { finalBgm.stop();  }

/** 加倍轉盤 → upbeat 墊在轉盤的答答聲底下 */
export function startWheelBgm() { wheelBgm.start(); }
export function stopWheelBgm()  { wheelBgm.stop();  }

// ---------- 主持人隨時可以放的音檔（鐘聲、健康操） ----------
//  跟 BGM 不一樣的地方：不循環、放完就自己結束，而且主持人可以中途喊停。
//  沒按過「開啟音效」的話 Web Audio 接不起來，就退回 <audio> 自己的音量播 ——
//  「不要聲音，直接進入」也是一次點擊，多半還是放得出來。

/** 放完（或被喊停）時通知外面 —— 投影頁要拿它把 state.cue 收掉 */
let cueEndCb = null;
export function onCueEnd(fn) { cueEndCb = fn; }

function makeCue(file, { volume = 0.85, fadeOut = 0.35 } = {}) {
  const t = { on: false, el: null, src: null, gain: null };

  function ensure() {
    if (!t.el) {
      t.el = new Audio(AUDIO(file));
      t.el.preload = "auto";
      t.el.addEventListener("ended", () => { t.on = false; cueEndCb?.(); });
    }
    if (!t.src && ctx) {
      t.src  = ctx.createMediaElementSource(t.el);
      t.gain = ctx.createGain();
      t.gain.gain.value = volume;
      t.src.connect(t.gain).connect(master);
    }
    return t.el;
  }

  return {
    /** 解鎖時先接起來開始緩衝，按下去才不會卡在下載 */
    prime() { ensure(); },

    playing: () => t.on,

    start() {
      const el = ensure();
      t.on = true;
      try { el.currentTime = 0; } catch { /* seek 不動就照樣播 */ }

      if (t.gain) {
        const now = ctx.currentTime;
        t.gain.gain.cancelScheduledValues(now);
        t.gain.gain.setValueAtTime(volume, now);   // 上一次淡出留下的值要收回來
      } else {
        el.volume = volume;
      }
      el.play().catch(() => {});
    },

    stop() {
      if (!t.on) return;
      t.on = false;
      const el = t.el;
      if (!el) return;
      if (!t.gain) { el.pause(); return; }

      const now = ctx.currentTime;
      t.gain.gain.cancelScheduledValues(now);
      t.gain.gain.setValueAtTime(Math.max(t.gain.gain.value, 0.0001), now);
      t.gain.gain.exponentialRampToValueAtTime(0.0001, now + fadeOut);
      // 淡出跑完才 pause；期間又被重新叫起來就不要停
      setTimeout(() => { if (!t.on) el.pause(); }, fadeOut * 1000 + 60);
    }
  };
}

const cues = {
  bell:     makeCue("bell.m4a", { volume: 0.9 }),
  exercise: makeCue("lucy.m4a", { volume: 0.85 })
};

export const CUE_KINDS = Object.keys(cues);

/** 放一段音檔。同一時間只會有一段，換一段會先把前一段收掉。 */
export function startCue(kind) {
  if (!cues[kind]) return false;
  stopCue();
  cues[kind].start();
  return true;
}

/** 主持人喊停，或要換另一段 */
export function stopCue() {
  for (const c of Object.values(cues)) c.stop();
}

/** 現在正在放哪一段（沒有就是 null） */
export function cuePlaying() {
  return CUE_KINDS.find(k => cues[k].playing()) || null;
}

// ---------- 放一次就結束的音檔 ----------

/**
 * 例如轉盤停下來的那一聲。放完會呼叫 onEnd —— 投影頁靠它把背景音樂接回來，
 * 所以「載不到／放不出來／被喊停」也一定要叫到 onEnd，不然音樂就回不來了。
 */
function makeOneShot(file, { volume = 0.9 } = {}) {
  const t = { on: false, el: null, src: null, gain: null, onEnd: null };

  const fire = () => { t.on = false; const cb = t.onEnd; t.onEnd = null; cb?.(); };

  function ensure() {
    if (!t.el) {
      t.el = new Audio(AUDIO(file));
      t.el.preload = "auto";
      t.el.addEventListener("ended", fire);
      t.el.addEventListener("error", fire);   // 檔案不在也要讓音樂接回來
    }
    if (!t.src && ctx) {
      t.src  = ctx.createMediaElementSource(t.el);
      t.gain = ctx.createGain();
      t.gain.gain.value = volume;
      t.src.connect(t.gain).connect(master);
    }
    return t.el;
  }

  return {
    prime() { ensure(); },
    playing: () => t.on,
    start(onEnd) {
      const el = ensure();
      t.on = true;
      t.onEnd = onEnd || null;
      try { el.currentTime = 0; } catch { /* seek 不動就照樣播 */ }
      if (t.gain) t.gain.gain.setValueAtTime(volume, ctx.currentTime);
      else el.volume = volume;
      el.play().catch(fire);
    },
    stop() { t.el?.pause(); fire(); }
  };
}

const wowSfx = makeOneShot("wow.m4a", { volume: 0.9 });

/** 轉盤停下來的那一聲。放完（或放不出來）會呼叫 onEnd。 */
export function wow(onEnd) { wowSfx.start(onEnd); }
export function stopWow()  { wowSfx.stop(); }
/** 還在放嗎 —— 投影頁用它決定「保底計時器」要不要再等一下 */
export function wowPlaying() { return wowSfx.playing(); }

// ---------- 一次性音效（整段解碼，觸發時零延遲） ----------

const SFX_REVEAL_VOL = 0.8;
let sfxRevealBuf = null;

/** 解鎖後在背景把撞擊聲解碼好，公布答案那一刻才不會慢半拍 */
async function loadRevealSfx() {
  if (sfxRevealBuf || !ctx) return;
  try {
    const res = await fetch(AUDIO("sfx-reveal.mp3"));
    sfxRevealBuf = await ctx.decodeAudioData(await res.arrayBuffer());
  } catch { sfxRevealBuf = null; }   // 載不到就退回原本的合成和弦
}

/** 公布答案 —— 低沉的撞擊聲。音檔還沒好就先用合成音頂著。 */
export function fanfare() {
  if (!enabled) return;
  if (!sfxRevealBuf) {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => blip({ freq: f, dur: 0.5, type: "triangle", gain: 0.26, at: i * 0.075 }));
    noise({ dur: 0.45, gain: 0.1, hp: 1800, at: 0.25 });
    return;
  }
  const src = ctx.createBufferSource();
  const g   = ctx.createGain();
  g.gain.value = SFX_REVEAL_VOL;
  src.buffer = sfxRevealBuf;
  src.connect(g).connect(master);
  src.start(ctx.currentTime);
}

/** 某一組代表按下確認 —— 明亮的兩音上揚 */
export function confirmed() {
  blip({ freq: 784,  dur: 0.10, type: "sine",     gain: 0.34 });
  blip({ freq: 1175, dur: 0.16, type: "sine",     gain: 0.30, at: 0.085 });
  noise({ dur: 0.06, gain: 0.10, hp: 3000, at: 0.085 });
}

/** 轉盤每經過一格的「答」聲。轉快的時候會連成一串答答答。 */
export function wheelTick() {
  if (!enabled) return;
  blip({ freq: 1500, dur: 0.035, type: "square", gain: 0.16 });
  noise({ dur: 0.022, gain: 0.09, hp: 4000 });
}

/** 轉盤停下來 */
export function wheelStop() {
  blip({ freq: 660,  dur: 0.14, type: "triangle", gain: 0.3 });
  blip({ freq: 990,  dur: 0.2,  type: "triangle", gain: 0.28, at: 0.1 });
  blip({ freq: 1320, dur: 0.34, type: "triangle", gain: 0.26, at: 0.2 });
  noise({ dur: 0.25, gain: 0.12, hp: 2000, at: 0.2 });
}

/** 有一組代表就位 —— 比「確認送出」輕，是報到不是定案 */
export function joined() {
  blip({ freq: 587, dur: 0.09, type: "sine", gain: 0.24 });
  blip({ freq: 880, dur: 0.13, type: "sine", gain: 0.20, at: 0.07 });
}

/**
 * 時間到。
 * 刻意不用往下滑音 —— 下墜的音高聽起來像在嘲笑人，改成乾脆的一記撞擊：
 * 低頻衝擊 + 被掐住的金屬鑼聲 + 一記沉的小調和弦收尾。
 */
export function timeUp() {
  stopBgm();
  if (!enabled) return;
  const t = ctx.currentTime;

  // 低頻衝擊，短促、收得乾淨
  const thud = ctx.createOscillator();
  const tg   = ctx.createGain();
  thud.type = "sine";
  thud.frequency.setValueAtTime(98, t);
  thud.frequency.linearRampToValueAtTime(74, t + 0.09);
  tg.gain.setValueAtTime(0.55, t);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  thud.connect(tg).connect(master);
  thud.start(t);
  thud.stop(t + 0.32);

  // 金屬撞擊：非整數倍的泛音疊起來，像鑼被掐住的那一下
  [1245, 1867, 2490, 3320].forEach((f, i) => {
    blip({ freq: f, dur: 0.34 - i * 0.055, type: "triangle", gain: 0.15 - i * 0.028 });
  });
  noise({ dur: 0.13, gain: 0.2, hp: 1500 });

  // A 小調和弦收尾，給「結束了」的重量
  [110, 131, 165].forEach(f =>
    blip({ freq: f, dur: 0.8, type: "triangle", gain: 0.1, at: 0.02 }));
}

/** 全部結束、公布排行榜 */
export function victory() {
  const notes = [523, 659, 784, 1047, 1319];
  notes.forEach((f, i) => blip({ freq: f, dur: 0.62, type: "triangle", gain: 0.24, at: i * 0.1 }));
}
