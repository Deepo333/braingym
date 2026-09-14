/* =========================================================
   Bloom — Writing & Grammar companion
   App logic (vanilla JS, no build step, localStorage only)
   ========================================================= */
(function(){
  "use strict";

  /* ---------------- storage ---------------- */
  const PREFIX = "bloom_v1_";
  function load(key, fallback){
    try{
      const raw = localStorage.getItem(PREFIX + key);
      if(raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    }catch(e){ return fallback; }
  }
  function save(key, val){
    try{
      if(val === null || val === undefined) localStorage.removeItem(PREFIX + key);
      else localStorage.setItem(PREFIX + key, JSON.stringify(val));
    }catch(e){ /* storage unavailable — app still works in-memory for this session */ }
  }

  /* ---------------- helpers ---------------- */
  function esc(str){
    return String(str == null ? "" : str).replace(/[&<>"']/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
    });
  }
  function renderPrompt(text){
    const parts = String(text).split(/⟦|⟧/);
    return parts.map(function(p, i){ return i % 2 === 1 ? "<mark>" + esc(p) + "</mark>" : esc(p); }).join("");
  }
  function uid(){ return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2,8); }
  function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
  function shuffle(arr){
    const a = arr.slice();
    for(let i = a.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function formatDate(ts){
    return new Date(ts).toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" });
  }
  function formatTime(ts){
    return new Date(ts).toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" });
  }
  function letterFor(i){ return String.fromCharCode(65 + i); }
  function pctColorClass(pct){ return pct >= 75 ? "" : pct >= 50 ? "mid" : "low"; }

  /* ---------------- passages lookup ---------------- */
  const PASSAGES = {};
  PLACEMENT_QUESTIONS.forEach(function(q){ if(q.passage) PASSAGES[q.passageId] = q.passage; });
  function getPassageFor(q){ return q.passage || (q.passageId ? PASSAGES[q.passageId] : null); }

  /* ---------------- state ---------------- */
  let placementResult = load("placementResult", null);
  let placementProgress = load("placementProgress", null);
  let moduleLevel = load("moduleLevel", null);
  let activeLesson = load("activeLesson", null);
  let history = load("history", []);
  let lastLessonResult = load("lastLessonResult", null);

  let view = "welcome";
  let viewParams = {};
  let selectedDuration = 10;
  let showSettings = false;

  function navigate(v, params){
    view = v;
    viewParams = params || {};
    showSettings = false;
    render();
    const main = document.getElementById("app-main");
    if(main) main.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  /* ---------------- placement test ---------------- */
  function startPlacement(){
    placementProgress = {
      order: PLACEMENT_QUESTIONS.map(function(q){ return q.id; }),
      answers: new Array(PLACEMENT_QUESTIONS.length).fill(null),
      currentIndex: 0,
      startedAt: Date.now()
    };
    save("placementProgress", placementProgress);
    navigate("placement");
  }
  function selectPlacementAnswer(idx){
    placementProgress.answers[placementProgress.currentIndex] = idx;
    save("placementProgress", placementProgress);
    render();
  }
  function nextPlacementQuestion(){
    if(placementProgress.answers[placementProgress.currentIndex] === null) return;
    if(placementProgress.currentIndex < placementProgress.order.length - 1){
      placementProgress.currentIndex++;
      save("placementProgress", placementProgress);
      navigate("placement");
    } else {
      finishPlacement();
    }
  }
  function prevPlacementQuestion(){
    if(placementProgress.currentIndex > 0){
      placementProgress.currentIndex--;
      save("placementProgress", placementProgress);
      navigate("placement");
    }
  }
  function levelFromPercent(pct){
    if(pct < 40) return 1;
    if(pct < 55) return 2;
    if(pct < 70) return 3;
    if(pct < 85) return 4;
    return 5;
  }
  function finishPlacement(){
    const byCat = {};
    Object.keys(CATEGORY_NAMES).forEach(function(c){ byCat[c] = { correct:0, total:0 }; });
    let correct = 0;
    PLACEMENT_QUESTIONS.forEach(function(q, i){
      const given = placementProgress.answers[i];
      byCat[q.category].total++;
      if(given === q.correctIndex){ correct++; byCat[q.category].correct++; }
    });
    const scorePercent = Math.round((correct / PLACEMENT_QUESTIONS.length) * 100);
    const level = levelFromPercent(scorePercent);
    const breakdown = Object.keys(byCat).map(function(c){
      const b = byCat[c];
      return { category:c, name:CATEGORY_NAMES[c], correct:b.correct, total:b.total, pct: b.total ? Math.round((b.correct / b.total) * 100) : 0 };
    }).sort(function(a,b){ return b.pct - a.pct; });

    placementResult = {
      level: level,
      levelName: LEVEL_NAMES[level],
      scorePercent: scorePercent,
      correct: correct,
      total: PLACEMENT_QUESTIONS.length,
      breakdown: breakdown,
      completedAt: Date.now()
    };
    save("placementResult", placementResult);
    placementProgress = null;
    save("placementProgress", null);
    moduleLevel = level;
    save("moduleLevel", moduleLevel);
    navigate("placement-result");
  }
  function restartPlacement(){
    placementProgress = null; save("placementProgress", null);
    startPlacement();
  }

  /* ---------------- lesson ---------------- */
  const DURATION_OPTIONS = [2, 5, 10, 15, 20, 30, 45, 60];
  function computeQuestionCount(minutes){
    return clamp(Math.round((minutes * 60) / 42), 3, 90);
  }
  function drawQuestions(level, count){
    const pool = GRAMMAR_BANK.filter(function(q){ return q.level === level; });
    let bag = [];
    while(bag.length < count){ bag = bag.concat(shuffle(pool)); }
    bag = bag.slice(0, count);
    return bag.map(function(orig){
      const pairs = orig.options.map(function(text, i){ return { text:text, correct: i === orig.correctIndex }; });
      const shuffled = orig.type === "error" ? pairs : shuffle(pairs);
      // keep "NO CHANGE" style items in original order for error-ID items so option A is always the base sentence context is preserved naturally; blanks get shuffled for variety
      const correctIndex = shuffled.findIndex(function(p){ return p.correct; });
      return {
        sourceId: orig.id, level: orig.level, type: orig.type, sub: orig.sub,
        prompt: orig.prompt, options: shuffled.map(function(p){ return p.text; }),
        correctIndex: correctIndex, explanation: orig.explanation
      };
    });
  }
  function goLessonSetup(){ navigate("lesson-setup"); }
  function beginLesson(minutes){
    const count = computeQuestionCount(minutes);
    const questions = drawQuestions(moduleLevel, count);
    activeLesson = {
      id: uid(), level: moduleLevel, durationMinutes: minutes,
      questions: questions, index: 0,
      answers: new Array(count).fill(null),
      startedAt: Date.now()
    };
    save("activeLesson", activeLesson);
    navigate("lesson");
  }
  function selectLessonAnswer(idx){
    if(activeLesson.answers[activeLesson.index]) return;
    const q = activeLesson.questions[activeLesson.index];
    const isCorrect = idx === q.correctIndex;
    activeLesson.answers[activeLesson.index] = { selectedIndex: idx, isCorrect: isCorrect };
    save("activeLesson", activeLesson);
    render();
  }
  function nextLessonQuestion(){
    if(activeLesson.index < activeLesson.questions.length - 1){
      activeLesson.index++;
      save("activeLesson", activeLesson);
      navigate("lesson");
    } else {
      finishLesson();
    }
  }
  function finishLesson(){
    const qs = activeLesson.questions;
    let correct = 0;
    const bySub = {};
    const reviewQuestions = qs.map(function(q, i){
      const a = activeLesson.answers[i];
      if(a && a.isCorrect) correct++;
      if(!bySub[q.sub]) bySub[q.sub] = { correct:0, total:0 };
      bySub[q.sub].total++;
      if(a && a.isCorrect) bySub[q.sub].correct++;
      return {
        type:q.type, sub:q.sub, prompt:q.prompt, options:q.options,
        correctIndex:q.correctIndex, explanation:q.explanation,
        userIndex: a ? a.selectedIndex : null, isCorrect: a ? a.isCorrect : false
      };
    });
    const scorePercent = Math.round((correct / qs.length) * 100);
    const breakdown = Object.keys(bySub).map(function(s){
      const b = bySub[s];
      return { sub:s, correct:b.correct, total:b.total, pct: Math.round((b.correct / b.total) * 100) };
    }).sort(function(a,b){ return a.pct - b.pct; });

    const record = {
      id: activeLesson.id, date: Date.now(), level: activeLesson.level,
      durationMinutes: activeLesson.durationMinutes,
      correct: correct, total: qs.length, scorePercent: scorePercent,
      breakdown: breakdown, questions: reviewQuestions
    };
    history.unshift(record);
    save("history", history);
    lastLessonResult = record;
    save("lastLessonResult", record);
    activeLesson = null;
    save("activeLesson", null);
    navigate("lesson-result");
  }
  function repeatLesson(){
    if(!lastLessonResult) return goLessonSetup();
    beginLesson(lastLessonResult.durationMinutes);
  }
  function adjustModuleLevel(delta){
    moduleLevel = clamp(moduleLevel + delta, 1, 5);
    save("moduleLevel", moduleLevel);
    render();
  }
  function resumeActiveLesson(){ navigate("lesson"); }
  function abandonActiveLesson(){
    activeLesson = null; save("activeLesson", null);
    navigate("dashboard");
  }

  /* ---------------- history ---------------- */
  function openHistory(){ navigate("history"); }
  function openHistoryDetail(id){
    const record = history.find(function(h){ return h.id === id; });
    if(!record) return navigate("history");
    navigate("history-detail", { record: record });
  }

  /* ---------------- settings / reset ---------------- */
  function toggleSettings(open){ showSettings = open; render(); }
  function confirmRetakePlacement(){
    if(!window.confirm("Retake the placement test? This will recalculate your Grammar & Punctuation level. Your lesson history stays saved.")) return;
    placementResult = null; save("placementResult", null);
    placementProgress = null; save("placementProgress", null);
    showSettings = false;
    startPlacement();
  }
  function confirmResetAll(){
    if(!window.confirm("Reset all progress? This clears your placement result, level, and full lesson history. This can't be undone.")) return;
    ["placementResult","placementProgress","moduleLevel","activeLesson","history","lastLessonResult"].forEach(function(k){ save(k, null); });
    placementResult = null; placementProgress = null; moduleLevel = null;
    activeLesson = null; history = []; lastLessonResult = null;
    showSettings = false;
    navigate("welcome");
  }

  /* ---------------- derived stats ---------------- */
  function computeStreak(){
    if(!history.length) return 0;
    const days = new Set(history.map(function(h){ return new Date(h.date).toDateString(); }));
    let cursor = new Date();
    if(!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while(days.has(cursor.toDateString())){
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }
  function computeAvgScore(){
    if(!history.length) return 0;
    return Math.round(history.reduce(function(s,h){ return s + h.scorePercent; }, 0) / history.length);
  }

  /* ================= RENDER: shared bits ================= */
  function svgIcon(name){
    const icons = {
      gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>',
      back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
      close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
      chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
      x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
      bloom: '<svg viewBox="0 0 24 24" fill="none"><g fill="#fff"><circle cx="12" cy="6.2" r="3.4"/><circle cx="17.4" cy="9.6" r="3.4"/><circle cx="15.4" cy="16" r="3.4"/><circle cx="8.6" cy="16" r="3.4"/><circle cx="6.6" cy="9.6" r="3.4"/></g><circle cx="12" cy="12" r="2.3" fill="#8FCB72"/></svg>',
      flame: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 3-3 4-3 7.5A3 3 0 0 0 12 13a2 2 0 0 0 2-2c1.5 1 2 2.7 2 4.2A5.2 5.2 0 0 1 10.8 22 6 6 0 0 1 5 15.5C5 10.8 8.5 8.5 8.5 5.8c0-1.2-.5-2.3-.5-2.3S10 1 12 2z"/></svg>'
    };
    return icons[name] || "";
  }
  function headerBar(opts){
    opts = opts || {};
    let left = "";
    if(opts.back){
      left = '<button class="icon-btn" data-action="' + opts.back + '" aria-label="Back">' + svgIcon("back") + "</button>";
    } else {
      left = '<div class="brand"><div class="brand-mark">' + svgIcon("bloom") + '</div><span class="brand-name">Bloom</span></div>';
    }
    let right = opts.right || "";
    if(opts.gear){
      right = '<button class="icon-btn" data-action="open-settings" aria-label="Settings">' + svgIcon("gear") + "</button>";
    }
    return '<header class="app-header">' + left + "<span></span>" + right + "</header>";
  }
  function atmosphere(){
    return '<div class="bg-atmosphere" aria-hidden="true"><span class="b1"></span><span class="b2"></span><span class="b3"></span></div>';
  }
  function progressBar(current, total){
    const pct = Math.round((current / total) * 100);
    return '' +
      '<div class="stack-sm">' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="progress-meta"><span>Question ' + current + ' of ' + total + "</span><span>" + pct + "% there</span></div>" +
      "</div>";
  }
  function choiceListHTML(opts){
    // opts: {options, correctIndex, selectedIndex, locked, action}
    return '<div class="choice-list">' + opts.options.map(function(text, i){
      let cls = "choice selectable";
      if(opts.locked){
        if(i === opts.correctIndex) cls = "choice is-correct";
        else if(i === opts.selectedIndex) cls = "choice is-wrong";
        else cls = "choice is-muted";
      } else if(i === opts.selectedIndex){
        cls += " is-selected";
      }
      const disabled = opts.locked ? "disabled" : "";
      return '<button type="button" class="' + cls + '" data-action="' + opts.action + '" data-index="' + i + '" ' + disabled + '>' +
        '<span class="choice-letter">' + letterFor(i) + '</span><span>' + esc(text) + "</span>" +
      "</button>";
    }).join("") + "</div>";
  }
  function passageHTML(q){
    const p = getPassageFor(q);
    if(!p) return "";
    return '<div class="passage-box">' + esc(p) + "</div>";
  }

  /* ================= RENDER: screens ================= */
  function renderWelcome(){
    return atmosphere() + headerBar({}) +
      '<main id="app-main" class="app-main screen">' +
        '<div class="hero-card">' +
          '<div class="eyebrow">Your writing companion</div>' +
          '<h1 class="title-lg" style="margin-top:8px;">Let\'s find your starting point</h1>' +
          '<p class="sub" style="color:rgba(255,255,255,.92); margin-top:10px;">A quick 40-question placement test shapes everything that follows — no pressure, no timer, and you can pause anytime and pick back up later.</p>' +
        "</div>" +
        '<div class="card stack">' +
          '<div class="stack-sm">' +
            '<div class="row-between"><span class="pill pill-amethyst">1</span><p style="flex:1">A mix of sentence errors, word choice, vocabulary, and short reading passages.</p></div>' +
            '<div class="row-between"><span class="pill pill-rose">2</span><p style="flex:1">Takes most people 25–35 minutes — split it across sittings if you like.</p></div>' +
            '<div class="row-between"><span class="pill pill-lime">3</span><p style="flex:1">You\'ll get a personalized level and a Grammar &amp; Punctuation module built for you.</p></div>' +
          "</div>" +
          '<button class="btn btn-primary" data-action="start-placement">Begin placement test</button>' +
        "</div>" +
      "</main>";
  }

  function renderPlacementResume(){
    const answered = placementProgress.answers.filter(function(a){ return a !== null; }).length;
    const pct = Math.round((answered / placementProgress.order.length) * 100);
    return atmosphere() + headerBar({}) +
      '<main id="app-main" class="app-main screen">' +
        '<div class="card center stack">' +
          '<div class="level-ring" style="--pct:' + pct + '; margin:0 auto;"><div class="level-ring-inner"><span class="n">' + pct + '%</span><span class="l">DONE</span></div></div>' +
          '<h2 class="title-md">Welcome back</h2>' +
          '<p class="sub">You\'ve answered ' + answered + ' of ' + placementProgress.order.length + ' placement questions. Pick up right where you left off.</p>' +
          '<button class="btn btn-primary" data-action="resume-placement">Resume placement test</button>' +
          '<button class="btn btn-ghost btn-sm" data-action="restart-placement" style="margin:0 auto;">Start over instead</button>' +
        "</div>" +
      "</main>";
  }

  function renderPlacement(){
    const idx = placementProgress.currentIndex;
    const q = PLACEMENT_QUESTIONS[idx];
    const selected = placementProgress.answers[idx];
    const isLast = idx === placementProgress.order.length - 1;
    return atmosphere() +
      headerBar({ back: "pause-placement" }) +
      '<main id="app-main" class="app-main screen">' +
        progressBar(idx + 1, placementProgress.order.length) +
        '<div class="card stack">' +
          '<span class="pill pill-amethyst">' + esc(CATEGORY_NAMES[q.category]) + "</span>" +
          passageHTML(q) +
          '<div class="prompt-box">' + renderPrompt(q.prompt) + "</div>" +
          choiceListHTML({ options:q.options, selectedIndex:selected, locked:false, action:"select-placement" }) +
        "</div>" +
        '<div class="btn-row">' +
          (idx > 0 ? '<button class="btn btn-outline" data-action="prev-placement">Back</button>' : "") +
          '<button class="btn btn-primary" data-action="next-placement" ' + (selected === null ? "disabled" : "") + ">" + (isLast ? "Finish test" : "Next question") + "</button>" +
        "</div>" +
      "</main>";
  }

  function renderPlacementResult(){
    const r = placementResult;
    const pct = Math.round((r.level / 5) * 100);
    return atmosphere() + headerBar({}) +
      '<main id="app-main" class="app-main screen">' +
        '<div class="hero-card center">' +
          '<div class="eyebrow">Placement complete</div>' +
          '<div class="level-ring" style="--pct:' + pct + '; margin:14px auto; background: conic-gradient(#fff calc(' + pct + '*1%), rgba(255,255,255,.35) 0);">' +
            '<div class="level-ring-inner" style="background:rgba(255,255,255,.98);"><span class="n" style="color:var(--amethyst-deep)">L' + r.level + '</span><span class="l" style="color:var(--ink-soft)">LEVEL</span></div>' +
          "</div>" +
          '<h1 class="title-lg">' + esc(r.levelName) + "</h1>" +
          '<p class="sub" style="color:rgba(255,255,255,.92); margin-top:6px;">' + esc(LEVEL_BLURB[r.level]) + "</p>" +
          '<p style="margin-top:14px; font-weight:800; color:#fff;">' + r.correct + " / " + r.total + " correct (" + r.scorePercent + "%)</p>" +
        "</div>" +
        '<div class="card stack">' +
          '<h3 class="title-md">Strengths &amp; growth areas</h3>' +
          '<div>' + r.breakdown.map(function(b){
            return '<div class="bar-row"><div class="bar-row-top"><span>' + esc(b.name) + "</span><span>" + b.pct + "%</span></div>" +
              '<div class="bar-track"><div class="bar-fill ' + pctColorClass(b.pct) + '" style="width:' + b.pct + '%"></div></div></div>';
          }).join("") + "</div>" +
          '<p class="sub">Strongest: <strong style="color:var(--ink)">' + esc(r.breakdown[0].name) + "</strong> · Focus next on <strong style=\"color:var(--ink)\">" + esc(r.breakdown[r.breakdown.length-1].name) + "</strong></p>" +
        "</div>" +
        '<button class="btn btn-primary" data-action="go-dashboard">Unlock Grammar &amp; Punctuation</button>' +
      "</main>";
  }

  function renderDashboard(){
    const streak = computeStreak();
    const avg = computeAvgScore();
    const pct = Math.round((moduleLevel / 5) * 100);
    const resumeBanner = activeLesson ? (
      '<div class="card-soft row-between" style="border-color:var(--amethyst-deep);">' +
        '<div><p style="font-weight:800;">Lesson in progress</p><p class="sub">Question ' + (activeLesson.index + 1) + " of " + activeLesson.questions.length + "</p></div>" +
        '<button class="btn btn-primary btn-sm" data-action="resume-lesson">Resume</button>' +
      "</div>"
    ) : "";
    return atmosphere() + headerBar({ gear:true }) +
      '<main id="app-main" class="app-main screen">' +
        resumeBanner +
        '<div class="hero-card">' +
          '<div class="row-between" style="align-items:flex-start;">' +
            '<div><div class="eyebrow">Your module</div><h2 class="title-lg" style="margin-top:6px;">Grammar &amp; Punctuation</h2></div>' +
            '<div class="level-ring" style="--pct:' + pct + '; background: conic-gradient(#fff calc(' + pct + '*1%), rgba(255,255,255,.35) 0);">' +
              '<div class="level-ring-inner" style="background:rgba(255,255,255,.98);"><span class="n" style="color:var(--amethyst-deep)">L' + moduleLevel + '</span><span class="l" style="color:var(--ink-soft)">' + esc(LEVEL_NAMES[moduleLevel].toUpperCase()) + "</span></div>" +
            "</div>" +
          "</div>" +
          '<p class="sub" style="color:rgba(255,255,255,.92); margin-top:12px;">' + esc(LEVEL_BLURB[moduleLevel]) + "</p>" +
          '<button class="btn" style="background:#fff; color:var(--amethyst-deep); margin-top:16px; box-shadow:0 10px 22px -10px rgba(0,0,0,.25);" data-action="go-lesson-setup">Start a lesson</button>' +
        "</div>" +
        '<div class="stat-grid">' +
          '<div class="stat-tile"><div class="num">' + streak + '</div><div class="lbl">DAY STREAK</div></div>' +
          '<div class="stat-tile"><div class="num">' + history.length + '</div><div class="lbl">LESSONS DONE</div></div>' +
          '<div class="stat-tile"><div class="num">' + (history.length ? avg + "%" : "—") + '</div><div class="lbl">AVG SCORE</div></div>' +
        "</div>" +
        '<button class="btn btn-secondary" data-action="open-history">Review lesson history</button>' +
      "</main>" +
      (showSettings ? renderSettingsSheet() : "");
  }

  function renderSettingsSheet(){
    return '<div class="overlay" data-action="close-settings">' +
      '<div class="sheet stack" onclick="event.stopPropagation()">' +
        '<div class="row-between"><h3 class="title-md">Settings</h3><button class="icon-btn" data-action="close-settings">' + svgIcon("close") + "</button></div>" +
        '<button class="btn btn-outline" data-action="retake-placement">Retake placement test</button>' +
        '<button class="btn btn-outline" style="color:var(--danger); border-color:var(--danger-bg);" data-action="reset-all">Reset all progress</button>' +
      "</div>" +
    "</div>";
  }

  function renderLessonSetup(){
    const count = computeQuestionCount(selectedDuration);
    return atmosphere() + headerBar({ back: "go-dashboard" }) +
      '<main id="app-main" class="app-main screen">' +
        '<div class="stack-sm"><span class="eyebrow">Grammar &amp; Punctuation · Level ' + moduleLevel + "</span><h1 class=\"title-lg\">Set up your lesson</h1></div>" +
        '<div class="card stack">' +
          '<div class="field">' +
            '<label for="duration-select">How long do you want to practice?</label>' +
            '<select id="duration-select" class="select" data-action="change-duration">' +
              DURATION_OPTIONS.map(function(m){ return '<option value="' + m + '" ' + (m === selectedDuration ? "selected" : "") + ">" + m + " minutes</option>"; }).join("") +
            "</select>" +
          "</div>" +
          '<div class="card-soft row-between">' +
            '<span class="sub">Estimated length</span><span style="font-weight:800;">~' + count + " questions</span>" +
          "</div>" +
          '<button class="btn btn-primary" data-action="begin-lesson">Begin lesson</button>' +
        "</div>" +
      "</main>";
  }

  function renderLesson(){
    const idx = activeLesson.index;
    const q = activeLesson.questions[idx];
    const answer = activeLesson.answers[idx];
    const locked = !!answer;
    const isLast = idx === activeLesson.questions.length - 1;
    let feedback = "";
    if(locked){
      feedback = '<div class="feedback ' + (answer.isCorrect ? "correct" : "incorrect") + '">' +
        '<div class="feedback-icon">' + svgIcon(answer.isCorrect ? "check" : "x") + "</div>" +
        '<div><div class="feedback-title">' + (answer.isCorrect ? "Nice — that’s correct!" : "Not quite") + "</div>" +
        '<div class="feedback-body">' + esc(q.explanation) + "</div></div>" +
      "</div>";
    }
    return atmosphere() +
      headerBar({ back: "abandon-lesson" }) +
      '<main id="app-main" class="app-main screen">' +
        progressBar(idx + 1, activeLesson.questions.length) +
        '<div class="card stack">' +
          '<span class="pill pill-rose">' + esc(q.sub) + "</span>" +
          '<div class="prompt-box">' + renderPrompt(q.prompt) + "</div>" +
          choiceListHTML({ options:q.options, correctIndex:q.correctIndex, selectedIndex: answer ? answer.selectedIndex : null, locked:locked, action:"select-lesson" }) +
          feedback +
        "</div>" +
        (locked ? '<button class="btn btn-primary" data-action="next-lesson">' + (isLast ? "See my results" : "Next question") + "</button>" : "") +
      "</main>";
  }

  function renderLessonResult(){
    const r = lastLessonResult;
    const worst = r.breakdown[0];
    const best = r.breakdown[r.breakdown.length - 1];
    let suggestion = "";
    if(r.scorePercent >= 90 && moduleLevel < 5){
      suggestion = '<div class="card-soft stack-sm" style="border-color:var(--lime-deep);">' +
        '<p style="font-weight:800;">You’re crushing Level ' + moduleLevel + "!</p>" +
        '<p class="sub">Ready to try Level ' + (moduleLevel + 1) + " — " + esc(LEVEL_NAMES[moduleLevel + 1]) + "?</p>" +
        '<button class="btn btn-secondary btn-sm" data-action="level-up">Level up to ' + (moduleLevel + 1) + "</button>" +
      "</div>";
    } else if(r.scorePercent < 45 && moduleLevel > 1){
      suggestion = '<div class="card-soft stack-sm" style="border-color:var(--rose-deep);">' +
        '<p style="font-weight:800;">This level is stretching you right now.</p>' +
        '<p class="sub">Want to drop back to Level ' + (moduleLevel - 1) + " for a bit to build confidence?</p>" +
        '<button class="btn btn-secondary btn-sm" data-action="level-down">Try Level ' + (moduleLevel - 1) + "</button>" +
      "</div>";
    }
    return atmosphere() + headerBar({}) +
      '<main id="app-main" class="app-main screen">' +
        '<div class="hero-card center">' +
          '<div class="eyebrow">Lesson complete</div>' +
          '<h1 class="title-lg" style="margin-top:6px;">' + r.scorePercent + "% score</h1>" +
          '<p class="sub" style="color:rgba(255,255,255,.92); margin-top:6px;">' + r.correct + " of " + r.total + " correct · " + r.durationMinutes + " min lesson</p>" +
        "</div>" +
        '<div class="card stack">' +
          '<h3 class="title-md">How you did</h3>' +
          '<div>' + r.breakdown.map(function(b){
            return '<div class="bar-row"><div class="bar-row-top"><span>' + esc(b.sub) + "</span><span>" + b.correct + "/" + b.total + "</span></div>" +
              '<div class="bar-track"><div class="bar-fill ' + pctColorClass(b.pct) + '" style="width:' + b.pct + '%"></div></div></div>';
          }).join("") + "</div>" +
          '<p class="sub">Strongest: <strong style="color:var(--ink)">' + esc(best.sub) + "</strong> · Keep practicing <strong style=\"color:var(--ink)\">" + esc(worst.sub) + "</strong></p>" +
        "</div>" +
        suggestion +
        '<div class="btn-row">' +
          '<button class="btn btn-outline" data-action="go-dashboard">Dashboard</button>' +
          '<button class="btn btn-primary" data-action="repeat-lesson">Repeat lesson</button>' +
        "</div>" +
      "</main>";
  }

  function renderHistory(){
    if(!history.length){
      return atmosphere() + headerBar({ back: "go-dashboard" }) +
        '<main id="app-main" class="app-main screen">' +
          '<div class="empty-state"><div class="emoji">📔</div><h3 class="title-md">No lessons yet</h3><p class="sub">Finish your first lesson and it’ll show up here.</p></div>' +
        "</main>";
    }
    return atmosphere() + headerBar({ back: "go-dashboard" }) +
      '<main id="app-main" class="app-main screen">' +
        '<h1 class="title-lg">Lesson history</h1>' +
        '<div class="list">' + history.map(function(h){
          return '<button type="button" class="list-item" data-action="open-history-detail" data-id="' + h.id + '">' +
            '<div class="avatar">' + h.scorePercent + "%</div>" +
            '<div class="meta"><div class="top">Level ' + h.level + " · " + h.durationMinutes + " min lesson</div>" +
            '<div class="bottom">' + formatDate(h.date) + " at " + formatTime(h.date) + " · " + h.correct + "/" + h.total + " correct</div></div>" +
            '<span class="chev">' + svgIcon("chev") + "</span>" +
          "</button>";
        }).join("") + "</div>" +
      "</main>";
  }

  function renderHistoryDetail(){
    const r = viewParams.record;
    return atmosphere() + headerBar({ back: "open-history" }) +
      '<main id="app-main" class="app-main screen">' +
        '<div class="stack-sm">' +
          '<span class="eyebrow">' + formatDate(r.date) + " · Level " + r.level + "</span>" +
          '<h1 class="title-lg">' + r.scorePercent + "% · " + r.correct + "/" + r.total + " correct</h1>" +
        "</div>" +
        '<div>' + r.questions.map(function(q, i){
          return '<div class="review-item stack-sm">' +
            '<div class="row-between"><span class="q-num">Question ' + (i + 1) + " · " + esc(q.sub || "") + '</span><span class="pill ' + (q.isCorrect ? "pill-lime" : "pill-rose") + '">' + (q.isCorrect ? "Correct" : "Missed") + "</span></div>" +
            (getPassageFor(q) ? passageHTML(q) : "") +
            '<div class="prompt-box">' + renderPrompt(q.prompt) + "</div>" +
            choiceListHTML({ options:q.options, correctIndex:q.correctIndex, selectedIndex:q.userIndex, locked:true, action:"noop" }) +
            '<div class="feedback ' + (q.isCorrect ? "correct" : "incorrect") + '"><div class="feedback-icon">' + svgIcon(q.isCorrect ? "check" : "x") + '</div><div class="feedback-body" style="margin-top:0;">' + esc(q.explanation) + "</div></div>" +
          "</div>";
        }).join("") + "</div>" +
      "</main>";
  }

  /* ================= main render dispatch ================= */
  function render(){
    const root = document.getElementById("app");
    let html;
    switch(view){
      case "welcome": html = renderWelcome(); break;
      case "placement-resume": html = renderPlacementResume(); break;
      case "placement": html = renderPlacement(); break;
      case "placement-result": html = renderPlacementResult(); break;
      case "dashboard": html = renderDashboard(); break;
      case "lesson-setup": html = renderLessonSetup(); break;
      case "lesson": html = renderLesson(); break;
      case "lesson-result": html = renderLessonResult(); break;
      case "history": html = renderHistory(); break;
      case "history-detail": html = renderHistoryDetail(); break;
      default: html = renderWelcome();
    }
    root.innerHTML = '<div class="app-shell">' + html + "</div>";
  }

  /* ================= event delegation ================= */
  document.addEventListener("click", function(e){
    const el = e.target.closest("[data-action]");
    if(!el) return;
    const action = el.getAttribute("data-action");
    const index = el.getAttribute("data-index");
    switch(action){
      case "start-placement": startPlacement(); break;
      case "resume-placement": navigate("placement"); break;
      case "restart-placement":
        if(window.confirm("Start the placement test over from question 1?")) restartPlacement();
        break;
      case "pause-placement": navigate("placement-resume"); break;
      case "select-placement": selectPlacementAnswer(parseInt(index, 10)); break;
      case "next-placement": nextPlacementQuestion(); break;
      case "prev-placement": prevPlacementQuestion(); break;
      case "go-dashboard": navigate("dashboard"); break;
      case "open-settings": toggleSettings(true); break;
      case "close-settings": toggleSettings(false); break;
      case "retake-placement": confirmRetakePlacement(); break;
      case "reset-all": confirmResetAll(); break;
      case "go-lesson-setup": goLessonSetup(); break;
      case "begin-lesson": beginLesson(selectedDuration); break;
      case "select-lesson": selectLessonAnswer(parseInt(index, 10)); break;
      case "next-lesson": nextLessonQuestion(); break;
      case "resume-lesson": resumeActiveLesson(); break;
      case "abandon-lesson": navigate("dashboard"); break;
      case "repeat-lesson": repeatLesson(); break;
      case "level-up": adjustModuleLevel(1); break;
      case "level-down": adjustModuleLevel(-1); break;
      case "open-history": openHistory(); break;
      case "open-history-detail": openHistoryDetail(el.getAttribute("data-id")); break;
      case "noop": break;
    }
  });
  document.addEventListener("change", function(e){
    if(e.target && e.target.id === "duration-select"){
      selectedDuration = parseInt(e.target.value, 10);
      render();
    }
  });

  /* ================= boot ================= */
  function boot(){
    if(placementResult){
      navigate("dashboard");
    } else if(placementProgress){
      navigate("placement-resume");
    } else {
      navigate("welcome");
    }
    if("serviceWorker" in navigator){
      window.addEventListener("load", function(){
        navigator.serviceWorker.register("sw.js").catch(function(){ /* offline caching is optional */ });
      });
    }
  }
  boot();
})();
