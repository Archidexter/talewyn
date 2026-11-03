// src/constants.ts
var BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
var TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
var WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
var VOICE_LIST_URL = `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
var DEFAULT_VOICE = "en-US-EmmaMultilingualNeural";
var CHROMIUM_FULL_VERSION = "143.0.3650.75";
var CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
// Microsoft сменил проверку: префикс версии «2-» и новый формат токена (см. secMsGecV2 ниже).
// Со старым «1-» и обычным SHA-256 сервер отвечает 403 на рукопожатии — все нейроголоса молчат.
var SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
var BASE_HEADERS = {
  "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9"
};
var VOICE_HEADERS = {
  ...BASE_HEADERS,
  "Authority": "speech.platform.bing.com",
  "Sec-CH-UA": `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR_VERSION}", "Chromium";v="${CHROMIUM_MAJOR_VERSION}"`,
  "Sec-CH-UA-Mobile": "?0",
  "Accept": "*/*",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty"
};

// src/exceptions.ts
var EdgeTTSException = class extends Error {
  constructor(message) {
    super(message);
    this.name = "EdgeTTSException";
  }
};
var SkewAdjustmentError = class extends EdgeTTSException {
  constructor(message) {
    super(message);
    this.name = "SkewAdjustmentError";
  }
};
var UnknownResponse = class extends EdgeTTSException {
  constructor(message) {
    super(message);
    this.name = "UnknownResponse";
  }
};
var UnexpectedResponse = class extends EdgeTTSException {
  constructor(message) {
    super(message);
    this.name = "UnexpectedResponse";
  }
};
var NoAudioReceived = class extends EdgeTTSException {
  constructor(message) {
    super(message);
    this.name = "NoAudioReceived";
  }
};
var WebSocketError = class extends EdgeTTSException {
  constructor(message) {
    super(message);
    this.name = "WebSocketError";
  }
};
var ValueError = class extends EdgeTTSException {
  constructor(message) {
    super(message);
    this.name = "ValueError";
  }
};

