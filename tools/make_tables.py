# -*- coding: utf-8 -*-
"""서버가 쓸 표를 만든다 — api/_tables.js

data/heads.json 은 16KB짜리 자료 파일이라 그대로 두고,
서버리스 함수가 곧바로 불러 쓸 수 있게 자바스크립트 모듈로 옮겨 적는다.
(Vercel 함수에서 JSON 불러오기는 설정을 타서, JS 모듈이 확실하다.)

  python tools/make_tables.py

data/heads.json 과 data/killers.json 이 먼저 있어야 한다.
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
HEADS = ROOT / "data" / "heads.json"
KILLERS = ROOT / "data" / "killers.json"
OUT = ROOT / "api" / "_tables.js"

RAW = ROOT / "tools" / ".danger-cache.json"

heads = json.loads(HEADS.read_text(encoding="utf-8"))
kdata = json.loads(KILLERS.read_text(encoding="utf-8"))
killers = sorted({w for k, v in kdata.items() if isinstance(v, list) for w in v})

# 초지옥용 무기고 — 사전에서 뽑은 한방 낱말 전부를 첫 글자로 묶는다.
# 아이가 모르는 낱말이어도 상관없다. AI가 쓰는 무기이지 학생이 쓸 것이 아니다.
arsenal = {}
if RAW.exists():
    for tail, words in json.loads(RAW.read_text(encoding="utf-8")).items():
        for w in words:
            if 2 <= len(w) <= 5:
                arsenal.setdefault(w[0], []).append(w)
    # 글자마다 짧은 것부터 여덟 개까지만 — 짧은 낱말이 더 그럴듯하다
    arsenal = {k: sorted(set(v), key=lambda x: (len(x), x))[:8] for k, v in sorted(arsenal.items())}

# 글자 수를 줄이려고 구간별로 묶는다 — 게임에는 대략의 난이도만 있으면 된다.
# 표에 없는 글자는 0개(아무도 못 이음)로 본다.
body = json.dumps(heads, ensure_ascii=False, separators=(",", ":"))

OUT.write_text(f"""// 이 파일은 tools/make_tables.py 가 만든다. 직접 고치지 말 것.
//
// HEADS  글자 → 그 글자로 시작하는 이름씨가 사전에 몇 개 있는가.
//        표에 없으면 0개 = 그 글자로 끝나면 아무도 이을 수 없다.
//        국립국어원 표준국어대사전을 한글 음절 11,172자 전수 조회해 만들었다.
//
// KILLERS 초등학교 6학년이 알 만한 한방 낱말. 지옥 모드에서 두 가지로 쓴다.
//        · AI가 7턴부터 꺼내는 무기
//        · AI가 이 낱말들의 첫 글자로 끝내지 않게 하는 금지 목록
//          (「기」로 끝내면 학생이 「기쁨」을 꽂을 수 있다)

// ARSENAL 초지옥 전용 무기고. 첫 글자 → 그 글자로 시작하는 한방 낱말들.
//        아이가 모르는 낱말이어도 괜찮다. AI가 쓰는 무기이지 학생이 쓸 것이 아니다.

export const HEADS = {body};

export const KILLERS = {json.dumps(killers, ensure_ascii=False)};

export const ARSENAL = {json.dumps(arsenal, ensure_ascii=False, separators=(",", ":"))};
""", encoding="utf-8")

n_arse = sum(len(v) for v in arsenal.values())
print(f"api/_tables.js 생성")
print(f"  글자 {len(heads)}자")
print(f"  지옥 무기 {len(killers)}개 (아이가 아는 한방 낱말, 방어에도 씀)")
print(f"  초지옥 무기 {n_arse}개 / 시작 글자 {len(arsenal)}자")
print(f"  크기 {OUT.stat().st_size / 1024:.0f}KB")
