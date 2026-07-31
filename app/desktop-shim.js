'use strict';
/* Десктоп (Tauri): подкладываем под веб-слой то, что на Android даёт нативный мост,
   плюс десктопные мелочи (свой титлбар, гашение системного ПКМ-меню, колесо мыши).
   На Android и в браузере/PWA window.__TAURI__ нет — шим молча выходит, ничего не трогая. */
(function () {
  var T = window.__TAURI__;
  if (!T || !T.core || typeof T.core.invoke !== 'function') return;   // не Tauri — выходим
  var invoke = T.core.invoke;

  // ── нативный HTTP без CORS, с любыми заголовками (User-Agent и т.д.) ──
  // Контракт ровно тот, что ждут grab.js / catalog.js / app.js: request → {status, data, headers}.
  var CapacitorHttp = {
    request: function (opts) {
      opts = opts || {};
      var body = null;
      if (typeof opts.data === 'string') body = opts.data;
      else if (opts.data != null) { try { body = JSON.stringify(opts.data); } catch (e) { body = null; } }
      return invoke('http_request', {
        req: {
          url: opts.url,
          method: opts.method || 'GET',
          headers: opts.headers || {},
          responseType: opts.responseType || 'text',
          body: body,
        },
      });
    },
    get: function (o) { return CapacitorHttp.request(Object.assign({}, o, { method: 'GET' })); },
    post: function (o) { return CapacitorHttp.request(Object.assign({}, o, { method: 'POST' })); },
  };
  window.Capacitor = {
    isNativePlatform: function () { return true; },
    getPlatform: function () { return 'windows'; },
    Plugins: { CapacitorHttp: CapacitorHttp },
    // путь файла → URL, который умеет открыть WebView (asset-протокол). Нужно импорту после скана.
    convertFileSrc: function (p) { try { return T.core.convertFileSrc(p); } catch (e) { return p; } },
  };

  // ── «Автопоиск» книг (мост AndroidScan) ──
  function ok(list) { if (window.__scanResult) window.__scanResult(list || []); }
  function fail() { if (window.__scanError) window.__scanError(); }
  // «Отдельная папка» — выбор папки диалогом и обход её
  function pickFolder() {
    invoke('plugin:dialog|open', { options: { directory: true, multiple: false, title: 'Папка с книгами' } })
      .then(function (dir) {
        if (!dir) { if (window.__scanCancelled) window.__scanCancelled(); return; }
        return invoke('scan_dir', { path: dir }).then(ok);
      })
      .catch(fail);
  }
  // «Весь компьютер» — типовые книжные папки (Документы, Загрузки, Рабочий стол)
  function scanAll() { invoke('scan_home').then(ok).catch(fail); }
  window.AndroidScan = {
    hasAccess: function () { return true; },
    requestAccess: function () {},
    pickFolder: pickFolder,
    scanAll: scanAll,
  };

  // ── вход в аккаунт lib-сайта: открываем окно логина (Rust ловит токен и вернёт в __siteLogin) ──
  window.AndroidSiteLogin = {
    open: function (url) { invoke('open_login', { url: url }); },
  };

  // ── полноэкранный режим (читалка манги): фуллскрин окна + прячем свой титлбар и верхний отступ ──
  window.AndroidImmersive = {
    set: function (on) {
      try { var w = getWin(); if (w && w.setFullscreen) w.setFullscreen(!!on); } catch (e) {}
      var bar = document.querySelector('.dsk-titlebar');
      if (bar) bar.style.display = on ? 'none' : '';
      document.documentElement.style.setProperty('--sat', on ? '0px' : '34px');
    },
  };

  // ── десктопные повадки ──
  // маркер десктопа — АТРИБУТОМ: applyTheme перезаписывает className целиком и стёр бы класс,
  // а data-* атрибут переживает; на него и завязан десктопный CSS
  document.documentElement.setAttribute('data-desktop', '1');
  document.documentElement.classList.add('desktop');
  // в десктопе service worker не нужен и лишь кэширует встроенные ассеты (после пересборки — старые):
  // снимаем регистрации, чистим кэши И глушим повторную регистрацию (приложение вешает её при загрузке)
  if (navigator.serviceWorker) {
    try {
      navigator.serviceWorker.register = function () { return Promise.resolve(undefined); };
    } catch (e) {}
    if (navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); }).catch(function () {});
    }
    if (window.caches && caches.keys) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); }).catch(function () {});
  }
  // место под свой титлбар: вся вёрстка держит верхний отступ через max(env(safe-area-top), var(--sat))
  document.documentElement.style.setProperty('--sat', '34px');

  // системное меню ПКМ WebView2 (с «Проверить»/кодом) — убираем
  window.addEventListener('contextmenu', function (e) { e.preventDefault(); }, { capture: true });

  // колесо мыши листает горизонтальные карусели (темы, книги в сборнике)
  window.addEventListener('wheel', function (e) {
    var box = e.target && e.target.closest && e.target.closest('#seg-theme, .themes, .fold-carousel');
    if (!box || box.scrollWidth <= box.clientWidth || !e.deltaY) return;
    box.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  // ── свой титлбар (окно безрамочное) ──
  function getWin() {
    try {
      if (T.window && T.window.getCurrentWindow) return T.window.getCurrentWindow();
      if (T.window && T.window.getCurrent) return T.window.getCurrent();
      if (T.webviewWindow && T.webviewWindow.getCurrentWebviewWindow) return T.webviewWindow.getCurrentWebviewWindow();
    } catch (e) {}
    return null;
  }
  function buildTitlebar() {
    if (document.querySelector('.dsk-titlebar')) return;
    var css = document.createElement('style');
    css.textContent =
      '.dsk-titlebar{position:fixed;top:0;left:0;right:0;height:34px;z-index:99999;display:flex;align-items:center;' +
      'background:var(--elev,#17171b);border-bottom:1px solid var(--border,#333);color:var(--dim,#999);' +
      'font-size:11px;letter-spacing:.14em;text-transform:uppercase;user-select:none;-webkit-user-select:none}' +
      '.dsk-title{flex:1;padding-left:14px;pointer-events:none}' +
      '.dsk-btns{display:flex;height:100%}' +
      '.dsk-btn{width:46px;height:100%;display:inline-flex;align-items:center;justify-content:center;' +
      'background:transparent;border:0;color:var(--dim,#999);cursor:default;transition:background-color .15s,color .15s}' +
      '.dsk-btn:hover{background:color-mix(in srgb,var(--text,#fff) 12%,transparent);color:var(--text,#fff)}' +
      '.dsk-btn.dsk-close:hover{background:#e5484d;color:#fff}' +
      '.dsk-btn svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.6}';
    document.head.appendChild(css);

    var bar = document.createElement('div');
    bar.className = 'dsk-titlebar';
    bar.setAttribute('data-tauri-drag-region', '');
    bar.innerHTML =
      '<span class="dsk-title" data-tauri-drag-region>AD.Talewyn</span>' +
      '<div class="dsk-btns">' +
      '<button class="dsk-btn" id="dsk-min" aria-label="Свернуть"><svg viewBox="0 0 12 12"><path d="M2 6h8"/></svg></button>' +
      '<button class="dsk-btn" id="dsk-max" aria-label="Развернуть"><svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7"/></svg></button>' +
      '<button class="dsk-btn dsk-close" id="dsk-close" aria-label="Закрыть"><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>' +
      '</div>';
    document.body.appendChild(bar);

    var w = getWin();
    var on = function (id, fn) { var b = document.getElementById(id); if (b) b.addEventListener('click', function () { try { fn(); } catch (e) {} }); };
    on('dsk-min', function () { w && w.minimize(); });
    on('dsk-max', function () { w && w.toggleMaximize(); });
    on('dsk-close', function () { w && w.close(); });
  }
  if (document.body) buildTitlebar();
  else document.addEventListener('DOMContentLoaded', buildTitlebar);

  // ── автообновление десктопа (плагин updater) ──
  // Сырые примитивы Tauri-апдейтера кладём в window — их дёргает И стартовый автоопрос (ниже),
  // И РУЧНАЯ кнопка обновления в шапке (app.js: otaManualCheck на десктопе идёт сюда, а не в веб-OTA).
  // check() может отклониться (нет сети) — вызывающий сам различает «нет сети» и «нет обновления».
  window.__tauriUpdate = {
    check: function () {
      if (!T.updater || !T.updater.check) return Promise.resolve(null);
      return T.updater.check();
    },
    install: function (update) {
      return update.downloadAndInstall().then(function () {
        if (T.process && T.process.relaunch) return T.process.relaunch();
      });
    },
  };
  // старт: тихо проверяем и, если есть — предлагаем (тем же uiConfirm и текстами, что и ручная кнопка)
  function checkUpdate() {
    window.__tauriUpdate.check().then(function (update) {
      if (!update) return;
      var ver = update.version || '';
      var msg = window.T ? window.T('otaAvailApp', { v: ver }) : 'Доступно обновление ' + ver;
      var yes = window.t ? window.t('otaInstall') : 'Обновить';
      var go = (typeof window.uiConfirm === 'function') ? window.uiConfirm(msg, { yes: yes }) : Promise.resolve(true);
      go.then(function (ok) { if (ok) window.__tauriUpdate.install(update).catch(function () {}); });
    }).catch(function () {});
  }
  setTimeout(checkUpdate, 4000);   // после загрузки приложения (уже есть uiConfirm)
})();