// src/gec-v2.ts
// Токен Sec-MS-GEC v2 — порт drm.py из edge-tts (rany2/edge-tts). Формат «<16 hex>-<64 hex>»:
// модифицированный SHA-256 (свои начальное состояние и константы) + 64-битная сумма CS64.
// Только 32-битная целочисленная арифметика, без SubtleCrypto — работает и вне https.
// Если Microsoft сменит алгоритм снова, сервер опять начнёт отвечать 403 — сверяться с
// https://github.com/rany2/edge-tts/blob/master/src/edge_tts/drm.py
var G_SHA_INIT = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
var G_SHA_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
var G_SHA_SCHED = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
var G_K = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
];
var G_SHA_ADJ = 0xC9DC06A7;
var G_K_BLOCK = G_K.slice();
G_K_BLOCK[14] = G_SHA_ADJ;
var G_SIG0_ADJ = 0x059C0B80;
var G_SIG1_ADJ = 0x000B92C0;
var G_CS = [[0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF], [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB], [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61], [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167]];
var G_CS_FACTOR = 0x82893933;
var G_CS_ADJ0 = 0xF2F90B1A;
var G_CS_ADJ1 = 0x0B1A0000;
var gU = (x) => x >>> 0;
var gMul = (a, b) => Math.imul(a, b) >>> 0;
var gRotr = (x, n) => (x >>> n | x << 32 - n) >>> 0;
var gRol16 = (x) => (x << 16 | x >>> 16) >>> 0;
var gSig0 = (x) => (gRotr(x, 7) ^ gRotr(x, 18) ^ x >>> 3) >>> 0;
var gSig1 = (x) => (gRotr(x, 17) ^ gRotr(x, 19) ^ x >>> 10) >>> 0;
function gRounds(state, w, first) {
  let [a, b, c, d, e, f, g, h] = state;
  const k = first === 14 ? G_K_BLOCK : G_K;
  for (let i = first; i < 64; i++) {
    const t1 = gU(h + (gRotr(e, 6) ^ gRotr(e, 11) ^ gRotr(e, 25)) + (g ^ e & (f ^ g)) + k[i] + w[i]);
    const t2 = gU((gRotr(a, 2) ^ gRotr(a, 13) ^ gRotr(a, 22)) + (a & b | c & (a | b)));
    h = g;
    g = f;
    f = e;
    e = gU(d + t1);
    d = c;
    c = b;
    b = a;
    a = gU(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}
function gExpand(w, from = 16) {
  for (let i = from; i < 64; i++) w[i] = gU(gSig1(w[i - 2]) + w[i - 7] + gSig0(w[i - 15]) + w[i - 16]);
}
var gInitKey = null;
var gInitVal = null;
function gShaInit(d7) {
  const key = d7.join(",");
  if (gInitKey === key) return gInitVal;
  const w = new Array(14).fill(0);
  w.push((d7[0] << 16 | d7[1] << 8 | d7[2]) >>> 0);
  w.push(gU(d7[3] * 16777216 + (d7[4] << 16) + (d7[5] << 8) + d7[6]));
  for (let i = 16; i < 30; i++) {
    let v = G_SHA_SCHED[i - 16];
    if (i - 2 >= 14) v += i === 16 ? (gSig1(w[i - 2]) ^ G_SIG1_ADJ) >>> 0 : gSig1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? (gSig0(w[i - 15]) ^ G_SIG0_ADJ) >>> 0 : gSig0(w[i - 15]);
    w.push(gU(v));
  }
  w.push(gU(gSig1(w[28]) + w[23] + gSig0(w[15]) + w[14] + G_SHA_ADJ - G_K[14]));
  gExpand(w, 31);
  const working = gRounds(G_SHA_STATE, w, 14);
  gInitVal = G_SHA_INIT.map((x, i) => gU(x + working[i]));
  gInitKey = key;
  return gInitVal;
}
function gShaDigest(data) {
  const length = 57 + data.length;
  const tail = data.length - 7;
  const zeros = ((55 - length) % 64 + 64) % 64;
  const padded = new Uint8Array(tail + 1 + zeros + 8);
  padded.set(data.subarray(7), 0);
  padded[tail] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(length * 8 / 4294967296));
  dv.setUint32(padded.length - 4, length * 8 >>> 0);
  let state = gShaInit(Array.from(data.subarray(0, 7)));
  for (let off = 0; off < padded.length; off += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) w.push(dv.getUint32(off + i * 4));
    gExpand(w);
    const working = gRounds(state, w, 0);
    state = state.map((x, i) => gU(x + working[i]));
  }
  return state;
}
function gCs64(data, shaWords) {
  const bswap = (x) => ((x & 255) << 24 | (x & 65280) << 8 | x >>> 8 & 65280 | x >>> 24) >>> 0;
  const keyA = (bswap(shaWords[0]) | 1) >>> 0;
  const keyB = (bswap(shaWords[1]) | 1) >>> 0;
  const factors = [gMul(keyA, G_CS_FACTOR), gMul(keyB, G_CS_FACTOR)];
  const terms = G_CS.map(([cf], i) => gMul(cf, factors[i % 2]));
  const offsets = G_CS.map(([, of]) => of);
  const buf = new Uint8Array(1 + data.length + (4 - (1 + data.length) % 4) % 4);
  buf.set(data, 1);
  const dv = new DataView(buf.buffer);
  const words = [];
  for (let i = 0; i < buf.length; i += 4) words.push(dv.getUint32(i, true));
  if (words.length % 2) words.push(0);
  words.forEach((word, i) => {
    let term = gMul(word, i % 2 === 0 ? keyA : keyB);
    let offset = gMul(gRol16(word), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (i === 0) {
      term = gU(term + gMul(G_CS_ADJ0, factors[0]));
      offset = gU(offset + G_CS_ADJ1);
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = gRol16(gU(offsets[i] + x));
    let q = gMul(t, 0x76F50F34);
    swapAcc = gU(swapAcc + gU(gMul(gRol16(q), 0xC3EFEA97) + q));
    t = gRol16(gU(offsets[i + 1] + y));
    q = gMul(t, 0x1881CE3C);
    swapLast = gU(gMul(gRol16(q), 0x35BD1EC9) + q);
    swapAcc = gU(swapAcc + swapLast);
    state = gU(gMul(state, keyA) + x);
    state = gMul(gRol16(state), 0xCF98B111);
    state = gMul(gRol16(state), 0x87085B9F);
    state = gMul(gRol16(state), 0x12CEB96D);
    state = gMul(gRol16(state), 0x257E1D83);
    acc = gU(acc + state);
    t = gU(gMul(state, keyB) + y);
    t = gMul(gRol16(t), 0xA27416F5);
    t = gMul(gRol16(t), 0xD38396FF);
    state = gMul(gRol16(gMul(gRol16(t), 0x7C932B89)), 0xBFA49F69);
    acc = gU(acc + state);
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}
var gHexLE = (x) => [x & 255, x >>> 8 & 255, x >>> 16 & 255, x >>> 24 & 255].map((b) => b.toString(16).padStart(2, "0")).join("");
var gHexBE = (x) => x.toString(16).padStart(8, "0");
function secMsGecV2(unixSeconds) {
  let ticks = unixSeconds + 11644473600;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  const data = new TextEncoder().encode(ticks.toFixed(0) + TRUSTED_CLIENT_TOKEN);
  const sha = gShaDigest(data);
  const [c0, c1] = gCs64(data, sha);
  return (gHexLE(c0) + gHexLE(c1) + "-" + sha.map(gHexBE).join("")).toUpperCase();
}

// src/browser-drm.ts
var WIN_EPOCH = 11644473600;
var S_TO_NS = 1e9;
var _BrowserDRM = class _BrowserDRM {
  static adjClockSkewSeconds(skewSeconds) {
    _BrowserDRM.clockSkewSeconds += skewSeconds;
  }
  static getUnixTimestamp() {
    return Date.now() / 1e3 + _BrowserDRM.clockSkewSeconds;
  }
  static parseRfc2616Date(date) {
    try {
      return new Date(date).getTime() / 1e3;
    } catch (e) {
      return null;
    }
  }
  static handleClientResponseError(response) {
    if (!response.headers) {
      throw new SkewAdjustmentError("No headers in response.");
    }
    const serverDate = response.headers["date"] || response.headers["Date"];
    if (!serverDate) {
      throw new SkewAdjustmentError("No server date in headers.");
    }
    const serverDateParsed = _BrowserDRM.parseRfc2616Date(serverDate);
    if (serverDateParsed === null) {
      throw new SkewAdjustmentError(`Failed to parse server date: ${serverDate}`);
    }
    const clientDate = _BrowserDRM.getUnixTimestamp();
    _BrowserDRM.adjClockSkewSeconds(serverDateParsed - clientDate);
  }
  static async generateSecMsGec() {
    return secMsGecV2(_BrowserDRM.getUnixTimestamp());
  }
  /**
   * Generates a random MUID (Machine Unique Identifier).
   * @returns Uppercase 32-character hex string
   */
  static generateMuid() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  /**
   * Returns a copy of the given headers with a MUID cookie added.
   * @param headers - The original headers
   * @returns New headers object with Cookie header containing the MUID
   */
  static headersWithMuid(headers) {
    return {
      ...headers,
      Cookie: `muid=${_BrowserDRM.generateMuid()};`
    };
  }
};
_BrowserDRM.clockSkewSeconds = 0;
var BrowserDRM = _BrowserDRM;

// src/browser.ts
var EdgeTTSBrowser = class {
  /**
   * @param text The text to be synthesized.
   * @param voice The voice to use for synthesis.
   * @param options Prosody options (rate, volume, pitch).
   */
  constructor(text, voice = "Microsoft Server Speech Text to Speech Voice (en-US, EmmaMultilingualNeural)", options = {}) {
    this.ws = null;
    this.text = text;
    this.voice = voice;
    this.rate = options.rate || "+0%";
    this.volume = options.volume || "+0%";
    this.pitch = options.pitch || "+0Hz";
  }
  /**
   * Initiates the synthesis process.
   * @returns A promise that resolves with the synthesized audio and subtitle data.
   */
  async synthesize() {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected.");
    }
    this.ws.send(this.createSpeechConfig());
    this.ws.send(this.createSSML());
    return new Promise((resolve, reject) => {
      const audioChunks = [];
      let wordBoundaries = [];
      if (this.ws) {
        this.ws.onmessage = (event) => {
          if (typeof event.data === "string") {
            const { headers, body } = this.parseMessage(event.data);
            if (headers.Path === "audio.metadata") {
              try {
                const metadata = JSON.parse(body);
                if (metadata.Metadata && Array.isArray(metadata.Metadata)) {
                  const boundaries = metadata.Metadata.filter((item) => item.Type === "WordBoundary" && item.Data).map((item) => ({
                    offset: item.Data.Offset,
                    duration: item.Data.Duration,
                    text: item.Data.text.Text
                  }));
                  wordBoundaries = wordBoundaries.concat(boundaries);
                }
              } catch (e) {
              }
            } else if (headers.Path === "turn.end") {
              if (this.ws) this.ws.close();
            }
          } else if (event.data instanceof Blob) {
            event.data.arrayBuffer().then((arrayBuffer) => {
              const dataView = new DataView(arrayBuffer);
              const headerLength = dataView.getUint16(0);
              if (arrayBuffer.byteLength > headerLength + 2) {
                const audioData = new Uint8Array(arrayBuffer, headerLength + 2);
                audioChunks.push(audioData);
              }
            });
          }
        };
        this.ws.onclose = () => {
          const audioBlob = new Blob(
            audioChunks,
            { type: "audio/mpeg" }
          );
          resolve({ audio: audioBlob, subtitle: wordBoundaries });
        };
        this.ws.onerror = (error) => {
          reject(error);
        };
      }
    });
  }
  /**
   * Establishes a connection to the WebSocket server.
   */
  async connect() {
    const connectionId = this.generateConnectionId();
    const secMsGec = await BrowserDRM.generateSecMsGec();
    const url = `${WSS_URL}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;
    this.ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        return reject(new Error("WebSocket not initialized"));
      }
      this.ws.onopen = () => {
        resolve();
      };
      this.ws.onerror = (error) => {
        reject(error);
      };
    });
  }
  /**
   * Parses a string message from the WebSocket into headers and a body.
   */
  parseMessage(message) {
    const parts = message.split("\r\n\r\n");
    const headerLines = parts[0].split("\r\n");
    const headers = {};
    headerLines.forEach((line) => {
      const [key, value] = line.split(":", 2);
      if (key && value) {
        headers[key.trim()] = value.trim();
      }
    });
    return { headers, body: parts[1] || "" };
  }
  /**
   * Creates the speech configuration message.
   */
  createSpeechConfig() {
    const config = {
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: false,
              wordBoundaryEnabled: true
            },
            outputFormat: "audio-24khz-48kbitrate-mono-mp3"
          }
        }
      }
    };
    return `X-Timestamp:${this.getTimestamp()}\r
Content-Type:application/json; charset=utf-8\r
Path:speech.config\r
\r
${JSON.stringify(config)}`;
  }
  /**
   * Creates the SSML (Speech Synthesis Markup Language) message.
   */
  createSSML() {
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>
      <voice name='${this.voice}'>
        <prosody pitch='${this.pitch}' rate='${this.rate}' volume='${this.volume}'>
          ${this.escapeXml(this.text)}
        </prosody>
      </voice>
    </speak>`;
    return `X-RequestId:${this.generateConnectionId()}\r
Content-Type:application/ssml+xml\r
X-Timestamp:${this.getTimestamp()}Z\r
Path:ssml\r
\r
${ssml}`;
  }
  generateConnectionId() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : r & 3 | 8;
      return v.toString(16);
    });
  }
  getTimestamp() {
    return (/* @__PURE__ */ new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  }
  escapeXml(text) {
    return text.replace(/[<>&'"]/g, (char) => {
      switch (char) {
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case "&":
          return "&amp;";
        case "'":
          return "&apos;";
        case '"':
          return "&quot;";
        default:
          return char;
      }
    });
  }
};

// src/browser-utils.ts
function browserConnectId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  array[6] = array[6] & 15 | 64;
  array[8] = array[8] & 63 | 128;
  const hex = Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return uuid.replace(/-/g, "");
}
function browserEscape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function browserUnescape(text) {
  return text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function browserRemoveIncompatibleCharacters(text) {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}
function browserDateToString() {
  // JS-стиль, как шлёт сам Edge: «Tue Nov 03 2026 20:27:10 GMT+0000 (Coordinated Universal Time)».
  // Прежний вариант с запятой («Tue, 03 Nov 2026 … GMT+0000 (…)») сервер теперь отвергает:
  // рукопожатие проходит, а после сообщения ssml соединение рвётся (1006) без единого байта звука.
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]} ${mon[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}
function browserMkssml(voice, rate, volume, pitch, escapedText) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapedText}</prosody></voice></speak>`;
}
function browserSsmlHeadersPlusData(requestId, timestamp, ssml) {
  return `X-RequestId:${requestId}\r
