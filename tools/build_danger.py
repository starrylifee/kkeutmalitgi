# -*- coding: utf-8 -*-
"""초지옥 무기고의 재료를 모은다 — tools/.danger-cache.json

「AI가 이 글자로 끝내면, 학생이 즉사기를 꽂을 수 있는가」를 미리 계산해 둔다.

  AI가 「기」로 끝내면 → 학생이 「기쁨」을 낸다 → 「쁨」으로 시작하는 낱말이 없다 → AI 패배
  그래서 지옥 모드의 AI는 「기」로 끝내면 안 된다.

만드는 법
  1) data/heads.json 에서 이을 수 없는 글자(즉사 글자)를 추린다. 예: 쁨 름 슭 읒 륨
  2) 사전에 「그 글자로 끝나는 낱말」을 물어본다. 예: 쁨 → 기쁨, 미쁨
  3) 모은 낱말들은 tools/make_tables.py 가 api/_tables.js 의 ARSENAL 로 옮긴다.

  python tools/build_danger.py

heads.json 이 먼저 있어야 한다 (tools/build_heads.py).
"""

import argparse
import json
import pathlib
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from _keys import STDICT_KEY as KEY
BASE = "https://stdict.korean.go.kr/api/search.do"

ROOT = pathlib.Path(__file__).resolve().parent.parent
HEADS = ROOT / "data" / "heads.json"
CACHE = ROOT / "tools" / ".danger-cache.json"

lock = threading.Lock()
done = 0
cache = {}
todo = []
t0 = 0.0


def load(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


def words_ending_with(ch, tries=3):
    """그 글자로 끝나는 이름씨들. 실패는 None."""
    url = BASE + "?" + urllib.parse.urlencode({
        "key": KEY, "q": ch, "req_type": "json", "num": 100,
        "method": "end", "advanced": "y", "type1": "word", "pos": "1"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=25) as r:
                body = r.read().decode("utf-8")
            if not body.strip():
                return []
            d = json.loads(body)
            items = d.get("channel", {}).get("item", [])
            items = [items] if isinstance(items, dict) else items
            out = []
            for it in items:
                s = it.get("sense")
                s = s[0] if isinstance(s, list) else s
                if (s or {}).get("type") != "일반어":
                    continue            # 옛말·방언은 학생이 쓸 일이 없다
                w = str(it.get("word", "")).replace("-", "").replace("^", "")
                if 2 <= len(w) <= 5 and w.endswith(ch) and all("가" <= c <= "힣" for c in w):
                    out.append(w)
            return out
        except Exception:
            time.sleep(0.6 * (i + 1))
    return None


def work(ch):
    global done
    ws = words_ending_with(ch)
    with lock:
        done += 1
        if ws is not None:
            cache[ch] = ws
        if done % 300 == 0:
            save(CACHE, cache)
            print(f"  {done}/{len(todo)}  {time.time() - t0:.0f}초", flush=True)
    return ch


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--limit", type=int, default=4,
                    help="이 수보다 적게 이어지는 글자를 즉사 글자로 본다")
    args = ap.parse_args()

    heads = load(HEADS)
    if not heads:
        raise SystemExit("data/heads.json 이 없습니다. 먼저 tools/build_heads.py 를 돌리세요.")

    # 이을 낱말이 거의 없는 글자 = 즉사 글자
    ALL = [chr(c) for c in range(0xAC00, 0xD7A4)]
    lethal = [c for c in ALL if heads.get(c, 0) < args.limit]
    print(f"즉사 글자 후보 {len(lethal)}자 (이을 낱말 {args.limit}개 미만)")

    cache.update(load(CACHE))
    todo[:] = [c for c in lethal if c not in cache]
    print(f"조회할 글자 {len(todo)}자 (이미 받은 것 {len(cache)}자)", flush=True)

    globals()["t0"] = time.time()
    try:
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            list(ex.map(work, todo))
    except KeyboardInterrupt:
        print("\n멈춤 — 여기까지 저장합니다.")
    finally:
        save(CACHE, cache)

    # 첫 글자별로 모은다: 이 글자로 끝내면 학생이 아래 낱말들을 꽂을 수 있다
    danger = {}
    total = 0
    for tail, words in cache.items():
        for w in words:
            total += 1
            danger.setdefault(w[0], []).append(w)

    # 파일을 줄인다 — 글자마다 보기 낱말 세 개까지
    slim = {k: sorted(set(v))[:3] for k, v in sorted(danger.items())}
    save(OUT, slim)

    print(f"\n{time.time() - t0:.0f}초")
    print(f"  즉사기 낱말 {total}개")
    print(f"  AI가 끝내면 안 되는 글자 {len(slim)}자")
    print(f"  → {OUT.relative_to(ROOT)} 저장")
    sample = sorted(slim.items(), key=lambda kv: -len(danger[kv[0]]))[:15]
    print("\n가장 위험한 글자:")
    for k, v in sample:
        print(f"  {k} — {len(danger[k])}개 ({', '.join(v)})")
