# -*- coding: utf-8 -*-
# T4 源：HD.Rip 全球电视频道直播（https://hd.rip，IPTV 直播站，193 个频道）
#
# ================== 实测硬结论（2026-10-30）==================
# 1) 频道表：GET /api/config.php → {channels:[{id,name,codec,ok,logo,intro,epg,sub}]}
#    无地区字段：分类按 name+intro 关键词归地区（台/港/马来/印尼/新/日/韩/印度/泰/中东/大陆/欧美/其他）。
#    logo 是站内相对路径 /logos/ch<id>-<名>.png，壳子 UA（okhttp/Dalvik）可直取，不用图片代理。
# 2) 播放三步缺一不可（顺序不能乱）：
#    ① GET / 先拿会话 cookie「hdrip_s」（HttpOnly，play.php 没它直接 stream_denied）
#    ② GET /api/play.php?id=<id>（带 cookie + 浏览器 UA + Referer）→ {url: 签名 m3u8, sig_ttl:3600}
#    ③ GET /api/keepalive.php?id=<id>（带 cookie）→ 激活该签名；不调它，签名地址拉清单回 stream_denied
#    之后拉 playlist/分片都要带同一 cookie + UA + Referer（playerContent 的 header 里给出）。
#    签名 1 小时过期 → 详情里不存地址，playerContent 每次现取。
#    站方限制同一会话最多 5 路并发（sess_max=5），源内全程复用一个 cookie 罐。
# 3) Cloudflare 按 UA 指纹拦：Python-urllib 默认 UA 拉图 403、play 回 1010；
#    全程固定 Chrome UA 后 curl/requests/urllib 均通。
# 4) 节目表：GET /api/epg.php?id=<id> → {has, days:[{date, items:[{a,b,t,now}]}]}，
#    仅 epg=1 的频道有（164/193）；详情里顺手拼「正在播出/接下来」，失败静默。
# ============================================================
import json
import re
import ssl
import time
import gzip
import http.cookiejar
import urllib.request
import urllib.parse

# -- 基类四级兼容导入（任一层可用即可；最后一层内置桩，保证任何加载器都能导入） --
BaseSpider = None
for _mod, _name in (
    ("base.spider", "BaseSpider"), ("base.spider", "Spider"),
    ("base", "BaseSpider"), ("base", "Spider"),
    ("spider", "Spider"), ("spider", "BaseSpider"),
    ("t4.base.spider", "Spider"), ("t4.base.spider", "BaseSpider"),
):
    try:
        _m = __import__(_mod, fromlist=[_name])
        BaseSpider = getattr(_m, _name)
        break
    except Exception:
        continue
if BaseSpider is None:
    class BaseSpider(object):
        def fetch(self, url, headers=None, timeout=None): return ""
        def post(self, url, headers=None, data=None, timeout=None): return ""
        def getProxyUrl(self, *a, **k): return "http://127.0.0.1:9978/proxy?do=py"
        def getCache(self, *a, **k): return ""
        def setCache(self, *a, **k): pass
        def log(self, *a, **k): pass
        def homeContent(self, filter=False): return {"class": [], "filters": {}}
        def homeVideoContent(self): return {"list": []}
        def categoryContent(self, tid, pg, filter, extend):
            return {"list": [], "page": 1, "pagecount": 1, "limit": 0, "total": 0}
        def detailContent(self, ids): return {"list": []}
        def searchContent(self, key, quick, pg="1"): return {"list": []}
        def playerContent(self, flag, id, vipFlags=None): return {"parse": 1, "url": id, "header": {}}
        def localProxy(self, param): return [404, "text/plain", b""]
        def getName(self): return ""
        def init(self, extend=""): pass


HOST = "https://hd.rip"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
_CTX = ssl._create_unverified_context()

