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
  // 옛말·방언·북한어 말고 요즘 쓰는 말을 먼저 고른다. 「을길간」 같은 옛말이 나오는 걸 막는다.
  const common = nouns.filter((i) => senseOf(i).type === '일반어');
  const best = common[0] || nouns[0] || items[0];
  const s = senseOf(best);
  return {
    found: true,
    noun: nouns.length > 0,
    common: common.length > 0,
    pos: String(best.pos || '').trim(),
    def: String(s.definition || '').split(/(?<=\.)\s/)[0].slice(0, 70)
  };
}

function senseOf(item) {
  const s = item && (Array.isArray(item.sense) ? item.sense[0] : item.sense);
  return s || {};
}

// 업스테이지 무료 기간: 2027-03-31 23:00 KST
const FREE_UNTIL = Date.parse('2027-03-31T14:00:00Z');

/* 난이도는 학년으로 나눈다. 사전에 있다고 해서 초1이 아는 말은 아니므로,
   그 학년 아이가 실제로 아는 낱말인지를 AI가 판단하게 한다. */
const LEVEL = {
  g1: '초등학교 1~2학년이 아는 아주 쉬운 낱말만. 두 글자 위주. 동물·과일·학용품·음식처럼 눈에 보이고 손에 잡히는 것.',
  g3: '초등학교 3~4학년이 아는 낱말. 두세 글자. 교과서와 생활에서 자주 보는 말.',
  g5: '초등학교 5~6학년이 아는 낱말. 네 글자까지. 교과서에 나오는 말이면 좋습니다.',
  adult: '중학생 이상도 겨루어 볼 만한 낱말. 네 글자까지. 어려운 말도 괜찮습니다.'
};
const LEVEL_NAME = { g1: '1~2학년', g3: '3~4학년', g5: '5~6학년', adult: '초6 이상' };
const LEVELS = Object.keys(LEVEL);

/* AI에게는 "초등학생이 아는 낱말 고르기"만 시킨다.
   실제로 있는 말인지, 품사가 무엇인지, 뜻이 무엇인지는 사전이 알려 주므로
   프롬프트에서 뺐다. 지어낸 낱말은 어차피 사전에서 걸린다. */
const WORD_RULES = `- 이름씨(명사)만. 「먹다」 「빠르다」 「살짝」처럼 움직임이나 모양을 나타내는 말은 안 됩니다.
- 사람·지역·상표 이름 같은 고유명사와 외래어는 쓰지 마세요.
- 두 글자에서 네 글자까지, 한글로만.`;

function headsText(allowed) {
  return allowed.map((c) => '「' + c + '」').join(' 또는 ');
}

/* 두음법칙으로 시작 글자가 여러 개일 때, 모델이 첫 글자 하나에만 매달리는 일이 있다.
   (「기린」 다음에 「린」만 붙들고 「인형」 「인사」를 떠올리지 못한다.) */
function headsHint(allowed) {
  if (allowed.length < 2) return '';
  return `\n- ${headsText(allowed)} 가운데 아무 글자로 시작해도 됩니다.` +
    ` 다섯 개를 한 글자에 몰지 말고 여러 글자에 나누어 고르세요.`;
}

/* 모델이 자주 헷갈리는 이웃 글자를 하나 만들어, 「이건 틀린 것」이라고 못박는다.
   「개」로 시작해야 하는데 「가」로 시작하는 낱말을 내놓는 일이 실제로 잦았다. */
function nearMiss(ch) {
  const c = ch.charCodeAt(0) - 0xac00;
  if (c < 0 || c > 11171) return '';
  const jung = ((c % 588) / 28) | 0;
  // ㅐ↔ㅏ, ㅔ↔ㅓ, ㅒ↔ㅑ, ㅖ↔ㅕ, ㅚ↔ㅗ, ㅟ↔ㅜ 처럼 소리가 비슷한 모음으로 바꾼다.
  const swap = { 0: 1, 1: 0, 2: 3, 3: 2, 4: 5, 5: 4, 6: 7, 7: 6, 8: 11, 11: 8, 13: 16, 16: 13 };
  const other = swap[jung];
  if (other === undefined) return '';   // 헷갈릴 만한 이웃 글자가 없으면 예를 들지 않는다
  return String.fromCharCode(0xac00 + ((c / 588) | 0) * 588 + other * 28 + (c % 28));
}

function missHint(head) {
  const m = nearMiss(head);
  return m ? `\n  「${head}」로 시작해야 하는데 「${m}」로 시작하면 틀린 것입니다.` : '';
}

function clampArr(a, n) {
  return Array.isArray(a) ? a.slice(-n).map((x) => String(x).slice(0, 12)) : [];
}

function norm(raw) {
  return String(raw == null ? '' : raw).normalize('NFC').replace(/[^가-힣]/g, '');
}

