'use strict';

/**
 * Patch for the zalo-connect channel plugin, applied by Setup to native projects right before every
 * gateway (re)start (local-server patchNativeZaloConnect). Pure string transform - no I/O here.
 *
 * Measured on a customer's Windows 10 host, 17/10/2026:
 *  1. Photo bursts -> one agent turn. Zalo delivers every photo of a multi-photo send as its own
 *     message and zalo-connect's per-thread queue hands them to the agent one by one: 11 photos = 11
 *     replies (OpenClaw's inbound debounce skips media). The queue also keeps only 10 waiting
 *     messages and silently drops the oldest. Media-only messages from one sender in one thread are
 *     now held until that sender pauses QUIET_MS and routed as ONE message carrying every attachment;
 *     a text from that sender inside the window joins the batch as its request.
 *  2. The last batch that went out without a request is re-attached to the sender's next message
 *     that addresses the bot (DM: next message; group: next @mention) within LINGER_MS. In a group the
 *     photos alone never reach the agent, so "@Jarvis xuất excel" arrived with no photos and the bot
 *     re-sent an old file.
 *  3. Windows file paths: isLocalFilePath() only knew "/", "./", "../", so "C:\\...\\file.xlsx" went out
 *     as a LINK (api.sendLink), Zalo dropped it, and the reply text riding as its caption vanished
 *     too - silently. Drive-letter paths are local files now, and a local mediaUrl is uploaded.
 *  4. Reply sends no longer fail silently: a failed send is logged and retried once without
 *     quote/mention.
 *
 * zalo-connect is installed as "latest", so the anchors are matched EXACTLY and all-or-nothing: a
 * build that does not contain every anchor once is left untouched ("incompatible").
 *
 * v3: "addressed" follows the plugin's own rule (DM, @mention OR the bot's name in a group) and is
 * never true while an ask_user question is pending - appending "[Kèm lại N ảnh]" to the answer "1"
 * stopped it matching the options. A group text that does not address the bot no longer uses up the
 * batch. Expired batches are pruned, deliberately suppressed text is not "retried", and every name
 * the injected code relies on must be present (REQUIRED) or nothing is patched.
 */
const QUIET_MS = 8000;      // longest gap seen inside one send was 5.8 s
const MAX_MS = 90000;       // never hold a burst longer than this
const LINGER_MS = 600000;   // re-attach window for the follow-up request (10 min)
const MARKER = '[openclaw-setup local patch: media-burst v3]';
const ANY_MARKER = /\[openclaw-setup local patch: media-burst v\d+\]/;

