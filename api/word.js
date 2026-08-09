/* 끝말잇기 서버.
   일을 셋으로 나눈다.
     클라이언트  — 시작 글자·글자 수·중복 검사 (0초, 서버에 오기도 전에 끝난다)
     표준국어대사전 — 그 낱말이 실제로 있는지, 품사가 무엇인지 (사실 판정)
     Solar Pro 3  — 이어갈 낱말 후보 만들기 (창작)
   "있는 낱말인가"를 AI에게 묻지 않는 것이 핵심이다.
   물어보면 「름가마」 「깨비」 같은 없는 말을 지어내서 국어 시간에 잘못 가르치게 된다. */

export const config = { maxDuration: 30 };

const UPSTAGE_KEY = process.env.UPSTAGE_API_KEY;
const ENDPOINT = 'https://api.upstage.ai/v1/chat/completions';
const MODEL = 'solar-pro3';

// 국립국어원 표준국어대사전 오픈 API — 하루 5만 건.
// 낱말이 실제로 있는지는 AI에게 묻지 않고 여기서 확정한다.
const STDICT_KEY = process.env.STDICT_API_KEY;
const STDICT = 'https://stdict.korean.go.kr/api/search.do';

/* 반환: {found, noun, pos, def}
   found=false 는 사전에 없다는 뜻이고, null 은 조회를 못 했다는 뜻이다(둘을 구분해야 한다). */
async function lookup(word) {
  if (!STDICT_KEY || !word) return null;
  const url = `${STDICT}?key=${STDICT_KEY}&q=${encodeURIComponent(word)}` +
    '&req_type=json&num=10&method=exact&advanced=y';
  let body;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    body = await r.text();
  } catch (e) {
    return null;
  }
  if (!body.trim()) return { found: false, noun: false, pos: '', def: '' };  // 없는 말
  let d;
  try { d = JSON.parse(body); } catch (e) { return null; }

  let items = (d.channel && d.channel.item) || [];
  if (!Array.isArray(items)) items = [items];
  items = items.filter((i) => norm(i && i.word) === word);   // 표제어가 정확히 같은 것만
  if (!items.length) return { found: false, noun: false, pos: '', def: '' };

  const nouns = items.filter((i) => /명사/.test(String(i.pos || '')));
  const best = nouns[0] || items[0];
  const sense = Array.isArray(best.sense) ? best.sense[0] : best.sense;
  const def = String((sense && sense.definition) || '').split(/(?<=\.)\s/)[0];
  return {
    found: true,
    noun: nouns.length > 0,
    pos: String(best.pos || '').trim(),
    def: def.slice(0, 70)
  };
}

// 업스테이지 무료 기간: 2027-03-31 23:00 KST
const FREE_UNTIL = Date.parse('2027-03-31T14:00:00Z');

const LEVEL = {
  easy: '초등학교 1~2학년이 아는 아주 쉬운 낱말. 두 글자 위주. 동물·과일·학용품·음식처럼 눈에 보이는 것.',
  normal: '초등학교 3~4학년 교과서에 나올 만한 낱말. 두세 글자.',
  hard: '초등학교 5~6학년이 배우는 낱말. 세 글자까지. 그래도 어른만 아는 말은 쓰지 말 것.'
};

// 낱말 후보에 공통으로 붙는 제약. 동사·부사·고유명사가 후보로 올라오는 걸 막는다.
const WORD_RULES = `- 이름씨(명사)만 됩니다. 움직씨(동사)·그림씨(형용사)·어찌씨(부사)는 안 됩니다.
  「먹다」 「빠르다」 「성큼」 「살짝」 같은 말은 낱말 후보가 될 수 없습니다.
- 회사·지역·사람 이름 같은 고유명사, 외래어, 줄임말, 신조어는 쓰지 마세요.
- 두 글자 이상 다섯 글자 이하, 한글로만.
- 실제로 국어사전에 있는 낱말만 쓰세요. 뜻(m)을 초등학생 눈높이로 한 줄에 못 쓰겠으면 그 낱말은 빼세요.`;

const JSON_NOTE = `
- w와 m은 당신이 직접 채우세요. 위 형식에 적힌 글자를 그대로 옮겨 쓰지 마세요.
- 문자열 안에서 큰따옴표(")를 쓰지 마세요. 인용이 필요하면 「」를 쓰세요.
- JSON 밖에는 아무것도 쓰지 마세요.`;

