# -*- coding: utf-8 -*-
"""초당 몇 번까지 견디는지 잰다 — 한 반이 동시에 쓸 수 있는지 알아보려는 것.

  python tests/ratetest.py
  python tests/ratetest.py --rates 1 2 4 8 --secs 20

한 턴(mode=turn)은 Solar를 두 번 부르므로, 여기서 재는 '초당 요청'은
학생이 낱말을 내는 횟수 기준이다.
"""

import argparse
import json
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

DEFAULT_URL = "https://kkeutmalitgi.vercel.app/api/word"
DEAD_END = list("늪릎슭윷옆팥흙솥짚빚숲칡녘샅뭍귤틈뺨픔흠릇즘츰늑뜸쁨읊깊넋삯섶앞엌옻윗헛")
WORDS = ["사과", "학교", "연필", "무지개", "호랑이", "운동장", "도서관", "책상", "의자", "가방"]
HEADS = {"사과": "과", "학교": "교", "연필": "필", "무지개": "개", "호랑이": "이",
         "운동장": "장", "도서관": "관", "책상": "상", "의자": "자", "가방": "방"}


def one(url, word, out, lock):
    body = {"mode": "turn", "word": word, "allowed": [HEADS[word]], "used": [],
            "level": "normal", "dueum": True, "deadEnd": DEAD_END}
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"})
    t0 = time.time()
    kind, d = "ok", {}
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            d = json.loads(e.read().decode("utf-8"))
        except Exception:
            d = {"error": f"HTTP {e.code}"}
    except Exception as e:
        d = {"error": str(e)}
    ms = time.time() - t0

    if d.get("error"):
        detail = str(d.get("detail", "")) + str(d.get("error", ""))
        kind = "한도초과" if ("request limit" in detail or "429" in detail) else "실패"
    elif not d.get("aiWord"):
        kind = "낱말없음"
    with lock:
        out.append((kind, ms))


def phase(url, rate, secs):
    out, lock, threads = [], threading.Lock(), []
    total = rate * secs
    gap = 1.0 / rate
    t0 = time.time()
    for i in range(total):
        target = t0 + i * gap
        now = time.time()
        if target > now:
            time.sleep(target - now)
        t = threading.Thread(target=one, args=(url, WORDS[i % len(WORDS)], out, lock))
        t.start()
        threads.append(t)
    for t in threads:
        t.join()
    return out, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--rates", type=float, nargs="+", default=[1, 2, 3, 5])
    ap.add_argument("--secs", type=int, default=20)
    ap.add_argument("--cooldown", type=int, default=30)
    args = ap.parse_args()

    print(f"대상: {args.url}")
    print(f"단계마다 {args.secs}초 동안 일정한 속도로 보내고, 사이에 {args.cooldown}초 쉰다.\n")
    print(f"{'초당요청':>7} {'보냄':>5} {'성공':>5} {'한도초과':>7} {'실패':>5} "
          f"{'중앙(s)':>8} {'최대(s)':>8}")
    print("-" * 52)

    for i, rate in enumerate(args.rates):
        if i:
            time.sleep(args.cooldown)
        out, elapsed = phase(args.url, int(rate), args.secs)
        c = Counter(k for k, _ in out)
        lat = sorted(m for _, m in out)
        mid = lat[len(lat) // 2] if lat else 0
        print(f"{rate:>7.0f} {len(out):>5} {c['ok']:>5} {c['한도초과']:>7} "
              f"{c['실패'] + c['낱말없음']:>5} {mid:>8.2f} {(max(lat) if lat else 0):>8.2f}")
        if c["한도초과"] > len(out) * 0.2:
            print("   → 여기서부터 한도에 걸린다. 더 올리지 않는다.")
            break

    print("\n한 턴은 Solar를 두 번 부른다. 학생 25명이 30초에 한 번씩 낱말을 내면")
    print("초당 약 0.8회이므로, 위 표에서 1~2회 구간이 견디면 한 반은 무리가 없다.")


if __name__ == "__main__":
    main()
