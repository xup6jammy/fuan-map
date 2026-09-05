#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_facilities.py — 用開放資料重建 facilities.js（附近公廁、停車場），並補 temples.js 的 fac 欄位

用法：
    python3 build_facilities.py --toilets 公廁_臺北.csv 公廁_新北.csv --parking 停車場_臺北.json
    （temples.js 先用 convert_temples.py 產好；本程式會讀它決定「附近」是哪裡）

資料來源：
  公廁    環境部環境資料開放平臺「建檔公廁明細」 臺北市 FAC_P_28、新北市 FAC_P_21（CSV）
          欄位：公廁名稱、公廁地址、緯度、經度、公廁類別、無障礙廁座數…（每列是一間，男女分開）
  停車場  臺北市停車場資訊（交通局停管處） https://data.taipei/dataset/detail?id=… dataset/128435（JSON）
          欄位：name、tw97x、tw97y、totalcar…（TWD97 二度分帶，要轉 WGS84；需要 pyproj）

規則（跟原本 facilities.js 檔頭寫的一樣）：
  公廁    同一地址的多列合併成一個點；只保留任一宮廟 350 公尺內的
          類別「宗教禮儀場所」且距某宮廟 80 公尺內 → 不放 facilities，改寫進該廟的 fac（toilet／accessible）
  停車場  只保留任一宮廟 500 公尺內的；total 是小型車總車位，非即時剩餘
  沒有的欄位就不寫，不補假的。