function headsText(allowed) {
  return allowed.map(function (c) { return '「' + c + '」'; }).join(' 또는 ');
}

function clampArr(a, n) {
  return Array.isArray(a) ? a.slice(-n).map((x) => String(x).slice(0, 12)) : [];
}

function norm(raw) {
  return String(raw == null ? '' : raw).normalize('NFC').replace(/[^가-힣]/g, '');
}

// 이름씨가 아닌 품사. 모델이 스스로 붙인 품사표를 서버가 그대로 믿고 거른다.
const BAD_POS = /움직씨|동사|그림씨|형용사|어찌씨|부사|매김씨|관형사|고유|없는|신조|줄임/;

function isNoun(p) {
  const s = String(p || '');
  if (!s) return true;            // 품사를 안 붙였으면 다른 조건으로만 거른다
  return !BAD_POS.test(s);
}

// AI 후보 재검증 — 시작 글자·길이·중복·품사·뜻풀이를 서버가 직접 확인한다.
function pickCandidate(cands, allowed, usedSet, deadEnd, avoidDeadEnd) {
  if (!Array.isArray(cands)) return null;
  for (const c of cands) {
    const w = norm(c && c.w);
    const m = String((c && c.m) || '').trim();
    if (w.length < 2 || w.length > 5) continue;
    if (allowed.length && allowed.indexOf(w.charAt(0)) === -1) continue;
    if (usedSet.has(w)) continue;
    if (!m) continue;                       // 뜻을 못 쓴 낱말은 지어낸 말로 본다
    if (!isNoun(c && c.p)) continue;        // 움직씨·그림씨는 끝말잇기 낱말이 아니다
    if (w.length >= 3 && w.charAt(w.length - 1) === '다') continue; // 「오르다」류 기본형
    if (avoidDeadEnd && deadEnd.indexOf(w.charAt(w.length - 1)) !== -1) continue;
    return { w, m: m.slice(0, 60) };
  }
  return null;
}

class RateLimited extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askSolar(prompt, maxTokens, temperature, retried) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTAGE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens
    })
  });
  if (!r.ok) {
    const t = await r.text();
    // 한 반이 한꺼번에 누르면 순간적으로 한도에 걸린다. 조금 기다렸다 한 번만 더 시도한다.
    if ((r.status === 429 || /request limit/i.test(t)) && !retried) {
      await sleep(900 + Math.floor(Math.random() * 700));
      return askSolar(prompt, maxTokens, temperature, true);
    }
    if (r.status === 429 || /request limit/i.test(t)) {
      throw Object.assign(new RateLimited('한도 초과'), { detail: t.slice(0, 200) });
    }
    throw Object.assign(new Error(`AI 요청 실패 (${r.status})`), { detail: t.slice(0, 300) });
  }
  const c = await r.json();
  return ((c.choices && c.choices[0] && c.choices[0].message.content) || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}

// 문자열 값 안에 큰따옴표가 섞여 들어온 경우를 한 번 고쳐 본다.
function repairJson(txt) {
  return txt.replace(/:\s*"((?:[^"\\]|\\.)*)"/g, function (m, val) {
    return ': "' + val.replace(/(?<!\\)"/g, '「') + '"';
  });
}

// JSON 한 덩어리를 뽑아낸다. 실패하면 온도를 낮춰 한 번만 더 시도한다.
async function askJson(prompt, maxTokens, deadline, temps) {
  const T = temps || [0.8, 0.2];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && Date.now() > deadline - 7000) break; // 남은 시간이 없으면 포기
    let raw;
    try {
      raw = await askSolar(prompt, maxTokens, T[attempt]);
    } catch (e) {
      if (e instanceof RateLimited) throw e;  // 한도 초과는 다시 시도해도 소용없다
      throw e;
    }
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) {
      const body = raw.slice(s, e + 1);
      try { return JSON.parse(body); } catch (err) { /* 아래에서 한 번 고쳐 본다 */ }
      try { return JSON.parse(repairJson(body)); } catch (err) { /* 재시도 */ }
    }
  }
  return null;
}

