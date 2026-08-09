# -*- coding: utf-8 -*-
"""끝 글자 점수표를 만든다 — data/heads.json

한글 음절마다 「이 글자로 시작하는 이름씨가 사전에 몇 개 있는가」를 세어 둔다.
숫자가 0이면 그 글자로 끝나는 낱말은 한방 낱말이다(아무도 이을 수 없다).

이 표 하나로 세 가지를 한다.
  · 보통 모드 — AI가 이어가기 쉬운 글자로 끝내게 한다
  · 지옥 모드 — AI가 이어가기 어려운 글자로 끝내게 한다
  · 즉사기 봉인 — 학생이 한방 낱말을 내는 것을 막는다

손으로 적은 목록은 틀린다. 실제로 「슴」을 이을 수 없다고 적었지만
슴새·슴베가 있었다. 그래서 사전에 직접 물어 만든다.

  python tools/build_heads.py            이어서 진행 (중간에 끊겨도 됨)
  python tools/build_heads.py --fresh    처음부터

한 번 돌리면 11,172번 조회한다. 하루 한도 5만 건 안이다.
"""

import argparse
import json
import pathlib
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from _keys import STDICT_KEY as KEY
BASE = "https://stdict.korean.go.kr/api/search.do"

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "heads.json"
CACHE = ROOT / "tools" / ".heads-cache.json"

ALL = [chr(c) for c in range(0xAC00, 0xD7A4)]   # 가 ~ 힣, 11,172자

lock = threading.Lock()
done = 0
fails = 0
cache = {}
todo = []
t0 = 0.0


def count(ch, tries=3):
    """그 글자로 시작하는 이름씨 수. 조회 실패는 None."""
    url = BASE + "?" + urllib.parse.urlencode({
        "key": KEY, "q": ch, "req_type": "json", "num": 10,
        "method": "start", "advanced": "y", "type1": "word", "pos": "1"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                body = r.read().decode("utf-8")
            if not body.strip():
                return 0                       # 빈 응답 = 그런 낱말 없음
            return int(json.loads(body).get("channel", {}).get("total", 0))
        except Exception:
            time.sleep(0.6 * (i + 1))
    return None


def work(ch):
    global done, fails
    n = count(ch)
    with lock:
        done += 1
        if n is None:
            fails += 1
        if n is not None:
            cache[ch] = n
        # 중간에 끊겨도 다시 이어갈 수 있게 자주 저장한다
        if done % 300 == 0:
            save(CACHE, cache)
            print(f"  {done}/{len(todo)}  실패 {fails}  {time.time() - t0:.0f}초", flush=True)
    return ch, n


def load(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    cache.update({} if args.fresh else load(CACHE))
    todo[:] = [c for c in ALL if c not in cache]
    print(f"조회할 글자 {len(todo)}자 (이미 받은 것 {len(cache)}자)", flush=True)

    globals()["t0"] = time.time()
    try:
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            list(ex.map(work, todo))
    except KeyboardInterrupt:
        print("\n멈춤 — 여기까지 저장합니다.")
    finally:
        save(CACHE, cache)

    # 0인 글자는 빼서 파일을 줄인다. 표에 없으면 0으로 본다.
    heads = {k: v for k, v in cache.items() if v > 0}
    save(OUT, heads)

    zero = sum(1 for v in cache.values() if v == 0)
    hard = sorted((v, k) for k, v in heads.items() if v < 20)
    print(f"\n{time.time() - t0:.0f}초, 조회 {len(cache)}자")
    print(f"  이을 수 없는 글자(0개) {zero}자")
    print(f"  이을 낱말이 20개 미만인 글자 {len(hard)}자")
    print(f"  → {OUT.relative_to(ROOT)} 에 {len(heads)}자 저장")
    if hard:
        print("\n가장 어려운 글자 30개:")
        print("  " + ", ".join(f"{k}({v})" for v, k in hard[:30]))
