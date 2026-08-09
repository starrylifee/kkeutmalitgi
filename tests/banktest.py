# -*- coding: utf-8 -*-
"""문제은행 — 실제로 문제가 났던 상황만 모아 케이스마다 여러 번 돌린다.

AI 응답은 매번 조금씩 달라서 한 번 돌려서는 흔들림이 안 잡힌다.
그래서 같은 케이스를 N번 반복하고 통과율로 본다.

  python tests/banktest.py                    케이스마다 5회
  python tests/banktest.py --runs 10          케이스마다 10회
  python tests/banktest.py --only stuck       한 종류만
  python tests/banktest.py --level g1         학년 바꿔서
"""

import argparse
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

DEFAULT_URL = "https://kkeutmalitgi.vercel.app/api/word"
HERE = pathlib.Path(__file__).parent

# js/hangul.js 의 DEAD_END 와 같아야 한다.
DEAD_END = list(
    "늪릎슭윷옆팥흙솥짚빚숲칡녘샅뭍귤틈뺨픔흠릇즘츰늑뜸쁨읊깊넋삯섶앞엌옻윗헛"
    "름님슴밖밑곁겉낯셈늘랑끼을윽읍웅몫삶앎짬엿셋넷렁렬큼낌빔헐즈츠캅릭섯엽"
)


def post(url, body, timeout=60):
    req = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
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


def run_once(url, case, level):
    heads = case.get("heads") or [case["word"][-1]]
    d, ms = post(url, {
        "mode": "turn", "word": case["word"], "allowed": heads, "used": [],
        "level": level, "dueum": True, "deadEnd": DEAD_END,
    })
    if d.get("error"):
        return "오류", d.get("error", "")[:40], ms

    kind = case["kind"]
    ai = d.get("aiWord") or ""
    stuck = bool(d.get("aiStuck")) or not ai

    if kind == "continue":
        if stuck:
            return "실패", "막힘", ms
        if ai[0] not in heads:
            return "실패", f"첫글자틀림({ai})", ms
        return "통과", ai, ms

    if kind == "stuck":
        return ("통과", "막힘", ms) if stuck else ("실패", f"지어냄?({ai})", ms)

    got = d.get("valid")
    if got is case["valid"]:
        return "통과", f"valid={got}", ms
    return "실패", f"valid={got} pos={d.get('pos') or '-'}", ms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--runs", type=int, default=5, help="케이스마다 반복 횟수")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--only", choices=["continue", "stuck", "judge"])
    ap.add_argument("--level", default="g3", choices=["g1", "g3", "g5", "adult"])
    ap.add_argument("--pass-rate", type=float, default=0.8, help="이 비율 미만이면 문제로 본다")
    args = ap.parse_args()

    data = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    cases = [c for c in data["cases"] if not args.only or c["kind"] == args.only]

    label = {"continue": "이어가야 함", "stuck": "막혀야 함", "judge": "판정"}
    print(f"대상: {args.url}  (난이도 {args.level})")
    print(f"케이스 {len(cases)}개 x {args.runs}회 = {len(cases) * args.runs}회 호출\n")

    jobs = [(c, i) for c in cases for i in range(args.runs)]
    results = {}
    lat = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for (c, _), out in zip(jobs, ex.map(lambda j: run_once(args.url, j[0], args.level), jobs)):
            status, detail, ms = out
            results.setdefault(id(c), []).append((status, detail))
            lat.append(ms)

    bad = []
    for kind in ["continue", "stuck", "judge"]:
        group = [c for c in cases if c["kind"] == kind]
        if not group:
            continue
        print(f"── {label[kind]} " + "─" * 40)
        for c in group:
            rs = results[id(c)]
            ok = sum(1 for s, _ in rs if s == "통과")
            rate = ok / len(rs)
            # soft 케이스는 흔들려도 게임이 이어지므로 알려만 주고 실패로 세지 않는다.
            failed = rate < args.pass_rate and not c.get("soft")
            mark = "!! " if failed else ("~  " if c.get("soft") else "OK ")
            seen = Counter(d for s, d in rs if s != "통과")
            extra = ("  " + ", ".join(f"{d}x{n}" for d, n in seen.most_common(3))) if seen else ""
            print(f"  {mark}{c['word']:6} {ok}/{len(rs)}{extra}")
            if failed:
                bad.append((c, ok, len(rs), seen))
        print()

    total = sum(len(v) for v in results.values())
    allok = sum(1 for v in results.values() for s, _ in v if s == "통과")
    lat.sort()
    print("=" * 52)
    print(f"전체 {allok}/{total} = {allok / total * 100:.0f}%   {time.time() - t0:.0f}초")
    print(f"응답시간 중앙 {lat[len(lat) // 2]:.2f}s  p90 {lat[int(len(lat) * .9) - 1]:.2f}s")
    if bad:
        print(f"\n통과율 {args.pass_rate * 100:.0f}% 미만 — 손봐야 할 케이스 {len(bad)}개")
        for c, ok, n, seen in bad:
            print(f"  {c['word']:6} ({label[c['kind']]}) {ok}/{n} — {c['note']}")
    else:
        print("\n모든 케이스가 기준을 넘었습니다.")
    print("=" * 52)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