/* AI가 낸 낱말 가운데 사전에 물어볼 만한 것만 추린다.
   품사·존재 여부는 사전이 판단하므로 여기서는 모양만 본다. */
function shortlist(words, allowed, usedSet) {
  const out = [];
  for (const raw of Array.isArray(words) ? words : []) {
    const w = norm(raw);
    if (w.length < 2 || w.length > 5) continue;
    if (allowed.length && allowed.indexOf(w.charAt(0)) === -1) continue;
    if (usedSet.has(w)) continue;
    if (w.length >= 3 && w.charAt(w.length - 1) === '다') continue; // 「오르다」류 기본형
    if (out.indexOf(w) === -1) out.push(w);
  }
  return out.slice(0, 5);
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

/* AI가 맡는 일은 하나뿐이다 — 그 학년 아이가 아는 낱말 다섯 개 고르기.
   실재 여부·품사·뜻은 사전이 알려 주므로 프롬프트에서 뺐다. */
function genPrompt({ used, allowed, level, deadEnd }) {
  const H = headsText(allowed);
  return `초등학교 국어 시간에 학생과 끝말잇기를 하고 있습니다.
${H}(으)로 시작하는 낱말 다섯 개를 고르세요.

- 다섯 낱말의 **첫 글자가 모두 ${H}** 여야 합니다. 비슷한 다른 글자로 시작하면 안 됩니다.${missHint(allowed[0])}${headsHint(allowed)}
- ${LEVEL[level] || LEVEL.g3}
${WORD_RULES}
- 이미 나온 낱말은 빼세요: ${used.length ? used.join(', ') : '없음'}
- 이 글자로 끝나는 낱말은 학생이 이어가기 어려우니 피하세요: ${deadEnd.join('')}

{"w":["낱말","낱말","낱말","낱말","낱말"]}
위 형식의 JSON만 출력하세요. 다른 말은 쓰지 마세요.
내보내기 전에 다시 확인하세요 — 다섯 낱말이 모두 ${H}(으)로 시작합니까?`;
}

function startPrompt({ level, used, deadEnd }) {
  return `초등학교 국어 시간에 학생과 끝말잇기를 시작합니다.
첫 낱말로 쓸 만한 낱말 다섯 개를 고르세요.

- ${LEVEL[level] || LEVEL.g3}
${WORD_RULES}
- 이미 나온 낱말은 빼세요: ${used.length ? used.join(', ') : '없음'}
- 이 글자로 끝나는 낱말은 학생이 이어가기 어려우니 피하세요: ${deadEnd.join('')}

{"w":["낱말","낱말","낱말","낱말","낱말"]}
위 형식의 JSON만 출력하세요. 다른 말은 쓰지 마세요.`;
}

/* 힌트도 낱말 다섯 개를 받아 사전으로 거른 뒤, 통과한 낱말에 세 단계 힌트를 붙인다.
   힌트 낱말은 학생이 그대로 쓸 수 있어야 하므로 반드시 사전을 거쳐야 한다. */
function hintPrompt({ allowed, used, level }) {
  const H = headsText(allowed);
  return `초등학생이 끝말잇기를 하다가 막혔습니다.
${H}(으)로 시작하는 낱말 다섯 개를 고르고, 첫 낱말에 힌트를 세 단계로 붙이세요.

- 다섯 개 모두 ${H}(으)로 시작해야 합니다.
- ${LEVEL[level] || LEVEL.g3}
${WORD_RULES}
- 이미 나온 낱말은 빼세요: ${used.length ? used.join(', ') : '없음'}
- s1: 첫 낱말이 무엇인지 알려 주는 수수께끼 한 문장. 낱말을 직접 말하지 마세요.
- s2: 글자 수와 첫 글자를 알려 주는 문장.
- s3: 정답을 알려 주는 문장.

{"w":["낱말","낱말","낱말","낱말","낱말"],"s1":"한 문장","s2":"한 문장","s3":"한 문장"}
위 형식의 JSON만 출력하세요. 다른 말은 쓰지 마세요.`;
}

/* 사전 조회 결과에서 쓸 낱말을 고른다.
   요즘 쓰는 말(일반어)을 먼저 보고, 학생이 이어가기 어려운 한방 낱말은 뒤로 미룬다. */
function pickFrom(list, found, deadEnd) {
  const ok = [];
  for (let i = 0; i < list.length; i++) {
    const r = found[i];
    if (r && r.found && r.noun && r.common) ok.push({ w: list[i], m: r.def });
  }
  return ok.find((c) => deadEnd.indexOf(c.w.charAt(c.w.length - 1)) === -1) || ok[0] || null;
}

// 낱말 목록을 사전에서 찾아 하나 고른다.
async function choose(list, deadEnd) {
  if (!list.length) return null;
  return pickFrom(list, await Promise.all(list.map(lookup)), deadEnd);
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
    const level = LEVELS.indexOf(body.level) !== -1 ? body.level : 'g3';
    const used = clampArr(body.used, 40);
    const usedSet = new Set(used.map(norm));
    const allowed = clampArr(body.allowed, 6).map(norm).filter(Boolean);
    const deadEnd = clampArr(body.deadEnd, 40).filter(Boolean);

    if (mode === 'start') {
      const d = await askJson(startPrompt({ level, used, deadEnd }), 260, deadline);
      if (!d) throw new Error('AI 응답을 읽지 못했습니다.');
      const list = shortlist(d.w, [], usedSet);
      const pick = await choose(list, deadEnd);
      if (!pick) throw new Error('첫 낱말을 만들지 못했습니다.');
      return res.status(200).json({ aiWord: pick.w, aiMeaning: pick.m });
    }

    if (mode === 'hint') {
      if (!allowed.length) return res.status(400).json({ error: '시작 글자가 없습니다.' });
      const d = await askJson(hintPrompt({ allowed, used, level }), 420, deadline, [0.6, 0.2]);
      if (!d) throw new Error('힌트를 만들지 못했습니다.');
      const list = shortlist(d.w, allowed, usedSet);
      const pick = await choose(list, []);
      const first = list.length ? norm(list[0]) : '';
      // 힌트 문장은 첫 낱말에 맞춰 만들어졌으니, 다른 낱말이 뽑히면 문장을 다시 짓는다.
      const same = pick && pick.w === first;
      return res.status(200).json({
        word: pick ? pick.w : '',
        step1: same ? String(d.s1 || '').slice(0, 120)
          : (pick ? pick.m.slice(0, 100) : ''),
        step2: same ? String(d.s2 || '').slice(0, 120)
          : (pick ? pick.w.length + '글자이고 「' + pick.w.charAt(0) + '」로 시작해요.' : ''),
        step3: pick ? '「' + pick.w + '」예요. ' + pick.m : ''
      });
    }

    // mode === 'turn'
    const word = norm(body.word).slice(0, 10);
    if (!word) return res.status(400).json({ error: '낱말이 비어 있습니다.' });
    if (!allowed.length) return res.status(400).json({ error: '시작 글자가 없습니다.' });

    // 방금 학생이 낸 낱말도 이미 나온 것으로 친다 — AI가 그대로 따라 내는 걸 막는다.
    usedSet.add(word);
    used.push(word);

    /* AI에게는 그 학년 아이가 아는 낱말 다섯 개를 고르는 일만 시킨다.
       실재 여부·품사·뜻은 사전이 알려 주므로 프롬프트에서 뺐고, 그만큼 짧고 빠르다. */
    let limited = false;
    const gen = await askJson(genPrompt({ used, allowed, level, deadEnd }), 260, deadline, [0.9, 0.4])
      .catch((e) => {
        if (e instanceof RateLimited) limited = true;
        return null;
      });
    let list = gen ? shortlist(gen.w, allowed, usedSet) : [];

    /* 다섯 개가 전부 엉뚱한 글자로 시작하는 일이 가끔 있다(「개」를 「가」로 읽는다).
       그럴 때만 온도를 낮춰 한 번 더 묻는다. 이게 없으면 AI가 헛되이 진다. */
    if (gen && !list.length && Date.now() < deadline - 9000) {
      const again = await askJson(genPrompt({ used, allowed, level, deadEnd }), 260, deadline, [0.25, 0.1])
        .catch(() => null);
      if (again) list = shortlist(again.w, allowed, usedSet);
    }

    // 학생 낱말과 AI 후보를 사전에서 한꺼번에 찾는다.
    const found = await Promise.all([lookup(word)].concat(list.map(lookup)));
    const me = found[0];
    const cand = found.slice(1);

    // AI 호출이 실패한 것은 "졌다"가 아니다. 잠시 뒤 다시 하도록 알린다.
    if (!gen) {
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

    /* AI 낱말은 사전에 있고 요즘 쓰는 말이어야 통과한다.
       사전에 있어도 그 학년이 모를 말이면 AI가 지는 쪽이 낫다. 승패가 없는 놀이라
       AI가 지는 순간이 오히려 아이들에게 즐겁고, 난이도 설정과도 맞아떨어진다. */
    const pick = pickFrom(list, cand, deadEnd);

    const out = {
      valid,
      pos,
      say,
      aiWord: pick ? pick.w : '',
      aiMeaning: pick ? pick.m : '',
      aiStuck: !pick,
      level: LEVEL_NAME[level] || ''
    };
    // 테스트에서 왜 막혔는지 보려고 쓴다. 화면에서는 쓰지 않는다.
    if (body.debug) {
      out._cands = (gen && gen.w) || null;
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
