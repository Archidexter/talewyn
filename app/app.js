'use strict';
/* AD.Talewyn — домашняя библиотека: полка книг + читалка + озвучка.
   Все данные живут на устройстве (IndexedDB), сервер не обязателен.   */

const APP_VERSION = '1.0.33';
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
    const rq = indexedDB.open('talewyn', 4);
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
    toShelf: 'К полке',
    searchPh: 'Поиск по книге…', reading: 'Читаю',
    pronunSec: 'Произношение', pronunSecFull: 'Словарь произношений',
    pronunHint: 'Как читать слово при озвучке. Напр.: GIF → джиф',
    pronunFromPh: 'Слово', pronunToPh: 'Как читать', pronunAdd: 'Добавить', pronunDel: 'Убрать',
    pronunListT: 'Список слов', pronunAdded: 'Добавлено в словарь',
    pronunEmpty: 'Пока пусто', wpPron: 'Произношение', wpSay: 'Озвучить',
    otaReady: 'Обновление {v} готово', otaApply: 'Обновить',
    updateT: 'Проверить обновления', otaNoUpd: 'Обновлять нечего',
    colTitle: 'Коллекции', colNew: 'Новая коллекция', colNamePh: 'Название коллекции',
    colCancel: 'Отменить', colSave: 'Сохранить', colDelete: 'Удалить коллекцию',
    colDelConfirm: 'Удалить коллекцию «{n}»?', colAddT: 'В коллекцию',
    colPickTitle: 'В какие коллекции добавить', colAdd2: 'Добавить',
    colNoneYet: 'Сначала создайте коллекцию', colAdded: 'Добавлено в коллекции',
    colRemoveYes: 'Убрать', colRemoveNo: 'Оставить', colRemoved: 'Убрано из коллекции',
    otaAvail: 'Доступно обновление {v}', otaAvailApp: 'Доступно обновление приложения {v}',
    otaDownloading: 'Загружаю обновление…', otaFail: 'Не удалось обновить',
    start: 'Начать чтение', cont: 'Продолжить чтение', nextCh: 'Следующая глава',
    footer: 'Прочитано {r} из {t} глав ({p}%)',
    build: 'AD.Talewyn · {v}',
    meta: '{i} из {t}',
    back: 'Назад', next: 'Дальше',
    theme: 'Тема', textSec: 'Текст', auto: 'Авто', light: 'Светлая', sepia: 'Сепия', dark: 'Тёмная',
    autoS: 'Авто', lightS: 'Свет', darkS: 'Тёмн',
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
    noteSave: 'Сохранить', noteDelete: 'Удалить',
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
    backupDone: 'Копия сохранена: {n} книг, {s} МБ',
    backupFail: 'Не получилось сохранить копию: {e}',
    restoreBusy: 'Восстанавливаю: «{n}»…',
    restoreDone: 'Восстановлено книг: {n}',
    restoreMixed: 'Восстановлено: {n}, уже на полке: {s}',
    restoreNone: 'Все книги из копии уже на полке',
    notBackup: 'это не копия библиотеки AD.Talewyn',
    settingsT: 'Настройки', infoT: 'О приложении', infoSocial: 'Контакты', infoLicense: 'Лицензия и авторство',
    licApp: 'AD.Talewyn — приложение для чтения книг.',
    licRights: '© 2026 Archidexter. Все права на приложение защищены.',
    licFiles: 'Книги и другие файлы, которые вы добавляете, принадлежат их правообладателям. Приложение хранит их только на вашем устройстве и никуда не передаёт.',
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
    toShelf: 'To the shelf',
    searchPh: 'Search this book…', reading: 'Reading',
    pronunSec: 'Pronunciation', pronunSecFull: 'Pronunciation dictionary',
    pronunHint: 'How a word is read aloud. E.g. GIF → jif',
    pronunFromPh: 'Word', pronunToPh: 'How to read it', pronunAdd: 'Add', pronunDel: 'Remove',
    pronunListT: 'Word list', pronunAdded: 'Added to dictionary',
    pronunEmpty: 'Empty', wpPron: 'Pronunciation', wpSay: 'Speak',
    otaReady: 'Update {v} ready', otaApply: 'Update',
    updateT: 'Check for updates', otaNoUpd: 'Nothing to update',
    colTitle: 'Collections', colNew: 'New collection', colNamePh: 'Collection name',
    colCancel: 'Cancel', colSave: 'Save', colDelete: 'Delete collection',
    colDelConfirm: 'Delete collection "{n}"?', colAddT: 'To collection',
    colPickTitle: 'Add to which collections', colAdd2: 'Add',
    colNoneYet: 'Create a collection first', colAdded: 'Added to collections',
    colRemoveYes: 'Remove', colRemoveNo: 'Keep', colRemoved: 'Removed from collection',
    otaAvail: 'Update {v} available', otaAvailApp: 'App update {v} available',
    otaDownloading: 'Downloading update…', otaFail: 'Update failed',
    start: 'Start reading', cont: 'Continue reading', nextCh: 'Next chapter',
    footer: '{r} of {t} chapters read ({p}%)',
    build: 'AD.Talewyn · {v}',
    meta: '{i} of {t}',
    back: 'Back', next: 'Next',
    theme: 'Theme', textSec: 'Text', auto: 'Auto', light: 'Light', sepia: 'Sepia', dark: 'Dark',
    autoS: 'Auto', lightS: 'Light', darkS: 'Dark',
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
    noteSave: 'Save', noteDelete: 'Delete',
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
    backupDone: 'Backup saved: {n} books, {s} MB',
    backupFail: 'Failed to save the backup: {e}',
    restoreBusy: 'Restoring: “{n}”…',
    restoreDone: 'Books restored: {n}',
    restoreMixed: 'Restored: {n}, already on the shelf: {s}',
    restoreNone: 'All books from the backup are already on the shelf',
    notBackup: 'this is not an AD.Talewyn library backup',
    settingsT: 'Settings', infoT: 'About', infoSocial: 'Contacts', infoLicense: 'License & credits',
    licApp: 'AD.Talewyn — a book-reading app.',
    licRights: '© 2026 Archidexter. All rights to the app reserved.',
    licFiles: 'Books and other files you add belong to their rights holders. The app stores them only on your device and never sends them anywhere.',
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
  document.documentElement.className = 't-' + theme;
  const st = document.documentElement.style;
  st.setProperty('--reader-fs', settings.size + 'px');
  st.setProperty('--reader-lh', settings.lh);
  st.setProperty('--measure', WIDTHS[settings.width] || WIDTHS.medium);
  st.setProperty('--reader-font', FONT_FAMILY[settings.font] || FONT_FAMILY.serif);
  st.setProperty('--reader-align', settings.align);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  $('meta[name=theme-color]').setAttribute('content', bg);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  updateWakeLock();
  if (applyLang.last !== settings.lang) {
    applyLang.last = settings.lang;
    applyLang();
  }
  syncSettingsUI();
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
  if (document.visibilityState === 'visible') updateWakeLock();
});
mqDark.addEventListener('change', () => { if (settings.theme === 'auto') applySettings(); });