Content-Type:application/ssml+xml\r
X-Timestamp:${timestamp}Z\r
Path:ssml\r
\r
${ssml}`;
}

// src/tts_config.ts
var TTSConfig = class _TTSConfig {
  /**
   * Creates a new TTSConfig instance with the specified parameters.
   * 
   * @param options - Configuration options
   * @param options.voice - Voice name (supports both short and full formats)
   * @param options.rate - Speech rate adjustment (default: "+0%")
   * @param options.volume - Volume adjustment (default: "+0%") 
   * @param options.pitch - Pitch adjustment (default: "+0Hz")
   * @throws {ValueError} If any parameter has an invalid format
   */
  constructor({
    voice,
    rate = "+0%",
    volume = "+0%",
    pitch = "+0Hz"
  }) {
    this.voice = voice;
    this.rate = rate;
    this.volume = volume;
    this.pitch = pitch;
    this.validate();
  }
  validate() {
    const match = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(this.voice);
    if (match) {
      const [, lang] = match;
      let [, , region, name] = match;
      if (name.includes("-")) {
        const parts = name.split("-");
        region += `-${parts[0]}`;
        name = parts[1];
      }
      this.voice = `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
    }
    _TTSConfig.validateStringParam(
      "voice",
      this.voice,
      /^Microsoft Server Speech Text to Speech Voice \(.+,.+\)$/
    );
    _TTSConfig.validateStringParam("rate", this.rate, /^[+-]\d+%$/);
    _TTSConfig.validateStringParam("volume", this.volume, /^[+-]\d+%$/);
    _TTSConfig.validateStringParam("pitch", this.pitch, /^[+-]\d+Hz$/);
  }
  static validateStringParam(paramName, paramValue, pattern) {
    if (typeof paramValue !== "string") {
      throw new TypeError(`${paramName} must be a string`);
    }
    if (!pattern.test(paramValue)) {
      throw new ValueError(`Invalid ${paramName} '${paramValue}'.`);
    }
  }
};

