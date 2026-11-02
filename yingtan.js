import { createDecipheriv } from 'node:crypto';
import req from '../../util/req.js';

const KEY = 'yingtan4k';
const NAME = '影探4K';
const DEFAULT_HOST = 'http://cms.lyyytv.cn';
const CMS_KEY = 'wP5bvxoc3yv7FoBQENFZuAF0EUYr4LTy';
const PARSE_API = 'http://fys.lyyytv.cn/api/index?parsesId=3&appid=10001&videoUrl=';
const HEADERS = { 'User-Agent': 'okhttp/4.12.0' };
const PARSE_HEADERS = { 'User-Agent': 'okhttp/4.12.0', 'Accept-Encoding': 'identity' };
const DEC_PREFIX = 'https://baidu.con/';
const PAGE_LIMIT = 20;
const FILTER_NAMES = {
  class: '类型', area: '地区', lang: '语言', year: '年份',
  letter: '字母', by: '排序', sort: '顺序',
};
const HOME_CACHE_TTL = 6 * 3600 * 1000;
const PLAY_CACHE_TTL = 120 * 1000;
const homeCache = new Map();
const playCache = new Map();

function text(value) {
  return value == null ? '' : String(value).trim();
}

function pageOf(value) {
  const match = /^\s*[+-]?\d+/.exec(value == null ? '' : String(value));
  const page = match ? Number.parseInt(match[0], 10) : 0;
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function objectOf(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function base64Decode(value) {
  const clean = text(value).replace(/\s+/g, '');
  if (!clean || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) return null;
  try { return Buffer.from(clean, 'base64'); } catch { return null; }
}

function decryptCbc(value, key, iv) {
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([decipher.update(value), decipher.final()]);
}

function decryptLvdou(value) {
  const original = text(value);
  if (!original.startsWith('lvdou+') || !CMS_KEY) return original;
  try {
    const encrypted = base64Decode(original.slice(6));
    if (!encrypted) return original;
    const key = CMS_KEY.slice(0, 16);
    const iv = CMS_KEY.length >= 32 ? CMS_KEY.slice(16, 32) : key;
    const result = decryptCbc(encrypted, key, iv).toString('utf8').trim();
    return result.startsWith('http') ? result : original;
  } catch {
    return original;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(text(value));
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isSiteUrl(value) {
  if (!isHttpUrl(value)) return false;
  const host = new URL(text(value)).hostname.toLowerCase();
  return host === 'lyyytv.cn' || host.endsWith('.lyyytv.cn');
}

function isLdmaxUrl(value) {
  return /^https?:\/\/ldmax\.cooom\//i.test(text(value));
}

function decryptLdmax(value, depth = 0) {
  if (depth > 5) return '';
  let url = text(value);
  const decoded = base64Decode(url);
  if (decoded) url = decoded.toString('utf8').replace(/\s+/g, '');
  if (!isLdmaxUrl(url)) return url;
  const path = url.replace(/^https?:\/\/ldmax\.cooom\//i, '');
  if (path.length <= 16) return '';
  try {
    const key = path.slice(0, 16).split('').reverse().join('');
    const encrypted = base64Decode(path.slice(16));
    if (!encrypted || encrypted.length % 16) return '';
    const result = decryptCbc(encrypted, key, key).toString('utf8').replace(/[\x01-\x10]+$/g, '').trim();
    return isLdmaxUrl(result) ? decryptLdmax(result, depth + 1) : result;
  } catch {
    return '';
  }
}

function findUrl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of ['url', 'playUrl', 'link']) {
    if (value[key]) return text(value[key]);
  }
  return findUrl(value.data);
}

function resolveParse(body) {
  const raw = text(body);
  if (!raw) return '';
  let candidate = raw;
  if (raw.startsWith('{')) {
    const found = findUrl(objectOf(raw));
    if (found) candidate = found;
  }
  if (!candidate.startsWith(DEC_PREFIX)) return candidate;
  const rest = candidate.slice(DEC_PREFIX.length);
  if (rest.length <= 16) return '';
  const key = rest.slice(0, 16);
  const cipherText = rest.slice(16);
  for (const encrypted of [base64Decode(cipherText), Buffer.from(cipherText, 'latin1')]) {
    if (!encrypted || encrypted.length % 16) continue;
    try {
      const result = decryptCbc(encrypted, key, key).toString('utf8').trim();
      if (result.startsWith('http')) return result;
    } catch {}
  }
  return '';
}

function parseUrl(raw) {
  if (!raw) return Promise.resolve('');
  const target = PARSE_API + encodeURIComponent(raw).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return (async () => {
    for (let round = 0; round < 3; round += 1) {
      if (round) await new Promise((resolve) => setTimeout(resolve, round * 350));
      try {
        const response = await req.get(target, { headers: PARSE_HEADERS, timeout: 30000, responseType: 'text' });
        if (response?.status >= 200 && response.status < 300 && response.data) {
          const resolved = resolveParse(response.data);
          if (resolved.startsWith('http')) return resolved;
        }
      } catch {}
    }
    return '';
  })();
}

function isMediaUrl(value) {
  if (!isHttpUrl(value)) return false;
  return /\.(?:mp4|m3u8?|flv|avi|mkv|ts|mov|wmv|webm|m4v|mpd)$/i.test(new URL(text(value)).pathname);
}

function makeCms(host) {
  return async function cms(path, params = {}) {
    const url = new URL(`${host}/api.php/app/${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await req.get(url.toString(), { headers: HEADERS, timeout: 15000, responseType: 'json' });
    const data = objectOf(response?.data);
    if (!Object.keys(data).length) throw new Error('影探4K：接口未返回有效 JSON');
    if (data.code !== undefined && ![1, 200].includes(Number(data.code))) throw new Error('影探4K：CMS 请求失败');
    return data;
  };
}

function paginated(data, requestedPage) {
  const result = { ...(data || {}) };
  const list = listOf(result.list);
  const page = pageOf(result.page ?? requestedPage);
  const limitRaw = Number.parseInt(result.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : PAGE_LIMIT;
  const pagecountRaw = Number.parseInt(result.pagecount, 10);
  const hasPagecount = Number.isFinite(pagecountRaw) && pagecountRaw > 0;
  const pagecount = hasPagecount ? pagecountRaw : page + (list.length >= limit ? 1 : 0);
  const totalRaw = result.total;
  const totalNumber = Number.parseInt(totalRaw, 10);
  const hasTotal = totalRaw !== undefined && Number.isFinite(totalNumber) && totalNumber >= 0;
  const total = hasPagecount && hasTotal
    ? totalNumber
    : (page - 1) * limit + list.length + (pagecount > page ? 1 : 0);
  return { page, pagecount, limit, total, list };
}

function normalizeExtend(request) {
  const body = request?.body || {};
  const raw = body.filters ?? body.extend ?? body.ext ?? body.filter ?? {};
  if (typeof raw === 'string') return objectOf(raw);
  return raw && typeof raw === 'object' ? raw : {};
}

function createHandlers(host) {
  const cms = makeCms(host);

  async function home() {
    const cacheKey = `${KEY}_home_${host}`;
    const cached = homeCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    const data = await cms('nav', { token: '' });
    const classes = [];
    const filters = {};
    for (const item of listOf(data.list)) {
      if (!item || item.type_id == null || !text(item.type_name)) continue;
      const tid = text(item.type_id);
      classes.push({ type_id: tid, type_name: text(item.type_name) });
      const ext = objectOf(item.type_extend);
      const groups = [];
      for (const [key, name] of Object.entries(FILTER_NAMES)) {
        const values = [...new Set(text(ext[key]).split(',').map(text).filter(Boolean))];
        if (values.length) groups.push({ key, name, init: '', value: [{ n: '全部', v: '' }, ...values.map((v) => ({ n: v, v }))] });
      }
      if (groups.length) filters[tid] = groups;
    }
    const value = { class: classes, filters, list: [] };
    if (classes.length) homeCache.set(cacheKey, { expires: Date.now() + HOME_CACHE_TTL, value });
    return value;
  }

  async function homeVod() {
    const data = await cms('index_video', { token: '' });
    return { list: listOf(data.list).flatMap((item) => listOf(item?.vlist)) };
  }

  async function category(request) {
    const body = request?.body || {};
    const page = pageOf(body.page);
    const tid = text(body.id ?? body.type_id);
    if (!tid) return paginated({ list: [] }, page);
    const params = { tid, pg: String(page), limit: '18' };
    const ext = normalizeExtend(request);
    for (const key of Object.keys(FILTER_NAMES)) {
      const value = text(ext[key]);
      if (value && value !== 'all') params[key] = value;
    }
    return paginated(await cms('video', params), page);
  }

  function playlist(value) {
    return text(value).split('#').map((entry) => {
      const split = entry.indexOf('$');
      if (split <= 0 || !text(entry.slice(split + 1))) return '';
      return `${text(entry.slice(0, split))}$${decryptLvdou(entry.slice(split + 1))}`;
    }).filter(Boolean).join('#');
  }

  async function detail(request) {
    const ids = Array.isArray(request?.body?.id) ? request.body.id : [request?.body?.id];
    const list = [];
    for (const rawId of ids.filter(Boolean)) {
      const vid = text(rawId);
      const data = (await cms('video_detail', { id: vid })).data;
      if (!data || typeof data !== 'object') continue;
      const players = data.vod_url_with_player;
      const vod = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'vod_url_with_player'));
      const names = text(vod.vod_play_from).split('$$$');
      const sources = Array.isArray(players)
        ? players
        : text(vod.vod_play_url).split('$$$').map((url, index) => ({ name: names[index] || '', url }));
      const froms = [];
      const urls = [];
      sources.forEach((source, index) => {
        if (!source || typeof source !== 'object') return;
        const url = playlist(source.url);
        if (!url) return;
        const name = text(source.name) || text(source.code) || `线路${index + 1}`;
        froms.push(name.replace(/[$#]/g, ' '));
        urls.push(url);
      });
      list.push({ ...vod, vod_id: vod.vod_id ?? vid, vod_play_from: froms.join('$$$'), vod_play_url: urls.join('$$$') });
    }
    return { list };
  }

  async function search(request) {
    const body = request?.body || {};
    const page = pageOf(body.page);
    const wd = text(body.wd ?? body.key);
    if (!wd) return paginated({ list: [] }, page);
    const data = await cms('search', { text: wd, pg: String(page) });
    return paginated({ ...data, list: listOf(data.list).filter((item) => item && typeof item === 'object').map((item) => {
      const { type, ...rest } = item;
      return rest;
    }) }, page);
  }

  async function play(request) {
    let original = decryptLvdou(request?.body?.id);
    if (!original) return { parse: 0, url: '', header: PARSE_HEADERS };
    if (isLdmaxUrl(original)) original = decryptLdmax(original) || original;
    const cached = playCache.get(original);
    if (cached && cached.expires > Date.now()) return { parse: 0, url: cached.url, header: PARSE_HEADERS };
    const resolved = await parseUrl(original);
    if (resolved) playCache.set(original, { expires: Date.now() + PLAY_CACHE_TTL, url: resolved });
    return { parse: 0, url: resolved, header: PARSE_HEADERS };
  }

  return { home, homeVod, category, detail, search, play };
}

export default function createSpider(name, config) {
  const host = text(config?.host || config?.域名 || DEFAULT_HOST).replace(/\/$/, '');
  const handlers = createHandlers(host);
  return {
    meta: { key: KEY, name: NAME, type: 3 },
    api: async (fastify) => {
      fastify.post('/init', async () => ({}));
      fastify.post('/home', handlers.home);
      fastify.post('/homeVod', handlers.homeVod);
      fastify.post('/category', handlers.category);
      fastify.post('/detail', handlers.detail);
      fastify.post('/play', handlers.play);
      fastify.post('/search', handlers.search);
    },
    check: async () => {
      try { await handlers.home(); return true; } catch { return false; }
    },
  };
}
