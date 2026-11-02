import { createDecipheriv, createCipheriv } from 'node:crypto';
import req from '../../util/req.js';

const KEY = 'tvb_yunbo';
const NAME = 'TVB云播';
const DEFAULT_HOST = 'http://app.tuxianimg.com';
const DEFAULT_DATA_KEY = 'MickwrKuMickwrKu';
const PLAY_LINE_ORDER = [
  '4K', '至臻', '臻影', '鲸宝', '爱壹帆', '玫瑰', '咖啡4K', '2K', '蓝光', '1080', '超清', 'HD', '高清', 'VIP', '精品', '极速', '标清', '流畅',
];
const LINE_NAME_MAP = { class: '类型', area: '地区', lang: '语言', year: '年份', sort: '排序' };

function text(value) { return value == null ? '' : String(value).trim(); }
function pageOf(value) {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}
function listOf(value) { return Array.isArray(value) ? value : []; }
function bodyOf(request) { return request?.body || {}; }
function objectOf(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try { const parsed = JSON.parse(String(value || '')); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}
function normalize16(value) {
  const raw = Buffer.from(text(value), 'utf8');
  return raw.length < 16 ? Buffer.concat([raw, Buffer.alloc(16 - raw.length)]) : raw.subarray(0, 16);
}
function pkcs7Encrypt(value, key, iv) {
  const cipher = createCipheriv('aes-128-cbc', normalize16(key), normalize16(iv));
  return Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]).toString('base64');
}
function pkcs7Decrypt(value, key, iv) {
  const decipher = createDecipheriv('aes-128-cbc', normalize16(key), normalize16(iv));
  return Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8');
}
function cleanLineName(name) {
  if (!name) return '';
  let clean = String(name).replace(/[【\[\(（].*?[】\]）)]/g, '').replace(/\(\d+\)$/, '');
  clean = clean.replace(/\s*(?:HD|VIP|备用|推荐|极速|高清|标清|蓝光|超清|试看|抢先|预告|新版|旧版)\s*$/i, '');
  return clean.replace(/\s+/g, ' ').trim();
}
function lineRank(name, playOrder = PLAY_LINE_ORDER) {
  const clean = cleanLineName(name);
  const low = clean.toLowerCase();
  for (let i = 0; i < playOrder.length; i += 1) {
    const kw = playOrder[i].toLowerCase();
    if (low && (low === kw || low.startsWith(kw) || low.includes(kw))) return i;
  }
  const raw = String(name || '').toLowerCase();
  if (raw && raw !== low) {
    for (let i = 0; i < playOrder.length; i += 1) {
      const kw = playOrder[i].toLowerCase();
      if (raw === kw || raw.startsWith(kw) || raw.includes(kw)) return i;
    }
  }
  if (!clean) return 9999;
  const up = clean.toUpperCase();
  if (['至臻', '臻影', '鲸宝', '爱壹帆'].some((x) => clean.includes(x))) return 100;
  if (up.includes('4K') || clean.includes('2160')) return 200;
  if (up.includes('2K') || clean.includes('1440')) return 240;
  if (clean.includes('蓝光')) return 250;
  if (['1080', '超清', 'UHD'].some((x) => clean.includes(x))) return 350;
  if (up.includes('HD') || up.includes('VIP') || ['高清', '精品', '极速', '金牌'].some((x) => clean.includes(x))) return 400;
  if (clean.includes('☆')) return 500;
  if (clean.includes('自营')) return 600;
  if (['标清', '流畅', '普清'].some((x) => clean.includes(x))) return 700;
  return 4000;
}