/* 판정과 낱말 생성은 성격이 정반대다(판정은 일관되어야 하고 생성은 다양해야 한다).
   그래서 프롬프트를 나누고 온도를 달리해 두 호출을 동시에 보낸다. 지연은 한 번과 같다. */
function genPrompt({ used, allowed, level, deadEnd }) {
  var H = headsText(allowed);
  return `당신은 초등학교 국어 시간에 학생과 끝말잇기를 하는 선생님입니다. JSON으로만 대답합니다.
당신이 이어갈 낱말 후보 세 개를 만드세요.

## 이미 나온 낱말
${used.length ? used.join(', ') : '없음'}

## 규칙
**첫 글자 규칙: 세 낱말 모두 ${H}(으)로 시작해야 합니다. 다른 글자로 시작하면 안 됩니다.**
${WORD_RULES}
- 난이도: ${LEVEL[level] || LEVEL.normal}
- '이미 나온 낱말'과 겹치면 안 됩니다.
- 다음 글자로 끝나는 낱말은 피하세요(학생이 이어가기 어렵습니다): ${deadEnd.join(' ')}
- **${H}(으)로 시작하는 낱말이 국어사전에 정말 없으면, 억지로 지어내지 말고
  candidates를 빈 배열로 두고 stuck을 true로 하세요. 지어낸 낱말은 절대 쓰면 안 됩니다.**

## 출력 형식
{"candidates":[{"w":"낱말","p":"품사","m":"뜻"},{"w":"낱말","p":"품사","m":"뜻"},{"w":"낱말","p":"품사","m":"뜻"}],"stuck":false}
- p에는 그 낱말의 품사를 이름씨 / 움직씨 / 그림씨 / 어찌씨 중 하나로 정직하게 적으세요.${JSON_NOTE}

다시 확인하세요: candidates의 세 낱말은 모두 ${H}(으)로 시작하는, 국어사전에 실제로 있는 이름씨여야 합니다.`;
}

function startPrompt({ level, used, deadEnd }) {
  return `당신은 초등학교 국어 시간에 학생과 끝말잇기를 시작하는 선생님입니다. JSON으로만 대답합니다.
끝말잇기의 첫 낱말 후보 세 개를 정해 주세요.

## 이미 나온 낱말
${used.length ? used.join(', ') : '없음'}

## 규칙
${WORD_RULES}
- 난이도: ${LEVEL[level] || LEVEL.normal}
- '이미 나온 낱말'과 겹치면 안 됩니다.
- 다음 글자로 끝나는 낱말은 피하세요(학생이 이어가기 어렵습니다): ${deadEnd.join(' ')}
- say는 게임을 시작하며 건네는 존댓말 한 문장입니다. 낱말을 직접 말하지는 마세요.

## 출력 형식
{"say":"한 문장","candidates":[{"w":"낱말","m":"뜻"},{"w":"낱말","m":"뜻"},{"w":"낱말","m":"뜻"}]}${JSON_NOTE}`;
}

function hintPrompt({ allowed, used, level }) {
  var H = headsText(allowed);
  return `초등학생이 끝말잇기를 하다가 막혔습니다. 힌트를 세 단계로 만들어 주세요. JSON으로만 대답합니다.

## 이어갈 낱말이 시작해야 하는 글자
${H}

## 이미 나온 낱말
${used.length ? used.join(', ') : '없음'}

## 규칙
**${H}(으)로 시작하는 쉬운 낱말 후보 세 개를 고르세요. 다른 글자로 시작하면 안 됩니다.**
${WORD_RULES}
- 난이도: ${LEVEL[level] || LEVEL.normal}
- '이미 나온 낱말'은 안 됩니다.
- 후보마다 힌트를 세 단계로 붙이세요.
  · s1: 그 낱말이 무엇인지 알려 주는 수수께끼 한 문장. 낱말을 직접 말하지 마세요.
  · s2: 글자 수와 첫 글자를 알려 주는 문장.
  · s3: 정답을 알려 주는 문장. 낱말과 뜻을 함께 쓰세요.
- ${H}(으)로 시작하는 낱말이 국어사전에 정말 없으면 candidates를 빈 배열로 두세요.

## 출력 형식
{"candidates":[{"w":"낱말","p":"품사","m":"뜻","s1":"한 문장","s2":"한 문장","s3":"한 문장"},{"w":"낱말","p":"품사","m":"뜻","s1":"...","s2":"...","s3":"..."},{"w":"낱말","p":"품사","m":"뜻","s1":"...","s2":"...","s3":"..."}]}${JSON_NOTE}`;
}

