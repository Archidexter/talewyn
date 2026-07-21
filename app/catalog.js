'use strict';
/* AD.Talewyn — каталог книг: загрузка и разбор OPDS-фидов (Atom/XML).
   Модуль ленивый (грузится при первом входе в каталог) и самостоятельный:
   из приложения ему передают только адрес, авторизацию и настройки источника.
   Никаких состояний тут нет — чистые функции «URL → разобранный фид». */
window.Catalog = (() => {

  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const capHttp = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) || null;

  // Порядок предпочтения форматов: наши импортёры понимают всё из этого списка,
  // но epub/fb2 дают лучший результат (структура глав, обложка, метаданные).
  const FMT_RANK = [
    'application/epub+zip',
    'application/x-fictionbook+xml',
    'application/fb2+zip',
    'application/x-mobipocket-ebook',
    'application/vnd.amazon.ebook',
    'application/vnd.comicbook+zip',
    'application/pdf',
    'text/plain',
  ];
  const fmtRank = type => {
    const t = (type || '').split(';')[0].trim().toLowerCase();
    const i = FMT_RANK.indexOf(t);
    return i < 0 ? FMT_RANK.length + 1 : i;
  };

  // Платные/образцы/выдача по абонементу — не наш случай: показываем только то,
  // что можно честно скачать (open-access либо просто acquisition).
  const ACQ_SKIP = /\/(buy|sample|borrow|subscribe)$/;

  function browserHeaders(url) {
    let origin = '';
    try { origin = new URL(url).origin; } catch {}
    const h = {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Accept': 'application/atom+xml,application/xml,text/xml,application/opensearchdescription+xml,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    };
    if (origin) h['Referer'] = origin + '/';
    return h;
  }

  // Логин/пароль личного сервера (Calibre-Web и т.п.) — обычный Basic.
  // btoa не умеет юникод, поэтому прогоняем через УРИ-костыль.
  function basicAuth(user, pass) {
    try { return 'Basic ' + btoa(unescape(encodeURIComponent(user + ':' + (pass || '')))); }
    catch { return ''; }
  }

  async function fetchText(url, opts) {
    const headers = browserHeaders(url);
    if (opts && opts.auth) headers['Authorization'] = opts.auth;
    if (isNative && capHttp) {
      const r = await capHttp.request({ url, method: 'GET', responseType: 'text', headers,
                                        connectTimeout: 15000, readTimeout: 30000 });
      if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
      // JSON-ответы (API Викитеки/LibriVox) мост разбирает в объект сам, невзирая на
      // responseType — возвращаем строкой, иначе дальше уезжает «[object Object]»
      const d = r.data;
      const text = typeof d === 'string' ? d : (d == null ? '' : JSON.stringify(d));
      return { text, url: r.url || url };
    }
    // ПК/PWA: обычный fetch (сработает там, где сервер отдаёт CORS, как Gutenberg)
    const c = new AbortController();
    const to = setTimeout(() => c.abort(), 20000);
    const res = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: c.signal,
                                   headers: (opts && opts.auth) ? { 'Authorization': opts.auth } : undefined });
    clearTimeout(to);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { text: await res.text(), url: res.url || url };
  }

  const resolveUrl = (href, base) => { try { return new URL(href, base).href; } catch { return href || ''; } };

  // XML-хелперы: DOMParser с default-неймспейсом Atom; CSS-селекторы по localName работают,
  // а для префиксных элементов (dcterms:language) селектор бессилен — идём перебором.
  const childText = (el, name) => {
    for (const c of el.children) if (c.localName === name) return (c.textContent || '').trim();
    return '';
  };

  function entryLinks(entry) {
    const out = [];
    for (const c of entry.children) {
      if (c.localName !== 'link') continue;
      out.push({ rel: c.getAttribute('rel') || '', type: c.getAttribute('type') || '',
                 href: c.getAttribute('href') || '', title: c.getAttribute('title') || '' });
    }
    return out;
  }

  // Разбор фида. cfg — настройки источника (могут отсутствовать):
  //   bookNavRe — «навигационная запись на самом деле книга» (стиль Gutenberg:
  //               в списках книга = subsection-ссылка на её мини-фид с файлами);
  //   coverOf(id) — обложка по номеру книги из bookNavRe.
  function parseFeed(xml, baseUrl, cfg) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('bad xml');
    const feedEl = doc.querySelector('feed');
    if (!feedEl) throw new Error('not a feed');

    const out = { title: childText(feedEl, 'title'), entries: [], next: '', searchTpl: '', osd: '' };

    for (const l of feedEl.children) {
      if (l.localName !== 'link') continue;
      const rel = l.getAttribute('rel') || '', href = l.getAttribute('href') || '';
      const type = l.getAttribute('type') || '';
      if (rel === 'next') out.next = resolveUrl(href, baseUrl);
      if (rel === 'search') {
        // либо готовый шаблон с {searchTerms}, либо ссылка на OpenSearch-описание
        if (/\{searchTerms\}/.test(href)) out.searchTpl = resolveUrl(href, baseUrl).replace(/%7BsearchTerms%7D/gi, '{searchTerms}');
        else if (/opensearchdescription/.test(type)) out.osd = resolveUrl(href, baseUrl);
      }
    }

    for (const en of doc.querySelectorAll('feed > entry')) {
      const links = entryLinks(en);
      const title = childText(en, 'title');
      if (!title) continue;

      // авторы: <author><name>…</name></author>, бывает несколько
      const authors = [];
      for (const c of en.children) if (c.localName === 'author') {
        const n = childText(c, 'name'); if (n) authors.push(n);
      }

      // содержимое: краткое описание (content/summary)
      let summary = childText(en, 'summary') || childText(en, 'content');
      summary = summary.replace(/\s+/g, ' ').trim();

      // обложки: полная и миниатюра; крошечные data:-иконки навигации нам не нужны
      let cover = '', thumb = '';
      for (const l of links) {
        if (l.rel === 'http://opds-spec.org/image' || l.rel === 'http://opds-spec.org/cover') cover = l.href;
        if (l.rel === 'http://opds-spec.org/image/thumbnail' || l.rel === 'http://opds-spec.org/thumbnail') thumb = l.href;
      }
      const pickCover = u => (u && !u.startsWith('data:')) ? resolveUrl(u, baseUrl) : '';

      // файлы книги: только скачиваемые acquisition-ссылки, лучший формат — первым
      const acqs = links
        .filter(l => l.rel.startsWith('http://opds-spec.org/acquisition') && !ACQ_SKIP.test(l.rel) && l.href)
        .sort((a, b) => fmtRank(a.type) - fmtRank(b.type));

      if (acqs.length) {
        out.entries.push({
          kind: 'book', title, author: authors.join(', '), summary,
          cover: pickCover(cover) || pickCover(thumb),
          acq: { url: resolveUrl(acqs[0].href, baseUrl), type: acqs[0].type },
          key: resolveUrl(acqs[0].href, baseUrl),
        });
        continue;
      }

      // навигационная запись — раздел либо «книга-ссылка» в стиле Gutenberg
      const nav = links.find(l =>
        /profile=opds-catalog/.test(l.type) &&
        (l.rel === 'subsection' || l.rel === '' || l.rel === 'alternate' || l.rel === 'http://opds-spec.org/sort/new' || l.rel === 'http://opds-spec.org/sort/popular'));
      if (!nav) continue;
      const href = resolveUrl(nav.href, baseUrl);

      const bm = cfg && cfg.bookNavRe && cfg.bookNavRe.exec(href);
      if (bm) {
        // в списках Gutenberg автора кладут в content простым текстом
        const author = authors.join(', ') || ((summary.length < 90 && !/[<>]/.test(summary)) ? summary : '');
        out.entries.push({
          kind: 'book', title, author, summary: authors.length ? summary : '',
          cover: (cfg.coverOf && cfg.coverOf(bm[1])) || pickCover(cover) || pickCover(thumb),
          acq: null, resolve: href, key: href,
        });
      } else {
        out.entries.push({ kind: 'nav', title, summary, href });
      }
    }
    return out;
  }

  async function fetchFeed(url, opts) {
    const got = await fetchText(url, opts);
    return parseFeed(got.text, got.url, opts && opts.cfg);
  }

  // Шаблон поиска: из настроек источника, из фида, либо из OpenSearch-описания.
  async function searchTemplate(feed, opts) {
    if (opts && opts.cfg && opts.cfg.searchTpl) return opts.cfg.searchTpl;
    if (feed.searchTpl) return feed.searchTpl;
    if (!feed.osd) return '';
    try {
      const got = await fetchText(feed.osd, opts);
      const doc = new DOMParser().parseFromString(got.text, 'application/xml');
      let best = '';
      for (const u of doc.querySelectorAll('Url')) {
        const type = u.getAttribute('type') || '', tpl = u.getAttribute('template') || '';
        if (!/\{searchTerms\}/.test(tpl)) continue;
        if (/atom/.test(type)) return resolveUrl(tpl, got.url).replace(/%7BsearchTerms%7D/gi, '{searchTerms}');
        if (!best) best = resolveUrl(tpl, got.url).replace(/%7BsearchTerms%7D/gi, '{searchTerms}');
      }
      return best;
    } catch { return ''; }
  }

  // «Книга-ссылка» (Gutenberg): дойти до файлов через её мини-фид
  async function resolveBook(entry, opts) {
    const feed = await fetchFeed(entry.resolve, { auth: opts && opts.auth });
    const best = feed.entries.find(e => e.kind === 'book' && e.acq);
    if (!best) throw new Error('no files');
    return best;
  }

  // ══ Викитека (русская классика, общественное достояние) ══
  // Не OPDS: список — «самое читаемое» по счётчику просмотров Викимедии, поиск — их же
  // API (оба с CORS). Файл книги генерирует официальный экспортёр Викимедии (EPUB).
  const WS_API = 'https://ru.wikisource.org/w/api.php';
  // служебные пространства и подстраницы (главы) — не книги
  const WS_SKIP = /^(Категория|Викитека|Портал|Шаблон|Справка|Индекс|Страница|Автор|Файл|Модуль|Участник|MediaWiki|Служебная|Обсуждение[^:]*):/i;
  function wsEntry(pageTitle) {
    let title = pageTitle, author = '';
    const m = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(pageTitle);   // «Название (Автор)»
    if (m) { title = m[1]; author = m[2]; }
    const url = 'https://ws-export.wmcloud.org/?lang=ru&format=epub&page='
      + encodeURIComponent(pageTitle.replace(/ /g, '_'));
    // plainUa: экспортёр за анти-скрапер-щитом Anubis, который отсекает браузерные
    // User-Agent (с «Mozilla»); честный UA приложения — рекомендация самой Викимедии
    return { kind: 'book', title, author, summary: '', cover: '',
             acq: { url, type: 'application/epub+zip' }, key: url, plainUa: true };
  }
  const wsFilter = rows => rows
    .map(r => r.title)
    .filter(t => t && t !== 'Заглавная страница' && !WS_SKIP.test(t) && !t.includes('/'))
    .map(wsEntry);
  async function wsList(offset) {
    const off = +offset || 0;
    const got = await fetchText(WS_API + '?action=query&list=mostviewed&pvimlimit=100&pvimoffset='
      + off + '&format=json&origin=*');
    const rows = ((JSON.parse(got.text).query || {}).mostviewed) || [];
    // счётчик просмотров отдаёт максимум несколько сотен строк — дальше хвоста нет
    return { entries: wsFilter(rows), next: rows.length >= 100 ? String(off + rows.length) : '' };
  }
  async function wsSearch(q, offset) {
    const off = +offset || 0;
    const got = await fetchText(WS_API + '?action=query&list=search&srnamespace=0&srlimit=40&sroffset='
      + off + '&format=json&origin=*&srsearch=' + encodeURIComponent(q));
    const d = JSON.parse(got.text);
    const rows = ((d.query || {}).search) || [];
    const more = d.continue && d.continue.sroffset;
    return { entries: wsFilter(rows), next: more ? String(more) : '' };
  }

  // ══ LibriVox (аудиокниги, общественное достояние — их правила прямо разрешают любое
  // использование, включая продажу) ══
  // Список русских аудиокниг зашит: их API не умеет фильтровать по языку, а прогонять
  // весь каталог (20 тысяч записей) с телефона при каждом входе — безумие. Список собран
  // прогоном полного каталога и обновляется вместе с приложением. Поиск — живой, по API.
  const LV_RU = [{"id":17147,"t":"Авантюристы гражданской войны","a":"A. Vetlugin","d":"04:53:46","n":16},{"id":2296,"t":"Aesops Fables in Russian","a":"Aesop","d":"0:50:28","n":39},{"id":8829,"t":"Японские народные сказки (Yaponskie Narodnye Skazki)","a":"Aleksandr Fyodorov-Davydov","d":"01:10:50","n":10},{"id":9842,"t":"Огненная Россия (Fiery Russia)","a":"Aleksey Mikhailovich Remizov","d":"01:22:02","n":4},{"id":15230,"t":"Народные русские сказки (Russian Fairy Tales), Выпуск 1","a":"Alexander Nikolayevich Afanasyev","d":"03:09:28","n":21},{"id":15307,"t":"Народные русские сказки (Russian Fairy Tales), Выпуск 2","a":"Alexander Nikolayevich Afanasyev","d":"04:43:49","n":37},{"id":16442,"t":"Народные русские сказки (Russian Fairy Tales), Выпуск 3","a":"Alexander Nikolayevich Afanasyev","d":"04:42:46","n":35},{"id":21764,"t":"Народные русские сказки (Russian Fairy Tales), Выпуск 4","a":"Alexander Nikolayevich Afanasyev","d":"","n":62},{"id":546,"t":"Krasavitse","a":"Alexander Pushkin","d":"00:02:14","n":1},{"id":8982,"t":"Дубровский (Dubrovsky)","a":"Alexander Pushkin","d":"02:17:20","n":6},{"id":11018,"t":"Евгений Онегин (Eugene Onegin)","a":"Alexander Pushkin","d":"02:50:00","n":8},{"id":8641,"t":"Повести покойного Ивана Петровича Белкина","a":"Alexander Pushkin","d":"02:24:20","n":6},{"id":2145,"t":"Поэмы (Poems)","a":"Alexander Pushkin","d":"7:42:07","n":37},{"id":5767,"t":"Woe from Wit [Горе от ума]","a":"Alexander Sergeyevich Griboedov, Алекса́ндр Серге́евич Грибое́дов","d":"2:19:49","n":10},{"id":18095,"t":"Белая стая. Часть 1-я","a":"Anna Akhmatova","d":"00:19:45","n":20},{"id":20664,"t":"Белая стая. Часть 2-я","a":"Anna Akhmatova","d":"00:20:21","n":21},{"id":20922,"t":"Белая стая. Часть 3-я","a":"Anna Akhmatova","d":"00:19:15","n":20},{"id":21742,"t":"Белая стая. Часть 4-я","a":"Anna Akhmatova","d":"","n":27},{"id":8692,"t":"Предложение (Predlozhenie)","a":"Anton Chekhov","d":"00:31:01","n":1},{"id":15766,"t":"Человек в футляре (Dramatic Reading)","a":"Anton Chekhov","d":"00:42:20","n":6},{"id":15437,"t":"Through the Literature / Сквозь литературу","a":"Boris Eikhenbaum","d":"11:10:05","n":29},{"id":15364,"t":"Аграфена","a":"Boris Zaytsev","d":"01:58:25","n":6},{"id":18952,"t":"Мать и Катя","a":"Boris Zaytsev","d":"02:19:14","n":9},{"id":15317,"t":"Стихи (Poems)","a":"Dmitry Venevitinov","d":"01:14:42","n":16},{"id":16410,"t":"Щелкунчик и мышиный царь","a":"E. T. A. Hoffmann","d":"02:48:15","n":14},{"id":9385,"t":"Сочинения","a":"Evgeny Baratynsky","d":"14:11:59","n":55},{"id":18568,"t":"Избранные Разсказы / Selected Stories","a":"Evgeny Chirikov","d":"02:22:06","n":6},{"id":559,"t":"Zapiski iz podpolya (Notes from the Underground)","a":"Fyodor Dostoyevsky","d":"4:23:52","n":18},{"id":557,"t":"Белые ночи (White Nights)","a":"Fyodor Dostoyevsky","d":"1:58:07","n":7},{"id":8261,"t":"Записки из Мертвого Дома (Zapiski iz Mertvogo Doma)","a":"Fyodor Dostoyevsky","d":"","n":41},{"id":13577,"t":"Раковина (The Conch)","a":"Georgy Arkadyevich Shengeli","d":"02:02:42","n":6},{"id":13335,"t":"Лампада","a":"Georgy Ivanov","d":"01:33:06","n":4},{"id":17203,"t":"Степные сказки (Stepnyia skazki)","a":"Grigory Danilevsky","d":"03:39:51","n":9},{"id":17392,"t":"Song of Hiawatha / Песнь о Гайавате","a":"Henry Wadsworth Longfellow","d":"05:13:58","n":24},{"id":15098,"t":"Ананасы в шампанском","a":"Igor Severyanin","d":"01:40:00","n":7},{"id":10868,"t":"Portraits of Russian Poets","a":"Ilya Ehrenburg","d":"03:13:39","n":28},{"id":15321,"t":"Вечный мир - Философский очерк (Perpetual Peace: A Philosophical Sketch)","a":"Immanuel Kant","d":"","n":10},{"id":18540,"t":"Кипарисовый ларец (Juniper Coffret)","a":"Innokenty Annensky","d":"02:16:05","n":8},{"id":14626,"t":"Обломов","a":"Ivan Goncharov","d":"","n":47},{"id":13240,"t":"Обрыв","a":"Ivan Goncharov","d":"31:28:45","n":102},{"id":14105,"t":"Обыкновенная история","a":"Ivan Goncharov","d":"12:16:53","n":13},{"id":251,"t":"Poezdka v Polesye","a":"Ivan Turgenev","d":"00:42:06","n":3},{"id":10422,"t":"Вешние воды (Veshnie Vody)","a":"Ivan Turgenev","d":"05:19:03","n":18},{"id":12256,"t":"Дворянское гнездо (Dvoryanskoe gnezdo)","a":"Ivan Turgenev","d":"06:34:52","n":25},{"id":8096,"t":"Записки охотника (Zapiski Okhotnika)","a":"Ivan Turgenev","d":"13:55:26","n":25},{"id":210,"t":"Childhood - Детство","a":"Leo Tolstoy","d":"3:30:37","n":28},{"id":15797,"t":"Childhood - Детство (version 2)","a":"Leo Tolstoy","d":"04:36:26","n":28},{"id":18453,"t":"Рассказы","a":"Leo Tolstoy","d":"","n":38},{"id":6467,"t":"Учение Христа, изложенное для детей","a":"Leo Tolstoy","d":"1:59:50","n":9},{"id":17494,"t":"Мелкие рассказы (Small Stories)","a":"Leonid Nikolayevich Andreyev","d":"","n":38},{"id":10916,"t":"Ocherki proshlago : razskazy","a":"Lev Osipovich Levanda","d":"06:52:39","n":15},{"id":15469,"t":"Нездешние вечера (Otherwhere Nights)","a":"Mikhail Kuzmin","d":"01:37:01","n":8},{"id":13447,"t":"Сказки","a":"Mikhail Saltykov-Shchedrin","d":"10:48:24","n":29},{"id":15182,"t":"Перед закатом / Before the Sunset","a":"Mirra Lokhvitskaya","d":"00:58:35","n":5},{"id":20288,"t":"Карусель (Carousel)","a":"Nadezhda Teffi","d":"07:01:50","n":44},{"id":15349,"t":"Вехи-Сборник статей о русской интеллигенции (Vekhi)","a":"Nikolai Berdyaev, Sergei Bulgakov, Semyon Frank, Mikhail Gershenzon, Bogdan Kistyakovski, Aron Lande, Peter Struve","d":"08:59:28","n":15},{"id":13744,"t":"На краю света (On the Edge of the World)","a":"Nikolai Leskov","d":"03:29:19","n":13},{"id":9970,"t":"Святочные рассказы","a":"Nikolai Leskov","d":"04:53:15","n":15},{"id":13866,"t":"К синей звезде","a":"Nikolay Gumilyov","d":"00:45:50","n":3},{"id":9708,"t":"Романтические Цветы, Шатер","a":"Nikolay Gumilyov","d":"01:42:46","n":5},{"id":13605,"t":"УШКУЙНИКИ, альманах","a":"Nina Berberova","d":"00:28:56","n":9},{"id":19789,"t":"Short Stories / Рассказы","a":"Octave Mirbeau","d":"04:37:41","n":14},{"id":9480,"t":"Камень (Kamen)","a":"Osip Mandelstam","d":"01:03:16","n":5},{"id":15222,"t":"Стихотворения П. Верлена в переводе В. Брюсова","a":"Paul-Marie Verlaine","d":"02:04:03","n":13},{"id":10587,"t":"Конёк-Горбунок (The Humpbacked Horse)","a":"Pyotr Pavlovich Yershov","d":"01:46:39","n":5},{"id":9515,"t":"Ice March - Ледяной поход","a":"Roman Gul","d":"04:21:01","n":15},{"id":15342,"t":"Лирика. Стихи об Италии.","a":"Sergey Shervinsky","d":"00:50:46","n":4},{"id":14954,"t":"Поэты наших дней: Антология / Poets of Our Days, Anthology","a":"Various","d":"01:54:26","n":10},{"id":9989,"t":"Избранные стихи и баллады","a":"Vasily Andreyevich Zhukovsky","d":"1:41:36","n":10},{"id":16834,"t":"Русско-еврейская литература","a":"Vasily Lvov-Rogachevsky","d":"07:17:56","n":19},{"id":19191,"t":"Судный день (\"Йом-Кипур\")","a":"Vladimir Korolenko","d":"","n":13},{"id":13646,"t":"Владислав Ходасевич, Стихи и Переводы","a":"Vladislav Khodasevich","d":"03:22:24","n":15},{"id":11365,"t":"Pассказы для детей и взрослых (Short Stories for Children and Adults)","a":"Vsevolod Garshin","d":"08:49:05","n":22},{"id":17122,"t":"Прозрачность (Transparency)","a":"Vyacheslav Ivanov","d":"02:39:22","n":24},{"id":22103,"t":"Две повести","a":"Yevgeny Zamyatin","d":"","n":12},{"id":14567,"t":"Силуэты русских писателей, Выпуск 1","a":"Yuly Aykhenvald","d":"10:37:31","n":23},{"id":14915,"t":"Силуэты русских писателей, Выпуск 2","a":"Yuly Aykhenvald","d":"11:26:02","n":22},{"id":15088,"t":"Силуэты русских писателей, Выпуск 3","a":"Yuly Aykhenvald","d":"18:13:18","n":36},{"id":7771,"t":"Early Short Stories","a":"Ze'ev Jabotinsky","d":"08:37:59","n":33},{"id":7531,"t":"Евреи и Россия (Jews and Russia)","a":"Ze'ev Jabotinsky","d":"5:51:06","n":20},{"id":16181,"t":"Очерки о национализме. Essays on Nationalism","a":"Ze'ev Jabotinsky","d":"06:11:08","n":15},{"id":17538,"t":"Чортова кукла","a":"Зинаида Гиппиус","d":"08:49:18","n":34},{"id":13624,"t":"Град","a":"Николай Оцуп","d":"00:41:46","n":2},{"id":17425,"t":"Избранные (Из жизни маленьких людей)","a":"שלום עליכם Sholem Aleichem","d":"01:42:42","n":12}];
  const lvEntry = b => ({
    kind: 'audio', title: b.t, author: b.a || '', summary: '', cover: '',
    rss: 'https://librivox.org/rss/' + b.id, time: b.d || '', sections: b.n || 0,
    key: 'lv:' + b.id,
  });
  // поток: русские (зашитый список) первыми, дальше — ВЕСЬ каталог LibriVox
  // постранично через их API (дубли русских отсеет дозагрузка по ключам)
  async function lvList(token) {
    if (!token) return { entries: LV_RU.map(lvEntry), next: '0' };
    const off = +token || 0;
    const got = await fetchText('https://librivox.org/api/feed/audiobooks/?format=json&extended=1&limit=50&offset=' + off);
    let books = [];
    try { books = JSON.parse(got.text).books || []; } catch {}
    const entries = books.map(b => lvEntry({
      id: b.id, t: b.title,
      a: (b.authors || []).map(a => [a.first_name, a.last_name].filter(Boolean).join(' ')).join(', '),
      d: b.totaltime || '', n: +b.num_sections || 0,
    }));
    return { entries, next: books.length >= 50 ? String(off + 50) : '' };
  }
  async function lvSearch(q) {
    const got = await fetchText('https://librivox.org/api/feed/audiobooks/?format=json&extended=1&limit=50&title='
      + encodeURIComponent(q));
    let books = [];
    try { books = JSON.parse(got.text).books || []; } catch {}
    const entries = books.map(b => lvEntry({
      id: b.id, t: b.title,
      a: (b.authors || []).map(a => [a.first_name, a.last_name].filter(Boolean).join(' ')).join(', '),
      d: b.totaltime || '', n: +b.num_sections || 0,
    }));
    // русские результаты из зашитого списка тоже ищем — API по-русски ищет плохо
    const ql = q.toLowerCase();
    const local = LV_RU.filter(b => (b.t + ' ' + (b.a || '')).toLowerCase().includes(ql)).map(lvEntry);
    const seen = new Set(entries.map(e => e.key));
    return { entries: [...local.filter(e => !seen.has(e.key)), ...entries], next: '' };
  }
  // треки аудиокниги из её подкаст-RSS: [{url, title}] в порядке глав + обложка
  async function lvTracks(rssUrl) {
    const got = await fetchText(rssUrl);
    const doc = new DOMParser().parseFromString(got.text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('bad rss');
    const out = [];
    for (const it of doc.querySelectorAll('item')) {
      const enc = [...it.children].find(c => c.localName === 'enclosure');
      const url = enc && enc.getAttribute('url');
      if (url) out.push({ url, title: childText(it, 'title') });
    }
    let cover = '';
    for (const im of doc.getElementsByTagName('itunes:image')) { cover = im.getAttribute('href') || ''; break; }
    if (!cover) { const im = doc.querySelector('image url'); if (im) cover = (im.textContent || '').trim(); }
    return { tracks: out, cover };
  }

  return { fetchFeed, searchTemplate, resolveBook, basicAuth, wsList, wsSearch, lvList, lvSearch, lvTracks };
})();
