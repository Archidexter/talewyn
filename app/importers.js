'use strict';
/* AD.Talewyn — импорт книг: EPUB, FB2 (в т.ч. .fb2.zip) и .fbook.
   Всё выполняется в браузере: ZIP распаковывается через DecompressionStream,
   XML/HTML разбирается DOMParser-ом (терпимым к битой разметке фан-файлов).
   Результат — нормализованный объект книги, который сохраняет app.js:
   { title, author, lang, cover: Blob|null,
     toc: [{t, ch?|kids?}], chapters: [{title, html, plain}],
     images: Map(имя → Blob), progress: {last, byIdx}|null }            */

window.Importers = (() => {

const td = new TextDecoder();
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
};
const extMime = name =>
  MIME[(String(name).split('.').pop() || '').toLowerCase()] || 'image/jpeg';
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// фиксированный список жанров + сведение произвольных subject/FB2-кодов к нему
const GENRES = ['Фэнтези', 'Фантастика', 'Ранобэ', 'Детектив', 'Ужасы', 'Приключения',
  'Роман', 'Проза', 'Классика', 'Поэзия', 'Драма', 'Юмор', 'Детская',
  'Научпоп', 'Биографии', 'Религия', 'Манга', 'Другое'];
function mapGenre(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return '';
  const has = (...w) => w.some(x => s.includes(x));

  // ── СОДЕРЖАНИЕ важнее формата (ранобэ/манга — это формат, а не жанр). ──
  // Порядок значим: сначала «крадущие» узкие корзины (детская, юмор), затем
  // жанровая проза, и лишь в самом конце — форматные ярлыки (манга/ранобэ).
  // FB2-коды идут семействами (det_*, adv_*, sf_*, prose_*, sci_*, nonf_*…),
  // поэтому ловим и по префиксу с подчёркиванием, и по «человеческим» словам.

  // Детская/подростковая — раньше остальных: child_sf/child_verse/child_det
  // это в первую очередь детские книги, а не НФ/поэзия/детектив.
  if (has('child', 'детск', 'сказк', 'fairy', 'юношеск', 'подростк', 'young adult', 'teen'))
    return 'Детская';
  // Юмор/сатира. 'humor_' с подчёркиванием, чтобы sf_humor осталось фантастикой.
  if (has('humour', 'юмор', 'анекдот', 'сатир', 'satire') || s.startsWith('humor'))
    return 'Юмор';
  // Фэнтези
  if (has('fantasy', 'фэнтези', 'фентези', 'фэнтэзи', 'magic', 'магия', 'магии', 'волшебств',
    'меч', 'эльф', 'гном', 'орк', 'дракон', 'иной мир', 'другой мир', 'иномир', 'попаданц',
    'реинкарнац', 'перерожд', 'isekai', 'исекай', 'рыцар', 'королевств')) return 'Фэнтези';
  // Фантастика (в т.ч. голый код 'sf' и все sf_* кроме sf_fantasy/sf_humor выше)
  if (has('sci-fi', 'sci_fi', 'science fiction', 'фантаст', 'sf_', 'киберпанк', 'cyberpunk',
    'космос', 'звездолёт', 'галактик', 'робот', 'андроид', 'постапокал', 'стимпанк', 'steampunk',
    'антиутоп', 'dystopi') || /(^|[^a-zа-яё])sf($|[^a-zа-яё])/.test(s)) return 'Фантастика';
  // Детектив/триллер — все det_*
  if (has('det_', 'detective', 'детектив', 'триллер', 'thriller', 'mystery', 'крими',
    'crime', 'расследов', 'шпион', 'espionage')) return 'Детектив';
  // Ужасы/мистика
  if (has('horror', 'ужас', 'мистик', 'хоррор')) return 'Ужасы';
  // Приключения — все adv_*
  if (has('adv_', 'adventure', 'приключ', 'вестерн', 'western', 'боевик')) return 'Приключения';
  // Классика/античность
  if (has('classic', 'классик', 'antique', 'антично', 'миф', 'myth', 'эпос', 'фольклор', 'folklore'))
    return 'Классика';
  // Роман/любовное — все love_*
  if (has('romance', 'любов', 'love', 'мелодрам', 'эрот', 'erotic')) return 'Роман';
  // Проза (современная/историческая/военная и пр.). 'fiction' — общий ярлык худлита,
  // но не 'non-fiction' (её ловит Научпоп ниже).
  if (has('prose', 'проза', 'современ', 'mainstream', 'мейнстрим', 'реализм', 'contemporary')
    || (has('fiction') && !has('non-fiction', 'nonfiction', 'nonf'))) return 'Проза';
  // Поэзия
  if (has('poetry', 'поэз', 'стих', 'verse', 'сонет', 'элегия', 'поэма')) return 'Поэзия';
  // Драматургия/пьесы
  if (has('dramaturg', 'драматург', 'драма', 'пьеса', 'пьесы', 'play', 'сценар', 'театр', 'theatre'))
    return 'Драма';
  // Религия/эзотерика/духовное
  if (has('religion', 'религи', 'esoteric', 'эзотер', 'духовн', 'библия', 'bible', 'буддизм',
    'христианств', 'ислам', 'теолог', 'spiritual')) return 'Религия';
  // Биографии/мемуары
  if (has('biography', 'биограф', 'мемуар', 'memoir', 'autobiograph', 'жизнеописан')) return 'Биографии';
  // Научпоп/нон-фикшн/наука/техника/справочники/публицистика.
  // 'история' сознательно НЕ ключ: в аннотациях это чаще «рассказ», а не наука
  // (научпоп-history и так ловится через sci_/military).
  if (has('science', 'sci_', 'научн', 'нон-фикшн', 'non-fiction', 'nonfiction', 'nonf_',
    'познавател', 'бизнес', 'business', 'эконом', 'econom', 'психолог', 'psychology',
    'философ', 'philosoph', 'политик', 'politic', 'публицист', 'publicism',
    'критик', 'critic', 'comp_', 'computers', 'программир', 'programming', 'reference',
    'справочник', 'словар', 'энциклопед', 'encyclop', 'dictionary', 'design', 'дизайн',
    'medicine', 'медицин', 'juris', 'юриспруден', 'linguist', 'лингвист', 'self-help',
    'самоучит', 'саморазвит', 'home_', 'кулинар', 'cooking', 'хобби', 'hobby', 'garden',
    'здоровь', 'health', 'спорт', 'sport', 'military', 'военн', 'geo_', 'путеводит', 'guide',
    'документал', 'documentary', 'публиц')) return 'Научпоп';
  // ── формат — только как запасной ярлык, если по содержанию жанр не распознан ──
  if (has('манга', 'манхв', 'manga', 'manhwa', 'comic', 'комикс', 'webtoon')) return 'Манга';
  if (has('ранобэ', 'ранобе', 'ranobe', 'light novel', 'веб-новелл', 'web novel',
    'litrpg', 'литрпг', 'лит-рпг', 'litprg', 'вебновелл')) return 'Ранобэ';
  if (has('роман', 'novel')) return 'Роман';
  return 'Другое';
}
const yearOf = s => { const m = String(s || '').match(/\b(1[5-9]\d\d|20\d\d)\b/); return m ? +m[1] : null; };
// быстрый base64 → байты (индексный цикл на порядок быстрее Uint8Array.from(map))
function b64bytes(b64) {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── ZIP (только чтение; методы: без сжатия и deflate) ──
async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;   // конец центрального каталога ищем с хвоста файла
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('не похоже на ZIP-архив');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  if (off === 0xffffffff) throw new Error('ZIP64 не поддерживается');
  const entries = new Map();
  for (let i = 0; i < count && off + 46 <= u8.length; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lof = dv.getUint32(off + 42, true);
    const name = td.decode(u8.subarray(off + 46, off + 46 + nlen)).replace(/\\/g, '/');
    entries.set(name, { method, csize, lof });
    off += 46 + nlen + elen + clen;
  }
  async function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    // размеры имени/доп.поля берём из ЛОКАЛЬНОГО заголовка — они бывают другими
    const nlen = dv.getUint16(e.lof + 26, true);
    const elen = dv.getUint16(e.lof + 28, true);
    const start = e.lof + 30 + nlen + elen;
    const data = u8.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    throw new Error('неподдерживаемое сжатие в ZIP: ' + e.method);
  }
  return { names: [...entries.keys()], has: n => entries.has(n), read };
}

