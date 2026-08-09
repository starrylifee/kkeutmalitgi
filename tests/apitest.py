# -*- coding: utf-8 -*-
"""배포된 /api/word 를 100번 두드려 판정 정확도와 게임 안정성을 잰다.

  python tests/apitest.py                       기본 100회
  python tests/apitest.py --n 200               횟수 지정
  python tests/apitest.py --url http://localhost:3000/api/word

표준 라이브러리만 쓴다.
"""

import argparse
import json
import random
import statistics
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

DEFAULT_URL = "https://kkeutmalitgi.vercel.app/api/word"

# js/hangul.js 의 DEAD_END 와 같아야 한다.
DEAD_END = list(
    "늪릎슭윷옆팥흙솥짚빚숲칡녘샅뭍귤틈뺨픔흠릇즘츰늑뜸쁨읊깊넋삯섶앞엌옻윗헛"
    "름님슴밖밑곁겉낯셈늘랑끼을윽읍웅몫삶앎짬엿셋넷렁렬큼낌빔헐즈츠캅릭섯엽"
)

# ── 두음법칙 (js/hangul.js 와 같은 규칙) ─────────────────────────
IDX_N, IDX_R, IDX_O = 2, 5, 11
Y_R = {2, 6, 7, 12, 17, 20}   # ㅑㅕㅖㅛㅠㅣ
Y_N = {2, 6, 12, 17, 20}      # ㅑㅕㅛㅠㅣ


def decompose(ch):
    c = ord(ch) - 0xAC00
    if c < 0 or c > 11171:
        return None
    return c // 588, (c % 588) // 28, c % 28


def compose(cho, jung, jong):
    return chr(0xAC00 + cho * 588 + jung * 28 + jong)


def allowed_starts(ch, dueum=True):
    out = [ch]
    d = decompose(ch)
    if not d or not dueum:
        return out
    cho, jung, jong = d
    if jung in Y_R:
        if cho in (IDX_R, IDX_N, IDX_O):
            for c in (IDX_R, IDX_O) + ((IDX_N,) if jung in Y_N else ()):
                v = compose(c, jung, jong)
                if v not in out:
                    out.append(v)
    else:
        if cho in (IDX_R, IDX_N):
            for c in (IDX_R, IDX_N):
                v = compose(c, jung, jong)
                if v not in out:
                    out.append(v)
    return out


# ── 판정 테스트용 낱말 ───────────────────────────────────────────
REAL_WORDS = [
    "사과", "학교", "연필", "무지개", "호랑이", "운동장", "김치찌개", "도서관", "가락", "수리",
    "책상", "의자", "필통", "지우개", "칠판", "교실", "선생님", "친구", "가방", "우산",
    "바다", "산책", "나무", "구름", "바람", "햇빛", "강아지", "고양이", "토끼", "다람쥐",
    "라면", "김밥", "떡볶이", "수박", "포도", "딸기", "당근", "감자", "고구마", "옥수수",
    "자전거", "기차", "비행기", "지하철", "신호등", "횡단보도", "병원", "우체국", "시장", "공원",
]

FAKE_WORDS = [
    ("슈뷁", "없는말"), ("퀄뤄", "없는말"), ("븕턍", "없는말"), ("칰퍕", "없는말"),
    ("삼성", "고유명사"), ("서울", "고유명사"), ("부산", "고유명사"), ("카카오", "고유명사"),
    ("킹받네", "신조어"), ("갑분싸", "신조어"), ("별다줄", "신조어"),
    ("먹다", "동사"), ("빠르다", "형용사"), ("살짝", "부사"), ("성큼", "부사"),
]