const FN_SOURCE = `// ${MARKER} Batch a burst of photos from one sender into one agent turn.
function createZaloMediaBurstRouter(routeNow, { quietMs = ${QUIET_MS}, maxMs = ${MAX_MS}, lingerMs = ${LINGER_MS}, isAddressed = () => true } = {}) {
  const bursts = new Map();
  const recent = new Map();
  const isMediaOnly = (c) => Array.isArray(c?.mediaUrls) && c.mediaUrls.length > 0 && !c.quote && /^\\s*(\\[Media( attachment)?\\])?\\s*$/.test(String(c.content ?? ""));
  const keyOf = (c) => \`\${c.threadId}|\${c.metadata?.fromId ?? ""}\`;
  const urlsOf = (items) => items.flatMap((c) => c.mediaUrls);
  const typesOf = (items) => items.flatMap((c) => c.mediaUrls.map((_, i) => c.mediaTypes?.[i] ?? "image/jpeg"));
  const safeRoute = (m) => {
    try { return routeNow(m); } catch (err) { console.error(\`[zalo-connect] media-burst route failed: \${String(err)}\`); }
  };
  const addressedBy = (c) => { try { return !!isAddressed(c); } catch { return false; } };
  const remember = (key, items) => {
    const now = Date.now();
    for (const [k, v] of recent) if (now - v.at > lingerMs) recent.delete(k);
    recent.set(key, { items, at: now });
  };
  const flush = (key, extra) => {
    const b = bursts.get(key);
    if (!b) return;
    bursts.delete(key);
    clearTimeout(b.timer);
    const items = extra?.mediaUrls?.length ? [...b.items, extra] : b.items;
    const base = extra ?? b.items[b.items.length - 1];
    const count = urlsOf(items).length;
    const caption = extra && !isMediaOnly(extra) ? String(extra.content ?? "").trim() : "";
    // A request the agent answers uses the batch up. One it does not (a group text with no mention)
    // only becomes passive context, text only - keep the photos for the sender's next @mention.
    if (caption && addressedBy(extra)) recent.delete(key);
    else remember(key, items);
    safeRoute({
      ...base,
      mediaUrls: urlsOf(items),
      mediaTypes: typesOf(items),
      content: caption || (count > 1 ? \`[\${count} ảnh/tệp gửi liên tiếp, không kèm lời nhắn]\` : base.content)
    });
  };
  return (c) => {
    if (!c || !c.threadId) return routeNow(c);
    const key = keyOf(c);
    if (isMediaOnly(c)) {
      let b = bursts.get(key);
      if (!b) {
        b = { items: [], startedAt: Date.now(), timer: null };
        bursts.set(key, b);
      }
      b.items.push(c);
      clearTimeout(b.timer);
      const wait = Math.max(0, Math.min(quietMs, b.startedAt + maxMs - Date.now()));
      b.timer = setTimeout(() => flush(key), wait);
      return;
    }
    if (bursts.has(key)) {
      if (c.quote) {
        flush(key);
        return routeNow(c);
      }
      return flush(key, c);
    }
    const prev = recent.get(key);
    if (prev && !(c.mediaUrls?.length)) {
      if (Date.now() - prev.at > lingerMs) {
        recent.delete(key);
      } else {
        if (addressedBy(c)) {
          recent.delete(key);
          const n = urlsOf(prev.items).length;
          return safeRoute({
            ...c,
            mediaUrls: urlsOf(prev.items),
            mediaTypes: typesOf(prev.items),
            content: \`\${String(c.content ?? "")}\\n[Kèm lại \${n} ảnh/tệp anh vừa gửi trước tin này]\`
          });
        }
      }
    }
    return routeNow(c);
  };
}
`;

