#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
convert_temples.py — 把內政部「全國宗教資訊系統資料－寺廟」轉成 temples.js

用法：
    python3 convert_temples.py 寺廟.xml                 # 只留臺北市（預設）
    python3 convert_temples.py 寺廟.csv --city 臺北市 新北市
    python3 convert_temples.py 寺廟.xml --keep temples.js  # 保留舊檔裡人工補的欄位（預設就會）

資料來源：https://data.gov.tw/dataset/8203（XML，UTF-8，每年更新）
          欄位：寺廟名稱、主祀神祇、行政區、地址、電話、WGS84X（經度）、WGS84Y（緯度）…
          ★ 下載後先確認 X 是經度（121.x）、Y 是緯度（25.x），兩者常被顛倒。

做的事：
  1. 讀 XML 或 CSV（欄位名用「包含關鍵字」比對，不同年份的欄名小改也吃得下）
  2. 只留指定縣市（預設臺北市；「台」「臺」都認）
  3. 座標不合法（空白、0、經緯顛倒且無法修正）的丟掉，並列在 stderr
  4. 跟舊的 temples.js 比對「寺廟名稱」，把人工補過的欄位帶過來：
       url / urlKind / wiki / fac / parking / open / peak / crowd / story / storySrc
     所以重跑不會把之前查的官網、維基條目洗掉
  5. 輸出 temples.js，檔頭寫清楚來源、日期、筆數；window.NEEDS 那段照舊帶過來

不做的事：
  - 不查官網、不查維基（那是人工核對的活，機器猜會猜錯廟）
  - 不合併同名廟（台北有好幾間「福德宮」，座標不同就是不同間）
