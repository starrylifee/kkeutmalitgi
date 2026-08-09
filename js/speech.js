/* 음성 입력(STT)과 음성 출력(TTS).
   폰에서 가장 잘 깨지는 부분이라 방어 코드가 많다.
   - iOS 사파리는 사용자가 누른 그 순간에 speak()가 한 번 불린 적이 있어야 이후 소리가 난다.
   - 안드로이드 크롬은 voiceschanged가 늦게 오거나 아예 안 온다.
   - onend가 안 오는 기기가 있어 낭독 끝을 타이머로도 잡는다. */
(function (global) {
  'use strict';

  /* ---------- TTS ---------- */

  var synth = global.speechSynthesis;
  var hasTTS = !!synth && typeof global.SpeechSynthesisUtterance === 'function';
  var voices = [];
  var koVoice = null;
  var unlocked = false;

  /* 기기마다 언어 표기가 제각각이다 — ko-KR, ko_KR, kor, 빈 문자열에 이름만 Korean인 것도 있다.
     그래서 언어 코드와 이름을 함께 본다. */
  function koVoices() {
    return voices.filter(function (v) {
      return /(^|[^a-z])ko([^a-z]|$)|^kor/i.test(String(v.lang || '')) ||
        /korean|한국/i.test(String(v.name || ''));
    });
  }

  function loadVoices() {
    if (!hasTTS) return true;
    voices = (synth.getVoices && synth.getVoices()) || [];
    var ko = koVoices();
    /* 삼성 태블릿 기본 엔진은 한국어를 못 읽고 조용히 실패하는 일이 있다.
       구글 음성이 깔려 있으면 그쪽을 먼저 쓴다. */
    koVoice =
      ko.find(function (v) { return /google/i.test(v.name); }) ||
      ko.find(function (v) { return /Yuna|Nari|Heami|Sora/i.test(v.name); }) ||
      ko[0] || null;
    return voices.length > 0;
  }

  if (hasTTS) {
    loadVoices();
    if ('onvoiceschanged' in synth) synth.onvoiceschanged = loadVoices;
    var poll = setInterval(function () { if (loadVoices()) clearInterval(poll); }, 300);
    setTimeout(function () { clearInterval(poll); }, 6000);
  }

  // 사용자 제스처 안에서 반드시 한 번 호출해야 한다 (시작 버튼 클릭 첫 줄).
  function unlockTTS() {
    if (unlocked || !hasTTS) return;
    try {
      var u = new global.SpeechSynthesisUtterance('​');
      u.volume = 0;
      u.lang = 'ko-KR';
      synth.speak(u);
      unlocked = true;
    } catch (e) { /* 무시 */ }
  }

  function onceFn(fn) {
    var done = false;
    return function () { if (!done) { done = true; fn(); } };
  }

  /* 한 번 읽어 준다. 소리가 실제로 시작됐는지(onstart)를 지켜보다가,
     아무 일도 일어나지 않으면 목소리 지정을 빼고 한 번 더 시도한다.
     갤럭시탭 기본 엔진이 조용히 실패하는 경우가 있어서다. */
  function speakOnce(text, useVoice, onStarted, done) {
    var finish = onceFn(done);
    var u;
    try {
      u = new global.SpeechSynthesisUtterance(text);
    } catch (e) { finish(); return; }
    u.lang = 'ko-KR';
    u.rate = 0.85;
    u.pitch = 1;
    if (useVoice && koVoice) u.voice = koVoice;

    var started = false;
    var keepAlive = setInterval(function () {
      try { synth.resume(); } catch (e) { /* 무시 */ }
    }, 5000);
    var watchdog = setTimeout(end, text.length * 280 + 2500);

    function end() {
      clearInterval(keepAlive);
      clearTimeout(watchdog);
      finish();
    }
    u.onstart = function () { started = true; onStarted(); };
    u.onend = end;
    u.onerror = end;

    try { synth.speak(u); } catch (e) { end(); return; }
    // 소리가 시작조차 안 하면 실패로 본다
    setTimeout(function () { if (!started) onStarted(false); }, 900);
  }

  function speak(text, done) {
    var finish = onceFn(typeof done === 'function' ? done : function () {});
    if (!hasTTS || !text) { finish(); return; }
    try { synth.cancel(); } catch (e) { /* 무시 */ }

    // cancel 직후 곧바로 speak하면 iOS에서 무음이 되는 사례가 있어 한 틱 띄운다.
    setTimeout(function () {
      var retried = false;
      speakOnce(text, true, function (ok) {
        if (ok === false && !retried) {
          // 목소리를 고른 게 문제일 수 있다. 엔진이 알아서 고르게 두고 다시 해 본다.
          retried = true;
          try { synth.cancel(); } catch (e) { /* 무시 */ }
          setTimeout(function () { speakOnce(text, false, function () {}, finish); }, 60);
        }
      }, function () {
        // 다시 시도하기로 했으면 첫 번째가 끝났다고 넘어가지 않는다
        if (!retried) finish();
      });
    }, 90);
  }

  function stopSpeaking() {
    if (hasTTS) { try { synth.cancel(); } catch (e) { /* 무시 */ } }
  }

  /* ---------- STT ---------- */

  var SR = global.SpeechRecognition || global.webkitSpeechRecognition;
  var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var sttSupported = !!SR && secure;
  var isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  var rec = null;
  var listening = false;
  var gotResult = false;
  var hardStop = null;

  function stopListen() {
    clearTimeout(hardStop);
    if (rec) { try { rec.stop(); } catch (e) { /* 무시 */ } }
  }

  // 마이크 권한을 먼저 물어 두면 recognition 쪽 에러보다 안내가 명확하다.
  function ensureMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(true);
    return navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (s) {
        s.getTracks().forEach(function (t) { t.stop(); });
        return true;
      })
      .catch(function () { return false; });
  }

  /* 낱말 하나만 받으면 되므로 단발 인식으로 간다.
     안드로이드 크롬은 continuous를 무시하고 iOS는 지원하지 않으므로 자동 재시작도 하지 않는다. */
  function listenOnce(cb) {
    cb = cb || {};
    var onInterim = cb.onInterim || function () {};
    var onResult = cb.onResult || function () {};
    var onError = cb.onError || function () {};
    var onStart = cb.onStart || function () {};
    var onStop = cb.onStop || function () {};

    if (!sttSupported) { onError('unsupported'); return; }
    if (listening) return;

    ensureMic().then(function (ok) {
      if (!ok) { onError('not-allowed'); return; }

      try {
        rec = new SR();
      } catch (e) { onError('start-failed'); return; }

      rec.lang = 'ko-KR';
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 3;
      gotResult = false;

      // onerror 뒤에 onend가 또 오는 기기가 있어 안내가 두 번 뜨는 걸 막는다.
      var errored = false;
      var fail = function (code) {
        if (errored) return;
        errored = true;
        onError(code);
      };

      rec.onresult = function (e) {
        var interim = '', finalTx = '', alts = [];
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var r = e.results[i];
          if (r.isFinal) {
            finalTx += r[0].transcript;
            for (var k = 0; k < r.length && k < 3; k++) alts.push(r[k].transcript);
          } else {
            interim += r[0].transcript;
          }
        }
        if (interim) onInterim(interim);
        if (finalTx) {
          gotResult = true;
          stopListen();
          onResult(finalTx, alts);
        }
      };

      rec.onerror = function (e) {
        var code = e && e.error;
        if (code === 'not-allowed' || code === 'service-not-allowed') fail('not-allowed');
        else if (code === 'no-speech') fail('no-speech');
        else if (code === 'network') fail('network');
        else if (code === 'aborted') { errored = true; /* 사용자가 멈춘 것 */ }
        else fail(code || 'unknown');
        stopListen();
      };

      rec.onend = function () {
        listening = false;
        clearTimeout(hardStop);
        onStop();
        if (!gotResult) fail('no-speech');
      };

      try {
        rec.start();
      } catch (e) { fail('start-failed'); return; }

      listening = true;
      onStart();
      hardStop = setTimeout(stopListen, 8000);
    });
  }

  var ERR_MSG = {
    'unsupported': '이 브라우저에서는 말하기 입력이 안 돼요. 크롬으로 열면 말로도 할 수 있어요.',
    'not-allowed': '마이크를 쓰도록 허용해 주세요.',
    'no-speech': '잘 안 들렸어요. 다시 말해 볼까요?',
    'network': '인터넷이 불안정해요. 글로 써 볼까요?',
    'start-failed': '마이크를 켜지 못했어요. 글로 써 볼까요?'
  };

  /* 소리가 안 날 때 무엇이 문제인지 알려 준다.
     갤럭시탭에서 한국어 음성 데이터가 없으면 speak가 조용히 실패한다. */
  // 기기가 알려 준 목소리 목록을 사람이 읽을 수 있게 적는다.
  function voiceList() {
    if (!voices.length) return '기기가 목소리 목록을 주지 않았어요.';
    return '이 기기의 목소리 ' + voices.length + '개 — ' +
      voices.slice(0, 8).map(function (v) {
        return (v.name || '이름없음') + '(' + (v.lang || '언어없음') + ')';
      }).join(', ') + (voices.length > 8 ? ' 외' : '');
  }

  /* 목록에 한국어가 없어도 일단 소리를 내 본다.
     엔진이 목소리를 목록에 안 내놓고도 읽어 주는 기기가 있기 때문이다. */
  function testSound(report) {
    if (!hasTTS) {
      report('이 브라우저는 소리 읽어 주기를 지원하지 않아요. 크롬으로 열어 보세요.', false);
      return;
    }
    loadVoices();
    var ko = koVoices();
    var withVoice = ko.length > 0;
    try { synth.cancel(); } catch (e) { /* 무시 */ }

    setTimeout(function () {
      speakOnce('소리가 잘 들리나요', withVoice, function (ok) {
        if (ok === false) {
          if (withVoice) {
            report('한국어 목소리(' + ko[0].name + ')는 있는데 소리가 나오지 않아요. ' +
              '미디어 볼륨을 올려 보시고, 그래도 안 되면 기기 설정에서 기본 음성 엔진을 ' +
              '「Google 음성 인식 및 합성」으로 바꿔 주세요.\n' + voiceList(), false);
          } else {
            report('소리가 나오지 않아요. 먼저 미디어 볼륨을 올리고 다시 눌러 보세요.\n' +
              '그래도 안 되면 플레이스토어에서 「Google 음성 인식 및 합성」을 설치하고, ' +
              '설정 > 일반 > 접근성 > 글자 음성 변환에서 기본 엔진을 Google로 바꾼 뒤 ' +
              '한국어를 내려받아 주세요.\n' + voiceList(), false);
          }
        } else {
          // 소리가 나갔다. 목소리가 목록에 없어도 문제가 아니므로 걱정을 안 만든다.
          report('지금 「소리가 잘 들리나요」라고 말했어요. 들렸다면 그대로 쓰시면 됩니다.' +
            (withVoice ? '\n쓰는 목소리: ' + ko[0].name : '') +
            '\n혹시 안 들렸다면 미디어 볼륨을 올리고 다시 눌러 보세요.', true);
        }
      }, function () { /* 끝났을 때 할 일 없음 */ });
    }, 80);
  }

  global.KKI = global.KKI || {};
  global.KKI.speech = {
    testSound: testSound,
    hasTTS: hasTTS,
    sttSupported: sttSupported,
    isIOS: isIOS,
    unlockTTS: unlockTTS,
    speak: speak,
    stopSpeaking: stopSpeaking,
    listenOnce: listenOnce,
    stopListen: stopListen,
    isListening: function () { return listening; },
    errorMessage: function (code) { return ERR_MSG[code] || '소리를 알아듣지 못했어요. 다시 해 볼까요?'; }
  };
})(window);