function fixImageUrl(pic, host) {
  const value = text(pic);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${host}/${value.replace(/^\/+/, '')}`;
}

function parseExtend(value) {
  if (value && typeof value === 'object') return value;
  return objectOf(value);
}

function createRuntime(config = {}) {
  const runtime = {
    host: text(config.host || config.域名 || DEFAULT_HOST).replace(/\/$/, ''),
    key: text(config.datakey || config.数据密钥 || DEFAULT_DATA_KEY),
    iv: text(config.iv || config.数据密钥 || DEFAULT_DATA_KEY),
    ua: text(config.ua || 'okhttp/4.9.3'),
    version: text(config.version || '585'),
    initData: null,
  };
  runtime.headers = {
    'User-Agent': runtime.ua,
    'App-Os-Type': 'android',
    'App-Version-Code': runtime.version,
    'Accept-Encoding': 'gzip',
    Connection: 'Keep-Alive',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  };
  runtime.apiUrl = (endpoint) => `${runtime.host}/api/vod/${String(endpoint).replace(/^\/+/, '')}`;
  runtime.sign = (timestamp) => pkcs7Encrypt(String(timestamp), runtime.key, runtime.iv);
  runtime.post = async (endpoint, data = {}, signed = true) => {
    const headers = { ...runtime.headers };
    if (signed) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      headers['app-api-verify-time'] = timestamp;
      headers['app-api-verify-sign'] = runtime.sign(timestamp);
    }
    try {
      const response = await req.post(runtime.apiUrl(endpoint), new URLSearchParams(data), { headers, timeout: 15000, responseType: 'json' });
      const envelope = objectOf(response?.data);
      if (Number(envelope.code) !== 0) return null;
      if (!envelope.data) return envelope;
      return objectOf(pkcs7Decrypt(envelope.data, runtime.key, runtime.iv));
    } catch { return null; }
  };
  return runtime;
}

function makeHandlers(runtime) {
  async function init(request) {
    const body = bodyOf(request);
    const ext = parseExtend(body.extend ?? body.ext ?? body.config);
    if (ext.host || ext['域名']) runtime.host = text(ext.host || ext['域名']).replace(/\/$/, '');
    if (ext.datakey || ext['数据密钥']) runtime.key = runtime.iv = text(ext.datakey || ext['数据密钥']);
    runtime.initData = await runtime.post('init', {}, false) || {};
    return {};
  }

  async function ensureInit(request) {
    if (!runtime.initData) await init(request);
    return runtime.initData || {};
  }

  async function home(request) {
    const data = await ensureInit(request);
    const result = { class: [], filters: {}, list: [] };
    for (const type of listOf(data.type_list)) {
      const typeName = text(type.type_name);
      if (!typeName || ['全部', 'QQ', 'juo.one'].includes(typeName) || typeName.includes('企鹅群')) continue;
      const tid = text(type.type_id);
      result.class.push({ type_id: tid, type_name: typeName });
      const filterItems = [];
      for (const filter of listOf(type.filter_type_list)) {
        const values = listOf(filter.list);
        if (!values.length) continue;
        const key = text(filter.name);
        filterItems.push({ key, name: LINE_NAME_MAP[key] || key, value: values.map((v) => ({ n: text(v), v: text(v) })) });
      }
      if (!filterItems.some((item) => item.key === 'sort')) filterItems.push({ key: 'sort', name: '排序', value: ['最新', '最热', '最赞'].map((v) => ({ n: v, v })) });
      if (filterItems.length) result.filters[tid] = filterItems;
    }
    return result;
  }

  async function homeVod(request) {
    const data = await ensureInit(request);
    const videos = [];
    const seen = new Set();
    const add = (item) => {
      const id = text(item?.vod_id);
      if (!id || seen.has(id)) return;
      seen.add(id);
      videos.push({ vod_id: id, vod_name: text(item.vod_name), vod_pic: fixImageUrl(item.vod_pic, runtime.host), vod_remarks: text(item.vod_remarks) });
    };
    listOf(data.banner_list).forEach(add);
    listOf(data.recommend_list).forEach(add);
    listOf(data.type_list).forEach((type) => listOf(type.recommend_list).forEach(add));
    return { list: videos };
  }

  async function category(request) {
    const body = bodyOf(request);
    const page = pageOf(body.page);
    const filters = parseExtend(body.filters ?? body.extend ?? body.ext ?? body.filter);
    const data = await runtime.post('typeFilterVodList', {
      area: filters.area || '全部', year: filters.year || '全部', type_id: body.id ?? body.type_id ?? '', page: String(page),
      sort: filters.sort || '最新', lang: filters.lang || '全部', class: filters.class || '全部',
    });
    if (!data) return { page, pagecount: 1, limit: 90, total: 0, list: [] };
    const list = listOf(data.recommend_list).map((item) => ({ vod_id: item.vod_id, vod_name: text(item.vod_name), vod_pic: fixImageUrl(item.vod_pic, runtime.host), vod_remarks: text(item.vod_remarks) }));
    return { page, pagecount: 9999, limit: 90, total: Number(data.total) || 999999, list };
  }

  async function search(request) {
    const body = bodyOf(request);
    const page = pageOf(body.page);
    const data = await runtime.post('searchList', { keywords: text(body.wd ?? body.key), type_id: '0', page: String(page) });
    const list = listOf(data?.search_list).map((item) => ({ vod_id: item.vod_id, vod_name: text(item.vod_name), vod_pic: fixImageUrl(item.vod_pic, runtime.host), vod_remarks: `${text(item.vod_year)} ${text(item.vod_class)}`.trim() }));
    return { page, pagecount: 9999, limit: 90, total: 999999, list };
  }

  async function detail(request) {
    const rawId = request?.body?.id;
    const did = Array.isArray(rawId) ? rawId[0] : rawId;
    const data = await runtime.post('vodDetail', { vod_id: did });
    if (!data) return { list: [] };
    const vod = data.vod || {};
    const info = new Map(listOf(data.player_source_list).map((item) => [item.player_code, item]));
    const from = [];
    const blocks = [];
    const counts = new Map();
    listOf(data.vod_play_url_list).forEach((group) => {
      const playerCode = text(group.player_code);
      const playerInfo = info.get(playerCode) || {};
      let playerName = text(playerInfo.player_name) || playerCode;
      if (['防走丢', '群', '防失群', '官网'].some((kw) => playerName.includes(kw))) playerName = `线路${counts.size + 1}`;
      const count = (counts.get(playerName) || 0) + 1;
      counts.set(playerName, count);
      if (count > 1) playerName += count;
      const urls = listOf(group.urls).map((item, index) => {
        const parseApi = text(item.parse_api_url).replace(text(item.url), '') || text(playerInfo.parse_api);
        const payload = { url: text(item.url), parse_api: parseApi, token: text(item.token), vod_id: did, player_source_id: playerInfo.id ?? '', episode_index: item.episode_index ?? index, parse_type: text(playerInfo.player_parse_type || '1'), user_agent: text(playerInfo.user_agent), headers: playerInfo.headers || {} };
        return `${text(item.name)}$${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
      }).filter(Boolean);
      if (urls.length) { from.push(playerName); blocks.push(urls.join('#')); }
    });
    const paired = from.map((name, index) => ({ name, urls: blocks[index] })).sort((a, b) => lineRank(a.name) - lineRank(b.name));
    return { list: [{ vod_id: did, vod_name: text(vod.vod_name), vod_pic: fixImageUrl(vod.vod_pic, runtime.host), vod_actor: text(vod.vod_actor).replace('演员', ''), vod_director: text(vod.vod_director).replace('导演', ''), vod_content: text(vod.vod_content), vod_remarks: text(vod.vod_remarks), vod_year: vod.vod_year ? `${vod.vod_year}年` : '', vod_area: text(vod.vod_area), vod_play_from: paired.map((x) => x.name).join('$$$'), vod_play_url: paired.map((x) => x.urls).join('$$$') }] };
  }

  async function play(request) {
    let payload;
    try { payload = JSON.parse(Buffer.from(text(request?.body?.id), 'base64').toString('utf8')); } catch { return { parse: 0, url: text(request?.body?.id), header: {} }; }
    const headers = { 'User-Agent': payload.user_agent || 'okhttp/4.9.3' };
    Object.entries(payload.headers || {}).forEach(([key, value]) => {
      if (!value) return;
      if (key.toLowerCase() === 'user-agent' && !payload.user_agent) headers['User-Agent'] = value;
      else if (key.toLowerCase() === 'referer' && !headers.Referer) headers.Referer = value;
      else if (key.toLowerCase() !== 'user-agent') headers[key] = value;
    });
    const url = text(payload.url);
    try {
      if (payload.parse_api && payload.parse_api.includes('url=') && /^https?:/i.test(payload.parse_api)) {
        try {
          const response = await req.get(payload.parse_api + url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000, responseType: 'json' });
          const playUrl = response?.data?.url || response?.data?.data?.url;
          if (playUrl) return { parse: 0, url: playUrl, header: headers };
        } catch {}
        return { parse: 1, url: payload.parse_api, header: headers };
      }
      if (payload.parse_api && url) {
        const body = new URLSearchParams({ parse_api: payload.parse_api, url: pkcs7Encrypt(url, runtime.key, runtime.iv), player_parse_type: payload.parse_type || '1', token: payload.token || '', scene: '0' });
        const response = await runtime.post('vodParse', Object.fromEntries(body.entries()));
        const playUrl = response?.url || (response?.json ? objectOf(response.json).url : '');
        if (playUrl) return { parse: 0, url: playUrl, header: headers };
        return { parse: 1, url: '', header: headers };
      }
      if (payload.vod_id && !url) {
        const response = await runtime.post('vodParse', { vod_id: payload.vod_id, player_source_id: payload.player_source_id || '', episode_index: payload.episode_index ?? 0, scene: '0' });
        if (response?.trial && response.trial.current_episode_allowed === false) return { parse: 1, url: '', header: headers, msg: '试看限制' };
        const playUrl = response?.play_url || response?.url;
        return playUrl ? { parse: 0, url: playUrl, header: headers } : { parse: 1, url: '', header: headers };
      }
      return url ? { parse: 0, url, header: headers } : { parse: 1, url: '', header: headers };
    } catch (error) {
      return { parse: 1, url: '', header: headers, message: text(error?.message) };
    }
  }

  return { init, home, homeVod, category, search, detail, play };
}

export default function createSpider(name, config) {
  const runtime = createRuntime(config || {});
  const handlers = makeHandlers(runtime);
  return {
    meta: { key: KEY, name: NAME, type: 3 },
    api: async (fastify) => {
      fastify.post('/init', handlers.init);
      fastify.post('/home', handlers.home);
      fastify.post('/homeVod', handlers.homeVod);
      fastify.post('/category', handlers.category);
      fastify.post('/detail', handlers.detail);
      fastify.post('/play', handlers.play);
      fastify.post('/search', handlers.search);
    },
    check: async () => Boolean(await runtime.post('init', {}, false)),
  };
}
