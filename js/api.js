/* /api/word 클라이언트. 타임아웃과 1회 자동 재시도만 담당한다. */
(function (global) {
  'use strict';

  function once(body, timeout) {
    var ac = new AbortController();
    var t = setTimeout(function () { ac.abort(); }, timeout);
    return fetch('/api/word', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
          return data;
        });
      })
      .finally(function () { clearTimeout(t); });
  }

  function call(body, opt) {
    opt = opt || {};
    var timeout = opt.timeout || 26000;
    return once(body, timeout).catch(function (err) {
      // 네트워크가 순간적으로 끊긴 경우만 한 번 더
      if (err && err.name === 'AbortError') throw new Error('AI가 늦게 대답하고 있어요. 다시 해 볼까요?');
      return new Promise(function (res) { setTimeout(res, 700); }).then(function () {
        return once(body, timeout);
      });
    });
  }

  global.KKI = global.KKI || {};
  global.KKI.api = {
    start: function (p) { return call(Object.assign({ mode: 'start' }, p)); },
    turn: function (p) { return call(Object.assign({ mode: 'turn' }, p)); },
    hint: function (p) { return call(Object.assign({ mode: 'hint' }, p)); }
  };
})(window);
