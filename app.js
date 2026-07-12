// ============================================================
// 汉语道 ― アプリ本体
// 依存: data.js (APP_DATA)
// ============================================================

// ---------------- 状態管理 ----------------
const STORE_KEY = "hanyudao_v1";

const DEFAULT_STATE = () => ({
  srs: {},        // itemId -> {ef, iv(日), reps, due(ms), lapses}
  mistakes: {},   // itemId -> {wrong, total, label, kind}
  answers: { total: 0, correct: 0 },
  days: {},       // 'YYYY-MM-DD' -> {secs, answers}
  doneReading: {},
  doneScenes: {},
  doneGrammar: {},
  settings: { apiKey: "", model: "claude-sonnet-5", rate: 1.0, voiceURI: "" },
});

let S = loadState();
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULT_STATE();
    const s = Object.assign(DEFAULT_STATE(), JSON.parse(raw));
    s.settings = Object.assign(DEFAULT_STATE().settings, s.settings);
    return s;
  } catch (e) { return DEFAULT_STATE(); }
}
// localStorageが使えない環境（サンドボックス等）でもアプリ自体は動かす
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* メモリ上のみで継続 */ }
}

function todayKey(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function touchDay() {
  const k = todayKey();
  if (!S.days[k]) S.days[k] = { secs: 0, answers: 0 };
  return S.days[k];
}

// 学習時間の自動計測（タブ表示中のみ30秒ごと加算）
setInterval(() => {
  if (document.visibilityState === "visible") { touchDay().secs += 30; save(); }
}, 30000);

// ---------------- SRS (SM-2簡易版・忘却曲線) ----------------
function srsGet(id) { return S.srs[id] || null; }
function srsGrade(id, q) { // q: 0=もう一度 1=難しい 2=普通 3=簡単
  const now = Date.now();
  const c = S.srs[id] || { ef: 2.5, iv: 0, reps: 0, due: now, lapses: 0 };
  if (q === 0) {
    c.reps = 0; c.iv = 0; c.lapses++;
    c.due = now + 10 * 60 * 1000; // 10分後に再出題
    c.ef = Math.max(1.3, c.ef - 0.2);
  } else {
    let days;
    if (c.reps === 0) days = q === 3 ? 2 : 1;
    else if (c.reps === 1) days = q === 3 ? 6 : 3;
    else days = Math.round(c.iv * (q === 1 ? 1.2 : q === 2 ? c.ef : c.ef * 1.3));
    c.iv = Math.max(1, days); c.reps++;
    c.due = now + c.iv * 86400000;
    c.ef = Math.max(1.3, c.ef + (0.1 - (3 - q) * (0.08 + (3 - q) * 0.02)));
  }
  S.srs[id] = c; save();
}
function dueItems() {
  const now = Date.now();
  return Object.entries(S.srs).filter(([, c]) => c.due <= now).map(([id]) => id);
}
function isMastered(id) { const c = S.srs[id]; return !!c && c.iv >= 4 && c.reps >= 2; }

// ---------------- 成績・苦手分析 ----------------
function recordAnswer(id, correct, label, kind) {
  S.answers.total++; touchDay().answers++;
  if (correct) S.answers.correct++;
  const m = S.mistakes[id] || { wrong: 0, total: 0, label, kind };
  m.total++; m.label = label; m.kind = kind;
  if (!correct) {
    m.wrong++;
    // 間違えた項目はSRSで即再出題対象に
    const c = S.srs[id];
    if (c) { c.due = Date.now(); c.iv = Math.min(c.iv, 1); }
  }
  S.mistakes[id] = m; save();
}
function weakRanking(limit = 10) {
  return Object.entries(S.mistakes)
    .filter(([, m]) => m.wrong > 0)
    .sort((a, b) => (b[1].wrong / b[1].total) - (a[1].wrong / a[1].total) || b[1].wrong - a[1].wrong)
    .slice(0, limit)
    .map(([id, m]) => ({ id, ...m }));
}
function accuracy() { return S.answers.total ? Math.round(100 * S.answers.correct / S.answers.total) : null; }

function streak() {
  let n = 0; const d = new Date();
  if (!activeDay(todayKey(d))) d.setDate(d.getDate() - 1); // 今日未学習でも昨日から数える
  while (activeDay(todayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function activeDay(k) { const v = S.days[k]; return v && (v.secs >= 60 || v.answers > 0); }
function totalMinutes() { return Math.round(Object.values(S.days).reduce((a, v) => a + v.secs, 0) / 60); }
function totalDays() { return Object.keys(S.days).filter(activeDay).length; }
function masteredCount() { return APP_DATA.vocab.filter(v => isMastered(v.id)).length; }

function levelEstimate() {
  let est = 0;
  for (const l of APP_DATA.levels) {
    const words = APP_DATA.vocab.filter(v => v.lv === l.id);
    const m = words.filter(w => isMastered(w.id)).length;
    if (words.length && m / words.length >= 0.5) est = l.id;
  }
  if (est === 0) return { cefr: "A0（準備中）", hsk: "―", kentei: "―", lv: 0 };
  const l = APP_DATA.levels.find(x => x.id === est);
  return { cefr: l.cefr, hsk: l.hsk, kentei: l.kentei, lv: est };
}

function itemById(id) {
  return APP_DATA.vocab.find(v => v.id === id)
    || APP_DATA.grammar.find(g => g.id === id) || null;
}

// ---------------- 音声 (TTS) ----------------
// 音声API非対応環境（テスト・一部ブラウザ）でも動作するようスタブを用意
if (!("speechSynthesis" in window)) {
  window.SpeechSynthesisUtterance = function () {};
  window.speechSynthesis = { cancel() {}, speak() {}, getVoices() { return []; }, onvoiceschanged: null };
}
let VOICES = [];
function refreshVoices() { VOICES = speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().replace("_", "-").startsWith("zh")); }
if ("speechSynthesis" in window) {
  refreshVoices();
  // Android Chrome等ではボイス一覧が遅れて届くため、届いたら設定画面を描き直す
  speechSynthesis.onvoiceschanged = () => {
    const before = VOICES.length;
    refreshVoices();
    if (VOICES.length !== before && typeof ROUTE !== "undefined" && ROUTE === "settings") render();
  };
}
// モバイルブラウザ対策：
// - iOS/Androidは「ユーザー操作の中で一度speakする」まで音声がアンロックされない
// - iOSは発話中のUtteranceがGCされると音が途中で止まるため参照を保持する
// - cancel()直後のspeak()が無視されることがあるため少し遅らせる
let CURRENT_UTTER = null;
let TTS_UNLOCKED = false;
function unlockTTS() {
  if (TTS_UNLOCKED || !("speechSynthesis" in window)) return;
  TTS_UNLOCKED = true;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch (e) {}
}
document.addEventListener("pointerdown", unlockTTS, { capture: true });
document.addEventListener("touchend", unlockTTS, { capture: true });

function makeUtterance(text, rate) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-CN";
  const v = VOICES.find(x => x.voiceURI === S.settings.voiceURI) || VOICES.find(x => x.lang === "zh-CN") || VOICES[0];
  if (v) u.voice = v;
  u.rate = rate !== undefined ? rate : S.settings.rate;
  return u;
}
function speak(text, rate) {
  if (!("speechSynthesis" in window)) return alert("このブラウザは音声合成に対応していません。");
  refreshVoices(); // モバイルでは音声リストが遅れて読み込まれるため毎回更新
  speechSynthesis.cancel();
  const u = makeUtterance(text, rate);
  CURRENT_UTTER = u;
  setTimeout(() => {
    speechSynthesis.speak(u);
    speechSynthesis.resume(); // Chromeがpaused状態で固まって無音になるバグへの対策
  }, 60);
}
// 連続再生
function speakSeq(texts, rate, gap = 700) {
  refreshVoices();
  speechSynthesis.cancel();
  let i = 0;
  const next = () => {
    if (i >= texts.length) return;
    const u = makeUtterance(texts[i++], rate);
    u.onend = () => setTimeout(next, gap);
    CURRENT_UTTER = u;
    speechSynthesis.speak(u);
    speechSynthesis.resume();
  };
  setTimeout(next, 60);
}

// 🔊ボタン用レジストリ（中国語テキストをHTML属性に埋め込まない）
let SPEAK_REG = [];
function spk(text, rate) {
  const i = SPEAK_REG.push({ text, rate }) - 1;
  return `<button class="spk" data-act="speak" data-i="${i}" title="再生">🔊</button>`;
}

// ---------------- ユーティリティ ----------------
const $ = s => document.querySelector(s);
function esc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }
function pick(a, n) { return shuffle(a).slice(0, n); }
function normZh(t) { return t.replace(/[，。！？、；：""''“”‘’…·\s,.!?;:'"()（）]/g, ""); }

// ---------------- ルーター ----------------
let ROUTE = "home";
let SESSION = null; // 進行中の学習セッション
const CHAT = { teacher: [], coach: [], talk: [], roleplay: [], roleplayScene: null };

function navigate(route) {
  ROUTE = route; SESSION = null;
  speechSynthesis.cancel();
  render();
  window.scrollTo(0, 0);
}
document.addEventListener("click", e => {
  const nav = e.target.closest("[data-route]");
  if (nav) { navigate(nav.dataset.route); return; }
  const el = e.target.closest("[data-act]");
  if (el && ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el.dataset, el);
});

function render() {
  SPEAK_REG = [];
  document.querySelectorAll("[data-route]").forEach(n => n.classList.toggle("active", n.dataset.route === ROUTE));
  const due = dueItems().length;
  for (const id of ["reviewBadge", "reviewBadgeM"]) {
    const b = document.getElementById(id);
    if (b) { b.style.display = due ? "" : "none"; b.textContent = due; }
  }
  VIEWS[ROUTE] ? VIEWS[ROUTE]() : VIEWS.home();
}

// ============================================================
// 各ビュー
// ============================================================
const VIEWS = {};

// ---------------- ホーム ----------------
VIEWS.home = () => {
  const est = levelEstimate();
  const due = dueItems().length;
  const weak = weakRanking(5);
  const acc = accuracy();
  const coach = coachSuggestions();
  $("#view").innerHTML = `
    <h1 class="page-title">你好！今日も学びましょう 🇨🇳</h1>
    <p class="page-sub">日本語話者向けに最適化された中国語総合学習アプリ</p>

    <div class="grid4">
      <div class="card stat-tile"><div class="num">🔥 ${streak()}</div><div class="lbl">継続日数</div></div>
      <div class="card stat-tile"><div class="num">${totalMinutes()}<span style="font-size:14px">分</span></div><div class="lbl">総学習時間</div></div>
      <div class="card stat-tile"><div class="num">${masteredCount()}<span style="font-size:14px">語</span></div><div class="lbl">習得語彙</div></div>
      <div class="card stat-tile"><div class="num">${acc === null ? "―" : acc + "%"}</div><div class="lbl">正答率</div></div>
    </div>

    <div class="card">
      <h3>📊 推定レベル</h3>
      <span class="level-badge" style="background:var(--green)">CEFR ${est.cefr}</span>
      <span class="level-badge" style="background:var(--blue)">${est.hsk}</span>
      <span class="level-badge" style="background:var(--gold)">${est.kentei}</span>
      <p class="muted" style="margin-top:8px">語彙の定着状況とクイズ正答率から自動推定しています。</p>
    </div>

    ${due ? `<div class="card" style="border-color:var(--gold)">
      <h3>🔁 復習の時間です</h3>
      <p>忘却曲線に基づき <b>${due}件</b> が復習期限を迎えています。</p>
      <div class="btn-row"><button data-route="review">今すぐ復習する</button></div>
    </div>` : ""}

    <div class="card">
      <h3>🤖 AIコーチからの提案</h3>
      ${coach.map(c => `<p style="margin:6px 0">・${c}</p>`).join("")}
      <div class="btn-row"><button class="secondary small" data-route="ai">AIコーチに詳しく聞く</button></div>
    </div>

    ${weak.length ? `<div class="card">
      <h3>⚠️ 苦手ランキング</h3>
      ${weak.map(w => {
        const it = itemById(w.id);
        return `<div class="weak-item"><span>${esc(w.label || (it ? it.zh || it.title : w.id))}</span>
          <span class="muted">${w.wrong}回ミス / ${w.total}回</span></div>`;
      }).join("")}
    </div>` : ""}

    <h3 style="margin:4px 0 10px">学習メニュー</h3>
    <div class="grid3">
      <div class="card clickable" data-route="vocab"><h3>📚 単語</h3><p class="muted">SRSフラッシュカード・クイズ</p></div>
      <div class="card clickable" data-route="grammar"><h3>✏️ 文法</h3><p class="muted">了・过・着…アスペクト攻略</p></div>
      <div class="card clickable" data-route="scenes"><h3>💬 会話</h3><p class="muted">12シーン + AIロールプレイ</p></div>
      <div class="card clickable" data-route="reading"><h3>📖 読解</h3><p class="muted">短文→中文→長文</p></div>
      <div class="card clickable" data-route="listening"><h3>🎧 リスニング</h3><p class="muted">ディクテーション・シャドーイング</p></div>
      <div class="card clickable" data-route="pron"><h3>🗣️ 発音</h3><p class="muted">四声・ピンイン・声調クイズ</p></div>
      <div class="card clickable" data-route="roadmap"><h3>🗺️ ロードマップ</h3><p class="muted">A1→B2 4ステージ</p></div>
      <div class="card clickable" data-route="review"><h3>🔁 復習</h3><p class="muted">忘却曲線で自動出題</p></div>
      <div class="card clickable" data-route="settings"><h3>⚙️ 設定</h3><p class="muted">AI・音声・データ管理</p></div>
    </div>
  `;
};

function coachSuggestions() {
  const out = [];
  const due = dueItems().length;
  const weak = weakRanking(3);
  const est = levelEstimate();
  if (due > 0) out.push(`復習期限の項目が <b>${due}件</b> あります。記憶が薄れる前に復習しましょう。`);
  if (weak.length) {
    const it = itemById(weak[0].id);
    out.push(`最近のミスが多いのは「<b>${esc(weak[0].label || (it ? it.zh || it.title : ""))}</b>」。集中的に復習しましょう。`);
  }
  const today = S.days[todayKey()];
  if (!today || today.secs < 600) out.push("今日の学習はまだ10分未満。まず単語クイズを1セット（約3分）どうぞ。");
  if (est.lv === 0) out.push("まずは<b>発音（声調・ピンイン）</b>とレベル1の単語30語から始めるのがおすすめです。");
  else if (est.lv < 4) out.push(`レベル${est.lv}が定着してきました。ロードマップのステージ${est.lv + 1}に進みましょう。`);
  else out.push("素晴らしい進捗です！AI自由会話で実践力を磨きましょう。");
  return out.slice(0, 3);
}

// ---------------- ロードマップ ----------------
VIEWS.roadmap = () => {
  const est = levelEstimate();
  $("#view").innerHTML = `
    <h1 class="page-title">🗺️ 学習ロードマップ</h1>
    <p class="page-sub">CEFR A1→B2 / HSK / 中国語検定に対応した4ステージ</p>
    ${APP_DATA.roadmap.map(st => {
      const words = APP_DATA.vocab.filter(v => v.lv === st.items.vocabLv);
      const m = words.filter(w => isMastered(w.id)).length;
      const gDone = st.items.grammar.filter(g => S.doneGrammar[g]).length;
      const rDone = st.items.reading.filter(r => S.doneReading[r]).length;
      const sDone = st.items.scenes.filter(s => S.doneScenes[s]).length;
      const totalItems = words.length + st.items.grammar.length + st.items.reading.length + st.items.scenes.length;
      const doneItems = m + gDone + rDone + sDone;
      const prog = totalItems ? Math.round(100 * doneItems / totalItems) : 0;
      const dotCls = prog >= 90 ? "done" : (est.lv + 1 === st.stage || (est.lv === 0 && st.stage === 1) ? "now" : "");
      return `<div class="stage">
        <div class="stage-dot ${dotCls}"></div>
        <div class="card">
          <h3>Stage ${st.stage}：${esc(st.title)}</h3>
          <div style="margin:6px 0">
            <span class="level-badge" style="background:var(--green)">CEFR ${st.cefr}</span>
            <span class="level-badge" style="background:var(--blue)">${st.hsk}</span>
            <span class="level-badge" style="background:var(--gold)">${st.kentei}</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${prog}%"></div></div>
          <p class="muted">達成度 ${prog}%（単語 ${m}/${words.length}・文法 ${gDone}/${st.items.grammar.length}・読解 ${rDone}/${st.items.reading.length}・会話 ${sDone}/${st.items.scenes.length}）</p>
          <p style="font-size:14px;margin-top:8px">${st.goals.map(g => `<span class="pill">${esc(g)}</span>`).join("")}</p>
          <div class="btn-row">
            <button class="small" data-act="vocabLevel" data-lv="${st.items.vocabLv}">単語を学ぶ</button>
            <button class="small secondary" data-route="grammar">文法へ</button>
            <button class="small secondary" data-route="reading">読解へ</button>
          </div>
        </div>
      </div>`;
    }).join("")}
  `;
};

// ---------------- 単語 ----------------
VIEWS.vocab = () => {
  if (SESSION && SESSION.view === "vocab") return renderVocabSession();
  $("#view").innerHTML = `
    <h1 class="page-title">📚 単語学習</h1>
    <p class="page-sub">SRS（忘却曲線）で最適なタイミングに復習。レベルを選んでモードを選択。</p>
    ${APP_DATA.levels.map(l => {
      const words = APP_DATA.vocab.filter(v => v.lv === l.id);
      const m = words.filter(w => isMastered(w.id)).length;
      return `<div class="card">
        <h3><span class="level-badge" style="background:${l.color}">Lv${l.id} ${l.name}</span> ${l.hsk} / ${l.kentei}</h3>
        <div class="progress-track"><div class="progress-fill" style="width:${Math.round(100 * m / words.length)}%"></div></div>
        <p class="muted">${m} / ${words.length} 語 習得済み</p>
        <div class="btn-row">
          <button class="small" data-act="startFlash" data-lv="${l.id}">📇 フラッシュカード</button>
          <button class="small secondary" data-act="startQuiz" data-lv="${l.id}" data-mode="zh2ja">🀄→🇯🇵 クイズ</button>
          <button class="small secondary" data-act="startQuiz" data-lv="${l.id}" data-mode="ja2zh">🇯🇵→🀄 クイズ</button>
          <button class="small secondary" data-act="startQuiz" data-lv="${l.id}" data-mode="listen">🎧 リスニングクイズ</button>
          <button class="small secondary" data-act="wordList" data-lv="${l.id}">📋 一覧</button>
        </div>
      </div>`;
    }).join("")}
  `;
};

function renderVocabSession() {
  const s = SESSION;
  if (s.mode === "flash") return renderFlash();
  if (s.mode === "list") return renderWordList();
  return renderQuiz();
}

function renderWordList() {
  const s = SESSION;
  const words = APP_DATA.vocab.filter(v => v.lv === s.lv);
  SPEAK_REG = [];
  $("#view").innerHTML = `
    <h1 class="page-title">📋 単語一覧（Lv${s.lv}・${words.length}語）</h1>
    <p class="page-sub"><a href="javascript:void 0" data-route="vocab">← 戻る</a></p>
    <input type="text" id="wordSearch" placeholder="🔍 検索（漢字・ピンイン・意味）" style="margin-bottom:12px">
    <div class="card"><table class="word-table">
      ${words.map(w => `<tr data-s="${esc((w.zh + w.py + w.ja).toLowerCase())}">
        <td class="w-zh">${esc(w.zh)} ${isMastered(w.id) ? "✅" : ""}</td>
        <td class="w-py">${esc(w.py)}</td>
        <td>${esc(w.ja)}</td>
        <td style="width:44px">${spk(w.zh)}</td>
      </tr>`).join("")}
    </table></div>
  `;
  $("#wordSearch").addEventListener("input", e => {
    const q = e.target.value.toLowerCase().trim();
    document.querySelectorAll("tr[data-s]").forEach(r => { r.style.display = !q || r.dataset.s.includes(q) ? "" : "none"; });
  });
}

// --- フラッシュカード ---
function startFlashSession(lv) {
  const now = Date.now();
  const words = APP_DATA.vocab.filter(v => v.lv === lv);
  const due = words.filter(w => S.srs[w.id] && S.srs[w.id].due <= now);
  const fresh = words.filter(w => !S.srs[w.id]).slice(0, 10);
  let queue = shuffle(due.concat(fresh));
  if (!queue.length) queue = pick(words, 10); // 全部学習済みなら軽い復習
  SESSION = { view: "vocab", mode: "flash", lv, queue, idx: 0, revealed: false, total: queue.length };
  render();
}
function renderFlash() {
  const s = SESSION;
  if (s.idx >= s.queue.length) return renderSessionResult("フラッシュカード完了！", `${s.total}枚学習しました`);
  const w = s.queue[s.idx];
  SPEAK_REG = [];
  $("#view").innerHTML = `
    <h1 class="page-title">📇 フラッシュカード</h1>
    <div class="progress-track"><div class="progress-fill" style="width:${Math.round(100 * s.idx / s.queue.length)}%"></div></div>
    <p class="muted">${s.idx + 1} / ${s.queue.length}</p>
    <div class="flashcard" data-act="flipCard">
      <div class="hanzi">${esc(w.zh)}</div>
      ${s.revealed ? `
        <div class="pinyin">${esc(w.py)}</div>
        <div class="meaning">${esc(w.ja)} ${w.pos ? `<span class="muted">〔${esc(w.pos)}〕</span>` : ""}${w.hsk ? `<span class="pill">HSK${w.hsk}</span>` : ""}</div>
        ${w.ex ? `<div class="example">${esc(w.ex.zh)}<br><span style="color:var(--primary)">${esc(w.ex.py)}</span><br>${esc(w.ex.ja)}</div>` : ""}
      ` : `<div class="hint">タップして答えを表示</div>`}
    </div>
    <div class="btn-row" style="justify-content:center">${spk(w.zh)} ${s.revealed && w.ex ? spk(w.ex.zh) : ""}</div>
    ${s.revealed ? `<div class="grade-row" style="margin-top:12px">
      <button class="g-again" data-act="gradeCard" data-q="0">もう一度<br><small>10分後</small></button>
      <button class="g-hard" data-act="gradeCard" data-q="1">難しい</button>
      <button class="g-good" data-act="gradeCard" data-q="2">普通</button>
      <button class="g-easy" data-act="gradeCard" data-q="3">簡単</button>
    </div>` : ""}
    <p style="margin-top:16px"><a href="javascript:void 0" data-route="vocab">← 単語メニューに戻る</a></p>
  `;
  if (!s.revealed) speak(w.zh);
}

// --- クイズ ---
function startQuizSession(lv, mode, fromItems) {
  const words = fromItems || pick(APP_DATA.vocab.filter(v => v.lv === lv), 10);
  SESSION = { view: "vocab", mode, lv, queue: shuffle(words), idx: 0, score: 0, answered: false, total: words.length };
  render();
}
function renderQuiz() {
  const s = SESSION;
  if (s.idx >= s.queue.length) {
    return renderSessionResult(`スコア：${s.score} / ${s.total}`, s.score === s.total ? "満点！素晴らしい！🎉" : "間違えた単語は自動的に復習キューに入りました。");
  }
  const w = s.queue[s.idx];
  const pool = APP_DATA.vocab.filter(v => v.id !== w.id && v.lv === w.lv);
  if (!s.opts) {
    const wrongs = pick(pool, 3);
    s.opts = shuffle([w].concat(wrongs));
  }
  const qHtml = s.mode === "zh2ja" ? `<div class="quiz-q">${esc(w.zh)}</div><p class="muted" style="text-align:center">意味はどれ？</p>`
    : s.mode === "ja2zh" ? `<div class="quiz-q small-q">「${esc(w.ja)}」</div><p class="muted" style="text-align:center">中国語はどれ？</p>`
    : `<div class="quiz-q">🎧</div><p class="muted" style="text-align:center">音声を聞いて意味を選んでください</p>`;
  SPEAK_REG = [];
  $("#view").innerHTML = `
    <h1 class="page-title">${s.mode === "listen" ? "🎧 リスニングクイズ" : "📝 単語クイズ"}</h1>
    <div class="progress-track"><div class="progress-fill" style="width:${Math.round(100 * s.idx / s.total)}%"></div></div>
    <p class="muted">${s.idx + 1} / ${s.total}　スコア ${s.score}</p>
    ${qHtml}
    ${s.mode === "listen" ? `<div style="text-align:center;margin-bottom:12px">${spk(w.zh)}</div>` : ""}
    <div class="quiz-opts">
      ${s.opts.map((o, i) => {
        let cls = "";
        if (s.answered) { if (o.id === w.id) cls = "correct"; else if (i === s.picked) cls = "wrong"; }
        const label = s.mode === "ja2zh" ? `${esc(o.zh)}<br><small style="color:var(--primary)">${esc(o.py)}</small>` : esc(o.ja);
        return `<button class="${cls}" data-act="answerQuiz" data-i="${i}" ${s.answered ? "disabled" : ""}>${label}</button>`;
      }).join("")}
    </div>
    ${s.answered ? `
      <div class="card" style="margin-top:14px">
        <b>${esc(w.zh)}</b>（${esc(w.py)}）＝ ${esc(w.ja)} ${spk(w.zh)}
        ${w.ex ? `<br><span class="muted">${esc(w.ex.zh)} ― ${esc(w.ex.ja)}</span>` : ""}
      </div>
      <div class="btn-row"><button data-act="nextQuiz">次へ →</button></div>` : ""}
    <p style="margin-top:16px"><a href="javascript:void 0" data-route="vocab">← 中断して戻る</a></p>
  `;
  if (s.mode === "listen" && !s.answered && !s.spoken) { s.spoken = true; speak(w.zh); }
}

function renderSessionResult(title, sub) {
  $("#view").innerHTML = `
    <div class="card" style="text-align:center;padding:40px 20px">
      <div class="result-big">${esc(title)}</div>
      <p>${esc(sub)}</p>
      <div class="btn-row" style="justify-content:center;margin-top:20px">
        <button data-route="${ROUTE}">もう一度</button>
        <button class="secondary" data-route="home">ホームへ</button>
      </div>
    </div>`;
  SESSION = null;
}

// ---------------- 文法 ----------------
VIEWS.grammar = () => {
  if (SESSION && SESSION.view === "grammar") return renderGrammarSession();
  const tags = [...new Set(APP_DATA.grammar.map(g => g.tag))];
  $("#view").innerHTML = `
    <h1 class="page-title">✏️ 文法</h1>
    <p class="page-sub">日本語話者がつまずく「了・过・着・在」などのアスペクト表現を重点解説。各項目に瞬間変換ドリル付き。</p>
    <div class="card" style="background:var(--primary-light);border-color:var(--primary)">
      <h3>⚡ 瞬間変換トレーニング（総合）</h3>
      <p class="muted">日本語を見て即座に中国語へ。スピーキングの基礎体力を作ります。</p>
      <div class="btn-row"><button data-act="startInstant">スタート</button></div>
    </div>
    ${tags.map(tag => `
      <h3 style="margin:18px 0 10px">【${esc(tag)}】</h3>
      ${APP_DATA.grammar.filter(g => g.tag === tag).map(g => `
        <div class="card clickable" data-act="openGrammar" data-id="${g.id}">
          <h3>${S.doneGrammar[g.id] ? "✅ " : ""}${esc(g.title)} <span class="level-badge" style="background:${APP_DATA.levels.find(l => l.id === g.lv).color}">Lv${g.lv}</span></h3>
          <p class="muted">${esc(g.summary)}</p>
        </div>`).join("")}
    `).join("")}
  `;
};

function renderGrammarSession() {
  const s = SESSION;
  if (s.mode === "detail") return renderGrammarDetail();
  if (s.mode === "drill") return renderDrill();
}

function renderGrammarDetail() {
  const g = APP_DATA.grammar.find(x => x.id === SESSION.id);
  SPEAK_REG = [];
  $("#view").innerHTML = `
    <p><a href="javascript:void 0" data-route="grammar">← 文法一覧</a></p>
    <h1 class="page-title">${esc(g.title)}</h1>
    <p class="page-sub"><span class="pill">${esc(g.tag)}</span><span class="pill">Lv${g.lv}</span></p>
    <div class="card"><h3>📖 解説</h3><p>${esc(g.explanation)}</p></div>
    <div class="card"><h3>💬 例文</h3>
      ${g.examples.map(e => `<div style="margin-bottom:12px">
        <div style="font-size:18px;font-weight:600">${esc(e.zh)} ${spk(e.zh)}</div>
        <div style="color:var(--primary);font-size:14px">${esc(e.py)}</div>
        <div class="muted">${esc(e.ja)}</div>
      </div>`).join("")}
    </div>
    <div class="card" style="border-color:var(--gold)"><h3>⚠️ 日本語話者のよくあるミス</h3>
      ${g.mistakes.map(m => `<p style="margin:6px 0">・${esc(m)}</p>`).join("")}
    </div>
    <div class="btn-row">
      <button data-act="startGrammarDrill" data-id="${g.id}">⚡ 瞬間変換ドリル（${g.drills.length}問）</button>
      <button class="secondary" data-act="markGrammarDone" data-id="${g.id}">${S.doneGrammar[g.id] ? "✅ 学習済み" : "学習済みにする"}</button>
    </div>
  `;
}

// --- 瞬間変換ドリル ---
function startDrill(items, backRoute, gid) {
  SESSION = { view: "grammar", mode: "drill", items: shuffle(items), idx: 0, revealed: false, ok: 0, backRoute: backRoute || "grammar", gid };
  render();
}
function renderDrill() {
  const s = SESSION;
  if (s.idx >= s.items.length) {
    if (s.gid) { S.doneGrammar[s.gid] = true; save(); }
    return renderSessionResult(`○ ${s.ok} / ${s.items.length}`, "×だった文は復習キューに追加されました。");
  }
  const d = s.items[s.idx];
  SPEAK_REG = [];
  $("#view").innerHTML = `
    <h1 class="page-title">⚡ 瞬間変換</h1>
    <div class="progress-track"><div class="progress-fill gold" style="width:${Math.round(100 * s.idx / s.items.length)}%"></div></div>
    <p class="muted">${s.idx + 1} / ${s.items.length}　声に出して言ってから答えを確認しましょう</p>
    <div class="flashcard" ${s.revealed ? "" : `data-act="revealDrill"`}>
      <div class="meaning" style="font-size:22px">「${esc(d.ja)}」</div>
      ${s.revealed ? `
        <div class="hanzi" style="font-size:30px;margin-top:14px">${esc(d.zh)}</div>
        <div class="pinyin" style="font-size:16px">${esc(d.py)}</div>
      ` : `<div class="hint">中国語で言えたらタップ</div>`}
    </div>
    ${s.revealed ? `
      <div style="text-align:center;margin-bottom:10px">${spk(d.zh)}</div>
      <div class="grade-row">
        <button class="g-again" data-act="gradeDrill" data-ok="0">× 言えなかった</button>
        <button class="g-good" data-act="gradeDrill" data-ok="1">○ 言えた</button>
      </div>` : ""}
    <p style="margin-top:16px"><a href="javascript:void 0" data-route="${s.backRoute}">← 中断して戻る</a></p>
  `;
}

// ---------------- 読解 ----------------
VIEWS.reading = () => {
  if (SESSION && SESSION.view === "reading") return renderReadingDetail();
  const types = ["短文", "中文", "長文"];
  $("#view").innerHTML = `
    <h1 class="page-title">📖 読解</h1>
    <p class="page-sub">短文→中文→長文とステップアップ。新出単語・文法解説・音声・内容理解問題つき。</p>
    ${types.map(t => `
      <h3 style="margin:18px 0 10px">【${t}】</h3>
      <div class="grid2">
      ${APP_DATA.reading.filter(r => r.type === t).map(r => `
        <div class="card clickable" data-act="openReading" data-id="${r.id}">
          <h3>${S.doneReading[r.id] ? "✅ " : ""}${esc(r.title)}</h3>
          <p class="muted"><span class="pill">${esc(r.theme)}</span><span class="pill">Lv${r.lv}</span></p>
        </div>`).join("")}
      </div>
    `).join("")}
  `;
};

function renderReadingDetail() {
  const s = SESSION;
  const r = APP_DATA.reading.find(x => x.id === s.id);
  SPEAK_REG = [];
  const answered = s.answers || {};
  const allCorrect = r.questions.every((q, i) => answered[i] === q.answer);
  $("#view").innerHTML = `
    <p><a href="javascript:void 0" data-route="reading">← 読解一覧</a></p>
    <h1 class="page-title">${esc(r.title)}</h1>
    <p class="page-sub"><span class="pill">${esc(r.type)}</span><span class="pill">${esc(r.theme)}</span><span class="pill">Lv${r.lv}</span></p>

    <div class="card">
      <div class="btn-row" style="margin:0 0 12px">
        ${spk(r.zh, 0.85)}
        <button class="small secondary" data-act="togglePy">${s.showPy ? "ピンインを隠す" : "ピンイン表示"}</button>
        <button class="small secondary" data-act="toggleJa">${s.showJa ? "訳を隠す" : "日本語訳表示"}</button>
      </div>
      <div class="reading-text">${esc(r.zh)}</div>
      ${s.showPy && r.py ? `<div class="reading-py">${esc(r.py)}</div>` : ""}
      ${s.showJa ? `<div class="reading-ja">${esc(r.ja)}</div>` : ""}
    </div>

    <div class="card"><h3>🆕 新出単語</h3><table class="word-table">
      ${r.words.map(w => `<tr><td class="w-zh">${esc(w.zh)}</td><td class="w-py">${esc(w.py)}</td><td>${esc(w.ja)}</td><td style="width:44px">${spk(w.zh)}</td></tr>`).join("")}
    </table></div>

    <div class="card"><h3>✏️ 文法メモ</h3><p>${esc(r.grammarNote)}</p></div>

    <div class="card"><h3>❓ 内容理解</h3>
      ${r.questions.map((q, qi) => `
        <p style="font-weight:700;margin-top:${qi ? 14 : 0}px">Q${qi + 1}. ${esc(q.q)}</p>
        <div class="quiz-opts" style="margin-top:8px">
          ${q.options.map((o, oi) => {
            let cls = "";
            if (answered[qi] !== undefined) {
              if (oi === q.answer) cls = "correct";
              else if (oi === answered[qi]) cls = "wrong";
            }
            return `<button class="${cls}" data-act="answerReading" data-q="${qi}" data-o="${oi}" ${answered[qi] !== undefined ? "disabled" : ""}>${esc(o)}</button>`;
          }).join("")}
        </div>
      `).join("")}
      ${allCorrect && Object.keys(answered).length === r.questions.length ? `<p style="color:var(--green);font-weight:700;margin-top:12px">🎉 全問正解！この読解は学習済みになりました。</p>` : ""}
    </div>

    ${r.summaryTask ? `<div class="card"><h3>📝 要約タスク</h3><p>${esc(r.summaryTask)}</p></div>` : ""}

    <div class="card"><h3>🤖 AIに質問する</h3>
      <p class="muted">この文章について分からないことをAI教師に聞けます（設定でAPIキーが必要）。</p>
      <div class="chat-box" id="readingChat">${(s.chat || []).map(m => chatBubble(m)).join("")}</div>
      <div class="chat-input-row">
        <textarea id="readingQ" placeholder="例：「越来越」の使い方をもっと教えて"></textarea>
        <button data-act="askReading">送信</button>
      </div>
    </div>
  `;
}

// ---------------- リスニング ----------------
VIEWS.listening = () => {
  if (!SESSION || SESSION.view !== "listening") SESSION = { view: "listening", tab: "dictation", rate: S.settings.rate };
  const s = SESSION;
  SPEAK_REG = [];
  let body = "";
  if (s.tab === "dictation") body = dictationBody(s);
  else body = shadowingBody(s);
  $("#view").innerHTML = `
    <h1 class="page-title">🎧 リスニング</h1>
    <p class="page-sub">ディクテーション（書き取り）とシャドーイング。速度変更対応。</p>
    <div class="tabs">
      <button class="${s.tab === "dictation" ? "active" : ""}" data-act="listenTab" data-tab="dictation">✍️ ディクテーション</button>
      <button class="${s.tab === "shadow" ? "active" : ""}" data-act="listenTab" data-tab="shadow">🗣️ シャドーイング</button>
    </div>
    <div class="card">
      <label class="field">再生速度：<span id="rateVal">${s.rate.toFixed(2)}x</span></label>
      <input type="range" min="0.5" max="1.5" step="0.05" value="${s.rate}" style="width:100%" data-act-input="listenRate" id="rateSlider">
    </div>
    ${body}
  `;
  const slider = $("#rateSlider");
  if (slider) slider.addEventListener("input", e => { s.rate = parseFloat(e.target.value); $("#rateVal").textContent = s.rate.toFixed(2) + "x"; });
}

function dictationBody(s) {
  if (s.item === undefined) s.item = null;
  if (!s.item) {
    return `<div class="card"><h3>レベルを選んで開始</h3><div class="btn-row">
      ${APP_DATA.levels.map(l => `<button class="small" data-act="startDict" data-lv="${l.id}" style="background:${l.color}">Lv${l.id} ${l.name}</button>`).join("")}
      <button class="small secondary" data-act="startDict" data-lv="0">ランダム</button>
    </div></div>`;
  }
  const d = s.item;
  return `<div class="card">
    <h3>✍️ 聞こえた中国語を入力してください</h3>
    <div class="btn-row" style="margin:8px 0 12px">
      <button class="small" data-act="playDict">▶ 再生</button>
      <button class="small secondary" data-act="playDictSlow">🐢 ゆっくり再生</button>
    </div>
    <input type="text" id="dictInput" placeholder="簡体字で入力（句読点は不要）" value="${esc(s.input || "")}" ${s.checked ? "disabled" : ""}>
    <div class="btn-row">
      ${s.checked ? `<button data-act="nextDict">次の問題 →</button>` : `<button data-act="checkDict">答え合わせ</button>
      <button class="secondary" data-act="revealDict">答えを見る</button>`}
    </div>
    ${s.checked ? `<div style="margin-top:14px">
      <p>${s.diffHtml}</p>
      <p style="font-size:18px;font-weight:700;margin-top:8px">${esc(d.zh)} ${spk(d.zh, s.rate)}</p>
      <p style="color:var(--primary)">${esc(d.py)}</p>
      <p class="muted">${esc(d.ja)}</p>
      <p style="font-weight:700;color:${s.correct ? "var(--green)" : "#d95a4e"}">${s.correct ? "✅ 正解！" : "もう少し！間違い箇所は赤で表示しています。"}</p>
    </div>` : ""}
  </div>`;
}

function shadowingBody(s) {
  return `<div class="card">
    <h3>🗣️ シャドーイング練習</h3>
    <p class="muted">音声を再生し、影のようにすぐ後を追って発音しましょう。連続再生も可能です。</p>
    <div class="btn-row" style="margin-bottom:14px"><button class="small" data-act="playAllShadow">▶ 全文連続再生</button></div>
    ${APP_DATA.dictation.map((d, i) => `
      <div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:17px;font-weight:600">${esc(d.zh)} ${spk(d.zh, undefined)} <span class="pill">Lv${d.lv}</span></div>
        <div style="color:var(--primary);font-size:13px">${esc(d.py)}</div>
        <div class="muted">${esc(d.ja)}</div>
      </div>`).join("")}
  </div>`;
}

// ---------------- 会話 ----------------
VIEWS.scenes = () => {
  if (SESSION && SESSION.view === "scenes") return renderSceneDetail();
  $("#view").innerHTML = `
    <h1 class="page-title">💬 会話</h1>
    <p class="page-sub">シーン別ダイアログで表現を学び、AIロールプレイで実践。</p>
    <div class="grid3">
      ${APP_DATA.scenes.map(sc => `
        <div class="card clickable" data-act="openScene" data-id="${sc.id}" style="text-align:center">
          <div style="font-size:34px">${sc.icon}</div>
          <h3>${S.doneScenes[sc.id] ? "✅ " : ""}${esc(sc.title)}</h3>
          <span class="pill">Lv${sc.lv}</span>
        </div>`).join("")}
    </div>
  `;
};

function renderSceneDetail() {
  const s = SESSION;
  const sc = APP_DATA.scenes.find(x => x.id === s.id);
  SPEAK_REG = [];
  $("#view").innerHTML = `
    <p><a href="javascript:void 0" data-route="scenes">← 会話一覧</a></p>
    <h1 class="page-title">${sc.icon} ${esc(sc.title)}</h1>
    <div class="btn-row" style="margin-bottom:16px">
      <button class="small" data-act="playScene">▶ 会話を通しで聞く</button>
      <button class="small secondary" data-act="toggleScenePy">${s.hidePy ? "ピンイン表示" : "ピンイン非表示"}</button>
      <button class="small secondary" data-act="toggleSceneJa">${s.hideJa ? "訳を表示" : "訳を非表示"}</button>
      <button class="small secondary" data-act="roleMode">${s.role ? "ロール練習中：" + s.role + " をやめる" : "🎭 ロール練習（B役）"}</button>
      <button class="small secondary" data-act="markSceneDone">${S.doneScenes[sc.id] ? "✅ 学習済み" : "学習済みにする"}</button>
    </div>
    ${s.role ? `<div class="notice">あなたは <b>B役</b> です。Aの音声を聞いたら、ぼかされたBのセリフを自分で言ってみてから、吹き出しをタップして確認しましょう。</div>` : ""}
    <div class="card">
      ${sc.lines.map((l, i) => {
        const hidden = s.role === "B" && l.sp === "B" && !s.revealedLines[i];
        return `<div class="dialog-line sp${l.sp}">
          <div class="avatar">${l.sp}</div>
          <div class="bubble ${hidden ? "hidden-line" : ""}" data-act="revealLine" data-i="${i}">
            <div class="zh">${esc(l.zh)} ${hidden ? "" : spk(l.zh)}</div>
            ${s.hidePy ? "" : `<div class="py">${esc(l.py)}</div>`}
            ${s.hideJa ? "" : `<div class="ja">${esc(l.ja)}</div>`}
          </div>
        </div>`;
      }).join("")}
    </div>
    <div class="card" style="background:var(--primary-light);border-color:var(--primary)">
      <h3>🤖 AIロールプレイ</h3>
      <p class="muted">このシーンをAIと実際に会話練習。あなたのレベルに合わせて調整され、最後にフィードバックがもらえます。</p>
      <div class="btn-row"><button data-act="startRoleplay" data-id="${sc.id}">AIロールプレイを開始</button></div>
    </div>
  `;
}

// ---------------- 発音 ----------------
VIEWS.pron = () => {
  if (!SESSION || SESSION.view !== "pron") SESSION = { view: "pron", tab: "tones" };
  const s = SESSION;
  const P = APP_DATA.pronunciation;
  SPEAK_REG = [];
  let body = "";
  if (s.tab === "tones") {
    body = `<div class="grid3">
      ${P.tones.map(t => `<div class="card tone-card">
        <div class="tone-mark">${t.mark}</div>
        <div class="tone-name">${esc(t.name)}</div>
        <div class="tone-desc">${esc(t.desc)}</div>
        <div class="tone-ex">${esc(t.ex.zh)} <span style="color:var(--primary)">${esc(t.ex.py)}</span></div>
        <div class="muted">${esc(t.ex.ja)}／${esc(t.kana)}</div>
        <div style="margin-top:8px">${spk(t.ex.zh, 0.8)}</div>
      </div>`).join("")}
    </div>
    <div class="card"><h3>🎵 まず「マー」で四声を体感</h3>
      <p class="muted">妈(mā)・麻(má)・马(mǎ)・骂(mà) ― 声調が変わると意味が変わります。</p>
      <div class="btn-row"><button class="small" data-act="playTonesDemo">▶ 四声を連続再生</button></div>
    </div>`;
  } else if (s.tab === "pinyin") {
    body = P.pinyinTips.map(sec => `<div class="card"><h3>${esc(sec.title)}</h3>
      ${sec.items.map(it => `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <b style="color:var(--primary);font-size:16px">${esc(it.py)}</b>
        <p style="font-size:14px;margin:4px 0">${esc(it.tip)}</p>
        <p class="muted">例：${esc(it.ex)} ${spk(it.ex.replace(/[a-zA-ZāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜÜü\s\/⇔]/g, ""), 0.8)}</p>
      </div>`).join("")}
    </div>`).join("");
  } else if (s.tab === "sandhi") {
    body = P.toneChanges.map(tc => `<div class="card">
      <h3>${esc(tc.title)}</h3><p style="font-size:14px">${esc(tc.desc)}</p>
      <p style="color:var(--primary);margin-top:6px">${esc(tc.ex)}</p>
    </div>`).join("") + `<div class="notice">${esc(P.katakanaNote)}</div>`;
  } else if (s.tab === "quiz") {
    body = toneQuizBody(s);
  }
  $("#view").innerHTML = `
    <h1 class="page-title">🗣️ 発音</h1>
    <p class="page-sub">声調（四声）・ピンイン・変調ルール。中国語学習の最重要基礎です。</p>
    <div class="tabs">
      <button class="${s.tab === "tones" ? "active" : ""}" data-act="pronTab" data-tab="tones">声調</button>
      <button class="${s.tab === "pinyin" ? "active" : ""}" data-act="pronTab" data-tab="pinyin">ピンイン攻略</button>
      <button class="${s.tab === "sandhi" ? "active" : ""}" data-act="pronTab" data-tab="sandhi">変調ルール</button>
      <button class="${s.tab === "quiz" ? "active" : ""}" data-act="pronTab" data-tab="quiz">🎧 声調クイズ</button>
    </div>
    ${body}
  `;
};

function toneQuizBody(s) {
  const P = APP_DATA.pronunciation;
  if (!s.quiz) {
    s.quiz = { items: shuffle(P.toneQuiz), idx: 0, score: 0, answered: false };
  }
  const q = s.quiz;
  if (q.idx >= q.items.length) {
    const msg = `スコア：${q.score} / ${q.items.length}`;
    s.quiz = null;
    return `<div class="card" style="text-align:center"><div class="result-big">${msg}</div>
      <div class="btn-row" style="justify-content:center"><button data-act="pronTab" data-tab="quiz">もう一度</button></div></div>`;
  }
  const item = q.items[q.idx];
  if (!q.opts) {
    const same = P.toneChoices.filter(c => c.includes("-") === item.tones.includes("-") && c !== item.tones);
    q.opts = shuffle([item.tones].concat(pick(same, 3)));
  }
  return `<div class="card" style="text-align:center">
    <p class="muted">${q.idx + 1} / ${q.items.length}　スコア ${q.score}</p>
    <div class="quiz-q">🎧 ${q.answered ? esc(item.zh) + "（" + esc(item.py) + "）" : "？"}</div>
    <div style="margin-bottom:14px">${spk(item.zh, 0.75)}</div>
    <p class="muted">聞こえた声調はどれ？（数字は第何声か、0は軽声）</p>
    <div class="quiz-opts" style="margin-top:10px">
      ${q.opts.map((o, i) => {
        let cls = "";
        if (q.answered) { if (o === item.tones) cls = "correct"; else if (i === q.picked) cls = "wrong"; }
        return `<button class="${cls}" data-act="answerTone" data-i="${i}" ${q.answered ? "disabled" : ""}>${o}声</button>`;
      }).join("")}
    </div>
    ${q.answered ? `<div class="btn-row" style="justify-content:center"><button data-act="nextTone">次へ →</button></div>` : ""}
  </div>`;
}

// ---------------- 復習 ----------------
VIEWS.review = () => {
  if (SESSION && SESSION.view === "vocab" && SESSION.mode === "flash") return renderFlash();
  const due = dueItems();
  const dueWords = due.map(itemById).filter(x => x && x.zh);
  const weak = weakRanking(10);
  $("#view").innerHTML = `
    <h1 class="page-title">🔁 自動復習</h1>
    <p class="page-sub">忘却曲線（SRS）に基づき、忘れかけたタイミングで自動的に再出題します。</p>
    <div class="card" style="${dueWords.length ? "border-color:var(--gold)" : ""}">
      <h3>📅 今日の復習キュー：${dueWords.length}件</h3>
      ${dueWords.length
        ? `<p class="muted">今が復習のベストタイミングです。</p>
           <div class="btn-row"><button data-act="startReview">復習を開始する</button></div>`
        : `<p class="muted">現在、期限が来ている復習項目はありません。新しい単語を学ぶと、ここに自動で復習予定が組まれます。</p>
           <div class="btn-row"><button class="secondary" data-route="vocab">新しい単語を学ぶ</button></div>`}
    </div>
    ${weak.length ? `<div class="card">
      <h3>⚠️ 苦手ランキング（ミス率順）</h3>
      ${weak.map(w => {
        const it = itemById(w.id);
        return `<div class="weak-item">
          <span>${esc(w.label || (it ? it.zh || it.title : w.id))} <span class="pill">${esc(w.kind || "")}</span></span>
          <span class="muted">ミス率 ${Math.round(100 * w.wrong / w.total)}%（${w.wrong}/${w.total}）</span>
        </div>`;
      }).join("")}
      <div class="btn-row"><button class="secondary small" data-act="startWeakQuiz">苦手単語だけクイズする</button></div>
    </div>` : ""}
    <div class="card">
      <h3>📈 学習記録</h3>
      <p>総学習時間：<b>${totalMinutes()}分</b>　学習日数：<b>${totalDays()}日</b>　継続：<b>${streak()}日</b></p>
      <p>解答数：<b>${S.answers.total}問</b>　正答率：<b>${accuracy() === null ? "―" : accuracy() + "%"}</b>　習得語彙：<b>${masteredCount()}語</b></p>
    </div>
  `;
};

// ---------------- AI ----------------
VIEWS.ai = () => {
  if (!SESSION || SESSION.view !== "ai") SESSION = { view: "ai", tab: "teacher" };
  const s = SESSION;
  const hasKey = !!S.settings.apiKey;
  const tabInfo = {
    teacher: { icon: "👨‍🏫", name: "AI教師", desc: "作文添削・文法解説・例文生成・宿題出題。日本語で質問できます。" },
    coach: { icon: "📋", name: "AIコーチ", desc: "あなたの学習データを分析し、弱点と学習計画を提案します。" },
    talk: { icon: "💬", name: "AI自由会話", desc: "レベルに合わせた中国語で自由会話。間違いはやさしく訂正してくれます。" },
    roleplay: { icon: "🎭", name: "ロールプレイ", desc: "会話シーンからロールプレイを開始すると、ここで対話できます。" },
  };
  const t = tabInfo[s.tab];
  const msgs = CHAT[s.tab];
  SPEAK_REG = [];
  $("#view").innerHTML = `
    <h1 class="page-title">🤖 AI学習アシスタント</h1>
    <p class="page-sub">AI教師・AIコーチ・AI会話。Claude API を利用します。</p>
    ${hasKey ? "" : `<div class="notice">⚠️ AI機能を使うには <a href="javascript:void 0" data-route="settings">設定</a> で Anthropic APIキーを登録してください。キーはこの端末の localStorage のみに保存されます。</div>`}
    <div class="tabs">
      ${Object.entries(tabInfo).map(([k, v]) => `<button class="${s.tab === k ? "active" : ""}" data-act="aiTab" data-tab="${k}">${v.icon} ${v.name}</button>`).join("")}
    </div>
    <div class="card">
      <h3>${t.icon} ${t.name}</h3>
      <p class="muted" style="margin-bottom:12px">${t.desc}</p>
      ${s.tab === "teacher" ? `<div class="quick-chips">
        <button data-act="aiQuick" data-q="次の中国語作文を添削してください：">✍️ 添削依頼</button>
        <button data-act="aiQuick" data-q="「了」と「过」の違いを例文つきで教えてください。">「了」と「过」の違い</button>
        <button data-act="aiQuick" data-q="私のレベルに合った作文の宿題を1つ出してください。">📝 宿題を出して</button>
        <button data-act="aiQuick" data-q="次の単語を使った例文を3つ作ってください：">例文を作って</button>
      </div>` : ""}
      ${s.tab === "coach" ? `<div class="quick-chips">
        <button data-act="aiCoachAnalyze">📊 学習データを分析してもらう</button>
      </div>` : ""}
      ${s.tab === "talk" && !msgs.length ? `<div class="quick-chips">
        <button data-act="aiTalkStart">🚀 会話を始める（AIから話しかけてもらう）</button>
      </div>` : ""}
      ${s.tab === "roleplay" && CHAT.roleplayScene ? `<p class="pill">シーン：${esc(CHAT.roleplayScene.title)}</p>
        <div class="quick-chips"><button data-act="aiRoleFeedback">🏁 会話を終えてフィードバックをもらう</button></div>` : ""}
      <div class="chat-box" id="chatBox">
        ${msgs.map(m => chatBubble(m)).join("") || `<p class="muted" style="text-align:center;padding:20px">まだメッセージはありません</p>`}
      </div>
      <div class="chat-input-row">
        <textarea id="chatInput" placeholder="${s.tab === "talk" || s.tab === "roleplay" ? "中国語で入力してみましょう（日本語でもOK）" : "日本語で質問できます"}"></textarea>
        <button data-act="aiSend" ${hasKey ? "" : "disabled"}>送信</button>
      </div>
    </div>
  `;
  const box = $("#chatBox");
  if (box) box.scrollTop = box.scrollHeight;
};

function chatBubble(m) {
  const hasZh = /[一-鿿]/.test(m.content);
  return `<div class="chat-msg ${m.role === "user" ? "user" : "ai"}${m.thinking ? " thinking" : ""}">${esc(m.content)}${m.role === "assistant" && hasZh && !m.thinking ? "<div style='margin-top:6px'>" + spk(m.content.replace(/[a-zA-Z0-9().,!?:;'"\-\n ]+/g, " ")) + "</div>" : ""}</div>`;
}

// ---------------- 設定 ----------------
VIEWS.settings = () => {
  refreshVoices(); // 表示時点の最新一覧を取得（モバイルでは遅れて増えることがある）
  const zhVoices = VOICES;
  $("#view").innerHTML = `
    <h1 class="page-title">⚙️ 設定</h1>
    <p class="page-sub">AI・音声・データの設定</p>
    <div class="card">
      <h3>🤖 AI設定（Anthropic API）</h3>
      <label class="field">APIキー（この端末にのみ保存されます）</label>
      <input type="password" id="setKey" value="${esc(S.settings.apiKey)}" placeholder="sk-ant-...">
      <label class="field">モデル</label>
      <select id="setModel">
        ${["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"].map(m => `<option value="${m}" ${S.settings.model === m ? "selected" : ""}>${m}</option>`).join("")}
      </select>
      <p class="muted" style="margin-top:8px">APIキーは <a href="https://console.anthropic.com/" target="_blank">console.anthropic.com</a> で取得できます。</p>
    </div>
    <div class="card">
      <h3>🔊 音声設定</h3>
      <label class="field">中国語ボイス</label>
      <select id="setVoice">
        <option value="">自動選択</option>
        ${zhVoices.map(v => `<option value="${esc(v.voiceURI)}" ${S.settings.voiceURI === v.voiceURI ? "selected" : ""}>${esc(v.name)} (${v.lang})</option>`).join("")}
      </select>
      <label class="field">標準再生速度：<span id="setRateVal">${S.settings.rate.toFixed(2)}x</span></label>
      <input type="range" id="setRate" min="0.5" max="1.5" step="0.05" value="${S.settings.rate}" style="width:100%">
      <div class="btn-row">
        <button class="small secondary" data-act="testVoice">🔊 テスト再生（你好，很高兴认识你）</button>
        <button class="small secondary" data-act="reloadVoices">🔄 ボイス一覧を再読み込み</button>
      </div>
      <p class="muted" style="margin-top:8px">※ 一覧に何も出なくても「自動選択」のままテスト再生で中国語が鳴れば正常です（端末の読み上げエンジンが自動で使われます）。</p>
      <p class="muted" style="margin-top:4px">🩺 診断：音声API ${"speechSynthesis" in window ? "対応" : "❌ 非対応"}／全ボイス ${("speechSynthesis" in window ? speechSynthesis.getVoices().length : 0)}個／中国語ボイス ${zhVoices.length}個${zhVoices.length ? "（" + esc(zhVoices[0].name) + " 等）" : ""}</p>
      <p class="notice" style="margin-top:10px">📱 スマホで音が出ない場合：<b>iPhoneは本体横の消音スイッチ（マナーモード）をオフ</b>にしてください。あわせてメディア音量も確認を。Androidで中国語音声が無い場合は「設定→システム→言語」からGoogle TTSの中国語をインストールしてください。</p>
      ${zhVoices.length ? "" : `<p class="notice" style="margin-top:10px">⚠️ 中国語の音声が見つかりません。<br>
        <b>Android（Galaxy等）</b>：Playストアで「Google スピーチサービス」を入手 → 設定→一般管理→テキスト読み上げ で優先エンジンを<b>Google</b>に変更 → ⚙️→音声データをインストール→中国語（中国）→ ブラウザを再起動。Samsung Internetではなく<b>Chrome</b>で開いてください。<br>
        <b>macOS</b>：システム設定 → アクセシビリティ → 読み上げコンテンツ で中国語ボイス（Tingting等）を追加してください。</p>`}
    </div>
    <div class="card">
      <h3>💾 データ管理</h3>
      <div class="btn-row">
        <button class="small" data-act="saveSettings">設定を保存</button>
        <button class="small secondary" data-act="exportData">学習データをエクスポート</button>
        <button class="small" style="background:#d95a4e" data-act="resetData">学習データをリセット</button>
      </div>
    </div>
  `;
  const r = $("#setRate");
  if (r) r.addEventListener("input", e => { $("#setRateVal").textContent = parseFloat(e.target.value).toFixed(2) + "x"; });
};

// ============================================================
// アクション（イベント委譲）
// ============================================================
const ACTIONS = {
  speak(d) {
    const r = SPEAK_REG[+d.i];
    if (!r) return;
    // リスニング画面では速度スライダーの現在値を優先
    const rate = r.rate !== undefined ? r.rate : (SESSION && SESSION.view === "listening" ? SESSION.rate : undefined);
    speak(r.text, rate);
  },

  // 単語
  vocabLevel(d) { navigate("vocab"); startFlashSession(+d.lv); },
  startFlash(d) { startFlashSession(+d.lv); },
  startQuiz(d) { startQuizSession(+d.lv, d.mode); },
  wordList(d) { SESSION = { view: "vocab", mode: "list", lv: +d.lv }; render(); },
  flipCard() { if (!SESSION.revealed) { SESSION.revealed = true; render(); } },
  gradeCard(d) {
    const s = SESSION; const w = s.queue[s.idx];
    const q = +d.q;
    srsGrade(w.id, q);
    recordAnswer(w.id, q >= 2, w.zh + "（" + w.ja + "）", "単語");
    if (q === 0) s.queue.push(w); // セッション内でも再出題
    s.idx++; s.revealed = false; render();
  },
  answerQuiz(d) {
    const s = SESSION; if (s.answered) return;
    const w = s.queue[s.idx];
    s.picked = +d.i; s.answered = true;
    const correct = s.opts[s.picked].id === w.id;
    if (correct) s.score++;
    recordAnswer(w.id, correct, w.zh + "（" + w.ja + "）", "単語");
    if (!S.srs[w.id]) srsGrade(w.id, correct ? 2 : 0);
    else if (!correct) srsGrade(w.id, 0);
    speak(w.zh);
    render();
  },
  nextQuiz() { const s = SESSION; s.idx++; s.answered = false; s.opts = null; s.picked = null; s.spoken = false; render(); },

  // 文法
  openGrammar(d) { SESSION = { view: "grammar", mode: "detail", id: d.id }; render(); },
  markGrammarDone(d) { S.doneGrammar[d.id] = !S.doneGrammar[d.id]; save(); render(); },
  startGrammarDrill(d) {
    const g = APP_DATA.grammar.find(x => x.id === d.id);
    const items = g.drills.map((dr, i) => ({ ...dr, _id: g.id + "_d" + i, _label: g.title, _kind: "文法" }));
    startDrill(items, "grammar", g.id);
  },
  startInstant() {
    const items = APP_DATA.instantDrills.map((dr, i) => ({ ...dr, _id: "inst_" + i, _label: dr.ja, _kind: "瞬間変換" }));
    startDrill(pick(items, 8), "grammar");
  },
  revealDrill() { SESSION.revealed = true; render(); speak(SESSION.items[SESSION.idx].zh); },
  gradeDrill(d) {
    const s = SESSION; const item = s.items[s.idx];
    const ok = d.ok === "1";
    if (ok) s.ok++;
    recordAnswer(item._id, ok, item._label || item.ja, item._kind || "文法");
    srsGrade(item._id, ok ? 2 : 0);
    s.idx++; s.revealed = false; render();
  },

  // 読解
  openReading(d) { SESSION = { view: "reading", id: d.id, showPy: false, showJa: false, answers: {}, chat: [] }; render(); },
  togglePy() { SESSION.showPy = !SESSION.showPy; render(); },
  toggleJa() { SESSION.showJa = !SESSION.showJa; render(); },
  answerReading(d) {
    const s = SESSION; const r = APP_DATA.reading.find(x => x.id === s.id);
    const qi = +d.q, oi = +d.o;
    if (s.answers[qi] !== undefined) return;
    s.answers[qi] = oi;
    const q = r.questions[qi];
    const correct = oi === q.answer;
    recordAnswer(r.id + "_q" + qi, correct, r.title + " Q" + (qi + 1), "読解");
    if (r.questions.every((qq, i) => s.answers[i] === qq.answer)) { S.doneReading[r.id] = true; save(); }
    render();
  },
  async askReading() {
    const s = SESSION; const r = APP_DATA.reading.find(x => x.id === s.id);
    const q = $("#readingQ").value.trim();
    if (!q) return;
    if (!S.settings.apiKey) return alert("設定画面でAPIキーを登録してください。");
    s.chat.push({ role: "user", content: q });
    s.chat.push({ role: "assistant", content: "考え中…", thinking: true });
    render();
    try {
      const sys = `あなたは日本語話者向けの中国語教師です。学習者は次の中国語の文章を読んでいます。質問に日本語でわかりやすく、例文を交えて答えてください。\n\n文章:\n${r.zh}\n\n日本語訳:\n${r.ja}`;
      const hist = s.chat.filter(m => !m.thinking).map(m => ({ role: m.role, content: m.content }));
      const ans = await callClaude(sys, hist);
      s.chat.splice(s.chat.length - 1, 1, { role: "assistant", content: ans });
    } catch (e) {
      s.chat.splice(s.chat.length - 1, 1, { role: "assistant", content: "エラー：" + e.message });
    }
    render();
  },

  // リスニング
  listenTab(d) { SESSION.tab = d.tab; SESSION.item = null; SESSION.checked = false; SESSION.input = ""; render(); },
  startDict(d) {
    const lv = +d.lv;
    const pool = lv ? APP_DATA.dictation.filter(x => x.lv === lv) : APP_DATA.dictation;
    SESSION.dictPool = shuffle(pool); SESSION.dictIdx = 0;
    SESSION.item = SESSION.dictPool[0]; SESSION.checked = false; SESSION.input = "";
    render(); speak(SESSION.item.zh, SESSION.rate);
  },
  playDict() { SESSION.input = $("#dictInput") ? $("#dictInput").value : SESSION.input; speak(SESSION.item.zh, SESSION.rate); },
  playDictSlow() { SESSION.input = $("#dictInput") ? $("#dictInput").value : SESSION.input; speak(SESSION.item.zh, Math.max(0.5, SESSION.rate - 0.3)); },
  checkDict() {
    const s = SESSION;
    s.input = $("#dictInput").value;
    const target = normZh(s.item.zh);
    const got = normZh(s.input);
    s.correct = target === got;
    // 文字単位で簡易diff表示
    let html = "あなたの解答：";
    for (let i = 0; i < Math.max(got.length, target.length); i++) {
      const c = got[i] || "＿";
      html += `<span class="${got[i] && got[i] === target[i] ? "diff-ok" : "diff-ng"}">${esc(c)}</span>`;
    }
    s.diffHtml = html;
    s.checked = true;
    recordAnswer("dict_" + normZh(s.item.zh), s.correct, "書き取り：" + s.item.zh, "リスニング");
    render();
  },
  revealDict() {
    const s = SESSION;
    s.input = $("#dictInput").value;
    s.correct = false; s.diffHtml = "";
    s.checked = true;
    recordAnswer("dict_" + normZh(s.item.zh), false, "書き取り：" + s.item.zh, "リスニング");
    render();
  },
  nextDict() {
    const s = SESSION;
    s.dictIdx = (s.dictIdx + 1) % s.dictPool.length;
    s.item = s.dictPool[s.dictIdx]; s.checked = false; s.input = ""; s.diffHtml = "";
    render(); speak(s.item.zh, s.rate);
  },
  playAllShadow() { speakSeq(APP_DATA.dictation.map(d => d.zh), SESSION.rate, 1500); },

  // 会話
  openScene(d) { SESSION = { view: "scenes", id: d.id, hidePy: false, hideJa: false, role: null, revealedLines: {} }; render(); },
  playScene() {
    const sc = APP_DATA.scenes.find(x => x.id === SESSION.id);
    speakSeq(sc.lines.map(l => l.zh), undefined, 900);
  },
  toggleScenePy() { SESSION.hidePy = !SESSION.hidePy; render(); },
  toggleSceneJa() { SESSION.hideJa = !SESSION.hideJa; render(); },
  roleMode() { SESSION.role = SESSION.role ? null : "B"; SESSION.revealedLines = {}; render(); },
  revealLine(d) {
    const s = SESSION;
    if (s.role !== "B") return;
    const sc = APP_DATA.scenes.find(x => x.id === s.id);
    const line = sc.lines[+d.i];
    if (line.sp === "B" && !s.revealedLines[d.i]) { s.revealedLines[d.i] = true; render(); speak(line.zh); }
  },
  markSceneDone() { const s = SESSION; S.doneScenes[s.id] = !S.doneScenes[s.id]; save(); render(); },
  startRoleplay(d) {
    const sc = APP_DATA.scenes.find(x => x.id === d.id);
    if (!S.settings.apiKey) { alert("AIロールプレイには設定画面でAPIキーの登録が必要です。"); navigate("settings"); return; }
    CHAT.roleplay = [];
    CHAT.roleplayScene = sc;
    SESSION = { view: "ai", tab: "roleplay" };
    ROUTE = "ai";
    render();
    aiRoleplayKickoff();
  },

  // 発音
  pronTab(d) { SESSION.tab = d.tab; if (d.tab === "quiz") SESSION.quiz = null; render(); },
  playTonesDemo() { speakSeq(["妈", "麻", "马", "骂"], 0.7, 800); },
  answerTone(d) {
    const q = SESSION.quiz; if (q.answered) return;
    const item = q.items[q.idx];
    q.picked = +d.i; q.answered = true;
    const correct = q.opts[q.picked] === item.tones;
    if (correct) q.score++;
    recordAnswer("tone_" + item.zh, correct, "声調：" + item.zh + "（" + item.py + "）", "発音");
    render();
  },
  nextTone() { const q = SESSION.quiz; q.idx++; q.answered = false; q.opts = null; q.picked = null; render(); },

  // 復習
  startReview() {
    const due = dueItems();
    const words = due.map(itemById).filter(x => x && x.zh);
    if (!words.length) return;
    SESSION = { view: "vocab", mode: "flash", lv: 0, queue: shuffle(words), idx: 0, revealed: false, total: words.length };
    render();
  },
  startWeakQuiz() {
    const weakIds = weakRanking(10).map(w => w.id);
    const words = weakIds.map(itemById).filter(x => x && x.zh && x.ja);
    if (!words.length) return alert("苦手な単語がまだありません。");
    startQuizSession(0, "zh2ja", words);
  },

  // AI
  aiTab(d) { SESSION.tab = d.tab; render(); },
  aiQuick(d) { const inp = $("#chatInput"); inp.value = d.q; inp.focus(); },
  async aiSend() {
    const inp = $("#chatInput");
    const text = inp.value.trim();
    if (!text) return;
    if (!S.settings.apiKey) return alert("設定画面でAPIキーを登録してください。");
    const tab = SESSION.tab;
    CHAT[tab].push({ role: "user", content: text });
    CHAT[tab].push({ role: "assistant", content: "考え中…", thinking: true });
    render();
    try {
      const ans = await callClaude(systemPromptFor(tab), CHAT[tab].filter(m => !m.thinking).map(m => ({ role: m.role, content: m.content })));
      CHAT[tab].splice(CHAT[tab].length - 1, 1, { role: "assistant", content: ans });
    } catch (e) {
      CHAT[tab].splice(CHAT[tab].length - 1, 1, { role: "assistant", content: "エラー：" + e.message });
    }
    render();
  },
  async aiCoachAnalyze() {
    if (!S.settings.apiKey) return alert("設定画面でAPIキーを登録してください。");
    const tab = "coach";
    CHAT[tab].push({ role: "user", content: "私の学習データを分析して、弱点と今後1週間の学習計画を提案してください。" });
    CHAT[tab].push({ role: "assistant", content: "分析中…", thinking: true });
    render();
    try {
      const ans = await callClaude(systemPromptFor(tab), CHAT[tab].filter(m => !m.thinking).map(m => ({ role: m.role, content: m.content })));
      CHAT[tab].splice(CHAT[tab].length - 1, 1, { role: "assistant", content: ans });
    } catch (e) {
      CHAT[tab].splice(CHAT[tab].length - 1, 1, { role: "assistant", content: "エラー：" + e.message });
    }
    render();
  },
  async aiTalkStart() {
    if (!S.settings.apiKey) return alert("設定画面でAPIキーを登録してください。");
    CHAT.talk.push({ role: "user", content: "（会話を始めてください）" });
    CHAT.talk.push({ role: "assistant", content: "考え中…", thinking: true });
    render();
    try {
      const ans = await callClaude(systemPromptFor("talk"), CHAT.talk.filter(m => !m.thinking).map(m => ({ role: m.role, content: m.content })));
      CHAT.talk.splice(CHAT.talk.length - 1, 1, { role: "assistant", content: ans });
    } catch (e) {
      CHAT.talk.splice(CHAT.talk.length - 1, 1, { role: "assistant", content: "エラー：" + e.message });
    }
    render();
  },
  async aiRoleFeedback() {
    CHAT.roleplay.push({ role: "user", content: "（ロールプレイを終了します。私の中国語について、良かった点・直すべき点・より自然な言い方を日本語でフィードバックしてください）" });
    CHAT.roleplay.push({ role: "assistant", content: "フィードバック作成中…", thinking: true });
    render();
    try {
      const ans = await callClaude(systemPromptFor("roleplay"), CHAT.roleplay.filter(m => !m.thinking).map(m => ({ role: m.role, content: m.content })));
      CHAT.roleplay.splice(CHAT.roleplay.length - 1, 1, { role: "assistant", content: ans });
      if (CHAT.roleplayScene) { S.doneScenes[CHAT.roleplayScene.id] = true; save(); }
    } catch (e) {
      CHAT.roleplay.splice(CHAT.roleplay.length - 1, 1, { role: "assistant", content: "エラー：" + e.message });
    }
    render();
  },

  // 設定
  saveSettings() {
    S.settings.apiKey = $("#setKey").value.trim();
    S.settings.model = $("#setModel").value;
    S.settings.voiceURI = $("#setVoice").value;
    S.settings.rate = parseFloat($("#setRate").value);
    save();
    alert("設定を保存しました。");
  },
  testVoice() {
    S.settings.voiceURI = $("#setVoice").value;
    S.settings.rate = parseFloat($("#setRate").value);
    speak("你好，很高兴认识你！");
  },
  reloadVoices() {
    // 無音発話でエンジンを起こしてから一覧を再取得（Android Chrome対策）
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch (e) {}
    refreshVoices();
    setTimeout(() => { refreshVoices(); render(); }, 500);
  },
  exportData() {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "hanyudao_backup_" + todayKey() + ".json";
    a.click();
  },
  resetData() {
    if (confirm("学習データ（進捗・SRS・統計）をすべてリセットします。よろしいですか？")) {
      const keep = S.settings;
      S = DEFAULT_STATE();
      S.settings = keep;
      save(); render();
    }
  },
};

// ---------------- AI (Claude API) ----------------
function systemPromptFor(tab) {
  const est = levelEstimate();
  const weak = weakRanking(5).map(w => `${w.label}（ミス${w.wrong}/${w.total}）`).join("、") || "データなし";
  const profile = `学習者プロフィール: 日本語話者。推定レベル CEFR ${est.cefr}（${est.hsk} / ${est.kentei}）。習得語彙 ${masteredCount()}語。総学習時間 ${totalMinutes()}分。正答率 ${accuracy() ?? "―"}%。苦手項目: ${weak}。`;
  if (tab === "teacher") {
    return `あなたは日本語話者向けの経験豊富な中国語教師です。${profile}
- 日本語で丁寧に解説し、中国語には必ずピンインを併記する
- 日本語話者特有の誤り（了の過去形化、能/会/可以の混同、語順など）に注意して指摘する
- 添削では「原文→修正→理由→より自然な言い方」の順で示す
- 例文は学習者のレベルに合わせ、簡潔に`;
  }
  if (tab === "coach") {
    return `あなたは学習科学（SLA・忘却曲線・習慣形成）に精通した中国語学習コーチです。${profile}
- 学習データに基づいて具体的に助言する
- 提案は「今日やること」「今週の計画」「弱点対策」の3部構成で、実行可能な小さいステップにする
- 励ましつつも現実的に。日本語で回答`;
  }
  if (tab === "roleplay" && CHAT.roleplayScene) {
    return `あなたは中国語会話ロールプレイの相手役です。シーン: ${CHAT.roleplayScene.title}。役割設定: ${CHAT.roleplayScene.aiPrompt}
${profile}
- 学習者のレベル（${est.cefr}）に合わせた簡単な中国語で話す（1〜2文ずつ）
- 各発話に【拼音】と（日本語訳）を添える
- 学習者が間違えても会話を続け、大きな誤りだけ ✏️ マークで短く訂正する
- フィードバックを求められたら日本語で「良かった点・改善点・より自然な表現」をまとめる`;
  }
  return `あなたは中国語の会話パートナーです。${profile}
- 学習者のレベル（${est.cefr}）に合わせた中国語で自由に会話する（1〜3文ずつ、簡単な語彙で）
- 各発話に【拼音】と（日本語訳）を添える
- 学習者の誤りは ✏️ で短く自然に訂正してから会話を続ける
- 時々質問を投げかけ、学習者に話させる`;
}

async function callClaude(system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": S.settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: S.settings.model, max_tokens: 1500, system, messages }),
  });
  if (!res.ok) {
    let msg = "HTTP " + res.status;
    try { const e = await res.json(); msg += " " + (e.error?.message || ""); } catch (_) {}
    throw new Error(msg);
  }
  const data = await res.json();
  return data.content.filter(b => b.type === "text").map(b => b.text).join("");
}

async function aiRoleplayKickoff() {
  CHAT.roleplay.push({ role: "user", content: "（ロールプレイを開始してください。あなたから話しかけてください）" });
  CHAT.roleplay.push({ role: "assistant", content: "考え中…", thinking: true });
  render();
  try {
    const ans = await callClaude(systemPromptFor("roleplay"), CHAT.roleplay.filter(m => !m.thinking).map(m => ({ role: m.role, content: m.content })));
    CHAT.roleplay.splice(CHAT.roleplay.length - 1, 1, { role: "assistant", content: ans });
  } catch (e) {
    CHAT.roleplay.splice(CHAT.roleplay.length - 1, 1, { role: "assistant", content: "エラー：" + e.message });
  }
  render();
}

// ---------------- 起動 ----------------
render();
