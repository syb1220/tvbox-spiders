import json
import re
import urllib.parse

import requests
from base.spider import Spider


class Spider(Spider):

    HOST = "http://116.62.133.86:56688/%E9%87%87%E9%9B%86/cai.php"
    JX_LIST = [
        "http://php.214728327.xyz:520/%E5%BC%80%E5%BF%83%E6%9E%9C.php?url=",
    ]
    UA_PAN = "pan.baidu.com"
    PAN_LINK_RE = re.compile(r"T7033\.php|action=redirect|d\.pcs\.baidu\.com", re.I)
    MEDIA_RE = re.compile(r"\.(m3u8|mp4|rmvb|avi|wmv|flv|mkv|webm|mov|m3u)(?!\w)", re.I)

    def getName(self):
        return "开心果4K"

    def init(self, extend=""):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        })

    def _get(self, params):
        try:
            r = self.session.get(self.HOST, params=params, timeout=20)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
        return {}

    @staticmethod
    def _page_result(data, pg):
        lst = data.get("list") or []
        try:
            page = int(data.get("page") or pg or 1)
        except Exception:
            page = 1
        try:
            pagecount = int(data.get("pagecount") or 1)
        except Exception:
            pagecount = 1
        total = data.get("total")
        if total is None:
            total = pagecount * len(lst) if lst else 0
        return {"list": lst, "page": page, "pagecount": pagecount,
                "limit": len(lst), "total": total}

    def homeContent(self, filter):
        data = self._get({"ac": "class"})
        classes = []
        for c in data.get("class") or []:
            classes.append({
                "type_id": str(c.get("type_id", "")),
                "type_name": c.get("type_name", ""),
                "type_flag": "",
            })
        return {"class": classes, "list": data.get("list") or [], "filters": {}}

    def homeVideoContent(self):
        data = self._get({"ac": "class"})
        return {"list": data.get("list") or []}

    def categoryContent(self, tid, pg, filter, extend):
        data = self._get({"ac": "class", "t": tid, "pg": pg})
        return self._page_result(data, pg)

    def detailContent(self, ids):
        vid = ids[0] if ids else ""
        if not vid:
            return {"list": []}
        data = self._get({"ac": "detail", "ids": vid})
        return {"list": data.get("list") or []}

    def searchContent(self, key, quick, pg="1"):
        # 搜索只认 wd 参数，ac=videolist 原样透传（同 JS 版）
        data = self._get({"ac": "videolist", "wd": key, "pg": pg})
        return self._page_result(data, pg)

    def searchContentPage(self, key, quick, pg):
        return self.searchContent(key, quick, pg)

    @staticmethod
    def _pick_url(data):
        cands = []
        if isinstance(data, dict):
            if data.get("url"):
                cands.append(data["url"])
            inner = data.get("data")
            if isinstance(inner, dict) and inner.get("url"):
                cands.append(inner["url"])
        elif isinstance(data, str):
            cands.append(data.strip())
        for c in cands:
            u = str(c or "").strip()
            if u.startswith("http://") or u.startswith("https://"):
                return u
        return None

    def _jx_play(self, pid):
        for jx in self.JX_LIST:
            try:
                r = self.session.get(jx + urllib.parse.quote(pid, safe=""), timeout=20)
                try:
                    data = r.json()
                except Exception:
                    data = r.text
                url = self._pick_url(data)
                if url:
                    ret = {"parse": 0, "jx": 0, "url": url, "header": {}}
                    if self.PAN_LINK_RE.search(url):
                        ret["header"] = {"User-Agent": self.UA_PAN}
                    return ret
            except Exception:
                continue
        return None

    def playerContent(self, flag, id, vipFlags):
        if id and self.MEDIA_RE.search(id):
            return {"parse": 0, "jx": 0, "url": id, "header": {}}
        ret = self._jx_play(id)
        if ret:
            return ret
        return {"parse": 1, "jx": 1, "url": id, "header": {}}

    def isVideoFormat(self, url):
        return False

    def manualVideoCheck(self):
        return False

    def localProxy(self, param):
        return [200, "video/mp2t", None, ""]