# 地区归类：按 name+intro 关键词，顺序即优先级（具体的在前）
REGIONS = [
    ("tw", "台湾", ("台湾", "台视", "中视", "华视", "民视", "三立", "TVBS", "东森", "纬来",
                    "八大", "中天", "寰宇", "龙华", "博斯", "靖天", "公视", "大爱", "客家",
                    "壹电视", "好消息", "GOODTV", "原住民族")),
    ("hk", "香港", ("香港", "翡翠", "明珠", "TVB", "ViuTV", "凤凰")),
    ("my", "马来西亚", ("马来", "Astro", "Malaysia", "Bernama")),
    ("id", "印尼", ("印尼", "Indonesia")),
    ("sg", "新加坡", ("新加坡",)),
    ("jp", "日本", ("日本", "NHK")),
    ("kr", "韩国", ("韩国", "KBS", "MBC", "SBS", "tvN")),
    ("in", "印度", ("印度", "India", "Zee", "Asianet", "Vijay", "Makkal", "Tamil")),
    ("th", "泰国", ("泰国", "Thailand", "PPTV")),
    ("me", "中东", ("沙特", "阿拉伯", "半岛")),
    ("cn", "大陆", ("中国", "大陆", "CCTV")),
    ("eu", "欧美", ("美国", "英国", "法国", "德国", "BBC", "CNN", "HBO", "CBS", "France",
                    "Discovery", "探索", "国家地理", "好莱坞", "天映", "索尼", "华纳",
                    "Nick", "Cartoon", "ZooMoo", "HGTV", "CINEMAX", "DAZN", "HISTORY",
                    "Bloomberg", "TLC", "动物星球", "罪案")),
]


def _region_of(ch):
    blob = (ch.get("name") or "") + "|" + (ch.get("intro") or "")
    for rid, _rn, kws in REGIONS:
        if any(k in blob for k in kws):
            return rid
    return "other"