// путь внутри архива относительно файла, из которого идёт ссылка
function resolvePath(baseFile, rel) {
  rel = String(rel || '').split('#')[0].split('?')[0];
  try { rel = decodeURIComponent(rel); } catch { /* уже раскодировано */ }
  if (!rel) return '';
  const stack = rel.startsWith('/') ? [] : baseFile.split('/').slice(0, -1);
  for (const part of rel.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

const byTag = (root, name) => [...root.getElementsByTagNameNS('*', name)];
const parseXml = text => new DOMParser().parseFromString(text, 'text/xml');
const xmlBroken = doc => doc.getElementsByTagName('parsererror').length > 0;

// ── очистка HTML главы: whitelist тегов, все атрибуты долой ──
// (наш CSS и должен управлять оформлением; заодно защита от скриптов)
const KEEP = new Set(['p', 'h3', 'h4', 'em', 'i', 'strong', 'b', 'u', 's',
  'blockquote', 'hr', 'br', 'ul', 'ol', 'li', 'table', 'thead', 'tbody',
  'tr', 'td', 'th', 'sup', 'sub', 'cite', 'pre', 'code']);
const VOID = new Set(['hr', 'br', 'img']);
const DROP = new Set(['script', 'style', 'link', 'head', 'title', 'meta',
  'iframe', 'object', 'embed', 'video', 'audio', 'form', 'input', 'button',
  'select', 'textarea', 'template', 'noscript']);
const TAG_MAP = { h1: 'h3', h2: 'h3', h5: 'h4', h6: 'h4', figure: 'div',
  figcaption: 'p', dd: 'p', dt: 'p', center: 'p' };

function sanitizeChildren(el, out, imgCb) {
  for (const node of el.childNodes) {
    if (node.nodeType === 3) { out.push(escText(node.data)); continue; }
    if (node.nodeType !== 1) continue;
    let tag = node.localName.toLowerCase();
    if (tag === 'img' || tag === 'image') {
      const name = imgCb ? imgCb(node) : null;
      if (name) out.push(`<img data-i="${escAttr(name)}" alt="">`);
      continue;
    }
    if (tag === 'svg') { sanitizeChildren(node, out, imgCb); continue; }
    if (DROP.has(tag)) continue;
    tag = TAG_MAP[tag] || tag;
    if (KEEP.has(tag) || tag === 'div' || tag === 'span') {
      if (VOID.has(tag)) { out.push(`<${tag}>`); continue; }
      out.push(`<${tag}>`);
      sanitizeChildren(node, out, imgCb);
      out.push(`</${tag}>`);
    } else {
      sanitizeChildren(node, out, imgCb);   // незнакомый тег разворачиваем
    }
  }
}

const tidyHtml = html => html
  .replace(/<(p|div|span|li|blockquote|h3|h4)>\s*<\/\1>/g, '')
  .replace(/<div>\s*<\/div>/g, '')
  .trim();
const plainOf = el => el.textContent.replace(/\s+/g, ' ').trim();

// тело документа: у XML-разобранного XHTML нет .body — берём <body> по тегу
const bodyOf = d => d.body || d.getElementsByTagName('body')[0] || d.documentElement;
// разбор главы: XHTML с самозакрывающимися тегами (<title/>, <br/>) при разборе как
// text/html «съедает» весь документ в <title> (это raw-text элемент) — тела не остаётся.
// Поэтому XHTML разбираем XML-парсером, с откатом на HTML (там чиним <title/>).
function parseChapter(raw) {
  if (/<\?xml|xmlns\s*=|xhtml/i.test(raw.slice(0, 500))) {
    const xd = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
    if (!xd.getElementsByTagName('parsererror').length
        && xd.getElementsByTagName('body').length
        && bodyOf(xd).textContent.trim()) return xd;
  }
  return new DOMParser().parseFromString(
    raw.replace(/<title(\s[^>]*)?\/>/gi, '<title></title>'), 'text/html');
}

// ══════════════════════ EPUB ══════════════════════
async function importEpub(buf) {
  const zip = await unzip(buf);
  // пути в EPUB бывают с несовпадающим регистром или иным префиксом папки —
  // ищем сначала точно, потом без регистра, потом по окончанию пути (если однозначно)
  const lowMap = new Map(zip.names.map(n => [n.toLowerCase(), n]));
  const findName = name => {
    if (name == null) return null;
    if (zip.has(name)) return name;
    const low = String(name).toLowerCase();
    if (lowMap.has(low)) return lowMap.get(low);
    const base = low.split('/').pop();
    if (!base) return null;
    const cands = zip.names.filter(n => { const l = n.toLowerCase(); return l === base || l.endsWith('/' + base); });
    return cands.length === 1 ? cands[0] : null;   // берём только при однозначном совпадении
  };
  const readText = async name => {
    const real = findName(name);
    const d = real === null ? null : await zip.read(real);
    return d === null ? null : td.decode(d);
  };
  const contText = await readText('META-INF/container.xml');
  if (!contText) throw new Error('в EPUB нет container.xml');
  const opfPath = byTag(parseXml(contText), 'rootfile')[0]?.getAttribute('full-path');
  const opfText = opfPath && await readText(opfPath);
  if (!opfText) throw new Error('в EPUB нет OPF-манифеста');
  const opf = parseXml(opfText);

  const title = byTag(opf, 'title')[0]?.textContent.trim() || 'Без названия';
  const author = byTag(opf, 'creator').map(e => e.textContent.trim())
    .filter(Boolean).join(', ');
  const lang = byTag(opf, 'language')[0]?.textContent.trim() || '';
  // ГОД ИЗДАНИЯ, а не дата файла. Раньше сюда подмешивались dcterms:modified и
  // calibre:timestamp — это когда epub собрали/сконвертировали. Из-за них «Властелин
  // колец», сконвертированный в 2015-м, значился изданным в 2015-м. Берём только то,
  // что действительно означает публикацию: dc:date (кроме пометки «modification»)
  // и dcterms:issued. Не нашлось — год пустой: лучше никакого, чем выдуманный
  // (его можно проставить руками в карточке книги).
  const year = yearOf([
    ...byTag(opf, 'date')
      .filter(e => !/modif/i.test(e.getAttribute('opf:event') || e.getAttribute('event') || ''))
      .map(e => e.textContent),
    ...byTag(opf, 'meta')
      .filter(e => /issued/i.test(e.getAttribute('property') || e.getAttribute('name') || ''))
      .map(e => e.textContent || e.getAttribute('content') || ''),
  ].join(' '));
  const genre = mapGenre(byTag(opf, 'subject').map(e => e.textContent).join(' '));
  // dc:description иногда содержит HTML прямо в тексте — вычищаем теги
  let annotation = '';
  const descEl = byTag(opf, 'description')[0];
  if (descEl) {
    const tmp = new DOMParser().parseFromString(descEl.textContent, 'text/html');
    annotation = (tmp.body ? tmp.body.textContent : '')
      .replace(/[ \t]+/g, ' ').trim().slice(0, 2000);
  }

  const items = new Map();      // id манифеста → {href, type, props}
  for (const it of byTag(opf, 'item')) {
    items.set(it.getAttribute('id'), {
      href: resolvePath(opfPath, it.getAttribute('href') || ''),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    });
  }
  const isDoc = it => it && (/html|xml/i.test(it.type) || /\.x?html?$/i.test(it.href));
  let spine = byTag(opf, 'itemref')
    .map(r => items.get(r.getAttribute('idref')))
    .filter(isDoc);
  // запасной путь: спайн битый/пустой — берём все html-документы манифеста по порядку
  if (!spine.length) spine = [...items.values()].filter(isDoc);
  if (!spine.length) throw new Error('в EPUB пустой список глав (spine)');

  // главы: каждый документ спайна → одна глава
  const chapters = [];          // {file, title|null, heading|null, html, plain}
  const imageNames = new Set();
  let readCount = 0;
  for (const it of spine) {
    const raw = await readText(it.href);
    if (raw === null) continue;
    readCount++;
    const doc = parseChapter(raw);
    const body = bodyOf(doc);
    const imgCb = el => {
      const src = el.getAttribute('src') || el.getAttribute('xlink:href')
        || el.getAttribute('href') || '';
      const p = findName(resolvePath(it.href, src));
      if (!p) return null;
      imageNames.add(p);
      return p;
    };
    const out = [];
    sanitizeChildren(body, out, imgCb);
    const html = tidyHtml(out.join(''));
    const plain = plainOf(body);
    const empty = !plain && !html.includes('<img');   // обложка/копирайт без текста
    const h = body.querySelector('h1,h2,h3,h4');
    chapters.push({ file: it.href, heading: h ? plainOf(h).slice(0, 120) : null,
      title: null, html, plain, empty });
  }
  // обычно пустышки отбрасываем; но если так книга осталась бы совсем без глав —
  // оставляем всё, что удалось прочитать (лучше, чем ошибка «нет глав»)
  const real = chapters.filter(c => !c.empty);
  // .slice(): если real пуст, use НЕ должен быть тем же массивом, что chapters,
  // иначе следующий chapters.length=0 обнулит и его (алиасинг) → «нет глав» на ровном месте
  const use = real.length ? real : chapters.slice();
  chapters.length = 0; chapters.push(...use);
  if (!chapters.length) {
    // диагностика: видно, совпадают ли пути спайна с реальными путями в архиве
    const sp = spine.slice(0, 2).map(it => it.href).join(' , ');
    const nm = (zip.names.filter(n => /\.x?html?$/i.test(n)).slice(0, 2).join(' , '))
      || zip.names.slice(0, 3).join(' , ');
    throw new Error(`нет глав (спайн ${spine.length}, прочитано ${readCount}); пути: [${sp}] в архиве: [${nm}]`);
  }
  const fileToIdx = new Map();
  chapters.forEach((c, i) => { if (!fileToIdx.has(c.file)) fileToIdx.set(c.file, i); });

  // оглавление: nav (EPUB3) или NCX (EPUB2) → дерево {t, target}
  let rawToc = null;
  const navItem = [...items.values()].find(it => it.props.split(/\s+/).includes('nav'));
  if (navItem) {
    const navText = await readText(navItem.href);
    if (navText) {
      const doc = new DOMParser().parseFromString(navText, 'text/html');
      let nav = [...doc.getElementsByTagName('nav')].find(n =>
        (n.getAttribute('epub:type') || n.getAttribute('role') || '').includes('toc'));
      nav = nav || doc.getElementsByTagName('nav')[0];
      const ol = nav && nav.querySelector('ol, ul');
      if (ol) rawToc = navList(ol, navItem.href);
    }
  }
  if (!rawToc) {
    const ncxId = byTag(opf, 'spine')[0]?.getAttribute('toc');
    const ncxItem = items.get(ncxId)
      || [...items.values()].find(it => /ncx/i.test(it.type));
    const ncxText = ncxItem && await readText(ncxItem.href);
    if (ncxText) {
      const ncx = parseXml(ncxText);
      const navMap = byTag(ncx, 'navMap')[0];
      if (navMap) rawToc = ncxPoints(navMap, ncxItem.href);
    }
  }

  function navList(ol, base) {
    const nodes = [];
    for (const li of ol.children) {
      if (li.localName.toLowerCase() !== 'li') continue;
      const a = [...li.children].find(c => c.localName.toLowerCase() === 'a');
      const span = [...li.children].find(c => c.localName.toLowerCase() === 'span');
      const sub = [...li.children].find(c => /^(ol|ul)$/i.test(c.localName));
      const t = plainOf(a || span || li).slice(0, 200);
      const node = { t: t || '…' };
      if (a && a.getAttribute('href'))
        node.target = resolvePath(base, a.getAttribute('href'));
      if (sub) node.kids = navList(sub, base);
      if (node.target !== undefined || node.kids) nodes.push(node);
    }
    return nodes;
  }
  function ncxPoints(el, base) {
    const nodes = [];
    for (const np of el.children) {
      if (np.localName !== 'navPoint') continue;
      const label = byTag(np, 'text')[0];
      const src = byTag(np, 'content')[0]?.getAttribute('src');
      const node = { t: label ? plainOf(label).slice(0, 200) : '…' };
      if (src) node.target = resolvePath(base, src);
      const kids = ncxPoints(np, base);
      if (kids.length) node.kids = kids;
      nodes.push(node);
    }
    return nodes;
  }

  const toc = buildTree(rawToc, chapters, fileToIdx);

  // обложка: properties=cover-image, meta name=cover или первая картинка
  let coverName = null;
  const covItem = [...items.values()].find(it =>
    it.props.split(/\s+/).includes('cover-image'));
  if (covItem) coverName = covItem.href;
  if (!coverName) {
    const metaCover = byTag(opf, 'meta').find(m =>
      (m.getAttribute('name') || '') === 'cover');
    const it = metaCover && items.get(metaCover.getAttribute('content'));
    if (it && MIME[(it.href.split('.').pop() || '').toLowerCase()]) coverName = it.href;
  }
  if (!coverName) coverName = [...imageNames][0] || null;

  const images = new Map();
  for (const name of imageNames) {
    const data = await zip.read(name);
    if (data && data.length) images.set(name, new Blob([data], { type: extMime(name) }));
  }
  let cover = null;
  if (coverName) {
    const data = await zip.read(coverName);
    if (data && data.length) cover = new Blob([data], { type: extMime(coverName) });
  }

  return {
    title, author, lang, annotation, year, genre, cover, toc, images, progress: null,
    chapters: chapters.map((c, i) => ({
      title: c.title || c.heading || 'Глава ' + (i + 1),
      html: c.html, plain: c.plain,
    })),
  };
}

// дерево оглавления со ссылками на файлы → дерево с индексами глав;
// главы спайна, не упомянутые в оглавлении, вставляются следом за соседями
function buildTree(rawToc, chapters, fileToIdx) {
  const listed = new Set();
  function convert(nodes) {
    const out = [];
    for (const n of nodes || []) {
      const idx = n.target !== undefined ? fileToIdx.get(n.target) : undefined;
      const kids = n.kids ? convert(n.kids) : null;
      if (kids && kids.length) {
        const node = { t: n.t, kids };
        // у группы есть и своя страница — она становится первым пунктом
        if (idx !== undefined && !listed.has(idx)) {
          listed.add(idx);
          chapters[idx].title = chapters[idx].title || n.t;
          node.kids.unshift({ t: n.t, ch: idx });
        }
        out.push(node);
      } else if (idx !== undefined && !listed.has(idx)) {
        listed.add(idx);
        chapters[idx].title = chapters[idx].title || n.t;
        out.push({ t: n.t, ch: idx });
      }
    }
    return out;
  }
  let toc = convert(rawToc);

  // если оглавление покрывает меньше половины глав — надёжнее плоский список
  if (listed.size < chapters.length / 2) {
    return chapters.map((c, i) => ({ t: c.title || c.heading || 'Глава ' + (i + 1), ch: i }));
  }
  // недостающие главы подселяем после ближайшей предыдущей из оглавления
  if (listed.size < chapters.length) {
    const spots = new Map();   // idx главы → {arr, at}
    (function walk(nodes) {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].kids) walk(nodes[i].kids);
        else spots.set(nodes[i].ch, { arr: nodes, at: i });
      }
    })(toc);
    for (let i = 0; i < chapters.length; i++) {
      if (listed.has(i)) continue;
      const c = chapters[i];
      const node = { t: c.title || c.heading || 'Глава ' + (i + 1), ch: i };
      let prev = i - 1;
      while (prev >= 0 && !spots.has(prev)) prev--;
      if (prev < 0) { toc.unshift(node); spots.set(i, { arr: toc, at: 0 }); }
      else {
        const s = spots.get(prev);
        s.arr.splice(s.at + 1, 0, node);
        for (const v of spots.values())        // сдвиг индексов после вставки
          if (v.arr === s.arr && v.at > s.at) v.at++;
        spots.set(i, { arr: s.arr, at: s.at + 1 });
      }
      listed.add(i);
    }
  }
  return toc;
}