// 뜻이 여러 개인 낱말은 그중 하나라도 이름씨이면 인정한다.

/* 반환: {status, pick}
     'ok'          — 검증을 통과한 낱말이 있다
     'rejected'    — 검증했더니 쓸 만한 낱말이 없다 → AI가 진 것
     'unavailable' — 검증 자체를 못 했다(한도 초과 등) → 걸러진 후보로 그냥 진행
   검증 실패를 '막힘'으로 처리하면 「학교」 다음 「교실」이 있는데도 막히는 일이 생긴다. */
// 검증에 보낼 후보를 먼저 기계적으로 걸러 낸다.
function shortlist(cands, allowed, usedSet) {
  const out = [];
  for (const c of cands || []) {
    const w = norm(c && c.w);
    if (w.length < 2 || w.length > 5) continue;
    if (allowed.length && allowed.indexOf(w.charAt(0)) === -1) continue;
    if (usedSet.has(w)) continue;
    if (!isNoun(c && c.p)) continue;
    if (w.length >= 3 && w.charAt(w.length - 1) === '다') continue;
    if (out.indexOf(w) === -1) out.push(w);
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 지원합니다.' });
  }
  if (!UPSTAGE_KEY) {
    return res.status(500).json({ error: '서버에 UPSTAGE_API_KEY가 설정되지 않았습니다.' });
  }
  if (Date.now() > FREE_UNTIL) {
    return res.status(503).json({ error: 'AI 이용 기간이 끝났어요. 선생님께 알려 주세요.' });
  }

  const deadline = Date.now() + 24000;

  try {
    const body = req.body || {};
    const mode = String(body.mode || 'turn');
    const level = ['easy', 'normal', 'hard'].indexOf(body.level) !== -1 ? body.level : 'normal';
    const used = clampArr(body.used, 40);
    const usedSet = new Set(used.map(norm));
    const allowed = clampArr(body.allowed, 6).map(norm).filter(Boolean);
    const deadEnd = clampArr(body.deadEnd, 40).filter(Boolean);

    if (mode === 'start') {
      const d = await askJson(startPrompt({ level, used, deadEnd }), 500, deadline);
      if (!d) throw new Error('AI 응답을 읽지 못했습니다.');
      // 첫 낱말도 사전에 있는지 확인하고 내보낸다.
      const list = shortlist(d.candidates, [], usedSet);
      const found = await Promise.all(list.map(lookup));
      const ok = [];
      for (let i = 0; i < list.length; i++) {
        if (found[i] && found[i].found && found[i].noun) ok.push({ w: list[i], m: found[i].def });
      }
      const pick = ok.find((c) => deadEnd.indexOf(c.w.charAt(c.w.length - 1)) === -1) || ok[0] ||
        (found.every((r) => r === null)
          ? pickCandidate(d.candidates, [], usedSet, deadEnd, true) ||
            pickCandidate(d.candidates, [], usedSet, deadEnd, false)
          : null);
      if (!pick) throw new Error('첫 낱말을 만들지 못했습니다.');
      return res.status(200).json({
        say: String(d.say || '').slice(0, 120),
        aiWord: pick.w,
        aiMeaning: pick.m
      });
    }

    if (mode === 'hint') {
      if (!allowed.length) return res.status(400).json({ error: '시작 글자가 없습니다.' });
      const d = await askJson(hintPrompt({ allowed, used, level }), 700, deadline, [0.6, 0.2]);
      if (!d) throw new Error('힌트를 만들지 못했습니다.');
      // 낱말 생성과 같은 잣대로 후보를 거른다.
      const cands = Array.isArray(d.candidates) ? d.candidates : [];
      const pick = pickCandidate(cands, allowed, usedSet, [], false);
      const src = pick ? cands.find((c) => norm(c && c.w) === pick.w) || {} : {};
      return res.status(200).json({
        word: pick ? pick.w : '',
        step1: String(src.s1 || '').slice(0, 120),
        step2: String(src.s2 || '').slice(0, 120),
        step3: String(src.s3 || ('「' + (pick ? pick.w : '') + '」예요. ' + (pick ? pick.m : ''))).slice(0, 160)
      });
    }

    // mode === 'turn'
    const word = norm(body.word).slice(0, 10);
    if (!word) return res.status(400).json({ error: '낱말이 비어 있습니다.' });
    if (!allowed.length) return res.status(400).json({ error: '시작 글자가 없습니다.' });

    // 방금 학생이 낸 낱말도 이미 나온 것으로 친다 — AI가 그대로 따라 내는 걸 막는다.
    usedSet.add(word);
    used.push(word);

    /* 1) 이어갈 낱말 후보를 만든다(다양해야 하니 온도를 높인다).
       2) 학생 낱말 판정과 후보 검증을 한 호출로 묶는다(일관돼야 하니 온도를 낮춘다).
       턴당 두 번만 부르므로 한 반이 같이 써도 한도에 덜 걸린다. */
    let limited = false;
    const gen = await askJson(genPrompt({ used, allowed, level, deadEnd }), 520, deadline, [0.9, 0.4])
      .catch((e) => {
        if (e instanceof RateLimited) limited = true;
        return null;
      });
    const list = gen ? shortlist(gen.candidates, allowed, usedSet) : [];

    // 학생 낱말과 AI 후보를 사전에서 한꺼번에 찾는다.
    const found = await Promise.all([lookup(word)].concat(list.map(lookup)));
    const me = found[0];
    const cand = found.slice(1);

    if (!gen && !me) {
      if (limited) throw new RateLimited('한도 초과');
      throw new Error('AI 응답을 읽지 못했습니다.');
    }

    // 학생 낱말 판정 — 사전이 정한다. 조회를 못 했으면 인정하는 쪽으로 간다.
    let valid = true;
    let pos = '';
    let say = '';
    if (me) {
      pos = me.pos;
      valid = me.found && me.noun;
      if (!me.found) {
        say = '「' + word + '」는 국어사전에서 찾을 수 없어요. 다른 낱말로 해 볼까요?';
      } else if (!me.noun) {
        say = '「' + word + '」는 ' + (me.pos || '이름을 나타내는 말이 아니라서') +
          '라서 끝말잇기에서는 쓸 수 없어요. 이름을 나타내는 낱말로 해 볼까요?';
      } else {
        say = '「' + word + '」, 좋아요. ' + (me.def || '');
      }
    }

    // AI 낱말도 사전에 있는 것만 고른다. 한방 낱말은 뒤로 미룬다.
    const okCands = [];
    for (let i = 0; i < list.length; i++) {
      if (cand[i] && cand[i].found && cand[i].noun) okCands.push({ w: list[i], m: cand[i].def });
    }
    let pick = okCands.find((c) => deadEnd.indexOf(c.w.charAt(c.w.length - 1)) === -1) ||
      okCands[0] || null;
    // 사전 조회를 아예 못 했으면(키 없음·장애) 예전 방식으로 넘어간다.
    if (!pick && list.length && cand.every((r) => r === null) && gen) {
      pick = pickCandidate(gen.candidates, allowed, usedSet, deadEnd, true) ||
             pickCandidate(gen.candidates, allowed, usedSet, deadEnd, false);
    }

    const out = {
      valid,
      pos,
      say,
      aiWord: pick ? pick.w : '',
      aiMeaning: pick ? pick.m : '',
      aiStuck: !pick || (gen && gen.stuck === true)
    };
    // 테스트에서 왜 막혔는지 보려고 쓴다. 화면에서는 쓰지 않는다.
    if (body.debug) {
      out._cands = (gen && gen.candidates) || null;
      out._list = list;
      out._dict = cand.map((r, i) => ({ w: list[i], r }));
      out._me = me;
    }
    return res.status(200).json(out);
  } catch (e) {
    if (e instanceof RateLimited) {
      return res.status(429).json({
        error: '친구들이 한꺼번에 많이 쓰고 있어요. 잠깐 뒤에 다시 해 볼까요?',
        rateLimited: true,
        detail: String(e.detail || '').slice(0, 200)
      });
    }
    return res.status(500).json({
      error: 'AI가 대답하지 못했어요. 잠시 뒤 다시 해 볼까요?',
      detail: String((e && e.detail) || (e && e.message) || e).slice(0, 300)
    });
  }
}
