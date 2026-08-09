# -*- coding: utf-8 -*-
"""지옥 모드가 제대로 조여가는지, 학생이 한방을 꽂을 틈을 주지 않는지 본다.

  python tests/helltest.py --url http://localhost:3210/api/word
  python tests/helltest.py --games 5

학생 노릇은 사전에서 아무 낱말이나 골라 하는 것으로 대신한다.
"""

import argparse
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "tools"))
from _keys import STDICT_KEY
ROOT = pathlib.Path(__file__).resolve().parent.parent
HEADS = json.loads((ROOT / "data" / "heads.json").read_text(encoding="utf-8"))
KDATA = json.loads((ROOT / "data" / "killers.json").read_text(encoding="utf-8"))
KILLERS = sorted({w for k, v in KDATA.items() if isinstance(v, list) for w in v})

IDX_N, IDX_R, IDX_O = 2, 5, 11
Y_R = {2, 6, 7, 12, 17, 20}
Y_N = {2, 6, 12, 17, 20}


def variants(ch, dueum=True):
    out = [ch]
    c = ord(ch) - 0xAC00
    if c < 0 or c > 11171 or not dueum:
        return out
    cho, jung, jong = c // 588, (c % 588) // 28, c % 28

    def add(x):
        v = chr(0xAC00 + x * 588 + jung * 28 + jong)
        if v not in out:
            out.append(v)
    if jung in Y_R:
        if cho in (IDX_R, IDX_N, IDX_O):
            add(IDX_R); add(IDX_O)
            if jung in Y_N:
                add(IDX_N)
    elif cho in (IDX_R, IDX_N):
        add(IDX_R); add(IDX_N)
    return out


def reach(ch, dueum=True):
    return sum(HEADS.get(v, 0) for v in variants(ch, dueum))


def post(url, body, timeout=60):
    req = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}


def student_word(heads, used):
    """학생 노릇 — 사전에서 그 글자로 시작하는 낱말을 하나 가져온다."""
    for h in heads:
        url = "https://stdict.korean.go.kr/api/search.do?" + urllib.parse.urlencode({
            "key": STDICT_KEY, "q": h, "req_type": "json", "num": 100,
            "method": "start", "advanced": "y", "type1": "word", "pos": "1"})
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                body = r.read().decode("utf-8")
            if not body.strip():
                continue
            items = json.loads(body).get("channel", {}).get("item", [])
            items = [items] if isinstance(items, dict) else items
            for it in items:
                s = it.get("sense")
                s = s[0] if isinstance(s, list) else s
                if (s or {}).get("type") != "일반어":
                    continue
                w = str(it.get("word", "")).replace("-", "").replace("^", "")
                if 2 <= len(w) <= 4 and w.startswith(h) and w not in used \
                        and all("가" <= c <= "힣" for c in w):
                    return w
        except Exception:
            continue
    return None


def play(url, gi, dueum, level="hell", max_turns=16):
    d = post(url, {"mode": "start", "level": level, "dueum": dueum, "used": [], "deadEnd": []})
    if d.get("error") or not d.get("aiWord"):
        print(f"게임{gi}: 시작 실패 — {d.get('error')}")
        return None
    used = [d["aiWord"]]
    path = [f"*{d['aiWord']}({reach(d['aiWord'][-1], dueum)})"]
    prev = d["aiWord"]
    turn = 0
    danger_given = []

    for turn in range(1, max_turns + 1):
        heads = variants(prev[-1], dueum)
        # AI가 학생에게 한방 기회를 줬는지 검사
        shots = [k for k in KILLERS if k[0] in heads and reach(k[-1], dueum) < 5]
        if shots:
            danger_given.append((turn, prev, shots[:2]))
        sw = student_word(heads, used)
        if not sw:
            path.append(f"[학생 막힘 {heads[0]}]")
            break
        used.append(sw)
        # AI에게 넘길 시작 글자는 학생이 낸 낱말의 끝 글자에서 나온다
        ai_heads = variants(sw[-1], dueum)
        d = post(url, {"mode": "turn", "word": sw, "allowed": ai_heads, "used": used,
                       "level": level, "dueum": dueum, "deadEnd": [], "turn": turn})
        if d.get("error"):
            path.append(f"[오류 {d['error'][:20]}]")
            break
        ai = d.get("aiWord") or ""
        path.append(sw)
        if not ai or d.get("aiStuck"):
            path.append("[AI 막힘]")
            break
        used.append(ai)
        n = reach(ai[-1], dueum)
        path.append(f"*{ai}({n})" + ("!!" if d.get("aiKill") else ""))
        prev = ai
        if d.get("aiKill") or n == 0:
            path.append("[학생 사망]")
            break

    print(f"게임{gi} ({turn}턴): " + " > ".join(path))
    for t, w, ss in danger_given:
        print(f"   ! {t}턴에 「{w}」로 끝냄 — 학생이 {', '.join(ss)} 꽂을 수 있었음")
    return {"turns": turn, "danger": len(danger_given), "path": path}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:3210/api/word")
    ap.add_argument("--games", type=int, default=4)
    ap.add_argument("--dueum", default="on", choices=["on", "off"])
    ap.add_argument("--level", default="hell", choices=["hell", "inferno"])
    args = ap.parse_args()

    print(f"대상 {args.url}  두음법칙 {args.dueum}\n")
    rs = [play(args.url, i + 1, args.dueum == "on", args.level) for i in range(args.games)]
    rs = [r for r in rs if r]
    if rs:
        print(f"\n평균 {sum(r['turns'] for r in rs) / len(rs):.1f}턴, "
              f"학생에게 한방 기회를 준 횟수 {sum(r['danger'] for r in rs)}회")