# 게임 시늉용 학생 사전 (테스트 전용 — 앱은 사전을 쓰지 않는다)
STUDENT_DICT = """
가게 가락 가방 가슴 가위 가을 가지 간식 감자 강물 강아지 개구리 개미 거미 거울 건물 겨울 경찰
계단 계절 고구마 고기 고래 고양이 골목 공기 공원 공책 과자 과일 관심 광장 교실 교문 구두 구름
구슬 국수 국물 그늘 그릇 그림 극장 근처 글씨 기린 기차 기억 기와 김밥 김치 나라 나무 나비 나이
낚시 날개 남자 낮잠 냄비 노래 노을 논밭 놀이 누나 눈물 다리 다람쥐 단추 달력 담요 대문 대나무
도로 도서관 도시 도토리 독수리 돌멩이 동물 동생 두부 등대 딸기 라디오 라면 로봇 리본 마늘 마당
마루 마을 만두 말씀 매미 머리 먼지 메주 모래 모자 목장 무지개 문어 물감 물고기 미술 바구니 바나나
바다 바람 바위 박수 반지 발목 밥상 방석 배추 백조 버섯 버스 벌레 병아리 병원 보리 복숭아 부엌
북극 불빛 비누 비둘기 비행기 사과 사슴 사자 사탕 산책 상자 새벽 색종이 생선 서점 선물 선생님
설탕 소나무 손목 수박 수업 시간 시계 시장 신발 실내화 아기 아침 안개 야구 양말 어깨 얼음 엄마
여름 연필 열쇠 영화 오리 오이 옥수수 온도 요리 우물 우산 우유 운동장 원숭이 유리 은행 음악 의자
이불 인형 자동차 자전거 잠자리 장갑 장미 저녁 전화 젓가락 정원 조개 종이 주머니 주전자 지도
지붕 지우개 진달래 짜장면 참새 창문 책상 천둥 청소 초록 축구 치마 친구 칠판 칫솔 침대 카메라
코끼리 콩나물 크레파스 키위 타조 태양 텔레비전 토마토 토끼 통조림 튤립 파도 파리 팔찌 편지 포도
표범 풍선 피아노 하늘 하마 학교 한글 할머니 항구 해바라기 햄버거 향기 허리 헬리콥터 호랑이 호수
화분 화살 회의 훈장 휴지 흑판 희망
""".split()

STU_BY_HEAD = {}
for w in STUDENT_DICT:
    STU_BY_HEAD.setdefault(w[0], []).append(w)


def post(url, body, timeout=40):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8")), time.time() - t0
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8")), time.time() - t0
        except Exception:
            return {"error": f"HTTP {e.code}"}, time.time() - t0
    except Exception as e:
        return {"error": str(e)}, time.time() - t0


# ── 1단계: 판정 정확도 ───────────────────────────────────────────
def judge_case(url, word, expect, tag, level):
    heads = allowed_starts(word[-1], True)
    d, ms = post(url, {
        "mode": "turn", "word": word, "allowed": heads,
        "used": [], "level": level, "dueum": True, "deadEnd": DEAD_END,
    })
    if "error" in d:
        return {"kind": "judge", "word": word, "tag": tag, "ms": ms,
                "err": d["error"], "detail": d.get("detail", "")}
    ai = d.get("aiWord") or ""
    return {
        "kind": "judge", "word": word, "tag": tag, "ms": ms,
        "valid": d.get("valid"), "expect": expect, "pos": d.get("pos", ""),
        "judge_ok": d.get("valid") is expect,
        "ai": ai,
        "head_ok": (not ai) or (ai[0] in heads),
        "dead": bool(ai) and ai[-1] in DEAD_END,
        "stuck": bool(d.get("aiStuck")),
        "say": d.get("say", ""),
        "mean": d.get("aiMeaning", ""),
    }