// src/browser-communicate.ts
var BrowserBuffer = class {
  static from(input, encoding) {
    if (typeof input === "string") {
      return new TextEncoder().encode(input);
    } else if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    } else if (input instanceof Uint8Array) {
      return input;
    }
    throw new Error("Unsupported input type for BrowserBuffer.from");
  }
  static concat(arrays) {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }
};
function browserGetHeadersAndDataFromText(message) {
  const messageString = new TextDecoder().decode(message);
  const headerEndIndex = messageString.indexOf("\r\n\r\n");
  const headers = {};
  if (headerEndIndex !== -1) {
    const headerString = messageString.substring(0, headerEndIndex);
    const headerLines = headerString.split("\r\n");
    for (const line of headerLines) {
      const [key, value] = line.split(":", 2);
      if (key && value) {
        headers[key] = value.trim();
      }
    }
  }
  const headerByteLength = new TextEncoder().encode(messageString.substring(0, headerEndIndex + 4)).length;
  return [headers, message.slice(headerByteLength)];
}
function browserGetHeadersAndDataFromBinary(message) {
  if (message.length < 2) {
    throw new Error("Message too short to contain header length");
  }
  const headerLength = message[0] << 8 | message[1];
  const headers = {};
  if (headerLength > 0 && headerLength + 2 <= message.length) {
    const headerBytes = message.slice(2, headerLength + 2);
    const headerString = new TextDecoder().decode(headerBytes);
    const headerLines = headerString.split("\r\n");
    for (const line of headerLines) {
      const [key, value] = line.split(":", 2);
      if (key && value) {
        headers[key] = value.trim();
      }
    }
  }
  return [headers, message.slice(headerLength + 2)];
}
function browserSplitTextByByteLength(text, byteLength) {
  return (function* () {
    let buffer = new TextEncoder().encode(text);
    while (buffer.length > byteLength) {
      let splitAt = byteLength;
      const slice = buffer.slice(0, byteLength);
      const sliceText = new TextDecoder().decode(slice);
      const lastNewline = sliceText.lastIndexOf("\n");
      const lastSpace = sliceText.lastIndexOf(" ");
      if (lastNewline > 0) {
        splitAt = new TextEncoder().encode(sliceText.substring(0, lastNewline)).length;
      } else if (lastSpace > 0) {
        splitAt = new TextEncoder().encode(sliceText.substring(0, lastSpace)).length;
      }
      const chunk = buffer.slice(0, splitAt);
      const chunkText = new TextDecoder().decode(chunk).trim();
      if (chunkText) {
        yield new TextEncoder().encode(chunkText);
      }
      buffer = buffer.slice(splitAt);
    }
    const remainingText = new TextDecoder().decode(buffer).trim();
    if (remainingText) {
      yield new TextEncoder().encode(remainingText);
    }
  })();
}
var BrowserCommunicate = class {
  /**
   * Creates a new browser Communicate instance for text-to-speech synthesis.
   * 
   * @param text - The text to synthesize
   * @param options - Configuration options for synthesis
   */
  constructor(text, options = {}) {
    this.state = {
      partialText: BrowserBuffer.from(""),
      offsetCompensation: 0,
      lastDurationOffset: 0,
      streamWasCalled: false
    };
    this.ttsConfig = new TTSConfig({
      voice: options.voice || DEFAULT_VOICE,
      rate: options.rate,
      volume: options.volume,
      pitch: options.pitch
    });
    if (typeof text !== "string") {
      throw new TypeError("text must be a string");
    }
    this.texts = browserSplitTextByByteLength(
      browserEscape(browserRemoveIncompatibleCharacters(text)),
      // browserCalcMaxMesgSize(this.ttsConfig.voice, this.ttsConfig.rate, this.ttsConfig.volume, this.ttsConfig.pitch),
      4096
    );
    this.connectionTimeout = options.connectionTimeout;
  }
  parseMetadata(data) {
    const metadata = JSON.parse(new TextDecoder().decode(data));
    for (const metaObj of metadata["Metadata"]) {
      const metaType = metaObj["Type"];
      if (metaType === "WordBoundary" || metaType === "SentenceBoundary") {
        const currentOffset = metaObj["Data"]["Offset"] + this.state.offsetCompensation;
        const currentDuration = metaObj["Data"]["Duration"];
        return {
          type: metaType,
          offset: currentOffset,
          duration: currentDuration,
          text: browserUnescape(metaObj["Data"]["text"]["Text"])
        };
      }
      if (metaType === "SessionEnd") {
        continue;
      }
      throw new UnknownResponse(`Unknown metadata type: ${metaType}`);
    }
    throw new UnexpectedResponse("No WordBoundary metadata found");
  }
  async *_stream() {
    const url = `${WSS_URL}&Sec-MS-GEC=${await BrowserDRM.generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${browserConnectId()}`;
    const websocket = new WebSocket(url);
    const messageQueue = [];
    let resolveMessage = null;
    let timeoutId;
    // Отказ на рукопожатии (403 и т.п.) раньше не прерывал ожидание открытия — приложение висело
    // до своего таймаута. Теперь ошибка/закрытие до open сразу отклоняют ожидание.
    let rejectOpen = null;
    if (this.connectionTimeout) {
      timeoutId = window.setTimeout(() => {
        websocket.close();
        messageQueue.push(new WebSocketError("Connection timeout"));
        if (resolveMessage) resolveMessage();
      }, this.connectionTimeout);
    }
    websocket.onmessage = (event) => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = void 0;
      }
      const data = event.data;
      if (typeof data === "string") {
        const [headers, parsedData] = browserGetHeadersAndDataFromText(BrowserBuffer.from(data));
        const path = headers["Path"];
        if (path === "audio.metadata") {
          try {
            const parsedMetadata = this.parseMetadata(parsedData);
            this.state.lastDurationOffset = parsedMetadata.offset + parsedMetadata.duration;
            messageQueue.push(parsedMetadata);
          } catch (e) {
            messageQueue.push(e);
          }
        } else if (path === "turn.end") {
          this.state.offsetCompensation = this.state.lastDurationOffset;
          this.state.offsetCompensation += 875e4;
          websocket.close();
        } else if (path !== "response" && path !== "turn.start") {
          messageQueue.push(new UnknownResponse(`Unknown path received: ${path}`));
        }
      } else if (data instanceof ArrayBuffer) {
        const bufferData = BrowserBuffer.from(data);
        if (bufferData.length < 2) {
          messageQueue.push(new UnexpectedResponse("We received a binary message, but it is missing the header length."));
        } else {
          const [headers, audioData] = browserGetHeadersAndDataFromBinary(bufferData);
          if (headers["Path"] !== "audio") {
            messageQueue.push(new UnexpectedResponse("Received binary message, but the path is not audio."));
          } else {
            const contentType = headers["Content-Type"];
            if (contentType !== "audio/mpeg") {
              if (audioData.length > 0) {
                messageQueue.push(new UnexpectedResponse("Received binary message, but with an unexpected Content-Type."));
              }
            } else if (audioData.length === 0) {
              messageQueue.push(new UnexpectedResponse("Received binary message, but it is missing the audio data."));
            } else {
              messageQueue.push({ type: "audio", data: audioData });
            }
          }
        }
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((arrayBuffer) => {
          const bufferData = BrowserBuffer.from(arrayBuffer);
          if (bufferData.length < 2) {
            messageQueue.push(new UnexpectedResponse("We received a binary message, but it is missing the header length."));
          } else {
            const [headers, audioData] = browserGetHeadersAndDataFromBinary(bufferData);
            if (headers["Path"] !== "audio") {
              messageQueue.push(new UnexpectedResponse("Received binary message, but the path is not audio."));
            } else {
              const contentType = headers["Content-Type"];
              if (contentType !== "audio/mpeg") {
                if (audioData.length > 0) {
                  messageQueue.push(new UnexpectedResponse("Received binary message, but with an unexpected Content-Type."));
                }
              } else if (audioData.length === 0) {
                messageQueue.push(new UnexpectedResponse("Received binary message, but it is missing the audio data."));
              } else {
                messageQueue.push({ type: "audio", data: audioData });
              }
            }
          }
          if (resolveMessage) resolveMessage();
        });
      }
      if (resolveMessage) resolveMessage();
    };
    websocket.onerror = (error) => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = void 0;
      }
      messageQueue.push(new WebSocketError("WebSocket error occurred"));
      if (resolveMessage) resolveMessage();
      if (rejectOpen) rejectOpen(new WebSocketError("WebSocket handshake failed"));
    };
    websocket.onclose = () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = void 0;
      }
      messageQueue.push("close");
      if (resolveMessage) resolveMessage();
      if (rejectOpen) rejectOpen(new WebSocketError("WebSocket closed before open"));
    };
    await new Promise((resolve, reject) => {
      rejectOpen = reject;
      websocket.onopen = () => {
        rejectOpen = null;
        if (timeoutId) {
          window.clearTimeout(timeoutId);
          timeoutId = void 0;
        }
        resolve();
      };
      if (this.connectionTimeout) {
        setTimeout(() => {
          if (websocket.readyState === WebSocket.CONNECTING) {
            websocket.close();
            reject(new WebSocketError("Connection timeout"));
          }
        }, this.connectionTimeout);
      }
    });
    websocket.send(
      `X-Timestamp:${browserDateToString()}\r
Content-Type:application/json; charset=utf-8\r
Path:speech.config\r
\r
{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r
`
    );
    websocket.send(
      browserSsmlHeadersPlusData(
        browserConnectId(),
        browserDateToString(),
        browserMkssml(this.ttsConfig.voice, this.ttsConfig.rate, this.ttsConfig.volume, this.ttsConfig.pitch, new TextDecoder().decode(this.state.partialText))
      )
    );
    let audioWasReceived = false;
    while (true) {
      if (messageQueue.length > 0) {
        const message = messageQueue.shift();
        if (message === "close") {
          if (!audioWasReceived) {
            throw new NoAudioReceived("No audio was received.");
          }
          break;
        } else if (message instanceof Error) {
          throw message;
        } else {
          if (message.type === "audio") audioWasReceived = true;
          yield message;
        }
      } else {
        await new Promise((resolve) => {
          resolveMessage = resolve;
          setTimeout(resolve, 50);
        });
      }
    }
  }
  /**
   * Streams text-to-speech synthesis results using native browser WebSocket.
   * Uses only browser-native APIs, avoiding Node.js dependencies.
   * 
   * @yields BrowserTTSChunk - Audio data or word boundary information
   * @throws {Error} If called more than once
   * @throws {NoAudioReceived} If no audio data is received
   * @throws {WebSocketError} If WebSocket connection fails
   */
  async *stream() {
    if (this.state.streamWasCalled) {
      throw new Error("stream can only be called once.");
    }
    this.state.streamWasCalled = true;
    for (const partialText of this.texts) {
      this.state.partialText = partialText;
      for await (const message of this._stream()) {
        yield message;
      }
    }
  }
};