"""
import sys, re, json, csv, io, argparse, datetime
import xml.etree.ElementTree as ET

KEEP_FIELDS = ["url", "urlKind", "wiki", "fac", "parking", "open", "peak", "crowd", "story", "storySrc"]

# 欄位名關鍵字 → 我們的欄位。用「包含」比對，遇到 BOM、全半形、年份差異都還抓得到。
FIELD_KEYS = {
    "name":  ["寺廟名稱", "名稱"],
    "deity": ["主祀神祇", "主祀"],
    "dist":  ["行政區", "鄉鎮市區"],
    "addr":  ["地址", "所在地"],
    "tel":   ["電話"],
    "lng":   ["WGS84X", "經度", "X座標", "lng", "lon"],
    "lat":   ["WGS84Y", "緯度", "Y座標", "lat"],
    "city":  ["縣市", "County", "city"],
}

def norm(s):
    return (s or "").strip().replace("﻿", "")

def pick(row, key):
    """row 是 dict；用關鍵字在欄名裡找，找到就回值"""
    for k in FIELD_KEYS[key]:
        for col, val in row.items():
            if k.lower() in norm(col).lower():
                return norm(val)
    return ""

def read_rows(path):
    raw = open(path, "rb").read()
    text = raw.decode("utf-8-sig", errors="replace")
    if text.lstrip().startswith("<"):
        root = ET.fromstring(text)
        rows = []
        # 找「重複出現、底下有子元素」的節點當一筆資料
        for parent in root.iter():
            kids = list(parent)
            if len(kids) >= 5 and all(len(list(k)) > 0 for k in kids[:5]):
                for rec in kids:
                    rows.append({c.tag.split("}")[-1]: (c.text or "") for c in rec})
                if rows:
                    return rows
        raise SystemExit("XML 裡找不到資料列，請確認檔案")
    else:
        return list(csv.DictReader(io.StringIO(text)))

def to_float(x):
    try:
        return float(str(x).replace(",", "").strip())
    except Exception:
        return None

def fix_coord(lat, lng):
    """台灣：緯度 21.8~26.5、經度 118~122.5。顛倒就換回來；不在範圍就 None"""
    if lat is None or lng is None:
        return None, None
    if 118 <= lat <= 123 and 21 <= lng <= 27:
        lat, lng = lng, lat
    if 21 <= lat <= 27 and 118 <= lat + 100 <= 223 and 118 <= lng <= 123:
        return round(lat, 5), round(lng, 5)
    return None, None

def load_old(path):
    """從舊 temples.js 撈出每間廟人工補的欄位（用 name 對）"""
    keep = {}
    try:
        src = open(path, encoding="utf-8").read()
    except FileNotFoundError:
        return keep, None
    # 抓 window.NEEDS = {...}; 這段原封不動帶過去
    m = re.search(r"window\.NEEDS\s*=\s*\{.*?\};", src, re.S)
    needs_block = m.group(0) if m else None
    for m in re.finditer(r"\{\s*name:\s*\"([^\"]+)\"(.*?)\}\s*,?\s*(?=\n)", src, re.S):
        name, body = m.group(1), m.group(2)
        fields = {}
        for f in KEEP_FIELDS:
            mm = re.search(r"\b" + f + r"\s*:\s*(\"(?:[^\"\\]|\\.)*\"|\[[^\]]*\]|\{[^}]*\}|true|false|[-\d.]+)", body)
            if mm:
                fields[f] = mm.group(1)
        if fields:
            keep[name] = fields
    return keep, needs_block

DEFAULT_NEEDS = '''window.NEEDS = {
  "事業財運": ["關聖帝君","關公","武財神","趙公明","五路財神","財神","福德正神","土地公"],
  "學業考試": ["文昌帝君","至聖先師","孔子","魁星"],
  "姻緣":     ["月下老人","月老"],
  "求子":     ["註生娘娘","臨水夫人"],
  "平安健康": ["天上聖母","媽祖","保生大帝","神農大帝","玄天上帝","觀世音菩薩","觀音"],
  "地方守護": ["城隍","王爺","開漳聖王","清水祖師","保儀尊王","孚佑帝君","福德正神","土地公"]
};'''

def js_str(s):
    return json.dumps(s, ensure_ascii=False)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="內政部寺廟資料（XML 或 CSV）")
    ap.add_argument("--city", nargs="+", default=["臺北市"], help="要保留的縣市，預設臺北市")
    ap.add_argument("--keep", default="temples.js", help="舊的 temples.js（帶過人工欄位）")
    ap.add_argument("--out", default="data/temples.json", help="主要輸出（index.html 抓這個）")
    ap.add_argument("--js", default="temples.js", help="退路用的 .js（file:// 打開或資料夾被壓平時用），給空字串就不寫")
    a = ap.parse_args()

    cities = {c.replace("台", "臺") for c in a.city}
    rows = read_rows(a.src)
    keep, needs_block = load_old(a.keep)
    out, dropped, kept = [], [], 0

    for r in rows:
        name = pick(r, "name")
        if not name:
            continue
        addr = pick(r, "addr")
        city = pick(r, "city") or addr[:3]
        if city.replace("台", "臺") not in cities:
            continue
        lat, lng = fix_coord(to_float(pick(r, "lat")), to_float(pick(r, "lng")))
        if lat is None:
            dropped.append(name + "（座標不合法：" + pick(r, "lat") + "," + pick(r, "lng") + "）")
            continue
        rec = {
            "name": name, "deity": pick(r, "deity"), "dist": pick(r, "dist"),
            "addr": addr, "tel": pick(r, "tel"), "lat": lat, "lng": lng,
        }
        extra = keep.get(name)
        if extra:
            kept += 1
        out.append((rec, extra))

    out.sort(key=lambda x: (x[0]["dist"], x[0]["name"]))
    today = datetime.date.today().isoformat()
    lines = []
    lines.append("/* ============================================================")
    lines.append("   宮廟資料（由 convert_temples.py 產生，不要手改座標）")
    lines.append("   ------------------------------------------------------------")
    lines.append("   來源：內政部「全國宗教資訊系統資料－寺廟」 https://data.gov.tw/dataset/8203")
    lines.append("   轉檔：%s　範圍：%s　共 %d 筆（丟掉 %d 筆座標不合法）" % (today, "、".join(sorted(cities)), len(out), len(dropped)))
    lines.append("   人工欄位（url / urlKind / wiki / fac / parking …）從舊檔帶過來 %d 筆；" % kept)
    lines.append("   新增的廟沒有這些欄位，畫面上就不會出現「看故事」「官方網站」——沒查到就不顯示。")
    lines.append("   ============================================================ */")
    lines.append("window.TEMPLES = [")
    for rec, extra in out:
        parts = ["name:%s" % js_str(rec["name"]), "deity:%s" % js_str(rec["deity"]),
                 "dist:%s" % js_str(rec["dist"]), "addr:%s" % js_str(rec["addr"])]
        if rec["tel"]:
            parts.append("tel:%s" % js_str(rec["tel"]))
        parts.append("lat:%.5f" % rec["lat"])
        parts.append("lng:%.5f" % rec["lng"])
        if extra:
            for f in KEEP_FIELDS:
                if f in extra:
                    parts.append("%s:%s" % (f, extra[f]))
        lines.append("  { " + ", ".join(parts) + " },")
    lines.append("];")
    lines.append("")
    lines.append(needs_block or DEFAULT_NEEDS)
    lines.append("")
    # 主要輸出：JSON（index.html 用 fetch 抓，不用把幾百筆塞進 <script>）
    import os
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    def js_literal(v):
        """把舊檔帶過來的 JS 字面值（字串／陣列／true）轉成 Python 值"""
        try: return json.loads(v)
        except Exception: return v
    temples_json = []
    for rec, extra in out:
        d = dict(rec)
        if not d["tel"]: d.pop("tel")
        if extra:
            for f in KEEP_FIELDS:
                if f in extra: d[f] = js_literal(extra[f])
        temples_json.append(d)
    needs = json.loads(re.search(r"\{.*\}", needs_block or DEFAULT_NEEDS, re.S).group(0)) if True else {}
    json.dump({"source": "內政部「全國宗教資訊系統資料－寺廟」 https://data.gov.tw/dataset/8203",
               "generated": today, "cities": sorted(cities), "count": len(out),
               "needs": needs, "temples": temples_json},
              open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("寫出 %s：%d 筆（%s），帶過人工欄位 %d 筆" % (a.out, len(out), "、".join(sorted(cities)), kept))
    if a.js:
        open(a.js, "w", encoding="utf-8").write("\n".join(lines))
        print("寫出 %s（退路用）" % a.js)
    if dropped:
        print("丟掉 %d 筆座標不合法：" % len(dropped), file=sys.stderr)
        for d in dropped:
            print("  - " + d, file=sys.stderr)

if __name__ == "__main__":
    main()