# ── 2단계: 실제 게임 흐름 ────────────────────────────────────────
def play_game(url, turns, level, gi):
    out = []
    d, ms = post(url, {"mode": "start", "level": level, "used": [], "deadEnd": DEAD_END})
    if "error" in d or not d.get("aiWord"):
        out.append({"kind": "game", "g": gi, "t": 0, "ms": ms,
                    "err": d.get("error", "첫 낱말 없음"), "detail": d.get("detail", "")})
        return out
    out.append({"kind": "game", "g": gi, "t": 0, "ms": ms, "ai": d["aiWord"], "ok": True,
                "dead": d["aiWord"][-1] in DEAD_END})

    used = [d["aiWord"]]
    prev = d["aiWord"]
    for t in range(1, turns + 1):
        heads = allowed_starts(prev[-1], True)
        pool = [w for h in heads for w in STU_BY_HEAD.get(h, []) if w not in used]
        if pool:
            sw = random.choice(pool)
        else:
            # 사전에 없으면 힌트를 받아 이어간다 (실제 학생이 힌트를 쓰는 흐름과 같다)
            hd, hms = post(url, {"mode": "hint", "allowed": heads, "used": used, "level": level})
            sw = (hd or {}).get("word") or ""
            out.append({"kind": "game", "g": gi, "t": t, "ms": hms, "hint": sw or "실패", "ok": True})
            if not sw:
                out.append({"kind": "game", "g": gi, "t": t, "student_stuck": True,
                            "head": heads[0], "ms": 0})
                break
        d, ms = post(url, {
            "mode": "turn", "word": sw, "allowed": heads, "used": used,
            "level": level, "dueum": True, "deadEnd": DEAD_END,
        })
        if "error" in d:
            out.append({"kind": "game", "g": gi, "t": t, "ms": ms, "student": sw,
                        "err": d["error"], "detail": d.get("detail", "")})
            break
        ai = d.get("aiWord") or ""
        rec = {
            "kind": "game", "g": gi, "t": t, "ms": ms, "student": sw,
            "valid": d.get("valid"), "ai": ai,
            "head_ok": (not ai) or (ai[0] in heads),
            "dead": bool(ai) and ai[-1] in DEAD_END,
            "dup": ai in used,
            "stuck": bool(d.get("aiStuck")),
            "ok": True,
        }
        out.append(rec)
        used.append(sw)
        if not ai or rec["stuck"]:
            break
        used.append(ai)
        prev = ai
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--n", type=int, default=100, help="총 요청 횟수 목표")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--seed", type=int, default=20260809)
    args = ap.parse_args()
    random.seed(args.seed)

    n_judge = int(args.n * 0.6)
    n_game_req = args.n - n_judge
    turns = 10
    n_games = max(1, n_game_req // (turns + 1))

    cases = []
    reals = REAL_WORDS[:]
    random.shuffle(reals)
    fakes = FAKE_WORDS[:]
    random.shuffle(fakes)
    # 요청 수가 낱말 수보다 많으면 목록을 돌려 쓴다 (같은 낱말도 온도 때문에 결과가 달라진다)
    n_fake = max(6, n_judge // 4)
    for i in range(n_fake):
        w, tag = fakes[i % len(fakes)]
        cases.append((w, False, tag))
    for i in range(n_judge - n_fake):
        cases.append((reals[i % len(reals)], True, "실제낱말"))
    random.shuffle(cases)
    levels = ["easy", "normal", "hard"]

    print(f"대상: {args.url}")
    print(f"1단계 판정 {len(cases)}회, 2단계 게임 {n_games}판 x 최대 {turns}턴\n")

    results = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(judge_case, args.url, w, e, tag, levels[i % 3])
                for i, (w, e, tag) in enumerate(cases)]
        for i, f in enumerate(futs, 1):
            r = f.result()
            results.append(r)
            if r.get("err"):
                print(f"  [{i:3}] ! {r['word']:6} 오류 {r['err']}")
            else:
                mark = "O" if r["judge_ok"] else "X"
                flags = ("" if r["head_ok"] else " <첫글자틀림>") + (" <한방>" if r["dead"] else "")
                print(f"  [{i:3}] {mark} {r['word']:6} valid={str(r['valid']):5} "
                      f"pos={r['pos'] or '-':5} ({r['tag']})  AI={r['ai'] or '-':6}{flags}")
            sys.stdout.flush()

    print()
    with ThreadPoolExecutor(max_workers=min(args.workers, n_games)) as ex:
        futs = [ex.submit(play_game, args.url, turns, levels[g % 3], g) for g in range(n_games)]
        for f in futs:
            recs = f.result()
            results.extend(recs)
            g = recs[0]["g"]
            path = []
            for r in recs:
                if r.get("hint"):
                    path.append(f"[힌트:{r['hint']}]")
                if r.get("student"):
                    path.append(r["student"] + ("" if r.get("valid") else "(거부)"))
                if r.get("ai"):
                    path.append("*" + r["ai"] + ("!" if r.get("dead") else ""))
                if r.get("student_stuck"):
                    path.append(f"[학생막힘 {r['head']}]")
                if r.get("stuck"):
                    path.append("[AI막힘]")
                if r.get("err"):
                    path.append(f"[오류 {r['err']}]")
            print(f"  게임{g + 1}: " + " > ".join(path))
            sys.stdout.flush()

    elapsed = time.time() - t0

    # ── 집계 ─────────────────────────────────────────────────
    judges = [r for r in results if r["kind"] == "judge" and not r.get("err")]
    games = [r for r in results if r["kind"] == "game" and r.get("ok")]
    errs = [r for r in results if r.get("err")]
    lat = sorted(r["ms"] for r in results if r.get("ms"))

    print("\n" + "=" * 58)
    print(f"총 요청 {len(results)}회, {elapsed:.0f}초")
    if lat:
        print(f"응답시간  중앙 {statistics.median(lat):.2f}s   "
              f"p90 {lat[int(len(lat) * 0.9) - 1]:.2f}s   최대 {max(lat):.2f}s")
    print(f"오류      {len(errs)}건")
    if errs:
        det = {}
        for r in errs:
            key = (r.get("detail") or r.get("err") or "")[:110]
            det[key] = det.get(key, 0) + 1
        for k, v in sorted(det.items(), key=lambda x: -x[1]):
            print(f"   {v:3}회  {k}")

    if judges:
        ok = sum(1 for r in judges if r["judge_ok"])
        print(f"\n[판정] 전체 {ok}/{len(judges)} = {ok / len(judges) * 100:.0f}%")
        by_tag = {}
        for r in judges:
            by_tag.setdefault(r["tag"], []).append(r["judge_ok"])
        for tag, v in sorted(by_tag.items(), key=lambda x: -len(x[1])):
            print(f"   {tag:8} {sum(v)}/{len(v)}")
        wrong = [r for r in judges if not r["judge_ok"]]
        if wrong:
            print("   틀린 것:")
            for r in wrong[:15]:
                print(f"     {r['word']} -> valid={r['valid']} pos={r['pos']} "
                      f"(기대 {r['expect']}, {r['tag']})")

    pool = [r for r in judges + games if r.get("ai")]
    if pool:
        hok = sum(1 for r in pool if r.get("head_ok", True))
        dead = sum(1 for r in pool if r.get("dead"))
        print(f"\n[AI 낱말] {len(pool)}개 중 첫 글자 정확 {hok} ({hok / len(pool) * 100:.0f}%), "
              f"한방 낱말 {dead}개")
        for r in pool:
            if not r.get("head_ok", True):
                print(f"     첫글자틀림: {r.get('word') or r.get('student')} -> {r['ai']}")

    if games:
        stuck = sum(1 for r in games if r.get("stuck"))
        dup = sum(1 for r in games if r.get("dup"))
        rej = sum(1 for r in games if r.get("student") and r.get("valid") is False)
        tot = sum(1 for r in games if r.get("student"))
        sstuck = sum(1 for r in results if r.get("student_stuck"))
        hfail = sum(1 for r in results if r.get("hint") == "실패")
        print(f"\n[게임] 학생 낱말 {tot}턴, 거부 {rej}턴, AI 막힘 {stuck}회, "
              f"AI 중복 {dup}회, 학생 막힘 {sstuck}회, 힌트 실패 {hfail}회")
        if rej:
            print("   거부된 학생 낱말: " +
                  ", ".join(r["student"] for r in games
                            if r.get("student") and r.get("valid") is False))
    print("=" * 58)


if __name__ == "__main__":
    main()