// src/browser-simple.ts
function concatUint8Arrays(arrays) {
  if (arrays.length === 0) return new Uint8Array(0);
  if (arrays.length === 1) return arrays[0];
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    if (arr.length > 0) {
      result.set(arr, offset);
      offset += arr.length;
    }
  }
  return result;
}
var BrowserEdgeTTS = class {
  /**
   * @param text The text to be synthesized.
   * @param voice The voice to use for synthesis.
   * @param options Prosody options (rate, volume, pitch).
   */
  constructor(text, voice = "Microsoft Server Speech Text to Speech Voice (en-US, EmmaMultilingualNeural)", options = {}) {
    this.text = text;
    this.voice = voice;
    this.rate = options.rate || "+0%";
    this.volume = options.volume || "+0%";
    this.pitch = options.pitch || "+0Hz";
  }
  /**
   * Initiates the synthesis process using browser-native APIs.
   * @returns A promise that resolves with the synthesized audio and subtitle data.
   */
  async synthesize() {
    const communicate = new BrowserCommunicate(this.text, {
      voice: this.voice,
      rate: this.rate,
      volume: this.volume,
      pitch: this.pitch
    });
    const audioChunks = [];
    const wordBoundaries = [];
    for await (const chunk of communicate.stream()) {
      if (chunk.type === "audio" && chunk.data) {
        audioChunks.push(chunk.data);
      } else if (chunk.type === "WordBoundary" && chunk.offset !== void 0 && chunk.duration !== void 0 && chunk.text !== void 0) {
        wordBoundaries.push({
          offset: chunk.offset,
          duration: chunk.duration,
          text: chunk.text
        });
      }
    }
    const audioBuffer = concatUint8Arrays(audioChunks);
    const audioBlob = new Blob([
      audioBuffer
    ], { type: "audio/mpeg" });
    return {
      audio: audioBlob,
      subtitle: wordBoundaries
    };
  }
};
function formatTimestamp(timeIn100ns, format) {
  const totalSeconds = Math.floor(timeIn100ns / 1e7);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor(timeIn100ns % 1e7 / 1e4);
  const separator = format === "vtt" ? "." : ",";
  return `${padNumber(hours)}:${padNumber(minutes)}:${padNumber(seconds)}${separator}${padNumber(milliseconds, 3)}`;
}
function padNumber(num, length = 2) {
  return num.toString().padStart(length, "0");
}
function createVTT(wordBoundaries) {
  let vttContent = "WEBVTT\n\n";
  wordBoundaries.forEach((word, index) => {
    const startTime = formatTimestamp(word.offset, "vtt");
    const endTime = formatTimestamp(word.offset + word.duration, "vtt");
    vttContent += `${index + 1}
`;
    vttContent += `${startTime} --> ${endTime}
`;
    vttContent += `${word.text}

`;
  });
  return vttContent;
}
function createSRT(wordBoundaries) {
  let srtContent = "";
  wordBoundaries.forEach((word, index) => {
    const startTime = formatTimestamp(word.offset, "srt");
    const endTime = formatTimestamp(word.offset + word.duration, "srt");
    srtContent += `${index + 1}
`;
    srtContent += `${startTime} --> ${endTime}
`;
    srtContent += `${word.text}

`;
  });
  return srtContent;
}

