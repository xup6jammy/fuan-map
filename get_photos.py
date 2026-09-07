#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
get_photos.py — 把 15 間示範宮廟在 Google 地圖上的第一張照片抓下來，存成 img/<slug>.jpg（640×480、<150KB）

用法（在 fuan-map repo 根目錄）：
    pip install pillow
    GOOGLE_KEY=AIza...  python3 get_photos.py            # 全部 15 間
    GOOGLE_KEY=AIza...  python3 get_photos.py 行天宮 艋舺龍山寺   # 只抓這幾間

需要：Google Cloud 專案啟用「Places API (New)」；key 不能有 HTTP referrer 限制（腳本沒有 referrer）。
每間廟三個請求：Text Search（免費 SKU）→ Place Details 只要 photos（免費 SKU）→ Place Photo 下載（每月免費 1,000 次）。
查到的地點離廟座標超過 500 公尺就跳過——寧可沒照片，也不要別間廟的照片。
會順手把拍照者寫進 data/temples.json 的 photoBy（如果該檔存在）。
"""
import os, sys, io, json, math, time, urllib.request, urllib.error

KEY = os.environ.get("GOOGLE_KEY", "").strip()
if not KEY:
    sys.exit("請先設定環境變數 GOOGLE_KEY（Google Maps Platform 的 API key）")
try:
    from PIL import Image
except ImportError:
    sys.exit("請先 pip install pillow")

# 名稱、地址、座標、檔名 —— 跟 data/temples.json 一致
TEMPLES = [
    ("艋舺龍山寺",     "台北市萬華區廣州街211號",        25.0372, 121.4998, "longshan"),
    ("行天宮",         "台北市中山區民權東路二段109號",   25.0632, 121.5337, "xingtian"),
    ("大龍峒保安宮",   "台北市大同區哈密街61號",          25.0730, 121.5153, "baoan"),
    ("台北霞海城隍廟", "台北市大同區迪化街一段61號",      25.0554, 121.5100, "xiahai"),
    ("台北孔子廟",     "台北市大同區大龍街275號",         25.0725, 121.5165, "confucius"),
    ("松山慈祐宮",     "台北市松山區八德路四段761號",     25.0508, 121.5776, "ciyou"),
    ("士林慈諴宮",     "台北市士林區大南路84號",          25.0885, 121.5245, "cixian"),
    ("艋舺清水巖祖師廟","台北市萬華區康定路81號",         25.0355, 121.5010, "qingshui"),
    ("台北府城隍廟",   "台北市中正區武昌街一段14號",      25.0435, 121.5115, "chenghuang-fucheng"),
    ("芝山巖惠濟宮",   "台北市士林區至誠路一段326巷26號", 25.1030, 121.5310, "huiji"),
    ("指南宮",         "台北市文山區萬壽路115號",         24.9705, 121.5872, "zhinan"),
    ("景美集應廟",     "台北市文山區景美街37號",          24.9930, 121.5410, "jiying"),
    ("三重先嗇宮",     "新北市三重區五谷王北街77號",      25.0640, 121.4830, "xianse"),
    ("蘆洲湧蓮寺",     "新北市蘆洲區得勝街96號",          25.0850, 121.4720, "yonglian"),
    ("新莊武聖廟",     "新北市新莊區新莊路340號",         25.0392, 121.4510, "wusheng"),
]
MAX_KM, W, H, MAX_BYTES = 0.5, 640, 480, 150_000

def api(url, mask, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": mask},
        method="POST" if body else "GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")[:300]
        if e.code in (400, 403):
            sys.exit("Google 拒絕請求（HTTP %d）：%s\n→ 確認已啟用 Places API (New)、key 沒有 referrer 限制" % (e.code, msg))
        print("  ! HTTP %d %s" % (e.code, msg)); return None

def km(a, b, c, d):
    r = math.pi / 180
    x = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))

def fetch_one(name, addr, lat, lng, slug):
    j = api("https://places.googleapis.com/v1/places:searchText", "places.id,places.location",
            {"textQuery": name + " " + addr, "languageCode": "zh-TW", "pageSize": 3,
             "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": 300.0}}})
    places = (j or {}).get("places") or []
    if not places: return None, "Google 查無此地點"
    d, pid = min((km(lat, lng, p.get("location", {}).get("latitude", 0), p.get("location", {}).get("longitude", 0)), p["id"]) for p in places)
    if d > MAX_KM: return None, "最近的結果離廟 %.0f 公尺，太遠不採用" % (d * 1000)
    det = api("https://places.googleapis.com/v1/places/" + pid, "photos")
    photos = (det or {}).get("photos") or []
    if not photos: return None, "Google 地圖上這個地點沒有照片"
    ph = photos[0]
    by = ((ph.get("authorAttributions") or [{}])[0]).get("displayName", "")
    url = "https://places.googleapis.com/v1/%s/media?maxWidthPx=1200&maxHeightPx=1200&key=%s" % (ph["name"], KEY)
    with urllib.request.urlopen(url, timeout=30) as r:          # 302 → 實際圖檔，urllib 會自動跟過去
        raw = r.read()
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    # 置中裁成 4:3 再縮到 640×480
    w, h = im.size
    if w / h > W / H:
        nw = int(h * W / H); im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = int(w * H / W); im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    im = im.resize((W, H), Image.LANCZOS)
    os.makedirs("img", exist_ok=True)
    path = os.path.join("img", slug + ".jpg")
    for q in (82, 74, 66, 58, 50):
        im.save(path, "JPEG", quality=q, optimize=True, progressive=True)
        if os.path.getsize(path) <= MAX_BYTES: break
    return by, "OK %dKB（拍攝：%s）" % (os.path.getsize(path) // 1000, by or "未具名")

def main():
    only = set(sys.argv[1:])
    credits, ok = {}, 0
    for name, addr, lat, lng, slug in TEMPLES:
        if only and name not in only: continue
        try:
            by, why = fetch_one(name, addr, lat, lng, slug)
        except Exception as e:
            by, why = None, "失敗：%s" % e
        print("%-10s %s" % (name, why))
        if by is not None:
            ok += 1
            if by: credits[name] = by
        time.sleep(0.2)
    print("完成：%d 張存進 img/" % ok)
    # 拍攝者寫回 data/temples.json（有這個檔才做）
    p = os.path.join("data", "temples.json")
    if credits and os.path.exists(p):
        j = json.load(open(p, encoding="utf-8"))
        for t in j["temples"]:
            if t["name"] in credits: t["photoBy"] = "Google 地圖・" + credits[t["name"]]
        json.dump(j, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("photoBy 寫回 %s：%d 間" % (p, len(credits)))

if __name__ == "__main__":
    main()
