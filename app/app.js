'use strict';
/* AD.Talewyn — домашняя библиотека: полка книг + читалка + озвучка.
   Все данные живут на устройстве (IndexedDB), сервер не обязателен.   */

const APP_VERSION = '1.2.46';
const $ = sel => document.querySelector(sel);

// диагностика: ошибки видны в атрибутах <html> (для headless-проверок)
addEventListener('error', e => {
  document.documentElement.dataset.err =
    ((document.documentElement.dataset.err || '') + ' | ' + e.message).slice(-300);
});
addEventListener('unhandledrejection', e => {
  const msg = e.reason && (e.reason.message || e.reason.name) || String(e.reason);
  document.documentElement.dataset.err =
    ((document.documentElement.dataset.err || '') + ' | rej: ' + msg).slice(-300);
});
const dbg = s => { document.documentElement.dataset.dbg =
  ((document.documentElement.dataset.dbg || '') + '|' + s).slice(-200); };
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ══════════════════ IndexedDB ══════════════════
let _db = null;
function idb() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const rq = indexedDB.open('talewyn', 5);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains('books')) {
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('chapters', { keyPath: ['book', 'idx'] });
        d.createObjectStore('images', { keyPath: ['book', 'name'] });
        d.createObjectStore('progress', { keyPath: ['book', 'idx'] });
        d.createObjectStore('kv', { keyPath: 'k' });
      }
      if (!d.objectStoreNames.contains('notes')) {   // версия 2: заметки
        const ns = d.createObjectStore('notes', { keyPath: 'id' });
        ns.createIndex('byBook', 'book');
        ns.createIndex('byChapter', ['book', 'idx']);
      }
      if (!d.objectStoreNames.contains('audiobooks')) {   // версия 3: аудиокниги
        d.createObjectStore('audiobooks', { keyPath: 'id' });
        d.createObjectStore('audiotracks', { keyPath: ['book', 'idx'] });
      }
      if (!d.objectStoreNames.contains('collections')) {   // версия 4: свои коллекции
        d.createObjectStore('collections', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('folders')) {   // версия 5: сборники (стопки на полке)
        d.createObjectStore('folders', { keyPath: 'id' });
      }
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
    // Апгрейд схемы блокирует другая открытая вкладка со старой версией. Без этого
    // обработчика промис не резолвится и не реджектится НИКОГДА — запуск виснет
    // навсегда, а человек видит пустую полку без единой ошибки.
    rq.onblocked = () => rej(new Error('база занята другой вкладкой приложения'));
  });
  return _db;
}
// Просим у системы «постоянное» хранилище. Без этого библиотека остаётся best-effort:
// при нехватке места Android вычищает IndexedDB целиком и без спроса — а в ней ВСЁ,
// что у пользователя есть (книги, заметки, прогресс, отзывы).
function askPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch { /* нет API — ничего не поделать */ }
}
// Переполнение хранилища — единственная ошибка записи, которую пользователь может починить
// сам, поэтому про неё говорим прямо, а не молчим в пустой catch.
const isQuota = e => !!e && (e.name === 'QuotaExceededError'
  || /quota|storage full|exceeded/i.test(String(e && e.message)));
// Место кончается не один раз, а на каждой записи подряд — не долбим тостом чаще раза в минуту
let quotaToastAt = 0;
function quotaToast() {
  if (performance.now() - quotaToastAt < 60000) return;
  quotaToastAt = performance.now();
  showToast(t('quotaFull'));
}
// Обёртка для сохранений из обработчиков кликов: промис оттуда никто не ловит, поэтому
// сбой записи превращался в тишину — шторка висит, текст потерян, причина неизвестна.
// Возвращает true при успехе; вызывающий закрывает шторку только тогда.
async function saveGuard(fn) {
  try { await fn(); return true; }
  catch (e) {
    if (isQuota(e)) quotaToast();
    else showToast(T('saveFail', { e: (e && e.message ? e.message : String(e)).slice(0, 60) }));
    return false;
  }
}
const req = r => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function dbGet(store, key) {
  const d = await idb();
  return req(d.transaction(store).objectStore(store).get(key));
}
async function dbAll(store, range) {
  const d = await idb();
  return req(d.transaction(store).objectStore(store).getAll(range));
}
async function dbPut(store, val) {
  const d = await idb();
  return req(d.transaction(store, 'readwrite').objectStore(store).put(val));
}
async function dbDel(store, keyOrRange) {
  const d = await idb();
  return req(d.transaction(store, 'readwrite').objectStore(store).delete(keyOrRange));
}
async function dbByIndex(store, index, key) {
  const d = await idb();
  return req(d.transaction(store).objectStore(store).index(index).getAll(key));
}
// все записи книги в составных хранилищах: [book] ≤ ключ < [book, []]
const bookRange = id => IDBKeyRange.bound([id], [id, []]);
const kvGet = async k => (await dbGet('kv', k) || {}).v;
const kvSet = (k, v) => dbPut('kv', { k, v });
const newId = p => (crypto.randomUUID && crypto.randomUUID())
  || p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// буфер обмена: navigator.clipboard требует https, по Wi-Fi нужен запасной путь
async function copyText(s) {
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(s); return true; }
  } catch { /* пробуем запасной путь */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// ══════════════════ состояние ══════════════════
const state = {
  books: [],           // записи книг на полке
  audiobooks: [],      // аудиокниги (отдельные аудиофайлы)
  folders: [],         // сборники — стопки книг/аудиокниг прямо на полке
  book: null,          // открытая книга (запись из books)
  toc: [],             // дерево оглавления открытой книги
  flat: [],            // главы в порядке чтения: {idx, title, crumb, groups}
  byIdx: new Map(),
  progress: { last: null, map: {} },   // по открытой книге
  chapter: null,       // открытая глава
  chNotes: [],         // выделения и заметки открытой главы
  shelfScroll: 0,
  libScroll: 0,
};

const SETTINGS_KEY = 'talewyn-settings';
const expandedKey = () => 'talewyn-expanded:' + (state.book ? state.book.id : '');

function safeParse(key, fallback, isValid) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (v === null || !isValid(v)) return fallback;
    return v;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

const DEFAULT_SETTINGS = {
  theme: 'dark', font: 'serif', size: 18, lh: 1.65, width: 'medium',
  align: 'justify',
  bg: 'on',           // живой фон полки (Патина): 'on' | 'off'
  wake: 'off',
  pronun: [],         // словарь произношений для озвучки: [{from, to, lang}]
  trChoice: 'auto',   // язык перевода по умолчанию (когда книга не открыта)
  lang: (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en',
};

// три читательских шрифта (OFL, с кириллицей), каждый на своей кнопке; названы одинаково
const READER_FONTS = ['serif', 'sans', 'lora'];
const FONT_FAMILY = {
  serif: 'var(--serif)',            // Spectral
  sans: 'var(--sans)',              // Nunito Sans
  lora: "'Lora', Georgia, serif",
};
const FONT_LABEL = { serif: 'Spectral', sans: 'Nunito', lora: 'Lora' };

// ══════════════════ два языка интерфейса ══════════════════
const I18N = {
  ru: {
    appName: 'AD.Talewyn',
    shelfSub: '— твоя библиотека',
    filtersT: 'Фильтры', filterSearch: 'Поиск по названию или автору…',
    filterAuthor: 'Автор', filterGenre: 'Жанр', filterAll: 'Все',
    fltStatus: 'Статус', stProgress: 'В процессе',
    stNew: 'Не прочитано', stRead: 'Прочитано', stNewA: 'Не прослушано', stReadA: 'Прослушано',
    filterReset: 'Сбросить фильтры', filterNone: 'По фильтрам ничего не найдено.',
    addBook: 'Добавить книги',
    tabBooks: 'Книги', tabAudio: 'Аудиокниги',
    coverLabel: 'Обложка', coverEdit: 'Изменить', coverDel: 'Удалить', coverReset: 'Вернуть исходную обложку', editT: 'Редактировать', noteJump: 'К моменту',
    audioSoonT: 'Аудиокниги скоро', audioSoonSub: 'Идёт разработка поддержки аудиоформатов.',
    abAdd: 'Добавить аудиокниги', abTracks: 'Треки', abCont: 'Продолжить слушать',
    abEmptyT: 'Аудиокниг пока нет', abEmptySub: 'Добавьте аудиофайлы — mp3, m4a, m4b, ogg, opus…',
    emptyShelf: 'На полке пока пусто.',
    emptyHint: 'Добавьте книгу — EPUB, FB2 или .fbook. Всё хранится на этом устройстве.',
    importing: 'Импортирую: {n}…',
    imported: 'Добавлено: «{n}»',
    dupBook: '«{n}» уже в библиотеке',
    addFile: 'Добавить файл',
    urlAdd: 'По ссылке',
    urlT: 'Вставить ссылку на файл',
    urlGo: 'Скачать', urlDl: 'Скачиваю с {h}…',
    urlStream: 'Подключаю поток с {h}…', streamAdded: 'Аудиокнига по ссылке добавлена',
    streamAddedN: 'Аудиокнига по ссылке · треков: {n}', urlNoAudio: 'на странице не нашлось аудио',
    urlBad: 'Это не похоже на ссылку',
    urlNoNet: 'Нет интернета — проверьте связь',
    urlHttp: 'сервер ответил {c}',
    urlNotBook: 'по ссылке веб-страница, а не файл книги',
    urlEmpty: 'файл пустой',
    urlBig: 'файл слишком большой',
    urlBlocked: 'сайт не отдаёт файл приложению',
    urlFail: 'Не получилось скачать: {e}',
    importFail: 'Не получилось добавить {n}: {e}',
    quotaFull: 'Закончилось место на устройстве. Удалите ненужные книги или освободите память — иначе прогресс и заметки не сохранятся.',
    saveFail: 'Не удалось сохранить: {e}',
    deleteBookQ: 'Удалить книгу «{x}» вместе с прогрессом чтения?',
    selectedN: 'Выбрано: {n}', deleteSelQ: 'Удалить выбранное ({n}) вместе с прогрессом?', deletedN: 'Удалено: {n}',
    bookDeleted: 'Книга удалена',
    dlgOk: 'ОК', dlgCancel: 'Отмена', dlgDelete: 'Удалить', dlgReset: 'Сбросить',
    dlgMark: 'Отметить', dlgUnmark: 'Снять',
    deleteT: 'Удалить книгу',
    booksN: 'Книг на полке: {n}',
    audioN: 'Аудиокниг на полке: {n}',
    toShelf: 'К полке',
    searchPh: 'Поиск по книге…', reading: 'Читаю',
    pronunSec: 'Произношение', pronunSecFull: 'Словарь произношений',
    pronunHint: 'Как читать слово при озвучке. Напр.: GIF → джиф',
    pronunFromPh: 'Слово', pronunToPh: 'Как читать', pronunAdd: 'Добавить', pronunDel: 'Убрать',
    pronunListT: 'Список слов', pronunAdded: 'Добавлено в словарь',
    pronunEmpty: 'Пока пусто', wpPron: 'Произношение', wpSay: 'Озвучить',
    otaReady: 'Обновление {v} готово', otaApply: 'Обновить',
    updateT: 'Проверить обновления', otaNoUpd: 'Обновлять нечего',
    otaNoNet: 'Не удалось проверить обновления',
    dlTitle: 'Загрузки', dlQueued: 'в очереди', dlWorking: 'обработка…', dlProgN: 'файл {i} из {n}', dlCancel: 'Отменить загрузку', dlEmpty: 'Нет активных загрузок',
    colTitle: 'Коллекции', colNew: 'Новая коллекция', colNamePh: 'Название коллекции',
    colRenameT: 'Переименовать коллекцию',
    colCancel: 'Отменить', colSave: 'Сохранить', colDelete: 'Удалить коллекцию',
    colDelConfirm: 'Удалить коллекцию «{n}»?', colAddT: 'В коллекцию',
    catTitle: 'Каталог', catWorld: 'Мировая литература',
    catClassics: 'Русская классика', catAudio: 'Аудиокниги',
    catNoBooks: 'В этом каталоге нет книг',
    catAddT: 'Добавить каталог', catUrlPh: 'https://адрес OPDS-каталога',
    catUserPh: 'Логин (если нужен)', catPassPh: 'Пароль (если нужен)',
    catNoUrl: 'Нужен адрес каталога', catSrvAdded: 'Каталог добавлен',
    catSrvDelQ: 'Убрать каталог «{n}»?',
    catLoading: 'Загружаю каталог…', catFail: 'Каталог не ответил. Нажми, чтобы попробовать ещё раз.',
    catEmptySec: 'Здесь пусто', catMoreLoad: 'Дальше…',
    catPickSec: 'Выбери раздел в списке каталога', catSecFail: 'Раздел не загрузился',
    catNoAudio: 'В этом каталоге нет аудиокниг', abTracksN: 'глав: {n}',
    catDlT: 'Скачать', catDoneT: 'Уже в библиотеке', catFmtNone: 'у книги нет файла, который можно скачать',
    catDlSelT: 'Скачать выбранное',
    shareFail: 'Не удалось принять файл',
    abDlBtn: 'Скачать на устройство',
    abDlDone: 'Скачано треков: {n}', abDlPart: 'Скачано {ok} из {n} треков — остальные можно докачать',
    catSearchPh: 'Поиск в каталоге…', fltCat: 'Каталог', fltDl: 'Скачано', fltNotDl: 'Не скачано',
    colPickTitle: 'В какие коллекции добавить', colAdd2: 'Добавить',
    syncPickTitle: 'Что сохранить?', syncKindBooks: 'Книги', syncKindAudio: 'Аудиокниги',
    syncPickNone: 'Отметьте хотя бы одно',
    colNoneYet: 'Сначала создайте коллекцию', colAdded: 'Добавлено в коллекции',
    colRemoveYes: 'Убрать', colRemoveNo: 'Оставить', colRemoved: 'Убрано из коллекции',
    moreAddT: 'Ещё способы',
    foldT: 'Объединить в сборник', foldN: 'в сборнике: {n}', foldRename: 'Название сборника',
    foldBreak: 'Расформировать сборник', foldNameQ: 'Название сборника',
    foldBreakQ: 'Расформировать сборник «{n}»?',
    foldBreakYes: 'Расформировать', foldMade: 'Сборник «{n}»', foldBroken: 'Сборник расформирован',
    foldOut: 'Убрать из сборника',
    timeLeft: '≈ {d} до конца', hUnit: 'ч', minUnit: 'мин',
    statStreak: 'серия', statToday: 'сегодня', dayShort: 'дн', wpm: 'сл/мин',
    otaAvail: 'Доступно обновление {v}', otaAvailApp: 'Доступно обновление приложения {v}',
    otaDownloading: 'Загружаю обновление…', otaFail: 'Не удалось обновить',
    otaInstall: 'Установить', otaDownloadingPct: 'Загружаю обновление… {p}%',
    otaInstalling: 'Открываю установщик…', otaNeedPerm: 'Разреши установку обновлений приложения',
    otaGrant: 'Разрешить', otaOldApp: 'Обнови приложение вручную один раз — дальше будет само',
    otaUpdated: 'Обновлено до {v}',
    scanTitle: 'Автопоиск книг', scanTitleT: 'Найти книги на устройстве',
    scanAll: 'Весь телефон', scanAllSub: 'Просканировать всю память',
    scanFolder: 'Отдельная папка', scanFolderSub: 'Выбрать, где искать',
    scanNeedPerm: 'Дай доступ к файлам, чтобы искать книги', scanGrant: 'Дать доступ',
    scanBusyStat: 'папок: {d} · найдено: {n}', scanFound: 'Найдено книг: {n}', scanNone: 'Книги не найдены',
    scanSelAll: 'Все', scanSelNone: 'Снять', scanReading: 'Читаю {i} из {n}…', scanTracks: '· {n} файлов',
    scanAdd: 'Добавить ({n})', scanAllFmt: 'Все · {n}',
    sortName: 'По алфавиту', sortDate: 'По дате', sortSize: 'По размеру',
    fltSort: 'Сортировка', sortAdded: 'По дате добавления', sortOnT: 'Включить или отключить сортировку',
    scanErr: 'Не удалось просканировать', scanNoNative: 'Автопоиск доступен только в приложении',
    start: 'Начать чтение', cont: 'Продолжить чтение', nextCh: 'Следующая глава',
    footer: 'Прочитано {r} из {t} глав ({p}%)',
    build: 'AD.Talewyn · {v}', buildBoth: 'AD.Talewyn · прил. {app} · веб {web}',
    meta: '{i} из {t}',
    back: 'Назад', next: 'Дальше',
    theme: 'Тема', textSec: 'Текст', auto: 'Авто', light: 'Светлая', sepia: 'Сепия', dark: 'Тёмная',
    autoS: 'Авто', lightS: 'Свет', darkS: 'Тёмн',
    bgSec: 'Фон полки', bgOn: 'Живой', bgOff: 'Выключен',
    font: 'Шрифт', serif: 'С засечками', sans: 'Гротеск',
    size: 'Размер', lh: 'Интервал',
    sizePrev: 'Тихий вечер опустился на город, и в тёплых окнах один за другим загорались огни.',
    lhPrev: 'Дорога вела через старый лес, где солнечный свет мягко пробивался сквозь листву.',
    readerPrev: 'Тихий вечер опустился на город, и в тёплых окнах один за другим загорались огни. Дорога вела через старый лес, где солнечный свет мягко пробивался сквозь листву.',
    align: 'Выравнивание', justify: 'По ширине', leftA: 'По левому', rightA: 'По правому',
    fontMore: 'Ещё шрифты — крути для выбора',
    width: 'Ширина', narrow: 'Узкая', medium: 'Средняя', wide: 'Широкая',
    lang: 'Язык', reset: 'Сбросить прогресс этой книги',
    resetQ: 'Сбросить прогресс чтения книги «{x}»? Отметки «прочитано» и позиции исчезнут.',
    resetDone: 'Прогресс чтения сброшен',
    chTip: 'Переключить отметку «прочитано»',
    volTip: 'Отметить раздел целиком', partTip: 'Отметить раздел целиком',
    markAllQ: 'Отметить все главы «{x}» прочитанными?',
    unmarkAllQ: 'Снять отметки «прочитано» со всех глав «{x}»?',
    jumpTo: 'Перейти к', foundIn: 'Найдено в тексте: {n}',
    first50: ' (показаны первые 50)', searching: 'Ищу в тексте…',
    nothing: 'Ничего не найдено',
    libFail: 'Не удалось открыть книгу ({e})',
    chMissing: 'Глава не найдена',
    chLoadFail: 'Не удалось открыть главу', retry: 'Повторить',
    listenHere: 'Озвучить', neural: 'нейро', deviceVoice: 'Голос устройства', onlineTag: 'онлайн',
    noVoices: 'Голоса не найдены — проверьте синтез речи в системе',
    neuralFallback: 'Нейроголос недоступен — перехожу на голос устройства',
    neuralHiccup: 'Сбой нейроголоса — этот абзац читает устройство',
    noTtsServer: 'Озвучка недоступна: нет связи с сервером голосов',
    needNet: 'Нужен интернет — этот голос онлайн',
    sleepT: 'Таймер сна', sleepOff: 'Выкл',
    sleepSet: 'Таймер сна: {m} мин', sleepFired: 'Таймер сна: озвучка остановлена',
    chDone: 'Глава озвучена до конца',
    annotAdd: 'Добавить описание книги…',
    annotEditT: 'Изменить описание',
    annotMore: 'Показать полностью', annotLess: 'Свернуть',
    annotPh: 'О чём эта книга?…',
    annotFind: 'Найти',
    annotFindPh: 'Поиск описания: название книги…',
    annotTitleL: 'Название', annotAuthorL: 'Автор', annotDescL: 'Описание',
    annotFindWeb: 'Найти описание в интернете',
    annotSearching: 'Ищу описание в интернете…',
    annotNone: 'Ничего не нашлось. Упростите запрос — например, оставьте только название.',
    bmT: 'Закладка', bmAdded: 'Закладка поставлена', bmRemoved: 'Закладка снята',
    bmBtn: 'Закладки', bmNone: 'Закладок пока нет.',
    bmHere: 'Здесь', autoScrollT: 'Автопрокрутка', autoScrollOn: 'Автопрокрутка: {v}', autoScrollOff: 'Автопрокрутка выключена',
    notesBtn: 'Заметки', notePh: 'Текст заметки…',
    noteSave: 'Сохранить', noteDelete: 'Удалить', noteHead: 'Заметка', trHead: 'Перевод',
    noteDeleted: 'Заметка удалена', undo: 'Отменить',
    noNotes: 'Пока нет ни выделений, ни заметок.',
    noNotesA: 'Пока нет заметок. Добавьте заметку на нужном моменте.',
    copyAll: 'Скопировать все', copied: 'Скопировано в буфер',
    copyFail: 'Не удалось скопировать',
    markT: 'Выделить цветом', noteT: 'Заметка',
    eraseT: 'Убрать выделение', noMarkHere: 'Здесь нет выделений',
    marksCleared: 'Убрано выделений: {n}',
    reviewBtn: 'Мой отзыв', reviewPh: 'Что вы думаете об этой книге?…',
    reviewShare: 'Поделиться', reviewSaved: 'Отзыв сохранён',
    trT: 'Перевести', trHdrT: 'Перевод главы',
    trTo: 'Перевод на', trLangLbl: 'Переводчик', trBusyOne: 'Перевожу…', trAuto: 'Авто',
    trBusy: 'Перевожу главу ({n} абзацев)…',
    trDone: 'Глава переведена — перевод под каждым абзацем',
    trFail: 'Переводчик недоступен — попробуйте позже',
    wpMore: 'Подробнее',
    trPartial: 'Перевод прерван: переводчик ограничил запросы. Нажмите глобус ещё раз позже — готовое не переводится заново.',
    copyOne: 'Скопировать',
    backupT: 'Сохранить копию библиотеки',
    restoreT: 'Восстановить из копии',
    backupPrep: 'Готовлю копию: «{n}»…',
    backupDone: 'Копия сохранена', backupSavedTo: 'Копия сохранена в «Загрузки»',
    restorePct: 'Восстановление: {p}%',
    backupFail: 'Не получилось сохранить копию: {e}',
    restoreBusy: 'Восстанавливаю: «{n}»…',
    restoreDone: 'Восстановлено книг: {n}',
    restoreMixed: 'Восстановлено: {n}, уже на полке: {s}',
    restoreNone: 'Все книги из копии уже на полке',
    notBackup: 'это не копия библиотеки AD.Talewyn',
    syncSaved: 'Файл синхронизации сохранён', syncShare: 'Выбери, куда сохранить файл',
    syncSavedTo: 'Файл синхронизации сохранён в «Загрузки»',
    syncResHead: 'Синхронизация', syncResAdd: 'добавлено книг: {n}', syncResUpd: 'обновлено книг: {n}',
    syncResNone: 'изменений нет', syncMissing: 'не найдено на устройстве: {x}',
    syncT: 'Синхронизация и копия',
    syncLight: 'Синхронизация прогресса', syncLightSub: 'Лёгкий файл: прогресс, заметки, закладки, коллекции — без самих книг',
    syncFull: 'Полная копия', syncFullSub: 'Всё вместе с книгами — для резервной копии',
    syncLoad: 'Загрузить и объединить', syncLoadSub: 'Принимает и файл синхронизации, и полную копию — объединит без повторов',
    settingsT: 'Настройки', infoT: 'О приложении', infoSocial: 'Контакты', infoLicense: 'Лицензия и авторство',
    licApp: 'AD.Talewyn — приложение для чтения книг.',
    licRights: '© 2026 Archidexter. Все права на приложение защищены.',
    licFiles: 'Книги и другие файлы, которые вы добавляете, принадлежат их правообладателям. Приложение хранит их только на вашем устройстве и никуда не передаёт.',
    licCatalog: 'Каталог показывает книги из открытых легальных источников — общественное достояние и свободные лицензии. Правовой статус произведения может отличаться от страны к стране: скачивая книгу, вы подтверждаете, что в вашей стране это разрешено.',
    licSources: 'Источники каталога: Викитека — свободная библиотека Викимедии (ru.wikisource.org), Project Gutenberg (gutenberg.org), LibriVox (librivox.org). Сведения об авторах, участниках и лицензиях сохраняются внутри самих скачанных книг.',
    backT: 'К оглавлению', listenT: 'Слушать главу',
    prevParaT: 'Абзац назад', nextParaT: 'Абзац вперёд',
    pauseT: 'Пауза/продолжить', stopT: 'Остановить', rateT: 'Скорость',
    slowerT: 'Медленнее', fasterT: 'Быстрее', voiceT: 'Голос', ttsKick: 'Озвучка',
    secApp: 'Приложение', secLibrary: 'Библиотека',
    prevChT: 'Предыдущая глава', nextChT: 'Следующая глава',
  },
  en: {
    appName: 'AD.Talewyn',
    shelfSub: '— your library',
    filtersT: 'Filters', filterSearch: 'Search by title or author…',
    filterAuthor: 'Author', filterGenre: 'Genre', filterAll: 'All',
    fltStatus: 'Status', stProgress: 'In progress',
    stNew: 'Unread', stRead: 'Read', stNewA: 'Not listened', stReadA: 'Listened',
    filterReset: 'Reset filters', filterNone: 'Nothing matches the filters.',
    addBook: 'Add books',
    tabBooks: 'Books', tabAudio: 'Audiobooks',
    coverLabel: 'Cover', coverEdit: 'Change', coverDel: 'Delete', coverReset: 'Restore original cover', editT: 'Edit', noteJump: 'Jump to',
    audioSoonT: 'Audiobooks coming soon', audioSoonSub: 'Audio-format support is in the works.',
    abAdd: 'Add audiobooks', abTracks: 'Tracks', abCont: 'Continue listening',
    abEmptyT: 'No audiobooks yet', abEmptySub: 'Add audio files — mp3, m4a, m4b, ogg, opus…',
    emptyShelf: 'The shelf is empty.',
    emptyHint: 'Add a book — EPUB, FB2 or .fbook. Everything is stored on this device.',
    importing: 'Importing: {n}…',
    imported: 'Added: “{n}”',
    dupBook: '“{n}” is already in your library',
    addFile: 'Add a file',
    urlAdd: 'From link',
    urlT: 'Paste a file link',
    urlGo: 'Download', urlDl: 'Downloading from {h}…',
    urlStream: 'Connecting stream from {h}…', streamAdded: 'Audiobook added from link',
    streamAddedN: 'Audiobook from link · tracks: {n}', urlNoAudio: 'no audio found on the page',
    urlBad: 'That does not look like a link',
    urlNoNet: 'No internet — check your connection',
    urlHttp: 'server returned {c}',
    urlNotBook: 'the link points to a web page, not a book file',
    urlEmpty: 'the file is empty',
    urlBig: 'the file is too large',
    urlBlocked: 'the site refuses to give the file to the app',
    urlFail: 'Could not download: {e}',
    importFail: 'Failed to add {n}: {e}',
    quotaFull: 'The device is out of storage. Delete some books or free up space — otherwise progress and notes will not be saved.',
    saveFail: 'Could not save: {e}',
    deleteBookQ: 'Delete “{x}” along with its reading progress?',
    selectedN: 'Selected: {n}', deleteSelQ: 'Delete selected ({n}) along with progress?', deletedN: 'Deleted: {n}',
    bookDeleted: 'Book deleted',
    dlgOk: 'OK', dlgCancel: 'Cancel', dlgDelete: 'Delete', dlgReset: 'Reset',
    dlgMark: 'Mark', dlgUnmark: 'Clear',
    deleteT: 'Delete book',
    booksN: 'Books on the shelf: {n}',
    audioN: 'Audiobooks on the shelf: {n}',
    toShelf: 'To the shelf',
    searchPh: 'Search this book…', reading: 'Reading',
    pronunSec: 'Pronunciation', pronunSecFull: 'Pronunciation dictionary',
    pronunHint: 'How a word is read aloud. E.g. GIF → jif',
    pronunFromPh: 'Word', pronunToPh: 'How to read it', pronunAdd: 'Add', pronunDel: 'Remove',
    pronunListT: 'Word list', pronunAdded: 'Added to dictionary',
    pronunEmpty: 'Empty', wpPron: 'Pronunciation', wpSay: 'Speak',
    otaReady: 'Update {v} ready', otaApply: 'Update',
    updateT: 'Check for updates', otaNoUpd: 'Nothing to update',
    otaNoNet: "Couldn't check for updates",
    dlTitle: 'Downloads', dlQueued: 'queued', dlWorking: 'processing…', dlProgN: 'file {i} of {n}', dlCancel: 'Cancel download', dlEmpty: 'No active downloads',
    colTitle: 'Collections', colNew: 'New collection', colNamePh: 'Collection name',
    colRenameT: 'Rename collection',
    colCancel: 'Cancel', colSave: 'Save', colDelete: 'Delete collection',
    colDelConfirm: 'Delete collection "{n}"?', colAddT: 'To collection',
    catTitle: 'Catalog', catWorld: 'World literature',
    catClassics: 'Russian classics', catAudio: 'Audiobooks',
    catNoBooks: 'No books in this catalog',
    catAddT: 'Add a catalog', catUrlPh: 'https://OPDS catalog address',
    catUserPh: 'Username (if needed)', catPassPh: 'Password (if needed)',
    catNoUrl: 'Catalog address required', catSrvAdded: 'Catalog added',
    catSrvDelQ: 'Remove catalog "{n}"?',
    catLoading: 'Loading the catalog…', catFail: 'The catalog did not respond. Tap to retry.',
    catEmptySec: 'Nothing here', catMoreLoad: 'More…',
    catPickSec: 'Pick a section in the catalog list', catSecFail: 'Section failed to load',
    catNoAudio: 'No audiobooks in this catalog', abTracksN: 'chapters: {n}',
    catDlT: 'Download', catDoneT: 'Already in your library', catFmtNone: 'this book has no downloadable file',
    catDlSelT: 'Download selected',
    shareFail: 'Could not receive the file',
    abDlBtn: 'Download to device',
    abDlDone: 'Tracks downloaded: {n}', abDlPart: 'Downloaded {ok} of {n} tracks — retry for the rest',
    catSearchPh: 'Search this catalog…', fltCat: 'Catalog', fltDl: 'Downloaded', fltNotDl: 'Not downloaded',
    colPickTitle: 'Add to which collections', colAdd2: 'Add',
    syncPickTitle: 'What to save?', syncKindBooks: 'Books', syncKindAudio: 'Audiobooks',
    syncPickNone: 'Tick at least one',
    colNoneYet: 'Create a collection first', colAdded: 'Added to collections',
    colRemoveYes: 'Remove', colRemoveNo: 'Keep', colRemoved: 'Removed from collection',
    moreAddT: 'More ways',
    foldT: 'Group into a set', foldN: 'in the set: {n}', foldRename: 'Set name',
    foldBreak: 'Break up the set', foldNameQ: 'Set name',
    foldBreakQ: 'Break up the set "{n}"?',
    foldBreakYes: 'Break up', foldMade: 'Set "{n}"', foldBroken: 'Set broken up',
    foldOut: 'Take out of the set',
    timeLeft: '≈ {d} left', hUnit: 'h', minUnit: 'min',
    statStreak: 'streak', statToday: 'today', dayShort: 'd', wpm: 'wpm',
    otaAvail: 'Update {v} available', otaAvailApp: 'App update {v} available',
    otaDownloading: 'Downloading update…', otaFail: 'Update failed',
    otaInstall: 'Install', otaDownloadingPct: 'Downloading update… {p}%',
    otaInstalling: 'Opening installer…', otaNeedPerm: 'Allow installing app updates',
    otaGrant: 'Allow', otaOldApp: 'Update the app manually once — after that it is automatic',
    otaUpdated: 'Updated to {v}',
    scanTitle: 'Find books', scanTitleT: 'Find books on device',
    scanAll: 'Whole phone', scanAllSub: 'Scan all storage',
    scanFolder: 'A folder', scanFolderSub: 'Choose where to look',
    scanNeedPerm: 'Grant file access to search for books', scanGrant: 'Grant',
    scanBusyStat: 'folders: {d} · found: {n}', scanFound: 'Books found: {n}', scanNone: 'No books found',
    scanSelAll: 'All', scanSelNone: 'None', scanReading: 'Reading {i} of {n}…', scanTracks: '· {n} files',
    scanAdd: 'Add ({n})', scanAllFmt: 'All formats · {n}',
    sortName: 'A–Z', sortDate: 'By date', sortSize: 'By size',
    fltSort: 'Sorting', sortAdded: 'By date added', sortOnT: 'Toggle sorting',
    scanErr: 'Scan failed', scanNoNative: 'Auto-search works only in the app',
    start: 'Start reading', cont: 'Continue reading', nextCh: 'Next chapter',
    footer: '{r} of {t} chapters read ({p}%)',
    build: 'AD.Talewyn · {v}', buildBoth: 'AD.Talewyn · app {app} · web {web}',
    meta: '{i} of {t}',
    back: 'Back', next: 'Next',
    theme: 'Theme', textSec: 'Text', auto: 'Auto', light: 'Light', sepia: 'Sepia', dark: 'Dark',
    autoS: 'Auto', lightS: 'Light', darkS: 'Dark',
    bgSec: 'Shelf background', bgOn: 'Living', bgOff: 'Off',
    font: 'Font', serif: 'Serif', sans: 'Sans',
    size: 'Size', lh: 'Spacing',
    sizePrev: 'A quiet evening settled over the town, and warm lights came on in the windows one by one.',
    lhPrev: 'The road led through an old forest, where sunlight filtered gently through the leaves.',
    readerPrev: 'A quiet evening settled over the town, and warm lights came on in the windows one by one. The road led through an old forest, where sunlight filtered gently through the leaves.',
    align: 'Alignment', justify: 'Justified', leftA: 'Left', rightA: 'Right',
    fontMore: 'More fonts — scroll to pick',
    width: 'Width', narrow: 'Narrow', medium: 'Medium', wide: 'Wide',
    lang: 'Language', reset: 'Reset progress for this book',
    resetQ: 'Reset reading progress for “{x}”? Read marks and positions will disappear.',
    resetDone: 'Reading progress reset',
    chTip: 'Toggle “read” mark',
    volTip: 'Mark the whole section', partTip: 'Mark the whole section',
    markAllQ: 'Mark all chapters of “{x}” as read?',
    unmarkAllQ: 'Clear “read” marks from all chapters of “{x}”?',
    jumpTo: 'Jump to', foundIn: 'Found in text: {n}',
    first50: ' (first 50 shown)', searching: 'Searching the text…',
    nothing: 'Nothing found',
    libFail: 'Failed to open the book ({e})',
    chMissing: 'Chapter not found',
    chLoadFail: 'Failed to open the chapter', retry: 'Retry',
    listenHere: 'Speak', neural: 'neural', deviceVoice: 'Device voice', onlineTag: 'online',
    noVoices: 'No voices found — check text-to-speech in your system',
    neuralFallback: 'Neural voice unavailable — switching to a device voice',
    neuralHiccup: 'Neural glitch — this paragraph on the device voice',
    noTtsServer: 'Narration unavailable: no connection to the voice server',
    needNet: 'Internet required — this voice is online',
    sleepT: 'Sleep timer', sleepOff: 'Off',
    sleepSet: 'Sleep timer: {m} min', sleepFired: 'Sleep timer: narration stopped',
    chDone: 'Chapter narrated to the end',
    annotAdd: 'Add a book description…',
    annotEditT: 'Edit description',
    annotMore: 'Show more', annotLess: 'Show less',
    annotPh: 'What is this book about?…',
    annotFind: 'Find',
    annotFindPh: 'Search for a description: book title…',
    annotTitleL: 'Title', annotAuthorL: 'Author', annotDescL: 'Description',
    annotFindWeb: 'Find a description online',
    annotSearching: 'Searching the web for a description…',
    annotNone: 'Nothing found. Simplify the query — e.g., keep just the title.',
    bmT: 'Bookmark', bmAdded: 'Bookmark added', bmRemoved: 'Bookmark removed',
    bmBtn: 'Bookmarks', bmNone: 'No bookmarks yet.',
    bmHere: 'Here', autoScrollT: 'Auto-scroll', autoScrollOn: 'Auto-scroll: {v}', autoScrollOff: 'Auto-scroll off',
    notesBtn: 'Notes', notePh: 'Note text…',
    noteSave: 'Save', noteDelete: 'Delete', noteHead: 'Note', trHead: 'Translation',
    noteDeleted: 'Note deleted', undo: 'Undo',
    noNotes: 'No highlights or notes yet.',
    noNotesA: 'No notes yet. Add one at the current moment.',
    copyAll: 'Copy all', copied: 'Copied to clipboard',
    copyFail: 'Failed to copy',
    markT: 'Highlight with colour', noteT: 'Note',
    eraseT: 'Remove highlight', noMarkHere: 'No highlights here',
    marksCleared: 'Highlights removed: {n}',
    reviewBtn: 'My review', reviewPh: 'What do you think of this book?…',
    reviewShare: 'Share', reviewSaved: 'Review saved',
    trT: 'Translate', trHdrT: 'Translate chapter',
    trTo: 'Translate into', trLangLbl: 'Translator', trBusyOne: 'Translating…', trAuto: 'Auto',
    trBusy: 'Translating the chapter ({n} paragraphs)…',
    trDone: 'Chapter translated — see below each paragraph',
    trFail: 'Translator unavailable — try again later',
    wpMore: 'More',
    trPartial: 'Translation interrupted: the translator rate-limited us. Tap the globe again later — finished parts are kept.',
    copyOne: 'Copy',
    backupT: 'Save a library backup',
    restoreT: 'Restore from backup',
    backupPrep: 'Preparing backup: “{n}”…',
    backupDone: 'Backup saved', backupSavedTo: 'Backup saved to Downloads',
    restorePct: 'Restoring: {p}%',
    backupFail: 'Failed to save the backup: {e}',
    restoreBusy: 'Restoring: “{n}”…',
    restoreDone: 'Books restored: {n}',
    restoreMixed: 'Restored: {n}, already on the shelf: {s}',
    restoreNone: 'All books from the backup are already on the shelf',
    notBackup: 'this is not an AD.Talewyn library backup',
    syncSaved: 'Sync file saved', syncShare: 'Choose where to save the file',
    syncSavedTo: 'Sync file saved to Downloads',
    syncResHead: 'Synchronization', syncResAdd: 'books added: {n}', syncResUpd: 'books updated: {n}',
    syncResNone: 'no changes', syncMissing: 'not found on device: {x}',
    syncT: 'Sync & backup',
    syncLight: 'Sync reading progress', syncLightSub: 'Light file: progress, notes, bookmarks, collections — without the books',
    syncFull: 'Full copy', syncFullSub: 'Everything with the books — for backup',
    syncLoad: 'Load & merge', syncLoadSub: 'Takes both a sync file and a full copy — merges without duplicates',
    settingsT: 'Settings', infoT: 'About', infoSocial: 'Contacts', infoLicense: 'License & credits',
    licApp: 'AD.Talewyn — a book-reading app.',
    licRights: '© 2026 Archidexter. All rights to the app reserved.',
    licFiles: 'Books and other files you add belong to their rights holders. The app stores them only on your device and never sends them anywhere.',
    licCatalog: 'The catalog offers books from open, legal sources only — public domain and free licenses. Copyright status varies by country: by downloading a book you confirm this is permitted where you live.',
    licSources: 'Catalog sources: Wikisource — the free Wikimedia library (ru.wikisource.org), Project Gutenberg (gutenberg.org), LibriVox (librivox.org). Author, contributor and license information is preserved inside the downloaded books themselves.',
    backT: 'To contents', listenT: 'Listen to chapter',
    prevParaT: 'Previous paragraph', nextParaT: 'Next paragraph',
    pauseT: 'Pause/resume', stopT: 'Stop', rateT: 'Speed',
    slowerT: 'Slower', fasterT: 'Faster', voiceT: 'Voice', ttsKick: 'Narration',
    secApp: 'Application', secLibrary: 'Library',
    prevChT: 'Previous chapter', nextChT: 'Next chapter',
  },
};
const urlParams = new URLSearchParams(location.search);
const urlLang = urlParams.get('lang');
const uiLang = () => (['ru', 'en'].includes(urlLang) ? urlLang : settings.lang);
const t = k => (I18N[uiLang()] || I18N.ru)[k] ?? I18N.ru[k] ?? k;
const T = (k, vars) => t(k).replace(/\{(\w+)\}/g, (_, v) => vars[v]);

function applyLang() {
  document.documentElement.lang = uiLang();
  for (const el of document.querySelectorAll('[data-i18n]'))
    el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-ph]'))
    el.placeholder = t(el.dataset.i18nPh);
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', t(el.dataset.i18nTitle));
  }
  updateTitle();
  if (!$('#shelf-view').hidden) renderShelf();
  else if (!$('#library-view').hidden && state.book) {
    renderContinue(); renderChips(); renderToc(); renderFooter();
  } else if (state.chapter) {
    const ch = state.chapter;
    setChapterMeta(ch.index, ch.total);
    renderNav(ch);
  }
  syncVoiceSelect();
}

function updateTitle() {
  document.title = state.chapter && !$('#reader-view').hidden
    ? `${state.chapter.title} — ${state.book ? state.book.title : t('appName')}`
    : state.book && !$('#library-view').hidden ? `${state.book.title} — ${t('appName')}`
    : t('appName');
}

function loadSettings() {
  const raw = safeParse(SETTINGS_KEY, {}, v => typeof v === 'object' && !Array.isArray(v));
  const s = Object.assign({}, DEFAULT_SETTINGS, raw);
  if (!['auto', 'light', 'sepia', 'dark', 'teal', 'royal', 'bordo', 'black'].includes(s.theme)) s.theme = 'dark';
  if (!READER_FONTS.includes(s.font)) s.font = 'serif';
  if (!['narrow', 'medium', 'wide'].includes(s.width)) s.width = 'medium';
  if (!['justify', 'left', 'right'].includes(s.align)) s.align = DEFAULT_SETTINGS.align;
  // разовый перевод старого мобильного умолчания «по левому» → «по ширине» (по умолчанию)
  if (!raw.alignMigrated) { if (s.align === 'left') s.align = 'justify'; s.alignMigrated = true; }
  if (!['off', 'on'].includes(s.wake)) s.wake = 'off';
  if (!['on', 'off'].includes(s.bg)) s.bg = DEFAULT_SETTINGS.bg;
  s.size = Math.min(26, Math.max(14, Number(s.size) || DEFAULT_SETTINGS.size));
  s.lh = Math.min(2.0, Math.max(1.4, Number(s.lh) || DEFAULT_SETTINGS.lh));
  if (!['ru', 'en'].includes(s.lang)) s.lang = DEFAULT_SETTINGS.lang;
  s.ttsRate = Math.min(2.0, Math.max(0.5, Number(s.ttsRate) || 1.0));
  if (typeof s.ttsVoice !== 'string') s.ttsVoice = '';
  if (!['ru', 'en', 'ja', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'uk', 'zh-CN', 'ko', 'tr'].includes(s.trLang))
    s.trLang = s.lang === 'ru' ? 'ru' : 'en';
  if (!['auto', 'ru', 'en', 'ja', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'uk', 'zh-CN', 'ko', 'tr'].includes(s.trChoice))
    s.trChoice = 'auto';
  // словарь произношений: только валидные пары {from, to} (+ необязательный lang на будущее)
  s.pronun = Array.isArray(s.pronun)
    ? s.pronun
        .filter(e => e && typeof e.from === 'string' && typeof e.to === 'string' && e.from.trim() && e.to.trim())
        .map(e => ({ from: e.from.trim(), to: e.to.trim(), lang: typeof e.lang === 'string' ? e.lang : '' }))
    : [];
  return s;
}

const settings = loadSettings();
let expanded = new Set();

// ══════════════════ оформление ══════════════════
// мера в em (не rem): считается от читательского кегля --reader-fs (см. .chapter{font-size:var(--reader-fs)}),
// поэтому длина строки держится ~60/66/72 знака при ЛЮБОМ размере шрифта — на планшете/складне строка не растягивается
const WIDTHS = { narrow: '30em', medium: '34em', wide: '40em' };
const mqDark = matchMedia('(prefers-color-scheme: dark)');
const urlTheme = urlParams.get('theme');

function applySettings() {
  const pref = ['light', 'sepia', 'dark', 'auto'].includes(urlTheme)
    ? urlTheme : settings.theme;
  const theme = pref === 'auto' ? (mqDark.matches ? 'dark' : 'light') : pref;
  // Смена темы: цвет перетекает только у крупных поверхностей (фон, шторка, шапка,
  // поля и кнопки) — их на экране десятки. Переходы на ВС�ём дереве или системный
  // кроссфейд со снимком страницы телефон не тянет: подвисает на четверть секунды.
  const shift = themeSwitch.last && themeSwitch.last !== theme;
  themeSwitch.last = theme;
  const smooth = shift && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Тяжёлый пересчёт всей страницы при смене темы прячем за системный кроссфейд:
  // браузер снимает кадр «до», делает пересчёт под снимком и переливает старый кадр
  // в новый. Размытие за панелями при этом не трогаем — иначе панели «щёлкают».
  if (smooth && !themeSwitch.busy && document.startViewTransition) {
    themeSwitch.busy = true;
    try {
      const vt = document.startViewTransition(() => applyTheme(theme, false));
      vt.finished.catch(() => {}).finally(() => { themeSwitch.busy = false; });
      return;
    } catch { themeSwitch.busy = false; }
  }
  applyTheme(theme, smooth);
}
function themeSwitch() {}
themeSwitch.last = '';
let themeShiftT = 0;

function applyTheme(theme, smooth) {
  document.documentElement.className = 't-' + theme + (smooth ? ' theme-shift' : '');
  if (smooth) {
    clearTimeout(themeShiftT);
    themeShiftT = setTimeout(() => document.documentElement.classList.remove('theme-shift'), 320);
  }
  const st = document.documentElement.style;
  st.setProperty('--reader-fs', settings.size + 'px');
  st.setProperty('--reader-lh', settings.lh);
  st.setProperty('--measure', WIDTHS[settings.width] || WIDTHS.medium);
  st.setProperty('--reader-font', FONT_FAMILY[settings.font] || FONT_FAMILY.serif);
  st.setProperty('--reader-align', settings.align);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  $('meta[name=theme-color]').setAttribute('content', bg);
  // Перекраску окна и пересборку заготовок блеска откладываем на после перехода:
  // и то и другое — тяжёлые разовые операции, а посреди анимации они дают рывок.
  // Особенно заметно на переходе светлая↔тёмная, где меняется вообще всё.
  // фон полки перекрашиваем сразу — иначе он отстаёт от остального интерфейса
  // на пол-секунды и это видно; перерисовка плиты дешёвая, тяжёлые заготовки
  // блеска пересобираются потом, по одной за кадр
  if (window.__shelfBgTheme) window.__shelfBgTheme();
  // а вот перекраску окна нативу отдаём после перехода: это разовая тяжёлая операция
  clearTimeout(applyTheme.after);
  applyTheme.after = setTimeout(() => {
    try { if (window.AndroidTheme && AndroidTheme.setColor) AndroidTheme.setColor(bg); } catch {}
  }, 360);
  // живой фон полки (Патина)
  document.body.classList.toggle('bg-live', settings.bg === 'on');
  persistSettings();   // ползунок шрифта шлёт события пачками — пишем настройки один раз в конце
  updateWakeLock();
  if (applyLang.last !== settings.lang) {
    applyLang.last = settings.lang;
    applyLang();
  }
  syncSettingsUI();
}

// запись настроек с задержкой: applySettings зовётся на каждый шаг ползунка размера/интервала
let settingsSaveT = 0;
function persistSettings(now) {
  clearTimeout(settingsSaveT);
  if (now) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} return; }
  settingsSaveT = setTimeout(() => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} }, 250);
}

let wakeLock = null;
async function updateWakeLock() {
  const want = (settings.wake === 'on' || (tts.active && tts.playing))
    && !$('#reader-view').hidden
    && document.visibilityState === 'visible';
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* система отказала — не страшно */ }
  } else if (!want && wakeLock) {
    try { wakeLock.release(); } catch {}
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { updateWakeLock(); if (window.shelfBgKick) window.shelfBgKick(); }
});
mqDark.addEventListener('change', () => { if (settings.theme === 'auto') applySettings(); });

// Живой фон полки (Патина) — два холста вместо пяти слоёв, без режимов смешивания.
//
// «Плита» (.sbg-plate) неподвижна и содержит всё, что не шевелится: цвет темы,
// зерно, виньетку. Рисуется один раз — при запуске, смене темы и повороте экрана.
// «Живой» холст (.sbg-live) содержит крупку и блеск и ездит параллаксом.
//
// Почему так. Раньше фон был пятью полноэкранными слоями, два из которых
// накладывались режимами «перекрытие» и «экран». Режим смешивания обязывает
// видеокарту перечитать всё, что лежит под слоем, и так на КАЖДОМ кадре — это
// дороже всей остальной отрисовки вместе взятой. Плюс каждая смена темы
// перерисовывала все пять слоёв разом. Теперь слоёв два, смешивания нет ни одного,
// а кадр движения — это три готовых картинки, положенные друг на друга.
(function shelfBgTilt() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let tx = 0, ty = 0, gx = 0, gy = 0, gT = -9, T = 0;
  let plate = null, pctx = null, live = null, lctx = null, W = 0, H = 0, DPR = 1;
  let parts = null, sampling = false, haloSprite = null, spriteGild = '';
  let fleckSprite = null, grainImg = null, fleckImg = null, imgsReady = false;
  let running = false, paused = false, gild = '', bgCol = '', lastDraw = -9, lastMove = -9;

  addEventListener('deviceorientation', e => {
    if (e.gamma == null && e.beta == null) return;
    const nx = Math.max(-1, Math.min(1, (e.gamma || 0) / 24));
    const ny = Math.max(-1, Math.min(1, ((e.beta || 45) - 45) / 24));
    if (Math.abs(nx - gx) < 0.02 && Math.abs(ny - gy) < 0.02 && T - gT < 2) return;
    gT = T; gx = nx; gy = ny;
    if (window.shelfBgKick) window.shelfBgKick();
  }, true);

  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const urlOf = v => { const m = /url\((['"]?)(.*?)\1\)/.exec(v || ''); return m ? m[2] : ''; };
  // вес маски крупки: золото сверху и снизу, середина пустая (та же кривая, что была в CSS)
  function maskW(y) { if (y < 0.40) return 1 - y / 0.40; if (y > 0.62) return (y - 0.62) / 0.38; return 0; }
  function hexA(hex, a) { hex = (hex || '#d8a54f').trim().replace('#', ''); if (hex.length === 3) hex = hex.split('').map(c => c + c).join(''); const n = parseInt(hex, 16); return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }
  function flakeShape() { const n = 3 + (Math.random() * 3 | 0), r0 = 0.7 + Math.random() * 1.3, pts = []; for (let k = 0; k < n; k++) { const ang = (k / n) * Math.PI * 2 + Math.random() * 0.7, rr = r0 * (0.55 + Math.random() * 0.8); pts.push([Math.cos(ang) * rr, Math.sin(ang) * rr]); } return pts; }
  function buildHalo(g) { const s = document.createElement('canvas'); s.width = s.height = 24; const c = s.getContext('2d'); const gr = c.createRadialGradient(12, 12, 0, 12, 12, 12); gr.addColorStop(0, hexA(g, 0.85)); gr.addColorStop(0.45, hexA(g, 0.3)); gr.addColorStop(1, hexA(g, 0)); c.fillStyle = gr; c.fillRect(0, 0, 24, 24); haloSprite = s; spriteGild = g; }

  // картинки зерна и крупки берём из тех же CSS-переменных, что и раньше: рисунок не меняется
  function loadImages(done) {
    if (imgsReady) return done();
    let left = 2;
    const fin = () => { if (--left === 0) { imgsReady = true; done(); } };
    grainImg = new Image(); grainImg.onload = fin; grainImg.onerror = fin; grainImg.src = urlOf(cssVar('--grain'));
    fleckImg = new Image(); fleckImg.onload = fin; fleckImg.onerror = fin; fleckImg.src = urlOf(cssVar('--fleck'));
  }

  // ── неподвижная плита: цвет темы + зерно + виньетка ──
  function drawPlate() {
    if (!pctx || !W || !H) return;
    pctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    pctx.clearRect(0, 0, W, H);
    pctx.fillStyle = bgCol || '#151719';
    pctx.fillRect(0, 0, W, H);
    if (grainImg && grainImg.width) {              // зерно: та же плитка 180×180
      pctx.globalAlpha = 0.35;
      const p = pctx.createPattern(grainImg, 'repeat');
      if (p) { pctx.fillStyle = p; pctx.fillRect(0, 0, W, H); }
      pctx.globalAlpha = 1;
    }
    const vg = pctx.createRadialGradient(W * 0.5, H * 0.48, Math.min(W, H) * 0.2,
      W * 0.5, H * 0.48, Math.max(W, H) * 0.72);   // виньетка тем же рисунком, что была в CSS
    vg.addColorStop(0.52, 'rgba(0,0,0,0)');
    vg.addColorStop(0.80, 'rgba(0,0,0,.22)');
    vg.addColorStop(1, 'rgba(0,0,0,.46)');
    pctx.fillStyle = vg; pctx.fillRect(0, 0, W, H);
  }

  // ── спрайт крупки: рисунок из маски, окрашенный в золото темы, с той же
  //    вертикальной растушёвкой (сверху и снизу густо, в середине пусто) ──
  function buildFleck() {
    if (!fleckImg || !fleckImg.width || !W || !H) return;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(W * DPR)); cv.height = Math.max(1, Math.round(H * DPR));
    const c = cv.getContext('2d');
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    const sc = Math.max(W / fleckImg.width, H / fleckImg.height);   // «cover», как делал CSS
    const dw = fleckImg.width * sc, dh = fleckImg.height * sc;
    c.drawImage(fleckImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
    c.globalCompositeOperation = 'source-in';       // белую крупку красим в золото
    c.fillStyle = gild || '#d8a54f';
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'destination-in';  // и растушёвываем по вертикали
    const mg = c.createLinearGradient(0, 0, 0, H);
    mg.addColorStop(0, 'rgba(0,0,0,1)');
    mg.addColorStop(0.40, 'rgba(0,0,0,0)');
    mg.addColorStop(0.62, 'rgba(0,0,0,0)');
    mg.addColorStop(1, 'rgba(0,0,0,1)');
    c.fillStyle = mg; c.fillRect(0, 0, W, H);
    fleckSprite = cv;
  }

  // ── позиции искр: считаны с самой крупки, чтобы блеск падал ровно на крупинки ──
  function procedural() {
    const arr = [];
    for (let i = 0; i < 900; i++) {
      const top = Math.random() < 0.5, e = Math.pow(Math.random(), 1.5);
      const y = top ? e * 0.40 : 1 - e * 0.38, w = maskW(y);
      if (w < 0.06) continue;
      const a = Math.random() * Math.PI * 2;
      arr.push({ x: Math.random(), y, fx: Math.cos(a), fy: Math.sin(a), w, sharp: 1.3 + Math.random() * 1.7, gain: 0.9 + Math.random() * 0.8, shape: flakeShape() });
    }
    return arr;
  }
  // Точки крупки собираем ПОРЦИЯМИ — по куску за кадр. Разом это полсекунды работы,
  // и телефон встаёт колом ровно в тот момент, когда открывается полка.
  let scan = null;
  function sample() {
    if (!fleckImg || !fleckImg.width) { parts = procedural(); return; }
    sampling = true;
    try {
      const sw = Math.max(1, Math.round(W)), sh = Math.max(1, Math.round(H));
      const off = document.createElement('canvas'); off.width = sw; off.height = sh;
      const oc = off.getContext('2d');
      const sc = Math.max(sw / fleckImg.width, sh / fleckImg.height);
      const dw = fleckImg.width * sc, dh = fleckImg.height * sc;
      oc.drawImage(fleckImg, (sw - dw) / 2, (sh - dh) / 2, dw, dh);
      scan = { d: oc.getImageData(0, 0, sw, sh).data, sw, sh, y: 0, arr: [] };
    } catch (e) { parts = procedural(); sampling = false; }
  }
  function sampleStep() {
    if (!scan) return;
    const { d, sw, sh, arr } = scan, step = 5;
    const until = Math.min(sh, scan.y + 260);          // ~260 строк за кадр
    for (; scan.y < until && arr.length < 3000; scan.y += step) {
      const ny = scan.y / sh, w = maskW(ny); if (w < 0.06) continue;
      for (let px = 0; px < sw && arr.length < 3000; px += step) {
        if (d[(scan.y * sw + px) * 4 + 3] > 120) {
          const a = Math.random() * Math.PI * 2;
          arr.push({ x: px / sw, y: ny, fx: Math.cos(a), fy: Math.sin(a), w, sharp: 1.3 + Math.random() * 1.7, gain: 0.9 + Math.random() * 0.8, shape: flakeShape() });
        }
      }
    }
    if (scan.y >= sh || arr.length >= 3000) {
      parts = arr.length ? arr : procedural();
      scan = null; sampling = false;
    }
  }

  // ── блеск: 12 заранее отрисованных направлений света, в кадре берутся два соседних ──
  const PHASES = 12;
  let phases = null, phaseGild = "";
  function resetPhases() { phases = null; }
  function buildPhase(i) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(W)); cv.height = Math.max(1, Math.round(H));
    const c = cv.getContext('2d');
    const ang = (i / PHASES) * Math.PI * 2, lx = Math.cos(ang), ly = Math.sin(ang);
    for (const p of parts) {
      const dot = p.fx * lx + p.fy * ly; if (dot <= 0) continue;
      let a = Math.pow(dot, p.sharp) * p.gain * p.w;
      if (a < 0.02) continue; if (a > 1) a = 1;
      const cx = p.x * cv.width, cy = p.y * cv.height, R = 2.6 + a * 3.4;
      c.globalAlpha = Math.min(1, a * 0.7);
      c.drawImage(haloSprite, cx - R, cy - R, R * 2, R * 2);
      c.globalAlpha = Math.min(1, a * 1.05);
      c.fillStyle = gild;
      const s = p.shape;
      c.beginPath(); c.moveTo(cx + s[0][0], cy + s[0][1]);
      for (let k = 1; k < s.length; k++) c.lineTo(cx + s[k][0], cy + s[k][1]);
      c.closePath(); c.fill();
    }
    return cv;
  }

  // ── кадр живого слоя: крупка + два направления блеска, три готовых картинки ──
  function drawLive(mayBuild) {
    if (!lctx) return;
    lctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    lctx.clearRect(0, 0, W, H);
    if (fleckSprite) {
      lctx.globalAlpha = 0.85;                    // та же прозрачность, что была у слоя крупки
      lctx.drawImage(fleckSprite, 0, 0, W, H);
      lctx.globalAlpha = 1;
    }
    if (!parts || !parts.length) return;
    if (spriteGild !== gild) buildHalo(gild);
    if (phaseGild !== gild) { resetPhases(); phaseGild = gild; }
    if (!phases) phases = new Array(PHASES).fill(null);
    const str = Math.min(1, Math.hypot(tx, ty));
    if (str < 0.015) return;                      // почти не наклонён — чистая патина
    const pos = (Math.atan2(ty, tx) / (Math.PI * 2) + 1) % 1 * PHASES;
    const i0 = Math.floor(pos) % PHASES, i1 = (i0 + 1) % PHASES, w = pos - Math.floor(pos);
    // готовим только те направления, которые нужны прямо сейчас, и не больше одного
    // за кадр: строить все двенадцать разом — это заметный провал в самый нужный момент
    if (mayBuild) {
      if (!phases[i0]) phases[i0] = buildPhase(i0);
      else if (!phases[i1]) phases[i1] = buildPhase(i1);
    }
    lctx.globalCompositeOperation = 'lighter';    // искры складываются светом, как раньше делал режим «экран»
    if (phases[i0]) { lctx.globalAlpha = (1 - w) * str; lctx.drawImage(phases[i0], 0, 0, W, H); }
    if (phases[i1]) { lctx.globalAlpha = w * str; lctx.drawImage(phases[i1], 0, 0, W, H); }
    lctx.globalCompositeOperation = 'source-over';
    lctx.globalAlpha = 1;
  }

  // Размеры меряем только когда они могут измениться (поворот, возврат на полку),
  // а не в каждом кадре: измерение посреди кадра заставляет браузер пересчитывать
  // раскладку всей полки заново.
  function measure(force) {
    if (!plate || !live) return;
    const r = plate.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (!force && Math.abs(r.width - W) < 1 && Math.abs(r.height - H) < 1) return;
    W = r.width; H = r.height; DPR = Math.min(2, devicePixelRatio || 1);
    for (const cv of [plate, live]) {
      cv.width = Math.max(1, Math.round(W * DPR));
      cv.height = Math.max(1, Math.round(H * DPR));
    }
    parts = null; resetPhases(); fleckSprite = null;
    drawPlate();
  }
  function watchSize() {
    if (watchSize.on) return; watchSize.on = true;
    addEventListener('resize', () => measure());
    if (window.ResizeObserver) { try { new ResizeObserver(() => measure()).observe(plate); } catch {} }
  }

  // смена темы: перерисовать плиту и перекрасить крупку с блеском
  window.__shelfBgTheme = () => {
    bgCol = cssVar('--bg') || bgCol;
    gild = cssVar('--gild') || '#d8a54f';
    fleckSprite = null; resetPhases();
    drawPlate();
    if (window.shelfBgKick) window.shelfBgKick();
  };

  function frame() {
    T += 0.016;
    const bg = document.getElementById('shelf-bg');
    const sv = document.getElementById('shelf-view');
    const on = bg && document.body.classList.contains('bg-live') && sv && !sv.hidden;
    if (!on || paused) { running = false; return; }
    if (!plate) {
      plate = bg.querySelector('.sbg-plate'); live = bg.querySelector('.sbg-live');
      if (!plate || !live) { running = false; return; }
      pctx = plate.getContext('2d'); lctx = live.getContext('2d');
      bgCol = cssVar('--bg'); gild = cssVar('--gild') || '#d8a54f';
      measure(true); watchSize();
      loadImages(() => { drawPlate(); if (window.shelfBgKick) window.shelfBgKick(); });
    }
    if (!imgsReady) { requestAnimationFrame(frame); return; }
    // за кадр выполняем НЕ БОЛЬШЕ одной тяжёлой задачи: сбор точек, спрайт крупки
    // и заготовка блеска в одном кадре давали заметный провал в момент открытия полки
    let heavy = false;
    if (!fleckSprite) { buildFleck(); heavy = true; }
    else if (!parts && !sampling) { sample(); heavy = true; }
    else if (scan) { sampleStep(); heavy = true; }

    let sx, sy;
    if (T - gT < 1.2) { sx = gx; sy = gy; }
    else { sx = Math.sin(T * 0.28) * 0.5; sy = Math.sin(T * 0.21) * 0.4; }
    tx += (sx - tx) * 0.06; ty += (sy - ty) * 0.06;
    if (T - lastMove >= 0.033) {                 // параллакс — 30 раз в секунду
      lastMove = T;
      const px = (tx * 7).toFixed(1) + 'px', py = (ty * 5).toFixed(1) + 'px';
      live.style.setProperty('--px', px); live.style.setProperty('--py', py);
    }
    if (T - lastDraw >= 0.033) { lastDraw = T; drawLive(!heavy); }
    requestAnimationFrame(frame);
  }

  window.shelfBgPause = on => {
    paused = !!on;
    if (!paused && !running) { running = true; requestAnimationFrame(frame); }
  };
  window.shelfBgKick = () => { if (paused) return; if (!running) { running = true; requestAnimationFrame(frame); } };
  window.shelfBgKick();
})();

// заливка пройденной части кастомного ползунка (CSS-переменная --fill)
function rangeFill(el) {
  if (!el) return;
  const min = +el.min, max = +el.max, v = +el.value;
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', pct.toFixed(1) + '%');
}
function syncSettingsUI() {
  for (const [segId, key] of [['seg-theme', 'theme'], ['seg-font', 'font'],
    ['seg-width', 'width'], ['seg-align', 'align'], ['seg-lang', 'lang']]) {
    document.querySelectorAll(`#${segId} button`).forEach(b =>
      b.classList.toggle('active', b.dataset.v === String(settings[key])));
  }
  $('#size-value').textContent = settings.size + ' px';
  $('#lh-value').textContent = settings.lh.toFixed(2).replace(/0$/, '');
  const sr = $('#size-range'); if (sr) { sr.value = settings.size; rangeFill(sr); }
  const lr = $('#lh-range'); if (lr) { lr.value = settings.lh; rangeFill(lr); }
  // единый пример (#settings-preview) обновляется сам через --reader-* переменные
  $('#reset-progress-btn').hidden = !state.book;
  if (typeof syncTrLangUI === 'function') syncTrLangUI();   // язык перевода — свой для книги
}

// ══════════════════ данные книги ══════════════════
// дерево оглавления → плоский список глав; группам присваиваются ключи
function buildFlat() {
  state.flat = [];
  state.byIdx.clear();
  let g = 0;
  (function walk(nodes, path, groups) {
    for (const n of nodes) {
      if (n.kids) {
        const key = 'g' + (g++);
        n._k = key;
        walk(n.kids, [...path, n.t], [...groups, key]);
      } else if (n.ch !== undefined) {
        const item = {
          idx: n.ch, title: n.t,
          crumb: path.slice(-2).join(' · '),
          vol: path.length ? path[path.length - 1] : '',   // только самый глубокий уровень (том)
          groups,
        };
        state.flat.push(item);
        state.byIdx.set(n.ch, item);
      }
    }
  })(state.toc, [], []);
}

function chaptersUnder(node) {
  const ids = [];
  (function walk(n) {
    if (n.kids) n.kids.forEach(walk);
    else if (n.ch !== undefined) ids.push(n.ch);
  })(node);
  return ids;
}

async function loadBook(id) {
  const book = await dbGet('books', id);
  dbg('book:' + (book ? 'да' : 'нет'));
  if (!book) throw new Error('нет книги');
  state.book = book;
  state.toc = book.toc || [];
  buildFlat();
  dbg('flat:' + state.flat.length);
  const rows = await dbAll('progress', bookRange(id));
  const map = {};
  for (const r of rows) map[r.idx] = { position: r.position, percent: r.percent };
  const last = await kvGet('last:' + id);
  state.progress = { last: typeof last === 'number' ? last : null, map };
  await loadBookmarks(id);   // здесь, а не в showLibrary: главу можно открыть и прямой ссылкой
  expanded = new Set(safeParse(expandedKey(), [], Array.isArray)
    .filter(x => typeof x === 'string'));
  if (!expanded.size) defaultExpand();
}

function defaultExpand() {
  const target = (state.progress.last != null && state.byIdx.get(state.progress.last))
    || state.flat[0];
  if (!target) return;
  for (const k of target.groups) expanded.add(k);
}

async function chapterOf(id, idx) {
  const row = await dbGet('chapters', [id, idx]);
  if (!row) { const e = new Error('нет главы'); e.status = 404; throw e; }
  const i = state.flat.findIndex(c => c.idx === idx);
  const item = state.flat[i];
  return {
    idx, title: row.title, html: row.html,
    crumb: item ? item.crumb : '',
    vol: item ? item.vol : '',
    prev_idx: i > 0 ? state.flat[i - 1].idx : null,
    next_idx: i >= 0 && i < state.flat.length - 1 ? state.flat[i + 1].idx : null,
    index: i + 1, total: state.flat.length,
  };
}

// ── прогресс ──
// Читаем и пишем в ОДНОЙ транзакции. Раньше это были две разные, и получался классический
// lost update: отметил главу прочитанной (percent=1), а отложенное сохранение прокрутки
// успело прочитать старое значение до отметки и записывало его поверх — галочка слетала.
async function progressBump(id, idx, position, percent) {
  const d = await idb();
  const tx = d.transaction('progress', 'readwrite');
  const os = tx.objectStore('progress');
  const prev = await req(os.get([id, idx]));
  await req(os.put({ book: id, idx, position, percent: Math.max(prev ? prev.percent : 0, percent) }));
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
let lastMarkKey = '';
function postProgress(idx, position, percent) {
  state.progress.last = idx;
  const id = state.book.id;
  // Позиция в главе меняется постоянно, а «последняя глава» и «последняя книга» — только
  // при переходе. Раньше все четыре записи уходили в базу каждые 0.7 с прокрутки.
  const markKey = id + ':' + idx;
  const needMark = markKey !== lastMarkKey;
  lastMarkKey = markKey;
  invalidateShelfData();   // проценты на полке пересчитаем при следующем показе
  (async () => {
    await progressBump(id, idx, position, percent);
    if (needMark) {
      await kvSet('last:' + id, idx);
      await kvSet('lastBook', id);
      for (const c of (state.collections || [])) if (colHas(c.id, 'book', id)) kvSet('colLast:' + c.id, id);   // своя «последняя» на коллекцию
    }
  })().catch(e => {
    // молча терять прогресс нельзя: человек читает часами, а на выходе — ничего
    if (isQuota(e)) quotaToast();
  });
}

let saveTimer = null;
let dirty = null;   // {idx, position, percent} — одна неотправленная запись
function queueSave(idx, position, percent) {
  dirty = { idx, position, percent };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDirty, 700);
}
function flushDirty() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty || !state.book) { dirty = null; return; }
  const p = dirty;
  dirty = null;
  postProgress(p.idx, p.position, p.percent);
}
addEventListener('pagehide', () => { flushDirty(); statFlush(); persistSettings(true); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { flushDirty(); statFlush(); persistSettings(true); }
});

// Отметка «прочитано» меняется в памяти до записи в базу. Если запись падает, галочка
// стоит, оглавление зелёное — а после перезапуска всё пропало, и молча. Поэтому при сбое
// откатываем память к тому, что реально в базе, и говорим об этом.
async function markChapters(idxs, read) {
  const id = state.book.id;
  const undo = [];
  try {
    for (const idx of idxs) {
      undo.push([idx, state.progress.map[idx]]);
      if (read) {
        const prev = state.progress.map[idx] || { position: 0 };
        state.progress.map[idx] = { position: prev.position || 0, percent: 1 };
        await dbPut('progress', { book: id, idx, position: prev.position || 0, percent: 1 });
      } else {
        delete state.progress.map[idx];
        await dbDel('progress', [id, idx]);
      }
    }
  } catch (e) {
    for (const [idx, was] of undo) {
      if (was === undefined) delete state.progress.map[idx];
      else state.progress.map[idx] = was;
    }
    if (isQuota(e)) quotaToast();
    else showToast(T('saveFail', { e: (e && e.message ? e.message : String(e)).slice(0, 60) }));
  }
  invalidateShelfData();
  renderContinue();
  renderToc();
  renderFooter();
}

// ══════════════════ статистика чтения (локально, без сервера) ══════════════════
// Три числа из роадмапа: сколько осталось до конца книги, личная скорость (слов/мин)
// и серия дней подряд. Всё считается на устройстве, поверх уже существующего прогресса.
// Главный принцип — честность времени: копим ТОЛЬКО активное чтение (глава на экране,
// приложение не свёрнуто, человек хоть что-то делает или идёт озвучка). Отвлёкся —
// пауза, чтобы «5 минут» не превращались в «час», пока телефон лежит открытым.
const STAT_IDLE = 100000;   // 100 с без действий — считаем, что человек отошёл
const STAT_TICK = 10000;    // квант учёта — 10 с

function countWords(s) {
  const m = (s || '').match(/[\p{L}\p{N}’'-]*[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}
// слова по главам текущей книги: у импортированных лежат на записи (chWords),
// у старых считаем один раз в фоне и кладём в kv
async function ensureWords(book) {
  if (!book) return null;
  if (Array.isArray(book.chWords)) return book.chWords;
  const cached = await kvGet('chWords:' + book.id);
  if (Array.isArray(cached)) { book.chWords = cached; return cached; }
  const rows = await dbAll('chapters', bookRange(book.id));
  const arr = new Array(book.count || rows.length).fill(0);
  for (const r of rows) arr[r.idx] = countWords(r.plain || (r.html || '').replace(/<[^>]+>/g, ' '));
  await kvSet('chWords:' + book.id, arr);
  book.chWords = arr;
  return arr;
}

const dayKey = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
// серия = дни подряд, заканчивая сегодня или вчера (сегодня мог ещё не начать читать)
function computeStreak(days) {
  const has = k => (days[k] || 0) > 0;
  const d = new Date();
  if (!has(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
// личная скорость: копим слова↔секунды по мере реального чтения; пока данных мало —
// берём типовые 200 сл/мин, чтобы оценка «до конца» не скакала на первых минутах
async function readSpeed() {
  const w = (await kvGet('stat:words')) || 0;
  const s = (await kvGet('stat:secs')) || 0;
  if (s < 240) return 200;
  return Math.max(60, Math.min(700, w / s * 60));
}

const stat = {
  bookId: null, timer: null, lastAct: 0,
  bookSecs: 0, daySecs: 0, spdWords: 0, spdSecs: 0,
  prevRead: 0,          // слов «прочитано» на прошлом тике (для Δ)
  chW: null,            // слова по главам текущей книги (или null, пока не посчитаны)
};
const statNote = () => { stat.lastAct = Date.now(); };   // «человек тут» — зовём на любое действие

function statReadWords() {   // сколько слов «прочитано» сейчас = Σ percent·слова_главы
  if (!stat.chW) return 0;
  let w = 0;
  const m = state.progress.map;
  for (const k in m) w += (m[k].percent || 0) * (stat.chW[+k] || 0);
  return w;
}
function statActive() {
  return !document.hidden
    && !$('#reader-view').hidden
    && (Date.now() - stat.lastAct < STAT_IDLE || (typeof tts !== 'undefined' && tts.playing));
}
function statTick() {
  if (!statActive()) return;
  const secs = STAT_TICK / 1000;
  stat.bookSecs += secs; stat.daySecs += secs;
  if (stat.chW) {
    const now = statReadWords();
    const d = now - stat.prevRead;   // сколько слов «прошло» за квант
    stat.prevRead = now;
    if (d > 0 && d < stat.chW.reduce((a, b) => a + b, 0)) { stat.spdWords += d; stat.spdSecs += secs; }
  }
  statFlush();   // сбрасываем в базу нечасто — раз в квант это ок, записи крохотные
}
let statFlushing = false;
async function statFlush() {
  if (statFlushing) return;
  const bid = stat.bookId, aB = stat.bookSecs, aD = stat.daySecs, aW = stat.spdWords, aS = stat.spdSecs;
  if (!aB && !aD && !aS) return;
  stat.bookSecs = stat.daySecs = stat.spdWords = stat.spdSecs = 0;
  statFlushing = true;
  try {
    if (bid && aB) await kvSet('readSecs:' + bid, ((await kvGet('readSecs:' + bid)) || 0) + aB);
    if (aD) { const days = (await kvGet('readDays')) || {}; const k = dayKey(); days[k] = (days[k] || 0) + aD; await kvSet('readDays', days); }
    if (aS) {
      await kvSet('stat:words', ((await kvGet('stat:words')) || 0) + aW);
      await kvSet('stat:secs', ((await kvGet('stat:secs')) || 0) + aS);
    }
  } catch { /* статистика — не критично, молча */ }
  finally { statFlushing = false; }
}
// старт/продолжение сессии чтения книги (зовём при открытии главы)
function statSessionStart(bookId, book) {
  if (stat.bookId !== bookId) { statSessionEnd(); stat.bookId = bookId; stat.chW = null; stat.prevRead = 0; }
  stat.lastAct = Date.now();
  if (book) ensureWords(book).then(arr => { if (stat.bookId === bookId) { stat.chW = arr; stat.prevRead = statReadWords(); } });
  if (!stat.timer) stat.timer = setInterval(statTick, STAT_TICK);
}
function statSessionEnd() {
  if (stat.timer) { clearInterval(stat.timer); stat.timer = null; }
  statFlush();
  stat.bookId = null; stat.chW = null; stat.prevRead = 0;
}

// сколько минут осталось до конца книги при личной скорости (null — если не оценить)
async function bookTimeLeft(book) {
  const chW = await ensureWords(book);
  if (!chW || !chW.length) return null;
  const total = chW.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let read = 0;
  for (const r of await dbAll('progress', bookRange(book.id))) read += (r.percent || 0) * (chW[r.idx] || 0);
  const remain = Math.max(0, total - read);
  if (remain < 1) return 0;
  return Math.max(1, Math.round(remain / (await readSpeed())));
}
function fmtDur(mins) {
  if (!mins || mins < 1) return null;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return h + ' ' + t('hUnit') + ' ' + m + ' ' + t('minUnit');
  if (h) return h + ' ' + t('hUnit');
  return m + ' ' + t('minUnit');
}

// ══════════════════ сохранение импортированной книги ══════════════════
// запись пачками по 40: одна огромная транзакция подвешивает мобильный браузер
async function dbChunk(store, rows) {
  const d = await idb();
  for (let i = 0; i < rows.length; i += 40) {
    const tx = d.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const r of rows.slice(i, i + 40)) os.put(r);
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
  }
}

// Запись книги на полку идёт в порядке «главы → картинки → прогресс → сама книга»: если
// упасть на середине, наполовину восстановленная книга не попадёт на полку. Но обратная
// сторона — сироты: главы записаны, записи в books нет, на полке пусто, удалять нечем,
// место не вернуть из приложения вообще. Поэтому при любом сбое подчищаем за собой.
// Особенно важно при переполнении памяти: там падение почти гарантировано.
async function storeBook(data) {
  const id = newId('b');
  try {
    const chunk = dbChunk;
    await chunk('chapters', data.chapters.map((c, idx) => ({
      book: id, idx, title: c.title, html: c.html, plain: c.plain || '',
    })));
    await chunk('images', [...data.images.entries()].map(([name, blob]) =>
      ({ book: id, name, blob })));
    if (data.progress && data.progress.byIdx) {
      await chunk('progress', Object.entries(data.progress.byIdx)
        .map(([idx, p]) => ({
          book: id, idx: +idx,
          position: Math.min(1, Math.max(0, +p.position || 0)),
          percent: Math.min(1, Math.max(0, +p.percent || 0)),
        }))
        .filter(p => Number.isInteger(p.idx) && p.idx >= 0 && p.idx < data.chapters.length));
      if (typeof data.progress.last === 'number')
        await kvSet('last:' + id, data.progress.last);
    }
    await dbPut('books', {
      id, title: data.title, author: data.author, lang: data.lang,
      annotation: data.annotation || '',
      year: data.year || null, genre: data.genre || '',
      addedAt: Date.now(), cover: data.cover || null, toc: data.toc,
      count: data.chapters.length,
      titles: data.chapters.map(c => c.title),
      chWords: data.chapters.map(c => countWords(c.plain || (c.html || '').replace(/<[^>]+>/g, ' '))),
    });
  } catch (e) {
    await dropBookLeftovers(id);
    if (isQuota(e)) quotaToast();
    throw e;
  }
  if (data.progress && typeof data.progress.last === 'number'
      && !(await kvGet('lastBook'))) {
    await kvSet('lastBook', id);
  }
  return id;
}

// подчистка недописанной книги: то же, что удаляет deleteBook, но молча и без подтверждения
async function dropBookLeftovers(id) {
  for (const step of [
    () => dbDel('chapters', bookRange(id)),
    () => dbDel('images', bookRange(id)),
    () => dbDel('progress', bookRange(id)),
    () => dbDel('kv', 'last:' + id),
    () => dbDel('books', id),
  ]) { try { await step(); } catch { /* чистим что получится */ } }
}

async function deleteBook(id) {
  invalidateShelfData();
  await dbDel('chapters', bookRange(id));
  await dbDel('images', bookRange(id));
  await dbDel('progress', bookRange(id));
  for (const n of await dbByIndex('notes', 'byBook', id))
    await dbDel('notes', n.id);
  await dbDel('kv', 'last:' + id);
  await dbDel('kv', 'review:' + id);
  await dbDel('books', id);
  await purgeFromCollections('book', id);   // убрать из всех коллекций
  await purgeFromFolders('book', id);       // и из сборника
  if ((await kvGet('lastBook')) === id) await dbDel('kv', 'lastBook');
  localStorage.removeItem('talewyn-expanded:' + id);
  if (coverUrls.has(id)) {
    URL.revokeObjectURL(coverUrls.get(id));
    coverUrls.delete(id);
  }
}

// системная «назад»/свайп от края: закрыть открытую шторку → иначе на уровень выше
window.__appBack = () => {
  if (selMode) { exitSelMode(); return true; }   // «назад» сначала выходит из мультивыбора
  if (fabMoreOpen()) { closeFabMore(); return true; }   // раскрытое «ещё» — обратно в троеточие
  if (confirmOpen()) { closeConfirm(false); return true; }
  if (typeof scanOpen === 'function' && scanOpen()) { closeScan(); return true; }
  if (!$('#lightbox').hidden) { closeLightbox(); return true; }
  for (const [ov, close] of [['settings-overlay', closeSettings], ['info-overlay', closeInfo], ['note-overlay', closeNoteSheet],
      ['tr-overlay', closeTrSheet], ['annot-overlay', closeAnnotSheet], ['review-overlay', closeReviewSheet]]) {
    if (!$('#' + ov).hidden) { close(); return true; }
  }
  // центральные окна (коллекции, выбор что сохранять) — «назад» закрывает их, а не сворачивает приложение
  for (const [id, close] of [['col-create', closeColCreate], ['col-pick', closeColPick],
                             ['sync-pick', () => closeSyncPick(null)]]) {
    const el = $('#' + id);
    if (el && !el.hidden) { close(); return true; }
  }
  if (!$('#sel-toolbar').hidden) { hideSelToolbar(); try { getSelection().removeAllRanges(); } catch {} return true; }
  if (typeof langPickers !== 'undefined' && langPickers.some(c => c._menu && c._menu.classList.contains('open'))) {
    closeLangMenus(); return true;
  }
  if (!$('#audio-view').hidden) { closeAudioView(); return true; }
  if (!$('#reader-view').hidden) { location.hash = state.book ? '#/b/' + state.book.id : '#/'; return true; }
  if (!$('#library-view').hidden) { location.hash = '#/'; return true; }
  if (activeFolder) { closeFolder(); return true; }   // раскрытая стопка — обратно на полку
  return false;   // полка — приложению свернуться
};

// ══════════════════ загрузка приложения ══════════════════
async function boot() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  askPersist();   // до первых чтений: просим не вычищать библиотеку при нехватке места
  applySettings();
  bindUI();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http'))
    navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    state.books = sortShelf(await dbAll('books'));
  } catch (e) {
    document.documentElement.dataset.err = 'idb: ' + e.message;
    state.books = [];
  }
  await loadCollections();
  await loadFolders();
  route();
  hideBootSplash();
  if (urlParams.get('selftest')) selftest();
  otaInit();   // самообновление веб-слоя (только в нативной сборке)
  importSharedFiles();   // книга, присланная из другого приложения до запуска (холодный старт)
}

// Заставка держит экран, пока приложение собирается: без неё было видно пустую полку,
// а потом в неё рывком влетало содержимое. Минимум 500мс — чтобы она не мигала на быстрых
// устройствах; убираем только после кадра, в котором полка уже отрисована.
const BOOT_SPLASH_MIN = 500;
const bootAt = performance.now();
function hideBootSplash() {
  const el = document.getElementById('boot-splash');
  if (!el) return;
  const wait = Math.max(0, BOOT_SPLASH_MIN - (performance.now() - bootAt));
  setTimeout(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.classList.add('gone');
      setTimeout(() => el.remove(), 320);   // после плавного исчезновения — из DOM совсем
    }));
  }, wait);
}

// ══════════════════ самообновление (OTA) ══════════════════
// Веб-слой (www) обновляется по воздуху через Capgo — без сторов и без переустановки APK.
// Ручной режим: сами тянем version.json с GitHub Pages (GET), качаем бандл, применяем.
// Всё под guard'ами: в PWA/вебе и при любой ошибке молча ничего не делаем.
const capUpdater = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorUpdater) || null;
const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// Источники обновления — по порядку. GitHub основной, HuggingFace зеркало: у части читателей
// GitHub блокируется провайдером, да и сам он временами отдаёт 502/503. Список живёт в вебе,
// поэтому новые зеркала можно добавить по воздуху, без пересборки APK.
const OTA_MANIFESTS = [
  'https://archidexter.github.io/talewyn/app/version.json',
  'https://huggingface.co/datasets/Archidexter/talewyn-assets/resolve/main/version.json',
];
const OTA_SRC_KEY = 'talewyn-ota-src';   // какой источник ответил в прошлый раз — его и пробуем первым
// склеить список адресов: сначала массив из манифеста, следом одиночное поле (старая схема), без повторов
const otaUrls = (list, one) => [...new Set([...(Array.isArray(list) ? list : []), ...(one ? [one] : [])].filter(Boolean))];
function cmpVer(a, b) {   // 1.0.23 vs 1.0.22 → 1/0/-1
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
let otaInfo = null;    // доступное обновление {kind:'web'|'native', version, bundleUrl?/apkUrl?} или null
let otaBusy = false;
let otaWebQueued = null;   // версия веб-бандла, уже скачанного и поставленного в очередь на след. запуск
async function otaInit() {
  if (!capUpdater || !isNativeApp()) return;             // OTA только в нативной сборке
  try { await capUpdater.notifyAppReady(); } catch {}    // текущий бандл рабочий — защита от отката
  // если тихое веб-обновление применилось при этом запуске — коротко сообщаем, что версия новее
  try {
    const prev = localStorage.getItem('talewyn-ran-ver');
    if (prev && cmpVer(APP_VERSION, prev) > 0)
      setTimeout(() => { try { showToast(T('otaUpdated', { v: APP_VERSION })); } catch {} }, 1600);
    localStorage.setItem('talewyn-ran-ver', APP_VERSION);
  } catch {}
  setTimeout(otaCheck, 3000);                            // фоновая проверка, не мешаем старту
}
// Манифест берём с первого ответившего источника. Таймаут обязателен: без него мёртвый хост
// висит до дефолта WebView, и проверка обновлений «молчит» минутами.
// Возвращает { m } — манифест, либо { err:'net' } — не ответил НИ ОДИН источник (это не то же
// самое, что «обновлений нет», и говорить о них надо по-разному).
async function otaFetchManifest() {
  let order = OTA_MANIFESTS;
  try {
    const last = localStorage.getItem(OTA_SRC_KEY);
    if (last && OTA_MANIFESTS.includes(last)) order = [last, ...OTA_MANIFESTS.filter(u => u !== last)];
  } catch {}
  const bust = '?t=' + Math.floor(Date.now() / 3600000);
  for (const url of order) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    try {
      const res = await fetch(url + bust, { cache: 'no-store', signal: ac.signal });
      if (!res.ok) continue;
      const m = await res.json();
      if (!m || typeof m !== 'object') continue;
      try { localStorage.setItem(OTA_SRC_KEY, url); } catch {}
      return { m };
    } catch { /* мёртвый или заблокированный хост — пробуем следующий */ }
    finally { clearTimeout(timer); }
  }
  return { err: 'net' };
}
// из манифеста определяем доступное обновление (нативное важнее веба)
async function otaEval(m) {
  if (!m) return null;
  if (m.native && m.apkUrl) {                            // новый APK
    // ВАЖНО: сравниваем manifest.native с УСТАНОВЛЕННОЙ нативной версией (versionName APK),
    // а НЕ с APP_VERSION (это версия веб-бандла — она уходит вперёд при веб-OTA и врёт).
    let nativeVer = null;
    try { const cur = await capUpdater.current(); if (cur && cur.native) nativeVer = cur.native; } catch {}
    if (nativeVer && cmpVer(m.native, nativeVer) > 0) return {
      kind: 'native', version: m.native, apkUrl: m.apkUrl, apkUrls: otaUrls(m.apkUrls, m.apkUrl),
      apkSha256: m.apkSha256 || '', apkSize: +m.apkSize || 0,
    };
  }
  if (m.web && (m.bundleUrl || (m.bundleUrls || []).length) && cmpVer(m.web, APP_VERSION) > 0)
    return { kind: 'web', version: m.web, bundleUrl: m.bundleUrl, bundleUrls: otaUrls(m.bundleUrls, m.bundleUrl) };
  return null;
}
// Скачать бандл, пробуя зеркала по очереди. Capgo принимает ровно один url, поэтому перебор — наш.
// Между попытками сносим недокачанный бандл этой версии: иначе повторная загрузка с тем же
// version упирается в уже заведённую запись и падает даже с живого зеркала.
async function otaDownloadBundle(info) {
  const urls = (info.bundleUrls && info.bundleUrls.length) ? info.bundleUrls : [info.bundleUrl];
  const version = String(info.version);
  let last = null;
  for (let i = 0; i < urls.length; i++) {
    try {
      const b = await capUpdater.download({ version, url: urls[i] });
      if (b && b.id) return b;
    } catch (e) { last = e; }
    try {
      const all = await capUpdater.list();
      const dead = ((all && all.bundles) || []).filter(x => x.version === version);
      for (const d of dead) { try { await capUpdater.delete({ id: d.id }); } catch {} }
    } catch {}
  }
  if (last) throw last;
  return null;
}
// маркер на кнопке: есть обновление — стрелки крутятся (оборот-пауза); нет — стоят
function otaMarker() {
  const btn = document.getElementById('update-btn');
  if (btn) btn.classList.toggle('ota-avail', !!otaInfo);
}
// ФОНОВАЯ проверка при старте. ВЕБ-обновление ставим сами и молча: качаем бандл и ставим
// в очередь на следующий сворачивание/запуск (next) — WebView тихо перезагрузится в новую версию,
// без тапа и без установщика. NATIVE (APK) тихо поставить нельзя (Android покажет системный
// установщик), поэтому его только помечаем на кнопке и ждём ручного «Обновить».
async function otaCheck() {
  if (!capUpdater) return;
  const r = await otaFetchManifest();
  if (r.err) return;                                     // сеть молчит — тихо ждём следующего раза
  otaInfo = await otaEval(r.m);
  otaMarker();
  if (otaInfo && otaInfo.kind === 'web' && otaWebQueued !== otaInfo.version) {
    try {
      const b = await otaDownloadBundle(otaInfo);
      if (b && b.id) { await capUpdater.next({ id: b.id }); otaWebQueued = otaInfo.version; }
    } catch { /* не вышло тихо — останется ручной путь по кнопке */ }
  }
}
// РУЧНАЯ проверка по кнопке
async function otaManualCheck() {
  if (!capUpdater || !isNativeApp()) { showToast(t('otaNoUpd')); return; }
  if (otaBusy) return;
  otaBusy = true;
  const btn = document.getElementById('update-btn');
  const t0 = Date.now();
  if (btn) btn.classList.add('ota-checking');
  const r = await otaFetchManifest();
  otaInfo = r.err ? null : await otaEval(r.m);
  // докручиваем до конца полного оборота (минимум один), даже если проверка мгновенная
  const spin = 800, elapsed = Date.now() - t0;
  const wait = Math.max(1, Math.ceil(elapsed / spin)) * spin - elapsed;
  if (wait > 0) await new Promise(r2 => setTimeout(r2, wait));
  if (btn) btn.classList.remove('ota-checking');
  otaMarker();
  otaBusy = false;
  // «не достучались» и «обновлять нечего» — разные вещи: раньше и то и другое молчало одинаково
  if (r.err) { showToast(t('otaNoNet')); return; }
  if (!otaInfo) { showToast(t('otaNoUpd')); return; }
  if (otaInfo.kind === 'web') showToast(T('otaAvail', { v: otaInfo.version }), t('otaApply'), otaDoWeb);
  else showToast(T('otaAvailApp', { v: otaInfo.version }), t('otaInstall'), otaDoNative);
}
// скачать и применить веб-обновление (перезагружает WebView в новую версию)
async function otaDoWeb() {
  if (!capUpdater || !otaInfo || otaInfo.kind !== 'web') return;
  showToast(t('otaDownloading'));
  try {
    const b = await otaDownloadBundle(otaInfo);          // GitHub, при неудаче — зеркало
    if (b && b.id) await capUpdater.set({ id: b.id });   // применяет и перезагружает
    else showToast(t('otaFail'));
  } catch { showToast(t('otaFail')); }
}
// ── нативное самообновление APK (мост AndroidUpdate из MainActivity) ──
// Скачивание+проверку+установку делает натив; сюда прилетают только прогресс и итог.
let otaNativeBusy = false;
const androidUpdate = () => window.AndroidUpdate || null;
function otaDoNative() {
  if (!isNativeApp() || !otaInfo || otaInfo.kind !== 'native') return;
  const U = androidUpdate();
  // старый APK без моста самообновиться не может — просим поставить новый вручную один раз
  if (!U || typeof U.download !== 'function') { showToast(t('otaOldApp')); return; }
  try {
    if (typeof U.canInstall === 'function' && !U.canInstall()) {
      // Android 8+: сначала разрешить установку из приложения, потом тап ещё раз
      showToast(t('otaNeedPerm'), t('otaGrant'), () => { try { U.openInstallSettings(); } catch {} });
      return;
    }
  } catch {}
  if (otaNativeBusy) return;
  otaNativeBusy = true;
  showProgress(t('otaDownloading'), 0);   // держим тост открытым с полосой загрузки
  try {
    const urls = (otaInfo.apkUrls && otaInfo.apkUrls.length) ? otaInfo.apkUrls : [otaInfo.apkUrl];
    // downloadMulti умеет перебирать зеркала, но живёт только в новых APK: веб-слой прилетает
    // по воздуху раньше нативного, поэтому проверяем наличие метода и откатываемся на старый
    if (urls.length > 1 && typeof U.downloadMulti === 'function')
      U.downloadMulti(JSON.stringify(urls), String(otaInfo.version),
        String(otaInfo.apkSize || 0), otaInfo.apkSha256 || '');
    else
      U.download(urls[0], String(otaInfo.version),
        String(otaInfo.apkSize || 0), otaInfo.apkSha256 || '');
  } catch { otaNativeBusy = false; showToast(t('otaFail')); }
}
// колбэки из натива (вызываются через evaluateJavascript)
window.__otaNativeProgress = pct => {
  const p = Math.max(0, Math.min(100, Math.round(+pct || 0)));
  if (p >= 100) showProgress(t('otaInstalling'), null);   // качается проверка → бегущая полоса
  else showProgress(T('otaDownloadingPct', { p }), p / 100);
};
window.__otaNativeReady = () => { otaNativeBusy = false; hideToast(); };   // системный установщик открылся
window.__otaNativeError = () => { otaNativeBusy = false; showToast(t('otaFail')); };

// ══════════════════ автопоиск книг на устройстве (мост AndroidScan) ══════════════════
// Натив ищет файлы книг в памяти и отдаёт СПИСОК путей (мелочь); сами файлы читаем по
// Capacitor.convertFileSrc и прогоняем через обычный doImport — дедуп и импорт уже там.
const scanBridge = () => window.AndroidScan || null;
let scanFiles = [];        // [{p,n,s}]
let scanSel = new Set();   // индексы отмеченных (глобально, поверх фильтра)
let scanBusyFlag = false;
let scanFmt = '';          // текущий фильтр формата ('' = все)
let scanSort = 'name';     // сортировка списка: 'name' | 'date' | 'size'
let scanSortOn = true;     // галочка рядом с выпадашкой: снята — список в порядке находки
const scanFmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ';
const scanExt = n => { const m = String(n).toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; };
const scanStripExt = n => String(n).replace(/\.[a-z0-9]+$/i, '');   // формат виден тегом → из имени убираем
// цвет тега по формату (книги/тексты/комиксы — разными оттенками)
const SCAN_FMT_COLOR = {
  pdf: '#cf7b6f', epub: '#8fb182', fb2: '#7f9fc4', fbook: '#7f9fc4', docx: '#7f9fc4',
  mobi: '#c9a45f', azw: '#c9a45f', azw3: '#c9a45f', prc: '#c9a45f',
  cbz: '#b58bcf', cbr: '#b58bcf', cb7: '#b58bcf', cbt: '#b58bcf',
  txt: '#93a1a6', html: '#93a1a6', htm: '#93a1a6', xhtml: '#93a1a6', zip: '#93a1a6',
  // аудиокниги — своим оттенком (бирюза), чтобы отличать от текстовых
  mp3: '#6fb0a4', m4a: '#6fb0a4', m4b: '#6fb0a4', aac: '#6fb0a4', ogg: '#6fb0a4', opus: '#6fb0a4', flac: '#6fb0a4', wav: '#6fb0a4',
};
const scanColor = f => SCAN_FMT_COLOR[f] || '#c9a45f';
const scanShownIdx = () => scanFiles.map((_, i) => i).filter(i => !scanFmt || scanExt(scanFiles[i].n) === scanFmt);

// ── группировка находок: аудио с похожим именем в ОДНОЙ ПАПКЕ = одна аудиокнига-единица ──
// (иначе «Гарри Поттер» на 125 треков показывался бы 125 строками, и чтобы добавить только его,
//  пришлось бы снимать десятки лишних галочек). Книги — каждая своя единица.
let scanGroups = [];
const scanDir = p => String(p).replace(/[^/\\]*$/, '');
// имя-основа: убираем расширение и нумерацию трека — И ХВОСТОВУЮ (…-001, «часть 2», cd1, №3),
// И ВЕДУЩУЮ («01 - имя», «12. имя», «03_имя»). Часто есть обе: «01 - книга - 01.mp3».
function scanStem(n) {
  let s = scanStripExt(n).toLowerCase()
    .replace(/[\s._\-–—(\[#№]*(?:part|глава|гл|chapter|ch|track|cd|disc|диск|том|vol|часть)?\.?\s*\d{1,4}[\s._\-–—)\]]*$/i, '');
  s = s.replace(/^\s*(?:part|глава|гл|chapter|ch|track|cd|disc|диск|том|vol|часть)?\.?\s*\d{1,4}\s*[.)\]\-–—_]+\s*/i, '');   // ведущий номер трека (в т.ч. «cd1 - », «часть 1.»)
  return s.replace(/^[\s._\-–—]+|[\s._\-–—]+$/g, '').trim();
}
function buildScanGroups() {
  const map = new Map();
  scanFiles.forEach((f, i) => {
    const audio = AUDIO_EXT.test(f.n);
    const key = audio ? ('a|' + scanDir(f.p) + '|' + (scanStem(f.n) || scanDir(f.p))) : ('b|' + i);
    let g = map.get(key);
    if (!g) { g = { key, kind: audio ? 'audio' : 'book', ex: scanExt(f.n), idxs: [], size: 0, date: 0, title: '', count: 0 }; map.set(key, g); }
    g.idxs.push(i); g.size += (+f.s || 0); g.date = Math.max(g.date, +f.d || 0);   // f.d — дата файла (нативный сканер, ≥1.0.83)
  });
  const arr = [...map.values()];
  arr.forEach(g => {
    g.count = g.idxs.length;
    const names = g.idxs.map(i => scanFiles[i].n);
    g.title = (g.kind === 'audio' && g.count > 1) ? (abCommonName(names) || scanStripExt(names[0])) : scanStripExt(names[0]);
  });
  return arr;
}
const scanShownGroups = () => scanGroups.filter(g => !scanFmt || g.ex === scanFmt);

// ── ОДНА механика для всех выпадающих списков приложения ──
// Раньше их было три почти одинаковых копии (фильтры полки, автопоиск, язык перевода):
// позиционирование, открытие и закрытие в каждой писались заново и постепенно разъезжались.
// Теперь общая часть здесь, а различия — только в содержимом и в том, что делать по выбору.
const MENU_CHEV = '<svg class="lang-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const menuTriggerHtml = extra =>
  '<button class="lang-trigger' + (extra ? ' ' + extra : '') + '" type="button" aria-haspopup="listbox" aria-expanded="false">'
  + '<span class="lang-cur"></span>' + MENU_CHEV + '</button>';
const menuOptionsHtml = (options, cur) => options.map(o =>
  `<button class="lang-opt${String(o.v) === String(cur) ? ' sel' : ''}" type="button" role="option" data-v="${esc(String(o.v))}">${esc(o.label)}</button>`).join('');

const appMenus = [];   // все меню-порталы, живущие в body
function closeAppMenus() {
  for (const m of appMenus) {
    m.classList.remove('open');
    // подсветка рамки триггера живёт на aria-expanded — без сброса она «залипала»
    // после закрытия меню тапом мимо
    if (m._trigger) m._trigger.setAttribute('aria-expanded', 'false');
  }
}
// anchor — элемент, по которому равняется меню (левая грань и ширина); по умолчанию
// сам триггер. Нужен, когда триггер живёт внутри рамки-контейнера (сортировка с
// галочкой): меню обязано вставать по грани РАМКИ, а не уезжать под триггер.
function makeMenu(trigger, { extraClass = '', minWidth = 0, cap = 280, align = 'left', onPick, anchor = null } = {}) {
  // подчищаем меню, чей триггер уже выброшен из документа (панели пересобираются)
  for (let i = appMenus.length - 1; i >= 0; i--) {
    const m = appMenus[i];
    if (m._trigger && !document.body.contains(m._trigger)) { m.remove(); appMenus.splice(i, 1); }
  }
  const menu = document.createElement('div');
  menu.className = 'lang-menu' + (extraClass ? ' ' + extraClass : '');
  menu.setAttribute('role', 'listbox');
  menu._trigger = trigger;
  document.body.appendChild(menu);
  appMenus.push(menu);
  // раскрываем ВНИЗ, если влезает; вверх — только когда снизу места нет
  const place = () => {
    const r = (anchor || trigger).getBoundingClientRect();
    const w = Math.max(r.width, minWidth);
    menu.style.width = w + 'px';
    menu.style.maxHeight = 'none';
    const full = menu.scrollHeight;
    const capH = Math.min(cap, innerHeight - 24);
    const h = Math.min(full, capH);
    const want = align === 'right' ? r.right - w : r.left;
    menu.style.left = Math.min(Math.max(8, want), Math.max(8, innerWidth - w - 8)) + 'px';
    const roomBelow = innerHeight - r.bottom >= h + 10;
    menu.style.top = (roomBelow || r.top < h + 12 ? r.bottom + 6 : r.top - h - 6) + 'px';
    menu.style.maxHeight = h + 'px';
    menu.style.overflowY = full > capH + 1 ? 'auto' : 'hidden';
  };
  const close = () => { menu.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); };
  let toggledAt = 0;
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    if (isOpen && performance.now() - toggledAt < 320) return;   // гасим «дребезг» быстрого тапа
    closeAppMenus();
    if (typeof voicePicker !== 'undefined' && voicePicker) voicePicker.close();
    if (!isOpen) { place(); menu.classList.add('open'); trigger.setAttribute('aria-expanded', 'true'); }
    toggledAt = performance.now();
  });
  menu.addEventListener('click', e => {
    const b = e.target.closest('.lang-opt');
    if (!b) return;
    close();
    if (onPick) onPick(b.dataset.v, b);
  });
  return { menu, place, close };
}

// тап мимо списка закрывает его — в фазе перехвата, до обработчиков кнопок под ним
addEventListener('pointerdown', e => {
  if (!e.target.closest('.lang-trigger, .lang-menu')) closeAppMenus();
}, true);

// выпадашка с подписью/иконкой текущего значения (автопоиск: формат и сортировка)
function buildDropdown(container, options, value, onChange, anchor) {
  if (!container) return;
  if (container._ddMenu) container._ddMenu.remove();   // пересборка — убираем прежнее меню-портал
  container.innerHTML = menuTriggerHtml();
  const trigger = container.querySelector('.lang-trigger');
  const cur = container.querySelector('.lang-cur');
  let val = String(value);
  const sync = () => {
    const o = options.find(x => String(x.v) === val);
    if (o && o.icon) cur.innerHTML = o.icon;   // иконка активного режима (напр. сортировка)
    else cur.textContent = o ? o.label : (options[0] ? options[0].label : '');
    menu.querySelectorAll('.lang-opt').forEach(op => op.classList.toggle('sel', op.dataset.v === val));
  };
  const { menu } = makeMenu(trigger, {
    extraClass: 'dd-menu', minWidth: 150, anchor,
    onPick: v => { val = v; sync(); onChange(val); },
  });
  menu.innerHTML = menuOptionsHtml(options, val);
  container._ddMenu = menu;
  sync();
}

function scanState(s) {     // 'choose' | 'busy' | 'results'
  $('#scan-choose').hidden = s !== 'choose';
  $('#scan-busy').hidden = s !== 'busy';
  $('#scan-results').hidden = s !== 'results';
  $('#scan-add').hidden = s !== 'results';
}
// открытие/закрытие — ТА ЖЕ механика, что у диалога «вставить ссылку» (uiConfirm):
// два кадра до .open (иначе стартовое положение за краем не отрисуется), уход за 400мс.
function openScan() {
  if (!isNativeApp() || !scanBridge()) { showToast(t('scanNoNative')); return; }   // только в приложении
  scanFiles = []; scanGroups = []; scanSel = new Set(); scanBusyFlag = false; scanFmt = ''; scanSort = 'name';
  scanSortOn = true;
  { const cb = $('#scan-sort-on'); if (cb) cb.checked = true; }
  scanState('choose');
  const modal = $('#scan-modal'), scrim = $('#scan-scrim');
  scrim.hidden = false; modal.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => { scrim.classList.add('open'); modal.classList.add('open'); }));
}
function scanOpen() { return !$('#scan-modal').hidden; }
function closeScan() {
  scanBusyFlag = false;
  closeAppMenus();   // закрыть выпадашки формата и сортировки
  const modal = $('#scan-modal'), scrim = $('#scan-scrim');
  modal.classList.remove('open'); scrim.classList.remove('open');
  setTimeout(() => { modal.hidden = true; scrim.hidden = true; }, 400);
}
function startScan(mode) {
  const B = scanBridge(); if (!B) return;
  try {
    if (typeof B.hasAccess === 'function' && !B.hasAccess()) {   // нет доступа — просим и ждём возврата
      showToast(t('scanNeedPerm'), t('scanGrant'), () => { try { B.requestAccess(); } catch {} });
      return;
    }
  } catch {}
  scanBusyFlag = true;
  $('#scan-stat').textContent = T('scanBusyStat', { d: 0, n: 0 });
  scanState('busy');
  try { if (mode === 'all') B.scanAll(); else B.pickFolder(); }
  catch { scanBusyFlag = false; showToast(t('scanErr')); scanState('choose'); }
}
window.__scanProgress = (d, n) => { if (scanBusyFlag) $('#scan-stat').textContent = T('scanBusyStat', { d, n }); };
window.__scanResult = list => {
  scanBusyFlag = false;
  scanFiles = Array.isArray(list) ? list : [];
  scanGroups = buildScanGroups();
  scanSel = new Set(scanGroups.map(g => g.key));   // по умолчанию отмечены все единицы
  scanFmt = '';
  buildScanFmtDD();
  buildScanSortDD();
  renderScanResults();
  scanState('results');
};
window.__scanError = () => { scanBusyFlag = false; showToast(t('scanErr')); scanState('choose'); };
window.__scanCancelled = () => { scanBusyFlag = false; scanState('choose'); };

// ── файлы из других приложений: «Поделиться» в Telegram, «Открыть с помощью» в проводнике ──
// Натив уже скопировал их к себе в кэш; здесь забираем очередь путей (takePending отдаёт и
// очищает), читаем байты через convertFileSrc и отправляем в обычный импорт. Зовётся дважды:
// пинком из натива (__sharedCheck, тёплый старт) и при загрузке приложения (холодный старт).
window.__sharedCheck = () => { setTimeout(importSharedFiles, 60); };
async function importSharedFiles() {
  const br = window.AndroidShare;
  if (!br || typeof br.takePending !== 'function') return;
  let list = [];
  try { list = JSON.parse(br.takePending() || '[]'); } catch {}
  if (!list.length) return;
  const conv = (window.Capacitor && window.Capacitor.convertFileSrc) || (x => x);
  const files = [];
  for (const it of list) {
    try {
      const r = await fetch(conv(it.p));
      const b = await r.blob();
      if (b.size) files.push(new File([b], it.n));
    } catch {}
  }
  if (!files.length) { showToast(t('shareFail')); return; }
  while (importBusy) await new Promise(r => setTimeout(r, 250));   // дожидаемся своей очереди
  await doImport(files);
}
// выпадашка форматов: «Все форматы · N» + каждый найденный формат со счётчиком
function buildScanFmtDD() {
  const fmts = [...new Set(scanFiles.map(f => scanExt(f.n)).filter(Boolean))].sort();
  const opts = [{ v: '', label: T('scanAllFmt', { n: scanFiles.length }) }]
    .concat(fmts.map(f => ({ v: f, label: `${f.toUpperCase()} · ${scanFiles.filter(x => scanExt(x.n) === f).length}` })));
  buildDropdown($('#scan-fmt'), opts, '', v => { scanFmt = v; renderScanResults(); });
}
// сортировка списка автопоиска: по алфавиту / дате файла / размеру.
// Триггер — только иконка активного режима; полные подписи — в раскрытом списке.
const SORT_IC = {
  name: '<svg viewBox="0 0 24 24" width="18" height="18"><text x="12" y="17" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor" style="font-family:var(--display),Georgia,serif">Ая</text></svg>',
  date: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.2 2"/></svg>',
  size: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6h10M10 12h6M10 18h3"/><path d="M5 5v13m0 0-2.4-2.4M5 18l2.4-2.4"/></svg>',
};
function buildScanSortDD() {
  const opts = [
    { v: 'name', label: t('sortName'), icon: SORT_IC.name },
    { v: 'date', label: t('sortDate'), icon: SORT_IC.date },
    { v: 'size', label: t('sortSize'), icon: SORT_IC.size },
  ];
  const mount = $('#scan-sort');
  // меню равняется по общей рамке «галочка + сортировка», а не по триггеру внутри неё
  buildDropdown(mount, opts, scanSort, v => { scanSort = v; renderScanResults(); },
    mount && mount.closest('.sort-frame'));
}
function renderScanResults() {
  const box = $('#scan-list');
  if (!scanFiles.length) { box.innerHTML = `<div class="scan-empty">${t('scanNone')}</div>`; $('#scan-add').hidden = true; return; }
  const groups = scanShownGroups().slice();
  if (scanSortOn) groups.sort((a, b) => {   // галочка снята — порядок, в котором нашлись
    if (scanSort === 'size') return (b.size || 0) - (a.size || 0);       // крупные сверху
    if (scanSort === 'date') return (b.date || 0) - (a.date || 0);       // новые сверху
    return String(a.title).localeCompare(String(b.title), undefined, { numeric: true, sensitivity: 'base' });
  });
  box.innerHTML = groups.map(g => {
    const col = scanColor(g.ex);
    const cnt = (g.kind === 'audio' && g.count > 1) ? ` <span class="scan-cnt">${T('scanTracks', { n: g.count })}</span>` : '';
    return `<label class="scan-row">`
      + `<span class="scan-tag" style="color:${col};border-color:${col}55;background:${col}1f">${esc(g.ex || '—')}</span>`
      + `<span class="scan-name"><span class="txt">${esc(g.title)}${cnt}</span></span>`
      + `<span class="scan-size">${scanFmtSize(g.size)}</span>`
      + `<input type="checkbox" class="scan-cb" data-key="${esc(g.key)}"${scanSel.has(g.key) ? ' checked' : ''}></label>`;
  }).join('');
  updateScanAdd();
  // бегущая строка для длинных имён: сначала все замеры (без перекладок), потом навешиваем
  requestAnimationFrame(() => {
    const rows = [...box.querySelectorAll('.scan-name')];
    const over = rows.map(nm => { const tx = nm.querySelector('.txt'); return tx ? tx.scrollWidth - nm.clientWidth : 0; });
    rows.forEach((nm, k) => {
      if (over[k] > 2) { nm.classList.add('marq'); nm.style.setProperty('--mshift', (-over[k] - 4) + 'px'); nm.style.setProperty('--mdur', Math.max(5, over[k] / 22) + 's'); }
    });
  });
}
// счётчик и «Все» — ПО ТЕКУЩЕМУ ФИЛЬТРУ: считаем/отмечаем только видимые ЕДИНИЦЫ
function updateScanAdd() {
  const shown = scanShownGroups();
  const selN = shown.filter(g => scanSel.has(g.key)).length;   // выбрано среди ВИДИМЫХ единиц
  const btn = $('#scan-add');
  btn.hidden = false; btn.disabled = !selN;
  btn.textContent = T('scanAdd', { n: selN });
  const cb = $('#scan-allcb');
  if (cb) cb.checked = shown.length > 0 && selN === shown.length;
}
async function scanDoAdd() {
  // добавляем только выбранные ЕДИНИЦЫ среди видимых под текущим фильтром
  const chosen = scanShownGroups().filter(g => scanSel.has(g.key));
  if (!chosen.length) return;
  closeScan();
  const conv = (window.Capacitor && window.Capacitor.convertFileSrc) || (x => x);
  const total = chosen.reduce((s, g) => s + g.idxs.length, 0);
  let done = 0;
  const read = async i => {
    done++;
    showProgress(T('scanReading', { i: done, n: total }), done / total);
    const it = scanFiles[i];
    try { const r = await fetch(conv(it.p)); return new File([await r.blob()], it.n); } catch { return null; }
  };
  const bookFiles = [];
  let anyAudio = false;
  // аудио-группы импортируем сразу по одной (каждая = одна аудиокнига, память освобождается);
  // книги собираем и добавляем разом в конце (там дедуп по библиотеке)
  for (const g of chosen) {
    if (g.kind === 'audio') {
      const files = [];
      for (const i of g.idxs) { const f = await read(i); if (f) files.push(f); }
      if (files.length) { anyAudio = true; await doImport(files); }   // одна аудиокнига из своих треков
    } else {
      const f = await read(g.idxs[0]); if (f) bookFiles.push(f);
    }
  }
  if (bookFiles.length) await doImport(bookFiles);
  else if (!anyAudio) showToast(t('scanErr'));
}
$('#scan-btn')?.addEventListener('click', () => { closeFabMore(true); openScan(); });
$('#scan-all')?.addEventListener('click', () => startScan('all'));
$('#scan-folder')?.addEventListener('click', () => startScan('folder'));
$('#scan-cancel')?.addEventListener('click', closeScan);
$('#scan-scrim')?.addEventListener('click', closeScan);
// тап мимо карточки закрывает окно — как у «вставить ссылку» (#scan-modal лежит поверх скрима)
$('#scan-modal')?.addEventListener('click', e => { if (!e.target.closest('.confirm-card, .dd-menu')) closeScan(); });
$('#scan-add')?.addEventListener('click', scanDoAdd);
// «Все» — отметить/снять все ВИДИМЫЕ (под текущим фильтром), обновляя галочки на месте
$('#scan-sort-on')?.addEventListener('change', e => { scanSortOn = e.target.checked; renderScanResults(); });
$('#scan-allcb')?.addEventListener('change', () => {
  const shown = scanShownGroups(), all = shown.every(g => scanSel.has(g.key));
  shown.forEach(g => all ? scanSel.delete(g.key) : scanSel.add(g.key));
  $('#scan-list').querySelectorAll('input[data-key]').forEach(cb => { cb.checked = scanSel.has(cb.dataset.key); });
  updateScanAdd();
});
$('#scan-list')?.addEventListener('change', e => {
  const cb = e.target.closest('input[data-key]'); if (!cb) return;
  if (cb.checked) scanSel.add(cb.dataset.key); else scanSel.delete(cb.dataset.key);
  updateScanAdd();
});

// ══════════════════ маршрутизация ══════════════════
let navToken = 0;
let loadingChapter = false;

function route() {
  const a = location.hash.match(/^#\/a\/([\w-]+)/);   // аудиокнига
  if (a) { openAudiobook(a[1]); return; }
  const m = location.hash.match(/^#\/b\/([\w-]+)(?:\/c\/(\d+))?/);
  if (!m) { showShelf(); return; }
  const [, id, chIdx] = m;
  if (chIdx !== undefined) openChapter(id, +chIdx);
  else showLibrary(id);
}
window.addEventListener('hashchange', route);

// ══════════════════ полка ══════════════════
const coverUrls = new Map();   // bookId → objectURL обложки
function coverUrl(book) {
  if (!book.cover) return null;
  if (!coverUrls.has(book.id))
    coverUrls.set(book.id, URL.createObjectURL(book.cover));
  return coverUrls.get(book.id);
}

// ── своя обложка: выбор файла, уменьшение до разумного размера, установка ──
// Выбор изображения через общий скрытый input (Promise с файлом или null при отмене).
function pickImageFile() {
  return new Promise(resolve => {
    const inp = $('#cover-input');
    if (!inp) { resolve(null); return; }
    inp.value = '';
    const done = () => { inp.removeEventListener('change', done); resolve(inp.files && inp.files[0] ? inp.files[0] : null); };
    inp.addEventListener('change', done, { once: true });
    inp.click();
  });
}
// сжимаем в webp (или jpeg), длинная сторона ≤ maxDim — чтобы не раздувать базу
async function imageToCoverBlob(file, maxDim = 720, quality = 0.85) {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxDim / Math.max(w, h || 1));
    w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    const blob = await new Promise(res => cv.toBlob(res, 'image/webp', quality))
      || await new Promise(res => cv.toBlob(res, 'image/jpeg', quality));
    return blob || file;
  } catch { return file; }
}
async function chooseCoverBlob() {
  const file = await pickImageFile();
  if (!file || !(file.type || '').startsWith('image/')) return null;
  return await imageToCoverBlob(file);
}
// Одна шторка редактирования на книгу И аудиокнигу. editTarget — что сейчас правим.
let editTarget = null;   // { kind:'book'|'audio', rec, store }
function editEntity() { return editTarget ? editTarget.rec : null; }
// применить/убрать обложку текущей редактируемой сущности
async function applyCover(blob) {
  const rec = editEntity(); if (!rec) return;
  // перед ЛЮБЫМ первым изменением (замена ИЛИ удаление) снимаем исходную обложку — чтобы вернуть
  if (rec.cover && rec.origCover === undefined) rec.origCover = rec.cover;
  rec.cover = blob || null;
  // обложка — это блоб на сотни килобайт, на переполненном хранилище падает первой;
  // раньше сбой глушился пустым catch, и обложка «применялась» только на экране
  if (!(await saveGuard(() => dbPut(editTarget.store, rec)))) return;
  syncCoverCaches(editTarget.kind, rec);
  refreshCoverViews();
  renderAnnotCover();
}
// вернуть исходную (изначально извлечённую) обложку
async function restoreCover() {
  const rec = editEntity(); if (!rec || !rec.origCover) return;
  rec.cover = rec.origCover;
  if (!(await saveGuard(() => dbPut(editTarget.store, rec)))) return;
  syncCoverCaches(editTarget.kind, rec);
  refreshCoverViews();
  renderAnnotCover();
}
function syncCoverCaches(kind, rec) {
  if (kind === 'audio') {
    const i = state.audiobooks ? state.audiobooks.findIndex(r => r.id === rec.id) : -1;
    if (i >= 0) state.audiobooks[i].cover = rec.cover;
    if (abCoverUrls.has(rec.id)) { try { URL.revokeObjectURL(abCoverUrls.get(rec.id)); } catch {} abCoverUrls.delete(rec.id); }
  } else {
    const i = state.books.findIndex(b => b.id === rec.id);
    if (i >= 0) state.books[i].cover = rec.cover;
    if (coverUrls.has(rec.id)) { try { URL.revokeObjectURL(coverUrls.get(rec.id)); } catch {} coverUrls.delete(rec.id); }
  }
}
function refreshCoverViews() {
  if (!editTarget) return;
  if (editTarget.kind === 'audio') {
    const cu = abCoverUrl(editTarget.rec);
    const face = $('#ab-cover-face');
    if (face) face.innerHTML = cu ? `<img src="${cu}" alt="">` : '<span class="ab-cover-fallback">♪</span>';
    if (typeof renderAudioShelf === 'function') { try { renderAudioShelf(); } catch {} }
  } else {
    if (typeof renderContinue === 'function') { try { renderContinue(); } catch {} }
    if (typeof renderShelf === 'function') { try { renderShelf(); } catch {} }
  }
}
function renderAnnotCover() {
  const rec = editEntity(); const box = $('#annot-cover'); if (!box || !rec) return;
  const url = editTarget.kind === 'audio' ? abCoverUrl(rec) : coverUrl(rec);
  box.innerHTML = url ? `<img src="${url}" alt="">`
    : `<span class="cover-blank" style="--h:${hueOf(rec.title)}"><span>${esc(rec.title)}</span></span>`;
  const del = $('#annot-cover-clear'); if (del) del.hidden = !rec.cover;
  const res = $('#annot-cover-restore'); if (res) res.hidden = !rec.origCover;
}

// Бегущие названия карточек — на CSS-анимации, а не на таймерах. Раньше на каждую
// карточку заводилась своя цепочка setTimeout: две сотни книг = две сотни живых таймеров,
// которые дёргали раскладку даже когда полка просто лежит на экране.
// Замер один на весь список, в одном кадре — без чересполосицы «прочитал-записал».
// Бегущая строка едет только у карточек, которые видно. Сотня книг = сотня вечных
// анимаций за экраном, а это постоянная перерисовка и разряд батареи впустую.
let marqIO = null;
function marqWatch(el, off) {
  if (!window.IntersectionObserver) { if (!off) el.classList.add('marq-live'); return; }
  if (!marqIO) marqIO = new IntersectionObserver(ents => {
    for (const e of ents) e.target.classList.toggle('marq-live', e.isIntersecting);
  }, { rootMargin: '15% 0px' });
  if (off) { marqIO.unobserve(el); el.classList.remove('marq-live'); }
  else marqIO.observe(el);
}
function cardMarquee(root) {
  if (!root) return;
  const els = [...root.querySelectorAll('.book-title, .ab-card-title, .fold-head-name')];
  if (!els.length) return;
  const slow = matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(() => {
    const over = els.map(el => {
      const inner = el.querySelector('.marq');
      return inner ? inner.scrollWidth - el.clientWidth : 0;   // сначала ВСЕ замеры…
    });
    els.forEach((el, i) => {                                   // …и только потом записи
      const inner = el.querySelector('.marq');
      if (!inner) return;
      if (over[i] > 4 && !slow) {
        inner.style.setProperty('--marq', over[i] + 'px');
        inner.style.setProperty('--marq-dur', Math.max(6, over[i] / 24).toFixed(1) + 's');
        el.classList.add('is-marquee');
        marqWatch(el);   // ехать будет только пока карточка на экране
      } else { el.classList.remove('is-marquee'); marqWatch(el, true); }
    });
  });
}

// книги без обложки получают «переплёт» с оттенком от названия
function hueOf(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

async function bookPercent(book) {
  const rows = await dbAll('progress', bookRange(book.id));
  const read = rows.filter(r => r.percent >= 0.98).length;
  return book.count ? Math.round(read / book.count * 100) : 0;
}
// Кэш процента прогресса всех книг — нужен фильтру по статусу (до фильтрации) и бейджу.
// Считаем ОДНИМ запросом за весь прогресс, а не по запросу на книгу: при вводе в поиск
// полка перерисовывается на каждую букву, и сотни отдельных транзакций съедали отклик.
// Пересчитываем только когда прогресс реально мог измениться (shelfDataDirty).
const bookPctCache = new Map();
const bookRevCache = new Map();   // отзывы (звёзды на карточке) — тем же приёмом
let shelfDataFresh = false;
function invalidateShelfData() { shelfDataFresh = false; }
async function refreshBookPcts(force) {
  if (shelfDataFresh && !force) return;
  const readCount = new Map();
  for (const r of await dbAll('progress')) {
    if ((r.percent || 0) >= 0.98) readCount.set(r.book, (readCount.get(r.book) || 0) + 1);
  }
  bookPctCache.clear();
  for (const b of state.books)
    bookPctCache.set(b.id, b.count ? Math.round((readCount.get(b.id) || 0) / b.count * 100) : 0);
  bookRevCache.clear();
  for (const [id, v] of await kvRange('review:')) bookRevCache.set(id, v);
  shelfDataFresh = true;
}
// все значения kv с общим началом ключа — одним запросом вместо запроса на каждую книгу
async function kvRange(prefix) {
  const m = new Map();
  for (const row of await dbAll('kv', IDBKeyRange.bound(prefix, prefix + '￿')))
    m.set(String(row.k).slice(prefix.length), row.v);
  return m;
}
// статус чтения книги: new (не прочитано) / progress (в процессе) / read (прочитано)
function bookStatus(id) {
  const p = bookPctCache.get(id) || 0;
  return p >= 100 ? 'read' : p > 0 ? 'progress' : 'new';
}

// ── фильтры полки (статус · год · автор · жанр · поиск), фильтруют список в реальном времени ──
const shelfFilters = { q: '', author: '', genre: '', status: new Set() };
// сортировка полки — как в автопоиске: выпадашка + галочка вкл/выкл.
// Выключена (по умолчанию) — ручной порядок с перетаскиванием, как всегда было.
const shelfSort = { on: false, by: 'name' };
// Полка и кнопка «Сбросить» обновляются вместе с любым изменением фильтра. Раньше кнопку
// рисовали только при открытии панели, и она появлялась лишь после перетыкивания фильтра.
function applyFilters() {
  const r = $('#flt-reset');
  if (r) r.hidden = !filtersActive();
  renderShelf();
}
function filtersActive() {
  const f = shelfFilters;
  return !!(f.q || f.author || f.genre || f.status.size);
}
// жанр книги: сохранённый при импорте, иначе выводим из названия+описания.
// «Другое»/пусто переоцениваем каждый раз — у книг, импортированных со старой
// (более скудной) mapGenre жанр записан как «Другое», и одна правка mapGenre их
// бы не тронула: сохранённое значение возвращалось как есть. Содержательный
// сохранённый жанр не перетираем — только повышаем «Другое»/пусто до конкретного.
function bookGenre(b) {
  if (b.genre && b.genre !== 'Другое') return b.genre;
  const m = Genres.mapGenre((b.title || '') + ' ' + (b.annotation || ''));
  return (m && m !== 'Другое') ? m : (b.genre || m || '');
}
// ── ручной порядок полки ──
// ord — позиция, выставленная перетаскиванием (0,1,2…). У книг без ord берём addedAt: он
// на порядки больше любого ord, поэтому новые книги всегда встают в конец, а не в середину.
const shelfOrd = r => (typeof r.ord === 'number' ? r.ord : (r.addedAt || 0));
const sortShelf = arr => arr.sort((a, b) => shelfOrd(a) - shelfOrd(b));

// проходит ли книга фильтры полки (без учёта коллекции — её порядок собирается отдельно)
function bookPassesFilters(b) {
  const f = shelfFilters;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!((b.title || '').toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q))) return false;
  }
  if (f.author && (b.author || '') !== f.author) return false;
  if (f.genre && bookGenre(b) !== f.genre) return false;
  if (f.status.size && !f.status.has(bookStatus(b.id))) return false;
  return true;
}
function filteredBooks() {
  return state.books.filter(b => {
    if (!bookPassesFilters(b)) return false;
    if (activeCol && !colHas(activeCol, 'book', b.id)) return false;   // просмотр коллекции
    return true;
  });
}

// карточка книги на полке (она же — внутри раскрытого сборника)
function bookCardHtml(b, en) {
  en = en || {};
  const url = coverUrl(b);
  const pct = bookPctCache.get(b.id) || 0;
  const rev = bookRevCache.get(b.id) || null;
  const stars = rev && rev.stars ? STAR.repeat(rev.stars) : '';
  const face = url
    ? `<img class="cover-img" src="${url}" alt="" loading="lazy">`
    : `<span class="cover-blank" style="--h:${hueOf(b.title)}"><span>${esc(b.title)}</span></span>`;
  return `<div class="book-card${en.inFold ? ' fold-kid' : ''}" data-book="${b.id}"${en.inFold ? ` data-in-fold="${esc(en.inFold)}"` : ''}${en.colcat ? ` data-colcat="${esc(en.colcat)}"` : ''}>
      <button class="cover" data-open="${b.id}">${face}
        ${pct ? `<span class="cover-pct">${pct}%</span>` : ''}
        <span class="cover-track"><span class="cover-fill" style="width:${pct}%"></span></span>
        <span class="sel-check" aria-hidden="true"></span>
      </button>
      <div class="book-meta">
        <div class="book-title"><span class="marq">${esc(b.title)}</span></div>
        ${stars ? `<div class="book-stars">${stars}</div>` : ''}
        ${b.author ? `<div class="book-author">${esc(b.author)}</div>` : ''}
      </div>
      <button class="book-del" data-del="${b.id}" title="${t('deleteT')}" aria-label="${t('deleteT')}">✕</button>
    </div>`;
}

let seenBookIds = null;   // id книг, уже показанных на полке — чтобы анимировать только НОВЫЕ
async function renderShelf() {
  // просмотр каталога: та же сетка, но записи приходят из сети (см. блок каталога)
  if (activeCat) { renderCatShelf(); return; }
  const grid = $('#shelf-grid');
  // копировать нечего только когда пусто ВСЁ: файл может быть и из одних аудиокниг
  const haveAny = state.books.length || (state.audiobooks || []).length;
  $('#backup-btn').hidden = !haveAny;
  { const sl = $('#sync-light-btn'); if (sl) sl.hidden = !haveAny; }
  if (!state.books.length && !(activeCol && colCatItems('book').length)) {
    grid.innerHTML = `<div class="shelf-empty">
      <p class="se-title">${t('emptyShelf')}</p><p class="se-hint">${t('emptyHint')}</p></div>`;
    $('#shelf-continue').innerHTML = '';
    $('#shelf-stats').innerHTML = '';
    $('#shelf-filters').hidden = true;
    seenBookIds = new Set();
    renderShelfFooter();
    return;
  }
  await refreshBookPcts();   // проценты всех книг — для фильтра по статусу и бейджа
  // коллекция: ЕДИНЫЙ список в порядке её элементов — скачанные книги и нескачанные записи
  // каталога вперемешку, без деления на сорта (порядок правится перетаскиванием, хранит его
  // сама коллекция). Вне коллекции — обычная полка в ручном порядке ord.
  const colEntries = activeCol ? colOrderedEntries('book') : null;
  if (colEntries && shelfSort.on) colEntries.sort((a, b) => shelfSort.by === 'date'
    ? (b.b ? b.b.addedAt || 0 : 0) - (a.b ? a.b.addedAt || 0 : 0)
    : String(a.b ? a.b.title : (a.ph.e || {}).title || '').localeCompare(
        String(b.b ? b.b.title : (b.ph.e || {}).title || ''), undefined, { numeric: true, sensitivity: 'base' }));
  const list = colEntries ? colEntries.filter(en => en.b).map(en => en.b) : filteredBooks();
  if (!colEntries && shelfSort.on) list.sort((a, b) => shelfSort.by === 'date'
    ? (b.addedAt || 0) - (a.addedAt || 0)   // новые сверху
    : String(a.title).localeCompare(String(b.title), undefined, { numeric: true, sensitivity: 'base' }));
  if (!(colEntries ? colEntries.length : list.length)) {
    grid.innerHTML = `<div class="shelf-empty"><p class="se-hint">${t('filterNone')}</p></div>`;
    seenBookIds = new Set(state.books.map(b => b.id));
    renderShelfContinue();
    renderShelfStats();
    renderShelfFooter(0);
    return;
  }
  // книги, собранные в стопку, показываются одной карточкой; раскрытая стопка расставляет
  // свои книги следом за собой, прямо в этой же сетке
  const entries = foldEntries(colEntries || list.map(b => ({ b })), 'book');
  grid.innerHTML = entries.map(en => {
    // раскрытая стопка — секция во всю ширину полки со своей сеткой внутри
    if (en.f) return folderCardHtml(en.f, en.items, false, en.open);
    if (en.ph) return colCatCardHtml(en.ph);   // нескачанная запись каталога — со стрелкой
    return bookCardHtml(en.b, en);
  }).join('');
  cardMarquee(grid);   // названия — одной бегущей строкой (проезжает, если не влезает)
  foldGaps(grid);      // добивки вокруг раскрытого сборника — соседний ряд строго вниз, без перескоков
  setFoldCellW(grid);  // ширина книжки в сборнике = ширине ячейки
  // FLIP СИНХРОННО, прямо здесь (до асинхронного «продолжить чтение» ниже) — иначе браузер успеет
  // нарисовать новую раскладку, и соседи дёрнутся на место ещё до анимации. См. addToFolder.
  if (foldFlipBefore) { flipCards(grid, foldFlipBefore); foldFlipBefore = null; }
  // плавное появление — только у книг, впервые попавших в библиотеку (не при фильтрации/первом рендере)
  if (seenBookIds) {
    grid.querySelectorAll('.book-card').forEach(c => {
      // стопки и плейсхолдеры каталога — не «новые книги»: без этого КАЖДАЯ перерисовка
      // полки заново проигрывала им анимацию появления, и все сборники мигали разом
      if (c.classList.contains('cat-card') || c.classList.contains('fold-card') || seenBookIds.has(c.dataset.book)) return;
      c.classList.add('book-in');
      // класс снимаем сразу после проигрыша: анимация с fill: both держала бы transform: none,
      // а он по правилам CSS сильнее inline-стиля — ломались бы перетаскивание и FLIP при удалении
      c.addEventListener('animationend', () => c.classList.remove('book-in'), { once: true });
    });
  }
  seenBookIds = new Set(state.books.map(b => b.id));
  if (selMode && selKind === 'books' && activeCol) refreshSelChecks();   // выбор переживает перерисовку
  const contId = await renderShelfContinue();
  renderShelfStats();
  renderShelfFooter(list.length);
  // обложки держим в памяти только для карточек, которые сейчас на полке
  pruneCoverUrls(coverUrls, new Set([...list.map(b => b.id), contId || '']));
}

// objectURL обложки держит саму картинку в памяти. Раньше ссылки копились на всю
// библиотеку и жили до перезапуска: три сотни книг — это десятки лишних мегабайт.
function pruneCoverUrls(map, keep) {
  for (const [id, u] of [...map]) {
    if (keep.has(id)) continue;
    try { URL.revokeObjectURL(u); } catch {}
    map.delete(id);
  }
}

// удаление книги с полки: карточка плавно уходит, а соседние съезжают на её место (FLIP)
async function animateRemoveBook(id) {
  const grid = $('#shelf-grid');
  const cards = [...grid.querySelectorAll('.book-card')];
  const first = new Map(cards.map(c => [c.dataset.book, c.getBoundingClientRect()]));
  // ищем перебором, а не селектором: id — это UUID (часто с цифры), и CSS.escape в
  // значении атрибута его ломает → карточка не находилась и уходила мгновенно
  const target = cards.find(c => c.dataset.book === id);
  if (target) target.classList.add('book-out');
  await new Promise(r => setTimeout(r, target ? 230 : 0));
  state.books = state.books.filter(b => b.id !== id);
  await renderShelf();
  grid.querySelectorAll('.book-card').forEach(c => {
    const prev = first.get(c.dataset.book);
    if (!prev) return;
    const now = c.getBoundingClientRect();
    const dx = prev.left - now.left, dy = prev.top - now.top;
    if (dx || dy) {
      c.style.transform = `translate(${dx}px, ${dy}px)`;
      c.style.transition = 'none';
      requestAnimationFrame(() => {
        c.style.transition = 'transform .34s cubic-bezier(.4, 0, .2, 1)';
        c.style.transform = '';
      });
    }
  });
}

async function renderShelfContinue() {
  const box = $('#shelf-continue');
  // в коллекции — своя последняя книга; на общей полке — глобальная
  let lastId = activeCol ? await kvGet('colLast:' + activeCol) : await kvGet('lastBook');
  if (activeCol && !lastId) { const g = await kvGet('lastBook'); if (g && colHas(activeCol, 'book', g)) lastId = g; }   // своя ещё не запомнилась, но глобальная — член
  let book = lastId && state.books.find(b => b.id === lastId);
  if (book && activeCol && !colHas(activeCol, 'book', book.id)) book = null;   // уже не в коллекции
  if (!book) { box.innerHTML = ''; return null; }
  const lastIdx = await kvGet('last:' + book.id);
  if (typeof lastIdx !== 'number' || !book.titles || !book.titles[lastIdx]) {
    box.innerHTML = '';
    return null;
  }
  const prog = await dbGet('progress', [book.id, lastIdx]);
  const pct = prog ? Math.round(prog.percent * 100) : 0;
  const url = coverUrl(book);
  const face = url
    ? `<img class="cover-img" src="${url}" alt="">`
    : `<span class="cover-blank" style="--h:${hueOf(book.title)}"><span>${esc(book.title)}</span></span>`;
  const left = fmtDur(await bookTimeLeft(book));   // ≈ сколько осталось до конца книги
  box.innerHTML = `<button class="cont-card" data-cont="${book.id}" data-ch="${lastIdx}">
    <span class="cont-cover" aria-hidden="true">${face}</span>
    <span class="cont-body">
      <div class="cont-eyebrow">${t('cont')}</div>
      <div class="cont-title">${esc(book.titles[lastIdx])}</div>
      <div class="cont-sub">${esc(book.title)}${pct ? ` · ${pct}%` : ''}</div>
      ${pct ? `<div class="cont-track"><div class="cont-fill" style="width:${pct}%"></div></div>` : ''}
      ${left ? `<div class="cont-left">${T('timeLeft', { d: left })}</div>` : ''}
    </span>
  </button>`;
  return book.id;
}

// узкая полоска статистики под «Продолжить чтение»: серия · сегодня · скорость.
// Только на вкладке Книги и вне режима просмотра коллекции — чтобы не мельтешить.
async function renderShelfStats() {
  const box = $('#shelf-stats');
  if (!box) return;
  if (!state.books.length || shelfTab !== 'books' || activeCol || activeCat) { box.innerHTML = ''; return; }
  const days = (await kvGet('readDays')) || {};
  const streak = computeStreak(days);
  const todayMin = Math.round((days[dayKey()] || 0) / 60);
  const w = (await kvGet('stat:words')) || 0, s = (await kvGet('stat:secs')) || 0;
  const cells = [];
  if (streak >= 2) cells.push([streak + ' ' + t('dayShort'), t('statStreak')]);
  if (todayMin >= 1) cells.push([fmtDur(todayMin), t('statToday')]);
  if (s >= 240) cells.push([Math.round(w / s * 60), t('wpm')]);
  box.innerHTML = cells.length
    ? `<div class="stat-strip">${cells.map(([v, l]) =>
        `<span class="stat-cell"><b>${v}</b><i>${l}</i></span>`).join('')}</div>`
    : '';
}

function renderShelfFooter(shown) {
  // версия ушла в меню «О приложении»; в подвале — только счётчик книг.
  // Считаем то, что РЕАЛЬНО видно на полке сейчас: с фильтрами и внутри коллекции.
  $('#shelf-footer').innerHTML =
    state.books.length ? `<p>${T('booksN', { n: shown != null ? shown : state.books.length })}</p>` : '';
}

// ══════════════════ мультивыбор на полке (долгое нажатие → удалить пачкой) ══════════════════
let selMode = false;
let selKind = 'books';            // что выбирается: 'books' | 'audio' | 'catbooks' | 'cataudio'
const selIds = [];                // выбранные id по порядку (порядок = номер в кружке)
let lpFiredAt = 0;                // отметка долгого нажатия — чтобы съесть клик-отпускание

// вид карточки: отдельные «каталожные» сорта — ТОЛЬКО в самом каталоге (там выбор по ключам
// записей и кружок «скачать всё» вместо мусорки). В коллекции нескачанные записи каталога
// выбираются ВМЕСТЕ с обычными книгами — никаких отдельных категорий.
const cardKindOf = card => ((activeCat && card.classList.contains('cat-card')) ? 'cat' : '')
  + (card.classList.contains('ab-card') ? 'audio' : 'books');
const cardIdOf = card => card.dataset.catkey
  || (card.classList.contains('ab-card') ? card.dataset.abId : card.dataset.book);
const selCards = () => {
  if (selKind === 'catbooks') return document.querySelectorAll('#shelf-grid .cat-card');
  if (selKind === 'cataudio') return document.querySelectorAll('#tab-audio .cat-card');
  return selKind === 'audio'
    ? document.querySelectorAll('#tab-audio .ab-card')
    : document.querySelectorAll('#shelf-grid .book-card');
};

function refreshSelChecks() {
  selCards().forEach(card => {
    const pos = selIds.indexOf(cardIdOf(card));
    card.classList.toggle('sel', pos >= 0);
    const badge = card.querySelector('.sel-check');
    // один выбранный — галочка; несколько — порядковые «цифорки»
    if (badge) badge.textContent = pos < 0 ? '' : (selIds.length > 1 ? String(pos + 1) : '✓');
  });
  updateSelFabs();
}
// запись библиотеки, стоящая за выбранным элементом (везде: полка, коллекция, каталог).
// null = за элементом ничего нет, то есть это нескачанная запись каталога.
function selRecOf(key) {
  const audio = selKind === 'audio' || selKind === 'cataudio';
  const pool = audio ? (state.audiobooks || []) : state.books;
  // в каталоге выбор идёт по ключам записей, в остальных местах — по id книг
  const id = selKind.startsWith('cat') ? catBookIdOf({ key }) : key;
  return id ? (pool.find(r => r.id === id) || null) : null;
}
// удалять есть что у того, что реально лежит в библиотеке;
// скачивать — у нескачанных записей каталога И у стрим-аудиокниг (треки живут в сети)
const selCanDelete = key => !!selRecOf(key);
const selCanDownload = key => { const r = selRecOf(key); return !r || !!r.stream; };

// кружки следуют за СОСТАВОМ выбора ВЕЗДЕ (полка, коллекция, каталог): есть скачанное —
// есть урна, есть нескачанное — есть «скачать всё»; смешанный выбор — оба разом.
// «Объединить в сборник» — когда выбрано хотя бы две своих книги (в каталоге нечего собирать).
function updateSelFabs() {
  let canDel = true, canDl = false, canFold = false;
  if (selMode && selIds.length) {
    canDel = selIds.some(selCanDelete);
    canDl = selIds.some(selCanDownload);
    canFold = !selKind.startsWith('cat') && !activeFolder && foldTargets().length >= 2;
  }
  setSelFab('del', '#fab-del', canDel);
  setSelFab('dl', '#fab-dl', canDl);
  setSelFab('fold', '#fab-fold', canFold);
}
// Появление/исчезновение ситуативного кружка — плавное в ОБЕ стороны. Появление: класс
// возвращается сразу, кружок въезжает (fab-del-in). Исчезновение — строго в ДВА ТАКТА, иначе
// ряд «падает» мгновенно: такт 1 — кружок уезжает за экран (слот держится, соседи стоят);
// такт 2 (когда его уже не видно) — слот схлопывается, а соседи опускаются FLIP-ом.
const SEL_FAB_IDS = ['#fab-dl', '#fab-collect', '#fab-fold', '#fab-del'];
function setSelFab(name, sel, want) {
  const btn = $(sel); if (!btn) return;
  const cls = 'sel-can-' + name, body = document.body;
  const on = body.classList.contains(cls);
  if (want) {                                    // появляется (или отменяем начатый уезд)
    let changed = false;
    if (btn._outT) { clearTimeout(btn._outT); btn._outT = 0; btn.classList.remove('fab-out'); btn.classList.add('fab-in'); changed = true; }
    if (!on) { body.classList.add(cls); changed = true; }
    if (changed && selMode) applyFabDock();
    return;
  }
  if (!on || btn._outT) return;                  // уже скрыт или уже уезжает
  btn.classList.remove('fab-in');
  btn.classList.add('fab-out');                  // такт 1: уезжает за экран, слот ещё держится
  btn._outT = setTimeout(() => {
    btn._outT = 0;
    const others = SEL_FAB_IDS.map(s => $(s))
      .filter(b => b && b !== btn && !b.classList.contains('fab-out') && getComputedStyle(b).display !== 'none');
    const before = others.map(b => b.getBoundingClientRect());
    btn.classList.remove('fab-out');
    body.classList.remove(cls);                  // такт 2: слот схлопывается…
    if (selMode) applyFabDock();
    for (let i = 0; i < others.length; i++) {    // …и соседи опускаются FLIP-ом, а не рывком
      const a = others[i].getBoundingClientRect(), p = before[i];
      const dx = p.left - a.left, dy = p.top - a.top;
      if (!dx && !dy) continue;
      others[i].style.transition = 'none';
      others[i].style.transform = `translate(${dx}px, ${dy}px)`;
    }
    requestAnimationFrame(() => {
      for (const b of others) {
        if (!b.style.transform) continue;
        b.style.transition = 'transform .24s cubic-bezier(.2, .8, .3, 1)';
        b.style.transform = '';
      }
      setTimeout(() => { for (const b of others) { b.style.transition = ''; b.style.transform = ''; } }, 260);
    });
  }, 280);
}
// сбросить незавершённые анимации кружков (уезд/въезд/FLIP) — на входе и выходе из режима
function clearSelFabAnim() {
  for (const s of SEL_FAB_IDS) {
    const b = $(s); if (!b) continue;
    clearTimeout(b._outT); b._outT = 0;
    b.classList.remove('fab-out', 'fab-in');
    b.style.transition = ''; b.style.transform = '';
  }
}
// что реально попадёт в сборник: свои книги и уже готовые стопки (их содержимое вливается).
// Нескачанные записи каталога собирать нечего — их пропускаем.
function foldTargets() {
  const kind = (selKind === 'audio' || selKind === 'cataudio') ? 'audio' : 'book';
  const out = [];
  for (const key of selIds) {
    const f = folderById(key);
    if (f && f.kind === kind) { out.push(...(f.items || [])); continue; }
    const r = selRecOf(key);
    if (r) out.push(r.id);
  }
  return [...new Set(out)];
}
let selExitTimer = null;
function enterSelMode(kind, firstId) {
  closeFabMore(true);   // в выборе кластеру не до «ещё» — там свои кружки
  clearSelFabAnim();    // на всякий случай — вдруг остался незавершённый уезд кружка
  selMode = true; selKind = kind; selIds.length = 0;
  if (firstId) selIds.push(firstId);
  clearTimeout(selExitTimer);
  document.body.classList.remove('sel-exiting');   // прервать уходящую анимацию, если успели
  document.body.classList.add('sel-mode');   // показывает чекбоксы и красную кнопку-мусорку
  // в каталоге вместо мусорки — кружок «скачать всё» (удалять из каталога нечего)
  document.body.classList.toggle('sel-cat', kind.startsWith('cat'));
  refreshSelChecks();
  applyFabDock();   // кластер стал шире/выше на 2 кнопки — пере-клампим, чтобы не вылез за экран
}
function exitSelMode() {
  if (!selMode) return;
  clearSelFabAnim();   // снять недоигранные одиночные уезды — дальше уводит общий .sel-exiting
  selMode = false; selIds.length = 0;
  // чекбоксы карточек убираем сразу, а кружки (корзина/коллекция) плавно уезжают за экран:
  // держим их на .sel-exiting, пока играет fab-del-out, потом окончательно прячем
  // (.sel-cat живёт до конца анимации — иначе «скачать всё» мигнёт мусоркой на уезде)
  document.body.classList.remove('sel-mode');
  document.body.classList.add('sel-exiting');
  clearTimeout(selExitTimer);
  selExitTimer = setTimeout(() => {
    document.body.classList.remove('sel-exiting');
    document.body.classList.remove('sel-cat');
    document.body.classList.remove('sel-can-dl');   // до конца уезда классы держат видимые кружки
    document.body.classList.add('sel-can-del');
    applyFabDock();
  }, 300);
  document.querySelectorAll('.book-card.sel, .ab-card.sel').forEach(c => c.classList.remove('sel'));
}
function toggleSel(id) {
  if (!id) return;
  const i = selIds.indexOf(id);
  if (i >= 0) selIds.splice(i, 1); else selIds.push(id);
  if (!selIds.length) { exitSelMode(); return; }   // сняли последний — выходим из режима
  refreshSelChecks();
}
// тап по карточке в режиме выбора — переключить её (true = обработали, гасим обычное поведение)
function selClick(e) {
  if (e.target.closest('#add-fab')) return false;
  if (performance.now() - lpFiredAt < 700) return true;   // это отпускание долгого нажатия — игнор
  if (performance.now() - cardDragEndedAt < 600) return true;   // отпустили после перетаскивания — не выбор
  const card = e.target.closest('.book-card, .ab-card');
  if (card && cardKindOf(card) === selKind) toggleSel(cardIdOf(card));
  return true;
}
// ══════════ перетаскивание карточек: ручной порядок книг и аудиокниг ══════════
// Жест — продолжение долгого нажатия: подержал (карточка выбралась) и, НЕ отпуская, повёл —
// карточка отрывается и едет за пальцем, соседи плавно разъезжаются (FLIP), у краёв экрана
// полка подкручивается сама. Отпустил — карточка встаёт в слот, порядок уходит в базу.
let cardHold = null;         // палец на карточке после долгого нажатия — ждём движения
let cardDrag = null;         // идёт перетаскивание
let cardDragEndedAt = 0;     // отпускание после перетаскивания не должно считаться тапом
const DRAG_START = 6;        // с какого сдвига считаем, что человек повёл, а не дрогнул

// сетка, внутри которой едет карточка при перетаскивании: полка или вкладка аудио.
// Книги в карусели раскрытого сборника не таскаются (карусель листается горизонтально).
// grid для перетаскивания: книжка из карусели сборника тащится в контексте полки (её выносят);
// остальные — прямо на полке/вкладке аудио
const dragGridOf = card => card.closest('#shelf-grid, .ab-grid');

function beginCardDrag(x, y) {
  if (!cardHold) return;
  const card = cardHold.card; cardHold = null;
  const grid = dragGridOf(card);
  if (!grid) return;
  // ── ВЫНОС книжки из раскрытого сборника: тащишь книжку из карусели, выводишь за рамку
  //    контейнера — книга покидает сборник. Внутри рамки — просто листание/возврат. ──
  const fromFold = card.closest('.fold-card.fold-open');
  if (fromFold) {
    const r = card.getBoundingClientRect();
    // ВЫНОС: книжку на время делаем position:fixed на её текущем месте (координаты ЭКРАНА). Так она
    // сама выходит за обрезку карусели (fixed не клипается overflow) — не надо ломать overflow и
    // показывать прочие обложки; и прокрутка страницы её не тянет — не надо трогать touch-action.
    card.style.position = 'fixed';
    card.style.left = r.left + 'px'; card.style.top = r.top + 'px';
    card.style.width = r.width + 'px'; card.style.height = r.height + 'px';
    card.style.margin = '0'; card.style.zIndex = '90';
    cardDrag = { card, grid, items: [card], from: 0, to: 0, sec: fromFold, fixed: true,
                 rects: [{ x: r.left, y: r.top, w: r.width, h: r.height }],   // координаты ЭКРАНА (fixed)
                 bounds: { x0: -1e5, y0: -1e5, x1: 1e5, y1: 1e5 },
                 sc: 1.06, pull: 0, magnetR: null, x0: x, y0: y, cx: x, cy: y, raf: 0,
                 scrollMin: 0, scrollMax: 0 };   // при выносе страницу не крутим (книжка fixed)
    card.classList.add('card-drag');
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
    cardDragMove();
    cardDrag.raf = requestAnimationFrame(cardDragTick);
    return;
  }
  // при включённой сортировке ручной порядок не действует — перетаскивание молча бы
  // перезаписало порядок по отсортированной сетке и испортило ручной
  if (shelfSort.on && grid.id === 'shelf-grid') return;
  // пока сборник РАСКРЫТ, полку не переставляем: раскрытый контейнер держит книги «по рельсам»
  // (порядок в DOM переставлен), и сохранение сбило бы и раскладку, и ord. Сначала свернуть.
  if (activeFolder) return;
  // Сам контейнер-сборник (.fold-card) ТОЖЕ таскается — его можно переставить как книгу.
  // Когда тащат книгу — контейнеры из списка исключаем: они стоят на месте как цель-магнит и
  // не «удирают» из-под пальца. Когда тащат сам контейнер — в списке участвуют все ячейки.
  const draggingFold = card.classList.contains('fold-card');
  const items = [...grid.children].filter(el => el.matches('.book-card, .ab-card')
    && (draggingFold || !el.classList.contains('fold-card')));
  const from = items.indexOf(card);
  if (from < 0 || items.length < 1) return;
  // анимация появления новой книги (fill: both) держит transform: none и по правилам CSS
  // перебивает inline-стиль — карточка бы не сдвинулась с места. Снимаем её перед перетаскиванием.
  for (const el of items) el.classList.remove('book-in');
  // геометрию держим в координатах документа — тогда автоскролл её не сдвигает
  const rects = items.map(el => {
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  });
  // границы — по самим карточкам, а не по контейнеру: ниже последней книги пусто, и таскать
  // туда нечего. За эту рамку карточка не выходит, и полка не крутится дальше неё.
  const bounds = {
    x0: Math.min(...rects.map(r => r.x)),
    y0: Math.min(...rects.map(r => r.y)),
    x1: Math.max(...rects.map(r => r.x + r.w)),
    y1: Math.max(...rects.map(r => r.y + r.h)),
  };
  // Рамку раздвигаем до всей полки, если рядом есть сборники: книгу нужно донести до любого
  // контейнера-сборника (магнит), даже если он в другом ряду.
  const outer = grid.closest('#shelf-grid, .ab-grid') || grid;
  if (outer.querySelector('.fold-card')) {
    const ro = outer.getBoundingClientRect();
    bounds.x0 = Math.min(bounds.x0, ro.left + scrollX);
    bounds.y0 = Math.min(bounds.y0, ro.top + scrollY);
    bounds.x1 = Math.max(bounds.x1, ro.right + scrollX);
    bounds.y1 = Math.max(bounds.y1, ro.bottom + scrollY);
  }
  // sec — раскрытый сборник, ИЗ которого тащат книгу (для выноса). В карусельном сборнике
  // книги не таскаются, поэтому тут всегда null; оставлено для d.sec-проверок ниже.
  const sec = null;
  cardDrag = { card, grid, items, rects, bounds, from, to: from, sec, sc: 1.06, pull: 0, magnetR: null,
               x0: x + scrollX, y0: y + scrollY, cx: x, cy: y, raf: 0,
               scrollMin: Math.max(0, bounds.y0 - 96),
               scrollMax: Math.max(0, bounds.y1 + 24 - innerHeight) };
  grid.classList.add('grid-dragging');
  card.classList.add('card-drag');
  grid.style.touchAction = 'none';
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
  cardDragMove();
  cardDrag.raf = requestAnimationFrame(cardDragTick);
}

// расставить соседей по слотам: те, через кого «перешагнули», сдвигаются на соседнее место
function layoutCardSlots(d) {
  d.items.forEach((el, i) => {
    if (i === d.from) return;
    let j = i;
    if (d.from < d.to && i > d.from && i <= d.to) j = i - 1;
    else if (d.from > d.to && i >= d.to && i < d.from) j = i + 1;
    const sx = d.rects[j].x - d.rects[i].x, sy = d.rects[j].y - d.rects[i].y;
    el.style.transform = (sx || sy) ? `translate(${sx}px, ${sy}px)` : '';
  });
}

// Книгу можно бросить в сборник: под пальцем она мягко притягивается к его центру и
// чуть съёживается. Цель — карточка-стопка или шапка раскрытой секции; сам сборник и
// книги, уже лежащие в нём, за цель не считаются.
function magnetTargetAt(d, cx, cy) {
  if (d.card.classList.contains('fold-card')) return null;   // стопку в стопку не кладём
  const kind = d.card.classList.contains('ab-card') ? 'audio' : 'book';
  const id = cardIdOf(d.card);
  for (const el of document.querySelectorAll('.fold-card')) {   // и закрытые, и раскрытые контейнеры
    const fid = el.dataset.foldId;
    const f = folderById(fid);
    if (!f || f.kind !== kind || (f.items || []).includes(id)) continue;
    if (el.contains(d.card)) continue;          // книгу из этого же сборника не «добавляем» повторно
    // у раскрытого сборника цель — ВСЯ его секция (шапка и поле с книгами), а не одна шапка
    const r = el.getBoundingClientRect();
    const x = cx - scrollX, y = cy - scrollY;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
      return { el, id: fid, r };
  }
  return null;
}
function setMagnet(d, m) {
  if (m) d.magnetR = m.r;                       // цель помним и после ухода — чтобы плавно отпустить
  if ((d.magnet && d.magnet.id) === (m && m.id)) { d.magnet = m || d.magnet; return; }
  if (d.magnet) d.magnet.el.classList.remove('fold-magnet');
  d.magnet = m;
  if (m) {
    m.el.classList.add('fold-magnet');
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
  }
}
function cardDragMove() {
  const d = cardDrag; if (!d) return;
  const r0 = d.rects[d.from], b = d.bounds;
  // выносимая книжка position:fixed — считаем в координатах ЭКРАНА (без scroll); обычная — в документе
  const sx = d.fixed ? 0 : scrollX, sy = d.fixed ? 0 : scrollY;
  // держим карточку внутри рамки книг: за последней книгой пустое место — уводить её туда незачем
  let dx = Math.max(b.x0 - r0.x, Math.min(b.x1 - r0.w - r0.x, d.cx + sx - d.x0));
  let dy = Math.max(b.y0 - r0.y, Math.min(b.y1 - r0.h - r0.y, d.cy + sy - d.y0));
  let cx = r0.x + r0.w / 2 + dx, cy = r0.y + r0.h / 2 + dy;
  // Куда кладут — решает ПАЛЕЦ, а не центр карточки: карточка высокая и упирается в рамку
  // перетаскивания, её центр физически не достаёт до верхних целей.
  const fx = d.cx, fy = d.cy;
  // книгу вытащили за рамку раскрытого сборника — значит её оттуда выносят
  if (d.sec) {
    const rs = d.sec.getBoundingClientRect();
    const out = fx < rs.left || fx > rs.right || fy < rs.top || fy > rs.bottom;
    if (out !== d.eject) {
      d.eject = out;
      d.card.classList.toggle('card-eject', out);
      d.sec.classList.toggle('fold-losing', out);
      if (out && navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
    }
    // fixed-книжка выноса просто следует за пальцем (внутри рамки — крупнее, снаружи — чуть меньше);
    // магнит/слоты для неё не считаем
    if (d.fixed) { d.card.style.transform = `translate(${dx}px, ${dy}px) scale(${out ? 1.02 : 1.06})`; return; }
    if (out) { d.card.style.transform = `translate(${dx}px, ${dy}px) scale(1.02)`; return; }
  }
  setMagnet(d, magnetTargetAt(d, fx + scrollX, fy + scrollY));
  // Ни масштаб, ни притяжение не переключаются рывком: каждый кадр подтягиваем их к цели
  // (кадры идут постоянно — см. cardDragTick), поэтому книга плавно съёживается над
  // сборником и так же плавно возвращается, если увести её в сторону.
  const wantSc = d.magnet ? 0.8 : 1.06, wantPull = d.magnet ? 1 : 0;
  d.sc += (wantSc - d.sc) * 0.16;
  d.pull += (wantPull - d.pull) * 0.16;
  if (d.pull > 0.002 && d.magnetR) {           // тянем к центру сборника — доля пути растёт плавно
    const tx = d.magnetR.left + scrollX + d.magnetR.width / 2;
    const ty = d.magnetR.top + scrollY + d.magnetR.height / 2;
    dx += (tx - cx) * 0.42 * d.pull; dy += (ty - cy) * 0.42 * d.pull;
  }
  d.card.style.transform = `translate(${dx}px, ${dy}px) scale(${d.sc.toFixed(3)})`;
  if (d.magnet) return;                        // соседи не разъезжаются — книга уходит в сборник
  // куда встанет — ближайший слот к центру перетаскиваемой карточки (сетка двумерная,
  // поэтому не «номер строки», а честное расстояние до центров)
  cx = r0.x + r0.w / 2 + dx; cy = r0.y + r0.h / 2 + dy;
  let to = d.from, best = Infinity;
  d.rects.forEach((r, i) => {
    const q = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    if (q < best) { best = q; to = i; }
  });
  if (to === d.to) return;
  d.to = to;
  layoutCardSlots(d);
}

// у верхнего/нижнего края полка едет сама — иначе книгу с низа не поднять наверх
function cardDragTick() {
  const d = cardDrag; if (!d) return;
  const EDGE = 100, MAX = 16;
  let v = 0;
  if (d.cy < EDGE) v = -MAX * (1 - d.cy / EDGE);
  else if (d.cy > innerHeight - EDGE) v = MAX * (1 - (innerHeight - d.cy) / EDGE);
  if (v) {
    // дальше последней книги не крутим: ниже неё пусто, и уезжать туда незачем
    const before = scrollY;
    const want = Math.max(d.scrollMin, Math.min(d.scrollMax, before + v));
    if (want !== before) scrollTo(0, want);
  }
  cardDragMove();   // каждый кадр: даже с неподвижным пальцем масштаб и притяжение доезжают плавно
  d.raf = requestAnimationFrame(cardDragTick);
}

async function endCardDrag() {
  const d = cardDrag; if (!d) return;
  cardDrag = null;
  cancelAnimationFrame(d.raf);
  cardDragEndedAt = performance.now();
  const { card, grid, items, rects, from, to } = d;
  // ── ВЫНОС (fixed-книжка): за рамкой — покидает сборник; в рамке — плавно возвращается на место ──
  if (d.fixed) {
    card.classList.remove('card-eject');
    if (d.sec) d.sec.classList.remove('fold-losing');
    if (d.eject && d.sec) {   // вынесли — takeOutOfFolder перерисует полку, эта fixed-карточка уйдёт
      await takeOutOfFolder(d.sec.dataset.foldId, cardIdOf(card));
      return;
    }
    // вернулась в рамку — доводим к месту в карусели и снимаем fixed
    card.style.transition = 'transform .2s cubic-bezier(.4, 0, .2, 1)';
    card.style.transform = 'translate(0, 0) scale(1)';
    await new Promise(r => setTimeout(r, 205));
    card.classList.remove('card-drag');
    for (const pr of ['position', 'left', 'top', 'width', 'height', 'margin', 'zIndex', 'transition', 'transform']) card.style[pr] = '';
    return;
  }
  // бросили на сборник — книга всасывается в него; вынесли за рамку — покидает сборник
  if (d.magnet) {
    const fid = d.magnet.id;
    d.magnet.el.classList.remove('fold-magnet');
    card.style.transition = 'transform .26s cubic-bezier(.4, 0, .2, 1), opacity .26s ease';
    const r = d.magnet.r, r0 = rects[from];
    card.style.transform = `translate(${r.left + scrollX + r.width / 2 - r0.x - r0.w / 2}px, `
      + `${r.top + scrollY + r.height / 2 - r0.y - r0.h / 2}px) scale(.15)`;
    card.style.opacity = '0';
    await new Promise(res => setTimeout(res, 250));
    for (const el of items) { el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; }
    card.classList.remove('card-drag');
    grid.classList.remove('grid-dragging');
    grid.style.touchAction = '';
    await addToFolder(fid, cardIdOf(card));
    return;
  }
  // доводим карточку до слота (заодно сходит увеличение), и только потом трогаем DOM —
  // к этому моменту она уже стоит там, где окажется, поэтому перестановка не мигает
  card.style.transition = 'transform .2s cubic-bezier(.4, 0, .2, 1), filter .2s ease';
  card.style.transform = `translate(${rects[to].x - rects[from].x}px, ${rects[to].y - rects[from].y}px)`;
  await new Promise(r => setTimeout(r, 210));
  if (to !== from) {
    const arr = items.filter(el => el !== card);
    arr.splice(to, 0, card);
    arr.forEach(el => grid.appendChild(el));
  }
  card.classList.remove('card-drag');
  for (const el of items) { el.style.transition = ''; el.style.transform = ''; }
  grid.classList.remove('grid-dragging');
  grid.style.touchAction = '';
  // порядок: в коллекции — её (там смешанный список), на полке — ord книг. Книги из карусели
  // сборника только выносятся (см. ветку d.eject выше), внутри карусели не переставляются.
  if (to !== from) await (activeCol && !activeCat ? saveColOrder(grid) : saveShelfOrder(grid));
}

// порядок из DOM — в state и базу. При фильтре или в коллекции видна лишь часть полки:
// переставляем книги только по их же слотам, остальные остаются на своих местах.
async function saveShelfOrder(grid) {
  const audio = grid.classList.contains('ab-grid');
  const store = audio ? 'audiobooks' : 'books';
  const arr = audio ? state.audiobooks : state.books;
  // Порядок из DOM. Контейнер-сборник РАЗВОРАЧИВАЕМ в его книги (в порядке items) на его месте —
  // так перетаскивание сборника переносит его целиком: книги встают подряд там, куда его бросили,
  // и он снова показывается на этом месте. Обычные карточки — по своему id.
  const kind = audio ? 'audio' : 'book';
  const byId = new Map(arr.map(r => [r.id, r]));
  const ids = [];
  for (const el of grid.children) {
    if (!el.matches('.book-card, .ab-card') || el.classList.contains('cat-card')) continue;
    if (el.classList.contains('fold-card')) {
      const f = folderById(el.dataset.foldId);
      if (f && f.kind === kind) for (const mid of (f.items || [])) if (byId.has(mid)) ids.push(mid);
    } else ids.push(cardIdOf(el));
  }
  const shown = new Set(ids);
  const slots = [];
  arr.forEach((r, i) => { if (shown.has(r.id)) slots.push(i); });
  slots.forEach((slot, k) => { const r = byId.get(ids[k]); if (r) arr[slot] = r; });
  const moved = [];
  for (let i = 0; i < arr.length; i++) if (arr[i].ord !== i) { arr[i].ord = i; moved.push(arr[i]); }
  if (moved.length) { try { await dbChunk(store, moved); } catch {} }   // одна транзакция на всю перестановку
}

// новый порядок содержимого КОЛЛЕКЦИИ — в неё саму: в её списке книги и записи каталога
// живут вперемешку, ord книг тут ни при чём. При фильтре видна лишь часть — переставляем
// только видимые по их же местам, скрытые остаются где были (как у saveShelfOrder).
async function saveColOrder(grid) {
  const c = activeCol ? colById(activeCol) : null;
  if (!c) return;
  const kind = grid.classList.contains('ab-grid') ? 'audio' : 'book';
  // идентичность элемента: запись каталога — по ключу (data-catkey у нескачанной,
  // data-colcat у скачанной ею книги), иначе — сама книга по id
  const keyOf = it => it.k === 'cat' ? 'cat:' + it.id : it.k + ':' + it.id;
  const mine = it => it.k === kind || (it.k === 'cat' && (it.ck || 'book') === kind);
  const inCol = new Set((c.items || []).filter(mine).map(keyOf));   // ключи, реально лежащие в коллекции
  // Порядок из DOM. Контейнер-сборник РАЗВОРАЧИВАЕМ в его книги (в порядке items, но только те, что
  // есть в ЭТОЙ коллекции) на его месте — так перетаскивание сборника переносит его целиком. .fold-card
  // сам по себе в порядок не идёт (у него нет id — иначе сбил бы сопоставление, как было на полке).
  const domKeys = [];
  for (const el of grid.children) {
    if (!el.matches('.book-card, .ab-card')) continue;
    if (el.classList.contains('fold-card')) {
      const fld = folderById(el.dataset.foldId);
      if (fld && fld.kind === kind) for (const mid of (fld.items || [])) { const k = kind + ':' + mid; if (inCol.has(k)) domKeys.push(k); }
    } else domKeys.push(el.dataset.catkey ? 'cat:' + el.dataset.catkey
      : el.dataset.colcat ? 'cat:' + el.dataset.colcat
      : kind + ':' + (kind === 'audio' ? el.dataset.abId : el.dataset.book));
  }
  const pool = new Map((c.items || []).filter(mine).map(it => [keyOf(it), it]));
  const shown = new Set(domKeys);
  const slots = [];
  (c.items || []).forEach((it, i) => { if (mine(it) && shown.has(keyOf(it))) slots.push(i); });
  slots.forEach((slot, k) => { const it = pool.get(domKeys[k]); if (it) c.items[slot] = it; });
  try { await saveCollection(c); } catch {}
}

// тихое удаление аудиокниги (deleteAudiobook — с подтверждением и перерисовкой, для пачки не годится)
async function dropAudiobook(id) {
  if (ab && ab.rec && ab.rec.id === id) {
    abPause();
    if (ab._url) { try { URL.revokeObjectURL(ab._url); } catch {} }
    ab = null; pushMedia(); $('#audio-view').hidden = true;
  }
  await dbDel('audiotracks', bookRange(id));
  await dbDel('audiobooks', id);
  await dbDel('kv', 'aprog:' + id);
  await dbDel('kv', 'review:' + id);
  if (abCoverUrls.has(id)) { try { URL.revokeObjectURL(abCoverUrls.get(id)); } catch {} abCoverUrls.delete(id); }
  await purgeFromCollections('audio', id);   // убрать из всех коллекций
  await purgeFromFolders('audio', id);       // и из сборника
}
function pluralRu(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
async function deleteSelected() {
  if (!selIds.length) return;
  const audio = selKind === 'audio' || selKind === 'cataudio';
  // урна касается только того, что реально лежит в библиотеке, и молча пропускает
  // нескачанные записи каталога — удалять у них нечего
  const ids = selIds.map(k => { const r = selRecOf(k); return r ? r.id : null; }).filter(Boolean);
  if (!ids.length) return;
  const n = ids.length;
  // видимая анимация нажатия: кнопка «клюёт», крышка мусорки откидывается
  const fab = $('#fab-del');
  // .pressing ОБЯЗАТЕЛЬНО снять по завершении анимации (крышка .44s): иначе класс висит
  // на кнопке, и при следующем появлении урны (вход в выбор) крышка переигрывается сама
  if (fab) {
    fab.classList.remove('pressing'); void fab.offsetWidth; fab.classList.add('pressing');
    setTimeout(() => fab.classList.remove('pressing'), 470);
  }
  await new Promise(r => setTimeout(r, 230));
  const noun = uiLang() === 'ru'
    ? (audio ? pluralRu(n, 'аудиокнигу', 'аудиокниги', 'аудиокниг') : pluralRu(n, 'книгу', 'книги', 'книг'))
    : (audio ? 'audiobook' : 'book') + (n === 1 ? '' : 's');
  const msg = uiLang() === 'ru'
    ? `Удалить ${n} ${noun} вместе с прогрессом?`
    : `Delete ${n} ${noun} along with progress?`;
  if (!(await uiConfirm(msg, { yes: t('dlgDelete'), danger: true }))) return;
  exitSelMode();
  if (audio) {
    for (const id of ids) { try { await dropAudiobook(id); } catch {} }
    await loadAudiobooks();
    renderAudioShelf();
  } else {
    for (const id of ids) { try { await deleteBook(id); } catch {} }
    state.books = state.books.filter(b => !ids.includes(b.id));
    await renderShelf();
  }
  showToast(T('deletedN', { n }));
}

// ══════════════════ сборники (стопки прямо на полке) ══════════════════
// Многотомник не должен занимать полку двадцатью карточками. Сборник — одна карточка-стопка
// на месте своих книг: { id, name, kind:'book'|'audio', items:[id…], auto:bool, createdAt }.
// Это свойство САМИХ книг, а не коллекции: стопка одинаково видна и на общей полке, и внутри
// коллекции (там — теми книгами, что в этой коллекции есть). Книга состоит максимум в одном
// сборнике. Расформирование убирает только стопку — книги остаются на месте.
let activeFolder = null;   // id раскрытого сборника (лист снизу)
let foldFlipBefore = null; // снимок позиций перед ре-рендером — FLIP применяется СИНХРОННО в рендере
async function loadFolders() {
  try { state.folders = (await dbAll('folders')).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }
  catch { state.folders = []; }
}
const saveFolder = f => dbPut('folders', f);
function folderById(id) { return (state.folders || []).find(f => f.id === id) || null; }
// книгу удалили из библиотеки — вынимаем её из сборника, пустой/одиночный сборник распускаем
async function purgeFromFolders(kind, id) {
  for (const f of (state.folders || []).slice()) {
    if (f.kind !== kind || !(f.items || []).includes(id)) continue;
    f.items = f.items.filter(x => x !== id);
    if (f.items.length < 2) {   // сборник из одной книги смысла не имеет
      state.folders = state.folders.filter(x => x !== f);
      try { await dbDel('folders', f.id); } catch {}
    } else { try { await saveFolder(f); } catch {} }
  }
}
// имя по общему началу названий («Реинкарнация безработного. Том 1/2/3» → «Реинкарнация
// безработного»); слишком короткое общее начало не годится — тогда имя спросим у человека
function folderAutoName(titles) {
  if (titles.length < 2) return '';
  let p = String(titles[0] || '');
  for (const t of titles) { const s = String(t || ''); while (p && !s.startsWith(p)) p = p.slice(0, -1); }
  p = p.replace(/[\s.,:;_\-–—(\[]*(?:том|часть|книга|кн|vol|volume|book|part|no)?\.?\s*\d*\s*$/i, '').trim();
  return p.length >= 3 ? p : '';
}
// ── полка с учётом сборников: книги одного сборника сворачиваются в ОДНУ карточку ──
// entries — [{ b }|{ ph }] в порядке показа (ord). Сборник встаёт на место своей ПЕРВОЙ (по
// этому порядку) книги, остальные его книги из потока уходят. Каждая книга показывается РОВНО
// один раз — либо сама, либо внутри своего сборника. Ни якорей, ни отложенных состояний:
// принадлежность книги считается один раз (folderOf), поэтому дублей быть не может в принципе.
function foldEntries(entries, kind) {
  const folders = (state.folders || []).filter(f => f.kind === kind);
  if (!folders.length) return entries;
  const folderOf = new Map();                          // id книги → её сборник (первый по списку)
  for (const f of folders) for (const id of (f.items || [])) if (!folderOf.has(id)) folderOf.set(id, f);
  const emitted = new Set();
  const out = [];
  for (const en of entries) {
    if (!en.b) { out.push(en); continue; }             // плейсхолдер каталога — как есть
    const f = folderOf.get(en.b.id);
    if (!f) { out.push(en); continue; }                // свободная книга — сама по себе
    if (emitted.has(f.id)) continue;                   // сборник уже стоит выше — книгу поглощаем
    // в сборнике — только те его книги, что реально видны здесь (в коллекции их может быть часть)
    const items = entries.filter(x => x.b && folderOf.get(x.b.id) === f).map(x => x.b);
    if (items.length < 2) { out.push({ b: en.b }); continue; }   // видна одна книга — показываем её
    emitted.add(f.id);
    out.push({ f, items, open: activeFolder === f.id });
  }
  return out;
}
// раскрытая стопка = секция во всю ширину полки: шапка с именем и своя сетка книг внутри.
// Так сборник получает собственное пространство и не мешается с остальной полкой.
// раскрытый сборник — КАРУСЕЛЬ: один ряд книг во всю ширину, 2 видно, остальные листаются
// свайпом вбок (нативный scroll-snap). Занимает всего одну строку высоты — движется минимум.
const FOLD_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 18z"/></svg>';
const FOLD_PEN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
// ЕДИНЫЙ контейнер сборника — ОДИН и тот же HTML закрытым и раскрытым: шапка (иконка-папка +
// имя + счётчик) и карусель книжек. Разница ТОЛЬКО в классе .fold-open, который через grid-column
// растягивает карточку на всю строку и открывает больше книжек в карусели. Рамка, фон, шапка,
// первая книжка идентичны — раскрытие это рост ширины, а не подмена. Кнопки правки (слева вверху)
// и роспуска (справа вверху) — в углах, одинаково в обоих состояниях.
function folderCardHtml(f, items, audio, open, cardFn) {
  const books = items.map(x =>
    `<div class="fold-cbook">${cardFn ? cardFn(x, { inFold: f.id }) : bookCardHtml(x, { inFold: f.id })}</div>`).join('');
  const cls = (audio ? 'ab-card' : 'book-card') + ' fold-card' + (open ? ' fold-open' : '');
  return `<div class="${cls}" data-fold-id="${esc(f.id)}">
    <button class="fold-edit" data-foldedit="${esc(f.id)}" aria-label="${esc(t('foldRename'))}">${FOLD_PEN}</button>
    <button class="fold-x" data-foldbreak="${esc(f.id)}" aria-label="${esc(t('foldBreak'))}">✕</button>
    <button class="fold-head" data-folder="${esc(f.id)}">
      <span class="fold-head-ic" aria-hidden="true">${FOLD_ICON}</span>
      <span class="fold-head-name"><span class="marq">${esc(f.name)}</span></span>
      <span class="fold-head-n">${items.length}</span>
    </button>
    <div class="fold-carousel">${books}</div>
  </div>`;
}

// ── собрать выбранное в сборник (кружок-папка) ──
// Выбраны только свободные книги — рождается новый сборник; попала в выбор готовая стопка —
// остальное вливается в неё. Имя берём из общего начала названий, а не вышло — спрашиваем.
async function foldSelected() {
  if (!selMode || !selIds.length) return;
  const kind = (selKind === 'audio' || selKind === 'cataudio') ? 'audio' : 'book';
  const ids = foldTargets();
  if (ids.length < 2) return;
  const pool = kind === 'audio' ? (state.audiobooks || []) : state.books;
  const titleOf = id => { const r = pool.find(x => x.id === id); return r ? r.title : ''; };
  // целевая стопка: если в выборе была готовая — вливаем в неё (её имя сохраняется)
  let target = null;
  for (const key of selIds) { const f = folderById(key); if (f && f.kind === kind) { target = f; break; } }
  let name = target ? target.name : folderAutoName(ids.map(titleOf));
  let auto = !!name;
  if (!name) {
    name = (await uiPrompt(t('foldNameQ'), { ph: titleOf(ids[0]).slice(0, 40), yes: t('colAdd2') }) || '').trim();
    if (!name) return;   // передумали — выбор не трогаем
  }
  // книги могли состоять в других сборниках — вынимаем их оттуда, пустые распускаем
  for (const f of (state.folders || []).slice()) {
    if (f === target || f.kind !== kind) continue;
    const left = (f.items || []).filter(x => !ids.includes(x));
    if (left.length === (f.items || []).length) continue;
    if (left.length < 2) { state.folders = state.folders.filter(x => x !== f); try { await dbDel('folders', f.id); } catch {} }
    else { f.items = left; try { await saveFolder(f); } catch {} }
  }
  if (target) target.items = [...new Set([...(target.items || []), ...ids])];
  else {
    target = { id: newId('fold'), name, kind, items: ids, auto, createdAt: Date.now() };
    state.folders.push(target);
  }
  // сборка без беготни по экрану: выбранные книги втягиваются САМИ В СЕБЯ на своих местах
  // и гаснут, а на месте самой первой из них рождается стопка
  const grid = kind === 'audio' ? $('#audio-content') : $('#shelf-grid');
  const dying = grid ? [...grid.querySelectorAll('[data-book], [data-ab-id]')]
    .filter(el => ids.includes(el.dataset.book || el.dataset.abId)) : [];
  exitSelMode();
  for (const el of dying) el.classList.add('fold-suck');
  if (dying.length) await new Promise(r => setTimeout(r, 260));
  try { await saveFolder(target); } catch {}
  if (kind === 'audio') await renderAudioShelf(); else await renderShelf();
  const card = grid && grid.querySelector(`[data-fold-id="${CSS.escape(target.id)}"]`);
  if (card) { card.classList.add('fold-born'); card.addEventListener('animationend', () => card.classList.remove('fold-born'), { once: true }); }
  showToast(T('foldMade', { n: target.name }));
}
// сетка, где живут карточки этого сорта (книги — полка, аудио — вкладка аудиокниг)
const foldGridOf = kind => kind === 'audio' ? $('#audio-content .ab-grid') : $('#shelf-grid');
// ── книга въезжает в сборник (бросили на него) и покидает его (вытащили за рамку) ──
// Перестройку полки после этого доводим FLIP-ом: соседи плавно съезжают на освободившееся
// место, ничего не прыгает.
async function addToFolder(folderId, id) {
  const f = folderById(folderId);
  if (!f || !id || (f.items || []).includes(id)) return;
  for (const o of (state.folders || []).slice()) {   // из прежнего сборника вынимаем
    if (o === f || o.kind !== f.kind || !(o.items || []).includes(id)) continue;
    o.items = o.items.filter(x => x !== id);
    if (o.items.length < 2) { state.folders = state.folders.filter(x => x !== o); try { await dbDel('folders', o.id); } catch {} }
    else { try { await saveFolder(o); } catch {} }
  }
  f.items = [...(f.items || []), id];
  try { await saveFolder(f); } catch {}
  foldFlipBefore = cardRects(foldGridOf(f.kind));   // FLIP применится СИНХРОННО внутри рендера — без рывка соседей
  if (f.kind === 'audio') await renderAudioShelf(); else await renderShelf();
}
async function takeOutOfFolder(folderId, id) {
  const f = folderById(folderId);
  if (!f || !(f.items || []).includes(id)) return;
  f.items = f.items.filter(x => x !== id);
  const audio = f.kind === 'audio';
  if (f.items.length < 2) {   // сборник из одной книги смысла не имеет — распускаем
    state.folders = (state.folders || []).filter(x => x !== f);
    if (activeFolder === f.id) activeFolder = null;
    try { await dbDel('folders', f.id); } catch {}
  } else { try { await saveFolder(f); } catch {} }
  foldFlipBefore = cardRects(foldGridOf(f.kind));   // FLIP синхронно внутри рендера — соседи не дёргаются
  if (audio) await renderAudioShelf(); else await renderShelf();
}

// ── раскрытие/сворачивание сборника ПРЯМО В СЕТКЕ ──
// Карточке добавляется/снимается класс .fold-open (через grid-column растит её на всю строку).
// Всё, что сместилось, переезжает FLIP-ом; сама карточка едет и растёт/сжимается по ширине.
// Порядок книг (ord) при этом НЕ трогается — раскрытие ничего не сохраняет, поэтому ручная
// расстановка полки не сбивается. Одновременно раскрыт только один сборник.
let foldBusy = false;
const foldSleep = ms => new Promise(r => setTimeout(r, ms));
// FLIP соседей, сдвинутых раскрытием: снимок был ДО сдвига (wasRects) → плавно едем в новые места
function flipMoved(grid, wasRects, dur) {
  const moved = [];
  for (const el of grid.querySelectorAll('.book-card, .ab-card')) {
    const was = wasRects.get(el); if (!was) continue;
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.classList.remove('book-in');
    el.style.transition = 'none'; el.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(el);
  }
  if (!moved.length) return moved;
  void grid.offsetWidth;
  for (const el of moved) { el.style.transition = `transform ${dur || 280}ms cubic-bezier(.25,.1,.25,1)`; el.style.transform = ''; }
  return moved;
}
function clearFlip(moved) { for (const el of moved) { el.style.transition = ''; el.style.transform = ''; } }

// Раскрытие/сворачивание — ДВА ЭТАПА, чтобы не было рывка: сперва соседний ряд спокойно
// опускается (FLIP), и ТОЛЬКО ПОТОМ контейнер разъезжается вбок до полной ширины (или наоборот
// при сворачивании). Порядок (ord) не трогается. Одновременно раскрыт только один сборник.
async function toggleFolder(id) {
  const f = folderById(id); if (!f || foldBusy) return;
  foldBusy = true;
  try {
    const grid = foldGridOf(f.kind);
    // СТРОГАЯ ЦЕПОЧКА при переключении: если открыт ДРУГОЙ сборник — сперва ПОЛНОСТЬЮ его свернуть
    // тем же чистым сворачиванием (его соседи вернутся на места), и только ПОТОМ открывать новый.
    if (activeFolder && activeFolder !== id) {
      const prevBox = grid.querySelector('.fold-card.fold-open');
      const prevF = folderById(activeFolder);
      activeFolder = null;
      if (prevBox && prevF) await foldCloseInPlace(grid, prevBox, prevF);
    }
    const box = grid.querySelector(`.fold-card[data-fold-id="${CSS.escape(id)}"]`);
    if (!box) { activeFolder = activeFolder === id ? null : id; if (f.kind === 'audio') await renderAudioShelf(); else await renderShelf(); return; }
    if (activeFolder === id) { activeFolder = null; await foldCloseInPlace(grid, box, f); }
    else { activeFolder = id; await foldOpenInPlace(grid, box, f); }
  } finally { foldBusy = false; }
}
function closeFolder() { if (activeFolder) toggleFolder(activeFolder); }

// РАСКРЫТИЕ на месте, два этапа. Контейнер во всю строку (grid-column:1/-1), но пока шириной
// ячейки и на своей стороне (justify-self), соседи по строке уходят под него (foldGaps). Этап 1
// плавно опускает соседей; этап 2 — разжимает контейнер вбок до 100%. Высота фиксирована (var).
async function foldOpenInPlace(grid, box, f) {
  const rc = box.getBoundingClientRect(), gr = grid.getBoundingClientRect();
  const rightHalf = (rc.left + rc.width / 2 - gr.left) > gr.width / 2;
  const wClosed = rc.width;
  // высота раскрытого = высоте закрытого (= высоте ячейки), замеряем СЕЙЧАС по тапу — раскладка
  // устоялась, число верное. Меняется только ширина.
  grid.style.setProperty('--fold-open-h', Math.round(rc.height) + 'px');
  const was = new Map([...grid.querySelectorAll('.book-card, .ab-card')].filter(el => el !== box)
    .map(el => [el, el.getBoundingClientRect()]));
  box.classList.add('fold-open');
  box.style.gridColumn = '1 / -1';
  box.style.justifySelf = rightHalf ? 'end' : 'start';
  box.style.width = wClosed + 'px';
  foldGaps(grid);
  cardMarquee(grid);
  const moved = flipMoved(grid, was, 280);        // этап 1: соседи опускаются, контейнер узкий
  await foldSleep(moved.length ? 300 : 40);
  clearFlip(moved);
  void box.offsetWidth;
  box.style.transition = 'width .3s cubic-bezier(.25,.1,.25,1)';   // этап 2: контейнер вбок
  box.style.width = '100%';
  await foldSleep(320);
  box.style.transition = ''; box.style.width = ''; box.style.justifySelf = ''; box.style.gridColumn = '';
}
// СВОРАЧИВАНИЕ, два этапа, БЕЗ ре-рендера (иначе браузер рисует финал до FLIP — прыжок).
// Этап 1 — контейнер сжимается к своей ЯЧЕЙКЕ в СВОЮ сторону (столбец считаем по тому, куда он
// вернётся, а не «по центру раскрытого» — иначе правый контейнер сжимался влево и прыгал вправо).
// Этап 2 — СИНХРОННО возвращаем раскладку (повисшие книги — назад перед контейнером, убираем
// пустышку и класс) и FLIP-ом поднимаем соседей на места. Ре-рендера нет — прыжка нет.
async function foldCloseInPlace(grid, box, f) {
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 2;
  const closed = grid.__foldClosed || [...grid.children].filter(el => el.matches('.book-card, .ab-card'));
  const idx = closed.indexOf(box);
  const col = idx >= 0 ? (idx % cols) : 0;          // столбец контейнера в ЗАКРЫТОЙ раскладке
  const rightHalf = col >= cols / 2;
  const sample = [...grid.children].find(el => el.matches('.book-card:not(.fold-card), .ab-card:not(.fold-card)'));
  const curW = box.getBoundingClientRect().width;   // ЗАМЕР ДО смены justify-self — иначе контейнер
  const wClosed = sample ? sample.getBoundingClientRect().width : curW;   // на миг растянется до контента (за экран)
  box.style.gridColumn = '1 / -1';
  box.style.justifySelf = rightHalf ? 'end' : 'start';   // сжимаемся В СВОЙ столбец
  box.style.width = curW + 'px';                     // сразу пришпилили к текущей ширине — рывка нет
  void box.offsetWidth;
  box.style.transition = 'width .27s cubic-bezier(.25,.1,.25,1)';   // этап 1: контейнер к ячейке
  box.style.width = wClosed + 'px';
  await foldSleep(285);
  const was = cardRects(grid);                     // рельсовая раскладка, контейнер уже сжат в свой столбец
  for (const g of grid.querySelectorAll('.fold-gap')) g.remove();
  for (const el of closed) if (el.isConnected) grid.appendChild(el);   // синхронно вернуть ЗАКРЫТЫЙ порядок
  box.classList.remove('fold-open');
  box.style.transition = ''; box.style.width = ''; box.style.justifySelf = ''; box.style.gridColumn = '';
  flipCards(grid, was);                            // этап 2: сдвинутый столбец синхронно едет обратно — без прыжка
  await foldSleep(360);
}

// Раскрытый сборник занимает ВСЮ свою строку. Книги, что были с ним в одной строке слева,
// уходят СТРОГО ВНИЗ под него (перенос под контейнер), на месте контейнера — пустая ячейка.
// Тогда сосед по строке (и слева, и справа) съезжает на одну строку вниз в СВОЙ столбец, а
// книги под контейнером столбцов не меняют. Перерисовка всё пересобирает из ord; .fold-gap в
// подсчёте порядка не участвует. Сборник раскрыт только один.
function foldGaps(grid) {
  if (!grid) return;
  for (const g of grid.querySelectorAll('.fold-gap')) g.remove();
  const open = grid.querySelector('.fold-card.fold-open');
  if (!open) { grid.__foldClosed = null; return; }
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  if (cols < 2) return;
  const mkGap = () => { const s = document.createElement('span'); s.className = 'fold-gap'; s.setAttribute('aria-hidden', 'true'); return s; };
  // Порядок карточек СЕЙЧАС = закрытый (грид только что собран из ord/коллекции). Запоминаем его —
  // при сворачивании вернём синхронно этим списком, без ре-рендера (значит без прыжка).
  const cards = [...grid.children].filter(el => el.matches('.book-card, .ab-card'));
  grid.__foldClosed = cards.slice();
  const P = cards.indexOf(open);
  const oc = P % cols;                                 // столбец контейнера

  if (cols !== 2) {                                    // не 2 колонки — прежнее: соседей слева под контейнер + пустышка
    const after0 = open.nextSibling;
    const hang0 = [];
    for (let i = 0, el = open.previousElementSibling; i < oc && el; el = el.previousElementSibling)
      if (el.matches('.book-card, .ab-card')) { hang0.unshift(el); i++; }
    for (const cnode of hang0) grid.insertBefore(cnode, after0);
    grid.insertBefore(mkGap(), after0);
    return;
  }

  // ═══ 2 колонки: РЕЛЬСЫ — вниз едет ТОЛЬКО столбец, куда врезается раскрытие; другой стоит. ═══
  // Контейнер во всю строку. Вытесненная соседка (справа у левого контейнера / слева у правого)
  // встаёт наверх «своего» столбца и толкает его вниз; противоположный столбец не двигается.
  const before = cards.slice(0, P), after = cards.slice(P + 1);
  let displaced, below, stayCol0;
  if (oc === 0) { displaced = after[0] || null; below = after.slice(1); stayCol0 = true; }   // левый: едет правый столбец
  else { displaced = before[before.length - 1] || null; below = after; stayCol0 = false; }    // правый: едет левый столбец
  const stay = [], shift = [];                         // книги ниже идут по столбцам [c0,c1,c0,c1,...]
  below.forEach((el, i) => { const c0 = (i % 2) === 0; ((stayCol0 ? c0 : !c0) ? stay : shift).push(el); });
  const shiftCol = displaced ? [displaced, ...shift] : shift;   // смещённый столбец: вытесненная книга сверху
  let ref = open;                                      // раскладываем построчно сразу за контейнером
  const rows = Math.max(stay.length, shiftCol.length);
  for (let i = 0; i < rows; i++) {
    const s = stay[i], f = shiftCol[i];
    const c0 = (stayCol0 ? s : f) || mkGap(), c1 = (stayCol0 ? f : s) || mkGap();   // [col0, col1]
    grid.insertBefore(c0, ref.nextSibling); ref = c0;
    grid.insertBefore(c1, ref.nextSibling); ref = c1;
  }
}
// Габариты книжки внутри сборника = габаритам ЯЧЕЙКИ полки: обложка заполняет контейнер и по
// ширине, и по высоте (не плавает в пустоте). Мерим соседнюю книгу через offset* (чистая
// раскладка, без искажений transform-анимации). На телефоне это верные числа.
function setFoldCellW(grid) {
  if (!grid || !grid.querySelector('.fold-card')) return;
  // ТОЛЬКО верхнеуровневая ячейка полки (grid.children), НЕ книжка из карусели сборника — иначе
  // при библиотеке из одних сборников замеряли бы обложку, размер которой сам зависит от --fold-cw,
  // и на каждом рендере контейнеры схлопывались бы (обратная связь). Нет своих книг — переменную
  // не трогаем, остаётся дефолт.
  const cell = [...grid.children].find(el => el.matches('.book-card:not(.fold-card), .ab-card:not(.fold-card)'));
  if (cell && cell.offsetWidth) grid.style.setProperty('--fold-cw', cell.offsetWidth + 'px');
  if (cell && cell.offsetHeight) grid.style.setProperty('--fold-cell-h', cell.offsetHeight + 'px');
}
// снимок позиций карточек — для FLIP-переезда после перерисовки
function cardRects(grid) {
  const m = new Map();
  if (!grid) return m;
  for (const el of grid.querySelectorAll('[data-book], [data-ab-id], [data-fold-id]')) {
    const k = el.dataset.foldId ? 'f:' + el.dataset.foldId
      : (el.dataset.inFold ? 'i:' + el.dataset.inFold + ':' : '') + (el.dataset.book || el.dataset.abId);
    m.set(k, el.getBoundingClientRect());
  }
  return m;
}
// FLIP после перерисовки: карточки едут из старых позиций (before) в новые. Контейнер-сборник
// заодно плавно меняет ШИРИНУ (раскрылся/свернулся) — justify-self держит его у начала строки.
function flipCards(grid, before) {
  if (!grid || !before.size) return;
  const moved = [];
  for (const el of grid.querySelectorAll('[data-book], [data-ab-id], [data-fold-id]')) {
    const k = el.dataset.foldId ? 'f:' + el.dataset.foldId
      : (el.dataset.inFold ? 'i:' + el.dataset.inFold + ':' : '') + (el.dataset.book || el.dataset.abId);
    const prev = before.get(k); if (!prev) continue;
    const now = el.getBoundingClientRect();
    const dx = prev.left - now.left, dy = prev.top - now.top;
    const dw = el.classList.contains('fold-card') ? (prev.width - now.width) : 0;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dw) < 0.5) continue;
    el.style.transition = 'none';
    el.classList.remove('book-in');   // анимация появления держала бы transform: none и гасила переезд
    const wide = Math.abs(dw) >= 0.5;
    if (wide) { el.style.justifySelf = 'start'; el.style.width = prev.width + 'px'; }
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push({ el, wide, w: now.width });
  }
  if (!moved.length) return;
  void grid.offsetWidth;              // отдаём браузеру стартовые позиции, иначе он схлопнет переезд
  requestAnimationFrame(() => {
    for (const m of moved) {
      m.el.style.transition = m.wide
        ? 'transform .34s cubic-bezier(.4,0,.2,1), width .34s cubic-bezier(.4,0,.2,1)'
        : 'transform .34s cubic-bezier(.4,0,.2,1)';
      m.el.style.transform = '';
      if (m.wide) m.el.style.width = m.w + 'px';
    }
    setTimeout(() => { for (const m of moved) { m.el.style.transition = ''; m.el.style.transform = ''; m.el.style.width = ''; m.el.style.justifySelf = ''; } }, 360);
  });
}
async function renameFolder(id) {
  const f = folderById(id); if (!f) return;
  const name = (await uiPrompt(t('foldRename'), { val: f.name, yes: t('colAdd2') }) || '').trim();
  if (!name || name === f.name) return;
  f.name = name; f.auto = false;
  try { await saveFolder(f); } catch {}
  if (f.kind === 'audio') renderAudioShelf(); else await renderShelf();
}
// расформировать: уходит только стопка, книги остаются на полке
async function breakFolder(id) {
  const f = folderById(id); if (!f) return;
  if (!(await uiConfirm(T('foldBreakQ', { n: f.name }), { yes: t('foldBreakYes'), danger: true }))) return;
  state.folders = (state.folders || []).filter(x => x.id !== id);
  if (activeFolder === id) activeFolder = null;
  try { await dbDel('folders', id); } catch {}
  if (f.kind === 'audio') renderAudioShelf(); else await renderShelf();
  showToast(t('foldBroken'));
}

// ══════════════════ коллекции («свои полки») ══════════════════
// Выдвижной раздел слева поверх интерфейса. Коллекция:
//   { id, name, order, createdAt, items:[{k:'book'|'audio', id}] }
// Членство хранится в самой коллекции. Просмотр: activeCol фильтрует полку.
if (!state.collections) state.collections = [];
let activeCol = null;          // id просматриваемой коллекции (null = все)
let colDrawerOpen = false;
// открыто ли какое-то вспомогательное окно/шторка/меню. Пока открыто — глобальные жесты по ФОНУ
// (свайп вкладок, листание глав, пинч картинки, долгое нажатие карточки, перетаскивание кластера)
// не срабатывают: взаимодействие идёт только внутри окна.
const OVERLAY_SEL = '#scan-modal, #confirm-modal, #settings-sheet, #note-sheet, #tr-sheet, #review-sheet, '
  + '#ab-notes-sheet, #annot-sheet, #info-sheet, #pronun-sheet, #col-create, #col-pick, #sync-pick, #cat-add, #lightbox, #word-pop';
// ignoreDrawer=true — для обработчика, который САМ обслуживает свайпы ящика коллекций (закрытие
// свайпом), иначе он глушил бы собственный жест
function uiOverlayOpen(ignoreDrawer) {
  if (!ignoreDrawer && colDrawerOpen) return true;
  for (const el of document.querySelectorAll(OVERLAY_SEL)) if (el && !el.hidden) return true;
  if (document.querySelector('.dd-menu.open, .lang-menu.open, .voice-menu.open, .speed-wheel.open')) return true;   // открытая выпадашка
  return false;
}
// пока открыто окно — НАТИВНАЯ прокрутка идёт только внутри него; тач по скриму/фону/короткому
// списку не двигает фон. Разрешаем жест, ТОЛЬКО если под пальцем есть контейнер окна, который
// реально может прокрутиться в эту сторону; иначе preventDefault (иначе браузер крутит тело сзади).
// Флаг/старт считаем на touchstart, чтобы не дёргать плавность обычного скролла.
let _ovlNow = false, _ovlY = 0;
document.addEventListener('touchstart', e => { _ovlNow = uiOverlayOpen(); _ovlY = e.touches[0] ? e.touches[0].clientY : 0; }, { capture: true, passive: true });
document.addEventListener('touchmove', e => {
  if (!_ovlNow || e.touches.length !== 1) return;
  const dy = e.touches[0].clientY - _ovlY;
  for (let el = e.target; el && el !== document.body; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
    // ближайший скролл-контейнер под пальцем: если может прокрутиться в эту сторону — разрешаем,
    // иначе гасим (не чейнимся на тело за окном — контейнеры и так overscroll-behavior:contain)
    const atTop = el.scrollTop <= 0, atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if (!((dy > 0 && atTop) || (dy < 0 && atBottom))) return;
    break;
  }
  e.preventDefault();   // внутри окна прокручивать нечего → фон не двигаем
}, { passive: false });
let colPickSel = null;         // Set выбранных colId в диалоге «в коллекцию»

async function loadCollections() {
  try { state.collections = (await dbAll('collections')).sort((a, b) => (a.order || 0) - (b.order || 0)); }
  catch { state.collections = []; }
}
const saveCollection = c => dbPut('collections', c);
function colById(id) { return (state.collections || []).find(c => c.id === id) || null; }
function colHas(colId, kind, id) {
  const c = colById(colId);
  return !!(c && (c.items || []).some(it => it.k === kind && it.id === id));
}
async function purgeFromCollections(kind, id) {   // при удалении книги — убрать её из всех коллекций
  for (const c of (state.collections || [])) {
    if (!c.items || !c.items.length) continue;
    const before = c.items.length;
    c.items = c.items.filter(it => !(it.k === kind && it.id === id));
    if (c.items.length !== before) { try { await saveCollection(c); } catch {} }
  }
}

// ── выдвижной раздел ──
function openColDrawer() {
  colDrawerOpen = true;
  // список своих каталогов лежит в kv — при первом открытии дочитываем и дорисовываем
  if (!catStateReady) ensureCatState().then(() => { if (colDrawerOpen) renderColDrawer(); });
  renderColDrawer();
  const dr = $('#col-drawer'), sc = $('#col-scrim');
  const hadInline = !!dr.style.transform;   // драг оставил позицию — плавно анимируем от неё
  sc.hidden = false; dr.hidden = false;
  dr.style.transition = ''; dr.style.transform = '';
  if (!hadInline) void dr.offsetWidth;       // тап/свайп: применяем стартовое -100% ДО .open, иначе рывок
  document.body.classList.add('col-open');   // язычок и раздел трогаются В ОДНОМ кадре — не отрываются
  sc.classList.add('open'); dr.classList.add('open');
}
function closeColDrawer() {
  colDrawerOpen = false;
  const dr = $('#col-drawer'), sc = $('#col-scrim');
  dr.style.transition = ''; dr.style.transform = '';   // от текущего положения плавно в -100%
  dr.classList.remove('open'); sc.classList.remove('open');
  document.body.classList.remove('col-open');
  setTimeout(() => { if (!colDrawerOpen) { dr.hidden = true; sc.hidden = true; } }, 340);
}
function toggleColDrawer() { colDrawerOpen ? closeColDrawer() : openColDrawer(); }

function renderColDrawer() {
  renderCatSection();   // секция «Каталог» над коллекциями живёт в том же шкафу
  const list = $('#col-list'), dr = $('#col-drawer');
  if (!list || !dr) return;
  const cols = state.collections || [];
  dr.classList.toggle('col-empty', !cols.length);
  list.innerHTML = cols.map(c =>
    `<div class="col-item${activeCol === c.id ? ' active' : ''}" data-col="${c.id}">`
    + `<span class="col-grip" data-colgrip aria-hidden="true"><i></i><i></i><i></i></span>`
    + `<span class="col-item-name">${esc(c.name)}</span>`
    + `<span class="col-item-count">${(c.items || []).length}</span>`
    + `<button class="col-item-del" data-coledit="${c.id}" aria-label="${esc(t('colRenameT'))}">`
    + `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>`
    + `<button class="col-item-del" data-coldel="${c.id}" aria-label="${esc(t('colDelete'))}">✕</button>`
    + `</div>`).join('');
}

// ── создание коллекции: центральное окно ввода имени (оно же — переименование) ──
let colHideT = 0, colPickHideT = 0;   // таймеры «спрятать после уезда» — сбрасываем при повторном открытии
let colRenameId = null;               // не null — окно правит имя существующей коллекции
function openColCreate(renameId) {
  const box = $('#col-create'); if (!box) return;
  colRenameId = typeof renameId === 'string' ? renameId : null;
  clearTimeout(colHideT);
  box.hidden = false;
  // два кадра, как у «Вставить по ссылке»: с одним браузер схлопывает стартовое
  // положение (за левым краем) с конечным и выезда не видно вовсе
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('open')));
  const inp = $('#col-name');
  if (inp) {
    inp.value = colRenameId ? ((colById(colRenameId) || {}).name || '') : '';
    setTimeout(() => inp.focus(), 80);
  }
}
function closeColCreate() {
  const box = $('#col-create'); if (!box) return;
  box.classList.remove('open');
  clearTimeout(colHideT);
  colHideT = setTimeout(() => { box.hidden = true; }, 360);   // дожидаемся, пока окно уедет за край
}
async function saveNewCol() {
  const name = (($('#col-name') || {}).value || '').trim();
  if (!name) { closeColCreate(); return; }
  if (colRenameId) {   // правка имени существующей
    const c = colById(colRenameId);
    if (c && c.name !== name) { c.name = name; try { await saveCollection(c); } catch {} }
    closeColCreate();
    renderColDrawer();
    return;
  }
  const order = (state.collections || []).length ? Math.max(...state.collections.map(c => c.order || 0)) + 1 : 0;
  const col = { id: newId('col'), name, order, createdAt: Date.now(), items: [] };
  state.collections.push(col);
  try { await saveCollection(col); } catch {}
  closeColCreate();
  renderColDrawer();
}
async function deleteCollection(id) {
  const c = colById(id); if (!c) return;
  if (!(await uiConfirm(T('colDelConfirm', { n: c.name }), { yes: t('dlgDelete'), danger: true }))) return;
  state.collections = state.collections.filter(x => x.id !== id);
  if (activeCol === id) activeCol = null;
  renderColDrawer();
  refreshShelfForCol();                 // полка обновляется сразу (книги возвращаются в реалтайме)
  try { await dbDel('collections', id); } catch {}
}

// ── просмотр коллекции ──
function refreshShelfForCol() {
  document.body.classList.toggle('col-viewing', !!activeCol);
  if (shelfTab === 'audio') renderAudioShelf(); else renderShelf();
}
function colName(id) { const c = colById(id); return c ? c.name : ''; }
function viewCollection(id) {
  exitSelMode();   // выбор (в т.ч. плейсхолдеров каталога) не переживает смену коллекции
  // из каталога выходим молча: коллекция и каталог не смотрятся одновременно
  if (activeCat) { catSeq++; activeCat = null; document.body.classList.remove('cat-viewing'); closeCatFiltersPanel(); }
  activeCol = (activeCol === id) ? null : id;   // повторный тап — снять
  // привязки «запись каталога → книга» лежат в kv: без них каталожные элементы коллекции
  // не отличить от нескачанных — дочитываем и перерисовываем
  if (activeCol && !catStateReady) ensureCatState().then(() => { if (activeCol) refreshShelfForCol(); });
  renderColDrawer();
  refreshShelfForCol();
  closeColDrawer();
}

// ── добавление выбранных книг в коллекции (диалог мультивыбора) ──
function openColPick() {
  if (!selIds.length) return;
  if (!(state.collections || []).length) { showToast(t('colNoneYet')); return; }
  colPickSel = new Set();
  const list = $('#col-pick-list');
  if (list) list.innerHTML = state.collections.map(c =>
    `<button class="col-pick-item" data-pick="${c.id}"><span class="col-pick-check"></span><span class="col-pick-name">${esc(c.name)}</span></button>`
  ).join('');
  const box = $('#col-pick'); if (!box) return;
  clearTimeout(colPickHideT);
  box.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('open')));
}
function closeColPick() {
  const box = $('#col-pick'); if (!box) return;
  box.classList.remove('open');
  clearTimeout(colPickHideT);
  colPickHideT = setTimeout(() => { box.hidden = true; }, 360);
}
// тап мимо окна закрывает — как у «Автопоиска» и «Вставить по ссылке»
$('#col-create')?.addEventListener('click', e => { if (!e.target.closest('.col-modal-box')) closeColCreate(); });
$('#col-pick')?.addEventListener('click', e => { if (!e.target.closest('.col-modal-box')) closeColPick(); });
$('#cat-add')?.addEventListener('click', e => { if (!e.target.closest('.col-modal-box')) closeCatAdd(); });
$('#cat-add-cancel')?.addEventListener('click', closeCatAdd);
$('#cat-add-save')?.addEventListener('click', saveCatServer);

async function applyColPick() {
  if (!colPickSel || !colPickSel.size || !selIds.length) { closeColPick(); return; }
  const ids = selIds.slice();
  const changed = [];
  if (selKind.startsWith('cat')) {
    // записи каталога уходят в коллекцию снимком — даже нескачанные
    const ck = selKind === 'cataudio' ? 'audio' : 'book';
    const srcId = activeCat && activeCat.srcId;
    for (const colId of colPickSel) {
      const c = colById(colId); if (!c) continue;
      c.items = c.items || [];
      for (const key of ids) {
        if (c.items.some(it => it.k === 'cat' && it.id === key)) continue;
        const en = activeCat && (activeCat.entries || []).find(x => x.key === key);
        if (!en) continue;
        c.items.push({ k: 'cat', id: key, ck, src: srcId, e: catEntrySnapshot(en) });
      }
      changed.push(c);
    }
  } else {
    const kind = selKind === 'audio' ? 'audio' : 'book';
    for (const colId of colPickSel) {
      const c = colById(colId); if (!c) continue;
      c.items = c.items || [];
      for (const id of ids) if (!c.items.some(it => it.k === kind && it.id === id)) c.items.push({ k: kind, id });
      changed.push(c);
    }
  }
  closeColPick(); exitSelMode(); renderColDrawer(); refreshShelfForCol();
  showToast(T('colAdded', { n: ids.length }));
  for (const c of changed) { try { await saveCollection(c); } catch {} }   // персист после обновления UI
}

// ── убрать выбранные из ПРОСМАТРИВАЕМОЙ коллекции: книги и записи каталога вперемешку ──
async function removeFromActiveCol() {
  if (!activeCol || !selIds.length) return;
  const c = colById(activeCol); if (!c) return;
  const kind = (selKind === 'audio' || selKind === 'cataudio') ? 'audio' : 'book';
  const ids = selIds.slice(), n = ids.length;
  const noun = uiLang() === 'ru'
    ? (kind === 'audio' ? pluralRu(n, 'аудиокнигу', 'аудиокниги', 'аудиокниг') : pluralRu(n, 'книгу', 'книги', 'книг'))
    : (kind === 'audio' ? 'audiobook' : 'book') + (n === 1 ? '' : 's');
  const msg = uiLang() === 'ru' ? `Убрать ${n} ${noun} из коллекции?` : `Remove ${n} ${noun} from the collection?`;
  if (!(await uiConfirm(msg, { yes: t('colRemoveYes'), no: t('colRemoveNo'), danger: true }))) return;
  // в выборе вперемешку id книг и ключи записей каталога — каждый элемент коллекции
  // проверяем на попадание любым из способов
  c.items = (c.items || []).filter(it => {
    if (it.k === kind && ids.includes(it.id)) return false;
    if (it.k === 'cat' && (it.ck || 'book') === kind
        && (ids.includes(it.id) || ids.includes(catBookIdOf({ key: it.id })))) return false;
    return true;
  });
  exitSelMode(); renderColDrawer(); refreshShelfForCol();   // убранные книги исчезают из коллекции сразу
  showToast(T('colRemoved', { n }));
  try { await saveCollection(c); } catch {}
}

// ── жесты язычка/раздела + перетаскивание коллекций ──
function setupColDrawer() {
  const tab = $('#col-tab'), dr = $('#col-drawer'), sc = $('#col-scrim'), list = $('#col-list');
  if (!tab || !dr || !sc) return;
  let colJustDragged = false;   // подавляет click-view сразу после перетаскивания
  const width = () => dr.getBoundingClientRect().width || 260;
  sc.addEventListener('click', closeColDrawer);
  // язычок: тап — открыть/закрыть, тянуть — следовать за пальцем
  let cs = null;
  tab.addEventListener('pointerdown', e => {
    cs = { x: e.clientX, moved: false, W: width() };
    if (!colDrawerOpen) { renderColDrawer(); dr.hidden = false; sc.hidden = false; }
    dr.style.transition = 'none';
    try { tab.setPointerCapture(e.pointerId); } catch {}
  });
  tab.addEventListener('pointermove', e => {
    if (!cs) return;
    const dx = e.clientX - cs.x;
    if (Math.abs(dx) > 6) cs.moved = true;
    const base = colDrawerOpen ? 0 : -cs.W;
    const tx = Math.max(-cs.W, Math.min(0, base + dx));
    dr.style.transform = 'translateX(' + tx + 'px)';
    tab.style.transition = 'none'; tab.style.left = (cs.W + tx) + 'px';   // язычок держится края раздела
    sc.hidden = false; sc.classList.toggle('open', tx > -cs.W * 0.5);
  });
  tab.addEventListener('pointerup', e => {
    if (!cs) return;
    dr.style.transition = ''; tab.style.transition = ''; tab.style.left = '';   // отдаём управление CSS
    const dx = e.clientX - cs.x, base = colDrawerOpen ? 0 : -cs.W;
    if (!cs.moved) toggleColDrawer();
    else (base + dx > -cs.W * 0.5) ? openColDrawer() : closeColDrawer();
    cs = null;
  });
  tab.addEventListener('pointercancel', () => { cs = null; dr.style.transition = ''; if (!colDrawerOpen) closeColDrawer(); });
  // клики внутри раздела
  dr.addEventListener('click', e => {
    const dlx = e.target.closest('[data-dlcancel]');
    if (dlx) { e.stopPropagation(); dlCancel(dlx.dataset.dlcancel); return; }   // отмена единицы загрузки
    const cdel = e.target.closest('[data-catdel]');
    if (cdel) { e.stopPropagation(); deleteCatServer(cdel.dataset.catdel); return; }   // убрать свой каталог
    if (e.target.closest('#cat-add-btn')) { openCatAdd(); return; }
    const cnode = e.target.closest('[data-catnode]');
    if (cnode) { catOpenNode(cnode.dataset.catnode); return; }   // категория в дереве каталога
    const cat = e.target.closest('[data-cat]');
    if (cat) { viewCatalog(cat.dataset.cat); return; }   // вход в витрину каталога
    const redit = e.target.closest('[data-coledit]');
    if (redit) { e.stopPropagation(); openColCreate(redit.dataset.coledit); return; }   // карандаш — переименовать
    const del = e.target.closest('[data-coldel]');
    if (del) { e.stopPropagation(); deleteCollection(del.dataset.coldel); return; }
    if (e.target.closest('#col-add')) { openColCreate(); return; }
    const item = e.target.closest('.col-item');
    if (item && !colJustDragged) viewCollection(item.dataset.col);   // после перетаскивания view не срабатывает
  });
  // перетаскивание коллекций за «ручку» (реордер)
  if (list) {
    // Реордер по УДЕРЖАНИЮ на ЛЮБОЙ части элемента (~0.35с). Движение до срабатывания удержания =
    // скролл списка (короткий свайп листает). Во время перетаскивания соседи плавно раздвигаются,
    // открывая щель, а скролл гасится (touch-action:none + touchmove preventDefault).
    // DOM переставляем один раз на отпускании — оттого не спотыкается.
    let drag = null, lp = null;
    const LP_MS = 350, MOVE_CANCEL = 12;
    const beginDrag = (item, y, pid) => {
      const items = [...list.querySelectorAll('.col-item')];
      const from = items.indexOf(item);
      const rects = items.map(el => el.getBoundingClientRect());
      const rowH = rects.length > 1 ? Math.abs(rects[1].top - rects[0].top) : (item.offsetHeight + 8);
      drag = { item, items, from, to: from, rects, rowH, h: item.offsetHeight, y0: y };
      item.classList.add('dragging');
      for (const el of items) el.style.transition = 'transform .16s ease';
      item.style.transition = 'none';
      list.style.touchAction = 'none';
      try { list.setPointerCapture(pid); } catch {}
    };
    list.addEventListener('pointerdown', e => {
      if (drag || lp) return;
      const item = e.target.closest('.col-item');
      if (!item || e.target.closest('[data-coldel], [data-coledit]')) return;   // ✕ и карандаш — не перетаскивание
      lp = { item, x: e.clientX, y: e.clientY, pid: e.pointerId };
      lp.timer = setTimeout(() => { if (lp) { const it = lp.item, y = lp.y, pid = lp.pid; lp = null; beginDrag(it, y, pid); } }, LP_MS);
    });
    list.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });   // скролл при перетаскивании выключен
    list.addEventListener('pointermove', e => {
      if (lp) { if (Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > MOVE_CANCEL) { clearTimeout(lp.timer); lp = null; } return; }
      if (!drag) return;
      const dy = e.clientY - drag.y0;
      drag.item.style.transform = 'translateY(' + dy + 'px)';
      const slot0C = drag.rects[0].top + drag.h / 2;
      const cur = drag.rects[drag.from].top + drag.h / 2 + dy;
      let to = Math.round((cur - slot0C) / drag.rowH);
      to = Math.max(0, Math.min(drag.items.length - 1, to));
      if (to === drag.to) return;
      drag.to = to;
      drag.items.forEach((el, i) => {
        if (i === drag.from) return;
        let s = 0;
        if (drag.from < to && i > drag.from && i <= to) s = -drag.rowH;        // едут вверх, освобождая место
        else if (drag.from > to && i >= to && i < drag.from) s = drag.rowH;    // едут вниз
        el.style.transform = s ? 'translateY(' + s + 'px)' : '';
      });
    });
    const dropEnd = () => {
      if (lp) { clearTimeout(lp.timer); lp = null; }
      if (!drag) return;
      const { item, items, from, to } = drag;
      for (const el of items) { el.style.transition = ''; if (el !== item) el.style.transform = ''; }
      item.classList.remove('dragging'); item.style.transform = ''; item.style.transition = '';
      list.style.touchAction = '';
      if (to !== from) {                     // применяем новый порядок в DOM
        const arr = items.filter(el => el !== item);
        arr.splice(to, 0, item);
        arr.forEach(el => list.appendChild(el));
      }
      [...list.querySelectorAll('.col-item')].forEach((el, i) => {
        const c = colById(el.dataset.col);
        if (c && c.order !== i) { c.order = i; saveCollection(c); }
      });
      (state.collections || []).sort((a, b) => (a.order || 0) - (b.order || 0));
      colJustDragged = true; setTimeout(() => { colJustDragged = false; }, 80);
      drag = null;
    };
    list.addEventListener('pointerup', dropEnd);
    list.addEventListener('pointercancel', dropEnd);
  }
}

// ══════════════════ каталог книг (витрины в шкафу) ══════════════════
// Каталог — «удалённая коллекция»: записи OPDS-фида рисуются той же полочной сеткой.
// На карточке каталога слева внизу стрелка «скачать»; скачанная получает галочку и
// живёт в общей библиотеке как обычная книга. Привязка «запись каталога → книга»
// хранится в kv ('cat:<ключ записи>' → id книги) и переживает перезапуск.
// Разбор фидов — в ленивом модуле catalog.js, здесь только состояние и интерфейс.
async function catalogMod() {
  if (!window.Catalog) await loadLazyScript('catalog.js?v=4');
  return window.Catalog;
}

// иконки витрин: пресеты несут свою, свои серверы получают «книжную полку»
const CAT_ICONS = {
  globe: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z"/><path d="M3.5 9h17M3.5 15h17M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  server: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  feather: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.2 3.8a5.6 5.6 0 0 0-7.9 0L5 11.1V19h7.9l7.3-7.3a5.6 5.6 0 0 0 0-7.9z"/><path d="M16 8 3 21"/><path d="M17.5 15H10"/></svg>',
  phones: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="3" y="13" width="4.5" height="7" rx="2"/><rect x="16.5" y="13" width="4.5" height="7" rx="2"/></svg>',
};

// витрины-пресеты; свои серверы пользователя добавляются к ним из kv 'catServers'.
// listUrl — «все книги сразу»: витрина открывает единый поток без подпапок
// (дальше листается прокруткой); дерево разделов остаётся только своим серверам,
// у которых структуру диктует сам сервер.
// adapter — источник не OPDS: 'ws' (Викитека, русская классика) и 'lv' (LibriVox,
// аудиокниги); kind: 'audio' живёт на вкладке аудиокниг, скачивание = стрим-аудиокнига.
const CAT_PRESETS = [{
  id: 'classics',
  nameKey: 'catClassics',
  icon: 'feather',
  adapter: 'ws',
}, {
  id: 'librivox',
  nameKey: 'catAudio',
  icon: 'phones',
  adapter: 'lv',
  kind: 'audio',
}, {
  id: 'gutenberg',
  nameKey: 'catWorld',
  icon: 'globe',
  url: 'https://www.gutenberg.org/ebooks.opds/',
  listUrl: 'https://www.gutenberg.org/ebooks/search.opds/?sort_order=downloads',
  cfg: {
    searchTpl: 'https://www.gutenberg.org/ebooks/search.opds/?query={searchTerms}',
    // в списках Gutenberg книга — subsection-ссылка на её мини-фид; настоящая обложка
    // лежит по предсказуемому адресу, а data:-миниатюры из фида — крошки 22×22
    bookNavRe: /\/ebooks\/(\d+)\.opds$/,
    coverOf: id => `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,
    // у части книг мини-фид вовсе без ссылок на файлы (проверено на «Детстве», №19681) —
    // файлы при этом лежат по стандартному шаблону; пробуем варианты по очереди
    acqFallback: id => [
      `https://www.gutenberg.org/ebooks/${id}.epub3.images`,
      `https://www.gutenberg.org/ebooks/${id}.epub.images`,
      `https://www.gutenberg.org/ebooks/${id}.epub.noimages`,
    ],
  },
}];

// activeCat: { srcId, name, cfg, auth, rootUrl, tree, entries, next, curUrl, curTitle, … }
// tree — дерево категорий, живёт в секции «Каталог» шкафа (раскрывается на месте, как список);
// entries — книги ВЫБРАННОЙ категории, их рисует полочная сетка. null = категория ещё не выбрана.
let activeCat = null;
let catServers = [];         // свои OPDS-серверы: { id, name, url, user, pass }
// фильтры каталога — тот же набор, что у полки, плюс «скачано/не скачано»
const catFilters = { q: '', status: new Set(), author: '', dl: '' };
const catSort = { on: false };   // сортировка каталога: только алфавит; выкл = порядок источника
const catDlKeys = new Map();            // ключ записи каталога → id книги в библиотеке
const catBusyKeys = new Set();          // записи, которые прямо сейчас качаются
let catStateReady = false;
let catSeq = 0;              // защита от гонок: пришёл ответ старой навигации — выбрасываем
let catMoreObs = null;       // IntersectionObserver дозагрузки следующей страницы

async function ensureCatState() {
  if (catStateReady) return;
  catStateReady = true;
  try { catServers = (await kvGet('catServers')) || []; } catch { catServers = []; }
  try { for (const [k, v] of await kvRange('cat:')) catDlKeys.set(k, v); } catch {}
}

function catSrcById(id) {
  const p = CAT_PRESETS.find(x => x.id === id);
  if (p) return { id: p.id, name: t(p.nameKey), url: p.url || '', listUrl: p.listUrl || '',
                  adapter: p.adapter || '', kind: p.kind || 'book', cfg: p.cfg, auth: '' };
  const s = catServers.find(x => x.id === id);
  if (!s) return null;
  return { id: s.id, name: s.name, url: s.url, cfg: null,
           auth: s.user ? window.Catalog?.basicAuth?.(s.user, s.pass) || catBasicAuth(s.user, s.pass) : '' };
}
// та же кодировка Basic, что в catalog.js — на случай, когда модуль ещё не загружен
function catBasicAuth(user, pass) {
  try { return 'Basic ' + btoa(unescape(encodeURIComponent(user + ':' + (pass || '')))); } catch { return ''; }
}

// скачана ли запись: привязка есть И книга/аудиокнига ещё в библиотеке (после
// удаления привязка не мешает — стрелка возвращается сама)
function catBookIdOf(entry) {
  const id = catDlKeys.get(entry.key);
  if (!id) return null;
  if (state.books.some(b => b.id === id)) return id;
  if ((state.audiobooks || []).some(a => a.id === id)) return id;
  return null;
}

// бейдж записи каталога: галочка (скачана) / спиннер (качается) / стрелка (скачать).
// dlAttr — data-атрибут стрелки: обработчик клика у сетки каталога и у коллекции свой.
// Стрелка — именно <span>, НЕ <button>: бейдж живёт внутри кнопки-обложки, а вложенный
// <button> запрещён в HTML — парсер разрывает обложку, и бейдж вываливается из неё
// (стрелка оказывалась под телом книги). Клик по span ловится делегированием так же.
function catBadgeHtml(key, dlId, dlAttr) {
  if (dlId) return `<span class="cat-badge done" title="${esc(t('catDoneT'))}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg></span>`;
  if (catBusyKeys.has(key)) return `<span class="cat-badge busy" aria-hidden="true"><span class="cat-spin"></span></span>`;
  return `<span class="cat-badge cat-dl" ${dlAttr} role="button" title="${esc(t('catDlT'))}" aria-label="${esc(t('catDlT'))}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="m6.5 11.5 5.5 5.5 5.5-5.5"/><path d="M5 20h14"/></svg></span>`;
}

// ── секция «Каталог» в шкафу: витрины + раскрывающееся дерево категорий ──
// Строки — точно те же .col-item, что у коллекций. Категории активной витрины
// разворачиваются под ней со сдвигом; тап по категории показывает её книги в сетке.
function renderCatSection() {
  const list = $('#cat-list');
  if (!list) return;
  const rows = [];
  const chev = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
  const pushNode = (node, path) => {
    rows.push(`<div class="col-item cat-node${activeCat.curUrl === node.url ? ' active' : ''}" data-catnode="${path}" style="--cd:${node.depth}">`
      + `<span class="cat-tw${node.expanded ? ' open' : ''}" aria-hidden="true">${node.loading ? '<span class="cat-spin"></span>' : chev}</span>`
      + `<span class="col-item-name">${esc(node.title)}</span></div>`);
    if (node.expanded) node.kids.forEach((k, i) => pushNode(k, path + '/' + i));
  };
  const pushSrc = (id, name, icon, del) => {
    const on = activeCat && activeCat.srcId === id;
    rows.push(`<div class="col-item${on ? ' active' : ''}" data-cat="${esc(id)}">`
      + `<span class="cat-ic" aria-hidden="true">${CAT_ICONS[icon] || CAT_ICONS.server}</span>`
      + `<span class="col-item-name">${esc(name)}</span>`
      + (del ? `<button class="col-item-del" data-catdel="${esc(id)}" aria-label="${esc(t('colDelete'))}">✕</button>` : '')
      + `</div>`);
    if (on) activeCat.tree.forEach((n, i) => pushNode(n, String(i)));
  };
  for (const p of CAT_PRESETS) pushSrc(p.id, t(p.nameKey), p.icon, false);
  for (const s of catServers) pushSrc(s.id, s.name, 'server', true);
  list.innerHTML = rows.join('');
}
// узел дерева по пути «0/2/1»
function catNodeByPath(path) {
  let kids = activeCat ? activeCat.tree : [], node = null;
  for (const i of String(path).split('/')) { node = kids[+i]; if (!node) return null; kids = node.kids; }
  return node;
}
const catNavNode = (e, depth) => ({ title: e.title, url: e.href, depth, kids: [], expanded: false, loaded: false, loading: false, books: 0 });

// ── просмотр: вход и выход (повторный тап по витрине — выход, как у коллекций) ──
function viewCatalog(id) {
  if (activeCat && activeCat.srcId === id) { exitCatalog(); return; }
  const src = catSrcById(id);
  if (!src) return;
  exitSelMode();
  if (activeCol) { activeCol = null; document.body.classList.remove('col-viewing'); }
  catFilters.q = ''; catFilters.author = ''; catFilters.dl = ''; catFilters.status.clear();
  catSort.on = false;
  activeCat = { srcId: src.id, name: src.name, cfg: src.cfg, auth: src.auth, rootUrl: src.url,
                adapter: src.adapter, kind: src.kind || 'book',
                tree: [], entries: null, next: '', curUrl: '', curTitle: '',
                searchTpl: (src.cfg && src.cfg.searchTpl) || (src.adapter ? 'adapter' : ''),
                searchQ: '', lastUrl: '', lastReq: null,
                rootLoading: !src.listUrl && !src.adapter, loading: false, error: false };
  document.body.classList.add('cat-viewing');
  closeCatFiltersPanel();
  // аудио-витрина живёт на вкладке аудиокниг, книжные — на вкладке книг
  if (activeCat.kind === 'audio') { if (shelfTab !== 'audio') setShelfTab('audio'); }
  else if (shelfTab !== 'books') setShelfTab('books');
  renderColDrawer();
  if (src.adapter) {   // адаптер: единый поток без подпапок
    closeColDrawer();
    if (activeCat.kind === 'audio') renderShelf();   // книжная вкладка сразу получает заглушку
    ensureCatState().then(() => catAdapterShow(null));
    return;
  }
  if (src.listUrl) {   // витрина «все книги сразу»: единый поток, шкаф закрываем
    closeColDrawer();
    ensureCatState().then(() => catShowList(src.listUrl, src.name));
    return;
  }
  renderShelf();
  catLoadRoot();
}
// рендер каталога по типу: книги — в полочную сетку, аудио — на вкладку аудиокниг
function catRender() {
  if (!activeCat) return;
  if (activeCat.kind === 'audio') renderCatAudioShelf(); else renderCatShelf();
}
// адаптерные источники: поток (req = null) либо поиск (req = {q}); токен страницы — в next
async function catAdapterShow(req) {
  if (selMode && selKind.startsWith('cat')) exitSelMode();   // сменили раздел/поиск — выбор устарел
  const cat = activeCat, my = ++catSeq;
  cat.lastReq = req;
  cat.loading = true; cat.error = false;
  catRender();
  try {
    const Cat = await catalogMod();
    const r = await catAdapterPage(Cat, cat, req, '');
    if (activeCat !== cat || catSeq !== my) return;
    cat.loading = false;
    cat.entries = r.entries; cat.next = r.next;
    if (!req) { cat.curUrl = 'stream'; cat.curTitle = cat.name; }
  } catch {
    if (activeCat !== cat || catSeq !== my) return;
    cat.loading = false; cat.error = true;
  }
  catRender();
}
function catAdapterPage(Cat, cat, req, token) {
  if (cat.adapter === 'ws') return req && req.q ? Cat.wsSearch(req.q, token) : Cat.wsList(token);
  if (cat.adapter === 'lv') return req && req.q ? Cat.lvSearch(req.q) : Cat.lvList(token);
  throw new Error('unknown adapter');
}
function exitCatalog() {
  if (!activeCat) return;
  exitSelMode();   // выбранные записи каталога вне каталога не имеют смысла
  catSeq++;
  activeCat = null;
  document.body.classList.remove('cat-viewing');
  closeCatFiltersPanel();
  renderColDrawer();
  renderShelf();
  if (shelfTab === 'audio') renderAudioShelf();   // вкладка аудио тоже возвращается к своему
}
// открытая панель фильтров при входе/выходе из каталога закрывается — у них разное наполнение
function closeCatFiltersPanel() {
  const btn = $('#filter-btn');
  if (btn && btn.classList.contains('active')) {
    btn.classList.remove('active');
    for (const id of ['shelf-filters', 'audio-filters']) {
      const p = $('#' + id); if (p) { p.classList.remove('open'); p.hidden = true; }
    }
  }
}

// корень витрины: категории → в дерево шкафа; книги корня (если есть) → сразу в сетку.
// Пока книг нет — шкаф остаётся открытым, человек выбирает категорию.
async function catLoadRoot() {
  const cat = activeCat, my = ++catSeq;
  try {
    await ensureCatState();
    const Cat = await catalogMod();
    const feed = await Cat.fetchFeed(cat.rootUrl, { auth: cat.auth, cfg: cat.cfg });
    if (activeCat !== cat || catSeq !== my) return;
    cat.rootLoading = false;
    cat.tree = feed.entries.filter(e => e.kind === 'nav').map(e => catNavNode(e, 0));
    if (!cat.searchTpl) {
      Cat.searchTemplate(feed, { auth: cat.auth, cfg: cat.cfg })
        .then(tpl => { if (activeCat === cat && tpl) cat.searchTpl = tpl; });
    }
    const books = feed.entries.filter(e => e.kind === 'book');
    if (books.length) {
      cat.entries = books; cat.next = feed.next;
      cat.curUrl = cat.rootUrl; cat.curTitle = feed.title || cat.name;
      closeColDrawer();
    }
    // свой сервер получает имя из фида
    const srv = catServers.find(s => s.id === cat.srcId);
    if (srv && feed.title && srv.name !== feed.title) {
      srv.name = feed.title; cat.name = feed.title;
      kvSet('catServers', catServers);
    }
  } catch {
    if (activeCat !== cat || catSeq !== my) return;
    cat.rootLoading = false; cat.error = true;
  }
  renderColDrawer();
  renderShelf();
}

// тап по категории в шкафу: развёрнутую — свернуть; иначе грузим её фид,
// подкатегории раскрываются на месте, книги уезжают в сетку (и шкаф закрывается)
async function catOpenNode(path) {
  if (!activeCat) return;
  const cat = activeCat, node = catNodeByPath(path);
  if (!node || node.loading) return;
  if (node.expanded) { node.expanded = false; renderCatSection(); return; }
  if (node.loaded) {   // уже ходили: из кэша дерева, за книгами — свежий запрос
    if (node.kids.length) { node.expanded = true; renderCatSection(); }
    if (node.books) { catShowList(node.url, node.title); closeColDrawer(); }
    else if (!node.kids.length) showToast(t('catEmptySec'));
    return;
  }
  node.loading = true; renderCatSection();
  try {
    const Cat = await catalogMod();
    const feed = await Cat.fetchFeed(node.url, { auth: cat.auth, cfg: cat.cfg });
    if (activeCat !== cat) return;
    node.loading = false; node.loaded = true;
    node.kids = feed.entries.filter(e => e.kind === 'nav').map(e => catNavNode(e, node.depth + 1));
    const books = feed.entries.filter(e => e.kind === 'book');
    node.books = books.length;
    if (node.kids.length) node.expanded = true;
    if (books.length) {
      cat.entries = books; cat.next = feed.next;
      cat.curUrl = node.url; cat.curTitle = node.title;
      cat.searchQ = ''; cat.loading = false; cat.error = false;
      closeColDrawer();
      renderShelf();
    } else if (!node.kids.length) showToast(t('catEmptySec'));
    renderCatSection();
  } catch {
    if (activeCat !== cat) return;
    node.loading = false;
    renderCatSection();
    showToast(t('catSecFail'));
  }
}

// список книг в сетку по адресу (выбор категории повторно, поиск, повтор после ошибки)
async function catShowList(url, title) {
  if (selMode && selKind.startsWith('cat')) exitSelMode();   // сменили раздел — выбор устарел
  const cat = activeCat, my = ++catSeq;
  cat.lastUrl = url;
  cat.loading = true; cat.error = false;
  renderCatShelf();
  try {
    const Cat = await catalogMod();
    const feed = await Cat.fetchFeed(url, { auth: cat.auth, cfg: cat.cfg });
    if (activeCat !== cat || catSeq !== my) return;
    cat.loading = false;
    cat.entries = feed.entries.filter(e => e.kind === 'book');
    cat.next = feed.next;
    if (title !== undefined) { cat.curUrl = url; cat.curTitle = title; }
  } catch {
    if (activeCat !== cat || catSeq !== my) return;
    cat.loading = false; cat.error = true;
  }
  renderCatShelf();
}
function catRetry() {
  if (!activeCat) return;
  if (activeCat.adapter) { catAdapterShow(activeCat.lastReq); return; }
  if (activeCat.lastUrl) { catShowList(activeCat.lastUrl); return; }
  activeCat.error = false; activeCat.rootLoading = true;
  renderShelf();
  catLoadRoot();
}
async function catMore() {
  if (!activeCat || !activeCat.next || activeCat.loading) return;
  const cat = activeCat, my = catSeq, token = cat.next;
  cat.next = '';   // чтобы дозагрузка не дёргалась повторно, пока грузим
  try {
    const Cat = await catalogMod();
    let entries, next;
    if (cat.adapter) {
      const r = await catAdapterPage(Cat, cat, cat.lastReq, token);
      entries = r.entries; next = r.next;
    } else {
      const feed = await Cat.fetchFeed(token, { auth: cat.auth, cfg: cat.cfg });
      entries = feed.entries.filter(e => e.kind !== 'nav'); next = feed.next;
    }
    if (activeCat !== cat || catSeq !== my) return;
    // страницы «популярного» могут пересекаться — дубли отбрасываем по ключу
    const seen = new Set(cat.entries.map(e => e.key));
    cat.entries.push(...entries.filter(e => !seen.has(e.key)));
    cat.next = next;
    catRender();
  } catch { if (activeCat === cat && catSeq === my) cat.next = token; }
}

// ── рендер каталога той же полочной сеткой: только книги, категории живут в шкафу ──
async function renderCatShelf() {
  const grid = $('#shelf-grid');
  if (!grid || !activeCat) return;
  if (catFilters.status.size) await refreshBookPcts();   // статус скачанных — по свежему прогрессу
  // от библиотечного рендера остаются «Продолжить чтение», статистика и подвал — прячем
  $('#shelf-continue').innerHTML = '';
  $('#shelf-stats').innerHTML = '';
  $('#shelf-footer').innerHTML = '';
  if (catMoreObs) { catMoreObs.disconnect(); catMoreObs = null; }

  if (activeCat.kind === 'audio') {   // аудио-каталог: книг тут нет, всё на вкладке аудио
    grid.innerHTML = `<div class="cat-note">${esc(t('catNoBooks'))}</div>`;
    return;
  }
  if (activeCat.error) {
    grid.innerHTML = `<div class="cat-note cat-err" data-catretry>${esc(t('catFail'))}</div>`;
    return;
  }
  if (activeCat.rootLoading || activeCat.loading) {
    grid.innerHTML = `<div class="cat-note"><span class="cat-spin"></span>${esc(t('catLoading'))}</div>`;
    return;
  }
  if (activeCat.entries === null) {   // категория ещё не выбрана — подсказка вместо пустоты
    grid.innerHTML = `<div class="cat-note">${esc(t('catPickSec'))}</div>`;
    return;
  }

  const f = catFilters;
  const q = f.q.toLowerCase();
  const list = activeCat.entries.filter(en => {
    const id = catBookIdOf(en);
    if (f.dl && (f.dl === 'yes') !== !!id) return false;
    if (f.author && (en.author || '') !== f.author) return false;
    if (q && !((en.title || '').toLowerCase().includes(q) || (en.author || '').toLowerCase().includes(q))) return false;
    // статус: у скачанных — настоящий, нескачанная книга по смыслу «не прочитано»
    if (f.status.size && !f.status.has(id ? bookStatus(id) : 'new')) return false;
    return true;
  });
  if (catSort.on) list.sort((a, b) =>
    String(a.title).localeCompare(String(b.title), undefined, { numeric: true, sensitivity: 'base' }));

  const cards = list.map(en => {
    const i = activeCat.entries.indexOf(en);
    const dlId = catBookIdOf(en);
    // скачивание живёт ТОЛЬКО на стрелке (data-catdl); тап по телу — открыть скачанную
    const badge = catBadgeHtml(en.key, dlId, `data-catdl="${i}"`);
    const face = `<span class="cover-blank" style="--h:${hueOf(en.title)}"><span>${esc(en.title)}</span></span>`
      + (en.cover ? `<img class="cover-img cat-cimg" src="${esc(en.cover)}" alt="" loading="lazy" onerror="this.remove()">` : '');
    return `<div class="book-card cat-card" data-catbook="${i}" data-catkey="${esc(en.key)}">
      <button class="cover">${face}${badge}<span class="sel-check" aria-hidden="true"></span></button>
      <div class="book-meta">
        <div class="book-title"><span class="marq">${esc(en.title)}</span></div>
        ${en.author ? `<div class="book-author">${esc(en.author)}</div>` : ''}
      </div>
      ${dlId ? `<button class="book-del" data-del="${dlId}" title="${t('deleteT')}" aria-label="${t('deleteT')}">✕</button>` : ''}
    </div>`;
  }).join('');

  const tail = activeCat.next
    ? `<div class="cat-note cat-more" data-catmore><span class="cat-spin"></span>${esc(t('catMoreLoad'))}</div>`
    : (!cards ? `<div class="cat-note">${esc(t(filtersCatActive() ? 'filterNone' : 'catEmptySec'))}</div>` : '');
  grid.innerHTML = cards + tail;
  cardMarquee(grid);
  if (selMode && selKind === 'catbooks') refreshSelChecks();   // перерисовка не сбрасывает выбор

  // следующая страница подтягивается сама, когда прокрутка доезжает до хвоста
  const s = grid.querySelector('[data-catmore]');
  if (s) {
    catMoreObs = new IntersectionObserver(es => {
      if (es.some(x => x.isIntersecting)) catMore();
    }, { rootMargin: '600px' });
    catMoreObs.observe(s);
  }
}
function filtersCatActive() {
  const f = catFilters;
  return !!(f.q || f.author || f.dl || f.status.size);
}

// ── аудио-каталог (LibriVox): карточки аудиокниг на вкладке аудио ──
function renderCatAudioShelf() {
  const box = $('#audio-content');
  if (!box || !activeCat) return;
  $('#audio-continue').innerHTML = '';
  const foot = $('#audio-footer'); if (foot) foot.innerHTML = '';
  if (catMoreObs) { catMoreObs.disconnect(); catMoreObs = null; }

  if (activeCat.error) {
    box.innerHTML = `<div class="cat-note cat-err" data-catretry>${esc(t('catFail'))}</div>`;
    return;
  }
  if (activeCat.loading || activeCat.entries === null) {
    box.innerHTML = `<div class="cat-note"><span class="cat-spin"></span>${esc(t('catLoading'))}</div>`;
    return;
  }

  const f = catFilters;
  const q = f.q.toLowerCase();
  const list = activeCat.entries.filter(en => {
    const id = catBookIdOf(en);
    if (f.dl && (f.dl === 'yes') !== !!id) return false;
    if (f.author && (en.author || '') !== f.author) return false;
    if (q && !((en.title || '').toLowerCase().includes(q) || (en.author || '').toLowerCase().includes(q))) return false;
    return true;
  });
  if (catSort.on) list.sort((a, b) =>
    String(a.title).localeCompare(String(b.title), undefined, { numeric: true, sensitivity: 'base' }));

  const cards = list.map(en => {
    const i = activeCat.entries.indexOf(en);
    const dlId = catBookIdOf(en);
    const badge = catBadgeHtml(en.key, dlId, `data-catdl="${i}"`);
    const meta = [en.time, en.sections ? T('abTracksN', { n: en.sections }) : ''].filter(Boolean).join(' · ');
    return `<div class="ab-card cat-card" data-catab="${i}" data-catkey="${esc(en.key)}">
      <button class="ab-card-cover"><span>♪</span>${badge}<span class="sel-check" aria-hidden="true"></span></button>
      <div class="ab-card-title"><span class="marq">${esc(en.title)}</span></div>
      <div class="ab-card-author">${esc(en.author || '')}${meta ? `<br>${esc(meta)}` : ''}</div>
      ${dlId ? `<button class="ab-del" data-abdel="${esc(dlId)}" title="${t('deleteT')}" aria-label="${t('deleteT')}">✕</button>` : ''}
    </div>`;
  }).join('');

  const tail = activeCat.next
    ? `<div class="cat-note cat-more" data-catmore><span class="cat-spin"></span>${esc(t('catMoreLoad'))}</div>`
    : (!cards ? `<div class="cat-note">${esc(t(filtersCatActive() ? 'filterNone' : 'catEmptySec'))}</div>` : '');
  box.innerHTML = `<div class="ab-grid">${cards}</div>${tail}`;
  cardMarquee(box);
  if (selMode && selKind === 'cataudio') refreshSelChecks();   // перерисовка не сбрасывает выбор

  const s = box.querySelector('[data-catmore]');
  if (s) {
    catMoreObs = new IntersectionObserver(es => {
      if (es.some(x => x.isIntersecting)) catMore();
    }, { rootMargin: '600px' });
    catMoreObs.observe(s);
  }
}

// перерисовать то место, откуда стартовало скачивание: сетку каталога либо коллекцию
function catDlRender() {
  if (activeCat) catRender();
  else if (activeCol) refreshShelfForCol();
}
// «скачивание» аудио из каталога = стрим-аудиокнига: треки из подкаст-RSS уходят
// в существующий движок (url-треки), обложка — из того же RSS
function catDownloadAudio(entry) {
  if (catBusyKeys.has(entry.key) || catBookIdOf(entry)) return;
  if (!netOnline) { probeNet(); showToast(t('urlNoNet')); return; }
  catBusyKeys.add(entry.key);
  const job = dlAdd('audio', entry.title);
  catDlRender();
  catChain = catChain
    .then(() => catFetchAudioImport(entry, job))
    .catch(e => {
      dlRemove(job);
      if (!(job.cancelled || (e && e.name === 'AbortError')))
        showToast(T('urlFail', { e: (e && e.message) || t('urlBlocked') }));
    })
    .finally(() => {
      catBusyKeys.delete(entry.key);
      dlRemove(job);
      catDlRender();
    });
}
async function catFetchAudioImport(entry, job) {
  if (job.cancelled) return;
  job.status = 'active'; renderDlList();
  const Cat = await catalogMod();
  const got = await Cat.lvTracks(entry.rss);
  if (!got.tracks.length) throw new Error(t('urlNoAudio'));
  if (job.cancelled) return;
  const rec = await addStreamAudiobook(got.tracks, entry.title);
  rec.author = entry.author || '';
  if (got.cover) {   // обложка не критична: не пришла — остаётся ♪
    try {
      const c = (isNative && capHttp) ? await dlNative(got.cover) : await dlWeb(got.cover);
      if (c.blob && c.blob.size) rec.cover = c.blob;
    } catch {}
  }
  try { await dbPut('audiobooks', rec); } catch {}
  if (typeof loadAudiobooks === 'function') await loadAudiobooks();
  catDlKeys.set(entry.key, rec.id);
  try { await kvSet('cat:' + entry.key, rec.id); } catch {}
}

// ── скачивание записи каталога: та же труба, что «по ссылке», плюс привязка ──
let catChain = Promise.resolve();   // тапы по нескольким книгам выстраиваются в очередь
// extCtx — источник для закачки ИЗ КОЛЛЕКЦИИ (каталог при этом закрыт): {cfg, auth}
function catDownload(entry, extCtx) {
  if (catBusyKeys.has(entry.key) || catBookIdOf(entry)) return;
  if (!netOnline) { probeNet(); showToast(t('urlNoNet')); return; }
  catBusyKeys.add(entry.key);
  const job = dlAdd('book', entry.title);
  // снимок источника: закачка доживёт до конца, даже если из каталога уже вышли
  const ctx = extCtx || { cfg: activeCat && activeCat.cfg, auth: (activeCat && activeCat.auth) || '' };
  catDlRender();
  catChain = catChain
    .then(() => catFetchImport(entry, job, ctx))
    .catch(e => {
      dlRemove(job);
      if (!(job.cancelled || (e && e.name === 'AbortError')))
        showToast(T('urlFail', { e: (e && e.message) || t('urlBlocked') }));
    })
    .finally(() => {
      catBusyKeys.delete(entry.key);
      dlRemove(job);
      catDlRender();
    });
}
async function catFetchImport(entry, job, ctx) {
  if (job.cancelled) return;
  job.status = 'active'; renderDlList();
  const Cat = await catalogMod();
  // кандидаты на скачивание: прямая ссылка, файл из мини-фида книги, запасной шаблон
  const candidates = [];
  if (entry.acq && entry.acq.url) candidates.push(entry.acq.url);
  else if (entry.resolve) {
    try {   // стиль Gutenberg: файлы лежат в мини-фиде книги
      const real = await Cat.resolveBook(entry, { auth: ctx.auth });
      if (real.acq && real.acq.url) candidates.push(real.acq.url);
    } catch {}
    const m = ctx.cfg && ctx.cfg.bookNavRe && ctx.cfg.acqFallback && ctx.cfg.bookNavRe.exec(entry.resolve);
    if (m) for (const u of ctx.cfg.acqFallback(m[1])) if (!candidates.includes(u)) candidates.push(u);
  }
  if (!candidates.length) throw new Error(t('catFmtNone'));
  if (job.cancelled) return;
  const ctrl = new AbortController(); job.abort = () => ctrl.abort();
  const headers = {};
  if (ctx.auth) headers['Authorization'] = ctx.auth;
  // Викитека: браузерный UA упирается в их анти-скрапер-щит — представляемся собой
  // (в вебе UA не переопределить, там источник честно не сработает; телефон — сработает)
  // формат по политике User-Agent Викимедии: имя/версия + контакт
  if (entry.plainUa) headers['User-Agent'] = 'AD.Talewyn/' + APP_VERSION + ' (https://github.com/Archidexter/talewyn; book reader)';
  let got = null, lastErr = null;
  for (const url of candidates) {
    if (job.cancelled) return;
    try {
      got = (isNative && capHttp)
        ? await dlNative(url, '', headers)
        : await dlWeb(url, frac => { job.frac = frac; renderDlList(); }, ctrl.signal,
                      Object.keys(headers).length ? headers : undefined);
      if (got.blob.size) {
        // вместо книги пришла веб-страница (заглушка/защита) — это не книга
        const head = await got.blob.slice(0, 300).text();
        if (/<!doctype html|<html[\s>]/i.test(head)) { got = null; lastErr = new Error(t('urlBlocked')); continue; }
        break;
      }
      got = null; lastErr = new Error(t('urlEmpty'));
    } catch (e) { lastErr = e; if (e && e.name === 'AbortError') throw e; }
  }
  if (job.cancelled) return;
  if (!got) throw (lastErr || new Error(t('catFmtNone')));
  const name = fileNameFrom(got.url, got.headers);
  const f = new File([got.blob], name, { type: got.blob.type || 'application/octet-stream' });
  // единица закачки уходит — дальше книгу ведёт собственная единица импорта
  dlRemove(job);
  // doImport занят другим импортом — дожидаемся своей очереди, не теряя файл
  while (importBusy) await new Promise(r => setTimeout(r, 250));
  const before = new Set(state.books.map(b => b.id));
  await doImport([f]);
  // привязка: новая книга; при «уже в библиотеке» — совпадение по названию+автору
  let book = state.books.find(b => !before.has(b.id));
  if (!book) book = state.books.find(b => bookKey(b) === bookKey({ title: entry.title, author: entry.author }));
  if (book) {
    catDlKeys.set(entry.key, book.id);
    try { await kvSet('cat:' + entry.key, book.id); } catch {}
  }
}

// ── мультивыбор: «скачать всё» одной кнопкой — везде, где что-то можно скачать ──
// Три случая под одной кнопкой: запись каталога (из витрины или из коллекции) и
// стрим-аудиокнига, которой нужно забрать треки на устройство. Неподходящее пропускаем.
function downloadSelected() {
  if (!selMode || !selIds.length) return;
  const keys = selIds.filter(selCanDownload);
  if (!keys.length) return;   // качать нечего — выбор не трогаем
  const cat = activeCat, col = activeCol;
  const jobs = keys.map(k => ({ k, rec: selRecOf(k) }));
  exitSelMode();
  for (const { k, rec } of jobs) {
    if (rec && rec.stream) { abDownloadTracks(rec); continue; }   // треки стрим-аудиокниги — офлайн
    if (cat) {
      const en = (cat.entries || []).find(x => x.key === k);
      if (!en) continue;
      if (cat.kind === 'audio') catDownloadAudio(en); else catDownload(en);   // очередь и дедуп уже внутри
    } else if (col) colCatDownload(k);
  }
}

// ── книги каталога в своих коллекциях: живут там и НЕскачанными ──
// Элемент коллекции: { k:'cat', id:<ключ записи>, ck:'book'|'audio', src:<id витрины>,
// e:<снимок записи — всё, что нужно для карточки и докачки> }
function catEntrySnapshot(en) {
  const o = {};
  for (const k of ['title', 'author', 'cover', 'acq', 'resolve', 'plainUa', 'rss', 'time', 'sections'])
    if (en[k] != null) o[k] = en[k];
  return JSON.parse(JSON.stringify(o));
}
function colCatItems(ck) {
  const c = activeCol ? colById(activeCol) : null;
  return c ? (c.items || []).filter(it => it.k === 'cat' && (it.ck || 'book') === ck) : [];
}
// содержимое просматриваемой коллекции ЕДИНЫМ списком в порядке её элементов:
// { b, colcat? } — книга/аудиокнига из библиотеки (colcat = ключ записи каталога, которой она
// скачана), { ph } — нескачанная запись каталога. Фильтры по строке/автору применяются здесь;
// статус/жанр/прослушивание — на месте рендера (у аудио статус требует прогресса).
function colOrderedEntries(ck) {
  const c = activeCol ? colById(activeCol) : null;
  if (!c) return [];
  const audio = ck === 'audio';
  const pool = audio ? (state.audiobooks || []) : state.books;
  const f = audio ? audioFilters : shelfFilters;
  const q = (f.q || '').toLowerCase();
  const out = [], seen = new Set();
  const passQ = (title, author) => !q || (title || '').toLowerCase().includes(q) || (author || '').toLowerCase().includes(q);
  for (const it of (c.items || [])) {
    if (it.k === (audio ? 'audio' : 'book')) {
      const b = pool.find(x => x.id === it.id);
      if (b && !seen.has(b.id)) { seen.add(b.id); out.push({ b }); }
    } else if (it.k === 'cat' && (it.ck || 'book') === ck) {
      const id = catBookIdOf({ key: it.id });
      const b = id && pool.find(x => x.id === id);
      if (b) { if (!seen.has(b.id)) { seen.add(b.id); out.push({ b, colcat: it.id }); } }
      else {
        const e = it.e || {};
        if (!passQ(e.title, e.author)) continue;
        if (f.author && (e.author || '') !== f.author) continue;
        if (f.genre) continue;                                   // жанра у нескачанной нет
        if (f.status.size && !f.status.has('new')) continue;     // нескачанная = «не прочитано»
        out.push({ ph: it });
      }
    }
  }
  // фильтры для реальных книг — те же, что на полке
  return out.filter(en => !en.b || audio || bookPassesFilters(en.b));
}
// карточка нескачанной записи каталога в коллекции: стрелка качает, крестика нет —
// убирается она как всё остальное, через выделение
function colCatCardHtml(it) {
  const e = it.e || {};
  const badge = catBadgeHtml(it.id, null, `data-colcatdl="${esc(it.id)}"`);
  if ((it.ck || 'book') === 'audio') {
    const meta = [e.time, e.sections ? T('abTracksN', { n: e.sections }) : ''].filter(Boolean).join(' · ');
    return `<div class="ab-card cat-card" data-catkey="${esc(it.id)}">
      <button class="ab-card-cover"><span>♪</span>${badge}<span class="sel-check" aria-hidden="true"></span></button>
      <div class="ab-card-title"><span class="marq">${esc(e.title || '')}</span></div>
      <div class="ab-card-author">${esc(e.author || '')}${meta ? `<br>${esc(meta)}` : ''}</div>
    </div>`;
  }
  const face = `<span class="cover-blank" style="--h:${hueOf(e.title || '')}"><span>${esc(e.title || '')}</span></span>`
    + (e.cover ? `<img class="cover-img cat-cimg" src="${esc(e.cover)}" alt="" loading="lazy" onerror="this.remove()">` : '');
  return `<div class="book-card cat-card" data-catkey="${esc(it.id)}">
    <button class="cover">${face}${badge}<span class="sel-check" aria-hidden="true"></span></button>
    <div class="book-meta">
      <div class="book-title"><span class="marq">${esc(e.title || '')}</span></div>
      ${e.author ? `<div class="book-author">${esc(e.author)}</div>` : ''}
    </div>
  </div>`;
}
// докачка из коллекции: контекст источника восстанавливаем по id витрины
async function colCatDownload(key) {
  const it = colCatItems('book').concat(colCatItems('audio')).find(x => x.id === key);
  if (!it) return;
  await ensureCatState();
  const en = Object.assign({}, it.e, { key: it.id });
  if ((it.ck || 'book') === 'audio') catDownloadAudio(en);
  else {
    const src = catSrcById(it.src);
    catDownload(en, { cfg: (src && src.cfg) || null, auth: (src && src.auth) || '' });
  }
}
// ── свой OPDS-сервер: добавление и удаление ──
function openCatAdd() {
  const box = $('#cat-add'); if (!box) return;
  clearTimeout(openCatAdd.hideT);
  for (const id of ['cat-url', 'cat-user', 'cat-pass']) { const i = $('#' + id); if (i) i.value = ''; }
  box.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('open')));
  setTimeout(() => { const i = $('#cat-url'); if (i) i.focus(); }, 80);
}
function closeCatAdd() {
  const box = $('#cat-add'); if (!box) return;
  box.classList.remove('open');
  clearTimeout(openCatAdd.hideT);
  openCatAdd.hideT = setTimeout(() => { box.hidden = true; }, 360);
}
async function saveCatServer() {
  let url = (($('#cat-url') || {}).value || '').trim();
  if (!url) { showToast(t('catNoUrl')); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let host = ''; try { host = new URL(url).hostname; } catch { showToast(t('urlBad')); return; }
  await ensureCatState();
  const srv = { id: newId('cat'), name: host, url,
                user: (($('#cat-user') || {}).value || '').trim(),
                pass: ($('#cat-pass') || {}).value || '' };
  catServers.push(srv);
  try { await kvSet('catServers', catServers); } catch {}
  closeCatAdd();
  renderColDrawer();
  showToast(t('catSrvAdded'));
}
async function deleteCatServer(id) {
  const s = catServers.find(x => x.id === id); if (!s) return;
  if (!(await uiConfirm(T('catSrvDelQ', { n: s.name }), { yes: t('dlgDelete'), danger: true }))) return;
  catServers = catServers.filter(x => x.id !== id);
  if (activeCat && activeCat.srcId === id) exitCatalog();
  try { await kvSet('catServers', catServers); } catch {}
  renderColDrawer();
}

// Фильтры каталога — та же панель, что у полки (поиск · статус · автор), плюс своя
// строка «Скачано / Не скачано». Поиск идёт ПО КАТАЛОГУ (серверный, если источник
// умеет), остальное фильтрует уже загруженные записи на месте. Панель передаётся
// снаружи: у книжных каталогов это #shelf-filters, у аудио — #audio-filters.
function buildCatFiltersPanel(panelSel) {
  const panel = $(panelSel || '#shelf-filters');
  if (!panel || !activeCat) return;
  const f = catFilters;
  const audioKind = activeCat.kind === 'audio';
  const entries = activeCat.entries || [];
  const authors = [...new Set(entries.map(e => e.author).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  panel.innerHTML = `<div class="flt-inner">
    <input class="field cflt-q" type="search" placeholder="${t(activeCat.searchTpl ? 'catSearchPh' : 'filterSearch')}" value="${esc(activeCat.searchQ || f.q)}" autocomplete="off">
    ${audioKind ? '' : `<div class="flt-row"><span class="flt-lbl">${t('fltStatus')}</span>
      <div class="flt-status cflt-status">
        <button class="chip flt-st${f.status.has('new') ? ' active' : ''}" data-s="new">${t('stNew')}</button>
        <button class="chip flt-st${f.status.has('progress') ? ' active' : ''}" data-s="progress">${t('stProgress')}</button>
        <button class="chip flt-st${f.status.has('read') ? ' active' : ''}" data-s="read">${t('stRead')}</button>
      </div></div>`}
    ${authors.length ? `<div class="flt-row"><span class="flt-lbl">${t('filterAuthor')}</span>
      <div class="flt-select cflt-author"></div></div>` : ''}
    <div class="flt-row"><span class="flt-lbl">${t('fltCat')}</span>
      <div class="flt-status cflt-dl">
        <button class="chip flt-st${f.dl === 'yes' ? ' active' : ''}" data-s="yes">${t('fltDl')}</button>
        <button class="chip flt-st${f.dl === 'no' ? ' active' : ''}" data-s="no">${t('fltNotDl')}</button>
      </div></div>
    <div class="flt-row"><span class="flt-lbl">${t('fltSort')}</span>
      <div class="flt-sort">
        <div class="sort-frame" title="${t('sortOnT')}">
          <label class="sort-cb-lbl"><input type="checkbox" class="scan-cb cflt-sort-on"${catSort.on ? ' checked' : ''} aria-label="${t('sortOnT')}"></label>
          <div class="flt-select cflt-sort-dd"></div>
        </div>
      </div></div>
    <button class="ghost-btn slim cflt-reset"${filtersCatActive() || activeCat.searchQ ? '' : ' hidden'}>${t('filterReset')}</button></div>`;

  const backToStream = () => {
    if (activeCat.adapter) { catAdapterShow(null); return; }
    if (activeCat.curUrl) catShowList(activeCat.curUrl);
    else { activeCat.entries = null; catRender(); }
  };
  const q = panel.querySelector('.cflt-q');
  let qTimer = null;
  const go = () => {
    if (!activeCat) return;
    const val = q.value.trim();
    if (activeCat.searchTpl) {   // серверный поиск по всему каталогу
      if (!val) {
        f.q = '';
        if (activeCat.searchQ) { activeCat.searchQ = ''; backToStream(); }
        return;
      }
      activeCat.searchQ = val;
      if (activeCat.adapter) catAdapterShow({ q: val });
      else catShowList(activeCat.searchTpl.replace('{searchTerms}', encodeURIComponent(val)));
    } else { f.q = val; catRender(); }   // источник без поиска — фильтруем загруженное
  };
  if (q) {
    q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(go, activeCat && activeCat.searchTpl ? 600 : 200); });
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(qTimer); go(); q.blur(); } });
  }
  const st = panel.querySelector('.cflt-status');
  if (st) st.addEventListener('click', e => {
    const btn = e.target.closest('.flt-st'); if (!btn) return;
    const s = btn.dataset.s;
    if (f.status.has(s)) f.status.delete(s); else f.status.add(s);
    btn.classList.toggle('active');
    catRender();
  });
  const auMount = panel.querySelector('.cflt-author');
  if (auMount) filterSelect(auMount,
    [{ v: '', label: t('filterAll') }, ...authors.map(a => ({ v: a, label: a }))],
    f.author, val => { f.author = val; catRender(); });
  const box = panel.querySelector('.cflt-dl');
  if (box) box.addEventListener('click', e => {
    const btn = e.target.closest('.flt-st'); if (!btn) return;
    f.dl = f.dl === btn.dataset.s ? '' : btn.dataset.s;   // повторный тап — снять
    box.querySelectorAll('.flt-st').forEach(x => x.classList.toggle('active', x.dataset.s === f.dl));
    catRender();
  });
  const sortDd = panel.querySelector('.cflt-sort-dd');
  if (sortDd) filterSelect(sortDd, [{ v: 'name', label: t('sortName') }], 'name', () => {});
  const sortOn = panel.querySelector('.cflt-sort-on');
  if (sortOn) sortOn.addEventListener('change', () => { catSort.on = sortOn.checked; catRender(); });
  const reset = panel.querySelector('.cflt-reset');
  if (reset) reset.addEventListener('click', () => {
    f.q = ''; f.author = ''; f.dl = ''; f.status.clear();
    const hadSearch = activeCat && activeCat.searchQ;
    if (activeCat) activeCat.searchQ = '';
    buildCatFiltersPanel(panelSel);
    if (hadSearch) backToStream();
    else catRender();
  });
}

// ── панель фильтров: строится по книгам, меняет список в реальном времени, плавно раскрывается ──
function toggleFilters() {
  const audio = shelfTab === 'audio';
  const panel = audio ? $('#audio-filters') : $('#shelf-filters'), btn = $('#filter-btn');
  // ориентируемся на класс .active кнопки — он отражает намерение сразу, без гонки с анимацией
  // что уезжает вниз вместе с раскрытием — всё, что лежит под панелью
  const movers = (audio ? ['#audio-content'] : ['#shelf-grid', '#shelf-footer'])
    .map(s => $(s)).filter(Boolean);
  if (!btn.classList.contains('active')) {
    if (audio) {
      // аудио-каталог держит свои фильтры на вкладке аудио
      if (activeCat && activeCat.kind === 'audio') buildCatFiltersPanel('#audio-filters');
      else buildAudioFiltersPanel();
    }
    else if (activeCat && activeCat.kind !== 'audio') buildCatFiltersPanel('#shelf-filters');
    else buildFiltersPanel();
    btn.classList.add('active');
    // высота занимается сразу, а видимое раскрытие идёт обрезкой: панель проявляется
    // сверху вниз, полка едет за ней сдвигом — ни одного пересчёта раскладки по пути.
    // сдвиг меряем по факту (сколько реально уехала полка), а не складываем отступы
    const ref = movers[0], was = ref ? ref.getBoundingClientRect().top : 0;
    panel.hidden = false;
    const h = ref ? Math.round(ref.getBoundingClientRect().top - was) : 0;
    panel._fltH = h;
    for (const m of movers) { m.classList.remove('flt-shift'); m.style.transform = `translateY(${-h}px)`; }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      panel.classList.add('open');
      for (const m of movers) { m.classList.add('flt-shift'); m.style.transform = ''; }
    }));
  } else {
    closeFltMenu();
    btn.classList.remove('active');
    const h = panel._fltH || Math.round(panel.getBoundingClientRect().height);
    for (const m of movers) { m.classList.add('flt-shift'); m.style.transform = `translateY(${-h}px)`; }
    panel.classList.remove('open');
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      panel.removeEventListener('transitionend', te);
      if (!panel.classList.contains('open')) panel.hidden = true;
      for (const m of movers) { m.classList.remove('flt-shift'); m.style.transform = ''; }
    };
    const te = ev => { if (ev.target === panel && ev.propertyName === 'clip-path') finish(); };
    panel.addEventListener('transitionend', te);
    setTimeout(finish, 380);   // страховка, если transitionend не придёт
  }
}

// кастомный выпадающий список в стиле приложения (не нативный <select>)
let fltMenuEl = null;
function closeFltMenu() { if (fltMenuEl) fltMenuEl.classList.remove('open'); }
function filterSelect(mount, options, current, onChange) {
  mount.innerHTML = menuTriggerHtml('flt-trigger');
  const trigger = mount.querySelector('.lang-trigger');
  const curEl = trigger.querySelector('.lang-cur');
  const lbl = () => (options.find(o => o.v === current) || options[0]).label;
  curEl.textContent = lbl();
  const { menu } = makeMenu(trigger, {
    cap: 300,
    anchor: mount.closest('.sort-frame'),   // сортировка: меню по грани общей рамки
    onPick: v => {
      current = v;
      curEl.textContent = lbl();
      menu.querySelectorAll('.lang-opt').forEach(o => o.classList.toggle('sel', o.dataset.v === current));
      onChange(current);
    },
  });
  menu.innerHTML = menuOptionsHtml(options, current);
  fltMenuEl = menu;
}

function buildFiltersPanel() {
  const panel = $('#shelf-filters');
  const f = shelfFilters;
  const authors = [...new Set(state.books.map(b => b.author).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const present = new Set(state.books.map(bookGenre).filter(Boolean));
  const genres = Genres.GENRES.filter(g => present.has(g));
  panel.innerHTML = `<div class="flt-inner">
    <input id="flt-q" class="field" type="search" placeholder="${t('filterSearch')}" value="${esc(f.q)}" autocomplete="off">
    <div class="flt-row"><span class="flt-lbl">${t('fltStatus')}</span>
      <div class="flt-status" id="flt-status">
        <button class="chip flt-st${f.status.has('new') ? ' active' : ''}" data-s="new">${t('stNew')}</button>
        <button class="chip flt-st${f.status.has('progress') ? ' active' : ''}" data-s="progress">${t('stProgress')}</button>
        <button class="chip flt-st${f.status.has('read') ? ' active' : ''}" data-s="read">${t('stRead')}</button>
      </div></div>
    ${authors.length ? `<div class="flt-row"><span class="flt-lbl">${t('filterAuthor')}</span>
      <div class="flt-select" id="flt-author"></div></div>` : ''}
    ${genres.length ? `<div class="flt-row"><span class="flt-lbl">${t('filterGenre')}</span>
      <div class="flt-genres" id="flt-genres">${genres.map(g =>
        `<button class="chip flt-g${g === f.genre ? ' active' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div></div>` : ''}
    <div class="flt-row"><span class="flt-lbl">${t('fltSort')}</span>
      <div class="flt-sort">
        <div class="sort-frame" title="${t('sortOnT')}">
          <label class="sort-cb-lbl"><input type="checkbox" id="flt-sort-on" class="scan-cb"${shelfSort.on ? ' checked' : ''} aria-label="${t('sortOnT')}"></label>
          <div class="flt-select" id="flt-sort-dd"></div>
        </div>
      </div></div>
    <button id="flt-reset" class="ghost-btn slim"${filtersActive() ? '' : ' hidden'}>${t('filterReset')}</button></div>`;

  const q = $('#flt-q');
  // печать — это серия событий: пересобирать полку на каждую букву незачем,
  // ждём короткую паузу и рисуем один раз
  let qTimer = null;
  if (q) q.addEventListener('input', () => {
    f.q = q.value.trim();
    clearTimeout(qTimer);
    qTimer = setTimeout(applyFilters, 180);
  });
  const stbox = $('#flt-status');
  if (stbox) stbox.addEventListener('click', e => {
    const btn = e.target.closest('.flt-st'); if (!btn) return;
    const s = btn.dataset.s;
    if (f.status.has(s)) f.status.delete(s); else f.status.add(s);
    btn.classList.toggle('active');
    applyFilters();
  });
  const auMount = $('#flt-author');
  if (auMount) filterSelect(auMount,
    [{ v: '', label: t('filterAll') }, ...authors.map(a => ({ v: a, label: a }))],
    f.author, val => { f.author = val; applyFilters(); });
  const gbox = $('#flt-genres');
  if (gbox) gbox.addEventListener('click', e => {
    const btn = e.target.closest('.flt-g'); if (!btn) return;
    f.genre = f.genre === btn.dataset.g ? '' : btn.dataset.g;   // повторный клик — снять
    gbox.querySelectorAll('.flt-g').forEach(x => x.classList.toggle('active', x.dataset.g === f.genre));
    applyFilters();
  });
  const sortDd = $('#flt-sort-dd');
  if (sortDd) filterSelect(sortDd,
    [{ v: 'name', label: t('sortName') }, { v: 'date', label: t('sortAdded') }],
    shelfSort.by, val => { shelfSort.by = val; if (shelfSort.on) renderShelf(); });
  const sortOn = $('#flt-sort-on');
  if (sortOn) sortOn.addEventListener('change', () => { shelfSort.on = sortOn.checked; renderShelf(); });
  const reset = $('#flt-reset');
  if (reset) reset.addEventListener('click', () => {
    shelfFilters.q = ''; shelfFilters.author = ''; shelfFilters.genre = '';
    shelfFilters.status.clear();
    buildFiltersPanel(); renderShelf();
  });
}

// фильтр аудиокниг: поиск + статус прослушивания (не прослушано / в процессе / прослушано)
function buildAudioFiltersPanel() {
  const panel = $('#audio-filters');
  if (!panel) return;
  const f = audioFilters;
  const hasReset = f.q || f.status.size;
  panel.innerHTML = `<div class="flt-inner">
    <input id="aflt-q" class="field" type="search" placeholder="${t('filterSearch')}" value="${esc(f.q)}" autocomplete="off">
    <div class="flt-row"><span class="flt-lbl">${t('fltStatus')}</span>
      <div class="flt-status" id="aflt-status">
        <button class="chip flt-st${f.status.has('new') ? ' active' : ''}" data-s="new">${t('stNewA')}</button>
        <button class="chip flt-st${f.status.has('progress') ? ' active' : ''}" data-s="progress">${t('stProgress')}</button>
        <button class="chip flt-st${f.status.has('read') ? ' active' : ''}" data-s="read">${t('stReadA')}</button>
      </div></div>
    ${hasReset ? `<button id="aflt-reset" class="ghost-btn slim">${t('filterReset')}</button>` : ''}</div>`;
  const q = $('#aflt-q');
  let aqTimer = null;
  if (q) q.addEventListener('input', () => {
    f.q = q.value.trim();
    clearTimeout(aqTimer);
    aqTimer = setTimeout(renderAudioShelf, 180);
  });
  const st = $('#aflt-status');
  if (st) st.addEventListener('click', e => {
    const b = e.target.closest('.flt-st'); if (!b) return;
    const s = b.dataset.s;
    if (f.status.has(s)) f.status.delete(s); else f.status.add(s);
    b.classList.toggle('active'); renderAudioShelf();
  });
  const rs = $('#aflt-reset');
  if (rs) rs.addEventListener('click', () => { f.q = ''; f.status.clear(); buildAudioFiltersPanel(); renderAudioShelf(); });
}

// главная панель разбита на вкладки «Книги» / «Аудиокниги» (последняя — заглушка,
// готовим место под поддержку аудиоформатов)
let shelfTab = 'books';
function setShelfTab(tab) {
  const next = tab === 'audio' ? 'audio' : 'books';
  const changed = next !== shelfTab;
  if (changed) exitSelMode();   // смена вкладки сбрасывает мультивыбор
  shelfTab = next;
  // при переключении вкладки закрываем открытый фильтр (у вкладок он разный)
  const fbtn = $('#filter-btn');
  if (fbtn && fbtn.classList.contains('active')) {
    fbtn.classList.remove('active');
    for (const id of ['shelf-filters', 'audio-filters']) {
      const p = $('#' + id); if (p) { p.classList.remove('open'); p.hidden = true; }
    }
  }
  for (const b of document.querySelectorAll('#shelf-tabs .shelf-tab'))
    b.classList.toggle('active', b.dataset.tab === shelfTab);
  const tabsEl = document.getElementById('shelf-tabs');
  if (tabsEl) tabsEl.dataset.active = shelfTab;   // золотой индикатор едет под активную вкладку
  const tb = $('#tab-books'), ta = $('#tab-audio');
  const shown = shelfTab === 'books' ? tb : ta;
  const hidden = shelfTab === 'books' ? ta : tb;
  if (hidden) hidden.hidden = true;
  if (shown) {
    shown.hidden = false;
    if (changed) {   // лёгкий слайд контента в сторону перехода
      shown.style.setProperty('--tab-dir', (shelfTab === 'audio' ? 16 : -16) + 'px');
      shown.classList.remove('tab-in'); void shown.offsetWidth; shown.classList.add('tab-in');
    }
  }
  // Перерисовка нужна и без смены вкладки: сюда приходят после закрытия плеера и после
  // импорта аудиокниги, и там процент в «Продолжить слушать» обязан обновиться.
  // А от лишних перерисовок защищаются сами жесты — они не зовут setShelfTab впустую.
  if (shelfTab === 'audio') renderAudioShelf();
  // в режиме каталога книжная вкладка обязана перерисоваться (заглушка аудио-каталога
  // или сетка книжного) — иначе при свайпе всплывает старая полка
  else if (activeCat) renderShelf();
}

// Кружки добавления живут снаружи #shelf-view (их ломала бы анимация входа полки),
// поэтому показываем и прячем их вместе с ней вручную.
function syncAddFab() {
  const f = $('#add-fab');
  if (f) {
    f.hidden = !!$('#shelf-view').hidden;
    if (f.hidden) closeFabMore(true);   // ушли с полки — «ещё» схлопываем без анимации
    else applyFabDock();
  }
}

// ── «ещё» (троеточие): под ним живут лупа и ссылка ──
// Троеточие схлопывается в точку, на его место теми же анимациями кластера выезжают обе кнопки.
let fabMoreT = 0;
// кластер меняет длину — переезжает на новое место плавно, а не скачком
function slideFab(fab) {
  fab.classList.add('fab-sliding');
  applyFabDock();
  clearTimeout(slideFab._t);
  slideFab._t = setTimeout(() => fab.classList.remove('fab-sliding'), 340);
}
function openFabMore() {
  const fab = $('#add-fab'); if (!fab || fab.classList.contains('more-open')) return;
  clearTimeout(fabMoreT);
  fab.classList.remove('more-closing');
  fab.classList.add('more-opening');           // троеточие схлопывается…
  fabMoreT = setTimeout(() => {
    fab.classList.remove('more-opening');
    fab.classList.add('more-open');            // …и на его месте выезжают лупа со ссылкой
    slideFab(fab);
  }, 190);
}
function closeFabMore(instant) {
  const fab = $('#add-fab'); if (!fab) return;
  clearTimeout(fabMoreT);
  fab.classList.remove('more-opening');
  if (!fab.classList.contains('more-open')) { fab.classList.remove('more-closing'); return; }
  fab.classList.remove('more-open');
  if (instant) { fab.classList.remove('more-closing'); applyFabDock(); return; }
  // лупа и ссылка уезжают за тот же край экрана, откуда появились, никуда не прыгая:
  // троеточие в это время ещё вне потока. Ушли — оно вырастает, а кластер плавно
  // подтягивается к новой (короткой) длине
  fab.classList.add('more-closing');
  fabMoreT = setTimeout(() => {
    fab.classList.remove('more-closing');
    fab.classList.add('more-grow');
    slideFab(fab);
    setTimeout(() => fab.classList.remove('more-grow'), 280);
  }, 280);
}
const fabMoreOpen = () => !!$('#add-fab')?.classList.contains('more-open');

// ── перетаскивание кластера #add-fab по L-рельсе (правый край ↔ низ), с инерцией и запоминанием ──
// позиция = ДОЛЯ (0..1) центра ГЛАВНОЙ кнопки вдоль рельсы. Якорим по ней и клампим ВЕСЬ кластер:
// поэтому у угла появление корзины/коллекции растёт в свободную сторону, не выталкивая видимые кнопки.
let fabDock = null;     // {edge:'right'|'bottom', frac} или null = дефолт из CSS (справа-снизу)
let fabDragging = false;   // истина во время захвата — по нему свайпы приложения себя глушат
const clamp01 = x => Math.max(0, Math.min(1, x));
function cssInset(n) { const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n)); return isFinite(v) ? v : 0; }
// Позиционирование кластера. ГЛАВНАЯ кнопка держится строго по 3 ОСНОВНЫМ (url·главная·поиск —
// их взаимное расположение вокруг главной постоянно), поэтому появление корзины/коллекции НИКОГДА
// не сдвигает главную. Доп-иконки показываем с той стороны, где влезают (по умолчанию перед
// основными; если там нет места — .fab-extra-flip уносит их в конец), а если не влезают нигде —
// оставляем по умолчанию (крайний случай). frac = доля позиции ГЛАВНОЙ вдоль рельсы.
// Ситуативные кружки в порядке близости к главной. Кто не помещается на своей стороне —
// перелетает в конец кластера ПООДИНОЧКЕ: сначала убирается родной анимацией, потом
// возникает уже с другой стороны. Остальные при этом стоят на месте.
const FAB_EXTRAS = ['#fab-dl', '#fab-collect', '#fab-fold', '#fab-del'];
let fabHopT = 0;
// раздать места: первые nBefore по близости остаются перед главной, прочие уходят в конец.
// Перелёт строго в два такта, иначе кнопка «возникает из ниоткуда» на новом месте и только
// потом играет свою анимацию: сперва она уходит за край СО СТАРОГО места, и лишь когда её
// уже не видно — меняется порядок и она выезжает с новой стороны.
const fabOrderOf = (i, after) => after ? String(10 + i) : String(-(i + 1));
function applyFabSides(fab, nBefore) {
  const btns = FAB_EXTRAS.map(s => $(s)).filter(b => b && getComputedStyle(b).display !== 'none');
  const moved = [];
  btns.forEach((b, i) => {
    const after = i >= nBefore;
    const known = b.dataset.fabAfter !== undefined;
    if (known && (b.dataset.fabAfter === '1') !== after) { moved.push({ b, i, after }); return; }
    if (!known || b.classList.contains('fab-hop-out')) {   // первый расчёт — сразу, без перелёта
      b.dataset.fabAfter = after ? '1' : '0';
      b.style.order = fabOrderOf(i, after);
    }
  });
  if (fabHopT || !moved.length) return;
  for (const { b } of moved) { b.classList.remove('fab-hop-in'); b.classList.add('fab-hop-out'); }
  fabHopT = setTimeout(() => {
    fabHopT = 0;
    for (const { b, i, after } of moved) {          // кнопки уже за краем — переставляем незаметно
      b.dataset.fabAfter = after ? '1' : '0';
      b.style.order = fabOrderOf(i, after);
      b.classList.remove('fab-hop-out');
      b.classList.add('fab-hop-in');
    }
    applyFabDock();                                  // длина кластера изменилась — подтянуть место
    setTimeout(() => { for (const { b } of moved) b.classList.remove('fab-hop-in'); }, 320);
  }, 190);
}
function applyFabDock() {
  const fab = $('#add-fab');
  if (!fab || fab.hidden || !fabDock) return;
  const bottom = fabDock.edge === 'bottom';
  fab.classList.toggle('fab-dock-bottom', bottom);
  // постоянная часть кластера — главная и всё, что ПОД ней («ещё» либо раскрытые лупа+ссылка).
  // Ситуативные кружки живут только НАД главной, поэтому перед главной постоянного ничего нет.
  // Меряем ТОЛЬКО offset-геометрией: getBoundingClientRect учитывает transform, и кнопку,
  // застигнутую анимацией (схлопывание троеточия, вылет кружка), он показывает меньше её
  // настоящего размера — кластер тогда уезжал за край экрана.
  const main = $('#import-btn');
  // хвост — последняя РЕАЛЬНО видимая кнопка под главной: пока лупа со ссылкой уезжают,
  // они ещё занимают место, и кластер обязан считаться по ним, а не по спрятанному троеточию
  const t = [$('#url-btn'), $('#scan-btn'), $('#fab-more')]
    .find(b => b && getComputedStyle(b).display !== 'none') || main;
  if (!fab.offsetWidth || !fab.offsetHeight) return;        // ещё не в потоке — применим при показе
  const W = innerWidth, H = innerHeight, m = 16;
  // Сколько ситуативных кружков влезает перед главной, а сколько уйдёт за хвост. Главную
  // ограничивают ТОЛЬКО основные (она сама и хвост) — упёрлась в стенку, значит лишние
  // кружки перелетают за неё поодиночке. Позицию правим лишь тогда, когда иначе они не
  // помещаются вовсе (кластер длиннее свободного места с обеих сторон).
  const spread = (want, lead, trail, step, count, lo, hi) => {
    let pos = Math.max(lo + lead, Math.min(hi - trail, want));
    if (!count || step <= 0) return { pos, nBefore: 0 };
    for (let k = 0; k < 3; k++) {
      const roomB = pos - lead - lo, roomA = hi - trail - pos;
      const nB = Math.max(0, Math.min(count, Math.floor(roomB / step + 1e-6)));
      const need = (count - nB) * step;
      if (need <= roomA + 1e-6) return { pos, nBefore: nB };
      // сзади не помещается — двигаем главную вперёд, освобождая место позади
      const next = Math.min(hi - trail, pos + (need - roomA));
      if (next <= pos + 0.5) return { pos, nBefore: Math.min(count, nB + Math.floor(roomA / step + 1e-6)) };
      pos = next;
    }
    return { pos, nBefore: Math.max(0, Math.min(count, Math.floor((pos - lead - lo) / step + 1e-6))) };
  };
  const shown = FAB_EXTRAS.map(s => $(s)).filter(b => b && getComputedStyle(b).display !== 'none');
  const gap = parseFloat(getComputedStyle(fab).gap) || 10;
  if (bottom) {   // нижняя рельса (строка): двигаем по X
    const cOff = main.offsetLeft + main.offsetWidth / 2;    // центр главной внутри кластера
    const lead = main.offsetWidth / 2;                      // постоянная часть слева от центра
    const trail = (t.offsetLeft + t.offsetWidth) - cOff;    // и справа (главная + хвост)
    const step = shown.length ? shown[0].offsetWidth + gap : 0;
    const r = spread(fabDock.frac * W, lead, trail, step, shown.length, m, W - m);
    applyFabSides(fab, r.nBefore);
    const off = main.offsetLeft + main.offsetWidth / 2;     // центр главной от левого края кластера
    fab.style.top = 'auto'; fab.style.left = (r.pos - off) + 'px'; fab.style.right = 'auto'; fab.style.bottom = '';
  } else {        // правая рельса (колонка): двигаем по Y, с потолком по вкладкам
    const cOff = main.offsetTop + main.offsetHeight / 2;
    const lead = main.offsetHeight / 2;
    const trail = (t.offsetTop + t.offsetHeight) - cOff;
    const step = shown.length ? shown[0].offsetHeight + gap : 0;
    // Потолок — вкладки книга/аудио, но привязанный к ЭКРАНУ, а не к прокрученной шапке:
    // вкладки уезжают вверх вместе с полкой, и по их текущему rect запрет переставал работать —
    // кнопки поднимались под самый верх, а после возврата полки оказывались поверх логотипа.
    // + scrollY даёт положение вкладок при неприкрученной полке, то есть постоянную границу.
    const tabs = $('#shelf-tabs');
    const ceil = (tabs && !tabs.hidden) ? tabs.getBoundingClientRect().top + scrollY : (m + 80);
    const topMin = Math.max(m + cssInset('--sat'), ceil);
    const botMax = H - m - cssInset('--sab');
    const r = spread(fabDock.frac * H, lead, trail, step, shown.length, topMin, botMax);
    applyFabSides(fab, r.nBefore);
    const off = main.offsetTop + main.offsetHeight / 2;
    fab.style.top = (r.pos - off) + 'px'; fab.style.left = 'auto'; fab.style.right = ''; fab.style.bottom = 'auto';
  }
}
// плавная перестройка колонка↔строка: FLIP — кнопки едут из старых экранных позиций в новые
function fabFlip(change) {
  const fab = $('#add-fab');
  const kids = [...fab.querySelectorAll('button')].filter(b => b.offsetParent);
  const before = kids.map(b => b.getBoundingClientRect());
  change();
  const after = kids.map(b => b.getBoundingClientRect());
  kids.forEach((b, i) => {
    const dx = before[i].left - after[i].left, dy = before[i].top - after[i].top;
    if (!dx && !dy) return;
    b.style.transition = 'none';
    b.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  });
  fab.getBoundingClientRect();   // форс-перерисовка со стартовым сдвигом
  kids.forEach(b => { b.style.transition = 'transform .26s cubic-bezier(.22,.61,.36,1)'; b.style.transform = ''; });
  setTimeout(() => kids.forEach(b => { b.style.transition = ''; b.style.transform = ''; }), 300);
}
function initFabDrag() {
  const fab = $('#add-fab'); if (!fab) return;
  try { const s = JSON.parse(localStorage.getItem('talewyn-fab-dock') || 'null'); if (s && s.edge) fabDock = s; } catch {}
  applyFabDock();
  let holdT = 0, pid = null, sx = 0, sy = 0, justDragged = false, vel = 0, lastT = 0;
  let pendX = 0, pendY = 0, rafId = 0;
  const startDrag = () => {
    fabDragging = true; vel = 0; lastT = performance.now();
    fab.classList.add('fab-dragging'); fab.classList.remove('fab-gliding');
    try { fab.setPointerCapture(pid); } catch {}
    if (!fabDock) { const r = fab.getBoundingClientRect(); fabDock = { edge: 'right', frac: clamp01((r.top + r.height / 2) / innerHeight) }; }
  };
  const moveDock = (fx, fy) => {
    const W = innerWidth, H = innerHeight;
    // гистерезис у угла: зона перехода между H-118 и H-72, иначе рельса «дрожит» на границе
    const cur = fabDock ? fabDock.edge : 'right';
    const edge = fy > H - 72 ? 'bottom' : fy < H - 118 ? 'right' : cur;
    const frac = clamp01(edge === 'bottom' ? fx / W : fy / H);
    const t = performance.now();
    if (fabDock && edge === fabDock.edge && t > lastT) vel = 0.6 * vel + 0.4 * ((frac - fabDock.frac) / (t - lastT));
    else vel = 0;   // смена рельсы — скорость сбрасываем (ось другая)
    lastT = t;
    if (fabDock && edge !== fabDock.edge) fabFlip(() => { fabDock = { edge, frac }; applyFabDock(); });
    else { fabDock = { edge, frac }; applyFabDock(); }
  };
  const flushMove = () => { rafId = 0; moveDock(pendX, pendY); };
  fab.addEventListener('pointerdown', e => {
    if ((e.button && e.button !== 0) || uiOverlayOpen()) return;   // окно открыто — кластер не таскаем
    pid = e.pointerId; sx = e.clientX; sy = e.clientY;
    clearTimeout(holdT); holdT = setTimeout(startDrag, 380);   // удержание ~0.38с → захват
  });
  fab.addEventListener('pointermove', e => {
    if (e.pointerId !== pid) return;
    if (!fabDragging) { if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) clearTimeout(holdT); return; }
    e.preventDefault();
    pendX = e.clientX; pendY = e.clientY;   // движение применяем раз в кадр (rAF), не чаще
    if (!rafId) rafId = requestAnimationFrame(flushMove);
  });
  const end = e => {
    if (pid == null || (e && e.pointerId !== pid)) return;
    clearTimeout(holdT);
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    try { fab.releasePointerCapture(pid); } catch {}
    pid = null;
    if (!fabDragging) return;
    fab.classList.remove('fab-dragging');
    // доводка по инерции: продлеваем в сторону броска и плавно доезжаем (через .fab-gliding)
    fab.classList.add('fab-gliding');
    fabDock = { edge: fabDock.edge, frac: clamp01(fabDock.frac + vel * 130) };
    applyFabDock();
    setTimeout(() => { fab.classList.remove('fab-gliding'); try { localStorage.setItem('talewyn-fab-dock', JSON.stringify(fabDock)); } catch {} }, 380);
    justDragged = true; setTimeout(() => { justDragged = false; }, 80);
    setTimeout(() => { fabDragging = false; }, 120);   // держим флаг ещё чуть-чуть — гасим завершающий touchend
  };
  fab.addEventListener('pointerup', end);
  fab.addEventListener('pointercancel', end);
  // клик сразу после перетаскивания глушим (в фазе перехвата, до обработчиков кнопок)
  fab.addEventListener('click', e => { if (justDragged) { e.preventDefault(); e.stopPropagation(); } }, true);
  addEventListener('resize', applyFabDock);
}
function showShelf() {
  navToken++;
  loadingChapter = false;
  ttsStop();
  flushDirty();
  statSessionEnd();   // вышли из книги — закрываем сессию чтения
  clearNoteHl();
  state.book = null;
  state.chapter = null;
  $('#reader-view').hidden = true;
  $('#library-view').hidden = true;
  $('#audio-view').hidden = true;
  $('#readbar').hidden = true;
  $('#readbar').classList.remove('loading');
  $('#shelf-view').hidden = false;
  nativeScrollbar(false);   // на полке нативную полосу прячем
  syncAddFab();
  updateTitle();
  renderShelf();
  if (window.shelfBgKick) window.shelfBgKick();
  enterView($('#shelf-view'));
  updateWakeLock();
  syncSettingsUI();
  requestAnimationFrame(() => { scrollTo(0, state.shelfScroll); syncShelfStuck(); });
}

// Липкая шапка полки: пока полка прокручена, у шапки появляется подложка (тон темы +
// размытие), чтобы контент уезжал под неё чисто. В самом верху — подложки нет.
function syncShelfStuck() {
  const h = document.querySelector('.shelf-head');
  if (!h) return;
  // гистерезис: включаем подложку выше 8px, снимаем ниже 4px — у самого края,
  // где полка дрожит на ±1px, она не мигает туда-сюда
  const on = h.classList.contains('stuck');
  if (!on && scrollY > 8) h.classList.add('stuck');
  else if (on && scrollY < 4) h.classList.remove('stuck');
}
addEventListener('scroll', () => { if (!$('#shelf-view').hidden) syncShelfStuck(); }, { passive: true });

// Нативная полоса прокрутки WebView. Оверлейную полосу главного окна CSS не берёт, поэтому
// переключаем её нативным мостом: в чтении оставляем (индикатор прочитанного), на полке, экране
// книги, аудио и в остальном интерфейсе — прячем. Мост есть только в свежем APK; на старом —
// тихо ничего не делает (полоса остаётся как была).
function nativeScrollbar(on) {
  try { window.AndroidScroll && window.AndroidScroll.set(!!on); } catch {}
}

// ══════════════════ импорт файлов ══════════════════
// Тяжёлые модули (разбор книг, чтение тегов аудио) грузятся ПРИ ПЕРВОМ импорте, а не при
// запуске: на слабом телефоне их разбор откладывал появление полки на несколько сотен
// миллисекунд, хотя большинство запусков — это просто «открыть и читать».
const _lazyScripts = {};
function loadLazyScript(src) {
  if (_lazyScripts[src]) return _lazyScripts[src];
  _lazyScripts[src] = new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = res;
    el.onerror = () => rej(new Error('не загрузился ' + src));
    document.head.appendChild(el);
  });
  return _lazyScripts[src];
}
async function importers() {
  if (!window.Importers) await loadLazyScript('importers.js?v=25');
  return window.Importers;
}
async function mediaTags() {
  if (!window.jsmediatags) { try { await loadLazyScript('jsmediatags.min.js?v=1'); } catch {} }
  return window.jsmediatags || null;
}
// ключ книги для защиты от повторного добавления одного и того же (название + автор)
const bookKey = b => (b.title || '').trim().toLowerCase() + '|' + (b.author || '').trim().toLowerCase();
// ══════════════════ импорт книги по ссылке ══════════════════
// Скачать произвольный URL обычным fetch из приложения нельзя: страница живёт на
// https://localhost, и чужой сервер её не пустит (CORS). Поэтому на телефоне идём
// мимо WebView — нативным мостом CapacitorHttp: он есть в Capacitor всегда и не
// требует включения (флаг enabled лишь патчит глобальный fetch — трогать его нельзя,
// иначе через мост поедут и озвучка, и переводчик). Цена: ответ приходит одним куском,
// процентов нет — показываем бегущую полосу. На ПК остаётся fetch с процентами.
const MAX_DL = 100 * 1024 * 1024;
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const capHttp = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) || null;

// Имя нужно импортёру: по расширению он выбирает разбор (магия байтов ловит не всё).
function fileNameFrom(url, headers) {
  const cd = headers['content-disposition'] || '';
  const m = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  if (m) { try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); } }
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
  } catch {}
  const ct = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = {
    'application/epub+zip': '.epub', 'application/x-fictionbook+xml': '.fb2',
    'application/pdf': '.pdf', 'application/x-mobipocket-ebook': '.mobi',
    'application/vnd.amazon.ebook': '.azw3', 'application/vnd.comicbook+zip': '.cbz',
    'application/vnd.comicbook-rar': '.cbr', 'text/plain': '.txt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    // аудио: по расширению doImport сам отправит файл в аудиокниги, а не в текст
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
    'audio/m4b': '.m4b', 'audio/x-m4b': '.m4b', 'audio/aac': '.aac', 'audio/ogg': '.ogg',
    'audio/opus': '.opus', 'audio/flac': '.flac', 'audio/x-flac': '.flac', 'audio/wav': '.wav',
    'audio/x-wav': '.wav', 'audio/wave': '.wav',
  }[ct];
  return 'book' + (ext || '');   // без расширения формат определится по сигнатуре байтов
}

async function dlNative(url, cookie, extraHeaders) {
  // Без браузерных заголовков CapacitorHttp выглядит для сервера ботом, и Cloudflare и
  // большинство книжных сайтов отвечают 503/403. Прикидываемся мобильным браузером.
  let origin = '';
  try { origin = new URL(url).origin; } catch {}
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/epub+zip,application/octet-stream,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  };
  if (origin) headers['Referer'] = origin + '/';
  if (cookie) headers['Cookie'] = cookie;   // ответ на куки-челлендж антибота (beget и т.п.)
  if (extraHeaders) Object.assign(headers, extraHeaders);   // авторизация личного OPDS-сервера
  const r = await capHttp.request({ url, method: 'GET', responseType: 'blob', headers,
                                    connectTimeout: 15000, readTimeout: 120000 });
  if (r.status < 200 || r.status >= 300) throw new Error(T('urlHttp', { c: r.status }));
  const h = {};
  for (const [k, v] of Object.entries(r.headers || {})) h[String(k).toLowerCase()] = String(v);
  // при Content-Type: application/json плагин сам разберёт ответ в объект — это точно не файл
  if (typeof r.data !== 'string') throw new Error(t('urlNotBook'));
  const b64 = r.data.replace(/\s+/g, '');   // база64 приходит с переносами строк
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (bin.length > MAX_DL) throw new Error(t('urlBig'));
  return { blob: new Blob([bin], { type: h['content-type'] || '' }), headers: h, url: r.url || url };
}

// Большие файлы (треки аудиокниг — десятки/сотни МБ) через capHttp целиком не пролезают:
// плагин отдаёт ответ ОДНОЙ base64-строкой через мост, декодирование замирает на минуты,
// прогресса нет. Качаем кусками по Range: каждый кусок — маленький мост, между кусками
// дышит интерфейс, прогресс честный. Сервер без Range (ответил 200) → файл пришёл целиком.
const DL_CHUNK = 6 * 1024 * 1024;
// base64 → Blob без ручного цикла по мегабайтам символов: декодер браузера в разы быстрее
const b64Blob = b64 => fetch('data:application/octet-stream;base64,' + b64.replace(/\s+/g, '')).then(r => r.blob());
async function dlNativeBig(url, onFrac, maxBytes, signal) {
  const cap = maxBytes || MAX_DL;
  let origin = '';
  try { origin = new URL(url).origin; } catch {}
  const base = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  };
  if (origin) base['Referer'] = origin + '/';
  const parts = [];
  let type = '', total = 0, got = 0;
  for (let off = 0; ; off += DL_CHUNK) {
    if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const r = await capHttp.request({
      url, method: 'GET', responseType: 'blob',
      headers: Object.assign({ Range: 'bytes=' + off + '-' + (off + DL_CHUNK - 1) }, base),
      connectTimeout: 15000, readTimeout: 180000,
    });
    if (r.status === 416) break;                              // диапазон за концом файла
    if (r.status < 200 || r.status >= 300) throw new Error(T('urlHttp', { c: r.status }));
    if (typeof r.data !== 'string') throw new Error(t('urlNotBook'));
    const h = {};
    for (const [k, v] of Object.entries(r.headers || {})) h[String(k).toLowerCase()] = String(v);
    if (!type) type = h['content-type'] || '';
    const part = await b64Blob(r.data);
    if (r.status === 200) {                                   // Range не поддержан — приехало всё
      if (part.size > cap) throw new Error(t('urlBig'));
      return { blob: new Blob([part], { type: type || part.type }), headers: h, url };
    }
    if (!part.size) break;
    parts.push(part); got += part.size;
    if (got > cap) throw new Error(t('urlBig'));
    const m = /\/(\d+)\s*$/.exec(h['content-range'] || '');
    if (m) total = +m[1];
    if (onFrac && total) onFrac(Math.min(1, got / total));
    if ((total && got >= total) || part.size < DL_CHUNK) break;
  }
  if (!got) throw new Error(t('urlEmpty'));
  return { blob: new Blob(parts, { type }), headers: {}, url };
}

async function dlWeb(url, onFrac, extSignal, headers) {
  const c = new AbortController();
  if (extSignal) extSignal.addEventListener('abort', () => c.abort());   // отмена из очереди загрузок
  const to = setTimeout(() => c.abort(), 20000);   // таймаут только на заголовки, не на всю качку
  const res = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: c.signal, headers });
  clearTimeout(to);
  if (!res.ok) throw new Error(T('urlHttp', { c: res.status }));
  const h = {}; res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  const total = +(h['content-length'] || 0);
  if (total > MAX_DL) throw new Error(t('urlBig'));
  if (!res.body) return { blob: await res.blob(), headers: h, url: res.url };
  const rd = res.body.getReader(); const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (got > MAX_DL) { rd.cancel(); throw new Error(t('urlBig')); }
    if (onFrac) onFrac(total ? got / total : null);
  }
  return { blob: new Blob(parts, { type: h['content-type'] || '' }), headers: h, url: res.url };
}

// антибот-заглушка вида beget: крошечный HTML со скриптом document.cookie='NAME=VAL…';…location.reload()
// — читаем куку, чтобы поставить её и повторить запрос за настоящей страницей
function cookieChallenge(html) {
  if (!html || html.length > 4000) return '';
  const m = /document\.cookie\s*=\s*['"]([^'";=]+=[^'";]+)/i.exec(html);
  return (m && /location\.(reload|href|replace)/i.test(html)) ? m[1] : '';
}

let urlBusy = false;   // свой флаг: importBusy трогать нельзя — doImport выйдет на первой строке
async function importFromUrl() {
  if (urlBusy || importBusy) return;
  let url = await uiPrompt(t('urlT'), { ph: 'https://…/book.fb2', yes: t('urlGo') });
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let u; try { u = new URL(url); } catch { showToast(t('urlBad')); return; }
  // прямая ссылка на аудио → слушаем ПОТОКОМ, не скачивая в память (аудиокниги большие).
  // расширение проверяем по пути URL, чтобы ?query не мешал.
  let audioUrl = false;
  try { audioUrl = AUDIO_EXT.test(new URL(u.href).pathname); } catch {}
  if (audioUrl) {
    if (!netOnline) { probeNet(); showToast(t('urlNoNet')); return; }
    urlBusy = true;
    try {
      showProgress(T('urlStream', { h: u.hostname }), null);
      const rec = await addStreamAudiobook([u.href]);
      hideToast();
      if (typeof loadAudiobooks === 'function') await loadAudiobooks();
      setShelfTab('audio'); renderAudioShelf();
      showToast(T('streamAdded', { n: rec.title }));
      openAudiobook(rec.id);
    } catch (e) { showToast(T('urlFail', { e: (e && e.message) || t('urlBlocked') })); }
    finally { urlBusy = false; }
    return;
  }
  if (!netOnline) { probeNet(); showToast(t('urlNoNet')); return; }
  urlBusy = true;
  const job = dlAdd('url', u.hostname); job.status = 'active'; renderDlList();
  const ctrl = new AbortController(); job.abort = () => ctrl.abort();   // отмена из очереди рвёт закачку (веб)
  const dropped = () => { if (job.cancelled) { dlRemove(job); urlBusy = false; return true; } return false; };
  try {
    const msg = T('urlDl', { h: u.hostname });
    showProgress(msg, null);
    let got = (isNative && capHttp) ? await dlNative(u.href)
                                    : await dlWeb(u.href, frac => { job.frac = frac; renderDlList(); showProgress(msg, frac); }, ctrl.signal);
    if (dropped()) return;                       // отменили, пока качалось (натив не прервать — просто не берём)
    if (!got.blob.size) throw new Error(t('urlEmpty'));
    // антибот-заглушка (beget и подобные): крошечный HTML ставит куку и перезагружается —
    // читаем куку из скрипта, ставим её и повторяем запрос, иначе получаем пустышку
    if (isNative && capHttp && got.blob.size < 4000) {
      const cookie = cookieChallenge(await got.blob.text());
      if (cookie) { got = await dlNative(u.href, cookie); if (dropped()) return; if (!got.blob.size) throw new Error(t('urlEmpty')); }
    }
    const name = fileNameFrom(got.url, got.headers);
    const isAudio = AUDIO_EXT.test(name) || (got.blob.type || '').startsWith('audio/');
    if (!isAudio) {
      const head = await got.blob.slice(0, 1024).text();
      // любая HTML-страница: СНАЧАЛА пробуем вытащить аудио (это аудиокнига), это важнее книги —
      // иначе страница с расширением .html импортировалась бы как «книга» из вёрстки сайта
      if (/<!doctype\s+html|<html[\s>]/i.test(head)) {
        const html = await got.blob.text();
        const found = extractAudioTracks(html, got.url || u.href);
        if (found.length) {
          urlBusy = false; hideToast(); dlRemove(job);
          const rec = await addStreamAudiobook(found, pageTitle(html));
          if (typeof loadAudiobooks === 'function') await loadAudiobooks();
          setShelfTab('audio'); renderAudioShelf();
          showToast(T('streamAddedN', { n: found.length }));
          openAudiobook(rec.id);
          return;
        }
        // аудио нет: настоящий .html-файл книги читаем как книгу, обычную веб-страницу — отвергаем
        if (!/\.(x?html?)$/i.test(name)) throw new Error(t('urlNoAudio'));
      }
    }
    const f = new File([got.blob], name, { type: got.blob.type || 'application/octet-stream' });
    urlBusy = false; dlRemove(job);              // закачка завершена — дальше книгу ведёт своя единица в очереди
    await doImport([f]);   // дальше как у обычного файла: дедуп, квота, тосты, перерисовка полки
  } catch (e) {
    dlRemove(job);
    if (!(job.cancelled || (e && e.name === 'AbortError'))) showToast(T('urlFail', { e: (e && e.message) || t('urlBlocked') }));
  } finally { urlBusy = false; dlRemove(job); }
}

// ══════════════════ очередь загрузок (сегмент «Загрузки» в левой панели) ══════════════════
// Показываем ЕДИНИЦЫ импорта (книга / аудиокнига из N файлов / ссылка), а не отдельные файлы.
// Отмена: очередную единицу убираем из очереди; текущую — прерываем (job.abort: fetch-abort или
// флаг cancelled, который проверяет цикл импорта аудиокниги между треками).
const DL_ICON = {
  book: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11a1 1 0 0 1 1 1v15H6a1 1 0 0 1-1-1z"/><path d="M9 4v16"/></svg>',
  audio: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.4"/><circle cx="16.5" cy="16" r="2.4"/></svg>',
  url: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
};
let dlJobs = [], dlSeq = 0;
function dlAdd(kind, title, count) {
  const j = { id: ++dlSeq, kind, title: title || '', count: count || 0, done: 0, frac: null, status: 'queued', cancelled: false, abort: null };
  dlJobs.push(j); renderDlList(); return j;
}
function dlRemove(j) { if (!j) return; dlJobs = dlJobs.filter(x => x !== j); renderDlList(); }
function dlCancel(id) {
  const j = dlJobs.find(x => x.id === +id); if (!j) return;
  j.cancelled = true;                        // активная аудиокнига увидит флаг между треками
  if (j.abort) { try { j.abort(); } catch {} }   // прервать текущую закачку
  dlRemove(j);
}
function renderDlList() {
  const list = $('#dl-list'); if (!list) return;
  const tab = $('#col-tab'); if (tab) tab.classList.toggle('has-dl', dlJobs.length > 0);
  if (!dlJobs.length) { list.innerHTML = `<div class="dl-empty">${esc(t('dlEmpty'))}</div>`; return; }
  list.innerHTML = dlJobs.map(j => {
    const det = j.status === 'active' && (j.frac != null || j.count > 1);
    const pct = j.frac != null ? Math.round(j.frac * 100) : (j.count ? Math.round(j.done / j.count * 100) : 0);
    const sub = j.status !== 'active' ? t('dlQueued')
      : j.count > 1 ? T('dlProgN', { i: j.done, n: j.count })
      : j.frac != null ? pct + '%' : t('dlWorking');
    return `<div class="dl-item"><span class="dl-ic">${DL_ICON[j.kind] || DL_ICON.book}</span>`
      + `<span class="dl-body"><span class="dl-name">${esc(j.title)}</span>`
      + `<span class="dl-sub">${esc(sub)}</span>`
      + `<span class="dl-bar${det ? '' : ' indet'}">${det ? `<i style="width:${pct}%"></i>` : '<i></i>'}</span></span>`
      + `<button class="dl-cancel" data-dlcancel="${j.id}" aria-label="${esc(t('dlCancel'))}">✕</button></div>`;
  }).join('');
}

let importBusy = false;
async function doImport(files) {
  if (importBusy || !files || !files.length) return;
  importBusy = true;
  let added = 0, addedAudio = 0;
  const archiveAudioSets = [];   // архивы с аудио: каждый → отдельная аудиокнига
  // аудиофайлы уходят отдельным путём: все выбранные разом = одна аудиокнига
  const audioFiles = files.filter(f => AUDIO_EXT.test(f.name) || (f.type || '').startsWith('audio/'));
  const bookFiles = files.filter(f => !audioFiles.includes(f));
  const seenKeys = new Set(state.books.map(bookKey));   // уже в библиотеке + добавленные в этот заход
  // единицы в очередь загрузок заводим заранее — видно всю очередь сверху вниз
  const bookJobs = bookFiles.map(f => dlAdd('book', f.name));
  const audioJob = audioFiles.length ? dlAdd('audio', rec_name(audioFiles), audioFiles.length) : null;
  for (let bi = 0; bi < bookFiles.length; bi++) {
    const file = bookFiles[bi], job = bookJobs[bi];
    if (job.cancelled) { dlRemove(job); continue; }
    job.status = 'active'; renderDlList();
    showProgress(T('importing', { n: file.name }), null);
    await new Promise(r => setTimeout(r, 60));   // даём тосту отрисоваться
    try {
      // файл синхры/копии — отдельный путь: умное слияние. Узнаём по началу файла;
      // сжатую копию (.json.gz) распознаём по её первым распакованным байтам
      const head = (await isGzipFile(file)) ? await gzipHead(file, 400) : await file.slice(0, 200).text();
      if (/"fmt"\s*:\s*"talewyn-(library|full|sync)"/.test(head)) {
        added += (await mergeImport(file)).added; dlRemove(job);
        continue;
      }
      const res = await (await importers()).importFile(file,
        frac => { job.frac = frac; renderDlList(); showProgress(T('importing', { n: file.name }), frac); });
      // архив с аудио — задача превращается в аудиокнигу (обработаем ниже, вместе с аудио)
      if (res && res.kind === 'audio-archive') {
        job.kind = 'audio'; job.count = (res.files || []).length; job.frac = null; job.status = 'queued'; renderDlList();
        archiveAudioSets.push({ set: res, job }); continue;
      }
      // архив может вернуть НЕСКОЛЬКО книг — нормализуем к списку
      const list = Array.isArray(res) ? res : [res];
      for (const data of list) {
        const key = bookKey(data);
        if (seenKeys.has(key)) { showToast(T('dupBook', { n: data.title })); continue; }
        seenKeys.add(key);
        await storeBook(data);
        added++;
        showToast(T('imported', { n: data.title }));
      }
      dlRemove(job);
    } catch (e) {
      dlRemove(job);
      // у QuotaExceededError пустое message — «Не получилось добавить книгу: » ни о чём
      // не говорит, а починить нехватку места человек как раз может
      if (isQuota(e)) { quotaToastAt = 0; quotaToast(); }
      else showToast(T('importFail', { n: file.name, e: e.message }));
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  // аудиокнига из набора аудиофайлов
  if (audioFiles.length && audioJob && !audioJob.cancelled) {
    audioJob.status = 'active'; renderDlList();
    showProgress(T('importing', { n: audioFiles[0].name }), null);
    await new Promise(r => setTimeout(r, 60));
    try {
      const rec = await importAudiobook(audioFiles,
        (frac, i) => { audioJob.frac = frac; audioJob.done = i; renderDlList(); showProgress(T('importing', { n: rec_name(audioFiles) }), frac); }, audioJob);
      addedAudio++;
      showToast(T('imported', { n: rec.title }));
    } catch (e) {
      if (!(e && e.cancelled)) {
        if (isQuota(e)) { quotaToastAt = 0; quotaToast(); }
        else showToast(T('importFail', { n: audioFiles[0].name, e: e.message }));
        await new Promise(r => setTimeout(r, 1200));
      }
    }
    dlRemove(audioJob);
  } else if (audioJob) dlRemove(audioJob);
  // аудиокниги из архивов: каждый архив — отдельная аудиокнига (все дорожки внутри = одна книга)
  for (const { set, job } of archiveAudioSets) {
    if (job.cancelled) { dlRemove(job); continue; }
    job.status = 'active'; renderDlList();
    showProgress(T('importing', { n: set.name }), null);
    await new Promise(r => setTimeout(r, 60));
    try {
      const rec = await importAudiobook(set.files,
        (frac, i) => { job.frac = frac; job.done = i; renderDlList(); showProgress(T('importing', { n: set.name }), frac); }, job);
      addedAudio++;
      showToast(T('imported', { n: rec.title }));
    } catch (e) {
      if (!(e && e.cancelled)) {
        if (isQuota(e)) { quotaToastAt = 0; quotaToast(); }
        else showToast(T('importFail', { n: set.name, e: e.message }));
        await new Promise(r => setTimeout(r, 1200));
      }
    }
    dlRemove(job);
  }
  importBusy = false;
  invalidateShelfData();
  if (added) {
    state.books = sortShelf(await dbAll('books'));
    if (!$('#shelf-view').hidden) renderShelf();
  }
  if (addedAudio) {
    await loadAudiobooks();
    renderAudioShelf();
    if (!$('#shelf-view').hidden) setShelfTab('audio');
  }
}
const rec_name = files => files.length > 1 ? (files.length + ' аудио') : files[0].name;

// ══════════════════ резервная копия библиотеки (.tlib) ══════════════════
// один JSON-файл: книги целиком (текст, картинки, обложки) + прогресс,
// заметки, отзывы и настройки. Восстановление докладывает недостающие
// книги на полку; уже имеющиеся (по id) не трогает.

const blobToB64 = blob => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1] || '');
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});
// байты → base64 без промежуточной data-URL строки (её FileReader делает на 33% длиннее самих данных)
function b64FromBytes(bytes) {
  let s = '';
  const CH = 0x8000;   // по 32К символов: apply не переваривает миллионы аргументов
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
const utf8B64 = str => b64FromBytes(new TextEncoder().encode(str));   // btoa сам кириллицу не берёт

// ── писатель копии: части уходят наружу ПО МЕРЕ появления, а не копятся до конца ──
// Раньше куски JSON складывались в массив строк и склеивались в Blob последней строкой:
// на библиотеке с аудио это означало всю копию в куче JS разом (и обрыв сохранения).
// Теперь на телефоне каждый кусок сразу уходит в файл через мост, в браузере — оседает
// в Blob (данные уходят из кучи в blob-хранилище). В памяти живёт только буфер.
const canGzip = () => typeof CompressionStream === 'function';
function createSink(name, opts) {
  const S = (name && isNativeApp() && window.AndroidSave && typeof window.AndroidSave.begin === 'function')
    ? window.AndroidSave : null;
  const native = !!(S && S.begin(name) === 'OK');
  const FLUSH = 512 * 1024;   // столько текста копим перед отправкой (мост зовём не на каждый чих)
  // Сжатие в том же потоке: копия ужимается примерно на треть (base64 избыточен ровно
  // настолько, а тексты книг жмутся вчетверо). Данные наружу уходят уже сжатыми кусками,
  // так что памяти это не добавляет. Нет CompressionStream — пишем как раньше, без сжатия.
  const gzip = !!(opts && opts.gzip) && canGzip();
  let buf = '', blobs = native ? null : [], done = false, gzErr = null;
  const emitBytes = bytes => {
    if (native) {
      if (S.chunk(b64FromBytes(bytes)) !== 'OK') throw new Error('запись в файл прервана');
    } else blobs.push(new Blob([bytes]));
  };
  let writer = null, pump = null;
  if (gzip) {
    const cs = new CompressionStream('gzip');
    writer = cs.writable.getWriter();
    pump = (async () => {                       // сжатые куски вычитываем по мере появления
      const rd = cs.readable.getReader();
      for (;;) {
        const { value, done: fin } = await rd.read();
        if (fin) break;
        try { emitBytes(value); } catch (e) { gzErr = e; try { await rd.cancel(); } catch {} break; }
      }
    })();
  }
  const flush = async () => {
    if (!buf) return;
    const s = buf; buf = '';
    if (gzip) {
      if (gzErr) throw gzErr;
      await writer.write(new TextEncoder().encode(s));
    } else if (native) {
      if (S.chunk(utf8B64(s)) !== 'OK') throw new Error('запись в файл прервана');
    } else blobs.push(new Blob([s]));
  };
  return {
    native, gzip,
    async text(s) {
      buf += s;
      if (buf.length >= FLUSH) { await flush(); await new Promise(r => setTimeout(r, 0)); }   // отдаём поток
    },
    // Blob → base64 прямо в поток, кусками. Кусок КРАТЕН 3 байтам: тогда base64 частей
    // склеивается встык, без padding-хвостов в середине строки.
    async blob64(blob) {
      const CH = 3 * 1024 * 1024;
      for (let off = 0; off < blob.size; off += CH) {
        const part = blob.slice(off, off + CH);
        const bytes = new Uint8Array(typeof part.arrayBuffer === 'function'
          ? await part.arrayBuffer()
          : await new Response(part).arrayBuffer());
        await this.text(b64FromBytes(bytes));
      }
    },
    async finish() {
      if (done) return { blob: null };
      done = true;
      await flush();
      if (gzip) {                        // дожимаем хвост и дожидаемся, пока всё уйдёт наружу
        await writer.close();
        await pump;
        if (gzErr) throw gzErr;
      }
      if (native) {
        const r = S.end();
        if (typeof r === 'string' && r.indexOf('OK') === 0) return { blob: null, where: r.slice(3) || name };
        throw new Error('файл не сохранился');
      }
      return { blob: new Blob(blobs, { type: gzip ? 'application/gzip' : 'application/json' }) };
    },
    abort() {
      if (done) return;
      done = true; buf = ''; blobs = null;
      if (gzip) { try { writer.abort(); } catch {} }
      if (native) { try { S.abort(); } catch {} }
    },
  };
}

function b64ToBlob(im) {
  try {
    const bytes = Uint8Array.from(atob(im.d || ''), c => c.charCodeAt(0));
    return bytes.length ? new Blob([bytes], { type: im.m || 'image/jpeg' }) : null;
  } catch { return null; }
}

// куски JSON копятся строками и склеиваются только внутри Blob —
// так большая библиотека не собирается в одну гигантскую строку
// ══════════════════ синхронизация: отпечатки и сбор состояния ══════════════════
// Книги сопоставляются между устройствами не по внутреннему id (он разный), а по отпечатку
// название|автор|число_глав. Лёгкая синхра несёт ТОЛЬКО состояние (без содержимого книг).
const syncKey = b => (b.title || '').trim().toLowerCase() + '|' + (b.author || '').trim().toLowerCase() + '|' + (b.count || 0);
const audioKey = a => (a.title || '').trim().toLowerCase() + '|' + (a.author || '').trim().toLowerCase();

async function bookState(b) {   // состояние одной книги (для лёгкой синхры и полной копии)
  const progress = {};
  for (const p of await dbAll('progress', bookRange(b.id))) progress[p.idx] = { position: p.position, percent: p.percent };
  return {
    key: syncKey(b), title: b.title, author: b.author || '', count: b.count || 0,
    last: (await kvGet('last:' + b.id)) ?? null,
    progress,
    review: (await kvGet('review:' + b.id)) || null,
    bookmarks: (await kvGet('bm:' + b.id)) || [],
    readSecs: (await kvGet('readSecs:' + b.id)) || 0,
    // заметки без id — на разных устройствах id разные, дедуп по содержимому (глава+границы+текст)
    notes: (await dbByIndex('notes', 'byBook', b.id)).map(n => ({ idx: n.idx, start: n.start, end: n.end, text: n.text, note: n.note || '', color: n.color, at: n.at || 0 })),
  };
}
async function audioState(a) {
  return {
    key: audioKey(a), title: a.title, author: a.author || '',
    aprog: (await kvGet('aprog:' + a.id)) || null,
    anotes: Array.isArray(a.notes) ? a.notes.map(n => ({ track: n.track, time: n.time, color: n.color, note: n.note || '', at: n.at || 0 })) : [],
  };
}
async function collectionsForSync(bookList, audioList) {   // членство по отпечаткам, не по id
  const bK = new Map(bookList.map(b => [b.id, syncKey(b)]));
  const aK = new Map(audioList.map(a => [a.id, audioKey(a)]));
  return (await dbAll('collections')).map(c => ({
    name: c.name, order: c.order || 0, createdAt: c.createdAt || 0,
    books: (c.items || []).filter(it => it.k === 'book' && bK.has(it.id)).map(it => bK.get(it.id)),
    audio: (c.items || []).filter(it => it.k === 'audio' && aK.has(it.id)).map(it => aK.get(it.id)),
    // записи каталога самодостаточны (снимок внутри) — переезжают как есть
    cat: (c.items || []).filter(it => it.k === 'cat'),
  }));
}
const statsForSync = async () => ({ readDays: (await kvGet('readDays')) || {}, words: (await kvGet('stat:words')) || 0, secs: (await kvGet('stat:secs')) || 0 });

// ЛЁГКАЯ синхра — только состояние (килобайты): для частого переноса телефон↔iPhone
// ── что класть в файл: книги и/или аудиокниги (обе галочки по умолчанию) ──
// Возвращает {books, audio} или null, если человек передумал.
let syncPickResolve = null, syncPickHideT = 0;
// trigSel — кнопка, которая открыла окно: пока идёт выбор, она выглядит нажатой (.sheet-on),
// как кнопки настроек, — чтобы было видно, ЧТО именно сохраняешь
function askSyncScope(trigSel) {
  const box = $('#sync-pick'); if (!box) return Promise.resolve({ books: true, audio: true });
  document.querySelectorAll('#sync-light-btn, #backup-btn').forEach(b => b.classList.remove('sheet-on'));
  if (trigSel) document.querySelectorAll(trigSel).forEach(b => b.classList.add('sheet-on'));
  const bB = $('#sync-pick-books'), bA = $('#sync-pick-audio');
  bB.classList.add('on'); bA.classList.add('on');   // по умолчанию сохраняем всё
  if (syncPickResolve) { const r = syncPickResolve; syncPickResolve = null; r(null); }
  clearTimeout(syncPickHideT);   // иначе таймер прошлого закрытия спрячет только что открытое окно
  box.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('open')));
  return new Promise(resolve => { syncPickResolve = resolve; });
}
function closeSyncPick(res) {
  const box = $('#sync-pick'); if (!box) return;
  document.querySelectorAll('#sync-light-btn, #backup-btn').forEach(b => b.classList.remove('sheet-on'));
  box.classList.remove('open');
  clearTimeout(syncPickHideT);
  syncPickHideT = setTimeout(() => { box.hidden = true; }, 360);
  if (syncPickResolve) { const r = syncPickResolve; syncPickResolve = null; r(res); }
}
$('#sync-pick-books')?.addEventListener('click', e => e.currentTarget.classList.toggle('on'));
$('#sync-pick-audio')?.addEventListener('click', e => e.currentTarget.classList.toggle('on'));
$('#sync-pick-cancel')?.addEventListener('click', () => closeSyncPick(null));
$('#sync-pick-ok')?.addEventListener('click', () => {
  const books = $('#sync-pick-books').classList.contains('on');
  const audio = $('#sync-pick-audio').classList.contains('on');
  if (!books && !audio) { showToast(t('syncPickNone')); return; }   // пустой файл делать незачем
  closeSyncPick({ books, audio });
});
$('#sync-pick')?.addEventListener('click', e => { if (!e.target.closest('.col-modal-box')) closeSyncPick(null); });

async function buildSync(scope) {
  const want = scope || { books: true, audio: true };
  const books = want.books ? await dbAll('books') : [];
  const audio = want.audio ? await dbAll('audiobooks') : [];
  const out = {
    fmt: 'talewyn-sync', ver: 2, app: APP_VERSION, created: Date.now(),
    books: [], audio: [],
    collections: await collectionsForSync(books, audio),
    stats: await statsForSync(),
    pronun: Array.isArray(settings.pronun) ? settings.pronun : [],
  };
  for (const b of books) out.books.push(await bookState(b));
  for (const a of audio) out.audio.push(await audioState(a));
  return new Blob([JSON.stringify(out)], { type: 'application/json' });
}
// сохранение файла: на устройстве (WebView) браузерное <a download> blob НЕ сохраняет —
// пишем поток прямо в папку «Загрузки» кусками (begin → chunk×N → end), размер не ограничен.
// Возвращает { how:'saved', where } (файл в «Загрузках») или { how:'download' } (браузер).
async function nativeSaveToDownloads(blob, name) {
  const S = window.AndroidSave;
  if (!isNativeApp() || !S || typeof S.begin !== 'function') return null;
  try {
    if (S.begin(name) !== 'OK') return null;
    const CH = 256 * 1024;   // срез base64-им независимо; склейка декодированных байт корректна
    for (let off = 0; off < blob.size; off += CH) {
      const b64 = await blobToB64(blob.slice(off, off + CH));
      if (S.chunk(b64) !== 'OK') { try { S.abort(); } catch {} return null; }
    }
    const r = S.end();
    if (typeof r === 'string' && r.indexOf('OK') === 0) return r.slice(3) || name;
    try { S.abort(); } catch {}
    return null;
  } catch { try { S.abort(); } catch {} return null; }
}
function webSaveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function downloadBlob(blob, name) {
  const where = await nativeSaveToDownloads(blob, name);
  if (where) return { how: 'saved', where };
  webSaveBlob(blob, name);
  return { how: 'download' };
}
window.__saveError = () => { try { showToast(T('backupFail', { e: '' })); } catch {} };
const stampName = (prefix, ext) => {
  const d = new Date();
  return prefix + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ext;
};
async function exportSync() {
  if (backupBusy) return;
  const scope = await askSyncScope('#sync-light-btn');
  if (!scope) return;                    // передумал
  backupBusy = true;
  try {
    const blob = await buildSync(scope);
    const name = stampName('talewyn-sync-', '.json');
    const r = await downloadBlob(blob, name);
    showToast(t(r.how === 'saved' ? 'syncSavedTo' : 'syncSaved'));
  } catch (e) { showToast(T('backupFail', { e: e.message })); }
  finally { backupBusy = false; }
}

// Копия пишется ПОТОКОМ: содержимое книги/дорожки уходит в файл сразу, кусками.
// В памяти одновременно живут только текущий кусок (3 МБ) и буфер писателя, поэтому
// размер библиотеки больше ничего не решает — гигабайты аудио проходят так же, как мегабайты.
async function backupWrite(sink, scope) {
  const want = scope || { books: true, audio: true };
  const books = want.books ? sortShelf(await dbAll('books')) : [];
  const audiobooks = want.audio ? sortShelf(await dbAll('audiobooks')) : [];
  const head = {
    fmt: 'talewyn-library', ver: 1, app: APP_VERSION, created: Date.now(),
    settings,
    ttsBase: localStorage.getItem('talewyn-tts-base') || null,
    lastBook: (await kvGet('lastBook')) || null,
    collections: await dbAll('collections'),   // свои полки
  };
  await sink.text(JSON.stringify(head).slice(0, -1) + ',"books":[');
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    showToast(T('backupPrep', { n: b.title }));
    await new Promise(r => setTimeout(r, 0));
    if (i) await sink.text(',');
    await writeBookRec(sink, b);
  }
  // Аудиокниги — ЦЕЛИКОМ: дорожки, обложка, описание плюс состояние (прогресс и заметки).
  await sink.text('],"audio":[');
  for (let i = 0; i < audiobooks.length; i++) {
    const a = audiobooks[i];
    showToast(T('backupPrep', { n: a.title }));
    await new Promise(r => setTimeout(r, 0));
    if (i) await sink.text(',');
    await writeAudioRec(sink, a);
  }
  await sink.text(']}');
}

// одна книга: сначала лёгкие поля, затем главы, затем картинки — каждая своим потоком байт
async function writeBookRec(sink, b) {
  const progress = {};
  for (const p of await dbAll('progress', bookRange(b.id)))
    progress[p.idx] = { position: p.position, percent: p.percent };
  const rec = {
    id: b.id, title: b.title, author: b.author || '', lang: b.lang || '',
    annotation: b.annotation || '', addedAt: b.addedAt, toc: b.toc,
    year: b.year ?? null, genre: b.genre || '',   // иначе год, заданный руками, терялся при переносе
    cover: b.cover ? { m: b.cover.type || '', d: await blobToB64(b.cover) } : null,
    origCover: b.origCover ? { m: b.origCover.type || '', d: await blobToB64(b.origCover) } : null,
    last: (await kvGet('last:' + b.id)) ?? null,
    review: (await kvGet('review:' + b.id)) || null,
    expanded: safeParse('talewyn-expanded:' + b.id, null, Array.isArray),
    progress,
    notes: await dbByIndex('notes', 'byBook', b.id),
  };
  await sink.text(JSON.stringify(rec).slice(0, -1));   // без закрывающей скобки — дописываем ниже
  const chapters = (await dbAll('chapters', bookRange(b.id)))
    .sort((x, y) => x.idx - y.idx)
    .map(c => ({ title: c.title, html: c.html, plain: c.plain }));
  await sink.text(',"chapters":' + JSON.stringify(chapters));
  await sink.text(',"images":{');
  let first = true;
  // getAll отдаёт записи со ССЫЛКАМИ на блобы — байты читаются только внутри blob64,
  // по 3 МБ за раз. Поэтому книга с сотнями страниц-картинок (PDF, комикс) не разворачивается в память.
  for (const im of await dbAll('images', bookRange(b.id))) {
    if (!im.blob) continue;
    await sink.text((first ? '' : ',') + JSON.stringify(im.name)
      + ':{"m":' + JSON.stringify(im.blob.type || '') + ',"d":"');
    await sink.blob64(im.blob);
    await sink.text('"}');
    first = false;
  }
  await sink.text('}}');
}

// одна аудиокнига: состояние + метаданные, затем дорожки по одной
async function writeAudioRec(sink, a) {
  const rec = await audioState(a);            // прогресс и заметки — как в лёгкой синхронизации
  rec.meta = {
    title: a.title, author: a.author || '', tracks: a.tracks || [],
    count: a.count || (a.tracks || []).length, totalDur: a.totalDur || 0,
    addedAt: a.addedAt || Date.now(), notes: Array.isArray(a.notes) ? a.notes : [],
    cover: a.cover ? { m: a.cover.type || '', d: await blobToB64(a.cover) } : null,
  };
  await sink.text(JSON.stringify(rec).slice(0, -1));
  await sink.text(',"trackBlobs":[');
  let first = true;
  for (const tr of (await dbAll('audiotracks', bookRange(a.id))).sort((x, y) => x.idx - y.idx)) {
    if (!tr.blob) continue;                   // стрим по ссылке: дорожка живёт по url, файла нет
    await sink.text((first ? '' : ',') + '{"idx":' + (+tr.idx || 0)
      + ',"m":' + JSON.stringify(tr.blob.type || '') + ',"d":"');
    await sink.blob64(tr.blob);
    await sink.text('"}');
    first = false;
  }
  await sink.text(']}');
}

// собрать копию в Blob (браузерный путь и самопроверка) — тем же писателем, без моста
async function buildBackup(scope) {
  const sink = createSink(null);
  await backupWrite(sink, scope);
  return (await sink.finish()).blob;
}

let backupBusy = false;
async function exportLibrary() {
  if (backupBusy || !(state.books.length || (state.audiobooks || []).length)) return;
  const scope = await askSyncScope('#backup-btn');
  if (!scope) return;
  backupBusy = true;
  // .json.gz — копия сжимается на лету (примерно −30% к весу файла); на старом движке
  // без CompressionStream сохраняем как раньше, обычным .json
  const gz = canGzip();
  const name = stampName('talewyn-backup-', gz ? '.json.gz' : '.json');
  const sink = createSink(name, { gzip: gz });   // на телефоне пишет прямо в «Загрузки», в браузере копит Blob
  try {
    await backupWrite(sink, scope);
    const r = await sink.finish();
    if (r.blob) webSaveBlob(r.blob, name);
    showToast(t(r.blob ? 'backupDone' : 'backupSavedTo'));
  } catch (e) {
    sink.abort();   // недописанный файл не оставляем: он всё равно не восстановится
    showToast(T('backupFail', { e: e.message }));
  } finally {
    backupBusy = false;
  }
}

// добавить книгу из полной/старой копии — ТОЛЬКО содержимое и запись книги; состояние
// (прогресс/заметки/закладки/оценка) накладывает потом mergeBookState (дедуп по содержимому)
async function restoreBook(b, id) {
  const chapters = (b.chapters || []).map((c, idx) => ({
    book: id, idx, title: c.title || 'Глава ' + (idx + 1), html: c.html || '', plain: c.plain || '',
  }));
  if (!chapters.length) throw new Error('нет глав');
  await dbChunk('chapters', chapters);
  await dbChunk('images', Object.entries(b.images || {})
    .map(([name, im]) => ({ book: id, name, blob: b64ToBlob(im) })).filter(r => r.blob));
  if (Array.isArray(b.expanded)) localStorage.setItem('talewyn-expanded:' + id, JSON.stringify(b.expanded));
  await dbPut('books', {
    id, title: b.title || 'Без названия', author: b.author || '',
    lang: b.lang || '', annotation: String(b.annotation || '').slice(0, 2000),
    year: Number.isFinite(+b.year) && +b.year > 1000 ? +b.year : null, genre: b.genre || '',
    addedAt: b.addedAt || Date.now(),
    cover: b.cover ? b64ToBlob(b.cover) : null, origCover: b.origCover ? b64ToBlob(b.origCover) : null,
    toc: Array.isArray(b.toc) && b.toc.length ? b.toc : chapters.map((c, i) => ({ t: c.title, ch: i })),
    count: chapters.length, titles: chapters.map(c => c.title),
    chWords: Array.isArray(b.chWords) ? b.chWords : undefined,
  });
}
async function restoreAudiobook(a) {
  const id = newId('ab'); const m = a.meta || {};
  const tracks = (a.trackBlobs || []).map(tb => ({ book: id, idx: tb.idx, blob: b64ToBlob(tb) })).filter(t => t.blob);
  // аудиокнига по ссылке: файлов нет, дорожки живут по адресу в сети — восстанавливаем запись
  // как есть, иначе такие книги молча пропадали при восстановлении
  const byUrl = Array.isArray(m.tracks) && m.tracks.some(x => x && x.url);
  if (!tracks.length && !byUrl) return null;
  if (tracks.length) await dbChunk('audiotracks', tracks);
  await dbPut('audiobooks', {
    id, kind: 'audiobook', title: m.title || a.title || 'Аудиокнига', author: m.author || a.author || '',
    cover: m.cover ? b64ToBlob(m.cover) : null,
    tracks: Array.isArray(m.tracks) ? m.tracks : tracks.map(t => ({ title: 'Дорожка ' + (t.idx + 1), dur: 0 })),
    count: m.count || tracks.length, totalDur: m.totalDur || 0, addedAt: m.addedAt || Date.now(),
    notes: Array.isArray(m.notes) ? m.notes : [],
  });
  return id;
}

// ── слияние состояния (НЕ перезапись): прогресс max, заметки/закладки объединяем, оценка новее ──
async function mergeBookState(id, e) {
  const cur = {};
  for (const p of await dbAll('progress', bookRange(id))) cur[p.idx] = p;
  const rows = [];
  for (const idx in (e.progress || {})) {
    const ip = Math.min(1, Math.max(0, +e.progress[idx].percent || 0));
    const ipos = Math.min(1, Math.max(0, +e.progress[idx].position || 0));
    const c = cur[+idx];
    if (!c || ip > (c.percent || 0)) rows.push({ book: id, idx: +idx, position: ipos, percent: ip });
  }
  if (rows.length) await dbChunk('progress', rows);
  if (typeof e.last === 'number' && (await kvGet('last:' + id)) == null) await kvSet('last:' + id, e.last);
  if (e.review) { const cr = await kvGet('review:' + id); if (!cr || (e.review.at || 0) > (cr.at || 0)) await kvSet('review:' + id, e.review); }
  if (e.readSecs) { const cs = (await kvGet('readSecs:' + id)) || 0; if (e.readSecs > cs) await kvSet('readSecs:' + id, e.readSecs); }
  if (Array.isArray(e.bookmarks) && e.bookmarks.length) {
    const arr = (await kvGet('bm:' + id)) || [];
    const sig = x => x.idx + ':' + Math.round((x.position || 0) * 1000);
    const have = new Set(arr.map(sig)); let ch = false;
    for (const x of e.bookmarks) if (!have.has(sig(x))) { arr.push({ id: newId('bm'), idx: x.idx, position: x.position, title: x.title || '', at: x.at || Date.now() }); have.add(sig(x)); ch = true; }
    if (ch) { arr.sort((a, b) => a.idx - b.idx || a.position - b.position); await kvSet('bm:' + id, arr); }
  }
  const en = e.notes || [];
  if (en.length) {
    const cur2 = await dbByIndex('notes', 'byBook', id);
    const sig = n => n.idx + '|' + n.start + '|' + n.end + '|' + (n.text || '');
    const have = new Set(cur2.map(sig)); const add = [];
    for (const n of en) { const s = sig(n); if (!have.has(s)) { have.add(s); add.push({ id: newId('n'), book: id, idx: n.idx, start: n.start, end: n.end, text: n.text || '', note: n.note || '', color: n.color || 'y', at: n.at || Date.now() }); } }
    if (add.length) await dbChunk('notes', add);
  }
}
async function mergeAudioState(id, e) {
  if (e.aprog) { const c = await kvGet('aprog:' + id); if (!c || e.aprog.idx > c.idx || (e.aprog.idx === c.idx && (e.aprog.position || 0) > (c.position || 0))) await kvSet('aprog:' + id, e.aprog); }
  if (Array.isArray(e.anotes) && e.anotes.length) {
    const rec = await dbGet('audiobooks', id); if (!rec) return;
    const arr = Array.isArray(rec.notes) ? rec.notes : [];
    const sig = n => n.track + ':' + Math.round(n.time || 0);
    const have = new Set(arr.map(sig)); let ch = false;
    for (const n of e.anotes) if (!have.has(sig(n))) { arr.push({ id: newId('an'), track: n.track, time: n.time, color: n.color || 'y', note: n.note || '', at: n.at || Date.now() }); have.add(sig(n)); ch = true; }
    if (ch) { rec.notes = arr; await dbPut('audiobooks', rec); }
  }
}
async function mergeStats(s) {
  if (!s) return;
  if (s.readDays && typeof s.readDays === 'object') {
    const cur = (await kvGet('readDays')) || {};
    for (const d in s.readDays) cur[d] = Math.max(cur[d] || 0, +s.readDays[d] || 0);
    await kvSet('readDays', cur);
  }
  if ((+s.secs || 0) > ((await kvGet('stat:secs')) || 0)) { await kvSet('stat:secs', +s.secs || 0); await kvSet('stat:words', +s.words || 0); }
}
function mergePronun(p) {
  if (!Array.isArray(p) || !p.length) return;
  if (!Array.isArray(settings.pronun)) settings.pronun = [];
  const have = new Set(settings.pronun.map(x => (x.from || '').toLowerCase()));
  let ch = false;
  for (const x of p) { const f = (x.from || '').trim(); if (f && x.to && !have.has(f.toLowerCase())) { settings.pronun.push({ from: f, to: String(x.to), lang: x.lang || '' }); have.add(f.toLowerCase()); ch = true; } }
  if (ch) saveSettings();
}
async function mergeCollectionsFromSync(cols) {
  if (!Array.isArray(cols) || !cols.length) return;
  const bByKey = new Map((await dbAll('books')).map(b => [syncKey(b), b.id]));
  const aByKey = new Map((await dbAll('audiobooks')).map(a => [audioKey(a), a.id]));
  await loadCollections();
  await loadFolders();
  const byName = new Map((state.collections || []).map(c => [(c.name || '').trim().toLowerCase(), c]));
  let maxOrder = (state.collections || []).reduce((m, c) => Math.max(m, c.order || 0), 0);
  for (const c of cols) {
    if (!c || !c.name) continue;
    let local = byName.get(c.name.trim().toLowerCase());
    if (!local) { local = { id: newId('col'), name: c.name, order: ++maxOrder, createdAt: c.createdAt || Date.now(), items: [] }; byName.set(c.name.trim().toLowerCase(), local); }
    const have = new Set((local.items || []).map(it => it.k + ':' + it.id));
    for (const k of (c.books || [])) { const id = bByKey.get(k); if (id && !have.has('book:' + id)) { local.items.push({ k: 'book', id }); have.add('book:' + id); } }
    for (const k of (c.audio || [])) { const id = aByKey.get(k); if (id && !have.has('audio:' + id)) { local.items.push({ k: 'audio', id }); have.add('audio:' + id); } }
    for (const it of (c.cat || [])) { if (it && it.id && !have.has('cat:' + it.id)) { local.items.push(it); have.add('cat:' + it.id); } }
    await dbPut('collections', local);
  }
  await loadCollections();
  await loadFolders();
}

// ══════════ УМНЫЙ импорт-слияние: лёгкая синхра / полная копия / старая копия ══════════
// Книги сопоставляются по отпечатку. Новые (с содержимым) — добавляем; существующим —
// СЛИВАЕМ состояние без дублей и без перезаписи. Старый формат talewyn-library тоже принимаем.
// Большую копию нельзя читать целиком: 540 МБ текста разворачиваются в памяти примерно в
// гигабайт (строки двухбайтные), а JSON.parse строит поверх ещё столько же объектов — телефон
// этого не переживает. Поэтому читаем файл потоком и выдаём записи книг/аудиокниг ПО ОДНОЙ:
// разобрал запись → положил в базу → забыл. В памяти живёт только текущая книга.
// Разбор простой: мы сами пишем этот файл, структура известна — "books":[…] и следом "audio":[…].
// ── сжатые копии (.json.gz) ──
// Формат узнаём по первым двум байтам, а не по имени файла: переименованный или
// пришедший из мессенджера файл всё равно откроется правильно.
async function isGzipFile(file) {
  try {
    const s = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    return s.length === 2 && s[0] === 0x1f && s[1] === 0x8b;
  } catch { return false; }
}
// начало распакованного содержимого — чтобы понять, наша ли это копия, не разжимая файл целиком
async function gzipHead(file, n) {
  try {
    const rd = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const { value } = await rd.read();
    try { await rd.cancel(); } catch {}
    return value ? new TextDecoder().decode(value.slice(0, n)) : '';
  } catch { return ''; }
}

async function streamRecords(file, onHead, onBook, onAudio, onProgress, gz) {
  // прогресс считаем по СЖАТЫМ байтам: только их размер известен заранее (file.size)
  let readRaw = 0;
  let src = file.stream();
  if (gz) {
    src = src.pipeThrough(new TransformStream({
      transform(chunk, ctrl) { readRaw += chunk.length; ctrl.enqueue(chunk); },
    })).pipeThrough(new DecompressionStream('gzip'));
  }
  const rd = src.getReader();
  const dec = new TextDecoder();
  let buf = '', mode = 'head', done = false, read = 0;
  // выделить из буфера очередной объект верхнего уровня; вернуть его текст или null (мало данных)
  const takeObject = () => {
    let i = 0;
    while (i < buf.length && (buf[i] === ',' || buf[i] === ' ' || buf[i] === '\n' || buf[i] === '\r')) i++;
    if (i >= buf.length) return null;
    if (buf[i] === ']') { buf = buf.slice(i + 1); return ']'; }        // конец массива
    if (buf[i] !== '{') { buf = buf.slice(i + 1); return null; }
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < buf.length; k++) {
      const c = buf[k];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (!depth) { const s = buf.slice(i, k + 1); buf = buf.slice(k + 1); return s; }
      }
    }
    return null;   // объект ещё не дочитан
  };
  while (!done) {
    const { value, done: fin } = await rd.read();
    if (value) { read += value.length; buf += dec.decode(value, { stream: true }); }
    if (fin) { buf += dec.decode(); done = true; }
    if (onProgress && file.size) onProgress(Math.min(1, (gz ? readRaw : read) / file.size));
    for (;;) {
      if (mode === 'head') {
        const at = buf.indexOf('"books":[');
        if (at < 0) break;
        await onHead(buf.slice(0, at) + '"books":[]}');   // голова = всё до книг, закрываем скобками
        buf = buf.slice(at + '"books":['.length);
        mode = 'books';
        continue;
      }
      if (mode === 'books' || mode === 'audio') {
        const s = takeObject();
        if (s === null) break;
        if (s === ']') {
          if (mode === 'books') {
            const at = buf.indexOf('"audio":[');
            if (at < 0 && !done) break;                  // ждём, пока подтянется секция аудио
            if (at < 0) { mode = 'end'; continue; }
            buf = buf.slice(at + '"audio":['.length);
            mode = 'audio';
          } else mode = 'end';
          continue;
        }
        let rec = null;
        try { rec = JSON.parse(s); } catch { continue; }
        if (mode === 'books') await onBook(rec); else await onAudio(rec);
        continue;
      }
      break;
    }
    if (mode === 'end') break;
  }
  try { await rd.cancel(); } catch {}
}

// ЕДИНСТВЕННЫЙ путь восстановления: файл читается потоком, записи приходят по одной.
// Раньше путей было два — потоковый для больших файлов и «прочитать целиком» для мелких, —
// с почти одинаковой логикой слияния. Правку в одном месте регулярно забывали продублировать
// во втором (так и случилось с аудиокнигами при восстановлении), поэтому путь оставлен один.
async function mergeImport(file) {
  // объект без потока (так копию подаёт самопроверка) заворачиваем в Blob — дальше всё одинаково
  const src = typeof file.stream === 'function' ? file
    : new Blob([await file.text()], { type: 'application/json' });
  const gz = typeof src.slice === 'function' && await isGzipFile(src);
  const byKey = new Map((await dbAll('books')).map(b => [syncKey(b), b.id]));
  const aByKey = new Map((await dbAll('audiobooks')).map(a => [audioKey(a), a.id]));
  const wasEmpty = !state.books.length;
  let added = 0, merged = 0, missing = 0, head = null, pct = -1;
  const bad = () => { const e = new Error(t('notBackup')); e.fatal = true; return e; };
  await streamRecords(src,
    async txt => {
      try { head = JSON.parse(txt); } catch { throw bad(); }
      if (!head || !/^talewyn-(sync|full|library)$/.test(head.fmt || '')) throw bad();
    },
    async b => {
      const key = b.key || syncKey({ title: b.title, author: b.author, count: (b.chapters ? b.chapters.length : b.count) || 0 });
      const id = byKey.get(key);
      if (id) { await mergeBookState(id, b); merged++; }
      else if (b.chapters) {   // есть содержимое → заводим книгу и накладываем состояние
        const nid = newId('b');
        try { await restoreBook(b, nid); await mergeBookState(nid, b); byKey.set(key, nid); added++; } catch {}
      } else missing++;        // лёгкая синхра — книги нет локально, класть некуда
    },
    async a => {
      const key = a.key || audioKey(a);
      const id = aByKey.get(key);
      if (id) { await mergeAudioState(id, a); merged++; }
      else if ((Array.isArray(a.trackBlobs) && a.trackBlobs.length) || a.meta) {
        const nid = await restoreAudiobook(a);   // с файлами или по ссылке
        if (nid) { await mergeAudioState(nid, a); aByKey.set(key, nid); added++; } else missing++;
      } else missing++;
    },
    frac => {   // на большом файле человек должен видеть, что идёт работа, а не гадать
      const p = Math.round(frac * 100);
      if (p !== pct) { pct = p; showProgress(T('restorePct', { p }), frac); }
    }, gz);
  await mergeCollectionsFromSync(head && head.collections);
  await mergeStats(head && head.stats);
  mergePronun(head && (Array.isArray(head.pronun) ? head.pronun : (head.settings && head.settings.pronun)));
  // настройки принимаем только на пустую библиотеку и только из нового формата
  if (wasEmpty && added && head && head.fmt !== 'talewyn-library' && head.settings
      && typeof head.settings === 'object' && !Array.isArray(head.settings)) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(head.settings));
    Object.assign(settings, loadSettings()); applySettings();
    if (typeof head.ttsBase === 'string' && head.ttsBase) localStorage.setItem('talewyn-tts-base', head.ttsBase);
  }
  return await finishImport(added, merged, missing);
}

// финал восстановления:
// перечитать библиотеку, перерисовать что открыто и сказать человеку итог
async function finishImport(added, merged, missing) {
  invalidateShelfData();
  state.books = sortShelf(await dbAll('books'));
  // ВАЖНО: перерисовываем полку и прогресс — иначе слитый прогресс не виден до перезапуска
  // (частый случай: книги не добавлялись, только обновлялись — раньше UI не обновлялся вовсе)
  try { await loadCollections(); } catch {}
  try { if (typeof loadAudiobooks === 'function') await loadAudiobooks(); } catch {}
  if (!$('#shelf-view').hidden) {
    try { await renderShelf(); } catch {}
    try { if (typeof renderAudioShelf === 'function') renderAudioShelf(); } catch {}
  }
  if (state.book) {   // открыта книга — перечитать её прогресс из базы
    try {
      const map = {};
      for (const r of await dbAll('progress', bookRange(state.book.id))) map[r.idx] = { position: r.position, percent: r.percent };
      state.progress.map = map;
      if (typeof renderContinue === 'function') renderContinue();
      if (typeof renderToc === 'function') renderToc();
      if (typeof renderFooter === 'function') renderFooter();
    } catch {}
  }
  // человеко-читаемый итог, без «+0» и жаргона
  const parts = [];
  if (added) parts.push(T('syncResAdd', { n: added }));
  if (merged) parts.push(T('syncResUpd', { n: merged }));
  if (!parts.length) parts.push(t('syncResNone'));
  let msg = t('syncResHead') + ': ' + parts.join(', ');
  if (missing) msg += '. ' + T('syncMissing', { x: missing });
  showToast(msg);
  return { added, merged, missing };
}

// ══════════════════ оглавление книги ══════════════════
const pctOf = idx => (state.progress.map[idx] ? state.progress.map[idx].percent : 0);
const isRead = idx => pctOf(idx) >= 0.98;

function chStatusHtml(idx) {
  const pct = pctOf(idx);
  if (pct >= 0.98)
    return ['read', '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'];
  if (pct > 0.02)
    return ['progress', `<span class="pct">${Math.round(pct * 100)}</span>`];
  return ['', ''];
}

const CHEV = '<svg class="chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

// Бегущая строка: если текст не влезает, он проезжает и повторяет цикл каждые 5 секунд.
// Таймеры держим НА САМОМ элементе, а не в общей переменной: строк теперь две (крошки
// читалки и название трека в плеере), и они не должны глушить друг друга.
function setMarquee(el, text) {
  if (!el) return;
  cancelMarquee(el);
  el.classList.remove('marquee');
  el.innerHTML = '<span class="crumbs-track"></span>';
  const track = el.firstChild;
  track.textContent = text;
  requestAnimationFrame(() => {
    const overflow = track.scrollWidth - el.clientWidth;
    if (overflow <= 4) return;                 // помещается — статично, по центру
    el.classList.add('marquee');
    const scrollMs = Math.max(2200, (overflow / 45) * 1000);
    const push = t => { (el._mqTimers = el._mqTimers || []).push(t); };
    const cycle = () => {
      track.style.transition = 'none';
      track.style.transform = 'translateX(0)';
      push(setTimeout(() => {
        track.style.transition = `transform ${scrollMs}ms linear`;
        track.style.transform = `translateX(${-overflow}px)`;
        push(setTimeout(() => push(setTimeout(cycle, 5000)), scrollMs));   // доехал → пауза 5с → снова
      }, 900));
    };
    cycle();
  });
}
function cancelMarquee(el) {
  if (!el || !el._mqTimers) return;
  el._mqTimers.forEach(clearTimeout);
  el._mqTimers = [];
}
// крошки читалки (раздел · том · глава)
function cancelCrumbs() { cancelMarquee($('#reader-crumbs')); }
function setCrumbs(text) { setMarquee($('#reader-crumbs'), text); }
function chapterRowHtml(idx, title, cur) {
  const [cls, icon] = chStatusHtml(idx);
  return `<button class="ch-row ${cls}${idx === cur ? ' current' : ''}" data-ch="${idx}">
    <span class="ch-name">${esc(title)}</span><span class="ch-status" title="${t('chTip')}">${icon}</span></button>`;
}

function renderToc() {
  const cur = state.chapter ? state.chapter.idx : state.progress.last;
  const depth0HasGroups = state.toc.some(n => n.kids);
  function nodesHtml(nodes, depth) {
    return nodes.map(n => {
      if (!n.kids) return chapterRowHtml(n.ch, n.t, cur);
      const ids = chaptersUnder(n);
      const read = ids.filter(isRead).length;
      const cls = depth === 0 ? 'part-summary' : 'vol-summary';
      return `<details data-k="${n._k}"${expanded.has(n._k) ? ' open' : ''} style="--d:${depth}">
        <summary class="${cls}">${CHEV}<span>${esc(n.t)}</span>
          <span class="count-badge${read === ids.length && ids.length ? ' done' : ''}" title="${t('volTip')}">${read}/${ids.length}</span>
        </summary>${nodesHtml(n.kids, depth + 1)}</details>`;
    }).join('');
  }
  $('#toc').classList.toggle('flat-toc', !depth0HasGroups);
  $('#toc').innerHTML = nodesHtml(state.toc, 0);
}

function continueTarget() {
  const lastIdx = state.progress.last;
  if (lastIdx == null || !state.byIdx.has(lastIdx))
    return state.flat[0] ? { t: state.flat[0], key: 'start' } : null;
  if (pctOf(lastIdx) >= 0.98) {
    const i = state.flat.findIndex(c => c.idx === lastIdx);
    const next = state.flat[i + 1];
    if (next && pctOf(next.idx) < 0.98) return { t: next, key: 'nextCh' };
  }
  return { t: state.byIdx.get(lastIdx), key: 'cont' };
}

function renderContinue() {
  const box = $('#continue-card');
  const target = continueTarget();
  if (!target) { box.innerHTML = ''; return; }
  const started = target.key !== 'start';
  const pct = Math.round(pctOf(target.t.idx) * 100);
  box.innerHTML = `<button class="cont-card" data-ch="${target.t.idx}">
    <div class="cont-eyebrow">${t(target.key)}</div>
    <div class="cont-title">${esc(target.t.title)}</div>
    <div class="cont-sub">${esc(target.t.crumb || state.book.title)}${started ? ` · ${pct}%` : ''}</div>
    ${started ? `<div class="cont-track"><div class="cont-fill" style="width:${pct}%"></div></div>` : ''}
  </button>`;
}

function renderChips() {
  const bar = $('#part-chips');
  const groups = state.toc.filter(n => n.kids);
  if (groups.length < 2) { bar.hidden = true; return; }
  bar.hidden = false;
  const cur = state.progress.last;
  const shorten = s => {
    s = s.replace(/\s*\(.*\)\s*/, '');
    return s.length > 20 ? s.slice(0, 19).trimEnd() + '…' : s;
  };
  bar.innerHTML = (cur != null ? `<button class="chip accent" data-goto-current>➤ ${t('reading')}</button>` : '')
    + groups.map(p =>
      `<button class="chip" data-part="${p._k}">${esc(shorten(p.t))}</button>`).join('');
}

function gotoCurrent() {
  const item = state.progress.last != null && state.byIdx.get(state.progress.last);
  if (!item) return;
  for (const k of item.groups) expanded.add(k);
  localStorage.setItem(expandedKey(), JSON.stringify([...expanded]));
  renderToc();
  const row = document.querySelector(`.ch-row[data-ch="${item.idx}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  row.addEventListener('animationend', () => row.classList.remove('flash'), { once: true });
}

function renderFooter() {
  const total = state.flat.length;
  const read = state.flat.filter(c => isRead(c.idx)).length;
  const pct = total ? Math.round(read / total * 100) : 0;
  $('#lib-footer').innerHTML = total
    ? `<div class="cont-track"><div class="cont-fill" style="width:${pct}%"></div></div>
       <p>${T('footer', { r: read, t: total, p: pct })}</p>`
    : '';
}

function enterView(el) {
  el.classList.remove('view-enter');
  void el.offsetWidth;
  el.classList.add('view-enter');
}

// «подвижный» заголовок: длинное название ужимается по кеглю до одной строки
// (до минимума 16px), а если совсем длинное — переносится сбалансированно
function fitTitle(el) {
  if (!el || !el.textContent.trim()) return;
  el.style.whiteSpace = 'nowrap';
  el.style.fontSize = '';
  let fs = parseFloat(getComputedStyle(el).fontSize);
  const min = 16;
  for (let i = 0; i < 24 && fs > min && el.scrollWidth > el.clientWidth + 1; i++) {
    fs -= 1;
    el.style.fontSize = fs + 'px';
  }
  el.style.whiteSpace = el.scrollWidth > el.clientWidth + 1 ? 'normal' : 'nowrap';
}

async function showLibrary(id) {
  // Токен обязателен, как в openChapter: пока грузится толстая книга, человек может нажать
  // «назад» — showShelf обнулит state.book, а мы дорезолвимся и упадём на state.book.title,
  // оставив пустой мёртвый экран поверх скрытой полки.
  const token = ++navToken;
  loadingChapter = false;
  ttsStop();
  flushDirty();
  const fresh = !state.book || state.book.id !== id;
  if (fresh) {
    try { await loadBook(id); }
    catch (e) {
      if (token !== navToken) return;
      showToast(T('libFail', { e: e.message }));
      location.replace('#/');
      return;
    }
    if (token !== navToken) return;
    state.libScroll = 0;
  } else {
    // мог измениться прогресс — перечитываем
    const rows = await dbAll('progress', bookRange(id));
    if (token !== navToken) return;
    const map = {};
    for (const r of rows) map[r.idx] = { position: r.position, percent: r.percent };
    state.progress.map = map;
  }
  if (!state.book) return;          // книгу успели выгрузить — рисовать нечего
  state.chapter = null;
  $('#reader-view').hidden = true;
  $('#shelf-view').hidden = true;
  syncAddFab();
  $('#audio-view').hidden = true;
  $('#readbar').hidden = true;
  $('#readbar').classList.remove('loading');
  $('#library-view').hidden = false;
  nativeScrollbar(false);   // экран книги — без нативной полосы
  $('#reader-header').classList.remove('hidden');
  $('#book-title').textContent = state.book.title;
  $('#book-author').textContent = state.book.author || '';
  fitTitle($('#book-title'));
  $('#search-input').value = '';
  $('#search-results').hidden = true;
  $('#notes-list').hidden = true;
  $('#notes-btn').classList.remove('active');
  $('#bm-list').hidden = true;
  $('#bm-list-btn').classList.remove('active');
  $('#toc').hidden = false;
  clearNoteHl();
  refreshNotesBadge();
  refreshReviewBadge();
  refreshBmBadge();
  renderAnnot();
  updateTitle();
  renderContinue();
  renderChips();
  renderToc();
  renderFooter();
  enterView($('#library-view'));
  updateWakeLock();
  syncSettingsUI();
  requestAnimationFrame(() => scrollTo(0, state.libScroll));
}

// ══════════════════ читалка ══════════════════
function scrollableMax() {
  return document.documentElement.scrollHeight - innerHeight;
}
// перелистывание тапом по нижним четвертям экрана: прокрутка на ~страницу
// (с небольшим нахлёстом, чтобы не терять строку), а на краях главы — переход
// к соседней главе. dir: +1 вперёд, -1 назад.
function pageTurn(dir) {
  const max = scrollableMax();
  const step = Math.max(120, innerHeight - Math.round(innerHeight * 0.14));
  const ch = state.chapter;
  if (dir > 0) {
    if (scrollY >= max - 4) { if (ch && ch.next_idx != null) location.hash = chHash(ch.next_idx); return; }
    scrollTo({ top: Math.min(max, scrollY + step), behavior: 'smooth' });
  } else {
    if (scrollY <= 4) { if (ch && ch.prev_idx != null) location.hash = chHash(ch.prev_idx); return; }
    scrollTo({ top: Math.max(0, scrollY - step), behavior: 'smooth' });
  }
}
function curFrac() {
  const max = scrollableMax();
  if (max <= 4) return 1;
  return Math.min(1, Math.max(0, scrollY / max));
}

// ══════════════════ закладки ══════════════════
// Заметка — про «запомнить мысль», закладка — про «вернуться сюда». Поэтому у закладки
// нет текста: только глава и место в ней. Храним в kv (bm:<id>), чтобы не заводить
// новое хранилище и не поднимать версию базы ради списка из десятка записей.
let bookmarks = [];
const bmKey = id => 'bm:' + id;
async function loadBookmarks(id) {
  bookmarks = (await kvGet(bmKey(id))) || [];
  return bookmarks;
}
const BM_NEAR = 0.02;   // ближе 2% страницы — считаем, что закладка уже тут
function bmAt(idx, pos) {
  return bookmarks.find(b => b.idx === idx && Math.abs(b.position - pos) < BM_NEAR);
}
function refreshBmBtn() {
  const btn = $('#bm-btn');
  if (!btn || !state.chapter) return;
  const here = !!bmAt(state.chapter.idx, curFrac());
  btn.classList.toggle('active', here);   // заливку внутренности рисует CSS (#bm-btn.active svg path)
}
async function toggleBookmark() {
  if (!state.book || !state.chapter) return;
  const idx = state.chapter.idx, pos = curFrac();
  const exist = bmAt(idx, pos);
  if (exist) bookmarks = bookmarks.filter(b => b !== exist);
  else bookmarks.push({ id: newId('bm'), idx, position: pos, title: state.chapter.title || '', at: Date.now() });
  if (!(await saveGuard(() => kvSet(bmKey(state.book.id), bookmarks)))) {
    await loadBookmarks(state.book.id);   // не записалось — возвращаем как было
    return;
  }
  refreshBmBtn();
  refreshBmBadge();
  showToast(t(exist ? 'bmRemoved' : 'bmAdded'));
}
function refreshBmBadge() {
  const b = $('#bm-count');
  if (b) b.textContent = bookmarks.length ? String(bookmarks.length) : '';
}

// ══════════════════ автопрокрутка ══════════════════
// Плавная прокрутка при чтении: руки свободны. Двигаем по кадрам с дробной скоростью
// (px/с), а не setInterval со скачком — иначе текст дёргается. Любое касание/скролл
// пальцем автопрокрутку не сбивает: её выключает только сама кнопка или конец главы.
const SCROLL_SPEEDS = [0, 12, 20, 32, 50, 80];   // px/с; 0 — выключено
let autoScroll = { i: 0, raf: 0, last: 0, acc: 0 };
function autoScrollStop() {
  if (autoScroll.raf) cancelAnimationFrame(autoScroll.raf);
  autoScroll = { i: 0, raf: 0, last: 0, acc: 0 };
  const b = $('#scroll-btn'); if (b) b.classList.remove('active', 'showing-num');
  const n = $('#scroll-num'); if (n) n.textContent = '';
}
function autoScrollTick(ts) {
  // ушли из читалки (полка/экран книги/др.) — не домотываем чужой экран глобальным scrollBy
  if ($('#reader-view').hidden) { autoScrollStop(); return; }
  const v = SCROLL_SPEEDS[autoScroll.i];
  if (!v) { autoScrollStop(); return; }
  if (!autoScroll.last) autoScroll.last = ts;
  const dt = Math.min(0.25, (ts - autoScroll.last) / 1000);   // после фона не прыгаем
  autoScroll.last = ts;
  autoScroll.acc += v * dt;
  const step = Math.floor(autoScroll.acc);
  if (step >= 1) {
    autoScroll.acc -= step;
    const max = scrollableMax();
    if (scrollY >= max - 1) {   // конец главы — сами дальше не листаем, просто встаём
      autoScrollStop();
      return;
    }
    scrollBy(0, step);
  }
  autoScroll.raf = requestAnimationFrame(autoScrollTick);
}
const autoScrollIdx = () => autoScroll.i;
// Пока прокрутка идёт, стрелку прячем и на её месте показываем саму скорость — так видно
// режим, не гадая по значку.
function autoScrollSyncUI(preview) {
  const btn = $('#scroll-btn'), num = $('#scroll-num');
  if (!btn || !num) return;
  const i = preview !== undefined ? preview : autoScroll.i;
  btn.classList.toggle('active', i > 0);
  btn.classList.toggle('showing-num', i > 0);   // прячет стрелку, освобождая место цифре
  num.textContent = i > 0 ? String(i) : '';
}
function autoScrollSet(i) {
  autoScroll.i = i;
  if (!SCROLL_SPEEDS[i]) {
    autoScrollStop();
    showToast(t('autoScrollOff'));
    return;
  }
  autoScrollSyncUI();
  showToast(T('autoScrollOn', { v: i + ' / ' + (SCROLL_SPEEDS.length - 1) }));
  autoScroll.last = 0;
  if (!autoScroll.raf) autoScroll.raf = requestAnimationFrame(autoScrollTick);
}
function autoScrollCycle() { autoScrollSet((autoScroll.i + 1) % SCROLL_SPEEDS.length); }
function updateReadbar(frac) {
  $('#readbar-fill').style.width = (frac * 100).toFixed(1) + '%';
}

let userScrolled = false;
let chapImgUrls = [];

async function hydrateImages(bookId) {
  for (const u of chapImgUrls) URL.revokeObjectURL(u);
  chapImgUrls = [];
  const imgs = [...document.querySelectorAll('#chapter-body img[data-i]')];
  if (!imgs.length) return;
  // одна картинка (страница PDF/комикса) — точечный запрос; много (иллюстрированная
  // глава) — один запрос на всю книгу, иначе это десятки отдельных транзакций подряд
  let get;
  if (imgs.length > 4) {
    const map = new Map((await dbAll('images', bookRange(bookId))).map(r => [r.name, r.blob]));
    get = name => map.get(name);
  } else {
    get = async name => { const rec = await dbGet('images', [bookId, name]); return rec && rec.blob; };
  }
  let removed = false;
  for (const img of imgs) {
    const blob = await get(img.dataset.i);
    if (blob) {
      const u = URL.createObjectURL(blob);
      chapImgUrls.push(u);
      img.src = u;
    } else {
      img.remove();
      removed = true;
    }
  }
  if (removed) invalidateTextIndex();
}

// плавное появление ОДНОГО элемента шапки через CSS-анимацию (не inline transition —
// иначе перебивался бы transition: top/height у крошек, см. щель при скролле).
function fadeHead(el) {
  if (!el) return;
  el.classList.remove('head-fade');
  void el.offsetWidth;   // рефлоу — перезапуск анимации
  el.classList.add('head-fade');
}
// Счётчик главы: разделитель (линии + звезда) СТАТИЧЕН — строится один раз и больше не
// перерисовывается. Из цифр обновляем только изменившиеся (напр. «621» — одно на всю книгу,
// его не трогаем). Так шапка не дёргается при листании (задача 5.1).
function setChapterMeta(index, total) {
  const meta = $('#chapter-meta');
  if (!meta) return;
  let ctr = meta.querySelector('.cm-ctr');
  if (!ctr) {
    meta.innerHTML = '<div class="cm-row"><span class="cm-line cm-l"></span>'
      + '<svg class="cm-star" viewBox="-13 -13 26 26" fill="currentColor"><path d="M0 -10 2.9 -2.9 10 0 2.9 2.9 0 10-2.9 2.9-10 0-2.9-2.9Z"/></svg>'
      + '<span class="cm-line cm-r"></span></div>'
      + '<div class="cm-ctr"><span class="cm-cur"></span><span class="cm-sep"></span><span class="cm-total"></span></div>';
    ctr = meta.querySelector('.cm-ctr');
  }
  const curEl = ctr.querySelector('.cm-cur'), sepEl = ctr.querySelector('.cm-sep'), totEl = ctr.querySelector('.cm-total');
  const cur = String(index), tot = String(total), sep = T('meta', { i: '', t: '' });   // '  из  ' — только разделитель
  if (curEl.textContent !== cur) curEl.textContent = cur;
  if (sepEl.textContent !== sep) sepEl.textContent = sep;
  if (totEl.textContent !== tot) totEl.textContent = tot;   // total обычно неизменен — не переписываем
}

// PDF/комикс: глава — это одна полностраничная картинка (img[data-i]) плюс, возможно,
// скрытый текстовый слой .pdf-text; настоящих абзацев нет. В таком случае крупный
// заголовок «Страница N» лишний (номер и так под звездой), а страницу разворачиваем
// почти во всю ширину экрана — класс body.reader-comic рулит этим в CSS.
function isPageImageChapter(bodyEl) {
  const kids = bodyEl.children;
  if (!kids.length) return false;
  let hasImg = false;
  for (const k of kids) {
    if (k.tagName === 'IMG' && k.hasAttribute('data-i')) { hasImg = true; continue; }
    if (k.classList.contains('pdf-text')) continue;
    return false;   // есть ещё что-то (текст, заголовки) — это не страница-картинка
  }
  return hasImg;
}

async function openChapter(bookId, idx) {
  const token = ++navToken;
  if (!pendingAutoplay) ttsStop();
  flushDirty();
  if (!$('#library-view').hidden) state.libScroll = scrollY;
  if (!$('#shelf-view').hidden) state.shelfScroll = scrollY;
  loadingChapter = true;
  $('#readbar').hidden = false;
  $('#readbar').classList.add('loading');
  let ch;
  dbg('open:' + idx);
  try {
    if (!state.book || state.book.id !== bookId) await loadBook(bookId);
    dbg('loaded');
    ch = await chapterOf(bookId, idx);
    dbg('ch-ok');
  } catch (e) {
    if (token !== navToken) return;
    loadingChapter = false;
    $('#readbar').classList.remove('loading');
    if ($('#reader-view').hidden) $('#readbar').hidden = true;
    if (e.status === 404 || e.message === 'нет книги') {
      showToast(t('chMissing'));
      location.replace('#/');
    } else {
      showToast(t('chLoadFail'), t('retry'), () => openChapter(bookId, idx));
    }
    return;
  }
  if (token !== navToken) return;

  state.chapter = ch;
  statSessionStart(bookId, state.book);   // учёт активного чтения этой книги
  // уже в читалке → это смена главы, а не вход: тогда НЕ переигрываем анимацию входа
  // всей вьюхи (иначе мигали бы все панели). Меняются только названия — через crossfade.
  const wasInReader = !$('#reader-view').hidden;
  $('#library-view').hidden = true;
  $('#shelf-view').hidden = true;
  syncAddFab();
  $('#audio-view').hidden = true;
  $('#reader-view').hidden = false;
  nativeScrollbar(true);   // в чтении нативную полосу ОСТАВЛЯЕМ — индикатор прочитанного
  $('#readbar').classList.remove('loading');
  if (!wasInReader) {   // при ВХОДЕ в читалку показываем шапку/стрелки; при листании — НЕ трогаем,
    $('#reader-header').classList.remove('hidden');   // иначе они принудительно выезжают и «скачут»
    $('#reader-fabnav')?.classList.remove('hidden');
  }
  // Обновляем и мигаем ТОЛЬКО то, что реально изменилось — иначе шапка дёргается на каждом
  // листании (том обычно тот же, звезда/линии постоянны, «621» одно на книгу).
  const crumbText = ch.vol || ch.crumb || state.book.title;
  if (crumbText !== ($('#reader-crumbs .crumbs-track')?.textContent || '')) {
    setCrumbs(crumbText); fadeHead($('#reader-crumbs'));
  }
  setChapterMeta(ch.index, ch.total);
  const titleEl = $('#chapter-title');
  if (titleEl.textContent !== ch.title) { titleEl.textContent = ch.title; fadeHead(titleEl); }
  const bodyEl = $('#chapter-body');
  bodyEl.style.transition = ''; bodyEl.style.transform = ''; bodyEl.style.opacity = '';   // убрать следы свайпа
  bodyEl.innerHTML = ch.html;
  invalidateTextIndex();   // новая глава — прежняя карта смещений недействительна
  watchChapterText();
  document.body.classList.toggle('reader-comic', isPageImageChapter(bodyEl));   // PDF/комикс: страница во всю ширину, без заголовка
  if (wasInReader) { bodyEl.classList.remove('body-fade'); void bodyEl.offsetWidth; bodyEl.classList.add('body-fade'); }
  for (const img of document.querySelectorAll('#chapter-body img')) {
    img.loading = 'lazy';
    img.decoding = 'async';
  }
  hydrateImages(bookId);
  trChapterOn = false;
  $('#tr-btn').classList.remove('active');
  state.chNotes = [];
  dbByIndex('notes', 'byChapter', [bookId, idx]).then(ns => {
    if (token !== navToken) return;
    state.chNotes = ns;
    renderNoteHighlights();
  }).catch(() => {});
  const firstP = document.querySelector('#chapter-body p');
  if (firstP && /^[A-Za-zА-ЯЁа-яё]/.test(firstP.textContent.trim()))
    firstP.classList.add('dropcap');
  renderNav(ch);
  updateTitle();
  if (!wasInReader) enterView($('#reader-view'));   // анимация входа — только при ВХОДЕ, не при смене главы
  updateWakeLock();

  const saved = state.progress.map[idx];
  userScrolled = false;
  const restore = () => {
    const max = scrollableMax();
    scrollTo(0, saved && saved.position ? saved.position * max : 0);
    lastY = scrollY;
    updateReadbar(curFrac());
    document.documentElement.dataset.scroll =
      `${Math.round(scrollY)}/${Math.round(max)}`;
  };
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (token !== navToken) return;
    restore();
    if (document.fonts && saved && saved.position) {
      document.fonts.ready.then(() => {
        if (token === navToken && !userScrolled) restore();
      });
    }
    setTimeout(() => { if (token === navToken) loadingChapter = false; }, 120);
    const percent = Math.max(saved ? saved.percent : 0, scrollableMax() <= 4 ? 1 : 0);
    state.progress.map[idx] = { position: saved ? saved.position : 0, percent };
    postProgress(idx, state.progress.map[idx].position, percent);
    if (pendingNoteJump && pendingNoteJump.idx === idx) {   // переход к заметке
      const jr = rangeFromOffsets($('#chapter-body'), pendingNoteJump.start, pendingNoteJump.end);
      if (jr) {
        userScrolled = true;
        const rect = jr.getBoundingClientRect();
        scrollTo(0, Math.max(0, rect.top + scrollY - innerHeight * 0.3));
        hlSet('sent', $('#chapter-body'), pendingNoteJump.start, pendingNoteJump.end);
        setTimeout(() => { if (HL && !tts.active) HL.sent.clear(); }, 2600);
      }
      pendingNoteJump = null;
    }
    if (pendingBmJump && pendingBmJump.idx === idx) {   // переход по закладке
      userScrolled = true;
      scrollTo(0, Math.round(pendingBmJump.position * scrollableMax()));
      pendingBmJump = null;
    }
    refreshBmBtn();   // флажок горит, если на этом месте уже стоит закладка
  }));
  // Продолжение озвучки в следующей главе НЕ вешаем на requestAnimationFrame: в свёрнутом
  // приложении кадры не рисуются, rAF не вызывается вовсе — и озвучка молчала до тех пор,
  // пока человек не откроет приложение. Восстановление прокрутки кадра ждать обязано,
  // а запуск речи — нет: ему нужен только разобранный текст главы, он уже в DOM.
  if (pendingAutoplay && token === navToken) {
    pendingAutoplay = false;
    ttsStart(null, 0, null, true);   // автопереход — озвучка с начала новой главы, а не с видимого места
  }
}

const chHash = idx => '#/b/' + state.book.id + '/c/' + idx;

function renderNav(ch) {
  // кнопки — стрелки-иконки (SVG статичен в разметке), меняем только доступность и переход
  const set = (el, idx) => {
    if (!el) return;
    el.disabled = idx == null;
    el.onclick = idx == null ? null : () => { location.hash = chHash(idx); };
  };
  set($('#prev-btn'), ch.prev_idx);
  set($('#next-btn'), ch.next_idx);
}

let lastY = 0;
addEventListener('scroll', () => {
  if ($('#reader-view').hidden || loadingChapter) return;
  userScrolled = true;
  statNote();   // прокрутка = человек читает
  const y = scrollY;
  const frac = curFrac();
  updateReadbar(frac);
  const hdr = $('#reader-header');
  const fab = $('#reader-fabnav');
  // прокрутка закрывает открытое меню выбора голоса/языка — иначе оно висит поверх текста
  if (Math.abs(y - lastY) > 4 && document.querySelector('.lang-menu.open')) closeLangMenus();
  if (y > 64 && y - lastY > 6) { hdr.classList.add('hidden'); if (fab) fab.classList.add('hidden'); }
  else if (lastY - y > 6 || y < 64) { hdr.classList.remove('hidden'); if (fab) fab.classList.remove('hidden'); }
  lastY = y;

  const ch = state.chapter;
  if (!ch) return;
  const cur = state.progress.map[ch.idx] || { percent: 0 };
  const percent = Math.max(cur.percent || 0, frac);
  state.progress.map[ch.idx] = { position: frac, percent };
  queueSave(ch.idx, frac, percent);
}, { passive: true });

// ══════════════════ поиск по книге ══════════════════
let searchTimer = null;
let searchSeq = 0;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function titleMatches(q) {
  const needle = q.toLowerCase();
  return state.flat.filter(c =>
    c.title.toLowerCase().includes(needle)
    || (c.crumb && c.crumb.toLowerCase().includes(needle))
  ).slice(0, 8);
}

function titleMatchesHtml(q) {
  const hits = titleMatches(q);
  if (!hits.length) return '';
  return `<p class="sr-head">${t('jumpTo')}</p>` + hits.map(c => `
    <button class="sr-item" data-ch="${c.idx}">
      <div class="sr-title">${esc(c.title)}</div>
      <div class="sr-where">${esc(c.crumb || '')}</div>
    </button>`).join('');
}

async function doSearch(q) {
  const seq = ++searchSeq;
  const box = $('#search-results');
  const jump = titleMatchesHtml(q);
  box.hidden = false;
  $('#toc').hidden = true;
  box.innerHTML = jump + `<p class="sr-empty">${t('searching')}</p>`;

  const terms = q.split(/\s+/).filter(x => x.length >= 2).slice(0, 5);
  const regs = terms.map(x => new RegExp(escRe(x), 'i'));
  const results = [];
  if (regs.length) {
    const d = await idb();
    await new Promise((resolve) => {
      const cur = d.transaction('chapters').objectStore('chapters')
        .openCursor(bookRange(state.book.id));
      cur.onerror = () => resolve();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || seq !== searchSeq || results.length >= 50) { resolve(); return; }
        const row = c.value;
        const plain = row.plain || '';
        let firstPos = -1;
        const okAll = regs.every(r => {
          const mt = plain.match(r);
          if (!mt) return false;
          if (firstPos < 0) firstPos = mt.index;
          return true;
        });
        if (okAll) {
          const start = Math.max(0, firstPos - 60);
          const snip = esc(plain.slice(start, firstPos + 100))
            .replace(new RegExp(escRe(esc(terms[0])), 'i'), mm => `<mark>${mm}</mark>`);
          results.push({ idx: row.idx, title: row.title, snippet: '…' + snip + '…' });
        }
        c.continue();
      };
    });
  }
  if (seq !== searchSeq) return;
  if ($('#search-input').value.trim() !== q) return;
  const head = results.length
    ? `<p class="sr-head">${T('foundIn', { n: results.length })}${results.length === 50 ? t('first50') : ''}</p>`
    : '';
  results.sort((a, b) => a.idx - b.idx);
  box.innerHTML = jump + head + (results.length
    ? results.map(r => {
      const item = state.byIdx.get(r.idx);
      return `<button class="sr-item" data-ch="${r.idx}">
          <div class="sr-title">${esc(r.title)}</div>
          <div class="sr-where">${esc(item ? item.crumb : '')}</div>
          <div class="sr-snip">${r.snippet}</div>
        </button>`;
    }).join('')
    : (jump ? '' : `<p class="sr-empty">${t('nothing')}</p>`));
}

// ══════════════════ озвучка ══════════════════
// Очередь — предложения; двигатели: нейросервер (edge-tts), голоса браузера,
// нативный синтез Capacitor (в мобильной сборке).
const ttsSupported = 'speechSynthesis' in window;
const capTTS = window.Capacitor && window.Capacitor.Plugins
  && window.Capacitor.Plugins.TextToSpeech || null;
const tts = { active: false, playing: false, items: [], pos: 0, token: 0, paraCount: 0 };
let ttsVoices = [];      // голоса WebView (ПК)
let capVoices = [];      // голоса устройства (Android/iOS через плагин)
let neuralVoices = [];   // онлайн-нейроголоса (edge-tts, лучше, нужен интернет)
let pendingAutoplay = false;
const audioEl = new Audio();
audioEl.preload = 'auto';
const audioCache = new Map();

// разблокировка <audio> жестом: на Android WebView программный play() ПОСЛЕ
// асинхронного синтеза блокируется, если элемент не «прогрет» в момент касания.
// Проигрываем крошечный тихий WAV в контексте касания — дальше play() разрешён.
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const sr = 8000, n = 400, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    audioEl.src = url;
    const done = () => { try { audioEl.pause(); } catch {} audioEl.removeAttribute('src'); URL.revokeObjectURL(url); };
    audioEl.play().then(done).catch(done);
  } catch { /* не критично */ }
}

// ── фоновое аудио: MediaSession — чтобы озвучка не глохла при погасшем экране ──
// Android держит медиасессию живой (как музыкальный плеер) и показывает уведомление
// с кнопками; <audio> нейроголоса продолжает играть в фоне и сам переключает абзацы.
let mediaArtUrl = null, mediaArtBookId = null;
function mediaArtwork() {
  const bk = state.book;
  if (!bk) return [];
  if (mediaArtBookId !== bk.id) {
    if (mediaArtUrl) { try { URL.revokeObjectURL(mediaArtUrl); } catch {} mediaArtUrl = null; }
    mediaArtBookId = bk.id;
    if (bk.cover instanceof Blob) mediaArtUrl = URL.createObjectURL(bk.cover);
  }
  return mediaArtUrl ? [{ src: mediaArtUrl, sizes: '512x512', type: (bk.cover && bk.cover.type) || 'image/jpeg' }] : [];
}
function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
  set('play', () => { unlockAudio(); if (tts.active) ttsPlay(); });
  set('pause', () => { if (tts.active) ttsPause(); });
  set('stop', () => ttsStop());
  set('previoustrack', () => { if (tts.active) ttsJumpPara(-1); });
  set('nexttrack', () => { if (tts.active) ttsJumpPara(+1); });
  set('seekbackward', null); set('seekforward', null); set('seekto', null);
}
// ── системный медиасеанс (Android) ──
// WebView не отдаёт JS-MediaSession системе, поэтому карточку плеера в шторке и на
// локскрине держит нативный сервис: отсюда шлём ему состояние, а нажатия кнопок он
// возвращает в window.__mediaAction. Один сеанс на озвучку книги и на аудиокнигу —
// играть одновременно они не могут (abPlay глушит озвучку, ttsPlay — плеер).
let mediaArt = { id: null, b64: '' };   // обложка для карточки: считаем один раз на книгу
let mediaOff = false;                   // «выключить» из шторки — не воскрешать карточку

function currentMedia() {
  if (ab && ab.rec && (ab.playing || !tts.active)) {
    const tr = ab.rec.tracks && ab.rec.tracks[ab.idx];
    return {
      kind: 'audio', active: true, playing: !!ab.playing,
      title: (tr && tr.title) || ab.rec.title || t('appName'),
      artist: ab.rec.author || ab.rec.title || '',
      album: ab.rec.tracks && ab.rec.tracks.length > 1 ? ab.rec.title : '',
      canPrev: true, canNext: !!(ab.rec.tracks && ab.idx + 1 < ab.rec.tracks.length),
      id: ab.rec.id, cover: ab.rec.cover,
    };
  }
  if (tts.active) {
    const bk = state.book, ch = state.chapter;
    return {
      kind: 'tts', active: true, playing: !!tts.playing,
      title: ch ? ch.title : (bk ? bk.title : t('appName')),
      artist: bk ? (bk.author || bk.title) : t('appName'),
      album: bk ? bk.title : '',
      canPrev: true, canNext: true,
      id: bk && bk.id, cover: bk && bk.cover,
    };
  }
  return { active: false };
}

// обложка уходит в сеанс картинкой: base64 считаем асинхронно и один раз на книгу,
// поэтому pushMedia остаётся синхронной и её можно звать из любого места
function mediaLoadArt(id, blob) {
  if (!id || !(blob instanceof Blob) || mediaArt.id === id) return;
  mediaArt = { id, b64: '' };
  // Обложку УМЕНЬШАЕМ до ~512px перед base64. Иначе большая картинка (напр. страница PDF,
  // отрендеренная в ~1600px JPEG ≈ 1МБ) даёт base64 >1МБ, и нативный мост падает с
  // TransactionTooLargeException при старте foreground-сервиса (лимит Binder-парсела ~1МБ).
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    if (mediaArt.id !== id) return;                       // книгу успели сменить
    try {
      const MAX = 512;
      const k = Math.min(1, MAX / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || MAX) * k));
      const h = Math.max(1, Math.round((img.naturalHeight || MAX) * k));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      const d = c.toDataURL('image/jpeg', 0.8);
      mediaArt.b64 = d.slice(d.indexOf(',') + 1);
    } catch { mediaArt.b64 = ''; }
    pushMedia();                                          // обложка доехала — обновляем карточку
  };
  img.onerror = () => { URL.revokeObjectURL(url); };
  try { img.src = url; } catch { URL.revokeObjectURL(url); }
}

function pushMedia() {
  const br = window.AndroidBgAudio;
  if (!br) return;                                        // не Android — моста нет
  try {
    const m = currentMedia();
    if (!m.active || mediaOff) { if (br.stop) br.stop(); return; }
    if (m.cover instanceof Blob) mediaLoadArt(m.id, m.cover);
    else if (mediaArt.id !== m.id) mediaArt = { id: m.id, b64: '' };
    if (!br.update) { if (m.playing && br.start) br.start(); else if (br.stop) br.stop(); return; }
    // страховка от TransactionTooLargeException: слишком большой арт вообще не отправляем
    const art = (mediaArt.b64 && mediaArt.b64.length < 700000) ? mediaArt.b64 : '';
    br.update(JSON.stringify({
      playing: m.playing, title: m.title, artist: m.artist, album: m.album,
      canPrev: m.canPrev, canNext: m.canNext,
      art, artKey: String(mediaArt.id || ''),
    }));
  } catch { /* мост недоступен */ }
}

// нажатия в системном плеере (шторка, локскрин, гарнитура)
window.__mediaAction = a => {
  const m = currentMedia();
  if (!m.active) return;
  unlockAudio();
  if (m.kind === 'audio') {
    if (a === 'play') abPlay();
    else if (a === 'pause') abPause();
    else if (a === 'next') abNext();
    else if (a === 'prev') abPrev();
    else if (a === 'stop') { mediaOff = true; abPause(); mediaOff = false; pushMediaStop(); }
  } else {
    if (a === 'play') ttsPlay();
    else if (a === 'pause') ttsPause();
    else if (a === 'next') ttsJumpPara(+1);
    else if (a === 'prev') ttsJumpPara(-1);
    else if (a === 'stop') ttsStop();
  }
};
function pushMediaStop() {
  try { if (window.AndroidBgAudio && window.AndroidBgAudio.stop) window.AndroidBgAudio.stop(); } catch {}
}
// старое имя — на него завязаны вызовы из плеера аудиокниг и озвучки
function bgAudio() { pushMedia(); }
function updateMediaSession() {
  bgAudio(tts.active && tts.playing);   // включаем/выключаем фоновый сервис по состоянию озвучки
  if (!('mediaSession' in navigator)) return;
  try {
    if (tts.active) {
      const bk = state.book, ch = state.chapter;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: ch ? ch.title : (bk ? bk.title : t('appName')),
        artist: bk ? (bk.author || bk.title) : t('appName'),
        album: bk ? bk.title : '',
        artwork: mediaArtwork(),
      });
      navigator.mediaSession.playbackState = tts.playing ? 'playing' : 'paused';
    } else {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    }
  } catch { /* MediaSession необязателен */ }
}

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

const isNeural = () => settings.ttsVoice.startsWith('neural:');
const isCap = () => settings.ttsVoice.startsWith('cap:');
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

function refreshVoices() {
  if (!ttsSupported) return;
  ttsVoices = speechSynthesis.getVoices()
    .filter(v => v.lang && v.lang.toLowerCase().startsWith('ru'));
  syncVoiceSelect();
}

// голоса устройства (Android/iOS) через нативный плагин: вытаскиваем русские,
// чтобы показать их списком в выборе голоса (индекс нужен для speak)
// скрытые голоса устройства: на движке Google (ru-RU) часть голосов звучит хуже —
// прячем их по просьбе. Список по URI: на других движках просто ни с чем не совпадёт.
const RU_VOICE_DENY = new Set([
  'ru-ru-x-dfc-network',   // бывш. «Женский 2»
  'ru-ru-x-ruc-local',     // бывш. «Женский 3»
  'ru-ru-x-rue-local',     // бывш. «Женский 5»
  'ru-ru-x-rud-local',     // бывш. «Мужской 2»
  'ru-ru-x-ruf-network',   // бывш. «Мужской 5»
]);
async function loadCapVoices() {
  if (!capTTS || !capTTS.getSupportedVoices) return;
  try {
    const r = await capTTS.getSupportedVoices();
    const all = (r && r.voices) || [];
    capVoices = all
      .map((v, i) => ({ index: i, name: v.name || v.voiceURI || ('Голос ' + (i + 1)),
        uri: v.voiceURI || '', lang: (v.lang || '') }))
      .filter(v => v.lang.toLowerCase().startsWith('ru')
        && !RU_VOICE_DENY.has((v.uri || '').toLowerCase()));
    syncVoiceSelect();
  } catch { /* движок не отдал список — останется общий «Голос устройства» */ }
}

// адрес опционального сервера-помощника: озвучка его НЕ использует (нейроголоса
// синтезируются напрямую), но он остаётся запасным путём для перевода (?tts=)
let ttsBase = localStorage.getItem('talewyn-tts-base') || '';

// онлайн-нейроголоса Microsoft: приложение синтезирует их НАПРЯМУЮ (edge-tts.js),
// без своего сервера. Показываем в списке, когда модуль загружен и есть интернет.
async function loadNeuralVoices() {
  // показываем онлайн-голоса, как только загрузился модуль синтеза (navigator.onLine
  // в WebView бывает ложно false — не прячем из-за него; нет сети → сработает откат)
  if (!window.TalewynEdgeTTS) { neuralVoices = []; syncVoiceSelect(); return; }
  neuralVoices = [
    { id: 'ru-RU-DmitryNeural', name: 'Дмитрий' },
    { id: 'ru-RU-SvetlanaNeural', name: 'Светлана' },
  ];
  syncVoiceSelect();
}
addEventListener('online', loadNeuralVoices);
addEventListener('offline', loadNeuralVoices);
addEventListener('edgett-ready', loadNeuralVoices);

// ── интернет для нейроголосов: реальная проверка связи (navigator.onLine в WebView врёт) ──
const WIFI_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8 15.4a6 6 0 0 1 8 0"/><circle cx="12" cy="18.6" r="1" fill="currentColor" stroke="none"/></svg>';
const WIFI_OFF_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8 15.4a6 6 0 0 1 8 0"/><circle cx="12" cy="18.6" r="1" fill="currentColor" stroke="none"/><path d="M3.5 3.5 20.5 20.5"/></svg>';
let netOnline = navigator.onLine !== false;
let netPollTimer = null;
function setNetOnline(v) {
  v = !!v;
  if (netOnline !== v) { netOnline = v; if (voicePicker) syncVoiceSelect(); }
  // пока офлайн — часто перепроверяем, чтобы быстро вернуть голоса при возврате сети
  if (!v && !netPollTimer) netPollTimer = setInterval(probeNet, 2500);
  else if (v && netPollTimer) { clearInterval(netPollTimer); netPollTimer = null; }
}
let netProbing = false;
async function probeNet() {
  if (netProbing) return;
  netProbing = true;
  try {
    const c = new AbortController();
    const to = setTimeout(() => c.abort(), 2200);   // быстрый таймаут — быстрее показываем недоступность
    // no-cors: ответ непрозрачен, но fetch РЕШИТСЯ при доступной сети и упадёт без неё
    await fetch('https://www.gstatic.com/generate_204', { mode: 'no-cors', cache: 'no-store', signal: c.signal });
    clearTimeout(to);
    setNetOnline(true);
  } catch { setNetOnline(false); }
  finally { netProbing = false; }
}
addEventListener('online', () => { setNetOnline(true); probeNet(); });   // вернулась сеть — сразу голоса назад
addEventListener('offline', probeNet);   // событие может врать — перепроверяем реальной связью
// ?tts=http://192.168.х.х:8770 — запомнить адрес сервера голосов
if (urlParams.get('tts')) {
  try {
    localStorage.setItem('talewyn-tts-base',
      new URL(urlParams.get('tts')).origin);
  } catch { /* некорректный адрес — пропускаем */ }
}

let voicePicker = null;
const cleanVoiceName = n => n.replace(/Microsoft |Google |Yandex /g, '')
  .replace(/ Online \(Natural\).*/, ' ✦').replace(/ - Russian.*/, '').trim();
function voiceItems() {
  // онлайн-нейро (лучше, нужен интернет) — сверху, помечены ✦ и «онлайн»
  const online = neuralVoices.map(v => ({ v: 'neural:' + v.id, label: '✦ ' + v.name + ' · ' + t('onlineTag') }));
  // голоса устройства: на телефоне — из плагина (группируем по полу), на ПК — из WebView
  let device;
  if (capTTS) {
    device = capVoices.length ? groupDeviceVoices(capVoices)
      : [{ v: 'cap:device', label: t('deviceVoice') }];
  } else {
    device = ttsVoices.map(v => ({ v: v.voiceURI, label: cleanVoiceName(v.name) }));
  }
  return [...online, ...device];
}
// пол русских голосов Android: сначала пробуем узнать из voiceURI, иначе — по раскладке
// для этого устройства (порядок getSupportedVoices стабилен; задано пользователем на слух)
const RU_GENDER_BY_INDEX = ['m', 'f', 'f', 'f', 'f', 'm', 'm', 'f', 'f', 'm', 'm'];
function capGender(v, i) {
  const u = (v.uri || '').toLowerCase();
  if (/female|women|-f-|\bfem/.test(u)) return 'f';
  if (/\bmale\b|-m-|\bman\b/.test(u)) return 'm';
  // голоса Google ru-RU определяем по коду — надёжно и не зависит от порядка/фильтра
  if (/x-(dfc|ruc|rue)(-|$)/.test(u)) return 'f';
  if (/x-(rud|ruf)(-|$)/.test(u) || u === 'ru-ru-language') return 'm';
  return RU_GENDER_BY_INDEX[i] || '';
}
function groupDeviceVoices(list) {
  const withG = list.map((v, i) => ({ v, g: capGender(v, i) }));
  const rank = { f: 0, m: 1, '': 2 };
  withG.sort((a, b) => rank[a.g] - rank[b.g]);   // женские → мужские → без пола
  let nf = 0, nm = 0, nn = 0;
  return withG.map(({ v, g }) => ({
    v: 'cap:' + v.index,
    label: g === 'f' ? 'Женский ' + (++nf) : g === 'm' ? 'Мужской ' + (++nm) : 'Русский ' + (++nn),
    g,
  }));
}
// два столбца выбора голоса: слева мужские, справа женские; сверху каждого — лучший
// нейроголос (Дмитрий / Светлана), дальше — голоса устройства того же пола
function voiceColumns() {
  const male = [], female = [], other = [];
  for (const v of neuralVoices) {
    const item = { v: 'neural:' + v.id, label: v.name, online: true };   // значок вай-фая вместо «онлайн»
    (/dmitry/i.test(v.id) ? male : female).push(item);
  }
  if (capTTS) {
    const dev = capVoices.length ? groupDeviceVoices(capVoices)
      : [{ v: 'cap:device', label: t('deviceVoice'), g: '' }];
    for (const d of dev) {
      const item = { v: d.v, label: d.label };
      if (d.g === 'm') male.push(item);
      else if (d.g === 'f') female.push(item);
      else other.push(item);
    }
  } else {
    const dev = ttsVoices.map(v => ({ v: v.voiceURI, label: cleanVoiceName(v.name) }));
    const half = Math.ceil(dev.length / 2);
    male.push(...dev.slice(0, half));
    female.push(...dev.slice(half));
  }
  for (const o of other) (male.length <= female.length ? male : female).push(o);
  return { male, female };
}
function buildVoicePicker() {
  const container = $('#tts-voice');
  if (!container) return;
  // круглая иконка-«граммофон» (диск): по тапу открывается список голосов
  container.innerHTML =
    '<button class="voice-round tbtn rd" type="button" aria-haspopup="listbox" aria-expanded="false">'
    + '<svg class="voice-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.1"/><circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none"/></svg>'
    + '<span class="lang-cur voice-cur"></span></button>';
  const trigger = container.querySelector('.voice-round');
  const menu = document.createElement('div');
  menu.className = 'lang-menu voice-menu';
  menu.setAttribute('role', 'listbox');
  document.body.appendChild(menu);
  // шторка голосов появляется прямо над панелью аудио, той же ширины и по её краям
  const place = () => {
    const bar = $('#tts-bar').getBoundingClientRect();
    menu.style.width = bar.width + 'px';
    menu.style.left = bar.left + 'px';
    menu.style.right = 'auto';
    menu.style.top = 'auto';
    let bottomPx = innerHeight - bar.top + 8;                       // 8px над аудиопанелью
    const st = $('#sel-toolbar');                                   // если открыта панель выделения — над НЕЙ
    if (st && !st.hidden && !st.classList.contains('leaving')) {
      const sr = st.getBoundingClientRect();
      if (sr.height) bottomPx = Math.max(bottomPx, innerHeight - sr.top + 8);
    }
    menu.style.bottom = bottomPx + 'px';
    menu.style.maxHeight = Math.min(innerHeight - bottomPx - 16, innerHeight * 0.72) + 'px';
    menu.style.overflowY = 'auto';
  };
  menu._place = place;   // чтобы двигать меню при появлении/уходе панели выделения
  // Панели под меню живут своей жизнью: у панели выделения меняется высота (появляются и
  // уходят кнопки), обе едут вверх-вниз с анимацией. Одного пересчёта по таймеру мало —
  // меню зависало выше, и между ним и панелью зиял просвет с текстом книги. Поэтому следим
  // и за размером, и за концом каждой анимации, и подтягиваем меню вплотную.
  const follow = [$('#tts-bar'), $('#sel-toolbar')].filter(Boolean);
  // считаем в следующем кадре: наблюдатель срабатывает ДО того, как новая раскладка применена,
  // и позиция получалась по старым размерам — меню недоезжало
  const replace = () => {
    if (!menu.classList.contains('open')) return;
    requestAnimationFrame(() => requestAnimationFrame(() => { if (menu.classList.contains('open')) place(); }));
  };
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(replace);
    // именно border-box: панель меняет высоту вместе с отступами, а внутренний размер при этом
    // остаётся прежним — наблюдатель по умолчанию такого изменения просто не заметил бы
    for (const el of follow) { try { ro.observe(el, { box: 'border-box' }); } catch { ro.observe(el); } }
  }
  for (const el of follow) el.addEventListener('transitionend', e => {
    if (e.target === el && (e.propertyName === 'bottom' || e.propertyName === 'transform' || e.propertyName === 'height')) replace();
  });
  const close = () => { menu.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); };
  let toggledAt = 0;
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    if (isOpen && performance.now() - toggledAt < 320) return;   // гасим «дребезг» быстрого тапа
    closeLangMenus();
    if (!isOpen) { probeNet(); place(); menu.classList.add('open'); trigger.setAttribute('aria-expanded', 'true'); }
    toggledAt = performance.now();
  });
  menu.addEventListener('click', e => {
    const b = e.target.closest('.lang-opt');
    if (!b) return;
    if (b.dataset.needsNet) { showToast(t('needNet')); return; }   // онлайн-голос без интернета
    settings.ttsVoice = b.dataset.v;
    saveSettings();
    clearAudioCache();
    syncVoiceSelect();
    if (tts.active && tts.playing) ttsPlayFrom(tts.pos);
    else previewVoice();          // не играем — даём услышать выбранный голос
    close();
  });
  voicePicker = { container, trigger, menu, close };
  syncVoiceSelect();
}
function syncVoiceSelect() {
  if (!voicePicker) return;
  const cols = voiceColumns();
  const renderCol = arr => arr.map(it => {
    const off = it.online && !netOnline;   // онлайн-голос без интернета — недоступен
    return `<button class="lang-opt voice-opt${it.online ? ' vo-net' : ''}${off ? ' vo-off' : ''}"`
      + ` type="button" role="option" data-v="${esc(it.v)}"${off ? ' data-needs-net="1"' : ''}>`
      + `<span class="vo-name">${esc(it.label)}</span>`
      + (it.online ? `<span class="vo-wifi">${off ? WIFI_OFF_SVG : WIFI_SVG}</span>` : '')
      + '</button>';
  }).join('');
  voicePicker.menu.innerHTML =
    `<div class="voice-col">${renderCol(cols.male)}</div>`
    + `<div class="voice-col">${renderCol(cols.female)}</div>`;
  const all = [...cols.male, ...cols.female];
  const cur = all.find(it => it.v === settings.ttsVoice) || all[0];
  const label = cur ? cur.label : t('voiceT');
  const curEl = voicePicker.trigger.querySelector('.voice-cur');
  if (curEl) curEl.textContent = label;
  voicePicker.trigger.title = label;                 // текущий голос — во всплывашке круглой иконки
  voicePicker.trigger.setAttribute('aria-label', label);
  voicePicker.menu.querySelectorAll('.lang-opt').forEach(o =>
    o.classList.toggle('sel', o.dataset.v === settings.ttsVoice));
}

function resolveVoice() {
  refreshVoices();
  const ok = (isNeural() && neuralVoices.some(v => 'neural:' + v.id === settings.ttsVoice))
    || (isCap() && capTTS && (settings.ttsVoice === 'cap:device'
        || capVoices.some(v => 'cap:' + v.index === settings.ttsVoice)))
    || ttsVoices.some(v => v.voiceURI === settings.ttsVoice);
  if (!ok) {
    // По умолчанию — нейроголос: он заметно лучше, а первое впечатление решает. Раньше по
    // умолчанию стоял голос устройства («работает без интернета»), и человек, включив
    // озвучку впервые, слышал худший из доступных голосов и уходил. Без сети нейроголос
    // сам откатывается на устройство (см. neuralPlay), так что офлайн ничего не теряем.
    settings.ttsVoice =
      neuralVoices.length ? 'neural:' + neuralVoices[0].id
      : capVoices.length ? 'cap:' + capVoices[0].index
      : capTTS ? 'cap:device'
      : ttsVoices.length ? ttsVoices[0].voiceURI
      : '';
    saveSettings();
  }
  syncVoiceSelect();
}

function splitSentences(text) {
  const parts = text.match(/[^.!?…]+[.!?…]+[»")\]]*\s*|[^.!?…]+$/g) || [text];
  const out = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (out.length && (p.length < 30 || out[out.length - 1].length < 30))
      out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out;
}

// Разбор на предложения с ТОЧНЫМ base = позиция в el.textContent (та же система, что у
// caretOffsetAt по тапу). Раньше предложения резались по innerText, а base искался через
// textContent.indexOf(нормализованной строки) — из-за trim/склейки коротких строка часто
// не находилась (base=-1 или смещался), и тап попадал не в то предложение (задача 5).
// ── словарь произношений ──────────────────────────────────────────────────
// Подменяем слова ПЕРЕД синтезом (имена/аббревиатуры, которые движок коверкает).
// Меняется только произносимая строка (speakTextOf), сам it.text остаётся оригиналом —
// поэтому подсветка/смещения караоке не съезжают. Границы слова юникодные: JS `\b`
// знает лишь латиницу, поэтому кириллица матчится через lookaround по \p{L}/\p{N}.
let _pronunRE = null, _pronunMap = null, _pronunDirty = true;
function pronunInvalidate() { _pronunDirty = true; }
function pronunBuild() {
  _pronunDirty = false; _pronunRE = null; _pronunMap = null;
  const list = (settings.pronun || []).filter(e => e && e.from && e.to);
  if (!list.length) return;
  const byLen = [...list].sort((a, b) => b.from.length - a.from.length);   // длинные вперёд
  _pronunMap = new Map();
  const alts = [];
  for (const e of byLen) {
    const key = e.from.toLowerCase();
    if (_pronunMap.has(key)) continue;
    _pronunMap.set(key, e.to);
    alts.push(e.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  try {
    _pronunRE = new RegExp('(?<![\\p{L}\\p{N}_])(' + alts.join('|') + ')(?![\\p{L}\\p{N}_])', 'giu');
  } catch { _pronunRE = null; }   // старый движок без lookbehind/\p{} — словарь просто не применяется
}
function applyPronun(text) {
  if (_pronunDirty) pronunBuild();
  if (!_pronunRE || !text) return text;
  _pronunRE.lastIndex = 0;
  return text.replace(_pronunRE, m => { const r = _pronunMap.get(m.toLowerCase()); return r == null ? m : r; });
}
// произносимая строка предложения (с учётом словаря) — отдельная от it.text
function speakTextOf(it) { return applyPronun(it.text); }

function ttsCollect() {
  const paras = [...document.querySelectorAll(
    '#chapter-body p, #chapter-body h3, #chapter-body h4, #chapter-body blockquote')]
    .filter(el => el.textContent.trim().length > 1);
  tts.paraCount = paras.length;
  const items = [];
  const re = /[^.!?…]+[.!?…]+[»")\]]*\s*|[^.!?…]+$/g;
  paras.forEach((el, pi) => {
    const full = el.textContent;
    const groups = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(full))) {
      const raw = m[0];
      const text = raw.trim();
      if (text) {
        const base = m.index + (raw.length - raw.trimStart().length);   // позиция первого символа предложения
        const end = base + text.length;                                 // и конец (точно в textContent)
        const prev = groups[groups.length - 1];
        // склеиваем только совсем короткие обрывки (<12), чтобы тап попадал точнее
        if (prev && (text.length < 12 || prev.text.length < 12)) { prev.text += ' ' + text; prev.end = end; }
        else groups.push({ base, end, text });
      }
      if (m.index === re.lastIndex) re.lastIndex++;   // страховка от зацикливания
    }
    for (const g of groups) {
      if (g.text.length <= TTS_MAXLEN) { items.push({ para: pi, el, text: g.text, base: g.base, end: g.end }); continue; }
      // страховка: слишком длинный кусок (напр. PDF-страница без пунктуации в одном абзаце)
      // режем по словам — иначе нативный/нейро-движок TTS может подавиться и уронить приложение
      let b = g.base, acc = '';
      for (const w of g.text.split(/(\s+)/)) {
        if (acc.length + w.length > TTS_MAXLEN && acc.trim()) {
          items.push({ para: pi, el, text: acc.trim(), base: b, end: b + acc.length });
          b += acc.length; acc = '';
        }
        acc += w;
      }
      if (acc.trim()) items.push({ para: pi, el, text: acc.trim(), base: b, end: b + acc.length });
    }
  });
  return items;
}
const TTS_MAXLEN = 480;   // предел длины одного куска для синтеза (нативный Android TTS ~4000, берём с запасом)

// Какое предложение (индекс в items) под точкой тапа — по РЕАЛЬНЫМ прямоугольникам его
// текста, а не по caretRangeFromPoint. Последний врёт на выключке (justify) в Android-WebView,
// из-за чего озвучка стартовала с рандомного места (задача 5).
function sentenceItemAtPoint(items, el, x, y) {
  let best = -1, bestDy = Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.el !== el || it.base < 0 || !(it.end > it.base)) continue;
    const r = rangeFromOffsets(el, it.base, it.end);
    if (!r) continue;
    for (const rc of r.getClientRects()) {
      if (y >= rc.top && y <= rc.bottom && x >= rc.left - 2 && x <= rc.right + 2) return i;   // точное попадание
      const dy = y < rc.top ? rc.top - y : (y > rc.bottom ? y - rc.bottom : 0);
      if (dy < bestDy) { bestDy = dy; best = i; }   // запас: ближайшая по вертикали строка
    }
  }
  return best;
}

// счёт тапов по центру страницы: одиночный — шапка (отложенно), двойной — перевод слова
let lastTap = null, hdrTimer = null;
// Открыт ли поверх текста хоть какой-то слой, который должен перехватывать касания.
// Меню языков/голосов живут в document.body и всплывают прямо над текстом главы.
function overlayOpen() {
  return !!document.querySelector('.sheet-scrim.open')
    || !!document.querySelector('.lang-menu.open, .voice-menu.open, .speed-wheel.open')
    || (typeof confirmOpen === 'function' && confirmOpen())
    || !$('#sel-toolbar').hidden;
}
// «глушилка» тапов по тексту сразу после закрытия шторки — от призрачного клика
let readerTapMuteUntil = 0;

// караоке-подсветка (CSS Custom Highlight API + скользящая пилюля)
const HL = (typeof Highlight !== 'undefined' && CSS.highlights)
  ? { word: new Highlight(), sent: new Highlight() } : null;
const NOTE_COLORS = ['y', 'g', 'v', 't'];
if (HL) {
  CSS.highlights.set('tts-word', HL.word);
  CSS.highlights.set('tts-sent', HL.sent);
  for (const c of NOTE_COLORS) {   // выделения читателя
    HL['nt' + c] = new Highlight();
    CSS.highlights.set('nt-' + c, HL['nt' + c]);
  }
  HL.ntnote = new Highlight();     // пунктир под выделениями с заметкой
  CSS.highlights.set('nt-note', HL.ntnote);
  HL.wordsel = new Highlight();    // слово под попапом перевода — свой слой:
  CSS.highlights.set('word-sel', HL.wordsel);   // word/sent заняты караоке озвучки
}

// текстовые узлы главы БЕЗ вставок перевода (.tr-block): все смещения
// заметок и караоке считаются по оригинальному тексту книги
function textWalker(root) {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement && n.parentElement.closest('.tr-block')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
}

// смещение точки в тексте главы, не считая вставок перевода
function absFromPoint(body, node, off) {
  const pre = document.createRange();
  pre.selectNodeContents(body);
  try { pre.setEnd(node, off); } catch { return -1; }
  let n = pre.toString().length;
  for (const tb of body.querySelectorAll('.tr-block')) {
    const rb = document.createRange();
    rb.selectNodeContents(tb);
    if (rb.compareBoundaryPoints(Range.END_TO_END, pre) <= 0) {
      n -= tb.textContent.length;      // блок целиком до точки
    } else if (rb.compareBoundaryPoints(Range.END_TO_START, pre) < 0) {
      return -1;                       // точка внутри перевода
    }
  }
  return n;
}

// Карта текстовых узлов главы: узлы и их накопленные концы. Раньше каждый перевод
// смещения в диапазон обходил главу с самого начала — а на главе, изрезанной курсивом
// (двадцать тысяч текстовых узлов), сотня выделений складывалась в полсекунды работы.
// Теперь обход один на главу, а поиск узла — двоичный.
let textIndexGen = 0;
const invalidateTextIndex = () => { textIndexGen++; };
const _textIndexCache = new WeakMap();
function textIndex(el) {
  const cached = _textIndexCache.get(el);
  if (cached && cached.gen === textIndexGen) return cached;
  const walker = textWalker(el);
  const nodes = [], ends = [];
  let acc = 0, node;
  while ((node = walker.nextNode())) { acc += node.data.length; nodes.push(node); ends.push(acc); }
  const rec = { nodes, ends, total: acc, gen: textIndexGen };
  _textIndexCache.set(el, rec);
  return rec;
}
// страховка на случай, если текст главы поменяли мимо явных вызовов invalidateTextIndex
function watchChapterText() {
  const body = document.getElementById('chapter-body');
  if (!body || body._txWatched || !window.MutationObserver) return;
  body._txWatched = true;
  new MutationObserver(invalidateTextIndex).observe(body, { childList: true, subtree: true, characterData: true });
}

function rangeFromOffsets(el, start, end) {
  const { nodes, ends, total } = textIndex(el);
  if (!nodes.length || end > total || start < 0) return null;
  // первый узел, который заканчивается ПОСЛЕ start (в нём начинается диапазон)
  const findFirst = (pos, strict) => {
    let lo = 0, hi = nodes.length - 1, res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (strict ? ends[mid] > pos : ends[mid] >= pos) { res = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return res;
  };
  const si = findFirst(start, true);
  const ei = findFirst(end, false);
  if (si < 0 || ei < 0 || ei < si) return null;
  const r = new Range();
  r.setStart(nodes[si], start - (ends[si] - nodes[si].data.length));
  r.setEnd(nodes[ei], end - (ends[ei] - nodes[ei].data.length));
  return r;
}

function hlSet(which, el, start, end) {
  if (!HL) return;
  HL[which].clear();
  if (el && end > start) {
    const r = rangeFromOffsets(el, start, end);
    if (r) HL[which].add(r);
  }
}
const hlClear = () => { if (HL) { HL.word.clear(); HL.sent.clear(); } hidePill(); };

function movePill(el, start, end) {
  const pill = $('#karaoke-pill');
  const r = rangeFromOffsets(el, start, end);
  if (!r) { pill.hidden = true; return; }
  const rect = r.getBoundingClientRect();
  const host = pill.parentElement.getBoundingClientRect();
  const first = pill.hidden;
  if (first) pill.style.transition = 'none';
  pill.style.transform =
    `translate(${rect.left - host.left - 3}px, ${rect.top - host.top - 1}px)`;
  pill.style.width = rect.width + 6 + 'px';
  pill.style.height = rect.height + 2 + 'px';
  if (first) {
    pill.hidden = false;
    void pill.offsetWidth;
    pill.style.transition = '';
  }
  pulsePlay();   // подсветка на кнопке Play вспыхивает в такт словам
}
function hidePill() { $('#karaoke-pill').hidden = true; }
// мягкая вспышка на кнопке Play + волна нижнего свечения на каждое слово
function pulsePlay() {
  const btn = $('#tts-play');
  if (btn) { btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse'); }
  const glow = $('#tts-glow');
  if (glow) {
    glow.classList.add('beat');
    clearTimeout(glow._t);
    glow._t = setTimeout(() => glow.classList.remove('beat'), 140);
  }
}

let karaokeRaf = 0;
// запуск ТОЛЬКО через это — иначе каждый сегмент нейроозвучки заводил новый rAF-цикл поверх
// живого (озвучка не пауза), и за главу их копились сотни → CPU рос, всё лагало до перезагрузки
function karaokeStart() { if (!karaokeRaf) karaokeRaf = requestAnimationFrame(karaokeTick); }
function karaokeTick() {
  karaokeRaf = 0;                                             // этот кадр отработан
  if (!tts.active || !tts.playing || !isNeural()) return;    // озвучка встала — цикл гаснет
  const it = tts.items[tts.pos];
  if (it && it.base >= 0 && tts.words && tts.words.length) {
    const cur = audioEl.currentTime;
    let i = tts.words.findIndex(w => w.t > cur);
    i = (i < 0 ? tts.words.length : i) - 1;
    if (i >= 0 && i !== tts.wordIdx) {
      tts.wordIdx = i;
      const w = tts.words[i];
      movePill(it.el, it.base + w.s, it.base + w.e);
    }
  }
  karaokeRaf = requestAnimationFrame(karaokeTick);
}

// «следование» за озвучкой: мягко подводим абзац, ТОЛЬКО когда он ушёл из
// зоны видимости и пользователь не листает сам; на каждое предложение не дёргаем
let ttsFollow = true;
let ttsLastScrolledEl = null;
let ttsProgScrollUntil = 0;   // окно, в котором прокрутка вызвана авто-подводкой, а не жестом
function ttsHighlight(el) {
  for (const s of document.querySelectorAll('.speaking')) s.classList.remove('speaking');
  if (!el) { ttsLastScrolledEl = null; return; }
  el.classList.add('speaking');
  if (!ttsFollow || el === ttsLastScrolledEl) return;   // тот же абзац или ручное листание — не таскаем
  // пока открыт лист/меню/диалог — не дёргаем страницу под пальцем пользователя
  if (document.querySelector('.sheet-scrim.open') || confirmOpen()
      || !$('#sel-toolbar').hidden || $('#reader-view').hidden) return;
  const r = el.getBoundingClientRect();
  if (r.top < 64 || r.bottom > innerHeight - 80) {
    ttsProgScrollUntil = performance.now() + 600;   // это не жест — не сворачиваем панель
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  ttsLastScrolledEl = el;
}

function updPos() {
  // счётчик абзацев убран из v3-плеера; функция оставлена и защищена от null,
  // чтобы озвучка не падала, если элемента #tts-pos нет в разметке
  const el = $('#tts-pos');
  if (!el) return;
  const it = tts.items[tts.pos];
  el.textContent = it ? `${it.para + 1}/${tts.paraCount}` : '';
}

function clearAudioCache() {
  for (const p of audioCache.values())
    p.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
  audioCache.clear();
}

function ttsStart(fromEl = null, charOffset = 0, boundary = null, fromStart = false) {
  unlockAudio();   // тап по абзацу — это жест: сразу снимаем автоплей-замок для нейроголосов
  loadNeuralVoices().then(resolveVoice);
  resolveVoice();
  if (!neuralVoices.length && !ttsVoices.length && !capTTS) {
    showToast(t('noVoices'));
    return;
  }
  tts.items = ttsCollect();
  if (!tts.items.length) return;
  let pos = -1;
  // точнее всего — по ГРАНИЦЕ выделения: ищем предложение, чей DOM-диапазон её содержит
  if (boundary && fromEl) {
    pos = tts.items.findIndex(it => {
      if (it.el !== fromEl || !(it.end > it.base)) return false;
      const r = rangeFromOffsets(it.el, it.base, it.end);
      try { return !!r && r.comparePoint(boundary.node, boundary.off) === 0; }
      catch { return false; }
    });
  }
  if (pos < 0) pos = fromStart ? 0                       // автопереход между главами — строго с начала главы
    : fromEl
      ? tts.items.findIndex(it => it.el === fromEl)
      : tts.items.findIndex(it => it.el.getBoundingClientRect().bottom > 70);
  if (pos < 0) pos = 0;
  if (!boundary && fromEl && charOffset > 0) {
    // запасной путь — по смещению: последнее предложение абзаца, чьё начало не дальше каретки
    while (pos + 1 < tts.items.length
        && tts.items[pos + 1].el === fromEl
        && tts.items[pos + 1].base >= 0
        && tts.items[pos + 1].base <= charOffset) {
      pos++;
    }
  }
  clearAudioCache();
  tts.active = true;
  tts.neuralFails = 0;
  tts.pos = pos;
  {
    const bar = $('#tts-bar');
    const wasHidden = bar.hidden;
    bar.hidden = false;
    if (wasHidden) {                          // плавный выезд снизу: старт из-под грани → на место
      bar.classList.add('tucked');
      void bar.offsetWidth;                   // зафиксировать стартовое (нижнее) положение
      requestAnimationFrame(() => bar.classList.remove('tucked'));
    } else {
      bar.classList.remove('tucked');
    }
  }
  document.body.classList.add('tts-on');
  watchTtsBarLayout();          // панель заметок и меню голоса поедут за плеером вплотную
  requestAnimationFrame(() => { placeSelToolbar(); repositionVoiceMenu(true); });
  $('#tts-rate-value').textContent = (Number.isInteger(settings.ttsRate) ? settings.ttsRate.toFixed(1) : String(settings.ttsRate)) + '×';
  ttsPlayFrom(pos);
}

// Глушим ВСЕ движки разом, а не только тот, что стоит в настройке. Причина: при разовом
// сбое синтеза абзац дочитывает голос устройства (deviceSpeakOnce), хотя в настройке
// по-прежнему 'neural:'. Раньше пауза/переход в такой момент останавливали audioEl —
// то есть не тот движок, — и системный голос продолжал говорить поверх новой озвучки.
function ttsSilence() {
  try { audioEl.pause(); } catch {}
  try { if (capTTS) capTTS.stop().catch(() => {}); } catch {}
  try { if (ttsSupported) speechSynthesis.cancel(); } catch {}
}

function speakCurrent(pos) {
  // страховка таймера сна на случай, если фоновый setTimeout притормозили —
  // на границе абзаца проверяем дедлайн и мягко останавливаем озвучку
  if (sleep.deadline && performance.now() >= sleep.deadline) {
    sleepClear();
    if (tts.playing) ttsPause();
    showToast(t('sleepFired'));
    return;
  }
  if (isNeural()) neuralPlay(pos);
  else if (isCap()) capSpeak(pos);
  else browserSpeak(pos);
}

function ttsPlay() {
  tts.playing = true;
  ttsFollow = true; ttsLastScrolledEl = null;   // нажали play — снова ведём к тексту
  $('#tts-play').innerHTML = PAUSE_SVG;
  $('#tts-btn').classList.add('active');
  $('#tts-bar').classList.add('playing');
  updateWakeLock();
  updateMediaSession();
  if (isNeural() && audioEl.dataset.pos === String(tts.pos)
      && audioEl.src && !audioEl.ended && audioEl.currentTime > 0) {
    audioEl.playbackRate = settings.ttsRate;
    audioEl.play().then(() => karaokeStart())
      .catch(() => neuralPlay(tts.pos));
    return;
  }
  speakCurrent(tts.pos);
}

function ttsPlayFrom(pos) {
  // немедленно глушим текущую озвучку (иначе новый абзац стартует с задержкой,
  // а старый успевает перескочить/озвучить не тот)
  tts.token++;
  clearTimeout(tts._karaTimer);
  ttsSilence();
  tts.pos = pos;
  audioEl.dataset.pos = '-1';
  tts.playing = true;
  ttsFollow = true; ttsLastScrolledEl = null;   // явный старт/переход — снова ведём к тексту
  $('#tts-play').innerHTML = PAUSE_SVG;
  $('#tts-btn').classList.add('active');
  $('#tts-bar').classList.add('playing');
  updateWakeLock();
  updateMediaSession();
  speakCurrent(pos);
}

function ttsPause() {
  tts.playing = false;
  tts.token++;
  clearTimeout(tts._karaTimer);
  ttsSilence();
  $('#tts-play').innerHTML = PLAY_SVG;
  $('#tts-btn').classList.remove('active');
  $('#tts-bar').classList.remove('playing');
  updateWakeLock();
  updateMediaSession();
}

// аудиопанель уезжает вниз ПЛАВНО (через .tucked с transition), а не пропадает резко
function hideTtsBar() {
  const bar = $('#tts-bar');
  if (!bar || bar.hidden) return;
  bar.classList.remove('collapsed');
  bar.classList.add('tucked');
  placeSelToolbar(); repositionVoiceMenu(true);   // плеер ушёл — панели опускаются следом
  setTimeout(() => {
    if (bar.classList.contains('tucked') && !tts.active) { bar.hidden = true; bar.classList.remove('tucked'); }
    placeSelToolbar(); repositionVoiceMenu(false);
  }, 340);
}
// панель выделения («закладок»): появляется через slide-toast, а уходит ПЛАВНО вниз (.leaving),
// а не пропадает резко. Плюс двигает открытое меню голоса под себя.
// Панель выделения садится ВПЛОТНУЮ над панелью озвучки (8px), а не по жёсткому числу в CSS:
// высота плеера со временем менялась, и от подгонки числом между панелями зиял просвет с текстом.
// панель озвучки живая: выезжает, уезжает, меняет высоту — панель заметок и меню голоса
// должны ехать за ней вплотную. Следим за размером и за концом каждой её анимации.
function watchTtsBarLayout() {
  const bar = $('#tts-bar'); if (!bar || bar._watched) return;
  bar._watched = true;
  const sync = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    placeSelToolbar();
    repositionVoiceMenu(false);
  }));
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(sync);
    try { ro.observe(bar, { box: 'border-box' }); } catch { ro.observe(bar); }
  }
  bar.addEventListener('transitionend', e => {
    if (e.target === bar && (e.propertyName === 'transform' || e.propertyName === 'bottom' || e.propertyName === 'height')) sync();
  });
  addEventListener('resize', sync);
}
function placeSelToolbar() {
  const st = $('#sel-toolbar'); if (!st || st.hidden) return;
  const bar = $('#tts-bar');
  const shown = bar && !bar.hidden && !bar.classList.contains('tucked')
    && document.body.classList.contains('tts-on');
  const r = shown ? bar.getBoundingClientRect() : null;
  if (!r || !r.height) { st.style.bottom = ''; return; }   // озвучки нет — работает правило из CSS
  st.style.bottom = Math.round(innerHeight - r.top + 8) + 'px';
}
function showSelToolbar() {
  const el = $('#sel-toolbar');
  if (!el) return;
  el.classList.remove('leaving');
  el.hidden = false;
  placeSelToolbar();
  repositionVoiceMenu(true);
}
function hideSelToolbar() {
  const el = $('#sel-toolbar');
  if (!el || el.hidden) return;
  el.classList.add('leaving');
  repositionVoiceMenu(false);
  setTimeout(() => { if (el.classList.contains('leaving')) { el.hidden = true; el.classList.remove('leaving'); } }, 220);
}
// перепозиционировать открытое меню голоса под текущие панели (плавно — у него transition: bottom)
function repositionVoiceMenu(delayed) {
  const m = document.querySelector('.voice-menu.open');
  if (!m || !m._place) return;
  if (delayed) setTimeout(() => { if (m.classList.contains('open')) m._place(); }, 210);   // после слайд-ина панели
  else m._place();
}
function ttsStop() {
  if (!tts.active) return;
  ttsPause();
  tts.active = false;
  audioEl.removeAttribute('src');
  audioEl.dataset.pos = '-1';
  clearAudioCache();
  ttsHighlight(null);
  hlClear();
  hideTtsBar();                                   // плавно уезжает вниз, а не пропадает резко
  document.body.classList.remove('tts-on');
  sleepClear();   // остановили озвучку — таймер сна больше не нужен
  updateMediaSession();
}

// ── таймер сна: как регулировка скорости (тап — цикл, зажать и крутить — барабан) ──
const SLEEP_MINS = [0, 15, 30, 45, 60];
let sleep = { mins: 0, deadline: 0, to: null, tick: null };
const sleepIdx = () => { const i = SLEEP_MINS.indexOf(sleep.mins); return i < 0 ? 0 : i; };
function sleepRenderNum(mins, shown) {
  const btn = $('#tts-timer'); if (!btn) return;
  const num = $('#tts-timer-num');
  if (mins > 0) { btn.classList.add('on'); if (num) num.textContent = String(shown != null ? shown : mins); }
  else { btn.classList.remove('on'); if (num) num.textContent = ''; }
}
function sleepPreview(mins) { sleepRenderNum(mins, mins); }   // во время кручения — показываем выбор
function sleepTick() {
  if (sleep.deadline <= 0) return;
  sleepRenderNum(sleep.mins, Math.max(1, Math.ceil((sleep.deadline - performance.now()) / 60000)));
}
function sleepClear() {
  clearTimeout(sleep.to); clearInterval(sleep.tick);
  sleep = { mins: 0, deadline: 0, to: null, tick: null };
  sleepRenderNum(0);
}
function sleepSet(mins) {
  clearTimeout(sleep.to); clearInterval(sleep.tick);
  sleep.mins = mins;
  if (mins <= 0) { sleep.deadline = 0; sleep.to = sleep.tick = null; sleepRenderNum(0); return; }
  sleep.deadline = performance.now() + mins * 60000;
  sleep.to = setTimeout(() => {
    sleepClear();
    if (tts.active && tts.playing) ttsPause();
    showToast(t('sleepFired'));
  }, mins * 60000);
  sleep.tick = setInterval(sleepTick, 20000);
  sleepTick();
  showToast(T('sleepSet', { m: mins }));
}

// универсальное «колесо-пинкод»: короткий тап — цикл по значениям; зажать и вести
// палец вверх/вниз — выбор по барабану. Общая механика для скорости и таймера сна.
function bindWheelDial(btn, cfg) {
  if (!btn) return;
  // Барабан крутится пальцем — страница под кнопкой ехать НЕ должна. touch-action ставим
  // прямо здесь, на самом элементе: инлайн перебивает глобальный button{touch-action:
  // manipulation}, из-за которого браузер решал панорамить страницу ещё ДО pointermove
  // (и preventDefault опаздывал). Так фикс получают ВСЕ барабаны разом — забыть его для
  // отдельной кнопки (как было со стрелкой автопрокрутки) больше нельзя.
  btn.style.touchAction = 'none';
  const ITEM_H = 42, WHEEL_H = 210, CY = WHEEL_H / 2, N = cfg.labels.length;
  let wheel = null, track = null, scrubbing = false, justScrubbed = false, holdT = null,
    baseIdx = 0, selIdx = 0, startX = 0, startY = 0;
  const ensureWheel = () => {
    if (wheel) return;
    wheel = document.createElement('div');
    wheel.className = 'speed-wheel';
    wheel.innerHTML = '<div class="wheel-win"><div class="wheel-track">'
      + cfg.labels.map((s, i) => `<div class="wheel-item" data-i="${i}">${s}</div>`).join('')
      + '</div><div class="wheel-band"></div></div>';
    document.body.appendChild(wheel);
    track = wheel.querySelector('.wheel-track');
  };
  const baseTranslate = idx => CY - (idx * ITEM_H + ITEM_H / 2);
  const paint = (ty, idx) => {
    track.style.transform = `translateY(${ty}px)`;
    wheel.querySelectorAll('.wheel-item').forEach(el => el.classList.toggle('sel', +el.dataset.i === idx));
  };
  const openWheel = () => {
    ensureWheel();
    const r = btn.getBoundingClientRect();
    const cx = Math.max(52, Math.min(innerWidth - 52, r.left + r.width / 2));
    wheel.style.left = cx + 'px';
    // не даём колесу уехать за верх экрана при низкой высоте/ландшафте (иначе старшие значения срезаются)
    wheel.style.top = Math.max(WHEEL_H + 8, r.top - 8) + 'px';
    wheel.classList.add('open');
    track.style.transition = 'none';
    paint(baseTranslate(selIdx), selIdx);
  };
  const closeWheel = () => wheel && wheel.classList.remove('open');
  btn.addEventListener('pointerdown', e => {
    justScrubbed = false; scrubbing = false;
    baseIdx = selIdx = cfg.getIdx(); startX = e.clientX; startY = e.clientY;
    try { btn.setPointerCapture(e.pointerId); } catch {}
    holdT = setTimeout(() => { scrubbing = true; openWheel(); }, 200);
  });
  btn.addEventListener('pointermove', e => {
    const dy = e.clientY - startY, dx = e.clientX - startX;
    if (!scrubbing && Math.hypot(dx, dy) > 12) { clearTimeout(holdT); scrubbing = true; openWheel(); }
    if (!scrubbing) return;
    e.preventDefault();
    const maxTy = baseTranslate(0), minTy = baseTranslate(N - 1);
    const ty = Math.max(minTy, Math.min(maxTy, baseTranslate(baseIdx) + dy));
    const idx = Math.max(0, Math.min(N - 1, Math.round((CY - ITEM_H / 2 - ty) / ITEM_H)));
    track.style.transition = 'none';
    paint(ty, idx);
    if (idx !== selIdx) { selIdx = idx; cfg.onLive && cfg.onLive(idx); }
  });
  const endScrub = e => {
    clearTimeout(holdT);
    try { btn.releasePointerCapture(e.pointerId); } catch {}
    if (scrubbing) {
      track.style.transition = 'transform .2s cubic-bezier(.2,.8,.3,1)';
      paint(baseTranslate(selIdx), selIdx);
      cfg.onCommit(selIdx);
      closeWheel();
      justScrubbed = true; scrubbing = false;
    }
  };
  btn.addEventListener('pointerup', endScrub);
  btn.addEventListener('pointercancel', () => { clearTimeout(holdT); closeWheel(); scrubbing = false; });
  btn.addEventListener('click', () => {
    if (justScrubbed) { justScrubbed = false; return; }
    cfg.onTap();
  });
}

function ttsJumpPara(delta) {
  if (!tts.active || !tts.items.length) return;
  const cur = tts.items[tts.pos] ? tts.items[tts.pos].para : 0;
  const target = Math.min(tts.paraCount - 1, Math.max(0, cur + delta));
  const pos = tts.items.findIndex(it => it.para === target);
  if (pos >= 0) ttsPlayFrom(pos);
}

function neuralData(pos) {
  if (!audioCache.has(pos)) {
    const it = tts.items[pos];
    const voice = settings.ttsVoice.slice(7);   // после 'neural:'
    // синтез напрямую у Microsoft (edge-tts.js), без сервера.
    // ГЛАВНАЯ причина, почему «нейроголос отваливается»: соединение к Microsoft
    // рвётся разово (WebSocket 1006, лимит запросов, гонка на границе 5-мин токена
    // Sec-MS-GEC). Раньше первый же такой сбой ронял озвучку. Теперь синтез
    // повторяется несколько раз со свежим подключением/токеном — разовые сбои гасятся.
    const p = (async () => {
      if (!window.TalewynEdgeTTS) throw new Error('edge-tts not loaded');
      const TIMEOUT = 12000, MAX_TRIES = 3;
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        const started = performance.now();
        try {
          const eng = new window.TalewynEdgeTTS(speakTextOf(it), voice);   // словарь произношений
          // страховка от зависания: не молчим вечно, отклоняемся по таймауту
          const res = await Promise.race([
            eng.synthesize(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут ' + (TIMEOUT / 1000) + 'с')), TIMEOUT)),
          ]);
          if (!res || !res.audio || res.audio.size < 128) throw new Error('пустой звук');
          const url = URL.createObjectURL(res.audio);   // Blob audio/mpeg
          const words = [];
          let cur = 0;
          for (const w of res.subtitle || []) {
            const i = it.text.indexOf(w.text, cur);
            if (i < 0) continue;
            words.push({ t: w.offset / 1e7, s: i, e: i + w.text.length });   // offset в 100нс → секунды
            cur = i + w.text.length;
          }
          return { url, words };
        } catch (err) {
          lastErr = err;
          // быстрый сбой (разрыв WS/токен) — есть смысл повторить; медленный (таймаут
          // по сети) — повторять бесполезно, отдаём управление откату на голос устройства
          const quick = performance.now() - started < 8000;
          if (attempt < MAX_TRIES && quick) await new Promise(r => setTimeout(r, 450 * attempt));
          else break;
        }
      }
      throw lastErr || new Error('синтез не удался');
    })();
    p.catch(() => audioCache.delete(pos));
    audioCache.set(pos, p);
    if (audioCache.size > 40) {
      const k = audioCache.keys().next().value;
      audioCache.get(k).then(d => URL.revokeObjectURL(d.url)).catch(() => {});
      audioCache.delete(k);
    }
  }
  return audioCache.get(pos);
}

async function neuralPlay(pos) {
  if (pos >= tts.items.length) { ttsChapterEnd(); return; }
  const token = ++tts.token;
  tts.pos = pos;
  const it = tts.items[pos];
  ttsHighlight(it.el);
  if (it.base >= 0) hlSet('sent', it.el, it.base, it.base + it.text.length);
  updPos();
  // Синтез и воспроизведение разведены НАМЕРЕННО. Раньше play() стоял в том же try, что и
  // синтез, и его отказ засчитывался как «нейроголос не смог» → откат на голос устройства.
  // А отказывает play() штатно: при уходе в фон WebView его отклоняет. Отсюда и жалоба
  // «свернул — заговорил системный голос, вернулся — нейроголос вернулся».
  let data;
  try {
    data = await neuralData(pos);
  } catch (e) {
    if (token !== tts.token) return;
    neuralFail(pos, e);
    return;
  }
  if (token !== tts.token || !tts.playing) return;
  audioEl.src = data.url;
  audioEl.dataset.pos = String(pos);
  audioEl.playbackRate = settings.ttsRate;
  tts.words = data.words;
  tts.wordIdx = -1;
  try {
    await audioEl.play();
  } catch {
    // Отказ ВОСПРОИЗВЕДЕНИЯ, а не синтеза: звук уже синтезирован и лежит в кэше. Менять
    // движок нельзя — просто ждём, когда играть снова разрешат (ttsPlay подхватит буфер).
    return;
  }
  tts.neuralFails = 0;                            // синтез удался — счётчик сбоев сбрасываем
  karaokeStart();
  if (pos + 1 < tts.items.length) neuralData(pos + 1);
}

// сбой ИМЕННО синтеза: разовый — дочитать абзац голосом устройства, устойчивый — переехать на него
function neuralFail(pos, e) {
  const why = (e && e.message ? String(e.message) : String(e)).slice(0, 90);
  probeNet();   // сбой нейроголоса часто = пропал интернет — обновим значок вай-фая
  if (!capTTS && !ttsVoices.length) { showToast(t('noTtsServer') + ' [' + why + ']'); ttsStop(); return; }
  tts.neuralFails = (tts.neuralFails || 0) + 1;
  if (tts.neuralFails >= 4) {
    // нейроозвучка не восстанавливается (нет сети и т.п.) — переходим на голос устройства
    showToast(t('neuralFallback') + ' [' + why + ']');
    settings.ttsVoice = ttsVoices.length ? ttsVoices[0].voiceURI : 'cap:device';
    saveSettings();
    syncVoiceSelect();
    speakCurrent(pos);
  } else {
    // разовый сбой: этот абзац читаем голосом устройства, но нейроголос из настроек
    // НЕ убираем — следующий абзац снова пробуем нейро, чтение не прерывается
    neuralNoticeOnce(why);
    deviceSpeakOnce(pos);
  }
}
// один абзац голосом устройства при разовом сбое нейроголоса; следующий абзац снова
// пойдёт через speakCurrent → нейро (озвучка сама восстанавливается, когда сеть вернулась)
function deviceSpeakOnce(pos) {
  if (pos >= tts.items.length) { ttsChapterEnd(); return; }
  const token = ++tts.token;
  tts.pos = pos;
  const it = tts.items[pos];
  ttsHighlight(it.el);
  updPos();
  if (it.base >= 0) hlSet('sent', it.el, it.base, it.base + it.text.length);
  const advance = () => { if (token === tts.token && tts.playing) speakCurrent(pos + 1); };
  if (capTTS) {
    if (it.base >= 0) capKaraoke(it, token);
    capTTS.speak({ text: speakTextOf(it), lang: 'ru-RU', rate: settings.ttsRate, category: 'playback' })   // словарь произношений
      .then(advance, advance);
  } else if (ttsSupported) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(speakTextOf(it));   // словарь произношений
    if (ttsVoices[0]) u.voice = ttsVoices[0];
    u.lang = 'ru-RU'; u.rate = settings.ttsRate;
    u.onend = advance; u.onerror = advance;
    speechSynthesis.speak(u);
  } else advance();
}
let neuralNoticeAt = -1e9;
function neuralNoticeOnce(why) {
  const now = performance.now();
  if (now - neuralNoticeAt < 20000) return;   // не спамим уведомлением на каждый абзац
  neuralNoticeAt = now;
  showToast(t('neuralHiccup') + (why ? ' [' + why + ']' : ''));
}
audioEl.addEventListener('ended', () => {
  if (tts.active && tts.playing && isNeural()) neuralPlay(tts.pos + 1);
});

function browserSpeak(pos) {
  if (!ttsSupported) { ttsStop(); return; }
  if (pos >= tts.items.length) { ttsChapterEnd(); return; }
  const token = ++tts.token;
  tts.pos = pos;
  speechSynthesis.cancel();
  const it = tts.items[pos];
  ttsHighlight(it.el);
  updPos();
  if (it.base >= 0) hlSet('sent', it.el, it.base, it.base + it.text.length);
  const speak = speakTextOf(it);           // словарь произношений
  const sub = speak !== it.text;           // строка изменилась → charIndex боундари уже не про it.text
  const u = new SpeechSynthesisUtterance(speak);
  const v = ttsVoices.find(x => x.voiceURI === settings.ttsVoice) || ttsVoices[0];
  if (v) u.voice = v;
  u.lang = 'ru-RU';
  u.rate = settings.ttsRate;
  u.addEventListener('boundary', e => {
    if (token !== tts.token || it.base < 0 || sub) return;   // при подмене — только подсветка предложения
    if (e.name && e.name !== 'word') return;
    const start = it.base + e.charIndex;
    let len = e.charLength;
    if (!len) len = ((it.text.slice(e.charIndex).match(/^\S+/) || [''])[0]).length;
    if (len > 0) movePill(it.el, start, start + len);
  });
  const next = () => { if (token === tts.token && tts.playing) browserSpeak(pos + 1); };
  u.onend = next;
  u.onerror = next;
  speechSynthesis.speak(u);
}

// короткий образец выбранного голоса — чтобы услышать голос/пол при выборе
function previewVoice() {
  if (isNeural()) return;   // у нейроголосов пол ясен по имени
  const text = 'Привет! Это пример голоса.';
  if (isCap() && capTTS) {
    capTTS.stop().catch(() => {});
    const opts = { text, lang: 'ru-RU', rate: settings.ttsRate, category: 'playback' };
    const sel = settings.ttsVoice.slice(4);
    if (sel && sel !== 'device' && !isNaN(+sel)) opts.voice = +sel;
    capTTS.speak(opts).catch(() => {});
  } else if (ttsSupported) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = ttsVoices.find(x => x.voiceURI === settings.ttsVoice);
    if (v) u.voice = v;
    u.lang = 'ru-RU'; u.rate = settings.ttsRate;
    speechSynthesis.speak(u);
  }
}

// приблизительное «караоке» для нативного голоса: границы слов система не даёт,
// поэтому ведём пилюлю по словам на таймере, оценивая длительность по длине слова
function capKaraoke(it, token) {
  clearTimeout(tts._karaTimer);
  if (!it || it.base < 0 || !it.text) return;
  const words = [];
  const re = /\S+/g; let m;
  while ((m = re.exec(it.text))) words.push({ s: m.index, e: m.index + m[0].length, len: m[0].length });
  if (!words.length) return;
  const perChar = 58 / (settings.ttsRate || 1);   // мс на символ (подобрано на слух)
  let i = 0;
  const step = () => {
    if (token !== tts.token || !tts.playing || i >= words.length) return;
    const w = words[i++];
    movePill(it.el, it.base + w.s, it.base + w.e);
    tts._karaTimer = setTimeout(step, Math.max(95, w.len * perChar + 45));
  };
  step();
}

// нативный синтез в мобильной сборке Capacitor: границ слов нет — ведём
// пилюлю по оценке (capKaraoke) и подсвечиваем предложение
async function capSpeak(pos) {
  if (!capTTS) { ttsStop(); return; }
  if (pos >= tts.items.length) { ttsChapterEnd(); return; }
  const token = ++tts.token;
  tts.pos = pos;
  const it = tts.items[pos];
  ttsHighlight(it.el);
  updPos();
  if (it.base >= 0) { hlSet('sent', it.el, it.base, it.base + it.text.length); capKaraoke(it, token); }
  try {
    const opts = { text: speakTextOf(it), lang: 'ru-RU', rate: settings.ttsRate, category: 'playback' };   // словарь произношений
    const sel = settings.ttsVoice.slice(4);            // после 'cap:'
    if (sel && sel !== 'device' && !isNaN(+sel)) opts.voice = +sel;   // конкретный голос устройства
    await capTTS.speak(opts);
    if (token === tts.token && tts.playing) capSpeak(pos + 1);
  } catch {
    if (token === tts.token && tts.playing) capSpeak(pos + 1);
  }
}

function ttsChapterEnd() {
  const ch = state.chapter;
  if (ch && ch.next_idx != null) {
    // как аудиокнига: продолжаем следующую главу даже при погашенном экране,
    // чтобы озвучка не прерывалась (MediaSession держит аудио живым в фоне)
    pendingAutoplay = true;
    location.hash = chHash(ch.next_idx);
  } else {
    ttsStop();
    showToast(t('chDone'));
  }
}

// ══════════════════ аудиокниги (отдельные аудиофайлы) ══════════════════
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav|wma)$/i;
const audioBookEl = new Audio();
audioBookEl.preload = 'auto';
let ab = null;                 // текущая открытая аудиокнига: { rec, idx, _url, playing }
let abRate = Math.min(2, Math.max(0.5, +localStorage.getItem('talewyn-ab-rate') || 1));
const abCoverUrls = new Map(); // id → objectURL обложки

const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
};
const abNatSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// теги/обложка через jsmediatags (ID3/MP4)
async function readTags(file) {
  const lib = await mediaTags();
  return new Promise(res => {
    if (!lib) return res(null);
    try { lib.read(file, { onSuccess: t => res(t && t.tags), onError: () => res(null) }); }
    catch { res(null); }
  });
}
function tagCover(tags) {
  const p = tags && tags.picture;
  if (!p || !p.data || !p.data.length) return null;
  try { return new Blob([new Uint8Array(p.data)], { type: p.format || 'image/jpeg' }); } catch { return null; }
}
function audioDuration(blob) {
  return new Promise(res => {
    const a = new Audio(), url = URL.createObjectURL(blob);
    let done = false;
    const fin = d => { if (done) return; done = true; try { URL.revokeObjectURL(url); } catch {} res(isFinite(d) && d > 0 ? d : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => fin(a.duration);
    a.onerror = () => fin(0);
    setTimeout(() => fin(a.duration || 0), 8000);
    a.src = url;
  });
}
function abCommonName(names) {
  if (!names.length) return '';
  // убираем расширение И ВЕДУЩИЙ номер трека («01 - имя») у каждого — иначе общий префикс схлопнется
  // до «0» и название книги потеряется (частый формат «01 - книга - 01.mp3»)
  const strip = x => x.replace(/\.[^.]+$/, '').replace(/^\s*(?:part|глава|гл|chapter|ch|track|cd|disc|диск|том|vol|часть)?\.?\s*\d{1,4}\s*[.)\]\-–—_]+\s*/i, '');
  let p = strip(names[0]);
  for (const n of names) { const s = strip(n); while (p && !s.startsWith(p)) p = p.slice(0, -1); }
  return p.replace(/[\s._\-–—]*\d*[\s._\-–—]*$/, '').replace(/[\s._\-–—]+$/, '').trim();   // убираем хвостовой номер трека
}
const abClean = n => n.replace(/\.[^.]+$/, '').replace(/^\s*\d+[\s._\-.)]*/, '').replace(/[_]+/g, ' ').trim();

// стрим-аудиокнига: треки — это URL (в audiotracks кладём {url} вместо {blob}), плеер играет потоком.
// длительность НЕ пробим заранее (у многотрековой книги это долго) — узнаём лениво при первом
// воспроизведении трека и запоминаем (см. abLoadTrack).
async function addStreamAudiobook(items, title) {
  const id = newId('ab');
  const tracks = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const url = typeof it === 'string' ? it : it.url;
    let name = (it && it.title) || '';
    if (!name) {
      try { const bn = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); if (bn) name = abClean(bn); } catch {}
    }
    if (!name) name = 'Трек ' + (i + 1);
    await dbPut('audiotracks', { book: id, idx: i, url });
    tracks.push({ title: name, dur: 0 });
  }
  const rec = {
    id, kind: 'audiobook', stream: true,
    title: title || (tracks[0] && tracks[0].title) || 'Аудиокнига', author: '',
    cover: null, tracks, count: tracks.length, totalDur: 0, addedAt: Date.now(),
  };
  await dbPut('audiobooks', rec);
  return rec;
}
// вытащить треки аудио из HTML страницы: DOM (audio/source/ссылки/og:audio), затем JSON-плейлист
// (пары "title"…"url") и сырой скан. Слэши в URL часто экранированы (\/), заголовки в \uXXXX —
// раскодируем. Возвращаем [{url, title}] в порядке появления, без дублей.
const AUDIO_ALT = 'mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav';
function unesc(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/');
}
// плееры часто прячут файл за редиректом вида /go.php?url=BASE64 — распакуем в прямой аудио-URL
function unwrapAudioUrl(v) {
  const m = /[?&](?:url|link|href|file)=([A-Za-z0-9%+/=_-]{16,})/i.exec(v);
  if (!m) return '';
  let s = m[1]; try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4);
  try { const dec = atob(s); if (/^https?:\/\//i.test(dec) && AUDIO_EXT.test(dec.split('?')[0])) return dec; } catch {}
  return '';
}
function extractAudioTracks(html, baseUrl) {
  const out = [], seen = new Set();
  const add = (rawUrl, title) => {
    if (!rawUrl) return;
    const v = unesc(rawUrl).trim();
    let abs = unwrapAudioUrl(v);                 // сперва пробуем распаковать редирект-обёртку
    if (!abs) { try { abs = new URL(v, baseUrl).href; } catch { return; } }
    if (seen.has(abs)) return; seen.add(abs);
    out.push({ url: abs, title: (title ? unesc(title).trim() : '') });
  };
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('audio[src], audio source[src], video source[src], source[src]').forEach(e => add(e.getAttribute('src'), ''));
    doc.querySelectorAll('a[href]').forEach(e => { const h = e.getAttribute('href'); if (h && AUDIO_EXT.test(h.split('?')[0])) add(h, (e.textContent || '').trim()); });
    doc.querySelectorAll('meta[property="og:audio"], meta[property="og:audio:url"]').forEach(e => add(e.getAttribute('content'), ''));
  } catch {}
  // JSON-плейлист: пара "title":"…" … ("file"|"url"|"src"):"ЗНАЧЕНИЕ".
  // ключ разный у разных плееров; значение принимаем, если это аудио ИЛИ base64-обёртка на аудио
  const pr = new RegExp('"title":"((?:[^"\\\\]|\\\\.)*)"[^{}]*?"(?:file|url|src)":"((?:[^"\\\\]|\\\\.)+?)"', 'gi');
  let p; while ((p = pr.exec(html))) {
    const v = p[2];
    if (AUDIO_EXT.test(unesc(v).split('?')[0]) || unwrapAudioUrl(v)) add(v, p[1]);
  }
  // сырой скан прямых ссылок на аудио — если плеер не в формате title/файл
  const re = new RegExp('https?:(?:\\\\?\\/){2}[^\\s"\'<>)]+?\\.(?:' + AUDIO_ALT + ')(?:\\?[^\\s"\'<>)]*)?', 'gi');
  let m; while ((m = re.exec(html))) add(m[0], '');
  // мобильные варианты (/mobile/) — обычно ужатые дубли; отсеиваем, если есть полные
  const hasFull = out.some(t => !/\/mobile\//i.test(t.url));
  return hasFull ? out.filter(t => !/\/mobile\//i.test(t.url)) : out;
}
function pageTitle(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const og = doc.querySelector('meta[property="og:title"]');
    const t = (og && og.getAttribute('content')) || (doc.querySelector('title') && doc.querySelector('title').textContent) || '';
    return t.trim().slice(0, 200);
  } catch { return ''; }
}

// набор аудиофайлов → одна аудиокнига (треки в естественном порядке)
async function importAudiobook(files, onProgress, job) {
  const list = [...files].sort((a, b) => abNatSort(a.name, b.name));
  const first = await readTags(list[0]).catch(() => null);
  const cover = tagCover(first);
  const title = (first && (first.album || first.title))
    || abClean(list.length > 1 ? (abCommonName(list.map(f => f.name)) || list[0].name) : list[0].name)
    || 'Аудиокнига';
  const author = (first && first.artist) || '';
  const id = newId('ab');
  const tracks = [];
  // Треки пишутся до записи самой аудиокниги — при сбое (а на m4b в сотни мегабайт первым
  // кончается место) они остались бы в базе навсегда: на полке пусто, удалить нечем.
  try {
    for (let i = 0; i < list.length; i++) {
      if (job && job.cancelled) {           // отмена из очереди загрузок — чистим недописанное
        await dropAudiobookLeftovers(id);
        const e = new Error('cancelled'); e.cancelled = true; throw e;
      }
      if (onProgress) onProgress(i / list.length, i);
      const f = list[i];
      const tt = i === 0 ? first : await readTags(f).catch(() => null);
      const trackTitle = (tt && tt.title) || abClean(f.name) || ('Трек ' + (i + 1));
      const dur = await audioDuration(f);
      await dbPut('audiotracks', { book: id, idx: i, blob: f });
      tracks.push({ title: trackTitle, dur });
    }
    const rec = {
      id, kind: 'audiobook', title, author, cover: cover || null,
      tracks, count: tracks.length,
      totalDur: tracks.reduce((s, t) => s + (t.dur || 0), 0),
      addedAt: Date.now(),
    };
    await dbPut('audiobooks', rec);
    return rec;
  } catch (e) {
    await dropAudiobookLeftovers(id);
    if (isQuota(e)) quotaToast();
    throw e;
  }
}

// подчистка недописанной аудиокниги — иначе её треки занимают место, а вернуть его нечем
async function dropAudiobookLeftovers(id) {
  for (const step of [
    () => dbDel('audiotracks', bookRange(id)),
    () => dbDel('audiobooks', id),
    () => dbDel('kv', 'aprog:' + id),
  ]) { try { await step(); } catch { /* чистим что получится */ } }
}

function abCoverUrl(rec) {
  if (!rec || !rec.cover) return null;
  if (!abCoverUrls.has(rec.id)) abCoverUrls.set(rec.id, URL.createObjectURL(rec.cover));
  return abCoverUrls.get(rec.id);
}
async function loadAudiobooks() {
  state.audiobooks = sortShelf(await dbAll('audiobooks'));
}
function abPlayedSeconds(rec, prog) {
  if (!prog) return 0;
  let s = 0;
  for (let i = 0; i < prog.idx && i < rec.tracks.length; i++) s += (rec.tracks[i] && rec.tracks[i].dur) || 0;
  return s + (prog.position || 0);
}
// статус прослушивания: new (не прослушано) / progress (в процессе) / read (прослушано)
const audioFilters = { q: '', status: new Set() };
function abStatusOf(rec, prog) {
  const pct = rec.totalDur ? abPlayedSeconds(rec, prog) / rec.totalDur : 0;
  return pct >= 0.98 ? 'read' : pct > 0.01 ? 'progress' : 'new';
}
// Бегущая строка имени трека в «Продолжить слушать»: включаем анимацию только когда
// текст реально не влезает; скорость постоянная (~24 px/с), паузы по краям — в @keyframes.
function setupContMarquee(scope) {
  const title = scope.querySelector('.cont-title.is-marquee, .cont-title');
  const inner = scope.querySelector('.cont-title .marq');
  if (!title || !inner) return;
  requestAnimationFrame(() => {
    const overflow = inner.scrollWidth - title.clientWidth;
    if (overflow > 4 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      inner.style.setProperty('--marq', overflow + 'px');
      inner.style.setProperty('--marq-dur', Math.max(6, overflow / 24).toFixed(1) + 's');
      title.classList.add('is-marquee');
    } else {
      title.classList.remove('is-marquee');
    }
  });
}
async function renderAudioShelf() {
  const box = $('#audio-content');
  if (!box) return;
  const contBoxEl = $('#audio-continue');
  if (contBoxEl) contBoxEl.innerHTML = '';   // чистим сразу: иначе на пустой полке зависнет старая карточка
  await loadAudiobooks();
  const head = `<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="3" y="13" width="4.5" height="7" rx="2"/><rect x="16.5" y="13" width="4.5" height="7" rx="2"/></svg>`;
  const addBtn = '';   // добавление вынесено в плавающий блок #add-fab, общий для обеих вкладок
  // просмотр каталога: локальные аудиокниги не показываем — никаких пересечений
  // каталога с библиотекой; у книжных каталогов вкладка аудио честно пустая
  const foot = $('#audio-footer');
  if (activeCat) {
    if (activeCat.kind === 'audio') { renderCatAudioShelf(); return; }   // аудио-каталог живёт здесь
    box.innerHTML = `<div class="tab-empty">${head}<p class="tab-empty-title">${esc(t('catNoAudio'))}</p></div>`;
    if (foot) foot.innerHTML = '';
    return;
  }
  if (!state.audiobooks.length && !(activeCol && colCatItems('audio').length)) {
    box.innerHTML = `<div class="tab-empty">${head}<p class="tab-empty-title">${esc(t('abEmptyT'))}</p><p class="tab-empty-sub">${esc(t('abEmptySub'))}</p></div>${addBtn}`;
    if (foot) foot.innerHTML = '';
  } else {
    // прогресс всех аудиокниг — одним запросом (было по запросу на книгу, последовательно)
    const progMap = await kvRange('aprog:');
    const progs = {};
    for (const r of state.audiobooks) progs[r.id] = progMap.get(r.id) || undefined;
    const af = audioFilters;
    // коллекция: единый список в порядке её элементов (аудиокниги и нескачанные записи
    // каталога вперемешку); вне коллекции — обычная полка. Статус прослушивания требует
    // прогресса, поэтому фильтруем им здесь, а не в colOrderedEntries.
    const colEntries = activeCol
      ? colOrderedEntries('audio').filter(en => !en.b || !af.status.size || af.status.has(abStatusOf(en.b, progs[en.b.id])))
      : null;
    let entries = colEntries || state.audiobooks.filter(r => {
      if (af.q) { const q = af.q.toLowerCase(); if (!((r.title || '').toLowerCase().includes(q) || (r.author || '').toLowerCase().includes(q))) return false; }
      if (af.status.size && !af.status.has(abStatusOf(r, progs[r.id]))) return false;
      return true;
    }).map(r => ({ b: r }));
    const shown = entries.filter(en => en.b).map(en => en.b);
    // «Продолжить слушать» — последняя аудиокнига с прогрессом (прячем при фильтре по статусу)
    let cont = null;
    if (!af.status.size && !af.q) for (const r of state.audiobooks) {
      if (activeCol && !colHas(activeCol, 'audio', r.id)) continue;   // в коллекции — только её последняя
      const p = progs[r.id];
      if (p && (p.position > 1 || p.idx > 0) && (!cont || (p.at || 0) > (progs[cont.id].at || 0))) cont = r;
    }
    let contHtml = '';
    if (cont) {
      const p = progs[cont.id];
      const pct = cont.totalDur ? Math.min(100, Math.round((abPlayedSeconds(cont, p) / cont.totalDur) * 100)) : 0;
      const cu = abCoverUrl(cont);
      const face = cu ? `<img class="cover-img" src="${cu}" alt="">` : `<span class="ab-blank">♪</span>`;
      const trTitle = cont.tracks[p.idx] ? cont.tracks[p.idx].title : cont.title;
      contHtml = `<button class="cont-card" data-abcont="${esc(cont.id)}">
        <span class="cont-cover" aria-hidden="true">${face}</span>
        <span class="cont-body">
          <div class="cont-eyebrow">${esc(t('abCont'))}</div>
          <div class="cont-title"><span class="marq">${esc(trTitle)}</span></div>
          <div class="cont-sub">${esc(cont.title)}${pct ? ` · ${pct}%` : ''}</div>
          ${pct ? `<div class="cont-track"><div class="cont-fill" style="width:${pct}%"></div></div>` : ''}
        </span></button>`;
    }
    const revMap = await kvRange('review:');   // отзывы — тоже одним запросом
    const abRevs = {};
    for (const r of shown) abRevs[r.id] = revMap.get(r.id) || null;
    entries = foldEntries(entries, 'audio');   // стопки; раскрытая расставляет свои книги следом
    // карточка аудиокниги (она же — внутри раскрытого сборника)
    const abCardHtml = (r, en) => {
      en = en || {};
      const url = abCoverUrl(r), p = progs[r.id];
      const pct = (p && r.totalDur) ? Math.min(100, Math.round((abPlayedSeconds(r, p) / r.totalDur) * 100)) : 0;
      const rv = abRevs[r.id];
      const stars = rv && rv.stars ? STAR.repeat(rv.stars) : '';
      // структура как у книги: обложка — кнопка (даёт нажатие-отклик), крестик — соседний элемент
      // стрим-аудиокнига: стрелка-скачать слева внизу обложки — как у ВСЕХ скачиваний в приложении
      const dlBadge = !r.stream ? ''
        : abDlBusy.has(r.id)
        ? `<span class="cat-badge busy" aria-hidden="true"><span class="cat-spin"></span></span>`
        : `<span class="cat-badge cat-dl" data-abdl="${esc(r.id)}" role="button" title="${esc(t('abDlBtn'))}" aria-label="${esc(t('abDlBtn'))}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="m6.5 11.5 5.5 5.5 5.5-5.5"/><path d="M5 20h14"/></svg></span>`;
      return `<div class="ab-card${en.inFold ? ' fold-kid' : ''}" data-ab-id="${esc(r.id)}"${en.inFold ? ` data-in-fold="${esc(en.inFold)}"` : ''}${en.colcat ? ` data-colcat="${esc(en.colcat)}"` : ''}>
        <button class="ab-card-cover" data-ab="${esc(r.id)}">${url ? `<img src="${url}" alt="">` : '<span>♪</span>'}
          ${pct ? `<span class="cover-pct">${pct}%</span>` : ''}
          ${dlBadge}<span class="sel-check" aria-hidden="true"></span></button>
        <div class="ab-card-title"><span class="marq">${esc(r.title)}</span></div>
        ${stars ? `<div class="book-stars">${stars}</div>` : ''}
        <div class="ab-card-author">${esc(r.author || '')}</div>
        <div class="ab-card-bar"><i style="width:${pct}%"></i></div>
        <button class="ab-del" data-abdel="${esc(r.id)}" title="${t('deleteT')}" aria-label="${t('deleteT')}">✕</button></div>`;
    };
    const cards = entries.map(en => {
      // раскрытая стопка — секция во всю ширину со своей сеткой внутри
      if (en.f) return folderCardHtml(en.f, en.items, true, en.open, abCardHtml);
      if (en.ph) return colCatCardHtml(en.ph);   // нескачанная запись каталога — со стрелкой
      return abCardHtml(en.b, en);
    }).join('');
    const gridHtml = entries.length ? `<div class="ab-grid">${cards}</div>` : `<div class="shelf-empty"><p class="se-hint">${esc(t('filterNone'))}</p></div>`;
    // «Продолжить слушать» живёт в отдельном блоке НАД фильтрами — как у книг
    const contBox = $('#audio-continue');
    if (contBox) { contBox.innerHTML = contHtml; setupContMarquee(contBox); }
    box.innerHTML = `${gridHtml}${addBtn}`;
    cardMarquee(box);   // одна бегущая строка
    foldGaps(box.querySelector('.ab-grid'));   // добивки вокруг раскрытого сборника
    setFoldCellW(box.querySelector('.ab-grid'));   // ширина книжки в сборнике = ширине ячейки
    if (foldFlipBefore) { flipCards(box.querySelector('.ab-grid'), foldFlipBefore); foldFlipBefore = null; }   // FLIP синхронно
    if (selMode && selKind === 'audio' && activeCol) refreshSelChecks();   // выбор переживает перерисовку
    // счётчик — как у книг: сколько РЕАЛЬНО видно (с фильтрами и внутри коллекции)
    if (foot) foot.innerHTML = `<p>${T('audioN', { n: shown.length })}</p>`;
    pruneCoverUrls(abCoverUrls, new Set([...shown.map(r => r.id), cont ? cont.id : '']));
  }
}

// ── плеер аудиокниги ──
function abViewShow() {
  navToken++;
  $('#shelf-view').hidden = true; $('#library-view').hidden = true; $('#reader-view').hidden = true;
  syncAddFab();
  $('#readbar').hidden = true;
  $('#audio-view').hidden = false;
  nativeScrollbar(false);   // экран аудио — без нативной полосы
  scrollTo(0, 0);
}
// описание аудиокниги на плеере: свёрнуто в 3 строки, тап — развернуть
function renderAudioDesc() {
  const box = $('#ab-desc'); if (!box) return;
  const a = ((ab && ab.rec && ab.rec.annotation) || '').trim();
  box.hidden = !a;
  if (!a) { box.innerHTML = ''; return; }
  // как у книг: текст по ширине, клампится в 4 строки, стрелка разворачивает с анимацией
  box.innerHTML = `<div class="annot-wrap">
    <div class="annot-textbox"><p class="annot-text clamped" id="ab-desc-text">${esc(a)}</p></div>
    <div class="annot-foot">
      <button class="annot-more" id="ab-desc-more" type="button" hidden aria-label="${t('annotMore')}">
        <svg class="annot-more-chev" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
    </div>
  </div>`;
  updateAnnotMore($('#ab-desc-text'), $('#ab-desc-more'));
}
// ── заметки аудиокниги: привязаны к таймкоду (трек + секунда), лежат в rec.notes ──
let editingAudioNote = null;
function abNoteStamp(n) {
  if (!ab || !ab.rec) return fmtTime(n.time || 0);
  const tr = ab.rec.tracks[n.track];
  const many = ab.rec.tracks.length > 1;
  const name = tr ? tr.title : ('Трек ' + ((n.track || 0) + 1));
  return (many ? name + ' · ' : '') + fmtTime(n.time || 0);
}
function abNotesSorted() {
  return ((ab && ab.rec && ab.rec.notes) || []).slice().sort((a, b) => (a.track - b.track) || (a.time - b.time));
}
function refreshAudioNotesBadge() {
  const el = $('#ab-notes-count');
  const n = (ab && ab.rec && ab.rec.notes) ? ab.rec.notes.length : 0;
  if (el) el.textContent = n ? String(n) : '';
}
async function addAudioNote() {
  if (!ab || !ab.rec) return;
  const note = { id: newId('an'), track: ab.idx, time: Math.floor(audioBookEl.currentTime || 0), color: 'y', note: '', at: Date.now() };
  ab.rec.notes = ab.rec.notes || [];
  ab.rec.notes.push(note);
  try { await dbPut('audiobooks', ab.rec); } catch {}
  refreshAudioNotesBadge();
  openAudioNoteEditor(note);
}
function openAudioNoteEditor(note) {
  editingAudioNote = note; editingNote = null;
  sheetHide($('#ab-notes-sheet'), $('#ab-notes-overlay'));   // не перекрываем список — прячем его
  $('#note-excerpt').textContent = abNoteStamp(note);
  $('#note-text').value = note.note || '';
  for (const b of document.querySelectorAll('#note-colors button')) b.classList.toggle('on', b.dataset.c === note.color);
  const jump = $('#note-jump'); if (jump) jump.hidden = false;
  sheetShow($('#note-sheet'), $('#note-overlay'));
}
function renderAudioNotes() {
  const box = $('#ab-notes-list'); if (!box) return;
  const notes = abNotesSorted();
  if (!notes.length) { box.innerHTML = `<p class="sr-empty">${t('noNotesA')}</p>`; return; }
  const fmtDate = ts => new Date(ts).toLocaleDateString(uiLang() === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short' });
  box.innerHTML = notes.map(n => `<div class="note-item" data-abnote="${esc(n.id)}">
    <span class="note-dot c-${NOTE_COLORS.includes(n.color) ? n.color : 'y'}"></span>
    <div class="note-body">
      <div class="note-exc">${esc(abNoteStamp(n))}</div>
      ${n.note ? `<div class="note-txt">${esc(n.note)}</div>` : ''}
      <div class="note-when">${fmtDate(n.at)}</div>
    </div>
    <button class="note-del icon-btn" data-abnote-del="${esc(n.id)}" title="${t('noteDelete')}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
  </div>`).join('');
}
function audioNotesMarkdown() {
  const rec = ab && ab.rec; if (!rec) return '';
  const lines = [`# ${rec.title}${rec.author ? ' — ' + rec.author : ''}`, ''];
  for (const n of abNotesSorted()) {
    lines.push(`## ${abNoteStamp(n)}`);
    if (n.note) lines.push(n.note);
    lines.push('');
  }
  return lines.join('\n');
}
function bookNoteCopyText(n) {
  const parts = [];
  if (n.text) parts.push('«' + n.text + '»');
  if (n.note) parts.push(n.note);
  return parts.join('\n');
}
function audioNoteCopyText(n) {
  const parts = [abNoteStamp(n)];
  if (n.note) parts.push(n.note);
  return parts.join('\n');
}
// долгое нажатие по заметке → копирование (без открытия редактора). touch + мышь.
function bindNoteLongPress(container, resolve) {
  if (!container) return;
  let timer = null, longFired = false, sx = 0, sy = 0;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const start = (x, y, item) => {
    longFired = false; sx = x; sy = y; clear();
    timer = setTimeout(() => {
      timer = null; longFired = true;
      const txt = resolve(item);
      if (txt) copyText(txt).then(ok => showToast(ok ? t('copied') : t('copyFail')));
    }, 480);
  };
  const onDown = (x, y, target) => {
    const item = target.closest && target.closest('.note-item'); if (!item) return;
    if (target.closest('.note-del, [data-note-del], [data-abnote-del]')) return;
    start(x, y, item);
  };
  container.addEventListener('touchstart', e => { const t0 = e.touches[0]; if (t0) onDown(t0.clientX, t0.clientY, e.target); }, { passive: true });
  container.addEventListener('touchmove', e => { const t0 = e.touches[0]; if (timer && t0 && (Math.abs(t0.clientX - sx) > 10 || Math.abs(t0.clientY - sy) > 10)) clear(); }, { passive: true });
  container.addEventListener('touchend', clear);
  container.addEventListener('touchcancel', clear);
  container.addEventListener('mousedown', e => onDown(e.clientX, e.clientY, e.target));
  container.addEventListener('mousemove', e => { if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) clear(); });
  container.addEventListener('mouseup', clear);
  // подавляем тап/клик, если только что сработало долгое нажатие
  container.addEventListener('click', e => { if (longFired) { e.stopPropagation(); e.preventDefault(); longFired = false; } }, true);
}
function openAudioNotes() {
  if (!ab || !ab.rec) return;
  renderAudioNotes();
  const lbl = $('#ab-note-add-label');
  if (lbl) lbl.textContent = t('noteT') + ' · ' + fmtTime(Math.floor(audioBookEl.currentTime || 0));
  sheetShow($('#ab-notes-sheet'), $('#ab-notes-overlay'));
}
function abNoteJump(note) {
  if (!ab || !ab.rec || !note) return;
  sheetHide($('#note-sheet'), $('#note-overlay'));
  sheetHide($('#ab-notes-sheet'), $('#ab-notes-overlay'));
  editingAudioNote = null;
  const jb = $('#note-jump'); if (jb) jb.hidden = true;
  abLoadTrack(note.track || 0, note.time || 0, true);
}
async function openAudiobook(id) {
  const rec = (state.audiobooks && state.audiobooks.find(r => r.id === id)) || await dbGet('audiobooks', id);
  if (!rec) { location.hash = '#/'; return; }
  ttsStop();
  ab = { rec, idx: 0 };
  const prog = await kvGet('aprog:' + id);
  ab.idx = (prog && prog.idx < rec.tracks.length) ? prog.idx : 0;
  const resume = (prog && prog.idx === ab.idx) ? (prog.position || 0) : 0;
  abViewShow();
  const cu = abCoverUrl(rec);
  $('#ab-cover-face').innerHTML = cu ? `<img src="${cu}" alt="">` : '<span class="ab-cover-fallback">♪</span>';
  $('#ab-title').textContent = rec.title;
  $('#ab-author').textContent = rec.author || '';
  $('#ab-crumbs').textContent = rec.title;
  renderAudioDesc();
  refreshAudioNotesBadge();
  refreshAudioReviewBadge();
  $('#ab-tracks-count').textContent = rec.tracks.length;
  $('#ab-rate-value').textContent = fmtAbRate(abRate);
  renderAbTracklist();
  abSyncPlayUI();
  await abLoadTrack(ab.idx, resume, false);
}
async function abLoadTrack(idx, pos, autoplay) {
  if (!ab) return;
  idx = Math.max(0, Math.min(ab.rec.tracks.length - 1, idx));
  ab.idx = idx;
  let row = null;
  try { row = await dbGet('audiotracks', [ab.rec.id, idx]); } catch {}
  if (!ab) return;                 // плеер закрыли, пока читали трек из базы
  if (!row || (!row.blob && !row.url)) return;
  if (ab._url) { try { URL.revokeObjectURL(ab._url); } catch {} ab._url = null; }
  if (row.url) audioBookEl.src = row.url;                    // стрим по ссылке — без скачивания
  else { ab._url = URL.createObjectURL(row.blob); audioBookEl.src = ab._url; }
  audioBookEl.playbackRate = abRate;
  setMarquee($('#ab-track-title'), ab.rec.tracks[idx].title);   // длинное название поедет строкой
  highlightAbTrack(idx);
  pushMedia();                     // сменился трек — обновляем название в системном плеере
  let started = false;
  const start = () => {
    if (started) return; started = true;
    // стрим: длительность трека узнаём лениво из метаданных потока и запоминаем в записи
    if (ab.rec.stream && !ab.rec.tracks[idx].dur && isFinite(audioBookEl.duration) && audioBookEl.duration > 0) {
      ab.rec.tracks[idx].dur = audioBookEl.duration;
      ab.rec.totalDur = ab.rec.tracks.reduce((s, t) => s + (t.dur || 0), 0);
      dbPut('audiobooks', ab.rec).catch(() => {});
      try { renderAbTracklist(); } catch {}
    }
    if (pos > 0) { try { audioBookEl.currentTime = pos; } catch {} }
    abUpdateSeek();
    if (autoplay) abPlay();   // автопродолжение при переходе на следующий трек
  };
  audioBookEl.addEventListener('loadedmetadata', start, { once: true });
  audioBookEl.load();
  // страховка: если метаданные уже готовы или пришли раньше подписки
  if (audioBookEl.readyState >= 1) start();
}
function abPlay() {
  if (!ab) return;
  ttsStop();
  audioBookEl.playbackRate = abRate;
  audioBookEl.play().then(() => { ab.playing = true; abSyncPlayUI(); bgAudio(true); updateWakeLock(); abVizStart(); }).catch(() => {});
}
function abPause() {
  audioBookEl.pause();
  if (ab) ab.playing = false;
  abSyncPlayUI(); bgAudio(false); abSaveProgress(); updateWakeLock(); abVizStop();
}
function abToggle() { if (audioBookEl.paused) abPlay(); else abPause(); }
function abSyncPlayUI() {
  const b = $('#ab-play'); if (b) b.innerHTML = audioBookEl.paused ? PLAY_SVG : PAUSE_SVG;
  const v = $('#audio-view'); if (v) v.classList.toggle('playing', !audioBookEl.paused);   // свечение снизу при игре
}
// ── свечение реагирует на ГОЛОС: анализируем громкость через Web Audio (копию потока
//    через captureStream — НЕ перенаправляя основной выход, чтобы не сломать фон) ──
let abAudioCtx = null, abAnalyser = null, abVizData = null, abVizRaf = 0, abVizSrc = null;
function abVizSetup() {
  if (abAnalyser) return true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || typeof audioBookEl.captureStream !== 'function') return false;
    const stream = audioBookEl.captureStream();
    if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().length) return false;
    abAudioCtx = new Ctx();
    abVizSrc = abAudioCtx.createMediaStreamSource(stream);
    abAnalyser = abAudioCtx.createAnalyser();
    abAnalyser.fftSize = 256; abAnalyser.smoothingTimeConstant = 0.82;
    abVizSrc.connect(abAnalyser);   // без connect к destination — звук идёт сам, анализируем копию
    abVizData = new Uint8Array(abAnalyser.frequencyBinCount);
    return true;
  } catch { abAnalyser = null; return false; }
}
function abVizTick() {
  const glow = $('#ab-glow');
  if (!glow || !abAnalyser) { abVizRaf = 0; return; }
  abAnalyser.getByteFrequencyData(abVizData);
  let sum = 0; for (let i = 0; i < abVizData.length; i++) sum += abVizData[i];
  const level = sum / abVizData.length / 255;   // 0..1 средняя громкость
  glow.style.opacity = Math.min(0.5, 0.06 + level * 0.95).toFixed(3);
  abVizRaf = requestAnimationFrame(abVizTick);
}
function abVizStart() {
  const ok = abVizSetup();
  const v = $('#audio-view'); if (v) v.classList.toggle('viz', ok);   // .viz — JS рулит яркостью (иначе CSS-дыхание)
  if (!ok) return;
  if (abAudioCtx.state === 'suspended') abAudioCtx.resume().catch(() => {});
  if (!abVizRaf) abVizRaf = requestAnimationFrame(abVizTick);
}
function abVizStop() {
  if (abVizRaf) { cancelAnimationFrame(abVizRaf); abVizRaf = 0; }
  const glow = $('#ab-glow'); if (glow) glow.style.opacity = '';
}
function abPrev() {
  if (!ab) return;
  if (audioBookEl.currentTime > 3 || ab.idx === 0) { try { audioBookEl.currentTime = 0; } catch {} abSaveProgress(); }
  else abLoadTrack(ab.idx - 1, 0, ab.playing);
}
// был ли включён воспроизвод: on 'ended' элемент уже paused, поэтому опираемся на ab.playing
function abNext() {
  if (!ab) return;
  if (ab.idx + 1 < ab.rec.tracks.length) abLoadTrack(ab.idx + 1, 0, ab.playing);
  else { abPause(); try { audioBookEl.currentTime = 0; } catch {} }
}
function abSkip(delta) {
  const d = audioBookEl.duration || 0;
  try { audioBookEl.currentTime = Math.max(0, Math.min(d, (audioBookEl.currentTime || 0) + delta)); } catch {}
  abUpdateSeek();
}
let abSeeking = false;
function abUpdateSeek() {
  const d = audioBookEl.duration || 0, c = audioBookEl.currentTime || 0;
  const s = $('#ab-seek');
  if (s && !abSeeking) s.value = d ? Math.round((c / d) * 1000) : 0;
  if (s) s.style.setProperty('--seek-fill', ((+s.value || 0) / 10) + '%');   // прослушанная часть — залита
  const cur = $('#ab-cur'); if (cur) cur.textContent = fmtTime(c);
  const tot = $('#ab-total'); if (tot) tot.textContent = fmtTime(d);
}
let abSaveT = 0;
function abSaveProgress() {
  if (!ab) return;
  kvSet('aprog:' + ab.rec.id, { idx: ab.idx, position: audioBookEl.currentTime || 0, at: Date.now() });
}
function fmtAbRate(r) { return (Number.isInteger(r) ? r.toFixed(1) : String(r)) + '×'; }
// ── скачивание треков стрим-аудиокниги: слушать без сети ──
// Вход — та же стрелка слева внизу обложки, что у всех скачиваний (карточка на полке).
// Треки-URL по одному вытягиваются и подменяются в audiotracks на blob'ы. Скачались все —
// запись перестаёт быть стримом и стрелка исчезает; часть не далась — url остаются,
// стрелка живёт для повтора.
const abDlBusy = new Set();   // id аудиокниг, чьи треки сейчас скачиваются (или ждут очереди)
let abDlChain = Promise.resolve();   // выбрали пачку — качаем по одной, а не всё сразу в сеть
// спиннер ставим СРАЗУ на все выбранные, работу выстраиваем в очередь
function abDownloadTracks(rec) {
  if (!rec || !rec.stream || abDlBusy.has(rec.id)) return;
  if (!netOnline) { probeNet(); showToast(t('urlNoNet')); return; }
  abDlBusy.add(rec.id);
  if (!$('#shelf-view').hidden) renderAudioShelf();
  abDlChain = abDlChain
    .then(() => abDlRun(rec))
    .catch(() => {})
    .then(() => {
      abDlBusy.delete(rec.id);
      if (!$('#shelf-view').hidden) renderAudioShelf();
    });
}
async function abDlRun(rec) {
  let rows = [];
  try { rows = (await dbAll('audiotracks', bookRange(rec.id))).filter(r => r.url && !r.blob); } catch {}
  if (!rows.length) {   // всё уже локально (например, докачали в прошлый раз) — снимаем флаг
    rec.stream = false;
    try { await dbPut('audiobooks', rec); } catch {}
    return;
  }
  const job = dlAdd('audio', rec.title, rows.length);
  job.status = 'active'; renderDlList();
  const ctrl = new AbortController(); job.abort = () => ctrl.abort();
  let ok = 0, fail = 0;
  try {
    for (let ti = 0; ti < rows.length; ti++) {
      const row = rows[ti];
      if (job.cancelled) break;
      try {
        // прогресс сквозной по всем трекам: внутри трека дробим его долю
        const frac = f => { job.frac = (ti + f) / rows.length; renderDlList(); };
        // треки бывают в сотни МБ — качаем кусками (Range), а не одной строкой через мост
        const got = (isNative && capHttp)
          ? await dlNativeBig(row.url, frac, 400 * 1024 * 1024, ctrl.signal)
          : await dlWeb(row.url, frac, ctrl.signal);
        if (!got.blob || !got.blob.size) throw new Error('empty');
        await dbPut('audiotracks', { book: row.book, idx: row.idx, blob: got.blob });
        ok++;
      } catch (e) {
        if (job.cancelled || (e && e.name === 'AbortError')) break;
        fail++;
      }
      job.done = ok + fail; job.frac = (ok + fail) / rows.length; renderDlList();
    }
  } finally {
    dlRemove(job);
  }
  if (!job.cancelled) {
    if (!fail) {
      rec.stream = false;   // всё локально — это больше не стрим
      try { await dbPut('audiobooks', rec); } catch {}
      showToast(T('abDlDone', { n: ok }));
    } else showToast(T('abDlPart', { ok, n: rows.length }));
  }
}

function renderAbTracklist() {
  const box = $('#ab-tracklist');
  if (!box || !ab) return;
  box.innerHTML = ab.rec.tracks.map((tr, i) =>
    `<button class="ab-track-row${i === ab.idx ? ' cur' : ''}" data-abtrack="${i}">
      <span class="abt-n">${i + 1}</span><span class="abt-t">${esc(tr.title)}</span>
      <span class="abt-d">${tr.dur ? fmtTime(tr.dur) : ''}</span></button>`).join('');
}
function highlightAbTrack(idx) {
  for (const el of document.querySelectorAll('#ab-tracklist .ab-track-row'))
    el.classList.toggle('cur', +el.dataset.abtrack === idx);
}
function closeAudioView() {
  abPause();
  // blob трека держит в памяти весь файл (у m4b — книгу целиком): без revoke он остаётся
  // закреплён до перезагрузки, и WebView умирает после нескольких открытий
  if (ab && ab._url) { try { URL.revokeObjectURL(ab._url); } catch {} ab._url = null; }
  ab = null;
  pushMedia();                     // плеер закрыт — убираем карточку из шторки
  $('#audio-view').hidden = true;
  location.hash = '#/';
  showShelf(); setShelfTab('audio');
}
async function deleteAudiobook(id) {
  const rec = state.audiobooks.find(r => r.id === id);
  if (!rec) return;
  if (!(await uiConfirm(T('deleteBookQ', { x: rec.title }), { yes: t('dlgDelete'), danger: true }))) return;
  if (ab && ab.rec.id === id) {
    abPause();
    // blob трека держит файл в памяти целиком — без revoke удалённая аудиокнига
    // продолжает занимать память до перезагрузки приложения
    if (ab._url) { try { URL.revokeObjectURL(ab._url); } catch {} }
    ab = null;
    pushMedia();
    $('#audio-view').hidden = true;
  }
  await dbDel('audiotracks', bookRange(id));
  await dbDel('audiobooks', id);
  await dbDel('kv', 'aprog:' + id);
  await dbDel('kv', 'review:' + id);   // как у книг (deleteBook) — иначе отзыв остаётся сиротой
  await purgeFromCollections('audio', id);   // убрать из всех коллекций
  if (abCoverUrls.has(id)) { try { URL.revokeObjectURL(abCoverUrls.get(id)); } catch {} abCoverUrls.delete(id); }
  await loadAudiobooks();
  renderAudioShelf();
  showToast(t('bookDeleted'));
}

// таймер сна аудиокниги (как у озвучки: тап циклит, зажать-крутить — барабан)
let abSleep = { mins: 0, deadline: 0, to: null, tick: null };
const abSleepIdx = () => { const i = SLEEP_MINS.indexOf(abSleep.mins); return i < 0 ? 0 : i; };
function abSleepRender(mins, shown) {
  const btn = $('#ab-timer'); if (!btn) return;
  const num = $('#ab-timer-num');
  if (mins > 0) { btn.classList.add('on'); if (num) num.textContent = String(shown != null ? shown : mins); }
  else { btn.classList.remove('on'); if (num) num.textContent = ''; }
}
function abSleepTick() {
  if (abSleep.deadline <= 0) return;
  abSleepRender(abSleep.mins, Math.max(1, Math.ceil((abSleep.deadline - performance.now()) / 60000)));
}
function abSleepClear() { clearTimeout(abSleep.to); clearInterval(abSleep.tick); abSleep = { mins: 0, deadline: 0, to: null, tick: null }; abSleepRender(0); }
function abSleepSet(mins) {
  clearTimeout(abSleep.to); clearInterval(abSleep.tick);
  abSleep.mins = mins;
  if (mins <= 0) { abSleep.deadline = 0; abSleep.to = abSleep.tick = null; abSleepRender(0); return; }
  abSleep.deadline = performance.now() + mins * 60000;
  abSleep.to = setTimeout(() => { abSleepClear(); abPause(); showToast(t('sleepFired')); }, mins * 60000);
  abSleep.tick = setInterval(abSleepTick, 20000);
  abSleepTick();
  showToast(T('sleepSet', { m: mins }));
}

audioBookEl.addEventListener('timeupdate', () => {
  abUpdateSeek();
  const now = performance.now();
  if (now - abSaveT > 5000) { abSaveT = now; abSaveProgress(); }
});
audioBookEl.addEventListener('ended', () => { abSaveProgress(); abNext(); });
// Систему тоже может остановить нас: входящий звонок, другой плеер, наушники вынули.
// Без этих слушателей ab.playing врёт — кнопка показывает «Пауза», а карточка в шторке
// думает, что мы играем. Ловим состояние самого элемента и приводим всё в соответствие.
audioBookEl.addEventListener('pause', () => {
  if (!ab || !ab.playing) return;
  ab.playing = false; abSyncPlayUI(); abVizStop(); abSaveProgress(); updateWakeLock(); pushMedia();
});
audioBookEl.addEventListener('play', () => {
  if (!ab || ab.playing) return;
  ab.playing = true; abSyncPlayUI(); abVizStart(); updateWakeLock(); pushMedia();
});

function bindAudioUI() {
  $('#audio-back').addEventListener('click', closeAudioView);
  $('#ab-play').addEventListener('click', abToggle);
  $('#ab-prev').addEventListener('click', abPrev);
  $('#ab-next').addEventListener('click', abNext);
  $('#ab-back15').addEventListener('click', () => abSkip(-15));
  $('#ab-fwd15').addEventListener('click', () => abSkip(15));
  const seek = $('#ab-seek');
  seek.addEventListener('pointerdown', () => { abSeeking = true; });
  seek.addEventListener('input', () => {
    const d = audioBookEl.duration || 0;
    const cur = $('#ab-cur'); if (cur) cur.textContent = fmtTime((seek.value / 1000) * d);
    seek.style.setProperty('--seek-fill', ((+seek.value || 0) / 10) + '%');
  });
  const commitSeek = () => {
    const d = audioBookEl.duration || 0;
    if (d) { try { audioBookEl.currentTime = (seek.value / 1000) * d; } catch {} }
    abSeeking = false; abSaveProgress();
  };
  seek.addEventListener('change', commitSeek);
  seek.addEventListener('pointerup', commitSeek);
  $('#ab-tracklist').addEventListener('click', e => {
    const r = e.target.closest('[data-abtrack]');
    if (r) abLoadTrack(+r.dataset.abtrack, 0, true);
  });
  // список треков раскрывается/сворачивается плавно, а не появляется рывком
  let abTracksTimer = null;
  $('#ab-tracks-btn').addEventListener('click', () => {
    const l = $('#ab-tracklist');
    const want = l.hidden;
    clearTimeout(abTracksTimer);
    $('#ab-tracks-btn').classList.toggle('open', want);
    if (want) {
      l.classList.remove('open');
      l.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => l.classList.add('open')));
      const cur = l.querySelector('.ab-track-row.cur');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    } else {
      l.classList.remove('open');
      abTracksTimer = setTimeout(() => { l.hidden = true; }, 240);
    }
  });
  // скорость — колесо, как в озвучке
  const setAbRate = (idx, live) => {
    idx = Math.max(0, Math.min(RATES_AB.length - 1, idx));
    abRate = RATES_AB[idx];
    localStorage.setItem('talewyn-ab-rate', String(abRate));
    audioBookEl.playbackRate = abRate;
    $('#ab-rate-value').textContent = fmtAbRate(abRate);
  };
  const abRateIdx = () => { const i = RATES_AB.findIndex(r => Math.abs(r - abRate) < 0.01); return i < 0 ? 1 : i; };
  bindWheelDial($('#ab-speed'), {
    labels: RATES_AB.map(fmtAbRate), getIdx: abRateIdx,
    onLive: idx => setAbRate(idx, true), onCommit: idx => setAbRate(idx, false),
    onTap: () => setAbRate((abRateIdx() + 1) % RATES_AB.length, false),
  });
  bindWheelDial($('#ab-timer'), {
    labels: SLEEP_MINS.map(m => m === 0 ? t('sleepOff') : m + ' мин'), getIdx: abSleepIdx,
    onLive: idx => abSleepRender(SLEEP_MINS[idx], SLEEP_MINS[idx]),
    onCommit: idx => abSleepSet(SLEEP_MINS[idx]),
    onTap: () => abSleepSet(SLEEP_MINS[(abSleepIdx() + 1) % SLEEP_MINS.length]),
  });
}
const RATES_AB = [0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// ══════════════════ выделения и заметки ══════════════════
// Якорь — смещения в тексте главы (textContent #chapter-body): HTML главы
// после импорта неизменен, поэтому такие ссылки не «плывут».

// смещение символа под точкой тапа внутри элемента el (в системе координат el.textContent —
// та же, что у it.base у предложений), чтобы озвучивать ровно то предложение, куда ткнули
function caretOffsetAt(el, x, y) {
  let node = null, off = 0;
  const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
  if (r) { node = r.startContainer; off = r.startOffset; }
  else if (document.caretPositionFromPoint) {
    const cp = document.caretPositionFromPoint(x, y);
    if (cp) { node = cp.offsetNode; off = cp.offset; }
  }
  if (!node || !el.contains(node)) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  try { pre.setEnd(node, off); } catch { return 0; }
  return pre.toString().length;
}

function selectionInfo() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const body = $('#chapter-body');
  const r = sel.getRangeAt(0);
  if (!body.contains(r.startContainer) || !body.contains(r.endContainer)) return null;
  // выделение, задевающее вставки перевода, к тексту книги не привязать
  const frag = r.cloneContents();
  if (frag.querySelector && frag.querySelector('.tr-block')) return null;
  const start = absFromPoint(body, r.startContainer, r.startOffset);
  if (start < 0) return null;
  const text = r.toString();
  if (!text.trim()) return null;
  return { start, end: start + text.length, text };
}

function renderNoteHighlights() {
  if (!HL) return;
  for (const c of NOTE_COLORS) HL['nt' + c].clear();
  HL.ntnote.clear();
  const body = $('#chapter-body');
  for (const n of state.chNotes || []) {
    const r = rangeFromOffsets(body, n.start, n.end);
    if (!r) continue;
    HL['nt' + (NOTE_COLORS.includes(n.color) ? n.color : 'y')].add(r);
    if (n.note) HL.ntnote.add(r);
  }
}
function clearNoteHl() {
  if (!HL) return;
  for (const c of NOTE_COLORS) HL['nt' + c].clear();
  HL.ntnote.clear();
}

async function addNote(color, withEditor) {
  const info = selectionInfo() || selCache;
  const ch = state.chapter;
  if (!info || !ch || !state.book) return null;
  state.chNotes = state.chNotes || [];
  const rec = {
    id: newId('n'), book: state.book.id, idx: ch.idx,
    start: info.start, end: info.end,
    text: info.text.slice(0, 500).trim(),
    color, note: '', at: Date.now(),
  };
  // не записалась — не делаем вид, что заметка есть: иначе она исчезнет при перезапуске
  if (!(await saveGuard(() => dbPut('notes', rec)))) return null;
  state.chNotes.push(rec);
  renderNoteHighlights();
  getSelection().removeAllRanges();
  hideSelToolbar();
  if (withEditor) openNoteSheet(rec);
  return rec;
}

// снять маркеры/заметки, задетые выделением
async function eraseSelectionMarks() {
  const info = selectionInfo() || selCache;
  getSelection().removeAllRanges();
  hideSelToolbar();
  if (!info) return;
  const hits = (state.chNotes || []).filter(n => info.start < n.end && info.end > n.start);
  if (!hits.length) { showToast(t('noMarkHere')); return; }
  for (const n of hits) await dbDel('notes', n.id);
  state.chNotes = (state.chNotes || []).filter(n => !hits.includes(n));
  renderNoteHighlights();
  showToast(T('marksCleared', { n: hits.length }), t('undo'), async () => {
    for (const n of hits) await dbPut('notes', n);
    if (state.chapter && hits[0] && state.chapter.idx === hits[0].idx) {
      state.chNotes.push(...hits);
      renderNoteHighlights();
    }
  });
}

// точка касания → смещение в тексте → заметка под пальцем
function noteAtPoint(x, y) {
  let node, off;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    node = p.offsetNode; off = p.offset;
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (!r) return null;
    node = r.startContainer; off = r.startOffset;
  } else return null;
  const body = $('#chapter-body');
  if (!node || node.nodeType !== 3 || !body.contains(node)) return null;
  const abs = absFromPoint(body, node, off);
  if (abs < 0) return null;
  return (state.chNotes || []).find(n => abs >= n.start && abs < n.end) || null;
}

// ── лист редактирования заметки ──
let editingNote = null;
let selCache = null;   // кэш живого выделения: тап по панели может его сбросить
function openNoteSheet(rec) {
  editingNote = rec;
  editingAudioNote = null;
  const jump = $('#note-jump'); if (jump) jump.hidden = true;
  const chLabel = (state.book && state.book.titles && state.book.titles[rec.idx])
    || ((uiLang() === 'ru' ? 'Глава ' : 'Chapter ') + ((rec.idx || 0) + 1));
  $('#note-excerpt').textContent = rec.text
    ? ('«' + rec.text.slice(0, 180) + (rec.text.length > 180 ? '…' : '') + '»')
    : chLabel;   // заметка из меню (без выделения) — показываем главу
  $('#note-text').value = rec.note || '';
  for (const b of document.querySelectorAll('#note-colors button'))
    b.classList.toggle('on', b.dataset.c === rec.color);
  sheetShow($('#note-sheet'), $('#note-overlay'));
}
function closeNoteSheet() {
  const wasAudio = !!editingAudioNote;
  sheetHide($('#note-sheet'), $('#note-overlay'));
  editingNote = null;
  editingAudioNote = null;
  const jump = $('#note-jump'); if (jump) jump.hidden = true;
  // после редактора аудио-заметки возвращаем список (без наложения)
  if (wasAudio) { renderAudioNotes(); sheetShow($('#ab-notes-sheet'), $('#ab-notes-overlay')); }
  // список заметок книги обновляем при ЛЮБОМ закрытии редактора (не только по «Сохранить»):
  // иначе добавленная заметка не появлялась, пока список не переоткроют.
  else if (!$('#notes-list').hidden) { renderNotesList(); refreshNotesBadge(); }
}
// Сбой записи заметки нельзя терять молча: раньше шторка не закрывалась, тоста не было,
// человек жал «Сохранить» ещё раз — и текст пропадал. Закрываем шторку только после успеха.
async function saveNote() {
  if (editingAudioNote) {   // заметка аудиокниги
    editingAudioNote.note = $('#note-text').value.trim();
    const sel = document.querySelector('#note-colors button.on');
    if (sel) editingAudioNote.color = sel.dataset.c;
    if (ab && ab.rec) {
      if (!(await saveGuard(() => dbPut('audiobooks', ab.rec)))) return;
    }
    refreshAudioNotesBadge(); renderAudioNotes();
    closeNoteSheet();
    return;
  }
  if (!editingNote) return;
  editingNote.note = $('#note-text').value.trim();
  const sel = document.querySelector('#note-colors button.on');
  if (sel) editingNote.color = sel.dataset.c;
  if (!(await saveGuard(() => dbPut('notes', editingNote)))) return;
  renderNoteHighlights();
  if (!$('#notes-list').hidden) { renderNotesList(); refreshNotesBadge(); }   // список — в реальном времени
  closeNoteSheet();
}
async function deleteNote() {
  if (editingAudioNote) {   // заметка аудиокниги
    const id = editingAudioNote.id;
    if (ab && ab.rec) { ab.rec.notes = (ab.rec.notes || []).filter(n => n.id !== id); try { await dbPut('audiobooks', ab.rec); } catch {} }
    refreshAudioNotesBadge(); renderAudioNotes();
    closeNoteSheet();
    return;
  }
  if (!editingNote) return;
  const rec = editingNote;
  await dbDel('notes', rec.id);
  state.chNotes = (state.chNotes || []).filter(n => n.id !== rec.id);
  renderNoteHighlights();
  if (!$('#notes-list').hidden) { renderNotesList(); refreshNotesBadge(); }   // список — в реальном времени
  closeNoteSheet();
  showToast(t('noteDeleted'), t('undo'), async () => {
    await dbPut('notes', rec);
    if (state.chapter && state.chapter.idx === rec.idx) {
      state.chNotes.push(rec);
      renderNoteHighlights();
    }
    if (!$('#notes-list').hidden) { renderNotesList(); refreshNotesBadge(); }
  });
}

// ── список заметок книги (в оглавлении) ──
let bookNotesCache = [];
let pendingNoteJump = null;

async function refreshNotesBadge() {
  if (!state.book) return;
  const notes = await dbByIndex('notes', 'byBook', state.book.id);
  $('#notes-count').textContent = notes.length ? String(notes.length) : '';
}

async function renderNotesList() {
  const box = $('#notes-list');
  bookNotesCache = (await dbByIndex('notes', 'byBook', state.book.id))
    .sort((a, b) => a.idx - b.idx || a.start - b.start);
  const has = bookNotesCache.length > 0;
  // Голова (кнопка «Заметка» + действия) — ПОСТОЯННАЯ: строим один раз, дальше
  // только переключаем класс. Тогда появление/скрытие действий и сужение кнопки
  // идут плавным CSS-переходом (при полном innerHTML узлы пересоздавались бы = рывок).
  let head = box.querySelector('.notes-head');
  if (!head) {
    box.innerHTML =
      `<div class="notes-head">` +
        `<button class="chip" id="notes-add-btn"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg> <span id="notes-add-label"></span></button>` +
        `<div class="notes-head-actions" aria-hidden="true">` +
          `<button class="chip notes-copy-btn" id="notes-copy"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg></button>` +
          `<button class="chip notes-del-all-btn" id="notes-del-all"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>` +
        `</div>` +
      `</div>` +
      `<div id="notes-items"></div>`;
    head = box.querySelector('.notes-head');
    void head.offsetWidth;   // зафиксировать исходный стиль, чтобы первый показ действий тоже анимировался
  }
  // подписи/подсказки могли смениться с языком — обновляем на постоянных узлах
  $('#notes-add-label').textContent = t('noteT');
  const cp = $('#notes-copy'); if (cp) { cp.title = t('copyAll'); cp.setAttribute('aria-label', t('copyAll')); }
  const delAllLabel = uiLang() === 'ru' ? 'Удалить все заметки' : 'Delete all notes';
  const da = $('#notes-del-all'); if (da) { da.title = delAllLabel; da.setAttribute('aria-label', delAllLabel); }
  head.classList.toggle('has-actions', has);
  head.querySelector('.notes-head-actions').setAttribute('aria-hidden', has ? 'false' : 'true');

  const items = $('#notes-items');
  if (!has) { items.innerHTML = `<p class="sr-empty">${t('noNotes')}</p>`; return; }
  const titles = state.book.titles || [];
  const fmtDate = ts => new Date(ts).toLocaleDateString(
    uiLang() === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short' });
  let lastIdx = -1;
  const parts = [];
  for (const n of bookNotesCache) {
    if (n.idx !== lastIdx) {
      lastIdx = n.idx;
      parts.push(`<p class="sr-head">${esc(titles[n.idx] || '#' + (n.idx + 1))}</p>`);
    }
    parts.push(`<div class="note-item" data-note-id="${n.id}">
      <span class="note-dot c-${NOTE_COLORS.includes(n.color) ? n.color : 'y'}"></span>
      <div class="note-body">
        ${n.text ? `<div class="note-exc">«${esc(n.text.slice(0, 140))}${n.text.length > 140 ? '…' : ''}»</div>` : ''}
        ${n.note ? `<div class="note-txt">${esc(n.note)}</div>` : ''}
        <div class="note-when">${fmtDate(n.at)}</div>
      </div>
      <button class="note-del icon-btn" data-note-del="${n.id}" title="${t('noteDelete')}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`);
  }
  items.innerHTML = parts.join('');
}

// последняя читаемая глава — к ней привязываем заметку, созданную из меню (без выделения текста)
function lastReadIdx() {
  const m = (state.progress && state.progress.map) || {};
  let best = 0;
  for (const k in m) { if (m[k] && m[k].percent > 0.001) best = Math.max(best, +k); }
  return best;
}
async function addBookNoteFromMenu() {
  if (!state.book) return;
  const idx = lastReadIdx();
  const rec = { id: newId('n'), book: state.book.id, idx, start: 0, end: 0, text: '', color: 'y', note: '', at: Date.now() };
  await dbPut('notes', rec);
  if (state.chapter && state.chapter.idx === idx) { state.chNotes = state.chNotes || []; state.chNotes.push(rec); }
  refreshNotesBadge();
  openNoteSheet(rec);
}
let notesAnimTimer = null;
function toggleNotesList(show) {
  const box = $('#notes-list');
  const want = show !== undefined ? show : box.hidden;
  clearTimeout(notesAnimTimer);
  if (want) {                                   // плавно показываем
    hideListNow($('#bm-list'), $('#bm-list-btn'), bmAnimTimer);   // закладки и заметки разом — каша
    renderNotesList();
    box.classList.remove('open');
    box.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('open')));
    $('#toc').hidden = true;
  } else {                                      // плавно прячем, потом скрываем
    box.classList.remove('open');
    // Оглавление возвращаем ТОЛЬКО когда список реально исчез. Раньше оно появлялось сразу,
    // пока уходящий список ещё 240 мс занимал место, — главы уезжали вниз и потом рывком
    // вставали на место.
    notesAnimTimer = setTimeout(() => { box.hidden = true; $('#toc').hidden = false; }, 240);
  }
  $('#search-results').hidden = true;
  $('#part-chips').hidden = want || !state.toc.some(n => n.kids)
    || state.toc.filter(n => n.kids).length < 2;
  $('#notes-btn').classList.toggle('active', want);
}

// Мгновенно убрать список — при переключении между заметками и закладками ждать анимацию
// нельзя: уходящий список ещё занимает место, и приходящий сначала скачет вниз.
function hideListNow(box, btn, timer) {
  if (!box) return;
  clearTimeout(timer);
  box.classList.remove('open');
  box.hidden = true;
  if (btn) btn.classList.remove('active');
}

// ── список закладок в меню книги: рядом с заметками, по тем же правилам ──
let bmAnimTimer = null;
function renderBmList() {
  const box = $('#bm-list');
  if (!box) return;
  if (!bookmarks.length) {
    box.innerHTML = `<p class="sr-empty">${esc(t('bmNone'))}</p>`;   // тот же вид, что у пустых заметок
    return;
  }
  const titles = (state.book && state.book.titles) || [];
  const sorted = [...bookmarks].sort((a, b) => a.idx - b.idx || a.position - b.position);
  box.innerHTML = sorted.map(b => `<div class="note-item bm-item" data-bm="${esc(b.id)}">
      <span class="note-dot c-b"></span>
      <div class="note-body">
        <div class="note-exc">${esc(b.title || titles[b.idx] || ('Глава ' + (b.idx + 1)))}</div>
        <div class="note-when">${Math.round(b.position * 100)}%</div>
      </div>
      <button class="note-del icon-btn" data-bmdel="${esc(b.id)}" title="${t('deleteT')}" aria-label="${t('deleteT')}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`).join('');
}
function toggleBmList(show) {
  const box = $('#bm-list');
  const want = show !== undefined ? show : box.hidden;
  clearTimeout(bmAnimTimer);
  if (want) {
    hideListNow($('#notes-list'), $('#notes-btn'), notesAnimTimer);
    renderBmList();
    box.classList.remove('open');
    box.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('open')));
    $('#toc').hidden = true;           // …и только потом прячем его сами
  } else {
    box.classList.remove('open');
    // как и у заметок: оглавление возвращаем после того, как список исчез, иначе рывок
    bmAnimTimer = setTimeout(() => { box.hidden = true; $('#toc').hidden = false; }, 240);
  }
  $('#search-results').hidden = true;
  $('#bm-list-btn').classList.toggle('active', want);
}
// переход по закладке: открываем главу и встаём на сохранённое место
let pendingBmJump = null;
function bmJump(id) {
  const b = bookmarks.find(x => x.id === id);
  if (!b || !state.book) return;
  pendingBmJump = { idx: b.idx, position: b.position };
  location.hash = chHash(b.idx);
}
async function bmDelete(id) {
  bookmarks = bookmarks.filter(b => b.id !== id);
  if (!(await saveGuard(() => kvSet(bmKey(state.book.id), bookmarks)))) {
    await loadBookmarks(state.book.id);
    return;
  }
  renderBmList();
  refreshBmBadge();
  refreshBmBtn();
}

// ── карточки заметок/закладок: свайп влево удаляет, улетая за экран (то же по крестику) ──
function deleteBookNote(nid) {
  const rec = bookNotesCache.find(n => n.id === nid);
  return dbDel('notes', nid).then(() => {
    bookNotesCache = bookNotesCache.filter(n => n.id !== nid);
    renderNotesList();
    refreshNotesBadge();
    showToast(t('noteDeleted'), t('undo'), async () => {
      if (!rec) return;
      await dbPut('notes', rec);
      renderNotesList();
      refreshNotesBadge();
    });
  });
}
// карточку уводим за левый край, затем реально удаляем
function flyAwayThenDelete(item, doDelete) {
  item.style.transition = 'transform .28s cubic-bezier(.4, 0, .2, 1), opacity .28s ease';
  item.style.transform = 'translateX(-120%)';
  item.style.opacity = '0';
  let done = false;
  const fin = () => { if (done) return; done = true; item.removeEventListener('transitionend', fin); doDelete(); };
  item.addEventListener('transitionend', fin);
  setTimeout(fin, 340);   // страховка, если transitionend не придёт
}
// свайп влево по карточкам списка (delSel — селектор крестика, с него свайп не начинаем);
// onHold (необязательно) — долгое удержание без сдвига (напр. открыть редактор заметки).
function setupSwipeList(sel, del, delSel, onHold, itemSel = '.note-item') {
  const list = document.querySelector(sel);
  if (!list) return;
  let item = null, x0 = 0, y0 = 0, dx = 0, mode = null, held = false, holdT = null;
  const clearHold = () => { if (holdT) { clearTimeout(holdT); holdT = null; } };
  const killGhostClick = it => {                        // гасим «призрачный» клик после жеста
    const kill = ev => { ev.stopPropagation(); ev.preventDefault(); };
    it.addEventListener('click', kill, { capture: true, once: true });
    setTimeout(() => it.removeEventListener('click', kill, true), 350);
  };
  list.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { item = null; return; }
    const it = e.target.closest(itemSel);
    if (!it || (delSel && e.target.closest(delSel))) { item = null; return; }
    item = it; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null; held = false;
    item.style.transition = 'none';
    clearHold();
    if (onHold) holdT = setTimeout(() => {              // держит на месте — открываем редактор
      if (item === it && mode === null) { held = true; onHold(it); }
    }, 500);
  }, { passive: true });
  list.addEventListener('touchmove', e => {
    if (!item) return;
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (mode === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      mode = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      clearHold();                                       // двинулся — это не удержание
    }
    if (mode === 'h' && !held) {
      const tx = Math.min(0, dx);                        // тянем только влево
      item.style.transform = 'translateX(' + tx + 'px)';
      item.style.opacity = String(Math.max(0.25, 1 - Math.abs(tx) / 260));
    }
  }, { passive: true });
  const end = () => {
    clearHold();
    if (!item) return;
    const it = item, moved = dx, m = mode, wasHeld = held; item = null; mode = null;
    if (wasHeld) { killGhostClick(it); return; }         // удержание сработало — только гасим клик
    if (m === 'h' && moved < -90) {
      flyAwayThenDelete(it, () => del(it));              // за порог — улетает и удаляется
    } else {
      it.style.transition = 'transform .22s ease, opacity .22s ease';
      it.style.transform = ''; it.style.opacity = '';    // не дотянул — возвращается
      if (m === 'h' && Math.abs(moved) > 10) killGhostClick(it);
    }
  };
  list.addEventListener('touchend', end, { passive: true });
  list.addEventListener('touchcancel', end, { passive: true });
}

// Анимации нажатия иконок: на pointerdown у ближайшей кнопки из карты проигрываем
// анимацию её <svg> (класс .ia + .ia-<тип>). Наушники аудио-вкладки = как у «Слушать».
const ICON_ANIM = {
  '#filter-btn': 'pop', '#info-btn': 'bob', '#shelf-settings-btn': 'tick',
  '.shelf-tab[data-tab="books"]': 'pop', '.shelf-tab[data-tab="audio"]': 'beat',
  '#url-btn': 'twist', '#import-btn': 'pop', '#scan-btn': 'seek', '#fab-more': 'pop',
  '#shelf-btn': 'nl', '#lib-settings-btn': 'tick', '#annot-more': 'nd', '#annot-edit': 'wiggle',
  '#notes-btn': 'pop', '#bm-list-btn': 'nd', '#review-btn': 'pop',
  '#notes-add-btn': 'pop', '#notes-copy': 'pop', '#notes-del-all': 'shrink',
  '[data-note-del]': 'shrink', '[data-bmdel]': 'shrink', '[data-abnote-del]': 'shrink',
  '#back-btn': 'nl', '#bm-btn': 'nd', '#scroll-btn': 'flow', '#tts-btn': 'beat',
  '#tr-btn': 'spin', '#reader-settings-btn': 'tick', '#edge-prev': 'nl', '#edge-next': 'nr',
  '#audio-back': 'nl', '#ab-edit': 'wiggle', '#ab-desc-more': 'nd',
  '#ab-notes-btn': 'pop', '#ab-review-btn': 'pop',
  '#ab-prev': 'nl', '#ab-next': 'nr', '#ab-timer': 'sway',
};
function setupIconTapAnim() {
  const entries = Object.entries(ICON_ANIM);
  addEventListener('pointerdown', e => {
    for (const [sel, anim] of entries) {
      const btn = e.target.closest(sel);
      if (!btn) continue;
      const svg = btn.querySelector('svg');
      if (svg) {
        const cls = 'ia-' + anim;
        svg.classList.remove('ia', cls); void svg.offsetWidth;
        svg.classList.add('ia', cls);
        setTimeout(() => svg.classList.remove('ia', cls), 660);
      }
      break;
    }
  }, { passive: true });
}

function notesMarkdown() {
  const titles = state.book.titles || [];
  const lines = [`# ${state.book.title} — ${t('notesBtn').toLowerCase()}`, ''];
  let lastIdx = -1;
  for (const n of bookNotesCache) {
    if (n.idx !== lastIdx) {
      lastIdx = n.idx;
      lines.push(`## ${titles[n.idx] || '#' + (n.idx + 1)}`, '');
    }
    lines.push(`> ${n.text}`);
    if (n.note) lines.push('', n.note);
    lines.push('');
  }
  return lines.join('\n');
}

// ── описание книги (из метаданных или своё) ──
function renderAnnot() {
  const box = $('#book-annot');
  if (!state.book) { box.innerHTML = ''; return; }
  const a = (state.book.annotation || '').trim();
  if (!a) {
    box.innerHTML = `<button class="annot-add" id="annot-add">${t('annotAdd')}</button>`;
    return;
  }
  box.innerHTML = `<div class="annot-wrap">
    <div class="annot-textbox"><p class="annot-text clamped" id="annot-text-view">${esc(a)}</p></div>
    <div class="annot-foot">
      <button class="annot-more" id="annot-more" type="button" hidden aria-label="${t('annotMore')}">
        <svg class="annot-more-chev" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <button class="annot-edit" id="annot-edit" title="${t('annotEditT')}" aria-label="${t('annotEditT')}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
    </div>
  </div>`;
  updateAnnotMore();
}
// показываем кнопку «Показать полностью» только если описание реально не влезает
// в 4 строки; иначе описание короткое — ни клампа, ни кнопки не нужно
// txt/more — элементы конкретного описания (книга: #annot-text-view/#annot-more; аудио: #ab-desc-text/#ab-desc-more)
function updateAnnotMore(txt, more) {
  txt = txt || $('#annot-text-view'); more = more || $('#annot-more');
  if (!txt || !more) return;
  const decide = () => {
    const wasClamped = txt.classList.contains('clamped');
    if (!wasClamped) txt.classList.add('clamped');
    const overflowing = txt.scrollHeight > txt.clientHeight + 2;
    if (!wasClamped) txt.classList.remove('clamped');
    more.hidden = !overflowing;
    if (!overflowing) txt.classList.remove('clamped');   // короткое: показываем целиком, без указателя
    syncAnnotMore(txt, more);
  };
  decide();
  // шрифт с засечками может догрузиться позже и изменить высоту — перепроверяем
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(decide);
}
function syncAnnotMore(txt, more) {
  txt = txt || $('#annot-text-view'); more = more || $('#annot-more');
  if (!txt || !more) return;
  const clamped = txt.classList.contains('clamped');
  const box = txt.closest('.annot-textbox');
  if (box) box.classList.toggle('faded', clamped && !more.hidden);
  if (more.hidden) return;
  more.classList.toggle('open', !clamped);
  more.setAttribute('aria-label', clamped ? t('annotMore') : t('annotLess'));
}
// плавное разворачивание/сворачивание описания через анимацию max-height
function toggleAnnot(tv, more) {
  tv = tv || $('#annot-text-view');
  if (!tv) return;
  const lh = parseFloat(getComputedStyle(tv).lineHeight) || 22;
  const collapsedPx = Math.round(lh * 4);
  const clearOnEnd = () => tv.addEventListener('transitionend', function te(ev) {
    if (ev.propertyName !== 'max-height') return;
    tv.removeEventListener('transitionend', te);
    tv.style.maxHeight = tv.classList.contains('clamped') ? '' : 'none';
  });
  if (tv.classList.contains('clamped')) {          // разворачиваем
    tv.classList.remove('clamped');
    const full = tv.scrollHeight;
    tv.style.maxHeight = collapsedPx + 'px';
    void tv.offsetHeight;
    clearOnEnd();
    tv.style.maxHeight = full + 'px';
  } else {                                          // сворачиваем
    const full = tv.scrollHeight;
    tv.style.maxHeight = full + 'px';
    void tv.offsetHeight;
    tv.classList.add('clamped');
    clearOnEnd();
    tv.style.maxHeight = collapsedPx + 'px';
  }
  syncAnnotMore(tv, more);
}
function openAnnotSheet(kind) {
  kind = (kind === 'audio') ? 'audio' : 'book';
  const rec = kind === 'audio' ? (ab && ab.rec) : state.book;
  if (!rec) return;
  editTarget = { kind, rec, store: kind === 'audio' ? 'audiobooks' : 'books' };
  $('#annot-title').value = rec.title || '';
  $('#annot-author').value = rec.author || '';
  $('#annot-input').value = rec.annotation || '';
  $('#annot-results').hidden = true;
  $('#annot-results').innerHTML = '';
  renderAnnotCover();
  sheetShow($('#annot-sheet'), $('#annot-overlay'));
}
function closeAnnotSheet() {
  sheetHide($('#annot-sheet'), $('#annot-overlay'));
}
async function saveAnnot() {
  const rec = editEntity(); if (!rec) { closeAnnotSheet(); return; }
  // rec — это ТОТ ЖЕ объект, что state.book/запись на полке. Правим его до записи в базу,
  // поэтому при сбое откатываем поля обратно: иначе в памяти новое название, в базе старое,
  // и рассинхрон живёт до перезапуска приложения.
  const prev = { title: rec.title, author: rec.author, annotation: rec.annotation };
  const title = $('#annot-title').value.trim().slice(0, 300);
  if (title) rec.title = title;                        // название не оставляем пустым
  rec.author = $('#annot-author').value.trim().slice(0, 200);
  rec.annotation = $('#annot-input').value.trim().slice(0, 2000);
  if (!(await saveGuard(() => dbPut(editTarget.store, rec)))) {
    Object.assign(rec, prev);
    return;
  }
  if (editTarget.kind === 'audio') {
    const i = state.audiobooks ? state.audiobooks.findIndex(r => r.id === rec.id) : -1;
    if (i >= 0) state.audiobooks[i] = rec;
    const at = $('#ab-title'); if (at) at.textContent = rec.title;
    const aa = $('#ab-author'); if (aa) aa.textContent = rec.author || '';
    const ac = $('#ab-crumbs'); if (ac) ac.textContent = rec.title;
    renderAudioDesc();
    if (typeof renderAudioShelf === 'function') { try { renderAudioShelf(); } catch {} }
  } else {
    const i = state.books.findIndex(b => b.id === rec.id);
    if (i >= 0) state.books[i] = rec;
    const bt = $('#book-title'); if (bt) { bt.textContent = rec.title; fitTitle(bt); }
    const ba = $('#book-author'); if (ba) ba.textContent = rec.author;
    renderAnnot();
  }
  closeAnnotSheet();
}

// ── поиск описания в интернете ──
// Все источники отвечают с CORS, поэтому работаем прямо из браузера,
// без своего сервера. Неудачные источники просто пропускаются.
let findSeq = 0;
let findResults = [];

async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally { clearTimeout(tm); }
}

// сеть для источников без CORS / требующих браузерный UA (Shikimori, knigavuhe):
// на телефоне идём нативным мостом (обход CORS, отдаём UA/Referer/ru), в вебе — обычный fetch
// (там чужой CORS может не пустить — источник просто отвалится, остальные работают).
async function netFetch(url, type) {
  if (isNative && capHttp) {
    const H = {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    };
    try { H.Referer = new URL(url).origin + '/'; } catch {}
    const r = await capHttp.request({ url, method: 'GET', responseType: type, headers: H, connectTimeout: 12000, readTimeout: 15000 });
    if (r.status < 200 || r.status >= 300) throw new Error('http ' + r.status);
    return r.data;   // 'json' → объект, 'text' → строка
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('http ' + r.status);
  return type === 'json' ? r.json() : r.text();
}

// вычищаем HTML и bb-коды ([b]…[/b] у ФантЛаба) из чужих описаний
function stripMarkup(s) {
  const tmp = document.createElement('div');
  tmp.innerHTML = String(s).replace(/\[\/?[a-zА-Яа-я][^\]]{0,40}\]/g, '');
  return tmp.textContent.replace(/[ \t]+/g, ' ').trim();
}

// статья Википедии годится, только если это ОПИСАНИЕ КНИГИ, а не человека/слова
function wikiIsBook(sum, title) {
  const desc = (sum.description || '').toLowerCase();     // краткое пояснение статьи
  const extract = (sum.extract || '').toLowerCase();
  const pageTitle = (sum.title || '').toLowerCase();
  const bookish = /(роман|новелл|ранобэ|ранобе|повест|книг|манга|манхв|манхва|рассказ|сказани|поэма|пьеса|сборник|произведени|мемуар|нон-?фикшн|novel|book|memoir|manga|webtoon|series|серия|цикл|фильм|аниме|игра)/;
  const isBookDesc = bookish.test(desc);
  // человек (а не книга): описание про личность И книжных слов в нём НЕТ. Иначе
  // «вторая КНИГА, выпущенная писателем…» ошибочно отсекалась как статья об авторе.
  if (!isBookDesc && /писател|поэт|переводчик|author|novelist|\bwriter\b|born|род(ился|\.)/.test(desc)) return false;
  // артикли и служебные слова не считаются: «The Odyssey» должна совпадать со статьёй
  // «Odyssey», иначе половина английской классики отсекается из-за «the»
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'этот', 'как']);
  const tw = title.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stop.has(w));
  const matched = tw.filter(w => pageTitle.includes(w)).length;
  const titleOk = tw.length && matched >= Math.ceil(tw.length * 0.6);   // заголовок реально про эту книгу
  if (!titleOk) return false;
  // книжное описание, либо многословное название совпало, либо «книжность» в тексте
  // (односложное название без книжности отсекаем — чтобы не подсунуть статью-понятие)
  return isBookDesc || tw.length > 1 || bookish.test(extract.slice(0, 220));
}

async function findWikipedia(title) {
  // язык статьи — от языка НАЗВАНИЯ: латиница → сначала английская Википедия
  // (русская для «The Odyssey» либо молчит, либо промахивается мимо книги)
  const langs = !/[а-яё]/i.test(title) ? ['en', 'ru']
    : uiLang() === 'ru' ? ['ru', 'en'] : ['en', 'ru'];
  const out = [];
  for (const lg of langs) {
    try {
      const s = await fetchJson(`https://${lg}.wikipedia.org/w/api.php`
        + `?action=query&list=search&srlimit=4&format=json&origin=*`
        + `&srsearch=` + encodeURIComponent(title));   // ищем по НАЗВАНИЮ, без автора
      for (const hit of ((s.query || {}).search || []).slice(0, 4)) {
        const sum = await fetchJson(`https://${lg}.wikipedia.org/api/rest_v1/page/summary/`
          + encodeURIComponent(hit.title), 6000);
        const text = stripMarkup(sum.extract || '');
        if (text.length > 80 && wikiIsBook(sum, title))
          out.push({ src: 'Википедия', title: sum.title || hit.title, text });
      }
      if (out.length) break;
    } catch { /* источник недоступен */ }
  }
  return out;
}

async function findFantlab(title, author) {
  const j = await fetchJson('https://api.fantlab.ru/search-works?page=1&q='
    + encodeURIComponent(title));
  let matches = (j.matches || []).slice();
  if (author) {   // совпадения по автору — вперёд, чтобы не брать чужую книгу с похожим названием
    const last = author.toLowerCase().split(/\s+/).filter(Boolean).pop() || '';
    const hasA = m => last && ((m.autor1_rusname || '') + ' ' + (m.all_autor_rusname || '')
      + ' ' + (m.autors || '')).toLowerCase().includes(last);
    matches.sort((x, y) => (hasA(y) ? 1 : 0) - (hasA(x) ? 1 : 0));
  }
  const out = [];
  for (const m of matches.slice(0, 3)) {
    try {
      const w = await fetchJson('https://api.fantlab.ru/work/' + m.work_id, 6000);
      const text = stripMarkup(w.work_description || '');
      if (text.length > 60)
        out.push({
          src: 'ФантЛаб',
          title: (m.rusname || m.name || '')
            + (m.autor1_rusname ? ' — ' + m.autor1_rusname : ''),
          text,
        });
    } catch { /* без описания */ }
  }
  return out;
}

async function findGoogleBooks(title, author) {
  // intitle/inauthor БЕЗ кавычек — нацеливают на книгу, но не требуют точной фразы
  // (жёсткая фраза мазала мимо у книг с длинным/грязным названием). Порядок попыток:
  // русские издания строгим запросом → русские свободным → любые свободным.
  const qStrict = 'intitle:' + title + (author ? ' inauthor:' + author : '');
  const qFree = title + (author ? ' ' + author : '');
  // латинское название — книга не русская: ru-ограничение только мешает
  const tries = !/[а-яё]/i.test(title)
    ? [{ q: qStrict, lang: '' }, { q: qFree, lang: '' }]
    : [
      { q: qStrict, lang: '&langRestrict=ru' },
      { q: qFree, lang: '&langRestrict=ru' },
      { q: qFree, lang: '' },
    ];
  for (const tr of tries) {
    let j;
    try {
      j = await fetchJson('https://www.googleapis.com/books/v1/volumes?maxResults=5'
        + tr.lang + '&q=' + encodeURIComponent(tr.q));
    } catch { continue; }   // лимит(429)/сеть — не валимся, идём к следующей попытке
    const out = (j.items || []).map(it => {
      const v = it.volumeInfo || {};
      // нет полного описания — берём хотя бы сниппет из поиска
      const text = stripMarkup(v.description || (it.searchInfo && it.searchInfo.textSnippet) || '');
      return text.length > 60 ? {
        src: 'Google Книги',
        title: (v.title || '') + (v.authors ? ' — ' + v.authors.join(', ') : ''),
        text,
      } : null;
    }).filter(Boolean);
    if (out.length) return out;
  }
  return [];
}

async function findOpenLibrary(title, author) {
  const q = 'title=' + encodeURIComponent(title) + (author ? '&author=' + encodeURIComponent(author) : '');
  const j = await fetchJson('https://openlibrary.org/search.json?limit=3&' + q);
  const out = [];
  for (const d of (j.docs || []).slice(0, 2)) {
    if (!d.key) continue;
    try {
      const w = await fetchJson('https://openlibrary.org' + d.key + '.json', 6000);
      const raw = typeof w.description === 'string'
        ? w.description : (w.description || {}).value || '';
      const text = stripMarkup(raw);
      if (text.length > 60)
        out.push({
          src: 'Open Library',
          title: (d.title || '')
            + (d.author_name ? ' — ' + d.author_name.join(', ') : ''),
          text,
        });
    } catch { /* без описания */ }
  }
  return out;
}

// Shikimori — аниме/манга/ранобэ с русскими описаниями (закрывает мангу и ранобэ,
// напр. «Реинкарнация безработного»). Чистый JSON-API; на телефоне через мост (нет CORS).
async function findShikimori(title) {
  const out = [];
  // найденное обязано совпадать с БОЛЬШИНСТВОМ значимых слов названия — одного мало:
  // на «Мастер и Маргарита» приезжала манга, у которой в названии случайно есть «мастер»
  const words = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const titled = it => {
    if (!words.length) return true;
    const name = ((it.russian || '') + ' ' + (it.name || '')).toLowerCase();
    return words.filter(w => name.includes(w)).length >= Math.ceil(words.length * 0.6);
  };
  for (const kind of ['ranobe', 'mangas']) {
    try {
      const list = await netFetch('https://shikimori.one/api/' + kind + '?limit=3&search=' + encodeURIComponent(title), 'json');
      for (const it of (Array.isArray(list) ? list : []).filter(titled).slice(0, 2)) {
        try {
          const d = await netFetch('https://shikimori.one/api/' + kind + '/' + it.id, 'json');
          const text = stripMarkup(String(d.description || '').replace(/\[[^\]]*\]/g, ' '));   // снимаем bb-коды shikimori
          if (text.length > 60) out.push({ src: 'Shikimori', title: (it.russian || it.name || ''), text });
        } catch { /* без описания */ }
      }
      if (out.length) break;
    } catch { /* источник недоступен */ }
  }
  return out;
}

// knigavuhe (аудиокниги): у страниц книг есть og:description = аннотация. CORS нет —
// только на телефоне через мост (туда мост уже ходит: стрим аудио).
async function findKnigavuhe(title) {
  if (!(isNative && capHttp)) return [];
  try {
    const html = String(await netFetch('https://knigavuhe.org/search/?q=' + encodeURIComponent(title), 'text'));
    const m = /href="(\/book\/[^"#]+?\/)"/i.exec(html);
    if (!m) return [];
    const page = String(await netFetch('https://knigavuhe.org' + m[1], 'text'));
    const og = /<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i.exec(page);
    const text = og ? stripMarkup(og[1]) : '';
    return text.length > 60 ? [{ src: 'КнигаВслух', title, text }] : [];
  } catch { return []; }
}

// чистим название/автора от мусора имени файла: расширение, [скобки], (сборник),
// метки форматов и сайтов, ведущий номер тома/части, тире-разделители.
// Иначе запрос «Автор - Название (сборник) [fb2]» не находит НИЧЕГО.
function cleanTitleQuery(s) {
  return String(s || '')
    .replace(/\.[a-z0-9]{2,5}$/i, ' ')
    .replace(/[\[(][^)\]]*[)\]]/g, ' ')
    .replace(/\b(fb2|epub|pdf|djvu|mobi|azw3?|txt|rtf|litres|readli|flibusta|royallib|coollib|litmir|loveread)\b/gi, ' ')
    .replace(/^\s*(?:том|часть|глава|book|vol|cd)\s*\d+[.)\-\s]*/i, ' ')
    .replace(/[_#№]+/g, ' ')
    .replace(/\s*[-–—]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function findAnnotations() {
  // название и автор — раздельно и ОЧИЩЕННЫЕ от мусора имени файла: так источники
  // ищут ИМЕННО книгу, а не автора/слово и не спотыкаются о «(сборник) [fb2]»
  const rawTitle = $('#annot-title').value.trim();
  const rawAuthor = $('#annot-author').value.trim();
  const title = cleanTitleQuery(rawTitle) || rawTitle;
  const author = cleanTitleQuery(rawAuthor) || rawAuthor;
  if (title.length < 2) return;
  const box = $('#annot-results');
  box.hidden = false;
  box.innerHTML = `<p class="sr-empty">${t('annotSearching')}</p>`;
  const seq = ++findSeq;
  // Порядок источников = порядок выдачи, и он зависит от языка названия.
  // Кириллица: ФантЛаб/Shikimori первыми (жанр, ранобэ). Латиница: книжные базы
  // (Google, OpenLibrary, английская Википедия) — иначе для «The Odyssey» первым
  // приезжает мусор с аниме-сайтов, а настоящие описания тонут в хвосте.
  const latin = !/[а-яё]/i.test(title);
  const order = latin
    ? [findGoogleBooks(title, author), findOpenLibrary(title, author), findWikipedia(title, author),
       findFantlab(title, author), findShikimori(title), findKnigavuhe(title)]
    : [findFantlab(title, author), findShikimori(title),
       findGoogleBooks(title, author), findKnigavuhe(title),
       findOpenLibrary(title, author), findWikipedia(title, author)];
  const settled = await Promise.allSettled(order);
  if (seq !== findSeq || $('#annot-sheet').hidden) return;
  let found = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []));
  const seen = new Set();   // дедуп почти одинаковых текстов
  found = found.filter(f => {
    const k = f.text.slice(0, 80).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);
  // англоязычные описания (OpenLibrary/Google) переводим на русский — иначе «что-то не то»
  if (uiLang() === 'ru') {
    await Promise.all(found.map(async f => {
      if (detectLang(f.text) !== 'en') return;
      try {
        const tr = await translateText(f.text.slice(0, 1500), 'ru');
        if (tr && tr.text && detectLang(tr.text) === 'ru') { f.text = tr.text; f.src += ' · пер.'; }
      } catch { /* перевод не вышел — оставляем как есть */ }
    }));
    if (seq !== findSeq || $('#annot-sheet').hidden) return;
  }
  findResults = found;
  box.innerHTML = findResults.length
    ? findResults.map((f, i) => `<button class="annot-res" data-res="${i}">
        <span class="annot-src">${esc(f.src)} · ${esc(f.title.slice(0, 70))}</span>
        <span class="annot-prev">${esc(f.text.slice(0, 220))}${f.text.length > 220 ? '…' : ''}</span>
      </button>`).join('')
    : `<p class="sr-empty">${t('annotNone')}</p>`;
}

// ══════════════════ переводчик ══════════════════
// Google-переводчик отвечает браузеру напрямую (CORS *); запасные пути —
// прокси на домашнем сервере и MyMemory. Ключи и регистрация не нужны.
const trCache = new Map();   // 'язык:текст' → перевод (на время сессии)

function detectLang(text) {
  if (/[぀-ヿ一-鿿]/.test(text)) return 'ja';
  if (/[а-яё]/i.test(text)) return 'ru';
  return 'en';
}

// длинные тексты бьём на куски по предложениям (ограничение длины запроса)
function trChunks(text, max = 1600) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = '';
  for (const p of splitSentences(text)) {
    if (cur && cur.length + p.length > max) { out.push(cur); cur = ''; }
    cur = cur ? cur + ' ' + p : p;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  return out;
}

async function trGoogle(text, tl) {
  const j = await fetchJson(
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl='
    + tl + '&q=' + encodeURIComponent(text));
  const out = (j[0] || []).map(x => (x && x[0]) || '').join('');
  if (!out.trim()) throw new Error('пустой перевод');
  return { text: out, from: j[2] || '' };
}

async function trServer(text, tl) {
  const r = await fetch(ttsBase + '/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, to: tl }),
  });
  if (!r.ok) throw new Error('server ' + r.status);
  return r.json();
}

async function trMyMemory(text, tl) {
  const sl = detectLang(text);
  if (sl === tl) throw new Error('тот же язык');
  const j = await fetchJson('https://api.mymemory.translated.net/get?langpair='
    + sl + '|' + tl + '&q=' + encodeURIComponent(text.slice(0, 490)));
  const out = (j.responseData && j.responseData.translatedText) || '';
  if (!out.trim() || /MYMEMORY WARNING/i.test(out)) throw new Error('mymemory');
  return { text: out, from: sl };
}

async function translateText(text, tl) {
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('пусто');
  const key = tl + ':' + text;
  if (trCache.has(key)) return trCache.get(key);
  const sources = [trGoogle];
  if (location.protocol.startsWith('http') || ttsBase) sources.push(trServer);
  sources.push(trMyMemory);
  const parts = [];
  let from = '';
  for (const chunk of trChunks(text)) {
    let res = null;
    for (const fn of sources) {
      try { res = await fn(chunk, tl); break; }
      catch { /* пробуем следующий источник */ }
    }
    if (!res) throw new Error('нет перевода');
    parts.push(res.text);
    from = from || res.from;
  }
  const out = { text: parts.join(' '), from };
  if (trCache.size > 500) trCache.delete(trCache.keys().next().value);
  trCache.set(key, out);
  return out;
}

// ── лист перевода выделенного ──
let trSheetText = '';
let trSheetSeq = 0;
// ── кастомный выбор языка перевода (в стиле приложения) ──
const TR_LANGS = [
  ['ru', 'Русский'], ['en', 'English'], ['ja', '日本語'], ['de', 'Deutsch'],
  ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano'], ['pt', 'Português'],
  ['pl', 'Polski'], ['uk', 'Українська'], ['zh-CN', '中文'], ['ko', '한국어'], ['tr', 'Türkçe'],
];
const langPickers = [];
const langName = code => code === 'auto' ? t('trAuto')
  : (TR_LANGS.find(l => l[0] === code) || [, code])[1];

// ── умный язык перевода, свой для каждой книги ──
// язык самой книги: метаданные, иначе — беглое определение по видимому тексту
function bookLangCode(book) {
  if (!book) return 'ru';
  const meta = (book.lang || '').toLowerCase().slice(0, 2);
  if (meta) return meta;
  const body = document.querySelector('#chapter-body');
  if (body) { const s = body.innerText.slice(0, 500); if (s.trim()) return detectLang(s); }
  return 'ru';
}
// авто-цель: русскую книгу переводим на английский, любую другую — на русский
function autoTrTarget(book) { return bookLangCode(book) === 'ru' ? 'en' : 'ru'; }
// что выбрано в книге: 'auto' (по умолчанию) или конкретный код
// выбранный режим: у книги — свой (b.trLang); без книги — глобальный (settings.trChoice)
function curTrChoice() {
  const b = state.book;
  const v = b ? b.trLang : settings.trChoice;
  return v || 'auto';
}
// действующий язык перевода
function curTrLang() {
  const c = curTrChoice();
  if (c && c !== 'auto') return c;
  return autoTrTarget(state.book);   // авто: русская книга → en, иначе → ru
}
function closeLangMenus() {
  closeAppMenus();   // все выпадающие списки приложения
  if (typeof voicePicker !== 'undefined' && voicePicker) voicePicker.close();
}
function buildLangPicker(container) {
  if (!container) return;
  container.innerHTML = menuTriggerHtml();
  const trigger = container.querySelector('.lang-trigger');
  const options = [{ v: 'auto', label: t('trAuto') }, ...TR_LANGS.map(([v, n]) => ({ v, label: n }))];
  const { menu, close } = makeMenu(trigger, {
    minWidth: 170, align: 'right',   // список прижат правым краем к триггеру
    onPick: v => setTrLang(v),
  });
  menu.innerHTML = menuOptionsHtml(options, curTrChoice());
  container._close = close;
  container._menu = menu;
  langPickers.push(container);
  syncTrLangUI();
}

function syncTrLangUI() {
  const choice = curTrChoice();
  // при «Авто» подсказываем, на какой язык это разворачивается для этой книги
  const label = choice === 'auto' ? t('trAuto') + ' · ' + langName(curTrLang()) : langName(choice);
  for (const c of langPickers) {
    const cur = c.querySelector('.lang-cur');
    if (cur) cur.textContent = label;
    c._menu.querySelectorAll('.lang-opt').forEach(o => o.classList.toggle('sel', o.dataset.v === choice));
  }
  // настройки: кнопка «Авто» активна в авто-режиме; встроенный список подводим к языку
  const auto = $('#tr-auto');
  if (auto) auto.classList.toggle('active', choice === 'auto');
  scrollTrPickerToCurrent(false);
}

// встроенный вертикальный выбор языка (без всплывающей шторки): прокручивается в самой
// строке, соседние языки видны сверху/снизу, центральный — выбранный
let trPickerLock = false;
function buildTrPicker() {
  const picker = $('#tr-picker'), list = $('#tr-picker-list'), wrap = $('#tr-picker-wrap');
  if (!picker || !list || !wrap) return;
  list.innerHTML = '<div class="tr-pk-pad"></div>'
    + TR_LANGS.map(([v, n]) => `<div class="tr-pk-item" data-v="${esc(v)}" role="option">${esc(n)}</div>`).join('')
    + '<div class="tr-pk-pad"></div>';
  const items = () => [...list.querySelectorAll('.tr-pk-item')];
  const centerIdx = () => {
    const its = items(), c = picker.scrollTop + picker.clientHeight / 2;
    let best = 0, bd = 1e9;
    its.forEach((it, i) => { const m = it.offsetTop + it.offsetHeight / 2, d = Math.abs(m - c); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const highlight = i => items().forEach((it, k) => it.classList.toggle('sel', k === i));
  const centerTop = it => it.offsetTop - (picker.clientHeight - it.offsetHeight) / 2;
  // Свёрнуто видна одна строка (обёртка обрезает барабан). При вводе барабан ВСПЛЫВАЕТ поверх
  // интерфейса — соседние языки появляются сверху/снизу, ничего не раздвигая. Когда прокрутка
  // стихла — сами плавно доводим ближайший язык до центра, затем сворачиваем и применяем выбор.
  let collapseT = null, settleT = null;
  const collapse = () => {
    const its = items(), it = its[centerIdx()];
    if (!it) { wrap.classList.remove('scrolling'); return; }
    const code = it.dataset.v;
    trPickerLock = true;                                    // гасим свои же scroll-события
    picker.scrollTo({ top: centerTop(it), behavior: 'smooth' });   // доводим до центра, барабан ещё раскрыт
    clearTimeout(settleT);
    settleT = setTimeout(() => {
      trPickerLock = false;
      wrap.classList.remove('scrolling');                  // сворачиваем в одну строку
      if (code && curTrChoice() !== code) setTrLang(code); // применяем выбранный язык
    }, 320);
  };
  const armCollapse = () => { clearTimeout(collapseT); collapseT = setTimeout(collapse, 360); };
  const expand = () => {
    clearTimeout(settleT); trPickerLock = false;
    wrap.classList.add('scrolling');
    armCollapse();
  };
  // раскрываем только по действию пользователя (не по программной прокрутке — иначе петля/мерцание)
  picker.addEventListener('pointerdown', expand);
  picker.addEventListener('touchstart', expand, { passive: true });
  picker.addEventListener('wheel', expand, { passive: true });
  picker.addEventListener('scroll', () => {
    highlight(centerIdx());
    if (trPickerLock) return;   // это наша программная доводка/центровка — не перезапускаем сворачивание
    armCollapse();
  }, { passive: true });
  // тап прямо по языку — сразу выбрать его (когда барабан раскрыт)
  list.addEventListener('click', e => {
    const it = e.target.closest('.tr-pk-item');
    if (!it) return;
    clearTimeout(collapseT); clearTimeout(settleT); trPickerLock = false;
    wrap.classList.remove('scrolling');
    const code = it.dataset.v;
    if (code && curTrChoice() !== code) setTrLang(code);
    else scrollTrPickerToCurrent(true);
  });
}
function scrollTrPickerToCurrent(smooth) {
  const picker = $('#tr-picker'), list = $('#tr-picker-list');
  if (!picker || !list) return;
  const c = curTrChoice();
  const code = c === 'auto' ? curTrLang() : c;
  let it = null;
  try { it = list.querySelector('.tr-pk-item[data-v="' + CSS.escape(code) + '"]'); } catch {}
  if (!it) return;
  list.querySelectorAll('.tr-pk-item').forEach(x => x.classList.toggle('sel', x === it));
  const top = it.offsetTop - (picker.clientHeight - it.offsetHeight) / 2;
  if (Math.abs(picker.scrollTop - top) < 2) return;   // уже на месте — не дёргаем
  trPickerLock = true;
  picker.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  clearTimeout(scrollTrPickerToCurrent._t);
  scrollTrPickerToCurrent._t = setTimeout(() => { trPickerLock = false; }, smooth ? 480 : 90);
}
async function setTrLang(v) {
  // язык перевода сохраняется отдельно для КАЖДОЙ книги; без книги — глобально
  const b = state.book;
  if (b) {
    b.trLang = v;
    try {
      await dbPut('books', b);
      const i = state.books.findIndex(x => x.id === b.id);
      if (i >= 0) state.books[i].trLang = v;
    } catch { /* сохранение не критично для текущего сеанса */ }
  } else {
    settings.trChoice = v;
    saveSettings();
  }
  syncTrLangUI();
  if (!$('#tr-sheet').hidden) runTrSheet();
  if (trChapterOn) { removeTrBlocks(); trChapterOn = false; $('#tr-btn').classList.remove('active'); toggleChapterTr(); }
}
// ══════════════════ перевод слова по двойному тапу ══════════════════
// Слово ищем сами: caretRangeFromPoint даёт позицию каретки, а границы слова
// доращиваем по буквам. Флаг /u обязателен — без него \p{L} не работает.
const WORD_RE = /[\p{L}\p{N}'’\-]/u;
let wpSeq = 0;

function wordAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const p = el && el.closest('#chapter-body p, #chapter-body blockquote');
  if (!p || p.closest('.tr-block')) return null;   // не лезем во вставки перевода главы
  const s = p.textContent;
  const i = caretOffsetAt(p, x, y);
  // caretOffsetAt отдаёт 0 и при неудаче, и в начале абзаца — убеждаемся, что под пальцем буква
  if (!WORD_RE.test(s[i] || '') && !WORD_RE.test(s[i - 1] || '')) return null;
  let a = i, b = i;
  while (a > 0 && WORD_RE.test(s[a - 1])) a--;
  while (b < s.length && WORD_RE.test(s[b])) b++;
  const word = s.slice(a, b);
  if (!word || word.length > 40 || !/\p{L}/u.test(word)) return null;
  return { p, a, b, word };
}

function placeWordPop() {
  const pop = $('#word-pop');
  if (pop.hidden) return;
  // координаты слова берём СВЕЖИЕ (за время перевода текст мог сместиться — иначе попап
  // прыгал по устаревшему прямоугольнику, вплоть до края экрана)
  const hit = wordPopHit;
  const r = hit ? rangeFromOffsets(hit.p, hit.a, hit.b) : null;
  const rect = r ? r.getBoundingClientRect() : null;
  const w = pop.offsetWidth, h = pop.offsetHeight;   // чтение offsetWidth форсит лэйаут — размеры уже настоящие
  // границы — по визуальному вьюпорту (учитывает зум/сдвиг), с запасом 8px
  const vv = window.visualViewport;
  const vx = vv ? vv.offsetLeft : 0, vy = vv ? vv.offsetTop : 0;
  const vw = vv ? vv.width : innerWidth, vh = vv ? vv.height : innerHeight;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  if (!rect || !w || !h) {   // нет якоря/ещё не измерилось — по центру у верха, но в экране
    pop.style.left = clamp(vx + (vw - w) / 2, vx + 8, vx + vw - w - 8) + 'px';
    pop.style.top = (vy + 12) + 'px';
    return;
  }
  pop.style.left = clamp(rect.left + rect.width / 2 - w / 2, vx + 8, vx + vw - w - 8) + 'px';
  let top = rect.top - h - 10;                                   // над словом
  if (top < vy + 8) top = rect.bottom + 10;                      // не влезает сверху — под словом
  pop.style.top = clamp(top, vy + 8, vy + vh - h - 8) + 'px';    // и всегда внутри экрана
}

// «Озвучить» слово в попапе — просто услышать, как оно звучит (голос устройства, без словаря)
function speakWord(word) {
  if (!word) return;
  try {
    if (capTTS) { capTTS.stop().catch(() => {}); capTTS.speak({ text: word, lang: 'ru-RU', rate: settings.ttsRate, category: 'playback' }).catch(() => {}); return; }
  } catch {}
  if (window.speechSynthesis) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(word);
    const v = (typeof ttsVoices !== 'undefined' && ttsVoices) ? (ttsVoices.find(x => x.voiceURI === settings.ttsVoice) || ttsVoices[0]) : null;
    if (v) u.voice = v;
    u.lang = 'ru-RU'; u.rate = settings.ttsRate;
    speechSynthesis.speak(u);
  }
}

async function openWordPop(hit) {
  const pop = $('#word-pop');
  $('#wp-word').textContent = hit.word;
  $('#wp-tr').textContent = t('trBusyOne');
  hlSet('wordsel', hit.p, hit.a, hit.b);
  pop.hidden = false;
  wordPopHit = hit;
  placeWordPop();                           // сразу (offsetWidth форсит лэйаут)…
  requestAnimationFrame(placeWordPop);      // …и после кадра — на случай, если шрифт/размер ещё догоняли
  const my = ++wpSeq;                       // защита от гонки: пока ждём перевод, могли тапнуть другое слово
  try {
    const res = await translateText(hit.word, curTrLang());
    if (my !== wpSeq || pop.hidden) return;
    $('#wp-tr').textContent = res.text;
  } catch {
    if (my !== wpSeq || pop.hidden) return;
    $('#wp-tr').textContent = t('trFail');
  }
  placeWordPop();                           // перевод изменил высоту — ставим заново по свежим координатам
}
let wordPopHit = null;
function closeWordPop() {
  wpSeq++;
  const pop = $('#word-pop');
  if (pop) pop.hidden = true;
  wordPopHit = null;
  if (HL && HL.wordsel) HL.wordsel.clear();
}
const wordPopOpen = () => { const p = $('#word-pop'); return !!p && !p.hidden; };

function openTrSheet(text) {
  trSheetText = text.replace(/\s+/g, ' ').trim().slice(0, 4000);
  if (!trSheetText) return;
  $('#tr-orig').textContent = trSheetText;
  syncTrLangUI();
  sheetShow($('#tr-sheet'), $('#tr-overlay'));
  runTrSheet();
}
async function runTrSheet() {
  const box = $('#tr-result');
  box.textContent = t('trBusyOne');
  const my = ++trSheetSeq;
  try {
    const res = await translateText(trSheetText, curTrLang());
    if (my !== trSheetSeq || $('#tr-sheet').hidden) return;
    box.textContent = res.text;
  } catch {
    if (my !== trSheetSeq) return;
    box.textContent = t('trFail');
  }
}
function closeTrSheet() {
  sheetHide($('#tr-sheet'), $('#tr-overlay'));
}

// ── билингва: перевод под каждым абзацем главы ──
let trChapterOn = false;
function removeTrBlocks() {
  for (const b of document.querySelectorAll('#chapter-body .tr-block')) b.remove();
  invalidateTextIndex();
}
async function toggleChapterTr() {
  const btn = $('#tr-btn');
  if (trChapterOn) {
    trChapterOn = false;
    btn.classList.remove('active');
    removeTrBlocks();
    return;
  }
  if (!state.chapter) return;
  trChapterOn = true;
  btn.classList.add('active');
  const token = navToken;
  const paras = [...document.querySelectorAll(
    '#chapter-body p, #chapter-body h3, #chapter-body h4, #chapter-body blockquote')]
    .filter(el => el.innerText.trim().length > 1);
  showToast(T('trBusy', { n: paras.length }));
  let fails = 0;
  for (const el of paras) {
    if (navToken !== token || !trChapterOn) return;
    if (el.nextElementSibling && el.nextElementSibling.classList.contains('tr-block'))
      continue;   // уже переведён (повторный запуск после сбоя)
    let res = null;
    const tl = curTrLang();
    try { res = await translateText(el.innerText, tl); }
    catch {
      await new Promise(r => setTimeout(r, 1300));
      try { res = await translateText(el.innerText, tl); }
      catch { /* абзац пропускаем */ }
    }
    if (navToken !== token || !trChapterOn) return;
    if (!res) {
      if (++fails >= 3) { showToast(t('trPartial')); return; }
      continue;
    }
    fails = 0;
    const d = document.createElement('div');
    d.className = 'tr-block';
    d.textContent = res.text;
    el.after(d);
    invalidateTextIndex();   // вставка перевода сдвигает узлы главы
    await new Promise(r => setTimeout(r, 120));   // бережный темп запросов
  }
  if (trChapterOn && navToken === token) showToast(t('trDone'));
}

// ── личный отзыв о книге ──
const STAR = '★';
// Отзыв хранится в kv по id (одинаково для книги и аудиокниги). reviewTarget — что оцениваем.
let reviewTarget = null;   // { kind:'book'|'audio', id, title, author }
async function loadReview(id) {
  return (await kvGet('review:' + id)) || { stars: 0, text: '' };
}
// оценка есть → просто заливаем основную звезду золотом (класс .active), без ряда звёзд
async function refreshReviewBadge() {
  if (state.book) {
    const rv = await loadReview(state.book.id);
    const btn = $('#review-btn'); if (btn) btn.classList.toggle('rated', !!rv.stars);
    const el = $('#review-stars'); if (el) el.textContent = '';
  }
}
async function refreshAudioReviewBadge() {
  if (!ab || !ab.rec) return;
  const rv = await loadReview(ab.rec.id);
  const btn = $('#ab-review-btn'); if (btn) btn.classList.toggle('rated', !!rv.stars);
  const el = $('#ab-review-stars'); if (el) el.textContent = '';
}
let reviewStars = 0;
async function openReviewSheet(kind) {
  const isAudio = kind === 'audio';
  const ent = isAudio ? (ab && ab.rec) : state.book;
  if (!ent) return;
  reviewTarget = { kind: isAudio ? 'audio' : 'book', id: ent.id, title: ent.title, author: ent.author };
  const rv = await loadReview(ent.id);
  reviewStars = rv.stars || 0;
  $('#review-text').value = rv.text || '';
  $('#review-book').textContent = ent.title;
  syncStarsUI();
  sheetShow($('#review-sheet'), $('#review-overlay'));
}
function syncStarsUI() {
  document.querySelectorAll('#star-row button').forEach((b, i) =>
    b.classList.toggle('on', i < reviewStars));
}
function closeReviewSheet() {
  sheetHide($('#review-sheet'), $('#review-overlay'));
}
async function saveReview(share) {
  if (!reviewTarget) return;
  const rv = { stars: reviewStars, text: $('#review-text').value.trim(), at: Date.now() };
  if (!(await saveGuard(() => kvSet('review:' + reviewTarget.id, rv)))) return;
  invalidateShelfData();
  if (reviewTarget.kind === 'audio') {
    refreshAudioReviewBadge();
    if (typeof renderAudioShelf === 'function') { try { renderAudioShelf(); } catch {} }
  } else refreshReviewBadge();
  if (share) {
    const s = `${reviewTarget.title}${reviewTarget.author ? ' — ' + reviewTarget.author : ''}\n`
      + (rv.stars ? STAR.repeat(rv.stars) + '☆'.repeat(5 - rv.stars) + '\n' : '')
      + (rv.text ? '\n' + rv.text : '');
    showToast((await copyText(s)) ? t('copied') : t('copyFail'));
  } else {
    showToast(t('reviewSaved'));
  }
  closeReviewSheet();
}

// ══════════════════ тост ══════════════════
let toastTimer = null;
function hideToast() {
  const box = $('#toast');
  clearTimeout(toastTimer);
  box.classList.remove('open');
  toastTimer = setTimeout(() => { box.hidden = true; }, 320);   // ждём завершения плавного ухода
}
function showToast(msg, btnLabel, onClick) {
  const box = $('#toast'), btn = $('#toast-btn'), prog = $('#toast-prog');
  $('#toast-msg').textContent = msg;
  btn.hidden = !btnLabel;
  btn.textContent = btnLabel || '';
  btn.onclick = () => { hideToast(); if (onClick) onClick(); };
  if (prog) { prog.hidden = true; prog.classList.remove('indet'); }   // обычный тост — без полосы
  clearTimeout(toastTimer);
  box.hidden = false;
  requestAnimationFrame(() => box.classList.add('open'));   // плавное появление сверху
  toastTimer = setTimeout(hideToast, 3000);
}
// прогресс импорта: тост держится открытым, снизу полоса. frac=null — бегущая (неизвестно сколько),
// число 0..1 — определённая доля. Показываем именно так для медленных форматов (PDF, комиксы).
function showProgress(msg, frac) {
  const box = $('#toast'), prog = $('#toast-prog');
  $('#toast-msg').textContent = msg;
  $('#toast-btn').hidden = true;
  if (prog) {
    prog.hidden = false;
    const fill = prog.querySelector('i');
    if (frac == null) { prog.classList.add('indet'); }
    else { prog.classList.remove('indet'); if (fill) fill.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; }
  }
  clearTimeout(toastTimer);   // во время импорта тост не прячем автоматически
  box.hidden = false;
  requestAnimationFrame(() => box.classList.add('open'));
}

// кастомный диалог подтверждения вместо системного confirm() — в стиле приложения.
// Возвращает Promise<boolean>: true — «да», false — отмена/скрим/Esc/системная «назад».
let confirmResolve = null;
function uiConfirm(message, { yes, no, danger = false } = {}) {
  const modal = $('#confirm-modal'), scrim = $('#confirm-scrim');
  const yesBtn = $('#confirm-yes'), noBtn = $('#confirm-no');
  $('#confirm-msg').textContent = message;
  $('#confirm-field').hidden = true;   // обычный вопрос — без поля ввода (его включает uiPrompt)
  yesBtn.textContent = yes || t('dlgOk');
  noBtn.textContent = no || t('dlgCancel');
  yesBtn.classList.toggle('danger', !!danger);
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }
  scrim.hidden = false; modal.hidden = false;
  // ДВА кадра, а не один: после снятия hidden браузеру нужен кадр, чтобы отрисовать
  // стартовое положение окна (за верхним краем экрана). С одним кадром он схлопывал
  // оба состояния в одно и перехода не было вовсе — окно просто возникало на месте.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    scrim.classList.add('open'); modal.classList.add('open');
  }));
  setTimeout(() => yesBtn.focus(), 0);
  return new Promise(resolve => { confirmResolve = resolve; });
}
// Тот же диалог, но с полем ввода: вся механика (скрим, Esc, аппаратная «назад»,
// реентерабельность) уже в uiConfirm — переиспользуем, а не плодим второй модал.
// Возвращает введённую строку или null.
function uiPrompt(message, { ph = '', yes, no } = {}) {
  const p = uiConfirm(message, { yes, no });
  const inp = $('#confirm-input');
  const field = $('#confirm-field');
  field.hidden = false;
  inp.value = ''; inp.placeholder = ph;
  const ru = uiLang() === 'ru';
  // Иконка-звено в строке — кнопка «вставить»: тап по ней берёт ссылку из буфера обмена.
  // Клавиатуру сами не открываем (автофокуса нет) — ссылки вставляют, а не печатают;
  // при желании тап по самому полю откроет её штатно.
  const icon = field.querySelector('svg');
  if (icon) icon.onclick = async e => {
    e.stopPropagation();
    // Android WebView не даёт navigator.clipboard.readText() — читаем нативным плагином
    // Clipboard (системный ClipboardManager); веб-АПИ оставлен запасным (для ПК-браузера).
    let txt = null;
    const capClip = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Clipboard;
    if (capClip) { try { const r = await capClip.read(); txt = (r && r.value) || ''; } catch { txt = null; } }
    if (txt === null && navigator.clipboard && navigator.clipboard.readText) {
      try { txt = (await navigator.clipboard.readText()) || ''; } catch { txt = null; }
    }
    if (txt === null) { showToast(ru ? 'Не удалось прочитать буфер обмена' : "Can't read clipboard"); return; }
    const v = txt.trim();
    if (v) inp.value = v;
    else showToast(ru ? 'Буфер обмена пуст' : 'Clipboard is empty');
  };
  return p.then(ok => {
    const v = inp.value.trim();
    field.hidden = true;
    if (icon) icon.onclick = null;
    return ok && v ? v : null;
  });
}
function confirmOpen() { return !$('#confirm-modal').hidden; }
function closeConfirm(result) {
  if (!confirmResolve) return;
  const r = confirmResolve; confirmResolve = null;
  const modal = $('#confirm-modal'), scrim = $('#confirm-scrim');
  modal.classList.remove('open'); scrim.classList.remove('open');
  // ждём, пока окно улетит за верхний край (анимация 380мс), иначе оно просто исчезнет
  setTimeout(() => { modal.hidden = true; scrim.hidden = true; }, 400);
  r(result);
}

// ══════════════════ обработчики ══════════════════
function bindUI() {
  bindAllSheets();   // свайп-вниз и плавное закрытие всех нижних шторок
  // разблокируем <audio> на самом первом касании экрана — тогда нейроголоса
  // (play() после асинхронного синтеза) точно не упрутся в автоплей-политику Android
  addEventListener('pointerdown', unlockAudio, { once: true, passive: true });
  addEventListener('touchstart', unlockAudio, { once: true, passive: true });
  // кастомный диалог подтверждения
  $('#confirm-yes').addEventListener('click', () => closeConfirm(true));
  $('#confirm-no').addEventListener('click', () => closeConfirm(false));
  $('#confirm-scrim').addEventListener('click', () => closeConfirm(false));
  // Тап по пустому месту закрывает диалог. Слушаем саму модалку: она растянута на весь
  // экран ПОВЕРХ скрима, поэтому до скрима тап просто не доходил. Проверяем, что попали
  // мимо карточки — иначе закрывались бы при любом нажатии внутри окна.
  $('#confirm-modal').addEventListener('click', e => {
    if (!e.target.closest('.confirm-card')) closeConfirm(false);
  });
  // accept у файловых input'ов сознательно сужен до конкретных расширений прямо в HTML
  // (#file-input/#audio-file-input/#restore-input). Причина: при accept="*/*" или "audio/*"
  // мобильные браузеры (в т.ч. Brave/Chrome на Android и Safari на iOS) добавляют в пикер
  // «Снять фото/видео» и «Записать аудио» — а это запрос камеры и микрофона. Формат книги
  // приложение определяет по СОДЕРЖИМОМУ, а не по расширению, поэтому сужение ничего не
  // ломает: перетаскивание и импорт по-прежнему принимают файл любой природы. Обложке
  // (#cover-input, image/*) камера нужна по делу — «сфотографировать обложку», её не трогаем.
  // импорт: кнопка, выбор файла, перетаскивание
  $('#import-btn').addEventListener('click', () => $('#file-input').click());
  $('#url-btn').addEventListener('click', () => { closeFabMore(true); importFromUrl(); });
  initFabDrag();   // кластер кнопок можно перетаскивать по правому/нижнему краю (удержанием)
  $('#file-input').addEventListener('change', e => {
    doImport([...e.target.files]);
    e.target.value = '';
  });
  $('#audio-file-input').addEventListener('change', e => {
    doImport([...e.target.files]);
    e.target.value = '';
  });
  // клики по карточкам аудиокниг (продолжить / открыть / удалить)
  $('#tab-audio').addEventListener('click', e => {
    // режим мультивыбора: тап по аудио-карточке переключает выбор (гасим до body-обработчика)
    if (selMode) { e.stopPropagation(); selClick(e); return; }
    const del = e.target.closest('[data-abdel]');
    if (del) { e.stopPropagation(); deleteAudiobook(del.dataset.abdel); return; }
    // стрелка на обложке стрим-аудиокниги — скачать треки на устройство
    const adl = e.target.closest('[data-abdl]');
    if (adl) {
      e.stopPropagation();
      const rec = (state.audiobooks || []).find(r => r.id === adl.dataset.abdl);
      if (rec) abDownloadTracks(rec);
      return;
    }
    // аудио-каталог: скачивание ТОЛЬКО со стрелки; тап по телу открывает уже добавленную
    if (activeCat && activeCat.kind === 'audio') {
      const adl = e.target.closest('[data-catdl]');
      if (adl) {
        const en = activeCat.entries && activeCat.entries[+adl.dataset.catdl];
        if (en) catDownloadAudio(en);
        return;
      }
      const cb = e.target.closest('[data-catab]');
      if (cb) {
        const en = activeCat.entries && activeCat.entries[+cb.dataset.catab];
        const haveId = en && catBookIdOf(en);
        if (haveId) location.hash = '#/a/' + haveId;
        return;
      }
      if (e.target.closest('[data-catmore]')) { catMore(); return; }
      if (e.target.closest('[data-catretry]')) { catRetry(); return; }
    }
    const cont = e.target.closest('[data-abcont]');
    if (cont) { location.hash = '#/a/' + cont.dataset.abcont; return; }
    const card = e.target.closest('[data-ab]');
    if (card) location.hash = '#/a/' + card.dataset.ab;
  });

  // долгое нажатие по карточке полки → режим мультивыбора (touch); правый клик — на десктопе.
  // Не отпустил и повёл — то же удержание переходит в перетаскивание карточки (ручной порядок).
  {
    let lpTimer = null, lpStart = null;
    const shelfShown = () => !$('#shelf-view').hidden;
    const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    // палец ещё на карточке — держим её «взведённой» под перетаскивание
    const armHold = (card, x, y) => { cardHold = { card, x, y }; };
    // карточки каталога выбираются в каталоге И в коллекции (нескачанные плейсхолдеры),
    // но никогда не таскаются: их порядок задаёт источник/хвост сетки
    const catCard = card => card.classList.contains('cat-card');
    // стопка сборника не выбирается (галочке и номеру там взяться неоткуда) — её удержание
    // сразу готовит перетаскивание, чтобы двигать сборник по полке
    const foldCard = card => card.classList.contains('fold-card');
    const selectable = card => card && (!catCard(card) || activeCat || activeCol);
    addEventListener('touchstart', e => {
      if (!shelfShown() || uiOverlayOpen() || e.touches.length !== 1) return;
      const card = e.target.closest('.book-card, .ab-card');
      if (!selectable(card)) return;
      // в режиме выбора удержание не трогает выбор — сразу готовит перетаскивание
      const already = selMode && cardKindOf(card) === selKind;
      lpStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      lpTimer = setTimeout(() => {
        lpTimer = null;
        // книга ВНУТРИ раскрытого сборника: удержание готовит её ВЫНОС (перетаскивание за рамку),
        // а не выбор — поэтому в режим выбора её не вводим
        if (!already && !foldCard(card) && !card.closest('.fold-card.fold-open')) {
          lpFiredAt = performance.now();
          enterSelMode(cardKindOf(card), cardIdOf(card));
        }
        // тащатся книги везде и плейсхолдеры в коллекции; в каталоге порядок задаёт источник
        if (!catCard(card) || (activeCol && !activeCat)) armHold(card, lpStart.x, lpStart.y);
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
      }, already ? 320 : 500);
    }, { passive: true });
    // ведём перетаскивание сами и гасим прокрутку: без preventDefault полка уедет под пальцем
    addEventListener('touchmove', e => {
      if (cardDrag) {
        e.preventDefault();
        const t = e.touches[0];
        if (t) { cardDrag.cx = t.clientX; cardDrag.cy = t.clientY; cardDragMove(); }
        return;
      }
      if (cardHold && e.touches.length === 1) {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - cardHold.x, t.clientY - cardHold.y) > DRAG_START) {
          e.preventDefault();
          beginCardDrag(t.clientX, t.clientY);
        }
        return;
      }
      if (!lpTimer) return;
      const p = e.touches[0];
      if (Math.hypot(p.clientX - lpStart.x, p.clientY - lpStart.y) > 10) cancelLp();
    }, { passive: false });
    const dropHold = () => { cardHold = null; if (cardDrag) endCardDrag(); cancelLp(); };
    addEventListener('touchend', dropHold, { passive: true });
    addEventListener('touchcancel', dropHold, { passive: true });
    // мышь (ПК): то же удержание левой кнопкой — выбор, а с движением превращается в перетаскивание
    addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      if (!shelfShown() || uiOverlayOpen()) return;
      const card = e.target.closest('.book-card, .ab-card');
      if (!selectable(card)) return;
      const already = selMode && cardKindOf(card) === selKind;
      lpStart = { x: e.clientX, y: e.clientY };
      lpTimer = setTimeout(() => {
        lpTimer = null;
        if (!already && !card.classList.contains('fold-card') && !card.closest('.fold-card.fold-open')) {
          lpFiredAt = performance.now();
          enterSelMode(cardKindOf(card), cardIdOf(card));
        }
        if (!catCard(card) || (activeCol && !activeCat)) armHold(card, lpStart.x, lpStart.y);
      }, already ? 320 : 500);
    });
    addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;   // тач ведём через touchmove (там же гасим прокрутку)
      if (cardDrag) { cardDrag.cx = e.clientX; cardDrag.cy = e.clientY; cardDragMove(); return; }
      if (cardHold) {
        if (Math.hypot(e.clientX - cardHold.x, e.clientY - cardHold.y) > DRAG_START)
          beginCardDrag(e.clientX, e.clientY);
        return;
      }
      if (lpTimer && Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 10) cancelLp();
    });
    addEventListener('pointerup', e => { if (e.pointerType !== 'touch') dropHold(); });
    addEventListener('contextmenu', e => {
      if (!shelfShown() || selMode || uiOverlayOpen()) return;
      const card = e.target.closest('.book-card, .ab-card');
      if (!selectable(card) || card.classList.contains('fold-card')) return;
      e.preventDefault();
      lpFiredAt = performance.now();
      enterSelMode(cardKindOf(card), cardIdOf(card));
    });
  }
  $('#fab-del')?.addEventListener('click', deleteSelected);   // красная кнопка-мусорка в стопке FAB
  $('#fab-dl')?.addEventListener('click', downloadSelected);   // «скачать выбранное» — везде
  bindAudioUI();
  // вкладки главной панели: «Книги» и «Аудиокниги»
  $('#shelf-tabs').addEventListener('click', e => {
    const b = e.target.closest('.shelf-tab');
    if (b && b.dataset.tab !== shelfTab) setShelfTab(b.dataset.tab);   // тап по своей же вкладке ничего не перерисовывает
  });
  // свайп влево/вправо по всей главной панели — переключение вкладок. Слушаем на window
  // (а не на #shelf-view: он короче экрана, и снизу свайп не ловился)
  (() => {
    let sx = 0, sy = 0, axis = null, active = false;
    const onShelf = () => !$('#shelf-view').hidden && $('#reader-view').hidden && $('#library-view').hidden;
    addEventListener('touchstart', e => {
      axis = null; active = false;
      // ящик коллекций ИГНОРИРУЕМ (его свайп-закрытие обслуживает этот же обработчик, ниже),
      // но любое ДРУГОЕ окно поверх — глушит свайп
      if (e.touches.length !== 1 || !onShelf() || uiOverlayOpen(true)) return;
      // Свайп начинается откуда угодно, в том числе с карточки книги/аудиокниги: тапу это не
      // мешает — вкладка листается только при сдвиге от 36px, а на таком сдвиге браузер уже
      // отменил клик по кнопке. Исключаем лишь то, где горизонталь значит своё: поля ввода
      // (курсор/выделение), ползунки и сама панель вкладок.
      // #add-fab — перетаскиваемый кластер: касания на нём вкладки НЕ листают
      // .fold-carousel — горизонтальный свайп внутри неё листает КАРУСЕЛЬ сборника, а не
      // переключает вкладки и не открывает ящик коллекций
      if (fabDragging || cardDrag || cardHold || e.target.closest('input, textarea, select, .shelf-tabs, #col-tab, .col-grip, #add-fab, .fold-carousel')) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; active = true;
    }, { passive: true });
    addEventListener('touchmove', e => {
      if (cardDrag || cardHold) { active = false; return; }   // тащим карточку — вкладки не листаем
      if (!active || axis || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'skip';   // преобладает горизонталь — свайп
    }, { passive: true });
    addEventListener('touchend', e => {
      if (!active || axis !== 'x') return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) < 36) return;
      if (colDrawerOpen) { if (dx < 0) closeColDrawer(); return; }   // раздел открыт: свайп влево закрывает, вкладки не трогаем
      if (dx > 0) {                                                  // свайп вправо
        if (shelfTab === 'books') openColDrawer();                  // коллекции открываются ТОЛЬКО со вкладки Книги
        else setShelfTab('books');                                  // с аудио вправо — обратно к книгам
        return;
      }
      if (shelfTab === 'books') setShelfTab('audio');               // свайп влево — аудиокниги
    }, { passive: true });
  })();
  // резервная копия библиотеки
  $('#sync-light-btn')?.addEventListener('click', exportSync);
  $('#backup-btn').addEventListener('click', exportLibrary);
  $('#restore-btn').addEventListener('click', () => $('#restore-input').click());
  $('#restore-input').addEventListener('change', e => {
    doImport([...e.target.files]);
    e.target.value = '';
  });
  addEventListener('dragover', e => {
    if ($('#shelf-view').hidden) return;
    e.preventDefault();
    $('#shelf-view').classList.add('dragging');
  });
  addEventListener('dragleave', e => {
    if (e.relatedTarget === null) $('#shelf-view').classList.remove('dragging');
  });
  addEventListener('drop', e => {
    if ($('#shelf-view').hidden) return;
    e.preventDefault();
    $('#shelf-view').classList.remove('dragging');
    doImport([...e.dataTransfer.files]);
  });

  $('#search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    $('#notes-list').hidden = true;
    $('#notes-btn').classList.remove('active');
    const q = e.target.value.trim();
    if (q.length < 2) {
      searchSeq++;
      $('#search-results').hidden = true;
      $('#toc').hidden = false;
      return;
    }
    searchTimer = setTimeout(() => doSearch(q), 350);
  });
  $('#search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') e.target.blur();
  });

  document.body.addEventListener('click', e => {
    // режим мультивыбора: тап по карточке переключает выбор, а не открывает/удаляет
    // (кнопки в стопке FAB — мусорка/добавить — обрабатываются своими слушателями)
    if (selMode) { if (!e.target.closest('#add-fab')) { e.preventDefault(); selClick(e); } return; }
    // картинки в книге — неинтерактивны: тап по ним НЕ открывает их на весь экран,
    // а листает страницу (удобно для манги и комиксов). Лупу по тапу убрали намеренно.
    // каталог: удалить скачанную / книга (скачать или открыть) / дозагрузка / повтор после ошибки
    if (activeCat) {
      const cdel = e.target.closest('[data-del]');
      if (cdel && cdel.closest('.cat-card')) {   // крестик на скачанной карточке каталога
        const book = state.books.find(b => b.id === cdel.dataset.del);
        if (book) uiConfirm(T('deleteBookQ', { x: book.title }), { yes: t('dlgDelete'), danger: true })
          .then(ok => {
            if (!ok) return;
            deleteBook(book.id).then(() => {
              // из state книгу убирает animateRemoveBook обычной полки — тут делаем сами
              state.books = state.books.filter(b => b.id !== book.id);
              renderCatShelf();
              showToast(t('bookDeleted'));
            });
          });
        return;
      }
      // скачивание ТОЛЬКО со стрелки; тап по телу открывает уже скачанную
      const cdl = e.target.closest('[data-catdl]');
      if (cdl && activeCat.kind !== 'audio') {   // аудио-стрелку обслуживает обработчик #tab-audio
        const en = activeCat.entries && activeCat.entries[+cdl.dataset.catdl];
        if (en) catDownload(en);
        return;
      }
      const bk = e.target.closest('[data-catbook]');
      if (bk) {
        const en = activeCat.entries && activeCat.entries[+bk.dataset.catbook];
        const haveId = en && catBookIdOf(en);
        if (haveId) location.hash = '#/b/' + haveId;   // уже скачана — открываем как обычную
        return;
      }
      if (e.target.closest('[data-catmore]')) { catMore(); return; }
      if (e.target.closest('[data-catretry]')) { catRetry(); return; }
    }
    // коллекция: докачать книгу каталога стрелкой на обложке
    if (activeCol && !activeCat) {
      const ccd = e.target.closest('[data-colcatdl]');
      if (ccd) { colCatDownload(ccd.dataset.colcatdl); return; }
    }
    // сборники: раскрыть стопку, переименовать, расформировать, выйти из раскрытой
    {
      const fe = e.target.closest('[data-foldedit]');
      if (fe) { e.stopPropagation(); renameFolder(fe.dataset.foldedit); return; }
      const fb = e.target.closest('[data-foldbreak]');
      if (fb) { e.stopPropagation(); breakFolder(fb.dataset.foldbreak); return; }
      const fo = e.target.closest('[data-folder]');
      if (fo) { toggleFolder(fo.dataset.folder); return; }
    }
    // полка: открыть книгу / удалить книгу / продолжить чтение
    const open = e.target.closest('[data-open]');
    if (open) { location.hash = '#/b/' + open.dataset.open; return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      const book = state.books.find(b => b.id === del.dataset.del);
      if (book) uiConfirm(T('deleteBookQ', { x: book.title }), { yes: t('dlgDelete'), danger: true })
        .then(ok => {
          if (!ok) return;
          deleteBook(book.id).then(() => {
            animateRemoveBook(book.id);
            showToast(t('bookDeleted'));
          });
        });
      return;
    }
    const contShelf = e.target.closest('[data-cont]');
    if (contShelf) {
      location.hash = '#/b/' + contShelf.dataset.cont + '/c/' + contShelf.dataset.ch;
      return;
    }
    // оглавление: кружок статуса главы
    const st = e.target.closest('.ch-row .ch-status');
    if (st) {
      const idx = +st.closest('.ch-row').dataset.ch;
      markChapters([idx], !isRead(idx));
      return;
    }
    // счётчик раздела — отметить/снять всё
    const badge = e.target.closest('.count-badge');
    if (badge) {
      e.preventDefault();
      const k = badge.closest('details')?.dataset.k || '';
      let node = null;
      (function find(nodes) {
        for (const n of nodes) {
          if (n._k === k) { node = n; return; }
          if (n.kids) find(n.kids);
        }
      })(state.toc);
      if (!node) return;
      const ids = chaptersUnder(node);
      if (!ids.length) return;
      const allRead = ids.every(isRead);
      const q = T(allRead ? 'unmarkAllQ' : 'markAllQ', { x: node.t });
      uiConfirm(q, { yes: allRead ? t('dlgUnmark') : t('dlgMark') })
        .then(ok => { if (ok) markChapters(ids, !allRead); });
      return;
    }
    // список заметок: создать / удалить / скопировать все / перейти к месту
    if (e.target.closest('#notes-add-btn')) { addBookNoteFromMenu(); return; }
    const ndel = e.target.closest('[data-note-del]');
    if (ndel) {
      e.stopPropagation();
      const nid = ndel.dataset.noteDel;
      const item = ndel.closest('.note-item');
      if (item) flyAwayThenDelete(item, () => deleteBookNote(nid));
      else deleteBookNote(nid);
      return;
    }
    if (e.target.closest('#notes-copy')) {
      copyText(notesMarkdown()).then(ok => showToast(ok ? t('copied') : t('copyFail')));
      return;
    }
    if (e.target.closest('#notes-del-all')) {
      const ru = uiLang() === 'ru';
      uiConfirm(ru ? 'Удалить все заметки книги?' : 'Delete all notes of this book?', { yes: t('noteDelete') })
        .then(async ok => {
          if (!ok) return;
          const removed = bookNotesCache.slice();
          await Promise.all(removed.map(n => dbDel('notes', n.id)));
          await renderNotesList();
          refreshNotesBadge();
          showToast(ru ? 'Все заметки удалены' : 'All notes deleted', t('undo'), async () => {
            await Promise.all(removed.map(n => dbPut('notes', n)));
            await renderNotesList();
            refreshNotesBadge();
          });
        });
      return;
    }
    const nitem = e.target.closest('.note-item');
    if (nitem) {
      const rec = bookNotesCache.find(n => n.id === nitem.dataset.noteId);
      if (rec) {
        pendingNoteJump = { idx: rec.idx, start: rec.start, end: rec.end };
        location.hash = chHash(rec.idx);
      }
      return;
    }
    const row = e.target.closest('[data-ch]');
    if (row && (row.classList.contains('ch-row') || row.classList.contains('sr-item')
        || row.classList.contains('cont-card'))) {
      location.hash = chHash(+row.dataset.ch);
      return;
    }
    const chip = e.target.closest('.chip');
    if (chip) {
      if ('gotoCurrent' in chip.dataset) { gotoCurrent(); return; }
      const pid = chip.dataset.part;
      expanded.add(pid);
      localStorage.setItem(expandedKey(), JSON.stringify([...expanded]));
      renderToc();
      const det = document.querySelector(`#toc details[data-k="${pid}"]`);
      if (det) det.scrollIntoView({ block: 'start' });
      return;
    }
    // Пока открыта шторка/меню/диалог — тап НЕ должен доходить до текста главы. Иначе
    // нажатие кнопки внутри окна доезжало до обработчика чтения, и озвучка перескакивала
    // на предложение, оказавшееся ПОД этой кнопкой. То же сразу после закрытия: «призрачный»
    // клик от того же касания успевает прилететь уже по открывшемуся тексту.
    if (!$('#reader-view').hidden && e.target.closest('.chapter-body')
        && (overlayOpen() || performance.now() < readerTapMuteUntil)) return;
    if (!$('#reader-view').hidden && e.target.closest('.chapter-body')
        && !e.target.closest('a') && !String(getSelection() || '').trim()) {
      // открыт попап перевода слова — любой тап по тексту сначала гасит его
      if (wordPopOpen()) { closeWordPop(); return; }
      // тап по заметке открывает её — проверяем ДО всего: заметки рисуются подсветкой
      // (Highlight API) поверх обычного текста, поэтому тап попадает на сам <p>, а не на span
      const hitNote = noteAtPoint(e.clientX, e.clientY);
      if (hitNote) { openNoteSheet(hitNote); return; }
      // ПЕРЕКЛЮЧЕНИЕ между предложениями/абзацами работает ТОЛЬКО когда озвучка уже
      // включена (показана панель аудио). Простой тап по тексту озвучку НЕ запускает.
      if (tts.active) {
        const p = e.target.closest(
          '#chapter-body p, #chapter-body h3, #chapter-body h4, #chapter-body blockquote');
        // тап по КОНКРЕТНОМУ ПРЕДЛОЖЕНИЮ — ищем по прямоугольникам текста (надёжно на justify)
        if (p && !e.target.closest('.tr-block')) {
          const idx = sentenceItemAtPoint(tts.items, p, e.clientX, e.clientY);
          if (idx >= 0) {
            try { getSelection().removeAllRanges(); } catch {}
            ttsPlayFrom(idx); return;
          }
        }
        // тап мимо абзаца при активной озвучке — просто прячем/показываем шапку
        $('#reader-header').classList.toggle('hidden');
        return;
      }
      // Листает только НИЖНЯЯ ЧЕТВЕРТЬ экрана: левая половина — назад, правая — вперёд.
      // Срабатывает мгновенно. Всё, что выше, отдано двойному тапу по слову — там перевод
      // и листание уже не спорят за одно и то же касание.
      if (e.clientY > innerHeight * 0.75) {
        pageTurn(e.clientX < innerWidth * 0.5 ? -1 : 1);
        return;
      }
      // Выше зоны листания. Второй тап рядом и в срок — перевод слова. Иначе тоггл шапки,
      // отложенный на 300мс: ждать приходится только его, а он и так не про скорость.
      const now = performance.now();
      if (lastTap && now - lastTap.t < 320
          && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 28) {
        clearTimeout(hdrTimer); hdrTimer = null;
        const hit = wordAt(lastTap.x, lastTap.y);   // слово берём по ПЕРВОМУ тапу
        lastTap = null;
        if (hit) { openWordPop(hit); return; }
      }
      lastTap = { x: e.clientX, y: e.clientY, t: now };
      clearTimeout(hdrTimer);
      hdrTimer = setTimeout(() => {
        hdrTimer = null; lastTap = null;
        $('#reader-header').classList.toggle('hidden');
      }, 300);
    }
  });

  // свайпы листают главы — страница «тянется» за пальцем и уезжает
  let sw = null;
  const swipeBlocked = () =>
    $('#reader-view').hidden || !$('#sel-toolbar').hidden || uiOverlayOpen();
  // свайп двигает ТОЛЬКО тело главы — заголовок/мета/крошки остаются на месте
  // и меняются затуханием (задача 2), а не уезжают вместе с текстом
  const art = () => $('#chapter-body');
  addEventListener('touchstart', e => {
    sw = null;
    if (swipeBlocked() || e.touches.length !== 1) return;
    // не листаем главы при касании плеера/кнопок/полей (иначе жест скорости листает страницы)
    if (e.target.closest('#tts-bar, .speed-dome, button, input, textarea, a, .lang-menu')) return;
    const p = e.touches[0];
    sw = { x: p.clientX, y: p.clientY, dx: 0, axis: null, at: performance.now() };
  }, { passive: true });
  addEventListener('touchmove', e => {
    if (!sw || e.touches.length !== 1) return;
    const p = e.touches[0];
    const dx = p.clientX - sw.x, dy = p.clientY - sw.y;
    if (!sw.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      sw.axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
      if (sw.axis === 'x' && String(getSelection())) { sw = null; return; }
    }
    if (sw.axis !== 'x') { sw.dy = dy; return; }   // вертикаль — запоминаем для свайпа-вниз (шапка)
    const ch = state.chapter;
    let d = dx;
    if ((d > 0 && !(ch && ch.prev_idx != null)) || (d < 0 && !(ch && ch.next_idx != null))) d *= 0.28;
    sw.dx = d;
    const a = art();
    if (a) {
      // НЕ двигаем тело по горизонтали — иначе оно вылезает за край, вьюпорт дёргается и
      // фиксированные иконки (шапка/стрелки) прыгают. Свайп — чистый crossfade: тело гаснет
      // по мере протяжки, на отпускании доугасает и появляется новая глава.
      a.style.transition = 'none';
      a.style.transform = '';
      a.style.opacity = String(Math.max(0.5, 1 - Math.abs(d) / (innerWidth * 1.1)));
    }
    e.preventDefault();
  }, { passive: false });
  addEventListener('touchend', () => {
    if (!sw) return;
    // свайп ВНИЗ открывает верхнюю панель — работает всегда, даже когда листать некуда
    // (PDF/короткая глава): там скролла нет, и обычное «показать шапку при прокрутке вверх»
    // не срабатывает, а вызвать меню было нечем.
    if (sw.axis === 'y') {
      if (sw.dy > 45) {                                    // вниз — показать шапку, навигацию И аудиопанель
        $('#reader-header').classList.remove('hidden');
        $('#reader-fabnav')?.classList.remove('hidden');
        if (tts.active) { const b = $('#tts-bar'); b.hidden = false; b.classList.remove('tucked'); }
      } else if (sw.dy < -45) {                            // вверх — скрыть всё это (чистое чтение; предохранитель для коротких страниц)
        $('#reader-header').classList.add('hidden');
        $('#reader-fabnav')?.classList.add('hidden');
        $('#tts-bar').classList.add('tucked');
      }
      sw = null; return;
    }
    if (sw.axis !== 'x') { sw = null; return; }
    const a = art(), ch = state.chapter;
    const dx = sw.dx, dt = performance.now() - sw.at;
    const far = Math.abs(dx) > Math.min(140, innerWidth * 0.26) || (dt < 300 && Math.abs(dx) > 55);
    sw = null;
    if (!a) return;
    if (far && dx < 0 && ch && ch.next_idx != null) commitSwipe(a, -1, () => { location.hash = chHash(ch.next_idx); });
    else if (far && dx > 0 && ch && ch.prev_idx != null) commitSwipe(a, 1, () => { location.hash = chHash(ch.prev_idx); });
    else { a.style.transition = 'transform .22s cubic-bezier(.2,.8,.3,1), opacity .22s ease'; a.style.transform = ''; a.style.opacity = ''; }
  }, { passive: true });

  $('#search-results').addEventListener('touchstart', () => {
    if (document.activeElement === $('#search-input')) $('#search-input').blur();
  }, { passive: true });

  // приближение картинок двумя пальцами (тап по картинке отключён — см. task 4).
  // Картинка масштабируется на месте, поверх текста, к центру щипка; когда пальцы
  // убраны — плавно возвращается в исходный размер и положение. Раскладку не двигает
  // (используем transform, он не влияет на поток), поэтому текст вокруг не «прыгает».
  (() => {
    let img = null, startDist = 0;
    const gap = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    addEventListener('touchstart', e => {
      if (e.touches.length !== 2 || uiOverlayOpen()) return;
      const t = e.target.closest && e.target.closest('#chapter-body img');
      if (!t) return;
      img = t;
      startDist = gap(e.touches[0], e.touches[1]) || 1;
      const r = img.getBoundingClientRect();
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      img.style.transformOrigin =
        `${((mx - r.left) / r.width * 100).toFixed(1)}% ${((my - r.top) / r.height * 100).toFixed(1)}%`;
      img.style.transition = 'none';
      img.style.willChange = 'transform';
      img.style.position = 'relative';
      img.style.zIndex = '30';
      e.preventDefault();
    }, { passive: false });
    addEventListener('touchmove', e => {
      if (!img || e.touches.length !== 2) return;
      const s = Math.max(1, Math.min(5, gap(e.touches[0], e.touches[1]) / startDist));
      img.style.transform = `scale(${s.toFixed(3)})`;
      e.preventDefault();
    }, { passive: false });
    const release = e => {
      if (!img) return;
      if (e.touches && e.touches.length >= 1) return;   // ещё палец на экране — ждём
      const el = img; img = null;
      el.style.transition = 'transform .25s cubic-bezier(.2,.8,.3,1)';
      el.style.transform = 'scale(1)';
      setTimeout(() => {
        el.style.cssText = el.style.cssText
          .replace(/transform[^;]*;?/g, '').replace(/transition[^;]*;?/g, '')
          .replace(/transform-origin[^;]*;?/g, '').replace(/will-change[^;]*;?/g, '')
          .replace(/z-index[^;]*;?/g, '').replace(/position[^;]*;?/g, '');
      }, 270);
    };
    addEventListener('touchend', release, { passive: true });
    addEventListener('touchcancel', release, { passive: true });
  })();

  // панель выделения: цвета маркера, заметка, «озвучить отсюда»
  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const info = !$('#reader-view').hidden && $('#note-sheet').hidden
        && $('#tr-sheet').hidden && $('#annot-sheet').hidden && $('#review-sheet').hidden
        ? selectionInfo() : null;
      selCache = info;
      if (info) showSelToolbar(); else hideSelToolbar();
    }, 200);
  });
  $('#sel-toolbar').addEventListener('pointerdown', e => {
    e.preventDefault();   // не даём сбросить выделение
    const dot = e.target.closest('[data-c]');
    if (dot) { addNote(dot.dataset.c, false); return; }
    if (e.target.closest('#sel-erase')) { eraseSelectionMarks(); return; }
    if (e.target.closest('#sel-note')) { addNote('y', true); return; }
    if (e.target.closest('#sel-tr')) {
      const s = String(getSelection()) || (selCache && selCache.text) || '';
      getSelection().removeAllRanges();
      hideSelToolbar();
      openTrSheet(s);
      return;
    }
    if (!e.target.closest('#sel-speak')) return;
    const sel = getSelection();
    // выделение могло схлопнуться от тапа — восстанавливаем из кэша
    const range = (sel && !sel.isCollapsed && sel.rangeCount) ? sel.getRangeAt(0)
      : (selCache ? rangeFromOffsets($('#chapter-body'), selCache.start, selCache.end) : null);
    if (!range) return;
    const node = range.startContainer;
    const el = (node.nodeType === 1 ? node : node.parentElement).closest(
      '#chapter-body p, #chapter-body h3, #chapter-body h4, #chapter-body blockquote');
    if (!el) return;
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    const offset = pre.toString().length;
    const boundary = { node: range.startContainer, off: range.startOffset };
    hideSelToolbar();
    sel.removeAllRanges();
    ttsStop();
    ttsStart(el, offset, boundary);   // точная граница выделения — надёжнее смещения
  });

  // листы заметки и отзыва
  $('#note-overlay').addEventListener('click', closeNoteSheet);
  $('#note-save').addEventListener('click', saveNote);
  $('#note-delete').addEventListener('click', deleteNote);
  $('#note-colors').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('#note-colors button')
      .forEach(x => x.classList.toggle('on', x === b));
  });
  $('#notes-btn').addEventListener('click', () => toggleNotesList());
  $('#review-btn').addEventListener('click', openReviewSheet);
  // закладки: кнопка-флажок в читалке ставит/снимает, список в меню книги — переходит
  // «Подробнее» в попапе слова — открыть полноценную шторку перевода
  $('#wp-more').addEventListener('click', e => {
    e.stopPropagation();
    const w = wordPopHit && wordPopHit.word;
    closeWordPop();
    if (w) openTrSheet(w);
  });
  $('#word-pop').addEventListener('click', e => e.stopPropagation());   // тап по попапу его не гасит
  $('#bm-btn').addEventListener('click', toggleBookmark);
  // автопрокрутка крутится тем же барабаном, что скорость речи и таймер сна:
  // тап — следующая скорость, зажать и вести палец — выбор из списка
  bindWheelDial($('#scroll-btn'), {
    labels: SCROLL_SPEEDS.map((v, i) => String(i)),   // 0 — просто «0», без текста на 3 строки
    getIdx: autoScrollIdx,
    onLive: i => autoScrollSyncUI(i),      // во время кручения — только показываем выбор
    onCommit: i => autoScrollSet(i),
    onTap: () => autoScrollCycle(),
  });
  // словарь произношений: добавить/удалить + Enter, и быстрый ввод из попапа слова
  $('#pronun-add')?.addEventListener('click', addPronun);
  $('#pronun-from')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#pronun-to').focus(); } });
  $('#pronun-to')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addPronun(); } });
  $('#pronun-list')?.addEventListener('click', e => { const del = e.target.closest('[data-pdel]'); if (!del) return; const item = del.closest('[data-pi]'); if (item) delPronun(+item.dataset.pi); });
  setupSwipeList('#pronun-list', it => delPronun(+it.dataset.pi), '[data-pdel]', null, '.pronun-item');   // смахивание влево удаляет, как у закладок
  $('#wp-pron')?.addEventListener('click', e => { e.stopPropagation(); openPronunFor(wordPopHit && wordPopHit.word); });
  $('#wp-say')?.addEventListener('click', e => { e.stopPropagation(); speakWord(wordPopHit && wordPopHit.word); });
  $('#pronun-open-list')?.addEventListener('click', openPronunList);
  $('#pronun-overlay')?.addEventListener('click', closePronunList);
  $('#bm-list-btn').addEventListener('click', () => toggleBmList());
  $('#bm-list').addEventListener('click', e => {
    const del = e.target.closest('[data-bmdel]');
    if (del) {
      e.stopPropagation();
      const card = del.closest('.note-item'); const id = del.dataset.bmdel;
      if (card) flyAwayThenDelete(card, () => bmDelete(id)); else bmDelete(id);
      return;
    }
    const item = e.target.closest('[data-bm]');
    if (item) bmJump(item.dataset.bm);
  });
  // свайп влево — удаление (то же что крестик); долгое удержание заметки — её редактор
  setupSwipeList('#notes-list', it => deleteBookNote(it.dataset.noteId), '[data-note-del]',
    it => { const rec = bookNotesCache.find(n => n.id === it.dataset.noteId); if (rec) openNoteSheet(rec); });
  setupSwipeList('#bm-list', it => bmDelete(it.dataset.bm), '[data-bmdel]');
  setupIconTapAnim();
  // описание книги: добавить/изменить/развернуть
  $('#book-annot').addEventListener('click', e => {
    if (e.target.closest('#annot-add') || e.target.closest('#annot-edit')) {
      openAnnotSheet();
      return;
    }
    if (e.target.closest('#annot-more') || e.target.closest('.annot-text')) {
      toggleAnnot();
      return;
    }
  });
  $('#annot-overlay').addEventListener('click', closeAnnotSheet);
  $('#annot-save').addEventListener('click', saveAnnot);
  // редактор обложки (книга и аудиокнига — одна шторка): изменить · удалить · вернуть исходную
  $('#annot-cover-set').addEventListener('click', async () => { const blob = await chooseCoverBlob(); if (blob) applyCover(blob); });
  $('#annot-cover-clear').addEventListener('click', () => applyCover(null));
  $('#annot-cover-restore').addEventListener('click', restoreCover);
  $('#ab-edit').addEventListener('click', () => openAnnotSheet('audio'));   // вход в редактор аудиокниги
  $('#ab-desc').addEventListener('click', e => {
    if (e.target.closest('#ab-desc-more') || e.target.closest('.annot-text'))
      toggleAnnot($('#ab-desc-text'), $('#ab-desc-more'));
  });
  // заметки и оценка аудиокниги (паритет с книгами)
  $('#ab-notes-btn').addEventListener('click', openAudioNotes);
  $('#ab-review-btn').addEventListener('click', () => openReviewSheet('audio'));
  $('#ab-note-add').addEventListener('click', addAudioNote);
  $('#ab-notes-copy').addEventListener('click', () => copyText(audioNotesMarkdown()).then(ok => showToast(ok ? t('copied') : t('copyFail'))));
  $('#ab-notes-overlay').addEventListener('click', () => sheetHide($('#ab-notes-sheet'), $('#ab-notes-overlay')));
  // долгое нажатие по заметке — копировать её (книга и аудио)
  bindNoteLongPress($('#notes-list'), item => { const n = bookNotesCache.find(x => x.id === item.dataset.noteId); return n ? bookNoteCopyText(n) : ''; });
  bindNoteLongPress($('#ab-notes-list'), item => { const n = ((ab && ab.rec && ab.rec.notes) || []).find(x => x.id === item.dataset.abnote); return n ? audioNoteCopyText(n) : ''; });
  $('#note-jump').addEventListener('click', () => { if (editingAudioNote) abNoteJump(editingAudioNote); });
  $('#ab-notes-list').addEventListener('click', e => {
    const del = e.target.closest('[data-abnote-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.abnoteDel;
      if (ab && ab.rec) { ab.rec.notes = (ab.rec.notes || []).filter(n => n.id !== id); dbPut('audiobooks', ab.rec); refreshAudioNotesBadge(); renderAudioNotes(); }
      return;
    }
    const item = e.target.closest('.note-item[data-abnote]');
    if (item) { const n = ((ab && ab.rec && ab.rec.notes) || []).find(x => x.id === item.dataset.abnote); if (n) openAudioNoteEditor(n); }
  });
  $('#annot-find').addEventListener('click', findAnnotations);
  for (const id of ['annot-title', 'annot-author']) $('#' + id).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); findAnnotations(); }
  });
  $('#annot-results').addEventListener('click', e => {
    const b = e.target.closest('[data-res]');
    if (!b) return;
    const f = findResults[+b.dataset.res];
    if (!f) return;
    $('#annot-input').value = f.text.slice(0, 2000);
    document.querySelectorAll('.annot-res')
      .forEach(x => x.classList.toggle('on', x === b));
  });
  $('#review-overlay').addEventListener('click', closeReviewSheet);
  $('#star-row').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const i = [...b.parentElement.children].indexOf(b) + 1;
    reviewStars = reviewStars === i ? 0 : i;   // повторный тап по той же звезде снимает оценку целиком
    syncStarsUI();
  });
  $('#review-save').addEventListener('click', () => saveReview(false));
  $('#review-share').addEventListener('click', () => saveReview(true));

  // переводчик
  $('#tr-btn').addEventListener('click', toggleChapterTr);
  $('#tr-overlay').addEventListener('click', closeTrSheet);
  $('#tr-copy').addEventListener('click', async () => {
    showToast((await copyText($('#tr-result').textContent))
      ? t('copied') : t('copyFail'));
  });
  buildLangPicker($('#tr-lang-pick'));   // выпадашка в листе перевода остаётся
  // «Переводчик» в настройках: отдельная кнопка «Авто» + встроенный вертикальный
  // список языков — крутится ПРЯМО в строке (сверху/снизу видны соседние языки), без всплывашек
  const trAuto = $('#tr-auto');
  if (trAuto) trAuto.addEventListener('click', () => setTrLang('auto'));
  buildTrPicker();
  document.addEventListener('click', closeLangMenus);
  // при прокрутке содержимого шторки/окна плавающее меню отвязывается — закрываем
  for (const id of ['settings', 'tr'])
    $('#' + id + '-sheet').addEventListener('scroll', closeLangMenus, { passive: true });
  addEventListener('resize', closeLangMenus);

  // боковые стрелки листания глав (широкие экраны)
  $('#edge-prev').addEventListener('click', () => $('#prev-btn').click());
  $('#edge-next').addEventListener('click', () => $('#next-btn').click());

  $('#part-chips').addEventListener('wheel', e => {
    const bar = e.currentTarget;
    if (bar.scrollWidth > bar.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      bar.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  $('#lightbox').addEventListener('click', closeLightbox);

  $('#toc').addEventListener('toggle', e => {
    const k = e.target.dataset && e.target.dataset.k;
    if (!k) return;
    if (e.target.open) expanded.add(k); else expanded.delete(k);
    localStorage.setItem(expandedKey(), JSON.stringify([...expanded]));
  }, true);

  $('#back-btn').addEventListener('click', () => {
    location.hash = state.book ? '#/b/' + state.book.id : '#/';
  });
  $('#shelf-btn').addEventListener('click', () => { location.hash = '#/'; });

  for (const id of ['shelf-settings-btn', 'lib-settings-btn', 'reader-settings-btn'])
    $('#' + id).addEventListener('click', openSettings);
  $('#settings-overlay').addEventListener('click', closeSettings);
  $('#info-btn').addEventListener('click', openInfo);
  $('#update-btn')?.addEventListener('click', otaManualCheck);
  $('#info-overlay').addEventListener('click', closeInfo);
  $('#filter-btn').addEventListener('click', toggleFilters);
  // коллекции («свои полки»)
  setupColDrawer();
  $('#fab-collect')?.addEventListener('click', () => activeCol ? removeFromActiveCol() : openColPick());
  $('#fab-fold')?.addEventListener('click', foldSelected);   // объединить выбранное в сборник
  $('#fab-more')?.addEventListener('click', e => { e.stopPropagation(); openFabMore(); });
  // тап мимо кластера сворачивает «ещё» обратно в троеточие (и по касанию, и по клику)
  for (const ev of ['pointerdown', 'click']) addEventListener(ev, e => {
    if (fabMoreOpen() && !e.target.closest('#add-fab')) closeFabMore();
  }, true);
  $('#col-create-cancel')?.addEventListener('click', closeColCreate);
  $('#col-create-save')?.addEventListener('click', saveNewCol);
  $('#col-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveNewCol(); } });
  $('#col-pick-cancel')?.addEventListener('click', closeColPick);
  $('#col-pick-add')?.addEventListener('click', applyColPick);
  $('#col-pick-list')?.addEventListener('click', e => {
    const b = e.target.closest('[data-pick]'); if (!b || !colPickSel) return;
    const id = b.dataset.pick;
    if (colPickSel.has(id)) colPickSel.delete(id); else colPickSel.add(id);
    b.classList.toggle('on', colPickSel.has(id));
  });

  $('#reset-progress-btn').addEventListener('click', async () => {
    if (!state.book) return;
    if (!(await uiConfirm(T('resetQ', { x: state.book.title }), { yes: t('dlgReset'), danger: true }))) return;
    clearTimeout(saveTimer);
    dirty = null;
    invalidateShelfData();
    await dbDel('progress', bookRange(state.book.id));
    await dbDel('kv', 'last:' + state.book.id);
    if ((await kvGet('lastBook')) === state.book.id) await dbDel('kv', 'lastBook');
    state.chapter = null;
    state.progress = { last: null, map: {} };
    state.libScroll = 0;
    closeSettings();
    const bookHash = '#/b/' + state.book.id;
    if (location.hash !== bookHash) location.hash = bookHash;
    else showLibrary(state.book.id);
    showToast(t('resetDone'));
  });

  // озвучка
  if (ttsSupported) {
    refreshVoices();
    speechSynthesis.addEventListener('voiceschanged', refreshVoices);
  }
  loadCapVoices();     // голоса устройства (Android/iOS)
  loadNeuralVoices();  // онлайн-нейроголоса, если доступен сервер
  initMediaSession();  // фоновое аудио: кнопки в системном уведомлении, не глохнет при экране off
  probeNet();          // реальная проверка интернета — для доступности нейроголосов
  $('#tts-btn').addEventListener('click', () => {
    unlockAudio();
    if (tts.active) { tts.playing ? ttsPause() : ttsPlay(); }
    else ttsStart();
  });
  $('#tts-play').addEventListener('click', () => {
    unlockAudio();
    tts.playing ? ttsPause() : ttsPlay();
  });
  $('#tts-stop').addEventListener('click', ttsStop);
  $('#tts-prev').addEventListener('click', () => ttsJumpPara(-1));
  $('#tts-next').addEventListener('click', () => ttsJumpPara(+1));
  buildVoicePicker();
  // панель компактная (одна строка) — свайп вниз/тап по ручке убирает её за экран,
  // свайп вверх возвращает
  (() => {
    const bar = $('#tts-bar'), grip = $('#tts-grip');
    if (grip) grip.addEventListener('click', () => bar.classList.toggle('tucked'));
    let sy = null;
    bar.addEventListener('touchstart', e => {
      // жесты по колёсам (скорость/таймер) и по иконке голоса — не свайп-сворачивание
      sy = e.target.closest('#tts-speed, #tts-timer, .voice-round') ? null : e.touches[0].clientY;
    }, { passive: true });
    bar.addEventListener('touchmove', e => {
      if (sy == null) return;
      const dy = e.touches[0].clientY - sy;
      if (dy > 28) { bar.classList.add('tucked'); sy = null; }
      else if (dy < -28) { bar.classList.remove('tucked'); sy = null; }
    }, { passive: true });
  })();
  // ручное листание/прокрутка во время озвучки — перестаём тащить страницу к тексту
  for (const ev of ['wheel', 'touchmove'])
    addEventListener(ev, () => { if (tts.active) ttsFollow = false; }, { passive: true });
  // прокрутка текста во время озвучки: тянем вниз — компактная панель уезжает за экран,
  // тянем вверх — возвращается (не мешает читать)
  let lastScrollY = 0, tuckAcc = 0;
  addEventListener('scroll', () => {
    if (!tts.active || $('#reader-view').hidden) { lastScrollY = scrollY; return; }
    const y = scrollY, bar = $('#tts-bar');
    const dy = y - lastScrollY;
    lastScrollY = y;
    if (performance.now() < ttsProgScrollUntil) return;   // авто-подводка к тексту, не жест
    if (Math.abs(dy) < 2) return;
    if ((dy > 0) !== (tuckAcc > 0)) tuckAcc = 0;           // сменили направление — копим заново
    tuckAcc += dy;
    const STEP = 48;
    if (tuckAcc > STEP) { tuckAcc = 0; bar.classList.add('tucked'); }
    else if (tuckAcc < -STEP) { tuckAcc = 0; bar.classList.remove('tucked'); }
  }, { passive: true });
  // тап по стороннему интерфейсу (не по самому тексту книги) во время озвучки —
  // тоже прекращаем автоследование, чтобы страница не «прыгала» к месту чтения
  addEventListener('pointerdown', e => {
    if (tts.active && !e.target.closest('#chapter-body')) ttsFollow = false;
  }, { passive: true });
  // подгонка заголовка книги при повороте/изменении размера
  let fitT = null;
  addEventListener('resize', () => {
    clearTimeout(fitT);
    fitT = setTimeout(() => { if (!$('#library-view').hidden) fitTitle($('#book-title')); }, 150);
  });
  // скорость: короткий тап — цикл по значениям; зажать и вести палец влево/вправо — выбор по «шкале»
  const RATES = [0.8, 1, 1.25, 1.5, 1.75, 2];
  const fmtRate = r => (Number.isInteger(r) ? r.toFixed(1) : String(r)) + '×';
  const rateIdx = () => {
    const i = RATES.findIndex(r => Math.abs(r - settings.ttsRate) < 0.01);
    return i < 0 ? 1 : i;
  };
  const setRate = (idx, live) => {
    idx = Math.max(0, Math.min(RATES.length - 1, idx));
    settings.ttsRate = RATES[idx];
    $('#tts-rate-value').textContent = fmtRate(settings.ttsRate);
    saveSettings();
    if (isNeural()) audioEl.playbackRate = settings.ttsRate;
    else if (!live && tts.active && tts.playing) speakCurrent(tts.pos);   // cap/браузер не дёргаем на каждом шаге
  };
  // скорость и таймер сна — на одинаковом «колесе»: короткий тап циклит значения,
  // зажать и вести палец вверх/вниз — выбор по барабану
  bindWheelDial($('#tts-speed'), {
    labels: RATES.map(fmtRate),
    getIdx: rateIdx,
    onLive: idx => setRate(idx, true),
    onCommit: idx => setRate(idx, false),
    onTap: () => setRate((rateIdx() + 1) % RATES.length, false),
  });
  bindWheelDial($('#tts-timer'), {
    labels: SLEEP_MINS.map(m => m === 0 ? t('sleepOff') : m + ' мин'),
    getIdx: sleepIdx,
    onLive: idx => sleepPreview(SLEEP_MINS[idx]),   // во время кручения — только показываем выбор
    onCommit: idx => sleepSet(SLEEP_MINS[idx]),
    onTap: () => sleepSet(SLEEP_MINS[(sleepIdx() + 1) % SLEEP_MINS.length]),
  });
  bindSeg('seg-theme', 'theme');
  bindSeg('seg-font', 'font');
  bindSeg('seg-align', 'align');
  bindSeg('seg-width', 'width');
  bindSeg('seg-lang', 'lang');
  bindStep('size-minus', 'size-plus', 'size', 14, 26, 1, 0);
  bindStep('lh-minus', 'lh-plus', 'lh', 1.4, 2.0, 0.05, 2);
  const bindRange = (id, key, min, max, digits) => {
    const el = $('#' + id);
    if (!el) return;
    // защита от случайного сбоя настройки: значение меняется ТОЛЬКО когда тянут сам
    // ползунок. Тап/пролистывание по дорожке — игнорируем (откатываем к текущему).
    // Вертикальный скролл проходит сквозь слайдер (touch-action: pan-y в CSS).
    let armed = false;
    const onThumb = e => {
      const r = el.getBoundingClientRect();
      if (!r.width) return false;
      const frac = (settings[key] - min) / (max - min);
      const thumbX = r.left + frac * r.width;
      return Math.abs((e.clientX ?? thumbX) - thumbX) <= 22;   // ~радиус ползунка
    };
    el.addEventListener('pointerdown', e => { armed = onThumb(e); }, { passive: true });
    el.addEventListener('keydown', () => { armed = true; });     // стрелки на ПК — допускаем
    addEventListener('pointerup', () => { armed = false; }, { passive: true });
    el.addEventListener('input', () => {
      if (!armed) { el.value = settings[key]; rangeFill(el); return; }   // не с ползунка — откат
      settings[key] = Math.min(max, Math.max(min, +(+el.value).toFixed(digits)));
      rangeFill(el);
      applySettings();
    });
  };
  bindRange('size-range', 'size', 14, 26, 0);
  bindRange('lh-range', 'lh', 1.4, 2.0, 2);

  addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (confirmOpen()) { closeConfirm(false); return; }
      closeLightbox(); closeSettings(); closeNoteSheet(); closeReviewSheet();
      closeAnnotSheet(); closeTrSheet();
      return;
    }
    if (confirmOpen() && e.key === 'Enter') { closeConfirm(true); return; }
    if ($('#reader-view').hidden || !$('#settings-sheet').hidden) return;
    if (e.target.matches('input,textarea,select')) return;
    if (e.key === 'ArrowRight') $('#next-btn').click();
    if (e.key === 'ArrowLeft') $('#prev-btn').click();
  });
}

function bindSeg(segId, key) {
  $('#' + segId).addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !b.dataset.v) return;   // кнопки без data-v (напр. колесо шрифтов) — не наши
    settings[key] = b.dataset.v;
    applySettings();
  });
}

// Смена главы по свайпу: тело ГАСНЕТ НА МЕСТЕ (crossfade), без уезда за экран. Уезд
// translateX(±W) заставлял тело «улетать» вбок, а на возврате/подмене — скакать. Теперь
// плавно гаснет там, где остановился палец, а openChapter вернёт transform в 0 и проявит
// новую главу (body-fade). Горизонтального «улёта» и рывков больше нет.
function commitSwipe(a, dir, navFn) {
  a.style.transition = 'opacity .16s ease';   // transform НЕ трогаем — тело гаснет там, где палец
  a.style.opacity = '0';
  setTimeout(navFn, 150);
}

function bindStep(minusId, plusId, key, min, max, step, digits) {
  const clamp = v => Math.min(max, Math.max(min, +v.toFixed(digits)));
  $('#' + minusId).addEventListener('click', () => { settings[key] = clamp(settings[key] - step); applySettings(); });
  $('#' + plusId).addEventListener('click', () => { settings[key] = clamp(settings[key] + step); applySettings(); });
}

function openLightbox(src) {
  $('#lightbox-img').src = src;
  $('#lightbox').hidden = false;
}
function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightbox-img').src = '';
}

// ── общий контроллер нижних шторок: плавно, со свайпом вниз ──
// пока окно открыто — его кнопка выглядит нажатой (.sheet-on); при закрытии отжимается.
// Карта «id окна → кнопка(и), которые его открывают».
const SHEET_TRIGGER = {
  'settings-sheet': '#shelf-settings-btn, #lib-settings-btn, #reader-settings-btn',
  'info-sheet': '#info-btn',
  'review-sheet': '#review-btn, #ab-review-btn',
  'pronun-sheet': '#pronun-open-list',
};
function sheetShow(sheet, overlay) {
  overlay.hidden = false;
  sheet.hidden = false;
  sheet.style.transform = '';
  void sheet.offsetWidth;                 // reflow → анимация «въезда»
  overlay.classList.add('open');
  sheet.classList.add('open');
  const trig = SHEET_TRIGGER[sheet.id];
  if (trig) document.querySelectorAll(trig).forEach(b => b.classList.add('sheet-on'));
  // защита от «призрачного»/быстрого второго тапа: пока лист выезжает, скрим
  // не должен ловить закрывающий тап (иначе лист откроется и тут же скроется)
  overlay.style.pointerEvents = 'none';
  clearTimeout(overlay._armT);
  overlay._armT = setTimeout(() => { overlay.style.pointerEvents = ''; }, 340);
}
function sheetHide(sheet, overlay) {
  if (sheet.hidden) return;
  const trig = SHEET_TRIGGER[sheet.id];
  if (trig) document.querySelectorAll(trig).forEach(b => b.classList.remove('sheet-on'));
  // то же касание, что закрыло шторку, может «дострелить» кликом уже по тексту главы
  // и сбить озвучку — глушим тапы по тексту на время закрытия
  readerTapMuteUntil = performance.now() + 450;
  if (typeof closeLangMenus === 'function') closeLangMenus();
  sheet.style.transform = '';
  overlay.classList.remove('open');
  sheet.classList.remove('open');
  const done = () => {
    sheet.hidden = true; overlay.hidden = true;
    sheet.removeEventListener('transitionend', done);
  };
  sheet.addEventListener('transitionend', done);
  setTimeout(() => { if (!sheet.classList.contains('open')) done(); }, 440);
}
function bindSheetDrag(sheet, overlay) {
  let sy = 0, dy = 0, dragging = false;
  sheet.addEventListener('touchstart', e => {
    const onGrip = !!e.target.closest('.sheet-grip');
    // не перехватываем жест на интерактивных контролах (ползунки, кнопки, чипы, поля)
    const onControl = !!e.target.closest(
      'input, button, select, textarea, a, .lang-pick, .v3slider, .swatch, .chip, .seg');
    // тянуть шторку можно только за «ручку» или с пустого места у самого верха
    if (!onGrip && (sheet.scrollTop > 0 || onControl)) { dragging = false; return; }
    sy = e.touches[0].clientY; dy = 0; dragging = true;
    sheet.style.transition = 'none';
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (!dragging) return;
    dy = e.touches[0].clientY - sy;
    if (dy <= 0) { sheet.style.transform = ''; return; }
    sheet.style.transform = `translateX(-50%) translateY(${dy}px)`;
    e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    if (dy > 90) sheetHide(sheet, overlay);
    else sheet.style.transform = '';
  };
  sheet.addEventListener('touchend', end, { passive: true });
  sheet.addEventListener('touchcancel', end, { passive: true });

  // мышью тянем за «ручку» (десктоп)
  const grip = sheet.querySelector('.sheet-grip');
  if (grip) grip.addEventListener('mousedown', e => {
    e.preventDefault();
    const my = e.clientY; let mdy = 0;
    sheet.style.transition = 'none';
    grip.style.cursor = 'grabbing';
    const mm = ev => {
      mdy = Math.max(0, ev.clientY - my);
      sheet.style.transform = `translateX(-50%) translateY(${mdy}px)`;
    };
    const mu = () => {
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', mu);
      grip.style.cursor = '';
      sheet.style.transition = '';
      if (mdy > 90) sheetHide(sheet, overlay);
      else sheet.style.transform = '';
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  });
}
function bindAllSheets() {
  for (const id of ['settings', 'pronun', 'note', 'review', 'annot', 'tr', 'info'])
    bindSheetDrag($('#' + id + '-sheet'), $('#' + id + '-overlay'));
}

function openSettings() {
  syncSettingsUI();
  sheetShow($('#settings-sheet'), $('#settings-overlay'));
  // список языков переводчика подводим к текущему, когда шторка уже видна (есть размеры)
  requestAnimationFrame(() => requestAnimationFrame(() => scrollTrPickerToCurrent(false)));
}
function closeSettings() {
  sheetHide($('#settings-sheet'), $('#settings-overlay'));
}

// ── словарь произношений: экран управления ──
function renderPronun() {
  const box = $('#pronun-list');
  if (!box) return;
  const list = settings.pronun || [];
  box.innerHTML = list.length
    ? list.map((e, i) =>
        `<div class="pronun-item" data-pi="${i}"><span class="pronun-from">${esc(e.from)}</span>`
        + `<span class="pronun-arrow" aria-hidden="true">→</span>`
        + `<span class="pronun-to">${esc(e.to)}</span>`
        + `<button class="pronun-del" data-pdel title="${esc(t('pronunDel'))}" aria-label="${esc(t('pronunDel'))}">✕</button></div>`
      ).join('')
    : `<div class="pronun-empty">${esc(t('pronunEmpty'))}</div>`;
}
function addPronun() {
  const fromEl = $('#pronun-from'), toEl = $('#pronun-to');
  if (!fromEl || !toEl) return;
  const from = (fromEl.value || '').trim(), to = (toEl.value || '').trim();
  if (!from || !to) return;
  settings.pronun = settings.pronun || [];
  const ex = settings.pronun.find(e => e.from.toLowerCase() === from.toLowerCase());
  if (ex) ex.to = to; else settings.pronun.push({ from, to, lang: '' });   // слово уже есть → обновляем
  saveSettings(); pronunInvalidate(); renderPronun();
  showToast(t('pronunAdded'));   // список теперь в отдельном окне — даём обратную связь
  fromEl.value = ''; toEl.value = ''; fromEl.focus();
}
function delPronun(i) {
  if (!settings.pronun || !settings.pronun[i]) return;
  settings.pronun.splice(i, 1);
  saveSettings(); pronunInvalidate(); renderPronun();
}
// быстрое добавление из попапа слова: открываем настройки с уже вписанным словом
function openPronunFor(word) {
  closeWordPop();
  openSettings();
  const fromEl = $('#pronun-from'), toEl = $('#pronun-to');
  if (fromEl) fromEl.value = word || '';
  if (toEl) toEl.value = '';
  requestAnimationFrame(() => {
    fromEl?.closest('.pronun-block')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    (word ? toEl : fromEl)?.focus();
  });
}
// отдельное окно со списком слов (открывается иконкой-списком у строки ввода)
function openPronunList() { renderPronun(); sheetShow($('#pronun-sheet'), $('#pronun-overlay')); }
function closePronunList() { sheetHide($('#pronun-sheet'), $('#pronun-overlay')); }

function openInfo() {
  $('#info-version').textContent = T('build', { v: APP_VERSION });
  // натив (APK, versionName) и веб (докачанный бандл) могут расходиться — показываем оба,
  // если различаются, чтобы было видно реальное состояние, а не одну цифру
  (async () => {   // в нативной сборке показываем ОБЕ версии всегда: прил. (APK) · веб (бандл)
    try {
      const c = capUpdater && await capUpdater.current();
      const nat = c && c.native;
      if (nat) $('#info-version').textContent = T('buildBoth', { app: nat, web: APP_VERSION });
    } catch {}
  })();
  sheetShow($('#info-sheet'), $('#info-overlay'));
}
function closeInfo() { sheetHide($('#info-sheet'), $('#info-overlay')); }

// ══════════════════ самопроверка (?selftest=1 | ?selftest=fbook) ══════════
// fetch между шагами — «якорь»: удерживает виртуальные часы headless-браузера
const anchor = () => fetch('manifest.webmanifest').catch(() => {});

async function selftest() {
  const out = { ok: false, steps: [] };
  const step = s => { out.steps.push(s); document.documentElement.dataset.test = JSON.stringify(out); };
  // «сердцебиение»: в headless-режиме не даёт виртуальным часам перепрыгнуть
  // ожидание IndexedDB (иначе дамп снимается до завершения записи)
  const hb = setInterval(() => {}, 50);
  try {
    const files = urlParams.get('selftest') === 'fbook'
      ? ['mushoku.fbook'] : ['sample.epub', 'sample.fb2'];
    // Книги-образцы лежат ВНЕ www (в tools/test) и намеренно не входят в сборку:
    // всё, что попадает в www, Capacitor копирует в APK, а раздавать чужие книги нельзя.
    // Путь можно переопределить через ?fixtures= — стенды сами знают, где их держат.
    const fixtures = urlParams.get('fixtures') || '/tools/test/';
    let firstId = null;
    for (const name of files) {
      const r = await fetch(fixtures + name);
      if (!r.ok) { step(name + ': нет файла'); continue; }
      const buf = await r.arrayBuffer();
      const data = await (await importers()).importFile({ name, arrayBuffer: () => Promise.resolve(buf) });
      await anchor();
      const id = await storeBook(data);
      firstId = firstId || id;
      await anchor();
      const ch = await dbGet('chapters', [id, 0]);
      step(`${name}: глав=${data.chapters.length} изобр=${data.images.size}`
        + ` опис=${(data.annotation || '').length} гл1="${(ch && ch.title || '').slice(0, 40)}"`);
    }
    state.books = sortShelf(await dbAll('books'));
    out.books = state.books.length;
    if (firstId) {   // полный путь читалки: открыть главу, отметить прочитанной
      await anchor();
      await openChapter(firstId, Math.min(1, state.books.find(b => b.id === firstId).count - 1));
      out.ch = state.chapter && {
        title: state.chapter.title, i: state.chapter.index, n: state.chapter.total,
        crumb: state.chapter.crumb, img: document.querySelectorAll('#chapter-body img[src]').length,
      };
      await anchor();
      await markChapters([0], true);
      out.marked = isRead(0);
      // выделение + заметка программно (тот же путь, что и у пользователя)
      const body = $('#chapter-body');
      const r0 = rangeFromOffsets(body, 3, 23);
      if (r0) {
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r0);
        const rec = await addNote('g', false);
        if (rec) {
          rec.note = 'тестовая заметка';
          await dbPut('notes', rec);
        }
        await anchor();
        out.notes = (await dbByIndex('notes', 'byChapter',
          [firstId, state.chapter.idx])).length;
        await refreshNotesBadge().catch(() => {});
      }
      if (urlParams.get('tr')) {   // перевод: выделение + билингва главы
        try {
          settings.trLang = 'en';
          const one = await translateText('Проверка перевода прошла успешно.', 'en');
          out.tr = one.text.slice(0, 60);
          await toggleChapterTr();
          out.trBlocks = document.querySelectorAll('#chapter-body .tr-block').length;
        } catch (e) { out.tr = 'сбой: ' + e.message; }
      }
      if (urlParams.get('backup')) {   // круг: копия → удалить всё → восстановить
        await anchor();
        const blob = await buildBackup();
        step('backup-built ' + blob.size);
        const notesBefore = (await dbAll('notes')).length;
        for (const b of [...state.books]) await deleteBook(b.id);
        state.books = [];
        await anchor();
        step('backup-cleared');
        const r = await mergeImport({ text: () => blob.text() });
        step('backup-restored');
        state.books = sortShelf(await dbAll('books'));
        const ch0 = await dbGet('chapters', [firstId, 0]);
        out.backup = {
          size: blob.size, restored: r.added, books: state.books.length,
          notesKept: (await dbAll('notes')).length === notesBefore,
          ch0: !!(ch0 && ch0.html), read0: null,
        };
        const p0 = await dbGet('progress', [firstId, 0]);
        out.backup.read0 = !!(p0 && p0.percent >= 0.98);
      }
      step('chapter-ok');
    }
    // ?show=notes|sheet|review — открыть нужный экран для визуальной проверки
    const show = urlParams.get('show');
    if (show === 'notes' && firstId) {
      await showLibrary(firstId);
      $('#notes-list').hidden = false;
      $('#toc').hidden = true;
      $('#notes-btn').classList.add('active');
      await renderNotesList();
    } else if (show === 'annot' && firstId) {
      await showLibrary(firstId);
      openAnnotSheet();
      if (urlParams.get('q')) {
        $('#annot-title').value = urlParams.get('q');
        await findAnnotations();
      }
    } else if (show === 'sheet' && state.chNotes && state.chNotes[0]) {
      openNoteSheet(state.chNotes[0]);
    } else if (show === 'review' && state.book) {
      await kvSet('review:' + state.book.id, { stars: 4, text: '', at: 1 });
      reviewStars = 4;
      $('#review-text').value = '';
      $('#review-book').textContent = state.book.title;
      syncStarsUI();
      $('#review-overlay').hidden = false;
      $('#review-sheet').hidden = false;
    }
    out.ok = true;
    step('done');
  } catch (e) {
    step('ошибка: ' + e.message + ' @ ' + String(e.stack).split('\n')[1]);
  } finally {
    clearInterval(hb);
  }
}

boot();

// Окно вставки ссылки не должно двигаться при появлении клавиатуры (см. #confirm-modal).
// --fullvh — полная высота экрана: максимум innerHeight (клавиатура его только
// уменьшает, поэтому максимум = высота без клавиатуры). Модал берёт её как свою высоту
// и не ужимается вместе с вьюпортом, значит стоит на месте.
(function () {
  const root = document.documentElement;
  let fullVh = window.innerHeight;
  const sync = () => {
    if (window.innerHeight > fullVh) fullVh = window.innerHeight;
    root.style.setProperty('--fullvh', fullVh + 'px');
  };
  window.addEventListener('resize', sync);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', sync);
  sync();
})();
