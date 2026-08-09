/* 끝말잇기 규칙 엔진 — 순수 함수만 둔다.
   기계적인 판정(시작 글자, 글자 수, 중복)은 전부 여기서 즉시 처리하고,
   "실제로 있는 낱말인가"만 서버(Solar)에 맡긴다. */
(function (global) {
  'use strict';

  var IDX_N = 2;   // 초성 ㄴ
  var IDX_R = 5;   // 초성 ㄹ
  var IDX_O = 11;  // 초성 ㅇ

  // 중성 인덱스: ㅏ0 ㅐ1 ㅑ2 ㅒ3 ㅓ4 ㅔ5 ㅕ6 ㅖ7 ㅗ8 ㅘ9 ㅙ10 ㅚ11 ㅛ12 ㅜ13 ㅝ14 ㅞ15 ㅟ16 ㅠ17 ㅡ18 ㅢ19 ㅣ20
  var Y_R = { 2: 1, 6: 1, 7: 1, 12: 1, 17: 1, 20: 1 }; // ㅑㅕㅖㅛㅠㅣ — ㄹ이 ㅇ으로 바뀌는 모음
  var Y_N = { 2: 1, 6: 1, 12: 1, 17: 1, 20: 1 };       // ㅑㅕㅛㅠㅣ — ㄴ이 ㅇ으로 바뀌는 모음

  function decompose(ch) {
    var c = ch.charCodeAt(0) - 0xac00;
    if (c < 0 || c > 11171) return null;
    return { cho: (c / 588) | 0, jung: ((c % 588) / 28) | 0, jong: c % 28 };
  }

  function compose(cho, jung, jong) {
    return String.fromCharCode(0xac00 + cho * 588 + jung * 28 + jong);
  }

  /* 두음법칙으로 서로 바꿔 쓸 수 있는 글자들.
     한글 맞춤법 제10·11·12항.
       ㄹ + ㅑㅕㅖㅛㅠㅣ → ㅇ   (량↔양, 려↔여, 례↔예, 료↔요, 류↔유, 리↔이)
       ㄹ + 그 밖의 모음 → ㄴ   (락↔낙, 래↔내, 로↔노, 뢰↔뇌, 루↔누)
       ㄴ + ㅑㅕㅛㅠㅣ  → ㅇ   (녀↔여, 뇨↔요, 뉴↔유, 니↔이)
     '래'는 11항이 아니라 12항이라 '내'가 된다('애'가 아니다). */
  function variants(ch) {
    var out = [ch];
    var d = decompose(ch);
    if (!d) return out;

    var add = function (cho) {
      var v = compose(cho, d.jung, d.jong);
      if (out.indexOf(v) === -1) out.push(v);
    };

    if (Y_R[d.jung]) {
      if (d.cho === IDX_R || d.cho === IDX_N || d.cho === IDX_O) {
        add(IDX_R);
        add(IDX_O);
        if (Y_N[d.jung]) add(IDX_N);
      }
    } else {
      if (d.cho === IDX_R || d.cho === IDX_N) {
        add(IDX_R);
        add(IDX_N);
      }
    }
    return out;
  }

  // 이 글자로 끝났을 때 다음 낱말이 시작할 수 있는 글자들
  function allowedStarts(lastChar, dueum) {
    if (!lastChar) return [];
    return dueum ? variants(lastChar) : [lastChar];
  }

  function canFollow(lastChar, firstChar, dueum) {
    if (lastChar === firstChar) return true;
    if (!dueum) return false;
    return allowedStarts(lastChar, true).indexOf(firstChar) !== -1;
  }

  function normalize(raw) {
    return String(raw == null ? '' : raw)
      .normalize('NFC')
      .replace(/\s+/g, '')
      .replace(/[^가-힣]/g, '');
  }

  function lastCharOf(word) {
    var w = normalize(word);
    return w ? w.charAt(w.length - 1) : '';
  }

  /* 학생이 이을 수 없는 끝 글자(한방 단어). AI가 이런 낱말을 내지 않게 거른다.
     학생이 내는 건 막지 않는다 — 오히려 잘한 것이므로 칭찬하고 넘어간다. */
  var DEAD_END = ['늪', '릎', '슭', '윷', '옆', '팥', '흙', '솥', '짚', '빚', '숲',
    '칡', '녘', '샅', '뭍', '귤', '틈', '뺨', '픔', '흠', '릇', '즘', '츰', '늑',
    '뜸', '쁨', '읊', '깊', '넋', '삯', '섶', '앞', '엌', '옻', '윗', '헛'];

  function isDeadEnd(word) {
    return DEAD_END.indexOf(lastCharOf(word)) !== -1;
  }

  var MSG = {
    EMPTY: '한글 낱말을 적어 주세요.',
    TOO_SHORT: '두 글자 이상인 낱말이어야 해요.',
    TOO_LONG: '너무 긴 낱말이에요. 다섯 글자까지만 해요.'
  };

  /* 로컬 검증. 실패해도 탈락은 없다 — 항상 다시 입력받는다.
     반환: {ok:true, word} | {ok:false, code, msg} */
  function checkLocal(raw, prevWord, usedSet, opt) {
    opt = opt || {};
    var w = normalize(raw);
    if (!w) return { ok: false, code: 'EMPTY', msg: MSG.EMPTY };
    if (w.length < 2) return { ok: false, code: 'TOO_SHORT', msg: MSG.TOO_SHORT };
    if (w.length > 5) return { ok: false, code: 'TOO_LONG', msg: MSG.TOO_LONG };
    if (usedSet && usedSet.has && usedSet.has(w)) {
      return { ok: false, code: 'DUP', msg: '"' + w + '"는 아까 나왔어요. 다른 낱말로 해 볼까요?' };
    }
    if (prevWord) {
      var last = lastCharOf(prevWord);
      if (!canFollow(last, w.charAt(0), !!opt.dueum)) {
        var heads = allowedStarts(last, !!opt.dueum);
        var head = heads.length > 1 ? heads.join(' 또는 ') : heads[0];
        return { ok: false, code: 'WRONG_START', msg: '"' + head + '"(으)로 시작해야 해요.' };
      }
    }
    return { ok: true, word: w };
  }

  global.KKI = global.KKI || {};
  global.KKI.hangul = {
    decompose: decompose,
    compose: compose,
    variants: variants,
    allowedStarts: allowedStarts,
    canFollow: canFollow,
    normalize: normalize,
    lastCharOf: lastCharOf,
    isDeadEnd: isDeadEnd,
    checkLocal: checkLocal,
    DEAD_END: DEAD_END
  };
})(window);