// ══════════════════════ FB2 ══════════════════════
const FB2_MAP = { emphasis: 'em', strong: 'strong', strikethrough: 's',
  sub: 'sub', sup: 'sup', code: 'code', subtitle: 'h4', v: 'p',
  'text-author': 'p', cite: 'blockquote', poem: 'blockquote', p: 'p',
  table: 'table', tr: 'tr', td: 'td', th: 'th' };

function fb2Serialize(el, out, images) {
  for (const node of el.childNodes) {
    if (node.nodeType === 3) { out.push(escText(node.data)); continue; }
    if (node.nodeType !== 1) continue;
    const tag = node.localName.toLowerCase();
    if (tag === 'image') {
      const href = node.getAttribute('l:href') || node.getAttribute('xlink:href')
        || node.getAttribute('href') || '';
      const id = href.replace(/^#/, '');
      if (id && images.has(id)) out.push(`<img data-i="${escAttr(id)}" alt="">`);
      continue;
    }
    if (tag === 'empty-line') { out.push('<br>'); continue; }
    if (tag === 'title' || tag === 'section') continue;   // обрабатываются выше
    if (tag === 'a') { fb2Serialize(node, out, images); continue; }
    if (tag === 'stanza' || tag === 'epigraph' || tag === 'annotation') {
      out.push(tag === 'stanza' ? '' : '<blockquote>');
      fb2Serialize(node, out, images);
      out.push(tag === 'stanza' ? '' : '</blockquote>');
      continue;
    }
    const mapped = FB2_MAP[tag];
    if (mapped) {
      out.push(`<${mapped}>`);
      fb2Serialize(node, out, images);
      out.push(`</${mapped}>`);
    } else {
      fb2Serialize(node, out, images);
    }
  }
}

function importFb2(buf) {
  // кодировку берём из XML-пролога: старые fb2 часто в windows-1251
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(400, buf.byteLength)));
  const encMatch = head.match(/encoding=["']([\w-]+)["']/i);
  let enc = (encMatch ? encMatch[1] : 'utf-8').toLowerCase();
  let text;
  try { text = new TextDecoder(enc).decode(buf); }
  catch { text = td.decode(buf); }

  let doc = parseXml(text);
  if (xmlBroken(doc)) {
    const fixed = text
      .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, '&amp;')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    doc = parseXml(fixed);
    if (xmlBroken(doc)) doc = new DOMParser().parseFromString(fixed, 'text/html');
  }

  const tinfo = byTag(doc, 'title-info')[0] || doc;
  const title = byTag(tinfo, 'book-title')[0]?.textContent.trim() || 'Без названия';
  const author = byTag(tinfo, 'author').map(a => {
    const part = n => byTag(a, n)[0]?.textContent.trim() || '';
    return [part('first-name'), part('middle-name'), part('last-name')]
      .filter(Boolean).join(' ') || part('nickname');
  }).filter(Boolean).join(', ');
  const lang = byTag(tinfo, 'lang')[0]?.textContent.trim() || '';
  // ГОД ИЗДАНИЯ — только <year> из <publish-info>: по спецификации FB2 именно он значит
  // «когда книга вышла». <date> в title-info — это когда создан ТЕКСТ или перевод,
  // а <date> в document-info — когда сделан сам fb2-файл. Раньше брались все три подряд,
  // и годом издания становился год сборки файла. Не нашлось — оставляем пустым:
  // лучше никакого, чем выдуманный (проставляется руками в карточке книги).
  const pinfo = byTag(doc, 'publish-info')[0];
  const year = pinfo
    ? yearOf(byTag(pinfo, 'year').map(e => e.textContent).join(' '))
    : null;
  const genre = mapGenre(byTag(tinfo, 'genre').map(e => e.textContent).join(' '));
  const annEl = byTag(tinfo, 'annotation')[0];
  let annotation = '';
  if (annEl) {
    const ps = byTag(annEl, 'p').map(plainOf).filter(Boolean);
    annotation = (ps.length ? ps.join('\n\n') : plainOf(annEl)).slice(0, 2000);
  }

  // бинарные вложения (картинки)
  const images = new Map();
  for (const bin of byTag(doc, 'binary')) {
    const id = bin.getAttribute('id');
    if (!id) continue;
    try {
      const bytes = b64bytes(bin.textContent);
      if (bytes.length) images.set(id, new Blob([bytes],
        { type: bin.getAttribute('content-type') || extMime(id) }));
    } catch { /* битый base64 — пропускаем картинку */ }
  }
  let cover = null;
  const covHref = byTag(byTag(tinfo, 'coverpage')[0] || doc.createElement('x'), 'image')[0];
  if (covHref) {
    const id = (covHref.getAttribute('l:href') || covHref.getAttribute('xlink:href')
      || covHref.getAttribute('href') || '').replace(/^#/, '');
    cover = images.get(id) || null;
  }

  const chapters = [];
  let untitled = 0;
  const pushChapter = (t, html) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    chapters.push({ title: t, html, plain: plainOf(tmp) });
    return chapters.length - 1;
  };
  const titleOf = sec => {
    const tEl = [...sec.children].find(c => c.localName === 'title');
    return tEl ? plainOf(tEl).slice(0, 200) : '';
  };
  function doSection(sec) {
    const t = titleOf(sec) || '· ' + (++untitled) + ' ·';
    const subs = [...sec.children].filter(c => c.localName === 'section');
    const out = [];
    fb2Serialize(sec, out, images);
    const html = tidyHtml(out.join(''));
    const hasOwn = html.replace(/<br>/g, '').trim().length > 0;
    if (!subs.length) return { t, ch: pushChapter(t, html) };
    const kids = [];
    if (hasOwn) kids.push({ t, ch: pushChapter(t, html) });
    for (const s of subs) kids.push(doSection(s));
    return { t, kids };
  }

  const toc = [];
  const bodies = byTag(doc, 'body');
  if (!bodies.length) throw new Error('в FB2 нет тела книги');
  for (const body of bodies) {
    const isNotes = /notes/i.test(body.getAttribute('name') || '');
    const secs = [...body.children].filter(c => c.localName === 'section');
    if (isNotes) {
      const out = [];
      fb2Serialize(body, out, images);
      for (const s of secs) {
        const st = titleOf(s);
        const so = [];
        fb2Serialize(s, so, images);
        out.push(st ? `<h4>${escText(st)}</h4>` : '', so.join(''));
      }
      const html = tidyHtml(out.join(''));
      if (html) toc.push({ t: 'Примечания', ch: pushChapter('Примечания', html) });
      continue;
    }
    for (const s of secs) toc.push(doSection(s));
    if (!secs.length) {   // всё тело — одна глава
      const out = [];
      fb2Serialize(body, out, images);
      const html = tidyHtml(out.join(''));
      if (html) toc.push({ t: title, ch: pushChapter(title, html) });
    }
  }
  if (!chapters.length) throw new Error('в FB2 не нашлось глав с текстом');
  return { title, author, lang, annotation, year, genre, cover, toc, images, chapters,
    progress: null };
}