// src/browser-voices.ts
var BrowserFetchError = class extends Error {
  constructor(message, response) {
    super(message);
    this.name = "BrowserFetchError";
    this.response = response;
  }
};
async function _listVoices() {
  const url = `${VOICE_LIST_URL}&Sec-MS-GEC=${await BrowserDRM.generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
  try {
    const response = await fetch(url, {
      headers: VOICE_HEADERS
    });
    if (!response.ok) {
      const headers = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      throw new BrowserFetchError(`HTTP ${response.status}`, {
        status: response.status,
        headers
      });
    }
    const data = await response.json();
    for (const voice of data) {
      voice.VoiceTag.ContentCategories = voice.VoiceTag.ContentCategories.map((c) => c.trim());
      voice.VoiceTag.VoicePersonalities = voice.VoiceTag.VoicePersonalities.map((p) => p.trim());
    }
    return data;
  } catch (error) {
    if (error instanceof BrowserFetchError) {
      throw error;
    }
    throw new BrowserFetchError(error instanceof Error ? error.message : "Unknown fetch error");
  }
}
async function listVoices() {
  try {
    return await _listVoices();
  } catch (e) {
    if (e instanceof BrowserFetchError && e.response?.status === 403) {
      BrowserDRM.handleClientResponseError(e.response);
      return await _listVoices();
    }
    throw e;
  }
}
var BrowserVoicesManager = class _BrowserVoicesManager {
  constructor() {
    this.voices = [];
    this.calledCreate = false;
  }
  /**
   * Creates a new BrowserVoicesManager instance.
   * 
   * @param customVoices - Optional custom voice list instead of fetching from API
   * @returns Promise resolving to BrowserVoicesManager instance
   */
  static async create(customVoices) {
    const manager = new _BrowserVoicesManager();
    const voices = customVoices ?? await listVoices();
    manager.voices = voices.map((voice) => ({
      ...voice,
      Language: voice.Locale.split("-")[0]
    }));
    manager.calledCreate = true;
    return manager;
  }
  /**
   * Finds voices matching the specified criteria.
   * 
   * @param filter - Filter criteria for voice selection
   * @returns Array of voices matching the filter
   * @throws {Error} If called before create()
   */
  find(filter) {
    if (!this.calledCreate) {
      throw new Error("BrowserVoicesManager.find() called before BrowserVoicesManager.create()");
    }
    return this.voices.filter((voice) => {
      return Object.entries(filter).every(([key, value]) => {
        return voice[key] === value;
      });
    });
  }
};

// src/submaker.ts
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1e3);
  const pad = (num, size = 2) => num.toString().padStart(size, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}
var SubMaker = class {
  constructor() {
    this.cues = [];
  }
  /**
   * Adds a WordBoundary chunk to the subtitle maker.
   * 
   * @param msg - Must be a WordBoundary type chunk with offset, duration, and text
   * @throws {ValueError} If chunk is not a WordBoundary with required fields
   */
  feed(msg) {
    if (msg.type !== "WordBoundary" || msg.offset === void 0 || msg.duration === void 0 || msg.text === void 0) {
      throw new ValueError("Invalid message type, expected 'WordBoundary' with offset, duration and text");
    }
    const start = msg.offset / 1e7;
    const end = (msg.offset + msg.duration) / 1e7;
    this.cues.push({
      index: this.cues.length + 1,
      start,
      end,
      content: msg.text
    });
  }
  /**
   * Merges consecutive cues to create subtitle entries with multiple words.
   * This is useful for creating more readable subtitles instead of word-by-word display.
   * 
   * @param words - Maximum number of words per merged cue
   * @throws {ValueError} If words parameter is invalid
   */
  mergeCues(words) {
    if (words <= 0) {
      throw new ValueError("Invalid number of words to merge, expected > 0");
    }
    if (this.cues.length === 0) {
      return;
    }
    const newCues = [];
    let currentCue = this.cues[0];
    for (const cue of this.cues.slice(1)) {
      if (currentCue.content.split(" ").length < words) {
        currentCue = {
          ...currentCue,
          end: cue.end,
          content: `${currentCue.content} ${cue.content}`
        };
      } else {
        newCues.push(currentCue);
        currentCue = cue;
      }
    }
    newCues.push(currentCue);
    this.cues = newCues.map((cue, i) => ({ ...cue, index: i + 1 }));
  }
  /**
   * Returns the subtitles in SRT format.
   * 
   * @returns SRT formatted subtitles
   */
  getSrt() {
    return this.cues.map((cue) => {
      return `${cue.index}\r
${formatTime(cue.start)} --> ${formatTime(cue.end)}\r
${cue.content}\r
`;
    }).join("\r\n");
  }
  toString() {
    return this.getSrt();
  }
};

export { BrowserCommunicate as Communicate, BrowserDRM as DRM, BrowserEdgeTTS as EdgeTTS, EdgeTTSBrowser, EdgeTTSException, BrowserFetchError as FetchError, NoAudioReceived, SkewAdjustmentError, SubMaker, UnexpectedResponse, UnknownResponse, ValueError, BrowserVoicesManager as VoicesManager, WebSocketError, createSRT, createVTT, listVoices };
//# sourceMappingURL=browser.js.map
//# sourceMappingURL=browser.js.map