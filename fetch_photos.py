#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_photos.py — 用 Google Places API (New) 幫每間廟找「Google 地圖上的那張照片」，寫進 data/temples.json 的 photo 欄位

用法：
    python3 fetch_photos.py --key AIza...                 # 只補還沒有 photo 的廟
    python3 fetch_photos.py --key AIza... --force         # 全部重查
    python3 fetch_photos.py --key AIza... --only 蘆洲湧蓮寺 行天宮   # 只查這幾間（demo 用）

需要：Google Cloud 專案啟用「Places API (New)」，key 允許呼叫它。
      ★ 這支程式從電腦跑、沒有 HTTP referrer，所以 key 若已設「HTTP 網站限制」會被拒——
        先跑完再加限制，或另開一把只給 IP 的 key 給腳本用。

流程（每間廟兩次呼叫，都是免費額度內的 SKU）：
  1. Text Search  「廟名 地址」＋座標 300 公尺內偏好 → 拿 place id 跟座標
     欄位只要 places.id,places.location → Essentials（每月 10,000 次免費）
  2. Place Details 只要 photos 欄位 → IDs Only SKU（免費、不限次數）
     取第一張照片的資源名 places/…/photos/… 跟作者名，寫進 photo / photoBy
  查到的地點若離廟座標超過 500 公尺，就當沒查到——寧可沒照片，也不要別間廟的照片。

之後顯示照片（index.html 的 photoUrl）才會走 Place Photo 端點，那個 SKU 每月免費 1,000 次、之後每千次 7 美元。
清單縮圖是 lazy 載入、瀏覽器會快取，demo 規模不會超過。
"""
import sys, json, re, time, argparse, math, urllib.request, urllib.error

TS  = "https://places.googleapis.com/v1/places:searchText"
DET = "https://places.googleapis.com/v1/places/%s"

def call(url, key, mask, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask},
        method="POST" if body else "GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")[:300]
        if e.code in (403, 400) and ("API_KEY" in msg or "PERMISSION_DENIED" in msg or "not authorized" in msg):
            raise SystemExit("Google 拒絕這把 key：%s\n→ 確認專案有啟用 Places API (New)，且 key 沒有 HTTP referrer 限制" % msg)
        print("  ! HTTP %d %s" % (e.code, msg), file=sys.stderr)
        return None

def haversine(a, b, c, d):
    R = 6371.0; r = math.pi / 180
    x = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))

def find_photo(t, key, max_km):
    body = {"textQuery": t["name"] + " " + t.get("addr", ""), "languageCode": "zh-TW", "pageSize": 3,
            "locationBias": {"circle": {"center": {"latitude": t["lat"], "longitude": t["lng"]}, "radius": 300.0}}}
    j = call(TS, key, "places.id,places.location", body)
    if not j or not j.get("places"): return None, "查無此地點"
    best = None
    for p in j["places"]:
        loc = p.get("location") or {}
        d = haversine(t["lat"], t["lng"], loc.get("latitude", 0), loc.get("longitude", 0))
        if best is None or d < best[0]: best = (d, p["id"])
    if best[0] > max_km: return None, "最近的結果離廟 %.0f 公尺，太遠不採用" % (best[0] * 1000)
    det = call(DET % best[1], key, "photos")
    photos = (det or {}).get("photos") or []
    if not photos: return None, "Google 地圖上這個地點沒有照片"
    ph = photos[0]
    by = ((ph.get("authorAttributions") or [{}])[0]).get("displayName", "")
    return {"placeId": best[1], "photo": ph["name"], "photoBy": by}, "OK（%s）" % (by or "無作者")

def patch_js(path, updates):
    """把 photo/photoBy/placeId 同步回 temples.js（退路檔）"""
    try: src = open(path, encoding="utf-8").read()
    except FileNotFoundError: return
    def js_str(s): return json.dumps(s, ensure_ascii=False)
    def fix(m):
        name, body = m.group(1), m.group(2)
        u = updates.get(name)
        if not u: return m.group(0)
        for f in ("photo", "photoBy", "placeId"):
            body = re.sub(r",?\s*\b" + f + r"\s*:\s*\"(?:[^\"\\]|\\.)*\"", "", body)
        body = body.rstrip().rstrip(",") + "".join(", %s:%s" % (f, js_str(u[f])) for f in ("photo", "photoBy", "placeId") if u.get(f))
        return "{ name:%s%s }" % (js_str(name), body)
    open(path, "w", encoding="utf-8").write(re.sub(r"\{\s*name:\s*\"([^\"]+)\"(.*?)\s*\}", fix, src, flags=re.S))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", required=True)
    ap.add_argument("--data", default="data/temples.json")
    ap.add_argument("--js", default="temples.js", help="同步回填的退路檔，給空字串就跳過")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", nargs="*", default=[])
    ap.add_argument("--max-km", type=float, default=0.5)
    a = ap.parse_args()
    j = json.load(open(a.data, encoding="utf-8"))
    updates, n_ok, n_skip = {}, 0, 0
    for t in j["temples"]:
        if a.only and t["name"] not in a.only: continue
        if t.get("photo") and not a.force: n_skip += 1; continue
        res, why = find_photo(t, a.key, a.max_km)
        print("%-14s %s" % (t["name"], why))
        if res:
            t.update(res); updates[t["name"]] = res; n_ok += 1
        elif a.force:
            for f in ("photo", "photoBy", "placeId"): t.pop(f, None)
        time.sleep(0.15)
    json.dump(j, open(a.data, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("找到 %d 間的照片，跳過 %d 間（已有 photo），寫回 %s" % (n_ok, n_skip, a.data))
    if a.js and updates: patch_js(a.js, updates); print("同步 %s" % a.js)

if __name__ == "__main__":
    main()