// ══════════════════════ .fbook (наш формат) ══════════════════════
async function importFbook(buf) {
  const j = JSON.parse(td.decode(buf));
  if (j.fmt !== 'talewyn-book')
    throw new Error('это не файл книги AD.Talewyn (.fbook)');
  const images = new Map();
  let i = 0;
  for (const [name, im] of Object.entries(j.images || {})) {
    try {                                    // битая картинка не должна рушить всю книгу
      const bytes = b64bytes(im && im.d);
      if (bytes.length) images.set(name, new Blob([bytes], { type: (im && im.m) || extMime(name) }));
    } catch { /* пропускаем картинку */ }
    if ((++i % 20) === 0) await new Promise(r => setTimeout(r));   // отдаём поток — WebView не виснет
  }
  const chapters = (j.chapters || []).map((c, i) => {
    let plain = c.plain;
    if (plain === undefined) {
      const tmp = document.createElement('div');
      tmp.innerHTML = c.html;
      plain = plainOf(tmp);
    }
    return { title: c.title || 'Глава ' + (i + 1), html: c.html || '', plain };
  });
  if (!chapters.length) throw new Error('в .fbook нет глав');
  return {
    title: j.title || 'Без названия', author: j.author || '',
    lang: j.lang || '', annotation: String(j.annotation || '').slice(0, 2000),
    // год/жанр в .fbook появились позже — у старых файлов их просто нет
    year: yearOf(j.year), genre: j.genre || '',
    cover: j.cover ? images.get(j.cover) || null : null,
    toc: j.toc && j.toc.length ? j.toc
      : chapters.map((c, i) => ({ t: c.title, ch: i })),
    images, chapters, progress: j.progress || null,
  };
}

