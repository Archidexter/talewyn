// ══════════════════ захват книги/манги со страницы-читалки ══════════════════
// Контент-нейтральный адаптер: по вставленной ссылке достаёт главы и страницы через открытый
// JSON-API сайта-читалки и складывает мангу в CBZ, текст — в EPUB. Ленивый модуль (как catalog.js):
// грузится только когда ссылка распознана. Никаких названий сайтов в интерфейсе — детект по хосту.
// Экспорт: window.WebGrab = { detect, chapters, chapter, pageUrl, ... }.
(function () {
  'use strict';
  const API = 'https://api.cdnlibs.org/api';
  // ведущий поддомен читалки → внутренний id раздела API (в UI не показывается)
  const SITE = { manga: 1, slash: 2, yaoi: 2, ranobe: 3, hentai: 4, anime: 5 };
  const UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const capHttp = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) || null;

  // ссылка → { site, slug, host } либо null, если это не поддерживаемая читалка
  function detect(url) {
    let u; try { u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); } catch { return null; }
    const h = u.hostname.match(/(?:^|\.)([a-z]+)lib\.(?:me|org|social|top|life|club|in)$/i);
    if (!h) return null;
    const site = SITE[h[1].toLowerCase()];
    if (!site) return null;
    const s = u.pathname.match(/\/(?:manga|book|novel|ranobe|read)\/([0-9]+--[^/?#]+)/i)
           || u.pathname.match(/\/([0-9]+--[^/?#]+)/);
    if (!s) return null;
    return { site, slug: s[1], host: u.hostname };
  }

  // Токен аккаунта: некоторые разделы не отдают содержимое главы анонимно (список глав приходит,
  // а страницы — «Not Found»). С токеном те же запросы отвечают нормально. Ставится снаружи.
  let token = '';
  const setToken = t => { token = String(t || '').trim(); };

  async function apiGet(path, d) {
    const url = API + path;
    const headers = { 'Accept': 'application/json', 'Site-Id': String(d.site), 'User-Agent': UA,
                      'Referer': 'https://' + (d.host || 'mangalib.me') + '/' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (isNative && capHttp) {
      const r = await capHttp.request({ url, method: 'GET', responseType: 'json', headers,
                                        connectTimeout: 15000, readTimeout: 30000 });
      if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
      return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    }
    const res = await fetch(url, { headers });   // ПК/PWA: сработает, где есть CORS
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  const info = d => apiGet('/manga/' + d.slug + '?fields[]=summary&fields[]=authors&fields[]=cover', d)
                    .then(r => r.data || {});
  const chapters = d => apiGet('/manga/' + d.slug + '/chapters', d).then(r => r.data || []);
  const chapter = (d, ch) => apiGet('/manga/' + d.slug + '/chapter?number=' + encodeURIComponent(ch.number)
                    + '&volume=' + encodeURIComponent(ch.volume) + (ch.branch_id ? '&branch_id=' + ch.branch_id : ''), d)
                    .then(r => r.data || {});

  // адрес сервера картинок берём один раз из констант API (с запасным дефолтом)
  let imgServers = null;
  async function imageBase(d) {
    if (!imgServers) {
      try { imgServers = (await apiGet('/constants?fields[]=imageServers', d)).data.imageServers || []; }
      catch { imgServers = []; }
    }
    // В ответе перечислены серверы ВСЕХ разделов, и id повторяются (main встречается несколько раз).
    // Берём только заявленные для нашего раздела (site_ids) — иначе уедем на чужой CDN и получим 403.
    const mine = imgServers.filter(s => Array.isArray(s.site_ids) ? s.site_ids.includes(d.site) : true);
    const pool = mine.length ? mine : imgServers;
    const pick = pool.find(s => s.id === 'main') || pool.find(s => s.id === 'secondary')
              || pool.find(s => s.id === 'compress') || pool[0];
    return (pick && pick.url) || 'https://img2.imglib.info';
  }
  async function pageUrl(d, page) {
    const base = (await imageBase(d)).replace(/\/+$/, '');
    return base + '/' + String(page.url || '').replace(/^\/+/, '');
  }

  // ── сборка файлов: манга → CBZ (zip картинок), текст → EPUB. fflate — ES-модуль, берём import()'ом ──
  let _ff = null;
  async function ff() { if (!_ff) _ff = await import(new URL('fflate.js', location.href).href); return _ff; }
  const xml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // entries: [{ name, bytes:Uint8Array }] → CBZ (zip без сжатия — картинки уже сжаты)
  async function buildCbz(entries) {
    const { zipSync } = await ff();
    const files = {};
    for (const e of entries) files[e.name] = [e.bytes, { level: 0 }];
    return zipSync(files, {});
  }

  // meta: {title, author, slug}; chapters: [{title, html}] → минимальный EPUB3
  async function buildEpub(meta, chapters) {
    const { zipSync, strToU8 } = await ff();
    const uid = 'grab-' + (meta.slug || meta.title || 'book');
    const items = chapters.map((c, i) => ({ id: 'c' + i, file: 'c' + i + '.xhtml', title: c.title || ('Глава ' + (i + 1)), html: c.html || '' }));
    const opf = '<?xml version="1.0" encoding="utf-8"?>\n'
      + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">'
      + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
      + '<dc:identifier id="uid">' + xml(uid) + '</dc:identifier>'
      + '<dc:title>' + xml(meta.title || 'Без названия') + '</dc:title>'
      + '<dc:language>ru</dc:language>'
      + (meta.author ? '<dc:creator>' + xml(meta.author) + '</dc:creator>' : '')
      + '</metadata><manifest>'
      + '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
      + items.map(it => '<item id="' + it.id + '" href="' + it.file + '" media-type="application/xhtml+xml"/>').join('')
      + '</manifest><spine>' + items.map(it => '<itemref idref="' + it.id + '"/>').join('') + '</spine></package>';
    const nav = '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>'
      + xml(meta.title || '') + '</title></head><body><nav epub:type="toc"><ol>'
      + items.map(it => '<li><a href="' + it.file + '">' + xml(it.title) + '</a></li>').join('') + '</ol></nav></body></html>';
    const container = '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
    const files = {
      'mimetype': [strToU8('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': strToU8(container),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/nav.xhtml': strToU8(nav),
    };
    for (const it of items) {
      files['OEBPS/' + it.file] = strToU8('<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>'
        + xml(it.title) + '</title></head><body><h2>' + xml(it.title) + '</h2>' + it.html + '</body></html>');
    }
    return zipSync(files, {});
  }

  window.WebGrab = { detect, info, chapters, chapter, imageBase, pageUrl, buildCbz, buildEpub, setToken };
})();
