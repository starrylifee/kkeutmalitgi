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
    roundCount: $('roundCount'),
    modal: $('modal'),
    modalInput: $('modalInput'),
    modalAlts: $('modalAlts'),
    modalHint: $('modalHint'),
    modalOk: $('modalOk'),
    modalCancel: $('modalCancel'),
    hintModal: $('hintModal'),
    hintBody: $('hintBody'),
    hintClose: $('hintClose'),
    hintMore: $('hintMore'),
    toast: $('toast')
  };

  var settings = { dueum: true, level: 'normal', time: 0 };
  var state = S.SETUP;
  var chain = [];          // {who:'me'|'ai', word, mean, pending, reject}
  var used = new Set();
  var pendingNode = null;
  var thinkNode = null;
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
      });
    });
    paint();
  }

  /* ── 공통 UI ─────────────────────────────── */

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
    if (!t.think) {
      el.roundCount.textContent = String(chain.filter(function (x) { return !x.think && !x.reject; }).length);
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
    toast('시간이 다 됐어요. 힌트를 볼까요?');
    SP.speak('시간이 다 됐어요. 힌트를 볼까요?');
    openHint();
  }

  /* ── 게임 시작 ───────────────────────────── */

  function startGame() {
    SP.unlockTTS();               // 사용자가 누른 이 순간에 반드시 한 번
    requestWakeLock();

    chain = [];
    used = new Set();
    el.chain.innerHTML = '';
    el.roundCount.textContent = '0';
    sttFails = 0;
    el.badge.textContent = '?';
    el.badgeAlt.textContent = '';
    setState(S.BOOTING);
    el.focusMsg.textContent = 'AI가 첫 낱말을 고르고 있어요';

    API.start({ level: settings.level, deadEnd: H.DEAD_END })
      .then(function (res) {
        playAiTurn(res.aiWord, res.aiMeaning, res.say);
      })
      .catch(function (err) {
        el.focusMsg.textContent = '연결이 잘 안 돼요';
        toast(err.message || 'AI를 부르지 못했어요.', 'warn');
        setState(S.STUDENT);      // 학생이 아무 낱말이나 먼저 낼 수 있게 열어 둔다
        el.focusMsg.textContent = '아무 낱말이나 먼저 말해 볼까요?';
        renderBadge();
      });
  }

  function playAiTurn(word, mean, say) {
    setState(S.AI);
    if (thinkNode) { removeNode(thinkNode); thinkNode = null; }
    if (!word) { onAiStuck(); return; }

    used.add(word);
    pushTurn({ who: 'ai', word: word, mean: mean });
    renderBadge();
    el.focusMsg.textContent = 'AI가 말하고 있어요';

    var line = word + '. ' + (mean || '');
    SP.speak(line, function () {
      toStudentTurn();
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
     이미 나온 낱말은 그대로 기억해 두어 같은 낱말이 또 나오지 않게 한다. */
  function restartChain(msg) {
    stopTimer();
    el.focusMsg.textContent = msg;
    toast(msg);
    SP.speak(msg, function () {
      setState(S.BOOTING);
      pushDivider('새 낱말로 다시 시작');
      el.focusMsg.textContent = 'AI가 새 낱말을 고르고 있어요';
      API.start({ level: settings.level, deadEnd: H.DEAD_END, used: Array.from(used) })
        .then(function (res) { playAiTurn(res.aiWord, res.aiMeaning); })
        .catch(function () {
          chain = [];
          setState(S.STUDENT);
          el.badge.textContent = '?';
          el.badgeAlt.textContent = '';
          el.focusMsg.textContent = '아무 낱말이나 먼저 말해 볼까요?';
        });
    });
  }

  function onAiStuck() {
    restartChain('와, 이어갈 낱말이 없어요. 어려운 낱말을 냈네요! 새 낱말로 다시 시작할게요.');
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
      deadEnd: H.DEAD_END
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
        el.roundCount.textContent = String(chain.filter(function (x) { return !x.think; }).length);

        if (res.aiStuck || !res.aiWord) { removeNode(thinkNode); thinkNode = null; onAiStuck(); return; }
        playAiTurn(res.aiWord, res.aiMeaning);
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
    if (focusInput) {
      // 키보드로 쓰기를 눌렀을 때만 포커스한다.
      // 음성 입력 뒤에 포커스하면 폰에서 키보드가 확인 화면을 덮어 버린다.
      setTimeout(function () { el.modalInput.focus(); el.modalInput.select(); }, 60);
    }
  }

  function closeModal() {
    el.modal.hidden = true;
    el.modalInput.blur();
  }

  /* ── 힌트 ───────────────────────────────── */

  function openHint() {
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

  if (!SP.sttSupported) {
    el.body.classList.add('no-stt');
    el.setupNote.textContent = location.protocol === 'file:'
      ? '지금은 파일로 열어서 말하기가 안 돼요. 주소로 접속하면 말로도 할 수 있어요.'
      : '이 브라우저는 말하기 입력이 안 돼요. 크롬으로 열면 말로도 할 수 있어요.';
  }

  el.startBtn.addEventListener('click', startGame);
  document.addEventListener('pointerdown', function () { SP.unlockTTS(); }, { once: true });

  el.backBtn.addEventListener('click', function () {
    SP.stopSpeaking();
    SP.stopListen();
    stopTimer();
    closeModal();
    closeHint();
    setState(S.SETUP);
  });

  el.micBtn.addEventListener('click', onMic);
  el.typeBtn.addEventListener('click', function () {
    if (state !== S.STUDENT) return;
    SP.stopSpeaking();
    openModal('', [], true);
  });
  el.hintBtn.addEventListener('click', function () {
    if (state !== S.STUDENT) return;
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
    if (e.key === 'Enter') { e.preventDefault(); el.modalOk.click(); }
  });
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