// ══════════════════════ CBZ / манга / комиксы ══════════════════════
// Архив изображений (.cbz и просто zip с картинками): каждая картинка — «страница».
const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
async function importCbz(zip, fname, onProgress) {
  const names = zip.names
    .filter(n => IMG_EXT.test(n) && !/(^|\/)__MACOSX\//.test(n) && !/(^|\/)\._/.test(n))
    .sort(naturalSort);
  if (!names.length) throw new Error('в архиве нет изображений');
  const images = new Map();
  let done = 0;
  for (const n of names) {
    const data = await zip.read(n);
    if (data && data.length) images.set(n, new Blob([data], { type: extMime(n) }));
    if (onProgress) onProgress(++done / names.length);
  }
  const title = String(fname || 'Комикс').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'Комикс';
  const chapters = names.map((n, i) => ({
    title: 'Страница ' + (i + 1),
    html: `<img data-i="${escAttr(n)}" alt="">`,
    plain: '',
  }));
  return {
    title, author: '', lang: '', annotation: '', year: null, genre: 'Манга',
    cover: images.get(names[0]) || null,
    toc: chapters.map((c, i) => ({ t: c.title, ch: i })),
    images, chapters, progress: null, kind: 'comic',
  };
}

// ══════════════════════ TXT / HTML (простой текст) ══════════════════════
// декодируем с автоопределением кодировки: BOM → UTF-16/UTF-8, иначе UTF-8,
// а если много «мусора» (кириллица в CP1251) — пробуем windows-1251
function decodeText(buf) {
  const b = new Uint8Array(buf);
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > utf8.length * 0.002 + 2) {
    try { return new TextDecoder('windows-1251').decode(buf).replace(/^﻿/, ''); } catch { /* нет 1251 */ }
  }
  return utf8.replace(/^﻿/, '');
}
// «это вообще текст?» — среди первых байт нет нулей и мало управляющих
function isMostlyText(buf) {
  const b = new Uint8Array(buf, 0, Math.min(2048, buf.byteLength));
  let ctrl = 0;
  for (const c of b) {
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return ctrl < b.length * 0.02;
}
function importTxt(buf, fname) {
  const raw = decodeText(buf).replace(/\r\n?/g, '\n');
  const isHeading = l => {
    const s = l.trim();
    // \b в JS не срабатывает после кириллицы (ASCII-границы), поэтому проверяем, что
    // после слова не идёт буква (иначе «главарь» ложно совпал бы с «глава»)
    return s.length > 0 && s.length <= 60
      && /^(глава|часть|том|книга|пролог|эпилог|chapter|part|book|prologue|epilogue)(?![а-яёa-z])/i.test(s);
  };
  const chapters = [];
  let curTitle = null, curParas = [], para = [];
  const pushPara = () => { if (para.length) { curParas.push(para.join(' ')); para = []; } };
  const flush = () => {
    const body = curParas.filter(p => p.trim());
    if (!body.length && !curTitle) return;
    const html = (curTitle ? `<h3>${escText(curTitle)}</h3>` : '')
      + body.map(p => `<p>${escText(p.trim())}</p>`).join('');
    chapters.push({ title: curTitle || ('Глава ' + (chapters.length + 1)), html, plain: body.join('\n\n') });
    curParas = [];
  };
  for (const line of raw.split('\n')) {
    if (isHeading(line)) { pushPara(); flush(); curTitle = line.trim(); continue; }
    if (!line.trim()) { pushPara(); continue; }
    para.push(line.trim());
  }
  pushPara(); flush();
  if (!chapters.length) throw new Error('пустой текстовый файл');
  const title = String(fname || 'Текст').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'Текст';
  return {
    title, author: '', lang: '', annotation: '', year: null, genre: '',
    cover: null, toc: chapters.map((c, i) => ({ t: c.title, ch: i })),
    images: new Map(), chapters, progress: null,
  };
}
function importHtml(buf, fname) { return importHtmlString(decodeText(buf), fname); }
function importHtmlString(htmlString, fname) {
  const doc = new DOMParser().parseFromString(htmlString, 'text/html');
  const body = doc.body || doc.documentElement;
  const images = new Map();
  let imgN = 0;
  const imgCb = el => {                    // берём только встроенные data:-картинки
    const src = el.getAttribute('src') || '';
    const m = /^data:([^;,]+)[^,]*,(.*)$/i.exec(src);
    if (!m) return null;
    try {
      const bin = atob(m[2]); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const name = 'img' + (++imgN);
      images.set(name, new Blob([arr], { type: m[1] || 'image/png' }));
      return name;
    } catch { return null; }
  };
  const out = [];
  sanitizeChildren(body, out, imgCb);
  const html = tidyHtml(out.join(''));
  const plain = plainOf(body);
  if (!plain && !images.size) throw new Error('в HTML нет текста');
  const title = (doc.querySelector('title')?.textContent || '').trim()
    || String(fname || 'Документ').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'Документ';
  const chapters = [{ title, html, plain }];
  return {
    title, author: '', lang: doc.documentElement.getAttribute('lang') || '',
    annotation: '', year: null, genre: '',
    cover: null, toc: [{ t: title, ch: 0 }], images, chapters, progress: null,
  };
}

// ══════════════════════ PDF (режим страницы) ══════════════════════
// Рендерим КАЖДУЮ страницу как картинку (вёрстка 1-в-1), а текстовый слой тянем
// отдельно — только для озвучки/поиска (у сканов его нет). pdf.js загружаем по требованию.
let _pdfjs = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  const base = new URL('pdf/', location.href).href;
  const m = await import(base + 'pdf.min.mjs');
  m.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';   // воркер — тем же origin
  _pdfjs = { lib: m, base };
  return _pdfjs;
}
async function importPdf(buf, fname, onProgress) {
  const { lib: pdfjs, base } = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,                      // в Capacitor CSP нет unsafe-eval
    standardFontDataUrl: base + 'standard_fonts/',
  }).promise;
  const images = new Map();
  const chapters = [];
  for (let i = 1; i <= doc.numPages; i++) {
    if (onProgress) onProgress(i / doc.numPages);   // шкала прогресса по страницам
    const page = await doc.getPage(i);
    const b = page.getViewport({ scale: 1 });
    let scale = 1600 / b.width;                                    // целимся в ~1600px по ширине
    scale = Math.max(1, Math.min(scale, 2600 / Math.max(b.width, b.height)));  // но не крупнее 2600 по стороне
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
    const name = 'page' + i;
    if (blob) images.set(name, blob);
    let text = '';
    try {
      const tc = await page.getTextContent();
      text = tc.items.map(it => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('')
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    } catch { /* скан без текстового слоя */ }
    // текст страницы кладём скрытым слоем (.pdf-text) — не виден, но озвучка его читает
    const paras = text ? text.split(/\n{2,}/).map(s => s.replace(/\n+/g, ' ').trim()).filter(Boolean) : [];
    const hid = paras.length ? `<div class="pdf-text">${paras.map(p => `<p>${escText(p)}</p>`).join('')}</div>` : '';
    chapters.push({ title: 'Страница ' + i, html: `<img data-i="${escAttr(name)}" alt="">` + hid, plain: text });
    try { page.cleanup(); } catch { /* ignore */ }
    canvas.width = canvas.height = 0;
    if (i % 4 === 0) await new Promise(r => setTimeout(r));       // отдаём поток — WebView не виснет
  }
  try { await doc.destroy(); } catch { /* ignore */ }
  if (!chapters.length) throw new Error('в PDF нет страниц');
  const hasText = chapters.some(c => c.plain);
  const title = String(fname || 'PDF').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'PDF';
  return {
    title, author: '', lang: '', annotation: '', year: null, genre: '',
    cover: images.get('page1') || null,
    toc: chapters.map((c, i) => ({ t: c.title, ch: i })),
    images, chapters, progress: null, kind: 'comic', textLayer: hasText,
  };
}

