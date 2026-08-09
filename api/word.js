// 끝말잇기 — Solar Pro 3 프록시.
// 클라이언트는 시작 글자/글자 수/중복을 이미 검사해서 보낸다.
// 여기서는 (1) 학생 낱말이 실재하는 말인지 판정하고 (2) AI가 이을 낱말을 만든다.
// AI가 낸 후보는 서버에서 규칙으로 한 번 더 걸러서 환각을 막는다.

export const config = { maxDuration: 30 };

const UPSTAGE_KEY = process.env.UPSTAGE_API_KEY;
const ENDPOINT = 'https://api.upstage.ai/v1/chat/completions';
const MODEL = 'solar-pro3';

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

// AI 후보 재검증 — 시작 글자·길이·중복·뜻풀이 유무를 서버가 직접 확인한다.
function pickCandidate(cands, allowed, usedSet, deadEnd, avoidDeadEnd) {
  if (!Array.isArray(cands)) return null;
  for (const c of cands) {
    const w = norm(c && c.w);
    const m = String((c && c.m) || '').trim();
    if (w.length < 2 || w.length > 5) continue;
    if (allowed.length && allowed.indexOf(w.charAt(0)) === -1) continue;
    if (usedSet.has(w)) continue;
    if (!m) continue; // 뜻을 못 쓴 낱말은 지어낸 말로 본다
    if (avoidDeadEnd && deadEnd.indexOf(w.charAt(w.length - 1)) !== -1) continue;
    return { w, m: m.slice(0, 60) };
  }
  return null;
}

async function askSolar(prompt, maxTokens, temperature, signal) {
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
    }),
    signal
  });
  if (!r.ok) {
    const t = await r.text();
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
async function askJson(prompt, maxTokens, deadline) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && Date.now() > deadline - 7000) break; // 남은 시간이 없으면 포기
    const raw = await askSolar(prompt, maxTokens, attempt === 0 ? 0.8 : 0.2);
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

function turnPrompt({ word, used, allowed, level, deadEnd }) {
  var H = headsText(allowed);
  return `당신은 초등학교 국어 시간에 학생과 끝말잇기를 하는 선생님입니다. JSON으로만 대답합니다.

## 학생이 낸 낱말
${word}

## 이미 나온 낱말
${used.length ? used.join(', ') : '없음'}

## 할 일 1 — 학생 낱말 판정 (valid, say)
- 국립국어원 표준국어대사전에 표제어로 실려 있는 보통명사이면 valid는 true입니다.
- 회사 이름, 지역 이름, 사람 이름 같은 고유명사와 줄임말, 신조어, 비속어는 valid를 false로 하세요.
- 조금이라도 자신이 없으면 false로 하세요. 모르는 낱말을 있다고 하지 마세요.
- say는 학생에게 건네는 존댓말 한 문장입니다. 인정하면 그 낱말의 뜻을 짧고 쉽게 알려 주고,
  인정하지 않으면 왜 안 되는지 부드럽게 설명하세요. 혼내지 마세요.

## 할 일 2 — 당신이 이어갈 낱말 세 개 만들기 (candidates)
**첫 글자 규칙: 세 낱말 모두 ${H}(으)로 시작해야 합니다. 다른 글자로 시작하면 안 됩니다.**
- 학생 낱말을 인정하지 않았더라도 세 개를 반드시 만드세요.
${WORD_RULES}
- 난이도: ${LEVEL[level] || LEVEL.normal}
- '이미 나온 낱말'과 겹치면 안 됩니다.
- 다음 글자로 끝나는 낱말은 피하세요(학생이 이어가기 어렵습니다): ${deadEnd.join(' ')}
- ${H}(으)로 시작하는 낱말이 정말 하나도 없으면 candidates를 빈 배열로 두고 stuck을 true로 하세요.

## 출력 형식
{"valid":true 또는 false,"say":"한 문장","candidates":[{"w":"낱말","m":"뜻"},{"w":"낱말","m":"뜻"},{"w":"낱말","m":"뜻"}],"stuck":false}${JSON_NOTE}

다시 확인하세요: candidates의 세 낱말은 모두 ${H}(으)로 시작하는 이름씨여야 합니다.`;
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
- ${H}(으)로 시작하는 쉬운 낱말을 하나 고르세요(word). '이미 나온 낱말'은 안 됩니다.
${WORD_RULES}
- 난이도: ${LEVEL[level] || LEVEL.normal}
- step1: 그 낱말이 무엇인지 알려 주는 수수께끼 한 문장. 낱말을 직접 말하지 마세요.
- step2: 글자 수와 첫 글자를 알려 주는 문장.
- step3: 정답을 알려 주는 문장. 낱말과 뜻을 함께 쓰세요.

## 출력 형식
{"word":"낱말","step1":"한 문장","step2":"한 문장","step3":"한 문장"}${JSON_NOTE}`;
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
      const pick =
        pickCandidate(d.candidates, [], usedSet, deadEnd, true) ||
        pickCandidate(d.candidates, [], usedSet, deadEnd, false);
      if (!pick) throw new Error('첫 낱말을 만들지 못했습니다.');
      return res.status(200).json({
        say: String(d.say || '').slice(0, 120),
        aiWord: pick.w,
        aiMeaning: pick.m
      });
    }

    if (mode === 'hint') {
      if (!allowed.length) return res.status(400).json({ error: '시작 글자가 없습니다.' });
      const d = await askJson(hintPrompt({ allowed, used, level }), 450, deadline);
      if (!d) throw new Error('힌트를 만들지 못했습니다.');
      const w = norm(d.word);
      const okWord = w.length >= 2 && w.length <= 5 && allowed.indexOf(w.charAt(0)) !== -1 && !usedSet.has(w);
      return res.status(200).json({
        word: okWord ? w : '',
        step1: String(d.step1 || '').slice(0, 120),
        step2: String(d.step2 || '').slice(0, 120),
        step3: String(d.step3 || '').slice(0, 160)
      });
    }

    // mode === 'turn'
    const word = norm(body.word).slice(0, 10);
    if (!word) return res.status(400).json({ error: '낱말이 비어 있습니다.' });
    if (!allowed.length) return res.status(400).json({ error: '시작 글자가 없습니다.' });

    const d = await askJson(turnPrompt({ word, used, allowed, level, deadEnd }), 700, deadline);
    if (!d) throw new Error('AI 응답을 읽지 못했습니다.');

    const valid = d.valid !== false;
    // 한방 낱말을 피하는 조건은 후보가 다 걸리면 풀어 준다 — 이어가는 게 우선이다.
    const pick =
      pickCandidate(d.candidates, allowed, usedSet, deadEnd, true) ||
      pickCandidate(d.candidates, allowed, usedSet, deadEnd, false);

    return res.status(200).json({
      valid,
      say: String(d.say || '').slice(0, 160),
      aiWord: pick ? pick.w : '',
      aiMeaning: pick ? pick.m : '',
      aiStuck: !pick || d.stuck === true
    });
  } catch (e) {
    return res.status(500).json({
      error: 'AI가 대답하지 못했어요. 잠시 뒤 다시 해 볼까요?',
      detail: String((e && e.detail) || (e && e.message) || e).slice(0, 300)
    });
  }
}
