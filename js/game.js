/* 상태 머신과 화면 연결.
   상태는 body[data-state] 하나로만 표현하고, 무엇을 보여줄지는 CSS가 정한다. */
(function (global) {
  'use strict';

  var H = global.KKI.hangul;
  var SP = global.KKI.speech;
  var API = global.KKI.api;

  var S = {
    SETUP: 'setup',
    BOOTING: 'booting',
    STUDENT: 'student',
    JUDGING: 'judging',
    AI: 'ai'
  };

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    body: document.body,
    setupNote: $('setupNote'),
    startBtn: $('startBtn'),
    testBtn: $('testBtn'),
    backBtn: $('backBtn'),
    chain: $('chain'),
    badge: $('nextBadge'),
    badgeAlt: $('nextAlt'),
    timer: $('timer'),
    timerBar: $('timerBar'),
    timerNum: $('timerNum'),
    focusMsg: $('focusMsg'),
    micBtn: $('micBtn'),
    micLabel: $('micLabel'),
    typeBtn: $('typeBtn'),
    hintBtn: $('hintBtn'),
    giveBtn: $('giveBtn'),
    roundCount: $('roundCount'),
    modal: $('modal'),
    modalInput: $('modalInput'),
    modalAlts: $('modalAlts'),
    modalHint: $('modalHint'),
    modalOk: $('modalOk'),
    modalCancel: $('modalCancel'),
    modalAuto: $('modalAuto'),
    modalAutoBar: $('modalAutoBar'),
    modalAutoNum: $('modalAutoNum'),
    hintModal: $('hintModal'),
    hintBody: $('hintBody'),
    hintClose: $('hintClose'),
    hintMore: $('hintMore'),
    toast: $('toast')
  };

  var settings = { dueum: true, level: 'g3', time: 0 };
  var LEVELS = ['g1', 'g3', 'g5', 'adult', 'hell', 'inferno'];
  var state = S.SETUP;
  var chain = [];          // {who:'me'|'ai', word, mean, pending, reject}
  var used = new Set();
  var pendingNode = null;
  var thinkNode = null;
  var turns = 0;       // 이번 판에서 주고받은 낱말 수
  var hintsLeft = 1;   // 힌트는 한 판에 한 번. 새 판이 시작되면 다시 채워진다.
  var sttFails = 0;

  var timerId = null, timeLeft = 0, timerTotal = 0, timerPaused = false;
  var hintData = null, hintStep = 0;
  var wakeLock = null;

  /* ── 설정 저장 ───────────────────────────── */

  function loadSettings() {
    try {
      var raw = localStorage.getItem('kki-settings');
      if (raw) settings = Object.assign(settings, JSON.parse(raw));
    } catch (e) { /* 무시 */ }
    // 예전에 저장된 easy/normal/hard 설정을 학년으로 옮긴다.
    if (LEVELS.indexOf(settings.level) === -1) {
      settings.level = { easy: 'g1', normal: 'g3', hard: 'g5' }[settings.level] || 'g3';
    }
  }
  function saveSettings() {
    try { localStorage.setItem('kki-settings', JSON.stringify(settings)); } catch (e) { /* 무시 */ }
  }

  function bindSeg(id, key, cast) {
    var wrap = $(id);
    var btns = wrap.querySelectorAll('button');
    function paint() {
      Array.prototype.forEach.call(btns, function (b) {
        var v = cast ? cast(b.dataset.val) : b.dataset.val;
        b.setAttribute('aria-pressed', String(v === settings[key]));
      });
    }
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        settings[key] = cast ? cast(b.dataset.val) : b.dataset.val;
        saveSettings();
        paint();
        if (key === 'level') paintHellNote();
      });
    });
    paint();
  }

  /* ── 공통 UI ─────────────────────────────── */

  function paintHellNote() {
    var n = document.getElementById('hellNote');
    if (n) n.hidden = LEVELS.indexOf(settings.level) < 4;
  }

  var toastTimer = null;
  function toast(msg, tone) {
    if (!msg) return;
    el.toast.textContent = msg;
    el.toast.className = 'toast on' + (tone === 'warn' ? ' warn' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.className = 'toast'; }, 3200);
  }

  function setState(next) {
    state = next;
    el.body.dataset.state = next;
  }

  // 지옥에서는 힌트를 주지 않는다. 화면에서 버튼을 감추는 것도 CSS가 이걸 보고 한다.
  function isHell() {
    return settings.level === 'hell' || settings.level === 'inferno';
  }

  // 새 판이 시작될 때마다 힌트를 다시 채운다.
  function resetHints() {
    hintsLeft = 1;
    paintHintBtn();
  }

  function paintHintBtn() {
    el.hintBtn.classList.toggle('spent', hintsLeft <= 0);
    var label = el.hintBtn.querySelector('span');
    if (label) label.textContent = hintsLeft > 0 ? '힌트' : '힌트 씀';
  }

  function lastWord() {
    for (var i = chain.length - 1; i >= 0; i--) {
      if (!chain[i].reject && !chain[i].think) return chain[i].word;
    }
    return '';
  }

  function allowedHeads() {
    return H.allowedStarts(H.lastCharOf(lastWord()), settings.dueum);
  }

  function renderBadge() {
    var heads = allowedHeads();
    el.badge.textContent = heads[0] || '?';
    el.badgeAlt.textContent = heads.length > 1 ? '또는 ' + heads.slice(1).join(', ') : '';
  }

  function scrollChain() {
    el.chain.scrollTop = el.chain.scrollHeight;
  }

  function makeTurnNode(t) {
    var d = document.createElement('div');
    d.className = 'turn ' + t.who + (t.pending ? ' pending' : '') + (t.think ? ' thinking' : '');
    var who = document.createElement('span');
    who.className = 'turn-who';
    who.textContent = t.who === 'me' ? '나' : 'AI';
    var w = document.createElement('div');
    w.className = 'turn-word';
    w.textContent = t.word;
    d.appendChild(who);
    d.appendChild(w);
    if (t.mean) {
      var m = document.createElement('p');
      m.className = 'turn-mean';
      m.textContent = t.mean;
      d.appendChild(m);
    }
    return d;
  }

  function pushTurn(t) {
    chain.push(t);
    var node = makeTurnNode(t);
    el.chain.appendChild(node);
    scrollChain();
    if (!t.think && !t.pending) {
      turns++;
      el.roundCount.textContent = String(turns);
    }
    return node;
  }

  function removeNode(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /* ── 타이머 ─────────────────────────────── */

  function startTimer() {
    stopTimer();
    if (!settings.time) { el.timer.hidden = true; return; }
    timerTotal = settings.time;
    timeLeft = settings.time;
    timerPaused = false;
    el.timer.hidden = false;
    paintTimer();
    timerId = setInterval(function () {
      if (timerPaused) return;
      timeLeft--;
      paintTimer();
      if (timeLeft <= 0) { stopTimer(); onTimeout(); }
    }, 1000);
  }
  function paintTimer() {
    el.timerBar.style.width = Math.max(0, (timeLeft / timerTotal) * 100) + '%';
    el.timerNum.textContent = String(Math.max(0, timeLeft));
    el.timer.classList.toggle('low', timeLeft <= 5);
  }
  function stopTimer() {
    clearInterval(timerId);
    timerId = null;
    el.timer.hidden = true;
    el.timer.classList.remove('low');
  }
  function pauseTimer() { timerPaused = true; }
  function resumeTimer() { timerPaused = false; }

  function onTimeout() {
    if (isHell()) {
      // 지옥에는 힌트가 없다. 시간은 다시 주되 도와주지는 않는다.
      var m = '시간이 다 됐어요. 그래도 계속 생각해 보세요.';
      toast(m, 'warn');
      SP.speak(m);
      startTimer();
      return;
    }
    if (hintsLeft <= 0) {
      // 힌트를 이미 썼다. 시간만 다시 주고 스스로 생각하게 둔다.
      var t = '시간이 다 됐어요. 힌트는 이미 썼으니 조금 더 생각해 볼까요?';
      toast(t, 'warn');
      SP.speak(t);
      startTimer();
      return;
    }
    toast('시간이 다 됐어요. 힌트를 볼까요?');
    SP.speak('시간이 다 됐어요. 힌트를 볼까요?');
    openHint();
  }

  /* ── 게임 시작 ───────────────────────────── */

  function startGame() {
    SP.unlockTTS();               // 사용자가 누른 이 순간에 반드시 한 번
    requestWakeLock();

    el.body.dataset.level = settings.level;   // CSS가 지옥인지 보고 힌트 버튼을 감춘다
    resetHints();
    chain = [];
    used = new Set();
    turns = 0;
    el.chain.innerHTML = '';
    el.roundCount.textContent = '0';
    sttFails = 0;
    el.badge.textContent = '?';
    el.badgeAlt.textContent = '';
    setState(S.BOOTING);
    el.focusMsg.textContent = 'AI가 첫 낱말을 고르고 있어요';

    API.start({ level: settings.level, deadEnd: H.DEAD_END, dueum: settings.dueum })
      .then(function (res) {
        playAiTurn(res.aiWord, res.aiMeaning, false, 1);
      })
      .catch(function (err) {
        el.focusMsg.textContent = '연결이 잘 안 돼요';
        toast(err.message || 'AI를 부르지 못했어요.', 'warn');
        setState(S.STUDENT);      // 학생이 아무 낱말이나 먼저 낼 수 있게 열어 둔다
        el.focusMsg.textContent = '아무 낱말이나 먼저 말해 볼까요?';
        renderBadge();
      });
  }

  function playAiTurn(word, mean, kill, nextCount) {
    setState(S.AI);
    if (thinkNode) { removeNode(thinkNode); thinkNode = null; }
    if (!word) { onAiStuck(); return; }

    used.add(word);
    pushTurn({ who: 'ai', word: word, mean: mean, kill: kill });
    renderBadge();
    el.focusMsg.textContent = 'AI가 말하고 있어요';

    var line = word + '. ' + (mean || '');
    SP.speak(line, function () {
      // 지옥 모드에서 한방 낱말을 맞았으면 여기서 판이 끝난다
      if (kill || nextCount === 0) { onStudentDead(word); return; }
      toStudentTurn();
    });
  }

  /* 학생이 이을 낱말이 하나도 없는 글자에 걸렸다 — 지옥 모드의 결말.
     몇 턴 버텼는지 남겨서 다시 도전하고 싶게 만든다. */
  function onStudentDead(word) {
    stopTimer();
    var last = H.lastCharOf(word);
    var best = 0;
    try { best = parseInt(localStorage.getItem('kki-hell-best') || '0', 10) || 0; } catch (e) { /* 무시 */ }
    var isBest = turns > best;
    if (isBest) {
      try { localStorage.setItem('kki-hell-best', String(turns)); } catch (e) { /* 무시 */ }
    }
    var msg = '「' + last + '」로 시작하는 낱말은 국어사전에 없어요. 제가 이겼습니다.';
    pushDivider(turns + '턴 버팀' + (isBest ? ' — 최고 기록!' : ' (최고 기록 ' + best + '턴)'));
    el.focusMsg.textContent = msg;
    toast(msg, 'warn');
    SP.speak(msg + ' ' + turns + '턴 버텼어요.', function () {
      restartChain('다시 해 볼까요?');
    });
  }

  function toStudentTurn() {
    setState(S.STUDENT);
    renderBadge();
    var heads = allowedHeads();
    el.focusMsg.textContent = heads.length > 1
      ? '「' + heads.join('」 또는 「') + '」(으)로 시작하는 낱말을 말해 보세요'
      : '「' + heads[0] + '」(으)로 시작하는 낱말을 말해 보세요';
    startTimer();
  }

  function pushDivider(text) {
    var d = document.createElement('p');
    d.className = 'divider';
    d.textContent = text;
    el.chain.appendChild(d);
    scrollChain();
  }

  /* 아무도 이을 수 없는 글자에 걸렸을 때. 승패가 없으니 새 낱말로 다시 이어 간다.
     새 판이므로 이미 나온 낱말 목록을 비운다 — 앞 판에서 썼던 낱말도 다시 쓸 수 있다.
     지나간 낱말은 화면에는 그대로 남겨 두어 무엇을 했는지 볼 수 있게 한다. */
  function restartChain(msg) {
    stopTimer();
    el.focusMsg.textContent = msg;
    toast(msg);
    SP.speak(msg, function () {
      setState(S.BOOTING);
      pushDivider('새 판 — 앞에서 쓴 낱말도 다시 쓸 수 있어요');
      used = new Set();
      turns = 0;
      resetHints();
      el.roundCount.textContent = '0';
      el.focusMsg.textContent = 'AI가 새 낱말을 고르고 있어요';
      API.start({ level: settings.level, deadEnd: H.DEAD_END, dueum: settings.dueum, used: [] })
        .then(function (res) { playAiTurn(res.aiWord, res.aiMeaning, false, 1); })
        .catch(function () {
          chain = [];
          setState(S.STUDENT);
          el.badge.textContent = '?';
          el.badgeAlt.textContent = '';
          el.focusMsg.textContent = '아무 낱말이나 먼저 말해 볼까요?';
        });
    });
  }

  var LEVEL_NAME = { g1: '1~2학년', g3: '3~4학년', g5: '5~6학년', adult: '초6 이상' };

  function onAiStuck() {
    // 사전에 낱말이 아예 없어서일 수도 있고, 그 학년에게 어려운 말뿐이어서일 수도 있다.
    restartChain('제가 졌어요! ' + (LEVEL_NAME[settings.level] || '') +
      '이 아는 낱말 중에는 이어갈 말이 생각나지 않아요. 새 낱말로 다시 시작할게요.');
  }

  /* ── 낱말 제출 ───────────────────────────── */

  function submitWord(raw) {
    var check = H.checkLocal(raw, lastWord(), used, { dueum: settings.dueum });
    if (!check.ok) {
      // 규칙 위반은 서버까지 갈 필요가 없다. 바로 알려 주고 다시 기회를 준다.
      toast(check.msg, 'warn');
      SP.speak(check.msg);
      el.chain.classList.add('shake');
      setTimeout(function () { el.chain.classList.remove('shake'); }, 260);
      setState(S.STUDENT);
      resumeTimer();
      return;
    }

    var word = check.word;
    stopTimer();
    setState(S.JUDGING);

    // 학생 낱말은 먼저 화면에 붙이고, AI 자리만 '생각 중'으로 둔다.
    pendingNode = pushTurn({ who: 'me', word: word, pending: true });
    thinkNode = pushTurn({ who: 'ai', word: '생각하고 있어요…', think: true });
    el.focusMsg.textContent = 'AI가 낱말을 살펴보고 있어요';

    API.turn({
      word: word,
      used: Array.from(used),
      allowed: allowedHeads(),
      level: settings.level,
      dueum: settings.dueum,
      deadEnd: H.DEAD_END,
      turn: turns          // 지옥 모드에서 턴이 갈수록 조여가는 데 쓴다
    })
      .then(function (res) {
        if (res.valid === false) {
          // 없는 낱말 — 되돌리고 다시 기회를 준다. 탈락은 없다.
          removeNode(pendingNode);
          removeNode(thinkNode);
          chain = chain.filter(function (t) { return !t.pending && !t.think; });
          pendingNode = thinkNode = null;
          var msg = res.say || '사전에 없는 낱말이에요. 다른 낱말로 해 볼까요?';
          toast(msg, 'warn');
          SP.speak(msg, toStudentTurn);
          setState(S.STUDENT);
          renderBadge();
          return;
        }

        // 인정 — pending 해제
        if (pendingNode) pendingNode.classList.remove('pending');
        chain.forEach(function (t) { if (t.pending) t.pending = false; });
        pendingNode = null;
        used.add(word);
        turns++;                       // 학생 낱말은 인정된 뒤에 센다
        el.roundCount.textContent = String(turns);

        if (res.aiStuck || !res.aiWord) { removeNode(thinkNode); thinkNode = null; onAiStuck(); return; }
        playAiTurn(res.aiWord, res.aiMeaning, res.aiKill, res.nextCount);
      })
      .catch(function (err) {
        removeNode(pendingNode);
        removeNode(thinkNode);
        chain = chain.filter(function (t) { return !t.pending && !t.think; });
        pendingNode = thinkNode = null;
        toast(err.message || 'AI가 대답하지 못했어요. 다시 해 볼까요?', 'warn');
        setState(S.STUDENT);
        renderBadge();
        startTimer();
      });
  }

  /* ── 확인 모달 ───────────────────────────── */

  /* 말로 넣었으면 3초 세고 저절로 제출한다. 매번 버튼을 누르는 게 번거롭기 때문이다.
     모달 안을 건드리는 순간(고치려는 뜻이므로) 세기를 멈춘다. */
  var AUTO_SEC = 3;
  var autoId = null;
  var autoLeft = 0;

  function startAuto() {
    stopAuto();
    autoLeft = AUTO_SEC;
    el.modalAuto.hidden = false;
    el.modalAutoNum.textContent = String(autoLeft);
    el.modalAutoBar.style.transition = 'none';
    el.modalAutoBar.style.width = '100%';
    el.modalHint.textContent = '가만히 두면 저절로 제출돼요. 고치려면 낱말을 눌러 보세요.';
    // 다음 그림 그릴 때부터 줄어들게 한다
    requestAnimationFrame(function () {
      el.modalAutoBar.style.transition = 'width 1s linear';
      el.modalAutoBar.style.width = ((autoLeft - 1) / AUTO_SEC * 100) + '%';
    });
    autoId = setInterval(function () {
      autoLeft--;
      if (autoLeft <= 0) { stopAuto(); el.modalOk.click(); return; }
      el.modalAutoNum.textContent = String(autoLeft);
      el.modalAutoBar.style.width = ((autoLeft - 1) / AUTO_SEC * 100) + '%';
    }, 1000);
  }

  function stopAuto() {
    clearInterval(autoId);
    autoId = null;
    el.modalAuto.hidden = true;
  }

  // 학생이 고치려고 손을 대면 세기를 멈춘다.
  function cancelAuto() {
    if (!autoId) return;
    stopAuto();
    el.modalHint.textContent = '고쳐서 제출하면 돼요.';
  }

  function openModal(text, alts, focusInput) {
    pauseTimer();
    el.modalInput.value = H.normalize(text);
    el.modalHint.textContent = focusInput ? '' : '틀리게 들렸으면 고쳐도 돼요.';
    el.modalAlts.innerHTML = '';
    (alts || []).forEach(function (a) {
      var w = H.normalize(a);
      if (!w || w === H.normalize(text)) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = w;
      b.addEventListener('click', function () { el.modalInput.value = w; });
      el.modalAlts.appendChild(b);
    });
    el.modal.hidden = false;
    stopAuto();
    if (focusInput) {
      // 키보드로 쓰기를 눌렀을 때만 포커스한다.
      // 음성 입력 뒤에 포커스하면 폰에서 키보드가 확인 화면을 덮어 버린다.
      setTimeout(function () { el.modalInput.focus(); el.modalInput.select(); }, 60);
    } else if (el.modalInput.value) {
      startAuto();   // 말로 넣었고 알아들은 낱말이 있으면 3초 뒤 저절로 제출
    }
  }

  function closeModal() {
    stopAuto();
    el.modal.hidden = true;
    el.modalInput.blur();
  }

  /* ── 힌트 ───────────────────────────────── */

  function openHint() {
    if (hintsLeft <= 0) {
      toast('힌트는 한 판에 한 번이에요. 「포기」를 누르면 새 판이 시작돼요.', 'warn');
      return;
    }
    hintsLeft--;
    paintHintBtn();
    pauseTimer();
    hintData = null;
    hintStep = 0;
    el.hintBody.textContent = '힌트를 생각하고 있어요…';
    el.hintMore.disabled = true;
    el.hintMore.textContent = '더 알려 주세요';
    el.hintModal.hidden = false;

    API.hint({ allowed: allowedHeads(), used: Array.from(used), level: settings.level })
      .then(function (res) {
        if (!res.word) { offerRestart(); return; }
        hintData = res;
        hintStep = 1;
        el.hintBody.textContent = res.step1 || '음… 힌트를 못 만들었어요.';
        el.hintMore.disabled = false;
        SP.speak(res.step1 || '');
      })
      .catch(function () {
        el.hintBody.textContent = '힌트를 가져오지 못했어요. 그냥 계속해 볼까요?';
        el.hintMore.disabled = true;
      });
  }

  // 이을 낱말이 아예 없는 글자에 걸린 경우 — 막다른 길을 만들지 않는다.
  function offerRestart() {
    var heads = allowedHeads();
    hintStep = 99;
    el.hintBody.textContent = '「' + heads[0] + '」(으)로 시작하는 낱말은 찾기가 아주 어려워요.\n어려운 낱말을 냈네요! 새 낱말로 다시 시작할까요?';
    el.hintMore.disabled = false;
    el.hintMore.textContent = '새 낱말로 다시 시작';
  }

  function nextHint() {
    if (hintStep === 99) {
      closeHint();
      restartChain('새 낱말로 다시 시작할게요.');
      return;
    }
    if (!hintData) return;
    if (hintStep === 1) {
      hintStep = 2;
      el.hintBody.textContent = hintData.step2 || '';
      SP.speak(hintData.step2 || '');
      el.hintMore.textContent = '정답을 알려 주세요';
      return;
    }
    if (hintStep === 2) {
      hintStep = 3;
      el.hintBody.textContent = hintData.step3 || '';
      SP.speak(hintData.step3 || '');
      el.hintMore.textContent = hintData.word ? '「' + hintData.word + '」(으)로 이어가기' : '닫기';
      return;
    }
    // 3단계까지 봤으면 그 낱말로 이어 간다 — 승패가 없으니 이대로 계속한다.
    closeHint();
    if (hintData.word) submitWord(hintData.word);
  }

  function closeHint() {
    el.hintModal.hidden = true;
    if (state === S.STUDENT) { resumeTimer(); if (!timerId) startTimer(); }
  }

  /* ── 음성 입력 ───────────────────────────── */

  function onMic() {
    if (state !== S.STUDENT) return;
    if (SP.isListening()) { SP.stopListen(); return; }
    SP.stopSpeaking();
    pauseTimer();

    SP.listenOnce({
      onStart: function () {
        el.micBtn.classList.add('rec');
        el.micLabel.textContent = '듣는 중';
        el.focusMsg.textContent = '듣고 있어요. 낱말을 말해 보세요';
      },
      onStop: function () {
        el.micBtn.classList.remove('rec');
        el.micLabel.textContent = '말하기';
      },
      onInterim: function (t) {
        el.focusMsg.textContent = t;
      },
      onResult: function (text, alts) {
        sttFails = 0;
        openModal(text, alts, false);
      },
      onError: function (code) {
        if (code === 'no-speech' && el.modal.hidden === false) return;
        sttFails++;
        toast(SP.errorMessage(code), 'warn');
        resumeTimer();
        if (state === S.STUDENT) toStudentTurnMsg();
        // 아이폰은 음성인식 실패가 잦다. 두 번 실패하면 조용히 글쓰기로 바꿔 준다.
        if ((SP.isIOS && sttFails >= 2) || code === 'unsupported' || code === 'not-allowed') {
          el.body.classList.add('no-stt');
        }
      }
    });
  }

  function toStudentTurnMsg() {
    var heads = allowedHeads();
    el.focusMsg.textContent = '「' + heads.join('」 또는 「') + '」(으)로 시작하는 낱말을 말해 보세요';
  }

  /* ── 화면 꺼짐 방지 ──────────────────────── */

  function requestWakeLock() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    navigator.wakeLock.request('screen')
      .then(function (l) { wakeLock = l; })
      .catch(function () { /* 무시 */ });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state !== S.SETUP) requestWakeLock();
  });

  /* ── 소프트 키보드에 맞춰 높이 보정 ───────── */

  function fixViewport() {
    var h = (global.visualViewport && global.visualViewport.height) || global.innerHeight;
    document.documentElement.style.setProperty('--vvh', h + 'px');
  }
  if (global.visualViewport) {
    global.visualViewport.addEventListener('resize', fixViewport);
    global.visualViewport.addEventListener('scroll', fixViewport);
  }
  global.addEventListener('resize', fixViewport);
  global.addEventListener('orientationchange', function () { setTimeout(fixViewport, 250); });
  fixViewport();

  /* ── 이벤트 연결 ─────────────────────────── */

  loadSettings();
  bindSeg('optDueum', 'dueum', function (v) { return v === 'on'; });
  bindSeg('optLevel', 'level', null);
  bindSeg('optTime', 'time', function (v) { return parseInt(v, 10); });
  paintHellNote();

  if (!SP.sttSupported) {
    el.body.classList.add('no-stt');
    el.setupNote.textContent = location.protocol === 'file:'
      ? '지금은 파일로 열어서 말하기가 안 돼요. 주소로 접속하면 말로도 할 수 있어요.'
      : '이 브라우저는 말하기 입력이 안 돼요. 크롬으로 열면 말로도 할 수 있어요.';
  }

  el.startBtn.addEventListener('click', startGame);
  el.testBtn.addEventListener('click', function () {
    SP.unlockTTS();                     // 누른 이 순간에 풀어 둬야 아이폰에서도 소리가 난다
    el.setupNote.textContent = '소리를 내 보는 중이에요…';
    SP.testSound(function (msg, ok) {
      el.setupNote.textContent = msg;
      el.setupNote.classList.toggle('bad', !ok);
    });
  });
  document.addEventListener('pointerdown', function () { SP.unlockTTS(); }, { once: true });

  el.backBtn.addEventListener('click', function () {
    SP.stopSpeaking();
    SP.stopListen();
    stopTimer();
    closeModal();
    closeHint();
    setState(S.SETUP);
  });

  /* 포기 — 막혔을 때 언제든 새 판을 시작한다.
     승패를 가리는 놀이가 아니니 확인창 없이 바로 넘어간다. */
  el.giveBtn.addEventListener('click', function () {
    if (state === S.SETUP || state === S.BOOTING) return;
    SP.stopSpeaking();
    SP.stopListen();
    closeModal();
    closeHint();
    restartChain(turns > 0
      ? turns + '턴까지 갔네요. 새 낱말로 다시 시작할게요.'
      : '새 낱말로 다시 시작할게요.');
  });

  el.micBtn.addEventListener('click', onMic);
  el.typeBtn.addEventListener('click', function () {
    if (state !== S.STUDENT) return;
    SP.stopSpeaking();
    openModal('', [], true);
  });
  el.hintBtn.addEventListener('click', function () {
    if (state !== S.STUDENT || isHell()) return;
    SP.stopSpeaking();
    openHint();
  });

  el.modalOk.addEventListener('click', function () {
    var v = el.modalInput.value;
    closeModal();
    submitWord(v);
  });
  el.modalCancel.addEventListener('click', function () {
    closeModal();
    resumeTimer();
    if (state === S.STUDENT) toStudentTurnMsg();
  });
  el.modalInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); el.modalOk.click(); return; }
    cancelAuto();
  });
  // 낱말을 고치려고 손을 대면 저절로 제출되지 않게 멈춘다.
  el.modalInput.addEventListener('pointerdown', cancelAuto);
  el.modalInput.addEventListener('focus', cancelAuto);
  el.modalInput.addEventListener('input', cancelAuto);
  el.modalAlts.addEventListener('pointerdown', cancelAuto);
  el.modalAuto.addEventListener('pointerdown', cancelAuto);
  el.modal.addEventListener('click', function (e) {
    if (e.target === el.modal) el.modalCancel.click();
  });

  el.hintClose.addEventListener('click', closeHint);
  el.hintMore.addEventListener('click', nextHint);
  el.hintModal.addEventListener('click', function (e) {
    if (e.target === el.hintModal) closeHint();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!el.modal.hidden) el.modalCancel.click();
      else if (!el.hintModal.hidden) closeHint();
    }
  });
})(window);