// подгрузка внешнего классического скрипта (mammoth) по требованию, один раз
const _scripts = {};
function loadScript(src) {
  if (_scripts[src]) return _scripts[src];
  _scripts[src] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL(src, location.href).href;
    s.onload = res; s.onerror = () => rej(new Error('не загрузился ' + src));
    document.head.appendChild(s);
  });
  return _scripts[src];
}

// ══════════════════════ DOCX (Word) ══════════════════════
async function importDocx(buf, fname) {
  await loadScript('mammoth.min.js');
  if (!window.mammoth) throw new Error('модуль DOCX не загрузился');
  const { value } = await window.mammoth.convertToHtml({ arrayBuffer: buf });   // HTML + base64-картинки
  if (!value || !value.replace(/<[^>]+>/g, '').trim()) throw new Error('в DOCX нет текста');
  return importHtmlString(value, fname);
}

// ══════════════════════ CBR / CB7 / CBT (комиксы в rar/7z/tar) ══════════════════════
let _libarchive = null;
async function importArchiveComic(file, fname) {
  if (!_libarchive) {
    _libarchive = (await import(new URL('libarchive/libarchive.js', location.href).href)).Archive;
    _libarchive.init({ workerUrl: new URL('libarchive/worker-bundle.js', location.href).href });
  }
  const archive = await _libarchive.open(file);
  const tree = await archive.extractFiles();
  const flat = [];
  (function walk(node, prefix) {
    for (const [name, val] of Object.entries(node || {})) {
      const p = prefix ? prefix + '/' + name : name;
      if (val instanceof File || val instanceof Blob) flat.push({ path: p, file: val });
      else if (val && typeof val === 'object') walk(val, p);
    }
  })(tree, '');
  const imgs = flat
    .filter(e => IMG_EXT.test(e.path) && !/(^|\/)__MACOSX\//.test(e.path) && !/(^|\/)\._/.test(e.path))
    .sort((a, b) => naturalSort(a.path, b.path));
  if (!imgs.length) throw new Error('в архиве нет изображений');
  const images = new Map();
  const chapters = imgs.map((e, i) => {
    const name = 'page' + i;
    images.set(name, e.file);
    return { title: 'Страница ' + (i + 1), html: `<img data-i="${escAttr(name)}" alt="">`, plain: '' };
  });
  const title = String(fname || 'Комикс').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'Комикс';
  return {
    title, author: '', lang: '', annotation: '', year: null, genre: 'Манга',
    cover: images.get('page0') || null,
    toc: chapters.map((c, i) => ({ t: c.title, ch: i })),
    images, chapters, progress: null, kind: 'comic',
  };
}

// ══════════════════════ MOBI / AZW3 (foliate mobi.js) ══════════════════════
// Только без DRM: защищённые файлы Kindle открыть нельзя (это защита, не формат).
async function importMobi(file, fname) {
  const [mobiMod, fflate] = await Promise.all([
    import(new URL('mobi.js', location.href).href),
    import(new URL('fflate.js', location.href).href),
  ]);
  let book;
  try {
    book = await new mobiMod.MOBI({ unzlib: fflate.unzlibSync }).open(file);
  } catch (e) {
    throw new Error('не удалось открыть MOBI/AZW3 (возможно, DRM)');
  }
  const md = book.metadata || {};
  const mstr = v => !v ? '' : typeof v === 'string' ? v
    : Array.isArray(v) ? v.map(mstr).filter(Boolean).join(', ')
    : (v.value || v.name || '');
  const chapters = [];
  for (const section of (book.sections || [])) {
    let doc = null;
    try { doc = await section.createDocument(); } catch { /* битая/защищённая секция */ }
    const body = doc && (doc.body || doc.documentElement);
    if (!body) continue;
    const out = [];
    sanitizeChildren(body, out, null);          // картинки MOBI (kindle:embed) пока не тянем
    const html = tidyHtml(out.join(''));
    const plain = plainOf(body);
    if (plain || html) chapters.push({ title: '', html, plain });
  }
  if (!chapters.length) throw new Error('в MOBI/AZW3 нет читаемых глав (возможно, DRM)');
  const title = mstr(md.title) || String(fname || 'Книга').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'Книга';
  return {
    title, author: mstr(md.author) || mstr(md.creator), lang: mstr(md.language),
    annotation: mstr(md.description).slice(0, 2000),
    year: yearOf(mstr(md.published) || mstr(md.date)), genre: mapGenre(mstr(md.subject)),
    cover: null,
    toc: chapters.map((c, i) => ({ t: c.title || ('Глава ' + (i + 1)), ch: i })),
    images: new Map(), chapters, progress: null,
  };
}

// ══════════════════════ входная точка ══════════════════════
// Определяем формат по содержимому, а не по расширению: так надёжнее.
async function importFile(file, onProgress) {
  const prog = typeof onProgress === 'function' ? onProgress : null;
  const buf = await file.arrayBuffer();
  if (!buf.byteLength) throw new Error('файл пустой');
  const magic = new Uint8Array(buf, 0, Math.min(5, buf.byteLength));
  if (magic[0] === 0x25 && magic[1] === 0x50 && magic[2] === 0x44 && magic[3] === 0x46)  // '%PDF'
    return importPdf(buf, file.name, prog);
  if ((magic[0] === 0x52 && magic[1] === 0x61 && magic[2] === 0x72 && magic[3] === 0x21) ||   // 'Rar!'
      (magic[0] === 0x37 && magic[1] === 0x7a && magic[2] === 0xbc && magic[3] === 0xaf) ||     // 7z
      /\.(cbr|cb7|cbt)$/i.test(file.name))                                                       // tar по расширению
    return importArchiveComic(file, file.name);
  if (magic[0] === 0x50 && magic[1] === 0x4b) {           // 'PK' — ZIP
    const zip = await unzip(buf);
    if (zip.has('word/document.xml')) return importDocx(buf, file.name);   // DOCX
    if (zip.has('META-INF/container.xml')) return importEpub(buf);
    const inner = zip.names.find(n => /\.fb2$/i.test(n)); // .fb2.zip
    if (inner) {
      const data = await zip.read(inner);
      return importFb2(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (zip.names.some(n => IMG_EXT.test(n))) return importCbz(zip, file.name, prog);  // .cbz / манга
    throw new Error('в архиве нет ни EPUB, ни FB2');
  }
  // MOBI / AZW3: сигнатура BOOKMOBI на смещении 60 (или по расширению)
  const mobiSig = buf.byteLength >= 68 ? td.decode(new Uint8Array(buf, 60, 8)) : '';
  if (mobiSig === 'BOOKMOBI' || /\.(mobi|azw3?|prc)$/i.test(file.name)) return importMobi(file, file.name);
  const headText = td.decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
  if (/^﻿?\s*\{/.test(headText)) return importFbook(buf);
  if (/<fictionbook/i.test(headText) || /\.fb2$/i.test(file.name)) return importFb2(buf);
  if (/<!doctype\s+html|<html[\s>]/i.test(headText) || /\.x?html?$/i.test(file.name)) return importHtml(buf, file.name);
  if (/<\?xml/i.test(headText)) return importFb2(buf);              // прочий XML — пробуем как FB2
  if (/\.txt$/i.test(file.name) || isMostlyText(buf)) return importTxt(buf, file.name);
  throw new Error('неизвестный формат — поддерживаются EPUB, FB2, MOBI/AZW3, PDF, DOCX, TXT, HTML, комиксы (CBZ/CBR/CB7/CBT), .fbook');
}

return { importFile, GENRES, mapGenre };
})();