"""
import sys, re, csv, io, json, math, argparse, datetime

def norm(s): return (s or "").strip().replace("﻿", "")

def pick(row, keys):
    for k in keys:
        for col, val in row.items():
            if k.lower() in norm(col).lower():
                return norm(val)
    return ""

def to_f(x):
    try: return float(str(x).replace(",", "").strip())
    except Exception: return None

def haversine(a, b, c, d):
    R = 6371.0; r = math.pi / 180
    dlat, dlng = (c - a) * r, (d - b) * r
    x = math.sin(dlat / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))

def read_table(path):
    raw = open(path, "rb").read().decode("utf-8-sig", errors="replace").lstrip()
    if raw.startswith("[") or raw.startswith("{"):
        j = json.loads(raw)
        # 臺北市資料大平臺常見包法：{"result":{"results":[...]}}
        if isinstance(j, dict):
            for k in ("result", "results", "data", "records"):
                if k in j:
                    j = j[k]; break
            if isinstance(j, dict):
                for k in ("results", "data", "records"):
                    if k in j:
                        j = j[k]; break
        return [{str(k): ("" if v is None else str(v)) for k, v in r.items()} for r in j]
    return list(csv.DictReader(io.StringIO(raw)))

def load_temples(path):
    """path 可以是 data/temples.json（主）或 temples.js（退路）"""
    src = open(path, encoding="utf-8").read()
    if path.endswith(".json"):
        j = json.loads(src)
        return src, [{"name": t["name"], "lat": float(t["lat"]), "lng": float(t["lng"])} for t in j["temples"]]
    out = []
    for m in re.finditer(r"\{\s*name:\s*\"([^\"]+)\".*?lat:\s*([-\d.]+).*?lng:\s*([-\d.]+)", src, re.S):
        out.append({"name": m.group(1), "lat": float(m.group(2)), "lng": float(m.group(3))})
    return src, out

def js_str(s): return json.dumps(s, ensure_ascii=False)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--temples", default="data/temples.json", help="宮廟資料（JSON 或 .js）")
    ap.add_argument("--temples-js", default="temples.js", help="同步回填 fac 的退路 .js，給空字串就跳過")
    ap.add_argument("--toilets", nargs="*", default=[])
    ap.add_argument("--parking", nargs="*", default=[])
    ap.add_argument("--out", default="data/facilities.json", help="主要輸出")
    ap.add_argument("--js", default="facilities.js", help="退路用的 .js，給空字串就不寫")
    ap.add_argument("--toilet-km", type=float, default=0.35)
    ap.add_argument("--parking-km", type=float, default=0.5)
    ap.add_argument("--own-km", type=float, default=0.08, help="宗教禮儀場所公廁離廟多近算「廟內」")
    a = ap.parse_args()

    src, temples = load_temples(a.temples)
    if not temples:
        raise SystemExit("temples.js 裡讀不到任何廟，先跑 convert_temples.py")
    print("宮廟 %d 間" % len(temples))

    def nearest(lat, lng):
        best = None
        for t in temples:
            d = haversine(lat, lng, t["lat"], t["lng"])
            if best is None or d < best[0]: best = (d, t)
        return best

    # ---------- 公廁 ----------
    toilets, own = {}, {}          # own[廟名] = set(fac)
    n_rows = 0
    for path in a.toilets:
        for r in read_table(path):
            n_rows += 1
            lat, lng = to_f(pick(r, ["緯度", "lat"])), to_f(pick(r, ["經度", "lng", "lon"]))
            if lat is None or lng is None or not (21 < lat < 27 and 118 < lng < 123): continue
            name = pick(r, ["公廁名稱", "名稱"])
            addr = pick(r, ["地址"])
            cat  = pick(r, ["類別", "類型"])
            acc  = (to_f(pick(r, ["無障礙"])) or 0) > 0
            d, t = nearest(lat, lng)
            if cat and "宗教" in cat and d <= a.own_km:
                s = own.setdefault(t["name"], set()); s.add("toilet")
                if acc: s.add("accessible")
                continue
            if d > a.toilet_km: continue
            key = addr or name
            e = toilets.setdefault(key, {"type": "toilet", "name": re.sub(r"[男女]$", "", name) or key,
                                         "lat": round(lat, 5), "lng": round(lng, 5), "acc": False})
            e["acc"] = e["acc"] or acc
    print("公廁：讀 %d 列 → 附近 %d 個點位；歸到廟內的：%d 間" % (n_rows, len(toilets), len(own)))

    # ---------- 停車場 ----------
    parks, n_rows = [], 0
    if a.parking:
        try:
            from pyproj import Transformer
            tf = Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)
        except ImportError:
            raise SystemExit("需要 pyproj 轉 TWD97 座標：pip install pyproj")
        for path in a.parking:
            for r in read_table(path):
                n_rows += 1
                x, y = to_f(pick(r, ["tw97x", "TWD97X", "X座標"])), to_f(pick(r, ["tw97y", "TWD97Y", "Y座標"]))
                if x is None or y is None:
                    lat, lng = to_f(pick(r, ["緯度", "lat"])), to_f(pick(r, ["經度", "lng"]))
                else:
                    lng, lat = tf.transform(x, y)
                if lat is None or lng is None or not (21 < lat < 27 and 118 < lng < 123): continue
                d, t = nearest(lat, lng)
                if d > a.parking_km: continue
                total = to_f(pick(r, ["totalcar", "小型車", "汽車"]))
                e = {"type": "parking", "name": pick(r, ["name", "名稱"]), "lat": round(lat, 5), "lng": round(lng, 5)}
                if total is not None and total > 0: e["total"] = int(total)
                parks.append(e)
    print("停車場：讀 %d 列 → 附近 %d 個" % (n_rows, len(parks)))

    # ---------- 寫 facilities.js ----------
    today = datetime.date.today().isoformat()
    L = ["/* ============================================================",
         "   附近設施點位（真實開放資料，由 build_facilities.py 產生 %s）" % today,
         "   ------------------------------------------------------------",
         "   公廁：環境部「建檔公廁明細」；同地址合併，只留宮廟 %d 公尺內的 %d 個。" % (int(a.toilet_km * 1000), len(toilets)),
         "         acc = 該點位設有無障礙廁所。類別「宗教禮儀場所」且距廟 %d 公尺內者已寫進 temples.js 的 fac。" % int(a.own_km * 1000),
         "   停車場：臺北市停車場資訊（交通局停管處）dataset/128435，TWD97 → WGS84；",
         "         只留宮廟 %d 公尺內的 %d 個。total 為小型車總車位，非即時剩餘。" % (int(a.parking_km * 1000), len(parks)),
         "   新北市目前沒有停車場資料集可用；沒有的就沒有，程式會照實講。",
         "   ============================================================ */",
         "window.FACILITIES = ["]
    for e in sorted(toilets.values(), key=lambda e: (e["lat"], e["lng"])):
        L.append('  { type:"toilet",  name:%s, lat:%.5f, lng:%.5f%s },' % (js_str(e["name"]), e["lat"], e["lng"], ", acc:true" if e["acc"] else ""))
    for e in sorted(parks, key=lambda e: (e["lat"], e["lng"])):
        L.append('  { type:"parking", name:%s, lat:%.5f, lng:%.5f%s },' % (js_str(e["name"]), e["lat"], e["lng"], (", total:%d" % e["total"]) if "total" in e else ""))
    L.append("];")
    import os
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    fac_list = [dict(type="toilet", name=e["name"], lat=e["lat"], lng=e["lng"], **({"acc": True} if e["acc"] else {}))
                for e in sorted(toilets.values(), key=lambda e: (e["lat"], e["lng"]))]
    fac_list += [dict(type="parking", name=e["name"], lat=e["lat"], lng=e["lng"], **({"total": e["total"]} if "total" in e else {}))
                 for e in sorted(parks, key=lambda e: (e["lat"], e["lng"]))]
    json.dump({"source": "公廁：環境部建檔公廁明細；停車場：臺北市停管處 dataset/128435（TWD97→WGS84）",
               "generated": today, "count": len(fac_list), "facilities": fac_list},
              open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("寫出 %s（%d 個點位）" % (a.out, len(fac_list)))
    if a.js:
        open(a.js, "w", encoding="utf-8").write("\n".join(L) + "\n")
        print("寫出 %s（退路用）" % a.js)

    # ---------- 回填 fac：JSON 主檔 + .js 退路 ----------
    if own and a.temples.endswith(".json"):
        j = json.loads(src)
        for t in j["temples"]:
            if t["name"] in own:
                t["fac"] = sorted(set(t.get("fac", [])) | own[t["name"]])
        json.dump(j, open(a.temples, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("回填 %s 的 fac：%d 間" % (a.temples, len(own)))
        if a.temples_js:
            try: src = open(a.temples_js, encoding="utf-8").read()
            except FileNotFoundError: src = None
    if own and src and (a.temples.endswith(".js") or a.temples_js):
        target = a.temples if a.temples.endswith(".js") else a.temples_js
        def add_fac(m):
            name = m.group(1)
            if name not in own: return m.group(0)
            body = m.group(2)
            facs = sorted(own[name])
            if re.search(r"\bfac\s*:", body):
                body = re.sub(r"\bfac\s*:\s*\[[^\]]*\]", "fac:[%s]" % ", ".join(js_str(f) for f in facs), body)
            else:
                body = body.rstrip().rstrip(",") + ", fac:[%s]" % ", ".join(js_str(f) for f in facs)
            return "{ name:%s%s }" % (js_str(name), body)
        new_src = re.sub(r"\{\s*name:\s*\"([^\"]+)\"(.*?)\s*\}", add_fac, src, flags=re.S)
        open(target, "w", encoding="utf-8").write(new_src)
        print("回填 %s 的 fac：%d 間" % (target, len(own)))

if __name__ == "__main__":
    main()