// заливка пройденной части кастомного ползунка (CSS-переменная --fill)
function rangeFill(el) {
  if (!el) return;
  const min = +el.min, max = +el.max, v = +el.value;
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', pct.toFixed(1) + '%');
}
function syncSettingsUI() {
  for (const [segId, key] of [['seg-theme', 'theme'], ['seg-font', 'font'],
    ['seg-width', 'width'], ['seg-align', 'align'],
    ['seg-lang', 'lang']]) {
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
function postProgress(idx, position, percent) {
  state.progress.last = idx;
  const id = state.book.id;
  (async () => {
    await progressBump(id, idx, position, percent);
    await kvSet('last:' + id, idx);
    await kvSet('lastBook', id);
    for (const c of (state.collections || [])) if (colHas(c.id, 'book', id)) kvSet('colLast:' + c.id, id);   // своя «последняя» на коллекцию
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
addEventListener('pagehide', flushDirty);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDirty();
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
  renderContinue();
  renderToc();
  renderFooter();
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
  await dbDel('chapters', bookRange(id));
  await dbDel('images', bookRange(id));
  await dbDel('progress', bookRange(id));
  for (const n of await dbByIndex('notes', 'byBook', id))
    await dbDel('notes', n.id);
  await dbDel('kv', 'last:' + id);
  await dbDel('kv', 'review:' + id);
  await dbDel('books', id);
  await purgeFromCollections('book', id);   // убрать из всех коллекций
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
  if (confirmOpen()) { closeConfirm(false); return true; }
  if (!$('#lightbox').hidden) { closeLightbox(); return true; }
  for (const [ov, close] of [['settings-overlay', closeSettings], ['info-overlay', closeInfo], ['note-overlay', closeNoteSheet],
      ['tr-overlay', closeTrSheet], ['annot-overlay', closeAnnotSheet], ['review-overlay', closeReviewSheet]]) {
    if (!$('#' + ov).hidden) { close(); return true; }
  }
  if (!$('#sel-toolbar').hidden) { hideSelToolbar(); try { getSelection().removeAllRanges(); } catch {} return true; }
  if (typeof langPickers !== 'undefined' && langPickers.some(c => c._menu && c._menu.classList.contains('open'))) {
    closeLangMenus(); return true;
  }
  if (!$('#audio-view').hidden) { closeAudioView(); return true; }
  if (!$('#reader-view').hidden) { location.hash = state.book ? '#/b/' + state.book.id : '#/'; return true; }
  if (!$('#library-view').hidden) { location.hash = '#/'; return true; }
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
    state.books = (await dbAll('books')).sort((a, b) => a.addedAt - b.addedAt);
  } catch (e) {
    document.documentElement.dataset.err = 'idb: ' + e.message;
    state.books = [];
  }
  await loadCollections();
  route();
  hideBootSplash();
  if (urlParams.get('selftest')) selftest();
  otaInit();   // самообновление веб-слоя (только в нативной сборке)
}

// Заставка держит экран, пока приложение собирается: без неё было видно пустую полку,
// а потом в неё рывком влетало содержимое. Минимум 600мс — чтобы она не мигала на быстрых
// устройствах; убираем только после кадра, в котором полка уже отрисована.
const BOOT_SPLASH_MIN = 600;
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
const OTA_MANIFEST = 'https://archidexter.github.io/talewyn/app/version.json';
function cmpVer(a, b) {   // 1.0.23 vs 1.0.22 → 1/0/-1
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
let otaInfo = null;    // доступное обновление {kind:'web'|'native', version, bundleUrl?/apkUrl?} или null
let otaBusy = false;
async function otaInit() {
  if (!capUpdater || !isNativeApp()) return;             // OTA только в нативной сборке
  try { await capUpdater.notifyAppReady(); } catch {}    // текущий бандл рабочий — защита от отката
  setTimeout(otaCheck, 3000);                            // фоновая проверка, не мешаем старту
}
async function otaFetchManifest() {
  try {
    const res = await fetch(OTA_MANIFEST + '?t=' + Math.floor(Date.now() / 3600000), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
// из манифеста определяем доступное обновление (нативное важнее веба)
async function otaEval(m) {
  if (!m) return null;
  if (m.native && m.apkUrl) {                            // новый APK
    let nativeVer = APP_VERSION;
    try { const cur = await capUpdater.current(); if (cur && cur.native) nativeVer = cur.native; } catch {}
    if (cmpVer(m.native, nativeVer) > 0) return { kind: 'native', version: m.native, apkUrl: m.apkUrl };
  }
  if (m.web && m.bundleUrl && cmpVer(m.web, APP_VERSION) > 0) return { kind: 'web', version: m.web, bundleUrl: m.bundleUrl };
  return null;
}
// маркер на кнопке: есть обновление — стрелки крутятся (оборот-пауза); нет — стоят
function otaMarker() {
  const btn = document.getElementById('update-btn');
  if (btn) btn.classList.toggle('ota-avail', !!otaInfo);
}
// ФОНОВАЯ проверка при старте: только маркер, без тостов и без загрузки
async function otaCheck() {
  if (!capUpdater) return;
  otaInfo = await otaEval(await otaFetchManifest());
  otaMarker();
}
// РУЧНАЯ проверка по кнопке
async function otaManualCheck() {
  if (!capUpdater || !isNativeApp()) { showToast(t('otaNoUpd')); return; }
  if (otaBusy) return;
  otaBusy = true;
  const btn = document.getElementById('update-btn');
  const t0 = Date.now();
  if (btn) btn.classList.add('ota-checking');
  otaInfo = await otaEval(await otaFetchManifest());
  // докручиваем до конца полного оборота (минимум один), даже если проверка мгновенная
  const spin = 800, elapsed = Date.now() - t0;
  const wait = Math.max(1, Math.ceil(elapsed / spin)) * spin - elapsed;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  if (btn) btn.classList.remove('ota-checking');
  otaMarker();
  otaBusy = false;
  if (!otaInfo) { showToast(t('otaNoUpd')); return; }
  if (otaInfo.kind === 'web') showToast(T('otaAvail', { v: otaInfo.version }), t('otaApply'), otaDoWeb);
  else showToast(T('otaAvailApp', { v: otaInfo.version }));   // нативная установка одним тапом — Фаза 2
}
// скачать и применить веб-обновление (перезагружает WebView в новую версию)
async function otaDoWeb() {
  if (!capUpdater || !otaInfo || otaInfo.kind !== 'web') return;
  showToast(t('otaDownloading'));
  try {
    const b = await capUpdater.download({ version: String(otaInfo.version), url: otaInfo.bundleUrl });
    if (b && b.id) await capUpdater.set({ id: b.id });   // применяет и перезагружает
    else showToast(t('otaFail'));
  } catch { showToast(t('otaFail')); }
}

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
// кэш процента прогресса всех книг — нужен фильтру по статусу (до фильтрации) и бейджу
const bookPctCache = new Map();
async function refreshBookPcts() {
  await Promise.all(state.books.map(async b => { bookPctCache.set(b.id, await bookPercent(b)); }));
}
// статус чтения книги: new (не прочитано) / progress (в процессе) / read (прочитано)
function bookStatus(id) {
  const p = bookPctCache.get(id) || 0;
  return p >= 100 ? 'read' : p > 0 ? 'progress' : 'new';
}

// ── фильтры полки (статус · год · автор · жанр · поиск), фильтруют список в реальном времени ──
const shelfFilters = { q: '', author: '', genre: '', status: new Set() };
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
  const m = Importers.mapGenre && Importers.mapGenre((b.title || '') + ' ' + (b.annotation || ''));
  return (m && m !== 'Другое') ? m : (b.genre || m || '');
}
function filteredBooks() {
  const f = shelfFilters;
  return state.books.filter(b => {
    if (f.q) {
      const q = f.q.toLowerCase();
      if (!((b.title || '').toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q))) return false;
    }
    if (f.author && (b.author || '') !== f.author) return false;
    if (f.genre && bookGenre(b) !== f.genre) return false;
    if (f.status.size && !f.status.has(bookStatus(b.id))) return false;
    if (activeCol && !colHas(activeCol, 'book', b.id)) return false;   // просмотр коллекции
    return true;
  });
}

let seenBookIds = null;   // id книг, уже показанных на полке — чтобы анимировать только НОВЫЕ
async function renderShelf() {
  const grid = $('#shelf-grid');
  $('#backup-btn').hidden = !state.books.length;   // копировать нечего
  if (!state.books.length) {
    grid.innerHTML = `<div class="shelf-empty">
      <p class="se-title">${t('emptyShelf')}</p><p class="se-hint">${t('emptyHint')}</p></div>`;
    $('#shelf-continue').innerHTML = '';
    $('#shelf-filters').hidden = true;
    seenBookIds = new Set();
    renderShelfFooter();
    return;
  }
  await refreshBookPcts();   // проценты всех книг — для фильтра по статусу и бейджа
  const list = filteredBooks();
  if (!list.length) {
    grid.innerHTML = `<div class="shelf-empty"><p class="se-hint">${t('filterNone')}</p></div>`;
    seenBookIds = new Set(state.books.map(b => b.id));
    renderShelfContinue();
    renderShelfFooter();
    return;
  }
  const pcts = list.map(b => bookPctCache.get(b.id) || 0);
  const revs = await Promise.all(list.map(b => kvGet('review:' + b.id)));
  grid.innerHTML = list.map((b, i) => {
    const url = coverUrl(b);
    const pct = pcts[i];
    const stars = revs[i] && revs[i].stars ? STAR.repeat(revs[i].stars) : '';
    const face = url
      ? `<img class="cover-img" src="${url}" alt="" loading="lazy">`
      : `<span class="cover-blank" style="--h:${hueOf(b.title)}"><span>${esc(b.title)}</span></span>`;
    return `<div class="book-card" data-book="${b.id}">
      <button class="cover" data-open="${b.id}">${face}
        ${pct ? `<span class="cover-pct">${pct}%</span>` : ''}
        <span class="cover-track"><span class="cover-fill" style="width:${pct}%"></span></span>
        <span class="sel-check" aria-hidden="true"></span>
      </button>
      <div class="book-meta">
        <div class="book-title">${esc(b.title)}</div>
        ${stars ? `<div class="book-stars">${stars}</div>` : ''}
        ${b.author ? `<div class="book-author">${esc(b.author)}</div>` : ''}
      </div>
      <button class="book-del" data-del="${b.id}" title="${t('deleteT')}" aria-label="${t('deleteT')}">✕</button>
    </div>`;
  }).join('');
  // названия — одной бегущей строкой (проезжает, если не влезает)
  grid.querySelectorAll('.book-title').forEach(el => setMarquee(el, el.textContent));
  // плавное появление — только у книг, впервые попавших в библиотеку (не при фильтрации/первом рендере)
  if (seenBookIds) {
    grid.querySelectorAll('.book-card').forEach(c => {
      if (!seenBookIds.has(c.dataset.book)) c.classList.add('book-in');
    });
  }
  seenBookIds = new Set(state.books.map(b => b.id));
  renderShelfContinue();
  renderShelfFooter();
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
  if (!book) { box.innerHTML = ''; return; }
  const lastIdx = await kvGet('last:' + book.id);
  if (typeof lastIdx !== 'number' || !book.titles || !book.titles[lastIdx]) {
    box.innerHTML = '';
    return;
  }
  const prog = await dbGet('progress', [book.id, lastIdx]);
  const pct = prog ? Math.round(prog.percent * 100) : 0;
  const url = coverUrl(book);
  const face = url
    ? `<img class="cover-img" src="${url}" alt="">`
    : `<span class="cover-blank" style="--h:${hueOf(book.title)}"><span>${esc(book.title)}</span></span>`;
  box.innerHTML = `<button class="cont-card" data-cont="${book.id}" data-ch="${lastIdx}">
    <span class="cont-cover" aria-hidden="true">${face}</span>
    <span class="cont-body">
      <div class="cont-eyebrow">${t('cont')}</div>
      <div class="cont-title">${esc(book.titles[lastIdx])}</div>
      <div class="cont-sub">${esc(book.title)}${pct ? ` · ${pct}%` : ''}</div>
      ${pct ? `<div class="cont-track"><div class="cont-fill" style="width:${pct}%"></div></div>` : ''}
    </span>
  </button>`;
}

function renderShelfFooter() {
  // версия ушла в меню «О приложении»; в подвале — только счётчик книг
  $('#shelf-footer').innerHTML =
    state.books.length ? `<p>${T('booksN', { n: state.books.length })}</p>` : '';
}

// ══════════════════ мультивыбор на полке (долгое нажатие → удалить пачкой) ══════════════════
let selMode = false;
let selKind = 'books';            // какая вкладка выбирается: 'books' | 'audio'
const selIds = [];                // выбранные id по порядку (порядок = номер в кружке)
let lpFiredAt = 0;                // отметка долгого нажатия — чтобы съесть клик-отпускание

const cardIdOf = card => card.classList.contains('ab-card') ? card.dataset.abId : card.dataset.book;
const selCards = () => selKind === 'audio'
  ? document.querySelectorAll('#tab-audio .ab-card')
  : document.querySelectorAll('#shelf-grid .book-card');

function refreshSelChecks() {
  selCards().forEach(card => {
    const pos = selIds.indexOf(cardIdOf(card));
    card.classList.toggle('sel', pos >= 0);
    const badge = card.querySelector('.sel-check');
    // один выбранный — галочка; несколько — порядковые «цифорки»
    if (badge) badge.textContent = pos < 0 ? '' : (selIds.length > 1 ? String(pos + 1) : '✓');
  });
}
function enterSelMode(kind, firstId) {
  selMode = true; selKind = kind; selIds.length = 0;
  if (firstId) selIds.push(firstId);
  document.body.classList.add('sel-mode');   // показывает чекбоксы и красную кнопку-мусорку
  refreshSelChecks();
}
function exitSelMode() {
  if (!selMode) return;
  selMode = false; selIds.length = 0;
  document.body.classList.remove('sel-mode');
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
  const card = e.target.closest('.book-card, .ab-card');
  if (card) {
    const kind = card.classList.contains('ab-card') ? 'audio' : 'books';
    if (kind === selKind) toggleSel(cardIdOf(card));
  }
  return true;
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
}
function pluralRu(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
async function deleteSelected() {
  if (!selIds.length) return;
  const n = selIds.length, kind = selKind, ids = selIds.slice();
  // видимая анимация нажатия: кнопка «клюёт», крышка мусорки откидывается
  const fab = $('#fab-del');
  if (fab) { fab.classList.remove('pressing'); void fab.offsetWidth; fab.classList.add('pressing'); }
  await new Promise(r => setTimeout(r, 230));
  const noun = uiLang() === 'ru'
    ? (kind === 'audio' ? pluralRu(n, 'аудиокнигу', 'аудиокниги', 'аудиокниг') : pluralRu(n, 'книгу', 'книги', 'книг'))
    : (kind === 'audio' ? 'audiobook' : 'book') + (n === 1 ? '' : 's');
  const msg = uiLang() === 'ru'
    ? `Удалить ${n} ${noun} вместе с прогрессом?`
    : `Delete ${n} ${noun} along with progress?`;
  if (!(await uiConfirm(msg, { yes: t('dlgDelete'), danger: true }))) return;
  exitSelMode();
  if (kind === 'audio') {
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

// ══════════════════ коллекции («свои полки») ══════════════════
// Выдвижной раздел слева поверх интерфейса. Коллекция:
//   { id, name, order, createdAt, items:[{k:'book'|'audio', id}] }
// Членство хранится в самой коллекции. Просмотр: activeCol фильтрует полку.
if (!state.collections) state.collections = [];
let activeCol = null;          // id просматриваемой коллекции (null = все)
let colDrawerOpen = false;
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
  const list = $('#col-list'), dr = $('#col-drawer');
  if (!list || !dr) return;
  const cols = state.collections || [];
  dr.classList.toggle('col-empty', !cols.length);
  list.innerHTML = cols.map(c =>
    `<div class="col-item${activeCol === c.id ? ' active' : ''}" data-col="${c.id}">`
    + `<span class="col-grip" data-colgrip aria-hidden="true"><i></i><i></i><i></i></span>`
    + `<span class="col-item-name">${esc(c.name)}</span>`
    + `<span class="col-item-count">${(c.items || []).length}</span>`
    + `<button class="col-item-del" data-coldel="${c.id}" aria-label="${esc(t('colDelete'))}">✕</button>`
    + `</div>`).join('');
}

// ── создание коллекции: центральное окно ввода имени ──
function openColCreate() {
  const box = $('#col-create'); if (!box) return;
  box.hidden = false;
  requestAnimationFrame(() => box.classList.add('open'));
  const inp = $('#col-name'); if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 80); }
}
function closeColCreate() {
  const box = $('#col-create'); if (!box) return;
  box.classList.remove('open');
  setTimeout(() => { box.hidden = true; }, 240);
}
async function saveNewCol() {
  const name = (($('#col-name') || {}).value || '').trim();
  if (!name) { closeColCreate(); return; }
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
  activeCol = (activeCol === id) ? null : id;   // повторный тап — снять
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
  box.hidden = false;
  requestAnimationFrame(() => box.classList.add('open'));
}
function closeColPick() {
  const box = $('#col-pick'); if (!box) return;
  box.classList.remove('open');
  setTimeout(() => { box.hidden = true; }, 240);
}
async function applyColPick() {
  if (!colPickSel || !colPickSel.size || !selIds.length) { closeColPick(); return; }
  const kind = selKind === 'audio' ? 'audio' : 'book';
  const ids = selIds.slice();
  const changed = [];
  for (const colId of colPickSel) {
    const c = colById(colId); if (!c) continue;
    c.items = c.items || [];
    for (const id of ids) if (!c.items.some(it => it.k === kind && it.id === id)) c.items.push({ k: kind, id });
    changed.push(c);
  }
  closeColPick(); exitSelMode(); renderColDrawer(); refreshShelfForCol();
  showToast(T('colAdded', { n: ids.length }));
  for (const c of changed) { try { await saveCollection(c); } catch {} }   // персист после обновления UI
}

// ── убрать выбранные книги из ПРОСМАТРИВАЕМОЙ коллекции ──
async function removeFromActiveCol() {
  if (!activeCol || !selIds.length) return;
  const c = colById(activeCol); if (!c) return;
  const kind = selKind === 'audio' ? 'audio' : 'book';
  const ids = selIds.slice(), n = ids.length;
  const noun = uiLang() === 'ru'
    ? (kind === 'audio' ? pluralRu(n, 'аудиокнигу', 'аудиокниги', 'аудиокниг') : pluralRu(n, 'книгу', 'книги', 'книг'))
    : (kind === 'audio' ? 'audiobook' : 'book') + (n === 1 ? '' : 's');
  const msg = uiLang() === 'ru' ? `Убрать ${n} ${noun} из коллекции?` : `Remove ${n} ${noun} from the collection?`;
  if (!(await uiConfirm(msg, { yes: t('colRemoveYes'), no: t('colRemoveNo'), danger: true }))) return;
  c.items = (c.items || []).filter(it => !(it.k === kind && ids.includes(it.id)));
  exitSelMode(); renderColDrawer(); refreshShelfForCol();   // убранные книги исчезают из коллекции сразу
  showToast(T('colRemoved', { n }));
  try { await saveCollection(c); } catch {}
}

// ── жесты язычка/раздела + перетаскивание коллекций ──
function setupColDrawer() {
  const tab = $('#col-tab'), dr = $('#col-drawer'), sc = $('#col-scrim'), list = $('#col-list');
  if (!tab || !dr || !sc) return;
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
    const del = e.target.closest('[data-coldel]');
    if (del) { e.stopPropagation(); deleteCollection(del.dataset.coldel); return; }
    if (e.target.closest('#col-add')) { openColCreate(); return; }
    const item = e.target.closest('.col-item');
    if (item && !e.target.closest('[data-colgrip]')) viewCollection(item.dataset.col);
  });
  // перетаскивание коллекций за «ручку» (реордер)
  if (list) {
    // реордер: таскаемый следует за пальцем, а СОСЕДИ плавно сдвигаются на слот, открывая щель
    // в целевом месте. DOM переставляем один раз на отпускании — оттого не спотыкается.
    let drag = null;
    list.addEventListener('pointerdown', e => {
      const grip = e.target.closest('[data-colgrip]'); if (!grip) return;
      const item = grip.closest('.col-item'); if (!item) return;
      e.preventDefault();
      const items = [...list.querySelectorAll('.col-item')];
      const from = items.indexOf(item);
      const rects = items.map(el => el.getBoundingClientRect());
      const rowH = rects.length > 1 ? Math.abs(rects[1].top - rects[0].top) : (item.offsetHeight + 8);
      drag = { item, items, from, to: from, rects, rowH, h: item.offsetHeight, y0: e.clientY };
      item.classList.add('dragging');
      for (const el of items) el.style.transition = 'transform .16s ease';
      item.style.transition = 'none';
      try { list.setPointerCapture(e.pointerId); } catch {}
    });
    list.addEventListener('pointermove', e => {
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
      if (!drag) return;
      const { item, items, from, to } = drag;
      for (const el of items) { el.style.transition = ''; if (el !== item) el.style.transform = ''; }
      item.classList.remove('dragging'); item.style.transform = ''; item.style.transition = '';
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
      drag = null;
    };
    list.addEventListener('pointerup', dropEnd);
    list.addEventListener('pointercancel', dropEnd);
  }
}

// ── панель фильтров: строится по книгам, меняет список в реальном времени, плавно раскрывается ──
function toggleFilters() {
  const audio = shelfTab === 'audio';
  const panel = audio ? $('#audio-filters') : $('#shelf-filters'), btn = $('#filter-btn');
  // ориентируемся на класс .active кнопки — он отражает намерение сразу, без гонки с анимацией
  if (!btn.classList.contains('active')) {
    if (audio) buildAudioFiltersPanel(); else buildFiltersPanel();
    panel.hidden = false;
    btn.classList.add('active');
    // два кадра, чтобы стартовое состояние (grid-rows 0fr) применилось до анимации
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('open')));
  } else {
    closeFltMenu();
    btn.classList.remove('active');
    panel.classList.remove('open');
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      if (!panel.classList.contains('open')) panel.hidden = true;
      panel.removeEventListener('transitionend', te);
    };
    const te = ev => { if (ev.target === panel && ev.propertyName === 'opacity') finish(); };
    panel.addEventListener('transitionend', te);
    setTimeout(finish, 320);   // страховка, если transitionend не придёт
  }
}

// кастомный выпадающий список в стиле приложения (не нативный <select>)
let fltMenuEl = null;
function closeFltMenu() { if (fltMenuEl) fltMenuEl.classList.remove('open'); }
function filterSelect(mount, options, current, onChange) {
  mount.innerHTML = '<button class="lang-trigger flt-trigger" type="button" aria-haspopup="listbox">'
    + '<span class="lang-cur"></span>'
    + '<svg class="lang-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>';
  const trigger = mount.querySelector('.lang-trigger');
  const lbl = () => (options.find(o => o.v === current) || options[0]).label;
  trigger.querySelector('.lang-cur').textContent = lbl();
  if (fltMenuEl) { fltMenuEl.remove(); fltMenuEl = null; }
  const menu = fltMenuEl = document.createElement('div');
  menu.className = 'lang-menu';
  menu.innerHTML = options.map(o =>
    `<button class="lang-opt${o.v === current ? ' sel' : ''}" data-v="${esc(o.v)}">${esc(o.label)}</button>`).join('');
  document.body.appendChild(menu);
  const place = () => {
    const r = trigger.getBoundingClientRect(), w = r.width;
    menu.style.width = w + 'px'; menu.style.maxHeight = 'none';
    const full = menu.scrollHeight, cap = Math.min(300, innerHeight - 24), h = Math.min(full, cap);
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    menu.style.top = (r.top > h + 12 ? r.top - h - 6 : r.bottom + 6) + 'px';
    menu.style.maxHeight = h + 'px';
    menu.style.overflowY = full > cap + 1 ? 'auto' : 'hidden';
  };
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const open = menu.classList.contains('open');
    closeLangMenus(); closeFltMenu();
    if (!open) { place(); menu.classList.add('open'); }
  });
  menu.addEventListener('click', e => {
    const b = e.target.closest('.lang-opt'); if (!b) return;
    current = b.dataset.v;
    trigger.querySelector('.lang-cur').textContent = lbl();
    menu.querySelectorAll('.lang-opt').forEach(o => o.classList.toggle('sel', o.dataset.v === current));
    menu.classList.remove('open');
    onChange(current);
  });
}

