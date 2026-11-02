import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import req from '../../util/req.js';

const KEY = 'dongpiandi';
const DEFAULT_HOST = 'https://dongpian17.com';
const DEFAULT_NAME = '懂片帝';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const SIGN_KEY = '8b9a908a05eac640e1ee06f52acaa741bfe4ba9e004eeffdbeb635e532e06666';
const KINDS = [
  ['all', '全部'], ['movie', '电影'], ['series', '剧集'],
  ['short_drama', '短剧'], ['anime', '动漫'], ['variety', '综艺'],
];
const WINDOWS = [['day', '日榜'], ['week', '周榜'], ['month', '月榜'], ['total', '总榜']];

function text(value, fallback = '') { const result = String(value ?? '').trim(); return result || fallback; }
function pageOf(value) { const page = Number.parseInt(value, 10); return Number.isFinite(page) && page > 0 ? page : 1; }
function listOf(value) { return Array.isArray(value) ? value : []; }
function bodyOf(request) { return request?.body || {}; }
function objectOf(value) {
  if (value && typeof value === 'object') return value;
  try { const parsed = JSON.parse(String(value || '')); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}
function normalizeExtend(request) {
  const value = bodyOf(request).filters ?? bodyOf(request).extend ?? bodyOf(request).ext ?? bodyOf(request).filter;
  if (typeof value === 'string') return objectOf(value);
  return value && typeof value === 'object' ? value : {};
}
function cookiePairs(cookie) {
  return String(cookie || '').split(';').map((pair) => pair.trim()).filter((pair) => pair.includes('=')).map((pair) => pair.slice(0, pair.indexOf('=')));
}
function responseCookies(response) {
  const headers = response?.headers || {};
  const setCookie = headers['set-cookie'] || headers['Set-Cookie'];
  if (!setCookie) return [];
  return Array.isArray(setCookie) ? setCookie : [setCookie];
}

function createRuntime(config = {}) {
  const runtime = {
    host: text(config.host, DEFAULT_HOST).replace(/\/$/, ''),
    name: text(config.name, DEFAULT_NAME),
    ua: text(config.ua, DEFAULT_UA),
    account: text(config.account),
    password: text(config.password),
    cookies: new Map(),
    loggedIn: false,
  };

  function applyCookie(value) {
    for (const part of String(value || '').split(';')) {
      const split = part.indexOf('=');
      if (split > 0) runtime.cookies.set(part.slice(0, split).trim(), part.slice(split + 1).trim());
    }
    runtime.loggedIn = runtime.cookies.size > 0;
  }

  function cookieHeader() {
    return [...runtime.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  function captureCookies(response) {
    for (const value of responseCookies(response)) {
      const pair = String(value).split(';', 1)[0];
      const split = pair.indexOf('=');
      if (split > 0) runtime.cookies.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
    }
  }

  function headers(method, path, search = '') {
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString('hex');
    const message = `${method}\n${path}${search}\n${timestamp}\n${nonce}`;
    const signature = createHmac('sha256', Buffer.from(SIGN_KEY, 'utf8')).update(message).digest('hex');
    return {
      'User-Agent': runtime.ua,
      Accept: 'application/json',
      'x-ai-movie-client-name': 'movie-search-frontend',
      'x-ai-movie-client-version': '1.0.0',
      'x-ai-movie-build-version': 'dongpiandi-v2026.10.04.1-episode-resume-efd9a7f2e87e-web',
      'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
      'x-ai-movie-timestamp': timestamp,
      'x-ai-movie-nonce': nonce,
      'x-ai-movie-signature': signature,
      ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
    };
  }

  async function request(method, path, search = '', data) {
    const url = `${runtime.host}${path}${search}`;
    try {
      const options = { headers: headers(method, path, search), timeout: 15000, responseType: 'json', validateStatus: () => true };
      const response = method === 'GET'
        ? await req.get(url, options)
        : await req.post(url, data, { ...options, headers: { ...options.headers, 'Content-Type': 'application/json' } });
      captureCookies(response);
      return objectOf(response?.data);
    } catch { return {}; }
  }

  runtime.setCookie = applyCookie;
  runtime.get = (path, search = '') => request('GET', path, search);
  runtime.post = (path, search, data) => request('POST', path, search, data);

  async function login() {
    if (!runtime.account || !runtime.password) return false;
    const data = await runtime.post('/v1/users/password/login', '', { account: runtime.account, password: runtime.password });
    if (!data.error && runtime.cookies.size) { runtime.loggedIn = true; return true; }
    return false;
  }

  async function anonymousLogin() {
    const response = await req.post(`${runtime.host}/v1/users/anonymous`, { anonymous_id: `web_${randomUUID()}` }, {
      headers: { ...headers('POST', '/v1/users/anonymous'), 'Content-Type': 'application/json' },
      timeout: 15000, responseType: 'json', validateStatus: () => true,
    });
    captureCookies(response);
    runtime.loggedIn = Number(response?.status) === 200 || Number(response?.status) === 201;
    return runtime.loggedIn;
  }

  runtime.ensureLogin = async () => {
    if (runtime.loggedIn) return true;
    return runtime.account && runtime.password ? login() : anonymousLogin();
  };
  runtime.applyCookie = applyCookie;
  return runtime;
}

function isOfficialLine(line) {
  const label = text(line?.label);
  const provider = text(line?.provider_id).toLowerCase();
  return label.includes('官方') || provider.startsWith('official') || provider.startsWith('bytevod');
}

function shortLineName(label) {
  if (!label.includes('官方')) return label;
  const base = label.split('·')[0].trim();
  for (const segment of base.split('-').reverse()) {
    if (segment.includes('官方')) {
      let name = segment.trim();
      if (base.toUpperCase().includes('4K') && !name.toUpperCase().startsWith('4K')) name = `4K${name}`;
      return name;
    }
  }
  return label;
}

function parseCard(card = {}) {
  return {
    vod_id: text(card.id),
    vod_name: text(card.title || card.normalized_title),
    vod_pic: text(card.poster_url || card.backdrop_url),
    vod_remarks: text(card.remarks),
    vod_year: text(card.year),
    vod_area: text(card.area),
    vod_director: listOf(card.directors).join('、'),
    vod_actor: listOf(card.actors).join('、'),
    vod_content: text(card.content || card.description || card.blurb),
  };
}

function makeHandlers(runtime) {
  async function init(request) {
    const body = bodyOf(request);
    const ext = typeof body.extend === 'string' ? objectOf(body.extend) : (body.extend || body.config || {});
    runtime.host = text(ext.host, runtime.host).replace(/\/$/, '');
    runtime.name = text(ext.name, runtime.name);
    runtime.ua = text(ext.ua, runtime.ua);
    runtime.account = text(ext.account, runtime.account);
    runtime.password = text(ext.password, runtime.password);
    if (ext.cookie) runtime.setCookie(ext.cookie);
    return {};
  }

  async function home(request) {
    const filters = {};
    if (bodyOf(request).filter) {
      for (const [tid] of KINDS) filters[tid] = [{ key: 'window', name: '榜单', value: WINDOWS.map(([v, n]) => ({ n, v })) }];
    }
    return { class: KINDS.map(([type_id, type_name]) => ({ type_id, type_name })), filters, list: [] };
  }

  async function homeVod() {
    const data = await runtime.get('/v1/feed/home', '?scope=public&mode=preview&sections=3&cards=12');
    const sections = listOf(data.sections);
    let target = sections.find((section) => section.id === 'feed_sec_everyone_watching' || section.type === 'trend');
    if (!target) target = sections.find((section) => listOf(section.cards).length);
    return { list: listOf(target?.cards).map(parseCard) };
  }

  async function category(request) {
    const body = bodyOf(request);
    const page = pageOf(body.page);
    const kind = text(body.id ?? body.type_id);
    const filters = normalizeExtend(request);
    const params = new URLSearchParams({ sort: 'trending', window: text(filters.window, 'day'), page: String(page), limit: '20' });
    if (kind && kind !== 'all') params.set('kind', kind);
    const data = await runtime.get('/v1/browse/catalog', `?${params.toString()}`);
    const list = listOf(data.cards).map(parseCard);
    const hasMore = Boolean(data.pagination?.has_more);
    const pagecount = hasMore ? page + 1 : page;
    return { page, pagecount, limit: 20, total: pagecount * 20, list };
  }

  async function fetchAllEpisodes(id, inline) {
    const episodes = [...inline];
    let offset = episodes.length;
    try {
      while (true) {
        const data = await runtime.get(`/v1/catalog/${encodeURIComponent(id)}/episodes`, `?limit=48&offset=${offset}`);
        const batch = listOf(data.episodes);
        if (!batch.length) break;
        episodes.push(...batch);
        if (!data.episode_pagination?.has_more) break;
        offset += batch.length;
      }
    } catch {}
    return episodes;
  }

  async function detail(request) {
    const rawId = bodyOf(request).id;
    const id = text(Array.isArray(rawId) ? rawId[0] : rawId);
    if (!id) return { list: [] };
    const data = await runtime.get(`/v1/catalog/${encodeURIComponent(id)}`);
    const card = data.card || data;
    let episodes = listOf(card.episodes);
    const episodeCount = Number(card.episode_count) || episodes.length;
    if (episodeCount > episodes.length) episodes = await fetchAllEpisodes(id, episodes);
    const playUrls = episodes.map((episode) => {
      const title = text(episode.title || episode.display_name || `第${episode.number || ''}集`);
      return episode.token ? `${title}$${episode.token}` : '';
    }).filter(Boolean);
    const vod = parseCard(card);
    vod.vod_id = id;

    let lines = [];
    const firstToken = episodes[0]?.token;
    if (firstToken) {
      const resolved = await runtime.get(`/v1/playback/resolve/${encodeURIComponent(firstToken)}`, '?view=compact');
      lines = listOf(resolved.line_options).filter(isOfficialLine);
    }
    lines.sort((a, b) => Number(!text(a.label).toUpperCase().includes('4K')) - Number(!text(b.label).toUpperCase().includes('4K')));
    if (lines.length && playUrls.length) {
      const used = new Map();
      const from = [];
      const blocks = [];
      for (const line of lines) {
        const lineId = text(line.id);
        if (!lineId) continue;
        let label = shortLineName(text(line.label || line.play_from || line.provider_id, '线路'));
        const count = (used.get(label) || 0) + 1;
        used.set(label, count);
        if (count > 1) label = `${label}${count}`;
        from.push(label);
        blocks.push(playUrls.map((entry) => {
          const split = entry.indexOf('$');
          return `${entry.slice(0, split)}$${entry.slice(split + 1)}@@${lineId}`;
        }).join('#'));
      }
      vod.vod_play_from = from.length ? from.join('$$$') : runtime.name;
      vod.vod_play_url = from.length ? blocks.join('$$$') : playUrls.join('#');
    } else {
      vod.vod_play_from = runtime.name;
      vod.vod_play_url = playUrls.join('#');
    }
    return { list: [vod] };
  }

  async function resolveLine(ticket, retried = false) {
    let data = await runtime.post('/v1/playback/resolve-line', '?view=compact', { ticket });
    if (data.code === 'playback_user_session_required' && !retried && await runtime.ensureLogin()) {
      data = await runtime.post('/v1/playback/resolve-line', '?view=compact', { ticket });
    }
    return data.line || {};
  }

  async function play(request) {
    const body = bodyOf(request);
    const flag = text(body.flag);
    const id = text(body.id);
    const split = id.indexOf('@@');
    const token = split >= 0 ? id.slice(0, split) : id;
    const lineId = split >= 0 ? id.slice(split + 2) : '';
    const data = await runtime.get(`/v1/playback/resolve/${encodeURIComponent(token)}`, '?view=compact');
    const lines = listOf(data.line_options);
    let playUrl = '';
    let urlKind = '';
    let target = lineId ? lines.find((line) => String(line.id) === lineId) : null;
    if (!target && flag && flag !== runtime.name) {
      target = lines.find((line) => text(line.label) === flag || text(line.play_from) === flag || shortLineName(text(line.label)) === flag);
    }
    if (target) {
      if (target.url_kind === 'm3u8' && !target.resolve_required && target.url) {
        playUrl = target.url;
        urlKind = 'm3u8';
      } else {
        const ticket = text(target.url).replace('resolve://', '');
        if (ticket) {
          const resolved = await resolveLine(ticket);
          if (resolved.url) { playUrl = resolved.url; urlKind = resolved.url_kind || ''; }
        }
      }
    }
    const official = lines.filter(isOfficialLine);
    const fallback = [...official, ...lines.filter((line) => !isOfficialLine(line))];
    if (!playUrl) {
      const candidates = fallback.filter((line) => line.selected);
      for (const line of candidates.length ? candidates : fallback) {
        const ticket = text(line.url).replace('resolve://', '');
        if (!ticket) continue;
        const resolved = await resolveLine(ticket);
        if (resolved.url) { playUrl = resolved.url; urlKind = resolved.url_kind || ''; break; }
      }
    }
    if (!playUrl) {
      const direct = fallback.find((line) => line.url_kind === 'm3u8' && !line.resolve_required && line.url);
      if (direct) { playUrl = direct.url; urlKind = 'm3u8'; }
    }
    void urlKind;
    return { parse: 0, playUrl: '', url: playUrl, header: { 'User-Agent': runtime.ua } };
  }

  async function search(request) {
    const keyword = text(bodyOf(request).wd ?? bodyOf(request).key);
    if (!keyword) return { page: pageOf(bodyOf(request).page), pagecount: 1, limit: 20, total: 0, list: [] };
    const params = new URLSearchParams({ q: keyword, page: String(pageOf(bodyOf(request).page)), limit: '20' });
    const data = await runtime.get('/v1/browse/catalog', `?${params.toString()}`);
    const list = listOf(data.cards).map(parseCard);
    return { page: pageOf(bodyOf(request).page), pagecount: 1, limit: 20, total: list.length, list };
  }

  return { init, home, homeVod, category, detail, play, search };
}

export default function createSpider(name, config) {
  const runtime = createRuntime(config || {});
  const handlers = makeHandlers(runtime);
  return {
    meta: { key: KEY, name: text(config?.name, DEFAULT_NAME), type: 3 },
    api: async (fastify) => {
      fastify.post('/init', handlers.init);
      fastify.post('/home', handlers.home);
      fastify.post('/homeVod', handlers.homeVod);
      fastify.post('/category', handlers.category);
      fastify.post('/detail', handlers.detail);
      fastify.post('/play', handlers.play);
      fastify.post('/search', handlers.search);
    },
    check: async () => {
      try {
        const data = await runtime.get('/v1/feed/home', '?scope=public&mode=preview&sections=1&cards=1');
        return Array.isArray(data?.sections);
      } catch { return false; }
    },
  };
}
