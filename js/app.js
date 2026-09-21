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
  function isStandalone(){
    return (window.navigator.standalone === true) ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }

  /* ---------------- placement pool lookup ---------------- */
  const PASSAGES = {};
  const PLACEMENT_BY_ID = {};
  PLACEMENT_POOL.forEach(function(q){
    PLACEMENT_BY_ID[q.id] = q;
    if(q.passage) PASSAGES[q.passageId] = q.passage;
  });
  function getPassageFor(q){ return q.passage || (q.passageId ? PASSAGES[q.passageId] : null); }

  /* ---------------- unified lesson pool ---------------- */
  // Lessons draw from the placement pool's active categories plus the
  // curated grammar bank. Grammar-bank items carry a 1-5 level and no
  // category of their own, so they're normalized onto the same 1-10
  // difficulty scale and their type becomes their category. Their
  // sub-skill names are deliberately left alone rather than forced into
  // the placement taxonomy — they're more specific, and seeding falls
  // back to the category ceiling for the ones placement doesn't cover.
  const LESSON_POOL = PLACEMENT_POOL
    .filter(function(q){ return CATEGORY_NAMES[q.category]; })
    .concat(GRAMMAR_BANK.map(function(q){
      return {
        id: q.id, category: q.type, type: q.type, sub: q.sub,
        difficulty: clamp(q.level * 2, 1, 10),
        prompt: q.prompt, options: q.options,
        correctIndex: q.correctIndex, explanation: q.explanation
      };
    }));

  /* ---------------- state ---------------- */
  let placementResult = load("placementResult", null);
  let placementProgress = load("placementProgress", null);
  let moduleLevel = load("moduleLevel", null);
  let activeLesson = load("activeLesson", null);
  let history = load("history", []);
  let lastLessonResult = load("lastLessonResult", null);
  let dismissedStandaloneNotice = load("dismissedStandaloneNotice", false);
  let profile = load("profile", null);
  let skillState = load("skillState", {});
  let categoryState = load("categoryState", {});
  let profileError = "";
  let profileFormAge = profile ? String(profile.age) : "";
  let profileFormEducation = profile ? profile.education : "";

  if(placementProgress && (
    !placementProgress.sequence || !placementProgress.categoryDifficulty || !placementProgress.categoryDisplayDifficulty || !placementProgress.displaySnapshot ||
    placementProgress.order.some(function(id){ return id && !PLACEMENT_BY_ID[id]; })
  )){
    placementProgress = null;
    save("placementProgress", null);
  }

  let view = "home";
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
  function goHome(){ navigate("home"); }

  /* ---------------- profile (collected once before each placement attempt) ---------------- */
  const EDUCATION_LEVELS = ["High school diploma or GED","Some college","Associate degree","Bachelor's degree","Master's degree","Doctoral degree"];
  function submitProfile(){
    const ageEl = document.getElementById("profile-age");
    const eduEl = document.getElementById("profile-education");
    const ageRaw = ageEl ? ageEl.value.trim() : "";
    const ageNum = parseInt(ageRaw, 10);
    const eduVal = eduEl ? eduEl.value : "";
    // Preserve whatever was entered across a validation-error re-render.
    profileFormAge = ageRaw;
    profileFormEducation = eduVal;
    if(!ageRaw || isNaN(ageNum) || ageNum < 5 || ageNum > 120){
      profileError = "Please enter a valid age between 5 and 120.";
      render();
      return;
    }
    if(!EDUCATION_LEVELS.includes(eduVal)){
      profileError = "Please select your highest level of education.";
      render();
      return;
    }
    profileError = "";
    profile = { age: ageNum, education: eduVal };
    save("profile", profile);
    startPlacement();
  }

  /* ---------------- placement test ---------------- */
  // Adaptive: each category tracks its own difficulty independently (1-10,
  // starting at 5), split into two parallel values:
  //   - categoryDifficulty: the REAL target used to pick the next question's
  //     content. Moves by PLACEMENT_ACTUAL_STEP per answer, so the actual
  //     challenge ramps up/down faster than the visible indicator suggests.
  //   - categoryDisplayDifficulty: a running per-category counter that moves
  //     by exactly 1 per answer — a simple, readable progress cue, not a
  //     precise reflection of the real target.
  // Both are clamped to 1-10. The on-screen "Difficulty N/10" pill does NOT
  // read categoryDisplayDifficulty live — it reads a frozen snapshot of that
  // value captured in displaySnapshot[slotIndex] at the moment each question
  // is first picked, so revisiting an earlier question via Back always shows
  // the same value it showed originally, no matter how much the running
  // counter has moved since. This is measurement-only — no correct/incorrect
  // feedback is ever shown during the test, so all adjustments happen
  // silently in the background.
  const PLACEMENT_DRAW_COUNTS = { error:12, blank:10, vocab:8, spelling:10 }; // 40 total
  const PLACEMENT_START_DIFFICULTY = 5;
  const PLACEMENT_ACTUAL_STEP = 2;
  const PLACEMENT_DISPLAY_STEP = 1;

  function buildPlacementSequence(){
    const seq = [];
    Object.keys(PLACEMENT_DRAW_COUNTS).forEach(function(cat){
      // Defensive: skip a category with no pool items yet rather than crash
      // (also self-heals if a category's pool is ever fully exhausted).
      const available = PLACEMENT_POOL.some(function(q){ return q.category === cat; });
      if(!available) return;
      for(let i = 0; i < PLACEMENT_DRAW_COUNTS[cat]; i++) seq.push(cat);
    });
    return shuffle(seq);
  }
  function questionDifficulty(q){
    // Falls back to the starting difficulty (degrading to a plain random
    // pick within the tier) for any pool item that isn't rated yet.
    return typeof q.difficulty === "number" ? q.difficulty : PLACEMENT_START_DIFFICULTY;
  }
  function pickAdaptiveQuestion(cat, targetDifficulty, usedIds){
    const candidates = PLACEMENT_POOL.filter(function(q){ return q.category === cat && !usedIds[q.id]; });
    if(!candidates.length) return null;
    let bestDist = Infinity;
    candidates.forEach(function(q){
      const dist = Math.abs(questionDifficulty(q) - targetDifficulty);
      if(dist < bestDist) bestDist = dist;
    });
    const tier = candidates.filter(function(q){ return Math.abs(questionDifficulty(q) - targetDifficulty) === bestDist; });
    return tier[Math.floor(Math.random() * tier.length)];
  }
  function startPlacement(){
    const sequence = buildPlacementSequence();
    const categoryDifficulty = {};
    const categoryDisplayDifficulty = {};
    Object.keys(PLACEMENT_DRAW_COUNTS).forEach(function(cat){
      categoryDifficulty[cat] = PLACEMENT_START_DIFFICULTY;
      categoryDisplayDifficulty[cat] = PLACEMENT_START_DIFFICULTY;
    });
    const order = new Array(sequence.length).fill(null);
    const displaySnapshot = new Array(sequence.length).fill(null);
    const first = pickAdaptiveQuestion(sequence[0], categoryDifficulty[sequence[0]], {});
    order[0] = first.id;
    displaySnapshot[0] = categoryDisplayDifficulty[sequence[0]];
    placementProgress = {
      sequence: sequence,
      order: order,
      displaySnapshot: displaySnapshot,
      categoryDifficulty: categoryDifficulty,
      categoryDisplayDifficulty: categoryDisplayDifficulty,
      answers: new Array(sequence.length).fill(null),
      currentIndex: 0,
      startedAt: Date.now()
    };
    save("placementProgress", placementProgress);
    navigate("placement");
  }
  function openProfileScreen(){
    profileError = "";
    profileFormAge = profile ? String(profile.age) : "";
    profileFormEducation = profile ? profile.education : "";
    navigate("profile");
  }
  function openPlacement(){
    if(placementResult){ navigate("placement-result"); }
    else if(placementProgress){ navigate("placement"); }
    else { openProfileScreen(); }
  }
  function selectPlacementAnswer(idx){
    placementProgress.answers[placementProgress.currentIndex] = idx;
    save("placementProgress", placementProgress);
    render();
  }
  function nextPlacementQuestion(){
    const idx = placementProgress.currentIndex;
    if(placementProgress.answers[idx] === null) return;
    if(idx < placementProgress.sequence.length - 1){
      const nextIdx = idx + 1;
      if(!placementProgress.order[nextIdx]){
        // Only adjust difficulty and pick the next question the first time
        // we advance past this slot — revisiting via Back/Next afterward
        // must not double-apply the adjustment.
        const answeredQ = PLACEMENT_BY_ID[placementProgress.order[idx]];
        const wasCorrect = placementProgress.answers[idx] === answeredQ.correctIndex;
        const cat = answeredQ.category;
        const dir = wasCorrect ? 1 : -1;
        placementProgress.categoryDifficulty[cat] = clamp(placementProgress.categoryDifficulty[cat] + dir * PLACEMENT_ACTUAL_STEP, 1, 10);
        placementProgress.categoryDisplayDifficulty[cat] = clamp(placementProgress.categoryDisplayDifficulty[cat] + dir * PLACEMENT_DISPLAY_STEP, 1, 10);

        const usedIds = {};
        placementProgress.order.forEach(function(id){ if(id) usedIds[id] = true; });
        const nextCat = placementProgress.sequence[nextIdx];
        const picked = pickAdaptiveQuestion(nextCat, placementProgress.categoryDifficulty[nextCat], usedIds);
        placementProgress.order[nextIdx] = picked.id;
        placementProgress.displaySnapshot[nextIdx] = placementProgress.categoryDisplayDifficulty[nextCat];
      }
      placementProgress.currentIndex = nextIdx;
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
  // A category's "ceiling" is the highest difficulty (1-10) the learner was
  // consistently answering correctly by the end of the test — not just the
  // single hardest question they happened to get right, which could be a
  // fluke. Only the back half of that category's questions is considered
  // (the adaptive engine is still exploring early on), and a candidate
  // ceiling only counts if the learner also got most of the easier
  // same-window questions right, i.e. it has real support rather than
  // being an isolated lucky guess.
  function categoryCeiling(items){
    if(!items.length) return PLACEMENT_START_DIFFICULTY;
    const lateCount = Math.max(3, Math.ceil(items.length / 2));
    const lateItems = items.slice(-lateCount);
    const difficulties = Array.from(new Set(lateItems.map(function(i){ return i.difficulty; })))
      .sort(function(a, b){ return b - a; });
    for(let k = 0; k < difficulties.length; k++){
      const d = difficulties[k];
      const atOrBelow = lateItems.filter(function(i){ return i.difficulty <= d; });
      const correctAtOrBelow = atOrBelow.filter(function(i){ return i.correct; }).length;
      const wasCorrectAtD = lateItems.some(function(i){ return i.difficulty === d && i.correct; });
      if(wasCorrectAtD && (correctAtOrBelow / atOrBelow.length) >= 0.6) return clamp(d, 1, 10);
    }
    // Nothing cleared the consistency bar: fall back to the hardest correct
    // answer in the late window, or the easiest item attempted if none.
    const correctDifficulties = lateItems.filter(function(i){ return i.correct; }).map(function(i){ return i.difficulty; });
    const fallback = correctDifficulties.length
      ? Math.max.apply(null, correctDifficulties)
      : Math.min.apply(null, lateItems.map(function(i){ return i.difficulty; }));
    return clamp(fallback, 1, 10);
  }
  function subSkillBreakdown(items){
    const bySkill = {};
    items.forEach(function(i){
      if(!bySkill[i.sub]) bySkill[i.sub] = { correct:0, total:0, difficultySum:0 };
      const b = bySkill[i.sub];
      b.total++;
      b.difficultySum += i.difficulty;
      if(i.correct) b.correct++;
    });
    const out = {};
    Object.keys(bySkill).forEach(function(s){
      const b = bySkill[s];
      out[s] = {
        correct: b.correct,
        total: b.total,
        pct: Math.round((b.correct / b.total) * 100),
        avgDifficulty: Math.round((b.difficultySum / b.total) * 10) / 10
      };
    });
    return out;
  }
  function finishPlacement(){
    const byCat = {};
    const itemsByCat = {};
    Object.keys(CATEGORY_NAMES).forEach(function(c){ byCat[c] = { correct:0, total:0 }; itemsByCat[c] = []; });
    let correct = 0;
    placementProgress.order.forEach(function(id, i){
      const q = PLACEMENT_BY_ID[id];
      const given = placementProgress.answers[i];
      const wasCorrect = given === q.correctIndex;
      byCat[q.category].total++;
      if(wasCorrect){ correct++; byCat[q.category].correct++; }
      // Chronological per-category log (order/answers are already in the
      // sequence the questions were actually presented), the raw material
      // both the ceiling and sub-skill calculations below are built from.
      itemsByCat[q.category].push({ difficulty: questionDifficulty(q), correct: wasCorrect, sub: q.sub });
    });
    const scorePercent = Math.round((correct / placementProgress.order.length) * 100);
    const level = levelFromPercent(scorePercent);
    const breakdown = Object.keys(byCat).map(function(c){
      const b = byCat[c];
      return { category:c, name:CATEGORY_NAMES[c], correct:b.correct, total:b.total, pct: b.total ? Math.round((b.correct / b.total) * 100) : 0 };
    }).sort(function(a,b){ return b.pct - a.pct; });

    // Deeper, structured scoring for later use (detailed results display,
    // personalized curriculum) — additive to the summary fields above,
    // which the current results screen already relies on unchanged.
    const categoryScores = {};
    Object.keys(itemsByCat).forEach(function(c){
      const items = itemsByCat[c];
      if(!items.length) return;
      categoryScores[c] = {
        name: CATEGORY_NAMES[c],
        ceiling: categoryCeiling(items),
        correct: byCat[c].correct,
        total: byCat[c].total,
        pct: byCat[c].total ? Math.round((byCat[c].correct / byCat[c].total) * 100) : 0,
        subSkills: subSkillBreakdown(items)
      };
    });

    placementResult = {
      level: level,
      levelName: LEVEL_NAMES[level],
      scorePercent: scorePercent,
      correct: correct,
      total: placementProgress.order.length,
      breakdown: breakdown,
      categoryScores: categoryScores,
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
    openProfileScreen();
  }

  /* ---------------- lesson ---------------- */
  const DURATION_OPTIONS = [2, 5, 10, 15, 20, 30, 45, 60];
  function computeQuestionCount(minutes){
    return clamp(Math.round((minutes * 60) / 42), 3, 90);
  }
  /* ---- per-sub-skill adaptivity (independent of the placement engine) ----
     Every (category, sub-skill) pair carries its own difficulty estimate on
     the same 1-10 scale the pool is rated on. After each answer the estimate
     moves by a step that settles where the learner is getting roughly
     SKILL_TARGET_ACCURACY right: a hit nudges up by (1 - target), a miss
     drops by target, so at equilibrium the ups and downs cancel at an 85%
     success rate rather than the 50% a symmetric step would converge on.

     That up:down ratio is not a free choice — it IS the target. Equilibrium
     sits at down / (up + down), so evening the two out would retune the
     system to 50%. At 85% accuracy misses simply arrive ~5.7x less often
     than hits, so each has to carry ~5.7x the weight or the level would
     climb forever.

     What is free is the overall magnitude, and it shrinks as evidence
     accumulates rather than staying fixed. A brand new estimate takes the
     full step, so a level still finds its mark quickly from its placement
     seed; an estimate built over many lessons moves in small increments, so
     a short run of misses no longer gives away several points of a 10-point
     range. Scaling both steps by the same factor leaves the ratio, and
     therefore the 85% target, exact at every size. */
  const SKILL_TARGET_ACCURACY = 0.85;
  const SKILL_UP_STEP = 1 - SKILL_TARGET_ACCURACY;
  const SKILL_DOWN_STEP = SKILL_TARGET_ACCURACY;
  const SKILL_STEP_KNEE = 12;  // observations at which the step is halved
  const SKILL_STEP_FLOOR = 0.25;
  function stepScale(seen){
    return Math.max(SKILL_STEP_FLOOR, SKILL_STEP_KNEE / (SKILL_STEP_KNEE + seen));
  }
  const SKILL_CONFIDENCE_HALFLIFE_DAYS = 30;
  // Spaced repetition, indexed by consecutive correct answers on that
  // sub-skill. A miss resets to 0, i.e. due immediately, so missed
  // sub-skills come back in the very next lesson and then stretch out.
  const SKILL_DUE_HOURS = [0, 20, 72, 168, 384, 840];
  const HOUR_MS = 3600 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  // A single sub-skill is only sampled a few times across a run of lessons —
  // far too thin for its own estimate to steer difficulty on its own. So each
  // category also carries an estimate, updated on every answer in that
  // category and therefore calibrating an order of magnitude faster, and a
  // sub-skill's served difficulty is blended between the two in proportion to
  // how much evidence that sub-skill actually has. SKILL_EVIDENCE_HALF is the
  // number of observations at which a sub-skill trusts itself as much as its
  // category; PLACEMENT_PRIOR_N is how many observations the placement test's
  // own reading of that sub-skill is treated as being worth.
  const SKILL_EVIDENCE_HALF = 5;
  const PLACEMENT_PRIOR_N = 3;

  function skillKey(cat, sub){ return cat + "::" + sub; }
  function categorySeedLevel(cat){
    const cs = placementResult && placementResult.categoryScores && placementResult.categoryScores[cat];
    // Results saved before the scoring engine have no per-category data.
    return cs ? clamp(cs.ceiling, 1, 10) : clamp((moduleLevel || 3) * 2, 1, 10);
  }
  function getCategory(cat){
    if(!categoryState[cat]){
      categoryState[cat] = { level: categorySeedLevel(cat), seen:0, correct:0 };
    }
    return categoryState[cat];
  }
  // Starting difficulty comes from the placement test: the category ceiling,
  // nudged by how that specific sub-skill went where placement measured it.
  function getSkill(cat, sub){
    const key = skillKey(cat, sub);
    if(!skillState[key]){
      const cs = placementResult && placementResult.categoryScores && placementResult.categoryScores[cat];
      const measured = cs && cs.subSkills && cs.subSkills[sub];
      const adj = !measured ? 0 : measured.pct >= 80 ? 1 : measured.pct >= 50 ? 0 : measured.pct >= 25 ? -1 : -2;
      skillState[key] = {
        level: clamp(categorySeedLevel(cat) + adj, 1, 10),
        priorN: measured ? PLACEMENT_PRIOR_N : 0,
        seen:0, correct:0, reps:0, missStreak:0, lastSeenAt:0, dueAt:0
      };
    }
    return skillState[key];
  }
  // What difficulty to actually serve: the sub-skill's own estimate and its
  // category's, weighted by the sub-skill's accumulated evidence.
  function servedLevel(cat, sub){
    const s = getSkill(cat, sub);
    const evidence = s.seen + (s.priorN || 0);
    const w = evidence / (evidence + SKILL_EVIDENCE_HALF);
    return clamp(w * s.level + (1 - w) * getCategory(cat).level, 1, 10);
  }
  // Mastery decays with time since the sub-skill was last tested, so a stale
  // estimate loses confidence and earns a recheck.
  function skillConfidence(s){
    if(!s.seen || !s.lastSeenAt) return 0;
    return Math.pow(0.5, ((Date.now() - s.lastSeenAt) / DAY_MS) / SKILL_CONFIDENCE_HALFLIFE_DAYS);
  }
  function skillPriority(s){
    const coverage = 1 / (1 + s.seen);                                        // barely practised yet
    const overdue = s.dueAt ? clamp((Date.now() - s.dueAt) / DAY_MS, 0, 3) : 1; // spaced repetition
    const decay = 1 - skillConfidence(s);                                     // mastery decay
    const missed = s.missStreak > 0 ? 1 : 0;                                  // recently missed
    return coverage * 1.4 + overdue * 1.2 + decay + missed * 0.8 + Math.random() * 0.6;
  }
  function nearestLessonQuestion(cat, sub, target, usedIds){
    const candidates = LESSON_POOL.filter(function(q){
      return q.category === cat && q.sub === sub && !usedIds[q.id];
    });
    if(!candidates.length) return null;
    let best = Infinity;
    candidates.forEach(function(q){
      const dist = Math.abs(q.difficulty - target);
      if(dist < best) best = dist;
    });
    const tier = candidates.filter(function(q){ return Math.abs(q.difficulty - target) === best; });
    return tier[Math.floor(Math.random() * tier.length)];
  }
  function drawQuestions(count){
    const seen = {};
    const skills = [];
    LESSON_POOL.forEach(function(q){
      const key = skillKey(q.category, q.sub);
      if(seen[key]) return;
      seen[key] = true;
      skills.push({ cat:q.category, sub:q.sub });
    });
    const ranked = skills.map(function(s){
      return { cat:s.cat, sub:s.sub, score: skillPriority(getSkill(s.cat, s.sub)) };
    }).sort(function(a, b){ return b.score - a.score; });

    const usedIds = {};
    const picked = [];
    // Walk the priority order, wrapping for lessons longer than the
    // sub-skill list; a sub-skill whose questions are used up is skipped.
    for(let i = 0; picked.length < count && i < ranked.length * 6; i++){
      const s = ranked[i % ranked.length];
      const q = nearestLessonQuestion(s.cat, s.sub, servedLevel(s.cat, s.sub), usedIds);
      if(!q) continue;
      usedIds[q.id] = true;
      picked.push(q);
    }
    save("skillState", skillState);
    save("categoryState", categoryState);

    return picked.map(function(orig){
      const pairs = orig.options.map(function(text, i){ return { text:text, correct: i === orig.correctIndex }; });
      // "NO CHANGE" style items keep option A as the base sentence; others shuffle for variety
      const shuffled = orig.type === "error" ? pairs : shuffle(pairs);
      const correctIndex = shuffled.findIndex(function(p){ return p.correct; });
      return {
        sourceId: orig.id, category: orig.category, difficulty: orig.difficulty,
        type: orig.type, sub: orig.sub,
        prompt: orig.prompt, options: shuffled.map(function(p){ return p.text; }),
        correctIndex: correctIndex, explanation: orig.explanation
      };
    });
  }
  function recordSkillAnswer(q, isCorrect){
    if(!q.category) return; // lesson started before per-sub-skill tracking existed
    const s = getSkill(q.category, q.sub);
    const c = getCategory(q.category);
    const now = Date.now();
    const step = isCorrect ? SKILL_UP_STEP : -SKILL_DOWN_STEP;
    // Sized against the evidence each estimate had before this answer. The
    // category has seen every answer in its four sub-skill groups, so it is
    // the better established of the two and moves in smaller increments.
    const skillStep = step * stepScale(s.seen);
    const categoryStep = step * stepScale(c.seen);
    s.seen++;
    c.seen++;
    if(isCorrect){
      s.correct++;
      c.correct++;
      s.reps = Math.min(s.reps + 1, SKILL_DUE_HOURS.length - 1);
      s.missStreak = 0;
    } else {
      s.reps = 0;
      s.missStreak++;
    }
    s.level = clamp(s.level + skillStep, 1, 10);
    c.level = clamp(c.level + categoryStep, 1, 10);
    s.lastSeenAt = now;
    s.dueAt = now + SKILL_DUE_HOURS[s.reps] * HOUR_MS;
    save("skillState", skillState);
    save("categoryState", categoryState);
  }
  function goLessonSetup(){ navigate("lesson-setup"); }
  function openLessons(){
    if(!placementResult) return;
    navigate("lesson-setup");
  }
  function beginLesson(minutes){
    const questions = drawQuestions(computeQuestionCount(minutes));
    activeLesson = {
      id: uid(), level: moduleLevel, durationMinutes: minutes,
      questions: questions, index: 0,
      answers: new Array(questions.length).fill(null),
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
    recordSkillAnswer(q, isCorrect);
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
    // Questions are chosen per sub-skill now, so this manual dial shifts
    // every tracked estimate rather than picking a fixed bank level.
    Object.keys(skillState).forEach(function(k){
      skillState[k].level = clamp(skillState[k].level + delta * 2, 1, 10);
    });
    Object.keys(categoryState).forEach(function(k){
      categoryState[k].level = clamp(categoryState[k].level + delta * 2, 1, 10);
    });
    save("skillState", skillState);
    save("categoryState", categoryState);
    render();
  }
  function resumeActiveLesson(){ navigate("lesson"); }

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
    openProfileScreen();
  }
  function confirmResetAll(){
    if(!window.confirm("Reset all progress? This clears your placement result, level, and full lesson history. This can't be undone.")) return;
    ["placementResult","placementProgress","moduleLevel","activeLesson","history","lastLessonResult","skillState","categoryState"].forEach(function(k){ save(k, null); });
    skillState = {};
    categoryState = {};
    placementResult = null; placementProgress = null; moduleLevel = null;
    activeLesson = null; history = []; lastLessonResult = null;
    showSettings = false;
    navigate("home");
  }
  function dismissStandaloneNotice(){
    dismissedStandaloneNotice = true;
    save("dismissedStandaloneNotice", true);
    render();
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
      home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5L12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9"/><path d="M9.5 20v-6a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6"/></svg>',
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
    let left;
    if(opts.isHome){
      left = '<div class="brand"><div class="brand-mark">' + svgIcon("bloom") + '</div><span class="brand-name">Bloom</span></div>';
    } else {
      left = '<button class="icon-btn" data-action="go-home" aria-label="Home">' + svgIcon("home") + "</button>";
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
  function navCard(opts){
    // opts: {title, subtitle, buttonLabel, action, primary, locked, extra}
    const wrapStyle = opts.locked ? ' style="opacity:.65;"' : "";
    const btn = opts.locked
      ? '<button type="button" class="btn btn-outline" disabled>' + esc(opts.buttonLabel) + "</button>"
      : '<button type="button" class="btn ' + (opts.primary ? "btn-primary" : "btn-secondary") + '" data-action="' + opts.action + '">' + esc(opts.buttonLabel) + "</button>";
    return '<div class="card stack-sm"' + wrapStyle + '>' +
      '<h3 class="title-md">' + esc(opts.title) + "</h3>" +
      '<p class="sub">' + opts.subtitle + "</p>" +
      btn +
      (opts.extra || "") +
    "</div>";
  }
  function renderStandaloneNotice(){
    return '<div class="card-soft row-between" style="border-color:var(--beige-deep);">' +
      '<p class="sub" style="flex:1; padding-right:8px;">You\'re using Bloom in Safari — for one consistent place to pick up where you left off, add it to your home screen instead.</p>' +
      '<button class="icon-btn" data-action="dismiss-standalone-notice" aria-label="Dismiss">' + svgIcon("close") + "</button>" +
    "</div>";
  }

  /* ================= RENDER: screens ================= */
  function renderHome(){
    const streak = computeStreak();
    const avg = computeAvgScore();

    let greetTitle, greetBody;
    if(placementResult){
      greetTitle = "Ready for today's practice?";
      greetBody = "Level " + placementResult.level + " · " + esc(LEVEL_NAMES[placementResult.level]) +
        (streak > 0 ? " — " + streak + " day" + (streak === 1 ? "" : "s") + " in a row" : "");
    } else if(placementProgress){
      greetTitle = "Pick up where you left off";
      greetBody = "Your placement test is waiting for you.";
    } else {
      greetTitle = "Let's find your starting point";
      greetBody = "Everything here starts with a quick placement test.";
    }

    const notice = (!isStandalone() && !dismissedStandaloneNotice) ? renderStandaloneNotice() : "";
    const lessonBanner = activeLesson ? (
      '<div class="card-soft row-between" style="border-color:var(--amethyst-deep);">' +
        '<div><p style="font-weight:800;">Lesson in progress</p><p class="sub">Question ' + (activeLesson.index + 1) + " of " + activeLesson.questions.length + "</p></div>" +
        '<button class="btn btn-primary btn-sm" data-action="resume-lesson">Resume</button>' +
      "</div>"
    ) : "";

    let placementSub, placementBtnLabel, placementExtra = "";
    if(placementResult){
      placementSub = "Level " + placementResult.level + " · " + esc(placementResult.levelName) + " · completed " + formatDate(placementResult.completedAt);
      placementBtnLabel = "Review results";
      placementExtra = '<button type="button" class="btn-ghost btn-sm" data-action="retake-placement" style="margin:0 auto;">Retake test</button>';
    } else if(placementProgress){
      const answered = placementProgress.answers.filter(function(a){ return a !== null; }).length;
      placementSub = answered + " of " + placementProgress.order.length + " questions complete";
      placementBtnLabel = "Resume placement test";
      placementExtra = '<button type="button" class="btn-ghost btn-sm" data-action="restart-placement" style="margin:0 auto;">Start over instead</button>';
    } else {
      placementSub = "40 questions · about 25–35 minutes, pause anytime.";
      placementBtnLabel = "Begin placement test";
    }
    const placementCard = navCard({
      title: "1 · Placement test", subtitle: placementSub, buttonLabel: placementBtnLabel,
      action: "open-placement", primary: !placementResult, extra: placementExtra
    });

    const lessonsLocked = !placementResult;
    const lessonsCard = navCard({
      title: "2 · My lessons",
      subtitle: lessonsLocked
        ? "Complete your placement test to unlock this module."
        : "Adaptive practice · Level " + moduleLevel + " · " + esc(LEVEL_NAMES[moduleLevel]),
      buttonLabel: lessonsLocked ? "Locked for now" : "Start a lesson",
      action: "open-lessons", primary: true, locked: lessonsLocked
    });

    const historyCard = navCard({
      title: "3 · Lesson history",
      subtitle: history.length
        ? (history.length + " lesson" + (history.length === 1 ? "" : "s") + " completed · " + avg + "% average score")
        : "No lessons yet — your history will show up here.",
      buttonLabel: "View history", action: "open-history"
    });

    return atmosphere() + headerBar({ isHome:true, gear:true }) +
      '<main id="app-main" class="app-main screen">' +
        notice +
        lessonBanner +
        '<div class="hero-card">' +
          '<div class="eyebrow">Bloom</div>' +
          '<h1 class="title-lg" style="margin-top:6px;">' + esc(greetTitle) + "</h1>" +
          '<p class="sub" style="color:rgba(255,255,255,.92); margin-top:8px;">' + greetBody + "</p>" +
        "</div>" +
        '<div class="stack">' + placementCard + lessonsCard + historyCard + "</div>" +
        (placementResult ? (
          '<div class="stat-grid">' +
            '<div class="stat-tile"><div class="num">' + streak + '</div><div class="lbl">DAY STREAK</div></div>' +
            '<div class="stat-tile"><div class="num">' + history.length + '</div><div class="lbl">LESSONS DONE</div></div>' +
            '<div class="stat-tile"><div class="num">' + (history.length ? avg + "%" : "—") + '</div><div class="lbl">AVG SCORE</div></div>' +
          "</div>"
        ) : "") +
      "</main>" +
      (showSettings ? renderSettingsSheet() : "");
  }

  function renderProfile(){
    const savedAge = profileFormAge;
    const savedEdu = profileFormEducation;
    return atmosphere() + headerBar({}) +
      '<main id="app-main" class="app-main screen">' +
        '<div class="stack-sm">' +
          '<span class="eyebrow">Before you begin</span>' +
          '<h1 class="title-lg">Quick profile</h1>' +
          '<p class="sub">Just two questions — this helps put your results in context.</p>' +
        "</div>" +
        '<div class="card stack">' +
          (profileError ? '<div class="card-soft" style="border-color:var(--danger-bg); color:var(--danger);">' + esc(profileError) + "</div>" : "") +
          '<div class="field">' +
            '<label for="profile-age">Your age</label>' +
            '<input type="number" id="profile-age" class="text-input" inputmode="numeric" min="5" max="120" placeholder="e.g. 34" value="' + esc(savedAge) + '" />' +
          "</div>" +
          '<div class="field">' +
            '<label for="profile-education">Highest level of education completed</label>' +
            '<select id="profile-education" class="select">' +
              '<option value="" ' + (savedEdu ? "" : "selected") + " disabled>Select one</option>" +
              EDUCATION_LEVELS.map(function(level){
                return '<option value="' + esc(level) + '" ' + (level === savedEdu ? "selected" : "") + ">" + esc(level) + "</option>";
              }).join("") +
            "</select>" +
          "</div>" +
          '<button class="btn btn-primary" data-action="submit-profile">Continue to placement test</button>' +
        "</div>" +
      "</main>";
  }

  function renderPlacement(){
    const idx = placementProgress.currentIndex;
    const q = PLACEMENT_BY_ID[placementProgress.order[idx]];
    const selected = placementProgress.answers[idx];
    const isLast = idx === placementProgress.order.length - 1;
    return atmosphere() +
      headerBar({}) +
      '<main id="app-main" class="app-main screen">' +
        progressBar(idx + 1, placementProgress.order.length) +
        '<div class="card stack">' +
          '<div class="row-between" style="flex-wrap:wrap; row-gap:8px;">' +
            '<span class="pill pill-amethyst" style="white-space:nowrap;">' + esc(CATEGORY_NAMES[q.category]) + "</span>" +
            '<span class="pill pill-beige" style="white-space:nowrap;">Difficulty ' + placementProgress.displaySnapshot[idx] + '/10</span>' +
          "</div>" +
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

  // Loose expectation baselines, used only to give the ceiling numbers some
  // context on screen. Deliberately coarse, and labelled as an estimate
  // where it's shown — there is no validated norming data behind this.
  const EDUCATION_BASELINE = {
    "High school diploma or GED": 5,
    "Some college": 5.5,
    "Associate degree": 6,
    "Bachelor's degree": 6.5,
    "Master's degree": 7,
    "Doctoral degree": 7.5
  };
  function ceilingBand(n){
    for(let i = 0; i < CEILING_BANDS.length; i++){ if(n <= CEILING_BANDS[i].max) return i; }
    return CEILING_BANDS.length - 1;
  }
  function levelMeterHTML(ceiling){
    let out = '<div class="level-meter" role="img" aria-label="Level ' + ceiling + ' of 10">';
    for(let i = 1; i <= 10; i++) out += "<span" + (i <= ceiling ? ' class="on"' : "") + "></span>";
    return out + "</div>";
  }
  function subSkillChipsHTML(subSkills){
    const names = Object.keys(subSkills).sort(function(a, b){
      const byPct = subSkills[b].pct - subSkills[a].pct;
      return byPct !== 0 ? byPct : subSkills[b].total - subSkills[a].total;
    });
    return '<div class="chip-row">' + names.map(function(n){
      const s = subSkills[n];
      const cls = s.pct >= 67 ? "chip-good" : s.pct >= 34 ? "chip-mid" : "chip-low";
      return '<span class="chip ' + cls + '">' + esc(n) + " <b>" + s.correct + "/" + s.total + "</b></span>";
    }).join("") + "</div>";
  }
  function benchmarkHTML(avgCeiling){
    if(!profile) return "";
    const base = EDUCATION_BASELINE[profile.education];
    if(typeof base !== "number") return "";
    const ageAdj = profile.age < 18 ? -1 : profile.age < 25 ? -0.5 : profile.age < 40 ? 0 : 0.5;
    const lo = clamp(Math.round(base + ageAdj - 1), 1, 10);
    const hi = clamp(Math.round(base + ageAdj + 1), 1, 10);
    const where = avgCeiling > hi ? "sits above that range"
      : avgCeiling < lo ? "sits below that range"
      : "sits inside that range";
    return '<div class="card-soft stack-sm">' +
        '<span class="eyebrow">Rough context</span>' +
        '<p class="sub">Age ' + esc(profile.age) + " · " + esc(profile.education) + " — a loose expectation would land around levels " +
          lo + "–" + hi + ". Your average ceiling of " + avgCeiling + " " + where + ".</p>" +
        '<p class="sub" style="font-size:.8rem;">A rough sketch drawn from two data points, not a validated benchmark — context, not a verdict.</p>' +
      "</div>";
  }
  function categoryCardHTML(key, c){
    const band = ceilingBand(c.ceiling);
    const insights = CATEGORY_INSIGHTS[key];
    const insight = insights ? insights[band] : "";
    return '<div class="card stack-sm">' +
        '<div class="row-between" style="flex-wrap:wrap; row-gap:6px;">' +
          '<span style="font-weight:800;">' + esc(c.name) + "</span>" +
          '<span class="pill pill-amethyst" style="white-space:nowrap;">Level ' + c.ceiling + " · " + esc(CEILING_BANDS[band].name) + "</span>" +
        "</div>" +
        levelMeterHTML(c.ceiling) +
        (insight ? '<p class="sub">' + esc(insight) + "</p>" : "") +
        subSkillChipsHTML(c.subSkills) +
      "</div>";
  }
  function detailedResultHTML(r){
    const keys = Object.keys(r.categoryScores).sort(function(a, b){
      return r.categoryScores[b].ceiling - r.categoryScores[a].ceiling;
    });
    const cats = keys.map(function(k){ return r.categoryScores[k]; });
    const avgCeiling = Math.round((cats.reduce(function(s, c){ return s + c.ceiling; }, 0) / cats.length) * 10) / 10;
    const top = cats[0];
    const bottom = cats[cats.length - 1];
    return '<div class="card stack-sm">' +
        '<h3 class="title-md">Your snapshot</h3>' +
        '<p class="sub">Each category is scored 1–10 by the hardest level you were still answering correctly at the end of the test — your ceiling, not your percentage.</p>' +
        '<p class="sub">Strongest: <strong style="color:var(--ink)">' + esc(top.name) + "</strong> (level " + top.ceiling + ")" +
          (cats.length > 1 ? ' · Focus next on <strong style="color:var(--ink)">' + esc(bottom.name) + "</strong> (level " + bottom.ceiling + ")" : "") + "</p>" +
      "</div>" +
      benchmarkHTML(avgCeiling) +
      keys.map(function(k){ return categoryCardHTML(k, r.categoryScores[k]); }).join("") +
      '<p class="sub" style="font-size:.8rem;">Sub-skill counts come from a light sample across 40 questions — a 1/1 or 0/1 is a hint, not a verdict.</p>';
  }
  // Results saved before the scoring engine existed have no categoryScores,
  // so they keep the original percentage breakdown until the test is retaken.
  function legacyResultHTML(r){
    return '<div class="card stack">' +
        '<h3 class="title-md">Strengths &amp; growth areas</h3>' +
        "<div>" + r.breakdown.map(function(b){
          return '<div class="bar-row"><div class="bar-row-top"><span>' + esc(b.name) + "</span><span>" + b.pct + "%</span></div>" +
            '<div class="bar-track"><div class="bar-fill ' + pctColorClass(b.pct) + '" style="width:' + b.pct + '%"></div></div></div>';
        }).join("") + "</div>" +
        '<p class="sub">Retake the test to see your level-by-level breakdown.</p>' +
      "</div>";
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
        (r.categoryScores ? detailedResultHTML(r) : legacyResultHTML(r)) +
        '<div class="btn-row">' +
          '<button class="btn btn-outline" data-action="retake-placement">Retake test</button>' +
          '<button class="btn btn-primary" data-action="go-home">Back to home</button>' +
        "</div>" +
      "</main>";
  }

  function renderSettingsSheet(){
    return '<div class="overlay" data-action="close-settings">' +
      '<div class="sheet stack" data-action="noop">' +
        '<div class="row-between"><h3 class="title-md">Settings</h3><button class="icon-btn" data-action="close-settings">' + svgIcon("close") + "</button></div>" +
        '<button class="btn btn-outline" data-action="retake-placement">Retake placement test</button>' +
        '<button class="btn btn-outline" style="color:var(--danger); border-color:var(--danger-bg);" data-action="reset-all">Reset all progress</button>' +
      "</div>" +
    "</div>";
  }

  function renderLessonSetup(){
    const count = computeQuestionCount(selectedDuration);
    return atmosphere() + headerBar({}) +
      '<main id="app-main" class="app-main screen">' +
        '<div class="stack-sm"><span class="eyebrow">Adaptive practice · Level ' + moduleLevel + "</span><h1 class=\"title-lg\">Set up your lesson</h1></div>" +
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
      headerBar({}) +
      '<main id="app-main" class="app-main screen">' +
        progressBar(idx + 1, activeLesson.questions.length) +
        '<div class="card stack">' +
          '<div class="row-between" style="flex-wrap:wrap; row-gap:8px;">' +
            '<span class="pill pill-rose">' + esc(q.sub) + "</span>" +
            // Lessons in progress from before per-question difficulty was stored carry no value.
            (typeof q.difficulty === "number"
              ? '<span class="pill pill-beige" style="white-space:nowrap;">Difficulty ' + q.difficulty + "/10</span>"
              : "") +
          "</div>" +
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
          '<button class="btn btn-outline" data-action="go-home">Home</button>' +
          '<button class="btn btn-primary" data-action="repeat-lesson">Repeat lesson</button>' +
        "</div>" +
      "</main>";
  }

  function renderHistory(){
    if(!history.length){
      return atmosphere() + headerBar({}) +
        '<main id="app-main" class="app-main screen">' +
          '<div class="empty-state"><div class="emoji">📔</div><h3 class="title-md">No lessons yet</h3><p class="sub">Finish your first lesson and it’ll show up here.</p></div>' +
        "</main>";
    }
    return atmosphere() + headerBar({}) +
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
    return atmosphere() + headerBar({}) +
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
      case "home": html = renderHome(); break;
      case "profile": html = renderProfile(); break;
      case "placement": html = renderPlacement(); break;
      case "placement-result": html = renderPlacementResult(); break;
      case "lesson-setup": html = renderLessonSetup(); break;
      case "lesson": html = renderLesson(); break;
      case "lesson-result": html = renderLessonResult(); break;
      case "history": html = renderHistory(); break;
      case "history-detail": html = renderHistoryDetail(); break;
      default: html = renderHome();
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
      case "go-home": goHome(); break;
      case "open-placement": openPlacement(); break;
      case "submit-profile": submitProfile(); break;
      case "restart-placement":
        if(window.confirm("Start the placement test over from question 1?")) restartPlacement();
        break;
      case "select-placement": selectPlacementAnswer(parseInt(index, 10)); break;
      case "next-placement": nextPlacementQuestion(); break;
      case "prev-placement": prevPlacementQuestion(); break;
      case "open-settings": toggleSettings(true); break;
      case "close-settings": toggleSettings(false); break;
      case "retake-placement": confirmRetakePlacement(); break;
      case "reset-all": confirmResetAll(); break;
      case "dismiss-standalone-notice": dismissStandaloneNotice(); break;
      case "open-lessons": openLessons(); break;
      case "begin-lesson": beginLesson(selectedDuration); break;
      case "select-lesson": selectLessonAnswer(parseInt(index, 10)); break;
      case "next-lesson": nextLessonQuestion(); break;
      case "resume-lesson": resumeActiveLesson(); break;
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
    // Home is always the landing screen, regardless of saved progress or
    // how the app was launched (Safari tab vs. home-screen icon), so the
    // app opens the same way every time.
    navigate("home");
    if("serviceWorker" in navigator){
      const sw = navigator.serviceWorker;
      // Only a *change* of controller (not the first-ever install claiming
      // an uncontrolled page) means a newer deployed version just took
      // over — reload once so the page picks it up instead of continuing
      // to run stale in-memory code.
      const hadController = !!sw.controller;
      let reloadedForUpdate = false;
      sw.addEventListener("controllerchange", function(){
        if(!hadController || reloadedForUpdate) return;
        reloadedForUpdate = true;
        window.location.reload();
      });
      window.addEventListener("load", function(){
        sw.register("sw.js").then(function(reg){
          // Re-check for a newer version whenever the app is opened or
          // resumed — covers reopening the iOS home-screen icon, which
          // resumes from a frozen state rather than a fresh navigation
          // and can otherwise miss the browser's normal update check.
          document.addEventListener("visibilitychange", function(){
            if(document.visibilityState === "visible") reg.update().catch(function(){});
          });
        }).catch(function(){ /* offline caching is optional */ });
      });
    }
  }
  boot();
})();