// Each edit: [name, exact original text, replacement]. Every original must occur exactly once.
const EDITS = [
  ['router function',
    'function convertToZaloConnectMessage(msg) {',
    `${FN_SOURCE}function convertToZaloConnectMessage(msg) {`],
  ['routeInbound rename',
    '      const routeInbound = (converted) => {',
    '      const routeInboundNow = (converted) => {'],
  ['router install',
    '      api.listener.on("message", (msg) => {',
    `      // ${MARKER}\n      const routeInbound = createZaloMediaBurstRouter(routeInboundNow, {\n        // Same rule as processMessage (DM, @mention or the bot's name), but never an answer to a pending\n        // ask_user question: extra text would stop it matching the options.\n        isAddressed: (c) => !peekPendingQuestion(account.accountId, c.threadId) && (!c.metadata?.isGroup\n          || (Array.isArray(c.mentions) && c.mentions.some((m) => String(m?.uid ?? "") === String(selfUid ?? "")))\n          || textMentionsAnyName(String(c.content ?? ""), [getCurrentName(account.accountId), ...(account.config.nameTriggers ?? []).map((v) => String(v)), ...getRuntimeNameTriggers(account.accountId)]))\n      });\n      api.listener.on("message", (msg) => {`],
  ['windows local paths',
    '  return trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../");\n}\nvar ZALO_MAX_TEXT_LENGTH',
    `  // ${MARKER} Windows drive-letter paths are local files too (were sent as broken links).\n  return trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../") || /^[A-Za-z]:[\\\\/]/.test(trimmed);\n}\nvar ZALO_MAX_TEXT_LENGTH`],
  ['local mediaUrl upload',
    'async function sendMessageZaloConnect(threadId, text, options = {}) {\n  if (!threadId?.trim()) return { ok: false, error: "No threadId provided" };',
    `async function sendMessageZaloConnect(threadId, text, options = {}) {\n  if (!threadId?.trim()) return { ok: false, error: "No threadId provided" };\n  // ${MARKER} A local file passed as mediaUrl is uploaded, not sent as a link.\n  if (options.mediaUrl && !options.localPath && isLocalFilePath(options.mediaUrl) && fs9.existsSync(options.mediaUrl.trim())) {\n    options = { ...options, localPath: options.mediaUrl.trim(), mediaUrl: void 0 };\n  }`],
  ['reply media send result',
    '        await sendMessageZaloConnect(chatId, caption ?? "", { accountId, mediaUrl, isGroup, quote: getQuoteOnce() });',
    `        const mediaRes = await sendMessageZaloConnect(chatId, caption ?? "", { accountId, mediaUrl, isGroup, quote: getQuoteOnce() });\n        if (mediaRes && mediaRes.ok === false) runtime2.error(\`Media send failed (\${isGroup ? "group" : "dm"} \${chatId}): \${mediaRes.error}\`);`],
  ['reply text send result',
    '        await sendMessageZaloConnect(chatId, chunk, {\n          accountId,\n          isGroup,\n          quote: getQuoteOnce(),\n          mentions: firstChunk && nativeReplyMention ? [nativeReplyMention] : void 0\n        });',
    `        const textRes = await sendMessageZaloConnect(chatId, chunk, {\n          accountId,\n          isGroup,\n          quote: getQuoteOnce(),\n          mentions: firstChunk && nativeReplyMention ? [nativeReplyMention] : void 0\n        });\n        if (textRes && textRes.ok === false && !/^provider error suppressed/.test(String(textRes.error ?? ""))) {\n          runtime2.error(\`Message send failed (\${isGroup ? "group" : "dm"} \${chatId}): \${textRes.error} - retrying without quote/mention\`);\n          const retryRes = await sendMessageZaloConnect(chatId, chunk, { accountId, isGroup });\n          if (retryRes && retryRes.ok === false) runtime2.error(\`Message send retry failed (\${chatId}): \${retryRes.error}\`);\n        }`],
];

// Names the injected code uses without replacing them. A build that renamed one (the bundler renumbers
// `fs9` when an earlier `fs` import is added) would still parse - and then throw on every reply.
const REQUIRED = [
  'import * as fs9 from "fs";',
  'const { payload, chatId, isGroup, runtime: runtime2,',
  '      const selfUid = getCurrentUid(account.accountId) ?? api.getOwnId();',
  'function isLocalFilePath(str) {',
  'function peekPendingQuestion(accountId, threadId',
  'function textMentionsAnyName(text, names)',
  'function getCurrentName(accountId)',
  'function getRuntimeNameTriggers(accountId)',
];

const countOf = (text, needle) => text.split(needle).length - 1;

/** Returns { status: 'patched', out } | { status: 'already-patched' } | { status: 'incompatible', reason }. */
function patchZaloConnectSource(src) {
  const text = String(src || '');
  if (text.includes(MARKER)) return { status: 'already-patched' };
  for (const [name, original] of EDITS) {
    const n = countOf(text, original);
    if (n !== 1) return { status: 'incompatible', reason: `anchor "${name}" found ${n} times` };
  }
  for (const needle of REQUIRED) {
    const n = countOf(text, needle);
    if (n !== 1) return { status: 'incompatible', reason: `"${needle.trim().slice(0, 50)}" found ${n} times` };
  }
  let out = text;
  for (const [, original, replacement] of EDITS) out = out.replace(original, () => replacement);
  return { status: 'patched', out };
}

/** True when the source carries an OLDER version of this patch (re-patch from the pristine backup). */
function hasOlderZaloConnectPatch(src) {
  const text = String(src || '');
  return ANY_MARKER.test(text) && !text.includes(MARKER);
}

const api = { patchZaloConnectSource, hasOlderZaloConnectPatch, ZALO_CONNECT_PATCH_MARKER: MARKER };
if (typeof globalThis !== 'undefined') globalThis.__openclawZaloConnectPatch = api;
if (typeof exports !== 'undefined') Object.assign(exports, api);
