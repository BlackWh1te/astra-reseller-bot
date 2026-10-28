import { authorizeLocal, securityHeaders, boundedBody, safeEqual, validateConfig, SERVICE_ORIGIN, isLocalTest } from "./security.mjs";
import { openSync, closeSync } from "node:fs";
let dashboardExtensionFactory=null, activeDashboardExtension=null;
function setDashboardExtension(factory){ dashboardExtensionFactory=factory; }
import * as import_undici from "undici";
import { parse } from "node-html-parser";
// src/main.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync3, readFileSync as readFileSync6, rmSync, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join2 } from "node:path";


// src/api.ts
var ApiRefused = class extends Error {
  status;
  code;
  reason;
  constructor(status2, code, reason) {
    super(`${reason} (${code})`);
    this.status = status2;
    this.code = code;
    this.reason = reason;
  }
};
var ApiUnavailable = class extends Error {
};
var ResellerApi = class {
  base;
  devKey;
  constructor(apiBase, devKey) {
    const origin=new URL(apiBase);
    if(origin.origin!==SERVICE_ORIGIN && !isLocalTest(origin)) throw new Error("Untrusted reseller API origin");
    this.base = `${apiBase.replace(/\/+$/, "")}/api/reseller/v1`;
    this.devKey = devKey;
  }
  async request(method, path, body, idempotencyKey) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetch(`${this.base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.devKey}`,
            "user-agent": "funpay-reseller-bot/1",
            ...body ? { "content-type": "application/json" } : {},
            ...idempotencyKey ? { "idempotency-key": idempotencyKey } : {}
          },
          body: body ? JSON.stringify(body) : void 0,
          signal: AbortSignal.timeout(3e4)
        });
      } catch (error2) {
        throw new ApiUnavailable(`сервер ключей не ответил (${error2 instanceof Error ? error2.message : String(error2)})`);
      }
      const data = await response.json().catch(() => null);
      if (response.ok) return data;
      if (response.status === 409 && data?.error?.code === "request_in_progress" && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 2e3 * attempt));
        continue;
      }
      if (response.status === 429 || response.status >= 500) throw new ApiUnavailable(`сервер ключей ответил HTTP ${response.status}`);
      const error = data?.error ?? {};
      throw new ApiRefused(response.status, error.code ?? `http_${response.status}`, error.message_ru ?? error.message ?? `HTTP ${response.status}`);
    }
  }
  me() {
    return this.request("GET", "/me");
  }
  models() {
    return this.request("GET", "/models");
  }
  rates() {
    return this.request("GET", "/rates");
  }
  createKey(input, idempotencyKey) {
    const { tokens, ...wallet } = input;
    return this.request("POST", "/keys", { ...input.billing === "usd" ? wallet : { ...wallet, tokens }, language: "ru" }, idempotencyKey);
  }
  topUp(keyId, tokens, idempotencyKey, billing) {
    return this.request("POST", `/keys/${keyId}/topup`, billing === "usd" ? { usd: tokens / 1e6 } : { tokens }, idempotencyKey);
  }
  /** Tokens added as a gift (the review bonus); counted apart from sales in the cabinet. */
  bonus(keyId, tokens, reason, idempotencyKey, billing) {
    return this.request("POST", `/keys/${keyId}/bonus`, { ...billing === "usd" ? { usd: tokens / 1e6 } : { tokens }, reason }, idempotencyKey);
  }
  key(keyId) {
    return this.request("GET", `/keys/${keyId}`).then((answer) => answer.key);
  }
  secret(keyId) {
    return this.request("GET", `/keys/${keyId}/secret`);
  }
  /** Which of the reseller's keys this full key is (goods FunPay's auto-delivery handed over). */
  lookup(secret) {
    return this.request("POST", "/keys/lookup", { key: secret }).then((answer) => answer.key);
  }
  /** Working keys, newest first, 100 a page. */
  listKeys(cursor) {
    return this.request("GET", `/keys?status=active&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
  }
  setActive(keyId, active) {
    return this.request("POST", `/keys/${keyId}/${active ? "enable" : "disable"}`);
  }
  /** AI dollar pool only. Goods use steam_pool and smm_pool from me(). */
  usdPool() {
    return this.request("GET", "/me").then((me) => me.usd_pool?.balance ?? 0);
  }
  /* ---------------------------------------------- Steam rentals and SMM (the owner switches them on) */
  steamCatalog() {
    return this.request("GET", "/steam/catalog");
  }
  steamQuote(productId, hours) {
    return this.request("GET", `/steam/quote?product_id=${productId}&hours=${hours}`);
  }
  /** Rents for a FunPay order, once per order: a retry after a timeout gets the same rental. */
  async rentSteam(input) {
    await this.requireGoodsWallet("steam");
    return this.request("POST", "/steam/rentals", input);
  }
  steamRental(orderId) {
    return this.request("GET", `/steam/rentals/${encodeURIComponent(orderId)}`);
  }
  /** The shop's rentals still running (one call for all of them: the expiry reminders use it). */
  steamRentals() {
    return this.request("GET", "/steam/rentals?state=active&limit=200").then((answer) => answer.data);
  }
  steamCredentials(orderId) {
    return this.request("GET", `/steam/rentals/${encodeURIComponent(orderId)}/credentials`);
  }
  steamGuard(orderId) {
    return this.request("GET", `/steam/rentals/${encodeURIComponent(orderId)}/guard`);
  }
  async steamBonus(orderId) {
    await this.requireGoodsWallet("steam");
    return this.request("POST", `/steam/rentals/${encodeURIComponent(orderId)}/bonus`, {});
  }
  smmCatalog() {
    return this.request("GET", "/smm/catalog");
  }
  /** An SMM order for a FunPay order, once per order. 202: the result is unknown and the owner checks it. */
  async smmOrder(input) {
    await this.requireGoodsWallet("smm");
    return this.request("POST", "/smm/orders", input);
  }
  smmStatus(orderId) {
    return this.request("GET", `/smm/orders/${encodeURIComponent(orderId)}`);
  }
  /** An old server must not charge a shared AI pool when a dedicated wallet is missing. */
  async requireGoodsWallet(kind) {
    const me = await this.me();
    const wallet = kind === "steam" ? me.steam_pool : me.smm_pool;
    if (!wallet || typeof wallet.balance !== "number" || !Number.isFinite(wallet.balance) || wallet.balance < 0) {
      throw new ApiRefused(409, "separate_wallet_required", `Сервер не подтвердил отдельный баланс ${kind === "steam" ? "Steam" : "SMM"}. Нужны миграция и обновление сервера; общий баланс AI не используется.`);
    }
  }
};


// ../src/lib/funpay/ai.ts
import { randomUUID } from "crypto";
var MAX_CHAT_IMAGES = 2;
var HANDOFF_RE = /\[\s*handoff\s*\]/i;
var OFFTOPIC_RE = /\[\s*off[\s_-]*topic\s*\]/i;
var AiError = class extends Error {
  constructor(message, retryable) {
    super(message);
    this.name = "AiError";
    this.retryable = retryable;
  }
};
var SECRET_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;
var MAX_TURNS = 50;
var CONVERSATION_WINDOW_MS = 6 * 60 * 6e4;
var UNDATED_TURNS = 12;
var EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
var PASSWORD_RE = /(?<![\p{L}\p{N}])(пароль|password|passwd|pass|pwd)(\s*[:=—–-]\s*)\S+/giu;
var LOGIN_PAIR_RE = /(\[почта скрыта\])([ \t:;,/|]+)(?!\[|(?:пароль|password|passwd|pass|pwd|логин|login)(?![\p{L}\p{N}]))[^\s:;,/|]\S*/giu;
function redactSecrets(text) {
  return text.replace(SECRET_RE, "[ключ скрыт]").replace(PASSWORD_RE, "$1$2[пароль скрыт]").replace(EMAIL_RE, "[почта скрыта]").replace(LOGIN_PAIR_RE, "$1$2[пароль скрыт]");
}
function currentConversation(messages) {
  const newest = [...messages].reverse().find((message) => message.sentAt)?.sentAt;
  if (!newest) return messages.slice(-UNDATED_TURNS);
  return messages.filter((message) => message.sentAt && newest.getTime() - message.sentAt.getTime() <= CONVERSATION_WINDOW_MS);
}
function buildTranscript(messages, selfId, buyerId, images = /* @__PURE__ */ new Map()) {
  const turns = [];
  for (const message of currentConversation(messages).slice(-MAX_TURNS)) {
    const image = message.imageUrl && message.authorId === buyerId ? images.get(message.id) : void 0;
    const text = message.text ? redactSecrets(message.text.trim()) : message.imageUrl ? image ? "[покупатель отправил изображение, оно ниже]" : "[покупатель отправил изображение]" : "";
    if (!text) continue;
    let role = "user";
    let content = text;
    if (message.isSystem) {
      content = `[Уведомление FunPay] ${text}`;
    } else if (message.authorId === selfId) {
      role = "assistant";
      if (!message.byBot && !message.autoReply) content = `[Продавец] ${text}`;
    } else if (message.authorId !== buyerId) {
      content = `[Сотрудник FunPay${message.staffBadge ? `, ${message.staffBadge}` : ""}] ${text}`;
    }
    let turn = turns.at(-1);
    if (turn?.role !== role) {
      turn = { role, parts: [] };
      turns.push(turn);
    }
    const lastPart = turn.parts.at(-1);
    if (lastPart?.type === "text") lastPart.text += `
${content}`;
    else turn.parts.push({ type: "text", text: content });
    if (image) turn.parts.push({ type: "image_url", image_url: { url: image } });
  }
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", parts: [{ type: "text", text: "[Начало диалога]" }] });
  return turns.map(({ role, parts }) => ({
    role,
    content: parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("\n") : parts
  }));
}
async function completeChat(config, messages) {
  let response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        "x-request-id": `funpay-${randomUUID()}`
      },
      body: JSON.stringify({ model: config.model, messages, max_tokens: 900, temperature: 0.3, stream: false }),
      cache: "no-store",
      signal: AbortSignal.timeout(9e4)
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new AiError(timeout ? "Astra API не ответил за 90 секунд" : `Astra API недоступен: ${String(error)}`, true);
  }
  if (!response.ok) {
    const detail = redactSecrets((await response.text().catch(() => "")).slice(0, 200));
    throw new AiError(`Astra API ${response.status}${detail ? `: ${detail}` : ""}`, response.status >= 500);
  }
  const json = await response.json().catch(() => null);
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("") : "";
  if (!text.trim()) throw new AiError("Astra API вернул пустой ответ", true);
  return text;
}
function sanitizeReply(text, allowedHosts) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => /^\s*https?:\/\//i.test(label) ? url : `${label.trim()} (${url})`).replace(/<(https?:\/\/[^\s>]+)>/g, "$1").replace(/```[\w-]*\n?/g, "").replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*]\s+/gm, "• ").replace(/`([^`\n]+)`/g, "$1");
  return redactSecrets(cleaned).replace(/https?:\/\/[^\s)»"']+/gi, (url) => {
    try {
      const host = new URL(url).host.toLowerCase();
      return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url : "[ссылка удалена]";
    } catch {
      return "[ссылка удалена]";
    }
  }).replace(/\b(?:t\.me|telegram\.me|discord\.gg|discord\.com\/invite|wa\.me|vk\.com)\/\S+/gi, "[контакт удалён]").replace(/\n{3,}/g, "\n\n").trim();
}
var RISKY_WORDS = [
  "крипт(?!ограф)[оа]\\p{L}*",
  "crypto(?!graph)\\p{L}*",
  "bitcoin",
  "биткои?й?н\\p{L}*",
  "btc",
  "usdt",
  "tether",
  "eth",
  "ethereum",
  "эфириум\\p{L}*",
  "ton",
  "toncoin",
  "litecoin",
  "ltc",
  "xrocket",
  "nowpayments",
  "now ?payments",
  "binance",
  "бинанс\\p{L}*",
  "bybit",
  "yoomoney",
  "юmoney",
  "юмани",
  "qiwi",
  "киви-?кошел\\p{L}*",
  "сбп",
  "paypal",
  "payeer",
  "webmoney",
  "вебмани",
  "avito",
  "авито",
  "plati(?:\\.market|\\.ru)?",
  "плати[ .]?маркет\\p{L}*",
  "ggsel",
  "playerok",
  "плеерок\\p{L}*",
  "digiseller",
  "starvell",
  "lolz",
  "лолз\\p{L}*",
  "zelenka",
  "g2a",
  "eneba",
  "kinguin",
  "ozon",
  "озон\\p{L}*",
  "wildberries",
  "вайлдберриз"
];
var RISKY_RE = new RegExp(`(?<![\\p{L}\\d])(?:${RISKY_WORDS.join("|")})(?![\\p{L}\\d])|(?<![\\p{L}\\d.])@[A-Za-z][A-Za-z0-9_]{3,}(?![\\w/-])`, "iu");
var MAX_MESSAGE_LINES = 14;
function splitMessage(text, max = 1200, maxLines = MAX_MESSAGE_LINES) {
  const fits = (rows) => rows.length <= maxLines && rows.join("\n").length <= max;
  const filled = [];
  let part = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const rows = paragraph.split("\n").map((row) => row.length <= max ? row : `${row.slice(0, max - 1).trimEnd()}…`);
    const joined = part.length ? [...part, "", ...rows] : rows;
    if (fits(joined)) {
      part = joined;
      continue;
    }
    if (fits(rows)) {
      filled.push(part);
      part = rows;
      continue;
    }
    if (part.length) part.push("");
    for (const row of rows) {
      if (part.length && !fits([...part, row])) {
        filled.push(part);
        part = [];
      }
      part.push(row);
    }
  }
  filled.push(part);
  const parts = filled.map((rows) => rows.join("\n").trim()).filter(Boolean);
  if (parts.length <= 3) return parts;
  const kept = parts.slice(0, 3);
  kept[2] = kept[2].length < max ? `${kept[2]}…` : `${kept[2].slice(0, max - 1)}…`;
  return kept;
}


// ../src/lib/steam/lot.ts
var SteamSectionFullError = class extends Error {
  constructor(section) {
    super(`Раздел \xAB${section}\xBB заполнен на FunPay: удалите ненужные лоты в нём`);
    this.section = section;
  }
};
var SteamFormMissingError = class extends Error {
};
function offerForm(html) {
  const page = parse(html), form = page.querySelector("form.form-offer-editor");
  if (!form) {
    const full = /Много предложений в разделе\s*«([^»]+)»/.exec(page.text);
    if (full) throw new SteamSectionFullError(full[1].trim());
    throw new SteamFormMissingError("Редактор лота FunPay не открылся");
  }
  const fields = new URLSearchParams();
  const selects = [];
  for (const field of form.querySelectorAll("input[name], textarea[name], select[name]")) {
    const name = field.getAttribute("name");
    if (field.hasAttribute("disabled")) continue;
    const type = field.getAttribute("type");
    if (["submit", "button", "file", "reset"].includes(type ?? "")) continue;
    if (["checkbox", "radio"].includes(type ?? "") && !field.hasAttribute("checked")) continue;
    if (field.tagName === "SELECT") {
      selects.push({ name, options: field.querySelectorAll("option").map((option) => ({ value: option.getAttribute("value") ?? option.text, text: option.text.replace(/&nbsp;| /g, " ").trim() })) });
      const selected = field.querySelector("option[selected]") ?? field.querySelector("option");
      fields.append(name, selected?.getAttribute("value") ?? selected?.text ?? "");
    } else fields.append(name, field.tagName === "TEXTAREA" ? field.text : field.getAttribute("value") ?? (type === "checkbox" ? "on" : ""));
  }
  return { fields, currency: form.querySelector(".form-control-feedback")?.text.trim() ?? "", selects };
}
var RUB = /^(₽|руб\.?|RUB|Р)$/i;
function steamLotFields(html, lotId, marker) {
  const { fields, currency } = offerForm(html);
  const titles = [...fields.entries()].filter(([name]) => /^fields\[summary\]/.test(name)).map(([, value]) => value);
  if (fields.get("offer_id") !== lotId || !fields.get("csrf_token") || !fields.has("price") || !titles.length || titles.some((title) => !title.includes(marker))) throw new Error("Лот FunPay не совпадает: ID лота, маркер в названии или поля редактора");
  if (!RUB.test(currency)) throw new Error("Автоцена Steam работает только для лотов в рублях");
  if (fields.get("auto_delivery") || fields.get("secrets")) throw new Error("Выключите автовыдачу FunPay у лота аренды Steam");
  return fields;
}
var EDITION_WORDS = /\b(?:edition|bundle|goty|game of the year)\b/i;
var NUMERAL = /\b(?:\d+|i{2,3}|iv|v|vi{1,3}|ix|x)\b/;
var normalizeGame = (value) => value.normalize("NFKC").toLowerCase().replace(/[™®]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function gameOption(select, gameName) {
  const full = normalizeGame(gameName);
  if (!full) return void 0;
  const withoutEdition = (value) => value.replace(/\s+(?:(?:digital|deluxe|premium|ultimate|gold|complete|anniversary|royal|definitive|standard|legendary|goty|game of the year)\s+)*(?:edition|bundle)$/, "");
  const base = withoutEdition(full);
  const candidates = [full, base, normalizeGame(gameName.split(/\s+[-–]\s+/)[0]), normalizeGame(gameName.split(":")[0]), normalizeGame(gameName.split(":")[0].split(/\s+[-–]\s+/)[0])].map(withoutEdition).filter((value, i, all) => value && all.indexOf(value) === i && (!NUMERAL.test(base) || NUMERAL.test(value)));
  for (const candidate of candidates) {
    const option = select.options.find((o) => o.value && normalizeGame(o.text) === candidate) ?? select.options.find((o) => o.value && /^\(\s*pc\s*\)/i.test(o.text.trim()) && normalizeGame(o.text).replace(/^pc\s+/, "") === candidate);
    if (option) return option;
  }
  return void 0;
}
var SteamLotCategoryError = class extends Error {
};
function newSteamLotFields(html, node, text, price, amount, category) {
  const { fields, currency, selects } = offerForm(html);
  if (!fields.get("csrf_token") || !fields.has("price") || !fields.has("fields[summary][ru]")) throw new Error("В форме нового лота FunPay нет нужных полей");
  if (fields.get("node_id") && fields.get("node_id") !== String(node)) throw new Error("Форма нового лота открылась для другой категории FunPay");
  if (fields.get("offer_id") && fields.get("offer_id") !== "0") throw new Error("Форма FunPay открылась для существующего лота, а не нового");
  if (!RUB.test(currency)) throw new Error("Выкладка Steam работает только для аккаунта FunPay в рублях");
  const set = (name2, value) => {
    if (fields.has(name2)) fields.set(name2, value);
  };
  fields.set("fields[summary][ru]", text.ru.title);
  set("fields[summary][en]", text.en.title);
  set("fields[desc][ru]", text.ru.description);
  set("fields[desc][en]", text.en.description);
  set("fields[payment_msg][ru]", text.ru.payment);
  set("fields[payment_msg][en]", text.en.payment);
  const pick = (select, text2) => select.options.find((option) => option.text.toLowerCase() === text2.toLowerCase());
  const pc = (select) => select.options.find((o) => o.value && /\bpc\b/i.test(o.text) && /steam/i.test(o.text)) ?? pick(select, "PC") ?? pick(select, "Steam");
  const name = category?.gameName ?? "";
  const editionOf = (select) => {
    if (!name || !select.options.some((o) => /\bedition\b/i.test(o.text))) return void 0;
    const named = select.options.find((o) => /\bedition\b/i.test(o.text) && new RegExp(`\\b${o.text.replace(/\s*edition\s*/i, "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(name));
    return named ?? (EDITION_WORDS.test(name) ? pick(select, "Прочее") : pick(select, "Standard Edition"));
  };
  let rental = false;
  for (const select of selects) {
    const server = select.name === "server_id" ? gameOption(select, name) ?? pc(select) : void 0;
    const choice = server ?? editionOf(select) ?? pick(select, "Аренда") ?? pc(select) ?? (fields.get(select.name) || select.name === "server_id" ? void 0 : pick(select, "Прочее") ?? pick(select, "Другой"));
    if (!choice) continue;
    fields.set(select.name, choice.value);
    if (choice.text === "Аренда") rental = true;
  }
  const facts = node === 89 ? [] : [...fields.keys()].filter((key) => /^fields\[/.test(key) && !/^fields\[(summary|desc|payment_msg|images)\]/.test(key) && !selects.some((select) => select.name === key));
  if (facts.length) throw new SteamLotCategoryError(`В этой категории FunPay обязательны данные аккаунта (${facts.join(", ")}) — у поставщика их нет`);
  const hasSaleType = selects.some((select) => select.options.some((option) => /^(Продажа|Аренда)$/i.test(option.text)));
  if (!rental && !(category?.accounts && !hasSaleType)) throw new SteamLotCategoryError("В этой категории FunPay нет типа \xABАренда\xBB — игра пропущена");
  const missing = selects.find((select) => select.options.some((option) => option.value) && !fields.get(select.name));
  if (missing?.name === "server_id") throw new SteamLotCategoryError(`Игры \xAB${category?.gameName ?? ""}\xBB нет в списке игр этого раздела FunPay`);
  if (missing) throw new SteamLotCategoryError(`Не удалось выбрать поле ${missing.name} для ${category?.gameName ?? "игры"} — нужна проверка категории`);
  fields.set("price", price.toFixed(2));
  set("amount", String(amount));
  fields.delete("active");
  fields.delete("auto_delivery");
  fields.delete("secrets");
  return fields;
}
function steamAccountCategory(html, node) {
  return parse(html).querySelectorAll("a[href]").some((link) => {
    try {
      return new URL(link.getAttribute("href"), "https://funpay.com").pathname === `/lots/${node}/` && /^Аккаунты(?:\s|$)/i.test(link.text.trim());
    } catch {
      return false;
    }
  });
}
function ownOfferIdByMarker(html, marker) {
  const root = parse(html);
  if (!root.querySelector(".tc-item") && !root.querySelector('a[href*="offerEdit"]')) throw new Error("Страница собственных лотов FunPay не распознана");
  const ids = /* @__PURE__ */ new Set();
  for (const link of root.querySelectorAll('a[href*="offerEdit"]')) {
    const id = Number(link.getAttribute("href").match(/[?&](?:offer|id)=(\d+)/)?.[1]);
    if (Number.isSafeInteger(id) && id > 0 && link.text.includes(marker)) ids.add(id);
  }
  if (ids.size > 1) throw new Error(`Несколько лотов с маркером ${marker} — проверьте FunPay вручную`);
  return ids.size === 1 ? [...ids][0] : null;
}


// ../src/lib/funpay/html.ts
var BOT_MARK = "⁡";
var OLD_BOT_MARK = "⁤";
var FUNPAY_UTC_OFFSET_MINUTES = 180;
function parseHomePage(html) {
  const root = parse(html);
  return {
    username: root.querySelector(".user-link-name")?.text.trim() || null,
    appData: parseAppData(root)
  };
}
function parseAppData(root) {
  const raw = root.querySelector("body")?.getAttribute("data-app-data");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const userId = Number(data?.userId);
    const csrfToken = data?.["csrf-token"];
    if (!Number.isSafeInteger(userId) || userId <= 0 || typeof csrfToken !== "string" || !csrfToken) return null;
    return { userId, csrfToken, locale: typeof data.locale === "string" ? data.locale : null };
  } catch {
    return null;
  }
}
function parseSalesPage(html, now = /* @__PURE__ */ new Date(), utcOffsetMinutes = FUNPAY_UTC_OFFSET_MINUTES) {
  const root = parse(html);
  const header = root.querySelector("h1.page-header")?.text.trim().toLowerCase() ?? "";
  return {
    loggedIn: Boolean(root.querySelector(".user-link-name")),
    isSalesPage: /мои продажи|my sales|мої продажі/.test(header),
    csrfToken: parseAppData(root)?.csrfToken ?? null,
    rows: root.querySelectorAll("a.tc-item").flatMap((item) => {
      const row = parseSaleRow(item, now, utcOffsetMinutes);
      return row ? [row] : [];
    }),
    nextCursor: root.querySelector('input[name="continue"]')?.getAttribute("value") || null
  };
}
function parseSaleRow(item, now, utcOffsetMinutes) {
  const id = item.querySelector(".tc-order")?.text.trim().replace(/^#/, "") ?? "";
  if (!/^[A-Z0-9]{8}$/.test(id)) return null;
  const buyer = item.querySelector(".media-user-name span");
  const buyerId = Number(buyer?.getAttribute("data-href")?.match(/\/users\/(\d+)/)?.[1]);
  const money = parseMoney(item.querySelector(".tc-price")?.text ?? "");
  if (!buyer || !Number.isSafeInteger(buyerId) || !money) return null;
  const classes = item.classList;
  return {
    id,
    description: item.querySelector(".order-desc div")?.text.trim() ?? "",
    category: item.querySelector("div.text-muted")?.text.trim() || null,
    buyerName: buyer.text.trim(),
    buyerId,
    status: classes.contains("warning") ? "refunded" : classes.contains("info") ? "paid" : "closed",
    amountMinor: money.amountMinor,
    currency: money.currency,
    orderedAt: parseFunPayDate(item.querySelector(".tc-date-time")?.text ?? "", now, utcOffsetMinutes)
  };
}
function parseChatBookmarks(html) {
  return parse(html).querySelectorAll("a.contact-item").flatMap((item) => {
    const chatId = item.getAttribute("data-id") ?? "";
    const lastMessageId = Number(item.getAttribute("data-node-msg"));
    const message = item.querySelector(".contact-item-message");
    if (!/^\d{1,20}$/.test(chatId) || !Number.isSafeInteger(lastMessageId) || !message) return [];
    return [{
      chatId,
      name: item.querySelector(".media-user-name")?.text.trim() ?? "",
      lastMessageId,
      lastText: stripInvisibleSuffix(message.text).replace(/^[⁡⁤]/, ""),
      unread: item.classList.contains("unread")
    }];
  });
}
function parseChatMessages(raw, selfId, now = /* @__PURE__ */ new Date()) {
  const names = /* @__PURE__ */ new Map();
  const staff = /* @__PURE__ */ new Map();
  let lastSentAt = null;
  const parsed = raw.flatMap((message) => {
    const id = Number(message?.id);
    const authorId = Number(message?.author);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(authorId) || typeof message.html !== "string") return [];
    const root = parse(message.html.replace(/<br\s*\/?>/gi, "\n"));
    const stamp = root.querySelector(".chat-msg-date")?.getAttribute("title");
    const stamped = stamp ? parseFunPayDate(stamp, now) : null;
    if (stamped) lastSentAt = stamped;
    const sentAt = stamped ?? lastSentAt;
    const author = root.querySelector(".media-user-name");
    const name = author?.querySelector("a")?.text.trim();
    if (name) names.set(authorId, name);
    const badge = author?.querySelector(".chat-msg-author-label.label-success")?.text.trim().toLowerCase();
    if (badge) staff.set(authorId, badge);
    const autoReply = root.querySelectorAll(".chat-msg-author-label").some((label) => /автоответ|автовідповідь|auto-?reply/i.test(label.text));
    const isSystem = authorId === 0;
    const image = isSystem ? null : root.querySelector("a.chat-img-link");
    let text = null;
    let paidBy = null;
    if (!image) {
      const node = isSystem ? root.querySelector('[role="alert"]') : root.querySelector(".chat-msg-text");
      text = node ? stripInvisibleSuffix(node.text) : null;
      if (isSystem && text) {
        text = text.trim();
        if (classifySystemText(text).kind === "paid") {
          const profile = Number(node?.querySelector('a[href*="/users/"]')?.getAttribute("href")?.match(/\/users\/(\d+)/)?.[1]);
          paidBy = Number.isSafeInteger(profile) && profile > 0 ? profile : null;
        }
      }
    }
    let byBot = false;
    if (text && (text.startsWith(BOT_MARK) || authorId === selfId && text.startsWith(OLD_BOT_MARK))) {
      text = text.slice(1);
      byBot = true;
    }
    return [{ id, authorId, text, imageUrl: image?.getAttribute("href") ?? null, isSystem, byBot, autoReply, sentAt, paidBy }];
  });
  return parsed.map((message) => ({
    ...message,
    authorName: message.isSystem ? "FunPay" : names.get(message.authorId) ?? null,
    staffBadge: staff.get(message.authorId) ?? null
  }));
}
function parseOrderDetails(id, data) {
  const typeData = data?.type_data ?? {};
  const amount = Number(typeData.amount);
  const summary = typeData.fields?.summary?.value;
  const rating = Number(data?.review?.rating);
  const reviewText = typeof data?.review?.text === "string" && data.review.text.trim() ? data.review.text : null;
  const reviewReply = typeof data?.review?.reply === "string" && data.review.reply.trim() ? data.review.reply : null;
  const buyerId = Number(data?.buyer?.user_id);
  return {
    id,
    status: String(data?.status ?? ""),
    buyerId: Number.isSafeInteger(buyerId) ? buyerId : null,
    buyerName: typeof data?.buyer?.name === "string" ? data.buyer.name : null,
    chatNode: typeof data?.chat?.node_name === "string" ? data.chat.node_name : null,
    // Whole units only: a fractional amount is not a sale this bot understands (Steam rentals sell hours per unit).
    quantity: Number.isSafeInteger(amount) && amount > 0 ? amount : null,
    secrets: Array.isArray(typeData.secrets) ? typeData.secrets.map((secret) => String(secret?.value ?? "").trim()).filter(Boolean) : [],
    review: rating > 0 || reviewText ? { rating: rating > 0 ? rating : null, text: reviewText, reply: reviewReply } : null,
    reviewAbsent: Boolean(data) && typeof data === "object" && "review" in data && !(rating > 0) && !reviewText,
    title: typeof summary === "string" ? summary : summary?.ru ?? summary?.en ?? null
  };
}
var SYSTEM_PATTERNS = [
  ["paid", /(?:оплатил заказ|has paid for order) #([A-Z0-9]{8})/],
  ["confirmed", /(?:подтвердил успешное выполнение заказа|has confirmed that order) #([A-Z0-9]{8})/],
  ["review", /(?:отзыв к заказу|feedback to the order) #([A-Z0-9]{8})/],
  ["refund", /(?:вернул деньги покупателю|has refunded the buyer) \S+ (?:по заказу|on order) #([A-Z0-9]{8})/],
  ["refund", /(?:Часть средств по заказу|A part of the funds pertaining to the order) #([A-Z0-9]{8})/],
  ["reopened", /(?:Заказ|Order) #([A-Z0-9]{8}) (?:открыт повторно|has been reopened)/]
];
function classifySystemText(text) {
  for (const [kind, pattern] of SYSTEM_PATTERNS) {
    const match = text.match(pattern);
    if (match) return { kind, orderId: match[1] };
  }
  return { kind: "other", orderId: null };
}
var MONTHS = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};
function parseFunPayDate(text, now = /* @__PURE__ */ new Date(), utcOffsetMinutes = FUNPAY_UTC_OFFSET_MINUTES) {
  const clean = text.replace(/\s+/g, " ").trim().toLowerCase();
  const time = clean.match(/(\d{1,2}):(\d{2})/);
  if (!time) return null;
  const hours = Number(time[1]);
  const minutes = Number(time[2]);
  const offsetMs = utcOffsetMinutes * 6e4;
  const local = new Date(now.getTime() + offsetMs);
  let year = local.getUTCFullYear();
  let month = local.getUTCMonth();
  let day = local.getUTCDate();
  if (/вчера|вчора|yesterday/.test(clean)) {
    const yesterday = new Date(Date.UTC(year, month, day - 1));
    year = yesterday.getUTCFullYear();
    month = yesterday.getUTCMonth();
    day = yesterday.getUTCDate();
  } else if (!/сегодня|сьогодні|today/.test(clean)) {
    const date = clean.match(new RegExp("(\\d{1,2}) (\\p{L}+)(?: (\\d{4}))?", "u"));
    const monthNumber = date ? MONTHS[date[2]] : void 0;
    if (!date || !monthNumber) return null;
    day = Number(date[1]);
    month = monthNumber - 1;
    if (date[3]) {
      year = Number(date[3]);
    } else if (Date.UTC(year, month, day, hours, minutes) - offsetMs > now.getTime() + 864e5) {
      year -= 1;
    }
  }
  const utc = Date.UTC(year, month, day, hours, minutes) - offsetMs;
  return Number.isFinite(utc) ? new Date(utc) : null;
}
var CURRENCIES = { "₽": "RUB", "\xA4": "RUB", "$": "USD", "€": "EUR" };
function parseMoney(text) {
  const compact = text.replace(/\s+/g, "");
  const number = compact.match(/\d+(?:[.,]\d{1,2})?/)?.[0];
  const symbol = compact.match(/₽|¤|\$|€|RUB|USD|EUR/i)?.[0];
  if (!number || !symbol) return null;
  const amount = Number(number.replace(",", "."));
  if (!Number.isFinite(amount) || amount < 0) return null;
  return { amountMinor: Math.round(amount * 100), currency: CURRENCIES[symbol] ?? symbol.toUpperCase() };
}
function interlocutorId(nodeName, selfId) {
  const match = nodeName.match(/^users-(\d+)-(\d+)$/);
  if (!match) return null;
  const ids = [Number(match[1]), Number(match[2])];
  if (!ids.includes(selfId)) return null;
  const other = ids[0] === selfId ? ids[1] : ids[0];
  return Number.isSafeInteger(other) && other > 0 ? other : null;
}
function privateChatNode(a, b) {
  const [first, second] = [a, b].sort((x, y) => x - y);
  return `users-${first}-${second}`;
}
function stripInvisibleSuffix(text) {
  return text.replace(/[\s\p{Cf}]+$/u, "");
}
function parseOfferSections(html) {
  const root = parse(html);
  const sections = /* @__PURE__ */ new Map();
  for (const link of root.querySelectorAll(".offer-list-title h3 a")) {
    const node = Number(link.getAttribute("href")?.match(/\/lots\/(\d+)\/?$/)?.[1]);
    if (Number.isSafeInteger(node) && node > 0) sections.set(node, link.text.trim());
  }
  return [...sections].map(([node, title]) => ({ node, title }));
}
function parseProfileOffers(html) {
  const offers = [];
  for (const block of parse(html).querySelectorAll(".offer")) {
    const section = block.querySelector(".offer-list-title h3")?.text.trim() ?? "";
    for (const item of block.querySelectorAll("a.tc-item")) {
      const id = Number(item.getAttribute("href")?.match(/[?&]id=(\d+)/)?.[1]);
      const title = item.querySelector(".tc-desc-text")?.text.replace(/\s+/g, " ").trim() ?? "";
      const price = Number(item.querySelector(".tc-price")?.getAttribute("data-s"));
      if (!Number.isSafeInteger(id) || id <= 0 || !title) continue;
      offers.push({ id, section, title, price: Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null });
    }
  }
  return offers;
}
function parseRaiseButton(html) {
  const button = parse(html).querySelector(".js-lot-raise");
  const game = Number(button?.getAttribute("data-game"));
  const node = Number(button?.getAttribute("data-node"));
  return Number.isSafeInteger(game) && game > 0 && Number.isSafeInteger(node) && node > 0 ? { game, node } : null;
}
function parseRaiseAnswer(json) {
  if (!json || typeof json !== "object") return { kind: "error", message: "FunPay did not answer" };
  const message = typeof json.msg === "string" ? json.msg.trim() : "";
  const wait = Number(json.wait);
  if (typeof json.modal === "string" && json.modal) {
    const nodes = parse(json.modal).querySelectorAll('input[name="node_ids[]"]').map((input) => Number(input.getAttribute("value"))).filter((node) => Number.isSafeInteger(node) && node > 0);
    return nodes.length ? { kind: "choose", nodes } : { kind: "error", message: "FunPay asked to choose subcategories, but listed none" };
  }
  const waitSeconds = Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : parseWaitSeconds(message);
  if (json.error) {
    return waitSeconds !== null ? { kind: "wait", message, waitSeconds } : { kind: "error", message: message || "FunPay refused" };
  }
  if (json.url) return { kind: "error", message: `FunPay asked to open ${String(json.url)}` };
  return { kind: "raised", message, waitSeconds };
}
function parseWaitSeconds(text) {
  const clean = text.toLowerCase();
  if (!/подожд|зачекайте|wait|через|доступн/.test(clean)) return null;
  const amount = (pattern) => Number(clean.match(pattern)?.[1] ?? 0);
  const seconds = amount(/(\d+)\s*(?:ч|год|hour)/) * 3600 + amount(/(\d+)\s*(?:мин|хв|minute)/) * 60 + amount(/(\d+)\s*(?:сек|second)/);
  if (seconds > 0) return seconds;
  if (/час|годин|hour/.test(clean)) return 3600;
  if (/минут|хвилин|minute/.test(clean)) return 60;
  return /подожд|зачекайте|wait/.test(clean) ? 60 : null;
}


// ../src/lib/funpay/client.ts
var FunPayAuthError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FunPayAuthError";
  }
};
var FunPayRequestError = class extends Error {
  constructor(message, status2) {
    super(message);
    this.status = status2;
    this.name = "FunPayRequestError";
  }
};
var FunPayLotRejectedError = class extends FunPayRequestError {
};
var FunPayRateLimitError = class extends FunPayRequestError {
  constructor(retryAt, requestSent) {
    super(`FunPay ограничил запросы (HTTP 429). Пауза до ${new Date(retryAt).toISOString()}`, 429);
    this.retryAt = retryAt;
    this.requestSent = requestSent;
  }
};
var FunPaySendError = class extends Error {
  /** tooLong: FunPay refused the text itself («Слишком много строк»); a shorter message would go through. */
  constructor(message, flood, tooLong = false) {
    super(message);
    this.flood = flood;
    this.tooLong = tooLong;
    this.name = "FunPaySendError";
  }
};
var DEFAULT_BASE_URL = "https://funpay.com";
var DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
var SESSION_TTL_MS = 40 * 60 * 1e3;
var FLOOD_RE = /слишком часто|too frequently|занадто часто/i;
var TOO_LONG_RE = /много строк|слишком длинн|too many lines|too long|занадто багато рядків|занадто довг/i;
var FunPayClient = class {
  constructor(options) {
    this.options = options;
    this.userId = null;
    this.username = null;
    this.csrfToken = null;
    this.phpsessid = null;
    this.sessionStartedAt = 0;
    this.loginInFlight = null;
    this.cookies = /* @__PURE__ */ new Map();
    this.accountCategories = /* @__PURE__ */ new Map();
    this.lotRequestTail = Promise.resolve();
    this.nextLotRequestAt = 0;
    this.lotCooldownUntil = 0;
    this.lotRateLimits = 0;
    /** When the last new lot was sent (Steam or SMM): new lots from both publishers keep FunPay's pace together. */
    this.lastLotCreatedAt = 0;
    this.baseUrl = new URL(options.baseUrl || DEFAULT_BASE_URL);
  }
  /** Until when FunPay's last 429 pauses the lot lane (publishing, prices, raising). */
  get lotCooldown() {
    return this.lotCooldownUntil;
  }
  get loggedIn() {
    return this.csrfToken !== null && this.userId !== null;
  }
  /** Forget the current session so the next request signs in again. */
  resetSession() {
    this.csrfToken = null;
    this.phpsessid = null;
  }
  /** Opens a fresh session and reads the account id and CSRF token. Concurrent callers share one login. */
  login() {
    this.loginInFlight ??= this.openSession().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }
  async openSession() {
    this.csrfToken = null;
    this.phpsessid = null;
    const response = await this.request("GET", "/", { updateSession: true });
    if (response.status !== 200) throw new FunPayRequestError(`FunPay home page returned ${response.status}`, response.status);
    const { username, appData } = parseHomePage(await response.text());
    if (!username || !appData) throw new FunPayAuthError("FunPay did not accept the golden_key");
    this.username = username;
    this.userId = appData.userId;
    this.csrfToken = appData.csrfToken;
    this.sessionStartedAt = Date.now();
  }
  async ensureSession() {
    if (!this.loggedIn || Date.now() - this.sessionStartedAt > SESSION_TTL_MS) await this.login();
  }
  async runner(objects, request) {
    await this.ensureSession();
    for (let attempt = 0; ; attempt++) {
      const body = new URLSearchParams({
        objects: JSON.stringify(objects),
        request: request ? JSON.stringify(request) : "false",
        csrf_token: this.csrfToken ?? ""
      });
      const response = await this.request("POST", "/runner/", {
        headers: {
          accept: "*/*",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest"
        },
        body: body.toString()
      });
      if (response.status === 400 && attempt === 0) {
        await this.login();
        continue;
      }
      if (response.status !== 200) throw new FunPayRequestError(`FunPay runner returned ${response.status}`, response.status);
      const json = await response.json().catch(() => null);
      return {
        objects: Array.isArray(json?.objects) ? json.objects : [],
        response: json?.response ?? null
      };
    }
  }
  /** Up to 50 latest messages of one chat (numeric id or `users-A-B` name). */
  async chatHistory(node) {
    const result = await this.runner([chatNodeObject(node)]);
    const data = result.objects.find((object) => object.type === "chat_node")?.data;
    if (!data?.node) return null;
    return {
      id: String(data.node.id),
      name: String(data.node.name ?? ""),
      silent: Boolean(data.node.silent),
      messages: Array.isArray(data.messages) ? data.messages : []
    };
  }
  /** Sends one message marked as bot-sent. Returns FunPay's id for it when reported. */
  async sendMessage(node, text) {
    const result = await this.runner([chatNodeObject(node)], {
      action: "chat_message",
      data: { node, last_message: -1, content: `${BOT_MARK}${text}` }
    });
    if (!result.response) throw new FunPaySendError("FunPay did not confirm the message", false);
    if (result.response.error) {
      const error = String(result.response.error);
      throw new FunPaySendError(error, FLOOD_RE.test(error), TOO_LONG_RE.test(error));
    }
    const messages = result.objects.find((object) => object.type === "chat_node")?.data?.messages;
    const id = Array.isArray(messages) ? Number(messages.at(-1)?.id) : NaN;
    return Number.isSafeInteger(id) ? id : null;
  }
  /**
   * Publishes the seller's reply under the buyer's review of an order — the
   * same request as «Опубликовать» on the order page. It replaces a reply that
   * is already there, so callers check that there is none.
   */
  async replyToReview(orderId, text) {
    await this.ensureSession();
    for (let attempt = 0; ; attempt++) {
      const response = await this.request("POST", "/orders/review", {
        headers: {
          accept: "application/json, text/javascript, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest"
        },
        // A seller's reply has no rating: the site sends the field empty.
        body: new URLSearchParams({
          authorId: String(this.userId ?? ""),
          text,
          rating: "",
          csrf_token: this.csrfToken ?? "",
          orderId
        }).toString()
      });
      if (response.status === 400 && attempt === 0) {
        await this.login();
        continue;
      }
      if (response.status !== 200) throw new FunPayRequestError(`FunPay review reply returned ${response.status}`, response.status);
      const json = await response.json().catch(() => null);
      if (!json || json.error) throw new FunPayRequestError(`FunPay refused the review reply: ${json?.msg ?? "no answer"}`);
      return;
    }
  }
  /** The subcategories the seller has offers in, read from their public profile. */
  async offerSections() {
    await this.ensureSession();
    const response = await this.request("GET", `/users/${this.userId}/`);
    if (response.status !== 200) throw new FunPayRequestError(`FunPay profile returned ${response.status}`, response.status);
    return parseOfferSections(await response.text());
  }
  /** Every offer on the seller's public profile, with its section and price. */
  async profileOffers() {
    await this.ensureSession();
    const response = await this.request("GET", `/users/${this.userId}/`);
    if (response.status !== 200) throw new FunPayRequestError(`FunPay profile returned ${response.status}`, response.status);
    return parseProfileOffers(await response.text());
  }
  /** The game of one subcategory, from the «Поднять предложения» button on the seller's offers page there. */
  async raiseTarget(node) {
    await this.ensureSession();
    const response = await this.request("GET", `/lots/${node}/trade`);
    if (response.status !== 200) throw new FunPayRequestError(`FunPay offers page returned ${response.status}`, response.status);
    return parseRaiseButton(await response.text());
  }
  /**
   * «Поднять предложения»: lifts the seller's offers in these subcategories of
   * one game to the top of their lists, as the button on the offers page does.
   */
  async raiseOffers(game, nodes) {
    await this.ensureSession();
    const offersPage = `/lots/${nodes[0]}/trade`;
    for (let attempt = 0; ; attempt++) {
      const body = new URLSearchParams({ game_id: String(game), node_id: String(nodes[0]) });
      if (nodes.length > 1) for (const node of nodes) body.append("node_ids[]", String(node));
      if (this.csrfToken) body.set("csrf_token", this.csrfToken);
      const response = await this.request("POST", "/lots/raise", {
        headers: {
          accept: "application/json, text/javascript, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          referer: new URL(offersPage, this.baseUrl).toString()
        },
        body: body.toString()
      });
      if (attempt === 0 && response.status === 428) {
        await this.request("GET", offersPage);
        continue;
      }
      if (attempt === 0 && response.status === 400) {
        await this.login();
        continue;
      }
      if (response.status !== 200) throw new FunPayRequestError(`FunPay raise returned ${response.status}`, response.status);
      return parseRaiseAnswer(await response.json().catch(() => null));
    }
  }
  /** One page of the seller's sales list; pass the previous page's cursor for older sales. */
  async salesPage(cursor) {
    await this.ensureSession();
    const response = cursor ? await this.request("POST", "/orders/trade", {
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ continue: cursor }).toString()
    }) : await this.request("GET", "/orders/trade");
    if (response.status !== 200) throw new FunPayRequestError(`FunPay sales list returned ${response.status}`, response.status);
    const page = parseSalesPage(await response.text());
    if (!cursor && (!page.loggedIn || !page.isSalesPage)) {
      throw new FunPayAuthError("The FunPay sales page is not available for this golden_key");
    }
    if (page.csrfToken) this.csrfToken = page.csrfToken;
    return page;
  }
  /** Details for 1-10 orders, including goods FunPay's own auto-delivery already sent. */
  async orderDetails(ids) {
    if (!ids.length) return /* @__PURE__ */ new Map();
    if (ids.length > 10) throw new Error("FunPay returns at most 10 orders per request");
    await this.ensureSession();
    const response = await this.request("POST", "/api/orders/get", {
      headers: { "content-type": "application/json", "accept-language": "ru" },
      body: JSON.stringify({ order_uids: ids, include: ["details", "users", "review"] })
    });
    if (response.status !== 200) throw new FunPayRequestError(`FunPay order API returned ${response.status}`, response.status);
    const json = await response.json().catch(() => null);
    if (json?.status !== "SUCCESS" || !json.data || typeof json.data !== "object") {
      throw new FunPayRequestError("FunPay order API returned no data");
    }
    return new Map(Object.entries(json.data).map(([id, data]) => [id, parseOrderDetails(id, data)]));
  }
  /** The empty offer form of one subcategory, for a new Steam rental lot (see steam/lot.ts newSteamLotFields). */
  async newLotForm(node) {
    await this.ensureSession();
    const response = await this.request("GET", `/lots/offerEdit?node=${node}`);
    if (response.status !== 200) throw new FunPayRequestError(`FunPay new-lot form returned ${response.status}`, response.status);
    return response.text();
  }
  /**
   * Saves a new lot and finds its id on the seller's offers page of that subcategory by the title marker.
   * Null when FunPay saved it but the id could not be found: never save again (that would make a copy).
   */
  async createLot(node, fields, marker) {
    await this.ensureSession();
    this.lastLotCreatedAt = Date.now();
    try {
      const response = await this.request("POST", "/lots/offerSave", {
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
        body: fields.toString(),
        noRetry: true
      });
      const result = await response.json().catch(() => null);
      if ((response.ok || response.status === 400 || response.status === 422) && result && (result.error || result.errors?.length)) {
        const reason = typeof result?.msg === "string" ? result.msg : Array.isArray(result?.errors) ? result.errors.map((entry) => String(Array.isArray(entry) ? entry[1] : entry)).join("; ") : "";
        throw new FunPayLotRejectedError(`FunPay не сохранил новый лот${reason ? `: ${reason.slice(0, 200)}` : ""}`, response.status);
      }
      if (!response.ok || !result) throw new FunPayRequestError(`Результат сохранения лота неизвестен (HTTP ${response.status}, ${response.headers.get("content-type") ?? "нет типа ответа"}) — проверьте FunPay перед повтором`, response.status);
      const id = await this.findSteamLot(node, marker);
      if (!id) throw new FunPayRequestError("Сохранение принято, но лот ещё не найден по маркеру — проверьте FunPay перед повтором");
      return id;
    } catch (error) {
      if (error instanceof FunPayLotRejectedError || error instanceof FunPayRateLimitError) throw error;
      try {
        const id = await this.findSteamLot(node, marker);
        if (id) {
          await this.readSteamLot(String(id), marker);
          return id;
        }
      } catch {
      }
      throw error;
    }
  }
  async findSteamLot(node, marker) {
    await this.ensureSession();
    const page = await this.request("GET", `/lots/${node}/trade`);
    if (page.status !== 200) throw new FunPayRequestError("Не удалось проверить существующие лоты FunPay", page.status);
    const html = await page.text();
    this.accountCategories.set(node, steamAccountCategory(html, node));
    return ownOfferIdByMarker(html, marker);
  }
  isSteamAccountCategory(node) {
    return this.accountCategories.get(node) === true;
  }
  async readSteamLot(lotId, marker) {
    await this.ensureSession();
    const response = await this.request("GET", `/lots/offerEdit?offer=${encodeURIComponent(lotId)}`);
    if (response.status !== 200) throw new FunPayRequestError(`FunPay lot editor returned ${response.status}`, response.status);
    return steamLotFields(await response.text(), lotId, marker);
  }
  /** Steam rental lot: changes only price and active, keeping the rest of FunPay's editor form; reads it back to verify. */
  async updateSteamLot(lotId, marker, price, active) {
    await this.ensureSession();
    const read = () => this.readSteamLot(lotId, marker);
    const fields = await read();
    price ??= Number(fields.get("price"));
    if (!Number.isFinite(price) || price <= 0) throw new FunPayRequestError("Invalid Steam listing price");
    if (Math.abs(Number(fields.get("price")) - price) < 5e-3 && fields.has("active") === active) return;
    fields.set("price", price.toFixed(2));
    if (active) fields.set("active", "on");
    else fields.delete("active");
    const response = await this.request("POST", "/lots/offerSave", {
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
      body: fields.toString()
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.error || result.errors?.length) throw new FunPayRequestError("FunPay refused the Steam lot price/stock update", response.status);
    const saved = await read();
    if (Math.abs(Number(saved.get("price")) - price) > 5e-3 || saved.has("active") !== active) throw new FunPayRequestError("FunPay Steam lot update could not be verified");
  }
  async request(method, path, options = {}) {
    if (!path.startsWith("/lots/")) return this.rawRequest(method, path, options);
    const pending = this.lotRequestTail.then(async () => {
      if (Date.now() < this.lotCooldownUntil) throw new FunPayRateLimitError(this.lotCooldownUntil, false);
      const delay = this.nextLotRequestAt - Date.now();
      if (delay > 0) await sleep(delay);
      try {
        return await this.rawRequest(method, path, options);
      } finally {
        this.nextLotRequestAt = Date.now() + 1500;
      }
    });
    this.lotRequestTail = pending.catch(() => void 0);
    return pending;
  }
  async rawRequest(method, path, options = {}) {
    let url = new URL(path, this.baseUrl);
    let currentMethod = method;
    let body = options.body;
    let serverErrors = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch(url, {
        method: currentMethod,
        headers: {
          cookie: this.cookieHeader(),
          "user-agent": this.options.userAgent || DEFAULT_USER_AGENT,
          "accept-language": "ru,en;q=0.8",
          ...options.headers
        },
        body: currentMethod === "POST" ? body : void 0,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 2e4)
      });
      this.storeCookies(response, options.updateSession === true);
      if (response.status === 429 && path.startsWith("/lots/")) {
        const retry = response.headers.get("retry-after");
        const retryAt = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1e3 : Date.parse(retry ?? "");
        const backoff = Math.min(30, 5 * 2 ** Math.min(this.lotRateLimits++, 3)) * 6e4;
        this.lotCooldownUntil = Math.max(Date.now() + backoff, Number.isFinite(retryAt) ? retryAt : 0);
        await response.body?.cancel();
        throw new FunPayRateLimitError(this.lotCooldownUntil, true);
      }
      if (path.startsWith("/lots/") && response.status < 400) this.lotRateLimits = 0;
      if (options.noRetry) return response;
      if (response.status === 429) {
        await sleep(Math.min(2 ** (attempt + 1), 30) * 1e3);
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return response;
        const next = new URL(location, url);
        if (next.pathname.includes("/account/login")) throw new FunPayAuthError("FunPay redirected to the login page");
        if (next.host !== this.baseUrl.host) throw new FunPayRequestError(`Unexpected redirect to ${next.host}`);
        url = next;
        currentMethod = "GET";
        body = void 0;
        continue;
      }
      if (response.status === 403) throw new FunPayAuthError("FunPay returned 403 Forbidden");
      if (response.status >= 500 && serverErrors < 3) {
        serverErrors += 1;
        await sleep(2e3 * serverErrors);
        continue;
      }
      return response;
    }
    throw new FunPayRequestError(`FunPay request did not complete: ${path}`);
  }
  cookieHeader() {
    const jar = new Map(this.cookies);
    jar.set("golden_key", this.options.goldenKey);
    jar.set("cookie_prefs", "1");
    if (this.phpsessid) jar.set("PHPSESSID", this.phpsessid);
    return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  storeCookies(response, updateSession) {
    const headers = response.headers;
    const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : (headers.get("set-cookie") ?? "").split(/,(?=\s*[^;,\s]+=)/).filter(Boolean);
    for (const header of setCookies) {
      const pair = header.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name === "golden_key" || name === "fav_games") continue;
      if (name === "PHPSESSID") {
        if (updateSession || !this.phpsessid) this.phpsessid = value;
        continue;
      }
      if (!value || value === "deleted") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
};
function chatNodeObject(node) {
  return { type: "chat_node", id: node, tag: "00000000", data: { node, last_message: -1, content: "" } };
}
function randomTag() {
  return Math.random().toString(36).slice(2, 12).padEnd(10, "0");
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ../src/lib/funpay/errors.ts
var NETWORK_CAUSES = {
  UND_ERR_CONNECT_TIMEOUT: "сервер не ответил на подключение",
  ETIMEDOUT: "сервер не ответил на подключение",
  UND_ERR_HEADERS_TIMEOUT: "сервер не прислал ответ вовремя",
  UND_ERR_BODY_TIMEOUT: "сервер не дослал ответ",
  ECONNRESET: "соединение оборвалось",
  UND_ERR_SOCKET: "соединение оборвалось",
  EPIPE: "соединение оборвалось",
  ECONNREFUSED: "подключение отклонено",
  ENOTFOUND: "адрес не найден (DNS)",
  EAI_AGAIN: "DNS временно не отвечает",
  EHOSTUNREACH: "сервер недоступен",
  ENETUNREACH: "сеть недоступна"
};
function redactSecrets2(text) {
  return text.replace(/\bk[o]sell_[A-Za-z0-9_-]{8,}/g, "[ключ скрыт]").replace(/((?:Пароль|Password|Steam Guard[^:\n]*):\s*)[^\n]+/gi, "$1[скрыто]").replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[токен скрыт]").replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[ключ скрыт]").replace(/(golden_key|PHPSESSID|csrf_token)=[^;&\s]+/gi, "$1=[скрыто]").replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[скрыто]");
}
function causeText(error) {
  const cause = error.cause;
  if (!cause || typeof cause !== "object") return null;
  const { code, message } = cause;
  if (typeof code === "string") return NETWORK_CAUSES[code] ? `${NETWORK_CAUSES[code]}, ${code}` : code;
  return typeof message === "string" && message ? message : null;
}
function isDatabaseError(error) {
  return error instanceof Error && error.name.startsWith("PrismaClient");
}
var DATABASE_BUSY_RE = /Operations timed out after|database is locked|SQLITE_BUSY/i;
function databaseText(error) {
  const call = /`prisma\.([\w.]+)\(\)`/.exec(error.message)?.[1];
  const reason = DATABASE_BUSY_RE.test(error.message) ? "база данных была занята и не ответила вовремя" : error.message.split("\n").map((line2) => line2.trim()).filter(Boolean).pop() ?? error.name;
  return call ? `${reason} (${call})` : reason;
}
function errorText(error) {
  let message;
  if (!(error instanceof Error)) {
    message = String(error);
  } else if (error.name === "TimeoutError" || error.name === "AbortError") {
    message = "превышено время ожидания";
  } else if (isDatabaseError(error)) {
    message = databaseText(error);
  } else {
    const cause = causeText(error);
    message = cause ? `${error.message} (${cause})` : error.message;
  }
  return redactSecrets2(message).slice(0, 300);
}


// ../src/lib/funpay/images.ts
var FUNPAY_IMAGE_HOSTS = ["sfunpay.com", "funpay.com"];
var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
var MAX_REDIRECTS = 3;
var IMAGE_TYPES = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function allowedImageUrl(url, testOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (testOrigin && parsed.origin === testOrigin) return parsed;
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  return FUNPAY_IMAGE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? parsed : null;
}
async function chatImageDataUrl(url, testOrigin) {
  let target = allowedImageUrl(url, testOrigin);
  for (let hop = 0; target && hop <= MAX_REDIRECTS; hop++) {
    let response;
    try {
      response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(15e3) });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => void 0);
      const location = response.headers.get("location");
      target = location ? allowedImageUrl(new URL(location, target).toString(), testOrigin) : null;
      continue;
    }
    return response.ok ? readImage(response) : null;
  }
  return null;
}
async function readImage(response) {
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!IMAGE_TYPES.has(type) || declared > MAX_IMAGE_BYTES || !response.body) {
    await response.body?.cancel().catch(() => void 0);
    return null;
  }
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => void 0);
      return null;
    }
    chunks.push(value);
  }
  return size ? `data:${type};base64,${Buffer.concat(chunks).toString("base64")}` : null;
}


// ../src/lib/funpay/rules.ts
var BUYER_COMMANDS = [
  ["seller", /^!\s*(?:seller|продавец|продавца|менеджер|admin|админ)(?![\p{L}\p{N}])/iu],
  ["balance", /^!\s*(?:balance|баланс)(?![\p{L}\p{N}])/iu],
  ["help", /^!\s*(?:help|помощь|команды|commands)(?![\p{L}\p{N}])/iu]
];
var SELLER_RESUME_RE = /^!\s*(?:bot|бот)\s*$/iu;
var SELLER_STOP_RE = /^!\s*(?:stop|стоп)\s*$/iu;
var REFUND_RE = new RegExp(
  [
    "возврат",
    "верн\\p{L}*\\s+(?:мне\\s+|пожалуйста\\s+)?(?:мои\\s+|наши\\s+)?(?:деньг|средств|оплат)",
    "деньг\\p{L}*\\s+(?:назад|верн)",
    "refund",
    "money\\s*back",
    "chargeback",
    "арбитраж",
    "(?<!\\p{L})спор(?!\\p{L})",
    "(?<!\\p{L})(?:обман|мошен)",
    "(?<!\\p{L})(?:за)?скам(?!ей|ь)",
    "(?<![a-z])scam"
  ].join("|"),
  "iu"
);
var BARE_COMMANDS = [
  ["seller", /^(?:seller|продавец|продавца)[!?.]*$/iu],
  ["balance", /^(?:balance|баланс)[!?.]*$/iu],
  ["help", /^(?:help|помощь|команды)[!?.]*$/iu]
];
function buyerCommand(text) {
  const value = text?.trim() ?? "";
  const commands = value.startsWith("!") ? BUYER_COMMANDS : BARE_COMMANDS;
  return commands.find(([, pattern]) => pattern.test(value))?.[0] ?? null;
}
function mentionsRefund(text) {
  return Boolean(text && REFUND_RE.test(text));
}
var ORDER_TIME_SLACK_MS = 2 * 6e4;


// src/config.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var BOT_DIR = dirname(fileURLToPath(import.meta.url));
var DATA_DIR = process.env.RESELLER_BOT_DATA_DIR?.trim() || join(BOT_DIR, "data");
var CONFIG_FILE = join(DATA_DIR, "config.json");
var STATE_FILE = join(DATA_DIR, "state.json");
var JOURNAL_FILE = join(DATA_DIR, "journal.jsonl");
var KNOWLEDGE_FILE = process.env.RESELLER_BOT_KNOWLEDGE?.trim() || join(BOT_DIR, "knowledge.md");
var TEMPLATES_FILE = process.env.RESELLER_BOT_TEMPLATES?.trim() || join(BOT_DIR, "lot-templates.json");
var VERSION = "1.4.0";
var DEFAULT_API_BASE = "https://api.gserver.online";
var DEFAULT_MODEL = "gemini-3.8-flash";
var DEFAULT_DASHBOARD_PORT = 4777;
var LOCAL_FUNPAY_PROXY = "http://127.0.0.1:10820";
function readConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  if (!raw.goldenKey || !raw.devKey) return null;
  return validateConfig({
    goldenKey: raw.goldenKey,
    devKey: raw.devKey,
    apiBase: (raw.apiBase || DEFAULT_API_BASE).replace(/\/+$/, ""),
    shopName: raw.shopName?.trim() || "Магазин API",
    ai: { key: raw.ai?.key || null, keyId: raw.ai?.keyId ?? null, model: raw.ai?.model || DEFAULT_MODEL },
    dryRun: raw.dryRun === true,
    dashboardPort: Number.isInteger(raw.dashboardPort) ? raw.dashboardPort : DEFAULT_DASHBOARD_PORT,
    pollMs: clamp(raw.pollMs, 5e3, 3e3, 6e4),
    topUpKeys: raw.topUpKeys !== false,
    catchUpMinutes: clamp(raw.catchUpMinutes, 30, 5, 24 * 60),
    sellerTakeoverMinutes: clamp(raw.sellerTakeoverMinutes, 30, 1, 24 * 60),
    funpayProxy: raw.funpayProxy?.trim() || void 0,
    funpayBaseUrl: raw.funpayBaseUrl || void 0,
    aiBaseUrl: raw.aiBaseUrl || void 0,
    checkSeconds: raw.checkSeconds
  });
}
function writeConfig(config) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
  chmodSync(CONFIG_FILE, 384);
}
function clamp(value, fallback, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function linksFor(config) {
  return { apiBaseUrl: `${config.apiBase}/v1`, rootUrl: config.apiBase, siteHost: new URL(config.apiBase).host };
}


// src/journal.ts
import { appendFileSync, existsSync as existsSync2, readFileSync as readFileSync2, renameSync, statSync } from "node:fs";
var MAX_BYTES = 5 * 1024 * 1024;
var LEVEL_MARK = { info: "\xB7", warn: "!", error: "✖" };
var writes = 0;
function journal(level, event, message, context = {}) {
  const entry = { at: Date.now(), level, event, message: redactSecrets2(message).slice(0, 2e3), ...context };
  const time = new Date(entry.at).toLocaleString("ru-RU", { hour12: false });
  const line2 = `[${time}] ${LEVEL_MARK[level]} ${entry.message}`;
  if (level === "error") console.error(line2);
  else console.log(line2);
  try {
    if (++writes % 200 === 0 && existsSync2(JOURNAL_FILE) && statSync(JOURNAL_FILE).size > MAX_BYTES) {
      renameSync(JOURNAL_FILE, JOURNAL_FILE.replace(/\.jsonl$/, ".old.jsonl"));
    }
    appendFileSync(JOURNAL_FILE, `${JSON.stringify(entry)}
`, { mode: 384 });
  } catch {
  }
}
var logInfo = (event, message, context) => journal("info", event, message, context);
var logWarn = (event, message, context) => journal("warn", event, message, context);
var logError = (event, message, context) => journal("error", event, message, context);
function recentEntries(limit, onlyProblems = false) {
  if (!existsSync2(JOURNAL_FILE)) return [];
  const lines = readFileSync2(JOURNAL_FILE, "utf8").trimEnd().split("\n");
  const entries = [];
  for (let at = lines.length - 1; at >= 0 && entries.length < limit; at--) {
    try {
      const entry = JSON.parse(lines[at]);
      if (!onlyProblems || entry.level !== "info") entries.push(entry);
    } catch {
    }
  }
  return entries;
}
function errorsSince(since) {
  return recentEntries(5e3, true).filter((entry) => entry.level === "error" && entry.at >= since).length;
}


// ../src/lib/smm-lots.ts
var PUBLIC_TG = {
  ru: "Канал должен быть публичным (с @username) до конца выполнения.",
  en: "The channel must stay public (with an @username) until the order is complete."
};
var OPEN_PROFILE = {
  ru: "Профиль должен быть открытым до конца выполнения; не удаляйте и не скрывайте публикацию.",
  en: "Keep the profile public until the order is complete; do not delete or hide the post."
};
var OPEN_VIDEO = {
  ru: "Видео должно быть открытым (не \xABдоступ по ссылке\xBB и не 18+) до конца выполнения.",
  en: "The video must be public (not unlisted, not age-restricted) until the order is complete."
};
function warrantyText(warranty, language) {
  const ru = language === "ru";
  if (typeof warranty === "number") {
    return ru ? { title: `гарантия ${warranty} дней`, line: `Гарантия ${warranty} дней: если часть спишется, восстановим бесплатно — напишите !продавец.` } : { title: `${warranty}-day guarantee`, line: `${warranty}-day guarantee: if some drop, we refill for free — write !seller.` };
  }
  if (warranty === "forever") {
    return ru ? { title: "гарантия навсегда", line: "Гарантия навсегда: если часть спишется, восстановим бесплатно — напишите !продавец." } : { title: "lifetime guarantee", line: "Lifetime guarantee: if some drop, we refill for free — write !seller." };
  }
  if (warranty === "nodrop") {
    return ru ? { title: "без списаний", line: "Без списаний: если часть всё же спишется, восстановим бесплатно — напишите !продавец." } : { title: "non-drop", line: "Non-drop: if some still drop, we refill for free — write !seller." };
  }
  if (warranty === "none") {
    return ru ? { title: "без гарантии", line: "Без гарантии: возможны списания, восстановление не предусмотрено." } : { title: "no guarantee", line: "No guarantee: some may drop, no refill." };
  }
  return ru ? { title: "", line: "Без гарантии от списаний." } : { title: "", line: "No refill guarantee for this service." };
}
var SMM_LOT_PLAN = [
  {
    marker: "[S01]",
    link: "tgChannel",
    network: "Telegram",
    node: 703,
    type: "Подписчики",
    serviceId: 2258,
    perUnit: 100,
    what: { ru: "подписчики", en: "subscribers" },
    target: { ru: "ссылка на канал (https://t.me/…)", en: "channel link (https://t.me/…)" },
    warranty: 30,
    speed: { ru: "Быстрые.", en: "Fast." },
    note: PUBLIC_TG
  },
  {
    marker: "[S02]",
    link: "tgPost",
    network: "Telegram",
    node: 703,
    type: "Просмотры",
    serviceId: 3023,
    perUnit: 1e3,
    what: { ru: "просмотры", en: "views" },
    target: { ru: "ссылка на пост (https://t.me/канал/123)", en: "post link (https://t.me/channel/123)" },
    warranty: null,
    speed: { ru: "Быстрые, на один пост.", en: "Fast, for one post." },
    note: PUBLIC_TG
  },
  {
    marker: "[S03]",
    link: "tgPost",
    network: "Telegram",
    node: 703,
    type: "Реакции",
    serviceId: 1832,
    perUnit: 1e3,
    what: { ru: "реакции 👍❤️🔥🎉", en: "reactions 👍❤️🔥🎉" },
    target: { ru: "ссылка на пост (https://t.me/канал/123)", en: "post link (https://t.me/channel/123)" },
    warranty: null,
    speed: { ru: "Случайный микс 👍 ❤️ 🔥 🎉 на один пост.", en: "Random mix of 👍 ❤️ 🔥 🎉 on one post." },
    note: PUBLIC_TG
  },
  {
    marker: "[S04]",
    link: "tiktokVideo",
    network: "TikTok",
    node: 732,
    type: "Просмотры",
    serviceId: 2373,
    perUnit: 1e3,
    what: { ru: "просмотры", en: "views" },
    target: { ru: "ссылка на видео (https://www.tiktok.com/@ник/video/…)", en: "video link (https://www.tiktok.com/@name/video/…)" },
    warranty: 30,
    speed: { ru: "Быстрые.", en: "Fast." },
    note: OPEN_PROFILE
  },
  {
    marker: "[S05]",
    link: "tiktokVideo",
    network: "TikTok",
    node: 732,
    type: "Лайки",
    serviceId: 2632,
    perUnit: 100,
    what: { ru: "лайки", en: "likes" },
    target: { ru: "ссылка на видео (https://www.tiktok.com/@ник/video/…)", en: "video link (https://www.tiktok.com/@name/video/…)" },
    warranty: 30,
    speed: { ru: "Быстрые.", en: "Fast." },
    note: OPEN_PROFILE
  },
  {
    marker: "[S06]",
    link: "tiktokProfile",
    network: "TikTok",
    node: 732,
    type: "Подписчики",
    serviceId: 2480,
    perUnit: 100,
    what: { ru: "подписчики", en: "followers" },
    target: { ru: "ссылка на профиль (https://www.tiktok.com/@ник)", en: "profile link (https://www.tiktok.com/@name)" },
    warranty: 30,
    speed: { ru: "Плавно, без резких скачков.", en: "Gradual." },
    note: OPEN_PROFILE
  },
  {
    marker: "[S07]",
    link: "ytVideo",
    network: "YouTube",
    node: 705,
    type: "Просмотры",
    serviceId: 3006,
    perUnit: 1e3,
    what: { ru: "просмотры", en: "views" },
    target: { ru: "ссылка на видео (https://youtu.be/…)", en: "video link (https://youtu.be/…)" },
    warranty: 30,
    speed: { ru: "До 5 000 в день, без списаний.", en: "Up to 5,000 per day, non-drop." },
    note: OPEN_VIDEO
  },
  {
    marker: "[S08]",
    link: "ytVideo",
    network: "YouTube",
    node: 705,
    type: "Лайки",
    serviceId: 2058,
    perUnit: 100,
    what: { ru: "лайки", en: "likes" },
    target: { ru: "ссылка на видео (https://youtu.be/…)", en: "video link (https://youtu.be/…)" },
    warranty: 30,
    speed: { ru: "Стабильные.", en: "Stable." },
    note: OPEN_VIDEO
  },
  {
    marker: "[S09]",
    link: "ytChannel",
    network: "YouTube",
    node: 705,
    type: "Подписчики",
    serviceId: 2756,
    perUnit: 100,
    what: { ru: "подписчики", en: "subscribers" },
    target: { ru: "ссылка на канал (https://www.youtube.com/@канал)", en: "channel link (https://www.youtube.com/@channel)" },
    warranty: 30,
    speed: { ru: "Плавно, 100–200 в день.", en: "Gradual, 100–200 per day." },
    note: { ru: "Канал должен быть открытым, подписчики не скрыты.", en: "The channel must be public with the subscriber count visible." }
  },
  {
    marker: "[S10]",
    link: "igProfile",
    network: "Instagram",
    node: 704,
    type: "Подписчики",
    serviceId: 2278,
    perUnit: 100,
    what: { ru: "подписчики", en: "followers" },
    target: { ru: "ссылка на профиль (https://www.instagram.com/ник)", en: "profile link (https://www.instagram.com/name)" },
    warranty: 30,
    speed: { ru: "Быстрые.", en: "Fast." },
    note: { ru: "Профиль должен быть открытым; на время выполнения уберите галочку \xABПометить для проверки\xBB в настройках подписчиков.", en: "The profile must be public; turn off \xABFlag for review\xBB for new followers while the order runs." }
  },
  {
    marker: "[S11]",
    link: "igPost",
    network: "Instagram",
    node: 704,
    type: "Лайки",
    serviceId: 2684,
    perUnit: 100,
    what: { ru: "лайки", en: "likes" },
    target: { ru: "ссылка на пост или Reels (https://www.instagram.com/p/…)", en: "post or Reels link (https://www.instagram.com/p/…)" },
    warranty: 30,
    speed: { ru: "Быстрые.", en: "Fast." },
    note: OPEN_PROFILE
  },
  {
    marker: "[S12]",
    link: "igPost",
    network: "Instagram",
    node: 704,
    type: "Просмотры",
    serviceId: 2153,
    perUnit: 1e4,
    what: { ru: "просмотры", en: "views" },
    target: { ru: "ссылка на Reels или видео (https://www.instagram.com/reel/…)", en: "Reels or video link (https://www.instagram.com/reel/…)" },
    warranty: null,
    speed: { ru: "Быстрые.", en: "Fast." },
    note: OPEN_PROFILE
  }
];
var TG_CHANNEL = { ru: "ссылка на канал (https://t.me/…)", en: "channel link (https://t.me/…)" };
var TG_ANY = { ru: "ссылка на канал или группу — открытую (https://t.me/…) или закрытую (https://t.me/+…)", en: "channel or group link — public (https://t.me/…) or private invite (https://t.me/+…)" };
var TG_GROUP = { ru: "ссылка на группу (https://t.me/…)", en: "group link (https://t.me/…)" };
var TG_POST = { ru: "ссылка на пост (https://t.me/канал/123)", en: "post link (https://t.me/channel/123)" };
var TT_VIDEO = { ru: "ссылка на видео (https://www.tiktok.com/@ник/video/…)", en: "video link (https://www.tiktok.com/@name/video/…)" };
var TT_PROFILE = { ru: "ссылка на профиль (https://www.tiktok.com/@ник)", en: "profile link (https://www.tiktok.com/@name)" };
var YT_VIDEO = { ru: "ссылка на видео (https://youtu.be/…)", en: "video link (https://youtu.be/…)" };
var YT_CHANNEL = { ru: "ссылка на канал (https://www.youtube.com/@канал)", en: "channel link (https://www.youtube.com/@channel)" };
var IG_PROFILE = { ru: "ссылка на профиль (https://www.instagram.com/ник)", en: "profile link (https://www.instagram.com/name)" };
var IG_POST = { ru: "ссылка на пост или Reels (https://www.instagram.com/p/…)", en: "post or Reels link (https://www.instagram.com/p/…)" };
var IG_REEL = { ru: "ссылка на Reels или видео (https://www.instagram.com/reel/…)", en: "Reels or video link (https://www.instagram.com/reel/…)" };
var ANY_TG = { ru: "Канал или группа могут быть закрытыми — пришлите ссылку-приглашение.", en: "The channel or group may be private — send the invite link." };
var IG_FOLLOW = { ru: "Профиль должен быть открытым; на время выполнения уберите галочку \xABПометить для проверки\xBB в настройках подписчиков.", en: "The profile must be public; turn off \xABFlag for review\xBB for new followers while the order runs." };
var YT_SUBS = { ru: "Канал должен быть открытым, подписчики не скрыты.", en: "The channel must be public with the subscriber count visible." };
var FAST = { ru: "Быстрый старт.", en: "Fast start." };
var GRADUAL = { ru: "Плавно, без резких скачков.", en: "Gradual." };
var SUBS = { ru: "подписчики", en: "subscribers" };
var FOLLOWERS = { ru: "подписчики", en: "followers" };
var VIEWS = { ru: "просмотры", en: "views" };
var LIKES = { ru: "лайки", en: "likes" };
var RU = { ru: "русские 🇷🇺", en: "Russian 🇷🇺" };
var NODROP = { ru: "без списаний", en: "non-drop" };
var lots = (network, node, first, entries) => entries.map((entry, index) => ({ marker: `[S${String(first + index).padStart(2, "0")}]`, network, node, ...entry }));
SMM_LOT_PLAN.push(
  ...lots("Telegram", 703, 13, [
    { type: "Подписчики", serviceId: 2258, perUnit: 500, link: "tgChannel", what: SUBS, target: TG_CHANNEL, warranty: 30, speed: FAST, note: PUBLIC_TG },
    { type: "Подписчики", serviceId: 2258, perUnit: 1e3, link: "tgChannel", what: SUBS, target: TG_CHANNEL, warranty: 30, speed: FAST, note: PUBLIC_TG },
    { type: "Подписчики", serviceId: 2911, perUnit: 500, link: "tgChannel", what: SUBS, target: TG_CHANNEL, warranty: 90, speed: FAST, note: PUBLIC_TG },
    { type: "Подписчики", serviceId: 2911, perUnit: 1e3, link: "tgChannel", what: SUBS, target: TG_CHANNEL, warranty: 90, speed: FAST, note: PUBLIC_TG },
    { type: "Подписчики", serviceId: 2080, perUnit: 500, link: "tgChannel", what: SUBS, target: TG_CHANNEL, warranty: "nodrop", speed: FAST, note: PUBLIC_TG },
    { type: "Подписчики", serviceId: 1784, perUnit: 100, link: "tgChannel", what: SUBS, tag: RU, target: TG_CHANNEL, warranty: 30, speed: FAST, note: PUBLIC_TG },
    { type: "Подписчики", serviceId: 2313, perUnit: 100, link: "tgChannel", what: SUBS, tag: RU, target: TG_CHANNEL, warranty: "forever", speed: FAST, note: PUBLIC_TG },
    { type: "Подписчики", serviceId: 3147, perUnit: 100, link: "tgChannel", what: { ru: "участники в группу", en: "group members" }, target: TG_GROUP, warranty: "nodrop", speed: FAST, note: { ru: "Группа должна быть публичной (с @username) до конца выполнения.", en: "The group must stay public (with an @username) until the order is complete." } },
    { type: "Подписчики", serviceId: 2114, perUnit: 500, link: "tgAnyChannel", what: SUBS, tag: { ru: "в закрытые и открытые каналы", en: "private & public" }, target: TG_ANY, warranty: 30, speed: FAST, note: ANY_TG },
    { type: "Просмотры", serviceId: 3023, perUnit: 1e4, link: "tgPost", what: VIEWS, target: TG_POST, warranty: null, speed: { ru: "Быстрые, на один пост.", en: "Fast, for one post." }, note: PUBLIC_TG },
    { type: "Просмотры", serviceId: 2409, perUnit: 1e3, link: "tgChannel", what: { ru: "просмотры на 5 последних постов", en: "views on the last 5 posts" }, target: TG_CHANNEL, warranty: null, speed: { ru: "Каждый из 5 последних постов получает указанное количество.", en: "Each of the last 5 posts gets the amount." }, note: PUBLIC_TG },
    { type: "Реакции", serviceId: 1500, perUnit: 100, link: "tgPost", what: { ru: "реакции 👍❤️🔥🥰", en: "reactions 👍❤️🔥🥰" }, tag: { ru: "премиум", en: "premium" }, target: TG_POST, warranty: null, speed: { ru: "Микс позитивных реакций от премиум-аккаунтов на один пост.", en: "Mix of positive reactions from Premium accounts on one post." }, note: PUBLIC_TG },
    { type: "Репосты", serviceId: 2913, perUnit: 1e3, link: "tgPost", what: { ru: "репосты", en: "shares" }, target: TG_POST, warranty: null, speed: { ru: "Быстрые, со статистикой.", en: "Fast, counted in stats." }, note: PUBLIC_TG },
    { type: "Буст", serviceId: 3101, perUnit: 10, link: "tgAnyChannel", what: { ru: "бусты", en: "boosts" }, tag: { ru: "на 1 день", en: "for 1 day" }, target: TG_ANY, warranty: null, speed: { ru: "Бусты действуют 1 день.", en: "Boosts last 1 day." }, note: ANY_TG },
    { type: "Буст", serviceId: 1620, perUnit: 10, link: "tgAnyChannel", what: { ru: "бусты", en: "boosts" }, tag: { ru: "на 7 дней", en: "for 7 days" }, target: TG_ANY, warranty: null, speed: { ru: "Бусты действуют 7 дней.", en: "Boosts last 7 days." }, note: ANY_TG },
    { type: "Комментарии", serviceId: 2261, perUnit: 10, link: "tgPost", what: { ru: "комментарии", en: "comments" }, tag: { ru: "случайные 🇷🇺", en: "random 🇷🇺" }, target: TG_POST, warranty: null, speed: { ru: "Случайные комментарии на русском под одним постом.", en: "Random Russian comments under one post." }, note: { ru: "Комментарии под постом должны быть открыты.", en: "Comments must be enabled under the post." } }
  ]),
  ...lots("TikTok", 732, 29, [
    { type: "Просмотры", serviceId: 2373, perUnit: 1e4, link: "tiktokVideo", what: VIEWS, target: TT_VIDEO, warranty: 30, speed: FAST, note: OPEN_PROFILE },
    { type: "Просмотры", serviceId: 2631, perUnit: 1e3, link: "tiktokVideo", what: VIEWS, tag: NODROP, target: TT_VIDEO, warranty: 30, speed: FAST, note: OPEN_PROFILE },
    { type: "Лайки", serviceId: 2632, perUnit: 500, link: "tiktokVideo", what: LIKES, target: TT_VIDEO, warranty: 30, speed: FAST, note: OPEN_PROFILE },
    { type: "Лайки", serviceId: 2632, perUnit: 1e3, link: "tiktokVideo", what: LIKES, target: TT_VIDEO, warranty: 30, speed: FAST, note: OPEN_PROFILE },
    { type: "Лайки", serviceId: 2470, perUnit: 100, link: "tiktokVideo", what: LIKES, target: TT_VIDEO, warranty: "none", speed: FAST, note: OPEN_PROFILE },
    { type: "Подписчики", serviceId: 2480, perUnit: 500, link: "tiktokProfile", what: FOLLOWERS, target: TT_PROFILE, warranty: 30, speed: GRADUAL, note: OPEN_PROFILE },
    { type: "Подписчики", serviceId: 2480, perUnit: 1e3, link: "tiktokProfile", what: FOLLOWERS, target: TT_PROFILE, warranty: 30, speed: GRADUAL, note: OPEN_PROFILE },
    { type: "Подписчики", serviceId: 3105, perUnit: 100, link: "tiktokProfile", what: FOLLOWERS, target: TT_PROFILE, warranty: "none", speed: GRADUAL, note: OPEN_PROFILE },
    { type: "Подписчики", serviceId: 2932, perUnit: 100, link: "tiktokProfile", what: FOLLOWERS, tag: NODROP, target: TT_PROFILE, warranty: 30, speed: GRADUAL, note: OPEN_PROFILE },
    { type: "Репосты", serviceId: 2965, perUnit: 100, link: "tiktokVideo", what: { ru: "репосты", en: "reposts" }, target: TT_VIDEO, warranty: "forever", speed: FAST, note: OPEN_PROFILE },
    { type: "Прочее", serviceId: 1811, perUnit: 1e3, link: "tiktokVideo", what: { ru: "сохранения в избранное", en: "saves to favourites" }, target: TT_VIDEO, warranty: 30, speed: FAST, note: OPEN_PROFILE },
    { type: "Комментарии", serviceId: 2972, perUnit: 10, link: "tiktokVideo", what: { ru: "комментарии", en: "comments" }, tag: { ru: "случайные", en: "random" }, target: TT_VIDEO, warranty: null, speed: { ru: "Случайные комментарии под одним видео.", en: "Random comments under one video." }, note: { ru: "Профиль открыт, комментарии под видео открыты.", en: "Public profile, comments enabled." } }
  ]),
  ...lots("YouTube", 705, 41, [
    { type: "Просмотры", serviceId: 3006, perUnit: 5e3, link: "ytVideo", what: VIEWS, target: YT_VIDEO, warranty: 30, speed: { ru: "До 5 000 в день, без списаний.", en: "Up to 5,000 per day, non-drop." }, note: OPEN_VIDEO },
    { type: "Просмотры", serviceId: 2227, perUnit: 1e3, link: "ytVideo", what: VIEWS, tag: { ru: "быстрые", en: "fast" }, target: YT_VIDEO, warranty: 30, speed: { ru: "До 10 000 в день.", en: "Up to 10,000 per day." }, note: OPEN_VIDEO },
    { type: "Лайки", serviceId: 2058, perUnit: 500, link: "ytVideo", what: LIKES, target: YT_VIDEO, warranty: 30, speed: { ru: "Стабильные.", en: "Stable." }, note: OPEN_VIDEO },
    { type: "Лайки", serviceId: 2284, perUnit: 100, link: "ytVideo", what: LIKES, target: YT_VIDEO, warranty: "none", speed: { ru: "Стабильные.", en: "Stable." }, note: OPEN_VIDEO },
    { type: "Подписчики", serviceId: 2757, perUnit: 500, link: "ytChannel", what: SUBS, target: YT_CHANNEL, warranty: 30, speed: { ru: "300–500 в день.", en: "300–500 per day." }, note: YT_SUBS },
    { type: "Подписчики", serviceId: 2975, perUnit: 100, link: "ytChannel", what: SUBS, tag: { ru: "быстрые", en: "fast" }, target: YT_CHANNEL, warranty: 30, speed: { ru: "До 2 000 в день.", en: "Up to 2,000 per day." }, note: YT_SUBS },
    { type: "Комментарии", serviceId: 1451, perUnit: 20, link: "ytVideo", what: { ru: "комментарии", en: "comments" }, tag: { ru: "микс", en: "mix" }, target: YT_VIDEO, warranty: 30, speed: { ru: "Случайные комментарии под одним видео.", en: "Random comments under one video." }, note: { ru: "Видео открыто, комментарии к нему открыты.", en: "Public video, comments enabled." } }
  ]),
  ...lots("Instagram", 704, 48, [
    { type: "Подписчики", serviceId: 2278, perUnit: 500, link: "igProfile", what: FOLLOWERS, target: IG_PROFILE, warranty: 30, speed: FAST, note: IG_FOLLOW },
    { type: "Подписчики", serviceId: 2278, perUnit: 1e3, link: "igProfile", what: FOLLOWERS, target: IG_PROFILE, warranty: 30, speed: FAST, note: IG_FOLLOW },
    { type: "Подписчики", serviceId: 3120, perUnit: 100, link: "igProfile", what: FOLLOWERS, tag: { ru: "минимум списаний", en: "minimal drop" }, target: IG_PROFILE, warranty: 30, speed: FAST, note: IG_FOLLOW },
    { type: "Лайки", serviceId: 2684, perUnit: 500, link: "igPost", what: LIKES, target: IG_POST, warranty: 30, speed: FAST, note: OPEN_PROFILE },
    { type: "Лайки", serviceId: 2684, perUnit: 1e3, link: "igPost", what: LIKES, target: IG_POST, warranty: 30, speed: FAST, note: OPEN_PROFILE },
    { type: "Лайки", serviceId: 2283, perUnit: 100, link: "igPost", what: LIKES, tag: { ru: "живые, без списаний", en: "real accounts, non-drop" }, target: IG_POST, warranty: 30, speed: FAST, note: OPEN_PROFILE },
    { type: "Лайки", serviceId: 2988, perUnit: 100, link: "igPost", what: LIKES, tag: RU, target: IG_POST, warranty: "none", speed: FAST, note: OPEN_PROFILE },
    { type: "Лайки", serviceId: 2492, perUnit: 100, link: "igPost", what: LIKES, target: IG_POST, warranty: "none", speed: FAST, note: OPEN_PROFILE },
    { type: "Просмотры", serviceId: 2153, perUnit: 1e5, link: "igPost", what: VIEWS, target: IG_REEL, warranty: null, speed: FAST, note: OPEN_PROFILE },
    { type: "Просмотры", serviceId: 3012, perUnit: 1e3, link: "igProfile", what: { ru: "просмотры сторис", en: "story views" }, tag: { ru: "живые", en: "real" }, target: IG_PROFILE, warranty: null, speed: { ru: "На все текущие сторис профиля.", en: "On all current stories of the profile." }, note: { ru: "Профиль открыт, сторис опубликованы до запуска.", en: "Public profile, stories posted before the start." } }
  ]),
  ...lots("Twitter", 1260, 58, [
    { type: "Просмотры", serviceId: 1323, perUnit: 1e3, link: "xPost", what: VIEWS, target: { ru: "ссылка на пост (https://x.com/имя/status/123)", en: "post link (https://x.com/name/status/123)" }, warranty: "none", speed: FAST, note: OPEN_PROFILE },
    { type: "Подписчики", serviceId: 2343, perUnit: 100, link: "xProfile", what: FOLLOWERS, target: { ru: "ссылка на профиль (https://x.com/имя)", en: "profile link (https://x.com/name)" }, warranty: "none", speed: { ru: "Старт может задержаться при нагрузке; возможны списания во время и после выполнения. Отмена недоступна.", en: "Start may be delayed under load; followers may drop during or after completion. Cancellation is unavailable." }, note: OPEN_PROFILE },
    { type: "Подписчики", serviceId: 2636, perUnit: 100, link: "xProfile", what: FOLLOWERS, target: { ru: "ссылка на профиль (https://x.com/имя)", en: "profile link (https://x.com/name)" }, warranty: 7, speed: GRADUAL, note: OPEN_PROFILE },
    { type: "Лайки", serviceId: 2637, perUnit: 100, link: "xPost", what: LIKES, target: { ru: "ссылка на пост (https://x.com/имя/status/123)", en: "post link (https://x.com/name/status/123)" }, warranty: 30, speed: FAST, note: OPEN_PROFILE },
    { type: "Ретвиты", serviceId: 2639, perUnit: 100, link: "xPost", what: { ru: "ретвиты", en: "reposts" }, target: { ru: "ссылка на пост (https://x.com/имя/status/123)", en: "post link (https://x.com/name/status/123)" }, warranty: "none", speed: FAST, note: OPEN_PROFILE }
  ]),
  ...lots("Kick", 4031, 63, [
    { type: "Подписчики", serviceId: 2401, perUnit: 100, link: "kickProfile", what: FOLLOWERS, target: { ru: "ссылка на канал (https://kick.com/имя)", en: "channel link (https://kick.com/name)" }, warranty: 30, speed: GRADUAL, note: OPEN_PROFILE },
    { type: "Подписчики", serviceId: 2401, perUnit: 500, link: "kickProfile", what: FOLLOWERS, target: { ru: "ссылка на канал (https://kick.com/имя)", en: "channel link (https://kick.com/name)" }, warranty: 30, speed: GRADUAL, note: OPEN_PROFILE },
    { type: "Подписчики", serviceId: 2402, perUnit: 100, link: "kickProfile", what: FOLLOWERS, target: { ru: "ссылка на канал (https://kick.com/имя)", en: "channel link (https://kick.com/name)" }, warranty: "none", speed: GRADUAL, note: OPEN_PROFILE },
    { type: "Прочее", serviceId: 2403, perUnit: 1e3, link: "kickClip", what: { ru: "просмотры клипа", en: "clip views" }, target: { ru: "ссылка на клип Kick (https://kick.com/имя/clips/…)", en: "Kick clip link (https://kick.com/name/clips/…)" }, warranty: "none", speed: FAST, note: OPEN_PROFILE },
    { type: "Прочее", serviceId: 2404, perUnit: 1e3, link: "kickVideo", what: { ru: "просмотры записи", en: "video views" }, target: { ru: "ссылка на запись Kick (https://kick.com/имя/videos/…)", en: "Kick video link (https://kick.com/name/videos/…)" }, warranty: "none", speed: FAST, note: OPEN_PROFILE }
  ])
);
var EMOJI = { Telegram: "✈️", TikTok: "🎵", YouTube: "▶️", Instagram: "📸", Twitter: "𝕏", Kick: "🟩" };
var fmt = (n, language) => n.toLocaleString(language === "ru" ? "ru-RU" : "en-US").replace(/ /g, " ");
var capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
function smmLotTitle(plan, language) {
  const pack = `${fmt(plan.perUnit, language)} ${language === "ru" ? "шт." : "pcs"}`;
  const warranty = warrantyText(plan.warranty, language).title;
  const guarantee = warranty ? ` \xB7 ${warranty}` : "";
  const auto = language === "ru" ? " \xB7 автозапуск" : " \xB7 auto start";
  const tag = plan.tag ? ` ${plan.tag[language]}` : "";
  return `${EMOJI[plan.network]} ${plan.network} ${capital(plan.what[language])}${tag} \xB7 ${pack}${guarantee}${auto} ${plan.marker}`;
}
function smmLotDescription(plan, maxPacks, language) {
  const t = (text) => text[language];
  const n = (value) => fmt(value, language);
  if (language === "en") {
    return [
      `${EMOJI[plan.network]} ${plan.network} — ${t(plan.what)}. 1 unit = ${n(plan.perUnit)}; 5 units = ${n(plan.perUnit * 5)}. Up to ${n(plan.perUnit * maxPacks)} per order.`,
      "",
      `🔗 After payment the bot asks in this chat for the ${t(plan.target)}. Send it in one message, starting with https://.`,
      `⚡ The order starts automatically after the link; delivery usually begins within 0–6 hours. ${t(plan.speed)}`,
      `♻️ ${warrantyText(plan.warranty, "en").line}`,
      `🔓 No password needed. ${t(plan.note)} Do not change the link until the order is complete.`,
      "✅ When it is done, the bot writes here — check the result and confirm the order.",
      "💬 Questions: !seller"
    ].join("\n");
  }
  return [
    `${EMOJI[plan.network]} ${plan.network} — ${t(plan.what)}. 1 шт. = ${n(plan.perUnit)}; например, 5 шт. = ${n(plan.perUnit * 5)}. До ${n(plan.perUnit * maxPacks)} за заказ.`,
    "",
    `🔗 После оплаты бот спросит в этом чате: ${t(plan.target)}. Пришлите её одним сообщением, начиная с https://.`,
    `⚡ Запуск автоматически сразу после ссылки, старт обычно в течение 0–6 часов. ${t(plan.speed)}`,
    `♻️ ${warrantyText(plan.warranty, "ru").line}`,
    `🔓 Пароль не нужен. ${t(plan.note)} Не меняйте ссылку до конца выполнения.`,
    "✅ Когда заказ выполнен, бот напишет сюда — проверьте результат и подтвердите заказ.",
    "💬 Вопросы: !продавец"
  ].join("\n");
}
function smmPaymentMessage(plan, language) {
  return language === "ru" ? `Спасибо за заказ! Пришлите в этот чат одним сообщением: ${plan.target.ru}. Бот запустит заказ автоматически.` : `Thank you! Send the ${plan.target.en} in this chat in one message. The bot starts the order automatically.`;
}
var RUB2 = /^(₽|руб\.?|RUB|Р)$/i;
var SmmSectionFullError = class extends Error {
};
var SmmSlowDownError = class extends Error {
};
function newSmmLotFields(html, lot, active, texts) {
  const page = parse(html);
  const form = page.querySelector("form.form-offer-editor");
  if (!form) {
    const full = /Много предложений в разделе\s*«([^»]+)»/.exec(page.text);
    if (full) throw new SmmSectionFullError(`Раздел \xAB${full[1].trim()}\xBB заполнен на FunPay: удалите ненужные лоты в нём`);
    if (/Много предложений,?\s*подождите/i.test(page.text)) throw new SmmSlowDownError("FunPay просит подождать с новыми лотами (\xABМного предложений, подождите\xBB)");
    throw new Error("Редактор лота FunPay не открылся");
  }
  if (lot.price === null || lot.problem) throw new Error(lot.problem ?? "Нет цены");
  const fields = new URLSearchParams();
  const selects = /* @__PURE__ */ new Map();
  for (const field of form.querySelectorAll("input[name], textarea[name], select[name]")) {
    const name = field.getAttribute("name");
    const type2 = field.getAttribute("type");
    if (field.hasAttribute("disabled") || ["submit", "button", "file", "reset"].includes(type2 ?? "")) continue;
    if (["checkbox", "radio"].includes(type2 ?? "") && !field.hasAttribute("checked")) continue;
    if (field.tagName === "SELECT") {
      selects.set(name, field.querySelectorAll("option").map((option) => ({ value: option.getAttribute("value") ?? option.text, text: option.text.trim() })));
      fields.append(name, "");
    } else fields.append(name, field.tagName === "TEXTAREA" ? field.text : field.getAttribute("value") ?? "");
  }
  const currency = form.querySelector(".form-control-feedback")?.text.trim() ?? "";
  if (!fields.get("csrf_token") || !fields.has("price") || !fields.has("fields[summary][ru]")) throw new Error("В форме нового лота FunPay нет нужных полей");
  if (fields.get("node_id") !== String(lot.plan.node)) throw new Error("Форма нового лота открылась для другой категории FunPay");
  if (fields.get("offer_id") && fields.get("offer_id") !== "0") throw new Error("Форма FunPay открылась для существующего лота, а не нового");
  if (!RUB2.test(currency)) throw new Error("Выкладка SMM работает только для аккаунта FunPay в рублях");
  const type = selects.get("fields[type]")?.find((option) => option.text.toLowerCase() === lot.plan.type.toLowerCase());
  if (!type) throw new Error(`В категории FunPay нет типа \xAB${lot.plan.type}\xBB`);
  fields.set("fields[type]", type.value);
  if (lot.plan.type === "Реакции" && selects.has("fields[reactions]")) {
    const usual = selects.get("fields[reactions]").find((option) => option.text === "Обычные реакции");
    if (!usual) throw new Error("В категории FunPay нет \xABОбычные реакции\xBB");
    fields.set("fields[reactions]", usual.value);
  }
  const set = (name, value) => {
    if (fields.has(name)) fields.set(name, value);
  };
  fields.set("fields[summary][ru]", texts?.ru.title ?? lot.title);
  set("fields[summary][en]", texts?.en.title ?? smmLotTitle(lot.plan, "en"));
  set("fields[desc][ru]", texts?.ru.description ?? smmLotDescription(lot.plan, lot.maxPacks, "ru"));
  set("fields[desc][en]", texts?.en.description ?? smmLotDescription(lot.plan, lot.maxPacks, "en"));
  set("fields[payment_msg][ru]", texts?.ru.payment ?? smmPaymentMessage(lot.plan, "ru"));
  set("fields[payment_msg][en]", texts?.en.payment ?? smmPaymentMessage(lot.plan, "en"));
  fields.set("price", lot.price.toFixed(2));
  set("amount", String(lot.maxPacks));
  if (active) fields.set("active", "on");
  else fields.delete("active");
  fields.delete("auto_delivery");
  fields.delete("secrets");
  return fields;
}
var HOSTS = {
  Telegram: /^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)$/,
  TikTok: /^(?:(?:www|m|vm|vt)\.)?tiktok\.com$/,
  YouTube: /^(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)$/,
  Instagram: /^(?:(?:www|m)\.)?instagram\.com$/,
  Twitter: /^(?:(?:www|m|mobile)\.)?(?:x\.com|twitter\.com)$/,
  Kick: /^(?:www\.)?kick\.com$/
};
var NETWORK_OF = {
  tgChannel: "Telegram",
  tgAnyChannel: "Telegram",
  tgPost: "Telegram",
  tiktokVideo: "TikTok",
  tiktokProfile: "TikTok",
  ytVideo: "YouTube",
  ytChannel: "YouTube",
  igProfile: "Instagram",
  igPost: "Instagram",
  xProfile: "Twitter",
  xPost: "Twitter",
  kickProfile: "Kick",
  kickClip: "Kick",
  kickVideo: "Kick"
};
var BARE_LINK = /(?:^|[\s(«"'])((?:[a-z0-9-]+\.)*(?:t\.me|telegram\.me|tiktok\.com|youtube\.com|youtu\.be|instagram\.com|x\.com|twitter\.com|kick\.com)\/[^\s<>"'»)]+)/i;
var USERNAME = /(?:^|\s)@([A-Za-z0-9_.]{3,64})(?=$|[\s,.!?;:])/;
var IG_RESERVED = /* @__PURE__ */ new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "s"]);
function smmLinkFromText(plan, text) {
  const value = (text ?? "").trim();
  const full = value.match(/https?:\/\/[^\s<>"'»]+/i)?.[0];
  const bare = full ? null : value.match(BARE_LINK)?.[1];
  let raw = (full ?? (bare ? `https://${bare}` : "")).replace(/[),.!?;:]+$/, "");
  if (!raw) {
    const name = value.match(USERNAME)?.[1]?.replace(/\.+$/, "");
    if (name && (plan.link === "tgChannel" || plan.link === "tgAnyChannel")) raw = `https://t.me/${name}`;
    else if (name && plan.link === "tiktokProfile") raw = `https://www.tiktok.com/@${name}`;
    else if (name && plan.link === "igProfile") raw = `https://www.instagram.com/${name}`;
    else if (name && plan.link === "xProfile") raw = `https://x.com/${name}`;
    else if (name && plan.link === "kickProfile") raw = `https://kick.com/${name}`;
  }
  return raw && raw.length <= 500 ? raw : null;
}
function smmLinkProblem(plan, link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return "ссылка не открывается.";
  }
  const network = NETWORK_OF[plan.link];
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || url.port || !["http:", "https:"].includes(url.protocol) || !HOSTS[network]?.test(host)) {
    const other = Object.keys(HOSTS).find((name) => HOSTS[name].test(host));
    return other ? `это ссылка ${other}, а заказ — для ${network}.` : `это не ссылка ${network}.`;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const first = (parts[0] ?? "").toLowerCase();
  switch (plan.link) {
    case "tgChannel":
    case "tgAnyChannel":
    case "tgPost": {
      const path = first === "s" || first === "boost" ? parts.slice(1) : parts;
      if (!path.length) return "в ссылке нет канала.";
      if (plan.link === "tgAnyChannel" && (path[0].startsWith("+") || path[0].toLowerCase() === "joinchat")) return path[0] !== "+" && (path[0].length > 1 || path[1]) ? null : "в ссылке-приглашении нет кода.";
      if (path[0].startsWith("+") || ["joinchat", "c"].includes(path[0].toLowerCase())) return "это закрытый канал или приглашение — нужен публичный канал с @username.";
      if (!/^[A-Za-z0-9_]{4,64}$/.test(path[0])) return "в ссылке нет имени канала.";
      if (plan.link === "tgPost" && !/^\d+$/.test(path[1] ?? "")) return "это ссылка на канал, а нужна ссылка на конкретный пост (вида https://t.me/канал/123).";
      return null;
    }
    case "tiktokVideo":
      if (/^(?:vm|vt)\./.test(host) || first === "t") return parts.length ? null : "в ссылке нет видео.";
      return parts[0]?.startsWith("@") && parts[1] === "video" && /^\d+$/.test(parts[2] ?? "") ? null : "нужна ссылка на конкретное видео (вида https://www.tiktok.com/@ник/video/123…).";
    case "tiktokProfile":
      if (/^(?:vm|vt)\./.test(host) || first === "t") return "это короткая ссылка на видео — нужна ссылка на профиль (вида https://www.tiktok.com/@ник).";
      return parts[0]?.startsWith("@") && parts[0].length > 1 && parts[1] !== "video" ? null : "нужна ссылка на профиль (вида https://www.tiktok.com/@ник).";
    case "ytVideo":
      if (host.endsWith("youtu.be")) return parts[0] ? null : "в ссылке нет видео.";
      if (first === "watch") return url.searchParams.get("v") ? null : "в ссылке нет видео.";
      return ["shorts", "live", "embed"].includes(first) && parts[1] ? null : "нужна ссылка на конкретное видео (вида https://youtu.be/…).";
    case "ytChannel":
      if (host.endsWith("youtu.be") || ["watch", "shorts", "live", "embed"].includes(first)) return "это ссылка на видео — нужна ссылка на канал (вида https://www.youtube.com/@канал).";
      return first.startsWith("@") && first.length > 1 || ["channel", "c", "user"].includes(first) && parts[1] ? null : "нужна ссылка на канал (вида https://www.youtube.com/@канал).";
    case "igProfile":
      if (!parts.length) return "в ссылке нет профиля.";
      return IG_RESERVED.has(first) ? "это ссылка на публикацию — нужна ссылка на профиль (вида https://www.instagram.com/ник)." : null;
    case "igPost":
      return ["p", "reel", "reels", "tv"].includes(first) && parts[1] ? null : "нужна ссылка на конкретную публикацию или Reels (вида https://www.instagram.com/reel/…).";
    case "xProfile":
      return /^[a-z0-9_]{1,15}$/i.test(first) && parts.length === 1 && !["home", "explore", "search", "settings", "messages", "i", "intent", "login"].includes(first) ? null : "нужна ссылка на профиль X/Twitter, а не на пост или раздел сайта.";
    case "xPost":
      return /^[a-z0-9_]{1,15}$/i.test(first) && parts[1] === "status" && /^\d+$/.test(parts[2] ?? "") || first === "i" && parts[1] === "web" && parts[2] === "status" && /^\d+$/.test(parts[3] ?? "") ? null : "нужна ссылка на конкретный пост X/Twitter (x.com/имя/status/123).";
    case "kickProfile":
      return /^[a-z0-9_-]{1,40}$/i.test(first) && parts.length === 1 && !["categories", "search", "settings", "browse", "following", "clips", "videos"].includes(first) ? null : "нужна ссылка на канал Kick, а не клип или запись.";
    case "kickClip":
      return parts[1] === "clips" && !!parts[2] || parts.length === 1 && !!url.searchParams.get("clip") ? null : "нужна ссылка на клип Kick, а не на канал или запись.";
    case "kickVideo":
      return parts[1] === "videos" && !!parts[2] || first === "video" && !!parts[1] ? null : "нужна ссылка на запись Kick, а не на канал или клип.";
  }
}


// ../src/lib/steam/core.ts
function steamMarker(productId, hours) {
  return `[R${productId}-${hours}]`;
}
function parseSteamMarker(text) {
  const matches = [...text.matchAll(/\[R(\d+)-(\d+)\]/gi)];
  if (matches.length !== 1) return null;
  const productId = Number(matches[0][1]), hours = Number(matches[0][2]);
  return Number.isSafeInteger(productId) && productId > 0 && Number.isInteger(hours) && hours > 0 && hours <= 8760 ? { productId, hours } : null;
}


// ../src/lib/steam/knowledge.ts
function parseSteamCommand(text) {
  const m = /^!(steam|guard|code|код|review|отзыв|rental|аренда)(?:\s+#?([A-Za-z0-9]{8}))?\s*$/i.exec(text.trim());
  if (!m) return null;
  return { kind: /^(review|отзыв)$/i.test(m[1]) ? "review" : /^(rental|аренда)$/i.test(m[1]) ? "status" : "guard", ...m[2] ? { orderId: m[2].toUpperCase() } : {} };
}


// src/store.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
var DEFAULT_AI_SETTINGS = {
  enabled: false,
  rubPerDollar: 0,
  rubPerMillion: 0,
  dollars: [0.5, 1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 200, 300],
  millions: [1, 5, 10, 25, 50, 100, 250, 500, 1e3],
  categories: ["opencode", "gpt", "claude", "gemini", "kimi", "glm"]
};
var ORDER_KEEP_MS = 180 * 24 * 60 * 6e4;
var CHAT_KEEP_MS = 90 * 24 * 60 * 6e4;
var OUTBOX_SIZE = 40;
var SAVE_DELAY_MS = 800;
function emptyPublisher() {
  return {
    state: "idle",
    queue: [],
    pending: null,
    blocked: [],
    parked: [],
    fullNodes: [],
    cooldownUntil: null,
    nextPostAt: null,
    postIntervalMs: 0,
    cleanPosts: 0,
    posted: 0,
    errors: [],
    note: null,
    fallbackLeft: 20
  };
}
function emptyGoods() {
  return {
    settings: { steamEnabled: false, smmEnabled: false, steamMarkupPercent: 40, smmMarkupPercent: 40, steamTopGames: 50 },
    lots: {},
    ai: { ...DEFAULT_AI_SETTINGS },
    publisher: emptyPublisher()
  };
}
function emptyState() {
  return {
    version: 1,
    initializedAt: null,
    orders: {},
    chats: {},
    lowBalance: {},
    toggles: { aiEnabled: true, deliveryEnabled: true, remindersEnabled: true, raiseEnabled: true },
    status: null,
    outbox: [],
    goods: emptyGoods()
  };
}
var Store = class {
  state;
  file;
  timer = null;
  constructor(file) {
    this.file = file;
    mkdirSync2(dirname2(file), { recursive: true });
    this.state = existsSync3(file) ? { ...emptyState(), ...JSON.parse(readFileSync3(file, "utf8")) } : emptyState();
    this.state.toggles = { ...emptyState().toggles, ...this.state.toggles };
    const goods = emptyGoods();
    this.state.goods = {
      settings: { ...goods.settings, ...this.state.goods?.settings },
      ai: { ...DEFAULT_AI_SETTINGS, ...this.state.goods?.ai },
      lots: this.state.goods?.lots ?? {},
      publisher: { ...goods.publisher, ...this.state.goods?.publisher }
    };
  }
  /** Writes within a second; many changes in a row make one write. */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, SAVE_DELAY_MS);
  }
  saveNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const temporary = `${this.file}.tmp`;
    writeFileSync2(temporary, JSON.stringify(this.state), { mode: 384 });
    renameSync2(temporary, this.file);
  }
  /** Old closed orders and quiet chats are dropped, so the file stays small. */
  prune(now = Date.now()) {
    const keepKeys = /* @__PURE__ */ new Set();
    for (const order of Object.values(this.state.orders)) {
      const open = ["pending", "retry", "minted", "stale", "failed"].includes(order.delivery) || order.status === "paid" || (order.steam?.expiresAt ? Date.parse(order.steam.expiresAt) > now : false);
      if (order.keyId) keepKeys.add(order.keyId);
      else if (!open && now - order.orderedAt > ORDER_KEEP_MS) delete this.state.orders[order.id];
    }
    for (const chat of Object.values(this.state.chats)) {
      const last = Math.max(chat.lastBuyerAt ?? 0, chat.lastAiReplyAt ?? 0, chat.sellerCalledAt ?? 0);
      const paused = chat.aiPausedUntil !== null && chat.aiPausedUntil > now;
      if (!paused && last && now - last > CHAT_KEEP_MS) delete this.state.chats[chat.id];
    }
    for (const keyId of Object.keys(this.state.lowBalance)) {
      if (!keepKeys.has(Number(keyId))) delete this.state.lowBalance[keyId];
    }
    this.state.outbox.length = Math.min(this.state.outbox.length, OUTBOX_SIZE);
  }
  pushOutbox(entry) {
    this.state.outbox.unshift(entry);
    this.state.outbox.length = Math.min(this.state.outbox.length, OUTBOX_SIZE);
    this.save();
  }
};


// src/publisher.ts
var POST_EVERY_MS = Math.max(1e3, Number(process.env.RESELLER_BOT_POST_EVERY_MS) || 6e4);
var MAX_INTERVAL_MS = 5 * 6e4;
var SLOW_DOWN_MS = 10 * 6e4;
var CHECK_AGAIN_MS = 5 * 6e4;
var CLEAN_POSTS_TO_SPEED_UP = 10;
var FALLBACK_NODE = 89;
var FALLBACK_GAMES = 20;
function nextPostInterval(interval, cleanPosts) {
  if (interval <= POST_EVERY_MS) return { postIntervalMs: POST_EVERY_MS, cleanPosts: 0 };
  if (cleanPosts < CLEAN_POSTS_TO_SPEED_UP) return { postIntervalMs: interval, cleanPosts };
  return { postIntervalMs: Math.max(POST_EVERY_MS, Math.round(interval / 2)), cleanPosts: 0 };
}
var fallbackAllowed = (item) => item.hours === 1 && (item.minHours ?? 1) <= 1;
function gamesFirst(items) {
  const games = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = item.kind === "steam" ? `g${item.productId}` : item.marker;
    games.set(key, [...games.get(key) ?? [], item]);
  }
  const lists = [...games.values()].map((list) => [...list].sort((a, b) => (a.hours ?? 0) - (b.hours ?? 0)));
  const rounds = Math.max(0, ...lists.map((list) => list.length));
  return Array.from({ length: rounds }, (_, i) => lists.flatMap((list) => list[i] ? [list[i]] : [])).flat();
}
var LotPublisher = class {
  constructor(client, store, hooks) {
    this.client = client;
    this.store = store;
    this.hooks = hooks;
  }
  working = false;
  lastPost = 0;
  get run() {
    return this.store.state.goods.publisher;
  }
  save(change) {
    Object.assign(this.store.state.goods.publisher, change);
    this.store.save();
  }
  /** New lots for the queue (already posted markers and the ones waiting are skipped). */
  enqueue(items, note) {
    const run = this.run;
    const known = /* @__PURE__ */ new Set([...Object.keys(this.store.state.goods.lots), ...run.queue.map((i) => i.marker), ...run.blocked.map((i) => i.marker), ...run.parked.map((i) => i.marker), ...run.pending ? [run.pending.marker] : []]);
    const fresh = items.filter((item) => !known.has(item.marker));
    this.save({ queue: [...run.queue, ...fresh], state: run.queue.length + fresh.length ? "posting" : run.state === "posting" ? "posting" : "done", note });
    return fresh.length;
  }
  stop() {
    this.save({ state: "stopped", note: "Выкладка остановлена на панели. Уже отправленный лот может завершиться." });
  }
  /** «Продолжить»: stopped or finished runs go on; lots of full sections come back (after the seller freed them). */
  resume() {
    const run = this.run;
    this.save({ queue: [...run.queue, ...run.parked], parked: [], fullNodes: [], state: run.queue.length || run.parked.length || run.blocked.length ? "posting" : "done", note: "Выкладка продолжается" });
  }
  clear() {
    const run = this.run;
    this.store.state.goods.publisher = { ...emptyPublisher(), blocked: run.blocked, pending: run.pending, cooldownUntil: run.cooldownUntil, postIntervalMs: run.postIntervalMs, fallbackLeft: run.fallbackLeft };
    this.store.save();
  }
  /** One step from the bot's tick; returns at once when another step is still running. */
  async step(dryRun) {
    if (this.working) return;
    this.working = true;
    try {
      await this.stepOnce(dryRun);
    } finally {
      this.working = false;
    }
  }
  async stepOnce(dryRun) {
    const run = this.run;
    if (run.state !== "posting") return;
    if (dryRun) {
      this.save({ state: "stopped", note: "Тестовый режим: лоты не выкладываются" });
      return;
    }
    const now = Date.now();
    if (run.pending) {
      const pending = run.pending;
      this.save({ pending: null, blocked: [...run.blocked, { ...pending, retryAfter: now }], queue: run.queue.filter((i) => i.marker !== pending.marker) });
      logWarn("lots.unknown", `Лот ${pending.marker} (${pending.name}): результат сохранения неизвестен — бот проверит FunPay по маркеру, прежде чем выкладывать снова`);
      return;
    }
    if ((run.cooldownUntil ?? 0) > now || (run.nextPostAt ?? 0) > now) return;
    const due = run.blocked.find((item2) => (item2.retryAfter ?? 0) <= now);
    if (due) return this.recheck(due);
    if (now - this.lastPost < Math.max(POST_EVERY_MS, run.postIntervalMs) || now - this.client.lastLotCreatedAt < POST_EVERY_MS) return;
    const item = run.queue[0];
    if (!item) {
      if (!run.blocked.length) this.save({ state: "done", note: run.parked.length ? `Готово, кроме лотов заполненных разделов: ${run.parked.length}` : "Все лоты выложены" });
      return;
    }
    this.lastPost = now;
    await this.post(item);
  }
  /** A save with an unknown result: found by its marker → linked; not found twice → back in the queue. */
  async recheck(item) {
    try {
      let id = await this.client.findSteamLot(item.node, item.marker);
      if (!id) id = await this.client.findSteamLot(item.node, item.marker);
      const blocked = this.run.blocked.filter((i) => i.marker !== item.marker);
      if (id) {
        this.hooks.linked(item, String(id), true);
        this.save({ blocked, posted: this.run.posted + 1, note: `${item.marker}: найден на FunPay и привязан` });
        logInfo("lots.found", `Лот ${item.marker} (${item.name}) найден на FunPay — привязан (#${id})`);
      } else {
        this.save({ blocked, queue: [{ ...item, retryAfter: void 0 }, ...this.run.queue], note: `${item.marker}: на FunPay его нет (проверено дважды) — снова в очереди` });
      }
    } catch (error) {
      const until = error instanceof FunPayRateLimitError ? error.retryAt : Date.now() + CHECK_AGAIN_MS;
      this.save({ cooldownUntil: until, note: `Проверка ${item.marker} отложена: ${errorText(error).slice(0, 160)}` });
    }
  }
  dropFromQueue(item, extra = {}) {
    const queue = this.run.queue.filter((i) => i.marker !== item.marker);
    this.save({ queue, ...extra });
  }
  fail(item, message) {
    const errors = [...this.run.errors, { marker: item.marker, name: item.name, error: message.slice(0, 300), at: Date.now() }].slice(-200);
    const stop = errors.length >= 5 && !this.run.posted && this.run.errors.length < 5;
    this.dropFromQueue(item, { errors, ...stop ? { state: "stopped", note: "Пять ошибок подряд и ни одного выложенного лота — выкладка остановлена, посмотрите ошибки" } : {} });
    logWarn("lots.error", `Лот ${item.marker} (${item.name}) не выложен: ${message}`);
  }
  async post(item) {
    if (this.hooks.allowed && !this.hooks.allowed(item)) return this.fail(item, "Выкладка AI вне подтверждённого раздела \xABТокены\xBB запрещена");
    if (this.store.state.goods.lots[item.marker]) return this.dropFromQueue(item);
    let submitted = false;
    try {
      const existing = await this.client.findSteamLot(item.node, item.marker);
      if (existing) {
        this.hooks.linked(item, String(existing), true);
        this.dropFromQueue(item, { posted: this.run.posted + 1 });
        logInfo("lots.found", `Лот ${item.marker} (${item.name}) уже есть на FunPay — привязан (#${existing})`);
        return;
      }
      let prepared;
      try {
        prepared = await this.hooks.prepare(item);
      } catch (error) {
        if (!(error instanceof SteamLotCategoryError) || item.kind !== "steam" || item.node === FALLBACK_NODE) throw error;
        this.save({ queue: this.run.queue.filter((i) => i.productId !== item.productId || i.marker === item.marker) });
        if (!fallbackAllowed(item)) throw new Error("Нет категории с арендой, а в \xABАккаунты с играми Steam\xBB — только лоты на 1 ч.: игра пропущена");
        if (this.run.fallbackLeft <= 0 || this.run.fullNodes.some((f) => f.node === FALLBACK_NODE)) throw new Error(`Нет категории с арендой, а в \xABАккаунты с играми Steam\xBB уже ${FALLBACK_GAMES} игр: игра пропущена`);
        item = { ...item, node: FALLBACK_NODE, fallback: true };
        if (await this.client.findSteamLot(item.node, item.marker)) throw new Error(`Лот ${item.marker} уже есть в \xABАккаунты с играми Steam\xBB — привяжите вручную`);
        prepared = await this.hooks.prepare(item);
      }
      if (this.run.state !== "posting") return;
      this.save({ pending: item });
      this.store.saveNow();
      submitted = true;
      const lotId = await this.client.createLot(item.node, prepared.fields, item.marker);
      if (!lotId) throw new Error(`FunPay сохранил лот, но его номер не найден — привяжите лот ${item.marker} вручную`);
      this.hooks.linked(item, String(lotId), false);
      const pace = nextPostInterval(this.run.postIntervalMs, this.run.cleanPosts + 1);
      this.dropFromQueue(item, {
        ...pace,
        pending: null,
        posted: this.run.posted + 1,
        nextPostAt: Date.now() + Math.max(POST_EVERY_MS, pace.postIntervalMs),
        note: "Выкладка идёт с учётом ограничений FunPay",
        ...item.fallback ? { fallbackLeft: Math.max(0, this.run.fallbackLeft - 1) } : {}
      });
      logInfo("lots.posted", `Выложен лот ${item.name} ${item.marker} (#${lotId}) — выключен, включится сам при наличии`);
    } catch (error) {
      this.onError(item, error, submitted);
    }
  }
  onError(item, error, submitted) {
    const message = errorText(error);
    if (!submitted && (error instanceof SteamSectionFullError || error instanceof SmmSectionFullError)) {
      const section = error instanceof SteamSectionFullError ? error.section : message.match(/«([^»]+)»/)?.[1] ?? String(item.node);
      const parked = this.run.queue.filter((i) => i.node === item.node);
      this.save({
        fullNodes: [...this.run.fullNodes.filter((f) => f.node !== item.node), { node: item.node, section }],
        parked: [...this.run.parked, ...parked],
        queue: this.run.queue.filter((i) => i.node !== item.node),
        errors: [...this.run.errors, { marker: item.marker, name: item.name, error: `Раздел \xAB${section}\xBB заполнен на FunPay`, at: Date.now() }].slice(-200),
        note: `Раздел \xAB${section}\xBB заполнен: удалите ненужные лоты в нём и нажмите \xABПродолжить\xBB — отложено лотов: ${parked.length}`
      });
      logWarn("lots.section_full", `Раздел FunPay \xAB${section}\xBB заполнен — отложено лотов: ${parked.length}`);
      return;
    }
    if (!submitted && error instanceof SmmSlowDownError) {
      this.save({ cooldownUntil: Date.now() + SLOW_DOWN_MS, note: "FunPay просит подождать с новыми лотами — пауза 10 минут, затем тот же лот" });
      logInfo("lots.slow_down", "FunPay: \xABМного предложений, подождите\xBB — выкладка ждёт 10 минут");
      return;
    }
    if (!submitted && error instanceof SteamFormMissingError && (item.attempts ?? 0) < 2) {
      const attempts = (item.attempts ?? 0) + 1;
      this.save({ queue: [...this.run.queue.filter((i) => i.marker !== item.marker), { ...item, attempts }], note: `${item.marker}: редактор FunPay не открылся (попытка ${attempts} из 3) — лот в конце очереди` });
      return;
    }
    if (error instanceof FunPayRateLimitError) {
      const uncertain2 = submitted && error.requestSent;
      const interval = error.requestSent ? Math.min(MAX_INTERVAL_MS, Math.max(POST_EVERY_MS, this.run.postIntervalMs) * 2) : this.run.postIntervalMs;
      this.save({
        pending: null,
        cooldownUntil: error.retryAt,
        postIntervalMs: interval,
        cleanPosts: error.requestSent ? 0 : this.run.cleanPosts,
        ...uncertain2 ? { queue: this.run.queue.filter((i) => i.marker !== item.marker), blocked: [...this.run.blocked, { ...item, retryAfter: error.retryAt }] } : {},
        note: `FunPay ограничил запросы (429) — пауза до ${new Date(error.retryAt).toLocaleTimeString("ru-RU")}, затем продолжение без дублей`
      });
      logWarn("lots.rate_limited", `FunPay ограничил запросы при выкладке — пауза, интервал между лотами ${Math.round(interval / 1e3)} с`);
      return;
    }
    const uncertain = submitted && !(error instanceof FunPayLotRejectedError);
    if (uncertain) {
      this.save({ pending: null, queue: this.run.queue.filter((i) => i.marker !== item.marker), blocked: [...this.run.blocked, { ...item, retryAfter: Date.now() + CHECK_AGAIN_MS }], note: `Результат ${item.marker} неизвестен — проверю FunPay через 5 минут` });
      logError("lots.unknown", `Лот ${item.marker} (${item.name}): ${message}. Бот проверит FunPay по маркеру, второй копии не будет`);
      return;
    }
    this.save({ pending: null });
    this.fail(item, message);
  }
};


// src/templates.ts
import { existsSync as existsSync4, readFileSync as readFileSync4, statSync as statSync2 } from "node:fs";


// ../src/lib/funpay/plans.ts
var MAX_MILLIONS = 1e4;
var MAX_IMAGES = 1e4;
var MAX_HOURS = 24 * 365;
var MAX_DOLLARS = 1e4;
var API_KEY_RE = /api[\s-]*(?:ключ|key)|(?:ключ|key)[\s-]*api/iu;
var IMAGES_RE = new RegExp("(\\d{1,5})\\s*(?:картин\\p{L}*|изображени\\p{L}*|images?(?!\\p{L})|pics?(?!\\p{L}))", "iu");
var UNLIMITED_RE = /безлимит|unlimited/iu;
var DAYS_RE = new RegExp("(\\d{1,3})\\s*(?:дн\\p{L}*|ден\\p{L}*|сут\\p{L}*|days?(?!\\p{L}))", "iu");
var HOURS_RE = new RegExp("(\\d{1,4})\\s*(?:ч(?!\\p{L})|час\\p{L}*|hours?(?!\\p{L})|h(?!\\p{L}))", "iu");
var TOKENS_RE = new RegExp("(?<![\\d.,])(\\d{1,3}(?:[ \ ]\\d{3})+|\\d{1,5}(?:[.,]\\d{1,3})?)\\s*(m|м|млн\\.?|mln|миллион\\p{L}*|million\\p{L}*|kk(?!k)|кк(?!к)|b|в|млрд\\.?|bln|миллиард\\p{L}*|billion\\p{L}*|kkk|ккк)\\s*(?:токен|token)", "iu");
var BILLION_UNIT_RE = new RegExp("^(?:b|в|млрд\\.?|bln|миллиард\\p{L}*|billion\\p{L}*|kkk|ккк)$", "iu");
var FULL_TOKENS_RE = /(?<![\d.,])(\d{1,3}(?:[ .,]\d{3})+|\d{6,})\s*(?:токен|token)/iu;
var MODEL_VERSION_RE = /(?<![\p{L}\d])(?:glm|kimi|k|m|v|r|gpt|grok|gemini|claude|opus|sonnet|fable|deepseek|minimax|qwen)[\s-]?\d+(?:\.\d+)*(?=[\s -]+\d)/giu;
var MIN_FULL_TOKENS = 1e5;
var BONUS_RE = /\+\s*(\d{1,3})\s*%/u;
var USD_AMOUNT = String.raw`(?:\$\s*(\d{1,5}(?:[.,]\d{1,2})?)|(\d{1,5}(?:[.,]\d{1,2})?)\s*\$)`;
var BALANCE_RE = new RegExp(String.raw`(?:баланс|balance)[\s:|-]*${USD_AMOUNT}|${USD_AMOUNT}[\s|-]*(?:баланс|balance)`, "iu");
var RETIRED_RE = /(?<![a-z])(?:grok|xai|deep\s*seek|mini[\s-]*max)(?![a-z])/i;
var STILL_RETIRED_RE = /(?<![a-z])(?:grok|xai|mini[\s-]*max)(?![a-z])/i;
var QUANTITY_RE = /,\s(\d{1,3}(?:\s?\d{3})*)\s(?:шт|pcs)\./giu;
function hubFamilyOf(text) {
  if (/(?<![a-z])(?:kimi|moonshot)(?![a-z])/i.test(text)) return "kimi";
  if (/gemini/i.test(text)) return "gemini";
  return null;
}
function familyOf(text) {
  const hub = hubFamilyOf(text);
  const provider = [
    ["claude", /claude/i],
    ["gpt", /(?<![a-z])(?:chat\s*)?gpt(?![a-z])|openai|(?<![a-z])codex(?![a-z])/i],
    ["glm", /(?<![a-z])(?:chat\s*)?glm(?![a-z])|zhipu/i],
    ["qwen", /(?<![a-z])(?:qwen|qwq)(?![a-z])|tongyi/i]
  ].filter(([, pattern]) => pattern.test(text)).map(([family]) => family);
  if (!provider.length) return hub;
  if (hub === "gemini" && provider.length === 1 && GEMINI_GIFT_FAMILIES.includes(provider[0])) return provider[0];
  if (hub || provider.length > 1) return null;
  return provider[0];
}
function looksLikeApiKey(description) {
  const text = description.normalize("NFKC");
  return API_KEY_RE.test(text) && !GUIDE_RE.test(text);
}
var GUIDE_RE = new RegExp("📘|(?<!\\p{L})(?:гайд|шпаргалк|шаблон|guide|cheat\\s*sheet)", "iu");
function isRetiredTitle(description) {
  const text = description.normalize("NFKC");
  if (!RETIRED_RE.test(text)) return false;
  return STILL_RETIRED_RE.test(text) || !BALANCE_RE.test(text) || !/(?<![a-z])qwen(?![a-z])/i.test(text);
}
function detectPlan(description) {
  const text = description.normalize("NFKC");
  if (!API_KEY_RE.test(text) || isRetiredTitle(text)) return null;
  const balance = text.match(BALANCE_RE);
  if (balance) {
    if (!/gemini|claude|(?<![a-z])(?:chat\s*)?gpt(?![a-z])|openai|(?<![a-z])codex(?![a-z])|(?<![a-z])(?:kimi|glm|qwen)(?![a-z])/i.test(text)) return null;
    const dollars = Number((balance[1] ?? balance[2] ?? balance[3] ?? balance[4]).replace(",", "."));
    if (!Number.isFinite(dollars) || dollars <= 0 || dollars > MAX_DOLLARS) return null;
    const bonus = Number(text.match(BONUS_RE)?.[1] ?? 0);
    return { kind: "usd", dollars, bonusPercent: Math.min(100, bonus) };
  }
  const group = familyOf(text);
  if (UNLIMITED_RE.test(text)) {
    if (!group) return null;
    const days = text.match(DAYS_RE);
    const hours = days ? Number(days[1]) * 24 : Number(text.match(HOURS_RE)?.[1] ?? NaN);
    return Number.isInteger(hours) && hours >= 1 && hours <= MAX_HOURS ? { kind: "unlimited", group, hours } : null;
  }
  const amounts = text.replace(MODEL_VERSION_RE, " ");
  const tokens = amounts.match(TOKENS_RE);
  const fullTokens = tokens ? null : amounts.match(FULL_TOKENS_RE);
  if (tokens || fullTokens) {
    if (!group) return null;
    const millions = tokens ? Number(tokens[1].replace(/[  ]/g, "").replace(",", ".")) * (BILLION_UNIT_RE.test(tokens[2]) ? 1e3 : 1) : Number(fullTokens[1].replace(/[ .,]/g, "")) / 1e6;
    if (!Number.isFinite(millions) || millions > MAX_MILLIONS) return null;
    if (tokens ? millions <= 0 : millions * 1e6 < MIN_FULL_TOKENS) return null;
    const bonus = Number(text.match(BONUS_RE)?.[1] ?? 0);
    return { kind: "tokens", group, millions, bonusPercent: Math.min(100, bonus) };
  }
  const images = text.match(IMAGES_RE);
  if (!images) return null;
  const count2 = Number(images[1]);
  return count2 >= 1 && count2 <= MAX_IMAGES ? { kind: "images", images: count2 } : null;
}
function quantityFromDescription(description) {
  const matches = [...description.matchAll(QUANTITY_RE)];
  const value = Number(matches.at(-1)?.[1]?.replace(/\s/g, "") ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}
var GEMINI_GIFT_FAMILIES = ["glm", "kimi", "qwen"];
function formatMillions(tokens) {
  const millions = tokens / 1e6;
  return `${Number.isInteger(millions) ? millions : Number(millions.toFixed(2))}M`;
}
function plural(value, one, few, many) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}


// src/plans.ts
var GROUP_NAMES = {
  gemini: "Gemini",
  grok: "Grok",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  minimax: "MiniMax",
  gpt: "GPT",
  claude: "Claude",
  glm: "GLM",
  qwen: "Qwen",
  all: "Gemini + Grok + DeepSeek + Kimi + MiniMax",
  full: "Все модели"
};
var ALL_MODELS_RE = /вс[её]\s+модели|all\s+models|любые\s+модели|any\s+model/iu;
var FAMILY_WORDS_RE = /chat\s*gpt|gpt|claude|gemini|grok|xai|deep\s*seek|kimi|moonshot|mini[\s-]*max|openai|codex/giu;
function detectLot(description) {
  const text = description.normalize("NFKC");
  const shopBundle = /gpt\s*\/\s*opus\s*5\.5\s*\/\s*gemini\s*\/\s*kimi\s*\/\s*glm/iu;
  if (shopBundle.test(text)) {
    const bundle = detectPlan(text.replace(shopBundle, " ").replace(/\[A(?:OPENCODE|GPT|CLAUDE|GEMINI|KIMI|GLM)T\d+\]/giu, " ") + " GEMINI");
    if (bundle?.kind === "tokens") return { plan: { group: "full", millions: bundle.millions, bonusPercent: bundle.bonusPercent } };
  }
  const wallet = detectPlan(text);
  if (wallet?.kind === "usd") return { plan: { group: "full", millions: 0, billing: "usd", dollars: wallet.dollars, bonusPercent: wallet.bonusPercent } };
  if (ALL_MODELS_RE.test(text)) {
    const plan2 = detectPlan(`${text.replace(FAMILY_WORDS_RE, " ").replace(ALL_MODELS_RE, " ")} GEMINI`);
    if (plan2?.kind === "tokens") return { plan: { group: "full", millions: plan2.millions, bonusPercent: plan2.bonusPercent } };
  }
  const plan = detectPlan(text);
  if (!plan) return null;
  if (plan.kind === "unlimited") return { unsupported: "Безлимитные ключи не выдаются из пула реселлера — выдайте вручную" };
  if (plan.kind === "images") return { unsupported: "Ключи для картинок не выдаются из пула реселлера — выдайте вручную" };
  if (plan.kind !== "tokens") return { unsupported: "Лоты \xABБаланс $\xBB бот пока не выдаёт — выдайте ключ в $ вручную в /seller" };
  return { plan: { group: plan.group, millions: plan.millions, bonusPercent: plan.bonusPercent } };
}
function parseStoredPlan(value) {
  if (!value) return null;
  try {
    const plan = JSON.parse(value);
    if (typeof plan?.group !== "string" || !Number.isFinite(plan?.millions)) return null;
    if (plan.billing === "usd" && (!Number.isFinite(plan.dollars) || plan.dollars <= 0)) return null;
    return plan;
  } catch {
    return null;
  }
}
function grantFor(plan, quantity) {
  const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const perUnit = (plan.billing === "usd" ? plan.dollars : plan.millions) * 1e6;
  const tokens = Math.round(perUnit * qty);
  return {
    group: plan.group,
    tokens,
    ...plan.billing === "usd" ? { billing: "usd" } : {},
    reviewBonus: Math.round(perUnit * plan.bonusPercent / 100) * qty,
    label: plan.billing === "usd" ? `Баланс ${formatDollars(tokens)} \xB7 все модели${qty > 1 ? ` (${qty} \xD7 ${formatDollars(perUnit)})` : ""}` : `${GROUP_NAMES[plan.group] ?? plan.group} \xB7 ${formatMillions(tokens)} токенов${qty > 1 ? ` (${qty} \xD7 ${formatMillions(perUnit)})` : ""}`
  };
}
function productLabel(description, plan) {
  if (plan?.billing === "usd") return `Баланс ${formatDollars(plan.dollars * 1e6)}`;
  if (plan) return `${GROUP_NAMES[plan.group] ?? plan.group} ${formatMillions(plan.millions * 1e6)}`;
  const cleaned = description.normalize("NFKC").replace(/,\s*\d[\d\s]*\s*(?:шт|pcs)\.?\s*$/iu, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Без названия";
  return cleaned.length > 90 ? `${cleaned.slice(0, 89).trimEnd()}…` : cleaned;
}
function groupsThatTake(group) {
  return group === "gemini" ? ["gemini", "all", "full"] : [group];
}
function formatTokens(value) {
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(2))}B`;
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(1))}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.max(0, Math.round(value)));
}
function formatDollars(units) {
  return `$${Number((units / 1e6).toFixed(6))}`;
}
function formatBalance(units, billing) {
  return billing === "usd" ? formatDollars(units) : `${formatTokens(units)} токенов`;
}


// src/texts.ts
var CONFIRM = "📌 Когда убедитесь, что ключ работает, подтвердите, пожалуйста, заказ на FunPay — это очень помогает магазину.";
function head(shop, orderId) {
  return `⚡ ${shop} │ заказ #${orderId}`;
}
function bonusLine(tokens, billing) {
  return `🎀 Подарок: за любой отзыв после подтверждения заказа добавим +${formatBalance(tokens, billing)}.`;
}
function installCommands(links) {
  return {
    windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${links.rootUrl}/install.ps1 | iex"`,
    unix: `curl -fsSL ${links.rootUrl}/install.sh | bash`
  };
}
function setupSteps(group, links, exampleModel) {
  const pick = group === "gpt" ? "Codex (1) или Claude Code (2)" : group === "full" ? "для кода — Claude Code (2), для GPT можно Codex (1)" : "для кода — Claude Code (2)";
  const install = installCommands(links);
  return [
    "🛠 Подключение — 3 шага:",
    "① Откройте терминал: Windows — PowerShell, Mac — \xABТерминал\xBB.",
    "② Вставьте строку для своей системы и нажмите Enter (Node.js поставится сам):",
    `• Windows: ${install.windows}`,
    `• Mac / Linux: ${install.unix}`,
    `③ Вставьте ключ и выберите программу — ${pick}. Все модели ключа добавятся сами.`,
    `🔗 Другая программа (Cursor, Cline, SillyTavern, Chatbox): Base URL ${links.apiBaseUrl} и ваш ключ${exampleModel ? `, модель — например ${exampleModel}` : ""}.`
  ];
}
function keyDeliveredText(input) {
  const { shop, orderId, apiKey, grant, models, links } = input;
  return [
    head(shop, orderId),
    "Оплата получена — ваш ключ готов к работе.",
    "",
    `🗝 ${apiKey}`,
    `🧾 Пакет: ${grant.label}`,
    `🛰 Адрес API: ${links.apiBaseUrl}`,
    ...models.length ? [`🧠 Модели: ${models.join(", ")}`] : [],
    ...grant.reviewBonus > 0 ? [bonusLine(grant.reviewBonus, grant.billing)] : [],
    "",
    "⤵️ Как подключить — следующим сообщением."
  ].join("\n");
}
function setupGuideText(group, links, exampleModel) {
  return [
    ...setupSteps(group, links, exampleModel),
    "💬 Не выходит — напишите сюда, помогу по шагам. Живой продавец: !продавец",
    "",
    CONFIRM
  ].join("\n");
}
function keyToppedUpText(input) {
  const { shop, orderId, grant, preview, tokensLeft, tokenLimit } = input;
  return [
    head(shop, orderId),
    `🔋 Пополнили ваш ключ ${preview} — новый ключ не нужен, всё уже работает.`,
    "",
    `🧾 Добавлено: ${grant.label}`,
    `🪙 Сейчас на ключе: ${input.billing === "usd" ? `${formatDollars(tokensLeft)} из ${formatDollars(tokenLimit)}` : `${formatTokens(tokensLeft)} из ${formatTokens(tokenLimit)} токенов`}`,
    ...grant.reviewBonus > 0 ? [bonusLine(grant.reviewBonus, grant.billing)] : [],
    "",
    "Остаток в любой момент — !баланс. Нужен отдельный ключ — !продавец.",
    CONFIRM
  ].join("\n");
}
function funpayDeliveredText(input) {
  const { shop, orderId, group, links } = input;
  return [
    head(shop, orderId),
    "Спасибо за покупку! Ключ выдан автоматически — он на странице заказа FunPay.",
    "",
    ...setupSteps(group ?? "", links),
    "",
    CONFIRM
  ].join("\n");
}
function thankYouText(orderId, reviewed, bonus = {}, billing) {
  if (reviewed && bonus.granted) {
    return `🤝 Заказ #${orderId} подтверждён — спасибо! За отзыв уже добавили к ключу +${formatBalance(bonus.granted, billing)} 🎀 Остаток: !баланс`;
  }
  if (reviewed) {
    return `🤝 Заказ #${orderId} подтверждён, отзыв получили — огромное спасибо! Понадобится помощь с ключом — просто напишите сюда.`;
  }
  if (bonus.offered) {
    return `🤝 Спасибо за подтверждение заказа #${orderId}! Оставьте, пожалуйста, отзыв — любой, как есть 🌟 За него добавим к ключу +${formatBalance(bonus.offered, billing)} 🎀`;
  }
  return `🤝 Спасибо за подтверждение заказа #${orderId}! Будем рады вашему отзыву 🌟 Если что-то понадобится — пишите сюда.`;
}
function keyWorksText(orderId) {
  return [
    `✨ Ключ по заказу #${orderId} в деле — первый запрос прошёл!`,
    "Если всё устраивает, нажмите \xABПодтвердить выполнение заказа\xBB на странице заказа:",
    `https://funpay.com/orders/${orderId}/`,
    "Что-то не так — напишите здесь, разберёмся."
  ].join("\n");
}
function lowBalanceText(input) {
  const { preview, left, total, product, shopUrl } = input;
  return [
    left > 0 ? `🔋 На ключе ${preview} осталось ${input.billing === "usd" ? `${formatDollars(left)} из ${formatDollars(total)}` : `${formatTokens(left)} из ${formatTokens(total)} токенов`}.` : `🔋 На ключе ${preview} закончился баланс.`,
    `Следующий пакет ${product} добавится к этому же ключу — перенастраивать ничего не придётся.`,
    `🏷 Все пакеты магазина: ${shopUrl}`,
    "Остаток: !баланс"
  ].join("\n");
}
function reviewBonusText(orderId, tokens, billing) {
  return `🎀 Спасибо за отзыв к заказу #${orderId}! Добавили к вашему ключу +${formatBalance(tokens, billing)}. Остаток: !баланс`;
}
function writtenInEnglish(text) {
  if (!text) return false;
  return /[a-z]/i.test(text) && !/[а-яё]/i.test(text);
}
var REVIEW_FAMILY = {
  gemini: ["GEMINI", "GEMINI"],
  gpt: ["GPT", "GPT"],
  claude: ["CLAUDE", "CLAUDE"],
  deepseek: ["DEEPSEEK", "DEEPSEEK"],
  grok: ["GROK", "GROK"],
  kimi: ["KIMI", "KIMI"],
  minimax: ["MINIMAX", "MINIMAX"],
  full: ["ВСЕ МОДЕЛИ", "ALL MODELS"],
  all: ["GEMINI + GROK + DEEPSEEK", "GEMINI + GROK + DEEPSEEK"]
};
function reviewReplyText(input) {
  const { shop, plan, english } = input;
  const quantity = Number.isInteger(input.quantity) && input.quantity > 0 ? input.quantity : 1;
  const family = REVIEW_FAMILY[plan.group]?.[english ? 1 : 0] ?? plan.group.toUpperCase();
  const total = Math.round(plan.millions * 1e6 * quantity);
  const parts = [
    `✨ ${shop.toUpperCase()}`,
    plan.billing === "usd" ? `🗝 ${family} \xB7 ${formatDollars(plan.dollars * quantity * 1e6)}` : english ? `🗝 ${family} \xB7 ${formatTokens(total)} TOKENS` : `🗝 ${family} \xB7 ${formatTokens(total)} ТОКЕНОВ`
  ];
  if (input.bonusTokens > 0) {
    const bonus = plan.billing === "usd" ? formatDollars(input.bonusTokens) : formatTokens(input.bonusTokens);
    const sum = plan.billing === "usd" ? formatDollars(plan.dollars * quantity * 1e6 + input.bonusTokens) : formatTokens(total + input.bonusTokens);
    parts.push(english ? `🎀 +${plan.bonusPercent}% REVIEW BONUS: +${bonus} (${sum} TOTAL)` : `🎀 +${plan.bonusPercent}% ЗА ОТЗЫВ: +${bonus} (ИТОГО ${sum})`);
  }
  parts.push(english ? "Thanks for the review! 🤝" : "Благодарим за отзыв! 🤝");
  return parts.join(" ✦ ");
}
function helpText(shop) {
  return [
    `✨ Я ассистент магазина ${shop}: подберу пакет, помогу подключить ключ и проверить остаток.`,
    "",
    "Команды:",
    "!продавец (или !seller) — позвать продавца; до его ответа я молчу в этом чате",
    "!баланс (или !balance) — сколько осталось на ваших ключах",
    "!помощь (или !help) — эта памятка"
  ].join("\n");
}
var SELLER_CALLED_TEXT = "📍 Продавец уже в курсе — ответит здесь лично, как только сможет. Пока он не ответит, я молчу.";
var SELLER_ALREADY_CALLED_TEXT = "📍 Продавец уже позван и скоро будет здесь 🤝";
var REFUND_HANDOFF_TEXT = "📍 Возвраты и спорные вопросы решает только продавец — я его уже позвал, он ответит здесь. До его ответа я молчу.";
var AI_HANDOFF_TEXT = "📍 Тут лучше ответит продавец — уже позвал его, он напишет здесь 🤝";
var AI_UNAVAILABLE_TEXT = "📍 Не могу ответить автоматически прямо сейчас — позвал продавца, он ответит здесь 🤝";
var OFF_TOPIC_PREFIX = "Я отвечаю только по ключам";
function offTopicText(shop) {
  return `${OFF_TOPIC_PREFIX} магазина ${shop}: пакеты, модели, подключение, заказы. Спрашивайте об этом — помогу! Продавец: !продавец`;
}
function balanceText(lines, links) {
  if (!lines.length) {
    return `Ключей, выданных вам в этом чате, не нашёл 🤔 Остаток любого ключа можно проверить на ${links.siteHost} — \xABПроверка баланса\xBB.`;
  }
  const rows = lines.map((line2) => {
    const orders = line2.orderIds.map((id) => `#${id}`).join(", ");
    const head2 = `• ${line2.preview} \xB7 ${line2.label} (${orders}) — `;
    if (line2.deleted) return `${head2}удалён`;
    if (!line2.active) return `${head2}отключён`;
    return `${head2}${line2.billing === "usd" ? `${formatDollars(line2.tokensLeft)} из ${formatDollars(line2.tokenLimit)}` : `${formatTokens(line2.tokensLeft)} из ${formatTokens(line2.tokenLimit)} токенов`}`;
  });
  return ["🪙 Ваши ключи:", ...rows, "", `Остаток любого ключа — \xABПроверка баланса\xBB на ${links.siteHost}.`].join("\n");
}
function formatMoscow(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}


// src/templates.ts
var DEFAULT_TEMPLATES = {
  ai_title_ru: "🧩 {family} | 🔑 API КЛЮЧ | {kind} {amount} {marker}",
  ai_title_en: "🧩 {family_en} | 🔑 API KEY | {kind_en} {amount_en} {marker}",
  ai_desc_ru: [
    "🧩 {family} — доступ через личный API-ключ.",
    "{details}",
    "",
    "После оплаты ключ и адрес подключения придут в чат заказа. Настройку для Windows и macOS бот пришлёт отдельным сообщением.",
    "Свой аккаунт передавать не нужно. Можно подключить OpenCode, Claude Code, Codex, Cursor или собственное приложение; доступные модели зависят от пакета.",
    "1 шт. = один пакет. При повторной покупке совместимый ключ пополняется — повторная настройка не нужна.",
    "Это API-доступ, а не подписка на сайте модели. Вопросы перед покупкой или помощь с подключением: напишите в чат; живой продавец — !продавец."
  ].join("\n"),
  ai_desc_en: [
    "🧩 {family_en} — access with your own API key.",
    "{details_en}",
    "",
    "After payment, the key and connection address arrive in the order chat. The bot sends Windows and macOS setup steps separately.",
    "No access to your account is needed. Connect OpenCode, Claude Code, Codex, Cursor or your own application; available models depend on the pack.",
    "1 unit = one pack. A repeat purchase tops up a compatible key, so you keep your setup.",
    "API access, not a subscription on the model's website. Ask in chat before buying or for setup help; contact the seller with !seller."
  ].join("\n"),
  ai_payment_ru: "Пакет оплачен — бот подготовит ключ и пришлёт адрес подключения в этот чат. Если нужна помощь, напишите !продавец.",
  ai_payment_en: "Payment received — the bot will prepare your key and send the connection address to this chat. Need help? Send !seller.",
  /* -------------------------------------------------------- Steam lots */
  steam_title_ru: "🎮 {game} ⏰ {duration} аренды 🚀 Выдача сразу{bonus_title} {marker}",
  steam_title_en: "🎮 {game} ⏰ {duration_en} rental 🚀 Instant{bonus_title_en} {marker}",
  steam_desc_ru: [
    "🎮 {game} — Steam-аккаунт в аренду на {duration}.",
    "",
    "✨ Как это работает:",
    "🚀 Оплатили — бот за минуту присылает логин и пароль в этот чат",
    "🔐 Код Steam Guard — командой !steam НОМЕР_ЗАКАЗА, в любой момент",
    "⏱️ 1 шт. = {hours} ч. на одном аккаунте; 2 шт. = {hours2} ч. Время идёт с момента выдачи, скачивание входит в аренду",
    "🔄 Продление: купите ещё раз до конца аренды — часы добавятся к тому же аккаунту",
    "⏳ За 10 минут до конца бот напомнит",
    "{bonus_line}",
    "📋 Команды: !steam \xB7 !аренда \xB7 !отзыв \xB7 !продавец",
    "",
    "⚠️ Это временный доступ к аккаунту, а не ключ игры и не передача аккаунта. Не меняйте пароль и почту и не передавайте доступ. DLC, язык и мультиплеер не обещаем — уточните до оплаты."
  ].join("\n"),
  steam_desc_en: [
    "🎮 {game} — Steam account rental for {duration_en}.",
    "",
    "✨ How it works:",
    "🚀 Pay — within a minute the bot sends the login and password to this chat",
    "🔐 Steam Guard code any time: !steam ORDER_ID",
    "⏱️ 1 unit = {hours} h on one account; 2 units = {hours2} h. Time starts when the account is issued; downloading counts",
    "🔄 To extend, buy again before it ends — the hours go to the same account",
    "⏳ The bot reminds you 10 minutes before the end",
    "{bonus_line_en}",
    "📋 Commands: !steam \xB7 !rental \xB7 !review \xB7 !seller",
    "",
    "⚠️ Temporary access to a rental account, not a game key or ownership. Do not change the password or email or share access. No promise of DLC, language or multiplayer — ask before paying."
  ].join("\n"),
  steam_bonus_title: "🎁 +{bonus} ч. за отзыв",
  steam_bonus_title_en: "🎁 +{bonus}h for a review",
  steam_bonus_line: "🎁 +{bonus} ч. к аренде за любой честный отзыв: оставьте его, пока аренда идёт, и напишите !отзыв НОМЕР_ЗАКАЗА",
  steam_bonus_line_en: "🎁 +{bonus} h for any honest review: post it while the rental runs and send !review ORDER_ID",
  steam_payment_ru: "🙌 Оплата пришла! Бот уже готовит аккаунт {game} — логин и пароль придут сюда за пару минут. Не пришли за 5 минут — напишите !продавец.",
  steam_payment_en: "🙌 Payment received! The bot is preparing your {game} account — the login and password arrive here within a couple of minutes. Nothing after 5 minutes? Send !seller.",
  /* -------------------------------------------------------- Steam messages */
  steam_delivered: [
    "🎉 {shop} \xB7 заказ #{order}",
    "🎮 {game} \xB7 {hours} ч.",
    "👤 Логин: {login}",
    "🔑 Пароль: {password}",
    "⏳ Доступ до {expires} МСК",
    "1️⃣ Войдите в Steam с этими данными",
    "2️⃣ Попросит код Steam Guard — напишите !steam {order}",
    "3️⃣ Установите игру из библиотеки (скачивание входит во время аренды)",
    "{bonus_delivered}",
    "ℹ️ Сколько осталось: !аренда {order} \xB7 Помощь: !продавец"
  ].join("\n"),
  steam_bonus_delivered: "🎁 +{bonus} ч. за отзыв: оставьте отзыв и напишите !отзыв {order}",
  steam_extended: "🔄 {shop} \xB7 заказ #{order}: к вашему аккаунту {game} добавлено {hours} ч. Логин и пароль прежние.\n⏳ Доступ до {expires} МСК\nКод Steam Guard: !steam {order} \xB7 Сколько осталось: !аренда {order}",
  steam_guard: "🔐 Steam Guard \xB7 заказ #{order}: {code}\nКод действует {seconds} сек.",
  steam_guard_unavailable: "🔐 Код Steam Guard сейчас недоступен — повторите !steam {order} через минуту.",
  steam_status: "⏳ {game} \xB7 заказ #{order}\nАренда идёт до {expires} МСК — осталось {minutes} мин.",
  steam_status_ended: "⌛ Аренда по заказу #{order} закончилась. Хотите ещё — купите лот снова, а если что-то не так — !продавец.",
  steam_bonus_added: "🎁 Спасибо за отзыв! К аренде по заказу #{order} добавлено {bonus} ч. Доступ до {expires} МСК.",
  steam_bonus_no_review: "🎁 Отзыв к заказу #{order} пока не виден на FunPay. Оставьте его, пока аренда идёт, и снова напишите !отзыв {order}.",
  steam_bonus_already: "🎁 Бонус за отзыв к заказу #{order} уже начислен.",
  steam_bonus_none: "В заказе #{order} бонус за отзыв не предусмотрен.",
  steam_bonus_ended: "🎁 Аренда по заказу #{order} уже закончилась — бонус добавить нельзя. Если нужна помощь — !продавец.",
  steam_pick_order: "Укажите номер заказа, например: !steam {example}",
  steam_no_rental: "Активной аренды не нашёл. Укажите номер заказа (например, !steam ABCD1234) или напишите !продавец.",
  steam_reminder: "⏳ {game}: аренда закончится примерно через {minutes} мин. ({expires} МСК).\n🔄 Хотите продолжить на этом же аккаунте — купите ещё часы до конца аренды: {link}\n1 шт. = {hours} ч., количество добавляет часы.",
  steam_reminder_nolink: "⏳ {game}: аренда закончится примерно через {minutes} мин. ({expires} МСК). Чтобы продлить, напишите !продавец.",
  steam_waiting: "⏳ Заказ #{order}: все аккаунты {game} сейчас заняты. Бот выдаст аккаунт, как только он освободится (обычно в течение получаса), и напишет сюда.",
  /* -------------------------------------------------------- SMM lots */
  smm_title_ru: "{emoji} {network} \xB7 {what}{tag} \xB7 {pack} шт. за 1 💥 Автостарт{warranty_title} {marker}",
  smm_title_en: "{emoji} {network} \xB7 {what_en}{tag_en} \xB7 {pack} per unit 💥 Auto start{warranty_title_en} {marker}",
  smm_desc_ru: [
    "{emoji} {network}: {what}{tag}.",
    "📦 1 шт. = {pack}; 10 шт. = {pack10}. До {max} за один заказ.",
    "",
    "🔗 После оплаты пришлите в этот чат одним сообщением: {target}",
    "⚡ Бот запустит заказ сам, сразу после ссылки. {speed}",
    "🛡️ {warranty}",
    "🔓 Пароль не нужен. {note}",
    "✅ Готово — бот напишет сюда. Проверьте результат и подтвердите заказ.",
    "💬 Вопросы: !продавец"
  ].join("\n"),
  smm_desc_en: [
    "{emoji} {network}: {what_en}{tag_en}.",
    "📦 1 unit = {pack}; 10 units = {pack10}. Up to {max} per order.",
    "",
    "🔗 After payment send in one message: {target_en}",
    "⚡ The bot starts the order right after the link. {speed_en}",
    "🛡️ {warranty_en}",
    "🔓 No password needed. {note_en}",
    "✅ When done, the bot writes here. Check it and confirm the order.",
    "💬 Questions: !seller"
  ].join("\n"),
  smm_payment_ru: "🙌 Спасибо за заказ! Пришлите сюда одним сообщением: {target} — бот запустит всё автоматически.",
  smm_payment_en: "🙌 Thank you! Send here in one message: {target_en} — the bot starts automatically.",
  /* -------------------------------------------------------- SMM messages */
  smm_ask_link: "🚀 {shop} \xB7 заказ #{order}: {what} \xB7 {quantity} шт.\nПришлите одним сообщением: {target}. Ссылка начинается с https://",
  smm_remind_link: "🔗 Чтобы запустить заказ #{order}, пришлите: {target}. Нужен продавец — !продавец",
  smm_wrong_link: "🚫 Эта ссылка не подходит для заказа #{order}: {problem}\nНужна {target}. Пришлите её одним сообщением.",
  smm_started: "✅ Ссылку получил — заказ #{order} запущен ({quantity} шт.). Старт обычно в течение нескольких часов, я напишу здесь, когда всё будет готово 🚀",
  smm_done: "🎉 Заказ #{order} выполнен! Проверьте результат — если всё хорошо, подтвердите заказ, пожалуйста. Спасибо, что выбрали {shop} 💙",
  smm_seller: "📍 По заказу #{order} нужна проверка продавца — я уже позвал его, он ответит здесь лично 🙏",
  /* -------------------------------------------------------- after confirmation, reviews */
  goods_thanks: "🤝 Спасибо, что подтвердили заказ #{order}! Будем рады вашему отзыву — он очень помогает магазину {shop} 💙",
  goods_thanks_reviewed: "🤝 Заказ #{order} подтверждён, отзыв получили — спасибо! Возвращайтесь в {shop} 💙",
  goods_review_reply: "✨ {shop_upper} ✦ {product} ✦ Спасибо за отзыв и за то, что выбрали нас! 🤝",
  goods_review_reply_en: "✨ {shop_upper} ✦ {product} ✦ Thanks for the review and for choosing us! 🤝"
};
function publicLotFields(fields) {
  for (const [name, value] of fields) {
    if (/^fields\[(summary|desc)\]/.test(name) && /api\.gserver\.online/i.test(value)) throw new Error("Уберите адрес API из публичного текста лота; бот отправит его покупателю после оплаты");
  }
  return fields;
}
var cached = null;
function overrides() {
  if (!existsSync4(TEMPLATES_FILE)) return {};
  try {
    const mtimeMs = statSync2(TEMPLATES_FILE).mtimeMs;
    if (cached?.mtimeMs === mtimeMs) return cached.values;
    const raw = JSON.parse(readFileSync4(TEMPLATES_FILE, "utf8"));
    const values = {};
    for (const [name, value] of Object.entries(raw)) {
      if (name in DEFAULT_TEMPLATES && typeof value === "string" && value.trim()) values[name] = value;
      else if (name in DEFAULT_TEMPLATES && Array.isArray(value) && value.every((line2) => typeof line2 === "string")) values[name] = value.join("\n");
    }
    cached = { mtimeMs, values };
    return values;
  } catch (error) {
    if (cached?.mtimeMs !== -1) console.error(`lot-templates.json не прочитан (${error instanceof Error ? error.message : String(error)}) — используются тексты по умолчанию`);
    cached = { mtimeMs: -1, values: {} };
    return {};
  }
}
function rawTemplate(name) {
  return overrides()[name] ?? DEFAULT_TEMPLATES[name];
}
function fill(name, vars) {
  const template = rawTemplate(name);
  const value = (key) => vars[key] === null || vars[key] === void 0 ? "" : String(vars[key]);
  const lines = [];
  for (const line2 of template.split("\n")) {
    const filled = line2.replace(/\{([a-z0-9_]+)\}/g, (_, key) => value(key));
    if (!filled.trim() && line2.trim()) continue;
    lines.push(filled.replace(/\s+$/, ""));
  }
  return lines.join("\n").trim();
}
var TITLE_MAX = 100;
function lotTitle(name, vars, marker, shorten) {
  let title = fill(name, { ...vars, marker });
  if (!title.includes(marker)) title = `${title} ${marker}`;
  if (title.length <= TITLE_MAX) return title;
  const value = String(vars[shorten] ?? "");
  const room = Math.max(4, value.length - (title.length - TITLE_MAX) - 1);
  title = fill(name, { ...vars, marker, [shorten]: `${value.slice(0, room).trimEnd()}…` });
  if (!title.includes(marker)) title = `${title} ${marker}`;
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - marker.length - 2).trimEnd()}… ${marker}`;
}
var plain = (text) => text.replace(/[\n\r`]/g, " ").replace(/\s+/g, " ").trim();
function durationRu(hours) {
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24} дн.`;
  return hours === 1 ? "1 час" : `${hours} ч.`;
}
function durationEn(hours) {
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24} day${hours === 24 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
function steamLotTexts(game, productId, hours, bonusHours, marker) {
  const name = plain(game);
  const vars = {
    game: name,
    hours,
    hours2: hours * 2,
    duration: durationRu(hours),
    duration_en: durationEn(hours),
    bonus: bonusHours,
    product: productId,
    bonus_title: bonusHours ? `${" "}${fill("steam_bonus_title", { bonus: bonusHours })}` : "",
    bonus_title_en: bonusHours ? `${" "}${fill("steam_bonus_title_en", { bonus: bonusHours })}` : "",
    bonus_line: bonusHours ? fill("steam_bonus_line", { bonus: bonusHours }) : "",
    bonus_line_en: bonusHours ? fill("steam_bonus_line_en", { bonus: bonusHours }) : ""
  };
  const titleVars = { ...vars, game: name.toLocaleUpperCase("ru-RU") };
  return {
    ru: { title: lotTitle("steam_title_ru", titleVars, marker, "game"), description: fill("steam_desc_ru", vars), payment: fill("steam_payment_ru", vars) },
    en: { title: lotTitle("steam_title_en", titleVars, marker, "game"), description: fill("steam_desc_en", vars), payment: fill("steam_payment_en", vars) }
  };
}
var moscow = (iso) => formatMoscow(typeof iso === "string" ? Date.parse(iso) : iso);
var EMOJI2 = { Telegram: "✈️", TikTok: "🎵", YouTube: "▶️", Instagram: "📸", Twitter: "𝕏", Kick: "🟩" };
var capital2 = (text) => text.charAt(0).toUpperCase() + text.slice(1);
var count = (value, language) => value.toLocaleString(language === "ru" ? "ru-RU" : "en-US").replace(/\s/g, " ");
function warrantyTitle(warranty, language) {
  if (typeof warranty === "number") return language === "ru" ? ` \xB7 ♻️ гарантия ${warranty} дн.` : ` \xB7 ♻️ ${warranty}-day refill`;
  if (warranty === "forever") return language === "ru" ? " \xB7 ♻️ гарантия навсегда" : " \xB7 ♻️ lifetime refill";
  if (warranty === "nodrop") return language === "ru" ? " \xB7 🛡️ без списаний" : " \xB7 🛡️ non-drop";
  return "";
}
function smmVars(item) {
  return {
    emoji: EMOJI2[item.network] ?? "⭐",
    network: item.network,
    what: capital2(item.what.ru),
    what_en: capital2(item.what.en),
    what_lower: item.what.ru,
    tag: item.tag ? ` ${item.tag.ru}` : "",
    tag_en: item.tag ? ` ${item.tag.en}` : "",
    pack: count(item.pack_size, "ru"),
    pack10: count(item.pack_size * 10, "ru"),
    max: count(item.pack_size * item.max_packs, "ru"),
    target: item.target.ru,
    target_en: item.target.en,
    speed: item.speed.ru,
    speed_en: item.speed.en,
    note: item.note.ru,
    note_en: item.note.en,
    warranty: item.warranty_text.ru,
    warranty_en: item.warranty_text.en,
    warranty_title: warrantyTitle(item.warranty, "ru"),
    warranty_title_en: warrantyTitle(item.warranty, "en")
  };
}
function smmLotTexts(item, marker) {
  const vars = smmVars(item);
  return {
    ru: { title: lotTitle("smm_title_ru", vars, marker, "what"), description: fill("smm_desc_ru", vars), payment: fill("smm_payment_ru", vars) },
    en: { title: lotTitle("smm_title_en", { ...vars, pack: count(item.pack_size, "en") }, marker, "what_en"), description: fill("smm_desc_en", { ...vars, pack: count(item.pack_size, "en"), pack10: count(item.pack_size * 10, "en"), max: count(item.pack_size * item.max_packs, "en") }), payment: fill("smm_payment_en", vars) }
  };
}


// src/ai-lots.ts
var AI_CATEGORIES = [
  { id: "opencode", name: "OpenCode AI \xB7 Токены", label: "OpenCode \xB7 все модели GPT/Claude/Gemini", node: 4752, group: "full", rate: "gemini" },
  { id: "gpt", name: "ChatGPT \xB7 Токены", label: "GPT", node: 4448, group: "gpt", rate: "gpt" },
  { id: "claude", name: "Claude \xB7 Токены", label: "Claude", node: 4234, group: "claude", rate: "claude" },
  { id: "gemini", name: "Gemini \xB7 Токены", label: "Gemini", node: 4615, group: "gemini", rate: "gemini" },
  { id: "kimi", name: "Kimi \xB7 Токены", label: "Kimi", node: 4614, group: "kimi", rate: "kimi" },
  { id: "glm", name: "GLM \xB7 Токены", label: "GLM", node: 4676, group: "glm", rate: "glm" },
  { id: "qwen", name: "QwenCloud", label: "Qwen", node: null, group: "qwen", rate: "qwen" },
  { id: "deepseek", name: "DeepSeek", label: "DeepSeek V4 ID на базе Qwen", node: null, group: null, rate: "qwen" }
];
// This shop sells one multi-model token key in every AI category.
for (const category of AI_CATEGORIES) if (category.node !== null) category.group = "full";
function isAiTokenDestination(item) {
  return AI_CATEGORIES.some((c) => c.node !== null && c.node === item.node && c.id === item.ai?.category);
}
function aiPrice(pack, settings) {
  const rate = pack.billing === "usd" ? settings.rubPerDollar : settings.rubPerMillion;
  const override = pack.billing === "usd" ? settings.dollarPrices?.[String(pack.value)] : void 0;
  return rate > 0 ? Math.max(1, Math.ceil((override ?? pack.value * rate) * 100) / 100) : 0;
}
function aiQueue(settings, groups, rates) {
  return AI_CATEGORIES.filter((c) => settings.categories.includes(c.id)).flatMap((category) => {
    if (category.node === null) return [];
    const packs = [];
    const rate = rates[category.rate];
    if (settings.rubPerDollar > 0 && groups.has("full") && Number.isFinite(rate) && rate > 0) {
      packs.push(...settings.dollars.map((value) => ({ category: category.id, group: "full", billing: "usd", value, referenceRate: rate })));
    }
    if (settings.rubPerMillion > 0 && category.group && groups.has(category.group)) {
      packs.push(...settings.millions.map((value) => ({ category: category.id, group: category.group, billing: "tokens", value })));
    }
    return packs.map((ai) => ({
      kind: "ai",
      ai,
      node: category.node,
      amount: Math.min(100, Math.floor((ai.billing === "usd" ? 1e4 : 1e5) / ai.value)),
      marker: `[A${category.id.toUpperCase()}${ai.billing === "usd" ? "U" : "T"}${Math.round(ai.value * 100)}]`,
      name: `${category.label} \xB7 ${ai.billing === "usd" ? formatDollars(ai.value * 1e6) : formatTokens(ai.value * 1e6)}`
    }));
  });
}
function aiLotTexts(pack, marker) {
  const category = AI_CATEGORIES.find((c) => c.id === pack.category);
  if (!category) throw new Error("Неизвестная категория AI");
  const usd = pack.billing === "usd";
  const familyEn = category.id === "opencode" ? "OpenCode \xB7 ALL MODELS GPT/Claude/Gemini" : category.id === "deepseek" ? "DeepSeek V4 ID via Qwen" : category.label;
  const vars = {
    family: category.label,
    family_en: familyEn,
    amount: usd ? formatDollars(pack.value * 1e6) : `${formatTokens(pack.value * 1e6)} ТОКЕНОВ`,
    amount_en: usd ? formatDollars(pack.value * 1e6) : `${formatTokens(pack.value * 1e6)} TOKENS`,
    kind: usd ? "БАЛАНС" : "",
    kind_en: usd ? "BALANCE" : "",
    details: usd ? `Один баланс для Gemini, GPT, Claude, Kimi, GLM и Qwen. Каждый запрос списывается по тарифу выбранной модели. Это баланс в $, а не фиксированный пакет токенов. Количество в фильтре — ориентир по базовому тарифу ${category.rate} ($${pack.referenceRate}/1M); другие модели расходуют баланс иначе.` : `Вы получите ${formatTokens(pack.value * 1e6)} токенов для ${category.label}.`,
    details_en: usd ? `One balance for Gemini, GPT, Claude, Kimi, GLM and Qwen. Each request is charged at the selected model's rate. This is a dollar balance, not a fixed token pack. The quantity filter is an estimate at the base ${category.rate} rate ($${pack.referenceRate}/1M); other models consume the balance differently.` : `You receive ${formatTokens(pack.value * 1e6)} tokens for ${familyEn}.`
  };
  return {
    ru: { title: lotTitle("ai_title_ru", vars, marker, "family"), description: fill("ai_desc_ru", vars), payment: fill("ai_payment_ru", vars) },
    en: { title: lotTitle("ai_title_en", vars, marker, "family_en"), description: fill("ai_desc_en", vars), payment: fill("ai_payment_en", vars) }
  };
}
function newAiLotFields(html, item, price) {
  if (!isAiTokenDestination(item)) throw new Error("AI-лоты публикуются только в подтверждённые разделы \xABТокены\xBB. Услуги и другие разделы запрещены.");
  if (!item.ai || !Number.isFinite(price) || price <= 0) throw new Error("Проверьте пакет AI и цену");
  const doc = parse(html), form = doc.querySelector("form.form-offer-editor");
  if (!form) {
    if (/Много предложений,?\s*подождите/i.test(doc.text)) throw new SmmSlowDownError("FunPay просит подождать с новыми лотами");
    if (/много предложений в разделе|максимальное количество|достигнут.{0,30}(?:лотов|предложений)|раздел.{0,30}заполнен|не более 20/i.test(doc.text)) throw new SmmSectionFullError("Раздел AI заполнен на FunPay");
    throw new Error("FunPay не открыл редактор лота AI");
  }
  const fields = new URLSearchParams();
  const selects = /* @__PURE__ */ new Map();
  for (const field of form.querySelectorAll("input[name], textarea[name], select[name]")) {
    const name = field.getAttribute("name"), type = field.getAttribute("type") ?? "";
    if (field.hasAttribute("disabled") || ["submit", "file", "button", "reset"].includes(type)) continue;
    if (["checkbox", "radio"].includes(type) && !field.hasAttribute("checked")) continue;
    if (field.tagName === "SELECT") {
      selects.set(name, field.querySelectorAll("option").map((o) => ({ value: o.getAttribute("value") ?? o.text, text: o.text.trim() })));
      fields.set(name, "");
    } else fields.set(name, field.tagName === "TEXTAREA" ? field.text : field.getAttribute("value") ?? "");
  }
  if (!fields.get("csrf_token") || fields.get("node_id") !== String(item.node) || !fields.has("price") || !fields.has("fields[summary][ru]") || fields.get("offer_id") && fields.get("offer_id") !== "0") throw new Error("FunPay вернул другую форму лота");
  if (!/₽|руб|RUB/i.test(form.querySelector(".form-control-feedback")?.text ?? "")) throw new Error("Выкладка AI работает для аккаунта FunPay в рублях");
  const tokens = Math.floor(item.ai.value * 1e6 / (item.ai.billing === "usd" ? item.ai.referenceRate : 1));
  if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error("Не удалось рассчитать ориентир количества токенов");
  for (const [name, options] of selects) {
    let selected = "";
    if (name === "fields[quantity]") {
      selected = (options.find((o) => item.ai.billing === "tokens" && o.text === `${item.ai.value}кк токенов`) ?? options.find((o) => /другое количество/i.test(o.text)))?.value ?? "";
      if (fields.has("fields[quantity2]")) fields.set("fields[quantity2]", String(tokens));
    } else if (name === "fields[method]") selected = options.find((o) => o.text === "Без захода на аккаунт")?.value ?? "";
    else if (name === "fields[model]") selected = options.find((o) => /друг|проч/i.test(o.text))?.value ?? "";
    if (!selected) throw new Error(`В форме AI выберите поддерживаемое значение поля ${name}; лот не отправлен`);
    fields.set(name, selected);
  }
  const texts = aiLotTexts(item.ai, item.marker);
  for (const lang of ["ru", "en"]) {
    const detected = detectLot(texts[lang].title);
    const grant = detected && "plan" in detected ? grantFor(detected.plan, 1) : null;
    if (!grant || grant.group !== item.ai.group || (grant.billing ?? "tokens") !== item.ai.billing || grant.tokens !== Math.round(item.ai.value * 1e6)) throw new Error("Название AI не соответствует пакету: сохраните семейство, API КЛЮЧ/API KEY и точный объём или баланс");
    for (const [key, value] of [["summary", texts[lang].title], ["desc", texts[lang].description], ["payment_msg", texts[lang].payment]]) {
      if (lang === "en" && /[А-Яа-яЁё]/.test(value)) throw new Error("Английское описание AI содержит русский текст; исправьте английский шаблон перед выкладкой");
      if (/api\.gserver\.online/i.test(value)) throw new Error("Уберите адрес API из публичного текста лота; бот отправит его после оплаты");
      if (fields.has(`fields[${key}][${lang}]`)) fields.set(`fields[${key}][${lang}]`, value);
    }
  }
  fields.set("price", price.toFixed(2));
  fields.set("amount", String(item.amount));
  fields.delete("active");
  fields.delete("auto_delivery");
  fields.delete("secrets");
  return fields;
}
var AiLots = class {
  constructor(config, store, api, client) {
    this.config = config;
    this.store = store;
    this.api = api;
    this.client = client;
  }
  lastSync = 0;
  running = null;
  get settings() {
    return this.store.state.goods.ai;
  }
  setSettings(settings) {
    if (![settings.rubPerDollar, settings.rubPerMillion].every((n) => Number.isFinite(n) && n >= 0 && n <= 1e6)) return "Цена: от 0 до 1 000 000 ₽; 0 отключает этот вид пакетов";
    const hundredths = (n) => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-7;
    if (!settings.dollars.length || !settings.millions.length || settings.dollars.length > 20 || settings.millions.length > 20 || !settings.dollars.every((n) => hundredths(n) && n >= 0.01 && n <= 1e4) || !settings.millions.every((n) => hundredths(n) && n >= 0.1 && n <= 1e5)) return "Укажите от 1 до 20 размеров пакетов, до 2 знаков после точки: $0.01–10 000, 0.1–100 000M";
    if (Object.entries(settings.dollarPrices ?? {}).some(([pack, price]) => !hundredths(Number(pack)) || Number(pack) < 0.01 || Number(pack) > 1e4 || !hundredths(price) || price < 1 || price > 1e6)) return "Индивидуальные цены: пакет=цена, например 0.5=1; цена от 1 до 1 000 000 ₽";
    if (!settings.categories.length || settings.categories.some((id) => !AI_CATEGORIES.some((c) => c.id === id && c.node !== null))) return "Выберите категории AI с подтверждённым разделом \xABТокены\xBB";
    this.store.state.goods.ai = { ...settings, dollarPrices: { ...settings.dollarPrices }, dollars: [...new Set(settings.dollars)], millions: [...new Set(settings.millions)], categories: [...new Set(settings.categories)] };
    this.lastSync = 0;
    this.store.save();
    return "Настройки AI сохранены. Проверьте предпросмотр и отправьте выбранные лоты в очередь.";
  }
  async preview() {
    const [models, rates] = await Promise.all([this.api.models(), this.api.rates()]);
    return aiQueue(this.settings, new Set(models.groups.map((g) => g.group)), rates.usd_per_million);
  }
  async queue(publisher, markers) {
    if (!this.settings.enabled) return "Сначала включите лоты AI";
    const selected = new Set(markers);
    const items = (await this.preview()).filter((i) => selected.has(i.marker));
    if (!items.length) return "Нет выбранных доступных лотов AI — проверьте цены и группы моделей";
    const added = publisher.enqueue(items, `AI: в очереди ${items.length} лотов`);
    return `Добавлено лотов AI: ${added}. Общая очередь со Steam и SMM, не чаще одного лота в минуту.`;
  }
  async prepare(item, html) {
    if (!isAiTokenDestination(item)) throw new Error("Выкладка AI вне раздела \xABТокены\xBB запрещена");
    if (!this.settings.enabled || !item.ai) throw new Error("Лоты AI выключены");
    const current = (await this.preview()).find((i) => i.marker === item.marker);
    if (!current?.ai) throw new Error("Пакет AI больше не доступен — проверьте настройки");
    return { fields: newAiLotFields(html, current, aiPrice(current.ai, this.settings)) };
  }
  tick() {
    if (existsSync(join(DATA_DIR, "ai-lots-maintenance.lock"))) return;
    const interval = this.config.checkSeconds ? Math.min(12e4, this.config.checkSeconds * 1e3) : 12e4;
    if (this.running || Date.now() - this.lastSync < interval) return;
    this.lastSync = Date.now();
    this.running = this.sync().catch((error) => logWarn("lots.ai_sync", `Лоты AI: ${error instanceof Error ? error.message : String(error)}`)).finally(() => {
      this.running = null;
    });
  }
  async sync() {
    const lots2 = Object.values(this.store.state.goods.lots).filter((l) => l.kind === "ai");
    if (!lots2.length) return;
    let available = [], me = null;
    try {
      [available, me] = await Promise.all([this.preview(), this.api.me()]);
    } catch {
    }
    for (const lot of lots2) {
      const item = available.find((i) => i.marker === lot.marker), pack = item?.ai ?? lot.ai;
      const funded = !!pack && !!me && (pack.billing === "usd" ? (me.usd_pool?.balance ?? 0) >= pack.value : me.pool.balance >= pack.value * 1e6);
      const active = this.settings.enabled && this.store.state.toggles.deliveryEnabled && !!item && item.node === lot.node && isAiTokenDestination(lot) && funded;
      const price = pack ? aiPrice(pack, this.settings) : 0;
      const target = price > 0 ? price : lot.price;
      if (this.config.dryRun || target === null || lot.active === active && lot.price === target && Date.now() - lot.syncedAt < 12 * 36e5) continue;
      try {
        await this.client.updateSteamLot(lot.lotId, lot.marker, target, active);
        Object.assign(lot, { price: target, active, syncedAt: Date.now(), error: active ? null : "AI выключен, пакет недоступен или не хватает пула" });
      } catch (error) {
        lot.error = error instanceof Error ? error.message.slice(0, 200) : "Не удалось обновить лот AI";
        break;
      }
      this.store.save();
    }
  }
};


// src/goods.ts
var STEAM_CATALOG_MS = 2 * 6e4;
var SMM_CATALOG_MS = 10 * 6e4;
var POOL_MS = 6e4;
var STEAM_SYNC_MS = 2 * 6e4;
var SMM_SYNC_MS = 5 * 6e4;
var RECHECK_MS = 12 * 60 * 6e4;
var REMINDER_CHECK_MS = 6e4;
var REMIND_BEFORE_MS = 10 * 6e4;
var SMM_SERVE_MS = 2e4;
var SMM_STATUS_MS = Math.max(5, Number(process.env.RESELLER_BOT_SMM_STATUS_SECONDS) || 300) * 1e3;
var SMM_REMIND_MS = 10 * 6e4;
var STOCK_WAIT_MS = 30 * 6e4;
var STALE_CATALOG_MS = 15 * 6e4;
var EARLY_LINK_MS = 60 * 6e4;
var POOL_STEAM_NOTE = "На отдельном балансе Steam не хватает денег. Пополните баланс Steam у владельца сервиса и нажмите \xABВыдать снова\xBB. Общий пул $ для аренды не используется.";
var POOL_USD_NOTE = "На отдельном балансе SMM не хватает денег. Пополните баланс SMM у владельца сервиса и нажмите \xABВыдать снова\xBB.";
function steamPrice(cost, bonusCost, markupPercent) {
  if (![cost, bonusCost, markupPercent].every(Number.isFinite) || cost <= 0 || bonusCost < 0 || markupPercent < 0) throw new Error("Сервис вернул неверную цену аренды");
  return { sale: Math.ceil(Math.max(1, cost * (1 + markupPercent / 100), cost + bonusCost + 0.01) * 100) / 100 };
}
var PLAYERS_URL = process.env.RESELLER_BOT_STEAM_PLAYERS_URL || "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/";
var GoodsSeller = class {
  constructor(config, store, api, client, host) {
    this.config = config;
    this.store = store;
    this.api = api;
    this.client = client;
    this.host = host;
    this.ai = new AiLots(config, store, api, client);
    this.publisher = new LotPublisher(client, store, { allowed: (item) => item.kind !== "ai" || isAiTokenDestination(item), prepare: (item) => this.prepare(item), linked: (item, lotId, found) => this.link(item, lotId, found) });
  }
  publisher;
  ai;
  steam = null;
  smm = null;
  pool = null;
  lastSteamSync = 0;
  lastSmmSync = 0;
  lastReminders = 0;
  lastSmmServe = 0;
  lastSmmStatus = 0;
  syncJob = null;
  refusedNote = null;
  soldOut = /* @__PURE__ */ new Map();
  earlyLinks = /* @__PURE__ */ new Map();
  warned = /* @__PURE__ */ new Set();
  /** checkSeconds (the local test only) shortens every interval. */
  every(ms) {
    return this.config.checkSeconds ? Math.min(ms, this.config.checkSeconds * 1e3) : ms;
  }
  get settings() {
    return this.store.state.goods.settings;
  }
  get on() {
    return this.settings.steamEnabled || this.settings.smmEnabled || this.ai.settings.enabled;
  }
  /** Availability changes take priority over raising offers in the shared FunPay request lane. */
  get syncing() {
    return this.syncJob !== null;
  }
  /** Why the service refused Steam/SMM (not switched on for this shop), for the panel. */
  get problem() {
    return this.refusedNote;
  }
  /** A sale's kind by the marker in its title: [R7-1] a Steam rental, [S01] an SMM service. */
  static kindOf(description) {
    if (parseSteamMarker(description)) return "steam";
    return /\[S\d{2,3}\]/.test(description) && (description.match(/\[S\d{2,3}\]/g) ?? []).length === 1 ? "smm" : null;
  }
  /* ------------------------------------------------------------ catalogs, pool */
  onRefused(error, what) {
    if (error instanceof ApiRefused && error.code === "goods_not_enabled") {
      if (this.refusedNote !== error.reason) logError("goods.not_enabled", `Steam и SMM: ${error.reason}`);
      this.refusedNote = error.reason;
      return;
    }
    const key = `${what}:${errorText(error)}`;
    if (!this.warned.has(key)) {
      this.warned.add(key);
      logWarn("goods.catalog", `${what}: сервис не ответил — ${errorText(error)}. Бот попробует позже`);
    }
  }
  async steamCatalog(fresh = false) {
    if (!fresh && this.steam && Date.now() - this.steam.at < this.every(STEAM_CATALOG_MS)) return this.steam.data;
    try {
      const data = await this.api.steamCatalog();
      this.steam = { at: Date.now(), data };
      this.refusedNote = null;
      const stockAt = Date.now();
      for (const [productId, at] of this.soldOut) if (stockAt > at && (data.games.find((g) => g.product_id === productId)?.available ?? 0) > 0) this.soldOut.delete(productId);
    } catch (error) {
      this.onRefused(error, "Каталог Steam");
    }
    return this.steam?.data ?? null;
  }
  async smmCatalog(fresh = false) {
    if (!fresh && this.smm && Date.now() - this.smm.at < this.every(SMM_CATALOG_MS)) return this.smm.items;
    try {
      const answer = await this.api.smmCatalog();
      this.smm = { at: Date.now(), items: answer.items, rate: answer.rub_per_usd };
      this.refusedNote = null;
    } catch (error) {
      this.onRefused(error, "Каталог SMM");
    }
    return this.smm?.items ?? [];
  }
  /** Rubles in the dollar pool at the service's rate. */
  async poolRub(kind = "smm") {
    if (!this.pool || Date.now() - this.pool.at > this.every(POOL_MS)) {
      const me = await this.api.me().catch(() => null);
      this.pool = { at: Date.now(), usd: me?.usd_pool?.balance ?? 0, steamUsd: me?.steam_pool?.balance ?? 0, smmUsd: me?.smm_pool?.balance ?? 0 };
    }
    return (kind === "steam" ? this.pool.steamUsd : this.pool.smmUsd) * this.rate();
  }
  rate() {
    return this.steam?.data.rub_per_usd ?? this.smm?.rate ?? 0;
  }
  /* ------------------------------------------------------------ prices */
  /** The service's price to the shop for one lot (rental + the review-bonus reserve), estimated by the hour. */
  steamCost(game, hours, bonusHours) {
    const listed = game.durations.find((d) => d.hours === hours)?.cost_rub;
    const cost = listed ?? Math.ceil(game.cost_per_hour_rub * hours * 100) / 100;
    const bonusCost = bonusHours ? Math.ceil(game.cost_per_hour_rub * Math.max(bonusHours, game.min_hours) * 100) / 100 : 0;
    return { cost, bonusCost };
  }
  /** The lot price: cost + markup, covering the bonus; never lower than before while the markup is the same. */
  keptPrice(lot, price, markup) {
    if (!lot || lot.markup !== markup || typeof lot.price !== "number") return price;
    return Math.max(price, lot.price);
  }
  steamLotPrice(game, hours, bonusHours, lot) {
    const { cost, bonusCost } = this.steamCost(game, hours, bonusHours);
    const sale = steamPrice(cost, bonusCost, this.settings.steamMarkupPercent).sale;
    return { price: this.keptPrice(lot, sale, this.settings.steamMarkupPercent), cost: cost + bonusCost };
  }
  smmLotPrice(item, lot) {
    const sale = Math.max(1, Math.ceil(item.pack_cost_rub * (1 + this.settings.smmMarkupPercent / 100) * 100) / 100);
    const price = sale <= item.pack_cost_rub ? Math.ceil((item.pack_cost_rub + 0.01) * 100) / 100 : sale;
    return { price: this.keptPrice(lot, price, this.settings.smmMarkupPercent), cost: item.pack_cost_rub };
  }
  /* ------------------------------------------------------------ publishing */
  bonusHours() {
    return this.steam?.data.bonus_hours ?? 0;
  }
  /** «Выложить топ»: the most-played games in stock, every duration, shortest lots first. */
  async queueTopSteam(count2) {
    if (!this.settings.steamEnabled) return "Сначала включите Steam";
    const catalog2 = await this.steamCatalog(true);
    if (!catalog2) return this.refusedNote ?? "Каталог Steam сейчас недоступен — повторите позже";
    const lots2 = this.store.state.goods.lots;
    const candidates = catalog2.games.filter((g) => g.available > 0 && g.steam_app_id && g.durations.some((d) => !lots2[steamMarker(g.product_id, d.hours)]));
    const players = /* @__PURE__ */ new Map();
    for (let i = 0; i < candidates.length; i += 6) {
      const counts = await Promise.all(candidates.slice(i, i + 6).map((g) => currentPlayers(g.steam_app_id)));
      counts.forEach((value, j) => players.set(candidates[i + j].product_id, value));
    }
    const top = candidates.filter((g) => (players.get(g.product_id) ?? -1) >= 0).sort((a, b) => players.get(b.product_id) - players.get(a.product_id)).slice(0, Math.max(1, Math.min(200, count2)));
    if (candidates.length && !top.length) return "Steam не вернул число игроков — повторите позже";
    const shared = new Set(Object.values(lots2).filter((lot) => lot.kind === "steam" && lot.node === FALLBACK_NODE).map((lot) => lot.productId));
    let room = Math.max(0, FALLBACK_GAMES - shared.size);
    const items = [];
    for (const game of top) {
      const node = game.funpay_node ?? FALLBACK_NODE;
      for (const { hours } of game.durations) {
        const marker = steamMarker(game.product_id, hours);
        if (lots2[marker]) continue;
        const item = { kind: "steam", marker, node, name: game.name, productId: game.product_id, hours, minHours: game.min_hours, amount: Math.max(1, Math.min(100, Math.floor(game.max_hours / hours))), players: players.get(game.product_id) };
        if (node === FALLBACK_NODE) {
          if (shared.has(game.product_id) || hours !== Math.max(1, game.min_hours) || !fallbackAllowed(item) || room <= 0) continue;
          room--;
        }
        items.push(item);
      }
    }
    this.store.state.goods.publisher.fallbackLeft = room;
    const added = this.publisher.enqueue(gamesFirst(items), `Топ-${top.length} игр Steam: в очереди ${items.length} лотов`);
    logInfo("lots.queue", `Выкладка Steam: топ-${top.length} игр по числу игроков, в очереди лотов: ${added}`);
    return `В очереди ${added} лотов Steam (${top.length} игр). Бот выкладывает по одному лоту в минуту.`;
  }
  /** «Выложить SMM»: every service of the catalog that has no lot yet. */
  async queueSmm() {
    if (!this.settings.smmEnabled) return "Сначала включите SMM";
    const items = await this.smmCatalog(true);
    if (!items.length) return this.refusedNote ?? "Каталог SMM сейчас недоступен — повторите позже";
    const lots2 = this.store.state.goods.lots;
    const queue = items.filter((item) => !lots2[`[${item.code}]`] && item.max_packs > 0).map((item) => ({
      kind: "smm",
      marker: `[${item.code}]`,
      node: item.funpay_node,
      name: `${item.network} \xB7 ${item.what.ru}${item.tag ? ` ${item.tag.ru}` : ""} \xB7 ${item.pack_size}`,
      code: item.code,
      amount: item.max_packs
    }));
    const added = this.publisher.enqueue(queue, `SMM: в очереди ${queue.length} лотов`);
    logInfo("lots.queue", `Выкладка SMM: в очереди лотов: ${added}`);
    return `В очереди ${added} лотов SMM.`;
  }
  async prepare(item) {
    const html = await this.client.newLotForm(item.node);
    if (item.kind === "ai") return this.ai.prepare(item, html);
    if (!/form-offer-editor/.test(html) && /Много предложений,?\s*подождите/i.test(html)) throw new SmmSlowDownError("FunPay просит подождать с новыми лотами");
    if (item.kind === "steam") {
      const catalog2 = await this.steamCatalog();
      const game = catalog2?.games.find((g) => g.product_id === item.productId);
      if (!game) throw new Error("Игры больше нет в каталоге");
      const exact = await this.api.steamQuote(item.productId, item.hours);
      const estimate = this.steamLotPrice(game, item.hours, this.bonusHours());
      const price2 = Math.max(estimate.price, steamPrice(exact.cost_rub, exact.bonus_cost_rub, this.settings.steamMarkupPercent).sale);
      const texts = steamLotTexts(game.name, game.product_id, item.hours, this.bonusHours(), item.marker);
      return { fields: publicLotFields(newSteamLotFields(html, item.node, texts, price2, item.amount, { gameName: game.name, accounts: this.client.isSteamAccountCategory(item.node) })), price: price2 };
    }
    const smmItem = (await this.smmCatalog()).find((entry) => entry.code === item.code);
    if (!smmItem) throw new Error("Услуги больше нет в каталоге");
    const { price } = this.smmLotPrice(smmItem);
    const plan = { marker: item.marker, network: smmItem.network, node: smmItem.funpay_node, type: smmItem.funpay_type, serviceId: smmItem.service_id, perUnit: smmItem.pack_size };
    const preview = { plan, service: null, salePer1000: null, price, cost: smmItem.pack_cost_rub, maxPacks: smmItem.max_packs, title: "", problem: null };
    return { fields: publicLotFields(newSmmLotFields(html, preview, false, smmLotTexts(smmItem, item.marker))), price };
  }
  link(item, lotId, found) {
    this.store.state.goods.lots[item.marker] = {
      kind: item.kind,
      ai: item.ai,
      marker: item.marker,
      lotId,
      node: item.node,
      name: item.name,
      productId: item.productId,
      hours: item.hours,
      code: item.code,
      // A found lot's price is unknown until the sync writes it.
      price: found ? null : null,
      active: false,
      markup: item.kind === "steam" ? this.settings.steamMarkupPercent : this.settings.smmMarkupPercent,
      syncedAt: 0,
      postedAt: Date.now(),
      error: null
    };
    this.store.save();
    if (item.kind === "steam") this.lastSteamSync = 0;
    else this.lastSmmSync = 0;
  }
  forgetLot(marker) {
    const lot = this.store.state.goods.lots[marker];
    if (!lot) return "Лот не найден";
    delete this.store.state.goods.lots[marker];
    this.store.save();
    logInfo("lots.forget", `Лот ${lot.name} ${marker} (#${lot.lotId}) убран из бота — на FunPay он остаётся как есть`);
    return "Лот убран из бота (на FunPay остаётся как есть)";
  }
  /* ------------------------------------------------------------ the tick */
  /** From the bot's tick: publishing and the lot sync run beside it, so chats are never held up. */
  async tick(deliveryEnabled) {
    if (!this.on && !Object.keys(this.store.state.goods.lots).length && this.store.state.goods.publisher.state !== "posting") return;
    this.ai.tick();
    const now = Date.now();
    void this.publisher.step(this.config.dryRun).catch((error) => logWarn("lots.error", `Выкладка: ${errorText(error)}`));
    if (!this.syncJob && (now - this.lastSteamSync >= this.every(STEAM_SYNC_MS) || now - this.lastSmmSync >= this.every(SMM_SYNC_MS))) {
      this.syncJob = this.syncLots().catch((error) => logWarn("lots.sync_error", `Цены и наличие лотов: ${errorText(error)}`)).finally(() => {
        this.syncJob = null;
      });
    }
    if (!deliveryEnabled) return;
    if (this.settings.steamEnabled && now - this.lastReminders >= this.every(REMINDER_CHECK_MS)) {
      this.lastReminders = now;
      await this.remindExpiring().catch((error) => logWarn("steam.reminder_error", `Напоминания об аренде: ${errorText(error)}`));
    }
    if (this.settings.smmEnabled && now - this.lastSmmServe >= this.every(SMM_SERVE_MS)) {
      this.lastSmmServe = now;
      await this.serveSmm().catch((error) => logWarn("smm.error", `SMM: ${errorText(error)}`));
    }
  }
  /** Price and on/off of every lot the bot keeps: written to FunPay only when they change (and twice a day). */
  async syncLots() {
    const now = Date.now();
    const steamDue = now - this.lastSteamSync >= this.every(STEAM_SYNC_MS);
    const smmDue = now - this.lastSmmSync >= this.every(SMM_SYNC_MS);
    if (steamDue) this.lastSteamSync = now;
    if (smmDue) this.lastSmmSync = now;
    if (steamDue) await this.steamCatalog(true);
    if (smmDue) await this.smmCatalog(true);
    const catalog2 = this.steam && now - this.steam.at < STALE_CATALOG_MS ? this.steam.data : null;
    const smmItems = this.smm && now - this.smm.at < STALE_CATALOG_MS ? this.smm.items : [];
    let on = 0, off = 0, written = 0;
    for (const lot of Object.values(this.store.state.goods.lots)) {
      if (lot.kind === "ai") continue;
      if (lot.kind === "steam" && !steamDue || lot.kind === "smm" && !smmDue) continue;
      let price = lot.kind === "steam" && lot.price !== null ? Math.max(1, lot.price) : lot.price;
      let active = false;
      let reason = null;
      if (lot.kind === "steam") {
        const game = catalog2?.games.find((g) => g.product_id === lot.productId);
        if (!catalog2) reason = "Каталог Steam недоступен — лот выключен";
        else if (!game) reason = "Игры нет в каталоге — лот выключен";
        else {
          const priced = this.steamLotPrice(game, lot.hours, this.bonusHours(), lot);
          price = priced.price;
          active = this.settings.steamEnabled && this.store.state.toggles.deliveryEnabled && game.available > 0 && !this.soldOut.has(game.product_id) && await this.poolRub("steam") >= priced.cost;
          if (!active) reason = !this.settings.steamEnabled ? "Steam выключен на панели" : game.available <= 0 || this.soldOut.has(game.product_id) ? "Нет свободных аккаунтов" : "На отдельном балансе Steam не хватает средств";
        }
      } else {
        const item = smmItems.find((entry) => entry.code === lot.code);
        if (!item) reason = smmItems.length ? "Услуги нет в каталоге — лот выключен" : "Каталог SMM недоступен — лот выключен";
        else {
          const priced = this.smmLotPrice(item, lot);
          price = priced.price;
          active = this.settings.smmEnabled && this.store.state.toggles.deliveryEnabled && item.available && await this.poolRub("smm") >= priced.cost;
          if (!active) reason = !this.settings.smmEnabled ? "SMM выключен на панели" : !item.available ? "Услуга сейчас недоступна" : "В пуле $ не хватает на заказ";
        }
      }
      if (price === null) continue;
      const markup = lot.kind === "steam" ? this.settings.steamMarkupPercent : this.settings.smmMarkupPercent;
      const changed = lot.price !== price || lot.active !== active || !lot.syncedAt || now - lot.syncedAt > RECHECK_MS;
      if (this.config.dryRun || !changed) {
        if (active) on++;
        else off++;
        continue;
      }
      try {
        await this.client.updateSteamLot(lot.lotId, lot.marker, price, active);
        written++;
        Object.assign(lot, { price, active, markup, syncedAt: Date.now(), error: active ? null : reason });
        if (active) on++;
        else off++;
      } catch (error) {
        lot.error = errorText(error).slice(0, 300);
        if (error instanceof FunPayRateLimitError) {
          this.lastSteamSync = this.lastSmmSync = error.retryAt - Math.min(this.every(STEAM_SYNC_MS), this.every(SMM_SYNC_MS));
          break;
        }
      }
      this.store.save();
    }
    this.store.save();
    if (written) logInfo("lots.sync", `Цены и наличие: обновлено лотов ${written}; сейчас включено ${on}, выключено ${off}`);
  }
  /** A game with no free account: its lots go off now, not at the next sync. */
  async switchOffGame(productId) {
    this.soldOut.set(productId, Date.now());
    if (this.config.dryRun) return;
    for (const lot of Object.values(this.store.state.goods.lots)) {
      if (lot.kind !== "steam" || lot.productId !== productId || !lot.active) continue;
      try {
        const price = lot.price === null ? null : Math.max(1, lot.price);
        await this.client.updateSteamLot(lot.lotId, lot.marker, price, false);
        Object.assign(lot, { price, active: false, syncedAt: Date.now(), error: "Нет свободных аккаунтов" });
      } catch (error) {
        lot.error = errorText(error).slice(0, 300);
      }
    }
    this.store.save();
  }
  /* ------------------------------------------------------------ Steam delivery */
  /** Delivers a paid Steam rental (from the bot's delivery pass). */
  async deliverSteam(order, detail) {
    if (order.delivery === "minted" && order.steam?.expiresAt) return this.sendRental(order);
    if (!detail) return this.host.failAttempt(order, "FunPay не вернул этот заказ");
    if (!this.settings.steamEnabled) return this.host.markFailed(order, "Steam выключен на панели бота — выдайте вручную или включите Steam и нажмите \xABВыдать снова\xBB");
    const marker = parseSteamMarker(order.description);
    const live = parseSteamMarker(detail.title ?? "");
    if (!marker || !live || live.productId !== marker.productId || live.hours !== marker.hours || detail.buyerId !== order.buyerId || detail.secrets.length) {
      return this.host.markFailed(order, "Заказ Steam не прошёл проверку: покупатель, маркер в названии лота или автовыдача FunPay — проверьте вручную");
    }
    const quantity = detail.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return this.host.markFailed(order, "FunPay не подтвердил количество в заказе");
    if (order.currency !== "RUB") return this.host.markFailed(order, "Аренда Steam выдаётся только за рубли — выдайте вручную");
    order.chatNode = detail.chatNode ?? order.chatNode;
    order.quantity = quantity;
    if (this.config.dryRun) {
      const note = `Тестовый режим: бот арендовал бы ${durationRu(marker.hours * quantity)} (игра #${marker.productId})`;
      if (order.deliveryError !== note) {
        order.deliveryError = note;
        this.store.save();
        logInfo("order.dry_run", `(тест) Заказ #${order.id}: ${note}`, { orderId: order.id });
      }
      return;
    }
    if (!order.steam?.expiresAt) {
      if (order.steam?.waitingSince && this.host.chatBusy(order.buyerId)) {
        return this.host.markFailed(order, "Ждали свободный аккаунт, но в чат позвали продавца — решите заказ вручную (вернуть деньги или выдать позже)");
      }
      const rate = this.rate() || (await this.steamCatalog())?.rub_per_usd || 0;
      const paidRub = order.amountMinor / 100;
      let answer;
      try {
        answer = await this.api.rentSteam({
          order_id: order.id,
          product_id: marker.productId,
          hours: marker.hours,
          quantity,
          buyer_id: String(order.buyerId),
          // Never pay the service more than the buyer paid for the lot.
          ...rate ? { max_cost_usd: Math.floor(paidRub / rate * 1e6) / 1e6 } : {}
        });
      } catch (error) {
        return this.onRentRefused(order, error, marker.productId);
      }
      const rental = answer.rental;
      if (rental.state === "review" || rental.state === "failed") {
        return this.host.markFailed(order, rental.state === "review" ? "Сервис проверяет эту аренду — дождитесь ответа владельца сервиса" : "Аренда не состоялась — деньги вернулись в пул; выдайте вручную или верните оплату");
      }
      if (rental.state !== "active" || !rental.expires_at) return this.host.failAttempt(order, "Аренда ещё не подтверждена — бот повторит");
      order.steam = { productId: marker.productId, hours: rental.hours, game: rental.game, expiresAt: rental.expires_at, mode: rental.mode, bonusHours: rental.bonus.hours, bonusState: rental.bonus.state, reminderFor: null, waitingSince: null };
      order.goodsCostRub = rental.cost_rub;
      Object.assign(order, { delivery: "minted", deliveryError: null });
      this.store.save();
      logInfo("steam.rented", `Заказ #${order.id}: ${rental.mode === "extend" ? "продлена аренда" : "арендован аккаунт"} ${rental.game} на ${rental.hours} ч. для ${order.buyerName} — $${rental.cost_usd}`, { orderId: order.id });
    }
    await this.sendRental(order);
  }
  onRentRefused(order, error, productId) {
    if (error instanceof ApiUnavailable || !(error instanceof ApiRefused)) return this.host.failAttempt(order, `Сервис не ответил: ${errorText(error)}`);
    switch (error.code) {
      case "out_of_stock":
        return this.waitForAccount(order, productId);
      case "insufficient_steam_pool":
      case "insufficient_pool":
        this.lastSteamSync = 0;
        return this.host.markFailed(order, POOL_STEAM_NOTE);
      case "price_changed":
        this.lastSteamSync = 0;
        return this.host.markFailed(order, "Аренда у сервиса подорожала и стоит больше, чем заплатил покупатель — бот поднимет цену лота; выдайте вручную или верните оплату");
      case "goods_not_enabled":
        return this.host.markFailed(order, `Сервис: ${error.reason}`);
      default:
        return this.host.markFailed(order, `Сервис отказал: ${error.reason}`);
    }
  }
  /** No free account: the game's lots go off, the buyer is told once, the order is tried every minute for 30 minutes. */
  async waitForAccount(order, productId) {
    const now = Date.now();
    const first = !order.steam?.waitingSince;
    order.steam = { ...order.steam ?? { productId, hours: 0, game: "", expiresAt: null, mode: "new", bonusHours: 0, bonusState: null, reminderFor: null }, waitingSince: order.steam?.waitingSince ?? now };
    if (now - order.steam.waitingSince >= STOCK_WAIT_MS) {
      this.host.sellerNeeded(order.buyerId, `Заказ #${order.id}: 30 минут нет свободного аккаунта`);
      return this.host.markFailed(order, "30 минут нет свободного аккаунта этой игры — верните оплату или выдайте позже вручную");
    }
    Object.assign(order, { delivery: "retry", lastAttemptAt: now, deliveryAttempts: Math.max(1, order.deliveryAttempts), deliveryError: `Ждём свободный аккаунт до ${moscow(order.steam.waitingSince + STOCK_WAIT_MS)} МСК` });
    this.store.save();
    if (first) {
      await this.switchOffGame(productId);
      const game = this.steam?.data.games.find((g) => g.product_id === productId)?.name ?? "этой игры";
      await this.host.send(this.host.nodeOf(order), fill("steam_waiting", { order: order.id, game })).catch(() => void 0);
      logWarn("steam.waiting", `Заказ #${order.id}: нет свободного аккаунта ${game} — лоты игры выключены, бот ждёт до 30 минут`, { orderId: order.id });
    }
  }
  /** The login and password (or the note about more hours) into the order chat. */
  async sendRental(order) {
    const steam = order.steam;
    if (steam.mode === "extend") {
      const text2 = fill("steam_extended", { shop: this.config.shopName, order: order.id, game: steam.game, hours: steam.hours, expires: moscow(steam.expiresAt) });
      return this.host.deliverMessage(order, text2, `${order.buyerName}: часы добавлены к текущему аккаунту ${steam.game}`);
    }
    let credentials;
    try {
      credentials = await this.api.steamCredentials(order.id);
    } catch (error) {
      return this.host.failAttempt(order, `Сервис не выдал логин и пароль: ${errorText(error)}`);
    }
    const bonus = steam.bonusHours ? fill("steam_bonus_delivered", { bonus: steam.bonusHours, order: order.id }) : "";
    const text = fill("steam_delivered", {
      shop: this.config.shopName,
      order: order.id,
      game: steam.game,
      hours: steam.hours,
      login: credentials.login,
      password: credentials.password,
      expires: moscow(credentials.expires_at),
      bonus_delivered: bonus
    });
    await this.host.deliverMessage(order, text, `данные аренды ${steam.game} отправлены ${order.buyerName}`);
  }
  /* ------------------------------------------------------------ Steam: commands, bonus, reminders */
  /** The buyer's rental a command is about: the order named, or the one active rental. */
  rentalFor(buyerId, orderId) {
    const own = Object.values(this.store.state.orders).filter((order) => order.buyerId === buyerId && order.goods === "steam" && order.steam?.expiresAt && order.delivery === "delivered");
    if (orderId) return own.find((order) => order.id.toUpperCase() === orderId) ?? null;
    const active = own.filter((order) => Date.parse(order.steam.expiresAt) > Date.now());
    if (active.length === 1) return active[0];
    return active.length ? "many" : null;
  }
  /** !steam / !аренда / !отзыв; the rest of the messages go on to the usual handling. Also takes SMM links. */
  async onBuyerMessages(node, buyerId, messages) {
    let rest = messages;
    if (this.settings.smmEnabled) rest = await this.takeSmmLinks(buyerId, rest);
    if (!this.settings.steamEnabled) return rest;
    const left = [];
    for (const message of rest) {
      const command = parseSteamCommand(message.text ?? "");
      if (!command) {
        left.push(message);
        continue;
      }
      const order = this.rentalFor(buyerId, command.orderId);
      if (!order || order === "many") {
        await this.host.send(node, order === "many" ? fill("steam_pick_order", { example: "ABCD1234" }) : fill("steam_no_rental", {}));
        continue;
      }
      logInfo("chat.command", `Чат ${node}: команда Steam (${command.kind}) по заказу #${order.id}`, { orderId: order.id });
      if (command.kind === "guard") await this.sendGuard(node, order);
      else if (command.kind === "status") await this.sendStatus(node, order);
      else await this.checkReview(node, order);
    }
    return left;
  }
  async sendGuard(node, order) {
    try {
      const guard = await this.api.steamGuard(order.id);
      await this.host.send(node, fill("steam_guard", { order: order.id, code: guard.code, seconds: guard.expires_in }));
    } catch (error) {
      if (error instanceof ApiRefused && error.code === "rental_not_active") return void await this.host.send(node, fill("steam_status_ended", { order: order.id }));
      await this.host.send(node, fill("steam_guard_unavailable", { order: order.id }));
    }
  }
  async sendStatus(node, order) {
    try {
      const answer = await this.api.steamRental(order.id);
      if (answer.live?.active && answer.live.expires_at) {
        order.steam.expiresAt = answer.live.expires_at;
        this.store.save();
        await this.host.send(node, fill("steam_status", { order: order.id, game: order.steam.game, expires: moscow(answer.live.expires_at), minutes: answer.live.minutes_left }));
      } else await this.host.send(node, fill("steam_status_ended", { order: order.id }));
    } catch (error) {
      await this.host.send(node, fill("steam_guard_unavailable", { order: order.id }).replace("Steam Guard", "Статус аренды"));
      logWarn("steam.status_error", `Заказ #${order.id}: статус аренды не получен — ${errorText(error)}`, { orderId: order.id });
    }
  }
  /** !отзыв: the bonus once the review is really on FunPay. */
  async checkReview(node, order) {
    const steam = order.steam;
    if (steam.bonusState === "done") return void await this.host.send(node, fill("steam_bonus_already", { order: order.id }));
    if (!steam.bonusHours) return void await this.host.send(node, fill("steam_bonus_none", { order: order.id }));
    const detail = (await this.client.orderDetails([order.id]).catch(() => null))?.get(order.id);
    if (!detail?.review) return void await this.host.send(node, fill("steam_bonus_no_review", { order: order.id }));
    order.reviewRating = detail.review.rating;
    await this.grantBonus(order, node);
  }
  /** The review bonus (from a review notice, the thank-you pass or !отзыв); false when not given now. */
  async grantBonus(order, node = this.host.nodeOf(order)) {
    const steam = order.steam;
    if (!steam?.expiresAt || !steam.bonusHours || steam.bonusState || this.config.dryRun || order.status === "refunded") return false;
    try {
      const answer = await this.api.steamBonus(order.id);
      steam.bonusState = answer.rental.bonus.state;
      if (answer.rental.bonus.state !== "done") {
        this.store.save();
        return false;
      }
      steam.expiresAt = answer.rental.expires_at ?? steam.expiresAt;
      order.reviewBonusAt = Date.now();
      order.goodsCostRub = answer.rental.cost_rub;
      this.store.save();
      logInfo("steam.bonus", `Заказ #${order.id}: бонус за отзыв +${steam.bonusHours} ч. к аренде ${steam.game}`, { orderId: order.id });
      await this.host.send(node, fill("steam_bonus_added", { order: order.id, bonus: steam.bonusHours, expires: moscow(steam.expiresAt) })).catch(() => void 0);
      return true;
    } catch (error) {
      if (error instanceof ApiRefused && error.code === "rental_not_active") {
        steam.bonusState = "ended";
        this.store.save();
        await this.host.send(node, fill("steam_bonus_ended", { order: order.id })).catch(() => void 0);
        return false;
      }
      logWarn("steam.bonus_error", `Заказ #${order.id}: бонус за отзыв не начислен — ${errorText(error)}. Бот повторит позже`, { orderId: order.id });
      return false;
    }
  }
  /** One message about 10 minutes before a rental ends, with the shortest lot of the game to buy more hours. */
  async remindExpiring() {
    if (this.config.dryRun) return;
    const now = Date.now();
    const running = Object.values(this.store.state.orders).filter((order) => order.goods === "steam" && order.delivery === "delivered" && order.steam?.expiresAt && Date.parse(order.steam.expiresAt) > now - 6e4);
    if (!running.length) return;
    const live = await this.api.steamRentals().catch(() => null);
    if (live) {
      const ends = new Map(live.map((rental) => [rental.order_id, rental.expires_at]));
      for (const order of running) {
        const end = ends.get(order.id);
        if (end && end !== order.steam.expiresAt) order.steam.expiresAt = end;
      }
      this.store.save();
    }
    const due = Object.values(this.store.state.orders).filter((order) => {
      const end = order.steam?.expiresAt ? Date.parse(order.steam.expiresAt) : NaN;
      return order.goods === "steam" && order.delivery === "delivered" && order.status !== "refunded" && end > now && end - now <= REMIND_BEFORE_MS + 6e4 && order.steam.reminderFor !== order.steam.expiresAt;
    });
    for (const order of due.slice(0, 10)) {
      const steam = order.steam;
      if (steam.reminderFor === steam.expiresAt) continue;
      const live2 = await this.api.steamRental(order.id).catch(() => null);
      if (!live2?.live?.active || !live2.live.expires_at) continue;
      if (live2.live.expires_at !== steam.expiresAt) {
        steam.expiresAt = live2.live.expires_at;
        this.store.save();
        if (Date.parse(steam.expiresAt) - now > REMIND_BEFORE_MS + 6e4) continue;
      }
      const same = Object.values(this.store.state.orders).filter((other) => other.buyerId === order.buyerId && other.goods === "steam" && other.steam?.productId === steam.productId && other.steam.expiresAt && Date.parse(other.steam.expiresAt) > now);
      const accounts = new Set(same.filter((other) => other.steam.mode === "new").map((other) => other.id));
      const lot = Object.values(this.store.state.goods.lots).filter((l) => l.kind === "steam" && l.productId === steam.productId && l.active).sort((a, b) => (a.hours ?? 0) - (b.hours ?? 0))[0];
      steam.reminderFor = steam.expiresAt;
      for (const other of same) if (other.steam) other.steam.reminderFor = steam.expiresAt;
      this.store.save();
      const minutes = Math.max(1, Math.ceil((Date.parse(steam.expiresAt) - now) / 6e4));
      const text = lot && accounts.size <= 1 ? fill("steam_reminder", { game: steam.game, minutes, expires: moscow(steam.expiresAt), link: `https://funpay.com/lots/offer?id=${lot.lotId}`, hours: lot.hours }) : fill("steam_reminder_nolink", { game: steam.game, minutes, expires: moscow(steam.expiresAt) });
      try {
        await this.host.send(this.host.nodeOf(order), text);
        logInfo("steam.reminder", `Заказ #${order.id}: напомнили ${order.buyerName}, что аренда ${steam.game} скоро закончится`, { orderId: order.id });
      } catch (error) {
        logWarn("send.error", `Заказ #${order.id}: напоминание об окончании аренды не отправлено — ${errorText(error)}`, { orderId: order.id });
      }
    }
  }
  /* ------------------------------------------------------------ SMM */
  /** A paid SMM sale (from the bot's delivery pass): the bot asks for the link. */
  async startSmm(order, detail) {
    if (!detail) return this.host.failAttempt(order, "FunPay не вернул этот заказ");
    if (!this.settings.smmEnabled) return this.host.markFailed(order, "SMM выключен на панели бота — выполните заказ вручную");
    const code = (detail.title ?? order.description).match(/\[(S\d{2,3})\]/)?.[1];
    const item = code ? (await this.smmCatalog()).find((entry) => entry.code === code) : void 0;
    if (!code || !item) return this.host.markFailed(order, "Услуги этого лота нет в каталоге SMM — выполните заказ вручную");
    if (detail.buyerId !== order.buyerId || detail.secrets.length) return this.host.markFailed(order, "Заказ SMM не прошёл проверку (покупатель или автовыдача FunPay) — проверьте вручную");
    const packs = detail.quantity ?? 1;
    const quantity = packs * item.pack_size;
    if (!Number.isInteger(packs) || packs < 1 || packs > item.max_packs) return this.host.markFailed(order, `Количество ${packs} шт. вне границ услуги — выполните заказ вручную`);
    order.chatNode = detail.chatNode ?? order.chatNode;
    order.quantity = packs;
    order.smm = { code, serviceId: item.service_id, packs, quantity, state: "need_link", link: null, remindedAt: null, checkedAt: null, note: null };
    Object.assign(order, { delivery: "working", deliveryError: null });
    this.store.save();
    logInfo("smm.new", `SMM: заказ #${order.id} от ${order.buyerName} — ${item.network} \xB7 ${item.what.ru}, ${quantity} шт.; бот просит ссылку`, { orderId: order.id });
    const early = this.earlyLinks.get(order.buyerId);
    if (early && Date.now() - early.at < EARLY_LINK_MS && early.at >= order.orderedAt - 6e4) {
      const { link, problem } = this.readLink(item.link_kind, early.text);
      if (link && !problem) {
        this.earlyLinks.delete(order.buyerId);
        order.smm.link = link;
        order.smm.state = "ready";
        this.store.save();
        return this.placeSmm(order);
      }
    }
    await this.askLink(order, item);
  }
  async askLink(order, item) {
    if (this.config.dryRun) return;
    await this.host.send(this.host.nodeOf(order), fill("smm_ask_link", { shop: this.config.shopName, order: order.id, what: `${item.network} \xB7 ${item.what.ru}`, quantity: order.smm.quantity.toLocaleString("ru-RU"), target: item.target.ru }));
    order.smm.state = "asked";
    order.smm.remindedAt = Date.now();
    this.store.save();
  }
  readLink(kind, text) {
    const plan = { link: kind };
    const link = smmLinkFromText(plan, text);
    return { link, problem: link ? smmLinkProblem(plan, link) : null };
  }
  async takeSmmLinks(buyerId, messages) {
    const waiting = Object.values(this.store.state.orders).filter((order) => order.buyerId === buyerId && order.goods === "smm" && (order.smm?.state === "asked" || order.smm?.state === "need_link")).sort((a, b) => a.orderedAt - b.orderedAt);
    if (!waiting.length) {
      const linky = messages.filter((m) => !(m.text ?? "").trim().startsWith("!") && /https?:\/\/|t\.me\/|tiktok\.com\/|youtu\.?be|instagram\.com\//i.test(m.text ?? ""));
      if (linky.length) this.earlyLinks.set(buyerId, { text: linky.at(-1).text.trim(), at: Date.now() });
      return messages;
    }
    const items = await this.smmCatalog();
    const rest = [];
    let reminded = false;
    for (const message of messages) {
      const text = message.text?.trim() ?? "";
      const order = waiting[0];
      const item = order && items.find((entry) => entry.code === order.smm.code);
      if (!order || !item) {
        rest.push(message);
        continue;
      }
      const { link, problem } = this.readLink(item.link_kind, text);
      if (link && problem) {
        await this.host.send(this.host.nodeOf(order), fill("smm_wrong_link", { order: order.id, problem, target: item.target.ru }));
        logInfo("smm.wrong_link", `SMM: заказ #${order.id} — ссылка ${link} не подходит (${problem})`, { orderId: order.id });
      } else if (link) {
        waiting.shift();
        order.smm.link = link;
        order.smm.state = "ready";
        this.store.save();
        logInfo("smm.link", `SMM: заказ #${order.id} — покупатель прислал ссылку ${link}`, { orderId: order.id });
        await this.placeSmm(order);
      } else if (text && !text.startsWith("!") && !reminded && Date.now() - (order.smm.remindedAt ?? 0) > SMM_REMIND_MS) {
        reminded = true;
        order.smm.remindedAt = Date.now();
        this.store.save();
        await this.host.send(this.host.nodeOf(order), fill("smm_remind_link", { order: order.id, target: item.target.ru }));
      } else rest.push(message);
    }
    return rest;
  }
  async placeSmm(order) {
    const smm = order.smm;
    if (this.config.dryRun) {
      smm.note = `(тест) бот отправил бы заказ: ${smm.quantity} шт., ${smm.link}`;
      this.store.save();
      return;
    }
    const rate = this.smm?.rate || this.rate();
    try {
      const answer = await this.api.smmOrder({
        order_id: order.id,
        service_id: smm.serviceId,
        quantity: smm.quantity,
        link: smm.link,
        buyer_id: String(order.buyerId),
        ...rate ? { max_cost_usd: Math.floor(order.amountMinor / 100 / rate * 1e6) / 1e6 } : {}
      });
      order.goodsCostRub = answer.order.cost_rub;
      if (answer.order.state === "review") return this.smmProblem(order, "Сервис проверяет этот заказ (результат неизвестен) — дождитесь владельца сервиса");
      if (answer.order.state === "done") return this.smmDone(order);
      smm.state = "placed";
      smm.checkedAt = Date.now();
      this.store.save();
      logInfo("smm.placed", `SMM: заказ #${order.id} запущен (${smm.quantity} шт.) — $${answer.order.cost_usd}`, { orderId: order.id });
      await this.host.send(this.host.nodeOf(order), fill("smm_started", { order: order.id, quantity: smm.quantity.toLocaleString("ru-RU") }));
    } catch (error) {
      if (error instanceof ApiRefused && error.code === "wrong_link") {
        smm.state = "asked";
        smm.link = null;
        this.store.save();
        const item = (await this.smmCatalog()).find((entry) => entry.code === smm.code);
        await this.host.send(this.host.nodeOf(order), fill("smm_wrong_link", { order: order.id, problem: error.reason.replace(/^[^:]*:\s*/, ""), target: item?.target.ru ?? "ссылка из описания лота" }));
        return;
      }
      if (error instanceof ApiRefused) {
        const noSmmFunds = error.code === "insufficient_smm_pool" || error.code === "insufficient_pool";
        if (noSmmFunds) this.lastSmmSync = 0;
        return this.smmProblem(order, noSmmFunds ? POOL_USD_NOTE : `Сервис отказал: ${error.reason}`);
      }
      smm.note = `Сервис не ответил: ${errorText(error)} — бот повторит`;
      this.store.save();
    }
  }
  async smmProblem(order, note) {
    order.smm.state = "problem";
    order.smm.note = note;
    Object.assign(order, { delivery: "failed", deliveryError: note });
    this.store.save();
    logError("smm.problem", `SMM: заказ #${order.id} (${order.buyerName}) — ${note}`, { orderId: order.id });
    this.host.sellerNeeded(order.buyerId, `SMM заказ #${order.id}: ${note}`);
    await this.host.send(this.host.nodeOf(order), fill("smm_seller", { order: order.id })).catch(() => void 0);
  }
  async smmDone(order) {
    order.smm.state = "done";
    Object.assign(order, { delivery: "delivered", deliveredAt: Date.now(), deliveryError: null });
    this.store.save();
    logInfo("smm.done", `SMM: заказ #${order.id} выполнен — покупателю сообщено`, { orderId: order.id });
    await this.host.send(this.host.nodeOf(order), fill("smm_done", { order: order.id, shop: this.config.shopName })).catch(() => void 0);
  }
  /** Orders waiting to be placed again, and the status of the placed ones (every 5 minutes). */
  async serveSmm() {
    const orders = Object.values(this.store.state.orders).filter((order) => order.goods === "smm" && order.smm);
    for (const order of orders) {
      if (order.smm.state !== "placed" && order.smm.state !== "done" && order.status !== "paid" && order.smm.state !== "problem") {
        order.smm.state = "skipped";
        Object.assign(order, { delivery: "skipped", deliveryError: order.status === "refunded" ? "Возврат до запуска" : "Заказ закрыт до запуска" });
        this.store.save();
        continue;
      }
      if (order.smm.state === "ready") await this.placeSmm(order);
    }
    if (Date.now() - this.lastSmmStatus < SMM_STATUS_MS) return;
    this.lastSmmStatus = Date.now();
    for (const order of orders.filter((o) => o.smm.state === "placed").slice(0, 30)) {
      const answer = await this.api.smmStatus(order.id).catch(() => null);
      if (!answer) continue;
      order.smm.checkedAt = Date.now();
      const state = answer.order.state;
      if (state === "done") await this.smmDone(order);
      else if (state === "partial" || state === "canceled") {
        order.goodsCostRub = answer.order.cost_rub;
        await this.smmProblem(order, state === "partial" ? `Выполнено частично (не выполнено ${answer.order.remains ?? "?"}); недоделанное вернулось в пул — решите с покупателем` : "Заказ отменён, деньги вернулись в пул — решите с покупателем");
      }
      this.store.save();
    }
  }
  /* ------------------------------------------------------------ the assistant */
  /** What the assistant knows about the shop's Steam and SMM goods and this buyer's orders of them. */
  aiContext(buyerId) {
    if (!this.on) return "";
    const lines = ["## Аренда Steam и SMM-услуги магазина (это товары магазина, отвечай о них сам)"];
    const lots2 = Object.values(this.store.state.goods.lots).filter((lot) => lot.active);
    if (this.settings.steamEnabled) {
      const games = /* @__PURE__ */ new Map();
      for (const lot of lots2.filter((l) => l.kind === "steam")) {
        const game = games.get(lot.productId) ?? { name: lot.name, hours: [] };
        game.hours.push(lot.hours);
        games.set(lot.productId, game);
      }
      lines.push(
        "Аренда Steam: временный доступ к Steam-аккаунту с игрой, не ключ и не передача аккаунта. После оплаты бот сам присылает логин и пароль в чат заказа. 1 шт. лота = часы из названия на одном аккаунте; несколько штук — больше часов, не больше аккаунтов. Время идёт с выдачи, скачивание входит в аренду. Повторная покупка той же игры до конца аренды добавляет часы к тому же аккаунту. За 10 минут до конца бот напоминает.",
        "Команды: !steam НОМЕР — код Steam Guard; !аренда НОМЕР — сколько осталось; !отзыв НОМЕР — бонус за отзыв (бот сам проверяет отзыв на FunPay). Без номера бот берёт единственную активную аренду.",
        `Бонус за любой честный отзыв, пока аренда идёт: +${this.bonusHours() || 0} ч., один раз за заказ. Не обещай DLC, язык, мультиплеер, регион. Пароли, коды и ключи никогда не повторяй и не придумывай. Нет свободного аккаунта, проблемы со входом после базовых шагов, возвраты — [HANDOFF].`,
        games.size ? `Сейчас в продаже (игра — сроки): ${[...games.values()].slice(0, 40).map((g) => `${g.name} — ${g.hours.sort((a, b) => a - b).map(durationRu).join(", ")}`).join("; ")}. Цены — в лотах.` : "Сейчас лотов аренды в продаже нет."
      );
    }
    if (this.settings.smmEnabled) {
      const smm = lots2.filter((l) => l.kind === "smm").map((l) => l.name);
      lines.push(
        "SMM-услуги: накрутка подписчиков, просмотров, лайков и реакций в Telegram, TikTok, YouTube, Instagram. После оплаты бот просит в чате ссылку (канал, профиль, пост или видео — как в описании лота) и сам запускает заказ; пароль не нужен. Старт обычно в течение нескольких часов, по готовности бот пишет в чат. Гарантия — как в описании лота.",
        smm.length ? `Сейчас в продаже: ${smm.slice(0, 40).join("; ")}.` : "Сейчас SMM-лотов в продаже нет."
      );
    }
    const own = Object.values(this.store.state.orders).filter((order) => order.buyerId === buyerId && order.goods).sort((a, b) => b.orderedAt - a.orderedAt).slice(0, 8);
    if (own.length) {
      lines.push("Заказы Steam/SMM этого покупателя:");
      for (const order of own) lines.push(`- #${order.id}: ${this.describe(order)}`);
    }
    return lines.join("\n");
  }
  /** One order as the assistant and the panel describe it (no logins, passwords or links to the account). */
  describe(order) {
    if (order.goods === "steam") {
      const s = order.steam;
      if (!s?.expiresAt) return order.delivery === "failed" || order.delivery === "stale" ? "аренда Steam: выдаст продавец" : s?.waitingSince ? "аренда Steam: ждём свободный аккаунт" : "аренда Steam: выдаётся";
      const ended = Date.parse(s.expiresAt) <= Date.now();
      return `аренда Steam ${s.game} \xB7 ${s.hours} ч. \xB7 ${ended ? "закончилась" : `идёт до ${moscow(s.expiresAt)} МСК`}${s.bonusHours ? ` \xB7 бонус за отзыв: ${s.bonusState === "done" ? "начислен" : "ещё не начислен"}` : ""}`;
    }
    const m = order.smm;
    const state = { need_link: "ждём ссылку", asked: "ждём ссылку", ready: "запускается", placed: "выполняется", done: "выполнен", problem: "проверяет продавец", skipped: "не запускался" };
    return `SMM ${m ? `${m.quantity} шт. \xB7 ${state[m.state] ?? m.state}` : "заказ"}`;
  }
  /* ------------------------------------------------------------ the panel */
  setSettings(change) {
    const next = { ...this.settings, ...change };
    for (const key of ["steamMarkupPercent", "smmMarkupPercent"]) if (!Number.isFinite(next[key]) || next[key] < 0 || next[key] > 1e3) return "Наценка: от 0 до 1000%";
    if (!Number.isInteger(next.steamTopGames) || next.steamTopGames < 1 || next.steamTopGames > 200) return "Игр в топе: от 1 до 200";
    this.store.state.goods.settings = next;
    this.store.save();
    this.lastSteamSync = this.lastSmmSync = 0;
    logInfo("bot.toggle", `Steam/SMM: ${next.steamEnabled ? "Steam вкл" : "Steam выкл"}, ${next.smmEnabled ? "SMM вкл" : "SMM выкл"}, наценка Steam ${next.steamMarkupPercent}%, SMM ${next.smmMarkupPercent}%`);
    return "Сохранено — цены и наличие лотов обновятся в течение пары минут";
  }
  /** Sales, profit, lots and errors for the panel. */
  summary() {
    const orders = Object.values(this.store.state.orders).filter((order) => order.goods).sort((a, b) => b.orderedAt - a.orderedAt);
    const money = (list) => {
      const sold = list.filter((o) => o.status !== "refunded" && o.goodsCostRub !== null && o.goodsCostRub !== void 0);
      const revenue = sold.reduce((sum, o) => sum + o.amountMinor / 100, 0);
      const cost = sold.reduce((sum, o) => sum + (o.goodsCostRub ?? 0), 0);
      return { count: sold.length, revenue: Math.round(revenue * 100) / 100, cost: Math.round(cost * 100) / 100, profit: Math.round((revenue - cost) * 100) / 100 };
    };
    const since = (ms) => orders.filter((o) => Date.now() - o.orderedAt < ms);
    const day = 864e5;
    const lots2 = Object.values(this.store.state.goods.lots);
    return {
      periods: [["За 24 часа", since(day)], ["За 7 дней", since(7 * day)], ["За 30 дней", since(30 * day)], ["Всего", orders]].map(([label, list]) => ({ label, steam: money(list.filter((o) => o.goods === "steam")), smm: money(list.filter((o) => o.goods === "smm")) })),
      orders: orders.slice(0, 50),
      lots: lots2.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || (a.hours ?? 0) - (b.hours ?? 0)),
      lotsOn: lots2.filter((l) => l.active).length,
      errors: lots2.filter((l) => l.error && !l.active).length,
      publisher: this.store.state.goods.publisher,
      pool: this.pool,
      rate: this.rate(),
      problem: this.refusedNote
    };
  }
};
async function currentPlayers(appId) {
  try {
    const response = await fetch(`${PLAYERS_URL}?appid=${appId}`, { signal: AbortSignal.timeout(1e4) });
    const body = await response.json();
    return body.response?.result === 1 && Number.isSafeInteger(body.response.player_count) ? body.response.player_count : -1;
  } catch {
    return -1;
  }
}


// src/knowledge.ts
import { readFileSync as readFileSync5, statSync as statSync3 } from "node:fs";
var cached2 = null;
function loadKnowledge(shop) {
  const info = statSync3(KNOWLEDGE_FILE);
  if (cached2?.mtimeMs !== info.mtimeMs) cached2 = { mtimeMs: info.mtimeMs, text: readFileSync5(KNOWLEDGE_FILE, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim() };
  return cached2.text.replaceAll("{{SHOP}}", shop);
}
var CATALOG_TTL_MS = 6 * 60 * 6e4;
var catalog = null;
async function featuredModels(api) {
  if (!catalog || Date.now() - catalog.at > CATALOG_TTL_MS) {
    try {
      const answer = await api.models();
      catalog = { at: Date.now(), groups: answer.groups.map((group) => ({ group: group.group, models: group.featured_models })) };
    } catch (error) {
      if (!catalog) throw error;
    }
  }
  return new Map(catalog.groups.map((group) => [group.group, group.models]));
}
function catalogText(models) {
  const lines = ["## Каталог моделей по видам ключей (из сервиса ключей, примеры ID)"];
  for (const [group, ids] of models) {
    if (!ids.length) continue;
    lines.push(`- Ключ \xAB${GROUP_NAMES[group] ?? group}\xBB: ${ids.join(", ")}`);
  }
  lines.push("Ключ открывает только модели своего вида. Полный список моделей ключа покупатель видит в программе после автонастройки или по GET /v1/models со своим ключом.");
  return lines.join("\n");
}
var STATUS_TEXT = {
  paid: "оплачен, ждёт подтверждения покупателем",
  closed: "закрыт (покупатель подтвердил)",
  refunded: "возврат"
};
var DELIVERY_TEXT = {
  pending: "ключ выдаётся ботом (обычно до минуты)",
  retry: "ключ выдаётся ботом",
  minted: "ключ создан и отправляется в этот чат",
  delivered: "ключ отправлен ботом в этот чат",
  funpay: "ключ выдан автовыдачей FunPay (на странице заказа)",
  manual: "выдан продавцом вручную",
  stale: "ключ выдаст продавец вручную",
  failed: "ключ выдаст продавец вручную",
  none: "не API-ключ, а другой товар магазина"
};
function dialogContext(buyerName, orders, now = Date.now()) {
  const lines = ["## Текущий диалог", `Сейчас ${formatMoscow(now)} (МСК). Покупатель: ${buyerName}.`];
  if (!orders.length) {
    lines.push("У этого покупателя ещё нет заказов в магазине — это вопрос до покупки.");
  } else {
    lines.push("Заказы этого покупателя (новые сверху):");
    for (const order of orders) {
      const delivery = order.delivery === "delivered" && order.keyAction === "topup" ? "бот пополнил ключ, выданный покупателю раньше (новый ключ не выдавался)" : DELIVERY_TEXT[order.delivery];
      lines.push(`- #${order.id} от ${formatMoscow(order.orderedAt)} МСК — ${order.product} — ${STATUS_TEXT[order.status] ?? order.status}${delivery ? `; ${delivery}` : ""}${order.note ? `; ${order.note}` : ""}${order.usage ? `; ${order.usage}` : ""}`);
    }
  }
  lines.push("Ключи никогда не повторяй и не придумывай: выданный ключ есть выше в этом чате или на странице заказа.");
  return lines.join("\n");
}
async function systemPrompt(shop, api, buyerName, orders, goods = "") {
  const models = await featuredModels(api).catch(() => /* @__PURE__ */ new Map());
  return [loadKnowledge(shop), catalogText(models), goods, dialogContext(buyerName, orders)].filter(Boolean).join("\n\n");
}


// src/bot.ts
var RECENT_SYNC_MS = 3 * 6e4;
var FULL_SYNC_MS = 60 * 6e4;
var REPLY_DEBOUNCE_MS = 3500;
var CHAT_RETRIES = 3;
var CHAT_RETRY_MS = 15e3;
var SEND_GAP_MS = 1500;
var AI_REPLIES_PER_HOUR = 20;
var AI_RETRY_DELAY_MS = 3e3;
var SELLER_CALL_PAUSE_MS = 12 * 60 * 6e4;
var STAFF_PAUSE_MS = 24 * 60 * 6e4;
var FOLLOW_UP_DELAY_MS = 2 * 6e4;
var RETRY_DELAY_MS = 6e4;
var MAX_DELIVERY_ATTEMPTS = 5;
var MAX_FOLLOW_UP_ATTEMPTS = 5;
var RAISE_CHECK_MS = 5 * 6e4;
var RAISE_LOOKUP_MS = 6 * 60 * 6e4;
var RAISE_EMPTY_RECHECK_MS = 30 * 6e4;
var RAISE_INTERVAL_MS = 4 * 60 * 6e4;
var RAISE_RETRY_MS = 30 * 6e4;
var RAISE_RETRY_MAX_MS = 6 * 60 * 6e4;
var RESUME_WINDOW_MS = 10 * 6e4;
var REVIEW_LOOK_DELAY_MS = 24 * 60 * 6e4;
var REVIEW_LOOK_MAX_AGE_MS = 7 * 24 * 60 * 6e4;
var REVIEW_REPLY_MAX_AGE_MS = 14 * 24 * 60 * 6e4;
var CONFIRM_REMINDER_MAX_AGE_MS = 7 * 24 * 60 * 6e4;
var USAGE_MAX_AGE_MS = 30 * 24 * 60 * 6e4;
var LOW_BALANCE_SHARE = 0.1;
var LOW_BALANCE_ACTIVE_MS = 7 * 24 * 60 * 6e4;
var MAX_REMINDERS_PER_RUN = 5;
var PRUNE_MS = 6 * 60 * 6e4;
var AUTH_RETRY_MS = 5 * 6e4;
var OUTAGE_ERROR_AFTER = 3;
var IMAGE_CACHE_SIZE = 20;
var FAR_FUTURE = Date.parse("2100-01-01T00:00:00Z");
var DRY_RUN_NOTE = "Тестовый режим:";
var STALE_NOTE = "Бот увидел заказ больше чем через 30 минут после оплаты (был выключен или в тестовом режиме). Проверьте чат и выдайте ключ вручную или нажмите \xABВыдать ключ\xBB.";
var GOODS_STALE_NOTE = "Бот увидел заказ больше чем через 30 минут после оплаты (был выключен или в тестовом режиме). Проверьте чат и выполните заказ вручную или нажмите \xABВыдать снова\xBB.";
var UNRECOGNIZED_NOTE = "Лот похож на API-ключ, но бот не понял, какой это пакет. Выдайте ключ вручную в /seller и нажмите \xABВыдано вручную\xBB; в названии лота должны быть модель и объём, например \xABGEMINI API КЛЮЧ 10M ТОКЕНОВ\xBB.";
var POOL_EMPTY_NOTE = "В пуле не хватает токенов. Пополните пул у владельца сервиса и нажмите \xABВыдать ключ\xBB.";
var STEAM_HELP = "\n🎮 Аренда Steam: !steam НОМЕР — код Guard, !аренда НОМЕР — сколько осталось, !отзыв НОМЕР — бонус за отзыв";
var STATUS_RU = { paid: "оплачен", closed: "закрыт", refunded: "возврат" };
var COMMAND_RU = { seller: "!продавец", balance: "!баланс", help: "!помощь" };
var PAUSE_RU = {
  seller_manual: "продавец отвечает сам",
  seller_call: "ждёт продавца",
  seller_stop: "бот выключен в этом чате (!стоп)",
  funpay_staff: "в чате поддержка FunPay",
  ai_limit: "лимит ответов ИИ за час"
};
var ResellerBot = class {
  constructor(config, store, api) {
    this.config = config;
    this.store = store;
    this.api = api;
    this.client = new FunPayClient({ goldenKey: config.goldenKey, baseUrl: config.funpayBaseUrl });
    this.links = linksFor(config);
    this.testOrigin = config.funpayBaseUrl ? new URL(config.funpayBaseUrl).origin : void 0;
    this.usageCheckMs = (config.checkSeconds ?? 300) * 1e3;
    this.reminderCheckMs = (config.checkSeconds ?? 600) * 1e3;
    this.goods = new GoodsSeller(config, store, api, this.client, {
      send: (node, text) => this.send(node, text),
      nodeOf: (order) => this.nodeOf(order),
      sellerNeeded: (buyerId, reason) => this.sellerNeeded(buyerId, reason),
      chatBusy: (buyerId) => this.chatBusy(buyerId),
      failAttempt: (order, error) => this.failAttempt(order, error),
      markFailed: (order, error) => this.markFailed(order, error),
      deliverMessage: (order, text, done) => this.deliverMessage(order, text, done)
    });
  }
  client;
  /** Steam rentals and SMM services (goods.ts). */
  goods;
  links;
  startedAt = Date.now();
  tags = { orders: randomTag(), chats: randomTag() };
  seen = /* @__PURE__ */ new Map();
  timers = /* @__PURE__ */ new Map();
  aiReplyTimes = /* @__PURE__ */ new Map();
  orderRefresh = /* @__PURE__ */ new Set();
  followUpFailures = /* @__PURE__ */ new Map();
  imageCache = /* @__PURE__ */ new Map();
  noKeyForBonus = /* @__PURE__ */ new Set();
  testOrigin;
  usageCheckMs;
  reminderCheckMs;
  ordersCounter = null;
  syncRequested = true;
  startupDone = false;
  chatsBaselined = false;
  resumedQuickly = false;
  stopped = false;
  lastRecentSync = 0;
  lastFullSync = 0;
  lastUsageCheck = 0;
  lastReminderCheck = 0;
  lastReviewReplyCheck = 0;
  lastPrune = 0;
  offerGames = null;
  raiseDue = /* @__PURE__ */ new Map();
  raisedElsewhere = /* @__PURE__ */ new Set();
  lastRaiseCheck = 0;
  raiseLookupFailures = 0;
  raiseJob = null;
  lastRaiseAt = null;
  lastOrderSyncAt = null;
  chatWork = Promise.resolve();
  chatRetries = /* @__PURE__ */ new Map();
  sendChain = Promise.resolve();
  lastSendAt = 0;
  lastHeartbeat = 0;
  status = "starting";
  lastError = null;
  failures = 0;
  outageSince = null;
  get orders() {
    return Object.values(this.store.state.orders);
  }
  get toggles() {
    return this.store.state.toggles;
  }
  get funpayUserId() {
    return this.client.userId;
  }
  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  async run() {
    const previous = this.store.state.status;
    this.resumedQuickly = Boolean(previous?.heartbeatAt && Date.now() - previous.heartbeatAt < RESUME_WINDOW_MS);
    logInfo("bot.start", this.config.dryRun ? "Бот запущен в тестовом режиме: сообщения не отправляются, ключи не выдаются" : `Бот запущен: магазин \xAB${this.config.shopName}\xBB`);
    if (!this.config.ai.key) logWarn("bot.no_ai_key", "ИИ-ответы выключены (нет ключа для ассистента) — команды и выдача ключей работают");
    this.heartbeat(true);
    while (!this.stopped) {
      try {
        if (!this.client.loggedIn) {
          await this.client.login();
          logInfo("funpay.login", `Вход в FunPay выполнен: ${this.client.username} (#${this.client.userId})`);
        }
        await this.tick();
        if (this.status !== "online") {
          if (this.status !== "starting") {
            logInfo("bot.recovered", `Связь с FunPay восстановлена через ${this.outageSeconds()} с (неудачных попыток: ${this.failures})`);
          }
          this.outageSince = null;
          this.status = "online";
          this.heartbeat(true);
        }
        this.failures = 0;
      } catch (error) {
        await this.onLoopError(error);
      }
      await sleep(this.config.pollMs + Math.floor(Math.random() * 1500));
    }
  }
  async onLoopError(error) {
    const message = errorText(error);
    this.lastError = { message, at: Date.now() };
    this.outageSince ??= Date.now();
    if (error instanceof FunPayAuthError) {
      this.status = "auth_error";
      this.client.resetSession();
      logError("funpay.auth_error", `FunPay не принял golden_key (${message}). Повтор через 5 минут; если повторяется — получите новый golden_key и запустите \xABbash start.sh setup\xBB`);
      this.heartbeat(true);
      await sleep(AUTH_RETRY_MS);
      return;
    }
    this.status = "error";
    this.failures += 1;
    const delayMs = Math.min(6e4, 1e3 * 2 ** this.failures);
    const retry = `Повтор через ${Math.round(delayMs / 1e3)} с`;
    if (this.failures < OUTAGE_ERROR_AFTER) logWarn("bot.loop_error", `FunPay не ответил: ${message}. ${retry}`);
    else logError("bot.loop_error", `Нет связи с FunPay уже ${this.failures} попытки подряд (${this.outageSeconds()} с): ${message}. ${retry}`);
    this.heartbeat(true);
    await sleep(delayMs);
  }
  outageSeconds() {
    return this.outageSince ? Math.round((Date.now() - this.outageSince) / 1e3) : 0;
  }
  async tick() {
    const selfId = this.client.userId;
    const result = await this.client.runner([
      { type: "orders_counters", id: selfId, tag: this.tags.orders, data: false },
      { type: "chat_bookmarks", id: selfId, tag: this.tags.chats, data: false }
    ]);
    for (const object of result.objects) {
      if (object.type === "orders_counters") {
        if (object.tag) this.tags.orders = object.tag;
        const counter = JSON.stringify(object.data ?? null);
        if (counter !== this.ordersCounter) {
          this.ordersCounter = counter;
          this.syncRequested = true;
        }
      } else if (object.type === "chat_bookmarks") {
        if (object.tag) this.tags.chats = object.tag;
        if (typeof object.data?.html === "string") this.onChatList(parseChatBookmarks(object.data.html));
      }
    }
    const now = Date.now();
    if (!this.startupDone) await this.startupSync();
    else if (now - this.lastFullSync > FULL_SYNC_MS) await this.syncOrders("full");
    else if (this.syncRequested || now - this.lastRecentSync > RECENT_SYNC_MS) await this.syncOrders("recent");
    await this.refreshNamedOrders();
    if (this.toggles.deliveryEnabled) {
      await this.processDeliveries();
      await this.processFollowUps();
    }
    await this.goods.tick(this.toggles.deliveryEnabled);
    await this.trackKeyUsage();
    await this.sendReminders();
    await this.answerReviews();
    this.startRaise();
    if (now - this.lastPrune > PRUNE_MS) {
      this.lastPrune = now;
      this.store.prune();
    }
    this.heartbeat();
  }
  /* ------------------------------------------------------- raising offers */
  startRaise() {
    if (this.config.dryRun || this.goods.syncing || this.raiseJob || Date.now() - this.lastRaiseCheck < RAISE_CHECK_MS) return;
    this.lastRaiseCheck = Date.now();
    this.raiseJob = this.raiseOffers().catch((error) => {
      this.raiseLookupFailures += 1;
      this.lastRaiseCheck = Date.now() + Math.min(RAISE_RETRY_MAX_MS, RAISE_RETRY_MS * 2 ** (this.raiseLookupFailures - 1)) - RAISE_CHECK_MS;
      if (this.raiseLookupFailures === 1) logWarn("lots.raise_error", `Поднятие лотов: не удалось прочитать предложения — ${errorText(error)}. Бот попробует позже`);
    }).finally(() => {
      this.raiseJob = null;
    });
  }
  async raiseOffers() {
    if (!this.toggles.raiseEnabled) return;
    const games = await this.lookUpOfferGames();
    this.raiseLookupFailures = 0;
    const raised = [];
    for (const [game, { nodes, titles }] of games) {
      if (this.stopped) return;
      const due = this.raiseDue.get(game);
      if (due && due.at > Date.now()) continue;
      let answer;
      try {
        answer = await this.client.raiseOffers(game, nodes);
        if (answer.kind === "choose") answer = await this.client.raiseOffers(game, answer.nodes);
        if (answer.kind === "choose") answer = { kind: "error", message: "FunPay снова спросил, какие разделы поднять" };
      } catch (error) {
        if (error instanceof FunPayRateLimitError) throw error;
        answer = { kind: "error", message: errorText(error) };
      }
      if (answer.kind === "raised") {
        this.raiseDue.set(game, { at: Date.now() + (answer.waitSeconds ? answer.waitSeconds * 1e3 : RAISE_INTERVAL_MS), failures: 0 });
        raised.push(...titles);
      } else if (answer.kind === "wait") {
        if (!due) {
          logInfo("lots.wait", `Поднятие лотов (${titles.join(", ")}): FunPay разрешит через ${waitText(answer.waitSeconds)}`);
        } else if (!this.raisedElsewhere.has(game)) {
          this.raisedElsewhere.add(game);
          logInfo("lots.wait", `Поднятие лотов (${titles.join(", ")}): их уже подняли вручную или другой программой — следующая попытка через ${waitText(answer.waitSeconds)}`);
        }
        this.raiseDue.set(game, { at: Date.now() + answer.waitSeconds * 1e3 + 3e4, failures: 0 });
      } else {
        const failures = (due?.failures ?? 0) + 1;
        this.raiseDue.set(game, { at: Date.now() + Math.min(RAISE_RETRY_MAX_MS, RAISE_RETRY_MS * 2 ** (failures - 1)), failures });
        if (failures === 1 || failures % 4 === 0) logWarn("lots.raise_error", `Не удалось поднять предложения (${titles.join(", ")}): ${answer.message}`);
      }
    }
    if (raised.length) {
      this.lastRaiseAt = Date.now();
      logInfo("lots.raised", `Подняты предложения: ${raised.join(", ")}`);
      this.heartbeat(true);
    }
  }
  async lookUpOfferGames() {
    if (this.offerGames && Date.now() - this.offerGames.at < RAISE_LOOKUP_MS) return this.offerGames.games;
    const games = /* @__PURE__ */ new Map();
    for (const section of await this.client.offerSections()) {
      const target = await this.client.raiseTarget(section.node);
      if (!target) continue;
      const game = games.get(target.game) ?? { nodes: [], titles: [] };
      game.nodes.push(section.node);
      game.titles.push(section.title);
      games.set(target.game, game);
    }
    const before = this.offerGames ? [...this.offerGames.games.keys()].sort().join() : null;
    this.offerGames = { at: games.size ? Date.now() : Date.now() - RAISE_LOOKUP_MS + RAISE_EMPTY_RECHECK_MS, games };
    if (before !== [...games.keys()].sort().join()) {
      const sections = [...games.values()].reduce((sum, game) => sum + game.nodes.length, 0);
      if (games.size) logInfo("lots.found", `Поднятие лотов: разделов с предложениями — ${sections}, игр — ${games.size}`);
      else logWarn("lots.raise_error", "Поднятие лотов: в профиле FunPay не найдено ни одного раздела с предложениями");
    }
    return games;
  }
  /* ------------------------------------------------------------- orders */
  async startupSync() {
    const initialized = this.store.state.initializedAt !== null;
    if (initialized) {
      let stale = 0;
      for (const order of this.orders) {
        if (order.delivery === "pending" && order.orderedAt < Date.now() - this.catchUpMs) {
          order.delivery = "stale";
          order.deliveryError = STALE_NOTE;
          stale += 1;
        }
      }
      if (stale) logWarn("order.stale", `Заказов, которые ждали дольше ${this.config.catchUpMinutes} минут: ${stale}. Бот их не выдаёт — проверьте \xABНужно внимание\xBB на панели`);
    }
    await this.syncOrders(initialized ? "catchup" : "backfill");
    if (!initialized) this.store.state.initializedAt = Date.now();
    this.store.save();
    this.startupDone = true;
  }
  get catchUpMs() {
    return this.config.catchUpMinutes * 6e4;
  }
  async syncOrders(mode) {
    const pageLimit = { backfill: 200, catchup: 5, full: 5, recent: 1 }[mode];
    const rows = [];
    let cursor;
    for (let page = 0; page < pageLimit; page++) {
      if (page) await sleep(1200);
      const result = await this.client.salesPage(cursor);
      rows.push(...result.rows);
      cursor = result.nextCursor ?? void 0;
      if (!cursor) break;
    }
    this.upsertSales(rows, mode);
    const now = Date.now();
    this.syncRequested = false;
    this.lastRecentSync = now;
    if (mode !== "recent") this.lastFullSync = now;
    this.lastOrderSyncAt = now;
    if (mode === "backfill") logInfo("sales.import", `Загружена история продаж FunPay: ${rows.length} ${plural(rows.length, "заказ", "заказа", "заказов")} (по ним бот ключи не выдаёт)`);
    this.store.save();
  }
  upsertSales(rows, mode) {
    const now = Date.now();
    for (const row of rows) {
      const current = this.store.state.orders[row.id];
      if (current) {
        if (current.status !== row.status) this.onStatusChange(current, row.status, now);
        continue;
      }
      const goods = GoodsSeller.kindOf(row.description);
      const detected = goods ? null : detectLot(row.description);
      const plan = detected && "plan" in detected ? detected.plan : null;
      const orderedAt = row.orderedAt?.getTime() ?? now;
      const { delivery, note } = goods ? this.goodsDelivery(row, orderedAt, mode) : this.initialDelivery(row, detected, orderedAt, mode);
      const product = productLabel(row.description, plan);
      this.store.state.orders[row.id] = {
        id: row.id,
        description: row.description.slice(0, 1e3),
        category: row.category?.slice(0, 200) ?? null,
        buyerName: row.buyerName.slice(0, 100),
        buyerId: row.buyerId,
        status: row.status,
        quantity: quantityFromDescription(row.description),
        amountMinor: row.amountMinor,
        currency: row.currency,
        orderedAt,
        product,
        plan: plan ? JSON.stringify(plan) : null,
        delivery,
        deliveryError: note,
        deliveryAttempts: 0,
        lastAttemptAt: null,
        keyId: null,
        keyAction: null,
        usedAtDelivery: null,
        chatNode: null,
        deliveredAt: null,
        closedAt: mode !== "backfill" && row.status === "closed" ? now : null,
        refundedAt: mode !== "backfill" && row.status === "refunded" ? now : null,
        thankedAt: null,
        reviewRating: null,
        reviewBonusAt: null,
        reviewBonusTokens: null,
        reviewReplyAt: null,
        reviewLookedAt: null,
        confirmReminderAt: null,
        keyFirstUsedAt: null,
        goods,
        steam: null,
        smm: null,
        goodsCostRub: null
      };
      if (mode !== "backfill") {
        const action = delivery === "pending" ? goods === "steam" ? " — бот выдаёт аренду Steam" : goods === "smm" ? " — бот запускает SMM-заказ" : " — бот выдаёт ключ" : delivery === "stale" ? " — слишком поздно для автовыдачи, выдайте вручную" : delivery === "failed" ? ` — бот НЕ выдал ключ: ${note}` : "";
        const log = delivery === "failed" ? logError : delivery === "stale" ? logWarn : logInfo;
        log("order.new", `Новый заказ #${row.id} от ${row.buyerName}: ${product}, ${STATUS_RU[row.status] ?? row.status}${action}`, { orderId: row.id });
      }
    }
  }
  /** A Steam or SMM sale: served by the goods module when it is paid and fresh. */
  goodsDelivery(row, orderedAt, mode) {
    if (mode === "backfill") return { delivery: "preexisting", note: null };
    if (row.status !== "paid") return { delivery: "skipped", note: null };
    if (Date.now() - orderedAt > this.catchUpMs) return { delivery: "stale", note: GOODS_STALE_NOTE };
    return { delivery: "pending", note: null };
  }
  /** History imported on the very first run is never delivered; later sales are, if they are fresh. */
  initialDelivery(row, detected, orderedAt, mode) {
    if (mode === "backfill") return { delivery: "preexisting", note: null };
    if (!detected) {
      return looksLikeApiKey(row.description) && row.status === "paid" ? { delivery: "failed", note: UNRECOGNIZED_NOTE } : { delivery: "none", note: null };
    }
    if ("unsupported" in detected) return row.status === "paid" ? { delivery: "failed", note: detected.unsupported } : { delivery: "skipped", note: null };
    if (row.status !== "paid") return { delivery: "skipped", note: null };
    if (Date.now() - orderedAt > this.catchUpMs) return { delivery: "stale", note: STALE_NOTE };
    return { delivery: "pending", note: null };
  }
  onStatusChange(order, next, now) {
    const undelivered = ["pending", "retry", "stale", "failed"].includes(order.delivery);
    const before = order.status;
    order.status = next;
    if (next === "closed" && !order.closedAt) order.closedAt = now;
    if (next === "refunded") order.refundedAt = now;
    if (next !== "paid" && undelivered) {
      order.delivery = "skipped";
      order.deliveryError = next === "refunded" ? "Возврат до выдачи ключа" : "Заказ закрыт до выдачи ключа";
    }
    this.store.save();
    const log = next === "refunded" ? logWarn : logInfo;
    log("order.status", `Заказ #${order.id}: ${STATUS_RU[before] ?? before} → ${STATUS_RU[next] ?? next}${next === "refunded" && order.keyId ? `. Ключ #${order.keyId} работает — отключите его на панели, если нужно` : ""}`, { orderId: order.id });
  }
  /** Orders named in chat notices (confirmed, refunded, review) are re-checked directly: the sync reads only the newest page. */
  async refreshNamedOrders() {
    if (!this.orderRefresh.size) return;
    const ids = [...this.orderRefresh].slice(0, 10);
    for (const id of ids) this.orderRefresh.delete(id);
    const known = ids.map((id) => this.store.state.orders[id]).filter(Boolean);
    if (!known.length) return;
    let details;
    try {
      details = await this.client.orderDetails(known.map((order) => order.id));
    } catch (error) {
      for (const order of known) this.orderRefresh.add(order.id);
      throw error;
    }
    for (const order of known) {
      const detail = details.get(order.id);
      const status2 = detail?.status;
      if ((status2 === "paid" || status2 === "closed" || status2 === "refunded") && status2 !== order.status) this.onStatusChange(order, status2, Date.now());
      if (detail?.review) await this.onReview(order, detail.review);
    }
  }
  reviewBonusFor(order) {
    const plan = parseStoredPlan(order.plan);
    return plan ? grantFor(plan, order.quantity).reviewBonus : 0;
  }
  /** FunPay lets a buyer review a seller once: a buyer with a review on another order gets no new promise. */
  reviewedEarlier(order) {
    return this.orders.some((other) => other.buyerId === order.buyerId && other.id !== order.id && other.reviewRating !== null);
  }
  async onReview(order, review) {
    if (review.rating !== order.reviewRating) {
      order.reviewRating = review.rating;
      this.store.save();
      logInfo("review.new", `Заказ #${order.id}: отзыв ★ ${review.rating ?? "—"} от ${order.buyerName}`, { orderId: order.id });
    }
    if (order.goods) {
      if (order.goods === "steam" && this.toggles.deliveryEnabled) await this.goods.grantBonus(order);
      await this.answerReview(order, review, 0);
      return;
    }
    const bonus = this.reviewBonusFor(order);
    let bonusAdded = order.reviewBonusAt !== null;
    if (!bonusAdded && bonus && order.thankedAt && !this.config.dryRun && this.toggles.deliveryEnabled && await this.grantReviewBonus(order, bonus)) {
      bonusAdded = true;
      await this.send(this.nodeOf(order), reviewBonusText(order.id, bonus, parseStoredPlan(order.plan)?.billing)).catch(
        (error) => logWarn("send.error", `Заказ #${order.id}: не удалось отправить сообщение о бонусе — ${errorText(error)}`, { orderId: order.id })
      );
    }
    const bonusComing = bonus > 0 && !bonusAdded && !order.thankedAt && ["delivered", "funpay"].includes(order.delivery);
    if (!bonusComing) await this.answerReview(order, review, bonusAdded ? order.reviewBonusTokens ?? bonus : 0);
  }
  /** Adds the review bonus to the order's key from the pool, once (claimed before the request, Idempotency-Key on it). */
  async grantReviewBonus(order, tokens) {
    if (order.reviewBonusAt !== null) return false;
    if (!order.keyId) {
      if (!this.noKeyForBonus.has(order.id)) {
        this.noKeyForBonus.add(order.id);
        logWarn("review.no_key", `Заказ #${order.id}: ${order.buyerName} оставил отзыв, но бот не знает ключ этого заказа — добавьте бонус +${formatMillions(tokens)} вручную в /seller`, { orderId: order.id });
      }
      return false;
    }
    this.reviewBonusInFlight ??= new Set();
    if(this.reviewBonusInFlight.has(order.id))return false;
    this.reviewBonusInFlight.add(order.id);
    try {
      await this.api.bonus(order.keyId, tokens, `Отзыв к заказу FunPay #${order.id}`, `fp-bonus-${order.id}`, parseStoredPlan(order.plan)?.billing);
    } catch (error) {
      this.reviewBonusInFlight.delete(order.id);
      logWarn("review.bonus_error", `Заказ #${order.id}: бонус за отзыв не начислен — ${errorText(error)}. Бот повторит позже`, { orderId: order.id });
      return false;
    }
    this.reviewBonusInFlight.delete(order.id);
    order.reviewBonusAt = Date.now();
    order.reviewBonusTokens = tokens;
    this.store.save();
    logInfo("review.bonus", `Заказ #${order.id}: начислен бонус за отзыв +${formatMillions(tokens)} токенов на ключ #${order.keyId}`, { orderId: order.id });
    return true;
  }
  /**
   * The seller's public reply under a buyer's review, in the review's language: only where
   * there is no reply yet (the seller's own replies are never replaced), only for key orders,
   * only for 4–5 stars (a low rating is left for the seller).
   */
  async answerReview(order, review, bonusTokens) {
    if (order.reviewReplyAt || this.config.dryRun || !this.toggles.deliveryEnabled) return;
    const plan = parseStoredPlan(order.plan);
    if (!plan && !order.goods) return;
    order.reviewReplyAt = Date.now();
    this.store.save();
    if (review.reply) return;
    if ((review.rating ?? 0) < 4) {
      logWarn("review.low", `Заказ #${order.id}: отзыв ★ ${review.rating ?? "—"} от ${order.buyerName} — бот на него не отвечает, ответьте покупателю сами`, { orderId: order.id });
      return;
    }
    const english = writtenInEnglish(review.text);
    const text = plan ? reviewReplyText({ shop: this.config.shopName, plan, quantity: order.quantity, bonusTokens, english }) : fill(english ? "goods_review_reply_en" : "goods_review_reply", { shop_upper: this.config.shopName.toLocaleUpperCase("ru-RU"), product: order.goods === "steam" ? `🎮 ${order.steam?.game ?? "Steam"}` : "📣 SMM" });
    try {
      await this.client.replyToReview(order.id, text);
      logInfo("review.reply", `Заказ #${order.id}: опубликован ответ на отзыв — \xAB${text}\xBB`, { orderId: order.id });
    } catch (error) {
      order.reviewReplyAt = null;
      this.store.save();
      logWarn("review.reply_error", `Заказ #${order.id}: не удалось ответить на отзыв — ${errorText(error)}. Бот повторит позже`, { orderId: order.id });
    }
  }
  /** Reviews of the last two weeks still without a reply: a notice the bot missed, or a bonus that came later. */
  async answerReviews() {
    if (this.config.dryRun || Date.now() - this.lastReviewReplyCheck < this.reminderCheckMs) return;
    this.lastReviewReplyCheck = Date.now();
    const due = this.orders.filter((order) => order.reviewRating !== null && !order.reviewReplyAt && (order.plan || order.goods) && order.orderedAt >= Date.now() - REVIEW_REPLY_MAX_AGE_MS).sort((a, b) => b.orderedAt - a.orderedAt).slice(0, 10);
    if (!due.length) return;
    const details = await this.client.orderDetails(due.map((order) => order.id)).catch(() => null);
    if (!details) return;
    for (const order of due) {
      const review = details.get(order.id)?.review;
      if (review) await this.onReview(order, review);
    }
  }
  /* ----------------------------------------------------------- delivery */
  async processDeliveries() {
    const now = Date.now();
    const batch = this.orders.filter((order) => ["pending", "retry", "minted"].includes(order.delivery)).filter((order) => order.deliveryAttempts === 0 || (order.lastAttemptAt ?? 0) <= now - RETRY_DELAY_MS).filter((order) => !this.config.dryRun || !order.deliveryError?.startsWith(DRY_RUN_NOTE)).sort((a, b) => a.orderedAt - b.orderedAt).slice(0, 10);
    if (!batch.length) return;
    const lookup = batch.filter((order) => order.delivery !== "minted" || order.goods === "steam" && !order.steam?.expiresAt).map((order) => order.id);
    let details = /* @__PURE__ */ new Map();
    if (lookup.length) {
      try {
        details = await this.client.orderDetails(lookup);
      } catch (error) {
        for (const id of lookup) this.failAttempt(this.store.state.orders[id], `FunPay не вернул данные заказа: ${errorText(error)}`);
        return;
      }
    }
    for (const order of batch) {
      try {
        if (order.goods === "steam") await this.goods.deliverSteam(order, details.get(order.id));
        else if (order.goods === "smm") await this.goods.startSmm(order, details.get(order.id));
        else if (order.delivery === "minted") await this.sendIssuedKey(order);
        else await this.deliver(order, details.get(order.id));
      } catch (error) {
        if (error instanceof ApiRefused) this.onKeyServiceRefused(order, error);
        else this.failAttempt(order, errorText(error));
      }
    }
  }
  /** The key service said no: retrying the same request will not help, so the seller is asked. */
  onKeyServiceRefused(order, error) {
    if (error.code === "insufficient_pool") return this.markFailed(order, POOL_EMPTY_NOTE);
    if (error.code === "invalid_api_key" || error.code === "api_disabled" || error.code === "account_disabled") {
      return this.markFailed(order, `Сервис ключей не принял ключ разработчика: ${error.reason}. Проверьте его в /seller и запустите \xABbash start.sh setup\xBB`);
    }
    this.markFailed(order, `Сервис ключей отказал: ${error.reason}`);
  }
  nodeOf(order) {
    return order.chatNode ?? privateChatNode(order.buyerId, this.client.userId);
  }
  async deliver(order, detail) {
    if (!detail) return this.failAttempt(order, "FunPay не вернул этот заказ");
    if (detail.status !== "paid") {
      if (order.delivery === "pending" || order.delivery === "retry") {
        order.delivery = "skipped";
        order.deliveryError = `Статус заказа на FunPay: ${detail.status}`;
        this.store.save();
        logInfo("order.skipped", `Заказ #${order.id}: выдача не нужна, статус на FunPay — ${detail.status}`, { orderId: order.id });
      }
      return;
    }
    order.chatNode = detail.chatNode ?? privateChatNode(order.buyerId, this.client.userId);
    if (detail.secrets.length) return this.recordFunPayDelivery(order, detail);
    const plan = parseStoredPlan(order.plan);
    if (!plan) return this.markFailed(order, "Не удалось определить пакет по названию лота");
    order.quantity = detail.quantity ?? order.quantity;
    const grant = grantFor(plan, order.quantity);
    if (grant.tokens < (grant.billing === "usd" ? 1e4 : 1e5)) return this.markFailed(order, "Пакет меньше минимального размера ключа");
    if (this.config.dryRun) {
      const note = `${DRY_RUN_NOTE} бот выдал бы ключ \xAB${grant.label}\xBB`;
      if (order.deliveryError !== note) {
        order.deliveryError = note;
        this.store.save();
        logInfo("order.dry_run", `(тест) Заказ #${order.id}: бот выдал бы ключ \xAB${grant.label}\xBB для ${order.buyerName}`, { orderId: order.id });
      }
      return;
    }
    const reusable = this.config.topUpKeys ? await this.reusableKey(order, grant.group, grant.billing) : null;
    if (reusable) {
      const answer = await this.api.topUp(reusable.id, grant.tokens, `fp-topup-${order.id}-${reusable.id}`, grant.billing);
      Object.assign(order, { delivery: "minted", keyId: reusable.id, keyAction: "topup", usedAtDelivery: reusable.tokens_used, deliveryError: null });
      this.store.save();
      logInfo("order.topup", `Заказ #${order.id}: пополнен уже выданный ключ #${reusable.id} (${reusable.preview ?? "—"}) покупателя ${order.buyerName} — ${grant.label}`, { orderId: order.id });
      await this.sendTopUpNotice(order, grant, answer.key);
      return;
    }
    const created = await this.api.createKey(
      { name: `FunPay \xB7 ${order.buyerName}`.slice(0, 100), group: grant.group, tokens: grant.tokens, note: `FunPay заказ #${order.id}`, ...grant.billing === "usd" ? { billing: "usd", usd: grant.tokens / 1e6 } : {} },
      `fp-order-${order.id}`
    );
    Object.assign(order, { delivery: "minted", keyId: created.key.id, keyAction: "issued", usedAtDelivery: created.key.tokens_used, deliveryError: null });
    this.store.save();
    logInfo("order.issued", `Заказ #${order.id}: создан ключ #${created.key.id} для ${order.buyerName} — ${grant.label}`, { orderId: order.id });
    await this.sendIssuedKey(order, created.secret, grant);
  }
  /**
   * The buyer's newest working key that this pack can top up: found through their earlier
   * orders, of a group that takes it, and never a key another buyer also received.
   */
  async reusableKey(order, group, billing) {
    const earlier = this.orders.filter((other) => other.buyerId === order.buyerId && other.id !== order.id && other.keyId).sort((a, b) => b.orderedAt - a.orderedAt);
    for (const keyId of [...new Set(earlier.map((other) => other.keyId))]) {
      if (this.orders.some((other) => other.keyId === keyId && other.buyerId !== order.buyerId)) continue;
      let key;
      try {
        key = await this.api.key(keyId);
      } catch (error) {
        if (error instanceof ApiRefused) continue;
        throw error;
      }
      if (key.active && !key.deleted && (key.billing ?? "tokens") === (billing ?? "tokens") && groupsThatTake(group).includes(key.group)) return key;
    }
    return null;
  }
  /** Sends (or re-sends after a failure) what the buyer needs: a new key, or a note about their topped-up key. */
  async sendIssuedKey(order, secret, grant) {
    if (!order.keyId) return this.markFailed(order, "Ключ не найден — выдайте вручную");
    const plan = parseStoredPlan(order.plan);
    grant ??= plan ? grantFor(plan, order.quantity) : void 0;
    if (!grant) return this.markFailed(order, "Не удалось определить пакет по названию лота");
    if (order.keyAction === "topup") return this.sendTopUpNotice(order, grant);
    secret ??= (await this.api.secret(order.keyId)).secret;
    const models = ((await featuredModels(this.api).catch(() => /* @__PURE__ */ new Map())).get(grant.group) ?? []).slice(0, 4);
    const text = keyDeliveredText({ shop: this.config.shopName, orderId: order.id, apiKey: secret, grant, models, links: this.links });
    const guide = setupGuideText(grant.group, this.links, models[0]);
    await this.deliverMessage(order, text, `ключ отправлен ${order.buyerName} в чат заказа`, guide);
  }
  async sendTopUpNotice(order, grant, key) {
    key ??= await this.api.key(order.keyId);
    const text = keyToppedUpText({
      shop: this.config.shopName,
      orderId: order.id,
      grant,
      preview: key.preview ?? `#${key.id}`,
      tokensLeft: key.tokens_left,
      tokenLimit: key.tokens_limit,
      billing: key.billing
    });
    await this.deliverMessage(order, text, `${order.buyerName} сообщили о пополнении ключа ${key.preview ?? `#${key.id}`}`);
  }
  /** `followUp` (the setup steps) goes right after; the order is delivered either way, a failed follow-up is only noted. */
  async deliverMessage(order, text, done, followUp) {
    try {
      await this.send(this.nodeOf(order), text);
    } catch (error) {
      return this.failAttempt(order, `Не удалось отправить сообщение: ${errorText(error)}`);
    }
    if (followUp) {
      await this.send(this.nodeOf(order), followUp).catch(
        (error) => logWarn("send.error", `Заказ #${order.id}: ключ отправлен, но инструкция — нет: ${errorText(error)}`, { orderId: order.id })
      );
    }
    Object.assign(order, { delivery: "delivered", deliveredAt: Date.now(), deliveryError: null });
    this.store.save();
    logInfo("order.delivered", `Заказ #${order.id}: ${done}`, { orderId: order.id });
  }
  async recordFunPayDelivery(order, detail) {
    let key = null;
    if (!this.config.dryRun) {
      for (const secret of detail.secrets.join("\n").match(/\bsk-[A-Za-z0-9_-]{16,}/g) ?? []) {
        key = await this.api.lookup(secret).catch(() => null);
        if (key) break;
      }
    }
    if (order.delivery !== "pending" && order.delivery !== "retry") return;
    Object.assign(order, {
      delivery: "funpay",
      deliveredAt: Date.now(),
      deliveryError: null,
      ...key ? { keyId: key.id, keyAction: "funpay", usedAtDelivery: key.tokens_used } : {}
    });
    this.store.save();
    logInfo("order.funpay", `Заказ #${order.id}: выдан автовыдачей FunPay${key ? `, это ключ #${key.id}` : " (ключ из вашего пула в товаре не найден)"}`, { orderId: order.id });
    const plan = parseStoredPlan(order.plan);
    await this.send(this.nodeOf(order), funpayDeliveredText({ shop: this.config.shopName, orderId: order.id, group: plan?.group ?? null, links: this.links })).catch(
      (error) => logWarn("send.error", `Заказ #${order.id}: не удалось отправить сообщение после автовыдачи — ${errorText(error)}`, { orderId: order.id })
    );
  }
  failAttempt(order, error) {
    if (!order || !["pending", "retry", "minted"].includes(order.delivery)) return;
    order.deliveryAttempts += 1;
    order.lastAttemptAt = Date.now();
    order.deliveryError = error.slice(0, 500);
    const exhausted = order.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS;
    if (exhausted) order.delivery = "failed";
    else if (order.delivery === "pending") order.delivery = "retry";
    this.store.save();
    (exhausted ? logError : logWarn)(
      "order.delivery_failed",
      `Заказ #${order.id}: попытка выдачи ${order.deliveryAttempts} из ${MAX_DELIVERY_ATTEMPTS} не удалась — ${error}${exhausted ? ". Бот больше не пытается, выдайте вручную" : ""}`,
      { orderId: order.id }
    );
  }
  markFailed(order, error) {
    order.delivery = "failed";
    order.deliveryError = error.slice(0, 500);
    this.store.save();
    logError("order.failed", `Заказ #${order.id}: ${error}`, { orderId: order.id });
  }
  /* ------------------------------------------------------- after delivery */
  /** After the buyer confirms: thank them, add the review bonus if the review is in, else invite one. */
  async processFollowUps() {
    const now = Date.now();
    const due = this.orders.filter((order) => order.status === "closed" && !order.thankedAt && ["delivered", "funpay"].includes(order.delivery)).filter((order) => (order.closedAt ?? 0) <= now - FOLLOW_UP_DELAY_MS || order.reviewRating !== null).filter((order) => now - (this.followUpFailures.get(order.id)?.at ?? 0) >= RETRY_DELAY_MS).slice(0, 10);
    if (!due.length) return;
    let details;
    try {
      details = await this.client.orderDetails(due.map((order) => order.id));
    } catch (error) {
      logWarn("order.follow_up", `Не удалось проверить отзывы по закрытым заказам — ${errorText(error)}. Повтор позже`);
      return;
    }
    for (const order of due) {
      const review = details.get(order.id)?.review ?? null;
      if (order.goods) {
        await this.thankForGoods(order, review);
        continue;
      }
      const bonus = this.reviewBonusFor(order);
      let granted = 0;
      if (review) {
        order.reviewRating = review.rating;
        if (bonus && !this.config.dryRun && await this.grantReviewBonus(order, bonus)) granted = bonus;
      }
      const reviewed = review !== null || this.reviewedEarlier(order);
      try {
        await this.send(this.nodeOf(order), thankYouText(order.id, reviewed, { granted, offered: reviewed ? 0 : bonus }, parseStoredPlan(order.plan)?.billing));
        logInfo("order.thanked", `Заказ #${order.id}: ${order.buyerName} подтвердил заказ, отправлена благодарность${review ? ` (отзыв ★ ${review.rating ?? "—"})` : ""}`, { orderId: order.id });
      } catch (error) {
        const failures = (this.followUpFailures.get(order.id)?.count ?? 0) + 1;
        const giveUp = failures >= MAX_FOLLOW_UP_ATTEMPTS;
        this.followUpFailures.set(order.id, { count: failures, at: Date.now() });
        logWarn("send.error", `Заказ #${order.id}: не удалось отправить благодарность — ${errorText(error)}${giveUp ? `. После ${failures} попыток бот больше не пытается` : ". Повтор через минуту"}`, { orderId: order.id });
        if (!granted && !giveUp) continue;
      }
      this.followUpFailures.delete(order.id);
      order.thankedAt = Date.now();
      this.store.save();
      if (review) await this.answerReview(order, review, order.reviewBonusAt ? order.reviewBonusTokens ?? 0 : 0);
    }
  }
  /** A confirmed Steam/SMM order: the review bonus if the review is in, a thank-you, the reply under the review. */
  async thankForGoods(order, review) {
    if (review) {
      order.reviewRating = review.rating;
      if (order.goods === "steam") await this.goods.grantBonus(order);
    }
    const reviewed = review !== null || this.reviewedEarlier(order);
    try {
      await this.send(this.nodeOf(order), fill(reviewed ? "goods_thanks_reviewed" : "goods_thanks", { order: order.id, shop: this.config.shopName }));
      logInfo("order.thanked", `Заказ #${order.id}: ${order.buyerName} подтвердил заказ, отправлена благодарность`, { orderId: order.id });
    } catch (error) {
      const failures = (this.followUpFailures.get(order.id)?.count ?? 0) + 1;
      this.followUpFailures.set(order.id, { count: failures, at: Date.now() });
      logWarn("send.error", `Заказ #${order.id}: не удалось отправить благодарность — ${errorText(error)}`, { orderId: order.id });
      if (failures < MAX_FOLLOW_UP_ATTEMPTS) return;
    }
    this.followUpFailures.delete(order.id);
    order.thankedAt = Date.now();
    this.store.save();
    if (review) await this.answerReview(order, review, 0);
  }
  /** Proof the buyer got a working key: the key spent tokens after the order was served. */
  async trackKeyUsage() {
    if (Date.now() - this.lastUsageCheck < this.usageCheckMs) return;
    this.lastUsageCheck = Date.now();
    const pending = this.orders.filter((order) => order.keyId && !order.keyFirstUsedAt && order.status !== "refunded" && ["delivered", "funpay", "manual"].includes(order.delivery) && order.orderedAt >= Date.now() - USAGE_MAX_AGE_MS);
    if (!pending.length) return;
    const keys = /* @__PURE__ */ new Map();
    let fresh = 0;
    for (const order of pending) {
      if (!keys.has(order.keyId)) keys.set(order.keyId, await this.api.key(order.keyId).catch(() => null));
      const key = keys.get(order.keyId);
      if (!key || key.tokens_used <= (order.usedAtDelivery ?? 0)) continue;
      order.keyFirstUsedAt = key.last_used_at ? Date.parse(key.last_used_at) : Date.now();
      fresh += 1;
      logInfo("order.key_used", `Заказ #${order.id}: ${order.buyerName} пользуется ключом #${key.id}`, { orderId: order.id });
    }
    if (!fresh) return;
    this.store.save();
    if (this.toggles.remindersEnabled && !this.config.dryRun) await this.askToConfirmOnceKeyWorks();
  }
  async sendReminders() {
    if (Date.now() - this.lastReminderCheck < this.reminderCheckMs) return;
    this.lastReminderCheck = Date.now();
    await this.lookForUnannouncedReviews();
    if (!this.toggles.remindersEnabled || this.config.dryRun) return;
    await this.askToConfirmOnceKeyWorks();
    await this.remindAboutLowBalance();
  }
  /** One message when an unconfirmed order's key first works: please confirm (FunPay pays the seller only then). */
  async askToConfirmOnceKeyWorks() {
    const due = this.orders.filter((order) => order.status === "paid" && ["delivered", "funpay"].includes(order.delivery) && !order.confirmReminderAt && order.keyFirstUsedAt).filter((order) => order.orderedAt >= Date.now() - CONFIRM_REMINDER_MAX_AGE_MS).sort((a, b) => a.orderedAt - b.orderedAt).slice(0, MAX_REMINDERS_PER_RUN);
    if (!due.length) return;
    const details = await this.client.orderDetails(due.map((order) => order.id)).catch(() => null);
    if (!details) return;
    for (const order of due) {
      if (details.get(order.id)?.status !== "paid" || this.chatBusy(order.buyerId) || order.confirmReminderAt) continue;
      order.confirmReminderAt = Date.now();
      this.store.save();
      try {
        await this.send(this.nodeOf(order), keyWorksText(order.id));
        logInfo("order.confirm_reminder", `Заказ #${order.id}: ключ у ${order.buyerName} заработал — попросили подтвердить заказ`, { orderId: order.id });
      } catch (error) {
        logWarn("send.error", `Заказ #${order.id}: не удалось отправить сообщение \xABключ работает\xBB — ${errorText(error)}`, { orderId: order.id });
      }
    }
  }
  /** From the goods module: the chat with this buyer waits for the seller (the assistant pauses, the panel lists it). */
  sellerNeeded(buyerId, reason) {
    const chat = Object.values(this.store.state.chats).find((candidate) => candidate.buyerId === buyerId);
    const now = Date.now();
    if (chat) {
      chat.sellerCalledAt ??= now;
      chat.sellerCallReason = reason.slice(0, 200);
      chat.aiPausedUntil = Math.max(chat.aiPausedUntil ?? 0, now + SELLER_CALL_PAUSE_MS);
      if (chat.pauseReason !== "seller_stop") chat.pauseReason = "seller_call";
      this.store.save();
    }
    logWarn("chat.seller_called", `Нужен продавец: ${reason}`);
  }
  chatBusy(buyerId) {
    const chat = Object.values(this.store.state.chats).find((candidate) => candidate.buyerId === buyerId);
    return Boolean(chat?.aiPausedUntil && chat.aiPausedUntil > Date.now());
  }
  /** A day after the thank-you, an order without a review is looked at once on FunPay; nothing is sent. */
  async lookForUnannouncedReviews() {
    const now = Date.now();
    const due = this.orders.filter((order) => order.status === "closed" && ["delivered", "funpay"].includes(order.delivery) && order.reviewRating === null && !order.reviewLookedAt).filter((order) => order.thankedAt && order.thankedAt <= now - REVIEW_LOOK_DELAY_MS && (order.closedAt ?? 0) >= now - REVIEW_LOOK_MAX_AGE_MS).slice(0, MAX_REMINDERS_PER_RUN);
    if (!due.length) return;
    const details = await this.client.orderDetails(due.map((order) => order.id)).catch(() => null);
    if (!details) return;
    for (const order of due) {
      order.reviewLookedAt = now;
      const review = details.get(order.id)?.review;
      if (review) await this.onReview(order, review);
    }
    this.store.save();
  }
  /** A buyer who used their key this week and has under 10% left gets one message; after a top-up it can come again. */
  async remindAboutLowBalance() {
    if (!this.config.topUpKeys) return;
    const owners = /* @__PURE__ */ new Map();
    for (const order of [...this.orders].sort((a, b) => b.orderedAt - a.orderedAt)) {
      if (!order.keyId || order.status === "refunded") continue;
      const owner = owners.get(order.keyId) ?? { buyerIds: /* @__PURE__ */ new Set(), order };
      owner.buyerIds.add(order.buyerId);
      owners.set(order.keyId, owner);
    }
    if (![...owners.values()].some((owner) => owner.buyerIds.size === 1)) return;
    const keys = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const answer = await this.api.listKeys(cursor).catch(() => null);
      if (!answer) return;
      keys.push(...answer.data);
      cursor = answer.next_cursor;
      if (!cursor) break;
    }
    let sent = 0;
    for (const key of keys) {
      if (sent >= MAX_REMINDERS_PER_RUN) break;
      const owner = owners.get(key.id);
      if (!owner || owner.buyerIds.size !== 1 || !key.last_used_at) continue;
      if (Date.parse(key.last_used_at) < Date.now() - LOW_BALANCE_ACTIVE_MS) continue;
      const total = key.tokens_limit;
      if (total <= 0 || key.tokens_left >= total * LOW_BALANCE_SHARE) continue;
      if ((this.store.state.lowBalance[key.id] ?? -1) >= total) continue;
      if (this.chatBusy(owner.order.buyerId)) continue;
      this.store.state.lowBalance[key.id] = total;
      this.store.save();
      try {
        await this.send(this.nodeOf(owner.order), lowBalanceText({
          preview: key.preview ?? `#${key.id}`,
          left: key.tokens_left,
          total,
          billing: key.billing,
          product: GROUP_NAMES[key.group] ?? key.group,
          shopUrl: `https://funpay.com/users/${this.client.userId}/`
        }));
        sent += 1;
        logInfo("keys.low_balance", `Ключ #${key.id} (${owner.order.buyerName}): осталось ${formatMillions(key.tokens_left)} из ${formatMillions(total)} — отправлено напоминание о пополнении`);
      } catch (error) {
        logWarn("send.error", `Ключ #${key.id} (${owner.order.buyerName}): не удалось отправить напоминание о пополнении — ${errorText(error)}`);
      }
    }
  }
  /* -------------------------------------------------------------- chats */
  onChatList(chats) {
    if (!this.chatsBaselined) {
      for (const chat of chats) {
        const stored = this.store.state.chats[chat.chatId];
        if (this.resumedQuickly && (!stored || stored.lastMessageId < chat.lastMessageId)) {
          this.scheduleChat(chat);
          continue;
        }
        this.seen.set(chat.chatId, chat.lastMessageId);
        this.store.state.chats[chat.chatId] = { ...stored ?? emptyChat(chat.chatId), lastMessageId: chat.lastMessageId, ...chat.name ? { buyerName: chat.name } : {} };
      }
      this.store.save();
      this.chatsBaselined = true;
      return;
    }
    for (const chat of chats) {
      if (chat.lastMessageId > (this.seen.get(chat.chatId) ?? 0)) this.scheduleChat(chat);
    }
  }
  /** Waits for a short pause so a burst of buyer messages gets one answer. */
  scheduleChat(chat) {
    this.seen.set(chat.chatId, chat.lastMessageId);
    clearTimeout(this.timers.get(chat.chatId));
    this.timers.set(chat.chatId, setTimeout(() => {
      this.timers.delete(chat.chatId);
      this.chatWork = this.chatWork.then(async () => {
        const sentBefore = this.lastSendAt;
        try {
          await this.processChat(chat.chatId, chat.name);
          this.chatRetries.delete(chat.chatId);
        } catch (error) {
          this.onChatError(chat, error, this.lastSendAt === sentBefore);
        }
      });
    }, REPLY_DEBOUNCE_MS));
  }
  /** A chat that failed before anything was sent is handled again later, so the buyer's message is not lost. */
  onChatError(chat, error, nothingSent) {
    const attempt = (this.chatRetries.get(chat.chatId) ?? 0) + 1;
    if (nothingSent && attempt <= CHAT_RETRIES && !this.stopped) {
      this.chatRetries.set(chat.chatId, attempt);
      const delayMs = CHAT_RETRY_MS * attempt;
      logWarn("chat.retry", `Чат ${chat.chatId} (${chat.name}): ошибка обработки — ${errorText(error)}. Повтор через ${delayMs / 1e3} с (${attempt} из ${CHAT_RETRIES})`, { chatId: chat.chatId });
      setTimeout(() => this.scheduleChat({ ...chat, lastMessageId: Math.max(chat.lastMessageId, this.seen.get(chat.chatId) ?? 0) }), delayMs);
      return;
    }
    this.chatRetries.delete(chat.chatId);
    logError("chat.error", `Чат ${chat.chatId} (${chat.name}): ошибка обработки — ${errorText(error)}`, { chatId: chat.chatId });
  }
  async processChat(chatId, displayName) {
    const selfId = this.client.userId;
    if (!selfId || this.stopped) return;
    const history = await this.client.chatHistory(chatId);
    if (!history || history.silent) return;
    const buyerId = interlocutorId(history.name, selfId);
    if (!buyerId) return;
    const now = Date.now();
    const messages = parseChatMessages(history.messages, selfId, new Date(now));
    if (!messages.length) return;
    const newestId = Math.max(...messages.map((message) => message.id));
    this.seen.set(chatId, Math.max(this.seen.get(chatId) ?? 0, newestId));
    const stored = this.store.state.chats[chatId];
    const lastOwnId = [...messages].reverse().find((message) => message.authorId === selfId)?.id ?? 0;
    const after = stored ? stored.lastMessageId : lastOwnId;
    const fresh = messages.filter((message) => message.id > after);
    const state = { ...stored ?? emptyChat(chatId) };
    state.node = history.name;
    state.buyerId = buyerId;
    state.buyerName = displayName || messages.find((message) => message.authorId === buyerId && message.authorName)?.authorName || state.buyerName;
    state.lastMessageId = Math.max(state.lastMessageId, newestId);
    if (isOwnPurchase(messages, selfId, stored)) {
      if (state.pauseReason !== "own_purchase") logInfo("chat.own_purchase", `Чат ${chatId} (${state.buyerName}): здесь вы покупатель — ассистент в этом чате не отвечает`, { chatId });
      Object.assign(state, { pauseReason: "own_purchase", aiPausedUntil: FAR_FUTURE, sellerCalledAt: null, sellerCallReason: null });
      this.saveChat(state);
      return;
    }
    if (state.pauseReason === "own_purchase") Object.assign(state, { pauseReason: null, aiPausedUntil: null });
    for (const message of stored ? fresh : messages) {
      if (!message.isSystem) continue;
      const event = classifySystemText(message.text ?? "");
      if (event.kind === "paid") this.syncRequested = true;
      else if (event.orderId) this.orderRefresh.add(event.orderId);
    }
    const buyerMessages = [];
    for (const message of fresh) {
      if (message.isSystem) {
        continue;
      } else if (message.staffBadge) {
        state.aiPausedUntil = Math.max(state.aiPausedUntil ?? 0, now + STAFF_PAUSE_MS);
        state.pauseReason = "funpay_staff";
        state.sellerCalledAt ??= now;
        state.sellerCallReason = `В чат написал сотрудник FunPay (${message.staffBadge})`;
        logWarn("chat.staff", `Чат ${chatId} (${state.buyerName}): написал сотрудник FunPay (${message.staffBadge}) — бот молчит 24 часа`, { chatId });
      } else if (message.authorId === selfId) {
        if (!message.byBot && !message.autoReply) this.onSellerMessage(state, message, now);
      } else if (message.authorId === buyerId) {
        buyerMessages.push(message);
      }
    }
    this.applyRecentSellerReply(state, messages, selfId, now);
    const sentBefore = this.lastSendAt;
    try {
      if (buyerMessages.length) {
        state.lastBuyerAt = now;
        if (this.toggles.aiEnabled) await this.onBuyerMessages(state, chatId, buyerId, buyerMessages, messages, now);
        else logInfo("chat.unanswered", `Чат ${chatId} (${state.buyerName}): ответы в чатах выключены. Сообщение: \xAB${snippet(buyerMessages)}\xBB`, { chatId });
      }
    } catch (error) {
      if (this.lastSendAt === sentBefore) state.lastMessageId = after;
      throw error;
    } finally {
      this.saveChat(state);
    }
  }
  saveChat(state) {
    this.store.state.chats[state.id] = {
      ...state,
      buyerName: state.buyerName?.slice(0, 100) ?? null,
      sellerCallReason: state.sellerCallReason?.slice(0, 200) ?? null
    };
    this.store.save();
  }
  onSellerMessage(state, message, now) {
    const text = message.text?.trim() ?? "";
    if (SELLER_RESUME_RE.test(text)) {
      Object.assign(state, { aiPausedUntil: null, pauseReason: null, sellerCalledAt: null, sellerCallReason: null });
      logInfo("chat.resumed", `Чат ${state.id} (${state.buyerName}): продавец вернул бота командой !бот`, { chatId: state.id });
    } else if (SELLER_STOP_RE.test(text)) {
      Object.assign(state, { aiPausedUntil: FAR_FUTURE, pauseReason: "seller_stop" });
      logInfo("chat.stopped", `Чат ${state.id} (${state.buyerName}): продавец выключил бота в этом чате (!стоп)`, { chatId: state.id });
    } else {
      const takeoverUntil = now + this.config.sellerTakeoverMinutes * 6e4;
      if (!state.aiPausedUntil || state.aiPausedUntil < takeoverUntil) {
        state.aiPausedUntil = takeoverUntil;
        state.pauseReason = "seller_manual";
      }
      state.sellerCalledAt = null;
      state.sellerCallReason = null;
    }
  }
  /** The seller's latest own message also counts when the bot did not see it arrive (while restarting). */
  applyRecentSellerReply(state, messages, selfId, now) {
    for (const message of [...messages].reverse()) {
      if (message.authorId !== selfId || message.byBot || message.autoReply) continue;
      const text = message.text?.trim() ?? "";
      const sentAt = message.sentAt?.getTime() ?? null;
      if (SELLER_RESUME_RE.test(text)) {
        if (state.pauseReason === "seller_stop" || state.pauseReason === "seller_manual") Object.assign(state, { aiPausedUntil: null, pauseReason: null });
        if (sentAt && state.sellerCalledAt && state.sellerCalledAt < sentAt) {
          Object.assign(state, { sellerCalledAt: null, sellerCallReason: null });
          if (state.pauseReason === "seller_call") Object.assign(state, { aiPausedUntil: null, pauseReason: null });
        }
        return;
      }
      if (SELLER_STOP_RE.test(text)) {
        Object.assign(state, { aiPausedUntil: FAR_FUTURE, pauseReason: "seller_stop" });
        return;
      }
      if (!sentAt) return;
      const until = sentAt + this.config.sellerTakeoverMinutes * 6e4;
      if (until > now && (!state.aiPausedUntil || state.aiPausedUntil < until)) Object.assign(state, { aiPausedUntil: until, pauseReason: "seller_manual" });
      return;
    }
  }
  async onBuyerMessages(state, chatId, buyerId, incoming, history, now) {
    const buyerMessages = this.goods.on ? await this.goods.onBuyerMessages(chatId, buyerId, incoming) : incoming;
    if (!buyerMessages.length) return;
    const commands = /* @__PURE__ */ new Set();
    const questions = [];
    for (const message of buyerMessages) {
      const command = buyerCommand(message.text);
      if (command) commands.add(command);
      else questions.push(message);
    }
    for (const command of commands) {
      logInfo("chat.command", `Чат ${chatId} (${state.buyerName}): команда ${COMMAND_RU[command]}`, { chatId });
      if (command === "seller") await this.callSeller(state, chatId, "Покупатель вызвал продавца командой", now, SELLER_CALLED_TEXT);
      else if (command === "help") await this.send(chatId, helpText(this.config.shopName) + (this.goods.settings.steamEnabled ? STEAM_HELP : ""));
      else await this.send(chatId, balanceText(await this.balanceLines(buyerId), this.links));
    }
    if (!questions.length || commands.has("seller")) return;
    const quote = snippet(questions);
    const refund = questions.find((message) => mentionsRefund(message.text));
    if (refund) {
      const sellerInvolved = state.aiPausedUntil !== null && state.aiPausedUntil > now;
      await this.callSeller(state, chatId, "Покупатель пишет о возврате или споре", now, sellerInvolved ? null : REFUND_HANDOFF_TEXT, snippet([refund]));
      return;
    }
    if (this.aiMayReply(state, now)) await this.replyWithAi(state, chatId, buyerId, history, now, quote);
    else {
      const why = state.aiPausedUntil && state.aiPausedUntil > now ? PAUSE_RU[state.pauseReason ?? ""] ?? "ИИ на паузе" : "ИИ не настроен";
      logInfo("chat.unanswered", `Чат ${chatId} (${state.buyerName}): ИИ не отвечал — ${why}. Сообщение: \xAB${quote}\xBB`, { chatId });
    }
  }
  async balanceLines(buyerId) {
    const byKey = /* @__PURE__ */ new Map();
    for (const order of [...this.orders].sort((a, b) => b.orderedAt - a.orderedAt)) {
      if (order.buyerId !== buyerId || !order.keyId) continue;
      byKey.set(order.keyId, [...byKey.get(order.keyId) ?? [], order.id]);
    }
    const lines = [];
    for (const [keyId, orderIds] of [...byKey].slice(0, 8)) {
      const key = await this.api.key(keyId).catch(() => null);
      if (!key) continue;
      lines.push({
        orderIds,
        preview: key.preview ?? `#${key.id}`,
        label: GROUP_NAMES[key.group] ?? key.group,
        active: key.active,
        deleted: key.deleted,
        tokensLeft: key.tokens_left,
        tokenLimit: key.tokens_limit,
        billing: key.billing
      });
    }
    return lines;
  }
  /** Marks the chat for the seller and pauses the AI there; `text` (if any) tells the buyer. */
  async callSeller(state, chatId, reason, now, text, quote) {
    const alreadyCalled = state.sellerCalledAt !== null && now - state.sellerCalledAt < SELLER_CALL_PAUSE_MS;
    state.sellerCalledAt = alreadyCalled ? state.sellerCalledAt : now;
    state.sellerCallReason = reason;
    state.aiPausedUntil = Math.max(state.aiPausedUntil ?? 0, now + SELLER_CALL_PAUSE_MS);
    if (state.pauseReason !== "seller_stop") state.pauseReason = "seller_call";
    logWarn("chat.seller_called", `Чат ${chatId} (${state.buyerName}): нужен продавец — ${reason}${quote ? `. Сообщение: \xAB${quote}\xBB` : ""}${text ? "" : " (продавец уже в чате — без сообщения покупателю)"}`, { chatId });
    if (!text) return;
    await this.send(chatId, alreadyCalled && text === SELLER_CALLED_TEXT ? SELLER_ALREADY_CALLED_TEXT : text);
  }
  aiMayReply(state, now) {
    if (!this.config.ai.key) return false;
    if (state.aiPausedUntil && state.aiPausedUntil > now) return false;
    const recent = (this.aiReplyTimes.get(state.id) ?? []).filter((time) => now - time < 60 * 6e4);
    this.aiReplyTimes.set(state.id, recent);
    if (recent.length < AI_REPLIES_PER_HOUR) return true;
    Object.assign(state, { aiPausedUntil: now + 60 * 6e4, pauseReason: "ai_limit", sellerCallReason: "Слишком много вопросов подряд — ИИ ждёт продавца" });
    state.sellerCalledAt ??= now;
    logWarn("chat.ai_limit", `Чат ${state.id} (${state.buyerName}): больше ${AI_REPLIES_PER_HOUR} ответов ИИ за час — ИИ ждёт продавца`, { chatId: state.id });
    return false;
  }
  async replyWithAi(state, chatId, buyerId, history, now, quote) {
    const images = await this.buyerImages(history, buyerId, chatId);
    const transcript = buildTranscript(history, this.client.userId, buyerId, images);
    if (transcript.at(-1)?.role !== "user") {
      logInfo("chat.unanswered", `Чат ${chatId} (${state.buyerName}): ниже уже есть ответ продавца или бота. Сообщение: \xAB${quote}\xBB`, { chatId });
      return;
    }
    const rows = this.orders.filter((order) => order.buyerId === buyerId).sort((a, b) => b.orderedAt - a.orderedAt).slice(0, 10);
    const reviewed = rows.find((order) => order.reviewRating !== null);
    const orders = rows.map((order) => {
      const bonus = this.reviewBonusFor(order);
      const note = order.reviewBonusAt ? `бонус за отзыв +${formatMillions(order.reviewBonusTokens ?? bonus)} токенов уже начислен` : reviewed && reviewed.id !== order.id ? `покупатель уже оставил отзыв по заказу #${reviewed.id}; второй отзыв FunPay не даёт, бонуса по этому заказу нет` : bonus ? `за отзыв после подтверждения начислим +${formatMillions(bonus)} токенов` : void 0;
      const usage = order.keyId && ["delivered", "funpay", "manual"].includes(order.delivery) ? order.keyFirstUsedAt ? "ключ работает (уже тратил токены)" : "ключ ещё ни разу не тратил токены — возможно, покупатель его не подключил" : void 0;
      if (order.goods) return { id: order.id, product: order.product, status: order.status, delivery: "goods", keyAction: null, orderedAt: order.orderedAt, note: this.goods.describe(order) };
      return { id: order.id, product: order.product, status: order.status, delivery: order.delivery, keyAction: order.keyAction, orderedAt: order.orderedAt, note, usage };
    });
    const system = await systemPrompt(this.config.shopName, this.api, state.buyerName ?? "покупатель", orders, this.goods.aiContext(buyerId));
    const replyTimes = this.aiReplyTimes.get(state.id) ?? [];
    replyTimes.push(now);
    this.aiReplyTimes.set(state.id, replyTimes);
    let reply;
    try {
      reply = await this.askAi([{ role: "system", content: system }, ...transcript], chatId);
    } catch (error) {
      logError("chat.ai_error", `Чат ${chatId} (${state.buyerName}): ИИ не ответил — ${errorText(error)}. Сообщение: \xAB${quote}\xBB`, { chatId });
      await this.callSeller(state, chatId, "ИИ не смог ответить — нужен ответ продавца", now, AI_UNAVAILABLE_TEXT, quote);
      return;
    }
    if (HANDOFF_RE.test(reply)) {
      await this.callSeller(state, chatId, "ИИ передал вопрос продавцу", now, AI_HANDOFF_TEXT, quote);
      return;
    }
    if (OFFTOPIC_RE.test(reply)) {
      const lastOwn = [...history].reverse().find((message) => message.authorId === this.client.userId && message.byBot);
      if (lastOwn?.text?.trim().startsWith(OFF_TOPIC_PREFIX)) {
        logInfo("chat.off_topic", `Чат ${chatId} (${state.buyerName}): снова не по магазину — бот промолчал. Сообщение: \xAB${quote}\xBB`, { chatId });
        return;
      }
      await this.send(chatId, offTopicText(this.config.shopName));
      logInfo("chat.off_topic", `Чат ${chatId} (${state.buyerName}): вопрос не по магазину — отправлен стандартный ответ. Сообщение: \xAB${quote}\xBB`, { chatId });
      return;
    }
    const clean = sanitizeReply(reply, [this.links.siteHost, "funpay.com"]);
    if (!clean) {
      logWarn("chat.ai_empty", `Чат ${chatId} (${state.buyerName}): ответ ИИ пуст после фильтра — ничего не отправлено. Сообщение: \xAB${quote}\xBB`, { chatId });
      return;
    }
    for (const part of splitMessage(clean)) await this.send(chatId, part);
    state.lastAiReplyAt = now;
    state.aiReplies += 1;
    logInfo("chat.ai_reply", `Чат ${chatId} (${state.buyerName}): ИИ ответил на \xAB${quote}\xBB (${clean.length} символов${images.size ? `, видел картинок: ${images.size}` : ""})`, { chatId });
  }
  /** The buyer's latest pictures, as data URLs by message id, so the AI can read error screenshots. */
  async buyerImages(history, buyerId, chatId) {
    const images = /* @__PURE__ */ new Map();
    const wanted = currentConversation(history).filter((message) => message.authorId === buyerId && message.imageUrl).slice(-MAX_CHAT_IMAGES);
    for (const message of wanted) {
      const url = message.imageUrl;
      let data = this.imageCache.get(url);
      if (!data) {
        data = await chatImageDataUrl(url, this.testOrigin) ?? void 0;
        if (!data) {
          logWarn("chat.image", `Чат ${chatId}: не удалось открыть картинку покупателя — ИИ попросит описать ошибку текстом`, { chatId });
          continue;
        }
        this.imageCache.set(url, data);
        if (this.imageCache.size > IMAGE_CACHE_SIZE) this.imageCache.delete(this.imageCache.keys().next().value);
      }
      images.set(message.id, data);
    }
    return images;
  }
  async askAi(messages, chatId) {
    const ai = { baseUrl: this.config.aiBaseUrl ?? this.links.apiBaseUrl, apiKey: this.config.ai.key, model: this.config.ai.model };
    try {
      return await completeChat(ai, messages);
    } catch (error) {
      if (!(error instanceof AiError) || !error.retryable) throw error;
      logWarn("chat.ai_retry", `Чат ${chatId}: ИИ временно не ответил (${error.message}), повтор через 3 с`, { chatId });
      await sleep(AI_RETRY_DELAY_MS);
      return completeChat(ai, messages);
    }
  }
  /* ------------------------------------------------------------ sending */
  /** All sends are serialized with a gap, to stay under FunPay's flood limits. */
  send(node, text) {
    const task = this.sendChain.then(() => this.sendNow(node, text));
    this.sendChain = task.catch(() => void 0);
    return task;
  }
  /** A message FunPay finds too long goes out again in two halves. */
  async sendNow(node, text, depth = 0) {
    const wait = this.lastSendAt + SEND_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    if (this.config.dryRun) {
      this.lastSendAt = Date.now();
      this.store.pushOutbox({ at: Date.now(), node, text: redactSecrets2(text).slice(0, 1500), dryRun: true });
      console.log(`(тест) сообщение в чат ${node}: ${redactSecrets2(text).slice(0, 160).replace(/\n/g, " ")}`);
      return null;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const id = await this.client.sendMessage(node, text);
        this.lastSendAt = Date.now();
        if (id && /^\d+$/.test(node)) this.seen.set(node, Math.max(this.seen.get(node) ?? 0, id));
        this.store.pushOutbox({ at: Date.now(), node, text: redactSecrets2(text).slice(0, 1500), dryRun: false });
        return id;
      } catch (error) {
        if (error instanceof FunPaySendError && error.flood && attempt < 4) {
          logWarn("send.flood", `FunPay просит писать реже (чат ${node}), повтор через ${5 * attempt} с`, { chatId: node });
          await sleep(5e3 * attempt);
          continue;
        }
        const lines = text.split("\n");
        if (error instanceof FunPaySendError && error.tooLong && lines.length > 1 && depth < 3) {
          logWarn("send.split", `FunPay не принял сообщение в чат ${node} (${errorText(error)}) — отправляем двумя частями`, { chatId: node });
          const half = Math.ceil(lines.length / 2);
          const first = lines.slice(0, half).join("\n").trim();
          const second = lines.slice(half).join("\n").trim();
          if (first) await this.sendNow(node, first, depth + 1);
          return second ? this.sendNow(node, second, depth + 1) : null;
        }
        logError("send.error", `Не удалось отправить сообщение в чат ${node} — ${errorText(error)}`, { chatId: node });
        throw error;
      }
    }
  }
  /* ------------------------------------------------- status and dashboard */
  heartbeat(force = false) {
    if (!force && Date.now() - this.lastHeartbeat < 3e4) return;
    this.lastHeartbeat = Date.now();
    this.store.state.status = {
      state: this.status,
      startedAt: this.startedAt,
      heartbeatAt: Date.now(),
      username: this.client.username,
      userId: this.client.userId,
      dryRun: this.config.dryRun,
      aiConfigured: Boolean(this.config.ai.key),
      lastOrderSyncAt: this.lastOrderSyncAt,
      lastError: this.lastError?.message ?? null,
      lastErrorAt: this.lastError?.at ?? null,
      lastRaiseAt: this.lastRaiseAt
    };
    this.store.save();
  }
  /** «Выдать ключ»: the order is delivered again from the start (the Idempotency-Key keeps a key already made). */
  retryDelivery(orderId) {
    const order = this.store.state.orders[orderId];
    if (!order) return "Заказ не найден";
    if (order.status !== "paid") return "Заказ уже не в статусе \xABоплачен\xBB";
    if (order.goods === "smm" && order.smm) {
      order.smm.state = order.smm.link ? "ready" : "asked";
      Object.assign(order, { delivery: "working", deliveryError: null });
      this.store.save();
      logInfo("order.retry", `Заказ #${order.id}: продавец запустил SMM-заказ снова`, { orderId: order.id });
      return order.smm.link ? "Бот отправит заказ в течение минуты" : "Бот ждёт ссылку от покупателя";
    }
    if (order.steam) order.steam.waitingSince = null;
    order.delivery = order.goods === "steam" ? order.steam?.expiresAt ? "minted" : "pending" : order.keyId && (order.keyAction === "issued" || order.keyAction === "topup") ? "minted" : "pending";
    Object.assign(order, { deliveryAttempts: 0, lastAttemptAt: null, deliveryError: null });
    this.store.save();
    logInfo("order.retry", `Заказ #${order.id}: продавец запустил выдачу снова`, { orderId: order.id });
    return "Бот выдаст ключ в течение минуты";
  }
  /** «Выдано вручную»: the seller handled the order; the bot leaves it. */
  markManual(orderId) {
    const order = this.store.state.orders[orderId];
    if (!order) return "Заказ не найден";
    Object.assign(order, { delivery: "manual", deliveryError: null });
    this.store.save();
    logInfo("order.manual", `Заказ #${order.id}: отмечен как выданный вручную`, { orderId: order.id });
    return "Отмечено";
  }
  /** «Отключить ключ» after a refund. */
  async disableOrderKey(orderId) {
    const order = this.store.state.orders[orderId];
    if (!order?.keyId) return "У заказа нет ключа";
    if (this.orders.some((other) => other.keyId === order.keyId && other.id !== order.id && other.status !== "refunded")) {
      return "Этот ключ пополнялся и другими заказами покупателя — отключите или уменьшите его в /seller вручную";
    }
    await this.api.setActive(order.keyId, false);
    logInfo("order.key_revoked", `Заказ #${order.id}: ключ #${order.keyId} отключён продавцом`, { orderId: order.id });
    return `Ключ #${order.keyId} отключён`;
  }
  /** «Готово, вернуть бота»: the same as !бот in the chat. */
  resumeChat(chatId) {
    const chat = this.store.state.chats[chatId];
    if (!chat) return "Чат не найден";
    Object.assign(chat, { aiPausedUntil: null, pauseReason: null, sellerCalledAt: null, sellerCallReason: null });
    this.store.save();
    logInfo("chat.resumed", `Чат ${chatId} (${chat.buyerName}): продавец вернул бота с панели`, { chatId });
    return "Бот снова отвечает в этом чате";
  }
  setToggle(name, value) {
    this.store.state.toggles[name] = value;
    this.store.save();
    logInfo("bot.toggle", `Переключатель \xAB${TOGGLE_RU[name]}\xBB: ${value ? "включён" : "выключен"}`);
  }
};
var TOGGLE_RU = {
  aiEnabled: "Ответы в чатах",
  deliveryEnabled: "Автовыдача ключей",
  remindersEnabled: "Напоминания",
  raiseEnabled: "Поднятие лотов"
};
function emptyChat(id) {
  return {
    id,
    node: null,
    buyerName: null,
    buyerId: null,
    lastMessageId: 0,
    lastBuyerAt: null,
    aiPausedUntil: null,
    pauseReason: null,
    sellerCalledAt: null,
    sellerCallReason: null,
    lastAiReplyAt: null,
    aiReplies: 0
  };
}
function isOwnPurchase(messages, selfId, stored) {
  const paid = [...messages].reverse().find((message) => message.paidBy !== null);
  if (paid) return paid.paidBy === selfId;
  return stored?.pauseReason === "own_purchase";
}
function snippet(messages) {
  const text = messages.map((message) => message.text?.trim() || (message.imageUrl ? "[изображение]" : "")).filter(Boolean).join(" / ").replace(/\s+/g, " ");
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
function waitText(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}` : `${minutes} мин`;
}


// src/dashboard.ts
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";


// src/dashboard-theme.ts
var DASHBOARD_THEME_KEY = "astra-reseller-console-theme";
var dashboardThemeInit = `(() => {
  let theme = 'light';
  try { const saved = localStorage.getItem('${DASHBOARD_THEME_KEY}'); if (saved === 'dark' || saved === 'light') theme = saved; } catch {}
  document.documentElement.dataset.theme = theme;
})();`;
var dashboardThemeControls = `
 const themeButton = document.querySelector('[data-theme-toggle]');
 const showTheme = theme => {
   document.documentElement.dataset.theme = theme;
   themeButton?.setAttribute('aria-pressed', String(theme === 'dark'));
   if (themeButton) {
     themeButton.title = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
     const label = themeButton.querySelector('[data-theme-label]');
     if (label) label.textContent = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
   }
 };
 showTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
 themeButton?.addEventListener('click', () => {
   const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
   showTheme(theme);
   try { localStorage.setItem('${DASHBOARD_THEME_KEY}', theme); } catch {}
 });
`;


// src/dashboard-ui.ts
function icon(name) {
  const paths = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    ai: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
    goods: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="m3 7 3-4h12l3 4M3 12h18M9 16h6"/>',
    orders: '<path d="M8 3H5v18l4-2 3 2 3-2 4 2V3h-3M9 3h6v4H9zM8 11h8M8 15h5"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.overview}</svg>`;
}
var dashboardStyles = `
:root{color-scheme:light;--bg:#f4f6f8;--surface:#fff;--ink:#202d38;--muted:#7c8793;--line:#e6eaee;--brand:#117b61;--soft:#e9f5ef;--red:#ba4545;--amber:#9a681e}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}button,input,select{font:inherit}button,a,input,summary{touch-action:manipulation}button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #76baaa;outline-offset:3px}
.sidebar{width:224px;position:fixed;inset:0 auto 0 0;display:flex;flex-direction:column;background:#17242d;color:#d3dde2;padding:30px 18px;z-index:10}
.brand{display:flex;align-items:center;gap:11px;color:#fff;font-weight:700;font-size:21px;letter-spacing:-.5px;padding:0 12px 35px}.brand-mark{display:grid;place-items:center;width:34px;height:34px;background:#b9ebca;border-radius:10px;color:#183b2b}.brand small{display:block;color:#8c9da7;font-size:10px;font-weight:500;letter-spacing:1.9px;text-transform:uppercase;margin-top:-3px}
.nav-caption{font-size:10px;letter-spacing:1.8px;color:#8498a4;padding:0 14px;margin:8px 0 12px;font-weight:600}.nav-link{display:flex;align-items:center;gap:12px;padding:12px 14px;margin:4px 0;border-radius:8px;color:#aabac4;font-size:13px;font-weight:500}.nav-link:hover{background:#22333e;color:#fff;text-decoration:none}.nav-link.active{background:#2b423f;color:#c8efda}.nav-link.active:after{content:"";margin-left:auto;width:5px;height:5px;border-radius:50%;background:#b9ebca}
.sidebar-bottom{margin-top:auto;padding:20px 12px 0;border-top:1px solid #2b3942;color:#92a5af;font-size:12px}.sidebar-bottom strong{display:block;color:#dae5ea;font-size:13px;font-weight:500;margin:8px 0 2px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#22a878;margin-right:7px}.dot.bad{background:var(--red)}
.workspace{margin-left:224px}.topbar{height:76px;display:flex;align-items:center;justify-content:space-between;padding:0 38px;background:#fff;border-bottom:1px solid var(--line);gap:16px}.breadcrumb{font-size:12px;color:var(--muted)}.breadcrumb span{color:var(--ink);margin-left:10px}.topbar-meta{display:flex;align-items:center;gap:18px;font-size:12px;color:var(--muted)}.avatar{width:31px;height:31px;border-radius:50%;display:grid;place-items:center;background:#e8f1ed;color:#31644f;font-size:11px;font-weight:700}
main{max-width:1600px;padding:34px 38px 60px;margin:auto;min-width:0}.page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:26px}.eyebrow{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.8px;color:var(--muted);margin-bottom:7px}h1{font-size:28px;letter-spacing:-.8px;line-height:1.3;font-weight:650;margin:0 0 7px}h2{font-size:16px;font-weight:650;margin:25px 0 14px;letter-spacing:-.2px}h3{font-size:14px;margin:0 0 10px;font-weight:600}p{margin:10px 0}.subtitle{font-size:13px;color:var(--muted);margin:0;max-width:750px}.heading-action{white-space:nowrap;margin-top:13px}.badge{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border:1px solid var(--line);background:#fff;border-radius:6px;font-size:11px;font-weight:500;white-space:nowrap}.badge.green{background:var(--soft);border-color:#d8ebdf;color:var(--brand)}.badge.amber{background:#fff4e2;border-color:#f2dfbb;color:var(--amber)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:24px}.stat{background:#fff;border:1px solid var(--line);border-radius:11px;padding:21px 22px;min-width:0}.stat-label{display:flex;justify-content:space-between;align-items:center;color:#6d7b87;font-size:12px}.stat-label svg{color:#99a8b1;width:17px;height:17px}.stat-value{font-size:31px;font-weight:600;letter-spacing:-1px;line-height:1.5;margin:9px 0 1px;font-variant-numeric:tabular-nums}.stat-note{color:var(--muted);font-size:11px}.stat-note .ok{font-weight:500}
.card{background:#fff;border:1px solid var(--line);border-radius:11px;padding:21px 23px;margin-bottom:18px;min-width:0}.card>table{margin:-3px 0 5px}.card:has(>table){overflow:auto}.card>h2:first-child{margin-top:0}.card-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:16px;margin-bottom:13px;border-bottom:1px solid var(--line)}.card-head h2,.card-head h3{margin:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;min-width:0}.grid>.card{margin-bottom:0}.overview-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(280px,1fr);gap:22px;margin-bottom:24px}.grid>*,.overview-grid>*{min-width:0}.section-copy{max-width:720px;color:var(--muted);font-size:12px;margin:-5px 0 18px}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:13px 12px;border-bottom:1px solid #edf0f3;text-align:left;vertical-align:top}th{font-size:10px;font-weight:600;color:#7b8893;text-transform:uppercase;letter-spacing:.7px;white-space:nowrap;background:#f9fafb}th:first-child,td:first-child{padding-left:10px}tr:last-child td{border-bottom:0}td{max-width:520px;overflow-wrap:anywhere}tbody tr:hover td{background:#fbfcfc}td a{font-weight:500}td:has(>.inline){white-space:nowrap}.table-wrap{overflow:auto;min-width:0}table .muted{font-size:11px;margin-top:3px}td pre{font-size:11px;max-width:680px}table:has(input[name=markers]){min-width:650px}table:has(input[name=markers]) td:nth-child(2){width:58%}table:has(input[name=markers]) td:nth-child(3){white-space:nowrap;font-weight:600}table:has(input[name=markers]) td:first-child{width:35px}
.muted{color:var(--muted);font-size:12px}.ok{color:var(--brand)}.off,.lvl-warn{color:var(--amber)}.bad,.lvl-error{color:var(--red)}button,.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid transparent;background:var(--brand);color:white;border-radius:7px;padding:9px 14px;cursor:pointer;font-size:12px;font-weight:550;line-height:1.3;transition:background .15s,box-shadow .15s}button:hover,.button:hover{background:#08634d;text-decoration:none;box-shadow:0 2px 5px #142f2514}button.ghost,.button.ghost{background:#fff;border-color:#dde3e7;color:#53616e}button.ghost:hover,.button.ghost:hover{background:#f3f6f7}button.danger{background:#fff3f3;color:#b54747;border-color:#efd9d9}button.danger:hover{background:#ffe7e7}button:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}.inline{display:inline}.inline+ .inline{margin-left:4px}td button{font-size:11px;padding:7px 10px}
input:not([type=checkbox]):not([type=hidden]),select{color:var(--ink);background:#fbfcfd;border:1px solid #dce3e8;border-radius:6px;padding:8px 10px;max-width:100%;outline-offset:2px}input[type=number]{width:130px}input[size="4"]{width:65px}input[type=checkbox]{width:15px;height:15px;accent-color:var(--brand);vertical-align:-3px;margin:0 7px 0 0;cursor:pointer}label{font-size:12px;color:#53616e}form p:has(label){margin:16px 0}form p label input:not([type=checkbox]){margin-top:6px}form .grid{gap:30px}.toggle{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}.toggle:last-child{border-bottom:0}.toggle b{font-weight:500}.toggle button{background:#f2f5f6;color:#52606c;border:1px solid #e3e8eb;padding:7px 11px}.toggle:has(input){justify-content:flex-start}.toggle:has(input) label:first-child{margin-right:auto}
.flash{padding:13px 17px;background:#e9f6ee;border:1px solid #cfe9d9;color:#216247;border-radius:8px;margin-bottom:20px;font-size:12px}.notice{padding:13px 16px;background:#f5f8fa;border:1px solid #e3eaf0;border-radius:7px;font-size:12px;color:#627583;margin:14px 0}.notice.green{background:#f0f8f3;border-color:#dfeee4;color:#54806a}.empty{padding:28px 18px;text-align:center;color:var(--muted);font-size:12px}.empty .empty-icon{width:39px;height:39px;display:grid;place-items:center;background:var(--soft);color:var(--brand);border-radius:50%;margin:0 auto 10px}.empty strong{display:block;color:#4b6156;font-size:13px;font-weight:500;margin-bottom:4px}
.queue-summary{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:17px}.queue-summary strong{font-size:25px;font-weight:600;letter-spacing:-.6px}.progress{height:5px;border-radius:4px;background:#edf1f3;overflow:hidden;margin:14px 0}.progress span{display:block;height:100%;background:#238a6c;border-radius:4px}.queue-list{margin:17px 0 0;padding:0;list-style:none}.queue-list li{display:flex;gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid var(--line)}.queue-list li:last-child{border:0}.queue-list .queue-kind{display:grid;place-items:center;border-radius:6px;background:#f0f5f3;color:#5a7b6c;width:29px;height:29px;flex-shrink:0;font-size:10px;font-weight:600}.queue-list strong{font-size:12px;font-weight:500}.queue-list small{display:block;color:var(--muted);font-size:10px}.queue-list .queue-index{margin-left:auto;font-size:10px;color:#a3adb4}
.activity-list{list-style:none;padding:0;margin:0}.activity-list li{display:grid;grid-template-columns:62px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);font-size:12px}.activity-list li:last-child{border:0}.activity-list time{color:#99a4ae;font-size:10px;font-variant-numeric:tabular-nums;padding-top:2px}.section-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:17px;flex-wrap:wrap}.section-toolbar input[type=search]{min-width:220px}.section-toolbar .muted{margin-left:auto}.selection-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:15px 0}.selection-tools button{padding:6px 10px}.filter-empty{display:none;text-align:center;padding:25px;color:var(--muted)}details{margin-top:7px}summary{color:#86959f;font-size:11px;cursor:pointer}details[open] summary{margin-bottom:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace}.footer{display:flex;justify-content:space-between;gap:15px;padding-top:25px;color:#9ba7b0;font-size:10px}.unsaved{display:none;background:#fff5df;color:#8d6b29;padding:8px 14px;border-radius:6px;font-size:11px;margin-bottom:16px}.unsaved.visible{display:block}.card-title{font-size:13px;font-weight:600;margin-bottom:12px}.stack-gap{margin-top:22px}
@media(min-width:1600px){main{padding-top:42px}.stats{gap:22px}.stat{padding:25px}}
@media(max-width:1150px){.sidebar{width:194px;padding-left:12px;padding-right:12px}.workspace{margin-left:194px}.topbar{padding:0 24px}main{padding:28px 24px}.overview-grid{grid-template-columns:1fr}.stats{gap:10px}.stat{padding:17px}.stat-value{font-size:27px}.grid{grid-template-columns:1fr}.grid>.card{margin-bottom:0}}
@media(max-width:760px){.sidebar{position:sticky;inset:0;width:100%;padding:12px 16px;display:block}.brand{padding:0;font-size:17px}.brand-mark{width:29px;height:29px}.brand small{font-size:8px}.nav-caption,.sidebar-bottom{display:none}.sidebar nav{display:flex;gap:5px;overflow:auto;margin-top:10px;scrollbar-width:none}.nav-link{padding:8px 11px;gap:7px;white-space:nowrap;font-size:11px;margin:0}.nav-link svg{width:15px;height:15px}.nav-link.active:after{display:none}.workspace{margin-left:0}.topbar{height:51px;padding:0 20px}.topbar-meta{gap:10px;font-size:10px}.breadcrumb{font-size:10px}.topbar-meta .version{display:none}main{padding:24px 18px 35px}.page-heading{margin-bottom:20px;gap:10px}h1{font-size:25px}.heading-action{display:none}.subtitle{font-size:12px}.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:18px}.stat{padding:15px 16px}.stat-value{font-size:28px}.stat-label{font-size:10px}.stat-note{font-size:10px}.card{padding:17px;margin-bottom:15px}.card:has(>table){padding:8px 10px}.card-head{padding-bottom:12px}.overview-grid{gap:15px}.grid{gap:15px}.queue-list li strong{font-size:11px}h2{font-size:15px;margin-top:21px}.footer{font-size:9px}.section-toolbar input[type=search]{min-width:0;width:100%}.toggle{gap:8px}.toggle:has(input){align-items:flex-start}.toggle:has(input) label:first-child{width:100%}form .grid{gap:15px}}
/* Theme changes affect the whole console, including native form controls. */
.theme-toggle{min-height:40px;min-width:40px;white-space:nowrap;padding:8px 10px}
.theme-toggle svg{width:16px;height:16px;flex-shrink:0}
.theme-icon-light{display:none}
:root[data-theme="dark"]{color-scheme:dark;--bg:#111820;--surface:#1b2630;--ink:#e7eef4;--muted:#a8b7c5;--line:#344651;--brand:#79d8b3;--soft:#203e34;--red:#ffaaa7;--amber:#f1c27a}
[data-theme="dark"] .topbar,[data-theme="dark"] .card,[data-theme="dark"] .stat,[data-theme="dark"] .badge{background:var(--surface)}
[data-theme="dark"] .sidebar{border-right:1px solid var(--line)}
[data-theme="dark"] .badge.green{background:var(--soft);border-color:#3b6250}
[data-theme="dark"] .badge.amber{background:#3a2e20;border-color:#665137}
[data-theme="dark"] .stat-label,[data-theme="dark"] label,[data-theme="dark"] th{color:var(--muted)}
[data-theme="dark"] .stat-label svg{color:var(--muted)}
[data-theme="dark"] td,[data-theme="dark"] th{border-color:var(--line)}
[data-theme="dark"] th{background:#202e39}
[data-theme="dark"] tbody tr:hover td{background:#23333e}
[data-theme="dark"] button,[data-theme="dark"] .button{color:#10281f}
[data-theme="dark"] button:hover,[data-theme="dark"] .button:hover{background:#91e6c6;box-shadow:0 2px 8px #0003}
[data-theme="dark"] button.ghost,[data-theme="dark"] .button.ghost{background:var(--surface);border-color:var(--line);color:var(--ink)}
[data-theme="dark"] button.ghost:hover,[data-theme="dark"] .button.ghost:hover{background:#273b46}
[data-theme="dark"] button.danger{background:#3b252b;color:var(--red);border-color:#69434b}
[data-theme="dark"] button.danger:hover{background:#4c2d34}
[data-theme="dark"] input:not([type=checkbox]):not([type=hidden]),[data-theme="dark"] select{background:#14202a;border-color:#3a4e5e;color:var(--ink)}
[data-theme="dark"] input::placeholder{color:#93a6b5}
[data-theme="dark"] .toggle button{background:#25343e;border-color:var(--line);color:var(--ink)}
[data-theme="dark"] .toggle button:hover{background:#304650}
[data-theme="dark"] .avatar{background:var(--soft);color:var(--brand)}
[data-theme="dark"] .flash{background:#203a30;border-color:#3b6250;color:#b8e8cf}
[data-theme="dark"] .notice{background:#1d2e3c;border-color:#344d61;color:#bdd0df}
[data-theme="dark"] .notice.green{background:#203a30;border-color:#3b6250;color:#b8e8cf}
[data-theme="dark"] .notice.bad{background:#3b252b;border-color:#69434b;color:var(--red)}
[data-theme="dark"] .empty strong{color:var(--ink)}
[data-theme="dark"] .progress{background:var(--line)}
[data-theme="dark"] .progress span{background:var(--brand)}
[data-theme="dark"] .queue-list .queue-kind{background:var(--soft);color:var(--brand)}
[data-theme="dark"] .unsaved{background:#3a2e20;color:var(--amber)}
[data-theme="dark"] .theme-icon-light{display:block}
[data-theme="dark"] .theme-icon-dark{display:none}
@media(max-width:760px){.theme-toggle [data-theme-label]{display:none}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
`;
var dashboardScript = `
(() => {
 ${dashboardThemeControls}
 let dirty = false;
 const notice = document.querySelector('.unsaved');
 document.addEventListener('input', event => {
  if (event.target.matches('input[type=search]')) return;
  dirty = true; notice?.classList.add('visible');
 });
 document.addEventListener('change', event => { if (event.target.closest('form')) { dirty = true; notice?.classList.add('visible'); } });
 document.querySelectorAll('[data-filter]').forEach(input => input.addEventListener('input', () => {
  const value = input.value.trim().toLocaleLowerCase();
  const scope = document.getElementById(input.dataset.filter);
  scope?.querySelectorAll('tr[data-search]').forEach(row => { row.hidden = !row.textContent.toLocaleLowerCase().includes(value); });
 }));
 const selection = () => { const count = document.querySelectorAll('input[name=markers]:checked:not(:disabled)').length; document.querySelectorAll('[data-selection]').forEach(e => { e.textContent = 'Выбрано: ' + count; }); };
 document.querySelectorAll('[data-select]').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('input[name=markers]:not(:disabled)').forEach(input => { input.checked = button.dataset.select === 'all'; }); dirty = true; notice?.classList.add('visible'); selection(); }));
 document.addEventListener('change', selection); selection();
 document.querySelectorAll('form').forEach(form => form.addEventListener('submit', event => {
  const action = form.querySelector('input[name=action]')?.value;
  const messages = {goods_clear:'Очистить очередь? Уже опубликованные лоты останутся на FunPay.', disable_key:'Отключить этот ключ покупателя?', goods_forget:'Убрать лот из управления ботом? На FunPay он останется.'};
  if (messages[action] && !confirm(messages[action])) { event.preventDefault(); return; }
  dirty = false;
 }));
 const key = 'reseller-scroll-' + new URL(location.href).searchParams.get('view');
 const previous = sessionStorage.getItem(key); if (previous) { window.scrollTo(0, Number(previous)); sessionStorage.removeItem(key); }
 setInterval(() => { if (!dirty && document.visibilityState === 'visible' && !document.querySelector('input:focus,select:focus,details[open]')) { sessionStorage.setItem(key, String(window.scrollY)); location.reload(); } }, 30000);
 if (new URL(location.href).searchParams.has('done')) { const url = new URL(location.href); url.searchParams.delete('done'); history.replaceState(null, '', url); }
})();
`;


// src/dashboard.ts
var DELIVERY_RU = {
  preexisting: "до запуска бота",
  none: "не ключ",
  pending: "выдаётся",
  retry: "повтор выдачи",
  minted: "ключ создан, отправляется",
  delivered: "ключ выдан",
  funpay: "автовыдача FunPay",
  manual: "выдано вручную",
  working: "выполняется",
  stale: "нужна выдача",
  failed: "ошибка выдачи",
  skipped: "выдача не нужна"
};
var STATUS_RU2 = { paid: "оплачен", closed: "закрыт", refunded: "возврат" };
var STATE_RU = { starting: "запускается", online: "работает", error: "нет связи с FunPay — повторяет попытки", auth_error: "FunPay не принял golden_key" };
function startDashboard(config, store, bot, api) {
  const extension = dashboardExtensionFactory?.({config,store,bot,api,dir:BOT_DIR,version:VERSION,restart:()=>process.kill(process.pid,"SIGTERM")});
  activeDashboardExtension=extension;
  const token = randomBytes(16).toString("hex");
  const hosts = /* @__PURE__ */ new Set([`127.0.0.1:${config.dashboardPort}`, `localhost:${config.dashboardPort}`]);
  let pool = null;
  async function poolText() {
    if (pool && Date.now() - pool.at < 6e4) return pool.text;
    try {
      const me = await api.me();
      let text = `${formatTokens(me.pool.balance)} токенов в пуле \xB7 ключей: ${me.keys.active} активных`;
      if (config.ai.keyId) {
        const key = await api.key(config.ai.keyId).catch(() => null);
        if (key) text += ` \xB7 ключ ассистента: осталось ${formatTokens(key.tokens_left)}`;
      }
      pool = { at: Date.now(), text, tokens: me.pool?.balance, usd: me.usd_pool?.balance, steamUsd: me.steam_pool?.balance, smmUsd: me.smm_pool?.balance };
    } catch (error) {
      pool = { at: Date.now(), text: `сервис ключей не ответил: ${error instanceof Error ? error.message : String(error)}` };
    }
    return pool.text;
  }
  async function page(url) {
    const state = store.state;
    const status2 = state.status;
    const now = Date.now();
    const alive2 = status2 && now - status2.heartbeatAt < 9e4;
    const views = {
      overview: { title: "Обзор магазина", subtitle: "Продажи, публикации и всё, что требует вашего внимания.", icon: "overview", nav: "Обзор" },
      ai: { title: "AI \xB7 Лоты FunPay", subtitle: "Пакеты API-доступа, цены и публикация в разделах \xABТокены\xBB.", icon: "ai", nav: "AI-лоты" },
      goods: { title: "Steam и SMM", subtitle: "Каталог, наценки, наличие и результаты продаж.", icon: "goods", nav: "Steam и SMM" },
      orders: { title: "Заказы и покупатели", subtitle: "Выдача ключей, выполнение заказов и обращения к продавцу.", icon: "orders", nav: "Заказы" },
      activity: { title: "Журнал работы", subtitle: "Сообщения бота и события FunPay в одном месте.", icon: "activity", nav: "Журнал" }
    };
    const requestedView = url.searchParams.get("view") ?? (url.searchParams.has("errors") ? "activity" : "overview");
    const view = Object.hasOwn(views, requestedView) ? requestedView : "overview";
    const currentView = views[view];
    const poolDescription = await poolText();
    const lots2 = Object.values(state.goods.lots);
    const activeLots = lots2.filter((lot) => lot.active).length;
    const run = state.goods.publisher;
    const waiting = run.queue.length + run.blocked.length;
    const completed = run.posted;
    const progress = completed + waiting ? Math.round(completed / (completed + waiting) * 100) : 0;
    const orders = Object.values(state.orders).sort((a, b) => b.orderedAt - a.orderedAt);
    const attention = orders.filter((order) => order.status === "paid" && ["stale", "failed"].includes(order.delivery) || order.status === "refunded" && order.keyId && order.refundedAt && now - order.refundedAt < 7 * 864e5);
    const calls = Object.values(state.chats).filter((chat) => chat.sellerCalledAt).sort((a, b) => (b.sellerCalledAt ?? 0) - (a.sellerCalledAt ?? 0));
    const onlyProblems = url.searchParams.get("errors") === "1";
    const entries = recentEntries(150, onlyProblems);
    const form = (action2, fields, label, style = "") => `<form method="post" action="/action" class="inline"><input type="hidden" name="token" value="${token}"><input type="hidden" name="view" value="${view}"><input type="hidden" name="action" value="${action2}">${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join("")}<button class="${style}">${esc(label)}</button></form>`;
    const toggles = Object.keys(TOGGLE_RU).map((name) => `<div class="toggle"><span>${TOGGLE_RU[name]}: <b class="${state.toggles[name] ? "ok" : "off"}">${state.toggles[name] ? "вкл" : "выкл"}</b></span>${form("toggle", { name, value: state.toggles[name] ? "0" : "1" }, state.toggles[name] ? "Выключить" : "Включить")}</div>`).join("");
    const orderRow = (order, withActions) => `<tr>
      <td><a href="https://funpay.com/orders/${order.id}/" target="_blank">#${order.id}</a><div class="muted">${formatMoscow(order.orderedAt)}</div></td>
      <td>${esc(order.buyerName)}</td><td>${esc(order.product)}</td>
      <td>${STATUS_RU2[order.status] ?? order.status}</td>
      <td>${DELIVERY_RU[order.delivery] ?? order.delivery}${order.keyId ? ` \xB7 ключ #${order.keyId}${order.keyAction === "topup" ? " (пополнен)" : ""}` : ""}${order.keyFirstUsedAt ? ' \xB7 <span class="ok">используется</span>' : ""}${order.reviewRating ? ` \xB7 ★${order.reviewRating}` : ""}${order.reviewBonusAt ? ` \xB7 бонус +${formatBalance(order.reviewBonusTokens ?? 0, parseStoredPlan(order.plan)?.billing)}` : ""}${order.deliveryError ? `<div class="muted">${esc(order.deliveryError)}</div>` : ""}</td>
      <td>${withActions ? order.status === "refunded" ? form("disable_key", { id: order.id }, "Отключить ключ", "danger") : `${form("retry", { id: order.id }, order.goods ? "Выдать снова" : "Выдать ключ")} ${form("manual", { id: order.id }, "Выдано вручную", "ghost")}` : ""}</td></tr>`;
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.shopName)} — ${currentView.nav}</title><script>${dashboardThemeInit}</script><style>${dashboardStyles}</style></head><body>
<aside class="sidebar"><a class="brand" href="/?view=overview"><span class="brand-mark">${icon("ai")}</span><span>ASTRA<small>Reseller console</small></span></a><div class="nav-caption">Рабочее пространство</div><nav aria-label="Разделы панели">${Object.entries(views).map(([id, v]) => `<a class="nav-link ${view === id ? "active" : ""}" href="/?view=${id}"${view === id ? ' aria-current="page"' : ""}>${icon(v.icon)}${v.nav}</a>`).join("")}</nav><div class="sidebar-bottom"><span class="dot${alive2 && status2?.state === "online" ? "" : " bad"}"></span>${alive2 && status2?.state === "online" ? "Бот подключён" : "Проверьте подключение"}<strong>${esc(config.shopName)}</strong>${esc(status2?.username ?? "FunPay не подключён")}<div style="margin-top:12px">Локальная панель \xB7 v${VERSION}</div></div></aside>
<div class="workspace"><header class="topbar"><div class="breadcrumb">Рабочее пространство <span>/ &nbsp; ${currentView.nav}</span></div><div class="topbar-meta"><button type="button" class="theme-toggle ghost" data-theme-toggle aria-label="Тёмная тема" aria-pressed="false" title="Включить тёмную тему"><svg class="theme-icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20.5 13.2A8.5 8.5 0 0 1 10.8 3.5a8.5 8.5 0 1 0 9.7 9.7Z"/></svg><svg class="theme-icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg><span data-theme-label>Тёмная тема</span></button><span class="version">v${VERSION}</span><span><span class="dot${alive2 && status2?.state === "online" ? "" : " bad"}"></span>${status2?.dryRun ? "Тестовый режим" : "FunPay"}</span><span class="avatar">${esc((status2?.username ?? config.shopName).slice(0, 2).toUpperCase())}</span></div></header><main>
<div class="page-heading"><div><div class="eyebrow">${esc(config.shopName)}</div><h1>${currentView.title}</h1><p class="subtitle">${currentView.subtitle}</p></div><a class="button ghost heading-action" href="https://funpay.com/users/${status2?.userId ?? ""}/" target="_blank" rel="noreferrer">Магазин на FunPay ${icon("arrow")}</a></div>
<div class="unsaved" role="status">Есть несохранённые изменения. Автообновление приостановлено.</div>
${url.searchParams.get("done") ? `<div class="flash">${esc(url.searchParams.get("done"))}</div>` : ""}
${view === "overview" ? `<div class="stats"><div class="stat"><div class="stat-label">Активные лоты ${icon("goods")}</div><div class="stat-value">${activeLots.toLocaleString("ru-RU")}</div><div class="stat-note">из ${lots2.length} под управлением бота</div></div><div class="stat"><div class="stat-label">API · токены ${icon("ai")}</div><div class="stat-value">${pool?.tokens !== void 0 ? formatTokens(pool.tokens) : "—"}</div><div class="stat-note">Доллары API: $${(pool?.usd ?? 0).toFixed(2)} \xB7 Steam: $${(pool?.steamUsd ?? 0).toFixed(2)} \xB7 SMM: $${(pool?.smmUsd ?? 0).toFixed(2)}</div></div><div class="stat"><div class="stat-label">Очередь публикаций ${icon("clock")}</div><div class="stat-value">${waiting}</div><div class="stat-note">${run.state === "posting" ? '<span class="ok">Выкладка идёт</span>' : run.state === "stopped" ? "Очередь остановлена" : "Нет активной выкладки"} \xB7 ${Math.round(run.postIntervalMs / 1e3)} с / лот</div></div><div class="stat"><div class="stat-label">Требуют внимания ${icon("orders")}</div><div class="stat-value">${attention.length + calls.length}</div><div class="stat-note">${attention.length} заказов \xB7 ${calls.length} вызовов продавца</div></div></div>
<div class="overview-grid"><div class="card"><div class="card-head"><h2>Очередь публикаций</h2><span class="badge ${run.state === "posting" ? "green" : ""}">${run.state === "posting" ? "В работе" : run.state === "stopped" ? "Остановлена" : waiting ? "Ожидает" : "Завершена"}</span></div><div class="queue-summary"><div><strong>${waiting}</strong> <span class="muted">лотов осталось</span></div><a href="/?view=ai" class="muted">Управлять лотами →</a></div><div class="progress"><span style="width:${progress}%"></span></div><div class="muted">Создано за всё время: ${completed} \xB7 отложено: ${run.parked.length} \xB7 проверка сохранения: ${run.blocked.length}</div><ul class="queue-list">${run.queue.slice(0, 3).map((item, index) => `<li><span class="queue-kind">${item.kind === "ai" ? "AI" : item.kind === "steam" ? "STM" : "SMM"}</span><span><strong>${esc(item.name)}</strong><small>${esc(item.marker)} \xB7 ${item.kind === "ai" ? "Токены" : item.kind === "steam" ? "Аренда аккаунта" : "SMM-услуги"}</small></span><span class="queue-index">0${index + 1}</span></li>`).join("") || '<li class="muted">Новых лотов в очереди нет</li>'}</ul><div class="selection-tools">${form("goods_stop", {}, "Остановить", "ghost")} ${form("goods_resume", {}, "Продолжить", "ghost")}</div>${run.cooldownUntil && run.cooldownUntil > now ? `<div class="notice">Пауза FunPay до ${formatMoscow(run.cooldownUntil)} МСК. Очередь сохранена.</div>` : ""}</div>
<div class="card"><div class="card-head"><h2>Автоматизация</h2><span class="badge ${alive2 && status2?.state === "online" ? "green" : "amber"}">${alive2 ? STATE_RU[status2.state] ?? status2.state : "Нет ответа"}</span></div>${toggles}<div class="notice green">AI-лоты публикуются только в \xABТокены\xBB. Адрес подключения покупатель получает после оплаты.</div></div></div>
<div class="card"><div class="card-head"><h3>Подключение и баланс</h3><span class="badge">${esc(status2?.username ?? "—")}</span></div><div class="grid"><div><div class="muted">Ваш пул токенов</div><p>${esc(poolDescription)}</p></div><div><div class="muted">ИИ-ассистент</div><p>${config.ai.key ? esc(config.ai.model) : "Выключен"}</p></div></div><div class="muted">Продажи проверены: ${status2?.lastOrderSyncAt ? formatMoscow(status2.lastOrderSyncAt) : "—"} МСК \xB7 ошибок за сутки: ${errorsSince(now - 864e5)}${status2?.lastRaiseAt ? ` \xB7 последнее поднятие: ${formatMoscow(status2.lastRaiseAt)}` : ""}</div>${status2?.lastError && status2.state !== "online" ? `<div class="notice bad">${esc(status2.lastError)}</div>` : ""}</div>` : ""}
${view === "overview" || view === "orders" ? `
<h2>Нужно внимание (${attention.length})</h2>
<div class="card">${attention.length ? `<table><tr><th>Заказ</th><th>Покупатель</th><th>Товар</th><th>Статус</th><th>Выдача</th><th></th></tr>${attention.map((order) => orderRow(order, true)).join("")}</table>` : '<span class="muted">Всё в порядке</span>'}</div>

<h2>Вызовы продавца (${calls.length})</h2>
<div class="card">${calls.length ? `<table><tr><th>Чат</th><th>Причина</th><th>Когда</th><th></th></tr>${calls.map((chat) => `<tr><td><a href="https://funpay.com/chat/?node=${chat.id}" target="_blank">${esc(chat.buyerName ?? chat.id)}</a></td><td>${esc(chat.sellerCallReason ?? "")}</td><td>${formatMoscow(chat.sellerCalledAt)}</td><td>${form("resume", { id: chat.id }, "Готово, вернуть бота")}</td></tr>`).join("")}</table>` : '<span class="muted">Никто не ждёт</span>'}</div>

` : ""}
${view === "ai" ? await aiSection(form) : ""}
${view === "goods" ? await goodsSection(form) : ""}
${view === "overview" || view === "orders" ? `

<h2>Последние заказы</h2>
<div class="card"><table><tr><th>Заказ</th><th>Покупатель</th><th>Товар</th><th>Статус</th><th>Выдача</th><th></th></tr>${orders.slice(0, view === "overview" ? 6 : 30).map((order) => orderRow(order, false)).join("")}</table></div>

` : ""}
${view === "activity" ? `<h2>Последние сообщения бота</h2>
<div class="card">${state.outbox.length ? state.outbox.slice(0, 10).map((entry) => `<div style="margin-bottom:10px"><div class="muted">${formatMoscow(entry.at)} \xB7 чат ${esc(entry.node)}${entry.dryRun ? " \xB7 тест" : ""}</div><pre>${esc(entry.text)}</pre></div>`).join("") : '<span class="muted">Пока ничего</span>'}</div>

<h2>Журнал ${onlyProblems ? '\xB7 <a href="/?view=activity">показать всё</a>' : '\xB7 <a href="/?view=activity&errors=1">только проблемы</a>'}</h2>
<div class="card"><table>${entries.map((entry) => `<tr><td class="muted" style="white-space:nowrap">${formatMoscow(entry.at)}</td><td class="lvl-${entry.level}">${esc(entry.message)}</td></tr>`).join("") || '<tr><td class="muted">Пусто</td></tr>'}</table></div>
` : ""}
<footer class="footer"><span>ASTRA \xB7 Панель реселлера</span><span>Обновление каждые 30 с \xB7 время МСК \xB7 v${VERSION}</span></footer></main></div><script>${dashboardScript}</script></body></html>`;
  }
  async function goodsSection(form) {
    const goods = bot.goods;
    const g = goods.summary();
    const st = goods.settings;
    const run = g.publisher;
    const RUN_RU = { idle: "не запускалась", ranking: "составляет очередь", posting: "выкладывает", done: "готово", stopped: "остановлена" };
    const rub = (value) => `${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
    const money = (m) => `<td>${m.count}</td><td>${rub(m.revenue)}</td><td>${rub(m.cost)}</td><td class="${m.profit >= 0 ? "ok" : "bad"}">${rub(m.profit)}</td>`;
    const wait = Math.max(run.cooldownUntil ?? 0, run.nextPostAt ?? 0);
    const errorGroups = /* @__PURE__ */ new Map();
    for (const entry of run.errors.slice(-100)) errorGroups.set(entry.error, (errorGroups.get(entry.error) ?? 0) + 1);
    const lotRows = g.lots.filter((lot) => lot.kind !== "ai").map((lot) => `<tr data-search><td>${lot.kind === "steam" ? "🎮" : "📣"} ${esc(lot.name)}${lot.hours ? `<div class="muted">${lot.hours} ч.</div>` : ""}</td><td class="muted">${esc(lot.marker)}</td>
      <td><a href="https://funpay.com/lots/offer?id=${esc(lot.lotId)}" target="_blank">#${esc(lot.lotId)}</a></td><td>${lot.price !== null ? rub(lot.price) : "—"}</td>
      <td><b class="${lot.active ? "ok" : "off"}">${lot.active ? "вкл" : "выкл"}</b>${lot.error ? `<div class="muted">${esc(lot.error)}</div>` : ""}</td><td>${form("goods_forget", { marker: lot.marker }, "Убрать", "ghost")}</td></tr>`).join("");
    const saleRows = g.orders.slice(0, 30).map((order) => {
      const cost = order.goodsCostRub ?? null;
      const revenue = order.status === "refunded" ? 0 : order.amountMinor / 100;
      return `<tr><td><a href="https://funpay.com/orders/${order.id}/" target="_blank">#${order.id}</a><div class="muted">${formatMoscow(order.orderedAt)}</div></td><td>${esc(order.buyerName)}</td>
        <td>${esc(goods.describe(order))}${order.deliveryError ? `<div class="muted">${esc(order.deliveryError)}</div>` : ""}</td><td>${STATUS_RU2[order.status] ?? order.status}</td>
        <td>${rub(revenue)}</td><td>${cost !== null ? rub(cost) : "—"}</td><td>${cost !== null ? `<span class="${revenue - cost >= 0 ? "ok" : "bad"}">${rub(revenue - cost)}</span>` : "—"}</td></tr>`;
    }).join("");
    const settingsForm = `<div class="card-title">Настройки каталога</div><form method="post" action="/action"><input type="hidden" name="token" value="${token}"><input type="hidden" name="view" value="goods"><input type="hidden" name="action" value="goods_settings">
      <div class="toggle"><label><input type="checkbox" name="steamEnabled" value="1"${st.steamEnabled ? " checked" : ""}> Аренда Steam</label> <label>наценка <input name="steamMarkupPercent" value="${st.steamMarkupPercent}" size="4">%</label> <label>игр в топе <input name="steamTopGames" value="${st.steamTopGames}" size="4"></label></div>
      <div class="toggle"><label><input type="checkbox" name="smmEnabled" value="1"${st.smmEnabled ? " checked" : ""}> SMM-услуги</label> <label>наценка <input name="smmMarkupPercent" value="${st.smmMarkupPercent}" size="4">%</label></div>
      <div class="notice">Цена = закупка + наценка. Минимум аренды Steam — 1 ₽. Аренда, продление и бонусы оплачиваются только с отдельного баланса Steam; при $0 лоты выключаются. При снижении закупочной цены лот не дешевеет.</div><button>Сохранить настройки</button></form>`;
    return `<h2>Steam и SMM</h2>
<div class="grid"><div class="card">${g.problem ? `<div class="bad">${esc(g.problem)}</div>` : ""}${settingsForm}
<div class="muted" style="margin-top:8px">Баланс Steam: ${g.pool ? `$${g.pool.steamUsd.toFixed(2)}` : "—"} \xB7 SMM: ${g.pool ? `$${g.pool.smmUsd.toFixed(2)}` : "—"} \xB7 AI $: ${g.pool ? `$${g.pool.usd.toFixed(2)}${g.rate ? `${" "}≈ ${rub(g.pool.usd * g.rate)}` : ""}` : "—"} \xB7 лотов включено ${g.lotsOn} из ${g.lots.length}${g.errors ? `${" "}\xB7 с ошибкой ${g.errors}` : ""} \xB7 тексты лотов: lot-templates.json</div></div>
<div class="card"><b>Выкладка: ${RUN_RU[run.state] ?? run.state}</b> \xB7 в очереди ${run.queue.length} \xB7 выложено ${run.posted}${run.blocked.length ? `${" "}\xB7 ждут проверки ${run.blocked.length}` : ""}${run.parked.length ? `${" "}\xB7 отложено (раздел заполнен) ${run.parked.length}` : ""}
${wait > Date.now() ? `<div class="muted">Следующий лот не раньше ${formatMoscow(wait)} МСК \xB7 интервал ${Math.round(run.postIntervalMs / 1e3)} с</div>` : ""}${run.note ? `<div class="muted">${esc(run.note)}</div>` : ""}
<div style="margin-top:8px">${form("goods_publish_steam", {}, `Выложить топ-${st.steamTopGames} Steam`)} ${form("goods_publish_smm", {}, "Выложить SMM")} ${form("goods_resume", {}, "Продолжить", "ghost")} ${form("goods_stop", {}, "Остановить", "ghost")} ${form("goods_clear", {}, "Очистить очередь", "danger")}</div>
${errorGroups.size ? `<div style="margin-top:8px">${[...errorGroups].slice(0, 8).map(([error, count2]) => `<div class="lvl-warn">${count2 > 1 ? `${count2} \xD7 ${" "}` : ""}${esc(error)}</div>`).join("")}</div>` : ""}</div></div>
<div class="card"><table><tr><th>Период</th><th colspan="4">Steam: продаж \xB7 выручка \xB7 закупка \xB7 прибыль</th><th colspan="4">SMM: продаж \xB7 выручка \xB7 закупка \xB7 прибыль</th></tr>
${g.periods.map((p) => `<tr><td>${p.label}</td>${money(p.steam)}${money(p.smm)}</tr>`).join("")}</table><div class="muted">Выручка — сумма заказов FunPay (до комиссии FunPay при выводе), закупка — что списано с пула $ по курсу сервиса.</div></div>
<div class="card"><table><tr><th>Заказ</th><th>Покупатель</th><th>Что</th><th>Статус</th><th>Выручка</th><th>Закупка</th><th>Прибыль</th></tr>${saleRows || '<tr><td class="muted">Продаж Steam и SMM пока нет</td></tr>'}</table></div>
<h2>Ваши лоты \xB7 Steam и SMM</h2><div class="card"><div class="section-toolbar"><input type="search" data-filter="goods-lots" placeholder="Поиск по названию или маркеру" aria-label="Поиск лотов Steam и SMM"><span class="muted">${g.lots.filter((l) => l.kind !== "ai").length} лотов</span></div><div class="table-wrap"><table id="goods-lots"><tr><th>Лот</th><th>Маркер</th><th>FunPay</th><th>Цена</th><th>Сейчас</th><th></th></tr>${lotRows || '<tr><td class="muted">Лотов пока нет — нажмите \xABВыложить…\xBB</td></tr>'}</table></div></div>`;
  }
  async function aiSection(form) {
    const ai = bot.goods.ai, settings = ai.settings;
    let preview = [], problem = "";
    try {
      preview = await ai.preview();
    } catch {
      problem = "Каталог AI или тарифы недоступны. Проверьте ключ разработчика и повторите позже.";
    }
    const categories = AI_CATEGORIES.map((c) => c.node === null ? `<div class="muted">${esc(c.name)} — раздела \xABТокены\xBB нет, выкладка отключена</div>` : `<label style="display:block"><input type="checkbox" name="categories" value="${c.id}"${settings.categories.includes(c.id) ? " checked" : ""}> <a href="https://funpay.com/lots/${c.node}/" target="_blank">${esc(c.name)}</a> \xB7 ${c.node}</label>`).join("");
    const rows = preview.map((item) => {
      const posted = store.state.goods.lots[item.marker];
      const texts = aiLotTexts(item.ai, item.marker);
      const queued = store.state.goods.publisher.queue.some((i) => i.marker === item.marker) || store.state.goods.publisher.pending?.marker === item.marker;
      return `<tr data-search><td><input type="checkbox" name="markers" aria-label="Выбрать ${esc(item.name)}" value="${esc(item.marker)}"${posted || queued ? " disabled" : " checked"}></td><td>${esc(item.name)}<div class="muted">${esc(item.marker)} \xB7 раздел ${item.node}</div><details><summary>Название и описание</summary><pre>${esc(texts.ru.title)}

${esc(texts.ru.description)}</pre></details></td><td>${aiPrice(item.ai, settings).toFixed(2)} ₽</td><td>${posted ? `<a href="https://funpay.com/lots/offer?id=${esc(posted.lotId)}" target="_blank">#${esc(posted.lotId)}</a> \xB7 ${posted.active ? '<span class="ok">в продаже</span>' : "выключен"}${posted.error ? `<div class="bad">${esc(posted.error)}</div>` : ""}` : queued ? '<span class="badge green">В очереди</span>' : '<span class="muted">Не выложен</span>'}</td></tr>`;
    }).join("");
    return `<div class="card"><div class="card-head"><h3>Цены и пакеты</h3><span class="badge ${settings.enabled ? "green" : ""}">${settings.enabled ? "Публикация включена" : "Публикация выключена"}</span></div><form method="post" action="/action"><input type="hidden" name="token" value="${token}"><input type="hidden" name="action" value="ai_settings"><input type="hidden" name="view" value="ai">
<label><input type="checkbox" name="enabled" value="1"${settings.enabled ? " checked" : ""}> Включить лоты AI</label>
<div class="grid"><div><p><label>Цена продажи за $1 баланса: <input name="rubPerDollar" type="number" step="0.01" min="0" value="${settings.rubPerDollar}"> ₽</label></p><p><label>Индивидуальные цены ($пакет=₽): <input name="dollarPrices" value="${esc(Object.entries(settings.dollarPrices ?? {}).map(([pack, price]) => `${pack}=${price}`).join(", "))}" placeholder="0.5=1" style="width:95%"></label></p><p><label>Цена за 1M токенов: <input name="rubPerMillion" type="number" step="0.01" min="0" value="${settings.rubPerMillion}"> ₽</label></p><div class="muted">0 отключает соответствующий вид пакетов. Цены задаёте вы; проверьте закупку и комиссии до выкладки.</div><p><label>Пакеты $ (через запятую): <input name="dollars" value="${settings.dollars.join(", ")}" style="width:95%"></label></p><p><label>Пакеты M токенов: <input name="millions" value="${settings.millions.join(", ")}" style="width:95%"></label></p></div><div>${categories}</div></div><button>Сохранить и обновить предпросмотр</button></form></div>
<div class="card"><div class="notice green">AI публикуется только в \xABТокены\xBB, без запасной выкладки в \xABУслуги\xBB или другие разделы. Адрес API бот пришлёт вместе с ключом после оплаты. OpenCode → Токены: новый раздел 4752.</div>${problem ? `<p class="bad">${esc(problem)}</p>` : ""}<form method="post" action="/action"><input type="hidden" name="token" value="${token}"><input type="hidden" name="action" value="ai_publish"><input type="hidden" name="view" value="ai"><div class="section-toolbar"><input type="search" data-filter="ai-lots" placeholder="Поиск по модели или пакету" aria-label="Поиск AI-лотов"><span class="muted" data-selection></span></div><div class="selection-tools"><button type="button" class="ghost" data-select="all">Выбрать все</button><button type="button" class="ghost" data-select="none">Снять выбор</button><span class="muted">Уже добавленные лоты не дублируются</span></div><div class="table-wrap"><table id="ai-lots"><tr><th></th><th>Пакет и предпросмотр</th><th>Цена</th><th>FunPay</th></tr>${rows || '<tr><td colspan="4">Задайте цены и размеры пакетов, затем сохраните настройки.</td></tr>'}</table></div><p><button${!settings.enabled || !preview.length ? " disabled" : ""}>Выложить выбранные AI-лоты</button></p></form><div class="muted">Общая очередь со Steam и SMM, один новый лот в минуту. Остановка и продолжение — ниже.</div>${form("goods_stop", {}, "Остановить очередь", "ghost")} ${form("goods_resume", {}, "Продолжить очередь", "ghost")}</div>`;
  }
  async function action(fields) {
    const id = fields.get("id") ?? "";
    switch (fields.get("action")) {
      case "ai_settings": {
        const packs = (name) => (fields.get(name) ?? "").split(/[,;\s]+/).filter(Boolean).map(Number);
        const dollarPrices = Object.fromEntries((fields.get("dollarPrices") ?? "").split(/[,;\s]+/).filter(Boolean).map((pair) => {
          const [pack, price, extra] = pair.split("=");
          return [String(Number(pack)), extra === void 0 && price !== void 0 ? Number(price) : NaN];
        }));
        return bot.goods.ai.setSettings({ dollarPrices, enabled: fields.get("enabled") === "1", rubPerDollar: Number(fields.get("rubPerDollar")), rubPerMillion: Number(fields.get("rubPerMillion")), dollars: packs("dollars"), millions: packs("millions"), categories: fields.getAll("categories") });
      }
      case "ai_publish":
        return bot.goods.ai.queue(bot.goods.publisher, fields.getAll("markers"));
      case "goods_settings":
        return bot.goods.setSettings({
          steamEnabled: fields.get("steamEnabled") === "1",
          smmEnabled: fields.get("smmEnabled") === "1",
          steamMarkupPercent: Number(fields.get("steamMarkupPercent")),
          smmMarkupPercent: Number(fields.get("smmMarkupPercent")),
          steamTopGames: Number(fields.get("steamTopGames"))
        });
      case "goods_publish_steam":
        return bot.goods.queueTopSteam(bot.goods.settings.steamTopGames);
      case "goods_publish_smm":
        return bot.goods.queueSmm();
      case "goods_stop":
        bot.goods.publisher.stop();
        return "Выкладка остановлена";
      case "goods_resume":
        bot.goods.publisher.resume();
        return "Выкладка продолжается";
      case "goods_clear":
        bot.goods.publisher.clear();
        return "Очередь очищена (лоты на FunPay не тронуты)";
      case "goods_forget":
        return bot.goods.forgetLot(fields.get("marker") ?? "");
      case "toggle": {
        const name = fields.get("name");
        if (!(name in TOGGLE_RU)) return "Неизвестный переключатель";
        bot.setToggle(name, fields.get("value") === "1");
        return `\xAB${TOGGLE_RU[name]}\xBB: ${fields.get("value") === "1" ? "включено" : "выключено"}`;
      }
      case "retry":
        return bot.retryDelivery(id);
      case "manual":
        return bot.markManual(id);
      case "resume":
        return bot.resumeChat(id);
      case "disable_key":
        return bot.disableOrderKey(id).catch((error) => `Не получилось: ${error instanceof Error ? error.message : String(error)}`);
      default:
        return "Неизвестное действие";
    }
  }
  const server = createServer(async (request, response) => {
    try {
      const nonce=randomBytes(18).toString("base64");
      securityHeaders(response,nonce);
      if (!authorizeLocal(request,hosts)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (request.method === "POST" && url.pathname === "/action") {
        if (!String(request.headers["content-type"]??"").startsWith("application/x-www-form-urlencoded")) { response.writeHead(415).end("Unsupported content type"); return; }
        const body = await boundedBody(request);
        const fields = new URLSearchParams(body);
        if (!safeEqual(fields.get("token") ?? "", token)) {
          response.writeHead(403).end("Страница устарела — обновите её и нажмите снова");
          return;
        }
        const done = await extension?.action(fields) ?? await action(fields);
        if(done && typeof done === "object" && typeof done.render === "string"){response.writeHead(200,{"content-type":"text/html; charset=utf-8"}).end(done.render);return;}
        if (done && typeof done === "object" && typeof done.redirect === "string") {
          const target=new URL(done.redirect);
          if(target.protocol!=="https:"||target.hostname!=="t.me"||target.pathname!=="/neva_glamur67") throw new Error("Invalid support link");
          response.writeHead(303,{location:target.href}).end();return;
        }
        const view = fields.get("view") ?? "overview";
        const back = ["overview", "ai", "goods", "orders", "activity", "balance", "setup", "updates", "keys", "usage"].includes(view) ? view : "overview";
        response.writeHead(303, { location: `/?view=${back}&done=${encodeURIComponent(done)}` }).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        let html=await page(url);
        if(extension)html=await extension.render({html,url,token});
        html=html.replace(/<script>/g,`<script nonce="${nonce}">`);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
        return;
      }
      response.writeHead(404).end("Not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`Ошибка панели: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=64;
  server.on("error", (error) => console.error(`Панель не запустилась на порту ${config.dashboardPort}: ${error.message}`));
  server.listen(config.dashboardPort, "127.0.0.1", () => console.log(`Панель бота: http://127.0.0.1:${config.dashboardPort}`));
  return server;
}
function readBody(request) { return boundedBody(request); }
function esc(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}


// src/proxy.ts

var FUNPAY_DOMAINS = ["funpay.com", "sfunpay.com"];
function isFunPayUrl(url, extraHosts = []) {
  const host = url.hostname.toLowerCase();
  return FUNPAY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`)) || extraHosts.includes(url.host);
}
function routeFunPayThroughProxy(proxyUrl, extraHosts = []) {
  const agent = new import_undici.ProxyAgent(proxyUrl);
  const direct = globalThis.fetch.bind(globalThis);
  const routed = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!isFunPayUrl(url, extraHosts)) return direct(input, init);
    return (0, import_undici.fetch)(input, { ...init, dispatcher: agent });
  };
  globalThis.fetch = routed;
}
function validProxyUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname) && Boolean(url.port || url.protocol === "https:");
  } catch {
    return false;
  }
}


// src/setup.ts
import { connect } from "node:net";
import { createInterface } from "node:readline";
var DEFAULT_AI_TOKENS = 1e7;
function asker() {
  const terminal = Boolean(process.stdin.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal });
  let muted = false;
  const output = rl;
  const write = output._writeToOutput.bind(rl);
  output._writeToOutput = (text) => {
    if (!muted || text.includes("\n") || text.startsWith("\x1B")) write(text);
    else write("*".repeat(text.length));
  };
  const queued = [];
  let waiting = null;
  rl.on("line", (answer) => {
    if (!waiting) return void queued.push(answer.trim());
    const resolve = waiting;
    waiting = null;
    muted = false;
    if (!terminal) process.stdout.write("\n");
    resolve(answer.trim());
  });
  rl.on("close", () => {
    if (!waiting) return;
    process.stdout.write("\nВвод закрыт — настройка не завершена. Запустите \xABbash start.sh setup\xBB ещё раз.\n");
    process.exit(1);
  });
  const ask = (question, options = {}) => {
    process.stdout.write(question);
    if (queued.length) {
      process.stdout.write(options.hidden ? "***\n" : `${queued[0]}
`);
      return Promise.resolve(queued.shift());
    }
    muted = Boolean(options.hidden);
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };
  return { ask, close: () => rl.close() };
}
var line = (text = "") => console.log(text);
async function runSetup() {
  const previous = readConfig();
  const { ask, close } = asker();
  try {
    line();
    line("══════════════════════════════════════════════");
    line("   FunPay-бот — настройка");
    line("══════════════════════════════════════════════");
    line(previous ? "Enter — оставить текущее значение." : "Пять коротких шагов. Всё хранится только на этом компьютере.");
    let funpayProxy = previous?.funpayProxy;
    const localProxy = await portOpen(LOCAL_FUNPAY_PROXY);
    if (funpayProxy || localProxy) {
      const offered = funpayProxy ?? LOCAL_FUNPAY_PROXY;
      line();
      line("Прокси для FunPay");
      if (localProxy && !funpayProxy) line(`  На этом компьютере работает прокси для FunPay (${offered}) — бот может ходить на FunPay только через него.`);
      for (; ; ) {
        const answer = await ask(`  Подключать FunPay через прокси ${offered}? (Enter — да, \xABнет\xBB — напрямую, или свой адрес http://…): `);
        if (!answer) funpayProxy = offered;
        else if (/^(н|n)/i.test(answer)) funpayProxy = void 0;
        else if (validProxyUrl(answer)) funpayProxy = answer;
        else {
          line("  Нужен адрес вида http://127.0.0.1:10820");
          continue;
        }
        break;
      }
    }
    if (funpayProxy) routeFunPayThroughProxy(funpayProxy, previous?.funpayBaseUrl ? [new URL(previous.funpayBaseUrl).host] : []);
    line();
    line("Шаг 1/5 \xB7 golden_key от FunPay");
    line("  Как получить: войдите на funpay.com в браузере → F12 (Mac: Cmd+Option+I) →");
    line("  вкладка Application (Safari: Хранилище) → Cookies → https://funpay.com → строка golden_key → скопируйте значение.");
    line("  Никому его не показывайте: он даёт полный доступ к аккаунту FunPay.");
    let goldenKey = "";
    let funpayUser = "";
    for (; ; ) {
      const answer = await ask(previous ? "  golden_key (Enter — прежний): " : "  golden_key: ", { hidden: true });
      goldenKey = answer || previous?.goldenKey || "";
      if (!goldenKey) continue;
      process.stdout.write("  Проверяю вход в FunPay… ");
      try {
        const client = new FunPayClient({ goldenKey, baseUrl: previous?.funpayBaseUrl });
        await client.login();
        funpayUser = client.username ?? "";
        line(`✔ вход выполнен: ${funpayUser} (#${client.userId})`);
        break;
      } catch (error) {
        line(`✖ ${errorText(error)}`);
        line("  Проверьте, что скопировали значение golden_key целиком, и попробуйте ещё раз.");
      }
    }
    const apiBase = previous?.apiBase ?? DEFAULT_API_BASE;
    line();
    line("Шаг 2/5 \xB7 ключ API разработчика (из него бот создаёт ключи покупателям)");
    line(`  Откройте ${apiBase}/seller → \xABAPI для разработчиков\xBB → \xABСоздать ключ\xBB и скопируйте ключ sk-dev-…`);
    let devKey = "";
    let api;
    let resellerName = "";
    for (; ; ) {
      const answer = await ask(previous ? "  Ключ sk-dev-… (Enter — прежний): " : "  Ключ sk-dev-…: ", { hidden: true });
      devKey = answer || previous?.devKey || "";
      if (!devKey) continue;
      api = new ResellerApi(apiBase, devKey);
      process.stdout.write("  Проверяю ключ… ");
      try {
        const me = await api.me();
        resellerName = me.reseller.name;
        line(`✔ кабинет \xAB${me.reseller.name}\xBB, в пуле ${formatTokens(me.pool.balance)} токенов`);
        break;
      } catch (error) {
        line(`✖ ${error instanceof ApiRefused ? error.reason : errorText(error)}`);
      }
    }
    line();
    line("Шаг 3/5 \xB7 название магазина — его видят покупатели в каждом сообщении бота");
    const defaultName = previous?.shopName ?? (resellerName || funpayUser || "Магазин API");
    const shopName = (await ask(`  Название (Enter — \xAB${defaultName}\xBB): `) || defaultName).slice(0, 40);
    line();
    line("Шаг 4/5 \xB7 ИИ-ассистент — отвечает покупателям в чате и помогает подключить ключ");
    line(`  1 — создать для него ключ из вашего пула (${formatTokens(DEFAULT_AI_TOKENS)} токенов ≈ 700 ответов)`);
    line("  2 — у меня уже есть ключ sk-ag-… с моделями Gemini");
    line("  3 — без ИИ: только выдача ключей, бонусы и команды");
    if (previous?.ai.key) line("  Enter — оставить текущий ключ ассистента");
    let ai = previous?.ai ?? { key: null, keyId: null, model: DEFAULT_MODEL };
    for (; ; ) {
      const choice = await ask("  Выбор: ");
      if (!choice && previous?.ai.key) break;
      if (choice === "3") {
        ai = { key: null, keyId: null, model: DEFAULT_MODEL };
        break;
      }
      if (choice === "2") {
        const key = await ask("  Ключ sk-ag-…: ", { hidden: true });
        if (!await checkAiKey(apiBase, key)) continue;
        ai = { key, keyId: null, model: DEFAULT_MODEL };
        break;
      }
      if (choice === "1" || !choice && !previous?.ai.key) {
        const amount = await ask(`  Сколько токенов (Enter — ${formatTokens(DEFAULT_AI_TOKENS)}): `);
        const tokens = amount ? Math.round(Number(amount.replace(/[^\d.]/g, "")) * (/[mм]/i.test(amount) ? 1e6 : 1)) : DEFAULT_AI_TOKENS;
        if (!Number.isSafeInteger(tokens) || tokens < 1e5) {
          line("  Нужно не меньше 100 000 токенов, например 10M.");
          continue;
        }
        try {
          const created = await api.createKey({ name: "Ассистент FunPay-бота", group: "gemini", tokens, note: "ИИ-ответы FunPay-бота" }, `fp-ai-${Date.now()}`);
          ai = { key: created.secret, keyId: created.key.id, model: DEFAULT_MODEL };
          line(`  ✔ создан ключ ассистента #${created.key.id} на ${formatTokens(tokens)} токенов`);
          break;
        } catch (error) {
          line(`  ✖ ${error instanceof ApiRefused ? error.reason : errorText(error)}`);
          continue;
        }
      }
    }
    line();
    line("Шаг 5/5 \xB7 режим");
    line("  1 — боевой: бот выдаёт ключи и отвечает покупателям");
    line("  2 — тестовый: только читает и пишет в журнал, что сделал бы (ничего не отправляет)");
    const mode = await ask(`  Выбор (Enter — ${previous?.dryRun ? "2" : "1"}): `);
    const dryRun = mode ? mode === "2" : previous?.dryRun === true;
    const config = {
      goldenKey,
      devKey,
      apiBase,
      shopName,
      ai,
      dryRun,
      dashboardPort: previous?.dashboardPort ?? DEFAULT_DASHBOARD_PORT,
      pollMs: previous?.pollMs ?? 5e3,
      topUpKeys: previous?.topUpKeys ?? true,
      catchUpMinutes: previous?.catchUpMinutes ?? 30,
      sellerTakeoverMinutes: previous?.sellerTakeoverMinutes ?? 30,
      ...funpayProxy ? { funpayProxy } : {},
      ...previous?.funpayBaseUrl ? { funpayBaseUrl: previous.funpayBaseUrl } : {}
    };
    writeConfig(config);
    line();
    line(`✔ Готово. Магазин \xAB${shopName}\xBB, ${dryRun ? "тестовый режим" : "боевой режим"}, ИИ ${ai.key ? "включён" : "выключен"}.`);
    line("  Заказы, которые уже были на FunPay до первого запуска, бот не трогает — он работает только с новыми.");
    return config;
  } finally {
    close();
  }
}
function portOpen(proxyUrl) {
  const url = new URL(proxyUrl);
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) || 80 });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(800, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
async function checkAiKey(apiBase, key) {
  if (!key.startsWith("sk-")) {
    line("  ✖ это не ключ sk-ag-…");
    return false;
  }
  try {
    const response = await fetch(`${apiBase}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2e4) });
    if (!response.ok) {
      line(`  ✖ ключ не подошёл (HTTP ${response.status})`);
      return false;
    }
    const models = (await response.json().catch(() => null))?.data?.map((model) => model.id) ?? [];
    if (!models.some((id) => id.startsWith("gemini"))) {
      line("  ✖ у этого ключа нет моделей Gemini — ассистенту нужен ключ Gemini (или \xABвсе модели\xBB)");
      return false;
    }
    line("  ✔ ключ работает");
    return true;
  } catch (error) {
    line(`  ✖ не удалось проверить ключ: ${errorText(error)}`);
    return false;
  }
}


// src/main.ts
var LOCK_FILE = join2(DATA_DIR, "bot.lock");
async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22) {
    console.error(`Нужен Node.js 22 или новее (сейчас ${process.versions.node}). Запустите \xABbash start.sh\xBB — он поставит нужную версию.`);
    process.exit(1);
  }
  const command = process.argv[2] ?? "run";
  if (command === "version") return console.log(VERSION);
  if (command === "setup") {
    await runSetup();
    return;
  }
  if (command === "status") return status();
  if (command === "templates") {
    const names = Object.keys(DEFAULT_TEMPLATES);
    return console.log(JSON.stringify(Object.fromEntries(names.map((name) => [name, rawTemplate(name)])), null, 2));
  }
  if (command !== "run") {
    console.error(`Неизвестная команда \xAB${command}\xBB. Есть: run, setup, status, templates.`);
    process.exit(1);
  }
  let config = readConfig();
  if (!config) {
    if (!process.stdin.isTTY) {
      console.error(`Бот не настроен (нет ${CONFIG_FILE}). Запустите в Терминале: bash start.sh`);
      await new Promise((resolve) => setTimeout(resolve, 6e4));
      process.exit(1);
    }
    config = await runSetup();
  }
  if (!existsSync5(KNOWLEDGE_FILE)) console.warn(`Нет файла ${KNOWLEDGE_FILE} — ИИ будет отвечать без базы знаний.`);
  takeLock();
  if (config.funpayProxy) {
    routeFunPayThroughProxy(config.funpayProxy, config.funpayBaseUrl ? [new URL(config.funpayBaseUrl).host] : []);
    console.log(`FunPay — только через прокси ${config.funpayProxy} (без прямого подключения)`);
  }
  const store = new Store(STATE_FILE);
  const api = new ResellerApi(config.apiBase, config.devKey);
  const bot = new ResellerBot(config, store, api);
  let stopping=false;
  const stop = async (signal) => {
    if(stopping)return;stopping=true;
    console.log(`Остановка (${signal})…`);
    bot.stop();
    await activeDashboardExtension?.drain?.();
    await Promise.race([Promise.allSettled([bot.chatWork,bot.sendChain]),new Promise(resolve=>setTimeout(resolve,10000))]);
    store.saveNow();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("unhandledRejection", (error) => logError("bot.crash", `Необработанная ошибка: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  startDashboard(config, store, bot, api);
  await bot.run();
}
function takeLock() {
  mkdirSync3(DATA_DIR, { recursive: true, mode: 0o700 });
  const gate=LOCK_FILE+".recover";
  let gateFd;
  try{gateFd=openSync(gate,"wx",0o600);}catch{throw new Error("Другой процесс запускает бот. Повторите через несколько секунд.");}
  try{
    if(existsSync5(LOCK_FILE)){
      const pid=Number(readFileSync6(LOCK_FILE,"utf8"));
      if(Number.isInteger(pid)&&pid!==process.pid&&alive(pid))throw new Error("Бот уже запущен. Второй процесс не запускается.");
      rmSync(LOCK_FILE);
    }
    const fd=openSync(LOCK_FILE,"wx",0o600);
    try{writeFileSync3(fd,String(process.pid));}finally{closeSync(fd);}
  }finally{closeSync(gateFd);rmSync(gate);}
}
function releaseLock() {
  try {
    if (Number(readFileSync6(LOCK_FILE, "utf8")) === process.pid) rmSync(LOCK_FILE);
  } catch {
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function status() {
  const config = readConfig();
  if (!config) return console.log("Бот не настроен. Запустите: bash start.sh");
  const store = new Store(STATE_FILE);
  const state = store.state;
  const heartbeat = state.status?.heartbeatAt ?? 0;
  const running = Date.now() - heartbeat < 9e4;
  const orders = Object.values(state.orders);
  const attention = orders.filter((order) => order.status === "paid" && ["stale", "failed"].includes(order.delivery));
  const calls = Object.values(state.chats).filter((chat) => chat.sellerCalledAt);
  console.log(`Магазин: ${config.shopName}${config.dryRun ? " (тестовый режим)" : ""}`);
  console.log(`Бот: ${running ? `работает (FunPay: ${state.status?.username ?? "—"})` : heartbeat ? `не отвечает с ${formatMoscow(heartbeat)} МСК` : "ещё не запускался"}`);
  try {
    const me = await new ResellerApi(config.apiBase, config.devKey).me();
    console.log(`Пул: ${formatTokens(me.pool.balance)} токенов`);
  } catch (error) {
    console.log(`Пул: сервис ключей не ответил (${error instanceof Error ? error.message : String(error)})`);
  }
  console.log(`Заказов в памяти: ${orders.length}; выдано ботом: ${orders.filter((order) => order.delivery === "delivered").length}`);
  console.log(`Нужно внимание: ${attention.length}${attention.length ? ` (${attention.map((order) => `#${order.id}`).join(", ")})` : ""}`);
  console.log(`Вызовы продавца: ${calls.length}`);
  console.log(`Ошибок за сутки: ${errorsSince(Date.now() - 864e5)}`);
  console.log(`Панель: http://127.0.0.1:${config.dashboardPort}`);
}
export { releaseLock, setDashboardExtension, main, readConfig, writeConfig, ResellerApi, ApiRefused, FunPayClient, ResellerBot, Store, startDashboard, detectLot, grantFor, aiLotTexts, aiQueue, aiPrice, AI_CATEGORIES, DATA_DIR, BOT_DIR, CONFIG_FILE, STATE_FILE, KNOWLEDGE_FILE, TEMPLATES_FILE, VERSION, rawTemplate, DEFAULT_TEMPLATES, routeFunPayThroughProxy, parse, steamLotFields, logInfo, logWarn, logError, errorsSince, recentEntries, formatTokens, formatDollars, esc, readBody };