function buildFiltersPanel() {
  const panel = $('#shelf-filters');
  const f = shelfFilters;
  const authors = [...new Set(state.books.map(b => b.author).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const present = new Set(state.books.map(bookGenre).filter(Boolean));
  const genres = (Importers.GENRES || []).filter(g => present.has(g));
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
    <button id="flt-reset" class="ghost-btn slim"${filtersActive() ? '' : ' hidden'}>${t('filterReset')}</button></div>`;

  const q = $('#flt-q');
  if (q) q.addEventListener('input', () => { f.q = q.value.trim(); applyFilters(); });
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
  if (q) q.addEventListener('input', () => { f.q = q.value.trim(); renderAudioShelf(); });
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
}

// Кружки добавления живут снаружи #shelf-view (их ломала бы анимация входа полки),
// поэтому показываем и прячем их вместе с ней вручную.
function syncAddFab() {
  const f = $('#add-fab');
  if (f) f.hidden = !!$('#shelf-view').hidden;
}
function showShelf() {
  navToken++;
  loadingChapter = false;
  ttsStop();
  flushDirty();
  clearNoteHl();
  state.book = null;
  state.chapter = null;
  $('#reader-view').hidden = true;
  $('#library-view').hidden = true;
  $('#audio-view').hidden = true;
  $('#readbar').hidden = true;
  $('#readbar').classList.remove('loading');
  $('#shelf-view').hidden = false;
  syncAddFab();
  updateTitle();
  renderShelf();
  enterView($('#shelf-view'));
  updateWakeLock();
  syncSettingsUI();
  requestAnimationFrame(() => scrollTo(0, state.shelfScroll));
}

// ══════════════════ импорт файлов ══════════════════
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

async function dlNative(url) {
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

async function dlWeb(url, onFrac) {
  const c = new AbortController();
  const to = setTimeout(() => c.abort(), 20000);   // таймаут только на заголовки, не на всю качку
  const res = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: c.signal });
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

let urlBusy = false;   // свой флаг: importBusy трогать нельзя — doImport выйдет на первой строке
async function importFromUrl() {
  if (urlBusy || importBusy) return;
  let url = await uiPrompt(t('urlT'), { ph: 'https://…/book.fb2', yes: t('urlGo') });
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let u; try { u = new URL(url); } catch { showToast(t('urlBad')); return; }
  if (!netOnline) { probeNet(); showToast(t('urlNoNet')); return; }
  urlBusy = true;
  try {
    const msg = T('urlDl', { h: u.hostname });
    showProgress(msg, null);
    const got = (isNative && capHttp) ? await dlNative(u.href)
                                      : await dlWeb(u.href, frac => showProgress(msg, frac));
    if (!got.blob.size) throw new Error(t('urlEmpty'));
    const name = fileNameFrom(got.url, got.headers);
    // страница логина/капчи вернёт 200 и HTML — иначе на полке появится «книга» из вёрстки сайта.
    // Аудио не нюхаем: в двоичном потоке может случайно попасться «<html», а текстом он не является.
    const isAudio = AUDIO_EXT.test(name) || (got.blob.type || '').startsWith('audio/');
    if (!isAudio) {
      const head = await got.blob.slice(0, 512).text();
      if (!/\.(x?html?)$/i.test(name) && /<!doctype\s+html|<html[\s>]/i.test(head))
        throw new Error(t('urlNotBook'));
    }
    const f = new File([got.blob], name, { type: got.blob.type || 'application/octet-stream' });
    urlBusy = false;
    await doImport([f]);   // дальше как у обычного файла: дедуп, квота, тосты, перерисовка полки
  } catch (e) {
    showToast(T('urlFail', { e: (e && e.message) || t('urlBlocked') }));
  } finally { urlBusy = false; }
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
  for (const file of bookFiles) {
    showProgress(T('importing', { n: file.name }), null);
    await new Promise(r => setTimeout(r, 60));   // даём тосту отрисоваться
    try {
      // копия библиотеки (.tlib) — отдельный путь; узнаём по началу файла
      const head = await file.slice(0, 200).text();
      if (/"fmt"\s*:\s*"talewyn-library"/.test(head)) {
        added += (await restoreLibrary(file)).added;
        continue;
      }
      const res = await Importers.importFile(file,
        frac => showProgress(T('importing', { n: file.name }), frac));
      // архив с аудио — все дорожки в одну аудиокнигу (обработаем ниже, вместе с аудио)
      if (res && res.kind === 'audio-archive') { archiveAudioSets.push(res); continue; }
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
    } catch (e) {
      // у QuotaExceededError пустое message — «Не получилось добавить книгу: » ни о чём
      // не говорит, а починить нехватку места человек как раз может
      if (isQuota(e)) { quotaToastAt = 0; quotaToast(); }
      else showToast(T('importFail', { n: file.name, e: e.message }));
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  // аудиокнига из набора аудиофайлов
  if (audioFiles.length) {
    showProgress(T('importing', { n: audioFiles[0].name }), null);
    await new Promise(r => setTimeout(r, 60));
    try {
      const rec = await importAudiobook(audioFiles, frac => showProgress(T('importing', { n: rec_name(audioFiles) }), frac));
      addedAudio++;
      showToast(T('imported', { n: rec.title }));
    } catch (e) {
      if (isQuota(e)) { quotaToastAt = 0; quotaToast(); }
      else showToast(T('importFail', { n: audioFiles[0].name, e: e.message }));
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  // аудиокниги из архивов: каждый архив — отдельная аудиокнига (все дорожки внутри = одна книга)
  for (const set of archiveAudioSets) {
    showProgress(T('importing', { n: set.name }), null);
    await new Promise(r => setTimeout(r, 60));
    try {
      const rec = await importAudiobook(set.files, frac => showProgress(T('importing', { n: set.name }), frac));
      addedAudio++;
      showToast(T('imported', { n: rec.title }));
    } catch (e) {
      if (isQuota(e)) { quotaToastAt = 0; quotaToast(); }
      else showToast(T('importFail', { n: set.name, e: e.message }));
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  importBusy = false;
  if (added) {
    state.books = (await dbAll('books')).sort((a, b) => a.addedAt - b.addedAt);
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

function b64ToBlob(im) {
  try {
    const bytes = Uint8Array.from(atob(im.d || ''), c => c.charCodeAt(0));
    return bytes.length ? new Blob([bytes], { type: im.m || 'image/jpeg' }) : null;
  } catch { return null; }
}

// куски JSON копятся строками и склеиваются только внутри Blob —
// так большая библиотека не собирается в одну гигантскую строку
async function buildBackup() {
  const books = (await dbAll('books')).sort((a, b) => a.addedAt - b.addedAt);
  const head = {
    fmt: 'talewyn-library', ver: 1, app: APP_VERSION, created: Date.now(),
    settings,
    ttsBase: localStorage.getItem('talewyn-tts-base') || null,
    lastBook: (await kvGet('lastBook')) || null,
    collections: await dbAll('collections'),   // свои полки
  };
  const parts = [JSON.stringify(head).slice(0, -1) + ',"books":['];
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    showToast(T('backupPrep', { n: b.title }));
    await new Promise(r => setTimeout(r, 0));
    const chapters = (await dbAll('chapters', bookRange(b.id)))
      .sort((x, y) => x.idx - y.idx)
      .map(c => ({ title: c.title, html: c.html, plain: c.plain }));
    const images = {};
    for (const im of await dbAll('images', bookRange(b.id)))
      images[im.name] = { m: im.blob.type || '', d: await blobToB64(im.blob) };
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
      chapters, images, progress,
      notes: await dbByIndex('notes', 'byBook', b.id),
    };
    parts.push((i ? ',' : '') + JSON.stringify(rec));
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json' });
}

let backupBusy = false;
async function exportLibrary() {
  if (backupBusy || !state.books.length) return;
  backupBusy = true;
  try {
    const blob = await buildBackup();
    const d = new Date();
    const name = 'talewyn-backup-' + d.getFullYear()
      + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0') + '.tlib';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    showToast(T('backupDone', {
      n: state.books.length, s: (blob.size / 1048576).toFixed(1),
    }));
  } catch (e) {
    showToast(T('backupFail', { e: e.message }));
  } finally {
    backupBusy = false;
  }
}

async function restoreBook(b) {
  const chapters = (b.chapters || []).map((c, idx) => ({
    book: b.id, idx, title: c.title || 'Глава ' + (idx + 1),
    html: c.html || '', plain: c.plain || '',
  }));
  if (!chapters.length) throw new Error('нет глав');
  await dbChunk('chapters', chapters);
  await dbChunk('images', Object.entries(b.images || {})
    .map(([name, im]) => ({ book: b.id, name, blob: b64ToBlob(im) }))
    .filter(r => r.blob));
  await dbChunk('progress', Object.entries(b.progress || {})
    .map(([idx, p]) => ({
      book: b.id, idx: +idx,
      position: Math.min(1, Math.max(0, +p.position || 0)),
      percent: Math.min(1, Math.max(0, +p.percent || 0)),
    }))
    .filter(p => Number.isInteger(p.idx) && p.idx >= 0 && p.idx < chapters.length));
  await dbChunk('notes', (b.notes || [])
    .filter(n => n && n.id)
    .map(n => ({ ...n, book: b.id })));
  if (typeof b.last === 'number') await kvSet('last:' + b.id, b.last);
  if (b.review) await kvSet('review:' + b.id, b.review);
  if (Array.isArray(b.expanded)) {
    localStorage.setItem('talewyn-expanded:' + b.id, JSON.stringify(b.expanded));
  }
  // запись книги — последней: наполовину восстановленная не попадёт на полку
  await dbPut('books', {
    id: b.id, title: b.title || 'Без названия', author: b.author || '',
    lang: b.lang || '', annotation: String(b.annotation || '').slice(0, 2000),
    year: Number.isFinite(+b.year) && +b.year > 1000 ? +b.year : null,
    genre: b.genre || '',
    addedAt: b.addedAt || Date.now(),
    cover: b.cover ? b64ToBlob(b.cover) : null,
    origCover: b.origCover ? b64ToBlob(b.origCover) : null,
    toc: Array.isArray(b.toc) && b.toc.length
      ? b.toc : chapters.map((c, i) => ({ t: c.title, ch: i })),
    count: chapters.length,
    titles: chapters.map(c => c.title),
  });
}

async function restoreLibrary(file) {
  let j = null;
  try { j = JSON.parse(await file.text()); } catch { /* не JSON */ }
  if (!j || j.fmt !== 'talewyn-library' || !Array.isArray(j.books))
    throw new Error(t('notBackup'));
  const wasEmpty = !state.books.length;
  const existing = new Set(state.books.map(b => b.id));
  let added = 0, skipped = 0;
  for (const b of j.books) {
    if (!b || !b.id || existing.has(b.id)) { skipped++; continue; }
    showToast(T('restoreBusy', { n: b.title || '…' }));
    await new Promise(r => setTimeout(r, 0));
    await restoreBook(b);
    existing.add(b.id);
    added++;
  }
  // настройки и адрес сервера голосов — только при восстановлении «с нуля»,
  // чтобы случайный импорт копии не сбил живые настройки
  if (wasEmpty && added) {
    if (j.settings && typeof j.settings === 'object' && !Array.isArray(j.settings)) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(j.settings));
      Object.assign(settings, loadSettings());
      applySettings();   // включая язык интерфейса и панель настроек
    }
    if (typeof j.ttsBase === 'string' && j.ttsBase) {
      localStorage.setItem('talewyn-tts-base', j.ttsBase);
    }
  }
  if (j.lastBook && existing.has(j.lastBook) && !(await kvGet('lastBook'))) {
    await kvSet('lastBook', j.lastBook);
  }
  // коллекции: добавляем те, которых ещё нет (по id); членство на отсутствующие книги безвредно
  if (Array.isArray(j.collections)) {
    const have = new Set((state.collections || []).map(c => c.id));
    for (const c of j.collections) {
      if (!c || !c.id || have.has(c.id)) continue;
      const rec = { id: c.id, name: c.name || '…', order: c.order || 0, createdAt: c.createdAt || Date.now(), items: Array.isArray(c.items) ? c.items : [] };
      try { await dbPut('collections', rec); state.collections.push(rec); have.add(c.id); } catch {}
    }
    state.collections.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  showToast(added && skipped ? T('restoreMixed', { n: added, s: skipped })
    : added ? T('restoreDone', { n: added }) : t('restoreNone'));
  return { added, skipped };
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
  btn.classList.toggle('active', here);
  btn.querySelector('svg').setAttribute('fill', here ? 'currentColor' : 'none');
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
  for (const img of document.querySelectorAll('#chapter-body img[data-i]')) {
    const rec = await dbGet('images', [bookId, img.dataset.i]);
    if (rec && rec.blob) {
      const u = URL.createObjectURL(rec.blob);
      chapImgUrls.push(u);
      img.src = u;
    } else {
      img.remove();
    }
  }
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
  // уже в читалке → это смена главы, а не вход: тогда НЕ переигрываем анимацию входа
  // всей вьюхи (иначе мигали бы все панели). Меняются только названия — через crossfade.
  const wasInReader = !$('#reader-view').hidden;
  $('#library-view').hidden = true;
  $('#shelf-view').hidden = true;
  syncAddFab();
  $('#audio-view').hidden = true;
  $('#reader-view').hidden = false;
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
    ttsStart();
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

function rangeFromOffsets(el, start, end) {
  const walker = textWalker(el);
  let acc = 0, sNode = null, sOff = 0, node;
  while ((node = walker.nextNode())) {
    const len = node.data.length;
    if (!sNode && acc + len > start) { sNode = node; sOff = start - acc; }
    if (acc + len >= end) {
      if (!sNode) return null;
      const r = new Range();
      r.setStart(sNode, sOff);
      r.setEnd(node, end - acc);
      return r;
    }
    acc += len;
  }
  return null;
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

function karaokeTick() {
  if (!tts.active || !tts.playing || !isNeural()) return;
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
  requestAnimationFrame(karaokeTick);
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

function ttsStart(fromEl = null, charOffset = 0, boundary = null) {
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
  if (pos < 0) pos = fromEl
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
    audioEl.play().then(() => requestAnimationFrame(karaokeTick))
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
  setTimeout(() => {
    if (bar.classList.contains('tucked') && !tts.active) { bar.hidden = true; bar.classList.remove('tucked'); }
  }, 340);
}
// панель выделения («закладок»): появляется через slide-toast, а уходит ПЛАВНО вниз (.leaving),
// а не пропадает резко. Плюс двигает открытое меню голоса под себя.
function showSelToolbar() {
  const el = $('#sel-toolbar');
  if (!el) return;
  el.classList.remove('leaving');
  el.hidden = false;
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
  requestAnimationFrame(karaokeTick);
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
function readTags(file) {
  return new Promise(res => {
    if (!window.jsmediatags) return res(null);
    try { window.jsmediatags.read(file, { onSuccess: t => res(t && t.tags), onError: () => res(null) }); }
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
  let p = names[0].replace(/\.[^.]+$/, '');
  for (const n of names) { const s = n.replace(/\.[^.]+$/, ''); while (p && !s.startsWith(p)) p = p.slice(0, -1); }
  return p.replace(/[\s._\-–—]*\d*[\s._\-–—]*$/, '').trim();   // убираем хвостовой номер трека
}
const abClean = n => n.replace(/\.[^.]+$/, '').replace(/^\s*\d+[\s._\-.)]*/, '').replace(/[_]+/g, ' ').trim();

// набор аудиофайлов → одна аудиокнига (треки в естественном порядке)
async function importAudiobook(files, onProgress) {
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
      if (onProgress) onProgress(i / list.length);
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
  state.audiobooks = (await dbAll('audiobooks')).sort((a, b) => a.addedAt - b.addedAt);
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
  if (!state.audiobooks.length) {
    box.innerHTML = `<div class="tab-empty">${head}<p class="tab-empty-title">${esc(t('abEmptyT'))}</p><p class="tab-empty-sub">${esc(t('abEmptySub'))}</p></div>${addBtn}`;
  } else {
    const progs = {};
    for (const r of state.audiobooks) progs[r.id] = await kvGet('aprog:' + r.id);
    const af = audioFilters;
    // фильтр по поиску и статусу прослушивания
    const shown = state.audiobooks.filter(r => {
      if (af.q) { const q = af.q.toLowerCase(); if (!((r.title || '').toLowerCase().includes(q) || (r.author || '').toLowerCase().includes(q))) return false; }
      if (af.status.size && !af.status.has(abStatusOf(r, progs[r.id]))) return false;
      if (activeCol && !colHas(activeCol, 'audio', r.id)) return false;   // просмотр коллекции
      return true;
    });
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
    const abRevs = {};
    await Promise.all(shown.map(async r => { abRevs[r.id] = await kvGet('review:' + r.id); }));
    const cards = shown.map(r => {
      const url = abCoverUrl(r), p = progs[r.id];
      const pct = (p && r.totalDur) ? Math.min(100, Math.round((abPlayedSeconds(r, p) / r.totalDur) * 100)) : 0;
      const rv = abRevs[r.id];
      const stars = rv && rv.stars ? STAR.repeat(rv.stars) : '';
      // структура как у книги: обложка — кнопка (даёт нажатие-отклик), крестик — соседний элемент
      return `<div class="ab-card" data-ab-id="${esc(r.id)}">
        <button class="ab-card-cover" data-ab="${esc(r.id)}">${url ? `<img src="${url}" alt="">` : '<span>♪</span>'}
          ${pct ? `<span class="cover-pct">${pct}%</span>` : ''}
          <span class="sel-check" aria-hidden="true"></span></button>
        <div class="ab-card-title">${esc(r.title)}</div>
        ${stars ? `<div class="book-stars">${stars}</div>` : ''}
        <div class="ab-card-author">${esc(r.author || '')}</div>
        <div class="ab-card-bar"><i style="width:${pct}%"></i></div>
        <button class="ab-del" data-abdel="${esc(r.id)}" title="${t('deleteT')}" aria-label="${t('deleteT')}">✕</button></div>`;
    }).join('');
    const gridHtml = shown.length ? `<div class="ab-grid">${cards}</div>` : `<div class="shelf-empty"><p class="se-hint">${esc(t('filterNone'))}</p></div>`;
    // «Продолжить слушать» живёт в отдельном блоке НАД фильтрами — как у книг
    const contBox = $('#audio-continue');
    if (contBox) { contBox.innerHTML = contHtml; setupContMarquee(contBox); }
    box.innerHTML = `${gridHtml}${addBtn}`;
    box.querySelectorAll('.ab-card-title').forEach(el => setMarquee(el, el.textContent));   // одна бегущая строка
  }
}

// ── плеер аудиокниги ──
function abViewShow() {
  navToken++;
  $('#shelf-view').hidden = true; $('#library-view').hidden = true; $('#reader-view').hidden = true;
  syncAddFab();
  $('#readbar').hidden = true;
  $('#audio-view').hidden = false;
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
  if (!row || !row.blob) return;
  if (ab._url) { try { URL.revokeObjectURL(ab._url); } catch {} }
  ab._url = URL.createObjectURL(row.blob);
  audioBookEl.src = ab._url;
  audioBookEl.playbackRate = abRate;
  setMarquee($('#ab-track-title'), ab.rec.tracks[idx].title);   // длинное название поедет строкой
  highlightAbTrack(idx);
  pushMedia();                     // сменился трек — обновляем название в системном плеере
  let started = false;
  const start = () => {
    if (started) return; started = true;
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
  const fmtDate = ts => new Date(ts).toLocaleDateString(
    uiLang() === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short' });
  const addBtn = `<button class="chip" id="notes-add-btn"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg> ${t('noteT')}</button>`;
  if (!bookNotesCache.length) {
    box.innerHTML = `<div class="notes-head">${addBtn}</div><p class="sr-empty">${t('noNotes')}</p>`;
    return;
  }
  const titles = state.book.titles || [];
  let lastIdx = -1;
  const copyBtn = `<button class="chip notes-copy-btn" id="notes-copy" title="${t('copyAll')}" aria-label="${t('copyAll')}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg></button>`;
  const delAllLabel = uiLang() === 'ru' ? 'Удалить все заметки' : 'Delete all notes';
  const delAllBtn = `<button class="chip notes-del-all-btn" id="notes-del-all" title="${delAllLabel}" aria-label="${delAllLabel}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
  const parts = [`<div class="notes-head has-actions">${addBtn}<div class="notes-head-actions">${copyBtn}${delAllBtn}</div></div>`];
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
  box.innerHTML = parts.join('');
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
  '#url-btn': 'twist', '#import-btn': 'pop',
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
  if (/писател|поэт|переводчик|author|novelist|\bwriter\b|born|род(ился|\.)/.test(desc)) return false;  // это человек
  const bookish = /(роман|новелл|ранобэ|ранобе|повест|книг|манга|манхв|манхва|рассказ|сказани|поэма|novel|book|manga|webtoon|series|серия|цикл|фильм|аниме|игра|манга)/;
  const tw = title.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const matched = tw.filter(w => pageTitle.includes(w)).length;
  const titleOk = tw.length && matched >= Math.ceil(tw.length * 0.6);   // заголовок реально про эту книгу
  if (!titleOk) return false;
  // многословное название совпало — этого достаточно; односложное — требуем «книжности»,
  // чтобы не подсунуть статью-понятие (например, «Дюна» как гряда песка)
  return tw.length > 1 || bookish.test(desc + ' ' + extract.slice(0, 220));
}

async function findWikipedia(title) {
  const langs = uiLang() === 'ru' ? ['ru', 'en'] : ['en', 'ru'];
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

async function findFantlab(title) {
  const j = await fetchJson('https://api.fantlab.ru/search-works?page=1&q='
    + encodeURIComponent(title));
  const out = [];
  for (const m of (j.matches || []).slice(0, 3)) {
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
  // операторы intitle/inauthor нацеливают поиск на саму книгу, а не на всё подряд
  const q = 'intitle:' + JSON.stringify(title) + (author ? ' inauthor:' + JSON.stringify(author) : '');
  const j = await fetchJson('https://www.googleapis.com/books/v1/volumes?maxResults=5&q='
    + encodeURIComponent(q));
  return (j.items || []).map(it => {
    const v = it.volumeInfo || {};
    const text = stripMarkup(v.description || '');
    return text.length > 60 ? {
      src: 'Google Книги',
      title: (v.title || '') + (v.authors ? ' — ' + v.authors.join(', ') : ''),
      text,
    } : null;
  }).filter(Boolean);
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

async function findAnnotations() {
  // название и автор — раздельно: так источники ищут ИМЕННО книгу, а не автора/слово
  const title = $('#annot-title').value.trim();
  const author = $('#annot-author').value.trim();
  if (title.length < 2) return;
  const box = $('#annot-results');
  box.hidden = false;
  box.innerHTML = `<p class="sr-empty">${t('annotSearching')}</p>`;
  const seq = ++findSeq;
  // книжные базы (ФантЛаб — ранобэ/новеллы, Google Книги, OpenLibrary) — первыми;
  // Википедия последней и со строгой проверкой, чтобы не подсовывать статью об авторе/слове
  const settled = await Promise.allSettled([
    findFantlab(title, author), findGoogleBooks(title, author),
    findOpenLibrary(title, author), findWikipedia(title, author),
  ]);
  if (seq !== findSeq || $('#annot-sheet').hidden) return;
  const found = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []));
  const seen = new Set();   // дедуп почти одинаковых текстов
  findResults = found.filter(f => {
    const k = f.text.slice(0, 80).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);
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
  for (const c of langPickers) c._close();
  if (typeof voicePicker !== 'undefined' && voicePicker) voicePicker.close();
}
function buildLangPicker(container) {
  if (!container) return;
  container.innerHTML =
    '<button class="lang-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">'
    + '<span class="lang-cur"></span>'
    + '<svg class="lang-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>';
  const trigger = container.querySelector('.lang-trigger');
  const menu = document.createElement('div');
  menu.className = 'lang-menu';
  menu.setAttribute('role', 'listbox');
  menu.innerHTML =
    `<button class="lang-opt" type="button" role="option" data-v="auto" data-i18n="trAuto">${t('trAuto')}</button>`
    + TR_LANGS.map(([v, n]) =>
      `<button class="lang-opt" type="button" role="option" data-v="${v}">${n}</button>`).join('');
  document.body.appendChild(menu);   // портал: вне трансформируемой шторки
  const place = () => {
    const r = trigger.getBoundingClientRect();
    const w = Math.max(r.width, 170);
    menu.style.width = w + 'px';
    menu.style.maxHeight = 'none';                 // измеряем истинную высоту при нужной ширине
    const full = menu.scrollHeight;
    const cap = Math.min(280, innerHeight - 24);
    const h = Math.min(full, cap);
    // прижимаем правым краем к триггеру, держим в пределах экрана
    const left = Math.min(Math.max(8, r.right - w), innerWidth - w - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = (r.top > h + 12 ? r.top - h - 8 : r.bottom + 8) + 'px';
    menu.style.maxHeight = h + 'px';
    menu.style.overflowY = full > cap + 1 ? 'auto' : 'hidden';   // скролл только когда реально не влезает
  };
  const close = () => { menu.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); };
  let toggledAt = 0;
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    if (isOpen && performance.now() - toggledAt < 320) return;   // гасим «дребезг» быстрого тапа
    closeLangMenus();
    if (!isOpen) { place(); menu.classList.add('open'); trigger.setAttribute('aria-expanded', 'true'); }
    toggledAt = performance.now();
  });
  menu.addEventListener('click', e => {
    const b = e.target.closest('.lang-opt');
    if (!b) return;
    setTrLang(b.dataset.v);
    close();
  });
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
async function refreshReviewBadge() {
  if (state.book) {
    const rv = await loadReview(state.book.id);
    const el = $('#review-stars'); if (el) el.textContent = rv.stars ? STAR.repeat(rv.stars) : '';
  }
}
async function refreshAudioReviewBadge() {
  if (!ab || !ab.rec) return;
  const rv = await loadReview(ab.rec.id);
  const el = $('#ab-review-stars'); if (el) el.textContent = rv.stars ? STAR.repeat(rv.stars) : '';
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
  $('#url-btn').addEventListener('click', importFromUrl);
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
    const cont = e.target.closest('[data-abcont]');
    if (cont) { location.hash = '#/a/' + cont.dataset.abcont; return; }
    const card = e.target.closest('[data-ab]');
    if (card) location.hash = '#/a/' + card.dataset.ab;
  });

  // долгое нажатие по карточке полки → режим мультивыбора (touch); правый клик — на десктопе
  {
    let lpTimer = null, lpStart = null;
    const shelfShown = () => !$('#shelf-view').hidden;
    const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    addEventListener('touchstart', e => {
      if (!shelfShown() || selMode || e.touches.length !== 1) return;
      const card = e.target.closest('.book-card, .ab-card');
      if (!card) return;
      lpStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      lpTimer = setTimeout(() => {
        lpTimer = null; lpFiredAt = performance.now();
        const kind = card.classList.contains('ab-card') ? 'audio' : 'books';
        enterSelMode(kind, cardIdOf(card));
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
      }, 500);
    }, { passive: true });
    addEventListener('touchmove', e => {
      if (!lpTimer) return;
      const p = e.touches[0];
      if (Math.hypot(p.clientX - lpStart.x, p.clientY - lpStart.y) > 10) cancelLp();
    }, { passive: true });
    addEventListener('touchend', cancelLp, { passive: true });
    addEventListener('touchcancel', cancelLp, { passive: true });
    addEventListener('contextmenu', e => {
      if (!shelfShown() || selMode) return;
      const card = e.target.closest('.book-card, .ab-card');
      if (!card) return;
      e.preventDefault();
      lpFiredAt = performance.now();
      const kind = card.classList.contains('ab-card') ? 'audio' : 'books';
      enterSelMode(kind, cardIdOf(card));
    });
  }
  $('#fab-del')?.addEventListener('click', deleteSelected);   // красная кнопка-мусорка в стопке FAB
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
      if (e.touches.length !== 1 || !onShelf()) return;
      // Свайп начинается откуда угодно, в том числе с карточки книги/аудиокниги: тапу это не
      // мешает — вкладка листается только при сдвиге от 36px, а на таком сдвиге браузер уже
      // отменил клик по кнопке. Исключаем лишь то, где горизонталь значит своё: поля ввода
      // (курсор/выделение), ползунки и сама панель вкладок.
      if (e.target.closest('input, textarea, select, .shelf-tabs, #col-tab, .col-grip')) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; active = true;
    }, { passive: true });
    addEventListener('touchmove', e => {
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
    $('#reader-view').hidden || !$('#settings-sheet').hidden || !$('#lightbox').hidden
    || !$('#note-sheet').hidden || !$('#tr-sheet').hidden || !$('#sel-toolbar').hidden;
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
    if (sw.axis !== 'x') return;
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
    if (!sw || sw.axis !== 'x') { sw = null; return; }
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
      if (e.touches.length !== 2) return;
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
    reviewStars = reviewStars === i ? i - 1 : i;   // повторный тап снимает звезду
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
function sheetShow(sheet, overlay) {
  overlay.hidden = false;
  sheet.hidden = false;
  sheet.style.transform = '';
  void sheet.offsetWidth;                 // reflow → анимация «въезда»
  overlay.classList.add('open');
  sheet.classList.add('open');
  // защита от «призрачного»/быстрого второго тапа: пока лист выезжает, скрим
  // не должен ловить закрывающий тап (иначе лист откроется и тут же скроется)
  overlay.style.pointerEvents = 'none';
  clearTimeout(overlay._armT);
  overlay._armT = setTimeout(() => { overlay.style.pointerEvents = ''; }, 340);
}
function sheetHide(sheet, overlay) {
  if (sheet.hidden) return;
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
      const data = await Importers.importFile({ name, arrayBuffer: () => Promise.resolve(buf) });
      await anchor();
      const id = await storeBook(data);
      firstId = firstId || id;
      await anchor();
      const ch = await dbGet('chapters', [id, 0]);
      step(`${name}: глав=${data.chapters.length} изобр=${data.images.size}`
        + ` опис=${(data.annotation || '').length} гл1="${(ch && ch.title || '').slice(0, 40)}"`);
    }
    state.books = (await dbAll('books')).sort((a, b) => a.addedAt - b.addedAt);
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
        const r = await restoreLibrary({ text: () => blob.text() });
        step('backup-restored');
        state.books = (await dbAll('books')).sort((a, b) => a.addedAt - b.addedAt);
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