class Spider(BaseSpider):
    def __init__(self):
        self.host = HOST
        self._cj = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler(),
            urllib.request.HTTPCookieProcessor(self._cj),
            urllib.request.HTTPSHandler(context=_CTX))
        self._booted = False
        self._chs = None
        self._chs_at = 0.0

    # ---------------- 基础请求（自带 cookie 罐，不走宿主 fetch：会话必须可控） ----------------

    def _get(self, url, referer=None, timeout=20, raw=False):
        h = {"User-Agent": UA, "Referer": referer or (self.host + "/"),
             "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9"}
        req = urllib.request.Request(url, headers=h)
        with self._opener.open(req, timeout=timeout) as r:
            data = r.read()
            if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
                try:
                    data = gzip.decompress(data)
                except Exception:
                    pass
        return data if raw else data.decode("utf-8", "ignore")

    def _boot(self, force=False):
        """访问首页拿 hdrip_s 会话 cookie；已拿过就不重复。"""
        if self._booted and not force:
            return True
        try:
            self._get(self.host + "/")
            self._booted = any(c.name == "hdrip_s" for c in self._cj)
        except Exception:
            self._booted = False
        return self._booted

    def _cookie_str(self):
        for c in self._cj:
            if c.name == "hdrip_s":
                return "hdrip_s=%s" % c.value
        return ""

    def _channels(self):
        """频道表（内存缓存 10 分钟）；失败返回上次缓存或空表。"""
        now = time.time()
        if self._chs is not None and now - self._chs_at < 600:
            return self._chs
        self._boot()
        try:
            d = json.loads(self._get(self.host + "/api/config.php"))
            chs = [c for c in (d.get("channels") or []) if c.get("id") and c.get("name")]
            if chs:
                self._chs, self._chs_at = chs, now
        except Exception:
            pass
        return self._chs or []

    def _classes(self):
        chs = self._channels()
        have = set(_region_of(c) for c in chs)
        cls = [{"type_id": "all", "type_name": "全部"}]
        for rid, rn, _k in REGIONS:
            if rid in have:
                cls.append({"type_id": rid, "type_name": rn})
        if "other" in have:
            cls.append({"type_id": "other", "type_name": "其他"})
        return cls

    def _item(self, ch):
        logo = ch.get("logo") or ""
        if logo and not logo.startswith("http"):
            logo = self.host + (logo if logo.startswith("/") else "/" + logo)
        return {
            "vod_id": str(ch["id"]),
            "vod_name": ch.get("name") or "",
            "vod_pic": logo,
            "vod_remarks": ch.get("codec") or "直播",
        }

    # ---------------- T4 接口 ----------------

    def init(self, extend=""):
        pass  # 零网络懒启动：会话与频道表第一次用时才拉

    def getName(self):
        return "HD.Rip直播"

    def homeContent(self, filter=False):
        cls = self._classes()
        return {"class": cls, "filters": {c["type_id"]: [] for c in cls} if filter else {}}

    def homeVideoContent(self):
        return {"list": [self._item(c) for c in self._channels()]}

    def categoryContent(self, tid, pg="1", filter=None, extend=None):
        chs = self._channels()
        if str(tid) != "all":
            chs = [c for c in chs if _region_of(c) == str(tid)]
        items = [self._item(c) for c in chs]
        return {"list": items, "page": 1, "pagecount": 1,
                "limit": len(items), "total": len(items)}

    def detailContent(self, ids):
        cid = str(ids[0] if isinstance(ids, (list, tuple)) and ids else ids or "").strip()
        ch = next((c for c in self._channels() if str(c.get("id")) == cid), None)
        if not ch:
            return {"list": []}
        it = self._item(ch)
        lines = []
        if ch.get("epg"):
            try:
                e = json.loads(self._get("%s/api/epg.php?id=%s" % (self.host, cid)))
                items = ((e.get("days") or [{}])[0].get("items") or []) if e.get("has") else []
                for i, p in enumerate(items):
                    if p.get("now"):
                        lines.append("正在播出：%s（%s-%s）" % (p.get("t", ""), p.get("a", ""), p.get("b", "")))
                        if i + 1 < len(items):
                            q = items[i + 1]
                            lines.append("接下来：%s（%s-%s）" % (q.get("t", ""), q.get("a", ""), q.get("b", "")))
                        break
            except Exception:
                pass
        if ch.get("intro"):
            lines.append(ch["intro"])
        it.update({
            "vod_content": "\n".join(lines),
            "vod_play_from": "直播",
            "vod_play_url": "直播$%s" % cid,
        })
        return {"list": [it]}

    def searchContent(self, key, quick=False, pg="1"):
        q = str(key or "").strip().lower()
        if not q:
            return {"list": [], "page": 1, "pagecount": 1, "limit": 0, "total": 0}
        items = [self._item(c) for c in self._channels()
                 if q in (c.get("name") or "").lower() or q in (c.get("intro") or "").lower()]
        return {"list": items, "page": 1, "pagecount": 1,
                "limit": len(items), "total": len(items)}

    def searchContentPage(self, key, quick=False, pg="1"):
        return self.searchContent(key, quick, pg)

    def playerContent(self, flag="", id="", vipFlags=None):
        cid = re.search(r"(\d+)", str(id or ""))
        cid = cid.group(1) if cid else ""
        if not cid:
            return {"parse": 0, "jx": 0, "playUrl": "", "url": "", "msg": "无频道 id"}
        url = ""
        for attempt in range(2):  # 第二轮强制重建会话再试（cookie 失效时自愈）
            try:
                self._boot(force=bool(attempt))
                d = json.loads(self._get("%s/api/play.php?id=%s" % (self.host, cid)))
                url = d.get("url") or ""
                if url:
                    # 关键一步：keepalive 激活签名，不调它清单会被拒
                    self._get("%s/api/keepalive.php?id=%s" % (self.host, cid))
                    break
            except Exception:
                url = ""
            time.sleep(0.4)
        if not url:
            # 全失败兜底：把频道页交壳嗅探
            return {"parse": 1, "jx": 1, "playUrl": "",
                    "url": "%s/channel.php?id=%s" % (self.host, cid),
                    "header": {"User-Agent": UA, "Referer": self.host + "/"}}
        header = {"User-Agent": UA, "Referer": self.host + "/"}
        ck = self._cookie_str()
        if ck:
            header["Cookie"] = ck
        return {"parse": 0, "jx": 0, "playUrl": "", "url": url, "header": header}

    def localProxy(self, param):
        """只做图片直通（logo 本可直取，这是兜底）：param 多形态先归一化取 url。"""
        url = ""
        try:
            if isinstance(param, dict):
                url = param.get("url") or param.get("u") or ""
            elif isinstance(param, (list, tuple)):
                for x in param:
                    m = re.search(r"url=(.+)$", str(x))
                    if m:
                        url = urllib.parse.unquote(m.group(1))
                        break
            else:
                m = re.search(r"[?&]url=([^&]+)", str(param or ""))
                url = urllib.parse.unquote(m.group(1)) if m else ""
        except Exception:
            url = ""
        if not url.startswith("http"):
            return [404, "text/plain", b""]
        try:
            self._boot()
            data = self._get(url, raw=True, timeout=15)
            mime = "image/png"
            if data[:3] == b"\xff\xd8\xff":
                mime = "image/jpeg"
            elif data[:4] == b"\x89PNG":
                mime = "image/png"
            elif data[:3] == b"GIF":
                mime = "image/gif"
            elif data[8:12] == b"WEBP":
                mime = "image/webp"
            return [200, mime, data]
        except Exception:
            return [404, "text/plain", b""]

    def isVideoFormat(self, url):
        return False

    def manualVideoCheck(self):
        return False


