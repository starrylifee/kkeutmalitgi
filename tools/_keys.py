# -*- coding: utf-8 -*-
"""API 키를 .env.local 에서 읽는다.

키를 스크립트에 적어 두면 공개 저장소에 그대로 올라간다.
.env.local 은 gitignore 되어 있으므로 거기서만 읽는다.

  vercel env pull .env.local     처음이거나 키가 바뀌었을 때
"""

import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load(name):
    v = os.environ.get(name)
    if v:
        return v
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, val = line.partition("=")
            if k.strip() == name:
                return val.strip().strip('"').strip("'")
    raise SystemExit(
        f"{name} 를 찾지 못했습니다.\n"
        f"  vercel env pull .env.local  을 먼저 돌리거나\n"
        f"  {name}=... 를 환경 변수로 넣어 주세요."
    )


STDICT_KEY = load("STDICT_API_KEY")
