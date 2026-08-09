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

  function loadVoices() {
    if (!hasTTS) return true;
    voices = (synth.getVoices && synth.getVoices()) || [];
    koVoice =
      voices.find(function (v) { return /^ko/i.test(v.lang) && /Yuna|Google|Nari|Heami/i.test(v.name); }) ||
      voices.find(function (v) { return /^ko/i.test(v.lang); }) ||
      null;
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

  function speak(text, done) {
    var finish = onceFn(typeof done === 'function' ? done : function () {});
    if (!hasTTS || !text) { finish(); return; }
    try { synth.cancel(); } catch (e) { /* 무시 */ }

    // cancel 직후 곧바로 speak하면 iOS에서 무음이 되는 사례가 있어 한 틱 띄운다.
    setTimeout(function () {
      var u;
      try {
        u = new global.SpeechSynthesisUtterance(text);
      } catch (e) { finish(); return; }
      u.lang = 'ko-KR';
      u.rate = 0.85;
      u.pitch = 1;
      if (koVoice) u.voice = koVoice;

      var keepAlive = setInterval(function () {
        try { synth.resume(); } catch (e) { /* 무시 */ }
      }, 5000);
      var watchdog = setTimeout(finish2, text.length * 280 + 2500);

      function finish2() {
        clearInterval(keepAlive);
        clearTimeout(watchdog);
        finish();
      }
      u.onend = finish2;
      u.onerror = finish2;

      try { synth.speak(u); } catch (e) { finish2(); }
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
        if (code === 'not-allowed' || code === 'service-not-allowed') onError('not-allowed');
        else if (code === 'no-speech') onError('no-speech');
        else if (code === 'network') onError('network');
        else if (code === 'aborted') { /* 사용자가 멈춘 것 — 조용히 넘어간다 */ }
        else onError(code || 'unknown');
        stopListen();
      };

      rec.onend = function () {
        listening = false;
        clearTimeout(hardStop);
        onStop();
        if (!gotResult) onError('no-speech');
      };

      try {
        rec.start();
      } catch (e) { onError('start-failed'); return; }

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

  global.KKI = global.KKI || {};
  global.KKI.speech = {
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