# ---------------- 模块级转发（部分 T4 加载器只认模块函数） ----------------

_sp = None


def _ins():
    global _sp
    if _sp is None:
        _sp = Spider()
    return _sp


def getName():
    return _ins().getName()


def init(extend=""):
    return _ins().init(extend)


def homeContent(filter=False):
    return _ins().homeContent(filter)


def homeVideoContent():
    return _ins().homeVideoContent()


def categoryContent(tid, pg="1", filter=None, extend=None):
    return _ins().categoryContent(tid, pg, filter, extend)


def detailContent(ids):
    return _ins().detailContent(ids)


def searchContent(key, quick=False, pg="1"):
    return _ins().searchContent(key, quick, pg)


def searchContentPage(key, quick=False, pg="1"):
    return _ins().searchContentPage(key, quick, pg)


def playerContent(flag="", id="", vipFlags=None):
    return _ins().playerContent(flag, id, vipFlags)


def localProxy(param):
    return _ins().localProxy(param)


def isVideoFormat(url):
    return _ins().isVideoFormat(url)


def manualVideoCheck():
    return _ins().manualVideoCheck()


if __name__ == "__main__":
    s = Spider()
    s.init("")
    h = s.homeContent(True)
    print("分类:", [(c["type_id"], c["type_name"]) for c in h["class"]])
    hv = s.homeVideoContent()
    print("全部频道:", len(hv["list"]), "| 首条:", hv["list"][0] if hv["list"] else None)
    tw = s.categoryContent("tw", "1", False, {})
    print("台湾:", len(tw["list"]))
    sc = s.searchContent("TVB", False, "1")
    print("搜索 TVB:", len(sc["list"]), [x["vod_name"] for x in sc["list"][:3]])
    d = s.detailContent(["173"])["list"][0]
    print("详情:", d["vod_name"], "|", (d["vod_content"] or "")[:80].replace("\n", " / "))
    p = s.playerContent("直播", "158", None)
    print("播放 parse:", p["parse"], "| url:", (p["url"] or "")[:90])
    if p["parse"] == 0:
        body = s._get(p["url"], timeout=15)
        segs = [l for l in body.splitlines() if l and not l.startswith("#")]
        print("清单分片数:", len(segs))
        if segs:
            base = p["url"].split("/playlist.m3u8")[0] + "/"
            data = s._get(base + segs[-1], raw=True, timeout=20)
            print("末分片:", len(data), "字节 | TS 头:", data[:1].hex())
